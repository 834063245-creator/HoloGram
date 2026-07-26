// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Anthropic Messages API provider — 手写 fetch() + SSE 解析，零第三方 SDK

import { sendWithRetry } from './retry';
import { extractWritePreview, fetchJsonWithTimeout, prewarmEndpoint, sseEvents } from './shared';
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

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 32000; // ponytail: safe ceiling across providers

interface AnthropicConfig {
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
      const response = await sendWithRetry({
        url: `${baseUrl}/v1/messages`,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal,
        name,
      });

      if (!response.body) throw new Error(`${name}: no response body`);

      yield* readSSE(response.body, name, signal);
    },

    prewarm(): void {
      prewarmEndpoint(`${baseUrl}/v1/models`, {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      });
    },

    async fetchModels(): Promise<ModelDescriptor[]> {
      const json = await fetchJsonWithTimeout(
        `${baseUrl}/v1/models`,
        {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        10000,
      );
      if (!json) return [];
      const data: Array<{ id: string; display_name?: string }> = (json as any).data || [];
      return data
        .filter((m) => m.id)
        .map((m) => ({
          id: m.id,
          name: m.display_name || m.id,
          kind: 'anthropic' as const,
          provider: name,
          baseUrl,
          reasoning: m.id.includes('sonnet') || m.id.includes('opus') || m.id.includes('haiku'),
          input: ['text', 'image'] as ('text' | 'image')[],
          cost: { input: 0, output: 0, cacheRead: 0 },
          contextWindow: 0,
          maxTokens: 0,
        }));
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
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking';
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
  thinking?: { type: string; display?: string; budget_tokens?: number };
  stream: boolean;
}

function ephemeral(): CacheControl {
  return { type: 'ephemeral' };
}

/** Return the last content block that is NOT a thinking/redacted_thinking block.
 *  Anthropic 400s if cache_control is placed on a thinking block. */
function findLastNonThinkingBlock(blocks: ContentBlock[]): ContentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = blocks[i].type;
    if (t !== 'thinking' && t !== 'redacted_thinking') return blocks[i];
  }
  return undefined;
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
        appendBlocks('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content }]);
        break;
      }
      case 'assistant': {
        const blocks: ContentBlock[] = [];
        // Replay signed thinking block first (Anthropic requires it precede tool_use)
        if (thinkingCfg && m.reasoning_content && m.reasoning_signature) {
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
            try {
              input = JSON.parse(tc.arguments);
            } catch {
              /* malformed JSON → empty input */
            }
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
    input_schema: Object.keys(t.parameters).length > 0 ? t.parameters : { type: 'object', properties: {} },
  }));

  // Cache breakpoints — up to 4, Anthropic's per-request limit.
  // Pattern from cc-switch cache_injector: system → tools → latest msg → prior user.
  // Each breakpoint snapshots all content before it. Anthropic 400s on
  // thinking/redacted_thinking blocks, so findLastNonThinkingBlock skips those.

  // (a) System: cache the full static system prompt at its last block
  if (system.length > 0) {
    system[system.length - 1].cache_control = ephemeral();
  }

  // (b) Tools: always cache tool definitions at the last tool entry
  if (anthTools.length > 0) {
    anthTools[anthTools.length - 1].cache_control = ephemeral();
  }

  // (c) Latest message: mark last non-thinking block of the last message.
  //     When the model just issued tool_use, this anchors the tool-result turn.
  if (anthMsgs.length > 0) {
    const last = anthMsgs[anthMsgs.length - 1];
    const anchor = findLastNonThinkingBlock(last.content);
    if (anchor) anchor.cache_control = ephemeral();
  }

  // (d) Prior user anchor: second user/tool_result from the end.
  //     Long tool-result turns push the stable prefix outside Anthropic's
  //     20-block scan window from (c); this second anchor extends it.
  if (anthMsgs.length >= 4) {
    let userCount = 0;
    for (let i = anthMsgs.length - 1; i >= 0; i--) {
      if (anthMsgs[i].role !== 'user') continue;
      userCount++;
      if (userCount === 2) {
        const block = findLastNonThinkingBlock(anthMsgs[i].content);
        if (block) block.cache_control = ephemeral();
        break;
      }
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

  if (thinkingCfg && thinkingCfg !== 'off') {
    // 努力等级 → budget tokens 映射
    const effortMap: Record<string, number> = { low: 4000, medium: 8000, high: 16000, max: 32000 };
    const effortBudget = effortMap[thinkingCfg.toLowerCase()];
    if (effortBudget) {
      r.thinking = { type: 'enabled', budget_tokens: Math.min(effortBudget, 32000) };
    } else {
      // 纯数字字符串 = budget tokens（如 "4000"、"16000"）
      const budget = parseInt(thinkingCfg, 10);
      if (!Number.isNaN(budget) && budget > 0) {
        r.thinking = { type: 'enabled', budget_tokens: Math.min(budget, 32000) };
      } else {
        // "auto" 或任意非 off 字符串 → 自动模式
        r.thinking = { type: 'auto', display: 'summarized' as const };
      }
    }
  }

  return r;
}

// ---- SSE stream parsing ----

async function* readSSE(body: ReadableStream<Uint8Array>, name: string, signal?: AbortSignal): AsyncGenerator<Chunk> {
  const toolsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  let inTok = 0;
  let outTok = 0;
  let _cacheCreate = 0;
  let cacheRead = 0;
  let finishReason = '';
  let haveUsage = false;

  for await (const ev of sseEvents(body, name, signal)) {
    switch (ev.type) {
      case 'message_start':
        if (ev.message?.usage) {
          inTok = ev.message.usage.input_tokens;
          _cacheCreate = ev.message.usage.cache_creation_input_tokens;
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
            if (ev.delta.thinking) yield { type: ChunkType.Reasoning, text: ev.delta.thinking };
            break;
          case 'signature_delta':
            if (ev.delta.signature) yield { type: ChunkType.Reasoning, signature: ev.delta.signature };
            break;
          case 'input_json_delta': {
            const tc = toolsByIndex.get(ev.index);
            if (tc) {
              tc.arguments += ev.delta.partial_json;
              // Streaming write preview: extract content from partial JSON args
              const preview = extractWritePreview(tc.name, tc.arguments);
              if (preview) {
                yield {
                  type: ChunkType.ToolArgPreview,
                  tool_arg_preview: { tool_id: tc.id, tool_name: tc.name, content: preview },
                };
              }
            }
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

  if (haveUsage) {
    yield {
      type: ChunkType.Usage,
      usage: {
        prompt_tokens: inTok, // inTok 已是总数，cacheCreate/cacheRead 是其 breakdown
        completion_tokens: outTok,
        total_tokens: inTok + outTok,
        cache_hit_tokens: cacheRead,
        cache_miss_tokens: inTok - cacheRead,
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
