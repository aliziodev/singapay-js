import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/browser-guard.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
});
