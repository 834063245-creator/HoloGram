// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram 主入口
// 三模式星图：minimal / standard / full — 独立实例，切换即重建
// v4.1: Workspace 抽象 — 所有工作区状态统一管理

import '@xterm/xterm/css/xterm.css';
import { invoke, listen, isMockMode } from './bridge';
import { StarGraph } from './ui/graph';
import { ChatPanel } from './ui/chat';
import { CheckPanel, type CheckResult } from './ui/check';
import { FileViewer } from './ui/file-viewer';
import { FileTreePanel } from './ui/file-tree';
import { TimelinePanel } from './ui/timeline';
import { ConstraintsPanel } from './ui/constraints';
import { HotspotsPanel } from './ui/hotspots';
import { ConflictPanel } from './ui/conflict';
import { SettingsPanel } from './ui/settings-panel';
import { GitPanel } from './ui/git-panel';
import { TerminalPanel } from './ui/terminal';
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
const dockGit = document.getElementById('dock-git')!;
const statusText = document.getElementById('status-text')!;
let _gitStatusTimer: ReturnType<typeof setInterval> | null = null;
const tbPath = document.getElementById('tb-path')!;
const btnExplorer = document.getElementById('btn-explorer') as HTMLButtonElement;
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;
const btnReanalyze = document.getElementById('btn-reanalyze') as HTMLButtonElement;
const btnWelcomeOpen = document.getElementById('btn-welcome-open') as HTMLButtonElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const btnFold = document.getElementById('btn-fold') as HTMLButtonElement;
const btnColorMode = document.getElementById('btn-color-mode') as HTMLButtonElement;
const btnScaleMode = document.getElementById('btn-scale-mode') as HTMLButtonElement;
const btnResetCam = document.getElementById('btn-reset-cam') as HTMLButtonElement;
const btnCheck = document.getElementById('btn-check') as HTMLButtonElement;
const btnDiff = document.getElementById('btn-diff') as HTMLButtonElement;
const btnTimeline = document.getElementById('btn-timeline') as HTMLButtonElement;
const btnConstraints = document.getElementById('btn-constraints') as HTMLButtonElement;
const btnConflict = document.getElementById('btn-conflict') as HTMLButtonElement;
const btnTerminal = document.getElementById('btn-terminal') as HTMLButtonElement;

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
let conflictPanel: ConflictPanel;

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
    if (_gitStatusTimer) { clearInterval(_gitStatusTimer); _gitStatusTimer = null; }

    // Create new — pass callbacks immediately so progress events during
    // Workspace.open (analyze + render) push visible status updates.
    const onStatusChange = (msg: string) => { statusText.textContent = msg; };
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
    notifyAllPanels(ws);

    const nodeCount = Array.isArray(ws.graphData.nodes) ? ws.graphData.nodes.length : Object.keys(ws.graphData.nodes || {}).length;
    const genTime = ws.graphData.meta?.generated_at ? new Date(ws.graphData.meta.generated_at).toLocaleTimeString() : '';
    statusText.textContent = `✨ ${nodeCount} 节点已就绪${genTime ? ` · ${genTime}` : ''}`;
    log.info('main', 'project loaded', {
      nodes: nodeCount,
      edges: Array.isArray(ws.graphData.edges) ? ws.graphData.edges.length : Object.keys(ws.graphData.edges || {}).length,
    });
    setLoading(false);
    startGitIndicator();

    try { await ws.setupAgent(chatPanel, checkPanel); } catch (e) { console.error('[switchWorkspace] setupAgent failed:', e); }

    chatPanel.setProjectPath(folder);
    chatPanel.autoRestoreLastSession(folder).catch(() => {});
    if (FileTreePanel.get().isOpen()) FileTreePanel.get().load(folder);
    ws.runCheck(checkPanel);
    await invoke('workspace_start_watcher').catch(() => {});
  } finally {
    _switching = false;
  }
}

function setLoading(active: boolean, folder?: string): void {
  btnOpen.disabled = active;
  btnOpen.innerHTML = active ? `${iconSvg('dot')} 分析中...` : `${iconSvg('folder-open')} 打开文件夹`;
  if (active) statusText.textContent = `正在分析 ${folder || ''}...`;
}

function resetCheckPanelState(): void {
  checkPanel.update({
    passed: true, timestamp: '', changed_files: [], total_changed_files: 0,
    l5_violations: [], l4_violations: [], l3_violations: [], l2_violations: [],
    passed_checks: [], blast_radius: 0, cross_community_edges: 0,
    new_cycles: 0, new_thread_conflicts: 0, api_signature_changes: 0,
  });
}

function notifyAllPanels(ws: Workspace): void {
  tbPath.textContent = ws.path;
  welcome.classList.add('hidden');
  graphEl.classList.remove('hidden');
  btnOpen.disabled = false;
  btnOpen.innerHTML = `${iconSvg('folder-open')} 打开文件夹`;
  chatPanel.setProjectPath(ws.path);
  timelinePanel.setProjectPath(ws.path);
  hotspotsPanel.setProjectPath(ws.path);
  TerminalPanel.get().setCwd(ws.path);
  const ft = FileTreePanel.get();
  if (ft.isOpen()) ft.load(ws.path);
  const gp = GitPanel.get();
  if (gp.isOpen()) gp.load(ws.path);
  if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().load(ws.path);
  conflictPanel.setGraph(starGraph);
}

// ── Check (thin wrapper) ──

async function runCheck(): Promise<void> {
  if (workspace) await workspace.runCheck(checkPanel);
}

// ── Search ──

function doSearch(): void {
  const query = searchInput.value.trim(); if (!query) return;
  const found = starGraph.focusNode(query);
  if (!found) { statusText.textContent = `未找到 "${query}"`; setTimeout(() => { if (statusText.textContent === `未找到 "${query}"`) statusText.textContent = '就绪'; }, 2000); }
}

// ── Icon setup ──

function setupIcons(): void {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const iconName = (el as HTMLElement).dataset['icon']!;
    const svgStr = iconSvg(iconName);
    el.insertAdjacentHTML('afterbegin', svgStr);
    (el as HTMLElement).classList.add('toolbar-btn');
  });
}
// ── Helper: set up agent with placeholder workspace (no project loaded) ──
async function setupPlaceholderAgent(): Promise<void> {
  if (workspace) return;
  const ws = Workspace.placeholder();
  ws.onStatusChange = (msg) => { statusText.textContent = msg; };
  try { await ws.setupAgent(chatPanel, checkPanel); } catch (e) { console.error('[init] setupAgent failed:', e); }
}

// ── Init ──

async function init(): Promise<void> {
  setLang(loadSettings().display.language);

  const { listen } = await import('@tauri-apps/api/event');
  const { bus: eventBus } = await import('./ui/events');
  const { FileViewer } = await import('./ui/file-viewer');

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
      if (mod && !shift && !alt && APP_CTRL_KEYS.has(key)) return;
      if (mod && !shift && !alt && APP_CTRL_KEYS_EXTRA.has(key)) return;
      if (!mod && !alt && !shift && (key === 'f' || key === 'escape' || key === 'b')) return;
      if (['f1', 'f3', 'f4', 'f5', 'f6', 'f7', 'f10', 'f11', 'f12'].includes(key)) { e.preventDefault(); return; }
      if (mod && !alt) { e.preventDefault(); return; }
      if (alt) { e.preventDefault(); return; }
      if (key === 'backspace') { e.preventDefault(); return; }
    }, { capture: true });
  })();

  setupIcons();

  // Chat panel
  chatPanel = new ChatPanel(document.body);
  chatPanel.setStarGraph(starGraph);

  // Check panel
  checkPanel = new CheckPanel(document.body);

  // Agent visualizer
  agentViz = new AgentVisualizer(starGraph);

  // Graph interaction
  new GraphInteraction();

  // Timeline
  timelinePanel = new TimelinePanel(document.body);

  // Hotspots
  hotspotsPanel = new HotspotsPanel(document.body);
  hotspotsPanel.setGraph(starGraph);

  // Conflict
  conflictPanel = new ConflictPanel(document.body);
  conflictPanel.setGraph(starGraph);

  // ── AppShell wiring — replaces bus commands with explicit dispatch ──
  // Register all panels so shell knows who's open
  shell.register({ id: 'check', isOpen: () => checkPanel.isOpen() });
  shell.register({ id: 'chat', isOpen: () => chatPanel.isOpen() });
  shell.register({ id: 'explorer', isOpen: () => FileTreePanel.get().isOpen() });
  shell.register({ id: 'timeline', isOpen: () => timelinePanel.isOpen() });
  shell.register({ id: 'git', isOpen: () => GitPanel.get().isOpen() });
  shell.register({ id: 'hotspots', isOpen: () => hotspotsPanel.isOpen() });
  shell.register({ id: 'conflict', isOpen: () => conflictPanel.isOpen() });
  shell.register({ id: 'constraints', isOpen: () => ConstraintsPanel.get().isOpen() });
  shell.register({ id: 'terminal', isOpen: () => TerminalPanel.get().isOpen() });

  // Wire navigation / highlight / agent-query commands
  shell.wire({
    navigateToNode: (name) => starGraph.focusNode(name),
    navigateToFile: (path) => FileViewer.get().open(path),
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
    if (TerminalPanel.get().isOpen()) TerminalPanel.get().toggle();
    checkPanel.showHistory(checkData, timestamp);
    updateTabs();
  });

  bus.on('chat:turn-done', () => {
    if (workspace?.path) chatPanel.saveActiveSession(workspace.path).catch(() => {});
  });

  // graph → file tree reverse linking
  window.addEventListener('graph:node-selected', ((e: CustomEvent) => {
    const filePath = e.detail as string;
    if (!filePath) return;
    const ft = FileTreePanel.get();
    if (!ft.isOpen()) {
      ft.show();
      btnExplorer.classList.add('active');
      if (workspace?.path) ft.load(workspace.path).then(() => ft.highlightPath(filePath));
    } else {
      ft.highlightPath(filePath);
    }
  }) as EventListener);

  // ── Dock tabs ──
  const leftTabs = document.getElementById('left-tabs')!;
  const rightTabs = document.getElementById('right-tabs')!;
  const bottomTabs = document.getElementById('bottom-tabs')!;
  leftTabs.style.display = '';
  rightTabs.style.display = '';
  bottomTabs.style.display = '';
  const updateTabs = () => {
    const hideLeft = FileTreePanel.get().isOpen() || timelinePanel.isOpen()
      || GitPanel.get().isOpen() || hotspotsPanel.isOpen();
    const hideRight = checkPanel.isOpen() || ConstraintsPanel.get().isOpen();
    leftTabs.style.display = hideLeft ? 'none' : '';
    rightTabs.style.display = hideRight ? 'none' : '';
    leftTabs.querySelectorAll('.dock-tab').forEach(t => {
      const p = (t as HTMLElement).dataset['panel'];
      const active = (p === 'explorer' && FileTreePanel.get().isOpen())
        || (p === 'timeline' && timelinePanel.isOpen())
        || (p === 'git' && GitPanel.get().isOpen())
        || (p === 'hotspots' && hotspotsPanel.isOpen());
      t.classList.toggle('active', !!active);
    });
    rightTabs.querySelectorAll('.dock-tab').forEach(t => {
      const p = (t as HTMLElement).dataset['panel'];
      const active = (p === 'check' && checkPanel.isOpen()) || (p === 'constraints' && ConstraintsPanel.get().isOpen());
      t.classList.toggle('active', !!active);
    });
    bottomTabs.querySelectorAll('.dock-tab').forEach(t => {
      const p = (t as HTMLElement).dataset['panel'];
      const active = (p === 'terminal' && TerminalPanel.get().isOpen());
      t.classList.toggle('active', !!active);
    });
  };
  shell.onPanelChanged = updateTabs;

  // Left dock
  leftTabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.dock-tab') as HTMLElement;
    if (!tab) return;
    const p = tab.dataset['panel'];
    const closeLeftSiblings = (except: string) => {
      if (except !== 'explorer' && FileTreePanel.get().isOpen()) { FileTreePanel.get().close(); btnExplorer.classList.remove('active'); }
      if (except !== 'timeline' && timelinePanel.isOpen()) timelinePanel.close();
      if (except !== 'git' && GitPanel.get().isOpen()) GitPanel.get().close();
      if (except !== 'hotspots' && hotspotsPanel.isOpen()) hotspotsPanel.close();
    };
    if (p === 'explorer') {
      closeLeftSiblings('explorer');
      const ft = FileTreePanel.get();
      if (!ft.isOpen() && workspace?.path) ft.load(workspace.path);
      ft.toggle();
      btnExplorer.classList.toggle('active', ft.isOpen());
    } else if (p === 'timeline') {
      closeLeftSiblings('timeline');
      if (workspace?.path) timelinePanel.setProjectPath(workspace.path);
      timelinePanel.toggle();
    } else if (p === 'git') {
      closeLeftSiblings('git');
      if (workspace?.path) GitPanel.get().load(workspace.path);
      else GitPanel.get().toggle();
    } else if (p === 'hotspots') {
      closeLeftSiblings('hotspots');
      if (workspace?.path) hotspotsPanel.setProjectPath(workspace.path);
      hotspotsPanel.toggle();
    }
    updateTabs();
  });

  // Right dock
  rightTabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.dock-tab') as HTMLElement;
    if (!tab) return;
    const p = tab.dataset['panel'];
    if (p === 'check') {
      if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
      if (conflictPanel.isOpen()) conflictPanel.close();
      if (workspace?.path) runCheck();
      checkPanel.toggle();
    } else if (p === 'constraints') {
      if (workspace?.path) ConstraintsPanel.get().load(workspace.path);
      if (checkPanel.isOpen()) checkPanel.close();
      if (conflictPanel.isOpen()) conflictPanel.close();
      ConstraintsPanel.get().toggle();
    }
    updateTabs();
  });

  // Bottom dock
  const closeBottomSiblings = (except: string) => {
    if (except !== 'terminal' && TerminalPanel.get().isOpen()) TerminalPanel.get().toggle();
  };

  bottomTabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.dock-tab') as HTMLElement;
    if (!tab) return;
    const p = tab.dataset['panel'];
    if (p === 'terminal') { closeBottomSiblings('terminal'); TerminalPanel.get().toggle(); }
    updateTabs();
  });

  btnCheck.addEventListener('click', () => {
    if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
    if (conflictPanel.isOpen()) conflictPanel.close();
    checkPanel.toggle();
    if (checkPanel.isOpen() && workspace?.path) runCheck();
    updateTabs();
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
        const afterPath = `${workspace.path}/hologram_graph.json`;
        const diffJson = await invoke<string>('hologram_diff', { before_path: beforePath, after_path: afterPath });
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
    if (FileTreePanel.get().isOpen()) { FileTreePanel.get().close(); btnExplorer.classList.remove('active'); }
    if (GitPanel.get().isOpen()) GitPanel.get().close();
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

  // Conflict
  btnConflict.addEventListener('click', () => { conflictPanel.toggle(); updateTabs(); });

  // Terminal
  btnTerminal.addEventListener('click', () => {
    closeBottomSiblings('terminal');
    TerminalPanel.get().toggle();
    updateTabs();
  });

  // Settings
  const settingsPanel = SettingsPanel.get();
  settingsPanel.setOnSave(async () => {
    if (workspace) await workspace.setupAgent(chatPanel, checkPanel);
    if (workspace?.path && workspace?.agent) {
      chatPanel.autoRestoreLastSession(workspace.path).catch(e => console.error('[settings] autoRestoreLastSession failed:', e));
    }
  });
  chatPanel.setOnOpenSettings(() => settingsPanel.open());
  chatPanel.setOnModeChange(async () => {
    if (workspace) await workspace.setupAgent(chatPanel, checkPanel);
    if (workspace?.path && workspace?.agent) {
      chatPanel.autoRestoreLastSession(workspace.path).catch(e => console.error('[mode-change] autoRestoreLastSession failed:', e));
    }
  });
  const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
  btnSettings.addEventListener('click', () => { settingsPanel.toggle(); });

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
      if (conflictPanel.isOpen()) conflictPanel.close();
      chatPanel.toggle();
      updateTabs();
    }
    if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); btnDiff.click();
    }
    if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      closeBottomSiblings('terminal');
      TerminalPanel.get().toggle();
      updateTabs();
    }
    if (e.key === ',' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); settingsPanel.toggle();
    }
    if ((e.key === 'e' || e.key === 'E') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const ft = FileTreePanel.get();
      if (!ft.isOpen() && workspace?.path) ft.load(workspace.path);
      if (!ft.isOpen()) {
        if (timelinePanel.isOpen()) timelinePanel.close();
        if (GitPanel.get().isOpen()) GitPanel.get().close();
      }
      ft.toggle();
      btnExplorer.classList.toggle('active', ft.isOpen());
      updateTabs();
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
    btnReanalyze.textContent = '分析中…';
    statusText.textContent = '重新分析中…';
    try {
      console.log('[reanalyze] step 1: calling analyze_and_load', ws.path);
      const raw = await invoke<string>('analyze_and_load', { path: ws.path, force: true });
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
      btnReanalyze.textContent = '重分析';
    }
  });

  // File explorer toggle
  btnExplorer.addEventListener('click', () => {
    const ft = FileTreePanel.get();
    if (!ft.isOpen() && workspace?.path) ft.load(workspace.path);
    if (!ft.isOpen()) {
      if (timelinePanel.isOpen()) timelinePanel.close();
      if (GitPanel.get().isOpen()) GitPanel.get().close();
      if (hotspotsPanel.isOpen()) hotspotsPanel.close();
    }
    ft.toggle();
    btnExplorer.classList.toggle('active', ft.isOpen());
    updateTabs();
  });

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // Color mode
  const colorModeOrder: Array<'type' | 'community' | 'coupling'> = ['type', 'community', 'coupling'];
  let colorModeIdx = 0;
  const updateColorTooltip = () => {
    const mode = colorModeOrder[colorModeIdx];
    const labels: Record<string, string> = { type: t('color.type'), community: t('color.community'), coupling: t('color.coupling') };
    btnColorMode.title = `${t('color.tooltip')}: ${labels[mode]}`;
  };
  btnColorMode.addEventListener('click', () => {
    colorModeIdx = (colorModeIdx + 1) % 3;
    starGraph.recolorByMode(colorModeOrder[colorModeIdx]);
    btnColorMode.innerHTML = iconSvg('chart');
    updateColorTooltip();
  });

  // Scale mode
  let scaleByCoupling = false;
  const updateScaleTooltip = () => {
    btnScaleMode.title = `${t('scale.tooltip')}: ${scaleByCoupling ? t('scale.coupling') : t('scale.degree')}`;
  };
  btnScaleMode.addEventListener('click', () => {
    scaleByCoupling = !scaleByCoupling;
    starGraph.rescaleByMode(scaleByCoupling ? 'coupling' : 'degree');
    btnScaleMode.innerHTML = iconSvg('blast');
    updateScaleTooltip();
  });

  bus.on('lang:changed', () => { updateColorTooltip(); updateScaleTooltip(); });

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
      else if (GitPanel.get().isOpen()) { GitPanel.get().close(); updateTabs(); }
      else if (hotspotsPanel.isOpen()) { hotspotsPanel.close(); updateTabs(); }
      else if (conflictPanel.isOpen()) { conflictPanel.close(); updateTabs(); }
      else if (checkPanel.isOpen()) { checkPanel.close(); updateTabs(); }
      else if (chatPanel.isOpen()) { chatPanel.close(); updateTabs(); }
      else if (FileTreePanel.get().isOpen()) { FileTreePanel.get().close(); btnExplorer.classList.remove('active'); updateTabs(); }
      else if (FileViewer.get().isOpen) FileViewer.get().close();
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
      const json = await invoke<string>('load_graph_json');
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
      // hologram_analyze here — it races with runCheck's analyze fallback and blocks workspace switches.
      return;
    }
  } catch { /* no cache */ }

  // No cached graph — show welcome
  welcome.classList.remove('hidden'); graphEl.classList.add('hidden');
  setLoading(false);
  await setupPlaceholderAgent();
}

// ── Git indicator ────────────────────────

function updateGitIndicator(): void {
  if (!workspace?.path) return;
  const badge = dockGit.querySelector('.git-badge') as HTMLElement | null;
  invoke<string>('git_status', { path: workspace.path }).then(raw => {
    const status = JSON.parse(raw) as { files?: Array<{ status: string; staged: boolean }> };
    const files = status.files || [];
    const totalCount = files.length;
    if (!badge) return;
    if (totalCount === 0) {
      badge.textContent = ''; badge.className = 'git-badge clean';
    } else {
      badge.textContent = String(totalCount); badge.className = 'git-badge';
    }
  }).catch(() => {
    if (badge) { badge.textContent = ''; badge.className = 'git-badge clean'; }
  });
}

function startGitIndicator(): void {
  if (_gitStatusTimer) clearInterval(_gitStatusTimer);
  const existing = dockGit.querySelector('.git-badge');
  if (!existing) {
    const badge = document.createElement('span');
    badge.className = 'git-badge';
    dockGit.appendChild(badge);
  }
  updateGitIndicator();
  _gitStatusTimer = setInterval(updateGitIndicator, 3000);
}

init();