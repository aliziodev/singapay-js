import { defineConfig } from 'tsdown';

// Deliberately `.mjs`, not `.ts`. tsdown loads a TypeScript config through
// `unrun`, which is only a peer dependency and is not installed. On Node 22+
// that never shows, because the runtime strips types itself; on Node 20 the
// build dies with "Failed to import module unrun". A plain ESM config is
// loadable by every Node this package supports, and `defineConfig` still
// gives editor completion through its JSDoc types.

export default defineConfig({
  entry: ['src/index.ts', 'src/browser-guard.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
});
