// Anthropic Messages API provider — 手写 fetch() + SSE 解析，零第三方 SDK

import { Chunk, ChunkType, Message, Provider, Request, Role, sanitizeToolPairing } from './types';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 32768;

export interface AnthropicConfig {
  name?: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  /** "adaptive" enables extended thinking */
  thinking?: string;
}

export function createAnthropicProvider(cfg: AnthropicConfig): Provider {
  const name = cfg.name || 'anthropic';
  const baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const { model, apiKey, thinking } = cfg;

  return {
    name() {
      return name;
    },

    async *stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      const body = buildRequest(sanitizeToolPairing(req.messages), req.tools, model, thinking || '', req.max_tokens);
      const response = await sendWithRetry(signal, baseUrl, apiKey, name, body);

      if (!response.body) throw new Error(`${name}: no response body`);

      yield* readSSE(response.body, name, signal);
    },
  };
}

// ---- Request building ----

interface CacheControl {
  type: 'ephemeral';
}

interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  cache_control?: CacheControl;
}

interface AnthMessage {
  role: string;
  content: ContentBlock[];
}

interface AnthTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

interface AnthRequest {
  model: string;
  max_tokens: number;
  system?: TextBlock[];
  messages: AnthMessage[];
  tools?: AnthTool[];
  thinking?: { type: string; display: string };
  stream: boolean;
}

function ephemeral(): CacheControl {
  return { type: 'ephemeral' };
}

function buildRequest(
  msgs: Message[],
  tools: Request['tools'],
  model: string,
  thinkingCfg: string,
  maxTok: number,
): AnthRequest {
  const system: TextBlock[] = [];
  const anthMsgs: AnthMessage[] = [];

  const appendBlocks = (role: string, blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = anthMsgs[anthMsgs.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      anthMsgs.push({ role, content: blocks });
    }
  };

  for (const m of msgs) {
    switch (m.role as Role) {
      case 'system':
        if (m.content) system.push({ type: 'text', text: m.content });
        break;
      case 'user':
        if (m.content) appendBlocks('user', [{ type: 'text', text: m.content }]);
        break;
      case 'tool': {
        const content = m.content || '(no output)';
        appendBlocks('user', [
          { type: 'tool_result', tool_use_id: m.tool_call_id, content },
        ]);
        break;
      }
      case 'assistant': {
        const blocks: ContentBlock[] = [];
        // Replay signed thinking block first (Anthropic requires it precede tool_use)
        if (
          thinkingCfg &&
          m.reasoning_content &&
          m.reasoning_signature
        ) {
          blocks.push({
            type: 'thinking',
            thinking: m.reasoning_content,
            signature: m.reasoning_signature,
          });
        }
        if (m.content) {
          blocks.push({ type: 'text', text: m.content });
        }
        for (const tc of m.tool_calls || []) {
          let input: unknown = {};
          if (tc.arguments) {
            try { input = JSON.parse(tc.arguments); } catch { /* malformed JSON → empty input */ }
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input,
          });
        }
        appendBlocks('assistant', blocks);
        break;
      }
    }
  }

  const anthTools: AnthTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: Object.keys(t.parameters).length > 0
      ? t.parameters
      : { type: 'object', properties: {} },
  }));

  // Cache breakpoints: mark last system block (caches tools+system) or last tool
  if (system.length > 0) {
    system[system.length - 1].cache_control = ephemeral();
  } else if (anthTools.length > 0) {
    anthTools[anthTools.length - 1].cache_control = ephemeral();
  }
  // Mark last block of last message
  if (anthMsgs.length > 0) {
    const last = anthMsgs[anthMsgs.length - 1];
    if (last.content.length > 0) {
      last.content[last.content.length - 1].cache_control = ephemeral();
    }
  }

  const r: AnthRequest = {
    model,
    max_tokens: maxTok > 0 ? maxTok : DEFAULT_MAX_TOKENS,
    system: system.length > 0 ? system : undefined,
    messages: anthMsgs,
    tools: anthTools.length > 0 ? anthTools : undefined,
    stream: true,
  };

  if (thinkingCfg === 'adaptive') {
    r.thinking = { type: 'adaptive', display: 'summarized' };
  }

  return r;
}

// ---- Retry logic ----

async function sendWithRetry(
  signal: AbortSignal,
  baseUrl: string,
  apiKey: string,
  name: string,
  body: AnthRequest,
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
      resp = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
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
    const statusErr = new Error(
      `${name}: status ${resp.status}: ${msg.slice(0, 500)}`,
    );
    if (!isRetryableStatus(resp.status)) throw statusErr;
    lastErr = statusErr;
  }

  throw lastErr!;
}

function isRetryableStatus(s: number): boolean {
  return s === 408 || s === 429 || (s >= 500 && s <= 599);
}

// ---- SSE stream parsing ----

interface WireUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface StreamEvent {
  type: string;
  index: number;
  message?: { usage: WireUsage };
  content_block?: { type: string; id: string; name: string };
  delta?: {
    type: string;
    text: string;
    thinking: string;
    signature: string;
    partial_json: string;
    stop_reason: string;
  };
  usage?: WireUsage;
  error?: { type: string; message: string };
}

async function* readSSE(
  body: ReadableStream<Uint8Array>,
  name: string,
  signal?: AbortSignal,
): AsyncGenerator<Chunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const toolsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  let inTok = 0;
  let outTok = 0;
  let cacheCreate = 0;
  let cacheRead = 0;
  let finishReason = '';
  let haveUsage = false;

  try {
    while (true) {
      if (signal?.aborted) throw new Error(`${name}: aborted`);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete last line

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        let ev: StreamEvent;
        try {
          ev = JSON.parse(data);
        } catch {
          continue; // skip non-JSON lines
        }

        switch (ev.type) {
          case 'message_start':
            if (ev.message?.usage) {
              inTok = ev.message.usage.input_tokens;
              cacheCreate = ev.message.usage.cache_creation_input_tokens;
              cacheRead = ev.message.usage.cache_read_input_tokens;
              haveUsage = true;
            }
            break;

          case 'content_block_start':
            if (ev.content_block?.type === 'tool_use') {
              const tc = {
                id: ev.content_block.id,
                name: ev.content_block.name,
                arguments: '',
              };
              toolsByIndex.set(ev.index, tc);
              yield {
                type: ChunkType.ToolCallStart,
                tool_call: { id: tc.id, name: tc.name, arguments: '' },
              };
            }
            break;

          case 'content_block_delta':
            if (!ev.delta) continue;
            switch (ev.delta.type) {
              case 'text_delta':
                if (ev.delta.text) yield { type: ChunkType.Text, text: ev.delta.text };
                break;
              case 'thinking_delta':
                if (ev.delta.thinking)
                  yield { type: ChunkType.Reasoning, text: ev.delta.thinking };
                break;
              case 'signature_delta':
                if (ev.delta.signature)
                  yield { type: ChunkType.Reasoning, signature: ev.delta.signature };
                break;
              case 'input_json_delta': {
                const tc = toolsByIndex.get(ev.index);
                if (tc) tc.arguments += ev.delta.partial_json;
                break;
              }
            }
            break;

          case 'content_block_stop': {
            const tc = toolsByIndex.get(ev.index);
            if (tc) {
              yield {
                type: ChunkType.ToolCall,
                tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
              };
              toolsByIndex.delete(ev.index);
            }
            break;
          }

          case 'message_delta':
            if (ev.delta?.stop_reason) {
              finishReason = ev.delta.stop_reason;
            }
            if (ev.usage) {
              outTok = ev.usage.output_tokens;
              haveUsage = true;
            }
            break;

          case 'message_stop':
            // stream complete
            break;

          case 'error': {
            const msg = ev.error?.message || 'stream error';
            yield { type: ChunkType.Error, err: new Error(`${name}: ${msg}`) };
            return;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (haveUsage) {
    yield {
      type: ChunkType.Usage,
      usage: {
        prompt_tokens: inTok + cacheCreate + cacheRead,
        completion_tokens: outTok,
        total_tokens: inTok + cacheCreate + cacheRead + outTok,
        cache_hit_tokens: cacheRead,
        cache_miss_tokens: inTok + cacheCreate,
        reasoning_tokens: 0,
        finish_reason: mapStopReason(finishReason),
      },
    };
  }
  yield { type: ChunkType.Done };
}

function mapStopReason(s: string): string {
  switch (s) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return s;
  }
}
