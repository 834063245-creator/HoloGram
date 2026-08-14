/**
 * @module hologram-dsh — HoloGram engine MCP bridge for the DeepSeek Harness.
 *
 * Phase 1 node-half glue plugin. It resolves the bundled `hologram-engine`
 * binary (an install-time fact of this package, never user config) and
 * provides the `hologramEngine` service used by the `hologram-mcp` row in
 * cordis.patch.yml. Reusing DSH's own `dsh-mcp-client` for the actual MCP
 * connection means we need no MCP client code here — just the facts DSH
 * can't know: where the engine lives and what project to analyze.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer as _cs, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Stable cordis plugin name (the import specifier `hologram-dsh`). */
export const name = 'hologram-dsh'

/** 依赖：(可选) 托管 3D 视图所需的 webServer；headless profile 无此服务时安全跳过。 */
export const inject = { webServer: 'webServer' } satisfies Record<string, string | boolean>


/** Plugin config: where to analyze. */
export interface Config {
  /** Filesystem root the engine should analyze (defaults to the process cwd). */
  projectRoot: string
  /** Extra environment variables for the engine subprocess. */
  env: Record<string, string>
}

export const Config: z<Config> = z.object({
  projectRoot: z.string().default(''),
  env: z.dict(String).default({}),
  /** 在 web profile 里托管 /hologram 视图与 /hologram/api/graph（发货形态，默认开）。 */
  enableWebRoutes: z.boolean().default(true),
})

/** The resolved facts of the bundled engine. */
export interface HologramEngineService {
  /** Absolute path to the bundled `hologram-engine` executable. */
  bin: string
  /** Absolute analysis project root (the process cwd when unset). */
  projectRoot: string
  /**
   * Full argv for `serve` (derived from this package's facts). Exposed as a
   * plain value rather than a patch-side flow-collection expression so the
   * yaml `!!js` tag only ever carries scalar expression bodies — a flow
   * collection body is rejected by the loader's js-yaml function schema.
   */
  serveArgs: string[]
  /** Environment additions handed to the engine subprocess. */
  env: Record<string, string>
}

/** Service key provided by this plugin and injected by the mcp row. */
const SERVICE = 'hologramEngine'

// The binary ships inside THIS package at bin/hologram-engine.exe, next to
// lib/ (built) or src/ (source). When installed into a dsh profile, the exe
// sits at node_modules/<pkg>/bin/hologram-engine.exe.
// One `..` from either src/index.ts or lib/index.mjs lands on the package root
// that holds bin/. In lib/index.mjs the file's parent is lib/, so a single
// hop reaches the package root; two hops would escape into node_modules.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Resolve the bundled engine executable. Throws a clear diagnostic when the
 * binary is missing so the harness reports a fixable error instead of a
 * cryptic spawn failure.
 */
export function resolveEngineBinary(): string {
  const candidate = path.join(PACKAGE_ROOT, 'bin', 'hologram-engine.exe')
  if (!existsSync(candidate)) {
    throw new Error(
      `hologram-dsh: bundled engine not found at ${candidate}. Run "pnpm run pack:bin" in the hologram-dsh package (or "npm run dsh:pack" in the repo) to copy it in — the engine binary is not committed to source control.`,
    )
  }
  return candidate
}

/**
 * Resolve the project root the engine should analyze. Empty (the schema
 * default) falls back to the current working directory of the dsh process.
 */
export function resolveProjectRoot(configProjectRoot: string): string {
  return configProjectRoot.trim().length > 0
    ? path.resolve(configProjectRoot)
    : process.cwd()
}


// ═══ 阶段2·发货形态：在 DSH web 里托管 3D 视图 + 实时图数据（不再依赖独立 dev 端口）═══

// viewer 静态产物目录（viewer/dist，构建后随包分发）
const VIEWER_DIST = path.join(PACKAGE_ROOT, 'viewer', 'dist')

/** 内容类型推断（SPA 静态托管最小集）。 */
function contentType(ext: string): string {
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * 给 viewer 提供 GraphJSON —— 尊重引擎的「数据生命周期」。
 *
 * 引擎的设计本意是「一个长驻进程持有图：全量 analyze 一次，之后所有查询读同一份
 * 内存图」。Tauri 端就是常驻 9777 的 TCP 引擎。早期实现每次请求临时 spawn 一个
 * 新引擎全量重分析再杀进程——把引擎的持久化/内存图/watcher 生命周期全绕过了，
 * 每次打开都是 20s 全量扫描。现在改为：
 *
 *   - host 插件内保持一个长驻引擎进程（TCP 9777，与 Tauri 用法一致）；
 *   - analyze 只在「首次 / 换了项目 / ?refresh=1 显式刷新」时发生；
 *   - 其余请求直接 get_graph（读引擎内存，毫秒级）；
 *   - 请求串行化（同一时刻一个未完成请求），引擎崩溃自动重启。
 */
let engineProc: ReturnType<typeof spawn> | null = null
let engineSocket: ReturnType<typeof connect> | null = null
let engineConnecting: Promise<ReturnType<typeof connect>> | null = null
let engineEpoch = 0
let analyzedProject: string | null = null
let engineQueue: Promise<unknown> = Promise.resolve()

function killEngine(): void {
  engineEpoch++
  try { engineProc?.kill() } catch { /* 尽力 */ }
  try { engineSocket?.destroy() } catch { /* 尽力 */ }
  engineProc = null
  engineSocket = null
  engineConnecting = null
  analyzedProject = null
}

/** 确保长驻引擎在跑并已绑定 9777；返回可用 socket。 */
function ensureEngine(bin: string): Promise<ReturnType<typeof connect>> {
  if (engineConnecting) return engineConnecting
  if (engineSocket) return Promise.resolve(engineSocket)
  const epoch = engineEpoch
  engineConnecting = (async () => {
    engineProc = spawn(bin, [], { stdio: ['ignore', 'ignore', 'ignore'] })
    let lastErr: unknown = new Error('engine did not bind 9777')
    for (let attempt = 0; attempt < 120; attempt++) {
      if (engineEpoch !== epoch) throw new Error('engine restarted')
      try {
        const sock = connect(9777, '127.0.0.1')
        await new Promise<void>((res, rej) => {
          sock.once('connect', () => res())
          sock.once('error', (e) => rej(e))
        })
        engineSocket = sock
        sock.on('error', () => { if (engineSocket === sock) killEngine() })
        sock.on('close', () => { if (engineSocket === sock) killEngine() })
        return sock
      } catch (e) {
        lastErr = e
        await new Promise(r => setTimeout(r, 500))
      }
    }
    throw lastErr
  })()
  const p = engineConnecting
  p.then(() => { if (engineConnecting === p) engineConnecting = null }).catch(() => { if (engineConnecting === p) engineConnecting = null })
  return p
}

/** 帧协议请求（4 字节 LE 长度前缀 + JSON），串行化，带超时。 */
function engineRequest(bin: string, cmd: string): Promise<string> {
  const run = engineQueue.then(async () => {
    const sock = await ensureEngine(bin)
    return new Promise<string>((resolve, reject) => {
      let buf = Buffer.alloc(0)
      let settled = false
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        while (buf.length >= 4) {
          const len = buf.readUInt32LE(0)
          if (buf.length < 4 + len) break
          const payload = buf.subarray(4, 4 + len).toString('utf8')
          buf = buf.subarray(4 + len)
          if (!settled) { settled = true; sock.off('data', onData); resolve(payload) }
        }
      }
      sock.on('data', onData)
      sock.write(cmd + '\n')
      setTimeout(() => {
        if (!settled) { settled = true; sock.off('data', onData); reject(new Error('engine request timeout: ' + cmd)) }
      }, 180000)
    })
  })
  engineQueue = run.catch(() => { /* 队列吞错，避免断链 */ })
  return run
}

/**
 * 取图：analyze 只发生在首次 / 换项目 / refresh；否则直接读引擎内存。
 * 引擎 analyze 成功返回 GraphJSON；失败返回 {"error": ...}。
 */
async function fetchGraphFromEngine(
  bin: string,
  project: string,
  refresh: boolean,
): Promise<{ nodes: unknown[]; edges: unknown[]; meta: { project: string } }> {
  if (refresh || analyzedProject !== project) {
    const raw = await engineRequest(bin, 'analyze:' + project)
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.error) throw new Error(String(parsed.error))
    analyzedProject = project
  }
  const g = JSON.parse(await engineRequest(bin, 'get_graph'))
  if (g && typeof g === 'object' && g.error) throw new Error(String(g.error))
  return { nodes: g.nodes ?? [], edges: g.edges ?? [], meta: { project } }
}

export function createGraphHandler(bin: string) {
  return async function graphHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x')
    const project = u.searchParams.get('project')
    const refresh = u.searchParams.get('refresh') === '1'
    if (!project) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '?project=<path> required' })); return }
    res.setHeader('access-control-allow-origin', '*')
    try {
      const graph = await fetchGraphFromEngine(bin, project, refresh)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(graph))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: (e as Error).message }))
    }
  }
}

/**
 * 托管 viewer 静态产物（SPA）：/hologram/ 下的 index.html + assets；深路径回退到 index.html。
 */
export function createStaticHandler(distDir: string) {
  return function staticHandler(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? '/', 'http://x')
    let p = decodeURIComponent(u.pathname)
    // 归一：/hologram → /hologram/
    if (p === '/hologram') p = '/hologram/'
    const rel = p.replace(/^\/hologram\/?/, '') || 'index.html'
    const base = rel.split('/')[0]
    let filePath: string
    if (base === 'assets' && rel.includes('/')) {
      filePath = path.join(distDir, rel)
    } else {
      filePath = path.join(distDir, 'index.html')
    }
    try {
      if (!statSync(filePath).isFile()) throw new Error('not file')
      const body = readFileSync(filePath)
      res.writeHead(200, { 'content-type': contentType(path.extname(filePath)) })
      res.end(body)
    } catch {
      // SPA fallback
      try {
        const body = readFileSync(path.join(distDir, 'index.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(body)
      } catch {
        res.writeHead(404); res.end('hologram viewer not built (run vite build in viewer/)')
      }
    }
  }
}

/** 注册 /hologram 路由（web profile 时）。由 apply 调用；无 webServer 则跳过（headless 安全）。 */
function registerWebRoutes(ctx: Context, bin: string): (() => void)[] {
  const webServer = (ctx as unknown as { webServer?: { register: (r: unknown) => () => void } }).webServer
  if (webServer === undefined) return []
  if ((webServer as { register?: unknown }).register === undefined) return []

  const disposers: (() => void)[] = []
  disposers.push(webServer.register({
    kind: 'prefix', path: '/hologram',
    handler: createStaticHandler(VIEWER_DIST),
  }))
  disposers.push(webServer.register({
    kind: 'exact', path: '/hologram/api/graph',
    handler: createGraphHandler(bin),
  }))
  return disposers
}


/**
 * Mount the engine facts service.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const bin = resolveEngineBinary()
  const projectRoot = resolveProjectRoot(config.projectRoot)
  const service: HologramEngineService = {
    bin,
    projectRoot,
    serveArgs: ['serve', '--project-root', projectRoot],
    env: config.env,
  }
  ctx.provide(SERVICE, service)
  if (config.enableWebRoutes) {
    const disposers = registerWebRoutes(ctx, bin)
    for (const d of disposers) {
      ctx.effect(() => d, 'hologram-dsh: web route')
    }
  }
}