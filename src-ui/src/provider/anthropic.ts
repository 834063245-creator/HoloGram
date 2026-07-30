// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Anthropic Messages API provider — 手写 fetch() + SSE 解析，零第三方 SDK

import { clampMaxTokens } from './catalog';
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
const DEFAULT_MAX_TOKENS = 32000; // ponytail：跨提供商的安全上限

interface AnthropicConfig {
  name?: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  /** "adaptive" 启用扩展思考 */
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
      const data: Array<{ id: string; display_name?: string }> = (json as { data?: Array<{ id: string; display_name?: string }> }).data || [];
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

// ---- 请求构建 ----

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

/** 返回最后一个非 thinking/redacted_thinking 的内容块。
 *  如果 cache_control 放在 thinking 块上，Anthropic 会返回 400。 */
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
        // 先重放已签名的 thinking 块（Anthropic 要求它在 tool_use 之前）
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
              /* 格式错误的 JSON → 空输入 */
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

  // 缓存断点 — 最多 4 个，Anthropic 每次请求的上限。
  // 模式来自 cc-switch cache_injector：system → tools → 最新消息 → 前一个 user。
  // 每个断点会快照其之前的所有内容。Anthropic 对 thinking/redacted_thinking
  // 块返回 400，因此 findLastNonThinkingBlock 会跳过这些块。

  // (a) System：在 system 提示词的最后一个块上设置缓存
  if (system.length > 0) {
    system[system.length - 1].cache_control = ephemeral();
  }

  // (b) Tools：始终在最后一个工具定义上设置缓存
  if (anthTools.length > 0) {
    anthTools[anthTools.length - 1].cache_control = ephemeral();
  }

  // (c) 最新消息：在最后一条消息的最后一个非 thinking 块上标记缓存。
  //     当模型刚发起 tool_use 时，此处锚定工具结果轮次。
  if (anthMsgs.length > 0) {
    const last = anthMsgs[anthMsgs.length - 1];
    const anchor = findLastNonThinkingBlock(last.content);
    if (anchor) anchor.cache_control = ephemeral();
  }

  // (d) 前一个 user 锚点：倒数第二个 user/tool_result。
  //     较长的工具结果轮次会将稳定前缀推到 Anthropic 从 (c) 出发的
  //     20 块扫描窗口之外；这第二个锚点用于扩展该窗口。
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
    max_tokens: clampMaxTokens(model, maxTok > 0 ? maxTok : DEFAULT_MAX_TOKENS),
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

// ---- SSE 流解析 ----

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
              // 流式写入预览：从部分 JSON 参数中提取内容
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
        // 流完成
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
