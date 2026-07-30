// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 共享 agent 类型 — 从 agent.ts 中提取，避免 agent.ts 和 streaming-executor.ts 之间的循环依赖。

import type { Message, Usage } from '../provider/types';

export enum EventKind {
  TurnStarted = 'turn_started',
  Reasoning = 'reasoning',
  Text = 'text',
  Message = 'message',
  ToolDispatch = 'tool_dispatch',
  ToolResult = 'tool_result',
  ToolProgress = 'tool_progress',
  Usage = 'usage',
  Notice = 'notice',
  SessionChanged = 'session_changed',
  PlanReview = 'plan_review',
}

export interface ToolEvent {
  id: string;
  name: string;
  args?: string;
  output?: string;
  err?: string;
  read_only: boolean;
  partial?: boolean;
  truncated?: boolean;
}

export interface PlanReviewEvent {
  planFilePath: string;
  planContent: string;
  options?: { label: string; description: string }[];
  callback: (response: import('./plan/plan-tools').PlanApprovalResponse) => void;
}

export interface AgentEvent {
  kind: EventKind;
  text?: string;
  reasoning?: string;
  tool?: ToolEvent;
  usage?: Usage;
  pricing?: Pricing;
  session_hit?: number;
  session_miss?: number;
  level?: 'info' | 'warn' | 'error';
  plan?: PlanReviewEvent;
}

export interface Pricing {
  cache_hit: number; // 每 1M tokens
  input: number; // 每 1M tokens
  output: number; // 每 1M tokens
  currency: string;
}

export function computeCost(p: Pricing | undefined, u: Usage | undefined): number {
  if (!p || !u) return 0;
  return (
    (u.cache_hit_tokens * p.cache_hit + u.cache_miss_tokens * p.input + u.completion_tokens * p.output) / 1_000_000
  );
}

/** Sink 接收 agent 的类型化事件流。 */
export type EventSink = (event: AgentEvent) => void;

/** UI 通知端口 — 由 workspace 注入，使 agent 核心永远不
 *  导入 UI 模块（单向边界：ui → agent，绝无 agent → ui）。
 *  所有成员可选；headless agent 不需要任何通知。 */
export interface AgentUINotifier {
  /** 循环进度（驱动状态栏）。 */
  progress?(step: number, toolName: string): void;
  /** 工具调用完成（面板自动刷新）。 */
  toolDone?(toolName: string, args: Record<string, unknown>, output: string): void;
  /** 子 Agent 启动中。UI 在此构建其渲染状态，并返回
   *  子 agent 应流式输出的 EventSink（undefined → 空操作 sink）。
   *  sessionId 标识拥有此子 Agent 输出的 UI 会话。 */
  subAgentSpawn?(
    info: { agentId: string; description: string; sessionId: number },
    onProgress?: (chunk: string) => void,
  ): EventSink | undefined;
  /** Agent 运行状态变更（idle ↔ running） */
  onStatusChange?(running: boolean): void;
  /** 子 Agent 完成 — UI 完成其渲染状态。 */
  subAgentFinished?(agentId: string, sessionId: number, ok: boolean): void;
  /** Agent 的会话数组已被替换（压缩 / 撤回 / setSession）。
   *  ChatCore 需要重建其 ChatMessage[] 投影。 */
  sessionReplaced?(messages: Message[]): void;
}
