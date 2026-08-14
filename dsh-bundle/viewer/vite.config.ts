import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

// 引擎二进制：优先用 DSH profile 里打包的；否则回退 HoloGram 构建产物
const ENGINE = process.env.HOLOGRAM_ENGINE
  ?? 'D:/HoloGramHG/engine/target/release/hologram-engine.exe'
const HOLOGRAM_FS = fileURLToPath(new URL('../../../HoloGramHG', import.meta.url)) // 用于 dump-graph 的测试项目

export default defineConfig({
  // 由 DSH host 插件托管在同源 /hologram 前缀下；base 必须指到 /hologram/，
  // 否则 index.html 里的资源 URL 写成根绝对 /assets/...，落在 /hologram 外
  // → 浏览器拿到 DSH SPA 的 index.html 当 JS 执行 → viewer 卡 loading。
  base: '/hologram/',
  resolve: { alias: { '@hologram-kernel': fileURLToPath(new URL('./kernel', import.meta.url)) } },
  server: { port: 5180, strictPort: true }
})