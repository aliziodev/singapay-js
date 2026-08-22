import { defineConfig } from 'tsdown';

// Deliberately `.mjs`, not `.ts`, and paired with `--config-loader native`
// in the build script.
//
// tsdown picks its config loader from what the *runtime* can do, not from the
// file extension: `isBun || nativeTS && isSupported ? "native" : "unrun"`. On
// Node 20 there is no native type stripping, so it reaches for `unrun` — which
// tsdown declares only as a peer dependency and does not install — and the
// build dies with "Failed to import module unrun", even for a config that
// needs no transpilation at all.
//
// Forcing the native loader avoids that, and this file has to be plain ESM for
// the native loader to read it on Node 20. `defineConfig` still gives editor
// completion through its JSDoc types.

export default defineConfig({
  entry: ['src/index.ts', 'src/browser-guard.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
});
