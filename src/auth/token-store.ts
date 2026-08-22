/**
 * Where access tokens are cached between requests.
 *
 * The default store lives in module memory, which is correct for a long-lived
 * server process and useless on serverless platforms, where every invocation
 * may get a fresh instance and re-fetch a token. Supply a Redis-backed or
 * framework-cache-backed store there.
 *
 * Implementations may be sync or async; the SDK always awaits.
 */
export interface TokenStore {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, token: string, ttlSeconds: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

type Entry = {
  token: string;
  expiresAtMs: number;
};

/**
 * In-memory token store with per-entry expiry.
 *
 * @param now Injected in tests to control expiry without waiting.
 */
export function createMemoryTokenStore(now: () => number = () => Date.now()): TokenStore {
  const entries = new Map<string, Entry>();

  return {
    get(key) {
      const entry = entries.get(key);

      if (entry === undefined) {
        return null;
      }

      if (entry.expiresAtMs <= now()) {
        entries.delete(key);

        return null;
      }

      return entry.token;
    },

    set(key, token, ttlSeconds) {
      entries.set(key, { token, expiresAtMs: now() + ttlSeconds * 1000 });
    },

    delete(key) {
      entries.delete(key);
    },
  };
}
