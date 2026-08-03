// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 精确 token 计数 — 用 gpt-tokenizer（cl100k_base，GPT-4、DeepSeek
// 和大多数 OpenAI 兼容模型使用的同一分词器）替代 chars/2.5 启发式。
//
// Anthropic 模型的分词器略有差异，但估算误差 < 8%，
// 在压缩决策的安全范围内。旧的 chars/2.5 启发式偏差达 30-60%。

import { encode } from 'gpt-tokenizer';
import type { Message, ToolSchema } from '../provider/types';

// 每条消息的格式化开销 — 角色标记、分隔符等。
// OpenAI 每条消息约 4 token 的角色格式化。
// 我们用 6 以保守并计入 JSON 序列化框架开销。
const MSG_OVERHEAD = 6;

/** 计数专用编码 — 允许特殊 token 按真实 ID 计入，而非抛错。
 *  会话内容不可控：模型输出 / 工具结果 / 文件内容里可能混入
 *  `<|im_end|>` 之类的字面特殊 token，gpt-tokenizer 默认遇之则抛
 *  `Disallowed special token found`，会把预检 / 压缩 / 轮次统计
 *  整条链炸掉（用户看到的 "错误: Disallowed special token found"）。
 *  兜底：tokenizer 自身异常时退化为 chars/2.5 估算 — 计数永不抛出。 */
function safeCount(text: string): number {
  try {
    return encode(text, { allowedSpecial: 'all' }).length;
  } catch {
    return Math.ceil(text.length / 2.5);
  }
}

/** 使用 cl100k_base 分词器计算单条消息的 token 数。 */
export function countMessage(m: Message): number {
  let total = MSG_OVERHEAD;

  if (typeof m.content === 'string') {
    total += safeCount(m.content);
  }
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      total += safeCount(tc.name ?? '');
      total += safeCount(tc.arguments ?? '');
    }
  }
  if (m.reasoning_content) {
    total += safeCount(m.reasoning_content);
  }
  if (m.name) {
    total += safeCount(m.name);
  }

  return total;
}

/** 计算消息数组的 token 数。 */
export function countMessages(msgs: readonly Message[]): number {
  let total = 0;
  for (const m of msgs) total += countMessage(m);
  return total;
}

/** 计算原始文本字符串的 token 数（如临时提醒）。 */
export function countText(text: string): number {
  return safeCount(text);
}

/** 计算多条原始文本字符串的 token 数。 */
export function countTexts(texts: readonly string[]): number {
  let total = 0;
  for (const t of texts) total += countText(t);
  return total;
}

/** 计算工具 schema 定义的 token 数。
 *  这些作为 JSON 发送给 API 并消耗 prompt token。 */
export function countToolSchemas(schemas: readonly ToolSchema[]): number {
  let total = 0;
  for (const s of schemas) {
    total += safeCount(s.name);
    total += safeCount(s.description);
    try {
      const params = typeof s.parameters === 'string' ? s.parameters : JSON.stringify(s.parameters);
      total += safeCount(params);
    } catch {
      // 忽略不可字符串化的参数
    }
  }
  return total;
}
