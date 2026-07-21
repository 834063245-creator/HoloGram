// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram 主入口
// 三模式星图：minimal / standard / full — 独立实例，切换即重建
// v4.1: Workspace 抽象 — 所有工作区状态统一管理

import './app/fonts';
import './app/tokens.css';
import './app/foundation.css';
import './app/graph-chrome.css';
import './app/shell.css';
import './app/chat/chat.css';
import './app/panels/dock-panels.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { log } from './agent/logger';
import { App } from './app/App';
import { registerActions } from './app/actions';
import { ChatCore } from './app/chat/chat-core';
import { useCoreStore } from './app/chat/core-instance';
import { useShellStore } from './app/shell-store';
import { isMockMode, rpc } from './bridge';
import { setLang } from './i18n';
import { loadSettings } from './settings';
import { AgentVisualizer } from './ui/agent-visualizer';
import { shell } from './ui/app-shell';
import { setDataflowQueryParser, setDockStarGraph, setOnSettingsSave } from './ui/dock-config';
import { useDockStore } from './ui/dock-store';
import { bus } from './ui/events';
import { StarGraph } from './ui/graph';
import { GraphInteraction } from './ui/graph-interaction';
import { getPanelStore } from './ui/panel-store';
import type { CheckResult } from './ui/react/CheckPanel';
import { isSamePath, Workspace } from './workspace';

// Lazy FileViewer — avoids pulling Monaco (~5MB) into initial bundle
let _FileViewer: any = null;
async function loadFileViewer(): Promise<void> {
  if (!_FileViewer) {
    const mod = await import('./ui/file-viewer');
    _FileViewer = mod.FileViewer;
  }
}
function FV(): any {
  return _FileViewer;
}
// ponytail: permission dialog now embedded inline via ChatPanel.showPermissionCard

// ── Worker layout helper ──

/**
 * 构建边索引对数组
 * 将图中的边从节点ID映射转换为基于节点索引的数值对，便于后续图算法处理
 * @param graph - 图对象，包含 nodes（节点集合）和 edges（边集合）
 * @returns 边索引对数组，每个元素为 [sourceIndex, targetIndex] 的元组
 */
function _buildEdgePairs(graph: any): Array<[number, number]> {
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
    const s = nodeIdx.get(e.source),
      t = nodeIdx.get(e.target);
    // 仅当源节点和目标节点均存在时才保留该边
    if (s !== undefined && t !== undefined) pairs.push([s, t]);
  }
  return pairs;
}

function _layoutViaWorker(nodeCount: number, pairs: Array<[number, number]>): Promise<Float32Array> {
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

// ── Status — 写入 shell-store（P1：DOM 状态栏已移除，日志环在 store 里）──
function pushStatus(msg: string): void {
  useShellStore.getState().pushStatus(msg);
}
const btnWelcomeOpen = document.getElementById('btn-welcome-open') as HTMLButtonElement;

// ── State ──
let workspace: Workspace | null = null;
const starGraph: StarGraph = new StarGraph(graphEl);
let agentViz: AgentVisualizer | null = null;
// Reentry guard for switchWorkspace — prevents stacked concurrent switches
// when deactivate() stalls on watcher teardown.
let _switching = false;

// Panel singletons（dock 面板已收编进 App 树 — 开合/数据走 ui/dock-store）
let chatPanel: ChatCore;

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

async function switchWorkspace(path?: string, opts?: { skipAnalysis?: boolean; cachedGraph?: any }): Promise<void> {
  if (_switching) {
    pushStatus('正在切换工作区，请稍候…');
    return;
  }
  _switching = true;
  try {
    const folder = path || (await pickFolder());
    if (!folder) return;

    if (workspace?.active && isSamePath(workspace.path, folder)) {
      pushStatus('已在当前工作区');
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
    const onStatusChange = (msg: string) => {
      pushStatus(msg);
    };
    const onLoadingChange = (loading: boolean) => {
      setLoading(loading, loading ? folder : undefined);
    };
    let ws: Workspace;
    try {
      console.log('[switchWorkspace] calling Workspace.open...');
      ws = await Workspace.open(folder, starGraph, chatPanel, opts, { onStatusChange, onLoadingChange });
      console.log('[switchWorkspace] Workspace.open returned');
    } catch (err: any) {
      console.error('[switchWorkspace] Workspace.open threw:', err);
      pushStatus(`分析失败: ${err}`);
      setLoading(false);
      throw err;
    }
    ws.onStatusChange = onStatusChange;
    ws.onLoadingChange = onLoadingChange;

    workspace = ws;
    await notifyAllPanels(ws);

    const nodeCount = Array.isArray(ws.graphData.nodes)
      ? ws.graphData.nodes.length
      : Object.keys(ws.graphData.nodes || {}).length;
    const genTime = ws.graphData.meta?.generated_at
      ? new Date(ws.graphData.meta.generated_at).toLocaleTimeString()
      : '';
    pushStatus(`✨ ${nodeCount} 节点已就绪${genTime ? ` · ${genTime}` : ''}`);
    log.info('main', 'project loaded', {
      nodes: nodeCount,
      edges: Array.isArray(ws.graphData.edges)
        ? ws.graphData.edges.length
        : Object.keys(ws.graphData.edges || {}).length,
    });
    setLoading(false);

    try {
      await ws.setupAgent(chatPanel);
    } catch (e) {
      console.error('[switchWorkspace] setupAgent failed:', e);
    }

    chatPanel.setProjectPath(folder);
    chatPanel.autoRestoreLastSession(folder).catch(() => {});
    ws.runCheck();
    await rpc('workspace_start_watcher').catch(() => {});
  } finally {
    _switching = false;
  }
}

function setLoading(active: boolean, folder?: string): void {
  useShellStore.getState().setAnalyzing(active ? 'open' : null);
  if (active) pushStatus(`正在分析 ${folder || ''}...`);
}

function resetCheckPanelState(): void {
  useDockStore.getState().setCheckResult({
    passed: true,
    timestamp: '',
    changed_files: [],
    total_changed_files: 0,
    l5_violations: [],
    l4_violations: [],
    l3_violations: [],
    l2_violations: [],
    passed_checks: [],
    blast_radius: 0,
    cross_community_edges: 0,
    new_cycles: 0,
    new_thread_conflicts: 0,
    api_signature_changes: 0,
  });
  useShellStore.getState().setViolations(0);
}

async function notifyAllPanels(ws: Workspace): Promise<void> {
  useShellStore.getState().setProjectPath(ws.path);
  useShellStore.getState().setView('graph');
  chatPanel.setProjectPath(ws.path);
  useDockStore.getState().setProjectPath(ws.path);
  await loadFileViewer();
  FV().get().setProjectPath(ws.path);
  bus.emit('workspace:switched');
}

// ── Check ──

async function runCheck(): Promise<void> {
  if (workspace) await workspace.runCheck();
}

// ── Search ──

function doSearch(query: string): void {
  const q = query.trim();
  if (!q) return;
  const found = starGraph.focusNode(q);
  if (!found) {
    pushStatus(`未找到 "${q}"`);
    setTimeout(() => {
      const st = useShellStore.getState();
      if (st.statusText === `未找到 "${q}"`) st.setStatusText('就绪');
    }, 2000);
  }
}

// ── Diff ──

let _diffActive = false;
async function toggleDiff(): Promise<void> {
  const store = useShellStore.getState();
  if (_diffActive) {
    starGraph.clearDiff();
    _diffActive = false;
    store.setDiffActive(false);
    pushStatus('已清除变更着色');
    return;
  }
  if (!workspace?.path) {
    pushStatus('请先打开项目');
    return;
  }
  try {
    const beforePath = `${workspace.path}/hologram_before.json`;
    const diffJson = await rpc<string>('hologram_call', { tool: 'graph_diff', args: { before_path: beforePath } });
    const diff = JSON.parse(diffJson);
    if (diff.is_empty) {
      pushStatus('已创建变更基线 · 再次分析后即可比较差异');
    } else {
      starGraph.showDiff(diff);
      _diffActive = true;
      store.setDiffActive(true);
      pushStatus(
        `+${diff.added_nodes?.length || 0} / -${diff.removed_nodes?.length || 0} / ~${diff.modified_nodes?.length || 0}`,
      );
    }
  } catch (err: any) {
    pushStatus(`变更分析失败: ${err}`);
  }
}

// ── Re-analyze — 原地重分析，不切换工作区 ──

async function reanalyze(): Promise<void> {
  if (_switching) {
    pushStatus('正在切换工作区，请稍候…');
    return;
  }
  const ws = workspace;
  if (!ws?.path) {
    pushStatus('请先打开项目');
    return;
  }
  useShellStore.getState().setAnalyzing('reanalyze');
  pushStatus('重新分析中…');
  try {
    console.log('[reanalyze] step 1: calling analyze_and_load', ws.path);
    const raw = await rpc<string>('analyze_and_load', { path: ws.path, force: true });
    console.log('[reanalyze] step 2: analyze_and_load returned, length:', raw?.length);
    // Guard against workspace switch during the long await.
    if (workspace !== ws) {
      console.log('[reanalyze] workspace switched during analysis — discarding result');
      pushStatus('工作区已切换，重分析已取消');
      return;
    }
    ws.graphData = JSON.parse(raw);
    console.log('[reanalyze] step 3: JSON parsed, nodes:', Object.keys(ws.graphData.nodes || {}).length);
    starGraph.render(ws.graphData);
    console.log('[reanalyze] step 4: render done');
    const nc = Array.isArray(ws.graphData.nodes)
      ? ws.graphData.nodes.length
      : Object.keys(ws.graphData.nodes || {}).length;
    pushStatus(`✨ ${nc} 节点已就绪`);
    console.log('[reanalyze] step 5: done');
  } catch (e: any) {
    console.error('[reanalyze] FAILED:', e);
    pushStatus(`重分析失败: ${e}`);
  } finally {
    useShellStore.getState().setAnalyzing(null);
  }
}

// ── Esc 逐层关闭（快捷键经 useGlobalKeys → actions 分发到此）──

function escLayer(): void {
  // Graph-internal Escape states (was in graph.ts keydown, now unified)
  if (starGraph.handleEscape()) return;
  // Global UI layers
  const dock = useDockStore.getState();
  if (starGraph.isInsideGalaxy) starGraph.exitGalaxy();
  else if (dock.isOpen('check')) dock.closePanel('check');
  else if (dock.isOpen('constraints')) dock.closePanel('constraints');
  else if (chatPanel.isOpen()) chatPanel.close();
  else if (FV()?.get().isOpen) FV().get().close();
  else starGraph.clearAgentHighlight();
}

// ── Helper: set up agent with placeholder workspace (no project loaded) ──
async function setupPlaceholderAgent(): Promise<void> {
  if (workspace) return;
  // Clear backend workspace binding — prevents stale PermissionContext from
  // previous project leaking into the placeholder's read_file / list_directory calls.
  await rpc('workspace_activate', { path: '' }).catch(() => {});
  const ws = Workspace.placeholder();
  ws.onStatusChange = (msg) => {
    pushStatus(msg);
  };
  try {
    await ws.setupAgent(chatPanel);
  } catch (e) {
    console.error('[init] setupAgent failed:', e);
  }
}

// ── Init ──

async function init(): Promise<void> {
  // 禁用浏览器原生右键菜单（自定义 ContextMenu 不受影响）
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  setLang(loadSettings().display.language);
  document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
  starGraph.resize(); // CSS custom props changed → container shrunk → canvas must follow

  // Tauri 事件监听 — 纯浏览器 dev(mock) 环境无 __TAURI_INTERNALS__，
  // listen 会抛错并中断 init；降级为静默跳过（权限卡在 mock 下不会出现）
  try {
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
          chatPanel.ask(
            `分析从 ${parts[0]} 到 ${parts[1]} 的依赖路径。请分析这条依赖链的架构合理性、风险点、以及如果修改起点的潜在影响范围。`,
          );
        }
      }
    });

    // ── Backend permission-ask → frontend inline chat card bridge ──
    const AUTO_WHITELIST = new Set(['edit_file', 'write_file', 'git_stage']);
    await listen('permission-ask', (event: any) => {
      const p = event.payload as {
        requestId: string;
        tool: string;
        path: string;
        reason: string;
        danger?: string;
        suggestions: Array<{ rule: string; behavior: string }>;
      };

      // Permission mode bypass: yolo → all auto, auto → safe edits only
      const permMode = getPanelStore(chatPanel.panelId).getState().permissionMode;
      if (permMode === 'yolo' || (permMode === 'auto' && AUTO_WHITELIST.has(p.tool))) {
        rpc('permission_ask_response', {
          requestId: p.requestId,
          allow: true,
          remember: false,
        });
        return;
      }

      chatPanel.showPermissionCard(p.tool, p.reason, p.path, p.danger).then((result) => {
        rpc('permission_ask_response', {
          requestId: p.requestId,
          allow: result.allow,
          remember: result.remember || undefined,
          ruleToAdd: result.remember && p.suggestions.length > 0 ? p.suggestions[0].rule : undefined,
          ruleBehavior: result.remember && p.suggestions.length > 0 ? p.suggestions[0].behavior : undefined,
        });
      });
    });
  } catch {
    /* browser mock: no tauri event bus */
  }

  // Browser shortcut suppression
  (() => {
    const isEditing = () => {
      const el = document.activeElement;
      if (!el) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
    };
    const APP_CTRL_KEYS = new Set(['l', 'd', 'e']);
    const APP_CTRL_KEYS_EXTRA = new Set(['`', ',']);
    window.addEventListener(
      'keydown',
      (e) => {
        const key = e.key.toLowerCase();
        const mod = e.ctrlKey || e.metaKey;
        const shift = e.shiftKey;
        const alt = e.altKey;
        if (isEditing()) {
          if (mod && !shift && !alt && new Set(['c', 'v', 'x', 'z', 'y', 'a']).has(key)) return;
          if (mod && !alt && ['r', 'p', 's', 'u', 'o', 'n'].includes(key)) {
            e.preventDefault();
            return;
          }
          if (key === 'f5' || key === 'f12') {
            e.preventDefault();
            return;
          }
          if (alt && (key === 'arrowleft' || key === 'arrowright')) {
            e.preventDefault();
            return;
          }
          return;
        }
        // App-specific shortcuts
        if (mod && !shift && !alt && APP_CTRL_KEYS.has(key)) return;
        if (mod && !shift && !alt && APP_CTRL_KEYS_EXTRA.has(key)) return;
        // Pass-through: standard browser copy/paste/select-all/undo/redo
        if (mod && !shift && !alt && new Set(['c', 'v', 'x', 'a', 'z', 'y']).has(key)) return;
        if (!mod && !alt && !shift && (key === 'f' || key === 'escape' || key === 'b')) return;
        if (['f1', 'f3', 'f4', 'f5', 'f6', 'f7', 'f10', 'f11', 'f12'].includes(key)) {
          e.preventDefault();
          return;
        }
        if (mod && !alt) {
          e.preventDefault();
          return;
        }
        if (alt) {
          e.preventDefault();
          return;
        }
        if (key === 'backspace') {
          e.preventDefault();
          return;
        }
      },
      { capture: true },
    );
  })();

  // ── Sandbox health check ──
  rpc<string>('sandbox_status')
    .then((raw) => {
      const s = JSON.parse(raw);
      if (s.degraded) {
        console.warn(`[sandbox] ⚠ DEGRADED: ${s.reason} — permission engine is the only barrier`);
      }
    })
    .catch(() => {});

  // Chat core（无头）+ React 信标视图（经 core-instance 注入 App 树）
  chatPanel = new ChatCore();
  useCoreStore.getState().setChatCore(chatPanel);
  chatPanel.setStarGraph(starGraph);

  // Agent visualizer
  agentViz = new AgentVisualizer(starGraph);
  chatPanel.setOnTrailToggle(() => agentViz?.toggleTrail());

  // Graph interaction
  const _graphInteraction = new GraphInteraction(); // ponytail: side-effect constructor, event bus listeners

  // Dock 面板外部依赖注入（组件已收编进 App 树，这里只写配置槽）
  setDockStarGraph(starGraph);

  // Wire NL→symbol fallback: if heuristic parser fails, use Agent to resolve
  setDataflowQueryParser(async (nl: string): Promise<string[]> => {
    try {
      if (!workspace?.prov) return [];
      const gen = workspace.prov.stream(new AbortController().signal, {
        messages: [
          {
            role: 'user',
            content: `Extract code symbol names (functions, classes, modules, variables) from this query. Return ONLY a JSON array of strings, nothing else. If no symbols found, return [].\n\nQuery: "${nl}"`,
          },
        ],
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
    } catch {
      return [];
    }
  });

  // ── AppShell wiring — replaces bus commands with explicit dispatch ──
  shell.wire({
    navigateToNode: (name) => starGraph.focusNode(name),
    navigateToFile: async (path, line) => {
      await loadFileViewer();
      FV().get().open(path, { line });
    },
    highlightFile: (path) => starGraph.highlightFile(path),
    highlightFolder: (path) => starGraph.highlightFolder(path),
    clearHighlight: () => starGraph.clearFileHighlight(),
    queryAgent: (question) => {
      const dock = useDockStore.getState();
      if (dock.isOpen('constraints')) dock.closePanel('constraints');
      chatPanel.ask(question);
    },
  });

  // ── Bus notifications (pure notification — sender doesn't care who listens) ──
  bus.on('check:history', ({ checkData }: { checkData: CheckResult; timestamp: string }) => {
    // 旧 showHistory 从未消费 timestamp — 行为保持：展示该历史结果并展开简报面板
    useDockStore.getState().showCheckHistory(checkData);
  });

  bus.on('chat:turn-done', () => {
    if (workspace?.path) chatPanel.scheduleAutoSave(workspace.path);
  });

  // ── 动作注册（CommandBar / 命令面板 / 全局快捷键统一入口）──
  registerActions([
    { id: 'open', group: '操作', label: '打开文件夹…', icon: 'folder-open', run: () => switchWorkspace() },
    { id: 'reanalyze', group: '操作', label: '重新分析当前项目', icon: 'refresh', run: () => reanalyze() },
    {
      id: 'toggle-fold',
      group: '操作',
      label: '折叠 / 展开社区星系',
      icon: 'fold',
      kbd: 'F',
      run: () => {
        starGraph.toggleFold();
        useShellStore.getState().setFolded(starGraph.isFolded);
      },
    },
    {
      id: 'reset-cam',
      group: '操作',
      label: '复位摄像机视角',
      icon: 'reset-cam',
      kbd: 'R',
      run: () => starGraph.resetCamera(),
    },
    {
      id: 'blast-toggle',
      group: '操作',
      label: '切换 Blast 模式',
      icon: 'blast',
      kbd: 'B',
      run: () => starGraph.handleBlastToggle(),
    },
    { id: 'toggle-diff', group: '操作', label: '变更回看着色', icon: 'diff', kbd: 'ctrl D', run: () => toggleDiff() },
    { id: 'search', group: '操作', label: '搜索符号', icon: 'search', run: (q) => doSearch(q || '') },
    {
      id: 'panel.check',
      group: '面板',
      label: '面板：简报',
      icon: 'check',
      run: () => {
        const dock = useDockStore.getState();
        if (dock.isOpen('constraints')) dock.closePanel('constraints');
        dock.togglePanel('check');
        if (dock.isOpen('check') && workspace?.path) runCheck();
        useShellStore.getState().setViolations(0); // 打开即视为已知晓
      },
    },
    {
      id: 'panel.constraints',
      group: '面板',
      label: '面板：约束',
      icon: 'constraints',
      run: () => {
        const dock = useDockStore.getState();
        if (workspace?.path) dock.setProjectPath(workspace.path);
        if (dock.isOpen('check')) dock.closePanel('check');
        dock.togglePanel('constraints');
      },
    },
    {
      id: 'panel.dataflow',
      group: '面板',
      label: '面板：数据流',
      icon: 'dataflow',
      run: () => {
        useDockStore.getState().togglePanel('dataflow');
      },
    },
    {
      id: 'toggle-chat',
      group: '面板',
      label: '展开 / 折叠对话',
      icon: 'chat',
      kbd: 'ctrl L',
      run: () => {
        const dock = useDockStore.getState();
        if (dock.isOpen('check')) dock.closePanel('check');
        if (dock.isOpen('constraints')) dock.closePanel('constraints');
        chatPanel.toggle();
      },
    },
    {
      id: 'toggle-settings',
      group: '设置',
      label: '设置…',
      icon: 'settings',
      kbd: 'ctrl ,',
      run: () => useDockStore.getState().togglePanel('settings'),
    },
    {
      id: 'toggle-shortcuts',
      group: '设置',
      label: '快捷键一览',
      icon: 'info',
      kbd: '?',
      run: () => {
        const st = useShellStore.getState();
        st.setShortcutsOpen(!st.shortcutsOpen);
      },
    },
    { id: 'esc-layer', group: '操作', label: '逐层关闭', icon: 'close', run: escLayer },
  ]);

  // Settings（保存后的 agent 重建链必须保住）
  setOnSettingsSave(async () => {
    document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
    starGraph.resize();
    if (workspace) {
      // Save current conversation BEFORE re-initializing agent — avoids data loss
      await chatPanel.saveActiveSession(workspace.path).catch(() => {});
      await workspace.setupAgent(chatPanel);
      if (workspace?.agent) {
        await chatPanel
          .autoRestoreLastSession(workspace.path)
          .catch((e) => console.error('[settings] autoRestoreLastSession failed:', e));
      }
    }
  });
  chatPanel.setOnOpenSettings(() => useDockStore.getState().openPanel('settings'));

  // Save sessions on close — scheduleAutoSave is sync (sets timeout).
  // LocalStorage write inside saveActiveSession is sync, so it completes
  // before the window closes even if the RPC disk write doesn't.
  window.addEventListener('beforeunload', () => {
    if (workspace?.path) {
      try {
        chatPanel.scheduleAutoSave(workspace.path);
      } catch {
        /* silent */
      }
    }
  });

  // Open folder buttons（工具栏动作已入 actions 注册表，此处仅欢迎屏按钮）
  const open = () => switchWorkspace();
  btnWelcomeOpen.addEventListener('click', open);

  // ponytail: 点 graph 画布时释放输入框焦点，Three.js canvas 不会自动抢焦点
  graphEl.addEventListener('pointerdown', () => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
  });

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
      useShellStore.getState().setView('welcome');
      setLoading(false);
      // Set up agent without workspace context (general chat only)
      await setupPlaceholderAgent();
      return;
    }

    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes || {}).length;
    if (nodeCount > 0) {
      const root: string = graph.meta?.source_root || '';
      if (!root) {
        // Graph exists but no path — render without workspace
        starGraph.render(graph);
        pushStatus('⚠️ 缓存图谱已加载，但工作区路径丢失 — 请重新打开项目');
        useDockStore.getState().setProjectPath(null);
        setLoading(false);
        await setupPlaceholderAgent();
        return;
      }

      // Use unified switchWorkspace with cached graph
      console.log('[init] cold start: switching to cached workspace', root);
      await switchWorkspace(root, { skipAnalysis: true, cachedGraph: graph });
      console.log('[init] cold start: switchWorkspace done');
      pushStatus(isMockMode() ? '🎨 Mock 模式 — 所见即所得，秒级刷新' : '已加载缓存图谱');
      // Engine warm-up happens via runCheck → engine_init (SQLite cache). Do NOT fire
      // analyze_project here — it races with runCheck's analyze fallback and blocks workspace switches.
      return;
    }
  } catch {
    /* no cache */
  }

  // No cached graph — show welcome
  useShellStore.getState().setView('welcome');
  setLoading(false);
  await setupPlaceholderAgent();
}

// ── 平台标记：方便 CSS 针对不同操作系统做差异化处理 ──
{
  const ua = navigator.userAgent;
  const plat = ua.includes('Linux') ? 'linux' : ua.includes('Windows') ? 'windows' : ua.includes('Mac') ? 'macos' : 'unknown';
  document.documentElement.setAttribute('data-platform', plat);
}

// ── React 壳引导（P1：CommandBar/DockRail/StatusBar/命令面板/快捷键浮层）──
createRoot(document.getElementById('app-root')!).render(createElement(App));

init();