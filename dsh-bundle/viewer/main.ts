// HoloGram · 深空星图 — DSH web 独立 3D viewer（阶段2，完整 StarGraph 渲染）
//
// 直接构建 src-ui/src/ui 的 HoloGram StarGraph facade 及其全部渲染子模块
//（graph-node-renderer / graph-edge-renderer / graph-layout / gpu-layout / graph-shaders /
//  graph-glow-instanced / graph-fold / graph-focus-controller / graph-interaction …）。
// 渲染内核与主应用同源，不维护副本；仅通过 vite alias 把 HoloGram app 耦合
//（shell-store / events / debug / app-shell）换成 kernel/stubs 的轻量替代。观感即原版。

import { StarGraph } from '@hologram-kernel/graph'
import type { GraphJSON } from '@hologram-kernel/graph-types'

// 带超时的 fetch：大项目分析可长达数十秒，要给用户明确的进度与超时反馈。
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const app = document.getElementById('app') as HTMLElement
  const hud = document.getElementById('hud')!

  const q = new URLSearchParams(location.search)
  const project = q.get('project')
  const graphURL = q.get('data') ?? './data.graph.json'

  let graph: GraphJSON
  if (project) {
    // 客户端会话级缓存：同项目本次会话内复用，不再每次重新分析（尊重引擎图数据生命周期）。
    const cacheKey = 'hologram-graph:' + project
    const ttl = 5 * 60 * 1000
    let cached: { graph: GraphJSON; at: number } | undefined
    try { cached = JSON.parse(sessionStorage.getItem(cacheKey) ?? '') } catch { /* ignore */ }
    const refresh = q.get('refresh') === '1'
    if (cached && typeof cached === 'object' && Date.now() - (cached.at ?? 0) < ttl && !refresh) {
      graph = cached.graph
      hud.innerHTML = '♻ 已用缓存（' + (Array.isArray(graph.nodes) ? graph.nodes.length : 0) + ' 节点）— ?refresh=1 可重新分析'
    } else {
      const url = '/hologram/api/graph?project=' + encodeURIComponent(project)
      hud.innerHTML = '⏳ 正在分析项目…（大项目可能需要几十秒）'
      const started = performance.now()
      graph = await fetchWithTimeout(url, 120000)
        .then(r => { if (!r.ok) throw new Error('引擎分析失败 ' + r.status); return r.json() })
        .then(j => {
          try { sessionStorage.setItem(cacheKey, JSON.stringify({ graph: j, at: Date.now() })) } catch { /* storage full */ }
          hud.innerHTML = `已分析 ${Array.isArray(j.nodes) ? j.nodes.length : 0} 节点，渲染中…(${Math.round((performance.now() - started) / 1000)}s)`
          return j
        })
    }
  } else {
    graph = await fetch(graphURL).then(r => r.json())
  }

  // 大图：力导向布局在主线程同步计算，会短暂卡顿几秒 —— 先给提示避免误以为卡死
  if (n_nodes() > 3000) hud.innerHTML += '<br/><span style="color:#8fb8d8">布局计算中，大图可能卡几秒…</span>'
  const star = new StarGraph(app)
  await star.render(graph)

  function n_nodes() { return Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes ?? {}).length }

  const n = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes ?? {}).length
  const e = Array.isArray(graph.edges) ? graph.edges.length : Object.keys(graph.edges ?? {}).length
  hud.innerHTML = `<b>${n}</b> nodes · <b>${e}</b> edges · 内核：HoloGram StarGraph (完整)`

  const resize = () => star.resize()
  addEventListener('resize', resize)
}

main().catch(err => {
  const msg = (err?.message ?? String(err))
  document.getElementById('hud')!.innerHTML = '⚠ ' + (msg.includes('abort') ? '分析超时（>120s）或已取消' : msg)
  console.error(err)
})