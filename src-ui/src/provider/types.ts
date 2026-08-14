// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 抽象层 — 统一 Message / Chunk / ToolCall，抹平 Anthropic 和 OpenAI 的 API 差异

import type { StoredThinking } from './thinking';

/** 模型 API 的线上方言（CONTEXT.md「Protocol」）。
 *  注意：ProviderSettings/ModelDescriptor 上的持久化字段名仍叫 `kind`（存储遗留名），
 *  领域词与代码类型统一为 Protocol，改存储键名需带迁移。 */
export type Protocol = 'anthropic' | 'openai';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  /** thinking 模式的思维链，多轮对话中原样往返 */
  reasoning_content?: string;
  /** provider 签发的推理证明（Anthropic thinking signature） */
  reasoning_signature?: string;
  /** 由 assistant 设置 */
  tool_calls?: ToolCall[];
  /** 将工具结果关联到其调用 */
  tool_call_id?: string;
  /** tool 消息：工具名称 */
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // 原始 JSON
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
  /** 部分工具参数预览 — 在 input_json_delta 期间为 write/edit 工具发出 */
  ToolArgPreview = 7,
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  /** 写缓存(缓存创建)的输入 token 数。
   *  Anthropic 通过 cache_creation_input_tokens 单独报告(单价较高);
   *  OpenAI 兼容(DeepSeek 等)通常没有该拆解,置 0。 */
  cache_creation_tokens: number;
  reasoning_tokens: number;
  finish_reason: string; // "stop", "tool_calls", "length", "content_filter"
}

export interface Chunk {
  type: ChunkType;
  text?: string;
  signature?: string; // ChunkReasoning：Anthropic thinking signature
  tool_call?: ToolCall; // ChunkToolCallStart（仅 id+name）或 ChunkToolCall（完整）
  /** 部分工具参数预览（write_file 内容、edit_file diff 等） */
  tool_arg_preview?: { tool_id: string; tool_name: string; content: string };
  usage?: Usage;
  err?: Error;
}

/** Provider 是具备聊天能力的模型后端。 */
export interface Provider {
  name(): string;
  /** 启动流式补全，yield chunks。取消 signal 会中止。 */
  stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk>;
  /** 运行时更新思考策略（ModelSwitcher 切思考档位），不重建 Provider。
   *  可选 — 旧实现没有此方法时静默跳过。 */
  setThinking?(cfg: StoredThinking | undefined): void;
  /** 预热 HTTP 连接池。创建后调用一次以在首次真实请求前建立
   *  TCP+TLS 连接。尽力而为 — 失败静默处理。 */
  prewarm?(): void;
  /** 从 provider 的 /models API 端点获取可用模型。
   *  返回 ModelDescriptor[]，仅含最小元数据（cost/contextWindow 从 API 不可知）。
   *  尽力而为 — 失败时返回空数组。 */
  fetchModels?(): Promise<ModelDescriptor[]>;
}

// ---- 模型目录 ----

/** 每百万 token 的费用（USD）。 */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
}

/** 静态模型描述符 — 数据驱动的模型选择，无需手动输入。 */
export interface ModelDescriptor {
  id: string; // 例如 "deepseek-v4-pro"
  name: string; // 例如 "DeepSeek V4 Pro"
  kind: Protocol; // 使用哪个 provider 实现（领域词：Protocol）
  vendor: string; // Vendor 厂商（例如 "deepseek"、"anthropic"）— CONTEXT.md「Vendor」
  baseUrl: string; // API 端点
  reasoning: boolean; // 是否支持 thinking/reasoning
  input: ('text' | 'image')[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
}

// ---- 错误分类 ----

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
    if (fetchErr?.includes('ETIMEDOUT')) return `[网络问题] 连接 "${name}" 超时，请检查地址或稍后重试。`;
    if (fetchErr?.includes('aborted')) return `[已取消] 请求被手动中止。`;
    return `[网络问题] 请求 "${name}" 失败：${fetchErr || '未知网络错误'}。请检查地址格式和网络连接。`;
  }

  // 鉴权
  if (status === 401 || (status === 403 && b.includes('invalid')))
    return `[密钥错误] "${name}" API Key 无效或已过期。请在设置中更换 Key。`;
  if (status === 403) return `[权限不足] "${name}" 拒绝了请求。请检查账户权限或 Key 的访问范围。`;

  // 服务商侧
  if (status === 429) return `[服务商限流] "${name}" 请求过于频繁，稍后自动重试。`;
  if (b.includes('rate') && (b.includes('limit') || b.includes('exceed')))
    return `[服务商限流] "${name}" 速率超限，稍后自动重试。`;
  if (status >= 500 && status <= 599) return `[服务商故障] "${name}" 服务器异常 (${status})，稍后重试。`;
  if (b.includes('overloaded') || b.includes('busy')) return `[服务商繁忙] "${name}" 当前负载过高，稍后重试。`;

  // 余额
  if (
    b.includes('insufficient_quota') ||
    b.includes('insufficient balance') ||
    b.includes('余额') ||
    b.includes('quota')
  )
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

// ---- 工具配对清理 ----

const interruptedToolResult = '[no result: the previous turn was interrupted before this tool call completed]';

/** 修复历史记录，使每个 assistant tool_calls 都有匹配的 tool 消息。 */
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
      i++; // 孤立的 tool 消息 — 丢弃
      continue;
    }
    // 跳过空的 assistant 消息 — DeepSeek 会拒绝
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
