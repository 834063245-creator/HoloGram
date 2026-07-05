// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Shared agent types — extracted from agent.ts to avoid circular imports
// between agent.ts and streaming-executor.ts.

import type { Usage } from '../provider/types';

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
}

export interface Pricing {
  cache_hit: number;  // per 1M tokens
  input: number;      // per 1M tokens
  output: number;     // per 1M tokens
  currency: string;
}

export function computeCost(p: Pricing | undefined, u: Usage | undefined): number {
  if (!p || !u) return 0;
  return (u.cache_hit_tokens * p.cache_hit +
    u.cache_miss_tokens * p.input +
    u.completion_tokens * p.output) / 1_000_000;
}

/** Sink receives the agent's typed event stream. */
export type EventSink = (event: AgentEvent) => void;
