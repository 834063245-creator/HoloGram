import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

// 引擎二进制：优先用 DSH profile 里打包的；否则回退 HoloGram 构建产物
const ENGINE = process.env.HOLOGRAM_ENGINE
  ?? 'D:/HoloGramHG/engine/target/release/hologram-engine.exe'
const HOLOGRAM_FS = fileURLToPath(new URL('../../../HoloGramHG', import.meta.url)) // 用于 dump-graph 的测试项目

export default defineConfig({
  resolve: { alias: { '@hologram-kernel': fileURLToPath(new URL('./kernel', import.meta.url)) } },
  server: { port: 5180, strictPort: true }
})