import { defineConfig } from 'tsdown'

// Standalone build for the hologram-dsh bundle.
// Bundle src/index.ts -> lib/index.js (ESM). DSH peer packages
// (@deepseek-ai/*) and Node builtins stay external: at runtime they resolve
// from the dsh installation's shared instance via the healed
// profiles/node_modules flat fallback — the same single-cordis contract every
// out-of-tree dsh plugin follows.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  clean: false,
  dts: false,
  external: [/^@deepseek-ai\//, /^node:/],
})
