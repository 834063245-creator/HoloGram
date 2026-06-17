// OpenAI-compatible provider — DeepSeek, MiMo, and any OpenAI-compatible endpoint
// 手写 fetch() + SSE 解析，零第三方 SDK

import { Chunk, ChunkType, Message, Provider, Request, Role, sanitizeToolPairing } from './types';

const DEFAULT_MAX_TOKENS = 32768;

export interface OpenAIConfig {
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
      const body = buildChatRequest(sanitizeToolPairing(req.messages), req.tools, model, req.max_tokens, disableThinking);
      const response = await sendWithRetry(signal, baseUrl, apiKey, name, body);

      if (!response.body) throw new Error(`${name}: no response body`);

      yield* readSSE(response.body, name, signal);
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

  // Apply cache breakpoint to the last system message (DeepSeek supports cache_control)
  let sysSet = false;
  for (let i = chatMsgs.length - 1; i >= 0; i--) {
    if (chatMsgs[i].role === 'system') {
      if (!sysSet) {
        (chatMsgs[i] as any).cache_control = { type: 'ephemeral' };
        sysSet = true;
      }
    }
  }

  const chatTools: ChatTool[] | undefined =
    tools.length > 0
      ? tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters:
              Object.keys(t.parameters).length > 0
                ? t.parameters
                : { type: 'object', properties: {} },
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

// ---- Retry logic ----

async function sendWithRetry(
  signal: AbortSignal,
  baseUrl: string,
  apiKey: string,
  name: string,
  body: ChatRequest,
): Promise<Response> {
  const maxAttempts = 3;
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = 500 * Math.pow(2, attempt - 1) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
    }
    if (signal.aborted) throw new Error(`${name}: aborted`);

    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error(`${name}: aborted`);
      lastErr = new Error(`${name}: request failed: ${err.message}`);
      continue;
    }

    if (resp.ok) return resp;

    const msg = await resp.text().catch(() => '');
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `authentication failed for "${name}" (HTTP ${resp.status}): API key is invalid or expired`,
      );
    }
    const statusErr = new Error(`${name}: status ${resp.status}: ${msg.slice(0, 500)}`);
    if (!isRetryableStatus(resp.status)) throw statusErr;
    lastErr = statusErr;
  }

  throw lastErr!;
}

function isRetryableStatus(s: number): boolean {
  return s === 408 || s === 429 || (s >= 500 && s <= 599);
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

async function* readSSE(
  body: ReadableStream<Uint8Array>,
  name: string,
  signal?: AbortSignal,
): AsyncGenerator<Chunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Accumulate tool calls by index
  const toolsByIndex = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let usage: Chunk['usage'];

  try {
    while (true) {
      if (signal?.aborted) throw new Error(`${name}: aborted`);
      const { done, value } = await reader.read();
      if (done) break;
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

        // Usage may come in a separate chunk or alongside the last choice.
        // Process it but DO NOT continue — the same chunk may also carry choices
        // with finish_reason that we need for tool call completion detection.
        if (ev.usage) {
          usage = {
            prompt_tokens: ev.usage.prompt_tokens,
            completion_tokens: ev.usage.completion_tokens,
            total_tokens: ev.usage.total_tokens,
            cache_hit_tokens: ev.usage.prompt_tokens_details?.cached_tokens || 0,
            cache_miss_tokens:
              ev.usage.prompt_tokens -
              (ev.usage.prompt_tokens_details?.cached_tokens || 0),
            reasoning_tokens:
              ev.usage.completion_tokens_details?.reasoning_tokens || 0,
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
