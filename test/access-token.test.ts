import { describe, expect, it } from 'vitest';
import { AccessTokenProvider } from '../src/auth/access-token-provider.js';
import { AccessTokenSigner } from '../src/auth/access-token-signer.js';
import type { TokenStore } from '../src/auth/token-store.js';
import { JakartaClock } from '../src/clock.js';
import type { SingaPayOptions } from '../src/config.js';
import { resolveConfig } from '../src/config.js';
import { AuthenticationError, ConnectionError, IpNotWhitelistedError } from '../src/errors.js';

/**
 * The access-token provider.
 *
 * Every request rides on this: a token fetched too often costs a round trip
 * per call, and one cached past its life fails authentication somewhere that
 * cannot explain why.
 */

type Recorded = { url: string; headers: Record<string, string>; body: string | undefined };

/** A gateway that answers each queued reply in turn, recording what it got. */
function gateway(replies: unknown[], status = 200) {
  const calls: Recorded[] = [];
  let index = 0;

  const impl = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });

    const reply = replies[Math.min(index, replies.length - 1)];

    index += 1;

    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetch: impl as unknown as typeof fetch, calls };
}

/** A store that records every ttl it is handed. */
function recordingStore(): { store: TokenStore; writes: { key: string; ttl: number }[] } {
  const held = new Map<string, string>();
  const writes: { key: string; ttl: number }[] = [];

  return {
    writes,
    store: {
      get: (key) => held.get(key) ?? null,
      set: (key, token, ttl) => {
        held.set(key, token);
        writes.push({ key, ttl });
      },
      delete: (key) => void held.delete(key),
    },
  };
}

function provider(overrides: Partial<SingaPayOptions> = {}): AccessTokenProvider {
  const config = resolveConfig({
    environment: 'sandbox',
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    apiKey: 'api-key-1',
    clock: new JakartaClock(() => new Date('2026-08-20T00:00:00Z')),
    ...overrides,
  });

  return new AccessTokenProvider(config, new AccessTokenSigner(config.clock));
}

const OK = { access_token: 'token-123', expires_in: '216000' };

describe('AccessTokenProvider', () => {
  describe('caching', () => {
    it('fetches once and serves the cache after that', async () => {
      const net = gateway([OK]);
      const tokens = provider({ fetch: net.fetch });

      expect(await tokens.token()).toBe('token-123');
      expect(await tokens.token()).toBe('token-123');
      expect(net.calls).toHaveLength(1);
    });

    it('shares one in-flight fetch across a burst on a cold cache', async () => {
      // Without this a cold start under load stampedes the token endpoint:
      // every concurrent caller would open its own exchange.
      const net = gateway([OK]);
      const tokens = provider({ fetch: net.fetch });

      const results = await Promise.all([tokens.token(), tokens.token(), tokens.token()]);

      expect(results).toEqual(['token-123', 'token-123', 'token-123']);
      expect(net.calls).toHaveLength(1);
    });

    it('shaves a refresh buffer off the lifetime, so a token is never used at the edge', async () => {
      const net = gateway([{ access_token: 'token-123', expires_in: '900' }]);
      const { store, writes } = recordingStore();

      await provider({ fetch: net.fetch, tokenStore: store }).token();

      expect(writes[0]?.ttl).toBe(840);
    });

    it('never caches longer than the token actually lives', async () => {
      // A lifetime shorter than the buffer would otherwise produce a negative
      // ttl, and a store told to keep something for -30 seconds may keep it
      // forever.
      const net = gateway([{ access_token: 'token-123', expires_in: '30' }]);
      const { store, writes } = recordingStore();

      await provider({ fetch: net.fetch, tokenStore: store }).token();

      expect(writes[0]?.ttl).toBe(1);
    });

    it('reads expires_in whether it arrives as a string or a number', async () => {
      const net = gateway([{ access_token: 'token-123', expires_in: 900 }]);
      const { store, writes } = recordingStore();

      await provider({ fetch: net.fetch, tokenStore: store }).token();

      expect(writes[0]?.ttl).toBe(840);
    });

    it('re-fetches after forget(), which is what an SP013 refresh relies on', async () => {
      const net = gateway([OK]);
      const tokens = provider({ fetch: net.fetch });

      await tokens.token();
      await tokens.forget();
      await tokens.token();

      expect(net.calls).toHaveLength(2);
    });
  });

  describe('auth schemes', () => {
    it('signs the exchange for v1.1, the default', async () => {
      const net = gateway([OK]);

      await provider({ fetch: net.fetch }).token();

      const call = net.calls[0];

      expect(call?.url).toContain('/api/v1.1/access-token/b2b');
      expect(call?.headers['X-CLIENT-ID']).toBe('client-abc');
      expect(call?.headers['X-Signature']).toBeTypeOf('string');
      expect(call?.headers.Authorization).toBeUndefined();
    });

    it('falls back to HTTP Basic for v1.0', async () => {
      const net = gateway([OK]);

      await provider({ fetch: net.fetch, authVersion: '1.0' }).token();

      const call = net.calls[0];

      expect(call?.url).toContain('/api/v1.0/access-token/b2b');
      expect(call?.headers.Authorization).toBe(`Basic ${btoa('client-abc:secret-xyz')}`);
      expect(call?.headers['X-Signature']).toBeUndefined();
    });

    it('always identifies the merchant with the api key header', async () => {
      const net = gateway([OK]);

      await provider({ fetch: net.fetch }).token();

      // The dashboard calls this value the API Key; the gateway wants it here.
      expect(net.calls[0]?.headers['X-PARTNER-ID']).toBe('api-key-1');
    });
  });

  describe('failures', () => {
    it('surfaces SP017 as its own error, not as a bad credential', async () => {
      // An unwhitelisted IP never gets past the token exchange, so this is
      // where SP017 actually shows up. The cause and the fix are nothing like
      // a wrong secret.
      const net = gateway([{ response_code: 'SP017', response_message: 'IP not registered' }], 403);

      await expect(provider({ fetch: net.fetch }).token()).rejects.toBeInstanceOf(
        IpNotWhitelistedError,
      );
    });

    it('surfaces the codeless IP rejection the token host actually sends', async () => {
      // Sandbox 2026-08-23. The token host does not answer SP017 at all. The
      // message below is verbatim from a live rejection (only the IP is
      // masked); the envelope around it is this host's standard error shape,
      // observed on a 422 from the same endpoint — `error.code` carries the
      // HTTP status, which is not an SP code and so `parseEnvelope` drops it.
      //
      // Classification depends only on the status and the message, so it holds
      // whichever envelope field carried the sentence. Matching on SP017 alone
      // made this an AuthenticationError, sending people to audit credentials
      // that were never wrong.
      const net = gateway(
        [
          {
            status: 403,
            success: false,
            error: { code: 403, message: 'Your IP address (203.0.113.10) is not registered' },
          },
        ],
        403,
      );

      await expect(provider({ fetch: net.fetch }).token()).rejects.toBeInstanceOf(
        IpNotWhitelistedError,
      );
    });

    it('leaves the other HTTP 403 alone', async () => {
      // The gateway's second 403 shape carries no code either, but it is a
      // permission problem, not a network one. Widening the IP check to every
      // 403 would swallow it.
      const net = gateway(
        [
          {
            status: 403,
            success: false,
            error: { code: 403, message: 'Access denied to this account.' },
          },
        ],
        403,
      );

      await expect(provider({ fetch: net.fetch }).token()).rejects.not.toBeInstanceOf(
        IpNotWhitelistedError,
      );
    });

    it('raises an authentication error when the exchange is refused', async () => {
      const net = gateway(
        [{ response_code: 'SP001', response_message: 'Invalid credential' }],
        401,
      );

      await expect(provider({ fetch: net.fetch }).token()).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    });

    it('raises an authentication error when the reply carries no token', async () => {
      const net = gateway([{ response_code: 'SP000', response_message: 'OK', access_token: '' }]);

      await expect(provider({ fetch: net.fetch }).token()).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    });

    it('reports an unreachable gateway as a connection failure', async () => {
      const unreachable = (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      await expect(provider({ fetch: unreachable }).token()).rejects.toBeInstanceOf(
        ConnectionError,
      );
    });

    it('does not cache a failure, so the next call tries again', async () => {
      let attempt = 0;
      const impl = (async () => {
        attempt += 1;

        return attempt === 1
          ? new Response(JSON.stringify({ response_code: 'SP001' }), { status: 401 })
          : new Response(JSON.stringify(OK), { status: 200 });
      }) as unknown as typeof fetch;

      const tokens = provider({ fetch: impl });

      await expect(tokens.token()).rejects.toBeInstanceOf(AuthenticationError);
      await expect(tokens.token()).resolves.toBe('token-123');
    });
  });
});
