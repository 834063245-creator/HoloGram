// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 抽象层 — 统一 Message / Chunk / ToolCall，抹平 Anthropic 和 OpenAI 的 API 差异

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  /** thinking-mode chain-of-thought, round-tripped on multi-turn */
  reasoning_content?: string;
  /** opaque provider-issued proof for reasoning (Anthropic thinking signature) */
  reasoning_signature?: string;
  /** set by assistant */
  tool_calls?: ToolCall[];
  /** links a tool result to its call */
  tool_call_id?: string;
  /** tool message: tool name */
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface Request {
  messages: Message[];
  tools: ToolSchema[];
  temperature: number;
  max_tokens: number;
}

export enum ChunkType {
  Text = 0,
  Reasoning = 1,
  ToolCallStart = 2,
  ToolCall = 3,
  Usage = 4,
  Done = 5,
  Error = 6,
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  reasoning_tokens: number;
  finish_reason: string; // "stop", "tool_calls", "length", "content_filter"
}

export interface Chunk {
  type: ChunkType;
  text?: string;
  signature?: string; // ChunkReasoning: Anthropic thinking signature
  tool_call?: ToolCall; // ChunkToolCallStart (id+name only) or ChunkToolCall (complete)
  usage?: Usage;
  err?: Error;
}

/** Provider is a chat-capable model backend. */
export interface Provider {
  name(): string;
  /** Start a streaming completion, yielding chunks. Cancelling signal aborts. */
  stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk>;
}

// ---- Tool pairing sanitization ----

const interruptedToolResult =
  '[no result: the previous turn was interrupted before this tool call completed]';

/** Repair history so every assistant tool_calls has matching tool messages. */
export function sanitizeToolPairing(msgs: Message[]): Message[] {
  const out: Message[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool') j++;
      out.push(m);
      out.push(...pairToolResults(m.tool_calls, msgs.slice(i + 1, j)));
      i = j;
      continue;
    }
    if (m.role === 'tool') {
      i++; // orphan tool message — drop
      continue;
    }
    // Skip empty assistant messages — DeepSeek rejects them
    if (m.role === 'assistant' && !m.content && (!m.tool_calls || m.tool_calls.length === 0)) {
      i++;
      continue;
    }
    out.push(m);
    i++;
  }
  return out;
}

function pairToolResults(calls: ToolCall[], available: Message[]): Message[] {
  return calls.map((tc) => {
    const found = available.find((r) => r.tool_call_id === tc.id);
    if (found) return found;
    return {
      role: 'tool' as Role,
      tool_call_id: tc.id,
      name: tc.name,
      content: interruptedToolResult,
    };
  });
}
