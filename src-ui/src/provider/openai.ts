// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OpenAI-compatible provider — DeepSeek, MiMo, and any OpenAI-compatible endpoint
// 手写 fetch() + SSE 解析，零第三方 SDK

import { sendWithRetry } from './retry';
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

const DEFAULT_MAX_TOKENS = 32000; // ponytail: safe ceiling across providers (GLM caps at 131072)

interface OpenAIConfig {
  name?: string;
  apiKey: string;
  baseUrl: string; // e.g. "https://api.deepseek.com/v1" or "https://api.openai.com/v1"
  model: string;
  /** Disable reasoning/thinking mode (DeepSeek v4-pro). Default: false (auto). */
  disableThinking?: boolean;
}

export function createOpenAIProvider(cfg: OpenAIConfig): Provider {
  const name = cfg.name || 'openai';
  const baseUrl = cfg.baseUrl.replace(/\/$/, ''); // user controls v1 prefix in baseUrl
  const { model, apiKey, disableThinking } = cfg;

  return {
    name() {
      return name;
    },

    async *stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      const body = buildChatRequest(
        sanitizeToolPairing(req.messages),
        req.tools,
        model,
        req.max_tokens,
        disableThinking,
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
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 3000);
      fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      }).catch(() => {});
    },

    async fetchModels(): Promise<ModelDescriptor[]> {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10000);
      try {
        const resp = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: ctrl.signal,
        });
        if (!resp.ok) return [];
        const json = await resp.json();
        const data: Array<{ id: string }> = json.data || [];
        return data
          .filter((m) => m.id)
          .map((m) => ({
            id: m.id,
            name: m.id,
            kind: 'openai' as const,
            provider: name,
            baseUrl,
            reasoning: false,
            input: ['text'] as ('text' | 'image')[],
            cost: { input: 0, output: 0, cacheRead: 0 },
            contextWindow: 0,
            maxTokens: 0,
          }));
      } catch {
        return [];
      }
    },
  };
}

// ---- Request building ----

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
}

function buildChatRequest(
  msgs: Message[],
  tools: Request['tools'],
  model: string,
  maxTok: number,
  disableThinking?: boolean,
): ChatRequest {
  const thinking = disableThinking ? { type: 'disabled' as const } : undefined;
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
          // OpenAI doesn't want content alongside tool_calls
          if (!m.content) cm.content = null;
        }
        chatMsgs.push(cm);
        break;
      }
    }
  }

  // OpenAI-compatible protocol has NO cache_control field — each provider
  // does its own server-side prefix caching (auto for DeepSeek, prompt_cache_key
  // for official OpenAI). Injecting Anthropic's cache_control here would 400 on
  // strict validators (GLM, Qwen, etc.). cc-switch regression_gh3805.
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
    max_tokens: maxTok > 0 ? maxTok : DEFAULT_MAX_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
    thinking,
  };

  return r;
}

// ---- SSE stream parsing ----

interface DeltaChunk {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface ChatChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: DeltaChunk;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

/** Extract partial content from streaming JSON args for write/edit tools. */
function extractWritePreview(toolName: string, args: string): string | null {
  const isWrite = toolName === 'write_file' || toolName === 'write_file_content';
  const isEdit = toolName === 'edit_file';
  if (!isWrite && !isEdit) return null;
  const key = isEdit ? 'newString' : 'content';
  const re = new RegExp(`"${key}"\\s*:\\s*"(.*)`, 's');
  const m = args.match(re);
  if (!m) return null;
  return m[1]
    .replace(/\\(["\\\/bfnrt])/g, (_, c: string) =>
      ({ '"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t' })[c] || c)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/"\s*\}?\s*$/, '');
}

async function* readSSE(body: ReadableStream<Uint8Array>, name: string, signal?: AbortSignal): AsyncGenerator<Chunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Accumulate tool calls by index
  const toolsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: Chunk['usage'];

  try {
    while (true) {
      if (signal?.aborted) throw new Error(`${name}: aborted`);
      const { done, value } = await reader.read();
      if (done) {
        // Flush decoder internal state and process any trailing data in buffer
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let ev: ChatChunk;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }

        // In-stream error from OpenAI-compatible API (DeepSeek overload, rate limit, etc.)
        if ((ev as any).error) {
          const e = (ev as any).error;
          yield { type: ChunkType.Error, err: new Error(`${name}: ${e.message || JSON.stringify(e)}`) };
          return;
        }

        // Usage may come in a separate chunk or alongside the last choice.
        // Process it but DO NOT continue — the same chunk may also carry choices
        // with finish_reason that we need for tool call completion detection.
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

          // Text content
          if (delta.content) {
            yield { type: ChunkType.Text, text: delta.content };
          }

          // Reasoning content (DeepSeek thinking mode)
          if (delta.reasoning_content) {
            yield { type: ChunkType.Reasoning, text: delta.reasoning_content };
          }

          // Tool calls
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
                // Streaming write preview: extract content from partial JSON args
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

          // Finish reason — detect completed tool calls
          if (choice.finish_reason) {
            if (usage) {
              usage.finish_reason = choice.finish_reason;
            }
            // Emit completed tool calls
            for (const tc of toolsByIndex.values()) {
              yield {
                type: ChunkType.ToolCall,
                tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
              };
            }
            toolsByIndex.clear();
          }
        }

        // Emit usage after choices (so finish_reason is correct)
        if (ev.usage && usage) {
          yield { type: ChunkType.Usage, usage };
        }
      }
    }

    // Process any remaining complete lines in buffer after stream ends
    if (buffer.trim()) {
      const remaining = buffer.split('\n').filter((l) => l.trim());
      for (const raw of remaining) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let ev: ChatChunk;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }

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
          if (choice.delta.content) {
            yield { type: ChunkType.Text, text: choice.delta.content };
          }
          if (choice.delta.reasoning_content) {
            yield { type: ChunkType.Reasoning, text: choice.delta.reasoning_content };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (usage) {
    // Only emit if not already emitted (usage from inline chunks is already out)
    yield { type: ChunkType.Done };
    return;
  }
  yield { type: ChunkType.Done };
}