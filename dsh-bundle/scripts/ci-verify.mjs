// ci-verify.mjs — dsh-bundle push CI 的包完整性校验。
// 不随 npm 包发布（package.json files 白名单不含本文件），只在 CI 使用。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const required = [
  'lib/index.mjs',
  'lib/client.js',
  'lib/client.js.map',
  'viewer/dist/index.html',
  'cordis.patch.yml',
  'scripts/install.mjs',
  'README.md',
]

const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg) }

// 1. 构建产物都在，且 npm pack 真的会收录
for (const f of required) {
  check(existsSync(join(ROOT, f)), `missing build artifact: ${f}`)
}
const assets = join(ROOT, 'viewer', 'dist', 'assets')
check(existsSync(assets) && readdirSync(assets).some(f => f.endsWith('.js')), 'viewer dist/assets must contain at least one JS chunk')

const packJson = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  encoding: 'utf8',
})
const [pack] = JSON.parse(packJson)
const packed = new Set(pack.files.map(f => f.path))
for (const f of required) {
  check(packed.has(f), `npm pack is missing expected file: ${f}`)
}
for (const f of ['lib/client.js', 'lib/client.js.map']) {
  check(!f.includes('..'), 'unexpected path')
}

// 2. 壳包必须保持轻量（引擎二进制/大样例不进 npm 包）
check(pack.unpackedSize < 5_000_000, `package too large: ${pack.unpackedSize} bytes (engine binary must live in GitHub Release)`)

// 3. 版本一致性：install.mjs 的 fallback 版本必须等于 package.json.version
const install = readFileSync(join(ROOT, 'scripts', 'install.mjs'), 'utf8')
const fallback = install.match(/const PKG_VERSION = process\.env\.npm_package_version \?\? '([^']+)'/)?.[1]
check(fallback === pkg.version, `install.mjs fallback version ${fallback} != package.json version ${pkg.version}`)

// 4. exports 指向的文件必须存在
for (const [spec, target] of Object.entries(pkg.exports ?? {})) {
  const file = target?.default ?? target
  if (typeof file === 'string' && file !== './package.json') {
    check(existsSync(join(ROOT, file.replace(/^\.\//, ''))), `exports ${spec} -> ${file} does not exist`)
  }
}

// 5. client 入口仍保持 DSH __ModuleLoader__ 闭包契约
const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
check(
  client.includes('window.__ModuleLoader__.load({') && client.includes('id: "hologram-dsh"'),
  'client.js lost __ModuleLoader__ wrapper contract',
)

if (failures.length > 0) {
  console.error('[dsh-bundle ci-verify] FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log(`[dsh-bundle ci-verify] OK: ${packed.size} packed files, ${pack.size} bytes tarball, ${pack.unpackedSize} bytes unpacked`)
