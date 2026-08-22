import { describe, expect, it } from 'vitest';
import { RequestSigner } from '../src/auth/request-signer.js';
import { JakartaClock } from '../src/clock.js';
import { sha256Hex } from '../src/crypto.js';
import { WebhookVerificationError } from '../src/errors.js';
import { WebhookType, webhookTypeFromPayload } from '../src/webhooks/types.js';
import { normalizeWebhookBody, verifyWebhook } from '../src/webhooks/verify.js';

const SECRET = 'singapay-test-secret';
const ENDPOINT = '/api/webhooks/singapay';
const TOKEN = 'gateway-generated-token';
const NOW = new Date('2026-08-20T00:00:00Z');

const clock = new JakartaClock(() => NOW);
const signer = new RequestSigner();

/** Forge a delivery the way the gateway does, so verification has something real to check. */
async function deliver(
  payload: unknown,
  overrides: { secret?: string; skewSeconds?: number } = {},
) {
  const rawBody = JSON.stringify(payload);
  const timestamp = clock.unixSeconds() - (overrides.skewSeconds ?? 0);
  const signature = await signer.signHashedBody(
    'POST',
    ENDPOINT,
    TOKEN,
    await sha256Hex(normalizeWebhookBody(payload)),
    timestamp,
    overrides.secret ?? SECRET,
  );

  return {
    rawBody,
    headers: {
      'X-Signature': signature,
      'X-Timestamp': String(timestamp),
      Authorization: `Bearer ${TOKEN}`,
    },
  };
}

describe('verifyWebhook', () => {
  it('accepts a correctly signed delivery and identifies its type', async () => {
    const payload = { event: 'va-transaction', data: { amount: 150_000 } };
    const { rawBody, headers } = await deliver(payload);

    const verified = await verifyWebhook({
      rawBody,
      headers,
      endpoint: ENDPOINT,
      secrets: SECRET,
      clock,
    });

    expect(verified.type).toBe(WebhookType.VirtualAccount);
    expect(verified.payload).toEqual(payload);
  });

  it('accepts a delivery signed with the raw bytes rather than the re-normalized form', async () => {
    // Keys deliberately out of order, so the raw bytes and the normalized form
    // differ. The gateway signs one or the other; both have to verify.
    const rawBody = '{"z":1,"a":2}';
    const timestamp = clock.unixSeconds();
    const signature = await signer.signHashedBody(
      'POST',
      ENDPOINT,
      TOKEN,
      await sha256Hex(rawBody),
      timestamp,
      SECRET,
    );

    const verified = await verifyWebhook({
      rawBody,
      headers: {
        'X-Signature': signature,
        'X-Timestamp': String(timestamp),
        Authorization: `Bearer ${TOKEN}`,
      },
      endpoint: ENDPOINT,
      secrets: SECRET,
      clock,
    });

    expect(verified.payload).toEqual({ z: 1, a: 2 });
  });

  it('accepts a Headers instance', async () => {
    const payload = { event: 'disbursement' };
    const { rawBody, headers } = await deliver(payload);

    const verified = await verifyWebhook({
      rawBody,
      headers: new Headers(headers),
      endpoint: ENDPOINT,
      secrets: SECRET,
      clock,
    });

    expect(verified.type).toBe(WebhookType.Disbursement);
  });

  it('tries every configured secret', async () => {
    const payload = { event: 'settlement' };
    const { rawBody, headers } = await deliver(payload, { secret: 'hmac-validation-key' });

    const verified = await verifyWebhook({
      rawBody,
      headers,
      endpoint: ENDPOINT,
      secrets: [SECRET, 'hmac-validation-key'],
      clock,
    });

    expect(verified.type).toBe(WebhookType.Settlement);
  });

  it('rejects a tampered body', async () => {
    const { headers } = await deliver({ event: 'va-transaction', data: { amount: 150_000 } });

    await expect(
      verifyWebhook({
        rawBody: '{"event":"va-transaction","data":{"amount":15000000}}',
        headers,
        endpoint: ENDPOINT,
        secrets: SECRET,
        clock,
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it('rejects a replay outside the tolerance window', async () => {
    const { rawBody, headers } = await deliver({ event: 'va-transaction' }, { skewSeconds: 900 });

    await expect(
      verifyWebhook({ rawBody, headers, endpoint: ENDPOINT, secrets: SECRET, clock }),
    ).rejects.toThrow(/tolerance/);
  });

  it('rejects a delivery whose endpoint does not match the configured path', async () => {
    const { rawBody, headers } = await deliver({ event: 'va-transaction' });

    await expect(
      verifyWebhook({ rawBody, headers, endpoint: '/api/webhooks/other', secrets: SECRET, clock }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it('rejects missing headers', async () => {
    await expect(
      verifyWebhook({ rawBody: '{}', headers: {}, endpoint: ENDPOINT, secrets: SECRET, clock }),
    ).rejects.toThrow(/required headers/);
  });
});

describe('normalizeWebhookBody', () => {
  it('reproduces the PHP associative-array cast for an empty object', () => {
    // json_decode($body, true) turns {} into an empty PHP array, which
    // re-encodes as []. Getting this wrong silently breaks verification.
    expect(normalizeWebhookBody({ meta: {} })).toBe('{"meta":[]}');
  });

  it('reproduces the PHP list cast for sequential numeric keys', () => {
    expect(normalizeWebhookBody({ '0': 'a', '1': 'b' })).toBe('["a","b"]');
  });

  it('sorts keys recursively in byte order', () => {
    expect(normalizeWebhookBody({ z: { y: 1, a: 2 }, a: 3 })).toBe('{"a":3,"z":{"a":2,"y":1}}');
  });
});

describe('webhookTypeFromPayload', () => {
  it('normalizes the underscore spelling the docs use', () => {
    expect(webhookTypeFromPayload({ event: 'transaction_expiration' })).toBe(
      WebhookType.TransactionExpiration,
    );
  });

  it('falls back to payload shape for payment links without an event field', () => {
    expect(webhookTypeFromPayload({ data: { transaction: { type: 'pl' } } })).toBe(
      WebhookType.PaymentLink,
    );
  });

  it('maps prefixed event names', () => {
    expect(webhookTypeFromPayload({ event: 'subscription.cycle.paid' })).toBe(
      WebhookType.SubscriptionCycle,
    );
  });

  it('returns null for a type it does not know, rather than guessing', () => {
    expect(webhookTypeFromPayload({ event: 'something-new' })).toBeNull();
  });
});
