// serve-graph.mjs — 给 viewer 提供「实时分析一个项目并返回 GraphJSON」的 HTTP 端点。
// 用法: node serve-graph.mjs [--port=5190]
// 端点: GET /graph?project=<abs-path>  -> 对 project 跑引擎 analyze+get_graph，返回 GraphJSON
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const ENGINE = process.env.HOLOGRAM_ENGINE || 'D:/HoloGramHG/engine/target/release/hologram-engine.exe'
const PORT = Number(process.env.HOLOGRAM_GRAPH_PORT || 5190)

function connectWithRetry(host, port, tries = 60, delayMs = 500) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const s = connect(port, host)
      s.once('connect', () => resolve(s))
      s.once('error', (e) => {
        if (n <= 0) return reject(e)
        setTimeout(() => attempt(n - 1), delayMs)
      })
    }
    attempt(tries)
  })
}

function fetchGraph(project) {
  return new Promise((resolve, reject) => {
    if (!existsSync(project)) return reject(new Error('project not found: ' + project))
    const engine = spawn(ENGINE, [], { stdio: ['ignore','ignore','ignore'] })
    const fail = (e) => { engine.kill(); reject(e) }
    const eatup = () => { engine.kill() }
    connectWithRetry('127.0.0.1', 9777).then((sock) => {
      let buf = Buffer.alloc(0), pend = [], done = false
      sock.on('data', d => {
        buf = Buffer.concat([buf, d])
        while (buf.length >= 4) {
          const len = buf.readUInt32LE(0)
          if (buf.length < 4 + len) break
          const payload = buf.subarray(4, 4+len).toString('utf8')
          buf = buf.subarray(4+len)
          const fn = pend.shift(); if (fn) fn(payload)
        }
      })
      const req = cmd => new Promise(r => { pend.push(r); sock.write(cmd + '\n') })
      const doneCleanup = () => { eatup(); sock.destroy() }
      sock.on('error', e => { if(!done) { done = true; doneCleanup(); fail(e) } })
      ;(async () => {
        try {
          await req('analyze:' + project)
          const g = JSON.parse(await req('get_graph'))
          if (done) return; done = true; doneCleanup()
          resolve({ nodes: g.nodes ?? [], edges: g.edges ?? [], meta: { project } })
        } catch (e) { if(!done){done=true; doneCleanup(); fail(e)} }
      })()
    }).catch(fail)

  })
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/graph') {
    const project = u.searchParams.get('project')
    if (!project) { res.writeHead(400); res.end('?project=<path> required'); return }
    try { const g = await fetchGraph(project); res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(g)) }
    catch (e) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({ error: e.message })) }
  } else { res.writeHead(404); res.end('not found') }
})
server.listen(PORT, () => console.log('[serve-graph] listening on http://127.0.0.1:' + PORT))