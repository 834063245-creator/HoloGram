// vendor-kernel.mjs — copy HoloGram 3D render kernel into viewer/kernel/
// 只重写 app 耦合 import 指向本仓 stub，渲染逻辑字节级不碰。
import { readdirSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const SRC = 'D:/HoloGramHG/src-ui/src/ui'
const I18N = 'D:/HoloGramHG/src-ui/src/i18n.ts'
const DST = 'D:/HoloGramHG/dsh-bundle/viewer/kernel'
const STUBS = 'D:/HoloGramHG/dsh-bundle/viewer/kernel/stubs'
mkdirSync(DST, { recursive: true })
mkdirSync(STUBS, { recursive: true })

// import 重映射：from 说明符文本 -> 本仓 stub（原样整串替换）
const specs = [
  ["'../app/shell-store'", "'./stubs/shell-store'"],
  ["'../i18n'", "'./kernel-i18n'"],
  ["'./events'", "'./stubs/events'"],
  ["'./debug'", "'./stubs/debug'"],
  ["'./app-shell'", "'./stubs/app-shell'"],
]
function rewrite(rel) {
  let t = readFileSync(rel, 'utf8')
  for (const [from, to] of specs) t = t.split(from).join(to)
  return t
}
let copied = []
for (const f of readdirSync(SRC)) {
  if (f.startsWith('graph') && f.endsWith('.ts')) {
    writeFileSync(join(DST, f), rewrite(join(SRC, f)))
    copied.push(f)
  }
}
copyFileSync(join(SRC, 'icons.ts'), join(DST, 'icons.ts')); copied.push('icons.ts')
copyFileSync(join(SRC, 'gpu-layout.ts'), join(DST, 'gpu-layout.ts')); copied.push('gpu-layout.ts')
writeFileSync(join(DST, 'kernel-i18n.ts'), rewrite(I18N)); copied.push('kernel-i18n.ts')
console.log('[vendor] copied:', copied.join(', '))