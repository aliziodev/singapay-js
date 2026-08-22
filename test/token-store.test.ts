import { describe, expect, it } from 'vitest';
import { createMemoryTokenStore } from '../src/auth/token-store.js';

/**
 * The default token store.
 *
 * Small, but it decides whether a token is reused or re-fetched, and an
 * expiry that never fires would keep handing out a dead token — which surfaces
 * as an authentication failure far away from here.
 */
describe('createMemoryTokenStore', () => {
  /** A clock the test moves by hand, so expiry is tested without waiting. */
  function clock(start = 0): { now: () => number; advance: (seconds: number) => void } {
    let ms = start;

    return {
      now: () => ms,
      advance: (seconds: number) => {
        ms += seconds * 1000;
      },
    };
  }

  it('returns null for a key it never held', () => {
    const store = createMemoryTokenStore();

    expect(store.get('absent')).toBeNull();
  });

  it('returns a token that is still inside its lifetime', () => {
    const time = clock();
    const store = createMemoryTokenStore(time.now);

    store.set('key', 'token-123', 60);
    time.advance(59);

    expect(store.get('key')).toBe('token-123');
  });

  it('drops a token the moment its lifetime is up', () => {
    // Exactly at the boundary, not merely past it: a token expiring "now" is
    // already unusable, and returning it would fail on the next request.
    const time = clock();
    const store = createMemoryTokenStore(time.now);

    store.set('key', 'token-123', 60);
    time.advance(60);

    expect(store.get('key')).toBeNull();
  });

  it('forgets an expired entry rather than keeping it around', () => {
    const time = clock();
    const store = createMemoryTokenStore(time.now);

    store.set('key', 'token-123', 60);
    time.advance(120);
    store.get('key');

    // Reading it back after the clock rewinds must still miss: the entry was
    // evicted, not merely hidden behind a time comparison.
    expect(store.get('key')).toBeNull();
  });

  it('keeps keys apart, so two credentials never share a token', () => {
    const store = createMemoryTokenStore();

    store.set('merchant', 'token-a', 60);
    store.set('payouts', 'token-b', 60);

    expect(store.get('merchant')).toBe('token-a');
    expect(store.get('payouts')).toBe('token-b');
  });

  it('overwrites a key with the newer token', () => {
    const store = createMemoryTokenStore();

    store.set('key', 'old', 60);
    store.set('key', 'new', 60);

    expect(store.get('key')).toBe('new');
  });

  it('deletes on request, which is what a refresh after SP013 relies on', () => {
    const store = createMemoryTokenStore();

    store.set('key', 'token-123', 60);
    store.delete('key');

    expect(store.get('key')).toBeNull();
  });

  it('ignores a delete for a key it never held', () => {
    const store = createMemoryTokenStore();

    expect(() => store.delete('absent')).not.toThrow();
  });
});
