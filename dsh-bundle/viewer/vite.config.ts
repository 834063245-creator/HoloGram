import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// dsh-bundle 是 HoloGram 的薄发布适配层：viewer 不再维护渲染内核副本，
// 直接构建 src-ui 的 graph 模块；仅把 4 处 app 耦合（shell-store/events/
// debug/app-shell）alias 到本目录的轻量 stubs。i18n 是纯翻译表，直接用原件。
const srcUi = fileURLToPath(new URL('../../src-ui/src/ui', import.meta.url))
const stubs = fileURLToPath(new URL('./kernel/stubs', import.meta.url))
const i18n = fileURLToPath(new URL('../../src-ui/src/i18n.ts', import.meta.url))

export default defineConfig({
  // 由 DSH host 插件托管在同源 /hologram 前缀下；base 必须指到 /hologram/，
  // 否则 index.html 里的资源 URL 写成根绝对 /assets/...，落在 /hologram 外
  // → 浏览器拿到 DSH SPA 的 index.html 当 JS 执行 → viewer 卡 loading。
  base: '/hologram/',
  resolve: {
    alias: [
      { find: /^@hologram-kernel/, replacement: srcUi },
      { find: /^\.\.\/app\/shell-store$/, replacement: join(stubs, 'shell-store.ts') },
      { find: /^\.\.\/i18n$/, replacement: i18n },
      { find: /^\.\/events$/, replacement: join(stubs, 'events.ts') },
      { find: /^\.\/debug$/, replacement: join(stubs, 'debug.ts') },
      { find: /^\.\/app-shell$/, replacement: join(stubs, 'app-shell.ts') },
    ],
  },
  server: {
    port: 5180,
    strictPort: true,
    fs: { allow: ['../..'] },
  },
})
