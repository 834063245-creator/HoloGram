// install.mjs — postinstall：为当前平台获取引擎二进制。
//
// 设计：引擎二进制（Windows x64，~60MB）不放进 npm 包（包保持 <1MB，安装秒级），
// 而是随 GitHub Release 附件发布；安装时按平台从 GitHub Releases 下载到 bin/。
//
// 支持矩阵（路线 A：Windows 先行）：
//   win32-x64 → 下载 hologram-engine-win32-x64.exe
//   其他平台   → 明确报"暂不支持"（安装失败，用户看到可读信息）
//
// 下载源：https://github.com/834063245-creator/HoloGram/releases/download/<tag>/<asset>
// tag 与 npm 版本对应：发布流程 = 打 v<version> tag（触发 CI 构建引擎传 Release）→ npm publish
// （install 脚本用 npm_package_version 拼 tag，保证二进制与包版本一致）

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get as httpsGet } from 'node:https'

// new URL('..', scripts/install.mjs) 已指向包根，不要再 dirname
const BUNDLE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN_DIR = join(BUNDLE_ROOT, 'bin')
const PKG_VERSION = process.env.npm_package_version ?? '0.2.0'
const REPO = '834063245-creator/HoloGram'
const TAG = 'v' + PKG_VERSION

function assetNameFor(platform, arch) {
  if (platform === 'win32' && (arch === 'x64' || arch === 'ia32')) return 'hologram-engine-win32-x64.exe'
  return null
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { 'user-agent': 'hologram-dsh-install' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // GitHub release 附件会 302 到 objects.githubusercontent.com
        res.resume()
        const loc = res.headers.location
        if (!loc) return reject(new Error('redirect without location (' + res.statusCode + ')'))
        return resolve(download(loc, dest))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url))
      }
      const out = createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => { out.close(); resolve() })
      out.on('error', reject)
    })
    req.on('error', reject)
  })
}

async function main() {
  const asset = assetNameFor(process.platform, process.arch)
  if (!asset) {
    console.error('\n[hologram-dsh] 当前平台不受支持：' + process.platform + '-' + process.arch)
    console.error('[hologram-dsh] 路线 A 目前仅支持 Windows x64。Linux/macOS 支持在路上。')
    console.error('[hologram-dsh] 安装中止。\n')
    process.exit(1)
  }

  const url = 'https://github.com/' + REPO + '/releases/download/' + TAG + '/' + asset
  const dest = join(BIN_DIR, 'hologram-engine.exe')

  if (existsSync(dest)) {
    // 已存在（本地开发：pack:bin 已放好）。做一次大小 sanity check，不重复下载。
    const size = statSync(dest).size
    if (size > 5_000_000) {
      console.log('[hologram-dsh] bin/hologram-engine.exe 已存在（' + (size / 1024 / 1024).toFixed(1) + 'MB），跳过下载')
      return
    }
    rmSync(dest, { force: true })
  }

  console.log('[hologram-dsh] 下载引擎二进制（' + TAG + '）...')
  console.log('[hologram-dsh] ' + url)
  mkdirSync(BIN_DIR, { recursive: true })
  const tmp = dest + '.tmp'
  try {
    await download(url, tmp)
    renameSync(tmp, dest)
  } catch (e) {
    rmSync(tmp, { force: true })
    console.error('\n[hologram-dsh] 引擎二进制下载失败：' + e.message)
    console.error('[hologram-dsh] 请确认：')
    console.error('  1. GitHub Release ' + TAG + ' 已发布且包含附件 ' + asset)
    console.error('  2. 网络可访问 github.com（可尝试设置代理 npm config set proxy https://...）')
    console.error('  3. 证书校验失败时（unable to verify the first certificate）：')
    console.error('     企业自签 CA 环境：设置 NODE_EXTRA_CA_CERTS=<你的根证书路径> 后重装')
    console.error('  4. 或本地手工执行 npm run pack:bin 放置二进制后重装\n')
    process.exit(1)
  }

  const size = statSync(dest).size
  console.log('[hologram-dsh] 引擎就绪：' + (size / 1024 / 1024).toFixed(1) + 'MB at bin/hologram-engine.exe')
  console.log('[hologram-dsh] （可选向量功能需另放 onnxruntime.dll，跳过不影响核心功能）')
}

main().catch((e) => {
  console.error('[hologram-dsh] install 失败：' + e.message)
  process.exit(1)
})
