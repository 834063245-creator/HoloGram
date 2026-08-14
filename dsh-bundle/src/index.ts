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
 * 给 viewer 提供「实时 analyze 一个项目 → GraphJSON」。
 * 复用引擎二进制（TCP analyze + get_graph），等价于独立的 serve-graph 进程，
 * 但作为 DSH webserver 的一个路由 handler 内联运行——发货后不依赖 5190。
 */
// 每项目的内存图缓存：首次 analyze 后复用，之后的请求秒回 —— 尊重引擎"图数据生命周期"，
// 不再每次都全量重分析（大仓单次分析可达 ~20s）。
const graphCache = new Map<string, { graph: { nodes: unknown[]; edges: unknown[]; meta: { project: string } }; at: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟，之后可手动强制刷新

export function createGraphHandler(bin: string) {
  return async function graphHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x')
    const project = u.searchParams.get('project')
    const refresh = u.searchParams.get('refresh') === '1'
    if (!project) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '?project=<path> required' })); return }
    res.setHeader('access-control-allow-origin', '*')
    try {
      const hit = graphCache.get(project)
      const fresh = hit !== undefined && !refresh && (Date.now() - hit.at) < CACHE_TTL_MS
      if (fresh) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(hit.graph))
        return
      }
      const graph = await fetchGraphFromEngine(bin, project)
      graphCache.set(project, { graph, at: Date.now() })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(graph))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: (e as Error).message }))
    }
  }
}

/** 起引擎 TCP server → analyze + get_graph → 返回 GraphJSON → 杀引擎。 */
function fetchGraphFromEngine(bin: string, project: string): Promise<{ nodes: unknown[]; edges: unknown[]; meta: { project: string } }> {
  return new Promise((resolve, reject) => {
    const engine = spawn(bin, [], { stdio: ['ignore', 'ignore', 'ignore'] })
    const fail = (e: unknown) => { engine.kill(); reject(e) }
    // 等引擎绑定 9777（重试）
    const tryConnect = (attempt: number) => {
      const sock = connect(9777, '127.0.0.1')
      const onC = async () => {
        let buf = Buffer.alloc(0); const pend: ((p: string) => void)[] = []; let done = false
        const cleanup = () => { engine.kill(); sock.destroy() }
        const failOnce = (e: unknown) => { if (!done) { done = true; cleanup(); reject(e) } }
        sock.on('data', (d: Buffer) => {
          buf = Buffer.concat([buf, d])
          while (buf.length >= 4) {
            const len = buf.readUInt32LE(0)
            if (buf.length < 4 + len) break
            const payload = buf.subarray(4, 4 + len).toString('utf8')
            buf = buf.subarray(4 + len)
            pend.shift()?.(payload)
          }
        })
        sock.on('error', failOnce)
        const req = (cmd: string) => new Promise<string>(r => { pend.push(r); sock.write(cmd + '\n') })
        try {
          await req('analyze:' + project)
          const g = JSON.parse(await req('get_graph'))
          if (!done) { done = true; cleanup(); resolve({ nodes: g.nodes ?? [], edges: g.edges ?? [], meta: { project } }) }
        } catch (e) { failOnce(e) }
      }
      const onErr = () => {
        if (attempt <= 0) fail(new Error('engine did not bind 9777'))
        else setTimeout(() => tryConnect(attempt - 1), 500)
      }
      sock.once('connect', onC)
      sock.once('error', onErr)
    }
    tryConnect(60)
    setTimeout(() => fail(new Error('engine timeout')), 120000)
  })
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