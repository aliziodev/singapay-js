import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Live sandbox runs have their own config and their own command, so that
    // `pnpm test` never depends on credentials or on the network.
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
    environment: 'node',
  },
});
