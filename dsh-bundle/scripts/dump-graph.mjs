import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// 开发辅助：用引擎 TCP 导出 fixture 的 GraphJSON 到 viewer/data.graph.json。
// 所有路径都从本文件位置推导，可用环境变量覆盖（不再硬编码开发机绝对路径）。
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ENGINE = process.env.HOLOGRAM_ENGINE
  ?? join(REPO_ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'hologram-engine.exe' : 'hologram-engine')
const FIXTURE = process.env.HOLOGRAM_FIXTURE ?? join(REPO_ROOT, 'engine', 'fixtures', 'test_project')
const OUT = join(REPO_ROOT, 'dsh-bundle', 'viewer', 'data.graph.json')

// 1) start engine TCP server
const engine = execFile(ENGINE, [], {})
console.log('[dump] engine spawned, waiting for listen...')
await new Promise(r => setTimeout(r, 2500))
const sock = connect(9777, '127.0.0.1')
let buf = Buffer.alloc(0)
const pending = []
sock.on('data', d => {
  buf = Buffer.concat([buf, d])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) break
    const payload = buf.subarray(4, 4 + len).toString('utf8')
    buf = buf.subarray(4 + len)
    pending.splice(0,1)[0]?.(payload)
  }
})
const req = (cmd) => new Promise(r => { pending.push(r); sock.write(cmd + '\n') })
sock.on('connect', async () => {
  try {
    console.log('[dump] connected, analyzing fixture...')
    const a = await req('analyze:' + FIXTURE)
    const an = JSON.parse(a)
    console.log('[dump] analyze: nodes=', an.node_count, 'edges=', an.edge_count)
    const g = await req('get_graph')
    const graph = JSON.parse(g)
    const full = {
      _source: 'hologram-engine get_graph (TCP) on ' + FIXTURE,
      nodes: (graph.nodes ?? []).map(n => ({ id:n.id, name:n.name, type:n.type, kind:n.type, location:n.location, community_id:n.community_id ?? undefined })),
      edges: (graph.edges ?? []).map(e => ({ id:e.id, source:e.source, target:e.target, type:e.type, coupling_depth:e.coupling_depth })),
      meta: { generator: 'HoloGram engine TCP export', fixture: FIXTURE }
    }
    writeFileSync(OUT, JSON.stringify(full, null, 2))
    console.log('[dump] wrote data.graph.json nodes=', full.nodes.length, 'edges=', full.edges.length)
  } catch (e) { console.error('[dump] error', e.message) }
  finally { engine.kill(); process.exit(0) }
})
