// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// agent loop 契约（平台化 Phase 5 · D13，2026-08-28）——流式循环从 Agent
// 特权本体降为**第一方默认实现**：契约上可替换（ctx.agentLoop 注册表，
// 后注册胜），Agent 接口不变，扩展方只依赖本包的接口（AgentLoop/
// AgentLoopHost），不 import 默认实现内部（守卫测试 grep 归零）。
//
// AgentLoopHost = loop 体对 Agent 的全部依赖面（由 Agent._loopHost() 以
// 闭包构建——私有成员不出类，行为逐字节一致）。接口成员命名去掉下划线
// 前缀（宿主面是 loop 的公开契约，不是 Agent 内部命名）。
//
// 替换契约：第三方通常不替换 loop（事件/服务才是扩展面），但可以——
// register 一个 AgentLoop 即接管 turn/step/request/tool 全生命周期。

import type { Message, Provider, ResponsesOutputItem, ToolCall, Usage } from '../../provider/types';
import type { AgentEvent, AgentUINotifier } from '../agent-types';
import type { CompactionTracker } from '../compaction-tracker';
import type { AgentEventBus } from '../events';
import type { HookRegistry, PreflightHookRegistry } from '../hooks';
import type { MessageBus } from '../message-contract';
import type { PlanGate } from '../plan/plan-registry';
import type { PreStepRegistry } from '../pre-step';
import type { SessionLog } from '../session-log';
import type { StreamingToolExecutor } from '../streaming-executor';
import type { TokenRequestRecord } from '../token-meter';
import type { ToolRegistry } from '../tool';

/** loop 一次流式请求的产物（Agent.stream 的返回形状）。 */
export interface LoopStreamResult {
  text: string;
  reasoning: string;
  signature: string;
  calls: ToolCall[];
  usage: Usage | undefined;
  err: Error | undefined;
  /** token 计量记录（2026-09-13）：Agent 侧已入账，此处带回 loop 以便随
   *  Usage 事件投给 UI。第三方 loop 不提供时 UI 计量面缺一条（不影响执行）。 */
  token?: TokenRequestRecord | undefined;
  /** Responses 方言（v47）：本轮 `response.output` 原样带回——loop 把它写进
   *  assistant 轮的 `responses_items` 留档，下一轮请求据此回放 reasoning 项
   *  （漏掉时带 tools 的请求被服务端 400）。其它方言恒缺省。 */
  responses_items?: ResponsesOutputItem[] | undefined;
}

/** loop 体对宿主 Agent 的依赖面（Agent._loopHost() 构建）。
 *  成员分三类：稳定引用（对象/方法——引用即活值）、可变标量（get/set——
 *  闭包穿透保活性）、loop 专属状态。 */
export interface AgentLoopHost {
  // ── 稳定引用 ──
  readonly id: string;
  readonly prov: Provider;
  readonly tools: ToolRegistry;
  readonly hooks: HookRegistry | null;
  readonly preflightHooks: PreflightHookRegistry | null;
  /** 步前裁决面（agent-hooks-plan 一期）——每步入场直读；null = 未接面
   *  （子 Agent 不接）⇒ 直通 enter。第三方 loop 不读 = 零影响。 */
  readonly preStep: PreStepRegistry | null;
  /** 隔离 worktree id（null = 主仓）。 */
  readonly isolationId: string | null;
  readonly planGate: PlanGate;
  readonly loopEvents: AgentEventBus;
  readonly sessionLog: SessionLog;
  readonly bus: MessageBus | null;
  readonly injectedMsgIds: Set<string>;
  readonly ui: AgentUINotifier;
  readonly planState: { state: { active: boolean; planFilePath: string | null; id: string | null } } | null; // PlanStateManager 结构子集（loop 只读 active/planFilePath）
  readonly planInjector: {
    getReminder(
      step: number,
      state: { active: boolean; planFilePath: string | null; id: string | null },
      planContent: string,
    ): string | null;
  } | null;
  readonly compactionTracker: CompactionTracker;
  readonly contextWindow: number;
  readonly pendingInserts: readonly string[];

  // ── 方法（宿主能力）──
  sink(ev: AgentEvent): void;
  appendMessage(kind: 'user/message' | 'assistant/text' | 'tool/result', message: Message): void;
  stream(signal: AbortSignal, turn: number, executor?: StreamingToolExecutor): Promise<LoopStreamResult>;
  /** 步骤边界（v44，2026-09-20 landmine L3 拆弹）：loop 每步入场调一次——
   *  **一次调用两件事**：① 记一次「无进展看门狗」的脉搏（步骤边界是天然脉搏点）；
   *  ② 栅栏裁决 —— 返回 `false` = 本轮已被硬截止**作废**，loop 必须立刻停止
   *  （`throw host.abandonedError(signal)`，别当普通失败再试一步）。
   *  **缺省（第三方 loop 不调）= 该轮的脉搏只剩 chunk 到达与工具结果落盘两条**
   *  ——不需要它也能跑（看门狗照常兜底），只是「模型在长时间思考、工具还没结果」
   *  的窗口少了步骤这一路脉搏（误判方向是**更晚**作废，不会误杀）。 */
  stepBoundary(signal: AbortSignal): boolean;
  /** 本轮被硬截止作废时的**具名错误**（v44）——`stepBoundary` 返回 false 之后
   *  照抛它，别自己拼文案：调用方（`Agent.run` 调用面 / chat-core 墓碑）认的是
   *  `RunDeadlineExceededError` 这个类型与它携带的 runId / 无进展时长 / 最后脉搏。
   *  未作废时调用 = 抛一个诚实报错（调用点错了，错误不静默）。 */
  abandonedError(signal: AbortSignal): Error;
  /** 栅栏**纯读法**（v44；无副作用，与 `stepBoundary` 分开的理由在此）：
   *  「本轮是不是已经被硬截止作废了」——给「不该再产生新事实」的写入点用
   *  （如分发前的 `tool/call` 审计补落；一旦作废，那条审计也不该再写）。 */
  isAbandoned(signal: AbortSignal): boolean;
  tokenCountWithEstimation(): number;
  compactNow(signal: AbortSignal): Promise<string>;
  /** 自动压缩入口（step 前 pre-flight 主触发）— 尾部按 retainRatio token
   *  预算保留完整 user 回合（对齐 DSH 自动压力路径；compactNow 是手动
   *  路径，保留 recentKeep 条）。 */
  compactIfNeeded(signal: AbortSignal): Promise<string>;
  maybeCompact(usage: Usage | undefined): void;
  /** 当前触发水位（compactRatio，占 contextWindow 比例）— pre-flight 判定读它。 */
  compactRatioOf(): number;
  stormNudge(calls: ToolCall[], resultsByCallId: Map<string, { output: string; err?: string }>): string | null;
  diagTokenBreakdown(apiUsage: Usage | undefined): void;
  toolReadOnly(name: string): boolean;
  applyPendingInserts(): void;
  applyPendingMemoryUpdates(): void;
  injectInbox(): void;
  injectDiscoveries(): void;
  onMessageDelivered(): Promise<void>;

  // ── 可变标量（get/set 闭包——活性由 Agent 侧字段保证）──
  // ⚡ 契约 v43（2026-09-20 运行态收口）：`isRunning` 成员**已移除**——「这卷在不在跑」
  //   的唯一事实是运行账（execution-state.ts 的 RunRecord；`Agent.isRunning` 派生自它）。
  //   loop 只管跑，不再声明自己的运行状态：旧契约由 loop 的 finally 写 `host.isRunning
  //   = false`，而 loop 的 finally 早于调用方收尾（默认 loop 的「延迟唤醒」微任务序），
  //   旧轮收尾把新轮刚点亮的状态清掉 = 「会话在跑而创作坞丢运行态」那一族病灶的载体。
  //   第三方 loop 若仍写 `host.isRunning`：JS 侧只是给宿主对象挂了个无主属性（no-op），
  //   运行态不再受其影响。变更四步见 composition/contract-version.ts（v43）。
  // ⚡ 契约 v44（2026-09-20 运行看门狗 = landmine L3 拆弹）：**新增成员
  //   `stepBoundary(signal): boolean`**（方法区，见上方成员注）。语义增量为零：
  //   不调它的第三方 loop 照旧跑（脉搏少一路，误判方向是更晚作废，不误杀）；调了
  //   的 loop 在硬截止作废后能**主动停步**。同版 `Agent.run()` 加硬截止竞速
  //   （`RunDeadlineExceededError`）。变更四步见 composition/contract-version.ts（v44）。
  get currentRunSignal(): AbortSignal | null;
  set currentRunSignal(v: AbortSignal | null);
  get transientReminders(): string[];
  set transientReminders(v: string[]);
  get compactStuck(): boolean;
  get compactRunning(): boolean;
  get cacheHitTotal(): number;
  set cacheHitTotal(v: number);
  get cacheMissTotal(): number;
  set cacheMissTotal(v: number);
  get lastUsage(): Usage | undefined;
  set lastUsage(v: Usage | undefined);
}

/** 可替换的 agent loop（D13 seam）。id = 注册表寻址面（后注册胜）。 */
export interface AgentLoop {
  id: string;
  run(host: AgentLoopHost, signal: AbortSignal): Promise<void>;
}
