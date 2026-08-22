import { beforeEach, describe, expect, it } from 'vitest';
import { JakartaClock } from '../src/clock.js';
import type { SingaPayOptions } from '../src/config.js';
import { IpNotWhitelistedError, MoneyOutDisabledError } from '../src/errors.js';
import { buildEndpoint } from '../src/http/client.js';
import { normalizeJson } from '../src/normalize/json-normalizer.js';
import { SingaPay } from '../src/singapay.js';

type Reply = { status?: number; body: unknown };
type Call = {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
};

function fakeGateway(replies: Reply[]) {
  const calls: Call[] = [];
  let index = 0;

  const impl = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });

    const reply = replies[Math.min(index, replies.length - 1)] as Reply;

    index += 1;

    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetch: impl as unknown as typeof fetch, calls };
}

const TOKEN_REPLY: Reply = { body: { access_token: 'token-123', expires_in: '216000' } };
const OK_REPLY: Reply = {
  body: { response_code: 'SP000', response_message: 'OK', data: { id: 7 } },
};

function client(fetchImpl: typeof fetch, overrides: Partial<SingaPayOptions> = {}): SingaPay {
  return new SingaPay({
    environment: 'sandbox',
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    apiKey: 'partner-1',
    accountId: '01J0ACCOUNT',
    retry: { times: 2, delayMs: 0 },
    fetch: fetchImpl,
    clock: new JakartaClock(() => new Date('2026-08-20T00:00:00Z')),
    ...overrides,
  });
}

describe('buildEndpoint', () => {
  it('appends the query string the signature has to cover', () => {
    expect(
      buildEndpoint({ method: 'GET', path: '/api/v1.0/statements/x', query: { page: 2 } }),
    ).toBe('/api/v1.0/statements/x?page=2');
  });

  it('percent-encodes to RFC 3986, not to form encoding', () => {
    // encodeURIComponent leaves !*'() alone and form encoding turns a space
    // into +. Either would sign a string the URL does not match.
    expect(buildEndpoint({ method: 'GET', path: '/p', query: { q: "a b!'()*" } })).toBe(
      '/p?q=a%20b%21%27%28%29%2A',
    );
  });

  it('omits an empty query entirely', () => {
    expect(buildEndpoint({ method: 'GET', path: '/p', query: {} })).toBe('/p');
  });
});

describe('money-out guard', () => {
  it('refuses a transfer before any request is made', async () => {
    const gateway = fakeGateway([TOKEN_REPLY, OK_REPLY]);

    await expect(
      client(gateway.fetch).disbursement.transfer({ reference_number: 'REF-1' }),
    ).rejects.toThrow(MoneyOutDisabledError);

    expect(gateway.calls).toHaveLength(0);
  });

  it('allows a transfer once explicitly enabled', async () => {
    const gateway = fakeGateway([TOKEN_REPLY, OK_REPLY]);

    await client(gateway.fetch, { moneyOut: { enabled: true } }).disbursement.transfer({
      reference_number: 'REF-1',
    });

    expect(gateway.calls).toHaveLength(2);
  });

  it('leaves direct-debit charge alone, because it collects rather than pays out', async () => {
    const gateway = fakeGateway([TOKEN_REPLY, OK_REPLY]);

    await client(gateway.fetch).directDebit.charge({ binding_id: 'bind-1' });

    expect(gateway.calls).toHaveLength(2);
  });
});

describe('signed requests', () => {
  let gateway: ReturnType<typeof fakeGateway>;

  beforeEach(() => {
    gateway = fakeGateway([TOKEN_REPLY, OK_REPLY]);
  });

  it('sends exactly the bytes that were hashed', async () => {
    await client(gateway.fetch, { moneyOut: { enabled: true } }).disbursement.transfer({
      reference_number: 'REF-1',
      amount: 150_000,
    });

    const request = gateway.calls[1] as Call;

    expect(request.body).toBe(
      normalizeJson({ reference_number: 'REF-1', amount: 150_000, account_id: '01J0ACCOUNT' }),
    );
    expect(request.headers['X-Signature']).toMatch(/^[0-9a-f]{128}$/);
    expect(request.headers['X-Timestamp']).toBe('1787184000');
    expect(request.headers.Authorization).toBe('Bearer token-123');
    expect(request.headers['X-PARTNER-ID']).toBe('partner-1');
  });

  it('fills in the configured account id', async () => {
    await client(gateway.fetch, { moneyOut: { enabled: true } }).disbursement.transfer({
      reference_number: 'REF-1',
    });

    expect(gateway.calls[1]?.body).toContain('"account_id":"01J0ACCOUNT"');
  });
});

describe('retries', () => {
  it('retries a GET on a server error', async () => {
    const gateway = fakeGateway([
      TOKEN_REPLY,
      { status: 500, body: {} },
      { status: 500, body: {} },
      OK_REPLY,
    ]);

    await client(gateway.fetch).balance.merchant();

    // token + three GET attempts
    expect(gateway.calls).toHaveLength(4);
  });

  it('never retries a write, because a blind retry can duplicate a transfer', async () => {
    const gateway = fakeGateway([TOKEN_REPLY, { status: 500, body: {} }]);

    await expect(
      client(gateway.fetch, { moneyOut: { enabled: true } }).disbursement.transfer({ a: 1 }),
    ).rejects.toThrow();

    expect(gateway.calls).toHaveLength(2);
  });
});

describe('token handling', () => {
  it('fetches one token and reuses it', async () => {
    const gateway = fakeGateway([TOKEN_REPLY, OK_REPLY]);
    const singapay = client(gateway.fetch);

    await singapay.balance.merchant();
    await singapay.balance.merchant();

    expect(gateway.calls.filter((call) => call.url.includes('access-token'))).toHaveLength(1);
  });

  it('refreshes once on SP013 and retries', async () => {
    const gateway = fakeGateway([
      TOKEN_REPLY,
      { status: 401, body: { response_code: 'SP013', response_message: 'Unauthorized' } },
      TOKEN_REPLY,
      OK_REPLY,
    ]);

    await client(gateway.fetch).balance.merchant();

    expect(gateway.calls).toHaveLength(4);
  });

  it('raises the IP whitelist error rather than a generic auth failure', async () => {
    const gateway = fakeGateway([
      {
        status: 401,
        body: { response_code: 'SP017', response_message: 'Unauthorized IP address' },
      },
    ]);

    await expect(client(gateway.fetch).balance.merchant()).rejects.toThrow(IpNotWhitelistedError);
  });
});
