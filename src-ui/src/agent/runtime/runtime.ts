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

import { typedRpc } from '../../rpc-contract';
import type { Message, Provider } from '../../provider/types';
import type { StoredThinking } from '../../provider/thinking';
import type { Pricing } from '../agent-types';
import { Agent } from '../agent';
import type { AgentStore } from '../agent-store';
import type { AgentEvent, AgentUINotifier, EventSink } from '../agent-types';
import { EventKind } from '../agent-types';
import { AgentBlueprint, type BlueprintScope } from '../blueprint';
import type { Context } from '../../cordis';
import type { SubAgentPool } from '../coordinator';
import { createExecState, type ExecStateInstance } from '../execution-state';
import type { GoalManager } from '../goal-manager';
import type { GraphContext } from '../hooks';
import { buildGraphSnapshot, HookRegistry, PreflightHookRegistry } from '../hooks';
import { log } from '../logger';
import type { MemoryManager } from '../memory';
import { memoryBundleIngest } from '../memory-bundle-client';
import { MessageBus } from '../message-bus';
import { JsonMessageStore } from '../message-store';
import { TaskBoard, TaskBoardProxy } from '../task-board';
import { DiscoveryBoard, DiscoveryBoardProxy } from '../discovery-board';
import type { SkillRegistry } from '../skills';
import type { DiagnosticsSource, LspDiagnostic } from '../state-inject';
import type { TaskManager } from '../task';
import { ToolRegistry, agentInvoke } from '../tool';
import { AgentLifecycleManager } from '../lifecycle-manager';
import { enqueueIsolationOp } from '../isolation-queue';
import type { SubAgentSpawner } from '../tools/subagent';
import {
  type BuilderDeps,
  buildGraphContextFromData,
  buildSystemPrompt,
  buildToolRegistry,
  extractGraphNodeNames,
} from './agent-builder';
import { PlanStateManager } from '../plan/plan-state';
import { AgentContext } from '../context';
import { SessionLog } from '../session-log';

import type {
  AgentAssemblyInputs,
  AgentConfig,
  AgentHandle,
  AgentStatus,
  AgentSummary,
  RuntimeNotifier,
  RuntimePort,
} from './types';

// ── AgentHandleImpl ──

class AgentHandleImpl implements AgentHandle {
  constructor(
    private readonly _agent: Agent,
    private readonly _runtime: AgentRuntime,
    private readonly _ctx: AgentContext | null = null,
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
  setThinking(cfg: StoredThinking | undefined) {
    return this._agent.setThinking(cfg);
  }
  setProvider(prov: Provider, pricing?: Pricing) {
    return this._agent.setProvider(prov, pricing);
  }
  setContextWindow(n: number) {
    return this._agent.setContextWindow(n);
  }

  /** 绑定到指定会话的 board — 会话 id 在创建后才分配，由会话层在登记句柄时调用 */
  bindSession(sessionId: string): void {
    this._runtime._bindAgentSession(this._agent.id, sessionId);
  }

  /** 销毁此 Agent — 句柄即所有权，幂等（重复调用为 no-op） */
  dispose(): void {
    this._runtime._disposeAgent(this._agent.id);
  }

  /** 直接访问底层 Agent — 仅供内部使用 */
  _getAgent(): Agent {
    return this._agent;
  }

  /** 直接访问装配 context — 仅供内部使用（_disposeAgent / 收敛测试） */
  _getContext(): AgentContext | null {
    return this._ctx;
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
  /** 每个 Agent 的 board proxies — bindSession 时重定向到其会话的 board */
  private _agentProxies = new Map<string, { task: TaskBoardProxy; discovery: DiscoveryBoardProxy }>();
  /** 已 restore 的会话集合 — 避免重复 restore */
  private _restoredSessions = new Set<string>();
  /** 项目路径 — 用于持久化 */
  private _projectPath: string;
  /** LifecycleManager 实例 — 每个 agent 一个，持有 pool/board/bus/exec/sink 引用 */
  private _lifecycleManagers = new Map<string, AgentLifecycleManager>();
  /** 启动恢复 promise — createAgent 前必须 await ready() */
  private _readyPromise: Promise<void>;
  /** agentId → sessionId 映射 — _disposeAgent 时知道清理哪个会话的 board */
  private _agentSessions = new Map<string, string>();
  /** agentId → 该 Agent 实例专属的待办 TaskManager（每会话主 Agent 一个实例） */
  private _agentTaskManagers = new Map<string, TaskManager>();
  /** cordis 挂载父 ctx（cordis-migration P2）— AgentContext 身份 fiber 的挂载点。 */
  private _cordisParent?: Context;

  constructor(projectPath?: string, cordisParent?: Context) {
    this._projectPath = projectPath ?? '';
    // cordis-migration P2：Agent fiber 的挂载父（workspace 接线传工作区 fiber ctx）。
    // 缺省（单测/无内核）→ AgentContext 不建 fiber，行为零变化。
    this._cordisParent = cordisParent;
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

  /** 切换当前活跃会话 — 仅触发该会话 board 的懒加载恢复（供面板查询）。
   *  不改写任何 Agent 的 board 绑定 — proxies 由 bindSession 静态绑定。 */
  setCurrentSession(sessionId: string): void {
    const tb = this._getOrCreateTaskBoard(sessionId);
    const db = this._getOrCreateDiscoveryBoard(sessionId);
    // 尚未恢复的会话进行懒加载恢复
    if (!this._restoredSessions.has(sessionId)) {
      this._restoredSessions.add(sessionId);
      void tb.restore();
      void db.restore();
    }
  }

  /** 将 Agent 的 board proxies 绑定到指定会话 — 仅供内部使用（AgentHandle.bindSession）。
   *  聊天会话的数字 id 在 createAgent 之后才分配，会话层在登记句柄时调用完成
   *  静态绑定；此后该 Agent 的 board 写入终生落在此会话的板上，不再随会话切换改变。 */
  _bindAgentSession(agentId: string, sessionId: string): void {
    const proxies = this._agentProxies.get(agentId);
    if (!proxies) return;
    const tb = this._getOrCreateTaskBoard(sessionId);
    const db = this._getOrCreateDiscoveryBoard(sessionId);
    // 尚未恢复的会话进行懒加载恢复（与 setCurrentSession 同一语义）
    if (!this._restoredSessions.has(sessionId)) {
      this._restoredSessions.add(sessionId);
      void tb.restore();
      void db.restore();
    }
    proxies.task.setTarget(tb);
    proxies.discovery.setTarget(db);
    // 更新会话映射 — 子 Agent 经 _agentSessions.get(parentId) 继承正确会话，
    // _disposeAgent 据此清理正确会话的 board
    this._agentSessions.set(agentId, sessionId);
    // 重启收养：根 Agent 绑定会话板后，认领上次进程遗留的条目与 worktree
    // （子 Agent 完成时父已退出 → 旧父 id 死账；Rust isolation 注册表内存态
    // → 磁盘 worktree 死账。两侧都收养后 agent_merge 恢复可用。）
    const handle = this.agents.get(agentId);
    if (handle && handle.parentId === null) {
      void tb.restore().then(() => this._adoptRestartOrphans(agentId, tb));
    }
  }

  /** 重启收养：重挂旧父 id 条目 + 注册磁盘孤儿 worktree（best-effort，不阻塞会话）。
   *  Rust 侧已在 workspace_activate 重建 isolation 注册表，这里把状态接回
   *  TaskBoard 使 agent_board / agent_merge 恢复可见可用。 */
  private async _adoptRestartOrphans(rootAgentId: string, tb: TaskBoard): Promise<void> {
    try {
      let adopted = 0;
      // 1. 旧父 id 条目重挂（父进程已消亡，条目还挂在死 id 上）
      const liveIds = new Set(this.agents.keys());
      for (const entry of tb.getAllEntries()) {
        if (entry.parentAgentId === rootAgentId || liveIds.has(entry.parentAgentId)) continue;
        tb.reparent(entry.agentId, rootAgentId);
        adopted++;
      }
      // 2. 磁盘孤儿 worktree（Rust 已收养、board 无记录）→ 注册为可合并条目
      const statusText = await agentInvoke<string>('agent_isolation_status', {});
      const status = JSON.parse(statusText) as {
        isolations?: Array<{ agent_id: string; worktree_exists: boolean }>;
      };
      const known = new Set(
        tb.getAllEntries().map((e) => e.isolationId).filter((v): v is string => !!v),
      );
      for (const iso of status.isolations ?? []) {
        if (!iso.worktree_exists || known.has(iso.agent_id)) continue;
        tb.register({
          agentId: iso.agent_id,
          parentAgentId: rootAgentId,
          description: '重启前遗留的子 Agent worktree（启动收养，可直接 agent_merge 或丢弃）',
          isolationId: iso.agent_id,
        });
        tb.complete(
          iso.agent_id,
          '重启收养的孤儿 worktree — 变更未经本轮验证，合并前请先 agent_isolation_diff 审阅',
          '',
        );
        adopted++;
      }
      if (adopted > 0) {
        console.warn(`[AgentRuntime] 收养 ${adopted} 个重启前遗留的子 Agent 条目到 ${rootAgentId}`);
        // 通知模型上下文（bus），不只发 console — 收养结果必须可见
        try {
          this._bus.send({
            from: 'system',
            to: rootAgentId,
            type: 'status',
            payload: `已收养 ${adopted} 个重启前遗留的子 Agent 条目（agent_board 可见；completed 条目可直接 agent_merge）`,
          });
        } catch {
          /* best-effort */
        }
      }
    } catch {
      // best-effort — 收养失败不阻塞会话启动
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

      // 4. 孤儿检测：status === 'running' 的条目是崩溃时还在跑的子 agent。
      //    进程已死 → 标记 stopped；worktree 不销毁 — 先抓 diff 保全到 board
      //    （TTL 清理纪律：不销毁无记录的工作），抓不到则保留现场。
      const orphans = defaultTB.getAllEntries().filter((e) => e.status === 'running');
      for (const orphan of orphans) {
        defaultTB.stop(orphan.agentId);
        if (orphan.isolationId) {
          try {
            await enqueueIsolationOp(async () => {
              const diffText = await agentInvoke<string>('agent_isolation_diff', { agent_id: orphan.isolationId! }).catch(() => '');
              if (diffText) {
                try {
                  const parsed = JSON.parse(diffText) as { has_changes?: boolean; diff?: string };
                  // 只保全可解析的 diff 文本；不可解析的回包不入 board（保留现场即可）
                  if (parsed.has_changes && parsed.diff) defaultTB.attachDiff(orphan.agentId, parsed.diff);
                } catch {
                  /* diff 抓取失败 — worktree 保留现场，不写垃圾进 board */
                }
              }
            });
          } catch {
            /* best-effort — Rust 注册表可能尚未收养（workspace_activate 顺序），保留现场即可 */
          }
        }
        console.warn(`[AgentRuntime] 检测到孤儿 agent: ${orphan.agentId}, 已标记 stopped（worktree 保留，diff 已尽力保全）`);
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
      const raw = await typedRpc('read_file_content', { file_path: oldDiscPath });
      const arr = JSON.parse(raw.replace(/^\s*\d+\t/gm, ''));
      if (Array.isArray(arr) && arr.length > 0) {
        const db = this._getOrCreateDiscoveryBoard('default');
        for (const e of arr) {
          db.post(e.agentId, e.key, e.value, e.category);
        }
        await db.flush();
      }
      // 迁移后删除旧文件
      await typedRpc('delete_file_or_dir', { path: oldDiscPath }).catch(() => {});
    } catch {
      /* 文件不存在 — 无需迁移 */
    }
    // 迁移全局 taskboard.json
    const oldTaskPath = `${base}/.hologram/taskboard.json`;
    try {
      const raw = await typedRpc('read_file_content', { file_path: oldTaskPath });
      const arr = JSON.parse(raw.replace(/^\s*\d+\t/gm, ''));
      if (Array.isArray(arr) && arr.length > 0) {
        const tb = this._getOrCreateTaskBoard('default');
        // 直接将迁移的条目写入新路径
        await typedRpc('write_file_content', {
          file_path: `${base}/.hologram/taskboard/default.json`,
          content: JSON.stringify(arr, null, 2),
        });
      }
      // 迁移后删除旧文件
      await typedRpc('delete_file_or_dir', { path: oldTaskPath }).catch(() => {});
    } catch {
      /* 文件不存在 — 无需迁移 */
    }
  }

  /** 创建 Agent — 接收完整配置，Runtime 不做 UI 依赖的事。
   *  Phase 3 起（agent-core-convergence）：本方法是 AgentConfig → AgentContext
   *  的翻译层 + 装配委托；装配本体 _assembleAgent 只消费 ctx + inputs，
   *  不再接触 AgentConfig（specs/phase-3 T0 结构门禁钉住）。 */
  async createAgent(config: AgentConfig): Promise<AgentHandle> {
    const { ctx, inputs } = this._contextFromConfig(config);
    return this._assembleAgent(ctx, inputs);
  }

  /** 从 AgentContext 创建 Agent — Phase 3 收敛入口（RuntimePort 契约见 types.ts）。
   *  Phase 6：第 3 参 blueprint 允许调用方以声明式 capability 扩展装配面 —
   *  新增工具/hook 不再要求修改 AgentConfig。缺省 AgentBlueprint.standard()。 */
  async createAgentFromContext(
    ctx: AgentContext,
    inputs: AgentAssemblyInputs = {},
    blueprint?: AgentBlueprint,
  ): Promise<AgentHandle> {
    return this._assembleAgent(ctx, inputs, blueprint);
  }

  /** AgentConfig → AgentContext 翻译层 — 身份与调用方供给的服务进 ctx，
   *  非服务装配输入进 inputs。这是 createAgent 路径唯一消费 AgentConfig 的地方。 */
  private _contextFromConfig(config: AgentConfig): { ctx: AgentContext; inputs: AgentAssemblyInputs } {
    // Plan 状态在翻译层创建（collaborationMode 是 config 侧概念，不进 ctx 契约）
    const planState = new PlanStateManager();
    if (config.collaborationMode === 'plan') {
      planState.enter(config.projectPath);
    }
    const ctx = new AgentContext(
      {
        agentId: config.agentId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        parentId: config.parentId ?? null,
        subagentDepth: config.subagentDepth ?? 0,
        isolationId: config.isolationId,
        projectPath: config.projectPath,
        sessionId: config.sessionId,
        cordisParent: this._cordisParent,
      },
      {
        provider: config.provider,
        tools: config.tools,
        eventSink: config.eventSink,
        memoryManager: config.memoryManager,
        agentStore: config.agentStore,
        goalManager: config.goalManager,
        subAgentPool: config.subAgentPool,
        execState: config.execState,
        messageBus: this._bus,
        planState,
      },
    );
    const inputs: AgentAssemblyInputs = {
      systemPrompt: config.systemPrompt,
      graphData: config.graphData,
      graphContext: config.graphContext,
      hooksEnabled: config.hooksEnabled,
      subAgentSpawner: config.subAgentSpawner,
      temperature: config.temperature,
      contextWindow: config.contextWindow,
      pricing: config.pricing,
      toolResultWindow: config.toolResultWindow,
      onSessionPersisted: config.onSessionPersisted,
      preRunHook: config.preRunHook,
    };
    return { ctx, inputs };
  }

  /** 物化会话级基础设施服务（board proxies / planState / execState）并写回 ctx。
   *  ctx 入口允许调用方自带（差分 / 子 Agent 派生）；缺什么补什么，幂等。 */
  private _materializeSessionServices(ctx: AgentContext): void {
    // 会话级 board — 按 sessionId 隔离，子 Agent 继承父会话
    // 有 parentId 的子 Agent 继承父会话 ID；否则使用 ctx.sessionId 或 'default'
    // （会话主 Agent 的数字 id 创建后才分配，由会话层随后调 bindSession 重绑）
    if (!ctx.get('taskBoard') || !ctx.get('discoveryBoard')) {
      const sessionId =
        ctx.sessionId ?? (ctx.parentId ? this._agentSessions.get(ctx.parentId) : undefined) ?? 'default';
      const taskBoard = this._getOrCreateTaskBoard(sessionId);
      const discoveryBoard = this._getOrCreateDiscoveryBoard(sessionId);
      // Proxy 静态绑定到该 Agent 所属会话的 board — 句柄即所有权，
      // 一个 Agent 终生只属于一个会话，不再随会话切换动态重定向。
      const taskProxy = new TaskBoardProxy(taskBoard);
      const discoveryProxy = new DiscoveryBoardProxy(discoveryBoard);
      this._agentProxies.set(ctx.agentId, { task: taskProxy, discovery: discoveryProxy });
      this._agentSessions.set(ctx.agentId, sessionId);
      ctx.set('taskBoard', taskProxy as unknown as TaskBoard);
      ctx.set('discoveryBoard', discoveryProxy as unknown as DiscoveryBoard);
    }
    if (!ctx.get('planState')) ctx.set('planState', new PlanStateManager());
    if (!ctx.get('execState')) ctx.set('execState', createExecState());
    // Phase 5：会话事件溯源日志 — 每 Agent 独立物化（Agent 构造从 ctx 读取并双写）
    if (!ctx.get('sessionLog')) ctx.set('sessionLog', new SessionLog());
  }

  /** 装配本体 — 只消费 AgentContext + AgentAssemblyInputs + AgentBlueprint（config-free）。
   *  Phase 6：工具/hook/接线由 blueprint capability 表驱动（表序 = 注册序，
   *  与 Phase 5 前的手写注册序一一对应；phase-1 effective 快照钉字节）。
   *  runtime 保留三块生命周期所有权：board-unregister / lifecycle-manager /
   *  runtime-maps 的 ctx.effect（Phase 4 语义，specs/phase-4 T0 钉住 ≥3 处）。 */
  private async _assembleAgent(
    ctx: AgentContext,
    inputs: AgentAssemblyInputs,
    blueprint: AgentBlueprint = AgentBlueprint.standard(),
  ): Promise<AgentHandle> {
    this._materializeSessionServices(ctx);
    const agentId = ctx.agentId;
    const taskProxy = ctx.resolve('taskBoard');
    const discoveryProxy = ctx.resolve('discoveryBoard');

    // Phase 4：TaskBoard 条目注销的对称清理归 ctx 所有权（proxy 转发到该 Agent
    // 终生绑定的会话板）。discoveryBoard 维持现状——旧 dispose 路径本就不注销它。
    ctx.effect(() => () => taskProxy.unregister(agentId), 'board-unregister');

    // 1. 构建 system prompt（如果没预构建）
    let sysPrompt = inputs.systemPrompt;
    if (!sysPrompt) {
      let memSection = '';
      const memoryManager = ctx.get('memoryManager');
      if (memoryManager) {
        try {
          memSection = await memoryManager.loadPromptSection(
            inputs.graphData ? extractGraphNodeNames(inputs.graphData) : undefined,
          );
        } catch {}
      }
      let claudeMd = '';
      try {
        claudeMd = await typedRpc('read_file_content', { file_path: `${ctx.projectPath}/CLAUDE.md` });
      } catch {}
      const snap = inputs.graphData ? buildGraphSnapshot(inputs.graphData) : '';

      // 运行环境块 — 探测当前 shell（bash/cmd），注入 system prompt。
      // Agent 第一轮就知道命令跑在哪个解释器上，避免"猜语法"反复踩坑。
      let shellEnvSection = '';
      try {
        const raw = await typedRpc('shell_env', {});
        const env = raw ? JSON.parse(raw) : null;
        if (env && typeof env === 'object' && env.shell) {
          if (env.shell === 'bash') {
            shellEnvSection =
              `- OS: ${env.os ?? 'unknown'}${env.os === 'windows' ? ' (Windows 环境)' : ''}\n` +
              `- Shell: bash (Git Bash)\n` +
              `- 所有命令跑在 bash 上，用 Unix 语法：用 /dev/null 而不是 NUL、路径用正斜杠、用 ls 而不是 dir、变量用 $var`;
          } else {
            shellEnvSection =
              `- OS: ${env.os ?? 'unknown'}\n` +
              `- Shell: ${env.shell}\n` +
              `- 命令跑在 ${env.shell} 上，用对应语法（bash 用 $var，cmd 用 %var%）`;
          }
          if (env.notes) shellEnvSection += `\n- 提示: ${env.notes}`;
        }
      } catch {}

      sysPrompt = buildSystemPrompt(
        inputs.graphData,
        ctx.projectPath,
        memSection,
        snap,
        claudeMd,
        ctx.resolve('provider').name(),
        shellEnvSection,
      );
    }

    // 2. 克隆工具注册表（每个 Agent 获得自己的副本）— 克隆件写回 ctx.tools，
    //    Agent 构造（ctx 路径）与后续注册都落在这份有效注册表上；
    //    输入注册表保持干净，调用方可继续复用（与 Phase 3 前语义一致）。
    const r = new ToolRegistry();
    for (const t of ctx.resolve('tools').all()) r.register(t);
    ctx.set('tools', r);

    // 2b. isolationExec — agent_isolation_* 的 invoke 包装，被 merge/kill 工具与
    //     LifecycleManager 共用；Phase 6 经 BlueprintDeps 注入 capability。
    const isolationExec = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = await agentInvoke<string>(name, args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    };

    // 3. Phase 6 声明式装配 — capability 表驱动。context 阶段（Agent 构造前，
    //    可写 ctx 服务）→ 构造 → agent 阶段（表序即工具面注册序）。
    const scope: BlueprintScope = {
      ctx,
      inputs,
      tools: r,
      hooks: new HookRegistry(),
      preflightHooks: new PreflightHookRegistry(),
      deps: {
        isolationExec,
        messageBus: this._bus,
        diagnosticsSource: this._diagSource ?? undefined,
        onPlanModeChange: (active, planFilePath) => {
          this.notifier?.onPlanModeChange?.(agentId, active, planFilePath);
        },
        registerTaskManager: (tm) => {
          this._agentTaskManagers.set(agentId, tm);
        },
      },
    };
    for (const cap of blueprint.capabilities('context')) {
      if (cap.when?.(scope) ?? true) cap.install(scope);
    }

    // 4. 创建 Agent 实例（Phase 3：ctx 入口 — 身份/服务/总线/boards 从 ctx 读；
    //    隔离 ID、bus 注册、store/goalManager/pool 接线在构造内完成，
    //    旧路径这些接线与构造之间无 await，时序等价）
    const newAgent = new Agent(ctx, sysPrompt, {
      onSessionPersisted: inputs.onSessionPersisted,
      pricing: inputs.pricing,
      temperature: inputs.temperature ?? 0.7,
      contextWindow: inputs.contextWindow ?? 0,
      toolResultWindow: inputs.toolResultWindow,
      ui: this._wrapNotifier(agentId),
    });

    // 5. agent 阶段 capability — 注册序 = 表序（通信/discovery/merge/request/
    //    spawn/task/compaction/converge + hooks + plan 接线 + pre-run + 自动调优）。
    const agentScope: BlueprintScope = { ...scope, agent: newAgent };
    for (const cap of blueprint.capabilities('agent')) {
      if (cap.when?.(agentScope) ?? true) cap.install(agentScope);
    }
    // hooks 统一接线 — capability 只往共享 registries 注册（setHooks 是整体替换语义）
    newAgent.setHooks(scope.hooks);
    newAgent.setPreflightHooks(scope.preflightHooks);

    // 6. 接线 LifecycleManager — 全局空闲判定 + 泄漏检测 + worktree TTL 清理
    //    （生命周期所有权留 runtime，不进 capability — Phase 4 语义）
    const subPool = ctx.get('subAgentPool');
    if (subPool) {
      // 停止此 agentId 的前一个 LifecycleManager — 否则其 60s setInterval
      // 会在会话创建/恢复周期中泄漏并堆积。
      this._lifecycleManagers.get(agentId)?.stop();

      const rawSink = ctx.get('eventSink') ?? (() => {});
      const wrappedSink: EventSink = (ev) => {
        rawSink(ev);
        // 将 Notice 事件转发给通知器以驱动面板
        if (ev.kind === EventKind.Notice) {
          this.notifier?.onLifecycleAlert?.(agentId, ev.level ?? 'info', ev.text ?? '');
        }
      };
      const lifecycle = new AgentLifecycleManager(
        subPool,
        taskProxy as any,
        this._bus,
        isolationExec,
        wrappedSink,
      );
      // Phase 4：巡检 timer（60s setInterval）所有权归 ctx —— startOwned 返回
      // 幂等清理器，_disposeAgent 经 ctx.dispose() 释放，不再分散 stop。
      this._lifecycleManagers.set(agentId, lifecycle);
      ctx.effect(
        () => {
          const stopOwned = lifecycle.startOwned();
          return () => {
            stopOwned();
            this._lifecycleManagers.delete(agentId);
          };
        },
        'lifecycle-manager',
      );

      // 接线子 Agent 完成 → 归档 discoveries（会话级）
      if (!ctx.parentId) {
        subPool.onFinish = (subId: string) => {
          discoveryProxy.archive(subId);
        };
      }
    }

    // 7. 注册并返回。runtime 注册表（agents/proxies/sessions/taskManagers）
    // 的清理同样归 ctx 所有权——最后注册 → dispose 时最先释放，保证
    // listAgents 在 dispose() 返回后同步可见移除（同步快通道）。
    const handle = new AgentHandleImpl(newAgent, this, ctx);
    this.agents.set(agentId, handle);
    ctx.effect(
      () => () => {
        this._agentProxies.delete(agentId);
        this._agentSessions.delete(agentId);
        this._agentTaskManagers.delete(agentId);
        this.agents.delete(agentId);
      },
      'runtime-maps',
    );
    log.info('runtime', `agent created: ${agentId}`);

    return handle;
  }

  getAgent(id: string): AgentHandle | null {
    return this.agents.get(id) ?? null;
  }

  /** 返回某 Agent 实例专属的待办 TaskManager（每会话主 Agent 一个实例）。
   *  UI 的 TasksPanel 用它订阅 / 读写当前会话主 Agent 的待办清单。 */
  getAgentTaskManager(agentId: string): TaskManager | null {
    return this._agentTaskManagers.get(agentId) ?? null;
  }

  /** 销毁单个 Agent — 仅供内部使用（AgentHandle.dispose / disposeAll）。
   *  外部代码必须经句柄销毁，不提供按 id 的公开入口。幂等。
   *  Phase 4：顺序铁律保持不变 —— bus/board flush → saveState('done') →
   *  context 逆序 effects（runtime maps 注销 → lifecycle timer → board/bus
   *  条目注销）。effects 全 sync 链经 DisposerBag 同步快通道在返回前完成，
   *  listAgents / bus 注册状态调用后立即可观测；聚合错误经 log.warn 可观测。 */
  _disposeAgent(id: string): void {
    const handle = this.agents.get(id);
    if (!handle) return;
    // 获取此 Agent 的会话级 board（effects 释放 maps 前完成查找）
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
    // 分散清理已统一归 ctx 所有权（装配期 effect 登记），此处只释放 context
    handle
      ._getContext()
      ?.dispose()
      .catch((err) => log.warn('runtime', `agent ${id} context 清理部分失败: ${String(err)}`));
    log.info('runtime', `agent destroyed: ${id}`);
  }

  /** 销毁所有 Agent — Workspace 整体停用时调用 */
  disposeAll(): void {
    for (const id of [...this.agents.keys()]) {
      this._disposeAgent(id);
    }
  }

  listAgents(): AgentSummary[] {
    return Array.from(this.agents.values()).map((h) => ({
      id: h.id,
      parentId: h.parentId,
      status: h.status,
      // 会话主 Agent 的 id 是 main-<ts>-<rand>（不再硬编码 'main'），按 parentId 判定
      description: h.parentId === null ? '主Agent' : `Agent (${h.id})`,
      subagentDepth: h._getAgent().subagentDepth,
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
