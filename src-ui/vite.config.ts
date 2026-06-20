// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { defineConfig } from 'vite';

export default defineConfig({
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
