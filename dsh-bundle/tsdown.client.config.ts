// Standalone client-bundle build for hologram-dsh（shell.overlay / sidebar.footer.action 入口）。
// 复刻 DSH 的 clientBundle wrapper 契约：closure-factory 形态，供 modules node-half serve。
import { defineConfig } from 'tsdown'

const ID = 'hologram-dsh'
// 平台模块 external：运行时经 __ModuleLoader__ 的 require 从框架共享实例解析
const EXTERNALS = [
  'react', 'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig({
  name: ID + '/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  noExternal: (id) => (EXTERNALS.includes(id) ? undefined : /^[a-z@]/.test(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(ID) + ', factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
