// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram 主入口
// 三模式星图：minimal / standard / full — 独立实例，切换即重建
// v4.1: Workspace 抽象 — 所有工作区状态统一管理

import './ui/react/base.css';
import './ui/react/chat.css';
import './ui/react/panels.css';
import { rpc, listen, isMockMode } from './bridge';
import { StarGraph } from './ui/graph';
import { ChatPanel } from './ui/chat';
import { CheckPanel, type CheckResult } from './ui/check';

import { TimelinePanel } from './ui/react/TimelinePanel';
import { ConstraintsPanel } from './ui/constraints';
import { HotspotsPanel } from './ui/hotspots';
import { DataflowPanel } from './ui/dataflow-panel';
import { SettingsPanel } from './ui/settings-panel';
import { bus } from './ui/events';
import { shell } from './ui/app-shell';
import { initLogger, log } from './agent/logger';
import { loadSettings, saveSettings } from './settings';
import { t, setLang } from './i18n';
import { iconSvg } from './ui/icons';
import { AgentVisualizer } from './ui/agent-visualizer';
import { GraphInteraction } from './ui/graph-interaction';
import { dbg } from './ui/debug';
import { Workspace, isSamePath } from './workspace';
// Lazy FileViewer — avoids pulling Monaco (~5MB) into initial bundle
let _FileViewer: any = null;
async function loadFileViewer(): Promise<void> {
  if (!_FileViewer) {
    const mod = await import('./ui/file-viewer');
    _FileViewer = mod.FileViewer;
  }
}
function FV(): any { return _FileViewer; }
// ponytail: permission dialog now embedded inline via ChatPanel.showPermissionCard

// ── Worker layout helper ──

/**
 * 构建边索引对数组
 * 将图中的边从节点ID映射转换为基于节点索引的数值对，便于后续图算法处理
 * @param graph - 图对象，包含 nodes（节点集合）和 edges（边集合）
 * @returns 边索引对数组，每个元素为 [sourceIndex, targetIndex] 的元组
 */
function buildEdgePairs(graph: any): Array<[number, number]> {
  // 统一处理节点数据：支持数组或对象两种结构
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : Object.values(graph.nodes || {});
  // 建立节点ID到数组索引的映射表，用于快速查找
  const nodeIdx = new Map<string, number>();
  nodes.forEach((n: any, i: number) => nodeIdx.set(n.id, i));
  // 统一处理边数据：支持数组或对象两种结构
  const edges = Array.isArray(graph.edges) ? graph.edges : Object.values(graph.edges || {});
  // 存储转换后的索引边对
  const pairs: Array<[number, number]> = [];
  for (const e of edges) {
    // 通过节点ID查找对应的数组索引
    const s = nodeIdx.get(e.source), t = nodeIdx.get(e.target);
    // 仅当源节点和目标节点均存在时才保留该边
    if (s !== undefined && t !== undefined) pairs.push([s, t]);
  }
  return pairs;
}

function layoutViaWorker(
  nodeCount: number,
  pairs: Array<[number, number]>,
): Promise<Float32Array> {
  return new Promise((resolve) => {
    try {
      const worker = new Worker(new URL('./ui/layout.worker.ts', import.meta.url), { type: 'module' });
      const timeout = setTimeout(() => {
        worker.terminate();
        import('./ui/graph').then(() => resolve(new Float32Array(0))).catch(() => resolve(new Float32Array(0)));
      }, 5000);
      worker.onmessage = (e: MessageEvent) => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(e.data.pos as Float32Array);
      };
      worker.onerror = () => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(new Float32Array(0));
      };
      worker.postMessage({ nodes: nodeCount, pairs });
    } catch {
      resolve(new Float32Array(0));
    }
  });
}

// ── UI ──
const welcome = document.getElementById('welcome')!;
const graphEl = document.getElementById('graph')!;
const statusText = document.getElementById('status-text')!;

// ── Status log (ring buffer + expandable panel) ──
const STATUS_LOG_MAX = 15;
const statusLog: string[] = [];

function pushStatus(msg: string): void {
  statusLog.push(msg);
  if (statusLog.length > STATUS_LOG_MAX) statusLog.shift();
  statusText.textContent = msg;
  updateStatusBadge();
}

function updateStatusBadge(): void {
  let badge = document.getElementById('status-log-badge') as HTMLElement | null;
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'status-log-badge';
    badge.style.cssText = 'margin-left:6px;cursor:pointer;font-size:10px;padding:0 4px;border-radius:3px;background:#333;color:#888';
    badge.textContent = String(statusLog.length);
    badge.onclick = toggleStatusLog;
    statusText.parentElement?.insertBefore(badge, statusText.nextSibling);
  }
  badge.textContent = String(statusLog.length);
}

function toggleStatusLog(): void {
  let panel = document.getElementById('status-log-panel');
  if (panel) { panel.remove(); return; }

  panel = document.createElement('div');
  panel.id = 'status-log-panel';
  panel.style.cssText = 'position:fixed;bottom:28px;right:8px;width:420px;max-height:300px;overflow-y:auto;background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:8px;font-family:monospace;font-size:11px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.5)';
  panel.innerHTML = statusLog.map((m, i) =>
    `<div style="padding:2px 0;border-bottom:1px solid #222;color:${i === statusLog.length - 1 ? '#ccc' : '#666'}">${escapeHtml(m)}</div>`
  ).join('');
  panel.onclick = (e) => e.stopPropagation();
  document.body.appendChild(panel);
  // Click outside to dismiss
  setTimeout(() => {
    const dismiss = () => { panel?.remove(); document.removeEventListener('click', dismiss); };
    document.addEventListener('click', dismiss);
  }, 0);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
const tbPath = document.getElementById('tb-path')!;
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;
const btnReanalyze = document.getElementById('btn-reanalyze') as HTMLButtonElement;
const btnWelcomeOpen = document.getElementById('btn-welcome-open') as HTMLButtonElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const btnFold = document.getElementById('btn-fold') as HTMLButtonElement;
const btnResetCam = document.getElementById('btn-reset-cam') as HTMLButtonElement;
const btnCheck = document.getElementById('btn-check') as HTMLButtonElement;
const btnDiff = document.getElementById('btn-diff') as HTMLButtonElement;
const btnTimeline = document.getElementById('btn-timeline') as HTMLButtonElement;
const btnConstraints = document.getElementById('btn-constraints') as HTMLButtonElement;

// ── State ──
let workspace: Workspace | null = null;
let starGraph: StarGraph = new StarGraph(graphEl);
let agentViz: AgentVisualizer | null = null;
// Reentry guard for switchWorkspace — prevents stacked concurrent switches
// when deactivate() stalls on watcher teardown.
let _switching = false;

// Panel singletons
let chatPanel: ChatPanel;
let checkPanel: CheckPanel;
let timelinePanel: TimelinePanel;
let hotspotsPanel: HotspotsPanel;
let dataflowPanel: DataflowPanel;

// ── Folder picker ──

async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false, title: '选择工作区目录' });
    return result as string | null;
  } catch {
    return prompt('输入项目路径:');
  }
}

// ═══════════════════════════════════════════════════════════════
// switchWorkspace — unified entry point
// ═══════════════════════════════════════════════════════════════

async function switchWorkspace(
  path?: string,
  opts?: { skipAnalysis?: boolean; cachedGraph?: any },
): Promise<void> {
  if (_switching) { statusText.textContent = '正在切换工作区，请稍候…'; return; }
  _switching = true;
  try {
    const folder = path || (await pickFolder());
    if (!folder) return;

    if (workspace?.active && isSamePath(workspace.path, folder)) {
      statusText.textContent = '已在当前工作区';
      return;
    }

    // Disable the open button BEFORE the possibly-slow deactivate() await.
    // Otherwise the button stays clickable while the watcher is being torn
    // down and repeated clicks stack concurrent switches.
    setLoading(true, folder);

    // Deactivate old
    if (workspace) {
      await workspace.deactivate(chatPanel);
      workspace = null;
    }

    resetCheckPanelState();

    // Create new — pass callbacks immediately so progress events during
    // Workspace.open (analyze + render) push visible status updates.
    const onStatusChange = (msg: string) => { pushStatus(msg); };
    const onLoadingChange = (loading: boolean) => { setLoading(loading, loading ? folder : undefined); };
    let ws: Workspace;
    try {
      console.log('[switchWorkspace] calling Workspace.open...');
      ws = await Workspace.open(folder, starGraph, chatPanel, checkPanel, opts, { onStatusChange, onLoadingChange });
      console.log('[switchWorkspace] Workspace.open returned');
    } catch (err: any) {
      console.error('[switchWorkspace] Workspace.open threw:', err);
      statusText.textContent = `分析失败: ${err}`;
      setLoading(false);
      throw err;
    }
    ws.onStatusChange = onStatusChange;
    ws.onLoadingChange = onLoadingChange;

    workspace = ws;
    await notifyAllPanels(ws);

    const nodeCount = Array.isArray(ws.graphData.nodes) ? ws.graphData.nodes.length : Object.keys(ws.graphData.nodes || {}).length;
    const genTime = ws.graphData.meta?.generated_at ? new Date(ws.graphData.meta.generated_at).toLocaleTimeString() : '';
    statusText.textContent = `✨ ${nodeCount} 节点已就绪${genTime ? ` · ${genTime}` : ''}`;
    log.info('main', 'project loaded', {
      nodes: nodeCount,
      edges: Array.isArray(ws.graphData.edges) ? ws.graphData.edges.length : Object.keys(ws.graphData.edges || {}).length,
    });
    setLoading(false);

    try { await ws.setupAgent(chatPanel, checkPanel); } catch (e) { console.error('[switchWorkspace] setupAgent failed:', e); }

    chatPanel.setProjectPath(folder);
    chatPanel.autoRestoreLastSession(folder).catch(() => {});
    ws.runCheck(checkPanel);
    await rpc('workspace_start_watcher').catch(() => {});
  } finally {
    _switching = false;
  }
}

function setLoading(active: boolean, folder?: string): void {
  btnOpen.disabled = active;
  btnOpen.innerHTML = active ? `${iconSvg('dot')} 分析中...` : `${iconSvg('folder-open')} 打开文件夹`;
  if (active) pushStatus(`正在分析 ${folder || ''}...`);
}

function resetCheckPanelState(): void {
  checkPanel.update({
    passed: true, timestamp: '', changed_files: [], total_changed_files: 0,
    l5_violations: [], l4_violations: [], l3_violations: [], l2_violations: [],
    passed_checks: [], blast_radius: 0, cross_community_edges: 0,
    new_cycles: 0, new_thread_conflicts: 0, api_signature_changes: 0,
  });
  clearCheckBadge();
}

function setCheckBadge(violations: number): void {
  const existing = btnCheck.querySelector('.toolbar-badge');
  if (existing) existing.remove();
  if (violations <= 0) return;
  const badge = document.createElement('span');
  badge.className = 'toolbar-badge';
  badge.textContent = `${violations}`;
  btnCheck.appendChild(badge);
}

function clearCheckBadge(): void {
  const existing = btnCheck.querySelector('.toolbar-badge');
  if (existing) existing.remove();
}

async function notifyAllPanels(ws: Workspace): Promise<void> {
  tbPath.textContent = ws.path;
  welcome.classList.add('hidden');
  graphEl.classList.remove('hidden');
  btnOpen.disabled = false;
  btnOpen.innerHTML = `${iconSvg('folder-open')} 打开文件夹`;
  chatPanel.setProjectPath(ws.path);
  timelinePanel.setProjectPath(ws.path);
  hotspotsPanel.setProjectPath(ws.path);
  await loadFileViewer();
  FV().get().setProjectPath(ws.path);
  if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().load(ws.path);
  window.dispatchEvent(new CustomEvent('workspace:switched'));
}

// ── Check (thin wrapper) ──

async function runCheck(): Promise<void> {
  if (workspace) await workspace.runCheck(checkPanel);
}

// ── Search ──

function doSearch(): void {
  const query = searchInput.value.trim(); if (!query) return;
  const found = starGraph.focusNode(query);
  searchInput.blur(); // ponytail: 搜完释放焦点，恢复键盘快捷键
  if (!found) { statusText.textContent = `未找到 "${query}"`; setTimeout(() => { if (statusText.textContent === `未找到 "${query}"`) statusText.textContent = '就绪'; }, 2000); }
}

// ── Icon setup ──

function setupIcons(): void {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const iconName = (el as HTMLElement).dataset['icon']!;
    const svgStr = iconSvg(iconName);
    el.insertAdjacentHTML('afterbegin', svgStr);
    (el as HTMLElement).classList.add('toolbar-btn');
    // Wrap existing text in a span so icon survives textContent changes
    const textContent = el.childNodes.length > 1 ? el.childNodes[1]?.textContent || '' : '';
    if (textContent.trim()) {
      (el as HTMLElement).innerHTML = svgStr;
      const label = document.createElement('span');
      label.className = 'btn-label';
      label.textContent = textContent.trim();
      el.appendChild(label);
    }
  });
}
// ── Helper: set up agent with placeholder workspace (no project loaded) ──
async function setupPlaceholderAgent(): Promise<void> {
  if (workspace) return;
  // Clear backend workspace binding — prevents stale PermissionContext from
  // previous project leaking into the placeholder's read_file / list_directory calls.
  await rpc('workspace_activate', { path: '' }).catch(() => {});
  const ws = Workspace.placeholder();
  ws.onStatusChange = (msg) => { pushStatus(msg); };
  try { await ws.setupAgent(chatPanel, checkPanel); } catch (e) { console.error('[init] setupAgent failed:', e); }
}

// ── Init ──

async function init(): Promise<void> {
  setLang(loadSettings().display.language);
  document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
  starGraph.resize(); // CSS custom props changed → container shrunk → canvas must follow

  const { listen } = await import('@tauri-apps/api/event');

  await listen('unity-event', (event: any) => {
    const { event: evt, payload } = event.payload;
    console.log('[Unity]', evt, payload);
    if (evt === 'node_double_clicked') {
      const parts = (payload as string).split('|');
      if (parts.length > 1 && parts[1]) shell.navigateToFile(parts[1]);
    }
    if (evt === 'path_selected') {
      const parts = (payload as string).split('|');
      if (parts.length === 2) {
        chatPanel.open();
        chatPanel.ask(`分析从 ${parts[0]} 到 ${parts[1]} 的依赖路径。请分析这条依赖链的架构合理性、风险点、以及如果修改起点的潜在影响范围。`);
      }
    }
  });

  // ── Backend permission-ask → frontend inline chat card bridge ──
  await listen('permission-ask', (event: any) => {
    const p = event.payload as {
      requestId: string;
      tool: string;
      path: string;
      reason: string;
      suggestions: Array<{ rule: string; behavior: string }>;
    };
    chatPanel.showPermissionCard(p.tool, p.reason, p.path).then((result) => {
      rpc('permission_ask_response', {
        requestId: p.requestId,
        allow: result.allow,
        remember: result.remember || undefined,
        ruleToAdd: result.remember && p.suggestions.length > 0 ? p.suggestions[0].rule : undefined,
        ruleBehavior: result.remember && p.suggestions.length > 0 ? p.suggestions[0].behavior : undefined,
      });
    });
  });

  // Browser shortcut suppression
  (() => {
    const isEditing = () => {
      const el = document.activeElement;
      if (!el) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
    };
    const APP_CTRL_KEYS = new Set(['l', 'd', 'e']);
    const APP_CTRL_KEYS_EXTRA = new Set(['`', ',']);
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;
      if (isEditing()) {
        if (mod && !shift && !alt && new Set(['c', 'v', 'x', 'z', 'y', 'a']).has(key)) return;
        if (mod && !alt && ['r', 'p', 's', 'u', 'o', 'n'].includes(key)) { e.preventDefault(); return; }
        if (key === 'f5' || key === 'f12') { e.preventDefault(); return; }
        if (alt && (key === 'arrowleft' || key === 'arrowright')) { e.preventDefault(); return; }
        return;
      }
            // App-specific shortcuts
      if (mod && !shift && !alt && APP_CTRL_KEYS.has(key)) return;
      if (mod && !shift && !alt && APP_CTRL_KEYS_EXTRA.has(key)) return;
      // Pass-through: standard browser copy/paste/select-all/undo/redo
      if (mod && !shift && !alt && new Set(['c', 'v', 'x', 'a', 'z', 'y']).has(key)) return;
      if (!mod && !alt && !shift && (key === 'f' || key === 'escape' || key === 'b')) return;
      if (['f1', 'f3', 'f4', 'f5', 'f6', 'f7', 'f10', 'f11', 'f12'].includes(key)) { e.preventDefault(); return; }
      if (mod && !alt) { e.preventDefault(); return; }
      if (alt) { e.preventDefault(); return; }
      if (key === 'backspace') { e.preventDefault(); return; }
    }, { capture: true });
  })();

  setupIcons();

  // ── Sandbox health check ──
  rpc<string>('sandbox_status').then(raw => {
    const s = JSON.parse(raw);
    if (s.degraded) {
      console.warn(`[sandbox] ⚠ DEGRADED: ${s.reason} — permission engine is the only barrier`);
    }
  }).catch(() => {});

  // Chat panel
  chatPanel = new ChatPanel(document.body);
  chatPanel.setStarGraph(starGraph);

  // Check panel
  checkPanel = new CheckPanel(document.body);

  // Agent visualizer
  agentViz = new AgentVisualizer(starGraph);
  chatPanel.setOnTrailToggle(() => agentViz?.toggleTrail());

  // Graph interaction
  new GraphInteraction();

  // Timeline
  timelinePanel = new TimelinePanel(document.body);

  // Hotspots
   hotspotsPanel = new HotspotsPanel(document.body);
   hotspotsPanel.setGraph(starGraph);

   // Dataflow panel (floating window)
   dataflowPanel = new DataflowPanel(document.body);

   // Wire NL→symbol fallback: if heuristic parser fails, use Agent to resolve
   dataflowPanel.onParseQuery = async (nl: string): Promise<string[]> => {
     try {
       if (!workspace?.prov) return [];
       const gen = workspace.prov.stream(new AbortController().signal, {
         messages: [{
           role: 'user',
           content: `Extract code symbol names (functions, classes, modules, variables) from this query. Return ONLY a JSON array of strings, nothing else. If no symbols found, return [].\n\nQuery: "${nl}"`,
         }],
         tools: [],
         temperature: 0,
         max_tokens: 200,
       });
       const { ChunkType } = await import('./provider/types');
       const parts: string[] = [];
       for await (const chunk of gen) {
         if (chunk.type === ChunkType.Text && chunk.text) parts.push(chunk.text);
       }
       const text = parts.join('').trim();
       // Extract JSON array from response
       const match = text.match(/\[[\s\S]*\]/);
       if (match) return JSON.parse(match[0]);
       return [];
     } catch { return []; }
   };

  // ── AppShell wiring — replaces bus commands with explicit dispatch ──
  // Register all panels so shell knows who's open
  shell.register({ id: 'check', isOpen: () => checkPanel.isOpen() });
  shell.register({ id: 'chat', isOpen: () => chatPanel.isOpen() });
  shell.register({ id: 'timeline', isOpen: () => timelinePanel.isOpen() });
  shell.register({ id: 'hotspots', isOpen: () => hotspotsPanel.isOpen() });
  shell.register({ id: 'constraints', isOpen: () => ConstraintsPanel.get().isOpen() });
  shell.register({ id: 'dataflow', isOpen: () => dataflowPanel.isOpen() });
  // Wire navigation / highlight / agent-query commands
  shell.wire({
    navigateToNode: (name) => starGraph.focusNode(name),
    navigateToFile: async (path, line) => { await loadFileViewer(); FV().get().open(path, { line }); },
    highlightFile:   (path) => starGraph.highlightFile(path),
    highlightFolder: (path) => starGraph.highlightFolder(path),
    clearHighlight:  ()    => starGraph.clearFileHighlight(),
    queryAgent: (question) => {
      if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
      chatPanel.ask(question);
    },
  });

  // ── Bus notifications (pure notification — sender doesn't care who listens) ──
  bus.on('check:history', ({ checkData, timestamp }: { checkData: CheckResult; timestamp: string }) => {
    checkPanel.showHistory(checkData, timestamp);
    updateTabs();
  });

  bus.on('check:result', ({ passed, violations }: { passed: boolean; violations: number }) => {
    if (passed) { clearCheckBadge(); return; }
    setCheckBadge(violations);
  });

  bus.on('chat:turn-done', () => {
    if (workspace?.path) chatPanel.saveActiveSession(workspace.path).catch(() => {});
  });

  // ── Dock tabs ──
  const leftTabs = document.getElementById('left-tabs')!;
  const rightTabs = document.getElementById('right-tabs')!;
  leftTabs.style.display = '';
  rightTabs.style.display = '';
  const updateTabs = () => {
    const hideLeft = timelinePanel.isOpen() || hotspotsPanel.isOpen();
    const hideRight = checkPanel.isOpen() || ConstraintsPanel.get().isOpen();
    leftTabs.style.display = hideLeft ? 'none' : '';
    rightTabs.style.display = hideRight ? 'none' : '';
    leftTabs.querySelectorAll('.dock-tab').forEach(t => {
      const p = (t as HTMLElement).dataset['panel'];
      const active = (p === 'timeline' && timelinePanel.isOpen())
        || (p === 'hotspots' && hotspotsPanel.isOpen());
      t.classList.toggle('active', !!active);
    });
    rightTabs.querySelectorAll('.dock-tab').forEach(t => {
      const p = (t as HTMLElement).dataset['panel'];
      const active = (p === 'check' && checkPanel.isOpen()) || (p === 'constraints' && ConstraintsPanel.get().isOpen());
      t.classList.toggle('active', !!active);
    });
  };
  shell.onPanelChanged = updateTabs;

  // Left dock — timeline & hotspots
  leftTabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.dock-tab') as HTMLElement;
    if (!tab) return;
    const p = tab.dataset['panel'];
    const closeLeftSiblings = (except: string) => {
      if (except !== 'timeline' && timelinePanel.isOpen()) timelinePanel.close();
      if (except !== 'hotspots' && hotspotsPanel.isOpen()) hotspotsPanel.close();
    };
    if (p === 'timeline') {
      closeLeftSiblings('timeline');
      if (workspace?.path) timelinePanel.setProjectPath(workspace.path);
      timelinePanel.toggle();
    } else if (p === 'hotspots') {
      closeLeftSiblings('hotspots');
      if (workspace?.path) hotspotsPanel.setProjectPath(workspace.path);
      hotspotsPanel.toggle();
    }
    updateTabs();
  });

  // Right dock — check & constraints
  rightTabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.dock-tab') as HTMLElement;
    if (!tab) return;
    const p = tab.dataset['panel'];
    if (p === 'check') {
      if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
      if (workspace?.path) runCheck();
      checkPanel.toggle();
    } else if (p === 'constraints') {
      if (workspace?.path) ConstraintsPanel.get().load(workspace.path);
      if (checkPanel.isOpen()) checkPanel.close();
      ConstraintsPanel.get().toggle();
    }
    updateTabs();
  });

  btnCheck.addEventListener('click', () => {
    if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
    checkPanel.toggle();
    if (checkPanel.isOpen() && workspace?.path) runCheck();
    // Clear badge on open — user has acknowledged
    clearCheckBadge();
    updateTabs();
  });

  // Dataflow panel (floating, independent of dock tabs)
  document.getElementById('btn-dataflow')?.addEventListener('click', () => {
    dataflowPanel.toggle();
  });

  // Diff
  let _diffActive = false;
  btnDiff.addEventListener('click', async () => {
    if (_diffActive) {
      starGraph.clearDiff();
      _diffActive = false;
      btnDiff.innerHTML = `${iconSvg('diff')} 变更`;
      statusText.textContent = '已清除变更着色';
    } else {
      if (!workspace?.path) { statusText.textContent = '请先打开项目'; return; }
      try {
        const beforePath = `${workspace.path}/hologram_before.json`;
        const diffJson = await rpc<string>('hologram_call', { tool: 'graph_diff', args: { before_path: beforePath } });
        const diff = JSON.parse(diffJson);
        if (diff.is_empty) {
          statusText.textContent = '已创建变更基线 · 再次分析后即可比较差异';
        } else {
          starGraph.showDiff(diff);
          _diffActive = true;
          btnDiff.innerHTML = `${iconSvg('diff')} 清除`;
          statusText.textContent = `+${diff.added_nodes?.length || 0} / -${diff.removed_nodes?.length || 0} / ~${diff.modified_nodes?.length || 0}`;
        }
      } catch (err: any) {
        statusText.textContent = `变更分析失败: ${err}`;
      }
    }
  });

  // Timeline
  btnTimeline.addEventListener('click', () => {
    if (workspace?.path) timelinePanel.setProjectPath(workspace.path);
    if (hotspotsPanel.isOpen()) hotspotsPanel.close();
    timelinePanel.toggle();
    updateTabs();
  });

  // Constraints
  btnConstraints.addEventListener('click', () => {
    if (workspace?.path) ConstraintsPanel.get().load(workspace.path);
    if (checkPanel.isOpen()) checkPanel.close();
    ConstraintsPanel.get().toggle();
    updateTabs();
  });

  // Settings
  const settingsPanel = SettingsPanel.get();
    settingsPanel.setOnSave(async () => {
    document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
    starGraph.resize();
    if (workspace) {
      // Save current conversation BEFORE re-initializing agent — avoids data loss
      await chatPanel.saveActiveSession(workspace.path).catch(() => {});
      await workspace.setupAgent(chatPanel, checkPanel);
      if (workspace?.agent) {
        await chatPanel.autoRestoreLastSession(workspace.path).catch(e => console.error('[settings] autoRestoreLastSession failed:', e));
      }
    }
  });
  chatPanel.setOnOpenSettings(() => settingsPanel.open());
  chatPanel.setOnModeChange(async () => {
    if (workspace) {
      // Save current conversation BEFORE re-initializing agent — avoids data loss
      await chatPanel.saveActiveSession(workspace.path).catch(() => {});
      await workspace.setupAgent(chatPanel, checkPanel);
      if (workspace?.agent) {
        await chatPanel.autoRestoreLastSession(workspace.path).catch(e => console.error('[mode-change] autoRestoreLastSession failed:', e));
      }
    }
  });
  const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
  btnSettings.addEventListener('click', () => { settingsPanel.toggle(); });

  // ── Window controls (decorations:false — custom title bar) ──
  // ponytail: 绕过所有 import，直接调 __TAURI_INTERNALS__ IPC — 跟 bridge.ts 同一条路
  const _winLabel: string = ((window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label) || 'main';
  function _winCmd(cmd: string): void {
    const t = (window as any).__TAURI_INTERNALS__;
    if (!t) return;
    const p = t.invoke(`plugin:window|${cmd}`, { label: _winLabel });
    if (p && typeof p.catch === 'function') p.catch((e: any) => console.error(`[win] ${cmd}:`, e));
  }

  const btnMaximize = document.getElementById('btn-maximize')!;
  const _maxIcon = { normal: '□', maximized: '❐' };
  async function _syncMaximizeIcon(): Promise<void> {
    try {
      const t = (window as any).__TAURI_INTERNALS__;
      if (!t) return;
      const ok = await t.invoke('plugin:window|is_maximized', { label: _winLabel });
      btnMaximize.innerHTML = ok ? _maxIcon.maximized : _maxIcon.normal;
      btnMaximize.title = ok ? '还原' : '最大化';
    } catch { /* best-effort */ }
  }
  btnMaximize.addEventListener('click', () => {
    _winCmd('toggle_maximize');
    setTimeout(() => _syncMaximizeIcon(), 200); // ponytail: 等窗口动画完成
  });
  // 双击标题栏 / Win+↑↓ 等外部触发
  let _maxSyncTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(_maxSyncTimer);
    _maxSyncTimer = window.setTimeout(() => _syncMaximizeIcon(), 200);
  });

  document.getElementById('btn-minimize')?.addEventListener('click', () => _winCmd('minimize'));
  document.getElementById('btn-close')?.addEventListener('click', () => _winCmd('close'));

  // Save sessions on close
  window.addEventListener('beforeunload', () => {
    if (workspace?.path) {
      chatPanel.saveActiveSession(workspace.path).then(
        () => console.log('[beforeunload] session saved'),
        (e) => console.error('[beforeunload] session save failed:', e),
      );
    }
  });

  const isEditing = () => {
    const el = document.activeElement;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
  };

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (isEditing()) return;
    if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (checkPanel.isOpen()) checkPanel.close();
      if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
      chatPanel.toggle();
      updateTabs();
    }
    if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); btnDiff.click();
    }
    if (e.key === ',' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); settingsPanel.toggle();
    }
  });

  // Open folder buttons
  const open = () => switchWorkspace();
  btnOpen.addEventListener('click', open);
  btnWelcomeOpen.addEventListener('click', open);

  // Re-analyze — runs analysis in-place without workspace switch
  btnReanalyze.addEventListener('click', async () => {
    if (_switching) { statusText.textContent = '正在切换工作区，请稍候…'; return; }
    const ws = workspace;
    if (!ws?.path) { statusText.textContent = '请先打开项目'; return; }
    btnReanalyze.disabled = true;
    const lbl = btnReanalyze.querySelector('.btn-label');
    if (lbl) lbl.textContent = '分析中…'; else btnReanalyze.textContent = '分析中…';
    statusText.textContent = '重新分析中…';
    try {
      console.log('[reanalyze] step 1: calling analyze_and_load', ws.path);
      const raw = await rpc<string>('analyze_and_load', { path: ws.path, force: true });
      console.log('[reanalyze] step 2: analyze_and_load returned, length:', raw?.length);
      // Guard against workspace switch during the long await.
      if (workspace !== ws) {
        console.log('[reanalyze] workspace switched during analysis — discarding result');
        statusText.textContent = '工作区已切换，重分析已取消';
        return;
      }
      ws.graphData = JSON.parse(raw);
      console.log('[reanalyze] step 3: JSON parsed, nodes:', Object.keys(ws.graphData.nodes || {}).length);
      starGraph.render(ws.graphData);
      console.log('[reanalyze] step 4: render done');
      const nc = Array.isArray(ws.graphData.nodes) ? ws.graphData.nodes.length : Object.keys(ws.graphData.nodes || {}).length;
      statusText.textContent = `✨ ${nc} 节点已就绪`;
      console.log('[reanalyze] step 5: done');
    } catch (e: any) {
      console.error('[reanalyze] FAILED:', e);
      statusText.textContent = `重分析失败: ${e}`;
    } finally {
      btnReanalyze.disabled = false;
      const lbl = btnReanalyze.querySelector('.btn-label');
      if (lbl) lbl.textContent = '重分析'; else btnReanalyze.textContent = '重分析';
    }
  });

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // ponytail: 点 graph 画布时释放搜索框焦点，Three.js canvas 不会自动抢焦点
  graphEl.addEventListener('pointerdown', () => { if (document.activeElement === searchInput) searchInput.blur(); });

  // Fold / Reset camera
  btnFold.addEventListener('click', () => { starGraph.toggleFold(); updateFoldBtn(); });
  btnResetCam.addEventListener('click', () => { starGraph.resetCamera(); });
  window.addEventListener('keydown', (e) => {
    if (isEditing()) return;
    if ((e.key === 'f' || e.key === 'F')) { starGraph.toggleFold(); updateFoldBtn(); }
    if ((e.key === 'r' || e.key === 'R')) { starGraph.resetCamera(); }
    if (e.key === '?') { toggleShortcuts(); }
    if (e.key === 'Escape') {
      if (starGraph.isInsideGalaxy) starGraph.exitGalaxy();
      else if (timelinePanel.isOpen()) { timelinePanel.close(); updateTabs(); }
      else if (hotspotsPanel.isOpen()) { hotspotsPanel.close(); updateTabs(); }
      else if (checkPanel.isOpen()) { checkPanel.close(); updateTabs(); }
      else if (chatPanel.isOpen()) { chatPanel.close(); updateTabs(); }
      else if (FV() && FV().get().isOpen) FV().get().close();
      else starGraph.clearAgentHighlight();
    }
  });
  function updateFoldBtn(): void {
    btnFold.innerHTML = starGraph.isFolded
      ? `${iconSvg('fold')} 展开`
      : `${iconSvg('fold')} 折叠`;
  }

  // Shortcuts overlay
  const shortcutsOverlay = document.getElementById('shortcuts-overlay')!;
  function toggleShortcuts(): void {
    const visible = shortcutsOverlay.style.display !== 'none';
    shortcutsOverlay.style.display = visible ? 'none' : '';
    if (!visible) {
      clearTimeout((shortcutsOverlay as any)._hideTimer);
      (shortcutsOverlay as any)._hideTimer = setTimeout(() => {
        if (shortcutsOverlay.style.display !== 'none') shortcutsOverlay.style.display = 'none';
      }, 12000);
    }
  }
  shortcutsOverlay.addEventListener('mouseenter', () => clearTimeout((shortcutsOverlay as any)._hideTimer));
  shortcutsOverlay.addEventListener('mouseleave', () => {
    (shortcutsOverlay as any)._hideTimer = setTimeout(() => {
      if (shortcutsOverlay.style.display !== 'none') shortcutsOverlay.style.display = 'none';
    }, 12000);
  });
  shortcutsOverlay.querySelector('.so-close')?.addEventListener('click', () => { shortcutsOverlay.style.display = 'none'; });
  const btnShortcuts = document.getElementById('btn-shortcuts') as HTMLButtonElement;
  btnShortcuts.addEventListener('click', () => toggleShortcuts());

  // ═══════════════════════════════════════════════════════════════
  // Cold start — resume cached project or show welcome
  // ═══════════════════════════════════════════════════════════════

  try {
    let graph: any;
    try {
      const json = await rpc<string>('load_graph_json');
      graph = JSON.parse(json);
    } catch {
      // No cached graph
    }
    if (!graph) {
      welcome.classList.remove('hidden'); graphEl.classList.add('hidden');
      setLoading(false);
      // Set up agent without workspace context (general chat only)
      await setupPlaceholderAgent();
      return;
    }

    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes || {}).length;
    if (nodeCount > 0) {
      let root: string = graph.meta?.source_root || '';
      if (!root) {
        // Graph exists but no path — render without workspace
        starGraph.render(graph);
        statusText.textContent = '⚠️ 缓存图谱已加载，但工作区路径丢失 — 请重新打开项目';
        timelinePanel.setProjectPath(null);
        hotspotsPanel.setProjectPath(null);
        setLoading(false);
        await setupPlaceholderAgent();
        return;
      }

      // Use unified switchWorkspace with cached graph
      console.log('[init] cold start: switching to cached workspace', root);
      await switchWorkspace(root, { skipAnalysis: true, cachedGraph: graph });
      console.log('[init] cold start: switchWorkspace done');
      statusText.textContent = isMockMode() ? '🎨 Mock 模式 — 所见即所得，秒级刷新' : '已加载缓存图谱';
      // Engine warm-up happens via runCheck → engine_init (SQLite cache). Do NOT fire
      // analyze_project here — it races with runCheck's analyze fallback and blocks workspace switches.
      return;
    }
  } catch { /* no cache */ }

  // No cached graph — show welcome
  welcome.classList.remove('hidden'); graphEl.classList.add('hidden');
  setLoading(false);
  await setupPlaceholderAgent();
}

init();