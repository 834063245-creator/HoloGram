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
 * 给 viewer 提供 GraphJSON —— 读「共享引擎」的数据（单一数据生命周期）。
 *
 * 引擎进程以 serve --tcp 启动：stdio MCP（34 个工具）与 TCP 9777（viewer）跑在
 * 同一个进程里，共享同一份内存图 + watcher 增量更新。host 插件不再 spawn 自己的
 * 引擎，而是直连共享引擎的 9777：
 *
 *   - get_graph：读引擎内存（含 watcher 实时增量后的最新图），毫秒级；
 *   - analyze:<project>：只在「首次 / 图不属于该项目 / ?refresh=1」时发送——
 *     会切换共享引擎的工作区（与 Tauri 行为一致），MCP 工具随之查同一份图；
 *   - 请求串行化，连接断开自动重连。
 */
let engineSocket: ReturnType<typeof connect> | null = null
let engineConnecting: Promise<ReturnType<typeof connect>> | null = null
let analyzedProject: string | null = null
let engineQueue: Promise<unknown> = Promise.resolve()

function dropEngineSocket(): void {
  try { engineSocket?.destroy() } catch { /* 尽力 */ }
  engineSocket = null
  engineConnecting = null
  analyzedProject = null
}

/** 连接共享引擎（MCP 引擎的 TCP 9777）。只连接不 spawn——引擎归 dsh-mcp-client 管。 */
function ensureEngine(): Promise<ReturnType<typeof connect>> {
  if (engineConnecting) return engineConnecting
  if (engineSocket) return Promise.resolve(engineSocket)
  engineConnecting = (async () => {
    let lastErr: unknown = new Error('hologram engine not reachable on 127.0.0.1:9777 — 共享引擎未运行（dsh-mcp-client 的 hologram 引擎应常驻）')
    // 引擎可能正在启动（MCP 连接建立 + 首次连接 9777 需要一点时间）：重试 ~10s
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const sock = connect(9777, '127.0.0.1')
        await new Promise<void>((res, rej) => {
          sock.once('connect', () => res())
          sock.once('error', (e) => rej(e))
        })
        engineSocket = sock
        sock.on('error', () => { if (engineSocket === sock) dropEngineSocket() })
        sock.on('close', () => { if (engineSocket === sock) dropEngineSocket() })
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
function engineRequest(cmd: string): Promise<string> {
  const run = engineQueue.then(async () => {
    const sock = await ensureEngine()
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

/** 图是否属于该项目：取样本节点 location，多数落在 project 前缀下即视为匹配。 */
function graphMatchesProject(graph: { nodes?: unknown[] }, project: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const target = norm(project)
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) return false
  const sample = graph.nodes.slice(0, 60)
  let hits = 0
  for (const n of sample) {
    const loc = norm(String((n as { location?: unknown }).location ?? (n as { name?: unknown }).name ?? ''))
    if (loc.startsWith(target)) hits++
  }
  return hits >= Math.ceil(sample.length * 0.5)
}

/**
 * 取图：analyze 只在「首次 / 图不属于该项目 / refresh」时发生；
 * 否则直接读共享引擎内存（含 watcher 增量）。
 */
async function fetchGraphFromEngine(
  _bin: string,
  project: string,
  refresh: boolean,
): Promise<{ nodes: unknown[]; edges: unknown[]; meta: { project: string } }> {
  // 先读一次：若共享引擎已持有该项目的图（比如 MCP analyze_project 刚分析过），
  // 直接秒回，不重复分析。
  let g = JSON.parse(await engineRequest('get_graph'))
  if (g && typeof g === 'object' && g.error) throw new Error(String(g.error))
  if (!refresh && graphMatchesProject(g, project)) {
    analyzedProject = project
    return { nodes: g.nodes ?? [], edges: g.edges ?? [], meta: { project } }
  }
  // 需要分析：切换共享引擎到该项目（与 Tauri 工作区切换一致）。
  // ?refresh=1 → reanalyze:（强制全量）；否则 analyze:（引擎内先查存量缓存，
  // 有且源码未变则秒回，避免每次打开都全量重扫）。
  const raw = await engineRequest(refresh ? 'reanalyze:' + project : 'analyze:' + project)
  const parsed = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && parsed.error) throw new Error(String(parsed.error))
  analyzedProject = project
  g = JSON.parse(await engineRequest('get_graph'))
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
    serveArgs: ['serve', '--project-root', projectRoot, '--tcp'],
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