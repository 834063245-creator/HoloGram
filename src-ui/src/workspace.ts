// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Workspace — 拥有一个已打开项目的全部状态。
// 替换 main.ts 中的 18+ 个模块级全局变量。
//
// 生命周期：
//   const ws = await Workspace.open(path, starGraph, chatPanel);
//   // ... 用户工作 ...
//   await ws.deactivate(chatPanel);
//
// 切换工作区是原子的：old.deactivate() → new = Workspace.open() → 赋值。

import { Agent } from './agent/agent';
import { AgentStore } from './agent/agent-store';
import { agentSessionState } from './agent/agent-session-state';
import { auraShutdown } from './agent/aura-memory';
import { SubAgentPool } from './agent/coordinator';
import { GoalManager } from './agent/goal-manager';
import type { GraphContext } from './agent/hooks';
import { initLogger } from './agent/logger';
import { MemoryManager } from './agent/memory';
import { buildTurnStartBlock, refreshGitStatus, refreshTimeline } from './agent/state-inject';
import { TaskManager } from './agent/task';
import type { Tool } from './agent/tool';
import { ToolRegistry } from './agent/tool';
import type { ChatCore } from './app/chat/chat-core';
import { listen, rpc } from './bridge';
import { createProvider } from './provider';
import { mergeDynamicModels, getModel } from './provider/catalog';
import { withThinkingDisabled } from './provider/thinking';
import { defaultPricing, getActiveProvider, loadSettingsWithSecrets, type AppSettings } from './settings';
import { stripLineNumbers } from './ui/chat-session';
import { useDockStore } from './ui/dock-store';
import { useAgentPanelStore } from './ui/agent-panel-store';
import { bus, type AgentConfigChangeReason } from './ui/events';
import type { StarGraph } from './ui/graph';
import type { GraphDiffJson } from './ui/graph-types';
import { getDiagnosticsForFile } from './ui/lsp-client';
import { getPanelStore } from './ui/panel-store';
import type { CheckResult } from './ui/react/CheckPanel';
// ── 运行时层（替代 bootstrap.ts）──
import { AgentRuntime } from './agent/runtime/runtime';
import type { AgentHandle } from './agent/runtime/types';
import {
  buildGraphContextFromData,
  buildToolRegistry,
  extractGraphNodeNames,
  scheduleEngineSnapshotRefresh,
  type BuilderDeps,
} from './agent/runtime/agent-builder';
import { createRuntimeAdapter, createBuilderDeps } from './ui/runtime-adapter';
import type { Provider } from './provider/types';
import { memoryBundleIngest } from './agent/memory-bundle-client';
import { SkillRegistry } from './agent/skills';
import { withTimeout } from './lifecycle/timeout';

// ═══════════════════════════════════════════════════════
// 从引擎注册表动态加载工具
// ═══════════════════════════════════════════════════════

import { dbg } from './ui/debug';

// ── 路径工具 ──────────────────────────────────────────────────────

/** 不区分大小写的路径比较（Windows 盘符大小写可能不同）。 */
export function isSamePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

// ── 参数翻译（从 main.ts 迁移）──────────────────────────────────

// ponytail: 所有 hologram 工具 schema 已用 camelCase (nodeId/maxDepth/from/to/...),
// Tauri v2 默认 camelCase 重命名 Rust snake_case 参数 → 期望的 JS key 正是这些 camelCase.
// 旧 ARG_TRANSLATIONS 把 camelCase→snake_case, 方向全反 → 7 个工具 (node/unused/impact/
// neighbors/path/coupling_report/community) 全部 "missing required key". 删整张表, args 直传.
// 若新增 hologram 命令: schema 参数名用 camelCase 即可, 无需任何翻译.

// ── Workspace 类 ─────────────────────────────────────────────────

export class Workspace {
  // ── 标识 ──
  readonly path: string;

  // ── 图数据 ──
  graphData: any = null;
  fileGraphData: any = null;

  // ── 视图状态 ──
  diffActive: boolean = false;

  // ── Agent 与记忆 ──
  agent: Agent | null = null;
  prov: Provider | null = null;
  /** 上次 setupAgent 时的构造级字段摘要 — settings-saved 到达时对比，
   *  只有构造级字段变化才重建 Agent（运行时级/无关字段走热切换/no-op）。 */
  private _lastAgentCfgKey: string | null = null;
  registry: ToolRegistry | null = null;
  memoryManager: MemoryManager | null = null;
  taskManager: TaskManager = new TaskManager();
  skillRegistry: SkillRegistry | null = null;
  agentStore: AgentStore | null = null;
  goalManager: GoalManager | null = null;

  // ── 运行时 ──
  runtime: AgentRuntime | null = null;

  // ── 子 Agent 池 ──
  subAgentPool = new SubAgentPool();

  // ── Store 路由（面板级隔离）──
  _storeId: string = '__default__';

  // ── 检查状态 ──
  checkRunning: boolean = false;
  checkPending: boolean = false;
  checkTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Agent 设置守卫 ──
  agentSetupRunning: boolean = false;
  agentSetupPending: boolean = false;

  // ── 内部状态 ──
  private _active: boolean = false;
  private _unlisteners: Array<() => void> = [];

  /** 冷启动后台分析的健康状态。 */
  _health: 'unknown' | 'ready' | 'degraded' = 'unknown';

  /** 后台分析失败时的回调（冷启动降级模式）。 */
  onAnalysisFailed: ((err: unknown) => void) | null = null;

  /** 守卫：初始冷启动渲染（open() 的第 4 步）进行中时为 true。
   *  防止 graph-updated 事件用第二次 _renderImpl → clearGraph() 调用
   *  踩踏正在进行的渲染，因为该调用会释放第一次渲染仍在使用的 GPU 资源。 */
  _initialRenderActive: boolean = false;

  /** 预检 GraphContext — 存储以便写入后刷新引擎快照。 */
  _preflightCtx: GraphContext | null = null;

  get active(): boolean {
    return this._active;
  }

  // ── UI 回调（由 main.ts 设置）──
  onStatusChange: ((msg: string) => void) | null = null;
  onLoadingChange: ((loading: boolean) => void) | null = null;

  private constructor(path: string) {
    this.path = path;
  }

  /** 创建仅 Agent 模式的占位工作区（未加载项目）。永不激活。 */
  static placeholder(): Workspace {
    return new Workspace('');
  }

  // ═══════════════════════════════════════════════════════════════
  // 工厂方法：打开工作区 — 完整分析 + 渲染 + 监听器
  // ═══════════════════════════════════════════════════════════════

  static async open(
    path: string,
    starGraph: StarGraph,
    _chatPanel: ChatCore,
    opts?: { skipAnalysis?: boolean; cachedGraph?: any },
    callbacks?: { onStatusChange?: (msg: string) => void; onLoadingChange?: (loading: boolean) => void },
  ): Promise<Workspace> {
    const ws = new Workspace(path);
    ws._active = true;
    // ponytail: 立即连接回调，以便本方法内的进度监听器能推送状态更新。
    // 否则整个分析阶段都是静默的 — onStatusChange 在 open() 返回后才被赋值。
    ws.onStatusChange = callbacks?.onStatusChange ?? null;
    ws.onLoadingChange = callbacks?.onLoadingChange ?? null;

    // Agent 写入文件时自动调度检查
    // （通过 agent:tool-done → onToolDone → scheduleCheck 处理，见下文）

    // 1. 向后端注册工作区
    ws.onStatusChange?.('正在初始化引擎...');
    console.log('[Workspace.open] step 1: workspace_activate...');
    await rpc('workspace_activate', { path }).catch((e) => {
      console.error('[Workspace.open] workspace_activate failed:', e);
    });
    console.log('[Workspace.open] step 1: done');
    initLogger(path);

    // 2. 连接进度监听器（限定于本工作区）
    let currentPhase = '';
    const unlistenProgress = await listen<{ current: number; total: number; file: string }>('analyze-progress', (e) => {
      if (!ws._active) return;
      const { current, total, file } = e.payload;
      const basename = file.replace(/.*[/\\]/, '');
      ws.onStatusChange?.(`${currentPhase ? currentPhase + ' — ' : ''}[${current}/${total}] ${basename}`);
    });
    const unlistenPhase = await listen<{ phase: string; message: string }>('analyze-phase', (e) => {
      if (!ws._active) return;
      currentPhase = e.payload.message || e.payload.phase;
      ws.onStatusChange?.(currentPhase);
    });
    const unlistenHeartbeat = await listen<{ label: string; elapsed: string }>('analyze-heartbeat', (e) => {
      if (!ws._active) return;
      const { label, elapsed } = e.payload;
      ws.onStatusChange?.(`${label} (${elapsed}...)`);
    });

    try {
      if (opts?.skipAnalysis && opts.cachedGraph) {
        // 冷启动：使用缓存的图谱进行即时渲染。
        // 仍触发 analyze_and_load（force=false），使 engine_init 将后端引擎切换到
        // 当前项目。否则所有 hologram_* 工具调用会命中上一个会话的图谱数据。
        // fire-and-track：用户立即看到图谱，引擎初始化在后台完成。
        // 若分析失败，工作区进入降级模式 — 可见但不阻塞。
        ws.graphData = opts.cachedGraph;
        rpc('analyze_and_load', { path, force: false })
          .then(() => {
            if (!ws._active) return;
            ws._health = 'ready';
          })
          .catch((err) => {
            if (!ws._active) return;
            ws._health = 'degraded';
            ws.onAnalysisFailed?.(err);
          });
      } else {
        // 完整分析
        ws.onLoadingChange?.(true);
        const raw = await rpc<string>('analyze_and_load', { path, force: false });
        ws.graphData = JSON.parse(raw);
      }

      // 3. 加载文件级图谱 — 5 秒超时，不阻塞工作区打开。
      // ponytail: read_file_content 的 async require_read 运行在 Tokio 运行时上，
      // 可能被 fire-and-forget 的 analyze_and_load 在异步线程上序列化 11669 节点
      // 的 JSON 占满。这是一个内部文件；若超时，文件级图谱为 null — 非致命。
      console.log('[Workspace.open] step 3: read_file_content...');
      try {
        const filesPath = path.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
        const raw = await Promise.race([
          rpc<string>('read_file_content', { filePath: filesPath }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        ws.fileGraphData = JSON.parse(stripLineNumbers(raw));
        console.log('[Workspace.open] step 3: done');
      } catch (e) {
        console.log('[Workspace.open] step 3: failed', e);
        ws.fileGraphData = null;
      }

      // 4. 渲染 — 延迟到下一个宏任务，使 DOM 状态更新先绘制。
      // ponytail: _renderImpl 在第一个 await 之前执行大量同步预处理
      // （N 个节点的 Map/Array 构建）。没有 setTimeout，主线程被阻塞，
      // "正在渲染图谱..." 永远不会绘制 — 用户看到的是过时的 "正在分析..."。
      // ponytail 2: _initialRenderActive 防止 graph-updated 在本次渲染进行中
      // 调用 doGraphUpdate→render→_renderImpl→clearGraph()
      // （冷启动竞态：fire-and-forget 的 analyze_and_load 发出
      // graph-updated → get_full_graph → doGraphUpdate → 渲染踩踏我们）。
      console.log('[Workspace.open] step 4: scheduling render...');
      ws.onStatusChange?.('正在渲染图谱...');
      ws._initialRenderActive = true;
      setTimeout(async () => {
        console.log('[Workspace.open] render starting');
        try {
          await starGraph.render(ws.graphData);
        } catch {
          /* 渲染器自行处理错误 */
        }
        ws._initialRenderActive = false;
        // 运行初始检查以建立基线 — 同时通过 doGraphUpdate 调度后续检查
        ws.runCheck();
      }, 0);

      // 5. 连接持久事件监听器（graph-updated、analysis-complete、analysis-failed）
      console.log('[Workspace.open] step 5: wiring listeners...');
      const unlistenGraphUpdated = await listen<string>('graph-updated', async (event) => {
        if (!ws._active) return;
        try {
          const summary = JSON.parse(event.payload);
          const eventRoot = summary.meta?.source_root || '';
          if (eventRoot && !isSamePath(eventRoot, ws.path)) return;
          const nc = summary.total_nodes || summary.node_count || 0;
          if (nc > 0 && ws.path) {
            // ponytail: 若初始冷启动渲染仍在进行中，
            // 不要用另一个 _renderImpl → clearGraph() 踩踏它。
            // 初始渲染已有 ws.graphData（cachedGraph）。
            // _initialRenderActive 清除后，后续 graph-updated 事件
            // 将正常触发 doGraphUpdate。
            if (ws._initialRenderActive) {
              console.log('[Workspace.open] graph-updated: skipping (initial render in flight)');
              return;
            }
            try {
              // ⚡ 2026-08-04 状态治理：不再每次全量 get_full_graph。
              // watcher 已算好 diff —— 用 diff 合并本地 graphData（数据层），
              // 渲染层仍走 doGraphUpdate(diff) 增量。合并后校验 nodeCount，
              // 与引擎汇总不一致（事件丢失/漂移）时兜底全量拉取。
              if (summary.diff && ws.graphData) {
                mergeGraphDiff(ws.graphData, summary.diff);
                const nc = Array.isArray(ws.graphData.nodes)
                  ? ws.graphData.nodes.length
                  : Object.keys(ws.graphData.nodes || {}).length;
                if (nc !== (summary.total_nodes ?? summary.node_count ?? nc)) {
                  throw new Error(`nodeCount mismatch: local ${nc} vs engine ${summary.total_nodes}`);
                }
              } else {
                const raw = await rpc<string>('get_full_graph');
                ws.graphData = JSON.parse(raw);
              }
              try {
                const filesPath = ws.path.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
                ws.fileGraphData = JSON.parse(
                  stripLineNumbers(await rpc<string>('read_file_content', { filePath: filesPath })),
                );
              } catch {
                /* 文件图谱可能尚不存在 */
              }
              ws.doGraphUpdate(starGraph, summary.diff);
              bus.emit('timeline:refresh');
            } catch {
              // 合并失败 / nodeCount 漂移 → 全量兜底
              try {
                const raw = await rpc<string>('get_full_graph');
                ws.graphData = JSON.parse(raw);
                ws.doGraphUpdate(starGraph);
                bus.emit('timeline:refresh');
              } catch {
                /* get_full_graph 也失败 — 保持现状 */
              }
            }
          }
        } catch {
          /* 忽略 */
        }
      });
      ws._unlisteners.push(unlistenGraphUpdated);

      // Agent 工具完成 → 文件可能变更时自动触发简报
      const FILE_MODIFY_TOOLS = new Set([
        'write_file',
        'edit_file',
        'delete_file',
        'rename_file',
        'move_file',
        'git_commit',
        'git_stage',
        'git_push',
        'git_pull',
        'run_shell',
        'rename_symbol',
      ]);
      const onToolDone = (evt: { toolName: string }) => {
        if (FILE_MODIFY_TOOLS.has(evt.toolName)) {
          ws.scheduleCheck();
          bus.emit('timeline:refresh');
          // 刷新引擎快照 — 跟踪累积结构漂移
          if (ws._preflightCtx) scheduleEngineSnapshotRefresh(ws._preflightCtx, ws.path);
        }
      };
      bus.on('agent:tool-done', onToolDone);
      ws._unlisteners.push(() => bus.off('agent:tool-done', onToolDone));

      const unlistenAnalysisComplete = await listen<string>('analysis-complete', async (event) => {
        if (!ws._active) return;
        try {
          const summary = JSON.parse(event.payload);
          if (!isSamePath(ws.path, summary.path)) return;
          const raw = await rpc<string>('get_full_graph');
          ws.graphData = JSON.parse(raw);
          try {
            const filesPath = ws.path.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
            ws.fileGraphData = JSON.parse(
              stripLineNumbers(await rpc<string>('read_file_content', { filePath: filesPath })),
            );
          } catch {
            /* 将由 watcher 重新生成 */
          }
          // 若 diff 可用则增量更新，否则全量渲染
          ws.doGraphUpdate(starGraph, summary.diff);
          bus.emit('timeline:refresh');
        } catch (e) {
          console.error('[analysis-complete] failed to reload graph:', e);
        }
      });
      ws._unlisteners.push(unlistenAnalysisComplete);

      const unlistenAnalysisFailed = await listen<{ path: string; error: string }>('analysis-failed', (event) => {
        if (!ws._active) return;
        if (!isSamePath(ws.path, event.payload.path)) return;
        const short = (event.payload.error || '未知错误').slice(0, 80);
        ws.onStatusChange?.(`⚠️ 后台分析失败: ${short}`);
      });
      ws._unlisteners.push(unlistenAnalysisFailed);

      // 清理进度监听器（仅在初始分析期间存活）
      unlistenProgress();
      unlistenPhase();
      unlistenHeartbeat();
      console.log('[Workspace.open] all done, returning workspace');
    } catch (err: any) {
      console.error('[Workspace.open] FAILED:', err);
      unlistenProgress();
      unlistenPhase();
      unlistenHeartbeat();
      ws.onStatusChange?.(`分析失败: ${err}`);
      ws.onLoadingChange?.(false);
      throw err;
    }

    return ws;
  }

  // ═══════════════════════════════════════════════════════════════
  // 停用 — 保存状态、停止监听器、移除监听器
  // ═══════════════════════════════════════════════════════════════

  async deactivate(chatPanel: ChatCore): Promise<void> {
    this._active = false;

    // 保存聊天会话
    try {
      await chatPanel.saveActiveSession(this.path);
    } catch {
      /* 忽略 */
    }

    // 停止 watcher 并清除后端状态
    try {
      await rpc('workspace_deactivate');
    } catch {
      /* 忽略 */
    }

    // 移除所有事件监听器
    for (const unlisten of this._unlisteners) {
      try {
        unlisten();
      } catch {
        /* 忽略 */
      }
    }
    this._unlisteners = [];

    // 清除 Agent 与记忆
    // 清除前停止所有运行中的子 Agent
    this.subAgentPool.stopAll();
    // 销毁运行时前刷新会话级看板 — 等待完成，确保看板数据
    // 在运行时 Agent 被拆除前已持久化。
    if (this.runtime) {
      await this.runtime.flushAllBoards();
    }
    // 销毁运行时 Agent — disposeAll 逐句柄走完整清理
    // （flush + saveState('done') + LifecycleManager 停止 + bus 注销）
    if (this.runtime) {
      this.runtime.disposeAll();
      this.runtime = null;
    }
    // 清除 Agent 面板数据
    useAgentPanelStore.getState().setAgents([]);
    useAgentPanelStore.getState().setTaskBoard([]);
    useAgentPanelStore.getState().setDiscoveries([]);
    // this.agent 是借用引用 — disposeAll 已完成 saveState，这里只需断开
    this.agent = null;
    try {
      await auraShutdown();
    } catch {
      /* 忽略 */
    }
    this.memoryManager = null;

    // 清除计时器
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /** 强制清除所有状态，不等待异步清理。
   *  在 deactivate() 超时时调用 — 防止卡住的工作区
   *  阻塞下一次 switchWorkspace。 */
  forceClearState(): void {
    this._active = false;
    for (const unlisten of this._unlisteners) {
      try { unlisten(); } catch { /* 忽略 */ }
    }
    this._unlisteners = [];
    this.subAgentPool.stopAll();
    // 分离运行时前尽力刷新 — 设计为 fire-and-forget
    // （这是同步紧急路径；deactivate() 会 await 刷新）。
    if (this.runtime) {
      void this.runtime.flushAllBoards();
    }
    this.runtime = null;
    this.agent = null;
    this.memoryManager = null;
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  // ── Agent 配置变更统一入口 ──

  /** provider 配置摘要键 — 用于判定 provider 是否真的变了。
   *  provider 变化走 setProvider 热切换；thinking/contextWindow 等行为参数
   *  总是热同步；无关字段（display/lastTest/temperature 遗留）直接 no-op。 */
  private static _agentRebuildKey(s: AppSettings): string {
    const provs = s.providers
      .map((p) => `${p.name}:${p.kind}:${p.apiKey}:${p.baseUrl}:${p.model}`)
      .sort()
      .join('|');
    return `${s.activeProvider}#${provs}`;
  }

  /**
   * Agent 配置变更统一入口（由 bus 'agent:config-changed' 驱动）。
   * 所有变更一律热切换，不重建 Agent：
   *  - provider（模型/信号源/协议）变了 → 换 provider 引用 + 定价（setProvider）
   *  - thinking / contextWindow → 热同步（setThinking / setContextWindow）
   *  - 协作模式 → 运行时切换（setPlanMode）
   * 上下文、压缩缓存、hook、正在运行的执行、所有会话全部保留。
   * 组件不得绕过此方法直接调 setupAgent。
   */
  async applyAgentConfig(chatPanel: ChatCore, reason: AgentConfigChangeReason): Promise<void> {
    // 规划模式切换 — 运行时状态切换
    if (reason === 'collaboration-mode') {
      const mode = this._modeState().collaborationMode;
      this.agent?.setPlanMode(mode === 'plan');
      return;
    }

    const s = await loadSettingsWithSecrets();
    const act = getActiveProvider(s);

    // API Key 被清空 → 显式拆除（旧 provider 不得继续服务会话）
    if (!act.apiKey || act.apiKey.trim() === '') {
      this.agent = null;
      this.prov = null;
      chatPanel.setAgent(null);
      bus.emit('agent:diag', { text: `❌ API Key 已清空 — provider="${act.name}"。`, ready: false });
      return;
    }

    // provider 配置变化 → 换引用（热切换），否则跳过
    const key = Workspace._agentRebuildKey(s);
    if (this._lastAgentCfgKey === null || key !== this._lastAgentCfgKey) {
      const prov = this._buildProvider(s);
      prov.prewarm?.(); // 廉价预热（fire-and-forget）
      const pricing = defaultPricing(act.kind, act.model);
      this.prov = prov;
      this.agent?.setProvider(prov, pricing);
      agentSessionState.forEachAgent((h) => h.setProvider(prov, pricing));
      this._lastAgentCfgKey = key;
    }

    // 行为参数总是热同步（幂等）
    const thinkingCfg = withThinkingDisabled(act.thinking, s.agent?.disableThinking);
    const win = this._effectiveContextWindow(s);
    this.agent?.setThinking(thinkingCfg);
    this.agent?.setContextWindow(win);
    agentSessionState.forEachAgent((h) => {
      h.setThinking(thinkingCfg);
      h.setContextWindow(win);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // setupAgent — 构建带 hologram/coding/memory 工具的 LLM Agent
  // ═══════════════════════════════════════════════════════════════

  async setupAgent(chatPanel: ChatCore): Promise<void> {
    if (this.agentSetupRunning) {
      this.agentSetupPending = true;
      return;
    }
    this.agentSetupRunning = true;
    try {
      await this._setupAgentInner(chatPanel);
    } finally {
      this.agentSetupRunning = false;
      if (this.agentSetupPending) {
        this.agentSetupPending = false;
        await this.setupAgent(chatPanel);
      }
    }
  }

  /** 从 panel store 读取模式状态。回退到 normal/ask。 */
  private _modeState(): { collaborationMode: 'normal' | 'plan'; permissionMode: 'ask' | 'auto' | 'yolo' } {
    try {
      const ps = getPanelStore(this._storeId).getState();
      return { collaborationMode: ps.collaborationMode as any, permissionMode: ps.permissionMode as any };
    } catch (e) {
      console.warn('[Workspace] _modeState failed, falling back to normal/ask:', e);
      return { collaborationMode: 'normal', permissionMode: 'ask' };
    }
  }

  /** 从同一份 settings 快照构建 active provider — createProvider 选项唯一收口处，
   *  _setupAgentInner 与会话工厂共用，保证两处构建永不分叉。 */
  private _buildProvider(settings: AppSettings): Provider {
    return createProvider(getActiveProvider(settings), {
      disableThinking: settings.agent?.disableThinking,
    });
  }

  /** 生效上下文窗口 — 设置值优先，其次活跃模型目录窗口，最后 200K。
   *  factory 与 settings-saved 热切换共用，保证两处计算不分叉。 */
  private _effectiveContextWindow(s: AppSettings): number {
    const act = getActiveProvider(s);
    return s.agent?.contextWindow || getModel(act.model)?.contextWindow || 200000;
  }

  private async _setupAgentInner(chatPanel: ChatCore): Promise<void> {
    this._storeId = chatPanel.panelId;

    const settings = await loadSettingsWithSecrets();

    // 从保存的偏好初始化模式状态
    const sAgent = settings.agent || {};
    const ps = getPanelStore(this._storeId).getState();
    if (sAgent.collaborationMode && ps.collaborationMode === 'normal') {
      ps.setCollaborationMode(sAgent.collaborationMode);
    }
    if (sAgent.permissionMode && ps.permissionMode === 'ask') {
      ps.setPermissionMode(sAgent.permissionMode);
    }

    const active = getActiveProvider(settings);

    const diag = `[Agent] provider=${active.name} keyLen=${(active.apiKey || '').length}`;
    this.onStatusChange?.(diag);
    bus.emit('agent:diag', { text: diag, ready: !!active.apiKey && active.apiKey.trim() !== '' });

    if (!active.apiKey || active.apiKey.trim() === '') {
      this.agent = null;
      chatPanel.setAgent(null);
      bus.emit('agent:diag', { text: `❌ 未检测到 API Key — provider="${active.name}" 的 Key 为空。`, ready: false });
      return;
    }

    // ⚡ 2026-08-08：删除启动时的 persistSecrets 回写（原在此行）。
    // 理由：读回→无条件写回是「null 复活」与双重编码放大循环的驱动器——
    // 任何残留在 state 里的垃圾 key（如字面量 "null"）都会在每次启动时
    // 被重新写入凭据库。凭据的唯一写入入口 = SettingsPanel 的保存动作。

    // 加载记忆（全局 + 项目）
    let memorySection = '';
    let globalDir: string | undefined;
    try {
      globalDir = await rpc<string>('get_global_memory_dir');
    } catch {
      /* 忽略 */
    }
    this.memoryManager = new MemoryManager(this.path, globalDir);
    this.memoryManager.onSaved = (info) => {
      this.agent?.notifyMemorySaved(
        `记忆已更新: **${info.description || info.name}** (${info.confidence || 'reference'})`,
      );
    };
    const auraReady = this.memoryManager.initAura();
    try {
      memorySection = await this.memoryManager.loadPromptSection(extractGraphNodeNames(this.graphData));
    } catch (e) {
      console.error('[setupAgent] loadPromptSection failed:', e);
    }

    // 初始化 Agent 状态持久化 + goal 生命周期 + skill 注册表
    this.agentStore = new AgentStore(this.path);
    this.goalManager = new GoalManager(this.path, (r) => bus.emit('goal:state', r));
    this.goalManager.migrateLegacy().then(() => this.goalManager?.adoptOrphans()).catch((e) => console.warn('[workspace] goal migration failed:', e));
    this.skillRegistry = new SkillRegistry(this.path);

    await auraReady;
    if (memorySection.trim()) {
      const memLines = memorySection.split('\n').filter((l) => l.startsWith('- ')).length;
      const globalCount = this.memoryManager?.scopes?.().includes('global') ? ' (含全局)' : '';
      this.onStatusChange?.(`[记忆] 已注入 ${memLines} 条${globalCount}`);
    }

    // ── 创建 Provider ──
    const prov: Provider = this._buildProvider(settings);
    prov.prewarm?.();
    // 从 API 获取动态模型，合并到目录（尽力而为）
    prov.fetchModels?.()
      .then((models) => {
        if (models.length > 0) mergeDynamicModels(active.name, models);
      })
      .catch(() => {});
    this.prov = prov;

    // ── 创建 Runtime + UI 适配器 ──
    // P0-10：覆盖旧 runtime 前必须走完整拆除（与下方销毁路径同一顺序：
    // flushAllBoards → disposeAll）——否则旧 runtime 的订阅与防抖 flush
    // 定时器仍然存活，可能回写覆盖新看板（雷区地图 P0-10）
    if (this.runtime) {
      try {
        await this.runtime.flushAllBoards();
      } catch (e) {
        console.warn('[workspace] 旧 runtime 看板 flush 失败:', e);
      }
      this.runtime.disposeAll();
      this.runtime = null;
    }
    const runtime = new AgentRuntime(this.path);
    const adapter = createRuntimeAdapter(this._storeId);
    runtime.setNotifier(adapter);
    runtime.setDiagnosticsSource(getDiagnosticsForFile);
    this.runtime = runtime;

    // ── 初始化 Agent 面板数据 + 订阅消息流 ──
    useAgentPanelStore.getState().setRuntime(runtime);
    useAgentPanelStore.getState().refresh(runtime);
    const unsubMsg = runtime.getBus().subscribe({}, (msg) => {
      useAgentPanelStore.getState().pushMessage(msg);
    });
    this._unlisteners.push(unsubMsg);

    // ── 构建图谱上下文 ──
    const graphCtx = buildGraphContextFromData(this.graphData);
    this._preflightCtx = graphCtx;

    // ── 构建工具注册表（通过 agent-builder，零 UI 导入）──
    const builderDeps: BuilderDeps = createBuilderDeps(this._storeId);
    runtime.setDeps(builderDeps);
    const agentRef = { current: null as Agent | null };

    const registry = await buildToolRegistry({
      graphData: this.graphData,
      deps: builderDeps,
      memoryManager: this.memoryManager,
      skillRegistry: this.skillRegistry,
      taskManager: this.taskManager,
      subAgentPool: this.subAgentPool,
      subAgentSpawner: async (desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride) =>
        agentRef.current?.spawnSubAgent(desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride) ??
        Promise.resolve({ text: '', err: 'agent not available' }),
    });
    this.registry = registry;

    // 将工具 schema 连接到 UI 面板
    chatPanel.setToolSchemas(registry.schemas());

    // 冷启动：预热状态缓存
    refreshGitStatus(this.path).catch(() => {});
    refreshTimeline(this.path).catch(() => {});

    // ── 工厂：每次调用通过 runtime 创建全新 Agent ──
    // 返回 runtime 句柄（含 dispose）— 所有权随句柄交给会话 state
    // （agentSessionState），会话关闭时由其负责销毁；
    // agentRef/this.agent 仅是借用 raw Agent 引用（spawn 闭包、notifyMemorySaved）。
    const factory = async (): Promise<AgentHandle | null> => {
      // 单一新鲜快照 — apiKey 判定 / provider 构建 / 定价 / 窗口全部出自它。
      // （旧实现用外层 setup 时的 prov 配新鲜 settings 的 key/定价，
      //  两份快照只靠 agent:config-changed 重跑 setupAgent 才不分叉。）
      const s = await loadSettingsWithSecrets();
      const act = getActiveProvider(s);
      if (!act.apiKey || act.apiKey.trim() === '') return null;
      const sessProv = this._buildProvider(s);
      sessProv.prewarm?.(); // 廉价预热（fire-and-forget）；fetchModels 合目录只在 setupAgent 做

      const ms = this._modeState();
      const agentOpts = s.agent || {};

      await runtime.ready();
      const handle = await runtime.createAgent({
        // 唯一 agentId — 每会话一个 Agent 实例；'main' 硬编码会让所有会话的
        // Agent 在 runtime.agents/_agentSessions 里互相覆盖（多会话错位根因之一）
        agentId: `main-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        parentId: null,
        projectPath: this.path,
        graphData: this.graphData,
        provider: sessProv,
        tools: registry,
        memoryManager: this.memoryManager ?? undefined,
        skillRegistry: this.skillRegistry ?? undefined,
        goalManager: this.goalManager ?? undefined,
        agentStore: this.agentStore ?? undefined,
        subAgentPool: this.subAgentPool,
        taskManager: this.taskManager,
        graphContext: graphCtx,
        eventSink: chatPanel.eventSink,
        execState: chatPanel.execState,
        collaborationMode: ms.collaborationMode,
        pricing: defaultPricing(act.kind, act.model),
        temperature: agentOpts.temperature ?? 0.7,
        // 从模型目录动态解析窗口（deepseek-v4 标 1M），查不到才 fallback 200K。
        // 0b3e5bf 曾加 Math.min(..., 200000) 硬封顶 — 把动态结果压成 200K，
        // 导致压缩在 110K 就触发；压缩已根治为只影响发送载荷，cap 无必要。
        contextWindow: this._effectiveContextWindow(s),
        preRunHook: this.memoryManager
          ? async (input: string) => {
              if (!this.memoryManager!.auraReady) return null;
              try {
                const records = await this.memoryManager!.auraSemanticRecall(input, 5);
                if (records.length === 0) return null;
                const lines = records.map((r) => {
                  const t = r.tags?.length ? `[${r.tags.join(', ')}] ` : '';
                  return `- ${t}${r.content.slice(0, 250)}`;
                });
                return `AuraSDK 语义记忆召回：\n${lines.join('\n')}`;
              } catch {
                return null;
              }
            }
          : undefined,
        onSessionPersisted: (_sid: string, messages: Array<{ role: string; content: unknown }>) => {
          memoryBundleIngest(
            messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
            'holo',
            _sid,
          ).catch(() => {});
          (async () => {
            await refreshGitStatus(this.path);
            await refreshTimeline(this.path);
            const block = buildTurnStartBlock();
            if (block) agentRef.current?.insertMessage(`<system-reminder>\n${block}\n</system-reminder>`, { silent: true });
          })().catch(() => {});
        },
      });

      const agent = ('_getAgent' in handle ? (handle as { _getAgent(): Agent })._getAgent() : null);
      if (!agent) return null;
      agentRef.current = agent;
      this.memoryManager?.prewarmAura();
      return handle;
    };

    // 注册工厂 + 创建初始 Agent
    chatPanel.setAgentFactory(factory);
    const initialAgent = await factory();
    if (initialAgent) {
      this.agent = agentRef.current;
      chatPanel.setAgent(initialAgent);
      this.onStatusChange?.('[Agent] ✅ 已就绪');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // runCheck — 健康检查 / 简报
  // ═══════════════════════════════════════════════════════════════

  async runCheck(): Promise<void> {
    if (!this.path) return;
    if (this.checkRunning) {
      this.checkPending = true;
      return;
    }
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }

    this.checkRunning = true;
    this.checkPending = false;
    try {
      const json = await rpc<string>('hologram_run_check', { path: this.path });
      try {
        const result: CheckResult = JSON.parse(json);
        const dock = useDockStore.getState();
        dock.setCheckResult(result);
        // 旧 loadAndRenderGate 实际等价于 open() — 每次简报后展开面板
        dock.openPanel('check');
        bus.emit('timeline:refresh');
        // 通知工具栏以显示违规徽章
        const cnt =
          (result.l5_violations?.length || 0) +
          (result.l4_violations?.length || 0) +
          (result.l3_violations?.length || 0) +
          (result.l2_violations?.length || 0);
        bus.emit('check:result', { passed: result.passed, violations: cnt });
        // 推送状态栏通知 — 即使检查面板关闭也可见
        if (!result.passed) {
          this.onStatusChange?.(`⚠ 简报未通过: ${cnt} 条违规`);
        }
      } catch (parseErr) {
        console.error('[runCheck] JSON parse failed:', parseErr, 'raw:', json.slice(0, 200));
        this.onStatusChange?.('简报解析失败');
      }
    } catch (err: any) {
      console.error('Check failed:', err);
      this.onStatusChange?.('简报请求失败');
    } finally {
      this.checkRunning = false;
      if (this.checkPending) {
        this.checkPending = false;
        if (this.checkTimer) clearTimeout(this.checkTimer);
        this.checkTimer = setTimeout(() => {
          this.checkTimer = null;
          if (!this.checkRunning) this.runCheck();
        }, 2000);
      }
    }
  }

  /** 防抖检查 — Agent 写入文件时调用。3 秒延迟批量处理多次写入。 */
  scheduleCheck(): void {
    if (!this.path) return;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      if (!this.checkRunning) this.runCheck();
    }, 3000);
  }

  // ═══════════════════════════════════════════════════════════════
  // doGraphUpdate — 处理来自 watcher 的图谱更新（diff 可用时增量更新）
  // ═══════════════════════════════════════════════════════════════
  doGraphUpdate(starGraph: StarGraph, diff?: any): void {    if (!this.graphData) return;
    const nodeCount = Array.isArray(this.graphData.nodes)
      ? this.graphData.nodes.length
      : Object.keys(this.graphData.nodes || {}).length;
    // ponytail: 增量路径 — 不 clearGraph，不重置相机，仅对新节点做局部布局松弛
    if (diff && starGraph.hasGraph) {
      starGraph
        .applyGraphDiff(diff, this.graphData)
        .then(() => {
          this.onStatusChange?.(`已增量更新 (${nodeCount} 节点)`);
          this.runCheck();
        })
        .catch((e) => {
          console.error('[doGraphUpdate] incremental failed, falling back to full render:', e);
          starGraph.render(this.graphData);
          this.onStatusChange?.(`已更新 (${nodeCount} 节点)`);
          if (this.diffActive) {
            starGraph.clearDiff();
            this.diffActive = false;
          }
          this.runCheck();
        });
    } else {
      starGraph.render(this.graphData);
      this.onStatusChange?.(`已更新 (${nodeCount} 节点)`);
      if (this.diffActive) {
        starGraph.clearDiff();
        this.diffActive = false;
      }
      this.runCheck();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// mergeGraphDiff — 数据层增量合并（2026-08-04 状态治理）
// ═══════════════════════════════════════════════════════════════
// 将 watcher 的 diff 原地合并进本地 graphData（nodes/edges），
// 使 graph-updated 不再需要全量 get_full_graph。
// 支持 nodes/edges 的数组（引擎 serialize_cached_graph 输出）与
// Record（id → 节点）两种形态；communiities/meta 不随 diff 变更，保持原样。
// ⚠️ 原地修改 graphData — 调用方持有同一引用，无需重新赋值。
function mergeGraphDiff(graphData: { nodes?: any; edges?: any }, diff: GraphDiffJson): void {
  const removedIds = new Set(diff.removed_nodes.map((n) => n.id));
  if (Array.isArray(graphData.nodes)) {
    for (const n of diff.added_nodes) graphData.nodes.push(n);
    for (const m of diff.modified_nodes) {
      const n = graphData.nodes.find((x) => x.id === m.node_id);
      if (n) {
        n.name = m.name;
        n.kind = m.new_kind;
        n.type = m.new_kind;
      }
    }
    if (removedIds.size > 0) {
      let w = 0;
      for (let i = 0; i < graphData.nodes.length; i++) {
        if (!removedIds.has(graphData.nodes[i].id)) graphData.nodes[w++] = graphData.nodes[i];
      }
      graphData.nodes.length = w;
    }
  } else if (graphData.nodes && typeof graphData.nodes === 'object') {
    for (const n of diff.added_nodes) graphData.nodes[n.id] = n;
    for (const m of diff.modified_nodes) {
      const n = graphData.nodes[m.node_id];
      if (n) {
        n.name = m.name;
        n.kind = m.new_kind;
        n.type = m.new_kind;
      }
    }
    for (const id of removedIds) delete graphData.nodes[id];
  }

  const removedEdgeIds = new Set(diff.removed_edges.map((e) => e.id));
  if (Array.isArray(graphData.edges)) {
    for (const e of diff.added_edges) graphData.edges.push(e);
    if (removedEdgeIds.size > 0) {
      let w = 0;
      for (let i = 0; i < graphData.edges.length; i++) {
        if (!removedEdgeIds.has(graphData.edges[i].id)) graphData.edges[w++] = graphData.edges[i];
      }
      graphData.edges.length = w;
    }
  } else if (graphData.edges && typeof graphData.edges === 'object') {
    for (const e of diff.added_edges) graphData.edges[e.id] = e;
    for (const id of removedEdgeIds) delete graphData.edges[id];
  }
}

// ═══════════════════════════════════════════════════════════════
// buildSystemPrompt — 纯函数，读取 Workspace 状态
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// （数据流追踪 Agent 已移除 — 由引擎查询替代）
