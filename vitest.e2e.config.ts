import { defineConfig } from 'vitest/config';

/**
 * Live sandbox runs.
 *
 * Kept out of the default config so `pnpm test` stays hermetic: a contributor
 * without credentials, and CI, must never see these fail or hang.
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    // Real network calls, and the gateway is not fast.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time. These share a merchant balance and a rate limit,
    // and a reference number collision reads exactly like a broken endpoint.
    fileParallelism: false,
    // Never retry. A retried money-out is a second transfer, not a second
    // attempt at the first one.
    retry: 0,
  },
});
