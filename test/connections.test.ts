import { afterEach, describe, expect, it } from 'vitest';
import { RequestSigner } from '../src/auth/request-signer.js';
import type { TokenStore } from '../src/auth/token-store.js';
import { JakartaClock } from '../src/clock.js';
import type { SingaPayOptions } from '../src/config.js';
import {
  connectionNames,
  DEFAULT_CONNECTION,
  optionsFromEnv,
  resolveConfig,
} from '../src/config.js';
import { sha256Hex } from '../src/crypto.js';
import { ConfigurationError, WebhookVerificationError } from '../src/errors.js';
import { SingaPay } from '../src/singapay.js';
import { normalizeWebhookBody, verifyWebhook } from '../src/webhooks/verify.js';

const CLOCK = new JakartaClock(() => new Date('2026-08-20T00:00:00Z'));
const ENDPOINT = '/api/webhooks/singapay';
const TOKEN = 'gateway-generated-token';

/** Top-level credentials plus one sub-account credential set. */
function options(overrides: Partial<SingaPayOptions> = {}): SingaPayOptions {
  return {
    environment: 'sandbox',
    clientId: 'merchant-client',
    clientSecret: 'merchant-secret',
    apiKey: 'merchant-partner',
    accountId: '01J0MERCHANT',
    moneyOut: { enabled: true },
    timeoutMs: 12_345,
    connections: {
      payouts: {
        clientId: 'payouts-client',
        clientSecret: 'payouts-secret',
        apiKey: 'payouts-partner',
        accountId: '01J0PAYOUTS',
      },
    },
    clock: CLOCK,
    ...overrides,
  };
}

describe('connection resolution', () => {
  it('treats the top-level credentials as the default connection', () => {
    const config = resolveConfig(options());

    expect(config.connectionName).toBe(DEFAULT_CONNECTION);
    expect(config.clientId).toBe('merchant-client');
    expect(config.accountId).toBe('01J0MERCHANT');
  });

  it('binds a named connection to its own credentials', () => {
    const config = resolveConfig(options(), 'payouts');

    expect(config.connectionName).toBe('payouts');
    expect(config.clientId).toBe('payouts-client');
    expect(config.clientSecret).toBe('payouts-secret');
    expect(config.apiKey).toBe('payouts-partner');
    expect(config.accountId).toBe('01J0PAYOUTS');
  });

  it('keeps application policy shared rather than per connection', () => {
    const config = resolveConfig(options(), 'payouts');

    expect(config.environment).toBe('sandbox');
    expect(config.moneyOutEnabled).toBe(true);
    expect(config.timeoutMs).toBe(12_345);
    expect(config.baseUrls.payment).toBe('https://sandbox-payment-b2b.singapay.id');
  });

  it('lets a connection override its own auth version', () => {
    const config = resolveConfig(
      options({
        connections: {
          legacy: { clientId: 'a', clientSecret: 'b', apiKey: 'c', authVersion: '1.0' },
        },
      }),
      'legacy',
    );

    expect(config.authVersion).toBe('1.0');
    expect(resolveConfig(options()).authVersion).toBe('1.1');
  });

  it('names the connection in the error when a credential is missing', () => {
    const broken = options({
      connections: { payouts: { clientId: '', clientSecret: 'x', apiKey: 'y' } },
    });

    expect(() => resolveConfig(broken, 'payouts')).toThrow(/connections\.payouts\.clientId/);
  });

  it('rejects an unknown connection', () => {
    expect(() => resolveConfig(options(), 'nope')).toThrow(ConfigurationError);
    expect(() => resolveConfig(options(), 'nope')).toThrow(/Configured: default, payouts/);
  });

  it('lists the default connection first', () => {
    expect(connectionNames(options())).toEqual(['default', 'payouts']);
    expect(connectionNames({ clientId: 'a', clientSecret: 'b', apiKey: 'c' })).toEqual(['default']);
  });
});

describe('SingaPay.connection()', () => {
  it('returns itself for the connection it is already bound to', () => {
    const singapay = new SingaPay(options());

    expect(singapay.connection()).toBe(singapay);
    expect(singapay.connection('default')).toBe(singapay);
  });

  it('memoizes each sibling', () => {
    const singapay = new SingaPay(options());

    expect(singapay.connection('payouts')).toBe(singapay.connection('payouts'));
    expect(singapay.connection('payouts')).not.toBe(singapay);
  });

  it('exposes the sibling credentials through its endpoint groups', () => {
    const payouts = new SingaPay(options()).connection('payouts');

    expect(payouts.config.clientId).toBe('payouts-client');
    expect(payouts.config.accountId).toBe('01J0PAYOUTS');
    expect(payouts.connectionNames).toEqual(['default', 'payouts']);
  });

  it('throws for an unknown connection', () => {
    expect(() => new SingaPay(options()).connection('nope')).toThrow(ConfigurationError);
  });
});

describe('token isolation between connections', () => {
  it('caches under a different key per credential, so no token is reused', async () => {
    const written = new Map<string, string>();
    const tokenStore: TokenStore = {
      get: (key) => written.get(key) ?? null,
      set: (key, token) => void written.set(key, token),
      delete: (key) => void written.delete(key),
    };

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: 'token-123', expires_in: '600' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const singapay = new SingaPay(options({ tokenStore, fetch: fetchImpl }));

    await singapay.tokens.token();
    await singapay.connection('payouts').tokens.token();

    expect(written.size).toBe(2);
    expect([...written.keys()].sort()).toEqual(
      [
        `singapay:token:sandbox:payment:${await sha256Hex('merchant-client')}`,
        `singapay:token:sandbox:payment:${await sha256Hex('payouts-client')}`,
      ].sort(),
    );
  });
});

describe('webhook verification across connections', () => {
  const signer = new RequestSigner();

  /** Sign a delivery the way the gateway does, with one credential's secret. */
  async function signed(payload: unknown, secret: string) {
    const rawBody = JSON.stringify(payload);
    const timestamp = CLOCK.unixSeconds();

    return {
      rawBody,
      headers: {
        'X-Signature': await signer.signHashedBody(
          'POST',
          ENDPOINT,
          TOKEN,
          await sha256Hex(normalizeWebhookBody(payload)),
          timestamp,
          secret,
        ),
        'X-Timestamp': String(timestamp),
        Authorization: `Bearer ${TOKEN}`,
      },
    };
  }

  it('collects the secret of every connection plus the shared extras', () => {
    const config = resolveConfig(
      options({ webhooks: { secrets: ['dashboard-hmac-key', 'merchant-secret'] } }),
    );

    // 'merchant-secret' appears twice in the inputs and once in the output.
    expect(config.webhookSecrets).toEqual([
      'merchant-secret',
      'payouts-secret',
      'dashboard-hmac-key',
    ]);
  });

  it('accepts a delivery signed by a sub-account credential', async () => {
    const singapay = new SingaPay(options());
    const { rawBody, headers } = await signed({ event: 'disbursement' }, 'payouts-secret');

    const verified = await singapay.verifyWebhook(rawBody, headers, ENDPOINT);

    expect(verified.type).toBe('disbursement');
  });

  it('accepts a delivery signed by the merchant credential from a sub-account connection', async () => {
    // The case verified in sandbox: a transfer made with the Specific
    // credential is notified by the merchant Default one.
    const payouts = new SingaPay(options()).connection('payouts');
    const { rawBody, headers } = await signed({ event: 'disbursement' }, 'merchant-secret');

    const verified = await payouts.verifyWebhook(rawBody, headers, ENDPOINT);

    expect(verified.type).toBe('disbursement');
  });

  it('still rejects a secret belonging to no connection', async () => {
    const singapay = new SingaPay(options());
    const { rawBody, headers } = await signed({ event: 'disbursement' }, 'not-our-secret');

    await expect(singapay.verifyWebhook(rawBody, headers, ENDPOINT)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it('skips a half-configured connection instead of breaking verification', async () => {
    const singapay = new SingaPay(
      options({
        connections: {
          payouts: { clientId: 'payouts-client', clientSecret: 'payouts-secret', apiKey: 'p' },
          draft: { clientId: 'draft', clientSecret: '   ', apiKey: 'd' },
        },
      }),
    );

    expect(singapay.config.webhookSecrets).toEqual(['merchant-secret', 'payouts-secret']);

    const { rawBody, headers } = await signed({ event: 'disbursement' }, 'payouts-secret');

    await expect(singapay.verifyWebhook(rawBody, headers, ENDPOINT)).resolves.toMatchObject({
      type: 'disbursement',
    });
  });

  it('leaves a single-credential setup working exactly as before', async () => {
    const singapay = new SingaPay({
      clientId: 'solo',
      clientSecret: 'solo-secret',
      apiKey: 'solo-partner',
      clock: CLOCK,
    });

    expect(singapay.config.webhookSecrets).toEqual(['solo-secret']);

    const { rawBody, headers } = await signed({ event: 'va-transaction' }, 'solo-secret');

    await expect(
      verifyWebhook({
        rawBody,
        headers,
        endpoint: ENDPOINT,
        secrets: singapay.config.webhookSecrets,
        clock: CLOCK,
      }),
    ).resolves.toMatchObject({ type: 'va-transaction' });
  });
});

describe('HMAC validation keys from the environment', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  function withEnv(values: Record<string, string>): void {
    process.env.SINGAPAY_CLIENT_ID = 'client';
    process.env.SINGAPAY_CLIENT_SECRET = 'secret';
    process.env.SINGAPAY_API_KEY = 'api-key';
    Object.assign(process.env, values);
  }

  it('takes a single key', () => {
    withEnv({ SINGAPAY_HMAC_KEY: 'one-key' });

    expect(optionsFromEnv().webhooks?.secrets).toEqual(['one-key']);
  });

  it('takes one key per credential, comma separated', () => {
    // A merchant holding two dashboard credentials has two of these, and a
    // single callback URL receives deliveries signed by either.
    withEnv({ SINGAPAY_HMAC_KEY: 'specific-key, default-key' });

    expect(optionsFromEnv().webhooks?.secrets).toEqual(['specific-key', 'default-key']);
  });

  it('ignores blank entries rather than trying to verify against an empty key', () => {
    withEnv({ SINGAPAY_HMAC_KEY: 'a,,  ,b,' });

    expect(optionsFromEnv().webhooks?.secrets).toEqual(['a', 'b']);
  });

  it('omits the webhooks block entirely when no key is set', () => {
    withEnv({ SINGAPAY_HMAC_KEY: '' });

    expect(optionsFromEnv().webhooks).toBeUndefined();
  });

  it('still tries every connection secret when no HMAC key is configured', () => {
    withEnv({ SINGAPAY_HMAC_KEY: '' });

    const config = resolveConfig({
      ...optionsFromEnv(),
      connections: { payouts: { clientId: 'p', clientSecret: 'payouts-secret', apiKey: 'k' } },
    });

    expect(config.webhookSecrets).toEqual(['secret', 'payouts-secret']);
  });
});
