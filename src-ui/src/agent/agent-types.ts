// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Shared agent types — extracted from agent.ts to avoid circular imports
// between agent.ts and streaming-executor.ts.

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
  cache_hit: number; // per 1M tokens
  input: number; // per 1M tokens
  output: number; // per 1M tokens
  currency: string;
}

export function computeCost(p: Pricing | undefined, u: Usage | undefined): number {
  if (!p || !u) return 0;
  return (
    (u.cache_hit_tokens * p.cache_hit + u.cache_miss_tokens * p.input + u.completion_tokens * p.output) / 1_000_000
  );
}

/** Sink receives the agent's typed event stream. */
export type EventSink = (event: AgentEvent) => void;

/** UI notification port — injected by the workspace so the agent core never
 *  imports UI modules (one-way boundary: ui → agent, never agent → ui).
 *  All members optional; a headless agent simply gets none. */
export interface AgentUINotifier {
  /** Loop progress (drives the status bar). */
  progress?(step: number, toolName: string): void;
  /** A tool call finished (panels auto-refresh). */
  toolDone?(toolName: string, args: Record<string, unknown>, output: string): void;
  /** A sub-agent is starting. The UI builds its render state here and returns
   *  the EventSink the child agent should stream into (undefined → no-op sink).
   *  sessionId identifies the UI session that owns this sub-agent's output. */
  subAgentSpawn?(
    info: { agentId: string; description: string; sessionId: number },
    onProgress?: (chunk: string) => void,
  ): EventSink | undefined;
  /** Agent 运行状态变更（idle ↔ running） */
  onStatusChange?(running: boolean): void;
  /** Sub-agent finished — UI finalizes its render state. */
  subAgentFinished?(agentId: string, sessionId: number, ok: boolean): void;
  /** Agent's session array has been replaced (compaction / retract / setSession).
   *  ChatCore needs to rebuild its ChatMessage[] projection. */
  sessionReplaced?(messages: Message[]): void;
}
