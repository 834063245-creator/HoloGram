// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 循环 — Run() → stream() → StreamingToolExecutor → 循环直到模型给出最终答案

import { rpc } from '../bridge';
import { z } from 'zod';
import type { Message, Provider, ToolCall, Usage } from '../provider/types';
import { ChunkType } from '../provider/types';
import type { AgentRecord, AgentStore } from './agent-store';
// 共享类型 — 本文件内部也使用
import {
  type AgentEvent,
  type AgentUINotifier,
  computeCost,
  EventKind,
  type EventSink,
  type Pricing,
  type ToolEvent,
} from './agent-types';
import {
  type CompactionConfig,
  type CompactionEvent,
  type CompactionSessionStats,
  CompactionTracker,
  maybeTune,
} from './compaction-model';
import { countMessage, countMessages, countText, countTexts, countToolSchemas } from './token-counter';
import { type ExecStateInstance, createExecState, execState } from './execution-state';
import { createProvider } from '../provider';
import { getAllModels } from '../provider/catalog';
import { STREAM_IDLE_TIMEOUT_MS, streamWithIdleTimeout } from '../provider/idle-stream';
import { loadSettingsWithSecrets } from '../settings';
import type { GoalManager, GoalRecord } from './goal-manager';
import { HookRegistry, type PreflightHookRegistry } from './hooks';
import { log } from './logger';
import { backoffDelay, isRetryable, MAX_RETRIES, sleepWithAbort } from './retry';
import { StreamingToolExecutor } from './streaming-executor';
import type { Tool } from './tool';
import { ToolRegistry } from './tool';
import { defineTool } from './tools/define-tool';

/** 用自定义 execute 函数包装一个 Tool，返回新的 Tool 对象。
 *  原始 Tool 永远不会被修改 — 这点至关重要，因为父 Agent
 *  与其子 Agent 共享 Tool 引用。 */
function wrapTool(original: Tool, execute: Tool['execute']): Tool {
  return {
    name: () => original.name(),
    description: () => original.description(),
    parameters: () => original.parameters(),
    readOnly: () => original.readOnly(),
    execute,
  };
}
import type { MessageBus } from './message-bus';
import type { TaskBoard } from './task-board';
import type { DiscoveryBoard } from './discovery-board';
import { createDiscoveryTools } from './tools/discovery';
import { createBoardTrackingHook } from './hooks/board-tracking-hook';
import { enqueueIsolationOp } from './isolation-queue';
import { FileOwnership, WRITE_TOOLS, extractFilePath } from './file-ownership';
import { removeSubAgentActivity, wrapSubAgentSink } from './subagent-activity';

export { type AgentEvent, computeCost, EventKind, type EventSink, type Pricing, type ToolEvent };

// ---- Agent 选项 ----

export interface AgentOptions {
  temperature?: number;
  pricing?: Pricing;
  /** 上下文窗口大小（token 数）。0 = 不压缩。 */
  contextWindow?: number;
  /** 触发压缩的 contextWindow 比例（默认: 0.7） */
  compactRatio?: number;
  /** 原文保留的最少近期消息数 */
  recentKeep?: number;
  /** 用于持久化的会话 ID。未提供则自动生成。 */
  sessionId?: string;
  /** 每次会话保存后调用（fire-and-forget，不阻塞循环）。 */
  onSessionPersisted?: (sessionId: string, messages: Message[]) => void;
  /** 子 Agent 嵌套深度（0 = 根，1 = 第一次 fork）。自动递增。 */
  subagentDepth?: number;
  /** 唯一 Agent 标识符。未提供则自动生成。 */
  agentId?: string;
  /** 派生此 Agent 的父 Agent ID。主 Agent 为 null。 */
  parentId?: string | null;
  /** 自定义事件 sink。设置后，Agent 事件发送到此处而非默认空操作。
   *  子 Agent 用它将输出捕获到 SubAgentPart。 */
  eventSink?: (ev: AgentEvent) => void;
  /** 执行状态实例。未提供则回退到全局 execState。 */
  execState?: ExecStateInstance;
  /** UI 通知端口 — 进度 / 工具完成 / 子 Agent 生命周期。
   *  由 workspace 注入；headless Agent 无。 */
  ui?: AgentUINotifier;
  /** 通信总线（可选 — 无则为 headless 无通信能力） */
  messageBus?: MessageBus;
  /** TaskBoard — 共享状态区，追踪异步子 Agent 的工作状态 */
  taskBoard?: TaskBoard;
  /** DiscoveryBoard — 共享发现区，Agent 间交换探索结果 */
  discoveryBoard?: DiscoveryBoard;
  // gate 已移除 — 权限由 Rust 后端 has_permission_to_use_tool() 处理
}

const STORM_BREAK_THRESHOLD = 3;

// ---- Agent ----

export class Agent {
  private prov: Provider;
  private tools: ToolRegistry;
  private session: Message[];
  private temperature: number;
  private pricing: Pricing | undefined;
  private _agentOpts: AgentOptions;

  // 上下文管理
  private contextWindow: number;
  private compactRatio: number;
  private recentKeep: number;
  // 真卡死闩锁 — 仅在"折叠后载荷仍 >95% 窗口"时置位（此时压缩确实
  // 无能为力，只有 /new 能解决）。瞬时失败不再使用它 — 见下方退避门控。
  private compactStuck = false;
  // 压缩退避门控: session 长度未涨到此值不重试。空区域（对话太短）和
  // 失败后都通过它延迟重试 — 增长足够后自动恢复，无永久闩锁。
  private compactRetryAfterLen = 0;
  // 连续失败计数 — 决定退避步长与是否升级用户告警
  private compactFailCount = 0;
  // 缓存的摘要模型选择（null = 未计算）— 运行时自动选出，无用户配置
  private _summaryProv: { prov: Provider; window: number } | null = null;

  // 子 Agent 深度追踪: 0 = 根，1 = 第一次 fork，2 = 孙 Agent，以此类推
  private _subagentDepth = 0;
  private static readonly MAX_SUBAGENT_DEPTH = 3;

  // Agent 身份 — 持久化用于生命周期追踪、会话恢复、谱系
  readonly id: string;
  readonly parentId: string | null;
  private agentStore: AgentStore | null = null;
  private goalManager: GoalManager | null = null;

  // 子 Agent 的隔离 ID — 注入到工具参数中，使 Rust 后端
  // 能通过 forward_map_path 解析 worktree 路径。
  _isolationId?: string;

  // Goal 循环安全: 强制终止前的硬上限（正常不应触发）
  private static readonly MAX_GOAL_ITERATIONS = 100;
  // 停滞检测: 连续无工具调用的轮次 → Agent 陷入分析瘫痪
  private static readonly MAX_STALL_ROUNDS = 3;

  // PreToolUse hooks — 用图上下文增强工具结果
  private hooks: HookRegistry | null = null;

  // Preflight hooks — 破坏性写入前告警（edit_file / write_file）
  private preflightHooks: PreflightHookRegistry | null = null;

  // Pre-run hook — 在每条用户消息推入会话前调用。
  // 返回可选的上下文文本，作为 <system-reminder> 注入到消息前。
  // 由 workspace 设置，用于每轮 AuraSDK 语义记忆检索。
  private _preRunHook: ((input: string) => Promise<string | null>) | null = null;

  // Storm breaker — 检测重复失败的工具调用
  private stormSig = '';
  private stormCount = 0;

  // 缓存累积
  private cacheHitTotal = 0;
  private cacheMissTotal = 0;

  // 事件 sink — 父 Agent 使用全局总线；子 Agent 使用自定义 sink
  private _sink: (ev: AgentEvent) => void;
  // UI 通知端口（workspace 注入；headless 时为空操作）
  private _ui: AgentUINotifier;

  /** UI 会话 ID — 由 ChatCore 在运行前设置，使子 Agent 通知
   *  能更新正确的会话存储（而非仅活跃的）。 */
  private _uiSessionId: number = 0;

  // 最近一次用量（用于状态显示）
  private lastUsage: Usage | undefined;

  // 执行状态 — 每个 Agent 实例独立（多窗口阶段 1）
  private _execState: ExecStateInstance;

  // 待插入的用户消息（工具执行期间排队，在安全边界应用）
  private _pendingInserts: string[] = [];

  // 待处理的记忆更新（从 memory:saved 事件排队，在安全边界应用）
  private _pendingMemoryUpdates: string[] = [];

  // 追踪本轮 runLoop 已注入的 inbox 消息 — 防止 LLM 不 ack/reply 时
  // 无限唤醒循环（消息留在 inbox，finally 块会不断重新触发 _onMessageDelivered）。
  private _injectedMsgIds = new Set<string>();

  // 当前活跃 runLoop 的 signal — 从工具调用派生的子 Agent
  // 将其合并到自己的 abort signal 中，使用户停止能级联到子 Agent。
  private _currentRunSignal: AbortSignal | null = null;

  // runLoop 是否正在运行 — 用于 bus 唤醒时避免重入
  private _isRunning = false;

  /** runLoop 是否正在运行 */
  get isRunning(): boolean {
    return this._isRunning;
  }

  // TaskBoard — 异步子 Agent 追踪的共享状态区
  private _taskBoard: TaskBoard | null = null;

  // DiscoveryBoard — Agent 间知识共享的共享发现区
  private _discoveryBoard: DiscoveryBoard | null = null;

  // 追踪已注入的 discovery ID — 防止同一 runLoop 内重复注入
  private _injectedDiscoveryIds = new Set<string>();

  // 临时提醒 — 每轮 <system-reminder> 注入，发送给 LLM
  // 但不持久化到 this.session。每个 runLoop 步骤开始时清除。
  // 保持会话历史干净以获得稳定的缓存前缀。
  private _transientReminders: string[] = [];

  // 文件所有权 — 并行子 Agent 的运行时写保护。
  // 仅 fresh 子 Agent（无 worktree 隔离）受声明约束。
  private _fileOwnership: FileOwnership | null = null;

  // 会话持久化
  sessionId: string;
  private _onSessionPersisted: ((sessionId: string, messages: Message[]) => void) | undefined;

  // 压缩成本模型追踪器
  private compactionTracker = new CompactionTracker();
  private _compactionConfigPath: string | null = null;
  private _compactionTrackerPath: string | null = null;

  // ── 压缩折叠状态（根治: session = 完整历史，压缩只影响发送载荷）──
  // session 永不被压缩动作替换 — UI 渲染与磁盘存档始终完整。
  // 压缩 = 生成摘要 + 记录折叠点；payloadMessages() 据此构造发送载荷。
  private _compactSummary: string | null = null;
  private _compactTailStart = -1;

  constructor(prov: Provider, tools: ToolRegistry, systemPrompt: string, opts: AgentOptions = {}) {
    this.prov = prov;
    this.tools = tools;
    this._sink = opts.eventSink ?? (() => {});
    this._ui = opts.ui ?? {};
    this._agentOpts = opts;
    this.temperature = opts.temperature ?? 0.7;
    this.pricing = opts.pricing;
    this.contextWindow = opts.contextWindow || 1000000; // 1M tokens 默认值; || 捕获零值（设置默认值），使压缩永不被静默禁用
    // ponytail: 0.55 将阈值设在 550K token（1M 窗口）。
    // 0.7 太高 — 最大的真实会话（450-630K）从未触发。
    // 积累足够样本后根据 compaction-model.ts 数据调优。
    this.compactRatio = opts.compactRatio ?? 0.55;
    this.recentKeep = opts.recentKeep ?? 4;
    this._subagentDepth = opts.subagentDepth ?? 0;
    this.id = opts.agentId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.parentId = opts.parentId ?? null;
    this._execState = opts.execState ?? execState;
    this._bus = opts.messageBus ?? null;
    this._taskBoard = opts.taskBoard ?? null;
    this._discoveryBoard = opts.discoveryBoard ?? null;

    this.sessionId = opts.sessionId || `session-${Date.now()}`;
    this._onSessionPersisted = opts.onSessionPersisted;

    this.session = [];
    if (systemPrompt) {
      this.session.push({ role: 'system', content: systemPrompt });
    }
  }

  /** 由 workspace 在会话中途保存记忆时调用 — 排队并在
   *  下一个安全边界作为 system-reminder 注入。 */
  notifyMemorySaved(text: string): void {
    this._pendingMemoryUpdates.push(text);
  }

  setHooks(hooks: HookRegistry): void {
    this.hooks = hooks;
  }

  setPreflightHooks(hooks: PreflightHookRegistry): void {
    this.preflightHooks = hooks;
  }

  /** Plan 模式状态 + 注入器 — 由 Runtime 在 createAgent 时设置 */
  private _planState: import('./plan/plan-state').PlanStateManager | null = null;
  private _planInjector: import('./plan/plan-injection').PlanModeInjector | null = null;

  setPlanState(
    state: import('./plan/plan-state').PlanStateManager,
    injector: import('./plan/plan-injection').PlanModeInjector,
  ): void {
    this._planState = state;
    this._planInjector = injector;
  }

  /** 从持久化快照恢复 plan 状态 — 在 agent load 后调用 */
  restorePlanState(snapshot: import('./plan/plan-state').PlanStateSnapshot | null | undefined, projectPath: string): void {
    if (this._planState) {
      this._planState.fromSnapshot(snapshot ?? null, projectPath);
    }
  }

  setUiSessionId(sid: number): void {
    this._uiSessionId = sid;
  }

  /** 设置在每条用户消息进入会话前触发的 hook。
   *  返回可选的上下文，作为 <system-reminder> 注入到消息前。
   *  用于每轮 AuraSDK 语义记忆检索。 */
  setPreRunHook(hook: (input: string) => Promise<string | null>): void {
    this._preRunHook = hook;
  }

  // ---- 公共 API ----

  getSession(): Message[] {
    return this.session;
  }

  setSession(msgs: Message[]): void {
    this.session = msgs;
    // 会话被替换（恢复/加载）→ 折叠状态失效，从完整历史重新开始
    this._compactSummary = null;
    this._compactTailStart = -1;
    this._execState.bumpVersion();
    this._ui.sessionReplaced?.(this.session);
  }

  getLastUsage(): Usage | undefined {
    return this.lastUsage;
  }

  getCacheTotals(): { hit: number; miss: number } {
    return { hit: this.cacheHitTotal, miss: this.cacheMissTotal };
  }

  /** 获取当前会话的压缩成本模型统计。 */
  getCompactionStats(): CompactionSessionStats {
    return this.compactionTracker.getStats(this.pricing);
  }

  /** 压缩统计工具的公共访问器。 */
  getCompactionTracker(): CompactionTracker {
    return this.compactionTracker;
  }
  getPricing(): Pricing | undefined {
    return this.pricing;
  }
  getCompactRatio(): number {
    return this.compactRatio;
  }
  getRecentKeep(): number {
    return this.recentKeep;
  }
  getContextWindow(): number {
    return this.contextWindow;
  }

  /** 设置自动调优压缩配置的持久化路径。 */
  setCompactionConfigPath(projectPath: string): void {
    const base = projectPath.replace(/\\/g, '/');
    this._compactionConfigPath = base + '/.hologram/compaction-config.json';
    // E5: tracker 状态（事件 + filesRead）单独持久化，使
    // 压缩调优在重启后不从零开始。
    this._compactionTrackerPath = base + '/.hologram/compaction-tracker.json';
  }

  /** E5: 从磁盘加载持久化的 tracker 状态（事件 + filesRead）。
   *  启动时调用，使压缩调优有历史数据。 */
  async loadCompactionTracker(): Promise<void> {
    if (!this._compactionTrackerPath) return;
    try {
      const raw = await rpc<string>('read_file_content', { filePath: this._compactionTrackerPath });
      const stripped = raw.replace(/^\s*\d+\t/gm, '');
      this.compactionTracker.deserializeState(stripped);
      const stats = this.compactionTracker.getStats(this.pricing);
      if (stats.events.length > 0) {
        log.info('agent', 'compaction tracker restored', {
          events: stats.events.length,
          filesRead: stats.filesReadPreCompact.size,
        });
      }
    } catch {
      /* 文件尚不存在 — 从零开始 */
    }
  }

  /** E5: 将 tracker 状态保存到磁盘。Best-effort，不抛异常。 */
  private async saveCompactionTracker(): Promise<void> {
    if (!this._compactionTrackerPath) return;
    try {
      await rpc('write_file_content', {
        filePath: this._compactionTrackerPath,
        content: this.compactionTracker.serializeState(),
      });
    } catch {
      /* 尽力而为 */
    }
  }

  /** 尝试加载持久化的压缩配置。无保存则返回 null。 */
  async loadCompactionConfig(): Promise<CompactionConfig | null> {
    if (!this._compactionConfigPath) return null;
    try {
      const raw = await rpc<string>('read_file_content', { filePath: this._compactionConfigPath });
      // 去除 cat -n 行号
      const stripped = raw.replace(/^\s*\d+\t/gm, '');
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }

  /** 应用自动调优的压缩参数。返回应用的配置。 */
  async applyAutoTuneConfig(): Promise<CompactionConfig | null> {
    // E5: 先加载 tracker 状态，使调优有历史数据
    await this.loadCompactionTracker();
    const config = await this.loadCompactionConfig();
    if (!config) return null;
    // 注意: 不要在这里修改 contextWindow — 它在 Agent 创建时
    // 从活跃模型派生。compactRatio/recentKeep 是无量纲的，
    // 适用于模型拥有的任何窗口。（旧的 `contextWindow = 1M` 硬编码
    // 在每个新 Agent 上静默覆盖了按模型的限制。）
    this.compactRatio = config.compactRatio;
    this.recentKeep = config.recentKeep;
    log.info('agent', 'auto-tune applied', {
      compactRatio: config.compactRatio,
      recentKeep: config.recentKeep,
      tunedAt: new Date(config.tunedAt).toISOString(),
      samples: config.sampleCount,
    });
    return config;
  }

  /** 检查是否有足够数据，若有则计算并持久化最优参数。
   *  每次压缩后调用。不抛异常 — best-effort 后台调优。 */
  private async tryAutoTune(): Promise<void> {
    const result = maybeTune(this.compactionTracker, this.compactRatio, this.recentKeep, this.pricing, this.contextWindow);
    if (!result?.changed) return;

    const { config } = result;
    log.info('agent', 'auto-tune recommendation', {
      compactRatio: config.compactRatio,
      recentKeep: config.recentKeep,
      samples: config.sampleCount,
      reasoning: config.reasoning,
    });

    this._sink({
      kind: EventKind.Notice,
      level: 'info',
      text: `[自动调优] ${config.reasoning}。参数已保存，下次会话生效。`,
    });

    // 持久化供下次会话使用
    if (this._compactionConfigPath) {
      try {
        await rpc('write_file_content', {
          filePath: this._compactionConfigPath,
          content: JSON.stringify(config, null, 2),
        });
      } catch {
        // 尽力而为
      }
    }
  }

  /** 撤回一轮: 从 sessionIndex 开始移除用户消息 + 后续的 assistant + tool 消息。
   *  通过 SessionChanged 事件通知 UI。 */
  retractTurnAt(sessionIndex: number): void {
    let end = sessionIndex + 1;
    while (end < this.session.length && this.session[end].role !== 'user') {
      end++;
    }
    this.session.splice(sessionIndex, end - sessionIndex);
    this._execState.bumpVersion();
    this._sink({ kind: EventKind.SessionChanged });
    this._ui.sessionReplaced?.(this.session);
  }

  /** 预测下一次插入的会话索引。在 insertMessage 前调用获取索引。 */
  get nextInsertIndex(): number {
    return this.session.length + this._pendingInserts.length;
  }

  /** 将消息插入会话队列。安全排队；Agent 在下次循环迭代时看到。
   *  通知是可选的 — 系统调用方（onSessionPersisted）应传 silent=true。 */
  insertMessage(text: string, opts?: { silent?: boolean }): void {
    this._pendingInserts.push(text);
    if (!opts?.silent) {
      this._sink({ kind: EventKind.Notice, level: 'info', text: '消息已插入，Agent 将在下一轮看到' });
    }
  }

  // ── 子 Agent 生命周期 ──

  /** 子 Agent 池的引用。由 workspace 在构造后设置。 */
  private _subAgentPool: import('./coordinator').SubAgentPool | null = null;

  /** Agent 间通信的消息总线。由 runtime/spawnSubAgent 设置。 */
  private _bus: MessageBus | null = null;

  setSubAgentPool(pool: import('./coordinator').SubAgentPool): void {
    this._subAgentPool = pool;
  }

  /** 接线 Agent 间通信的消息总线。
   *  注册 Agent 地址 + 唤醒回调，当 Agent 空闲时消息到达会触发 runLoop。 */
  setBus(bus: MessageBus): void {
    this._bus = bus;
    bus.register(
      { agentId: this.id, parentId: this.parentId, depth: this._subagentDepth },
      () => { void this._onMessageDelivered(); },
    );
  }

  /** 接线 discovery board 用于 Agent 间知识共享。
   *  由 runtime 调用，将共享 board 注入每个 Agent。 */
  setDiscoveryBoard(board: DiscoveryBoard): void {
    this._discoveryBoard = board;
  }

  /** 级联中止: 父 Agent 被中断时停止所有子 Agent。 */
  cascadeAbort(): void {
    const pool = this._subAgentPool;
    if (pool) {
      const stopped = pool.stopAll();
      if (stopped.length > 0) {
        log.info('agent', `cascade abort: stopped ${stopped.length} sub-agents`);
      }
    }
  }

  /** 接线文件所有权注册表，用于并行子 Agent 写保护。
   *  仅 fresh 子 Agent（无 worktree）受声明约束。 */
  setFileOwnership(fo: FileOwnership): void {
    this._fileOwnership = fo;
  }

  /** Bus 唤醒回调 — 当消息投递到此 Agent 的 inbox 时调用。
   *  若 Agent 空闲（未运行），启动新的 runLoop 处理消息。
   *  若正在运行，_injectInbox 会在下次迭代时拾取消息。 */
  private async _onMessageDelivered(): Promise<void> {
    if (this._isRunning) return;
    if (this._bus?.unreadCount(this.id) === 0) return;
    const signal = this._execState.start();
    try {
      await this.run(signal, '');
    } catch {
      // 唤醒失败不致命——消息还在 inbox，下次 run() 会捡到
    } finally {
      this._execState.done();
    }
  }

  /** 批量停止所有运行中的子 Agent。返回已停止的 Agent ID 列表。 */
  stopAllSubAgents(): string[] {
    return this._subAgentPool?.stopAll() ?? [];
  }

  /** 当前运行中的子 Agent 数量。 */
  runningSubAgentCount(): number {
    return this._subAgentPool?.runningCount ?? 0;
  }

  // ── Agent 身份与持久化 ──

  /** 接线持久化存储。主 Agent 从 Workspace 获取；
   *  子 Agent 从父 Agent 继承同一存储。 */
  setAgentStore(store: AgentStore): void {
    this.agentStore = store;
  }

  setGoalManager(mgr: GoalManager): void {
    this.goalManager = mgr;
  }

  /** 将当前状态 + 会话持久化到磁盘。Best-effort — 不抛异常。 */
  async saveState(status: AgentRecord['status'] = 'running'): Promise<void> {
    if (!this.agentStore) return;
    try {
      const planSnapshot = this._planState?.toSnapshot() ?? undefined;
      await this.agentStore.save(
        this.id,
        {
          parentId: this.parentId,
          description: this.id === 'main' ? '主Agent' : `子Agent (depth ${this._subagentDepth})`,
          status,
          subagentDepth: this._subagentDepth,
          planSnapshot,
        },
        this.session,
      );
    } catch {
      /* 持久化是尽力而为 — 绝不阻塞 agent 循环 */
    }
  }

  /** 在安全边界应用排队的插入（循环顶部，工具结果提交后）。 */
  private _applyPendingInserts(): void {
    if (this._pendingInserts.length === 0) return;
    for (const text of this._pendingInserts) {
      this.session.push({ role: 'user', content: text });
    }
    this._pendingInserts = [];
    // 通知 chat.ts 在新响应开始前完成当前轮次
    this._sink({ kind: EventKind.TurnStarted });
  }

  /** 在安全边界应用排队的记忆更新。
   *  作为临时 system-reminder 注入，使 Agent 在会话中途看到更新的记忆。
   *  不持久化到会话 — Aura 系统独立存储记忆。 */
  private _applyPendingMemoryUpdates(): void {
    if (!this._pendingMemoryUpdates?.length) return;
    const text = this._pendingMemoryUpdates.join('\n');
    this._transientReminders.push(`<system-reminder>${text}</system-reminder>`);
    this._pendingMemoryUpdates = [];
  }

  /** 将未读 inbox 消息注入为 system-reminder。非破坏性 —
   *  消息留在 inbox 直到被显式 ack 或回复。
   *  追踪已注入的消息 ID 以防止同一轮内重复注入
   *  result/reply 在注入时消费（从 inbox 移除）— 不需要回复。
   *  request 注入完整内容但留在 inbox（agent_reply 需要它在）。
   *  free 类型消息获得轻量通知；内容留在 inbox
   *  供 agent_inbox 查找。过期的 free 消息在注入前清除。 */
  private _injectInbox(): void {
    if (!this._bus) return;

    // 1. 清除过期的 free 类型消息
    this._bus.purgeExpired(this.id);

    // 2. 消费 result/reply: 注入完整内容 + 从 inbox 移除
    const CONSUME_TYPES = ['result', 'reply'];
    const { consumed, remaining } = this._bus.consumeByType(this.id, CONSUME_TYPES);

    // 3. 未消费的消息: 'request' 注入完整内容，其他注入轻量通知。
    //    'request' 留在 inbox 以便 agent_reply 找到并 ack。
    const newRemaining = remaining.filter((m) => !this._injectedMsgIds.has(m.id));
    for (const m of newRemaining) this._injectedMsgIds.add(m.id);

    const newRequests = newRemaining.filter((m) => m.type === 'request');
    const newFreeMsgs = newRemaining.filter((m) => m.type !== 'request');

    // 4. 强类型消息（result/reply/request）持久化到会话 — 它们
    //    从 inbox 消费或需要显式 ack，因此必须作为持久上下文
    //    保留供 Agent 处理。
    const durableParts: string[] = [];
    if (consumed.length > 0) {
      const formatted = consumed
        .map(
          (m) =>
            `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}`,
        )
        .join('\n\n');
      durableParts.push(`📬 消息 (${consumed.length} 条):\n${formatted}`);
    }
    if (newRequests.length > 0) {
      const formatted = newRequests
        .map(
          (m) =>
            `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}`,
        )
        .join('\n\n');
      durableParts.push(`📬 请求 (${newRequests.length} 条，用 agent_reply 回复):\n${formatted}`);
    }
    if (durableParts.length > 0) {
      this.session.push({
        role: 'user',
        content: `<system-reminder>\n${durableParts.join('\n\n')}\n</system-reminder>`,
      });
    }

    // 5. free 类型消息是临时的（内容留在 inbox 供 agent_inbox 查找）
    if (newFreeMsgs.length > 0) {
      const summary = newFreeMsgs
        .map((m) => `- from:${m.from} type:${m.type} (msg_id:${m.id})`)
        .join('\n');
      this._transientReminders.push(
        `<system-reminder>\n📬 未读消息 (${newFreeMsgs.length} 条，用 agent_inbox 查看详情):\n${summary}\n</system-reminder>`,
      );
    }

    // 6. 将 _injectedMsgIds 与实际 inbox 同步 — 移除自上次注入以来
    //    已 ack、过期或消费的消息 ID。
    const remainingIds = new Set(remaining.map((m) => m.id));
    for (const id of this._injectedMsgIds) {
      if (!remainingIds.has(id)) this._injectedMsgIds.delete(id);
    }
  }

  /** 将其他 Agent 的新发现注入为 system-reminder。
   *  仅注入本轮尚未见过 + 由其他 Agent 发布 + 5 分钟内的条目。
   *  使用 _injectedDiscoveryIds 防止重复注入。 */
  private _injectDiscoveries(): void {
    if (!this._discoveryBoard) return;
    const entries = this._discoveryBoard.query();
    if (entries.length === 0) return;
    // 仅注入来自其他 Agent、尚未见过、5 分钟内的 discoveries
    const recent = entries.filter(
      (e) =>
        e.agentId !== this.id &&
        !this._injectedDiscoveryIds.has(e.id) &&
        Date.now() - e.ts < 5 * 60 * 1000,
    );
    if (recent.length === 0) return;
    for (const e of recent) this._injectedDiscoveryIds.add(e.id);
    const formatted = recent
      .map(
        (e) =>
          `[${e.category}] ${e.key}: ${e.value} (by ${e.agentId})`,
      )
      .join('\n');
    // 临时 — discoveries 可通过 agent_lookup 重新查询
    this._transientReminders.push(
      `<system-reminder>\n🔬 共享发现 (${recent.length} 条):\n${formatted}\n\n用 agent_discover 发布你的发现，agent_lookup 查询全部。\n</system-reminder>`,
    );
  }

  /** 开启全新对话 — 保留 system prompt，清除其他所有内容。 */
  newSession(): void {
    const sys = this.session.length > 0 && this.session[0].role === 'system' ? this.session[0] : null;
    this.session = sys ? [sys] : [];
    // 新会话 → 折叠状态失效
    this._compactSummary = null;
    this._compactTailStart = -1;
    this._execState.bumpVersion();
    this.cacheHitTotal = 0;
    this.cacheMissTotal = 0;
    this.lastUsage = undefined;
    this.stormSig = '';
    this.stormCount = 0;
    this.compactStuck = false;
    this.compactRetryAfterLen = 0;
    this.compactFailCount = 0;
    this.compactionTracker.reset();
    this._transientReminders = [];
    this._sink({ kind: EventKind.Notice, level: 'info', text: '已开启新会话' });
  }

  /** 从父会话提取最近的工具结果作为 fork 的上下文。
   *  去除 system prompt、assistant tool_calls，截取最近 N 条消息。
   *  每条消息截断到 1000 字符以保持 fork system prompt 精简。 */
  extractRecentContext(maxMessages: number): string {
    const recent = this.session
      .filter((m) => m.role !== 'system') // 不泄漏父 Agent 的 system prompt
      .slice(-maxMessages);
    if (recent.length === 0) return '(无父Agent上下文)';
    return recent
      .map((m) => {
        const roleLabel =
          m.role === 'assistant' ? '主Agent' : m.role === 'tool' ? `工具结果(${m.name || '?'})` : '用户';
        const MAX = 1000;
        const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const content = raw.length > MAX ? raw.slice(0, MAX) + '…[截断]' : raw;
        return `[${roleLabel}] ${content}`;
      })
      .join('\n\n');
  }

  /** 运行一轮: 追加用户输入，驱动工具循环。
   *  空输入（bus 唤醒）跳过 preRunHook 和用户消息 — runLoop
   *  从 _injectInbox() 开始，将 inbox 消息作为唯一输入。 */
  async run(signal: AbortSignal, input: string): Promise<void> {
    this._isRunning = true;
    this._ui.onStatusChange?.(true);
    if (this._preRunHook && input) {
      try {
        const recallCtx = await this._preRunHook(input);
        if (recallCtx) {
          this._transientReminders.push(`<system-reminder>\n${recallCtx}\n</system-reminder>`);
        }
      } catch {
        /* pre-run hook 失败非致命 */
      }
    }
    if (input) {
      this.session.push({ role: 'user', content: input });
      // 用户发新消息 → 重置 plan 提醒计数（下一轮注入全量提醒）
      this._planInjector?.resetOnUserInput();
    }
    await this.runLoop(signal);
    // 触发 onSessionPersisted 回调（记忆 bundle 摄取、git 刷新、turn-start 块）
    if (this._onSessionPersisted) {
      try {
        this._onSessionPersisted(this.sessionId, this.session);
      } catch {
        /* 尽力而为 */
      }
    }
    // 每轮完成后持久化 Agent 状态
    this.saveState('running').catch(() => {});
  }

  // ══════════════════════════════════════════════════════
  // Goal 循环 — 自主多轮执行
  // ══════════════════════════════════════════════════════

  /** 自主运行目标: 规划 → 执行 → 验证 → 循环直到 goal_report。
   *  始终开启新目标 — 单槽语义会取消任何活跃目标
   *  （恢复是独立路径: resumeGoal）。状态存储在 GoalManager
   *  （.hologram/goals/{id}/），与聊天会话槽完全隔离 —
   *  日常聊天不再能覆盖目标检查点。 */
  async runGoal(
    signal: AbortSignal,
    goal: string,
  ): Promise<{ status: 'completed' | 'failed' | 'aborted' | 'paused'; summary: string }> {
    if (!this.goalManager) {
      return { status: 'failed', summary: '目标管理器未初始化' };
    }
    const record = await this.goalManager.create(goal);
    this._sink({ kind: EventKind.Notice, level: 'info', text: `[目标模式] ${record.text.slice(0, 60)}…` });
    const report = this._registerGoalReportTool();
    try {
      return await this._goalLoop(signal, record, false, report);
    } finally {
      this.tools.unregister('goal_report');
    }
  }

  /** 恢复活跃目标（暂停的，或崩溃遗留的活跃记录）。返回类型与 runGoal 相同。 */
  async resumeGoal(
    signal: AbortSignal,
    id?: string,
  ): Promise<{ status: 'completed' | 'failed' | 'aborted' | 'paused'; summary: string }> {
    if (!this.goalManager) {
      return { status: 'failed', summary: '目标管理器未初始化' };
    }
    const record = id ? await this.goalManager.get(id) : await this.goalManager.getActive();
    if (!record || (record.status !== 'paused' && record.status !== 'active')) {
      return { status: 'failed', summary: '没有可恢复的目标。使用 /goal 创建新目标。' };
    }
    // ponytail: 到达这里的 'active' 记录是崩溃残留（活跃循环被
    // UI 的 isRunning 守卫阻塞）— 像暂停的一样接管它。
    const snapshot = await this.goalManager.loadSession(record.id);
    if (snapshot && snapshot.length > 0) {
      this.session = snapshot;
      this._execState.bumpVersion();
    }
    this._sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 恢复: ${record.text.slice(0, 60)}…` });
    const report = this._registerGoalReportTool();
    try {
      return await this._goalLoop(signal, record, true, report);
    } finally {
      this.tools.unregister('goal_report');
    }
  }

  /** 为一个 goal 循环注册 goal_report。调用方在 finally 中注销。
   *  完成判定的主通道：模型显式上报，不再只靠正文正则。普通对话拿不到这个工具。 */
  private _registerGoalReportTool(): { called: boolean; status: 'completed' | 'failed'; summary: string } {
    const report = { called: false, status: 'completed' as 'completed' | 'failed', summary: '' };
    const goalReportTool: Tool = defineTool({
      name: 'goal_report',
      description:
        '目标模式专用：确认目标已达成、或确认无法达成时调用，调用后目标循环结束。' +
        'status=completed 时 summary 写完成摘要；status=failed 时 summary 写阻塞原因。',
      schema: z.object({
        status: z.enum(['completed', 'failed']),
        summary: z.string(),
      }),
      readOnly: true,
      execute: async (args) => {
        report.called = true;
        report.status = args.status;
        report.summary = args.summary;
        return `目标状态已记录: ${report.status}`;
      },
    });
    this.tools.register(goalReportTool);
    return report;
  }

  /** 共享的 goal 循环 — 新建和恢复都汇聚到这里。
   *  ponytail: 串行设计。并行是优化而非正确性要求 —
   *  串行子 Agent 派生保证无文件冲突。 */
  private async _goalLoop(
    signal: AbortSignal,
    record: GoalRecord,
    isResume: boolean,
    report: { called: boolean; status: 'completed' | 'failed'; summary: string },
  ): Promise<{ status: 'completed' | 'failed' | 'aborted' | 'paused'; summary: string }> {
    const mgr = this.goalManager;
    if (!mgr) return { status: 'aborted', summary: 'goal manager not initialized' };
    let stallRounds = record.stallRounds;

    // 重注完整目标提示词 — 新建与恢复都走这里。恢复时不能指望快照里
    // 还留着原文（可能已被压缩），重复出现的 <goal> 块是可接受的代价。
    this.session.push({ role: 'user', content: this._goalPrompt(record, isResume) });
    if (isResume) {
      this._sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 从第 ${record.iteration + 1} 轮恢复…` });
    }

    for (let iter = record.iteration; !signal.aborted && iter < Agent.MAX_GOAL_ITERATIONS; iter++) {
      this._ui.progress?.(iter + 1, 'goal-loop');

      // ── 检查点:记录 + 对话现场快照进 goal 专属槽 ──
      // ponytail: sessionBefore 使我们能在中止时裁剪未完成的轮次消息。
      const sessionBefore = this.session.length;
      await mgr.update(record.id, { iteration: iter, stallRounds, status: 'active' });
      await mgr.saveSession(record.id, this.session);

      try {
        await this.runLoop(signal);
      } catch (e: any) {
        // ponytail: 中断有多种冒泡形式 — runLoop 步骤边界抛 'aborted',
        // 流式 fetch 被掐断时抛 'BodyStreamBuffer was aborted' 之类的原始错误。
        // 用户意图是暂停,以 signal 为准,不认错误消息文本。
        if (signal.aborted || e?.message === 'aborted') {
          // ── 暂停:裁剪未完成轮次,快照进 goal 槽,记录转 paused ──
          this.session = this.session.slice(0, sessionBefore);
          this._execState.bumpVersion();
          await mgr.update(record.id, { status: 'paused', iteration: iter, stallRounds });
          await mgr.saveSession(record.id, this.session);
          // 从内存会话中清除目标上下文，使普通聊天不自动继续。
          // 完整上下文存在 goal 槽中；/goal resume 从那里恢复。
          this.session = this.session.length > 0 && this.session[0].role === 'system' ? [this.session[0]] : [];
          this._execState.bumpVersion();
          this._sink({
            kind: EventKind.Notice,
            level: 'info',
            text: `[目标] 已暂停于第 ${iter + 1} 轮。使用 /goal resume 继续。`,
          });
          return {
            status: 'paused',
            summary: `已暂停于第 ${iter + 1}/${Agent.MAX_GOAL_ITERATIONS} 轮。使用 /goal resume 继续。`,
          };
        }
        await mgr.update(record.id, { status: 'failed', summary: `执行异常: ${e?.message || e}` });
        return { status: 'failed', summary: `执行异常: ${e?.message || e}` };
      }

      // ── 完成判定:goal_report 优先,正文标记为旧会话 fallback ──
      if (report.called) {
        const summary = report.summary || this._lastAssistantContent();
        await mgr.update(record.id, { status: report.status, summary });
        this._sink({
          kind: EventKind.Notice,
          level: report.status === 'completed' ? 'info' : 'warn',
          text: report.status === 'completed' ? '✅ 目标达成' : '❌ 目标失败',
        });
        return { status: report.status, summary };
      }

      const last = this._lastAssistantContent();
      if (!last) {
        await mgr.update(record.id, { status: 'failed', summary: '模型未产出响应' });
        this._sink({ kind: EventKind.Notice, level: 'error', text: '目标执行异常: 模型未产出响应' });
        return { status: 'failed', summary: '模型未产出响应' };
      }

      if (/\[GOAL_COMPLETE\]/i.test(last)) {
        await mgr.update(record.id, { status: 'completed', summary: last });
        this._sink({ kind: EventKind.Notice, level: 'info', text: '✅ 目标达成' });
        return { status: 'completed', summary: last };
      }
      if (/\[GOAL_FAILED\]/i.test(last)) {
        await mgr.update(record.id, { status: 'failed', summary: last });
        this._sink({ kind: EventKind.Notice, level: 'warn', text: '❌ 目标失败' });
        return { status: 'failed', summary: last };
      }

      // ── 停滞检测: 连续无工具调用的轮次 → 卡住 ──
      const hasToolCalls = this._lastAssistantHasToolCalls();
      if (!hasToolCalls) {
        stallRounds++;
        if (stallRounds >= Agent.MAX_STALL_ROUNDS) {
          const summary = `连续 ${stallRounds} 轮未执行任何工具调用或委派子Agent。目标可能过于模糊或超出能力范围。请拆分目标为更具体的步骤。`;
          await mgr.update(record.id, { status: 'failed', summary, stallRounds });
          this._sink({
            kind: EventKind.Notice,
            level: 'warn',
            text: `[目标] 连续 ${stallRounds} 轮无实际行动，Agent 可能陷入分析瘫痪，终止`,
          });
          return { status: 'failed', summary };
        }
      } else {
        stallRounds = 0;
      }

      // 目标进行中 — 自动继续
      const stallHint =
        stallRounds > 0
          ? `\n⚠️ 已连续 ${stallRounds}/${Agent.MAX_STALL_ROUNDS} 轮无实际行动。必须调用工具或委派子Agent，禁止只输出文字分析。`
          : '';
      this.session.push({
        role: 'user',
        content: `<system-reminder>
目标未完成。已完成 ${iter + 1} 轮。${stallHint}

如果目标尚未达成: 规划下一步（不重复已完成步骤）→ 执行或 agent_spawn 委派 → 验证结果。
如果目标已全部达成: 调用 goal_report(status="completed", summary=…) 上报。
如果遇到无法克服的障碍: 调用 goal_report(status="failed", summary=…) 说明原因。

禁止反问用户。禁止只分析不行动。
</system-reminder>`,
      });
      this._sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 第 ${iter + 1} 轮完成，继续…` });
    }
    // 达到最大迭代数 — 强制终止（硬上限，正常使用不应触发）
    if (!signal.aborted) {
      const summary = `达到硬上限 ${Agent.MAX_GOAL_ITERATIONS} 轮。请拆分目标为更小单元。`;
      await mgr.update(record.id, { status: 'failed', summary });
      this._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `[目标] 达到硬上限 (${Agent.MAX_GOAL_ITERATIONS} 轮)，强制终止`,
      });
      return { status: 'failed', summary };
    }

    return { status: 'aborted', summary: '目标被中断' };
  }

  /** 完整 goal prompt — 新建和恢复时都注入，使模型
   *  不依赖原始 prompt 在快照中存活。 */
  private _goalPrompt(record: GoalRecord, isResume: boolean): string {
    const resumeNote = isResume
      ? `\n## 恢复执行\n这是恢复后的第 ${record.iteration + 1} 轮（此前已推进 ${record.iteration} 轮，对话现场已从快照恢复）。直接继续下一步，不要复盘已完成的工作。\n`
      : '';
    return `<goal>
## 总体目标
${record.text}
${resumeNote}
## 执行模式
你是目标驱动的执行Agent，会持续工作直到目标达成。你不会在中间停下来等用户。

## 执行规则
1. **规划** — 把目标分解为连续的、可验证的具体步骤
2. **执行** — 小步骤（几次工具调用内能完成）直接自己做；大步骤（多文件改动、独立子任务）用 \`agent_spawn\` fork 模式委派子Agent。子Agent有干净上下文，只做一件事，返回结果
3. **验证** — 每步完成后检查结果。正确→继续下一步，错误→分析原因→修正指令→重做
4. **循环** — 持续 规划→执行→验证→下一步，直到目标全部达成
5. **不要反问** — 不要在中间停下来问用户"要继续吗"。直接继续
6. **完成信号** — 判定目标已达成时调用 \`goal_report(status="completed", summary="完成摘要")\`；确认无法达成时调用 \`goal_report(status="failed", summary="阻塞原因")\`

## 禁止
- 输出纯文本分析后停止（分析完必须进入下一步行动）
- 反复分析同一问题而不行动
- 未验证结果就直接上报完成

现在开始。
</goal>`;
  }

  private _lastAssistantContent(): string {
    const session = this.getSession();
    for (let i = session.length - 1; i >= 0; i--) {
      if (session[i].role === 'assistant' && typeof session[i].content === 'string') {
        return session[i].content as string;
      }
    }
    return '';
  }

  /** 检查最后一条 assistant 消息是否包含 tool_calls（而非纯文本）。 */
  private _lastAssistantHasToolCalls(): boolean {
    const session = this.getSession();
    for (let i = session.length - 1; i >= 0; i--) {
      if (session[i].role === 'assistant') {
        return (session[i].tool_calls?.length ?? 0) > 0;
      }
    }
    return false;
  }

  /** 驱动工具循环而不添加用户消息。用于 fork 子 Agent
   *  其会话已以 fork 指令结尾的情况。 */
  private async runLoop(signal: AbortSignal): Promise<void> {
    const turnStart = performance.now();
    log.info('agent', 'turn started', { model: this.prov.name() });

    try {
    this._isRunning = true;
    this._currentRunSignal = signal; // 子 Agent 派生时合并此 signal 用于级联中止
    this._sink({ kind: EventKind.TurnStarted });

    for (let step = 0; ; step++) {
      // 清除上一步的临时提醒 — 仅当前步骤的
      // 提醒应对本轮 LLM 可见。
      // Step 0 跳过清除: run() 可能已将 preRunHook
      // （aura recall）结果推入 _transientReminders 后才调用 runLoop。
      if (step > 0) this._transientReminders = [];

      // Plan 模式提醒注入 — 去重逻辑在 PlanModeInjector 内部
      if (this._planState && this._planInjector) {
        let planContent = '';
        if (this._planState.state.active && this._planState.state.planFilePath) {
          try {
            const raw = await rpc<string>('read_file_content', {
              filePath: this._planState.state.planFilePath,
              isAgent: false,
            });
            planContent = raw.replace(/^\s*\d+\t/gm, '');
          } catch {
            /* plan 文件尚未写入 — 正常 */
          }
        }
        const reminder = this._planInjector.getReminder(
          step,
          this._planState.state,
          planContent,
        );
        if (reminder) {
          this._transientReminders.push(`<system-reminder>\n${reminder}\n</system-reminder>`);
        }
      }

      // 中止检查 — signal 覆盖用户停止 + 会话替换（通过 this._execState.stop）
      if (signal.aborted) throw new Error('aborted');

      // 在安全边界应用待插入的用户消息（工具结果提交后）
      this._applyPendingInserts();
      this._applyPendingMemoryUpdates();

      this._ui.progress?.(step + 1, 'thinking');

      // 在每次 stream() 调用前排空后台任务通知（临时 —
      // 轮次结束后进度更新无价值）
      try {
        const notes = await rpc<string>('drain_bg_notifications');
        if (notes) {
          this._transientReminders.push(`<system-reminder>\n${notes}\n</system-reminder>`);
        }
      } catch {
        // 尽力而为 — 排空失败不阻塞循环
      }

      // 注入未读 inbox 消息（窥探 — 不消费）
      this._injectInbox();

      // 注入其他 Agent 的新发现
      this._injectDiscoveries();

      // ── 预检上下文窗口 ──
      // 在发送到 API 前检查 — 捕获上轮结束时（maybeCompact() 在 0.55 触发）
      // 与危险区（0.88）之间的间隙。估算基于发送载荷（折叠视图），
      // 与真实 API 压力一致。没有这个检查，大量工具结果 + 注入
      // 会在下一轮导致 400 错误。
      if (this.contextWindow > 0) {
        const preFlight = this.tokenCountWithEstimation();
        const preFlightRatio = preFlight / this.contextWindow;
        if (preFlightRatio >= 0.88) {
          if (this.compactStuck) {
            log.warn('agent', 'pre-flight skipped: compact stuck', {
              estimated: preFlight,
              ratio: preFlightRatio.toFixed(2),
            });
            this._sink({
              kind: EventKind.Notice,
              level: 'warn',
              text: `上下文使用率 ${(preFlightRatio * 100).toFixed(0)}%，但压缩已卡住。建议 /new。`,
            });
          } else if (this.compactRunning) {
            log.info('agent', 'pre-flight skipped: compact already running', {
              estimated: preFlight,
              ratio: preFlightRatio.toFixed(2),
            });
          } else {
            log.info('agent', 'pre-flight compaction triggered', {
              estimated: preFlight,
              ratio: preFlightRatio.toFixed(2),
              contextWindow: this.contextWindow,
            });
            this._sink({
              kind: EventKind.Notice,
              level: 'warn',
              text: `上下文使用率 ${(preFlightRatio * 100).toFixed(0)}%，发送前压缩…`,
            });
            try {
              const outcome = await this.compactNow(signal);
              if (outcome === 'stuck') {
                this._sink({
                  kind: EventKind.Notice,
                  level: 'warn',
                  text: '压缩无法减少上下文——消息太少。建议 /new。',
                });
              }
            } catch {
              // compactNow 已发出自身错误 — 继续让 API 错误处理器
              // （stream 中的响应式压缩）捕获
              log.warn('agent', 'pre-flight compaction failed, falling through to API call');
            }
          }
        }
      }

      // ---- Stream（带流式工具执行器 + hooks）----
      this.compactionTracker.recordTurn();
      const executor = new StreamingToolExecutor(
        this.tools,
        (ev: AgentEvent) => this._sink(ev),
        this.hooks,
        this.preflightHooks,
        this._isolationId ?? null,
        signal,
      );
      let { text, reasoning, signature, calls, usage, err } = await this.stream(signal, step + 1, executor);
      if (err) {
        log.error('agent', 'stream error', { error: String(err.message || err) });
        throw err;
      }

      if (usage && usage.total_tokens > 0) {
        log.info('agent', 'llm response', {
          turn: step + 1,
          model: this.prov.name(),
          finish_reason: usage.finish_reason,
          total_tokens: usage.total_tokens,
          cache_hit_tokens: usage.cache_hit_tokens,
          elapsed_ms: Math.round(performance.now() - turnStart),
        });
        this._diagTokenBreakdown(usage);
        this.cacheHitTotal += usage.cache_hit_tokens;
        this.cacheMissTotal += usage.cache_miss_tokens;
        this.lastUsage = usage;
        this._sink({
          kind: EventKind.Usage,
          usage,
          pricing: this.pricing,
          session_hit: this.cacheHitTotal,
          session_miss: this.cacheMissTotal,
        });
      }

      // 异常完成原因告警
      const warnMsg = finishReasonMessage(usage);
      if (warnMsg) {
        this._sink({ kind: EventKind.Notice, level: 'warn', text: warnMsg });
      }

      // 保护: DeepSeek 拒绝既无 content 也无 tool_calls 的 assistant 消息。
      if (!text && calls.length === 0) {
        if (this._pendingInserts.length > 0 || reasoning) {
          text = reasoning ? '(思考完成)' : '(等待中)';
        } else {
          log.warn('agent', 'empty assistant turn — skipping push to avoid API 400');
          this._sink({ kind: EventKind.Notice, level: 'warn', text: 'Provider 本次调用了但无内容返回，已跳过此轮。' });
          return;
        }
      }

      // 存储 assistant 轮次（reasoning 保留用于显示，不重新上传）
      this.session.push({
        role: 'assistant',
        content: text,
        reasoning_content: reasoning,
        reasoning_signature: signature,
        tool_calls: calls,
      });

      if (calls.length === 0 && this._pendingInserts.length === 0) {
        return;
      }

      // ---- 收集工具结果（流式执行器在 stream 期间已执行）----
      log.info('agent', 'collect streaming results', {
        tools: calls.map((c) => c.name),
        count: calls.length,
      });
      const pendingResults = await executor.awaitRemaining();
      // 按调用顺序构建结果
      const resultsByCallId = new Map(pendingResults.map((r) => [r.call.id, r]));

      // ── Storm breaker + 压缩埋点 ──
      // 两个调用点在 6e75046（StreamingToolExecutor 清理前）丢失；
      // 在此重新接线。Storm breaker 将模型从相同失败的循环中推开；
      // tracker 用真实损失数据喂给压缩自动调优。
      const stormNudge = this._stormNudge(calls, resultsByCallId);
      for (const call of calls) {
        this.compactionTracker.recordToolCall(call.name, call.arguments || '{}');
        if (call.name === 'read_file_content' || call.name === 'read_file') {
          const fp = parseFilePathArg(call.arguments);
          if (fp) this.compactionTracker.recordFileRead(fp);
        }
      }

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const r = resultsByCallId.get(call.id);
        // r 存在但 output 为空 = 工具执行成功但无输出(如 git add 成功、git diff 无差异)。
        // 空字符串是 falsy,若用 `r?.output || error` 会把成功误判成"工具没结果",
        // 导致 Agent 看到 "did not produce a result" 而困惑/重试。
        // 仅当 r 不存在(流式重试丢失、未分发)才算真正失败。
        let content = r
          ? r.output || `(工具 ${call.name} 执行成功，无输出)`
          : `error: tool "${call.name}" did not produce a result`;
        if (stormNudge && i === 0) content += stormNudge;
        this.session.push({
          role: 'tool',
          content,
          tool_call_id: call.id,
          name: call.name,
        });
        // 通知面板自动刷新（workspace 注入的端口）
        this._ui.toolDone?.(
          call.name,
          (() => {
            try {
              return JSON.parse(call.arguments || '{}');
            } catch {
              return {};
            }
          })(),
          r?.output || '',
        );
      }

      // 下一轮前按需压缩
      this.maybeCompact(usage);
    }
    } finally {
      this._isRunning = false;
      this._ui.onStatusChange?.(false);
      // 重新检查新（尚未注入的）消息 — 避免本轮已注入但未 ack 的消息
      // 导致无限循环。
      if (!signal.aborted && this._bus) {
        const hasNew = this._bus.peekInbox(this.id).some((m) => !this._injectedMsgIds.has(m.id));
        if (hasNew) {
          queueMicrotask(() => { void this._onMessageDelivered(); });
        }
      }
    }
  }

  // ---- 私有: stream（带重试）----

  private async stream(
    signal: AbortSignal,
    turn: number,
    executor?: StreamingToolExecutor,
  ): Promise<{
    text: string;
    reasoning: string;
    signature: string;
    calls: ToolCall[];
    usage: Usage | undefined;
    err: Error | undefined;
  }> {
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) {
        executor?.discard();
        return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: new Error('aborted') };
      }

      const result = await this.streamOnce(signal, turn, executor);

      // 成功 — 无错误，或错误已由 streamOnce 作为通知发出
      if (!result.err) return result;

      lastErr = result.err;

      // 响应式压缩: 如果错误是 "prompt too long"，压缩并重试，
      // 无论错误是否通常可重试。
      // 根治: 只有载荷确实接近窗口（>60%）时才响应式压缩 —
      // 错误文本匹配会误判（"400"+"token" 字样即可命中），
      // 低水位下不引发任何动作；也不再自动调低 contextWindow
      // （单次错误不能证明窗口大小，永久砍小会让压缩在荒谬
      // 的阈值反复触发，日志 2026-07-28 已实锤该恶性循环）。
      const errAt = this.tokenCountWithEstimation();
      if (
        this.isContextLengthError(lastErr) &&
        !this.compactStuck &&
        !this.compactRunning &&
        this.session.length >= this.compactRetryAfterLen &&
        errAt > this.contextWindow * 0.6
      ) {
        log.info('agent', 'reactive compact triggered by context-length error', {
          estimated: errAt,
          ratio: (errAt / this.contextWindow).toFixed(2),
        });
        this._sink({ kind: EventKind.Notice, level: 'warn', text: '上下文过长，自动压缩后重试…' });
        try {
          await this.compactNow(signal);
          // compactNow 更新折叠状态（载荷变小）— 跳过退避，立即重试
          continue;
        } catch {
          // compactNow 失败 — 转入正常重试/中止逻辑
          this._sink({ kind: EventKind.Notice, level: 'warn', text: '自动压缩失败，尝试直接重试…' });
        }
      }

      // 不可重试的错误不重试
      if (!isRetryable(lastErr)) return result;

      // 最后一次尝试 — 放弃
      if (attempt >= MAX_RETRIES) break;

      // 丢弃失败尝试的所有工具调用
      executor?.discard();

      // 重试前退避
      const delay = backoffDelay(attempt);
      log.info('agent', `stream retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`, {
        error: String(lastErr.message || lastErr),
      });
      this._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `模型调用失败，${(delay / 1000).toFixed(1)}s 后重试 (${attempt + 1}/${MAX_RETRIES})…`,
      });

      const aborted = await sleepWithAbort(delay, signal);
      if (aborted) {
        return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: new Error('aborted') };
      }
    }

    // 重试已耗尽
    this._sink({
      kind: EventKind.Notice,
      level: 'error',
      text: `模型调用失败，已重试 ${MAX_RETRIES} 次：${lastErr?.message || '未知错误'}。请检查网络连接和 API 设置。`,
    });
    return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: lastErr };
  }

  /** 单次流式尝试 — 无重试逻辑。
   *  当提供 executor 时，工具调用立即添加到其中
   *  （在流式过程中开始执行，而非之后）。 */
  private async streamOnce(
    signal: AbortSignal,
    _turn: number,
    executor?: StreamingToolExecutor,
  ): Promise<{
    text: string;
    reasoning: string;
    signature: string;
    calls: ToolCall[];
    usage: Usage | undefined;
    err: Error | undefined;
  }> {
    // 将临时提醒作为 user 消息追加到末尾 — 它们
    // 本轮对 LLM 可见但不持久化到 this.session。
    // 载荷 = 完整历史的折叠视图（若已压缩）+ 临时提醒。
    const transientMsgs: Message[] = this._transientReminders.map((content) => ({
      role: 'user' as const,
      content,
    }));
    const payload = this.payloadMessages();
    const fullSession = transientMsgs.length > 0 ? [...payload, ...transientMsgs] : payload;

    // 流空闲超时：60s 无任何 chunk 视为挂起（与 callSummaryLLM / dataflow NL 解析
    // 共用 streamWithIdleTimeout）。超时 abort 后 sendWithRetry/readSSE 抛 aborted，
    // 此处转为可读的挂起提示。外部 signal 只做转发，不直接传给 stream——
    // 避免超时 abort 连累调用方。
    // sanitizeToolPairing 不在此调用 — provider（openai/anthropic）是上线前的最终 gate。
    const stream = streamWithIdleTimeout(this.prov, signal, {
      messages: fullSession,
      tools: this.tools.schemas(),
      temperature: this.temperature,
      // max_tokens 不开放设置 — 0 = provider 默认 32000，发送前按模型目录上限钳制
      max_tokens: 0,
    });

    let text = '';
    let reasoning = '';
    let signature = '';
    const calls: ToolCall[] = [];
    let usage: Usage | undefined;
    let err: Error | undefined;

    try {
      for await (const chunk of stream.chunks) {
        switch (chunk.type) {
          case ChunkType.Reasoning:
            reasoning += chunk.text || '';
            if (chunk.signature) signature = chunk.signature;
            if (chunk.text) {
              this._sink({ kind: EventKind.Reasoning, text: chunk.text });
            }
            break;

          case ChunkType.Text:
            text += chunk.text || '';
            this._sink({ kind: EventKind.Text, text: chunk.text });
            break;

          case ChunkType.ToolCallStart:
            if (chunk.tool_call) {
              this._sink({
                kind: EventKind.ToolDispatch,
                tool: {
                  id: chunk.tool_call.id,
                  name: chunk.tool_call.name,
                  args: '',
                  read_only: this.toolReadOnly(chunk.tool_call.name),
                  partial: true,
                },
              });
            }
            break;

          case ChunkType.ToolArgPreview:
            if (chunk.tool_arg_preview) {
              this._sink({
                kind: EventKind.ToolProgress,
                tool: {
                  id: chunk.tool_arg_preview.tool_id,
                  name: chunk.tool_arg_preview.tool_name,
                  output: chunk.tool_arg_preview.content,
                  read_only: true,
                },
              });
            }
            break;

          case ChunkType.ToolCall:
            if (chunk.tool_call) {
              calls.push(chunk.tool_call);
              // 流式执行: 立即启动工具，不等流结束
              executor?.addTool(chunk.tool_call);
            }
            break;

          case ChunkType.Usage:
            usage = chunk.usage;
            break;

          case ChunkType.Error:
            err = chunk.err;
            // 落入 Done 以停止迭代
            break;

          case ChunkType.Done:
            break;
        }

        if (err) break;
      }
    } catch (e: any) {
      if (stream.idleTimedOut) {
        err = new Error(`模型响应超时（${STREAM_IDLE_TIMEOUT_MS / 1000} 秒无输出），已自动中止`);
      } else {
        err = e instanceof Error ? e : new Error(String(e));
      }
    }

    if (err) {
      this._sink({ kind: EventKind.Notice, level: 'error', text: `模型调用失败: ${err.message || err}` });
      return { text: '', reasoning: '', signature: '', calls: [], usage, err };
    }

    // 关闭文本流
    if (text || reasoning) {
      this._sink({ kind: EventKind.Message, text, reasoning });
    }

    return { text, reasoning, signature, calls, usage, err: undefined };
  }

  // ---- Storm breaker — 打断重复工具调用循环 ----

  /** 检测重复相同的工具调用失败。返回追加到第一个工具结果的提示字符串，
   *  或 null。Storm 状态（stormSig/stormCount）在压缩/newSession 时重置；
   *  一批调用中任何成功调用也会重置。 */
  private _stormNudge(
    calls: ToolCall[],
    resultsByCallId: Map<string, { output: string; err?: string }>,
  ): string | null {
    const outcomes: ToolOutcome[] = calls.map((c) => {
      const r = resultsByCallId.get(c.id);
      const output = r?.output ?? '';
      return {
        output,
        errMsg: r?.err,
        blocked: output.includes('架构门禁已阻止'),
        truncated: false,
      };
    });
    const { sig, ok } = batchStormSignature(calls, outcomes);
    if (!ok) {
      this.stormSig = '';
      this.stormCount = 0;
      return null;
    }
    if (sig !== this.stormSig) {
      this.stormSig = sig;
      this.stormCount = 1;
      return null;
    }
    this.stormCount++;
    if (this.stormCount < STORM_BREAK_THRESHOLD) return null;

    const subject = calls.length === 1 ? `"${calls[0].name}"` : `this batch of ${calls.length} tool calls`;
    const short = calls.length === 1 ? calls[0].name : `a batch of ${calls.length} calls`;

    this._sink({
      kind: EventKind.Notice,
      level: 'warn',
      text: `loop guard: ${short} failed ${this.stormCount}× the same way — nudging the model to change approach`,
    });

    return `\n\n[loop guard] ${subject} has now failed ${this.stormCount} times in a row with the same error. Re-sending it will not help. Change approach: if an argument is being truncated, write less in one call and split the work; otherwise fix the arguments, use a different tool, or explain the blocker in your final answer.`;
  }

  // ---- 上下文窗口管理 ----

  private compactRunning = false;
  // ⚡ sessionGen migrated to ExecutionState.sessionVersion

  /** 使用 cl100k_base tokenizer 精确计算 token 数。
   *  替代旧的 chars/2.5 启发式（误差 30-60%）。
   *  Cl100k_base 匹配 GPT-4、DeepSeek 和大多数 OpenAI 兼容模型。
   *  Anthropic 的 tokenizer 略有差异（< 8% 误差），对压缩安全。
   *  按发送载荷（payloadMessages 折叠视图）计数 — 触发判定必须
   *  与真实 API 压力一致，而非完整历史大小。 */
  private tokenCountWithEstimation(): number {
    let total = countMessages(this.payloadMessages());
    // 计算临时提醒 token — 发送给 LLM 但不在会话中
    total += countTexts(this._transientReminders);
    // 计算工具 schema token — 每次请求都发送
    total += countToolSchemas(this.tools.schemas());
    return total;
  }

  /** 诊断: 按组件分解 token 消耗。
   *  每轮后以结构化 NDJSON 记录到 .hologram/logs/ui.log。
   *  过滤: jq 'select(.module=="agent" and .message=="token breakdown") | .ctx' */
  private _diagTokenBreakdown(apiUsage: Usage | undefined): void {
    try {
      const T = this.tools.schemas();
      const schemaTokens = countToolSchemas(T);
      // 统计发送载荷（折叠视图）而非完整历史 — 反映真实 API 成本
      const payload = this.payloadMessages();

      let sysTokens = 0, userTokens = 0, reminderTokens = 0, assistantTokens = 0, toolTokens = 0;
      let reminderCount = 0, inboxInjCount = 0;
      let sysMsgCount = 0, userMsgCount = 0, assistantMsgCount = 0, toolMsgCount = 0;

      for (const m of payload) {
        const tok = countMessage(m);
        if (m.role === 'system') { sysTokens += tok; sysMsgCount++; }
        else if (m.role === 'user') {
          if (typeof m.content === 'string' && m.content.includes('<system-reminder>')) {
            reminderTokens += tok; reminderCount++;
            if (m.content.includes('📬')) inboxInjCount++;
          } else { userTokens += tok; userMsgCount++; }
        }
        else if (m.role === 'assistant') { assistantTokens += tok; assistantMsgCount++; }
        else if (m.role === 'tool') { toolTokens += tok; toolMsgCount++; }
      }

      const transientTokens = countTexts(this._transientReminders);
      const estimatedTotal = sysTokens + userTokens + reminderTokens + transientTokens + assistantTokens + toolTokens + schemaTokens;

      const diag = {
        turn_session_msgs: payload.length,
        history_msgs: this.session.length,
        // ── 成本中心 ──
        system_prompt: { tokens: sysTokens, msgs: sysMsgCount },
        user_real:    { tokens: userTokens, msgs: userMsgCount },
        reminders:    { tokens: reminderTokens, msgs: reminderCount, inbox: inboxInjCount },
        transient_reminders: { tokens: transientTokens, msgs: this._transientReminders.length },
        assistant:    { tokens: assistantTokens, msgs: assistantMsgCount },
        tool_results: { tokens: toolTokens, msgs: toolMsgCount },
        tool_schemas: { tokens: schemaTokens, count: T.length },
        // ── 汇总 ──
        estimated_total: estimatedTotal,
        api_reported: apiUsage ? { prompt: apiUsage.prompt_tokens, completion: apiUsage.completion_tokens, total: apiUsage.total_tokens } : null,
        cache: apiUsage ? { hit: apiUsage.cache_hit_tokens, miss: apiUsage.cache_miss_tokens } : null,
      };

      log.info('agent', 'token breakdown', diag);
    } catch { /* 诊断绝不抛异常 */ }
  }

  /** 检查错误是否为上下文长度超限。 */
  private isContextLengthError(err: Error): boolean {
    const msg = (err.message || String(err)).toLowerCase();
    // 完成预算错误（"Invalid max_tokens value…"）是请求参数 bug，
    // 不是 prompt 溢出 — 压缩 prompt 无法修复它们，
    // 误分类会导致每次输入都陷入 compact→retry→400 循环。
    if (msg.includes('max_tokens') || msg.includes('max_output_tokens')) return false;
    return (
      msg.includes('prompt is too long') ||
      msg.includes('context length') ||
      msg.includes('too many tokens') ||
      msg.includes('maximum context') ||
      msg.includes('reduce the length') ||
      msg.includes('token limit') ||
      (msg.includes('400') && (msg.includes('token') || msg.includes('context') || msg.includes('prompt')))
    );
  }

  /** ponytail: 记录压缩事件 + 若为摘要结果则自动调优。
   *  集中 compactNow 和 triggerAutoCompact 中重复的模式。
   *  E5: 同时持久化 tracker 状态以在重启后存活。 */
  private recordCompactionEvent(event: CompactionEvent): void {
    this.compactionTracker.recordCompaction(event);
    // E5: 持久化 tracker 状态（事件 + filesRead）以跨会话存活
    void this.saveCompactionTracker();
    if (event.outcome === 'summary') this.tryAutoTune();
  }

  // ── 折叠视图（根治核心）──

  /** session 头部偏移: 若第一条是 system prompt 则为 1，否则 0。 */
  private _foldHead(): number {
    return this.session.length > 0 && this.session[0].role === 'system' ? 1 : 0;
  }

  /** 发送给 LLM 的载荷 — 完整历史 + 折叠（若已有压缩记录）。
   *  根治: session 永远是完整历史（UI/存档读取），压缩只影响这里。 */
  private payloadMessages(): Message[] {
    if (!this._compactSummary || this._compactTailStart < 0) return this.session;
    const head = this._foldHead();
    const tailStart = Math.min(Math.max(this._compactTailStart, head), this.session.length);
    const summaryMsg: Message = {
      role: 'user',
      content:
        '<compacted-context>\n以下是对前面讨论的总结（原始消息仍完整保留在会话历史中）:\n\n' +
        this._compactSummary +
        '\n</compacted-context>',
    };
    return [...this.session.slice(0, head), summaryMsg, ...this.session.slice(tailStart)];
  }

  /** 计算本次要折叠的中间区域。返回 null = 无可折叠内容（stuck）。
   *  区域 = session[foldPoint..tailStart]，foldPoint 是上次折叠点
   *  （首次压缩 = system 之后），tailStart 前保留最近 N 条消息 —
   *  每次压缩只处理"上次折叠后新增的消息"，摘要成本可控且累积正确。
   *  不拆分 tool-call 组: 若尾部以孤立的 tool 结果开始，将其拉入区域。 */
  private computeCompactRegion(): { region: Message[]; tailStart: number; priorSummary: string | null } | null {
    const msgs = this.session;
    const head = this._foldHead();
    const tailCount = Math.max(4, this.recentKeep);
    const foldPoint = this._compactTailStart >= 0 ? Math.max(this._compactTailStart, head) : head;
    const regionEnd = msgs.length - tailCount;
    if (regionEnd - foldPoint <= 0) return null; // 无可折叠内容
    let tailStart = regionEnd;
    while (tailStart < msgs.length && msgs[tailStart].role === 'tool') tailStart++;
    const region = msgs.slice(foldPoint, tailStart);
    if (region.length === 0) return null;
    return { region, tailStart, priorSummary: this._compactSummary };
  }

  /** 应用折叠状态: 记录摘要 + 折叠点。session（完整历史）不变。 */
  private _applyCompactState(tailStart: number, summary: string): void {
    this._compactSummary = summary;
    this._compactTailStart = tailStart;
    // session 可能已被 retract 缩短或替换 — 修正折叠点
    const head = this._foldHead();
    if (this._compactTailStart < head) this._compactTailStart = head;
    if (this._compactTailStart > this.session.length) this._compactTailStart = this.session.length;
  }

  /** 手动压缩触发器（来自 /compact 命令）。返回摘要文本或错误。
   *  根治: 压缩只生成摘要并记录折叠点 — 不触碰 this.session（完整历史），
   *  不触发 sessionReplaced，不写盘 — UI 渲染与磁盘存档永远完整。 */
  async compactNow(signal: AbortSignal): Promise<string> {
    if (this.compactRunning) throw new Error('compaction already in progress');
    this.compactRunning = true;
    try {
      const regionInfo = this.computeCompactRegion();
      if (!regionInfo) {
        // 头尾之间无内容可折叠 — 不再永久闩锁（对话增长后自然可折叠），
        // 仅设置增长门槛，避免响应式路径在空区域上空转。
        this.compactRetryAfterLen = this.session.length + Math.max(4, this.recentKeep);
        this.recordCompactionEvent({
          ts: Date.now(),
          regionMsgCount: 0,
          regionTokensEst: 0,
          summaryInputTokens: 0,
          summaryOutputTokens: 0,
          tailMsgCount: Math.max(0, this.session.length - this._foldHead()),
          preTokens: this.tokenCountWithEstimation(),
          postTokens: this.tokenCountWithEstimation(),
          outcome: 'stuck',
        });
        this._sink({
          kind: EventKind.Notice,
          level: 'warn',
          text: '对话太短，无法压缩。若上下文确实已满，请用 /new 开启新会话。',
        });
        return 'stuck';
      }
      const { region, tailStart, priorSummary } = regionInfo;
      let result: { text: string; degraded: boolean } | null = null;
      try {
        result = await this.summarizeRegion(signal, region, priorSummary);
      } catch (e: any) {
        log.warn('agent', `summarizeRegion failed (${e?.message || e})`);
      }
      if (!result || !result.text) {
        // 摘要失败 = 放弃本次压缩。历史保持完整，仅继续增长。
        // 根治: 绝不截断/删除历史消息。
        this.recordCompactionEvent({
          ts: Date.now(),
          regionMsgCount: region.length,
          regionTokensEst: countMessages(region),
          summaryInputTokens: 0,
          summaryOutputTokens: 0,
          tailMsgCount: this.session.length - tailStart,
          preTokens: this.tokenCountWithEstimation(),
          postTokens: this.tokenCountWithEstimation(),
          outcome: 'stuck',
        });
        this._sink({
          kind: EventKind.Notice,
          level: 'warn',
          text: '压缩失败，本次跳过（完整历史仍保留）。可继续对话或用 /new 开启新会话。',
        });
        return 'stuck';
      }
      const summary = result.text;

      // 应用折叠状态 — session 不变，发送载荷变小
      this._applyCompactState(tailStart, summary);
      this.stormSig = '';
      this.stormCount = 0;
      this.compactStuck = false;
      this.compactRetryAfterLen = 0;
      this.compactFailCount = 0;

      // ── 压缩模型埋点 ──
      const preTokens = this.tokenCountWithEstimation();
      this.recordCompactionEvent({
        ts: Date.now(),
        regionMsgCount: region.length,
        regionTokensEst: countMessages(region),
        summaryInputTokens: countMessages(region), // 近似值
        summaryOutputTokens: countText(summary),
        tailMsgCount: this.session.length - tailStart,
        preTokens,
        postTokens: this.tokenCountWithEstimation(),
        outcome: result.degraded ? 'digest' : 'summary',
      });
      this._sink({
        kind: EventKind.Notice,
        level: 'info',
        text: `上下文已压缩: ${region.length} 条消息 → 摘要 (保留最近 ${this.session.length - tailStart} 条，完整历史仍保留)`,
      });
      return summary;
    } finally {
      this.compactRunning = false;
    }
  }

  private maybeCompact(usage: Usage | undefined): void {
    if (this.contextWindow <= 0) return;

    // 有 API 报告的 token 时优先使用，否则回退到估算。
    // 估算基于发送载荷（折叠视图），与真实 API 压力一致 —
    // 压缩成功后载荷变小，比例自然回落，不会反复触发。
    const estimated = usage && usage.total_tokens > 0 ? usage.total_tokens : this.tokenCountWithEstimation();
    const ratio = estimated / this.contextWindow;

    if (ratio < this.compactRatio) {
      this.compactStuck = false;
      this.compactFailCount = 0;
      return;
    }
    if (this.compactStuck) return;
    if (this.compactRunning) {
      this._sink({ kind: EventKind.Notice, level: 'info', text: '压缩已在运行中，跳过重复触发' });
      return;
    }
    // 退避门控: 空区域（对话太短）或失败后，session 未增长足够不重试。
    // 瞬时错误随对话增长自动自愈 — 没有永久闩锁。
    if (this.session.length < this.compactRetryAfterLen) return;
    this.compactRunning = true;

    // 自动压缩: 本轮后在后台生成摘要并更新折叠状态
    this._sink({
      kind: EventKind.Notice,
      level: 'info',
      text: `上下文使用率 ${(ratio * 100).toFixed(0)}% — 自动压缩中…`,
    });

    // 异步运行压缩（不阻塞当前轮次）
    const genAtStart = this._execState.bumpVersion();
    const regionInfo = this.computeCompactRegion();
    if (!regionInfo) {
      // 无可折叠内容 — 不闩锁、不告警、不记录失败事件。
      // 对话继续增长后自然出现可折叠区域，设增长门槛后静默跳过。
      this.compactRetryAfterLen = this.session.length + Math.max(4, this.recentKeep);
      this.compactRunning = false;
      log.debug('agent', 'compact skipped: nothing to fold yet', {
        sessionLen: this.session.length,
        retryAfterLen: this.compactRetryAfterLen,
      });
      return;
    }

    const abortCtrl = new AbortController();
    this.summarizeRegion(abortCtrl.signal, regionInfo.region, regionInfo.priorSummary)
      .then(({ text: summary, degraded }) => {
        if (genAtStart !== this._execState.sessionVersion) {
          this.compactRunning = false;
          return;
        } // 会话已替换，丢弃
        if (!summary) {
          this.compactRunning = false;
          return;
        }
        // 应用折叠 — session（完整历史）不变，载荷变小
        this._applyCompactState(regionInfo.tailStart, summary);
        this.stormSig = '';
        this.stormCount = 0;
        this.compactRetryAfterLen = 0;
        this.compactFailCount = 0;

        // 检查压缩是否足够 — 若折叠后载荷仍高于 95%，则已卡住
        // （尾部保留的消息本身就占满窗口 — 压缩确实无能为力，
        //  这是唯一合法的"卡死"，只有 /new 能解决）
        const postEstimate = this.tokenCountWithEstimation();
        if (postEstimate / this.contextWindow > 0.95) {
          this.compactStuck = true;
          this.compactRunning = false;
          this._sink({
            kind: EventKind.Notice,
            level: 'warn',
            text: `压缩后上下文仍占用 ${((postEstimate / this.contextWindow) * 100).toFixed(0)}%。建议用 /new 开启新会话。`,
          });
          return;
        }

        this.compactStuck = false;
        this.compactRunning = false;

        // ── 压缩模型埋点 ──
        this.recordCompactionEvent({
          ts: Date.now(),
          regionMsgCount: regionInfo.region.length,
          regionTokensEst: countMessages(regionInfo.region),
          summaryInputTokens: countMessages(regionInfo.region),
          summaryOutputTokens: countText(summary),
          tailMsgCount: this.session.length - regionInfo.tailStart,
          preTokens: estimated,
          postTokens: postEstimate,
          outcome: degraded ? 'digest' : 'summary',
        });
        this._sink({
          kind: EventKind.Notice,
          level: 'info',
          text: `自动压缩完成: ${regionInfo.region.length} 条消息 → 摘要（完整历史仍保留）`,
        });
      })
      .catch((e: any) => {
        if (genAtStart !== this._execState.sessionVersion) {
          this.compactRunning = false;
          return;
        } // 会话已替换，丢弃
        // 失败不闩锁 — 退避重试：失败越多等越久（每级多等 4 条消息，封顶 16 条）。
        // summarizeRegion 内部已有机械摘要兜底，能走到这里的基本只剩
        // 用户中止与极端异常 — 静默退避，仅在逼近窗口上限且连续失败时升级。
        this.compactFailCount++;
        this.compactRunning = false;
        this.compactRetryAfterLen = this.session.length + Math.min(this.compactFailCount, 4) * 4;
        log.warn('agent', `auto-compact failed (${e?.message || e}), backoff #${this.compactFailCount}`);
        if (this.compactFailCount >= 3 && estimated / this.contextWindow >= 0.9) {
          this._sink({
            kind: EventKind.Notice,
            level: 'warn',
            text: '上下文已接近窗口上限，且自动压缩连续多次失败。建议用 /new 开启新会话。',
          });
        }
      });
  }

  /** 对消息区域生成摘要 — map-reduce 分块管线。
   *
   *  硬保证（不存在"塞爆"这个状态）：
   *    每次 LLM 调用的输入 ≤ prompt(≤SUMMARY_PROMPT_BUDGET) + chunkCap，
   *    输出 ≤ SUMMARY_OUTPUT_BUDGET，两者之和严格小于摘要模型窗口；
   *    窗口连最低可行条件都不满足的模型直接走机械摘要，不调 LLM。
   *
   *  降级阶梯（任何环节失败只降质量，管线永不闩死）：
   *    LLM 全量摘要 > 部分块机械提取 > 纯机械提取。
   *
   *  @param priorSummary 来自上次 `<compacted-context>` 块的内容，用于
   *    与新区域合并（累积压缩），若为首次压缩则为 null。
   *  @returns text = 摘要文本；degraded = 是否有环节降级为机械提取 */
  private async summarizeRegion(
    signal: AbortSignal,
    msgs: Message[],
    priorSummary: string | null = null,
  ): Promise<{ text: string; degraded: boolean }> {
    // priorSummary 防御性截断 — 理论上每轮 LLM 输出 ≤ 摘要预算不会无限涨，
    // 但手工编辑/旧版本数据可能异常，超限时保留头部
    if (priorSummary && countText(priorSummary) > SUMMARY_PROMPT_BUDGET - 1000) {
      priorSummary = priorSummary.slice(0, (SUMMARY_PROMPT_BUDGET - 1000) * 4);
    }

    const { window } = await this.summaryProvider();
    const inputBudget = window - SUMMARY_OUTPUT_BUDGET - SUMMARY_PROMPT_BUDGET;
    if (inputBudget < SUMMARY_MIN_INPUT) {
      log.warn('agent', `summary model window too small (${window}) — 走机械摘要`);
      return { text: digestMessages(msgs), degraded: true };
    }
    const chunkCap = Math.floor(inputBudget * 0.8);
    const chunks = chunkMessages(msgs, chunkCap);

    // 单块 — 与旧行为一致：一次调用，priorSummary 直接嵌入 prompt
    if (chunks.length <= 1) {
      try {
        const text = await this.callSummaryLLM(signal, buildSummaryPrompt(priorSummary), renderTranscript(msgs));
        if (!text) throw new Error('empty summary');
        return { text, degraded: false };
      } catch (e: any) {
        if (signal.aborted) throw e; // 用户中止 — 不兜底，直接传播
        log.warn('agent', `summarize LLM failed (${e?.message || e}) — 降级为机械摘要`);
        return { text: digestMessages(msgs), degraded: true };
      }
    }

    // 多块 — map-reduce。块数超上限时最老的块直接机械消化，
    // LLM 预算只花在最新内容上（成本与时延封顶）。
    const partials: string[] = [];
    let degraded = false;
    let startIdx = 0;
    if (chunks.length > SUMMARY_MAX_LLM_CHUNKS) {
      const oldMsgs = chunks.slice(0, chunks.length - SUMMARY_MAX_LLM_CHUNKS).flat();
      partials.push('## 早期历史（机械提取）\n' + digestMessages(oldMsgs));
      startIdx = chunks.length - SUMMARY_MAX_LLM_CHUNKS;
      degraded = true;
    }
    for (let i = startIdx; i < chunks.length; i++) {
      try {
        const text = await this.callSummaryLLM(
          signal,
          buildSummaryPrompt(null, { index: i + 1, total: chunks.length }),
          renderTranscript(chunks[i]),
        );
        if (!text) throw new Error('empty summary');
        partials.push(text);
      } catch (e: any) {
        if (signal.aborted) throw e;
        log.warn('agent', `chunk ${i + 1}/${chunks.length} summary failed (${e?.message || e}) — 该块机械提取`);
        partials.push(digestMessages(chunks[i]));
        degraded = true;
      }
    }
    // mergePartials 只报告合并阶段的降级 — 块阶段的降级必须透传
    const merged = await this.mergePartials(signal, priorSummary, partials, chunkCap);
    return { text: merged.text, degraded: degraded || merged.degraded };
  }

  /** 缓存的摘要模型选择。 */
  private async summaryProvider(): Promise<{ prov: Provider; window: number }> {
    if (!this._summaryProv) this._summaryProv = await this.selectSummaryProvider();
    return this._summaryProv;
  }

  /** 运行时自动选择摘要模型 — 无用户配置项。
   *  规则：已配置 key 覆盖的模型中，窗口 ≥ SUMMARY_MIN_WINDOW 且
   *  输入价严格低于主模型者，取价格最低（窗口大者破平）。
   *  主模型自己参与竞选 — 没有严格占优的候选时维持现状。
   *  只可能在"窗口不小、价格更低"时偏离主模型，永远不会让事情变糟。
   *  ⚡ 2026-08-07 修复：必须走 loadSettingsWithSecrets()——localStorage 不落
   *  key，裸 loadSettings() 让 keyed 永远为空，本特性从未触发过。 */
  private async selectSummaryProvider(): Promise<{ prov: Provider; window: number }> {
    const fallback = { prov: this.prov, window: this.contextWindow };
    try {
      const s = await loadSettingsWithSecrets();
      const active = s.providers.find((p) => p.name === s.activeProvider);
      if (!active) return fallback;
      const all = getAllModels();
      const main = all.find((m) => m.id === active.model);
      const mainWindow = main && main.contextWindow > 0 ? main.contextWindow : this.contextWindow;
      const mainCost = main?.cost?.input ?? Infinity;
      const keyed = new Map(s.providers.filter((p) => p.apiKey?.trim()).map((p) => [p.name, p]));
      const winner = all
        .filter(
          (m) =>
            m.id !== active.model &&
            keyed.has(m.provider) &&
            m.contextWindow >= SUMMARY_MIN_WINDOW &&
            (m.cost?.input ?? 0) > 0 &&
            (m.cost?.input ?? Infinity) < mainCost,
        )
        .sort((a, b) => a.cost.input - b.cost.input || b.contextWindow - a.contextWindow)[0];
      if (!winner) return { prov: this.prov, window: mainWindow };
      const ps = keyed.get(winner.provider)!;
      const prov = createProvider({ ...ps, model: winner.id, thinking: '' }, { disableThinking: true });
      log.info('agent', 'summary model auto-selected', {
        model: winner.id,
        window: winner.contextWindow,
        costIn: winner.cost.input,
        mainModel: active.model,
      });
      return { prov, window: winner.contextWindow };
    } catch (e: any) {
      log.warn('agent', `summary model selection failed (${e?.message || e}) — 使用主模型`);
      return fallback;
    }
  }

  /** 单次摘要 LLM 调用 — 60s 空闲超时守卫（挂起判定，streamWithIdleTimeout），
   *  流仍在产出就让它跑完。max_tokens 固定为输出预算，
   *  配合 chunkCap 构成"永不塞爆"的输入/输出硬上界。 */
  private async callSummaryLLM(signal: AbortSignal, systemPrompt: string, userText: string): Promise<string> {
    const { prov } = await this.summaryProvider();
    const stream = streamWithIdleTimeout(prov, signal, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      tools: [], // 摘要不需要工具
      temperature: 0.3, // 低温用于事实性摘要
      max_tokens: SUMMARY_OUTPUT_BUDGET,
    });

    try {
      let text = '';
      for await (const chunk of stream.chunks) {
        if (chunk.type === ChunkType.Text && chunk.text) {
          text += chunk.text;
        }
        if (chunk.type === ChunkType.Error) throw chunk.err ?? new Error('stream error');
      }
      return text.trim();
    } catch (e: any) {
      if (stream.idleTimedOut && !signal.aborted) {
        log.warn('agent', 'summary LLM call stalled (60s no output) — 该次调用放弃');
      }
      throw e;
    }
  }

  /** 滚动合并分段摘要（含 priorSummary）— 每轮把尽量多段塞进
   *  budgetTokens 内合并为一，直到只剩一段。合并调用失败时
   *  降级为直接拼接（结构化文本拼接本身就是及格的简报）。 */
  private async mergePartials(
    signal: AbortSignal,
    priorSummary: string | null,
    partials: string[],
    budgetTokens: number,
  ): Promise<{ text: string; degraded: boolean }> {
    let texts = [
      ...(priorSummary ? [`<previous-summary>\n${priorSummary}\n</previous-summary>`] : []),
      ...partials,
    ];
    let degraded = false;
    while (texts.length > 1) {
      const group = [texts[0], texts[1]];
      let rest = texts.slice(2);
      while (rest.length && countText(group.join('\n\n---\n\n') + '\n\n---\n\n' + rest[0]) <= budgetTokens) {
        group.push(rest[0]);
        rest = rest.slice(1);
      }
      try {
        const merged = await this.callSummaryLLM(signal, buildMergePrompt(), group.join('\n\n---\n\n'));
        if (!merged) throw new Error('empty merge');
        texts = [merged, ...rest];
      } catch (e: any) {
        if (signal.aborted) throw e;
        log.warn('agent', `merge round failed (${e?.message || e}) — 降级为拼接`);
        texts = [group.join('\n\n---\n\n'), ...rest];
        degraded = true;
      }
    }
    let final = texts[0] ?? '';
    // 防御性封顶 — 拼接路径下摘要可能超长
    if (countText(final) > 8192) final = final.slice(0, 32768) + '\n…(过长摘要已截断)';
    return { text: final, degraded };
  }

  private toolReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly() ?? false;
  }

  // ══════════════════════════════════════════════════════
  // 子 Agent 派生 — 用于并行/委派工作
  // ══════════════════════════════════════════════════════

  /** 派生子 Agent 处理聚焦任务。阻塞直到子 Agent 完成；
   *  子 Agent 的最终报告（加合并备注）成为工具结果。
   *  `mode: 'fork'`（默认）注入父 Agent 的近期上下文并在
   *  git worktree 中隔离文件编辑；`mode: 'fresh'` 是全新 Agent。
   *  中止源合并: 用户停止（当前 run signal）+ pool 停止/超时。 */
  async spawnSubAgent(
    description: string,
    prompt: string,
    onProgress?: (chunk: string) => void,
    mode: 'fork' | 'fresh' = 'fork',
    toolAllowlist?: string[] | null,
    poolSignal?: AbortSignal,
    asyncMode?: boolean,
    agentIdOverride?: string,
  ): Promise<{ text: string; err?: string }> {
    // 基于深度的递归守卫
    if (mode === 'fork' && this._subagentDepth >= Agent.MAX_SUBAGENT_DEPTH) {
      return { text: '', err: `Exceeded max subagent depth (${Agent.MAX_SUBAGENT_DEPTH})` };
    }

    // 合并中止源 — 子 Agent 在用户运行停止或 pool 停止/超时时终止。
    // （旧接线太晚移交 pool signal，导致 "已停止" 的 Agent 继续脱离运行。）
    // async 模式下子 agent 生命周期独立于父单轮 run；
    // sync 模式下父 agent 在等，父被 stop 子 agent 也该 stop
    const abortSources: AbortSignal[] = [];
    if (this._currentRunSignal && !asyncMode) abortSources.push(this._currentRunSignal);
    if (poolSignal) abortSources.push(poolSignal);
    const signal =
      abortSources.length > 1 ? AbortSignal.any(abortSources) : (abortSources[0] ?? new AbortController().signal);

    // 自动隔离: 为 fork 子 Agent 创建 git worktree，使文件修改
    // 被沙箱化并可在合并前审阅（diff）。隔离工具不可用或创建失败时
    // 降级为直接模式。
    let isolationId: string | null = null;
    if (mode === 'fork' && this.tools.get('agent_isolation_create')) {
      isolationId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const createT = this.tools.get('agent_isolation_create');
        if (createT) await createT.execute({ agent_id: isolationId });
      } catch {
        isolationId = null;
      }
    }

    // 从父 Agent 克隆工具 — 如指定则应用允许列表过滤
    const subTools = new ToolRegistry();
    const allowed = toolAllowlist && toolAllowlist.length > 0 ? new Set(toolAllowlist) : null;
    for (const t of this.tools.all()) {
      if (!allowed || allowed.has(t.name())) {
        subTools.register(t);
      }
    }
    // 子 Agent 永远不获得递归派生工具（fork 子 Agent 直接执行）。
    subTools.unregister('agent_spawn');
    // 子 Agent 不能杀死兄弟 — 只有父 Agent 能杀死子 Agent。
    subTools.unregister('agent_kill');
    // Pool 可观测性也是父 Agent 的职责 — 子 Agent 不获得 agent_status。
    subTools.unregister('agent_status');

    // 用子 Agent 自己的 id 重新注册 discovery 工具 — 克隆的
    // 工具的 getAgentId 闭包捕获的是父 Agent 的 id，会导致
    // archive() 永远匹配不上（onFinish 传的是子 Agent 的模型可见 id）。
    if (this._discoveryBoard) {
      const subDiscId = agentIdOverride ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      for (const tool of createDiscoveryTools(this._discoveryBoard, () => subDiscId)) {
        subTools.unregister(tool.name());
        subTools.register(tool);
      }
    }

    // ── 硬性阻止子 Agent 执行构建/测试命令 ──
    // 这些命令并行运行时会争抢文件锁（cargo target/、node_modules/、
    // .git/index.lock），导致死锁或超时。
    // 子 Agent 应完成文件修改并报告改了什么；
    // 父 Agent 在所有子 Agent 完成后统一运行验证。
    const BUILD_TEST_RE = /\b(?:cargo|npm|npx|pnpm|yarn|make|docker|rustc|tsc|gradle|gradlew|mvn|mvnw|cmake|pytest|dotnet|xcodebuild|zig)\b|go\s+(?:build|test|vet|run)|python\s+-m\s+pytest/;
    const shellTool = subTools.get('run_shell');
    if (shellTool) {
      const origShellExec = shellTool.execute.bind(shellTool);
      subTools.unregister('run_shell');
      subTools.register(wrapTool(shellTool, async (args, onProgress) => {
        const cmd = (args.command as string) || '';
        if (BUILD_TEST_RE.test(cmd)) {
          return `[已拦截] 子 Agent 不允许执行构建/测试/包管理命令（"${cmd.slice(0, 100)}"）。\n` +
            `原因：并行子 Agent 同时跑这类命令会争抢文件锁（target/、node_modules/、.git/index.lock 等），导致死锁或超时。\n` +
            `请直接完成文件修改，在结论中说明：你改了哪些文件、建议主 Agent 跑什么命令来验证。`;
        }
        return origShellExec(args, onProgress);
      }));
    }

    // ── fresh 子 Agent 的文件所有权（fork 有 worktree 隔离） ──
    // 先写者声明文件；其他子 Agent 被拒绝。
    // 防止多个 fresh Agent 并发编辑同一工作区时
    // 静默的"后写覆盖先写"。
    if (mode === 'fresh') {
      if (!this._fileOwnership) {
        this._fileOwnership = new FileOwnership();
      }
      const ownership = this._fileOwnership;
      const subAgentId = agentIdOverride ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      for (const toolName of WRITE_TOOLS) {
        const tool = subTools.get(toolName);
        if (!tool) continue;
        const origExec = tool.execute.bind(tool);
        subTools.unregister(toolName);
        subTools.register(wrapTool(tool, async (args, onProgress) => {
          const filePath = extractFilePath(toolName, args);
          if (filePath) {
            const result = ownership.claim(filePath, subAgentId);
            if (!result.ok) {
              return `[已拒绝] 文件 "${filePath}" 正在被另一个子 Agent (${result.owner}) 修改。\n` +
                `原因：并行子 Agent 同时写同一文件会导致后写覆盖先写（静默丢改动）。\n` +
                `请只修改分配给你的文件。如果确实需要改这个文件，在结论中说明，由主 Agent 统一处理。`;
            }
          }
          // move_file also claims the destination
          if (toolName === 'move_file' && args.to) {
            const result = ownership.claim(args.to as string, subAgentId);
            if (!result.ok) {
              return `[已拒绝] 目标路径 "${args.to}" 正在被另一个子 Agent (${result.owner}) 修改。`;
            }
          }
          return origExec(args, onProgress);
        }));
      }
    }

    let subSystem: string;

    if (mode === 'fork') {
      // Fork 模式: 干净的子 Agent，拥有自己的 system prompt（不继承
      // 父 Agent 的会话/system prompt — 那会使 fork 尝试派生自己的
      // 子 Agent）。父 Agent 的近期工具输出作为上下文注入，
      // 使 fork 知道已读取/修改了什么。
      const recentContext = this.extractRecentContext(6);

      subSystem = `你是主Agent派出的工作进程（fork）。你不是主Agent。

## 你的任务
${prompt}

## 硬性规则
1. **直接执行** — 直接读、写、搜索、跑命令。你不能 spawn 子Agent（该工具已移除）
2. **专注** — 只完成分配给你的任务，不要偏离
3. **先查后动** — 涉及代码库的，先查再动手
4. **直接给结论** — 不要反问、不要建议下一步、不要写论文
5. **不跑构建/测试** — 不要跑 cargo / npm / pnpm / make / docker / go build 等任何构建、测试或包管理命令。这些命令在并行环境下会争抢文件锁（如 target/、node_modules/、.git/index.lock），导致死锁或超时。你只负责改文件，验证由主 Agent 在所有子任务完成后统一执行。如果认为改动有风险，在结论里说明即可。
6. **隔离** — 你的文件修改在独立 git worktree 中进行，正常保存即可；任务成功后变更会自动合并回主仓

## 父Agent近期上下文（⚠️ 快照 — 可能已过期。操作前自行验证文件当前状态）
${recentContext}`;
    } else {
      subSystem = `你是主 Agent 派出的子任务 Agent。执行一个聚焦的专项任务。

## 任务
${prompt}

## 规则
1. **全权** — 你有写文件、跑命令、Git 操作的全部权限。放心干。
2. **专注** — 只完成分配给你的任务，不要偏离。
3. **先查后动** — 涉及代码库的，先调图查询工具（hologram_*）再动手。
4. **直接给结论** — 不要反问或延续对话。完成后直接输出结果。
5. **简短** — 输出精炼，不需要写论文。
6. **不跑构建/测试** — 不要跑 cargo / npm / pnpm / make / docker / go build 等任何构建、测试或包管理命令。这些命令在并行环境下会争抢文件锁（如 target/、node_modules/、.git/index.lock），导致死锁或超时。你只负责改文件，验证由主 Agent 统一执行。如果认为改动有风险，在结论里说明即可。

## 可用工具
${subTools
  .all()
  .map((t) => `- **${t.name()}**: ${t.description().slice(0, 100)}`)
  .join('\n')}`;
    }

    // ── 将子 Agent 的事件流交给 UI（workspace 注入的端口构建
    // SubAgentPart 并返回 sink；headless → 空操作 sink） ──
    // 对 UI 和 Agent 都使用 agentIdOverride，使 LLM 可见 ID 匹配
    // board/bus 条目（async 模式返回此 ID 给 LLM）。
    const subAgentId = agentIdOverride ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rawSubSink =
      this._ui.subAgentSpawn?.({ agentId: subAgentId, description, sessionId: this._uiSessionId }, onProgress) ??
      (() => {});
    // 将子 Agent 的事件流分叉到 activity tracker — agent_status 读取它
    // 以报告当前工具调用 + 等待时间（见 subagent-activity.ts）。
    const subSink = wrapSubAgentSink(subAgentId, rawSubSink);

    // 共享 provider，全新会话，不压缩
    const subAgent = new Agent(this.prov, subTools, subSystem, {
      temperature: 0.3,
      subagentDepth: this._subagentDepth + 1,
      contextWindow: this.contextWindow,
      eventSink: subSink,
      agentId: subAgentId,
      parentId: this.id,
      execState: createExecState(),
    });
    if (isolationId) {
      subAgent._isolationId = isolationId;
    }
    // 从父 Agent 继承持久化存储
    if (this.agentStore) {
      subAgent.setAgentStore(this.agentStore);
    }

    // 从父 Agent 继承消息总线 — setBus 处理 register(addr, onWake)
    if (this._bus) {
      subAgent.setBus(this._bus);
    }

    // 注册到 TaskBoard + 文件追踪 hook — 仅 async 模式。
    // Sync 模式不需要 board 追踪（结果直接返回，立即合并）。
    if (this._taskBoard && asyncMode) {
      this._taskBoard.register({
        agentId: subAgent.id,
        parentAgentId: this.id,
        description,
        isolationId,
      });
      const subHooks = new HookRegistry();
      subHooks.register(createBoardTrackingHook(subAgent.id, this._taskBoard));
      subAgent.setHooks(subHooks);
    }

    let subAgentSucceeded = false;
    let result: { text: string; err?: string };
    try {
      // Fork 和 fresh 都使用 run() — fork 有自己的 system prompt + 裁剪后的工具
      await subAgent.run(signal, mode === 'fork' ? prompt : '开始执行。');
      subAgentSucceeded = true;

      // ── 摘要提纯 — 确保子 Agent 交接有用 ──
      // 对低于 300 字符的摘要做单轮续写（"好的，完成了" 的情况）。
      const CONTEXT_LINE_LIMIT = 300;
      const session = subAgent.getSession();
      let lastAssistant = [...session].reverse().find((m) => m.role === 'assistant');
      let summary = lastAssistant?.content || '';

      if (summary.length < CONTEXT_LINE_LIMIT) {
        try {
          const expandPrompt =
            'Please expand your summary: describe exactly what you did, which files you read or modified, what you verified (build/tests), and the outcome. Use at least 200 characters.';
          await subAgent.run(signal, expandPrompt);
          const expandedSession = subAgent.getSession();
          const expanded = [...expandedSession].reverse().find((m) => m.role === 'assistant');
          if (expanded?.content && expanded.content.length > summary.length) {
            lastAssistant = expanded;
            summary = expanded.content;
          }
        } catch {
          /* 摘要提纯失败 — 返回原始摘要 */
        }
      }

      subAgent.saveState('done').catch(() => {});
      result = { text: summary || '(子 Agent 没有生成回复)' };
    } catch (e: any) {
      subAgent.saveState('failed').catch(() => {});
      let errReason: string;
      if (signal.aborted) {
        errReason = `子 Agent 被中止（超时或手动停止）: ${e.message || 'aborted'}`;
      } else if (e.name === 'AbortError' || e.code === 'ABORT_ERR') {
        errReason = `子 Agent 超时: ${e.message || 'aborted'}`;
      } else {
        errReason = e.message || '子 Agent 执行失败（未知原因）';
      }
      result = { text: '', err: errReason };
    } finally {
      this._ui.subAgentFinished?.(subAgentId, this._uiSessionId, subAgentSucceeded);
      removeSubAgentActivity(subAgentId);
      // 释放此子 Agent 的文件所有权声明
      this._fileOwnership?.release(subAgent.id);
    }

    if (asyncMode) {
      // ── Async 模式: 保存 diff 到 board + 通过 bus 通知（不自动合并） ──
      let diffText = '';
      if (isolationId && subAgentSucceeded) {
        try {
          const diffT = this.tools.get('agent_isolation_diff');
          if (diffT) diffText = await diffT.execute({ agent_id: isolationId });
        } catch {
          /* diff 不可用 */
        }
      }

      if (subAgentSucceeded) {
        this._taskBoard?.complete(subAgent.id, result.text || '(无摘要)', diffText);
        // Worktree 保留 — 等 agent_merge 时再处理
      } else if (signal.aborted) {
        this._taskBoard?.stop(subAgent.id);
        // 中止时清理 worktree
        if (isolationId) {
          const discardT = this.tools.get('agent_isolation_discard');
          await discardT?.execute({ agent_id: isolationId }).catch(() => {});
        }
      } else {
        this._taskBoard?.fail(subAgent.id, result.err || '子 Agent 执行失败');
        // 失败时清理 worktree
        if (isolationId) {
          const discardT = this.tools.get('agent_isolation_discard');
          await discardT?.execute({ agent_id: isolationId }).catch(() => {});
        }
      }

      // 通过 bus 通知父 Agent
      if (this._bus) {
        try {
          this._bus.send({
            from: subAgent.id,
            to: this.id,
            type: 'result',
            payload: {
              summary: subAgentSucceeded ? result.text : '',
              success: subAgentSucceeded,
              agentId: subAgent.id,
              error: subAgentSucceeded ? undefined : result.err,
            },
          });
        } catch {
          /* bus 发送失败非致命 */
        }
      }
    } else {
      // ── Sync 模式: 完成隔离 worktree（串行化） ──
      if (isolationId) {
        const mergeNote = await enqueueIsolationOp(() => this._finalizeIsolation(isolationId, subAgentSucceeded));
        if (mergeNote) {
          result = { text: (result.text ? result.text + '\n\n' : '') + mergeNote, err: result.err };
        }
      }
      // Sync 模式: 未创建 board 条目（仅 async 模式创建），无需清理
    }

    // 所有完成处理后从 bus 注销子 Agent
    if (this._bus) {
      this._bus.unregister(subAgent.id);
    }
    return result;
  }

  /** 合并（成功时）或丢弃（失败时）隔离 worktree。
   *  返回可追加到子 Agent 结果的可读备注。 */
  private async _finalizeIsolation(agentId: string, success: boolean): Promise<string> {
    const diffT = this.tools.get('agent_isolation_diff');
    const mergeT = this.tools.get('agent_isolation_merge');
    const discardT = this.tools.get('agent_isolation_discard');
    try {
      if (success && mergeT) {
        try {
          await mergeT.execute({ agent_id: agentId });
          await discardT?.execute({ agent_id: agentId }).catch(() => {});
          return '[隔离合并] ✅ 变更已自动合并回主仓。可用 git_status / git_diff 审阅。';
        } catch (mergeErr: any) {
          const errMsg = mergeErr?.message || String(mergeErr);
          log.warn('agent', `merge conflict for ${agentId}: ${errMsg}`);
          // 在丢弃 worktree 前捕获 diff — 否则
          // 子 Agent 的工作会静默丢失。
          let diffText = '';
          try {
            if (diffT) diffText = await diffT.execute({ agent_id: agentId });
          } catch {
            /* diff 不可用 */
          }
          await discardT?.execute({ agent_id: agentId }).catch(() => {});
          const clipped = diffText.length > 8000 ? diffText.slice(0, 8000) + '\n…[diff 过长已截断]' : diffText;
          return (
            `[隔离合并] ⚠️ 自动合并失败: ${errMsg}\n` +
            'worktree 已清理，但变更 diff 已保全在下方。请审阅后用 edit_file 把需要的部分手动应用到主仓:\n\n' +
            (clipped || '(diff 获取失败)')
          );
        }
      }
      // 子 Agent 失败/中止 — 丢弃 worktree，无需合并。
      await discardT?.execute({ agent_id: agentId }).catch(() => {});
      return '';
    } catch {
      return ''; // 尽力而为 — 清理失败不得中断结果流
    }
  }
}

// 隔离合并/丢弃的序列化在 isolation-queue.ts 中
// （与 merge.ts 共享 — 并发 git 操作会争抢 index lock）。

// ---- 辅助函数 ----

interface ToolOutcome {
  output: string;
  errMsg?: string;
  blocked: boolean;
  truncated: boolean;
  truncMsg?: string;
}

function batchStormSignature(calls: ToolCall[], outcomes: ToolOutcome[]): { sig: string; ok: boolean } {
  if (calls.length === 0) return { sig: '', ok: false };
  const parts: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (!outcomes[i].errMsg || outcomes[i].blocked) return { sig: '', ok: false };
    parts.push(`${calls[i].name}\x00${outcomes[i].errMsg}`);
  }
  return { sig: parts.join('\x00'), ok: true };
}

/** 从工具调用参数中提取文件路径（read_file_content / read_file）。
 *  同时容忍 filePath 和 file_path 键；任何失败返回 null。 */
function parseFilePathArg(argsJson: string | undefined): string | null {
  try {
    const a = JSON.parse(argsJson || '{}');
    const fp = a.filePath ?? a.file_path;
    return typeof fp === 'string' && fp.length > 0 ? fp : null;
  } catch {
    return null;
  }
}

function finishReasonMessage(u?: Usage): string | undefined {
  if (!u) return undefined;
  switch (u.finish_reason) {
    case 'length':
      return 'response truncated: hit max output tokens';
    case 'content_filter':
      return 'response blocked by content filter';
    default:
      return undefined;
  }
}

function renderTranscript(msgs: Message[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    switch (m.role) {
      case 'user':
        lines.push(`[用户]\n${m.content || ''}\n`);
        break;
      case 'assistant': {
        if (m.content) lines.push(`[助手]\n${m.content}`);
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            lines.push(`[助手调用 ${tc.name}] ${tc.arguments}`);
          }
        }
        lines.push('');
        break;
      }
      case 'tool':
        lines.push(`[工具 ${m.name || ''} 结果]\n${m.content || ''}\n`);
        break;
      case 'system':
        lines.push(`[系统]\n${m.content || ''}\n`);
        break;
      default:
        lines.push(`[${m.role}]\n${m.content || ''}\n`);
        break;
    }
  }
  return lines.join('\n');
}
// ══════════════════════════════════════════════════════
// 上下文压缩 — 分块 / 机械摘要 / prompt 构建
// ══════════════════════════════════════════════════════

/** 摘要调用的输出预算（token）— 固定上界。配合 chunkCap 保证
 *  每次调用 输入+输出 严格小于摘要模型窗口（"永不塞爆"的硬上界）。 */
const SUMMARY_OUTPUT_BUDGET = 2048;
/** prompt 预算：摘要指令 + 合并指令 + priorSummary 预留。 */
const SUMMARY_PROMPT_BUDGET = 4000;
/** 摘要模型最低窗口 — 低于此值切块会碎到失去意义，直接无参选资格。 */
const SUMMARY_MIN_WINDOW = 64_000;
/** 单次调用至少要的输入预算 — 不足说明窗口不可行，走纯机械摘要。 */
const SUMMARY_MIN_INPUT = 4000;
/** LLM 处理的最多块数 — 超出时最老的块走机械提取（成本/时延封顶）。 */
const SUMMARY_MAX_LLM_CHUNKS = 8;

/** 摘要 prompt — 单块时 priorSummary 直接嵌入（与旧行为一致）；
 *  分块时告知 LLM 这是第几段，只总结本段。 */
function buildSummaryPrompt(priorSummary: string | null, chunkInfo?: { index: number; total: number }): string {
  const mergeInstruction = priorSummary
    ? `\n以下是在本次压缩之前生成的会话背景简报。新消息可能覆盖或补充其中的内容——合并时以新消息为准，未变的旧事实直接保留：\n\n<previous-summary>\n${priorSummary}\n</previous-summary>`
    : '';
  const chunkInstruction = chunkInfo
    ? `\n注意：以下是完整历史的第 ${chunkInfo.index}/${chunkInfo.total} 段（按时间顺序）。只总结本段内容，不要推测其他分段。`
    : '';

  return `你是对话压缩器。把以下编码 Agent 的对话历史浓缩为一份简报。Agent 只会保留你的摘要（原始消息会被丢弃），因此必须能从摘要中恢复任务。

按这些标题写（没有内容的标题可以省略）：

## 目标
用户的需求和意图，尽量用用户的措辞。包含明确的约束和偏好。

## 决策与理由
已做出的关键选择及原因——避免被推翻或重复争论。

## 文件与代码
读取或修改过的文件，包含具体事实：签名、位置、数据形状、应用的具体编辑。

## 命令与结果
执行过的命令（构建、测试、git）及结果——哪些通过、哪些失败、错误信息。

## 错误与修复
遇到的问题及解决方式（或未解决），避免走重复的弯路。

## 待办与下一步
仍在进行中或未开始的工作，以及最具体的下一个行动。

规则：简洁——用要点和片段而非散文。准确保留标识符、路径和数字。不编造任何不存在于消息中的内容。${chunkInstruction}${mergeInstruction}`;
}

/** 合并 prompt — 把多份分段简报（可能含 previous-summary）合并为一份。 */
function buildMergePrompt(): string {
  return `你是对话压缩器。以下是同一编码 Agent 会话历史的多份分段简报（按时间顺序排列，可能包含一份 <previous-summary> 背景简报）。把它们合并成一份连贯简报——Agent 将仅凭它恢复任务。

按这些标题写（没有内容的标题可以省略）：

## 目标
用户的需求和意图，尽量用用户的措辞。包含明确的约束和偏好。

## 决策与理由
已做出的关键选择及原因——避免被推翻或重复争论。

## 文件与代码
读取或修改过的文件，包含具体事实：签名、位置、数据形状、应用的具体编辑。

## 命令与结果
执行过的命令（构建、测试、git）及结果——哪些通过、哪些失败、错误信息。

## 错误与修复
遇到的问题及解决方式（或未解决），避免走重复的弯路。

## 待办与下一步
仍在进行中或未开始的工作，以及最具体的下一个行动。

规则：相同事实去重；事实冲突时以靠后的分段为准；未变的旧事实直接保留。简洁——用要点和片段而非散文。准确保留标识符、路径和数字。不编造任何不存在于输入中的内容。`;
}

/** 把消息区域按 token 上限切成块（map-reduce 的 map 输入）。
 *  单条消息超限时先"炸开"为转录片段再切 — 任何消息形状
 *  都能被装进 capTokens 内，这是"永不塞爆"的第一道保证。 */
function chunkMessages(msgs: Message[], capTokens: number): Message[][] {
  const exploded: Message[] = [];
  for (const m of msgs) {
    if (countMessage(m) <= capTokens) {
      exploded.push(m);
    } else {
      exploded.push(...explodeTranscript(m, capTokens));
    }
  }
  const chunks: Message[][] = [];
  let cur: Message[] = [];
  let curTokens = 0;
  for (const m of exploded) {
    const t = countMessage(m);
    if (cur.length > 0 && curTokens + t > capTokens) {
      chunks.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(m);
    curTokens += t;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** 把超限单条消息炸开为若干 ≤ capTokens 的转录片段消息。
 *  按行累积（精确 countText）；单行仍超限时按字符硬切，
 *  步长 capTokens/2 字符 — 任何语言都低于 token 上界。 */
function explodeTranscript(m: Message, capTokens: number): Message[] {
  const out: Message[] = [];
  let cur = '';
  const pushFrag = (text: string) => out.push({ role: 'user' as const, content: `[历史转录片段]\n${text}` });
  for (const line of renderTranscript([m]).split('\n')) {
    if (countText(line) > capTokens) {
      if (cur) {
        pushFrag(cur);
        cur = '';
      }
      const step = Math.max(500, Math.floor(capTokens / 2));
      for (let i = 0; i < line.length; i += step) pushFrag(line.slice(i, i + step));
      continue;
    }
    if (cur && countText(cur + '\n' + line) > capTokens) {
      pushFrag(cur);
      cur = '';
    }
    cur = cur ? cur + '\n' + line : line;
  }
  if (cur) pushFrag(cur);
  return out;
}

/** 机械摘要 — 不依赖任何 LLM/key/窗口的本地兜底。
 *  从消息里机械提取结构化简报：用户目标、文件读写、命令与退出码、
 *  错误、工具使用统计、最近助手结论。瞬时、零 token、永不超时。
 *  质量低于 LLM 摘要，但保证压缩管线在任何失败下都能落地。 */
function digestMessages(msgs: Message[]): string {
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const commands: string[] = [];
  const errors: string[] = [];
  const toolCounts = new Map<string, number>();
  const callInfo = new Map<string, { name: string; args: Record<string, unknown> }>();
  const SHELL_TOOLS = new Set(['run_shell', 'exec_command']);
  let firstUser = '';
  let lastUser = '';
  let lastAssistant = '';

  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
  const firstLine = (s: string) => s.split('\n').find((l) => l.trim()) ?? '';

  for (const m of msgs) {
    if (m.role === 'user' && m.content && !m.content.startsWith('<compacted-context>')) {
      if (!firstUser) firstUser = m.content;
      lastUser = m.content;
    }
    if (m.role === 'assistant') {
      if (m.content) lastAssistant = m.content;
      for (const tc of m.tool_calls ?? []) {
        toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || '{}');
        } catch {}
        callInfo.set(tc.id, { name: tc.name, args });
        if (tc.name === 'read_file_content' || tc.name === 'read_file') {
          const fp = parseFilePathArg(tc.arguments);
          if (fp) filesRead.add(fp);
        } else if (WRITE_TOOLS.has(tc.name)) {
          const fp = extractFilePath(tc.name, args);
          if (fp) filesWritten.add(fp);
        } else if (SHELL_TOOLS.has(tc.name)) {
          const cmd = String(args.command || args.cmd || '').trim();
          // 相邻去重 — 重试场景下同一命令常连续出现
          if (cmd && commands[commands.length - 1] !== cmd) commands.push(cmd);
        }
      }
    }
    if (m.role === 'tool') {
      const info = m.tool_call_id ? callInfo.get(m.tool_call_id) : undefined;
      const content = m.content || '';
      if (info && SHELL_TOOLS.has(info.name)) {
        const exitMatch = /\[exit (-?\d+)\]/.exec(content.slice(0, 40));
        if (exitMatch && exitMatch[1] !== '0' && errors.length < 10) {
          const cmd = String(info.args.command || info.args.cmd || '');
          errors.push(`\`${trunc(cmd, 80)}\` → exit ${exitMatch[1]}: ${trunc(firstLine(content), 160)}`);
        }
      } else if (errors.length < 10 && /错误|失败|error[: ]|failed|panic/i.test(content.slice(0, 300))) {
        errors.push(`${info?.name ?? 'tool'}: ${trunc(firstLine(content), 160)}`);
      }
    }
  }

  const sections: string[] = [];
  if (firstUser) {
    let goal = `## 目标（用户原话摘录）\n${trunc(firstUser, 400)}`;
    if (lastUser && lastUser !== firstUser) goal += `\n\n最近要求: ${trunc(lastUser, 300)}`;
    sections.push(goal);
  }
  if (filesRead.size > 0 || filesWritten.size > 0) {
    const lines: string[] = ['## 文件操作'];
    if (filesRead.size > 0) lines.push(`- 读取: ${[...filesRead].slice(0, 20).join(', ')}`);
    if (filesWritten.size > 0) lines.push(`- 修改: ${[...filesWritten].slice(0, 20).join(', ')}`);
    sections.push(lines.join('\n'));
  }
  if (commands.length > 0) {
    sections.push(`## 命令执行\n${commands.slice(0, 15).map((c) => `- \`${trunc(c, 100)}\``).join('\n')}`);
  }
  if (errors.length > 0) {
    sections.push(`## 错误\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
  if (toolCounts.size > 0) {
    const top = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, n]) => `${name} ×${n}`)
      .join(', ');
    sections.push(`## 工具使用\n${top}`);
  }
  if (lastAssistant) {
    sections.push(`## 最近助手结论\n${trunc(lastAssistant, 600)}`);
  }
  return sections.length > 0 ? sections.join('\n\n') : '（无有效内容）';
}
