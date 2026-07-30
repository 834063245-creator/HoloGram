// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentRuntime — 管理 Agent 实例的生命周期
//
// 职责：
//   - 创建/销毁 Agent 实例
//   - 通过 RuntimeNotifier 接口向 UI 推送事件（不直接操作 zustand/store）
//   - 管理 ToolRegistry、hooks、preflight 等 Agent 依赖
//
// 不依赖：React, zustand, ui/event bus, ui/chat-store, ui/panel-store
//
// UI 层通过 setNotifier() 注入通知器，Runtime 通过它路由事件。

import { rpc } from '../../bridge';
import { createProvider } from '../../provider';
import type { Message, Provider } from '../../provider/types';
import { defaultPricing } from '../../settings';
import { Agent } from '../agent';
import type { AgentStore } from '../agent-store';
import type { AgentEvent, AgentUINotifier, EventSink } from '../agent-types';
import { EventKind } from '../agent-types';
import type { SubAgentPool } from '../coordinator';
import { createExecState, type ExecStateInstance } from '../execution-state';
import type { GoalManager } from '../goal-manager';
import type { GraphContext } from '../hooks';
import {
  buildGraphSnapshot,
  createGraphContextHook,
  createGraphPreflightHook,
  createStatePreflightHook,
  createStateReadHook,
  HookRegistry,
  PreflightHookRegistry,
} from '../hooks';
import { createBoardTrackingHook } from '../hooks/board-tracking-hook';
import { log } from '../logger';
import type { MemoryManager } from '../memory';
import { memoryBundleIngest } from '../memory-bundle-client';
import { MessageBus } from '../message-bus';
import { JsonMessageStore } from '../message-store';
import { TaskBoard, TaskBoardProxy } from '../task-board';
import { DiscoveryBoard, DiscoveryBoardProxy } from '../discovery-board';
import { createDiscoveryTools } from '../tools/discovery';
import type { SkillRegistry } from '../skills';
import type { DiagnosticsSource, LspDiagnostic } from '../state-inject';
import { buildTurnStartBlock, refreshGitStatus, refreshTimeline } from '../state-inject';
import type { TaskManager } from '../task';
import { ToolRegistry, agentInvoke } from '../tool';
import { createCommunicationTools } from '../tools/communication';
import { createMergeTool } from '../tools/merge';
import { createAgentKillTool } from '../tools/subagent';
import { createRequestTool } from '../tools/request';
import { AgentLifecycleManager } from '../lifecycle-manager';
import { enqueueIsolationOp } from '../isolation-queue';
import type { SubAgentSpawner } from '../tools/subagent';
import {
  type BuilderDeps,
  buildGraphContextFromData,
  buildSystemPrompt,
  buildToolRegistry,
  extractGraphNodeNames,
  loadEngineSnapshot,
  planRegistry,
  registerCompactionTools,
} from './agent-builder';
import { PlanModeInjector } from '../plan/plan-injection';
import { PlanStateManager } from '../plan/plan-state';
import { createEnterPlanModeTool, createExitPlanModeTool } from '../plan/plan-tools';
import { createPlanExploreHook, createPlanWriteHook } from '../plan/plan-graph-hook';

import type { AgentConfig, AgentHandle, AgentStatus, AgentSummary, RuntimeNotifier, RuntimePort } from './types';

// ── AgentHandleImpl ──

class AgentHandleImpl implements AgentHandle {
  constructor(
    private readonly _agent: Agent,
    private readonly _runtime: AgentRuntime,
  ) {}

  get id(): string {
    return this._agent.id;
  }
  get parentId(): string | null {
    return this._agent.parentId;
  }
  get status(): AgentStatus {
    return this._agent.isRunning ? 'running' : 'idle';
  }

  run(signal: AbortSignal, input: string): Promise<void> {
    return this._agent.run(signal, input);
  }
  runGoal(signal: AbortSignal, goal: string) {
    return this._agent.runGoal(signal, goal);
  }
  resumeGoal(signal: AbortSignal, id?: string) {
    return this._agent.resumeGoal(signal, id);
  }
  compactNow(signal: AbortSignal) {
    return this._agent.compactNow(signal);
  }
  retractTurnAt(sessionIndex: number) {
    return this._agent.retractTurnAt(sessionIndex);
  }
  getSession() {
    return this._agent.getSession();
  }
  setSession(msgs: Message[]) {
    return this._agent.setSession(msgs);
  }
  newSession() {
    return this._agent.newSession();
  }
  get nextInsertIndex() {
    return this._agent.nextInsertIndex;
  }
  insertMessage(text: string, opts?: { silent?: boolean }) {
    return this._agent.insertMessage(text, opts);
  }
  cascadeAbort() {
    return this._agent.cascadeAbort();
  }
  stopAllSubAgents() {
    return this._agent.stopAllSubAgents();
  }
  runningSubAgentCount() {
    return this._agent.runningSubAgentCount();
  }
  setUiSessionId(sid: number) {
    return this._agent.setUiSessionId(sid);
  }

  /** 直接访问底层 Agent — 仅供内部使用 */
  _getAgent(): Agent {
    return this._agent;
  }
}

// ── AgentRuntime ──

export class AgentRuntime implements RuntimePort {
  private agents = new Map<string, AgentHandleImpl>();
  private notifier: RuntimeNotifier | null = null;
  /** BuilderDeps — UI 层注入的回调（askUser, onPlanReview 等） */
  private _deps: BuilderDeps | null = null;
  /** 全局 MessageBus 实例 */
  private _bus: MessageBus;
  /** 会话级 TaskBoard 实例 — 按 sessionId 隔离 */
  private _taskBoards = new Map<string, TaskBoard>();
  /** 会话级 DiscoveryBoard 实例 — 按 sessionId 隔离 */
  private _discoveryBoards = new Map<string, DiscoveryBoard>();
  /** 主 Agent 的 board proxies — 用于会话切换时动态换 target */
  private _mainTaskProxy: TaskBoardProxy | null = null;
  private _mainDiscoveryProxy: DiscoveryBoardProxy | null = null;
  /** 主 Agent ID — 用于 setCurrentSession 时更新 _agentSessions */
  private _mainAgentId: string | null = null;
  /** 已 restore 的会话集合 — 避免重复 restore */
  private _restoredSessions = new Set<string>();
  /** 项目路径 — 用于持久化 */
  private _projectPath: string;
  /** LifecycleManager 实例 — 每个 agent 一个，持有 pool/board/bus/exec/sink 引用 */
  private _lifecycleManagers = new Map<string, AgentLifecycleManager>();
  /** 启动恢复 promise — createAgent 前必须 await ready() */
  private _readyPromise: Promise<void>;
  /** agentId → sessionId 映射 — destroyAgent 时知道清理哪个会话的 board */
  private _agentSessions = new Map<string, string>();

  constructor(projectPath?: string) {
    this._projectPath = projectPath ?? '';
    if (projectPath) {
      const store = new JsonMessageStore(projectPath);
      this._bus = new MessageBus(undefined, store);
      this._readyPromise = this._restore();
    } else {
      this._bus = new MessageBus();
      this._readyPromise = Promise.resolve();
    }
  }

  /** 等待启动恢复完成 — createAgent 前必须 await */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /** 注入 UI 通知器 — 由 UI 层在启动时设置 */
  setNotifier(n: RuntimeNotifier): void {
    this.notifier = n;
  }

  /** 注入 BuilderDeps — UI 层在启动时设置（askUser, onPlanReview 等回调） */
  setDeps(deps: BuilderDeps): void {
    this._deps = deps;
  }

  /** 获取全局 MessageBus 实例 */
  getBus(): MessageBus {
    return this._bus;
  }

  /** 获取指定会话的 TaskBoard — 不存在则创建 */
  getTaskBoard(sessionId?: string): TaskBoard {
    return this._getOrCreateTaskBoard(sessionId ?? 'default');
  }

  /** 获取指定会话的 DiscoveryBoard — 不存在则创建 */
  getDiscoveryBoard(sessionId?: string): DiscoveryBoard {
    return this._getOrCreateDiscoveryBoard(sessionId ?? 'default');
  }

  /** 获取或创建会话级 TaskBoard */
  private _getOrCreateTaskBoard(sessionId: string): TaskBoard {
    let board = this._taskBoards.get(sessionId);
    if (!board) {
      board = new TaskBoard(this._projectPath || undefined, sessionId);
      this._taskBoards.set(sessionId, board);
    }
    return board;
  }

  /** 获取或创建会话级 DiscoveryBoard */
  private _getOrCreateDiscoveryBoard(sessionId: string): DiscoveryBoard {
    let board = this._discoveryBoards.get(sessionId);
    if (!board) {
      board = new DiscoveryBoard(this._projectPath || undefined, sessionId);
      this._discoveryBoards.set(sessionId, board);
    }
    return board;
  }

  /** 销毁会话级 board 并删除持久化文件 */
  async destroySessionBoards(sessionId: string): Promise<void> {
    const tb = this._taskBoards.get(sessionId);
    if (tb) {
      await tb.destroy();
      this._taskBoards.delete(sessionId);
    }
    const db = this._discoveryBoards.get(sessionId);
    if (db) {
      await db.destroy();
      this._discoveryBoards.delete(sessionId);
    }
  }

  /** 切换当前活跃会话 — 主 Agent 的 board proxies 会指向新会话的 board */
  setCurrentSession(sessionId: string): void {
    const tb = this._getOrCreateTaskBoard(sessionId);
    const db = this._getOrCreateDiscoveryBoard(sessionId);
    // 尚未恢复的会话进行懒加载恢复
    if (!this._restoredSessions.has(sessionId)) {
      this._restoredSessions.add(sessionId);
      void tb.restore();
      void db.restore();
    }
    this._mainTaskProxy?.setTarget(tb);
    this._mainDiscoveryProxy?.setTarget(db);
    // 更新主 Agent 的会话映射，使子 Agent 继承活跃会话
    if (this._mainAgentId) {
      this._agentSessions.set(this._mainAgentId, sessionId);
    }
  }

  /** 启动恢复 — 在 createAgent() 之前完成。
   *  1. 恢复所有 inbox 消息
   *  2. 迁移旧全局 discoveries.json/taskboard.json（一次性）
   *  3. 孤儿检测：崩溃时还在跑的子 agent，进程已死，标记为 stopped 并清理 worktree
   *  best-effort — 永不抛异常阻塞启动
   *  注意：会话级 board 懒加载，首次 getOrCreate 时 restore */
  private async _restore(): Promise<void> {
    try {
      // 1. 恢复所有 inbox 消息
      await this._bus.restore();
      // 1b. 清除跨 session 泄漏的 result/reply — 这些只在上个 session 内有效
      this._bus.purgeEphemeralTypes();

      // 2. 迁移旧全局 discoveries.json → default 会话（一次性）
      await this._migrateGlobalBoards();

      // 3. 恢复 default 会话的 boards（启动时默认恢复）
      const defaultTB = this._getOrCreateTaskBoard('default');
      await defaultTB.restore();
      const defaultDB = this._getOrCreateDiscoveryBoard('default');
      await defaultDB.restore();
      this._restoredSessions.add('default');

      // 4. 孤儿检测：找 status === 'running' 的条目 — 这些是崩溃时还在跑的子 agent
      const orphans = defaultTB.getAllEntries().filter((e) => e.status === 'running');
      for (const orphan of orphans) {
        defaultTB.stop(orphan.agentId);
        // 清理 worktree
        if (orphan.isolationId) {
          try {
            await enqueueIsolationOp(async () => {
              await agentInvoke<string>('agent_isolation_discard', { agent_id: orphan.isolationId! }).catch(() => {});
            });
          } catch {
            /* best-effort */
          }
        }
        console.warn(`[AgentRuntime] 检测到孤儿 agent: ${orphan.agentId}, 已标记为 stopped`);
      }

      // 5. 刷新持久化（把 stop 状态写回）
      if (orphans.length > 0) {
        await defaultTB.flush();
      }
    } catch {
      // best-effort — 恢复失败不阻塞启动
    }
  }

  /** 一次性迁移旧全局 discoveries.json / taskboard.json → default 会话 */
  private async _migrateGlobalBoards(): Promise<void> {
    if (!this._projectPath) return;
    const base = this._projectPath.replace(/\\/g, '/').replace(/\/$/, '');
    // 迁移全局 discoveries.json
    const oldDiscPath = `${base}/.hologram/discoveries.json`;
    try {
      const raw = await rpc<string>('read_file_content', { filePath: oldDiscPath });
      const arr = JSON.parse(raw.replace(/^\s*\d+\t/gm, ''));
      if (Array.isArray(arr) && arr.length > 0) {
        const db = this._getOrCreateDiscoveryBoard('default');
        for (const e of arr) {
          db.post(e.agentId, e.key, e.value, e.category);
        }
        await db.flush();
      }
      // 迁移后删除旧文件
      await rpc('delete_file_or_dir', { path: oldDiscPath }).catch(() => {});
    } catch {
      /* 文件不存在 — 无需迁移 */
    }
    // 迁移全局 taskboard.json
    const oldTaskPath = `${base}/.hologram/taskboard.json`;
    try {
      const raw = await rpc<string>('read_file_content', { filePath: oldTaskPath });
      const arr = JSON.parse(raw.replace(/^\s*\d+\t/gm, ''));
      if (Array.isArray(arr) && arr.length > 0) {
        const tb = this._getOrCreateTaskBoard('default');
        // 直接将迁移的条目写入新路径
        await rpc('write_file_content', {
          filePath: `${base}/.hologram/taskboard/default.json`,
          content: JSON.stringify(arr, null, 2),
        });
      }
      // 迁移后删除旧文件
      await rpc('delete_file_or_dir', { path: oldTaskPath }).catch(() => {});
    } catch {
      /* 文件不存在 — 无需迁移 */
    }
  }

  /** 创建 Agent — 接收完整配置，Runtime 不做 UI 依赖的事 */
  async createAgent(config: AgentConfig): Promise<AgentHandle> {
    const agentId = config.agentId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 会话级 board — 按 sessionId 隔离，子 Agent 继承父会话
    // 有 parentId 的子 Agent 继承父会话 ID；否则使用 config.sessionId 或 'default'
    const sessionId = config.sessionId
      ?? (config.parentId ? this._agentSessions.get(config.parentId) : undefined)
      ?? 'default';
    const taskBoard = this._getOrCreateTaskBoard(sessionId);
    const discoveryBoard = this._getOrCreateDiscoveryBoard(sessionId);
    // Proxy 允许主 Agent（跨会话切换时持久存在）
    // 动态路由到当前会话的 board。
    const taskProxy = new TaskBoardProxy(taskBoard);
    const discoveryProxy = new DiscoveryBoardProxy(discoveryBoard);
    this._agentSessions.set(agentId, sessionId);
    // 追踪主 Agent 的 proxies 用于会话切换
    if (!config.parentId) {
      this._mainTaskProxy = taskProxy;
      this._mainDiscoveryProxy = discoveryProxy;
      this._mainAgentId = agentId;
    }

    // 1. 构建 system prompt（如果没预构建）
    let sysPrompt = config.systemPrompt;
    if (!sysPrompt) {
      let memSection = '';
      if (config.memoryManager) {
        try {
          memSection = await config.memoryManager.loadPromptSection(
            config.graphData ? extractGraphNodeNames(config.graphData) : undefined,
          );
        } catch {}
      }
      let claudeMd = '';
      try {
        claudeMd = await rpc<string>('read_file_content', { filePath: `${config.projectPath}/CLAUDE.md` });
      } catch {}
      const snap = config.graphData ? buildGraphSnapshot(config.graphData) : '';
      sysPrompt = buildSystemPrompt(
        config.graphData,
        config.projectPath,
        memSection,
        snap,
        claudeMd,
        config.collaborationMode ?? 'normal',
        config.provider.name(),
      );
    }

    // 2. 克隆工具注册表（每个 Agent 获得自己的副本）
    const r = new ToolRegistry();
    for (const t of config.tools.all()) r.register(t);

    // 2b. Plan 模式状态 — 在 planRegistry 之前创建，使工具能引用它
    const planState = new PlanStateManager();
    if (config.collaborationMode === 'plan') {
      planState.enter(config.projectPath);
    }

    // 2c. 注册 plan 工具（readOnly: true → 通过 planRegistry 过滤）
    r.register(createEnterPlanModeTool(planState, config.projectPath));
    // exit_plan_mode 使用 eventSink 将 PlanReview 事件推入聊天流
    r.register(createExitPlanModeTool(planState, config.eventSink));

    // 3. Plan 模式：过滤为只读，但允许 plan 文件写入
    const effR =
      config.collaborationMode === 'plan' ? planRegistry(r, planState) : r;

    // 4. 创建 Agent 实例
    const execState = config.execState ?? createExecState();
    const newAgent = new Agent(config.provider, effR, sysPrompt, {
      agentId,
      parentId: config.parentId ?? null,
      eventSink: config.eventSink ?? (() => {}),
      execState,
      onSessionPersisted: config.onSessionPersisted,
      pricing: config.pricing,
      temperature: config.temperature ?? 0.7,
      contextWindow: config.contextWindow ?? 0,
      maxTokens: config.maxTokens ?? 0,
      ui: this._wrapNotifier(agentId),
      messageBus: this._bus,
      taskBoard: taskProxy as any as TaskBoard,
    });

    // 5. 接线隔离
    if (config.isolationId) {
      newAgent._isolationId = config.isolationId;
    }

    // 6. 接线压缩工具
    newAgent.setCompactionConfigPath(config.projectPath);

    // 7. 接线持久化
    if (config.agentStore) newAgent.setAgentStore(config.agentStore);
    if (config.goalManager) newAgent.setGoalManager(config.goalManager);
    if (config.subAgentPool) newAgent.setSubAgentPool(config.subAgentPool);

    // 7b. 接线消息总线 + 注册通信工具
    // setBus() 处理 bus.register() 及唤醒回调 — 无需重复调用
    newAgent.setBus(this._bus);
    // 接线 discovery board 用于 Agent 间知识共享（通过 proxy 实现会话隔离）
    newAgent.setDiscoveryBoard(discoveryProxy as any);
    // 注册通信工具 — plan 模式仅获得只读工具（agent_inbox / agent_list）
    for (const tool of createCommunicationTools(this._bus, () => newAgent.id)) {
      if (config.collaborationMode === 'plan' && !tool.readOnly()) continue;
      effR.register(tool);
    }

    // 注册 discovery 工具 — plan 模式：仅只读 agent_lookup
    for (const tool of createDiscoveryTools(discoveryProxy as any, () => newAgent.id)) {
      if (config.collaborationMode === 'plan' && !tool.readOnly()) continue;
      effR.register(tool);
    }

    // isolationExec — 用于 agent_isolation_discard / agent_isolation_merge
    // 被 agent_merge 工具和 LifecycleManager 共用
    const isolationExec = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = await agentInvoke<string>(name, args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    };

    // 注册 agent_merge 工具 — 允许父 Agent 合并已完成的异步子 Agent worktree
    if (config.collaborationMode !== 'plan' && config.subAgentPool) {
      effR.register(createMergeTool(taskProxy as any, () => newAgent.id, isolationExec));
      effR.register(createAgentKillTool(config.subAgentPool, isolationExec));
    }

    // 注册 agent_request 工具 — 带超时的同步请求
    if (config.collaborationMode !== 'plan') {
      effR.register(createRequestTool(this._bus, () => newAgent.id));
    }

    // 7c. 接线 LifecycleManager — 全局空闲判定 + 泄漏检测 + worktree TTL 清理
    if (config.subAgentPool) {
      // 停止此 agentId 的前一个 LifecycleManager — 否则其 60s setInterval
      // 会在会话创建/恢复周期中泄漏并堆积。
      this._lifecycleManagers.get(agentId)?.stop();

      const rawSink = config.eventSink ?? (() => {});
      const wrappedSink: EventSink = (ev) => {
        rawSink(ev);
        // 将 Notice 事件转发给通知器以驱动面板
        if (ev.kind === EventKind.Notice) {
          this.notifier?.onLifecycleAlert?.(agentId, ev.level ?? 'info', ev.text ?? '');
        }
      };
      const lifecycle = new AgentLifecycleManager(
        config.subAgentPool,
        taskProxy as any,
        this._bus,
        isolationExec,
        wrappedSink,
      );
      lifecycle.start();
      this._lifecycleManagers.set(agentId, lifecycle);

      // 接线子 Agent 完成 → 归档 discoveries（会话级）
      if (!config.parentId) {
        config.subAgentPool.onFinish = (subId: string) => {
          discoveryProxy.archive(subId);
        };
      }
    }

    // 8. 在 Agent 的有效注册表上注册压缩工具
    registerCompactionTools(newAgent, effR);

    // 9. 接线 hooks（图上下文 + 状态 + board 追踪 + plan）
    const hooks = new HookRegistry();
    const preflightHooks = new PreflightHookRegistry();
    if (config.graphContext) {
      loadEngineSnapshot(config.graphContext, config.projectPath).catch(() => {});
      hooks.register(createGraphContextHook(config.graphContext));
      if (this._diagSource) {
        hooks.register(createStateReadHook(config.projectPath, this._diagSource));
      }
      preflightHooks.register(createGraphPreflightHook(config.graphContext));
      if (this._diagSource) {
        preflightHooks.register(createStatePreflightHook(this._diagSource));
      }
      // Plan 模式图增强 hook — 探索时注入影响面，写计划时追加分析
      hooks.register(createPlanExploreHook(config.graphContext, planState));
      hooks.register(createPlanWriteHook(config.graphContext, planState));
    }
    // Board 追踪 hook — board 可用时始终注册
    hooks.register(createBoardTrackingHook(agentId, taskProxy as any));
    newAgent.setHooks(hooks);
    newAgent.setPreflightHooks(preflightHooks);

    // 9b. 接线 plan 模式 — runLoop 提醒注入器 + 状态通知
    const planInjector = new PlanModeInjector();
    newAgent.setPlanState(planState, planInjector);
    planState.onChange((s) => {
      this.notifier?.onPlanModeChange?.(agentId, s.active, s.planFilePath);
    });

    // 10. 接线 pre-run hook（AuraSDK 语义检索）
    if (config.preRunHook) {
      newAgent.setPreRunHook(config.preRunHook);
    }

    // 11. 自动调优
    newAgent.applyAutoTuneConfig().catch(() => {});

    // 12. 注册并返回
    const handle = new AgentHandleImpl(newAgent, this);
    this.agents.set(agentId, handle);
    log.info('runtime', `agent created: ${agentId}`);

    return handle;
  }

  getAgent(id: string): AgentHandle | null {
    return this.agents.get(id) ?? null;
  }

  destroyAgent(id: string): void {
    const handle = this.agents.get(id);
    if (!handle) return;
    // 获取此 Agent 的会话级 board
    const sessionId = this._agentSessions.get(id) ?? 'default';
    const taskBoard = this._taskBoards.get(sessionId);
    const discoveryBoard = this._discoveryBoards.get(sessionId);
    // Flush 持久化 — 在清理前落盘
    this._bus.clearFlushTimer();
    taskBoard?.clearFlushTimer();
    discoveryBoard?.clearFlushTimer();
    void this._bus.flush();
    void taskBoard?.flush();
    void discoveryBoard?.flush();
    handle
      ._getAgent()
      .saveState('done')
      .catch(() => {});
    // 停止 LifecycleManager 巡检定时器
    this._lifecycleManagers.get(id)?.stop();
    this._lifecycleManagers.delete(id);
    this._bus.unregister(id);
    taskBoard?.unregister(id);
    this._agentSessions.delete(id);
    this.agents.delete(id);
    log.info('runtime', `agent destroyed: ${id}`);
  }

  listAgents(): AgentSummary[] {
    return Array.from(this.agents.values()).map((h) => ({
      id: h.id,
      parentId: h.parentId,
      status: h.status,
      description: h.id === 'main' ? '主Agent' : `Agent (${h.id})`,
      subagentDepth: 0, // TODO: 从 Agent 暴露
    }));
  }

  /** E6: 同步刷新所有会话级 board（best-effort）。
   *  在 beforeunload 时调用以防止标签页/窗口关闭时数据丢失。
   *  清除防抖定时器（同步）并触发 flush()（异步，可能未完成）。 */
  /** 刷新所有会话级 board + 消息总线。等待每个 flush 完成以确保
   *  主清理路径（deactivate）上的调用方在销毁 runtime 前数据已持久化。
   *  使用 allSettled 以防一个 board 失败阻塞其他 board。 */
  async flushAllBoards(): Promise<void> {
    const flushes: Promise<unknown>[] = [];
    for (const board of this._taskBoards.values()) {
      board.clearFlushTimer();
      flushes.push(board.flush());
    }
    for (const board of this._discoveryBoards.values()) {
      board.clearFlushTimer();
      flushes.push(board.flush());
    }
    this._bus.clearFlushTimer();
    flushes.push(this._bus.flush());
    await Promise.allSettled(flushes);
  }

  // ── 私有：将 RuntimeNotifier 包装为 AgentUINotifier ──

  private _wrapNotifier(agentId: string): AgentUINotifier {
    return {
      progress: (step: number, toolName: string) => {
        this.notifier?.onProgress(agentId, step, toolName);
      },
      toolDone: (toolName: string, args: Record<string, unknown>, output: string) => {
        this.notifier?.onToolDone(agentId, toolName, args, output);
      },
      subAgentSpawn: (info, onProgress) => {
        return this.notifier?.onSubAgentSpawn({
          agentId: info.agentId,
          parentAgentId: agentId,
          description: info.description,
          sessionId: info.sessionId,
          onProgress,
        });
      },
            subAgentFinished: (id, sessionId, ok) => {
        this.notifier?.onSubAgentFinished(id, agentId, sessionId, ok);
      },
      onStatusChange: (running: boolean) => {
        this.notifier?.onAgentStatus(agentId, running ? 'running' : 'idle');
      },
      sessionReplaced: (messages: Message[]) => {
        this.notifier?.onSessionReplaced(agentId, messages);
      },
    };
  }

  // ── 私有：诊断数据源 ──
  // 由 setDiagnosticsSource() 注入 — agent-builder 无法 import ui/lsp-client
  private _diagSource: DiagnosticsSource | null = null;

  setDiagnosticsSource(fn: DiagnosticsSource): void {
    this._diagSource = fn;
  }

  private _getDiagnosticsSource(): DiagnosticsSource | null {
    return this._diagSource;
  }
}