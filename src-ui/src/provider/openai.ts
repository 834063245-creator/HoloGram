// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OpenAI 兼容 provider — DeepSeek、MiMo 及任何 OpenAI 兼容端点
// 手写 fetch() + SSE 解析，零第三方 SDK

import { clampMaxTokens } from './catalog';
import { sendWithRetry } from './retry';
import { extractWritePreview, fetchJsonWithTimeout, prewarmEndpoint, sseEvents } from './shared';
import {
  effortVendor,
  isThinkingMode,
  toOpenAIEffort,
  type EffortVendor,
  type OpenAIWireEffort,
  type StoredThinking,
  type ThinkingMode,
} from './thinking';
import {
  type Chunk,
  ChunkType,
  type Message,
  type ModelDescriptor,
  type Provider,
  type Request,
  type Role,
  sanitizeToolPairing,
} from './types';

const DEFAULT_MAX_TOKENS = 32000; // ponytail：跨提供商的安全上限（GLM 上限 131072）

interface OpenAIConfig {
  name?: string;
  apiKey: string;
  baseUrl: string; // 例如 "https://api.deepseek.com/v1" 或 "https://api.openai.com/v1"
  model: string;
  /** 思考档位（ThinkingPolicy）。'off' = 关闭；命名档位按 EffortVendor 映射。 */
  thinking?: StoredThinking;
}

/** 动态模型 reasoning 启发式（P0 定稿）：
 *  静态目录元数据优先（mergeDynamicModels 跳过已收录 id），此函数只服务
 *  目录外的新模型。匹配 id 中的 think/reason 等关键词。 */
export function guessReasoning(id: string): boolean {
  return /think|reason|r1|deepseek-v[34]|kimi-k2-thinking/i.test(id);
}

export function createOpenAIProvider(cfg: OpenAIConfig): Provider {
  const name = cfg.name || 'openai';
  const baseUrl = cfg.baseUrl.replace(/\/$/, ''); // 用户在 baseUrl 中控制 v1 前缀
  const { model, apiKey } = cfg;
  let thinking: StoredThinking | undefined = cfg.thinking; // setThinking 运行时更新
  const effortProfile = effortVendor(name, 'openai', baseUrl, model);

  return {
    name() {
      return name;
    },
    setThinking(cfg: StoredThinking | undefined): void {
      thinking = cfg;
    },
    async *stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      const body = buildChatRequest(
        sanitizeToolPairing(req.messages),
        req.tools,
        model,
        req.max_tokens,
        thinking,
        effortProfile,
      );
      const response = await sendWithRetry({
        url: `${baseUrl}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
        name,
      });

      if (!response.body) throw new Error(`${name}: no response body`);

      yield* readSSE(response.body, name, signal);
    },

    prewarm(): void {
      prewarmEndpoint(`${baseUrl}/models`, {
        Authorization: `Bearer ${apiKey}`,
      });
    },

    async fetchModels(): Promise<ModelDescriptor[]> {
      const json = await fetchJsonWithTimeout(
        `${baseUrl}/models`,
        {
          Authorization: `Bearer ${apiKey}`,
        },
        10000,
      );
      if (!json) return [];
      const data: Array<{ id: string }> = (json as { data?: Array<{ id: string }> }).data || [];
      return data
        .filter((m) => m.id)
        .map((m) => ({
          id: m.id,
          name: m.id,
          kind: 'openai' as const,
          vendor: name,
          baseUrl,
          reasoning: guessReasoning(m.id),
          input: ['text'] as ('text' | 'image')[],
          cost: { input: 0, output: 0, cacheRead: 0 },
          contextWindow: 0,
          maxTokens: 0,
        }));
    },
  };
}

// ---- 请求构建 ----

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  max_tokens: number;
  stream: true;
  stream_options?: { include_usage: true };
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: OpenAIWireEffort;
}

export function buildChatRequest(
  msgs: Message[],
  tools: Request['tools'],
  model: string,
  maxTok: number,
  thinking: StoredThinking | undefined,
  effortProfile: EffortVendor,
): ChatRequest {
  // 数字预算串是 Anthropic 遗留存储形态，对 OpenAI 兼容协议无 effort 语义 → 按自动处理。
  const stored = thinking || '';
  const level: ThinkingMode = isThinkingMode(stored) ? stored : '';
  const effort = toOpenAIEffort(effortProfile, level);
  const thinkingBlock =
    thinking === 'off' ? { type: 'disabled' as const } : effort ? { type: 'enabled' as const } : undefined;
  const chatMsgs: ChatMessage[] = [];

  for (const m of msgs) {
    switch (m.role as Role) {
      case 'system':
      case 'user':
        chatMsgs.push({ role: m.role, content: m.content || null });
        break;
      case 'tool':
        chatMsgs.push({
          role: 'tool',
          content: m.content || '(no output)',
          tool_call_id: m.tool_call_id,
          name: m.name,
        });
        break;
      case 'assistant': {
        const cm: ChatMessage = { role: 'assistant', content: m.content || null };
        if (m.tool_calls && m.tool_calls.length > 0) {
          cm.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          }));
          // OpenAI 不希望 tool_calls 旁边有 content
          if (!m.content) cm.content = null;
        }
        chatMsgs.push(cm);
        break;
      }
    }
  }

  // OpenAI 兼容协议没有 cache_control 字段 — 每个 provider
  // 自行做服务端前缀缓存（DeepSeek 自动，官方 OpenAI 用 prompt_cache_key）。
  // 在此注入 Anthropic 的 cache_control 会在严格的验证器上返回 400
  // （GLM、Qwen 等）。cc-switch regression_gh3805.
  const chatTools: ChatTool[] | undefined =
    tools.length > 0
      ? tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: Object.keys(t.parameters).length > 0 ? t.parameters : { type: 'object', properties: {} },
          },
        }))
      : undefined;

  const r: ChatRequest = {
    model,
    messages: chatMsgs,
    tools: chatTools,
    max_tokens: clampMaxTokens(model, maxTok > 0 ? maxTok : DEFAULT_MAX_TOKENS),
    stream: true,
    stream_options: { include_usage: true },
    thinking: thinkingBlock,
    reasoning_effort: effort,
  };

  return r;
}

// ---- SSE 流解析 ----

async function* readSSE(body: ReadableStream<Uint8Array>, name: string, signal?: AbortSignal): AsyncGenerator<Chunk> {
  const toolsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: Chunk['usage'];

  for await (const ev of sseEvents(body, name, signal)) {
    // 来自 OpenAI 兼容 API 的流内错误（DeepSeek 过载、限流等）
    if ((ev as { error?: { message?: string } }).error) {
      const e = (ev as { error?: { message?: string } }).error!;
      yield { type: ChunkType.Error, err: new Error(`${name}: ${e.message || JSON.stringify(e)}`) };
      return;
    }

    // Usage 可能出现在单独的 chunk 中，也可能伴随最后一个 choice 出现。
    // 处理它但不要 continue — 同一个 chunk 可能还携带带 finish_reason 的 choices，
    // 我们需要它来检测工具调用是否完成。
    if (ev.usage) {
      usage = {
        prompt_tokens: ev.usage.prompt_tokens,
        completion_tokens: ev.usage.completion_tokens,
        total_tokens: ev.usage.total_tokens,
        cache_hit_tokens: ev.usage.prompt_tokens_details?.cached_tokens || 0,
        cache_miss_tokens: ev.usage.prompt_tokens - (ev.usage.prompt_tokens_details?.cached_tokens || 0),
        reasoning_tokens: ev.usage.completion_tokens_details?.reasoning_tokens || 0,
        finish_reason: 'stop',
      };
    }

    for (const choice of ev.choices) {
      const delta = choice.delta;

      // 文本内容
      if (delta.content) {
        yield { type: ChunkType.Text, text: delta.content };
      }

      // 推理内容（DeepSeek thinking 模式）
      if (delta.reasoning_content) {
        yield { type: ChunkType.Reasoning, text: delta.reasoning_content };
      }

      // 工具调用
      if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          let tc = toolsByIndex.get(tcDelta.index);
          if (!tc) {
            tc = { id: '', name: '', arguments: '' };
            toolsByIndex.set(tcDelta.index, tc);
          }
          if (tcDelta.id) tc.id = tcDelta.id;
          if (tcDelta.function?.name) {
            tc.name = tcDelta.function.name;
            yield {
              type: ChunkType.ToolCallStart,
              tool_call: { id: tc.id, name: tc.name, arguments: '' },
            };
          }
          if (tcDelta.function?.arguments) {
            tc.arguments += tcDelta.function.arguments;
            // 流式写入预览：从部分 JSON 参数中提取内容
            const preview = extractWritePreview(tc.name, tc.arguments);
            if (preview) {
              yield {
                type: ChunkType.ToolArgPreview,
                tool_arg_preview: { tool_id: tc.id, tool_name: tc.name, content: preview },
              };
            }
          }
        }
      }

      // 完成原因 — 检测已完成的工具调用
      if (choice.finish_reason) {
        if (usage) {
          usage.finish_reason = choice.finish_reason;
        }
        // 输出已完成的工具调用
        for (const tc of toolsByIndex.values()) {
          yield {
            type: ChunkType.ToolCall,
            tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
          };
        }
        toolsByIndex.clear();
      }
    }

    // 在 choices 之后输出 usage（确保 finish_reason 正确）
    if (ev.usage && usage) {
      yield { type: ChunkType.Usage, usage };
    }
  }

  yield { type: ChunkType.Done };
}
