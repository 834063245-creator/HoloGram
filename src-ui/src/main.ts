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
import './app/panels/dock-panels/check-panel.css';
import './app/panels/dock-panels/constraints-panel.css';
import './app/panels/dock-panels/settings-panel.css';
import './app/panels/dock-panels/dataflow-panel.css';
import './app/panels/dock-panels/shared.css';
import './app/panels/dock-panels/model-selector.css';
import './app/panels/dock-panels/provider-settings.css';
import './ui/react/TasksPanel.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { log } from './agent/logger';
import { App } from './app/App';
import { registerActions } from './app/actions';
import { ChatCore } from './app/chat/chat-core';
import { useCoreStore } from './app/chat/core-instance';
import { useShellStore } from './app/shell-store';
import { isMockMode } from './bridge';
import { setLang } from './i18n';
import { streamWithIdleTimeout } from './provider/idle-stream';
import { ChunkType } from './provider/types';
import { loadSettings } from './settings';
import { typedListen, typedRpc } from './rpc-contract';
import { AgentVisualizer } from './ui/agent-visualizer';
import { shell } from './ui/app-shell';
import { setDataflowQueryParser, setDockStarGraph } from './ui/dock-config';
import { useDockStore } from './ui/dock-store';
import { bus } from './ui/events';
import { StarGraph } from './ui/graph';
import { GraphInteraction } from './ui/graph-interaction';
import { getPanelStore } from './ui/panel-store';
import { installResizeZones } from './ui/resize-zones';
import type { CheckResult } from './ui/react/CheckPanel';
import { isSamePath, loadGraphPages, Workspace, type CachedGraphMeta } from './workspace';
import { WorkspaceStateMachine } from './lifecycle/state-machine';
import { withTimeout } from './lifecycle/timeout';
import type { GraphEdge, GraphJSON, GraphNode } from './ui/graph-types';

/** 冷启动缓存载荷 — 分页 meta（P0-2）或旧格式全量图（兼容）。 */
interface CachedGraphPayload {
  paged?: boolean;
  meta?: { node_count?: number; source_root?: string; [key: string]: unknown };
  nodes?: GraphNode[] | Record<string, GraphNode>;
  edges?: GraphEdge[] | Record<string, GraphEdge>;
}

// 懒加载 FileViewer — 避免将 Monaco（~5MB）拉入初始 bundle
let _FileViewer: (typeof import('./ui/file-viewer'))['FileViewer'] | null = null;
async function loadFileViewer(): Promise<void> {
  if (!_FileViewer) {
    const mod = await import('./ui/file-viewer');
    _FileViewer = mod.FileViewer;
  }
}
function FV(): (typeof import('./ui/file-viewer'))['FileViewer'] | null {
  return _FileViewer;
}
// ponytail：权限对话框现在通过 ChatPanel.showPermissionCard 内联嵌入

// ── Worker 布局辅助函数 ──

/**
 * 构建边索引对数组
 * 将图中的边从节点ID映射转换为基于节点索引的数值对，便于后续图算法处理
 * @param graph - 图对象，包含 nodes（节点集合）和 edges（边集合）
 * @returns 边索引对数组，每个元素为 [sourceIndex, targetIndex] 的元组
 */
// （2026-08-04 清理：_buildEdgePairs/_layoutViaWorker 全工程零调用，已删）

// ── UI ──
const welcome = document.getElementById('welcome')!;
const graphEl = document.getElementById('graph')!;

// ── Status — 写入 shell-store（P1：DOM 状态栏已移除，日志环在 store 里）──
function pushStatus(msg: string): void {
  useShellStore.getState().pushStatus(msg);
}
const btnWelcomeOpen = document.getElementById('btn-welcome-open') as HTMLButtonElement;

// ── 状态 ──
let workspace: Workspace | null = null;
// WebGL2 不可用时（旧 WebKitGTK / GPU 被驱动拉黑）构造会抛——
// 兜底成提示层，保住 React shell 与其余 UI，不再整窗黑屏
let starGraph: StarGraph | null = null;
try {
  starGraph = new StarGraph(graphEl);
} catch (err) {
  console.error('[init] StarGraph 初始化失败（WebGL2 不可用）:', err);
  const tip = document.createElement('div');
  tip.className = 'gl-fallback';
  tip.textContent = '3D 星图初始化失败：当前 WebView 不支持 WebGL2，请升级 WebKitGTK（≥ 2.40）后重启应用';
  graphEl.appendChild(tip);
}
let agentViz: AgentVisualizer | null = null;
// 统一状态机 — 替代临时的 _switching 布尔值。
// 守卫所有工作区转换（打开、停用、切换、重新分析）。
const wsMachine = new WorkspaceStateMachine();

// Panel singletons（dock 面板已收编进 App 树 — 开合/数据走 ui/dock-store）
let chatPanel: ChatCore;

// ── 文件夹选择器 ──

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
// switchWorkspace — 统一入口
// ═══════════════════════════════════════════════════════════════

async function switchWorkspace(path?: string, opts?: { skipAnalysis?: boolean; cachedGraph?: CachedGraphMeta }): Promise<void> {
  if (!starGraph) {
    pushStatus('3D 渲染不可用（WebGL2 初始化失败），无法打开项目');
    return;
  }
  if (wsMachine.isBusy) {
    pushStatus('正在切换工作区，请稍候…');
    return;
  }
  wsMachine.transition('switching');
  try {
    const folder = path || (await pickFolder());
    if (!folder) {
      wsMachine.forceState('idle');
      return;
    }

    if (workspace?.active && isSamePath(workspace.path, folder)) {
      pushStatus('已在当前工作区');
      wsMachine.forceState(workspace?._health === 'degraded' ? 'degraded' : 'active');
      return;
    }

    // 在可能缓慢的 deactivate() await 之前禁用打开按钮。
    setLoading(true, folder);

    // 停用旧工作区 — 设 5 秒超时以防卡死
    if (workspace) {
      try {
        await withTimeout(
          workspace.deactivate(chatPanel),
          5000,
          () => {
            console.warn('[switchWorkspace] deactivate timed out, forcing clear');
            workspace?.forceClearState();
          },
        );
      } catch (e) {
        console.error('[switchWorkspace] deactivate error:', e);
        workspace?.forceClearState();
      }
      workspace = null;
    }

    resetCheckPanelState();

    // 创建新工作区 — 立即传入回调，使 Workspace.open（分析 + 渲染）期间
    // 的进度事件推送可见的状态更新。
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
    } catch (err) {
      console.error('[switchWorkspace] Workspace.open threw:', err);
      pushStatus(`分析失败: ${err}`);
      setLoading(false);
      wsMachine.forceState('idle');
      throw err;
    }
    ws.onStatusChange = onStatusChange;
    ws.onLoadingChange = onLoadingChange;

    // 接线分析失败回调，用于降级模式
    ws.onAnalysisFailed = (err) => {
      console.warn('[switchWorkspace] background analysis failed:', err);
      pushStatus('⚠️ 后台分析未完成 — 缓存图谱可用，点击重新分析重试');
    };

    workspace = ws;
    wsMachine.transition(ws._health === 'degraded' ? 'degraded' : 'active');
    await notifyAllPanels(ws);

    const gd = ws.graphData;
    const nodeCount = gd
      ? (Array.isArray(gd.nodes) ? gd.nodes.length : Object.keys(gd.nodes || {}).length)
      : 0;
    const genRaw = gd?.meta?.generated_at;
    const genTime =
      typeof genRaw === 'string' || typeof genRaw === 'number'
        ? new Date(genRaw).toLocaleTimeString()
        : '';
    pushStatus(`✨ ${nodeCount} 节点已就绪${genTime ? ` · ${genTime}` : ''}`);
    log.info('main', 'project loaded', {
      nodes: nodeCount,
      edges: gd
        ? (Array.isArray(gd.edges) ? gd.edges.length : Object.keys(gd.edges || {}).length)
        : 0,
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
    await typedRpc('workspace_start_watcher', {}).catch(() => {});
  } finally {
    // 确保状态机未卡在 'switching' 状态
    if (wsMachine.state === 'switching') {
      wsMachine.forceState(workspace?._health === 'degraded' ? 'degraded' : (workspace ? 'active' : 'idle'));
    }
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
  await loadFileViewer();
  FV()?.get().setProjectPath(ws.path);
  bus.emit('workspace:switched');
}

// ── 简报 ──

async function runCheck(): Promise<void> {
  if (workspace) await workspace.runCheck();
}

// ── 搜索 ──

function doSearch(query: string): void {
  const q = query.trim();
  if (!q || !starGraph) return;
  const found = starGraph.focusNode(q);
  if (!found) {
    pushStatus(`未找到 "${q}"`);
    setTimeout(() => {
      const st = useShellStore.getState();
      if (st.statusText === `未找到 "${q}"`) st.setStatusText('就绪');
    }, 2000);
  }
}

// ── 变更对比 ──

let _diffActive = false;
async function toggleDiff(): Promise<void> {
  const store = useShellStore.getState();
  if (!starGraph) return;
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
    const beforePath = `${workspace.path}/.hologram/baseline.json`;
    const diffJson = await typedRpc('hologram_call', { tool: 'graph_diff', args: { before_path: beforePath } });
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
  } catch (err) {
    pushStatus(`变更分析失败: ${err}`);
  }
}

// ── Re-analyze — 原地重分析，不切换工作区 ──

async function reanalyze(): Promise<void> {
  if (!starGraph) return;
  if (wsMachine.isBusy) {
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
    const raw = await typedRpc('analyze_and_load', { path: ws.path, force: true });
    console.log('[reanalyze] step 2: analyze_and_load returned meta, length:', raw?.length);
    // 在漫长的 await 期间防止工作区切换。
    if (workspace !== ws) {
      console.log('[reanalyze] workspace switched during analysis — discarding result');
      pushStatus('工作区已切换，重分析已取消');
      return;
    }
    // P0-2 分页化：analyze_and_load 只回 meta，图数据逐页拉取重建。
    const meta = JSON.parse(raw) as CachedGraphMeta;
    ws.graphData = {
      meta: meta.meta || {},
      nodes: [],
      edges: [],
      communities: [],
      hierarchical_communities: [],
    };
    await loadGraphPages(ws, starGraph, meta);
    const nc = Array.isArray(ws.graphData.nodes)
      ? ws.graphData.nodes.length
      : Object.keys(ws.graphData.nodes || {}).length;
    console.log('[reanalyze] step 3: pages loaded, nodes:', nc);
    pushStatus(`✨ ${nc} 节点已就绪`);
    console.log('[reanalyze] step 4: done');
  } catch (e) {
    console.error('[reanalyze] FAILED:', e);
    pushStatus(`重分析失败: ${e}`);
  } finally {
    useShellStore.getState().setAnalyzing(null);
  }
}

// ── Esc 逐层关闭（快捷键经 useGlobalKeys → actions 分发到此）──

function escLayer(): void {
  // 图内部 Escape 状态（原在 graph.ts keydown 中，现已统一）
  if (starGraph?.handleEscape()) return;
  // 全局 UI 层
  const dock = useDockStore.getState();
  if (starGraph?.isInsideGalaxy) starGraph.exitGalaxy();
  else if (dock.isOpen('check')) dock.closePanel('check');
  else if (dock.isOpen('constraints')) dock.closePanel('constraints');
  else if (chatPanel.isOpen()) chatPanel.close();
  else if (FV()?.get().isOpen) FV()?.get().close();
  else starGraph?.clearAgentHighlight();
}

// ── 辅助：用占位工作区设置 agent（未加载项目）──
async function setupPlaceholderAgent(): Promise<void> {
  if (workspace) return;
  // 清除后端工作区绑定 — 防止上一个项目的 PermissionContext
  // 泄漏到占位工作区的 read_file / list_directory 调用中。
  await typedRpc('workspace_activate', { path: '' }).catch(() => {});
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

// ── 初始化 ──

async function init(): Promise<void> {
  // 禁用浏览器原生右键菜单（自定义 ContextMenu 不受影响）
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  setLang(loadSettings().display.language);
  document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
  starGraph?.resize(); // CSS 自定义属性变化 → 容器缩小 → canvas 必须跟随

  // Tauri 事件监听 — 纯浏览器 dev(mock) 环境无 __TAURI_INTERNALS__，
  // bridge.listen 返回空操作 unlisten（权限卡在 mock 下不会出现）
  try {
    await typedListen('unity-event', ({ event: evt, payload }) => {
      console.log('[Unity]', evt, payload);
      if (evt === 'node_double_clicked') {
        const parts = payload.split('|');
        if (parts.length > 1 && parts[1]) shell.navigateToFile(parts[1]);
      }
      if (evt === 'path_selected') {
        const parts = payload.split('|');
        if (parts.length === 2) {
          chatPanel.open();
          chatPanel.ask(
            `分析从 ${parts[0]} 到 ${parts[1]} 的依赖路径。请分析这条依赖链的架构合理性、风险点、以及如果修改起点的潜在影响范围。`,
          );
        }
      }
    });

    // ── 后端权限请求 → 前端内联聊天卡片桥接 ──
    // 白名单按后端 Tool.name() 匹配（payload.tool）：
    // "Edit" = edit_file/write_file/delete_file/move_file/create_directory/log_append。
    // 注意与 src-tauri permissions::auto_mode_allows 保持同一份名单（两端镜像）。
    const AUTO_WHITELIST = new Set(['Edit']);
    const timedOutRequests = new Set<string>();
    await typedListen('permission-ask', (p) => {

      // 权限模式旁路：yolo → 全部自动，auto → 仅安全编辑
      const permMode = getPanelStore(chatPanel.panelId).getState().permissionMode;
      if (permMode === 'yolo' || (permMode === 'auto' && AUTO_WHITELIST.has(p.tool))) {
        typedRpc('permission_ask_response', {
          request_id: p.requestId,
          allow: true,
          remember: false,
        });
        return;
      }

      // 子 Agent 权限请求使用更短的超时（60 秒 vs 120 秒）
      const isSubAgent = p.agentId && p.agentId !== 'main';
      const timeoutMs = isSubAgent ? 60_000 : 120_000;

      const timeoutId = setTimeout(() => {
        timedOutRequests.add(p.requestId);
        typedRpc('permission_ask_response', {
          request_id: p.requestId,
          allow: false,
          remember: false,
        });
      }, timeoutMs);

      // 为子 Agent 可见性标注来源 Agent 的原因
      const displayReason = isSubAgent
        ? `[子Agent ${p.agentId}] ${p.reason}`
        : p.reason;

      chatPanel.showPermissionCard(p.tool, displayReason, p.path, p.danger).then((result) => {
        clearTimeout(timeoutId);
        if (timedOutRequests.has(p.requestId)) {
          timedOutRequests.delete(p.requestId);
          return;
        }
        typedRpc('permission_ask_response', {
          request_id: p.requestId,
          allow: result.allow,
          remember: result.remember || undefined,
          rule_to_add: result.remember && p.suggestions.length > 0 ? p.suggestions[0].rule : undefined,
          rule_behavior: result.remember && p.suggestions.length > 0 ? p.suggestions[0]?.behavior || 'allow' : undefined,
        });
      }).catch((err) => {
        clearTimeout(timeoutId);
        if (timedOutRequests.has(p.requestId)) {
          timedOutRequests.delete(p.requestId);
          return;
        }
        console.error('[permission-ask]', err);
        typedRpc('permission_ask_response', {
          request_id: p.requestId,
          allow: false,
          remember: false,
        });
      });
    });
  } catch {
    /* 浏览器 mock：无 Tauri 事件总线 */
  }

  // 浏览器快捷键抑制
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
        // 应用专属快捷键
        if (mod && !shift && !alt && APP_CTRL_KEYS.has(key)) return;
        if (mod && !shift && !alt && APP_CTRL_KEYS_EXTRA.has(key)) return;
        // 放行：标准浏览器复制/粘贴/全选/撤销/重做
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

  // ── 沙箱健康检查 ──
  typedRpc('sandbox_status', {})
    .then((raw) => {
      const s = JSON.parse(raw);
      if (s.degraded) {
        console.warn(`[sandbox] ⚠ DEGRADED: ${s.reason} — permission engine is the only barrier`);
      }
    })
    .catch((e) => console.warn('[sandbox] status check failed:', e));

  // Chat core（无头）+ React 信标视图（经 core-instance 注入 App 树）
  chatPanel = new ChatCore();
  useCoreStore.getState().setChatCore(chatPanel);
  if (starGraph) chatPanel.setStarGraph(starGraph);

  // Agent 可视化器
  agentViz = starGraph ? new AgentVisualizer(starGraph) : null;
  chatPanel.setOnTrailToggle(() => agentViz?.toggleTrail());

  // 图交互
  const _graphInteraction = new GraphInteraction(); // ponytail：副作用构造函数，事件总线监听器

  // Dock 面板外部依赖注入（组件已收编进 App 树，这里只写配置槽）
  if (starGraph) setDockStarGraph(starGraph);

  // 接线 NL→symbol 回退：如果启发式解析器失败，使用 Agent 解析
  setDataflowQueryParser(async (nl: string): Promise<string[]> => {
    try {
      if (!workspace?.prov) return [];
      // 60s 空闲超时守卫（与 Agent 主循环共用）— 挂起/流内错误均视为解析失败
      const stream = streamWithIdleTimeout(workspace.prov, new AbortController().signal, {
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
      const parts: string[] = [];
      for await (const chunk of stream.chunks) {
        if (chunk.type === ChunkType.Text && chunk.text) parts.push(chunk.text);
        if (chunk.type === ChunkType.Error) throw chunk.err ?? new Error('stream error');
      }
      const text = parts.join('').trim();
      // 从响应中提取 JSON 数组
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
      return [];
    } catch {
      return [];
    }
  });

  // ── AppShell 接线 — 用显式分发替代 bus 命令 ──
  shell.wire({
    navigateToNode: (name) => starGraph?.focusNode(name),
    navigateToFile: async (path, line) => {
      await loadFileViewer();
      FV()?.get().open(path, { line });
    },
    highlightFile: (path) => starGraph?.highlightFile(path),
    highlightFolder: (path) => starGraph?.highlightFolder(path),
    clearHighlight: () => starGraph?.clearFileHighlight(),
    queryAgent: (question) => {
      const dock = useDockStore.getState();
      if (dock.isOpen('constraints')) dock.closePanel('constraints');
      chatPanel.ask(question);
    },
  });

  // ── Bus 通知（纯通知 — 发送方不关心谁监听）──
  bus.on('chat:turn-done', () => {
    if (workspace?.path) {
      // 增量持久化 — 将最后一条消息追加到后端 NDJSON
      chatPanel.appendLastMessage(workspace.path);
      chatPanel.scheduleAutoSave(workspace.path);
    }
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
        if (!starGraph) return;
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
      run: () => starGraph?.resetCamera(),
    },
    {
      id: 'blast-toggle',
      group: '操作',
      label: '切换 Blast 模式',
      icon: 'blast',
      kbd: 'B',
      run: () => starGraph?.handleBlastToggle(),
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
        if (dock.isOpen('agents')) dock.closePanel('agents');
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
        if (dock.isOpen('check')) dock.closePanel('check');
        if (dock.isOpen('agents')) dock.closePanel('agents');
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
      id: 'panel.agents',
      group: '面板',
      label: '面板：智能体',
      icon: 'agent',
      run: () => {
        const dock = useDockStore.getState();
        if (dock.isOpen('check')) dock.closePanel('check');
        if (dock.isOpen('constraints')) dock.closePanel('constraints');
        dock.togglePanel('agents');
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
        if (dock.isOpen('agents')) dock.closePanel('agents');
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

  // Agent 配置变更统一入口：设置面板/模型切换/模式按钮只发事件，
  // workspace.applyAgentConfig 热切换处理（不重建，会话/上下文全保留）。
  bus.on('agent:config-changed', (e) => {
    document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
    starGraph?.resize();
    if (workspace) {
      void workspace.applyAgentConfig(chatPanel, e.reason).catch((err) =>
        console.error('[agent:config-changed] hot-switch failed:', err),
      );
    }
  });
  chatPanel.setOnOpenSettings(() => useDockStore.getState().openPanel('settings'));

  // 关闭时保存会话 — scheduleAutoSave 是同步的（设置超时）。
  // saveActiveSession 内的 LocalStorage 写入是同步的，因此即使 RPC 磁盘写入未完成，
  // 也能在窗口关闭前完成。
  // 同时同步停止子 Agent（AbortController.abort 是同步的）。
  // E6：刷新会话级 boards（DiscoveryBoard + TaskBoard）— 清除
  // debounce 定时器（同步）并触发刷新（尽力异步）。
  window.addEventListener('beforeunload', () => {
    if (workspace?.path) {
      try {
        chatPanel.scheduleAutoSave(workspace.path);
      } catch {
        /* 静默 */
      }
      try {
        workspace.subAgentPool.stopAll();
      } catch {
        /* 静默 */
      }
      try {
        void workspace.runtime?.flushAllBoards();
      } catch {
        /* 静默 */
      }
    }
  });

  // 打开文件夹按钮（工具栏动作已入 actions 注册表，此处仅欢迎屏按钮）
  const open = () => switchWorkspace();
  btnWelcomeOpen.addEventListener('click', open);

  // ponytail: 点 graph 画布时释放输入框焦点，Three.js canvas 不会自动抢焦点
  graphEl.addEventListener('pointerdown', () => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
  });

  // ═══════════════════════════════════════════════════════════════
  // 冷启动 — 恢复缓存的项目或显示欢迎界面
  // ═══════════════════════════════════════════════════════════════

  try {
    let graph: CachedGraphPayload | null = null;
    try {
      const json = await typedRpc('load_graph_json', {});
      graph = JSON.parse(json) as CachedGraphPayload;
    } catch {
      // 无缓存图谱
    }
    if (!graph) {
      useShellStore.getState().setView('welcome');
      setLoading(false);
      // 在无工作区上下文下设置 agent（仅通用聊天）
      await setupPlaceholderAgent();
      return;
    }

    // P0-2 分页化：load_graph_json 返回 meta-only（paged）或旧格式全量图（兼容）。
    const nodeCount = graph.paged
      ? graph.meta?.node_count || 0
      : Array.isArray(graph.nodes)
        ? graph.nodes.length
        : Object.keys(graph.nodes || {}).length;
    if (nodeCount > 0) {
      const root: string = graph.meta?.source_root || '';
      if (!root) {
        // 图谱存在但无路径 — 无工作区渲染
        starGraph?.render(graph as GraphJSON);
        pushStatus('⚠️ 缓存图谱已加载，但工作区路径丢失 — 请重新打开项目');
        useShellStore.getState().setProjectPath('');
        setLoading(false);
        await setupPlaceholderAgent();
        return;
      }

      // 使用统一的 switchWorkspace 加载缓存图谱
      console.log('[init] cold start: switching to cached workspace', root);
      await switchWorkspace(root, { skipAnalysis: true, cachedGraph: graph });
      console.log('[init] cold start: switchWorkspace done');
      pushStatus(isMockMode() ? '🎨 Mock 模式 — 所见即所得，秒级刷新' : '已加载缓存图谱');
      // 引擎预热通过 runCheck → engine_init（SQLite 缓存）完成。不要在此处触发
      // analyze_project — 它会与 runCheck 的分析回退竞争并阻塞工作区切换。
      return;
    }
  } catch {
    /* 无缓存 */
  }

  // 无缓存图谱 — 显示欢迎界面
  useShellStore.getState().setView('welcome');
  setLoading(false);
  await setupPlaceholderAgent();
}

// ── 平台标记 + 渲染能力检测：方便 CSS 针对平台/引擎能力做差异化处理 ──
{
  const ua = navigator.userAgent;
  const plat = ua.includes('Linux') ? 'linux' : ua.includes('Windows') ? 'windows' : ua.includes('Mac') ? 'macos' : 'unknown';
  document.documentElement.setAttribute('data-platform', plat);
  // WebKitGTK <2.46 / 软件渲染下 backdrop-filter 不可靠 — 全局降级为不透明玻璃（tokens.css html.no-bf）
  const bfOk = CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
  if (!bfOk) document.documentElement.classList.add('no-bf');
  // Linux 无边框窗口无 WM 边缘缩放 — 铺 Tauri 缩放热区（内部自检平台）
  installResizeZones();
}

// ── React 壳引导（P1：CommandBar/DockRail/StatusBar/命令面板/快捷键浮层）──
createRoot(document.getElementById('app-root')!).render(createElement(App));

init();
