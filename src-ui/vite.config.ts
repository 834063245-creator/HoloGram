// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { realpathSync } from 'node:fs';
import { defineConfig } from 'vite';

// ponytail: Vite html-inline-proxy does case-sensitive file.replace(root, …) on
// Windows — when Tauri spawns the build with lower-case cwd, the proxy lookup
// misses. Use .native (GetFinalPathNameByHandleW) which returns canonical case.
export default defineConfig({
  root: realpathSync.native(process.cwd()),
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
