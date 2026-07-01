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

// ---- Error classification ----

/** 把 raw error 映射成人能看懂的分类和操作建议。 */
export function classifyError(name: string, status: number, body: string, fetchErr?: string): string {
  const b = body.toLowerCase();

  // 网络层
  if (status === 0) {
    if (fetchErr?.includes('ISO-8859-1') || fetchErr?.includes('headers'))
      return `[用户输入错误] Key 或 URL 中包含中文/特殊字符（HTTP header 只允许英文和数字）。请检查设置里的 Key 和地址是否误粘贴了全角符号、中文逗号、空格等。`;
    if (fetchErr?.includes('ENOTFOUND') || fetchErr?.includes('getaddrinfo'))
      return `[网络问题] 无法解析 "${name}" 的地址，请检查 URL 是否正确。`;
    if (fetchErr?.includes('ECONNREFUSED') || fetchErr?.includes('ECONNRESET'))
      return `[网络问题] 无法连接 "${name}"，请检查地址和网络。`;
    if (fetchErr?.includes('ETIMEDOUT'))
      return `[网络问题] 连接 "${name}" 超时，请检查地址或稍后重试。`;
    if (fetchErr?.includes('aborted'))
      return `[已取消] 请求被手动中止。`;
    return `[网络问题] 请求 "${name}" 失败：${fetchErr || '未知网络错误'}。请检查地址格式和网络连接。`;
  }

  // 鉴权
  if (status === 401 || (status === 403 && b.includes('invalid')))
    return `[密钥错误] "${name}" API Key 无效或已过期。请在设置中更换 Key。`;
  if (status === 403)
    return `[权限不足] "${name}" 拒绝了请求。请检查账户权限或 Key 的访问范围。`;

  // 服务商侧
  if (status === 429)
    return `[服务商限流] "${name}" 请求过于频繁，稍后自动重试。`;
  if (b.includes('rate') && (b.includes('limit') || b.includes('exceed')))
    return `[服务商限流] "${name}" 速率超限，稍后自动重试。`;
  if (status >= 500 && status <= 599)
    return `[服务商故障] "${name}" 服务器异常 (${status})，稍后重试。`;
  if (b.includes('overloaded') || b.includes('busy'))
    return `[服务商繁忙] "${name}" 当前负载过高，稍后重试。`;

  // 余额
  if (b.includes('insufficient_quota') || b.includes('insufficient balance') || b.includes('余额') || b.includes('quota'))
    return `[余额不足] "${name}" 账户余额/配额不足，请充值。`;

  // 模型
  if (b.includes('model_not_found') || b.includes('model info') || b.includes('invalid model'))
    return `[模型不存在] "${name}" 返回的模型名不在可用列表中。请检查设置中的模型名称。`;
  if (status === 404)
    return `[地址错误] "${name}" 接口路径不存在 (404)。请检查 URL 是否拼写正确（不要漏掉 /v1 等路径）。`;

  // 未知
  const snippet = body.slice(0, 300) || `HTTP ${status}`;
  return `[未知错误] "${name}" 返回了意外错误 (${status})：${snippet}。如不确定原因，请截图联系开发者。`;
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
