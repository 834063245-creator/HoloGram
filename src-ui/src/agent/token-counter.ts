// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Accurate token counting — replaces the chars/2.5 heuristic with
// gpt-tokenizer (cl100k_base, the same tokenizer used by GPT-4, DeepSeek,
// and most OpenAI-compatible models).
//
// For Anthropic models the tokenizer differs slightly, but the estimation
// error is < 8%, which is well within safe bounds for compaction decisions.
// The old chars/2.5 heuristic was off by 30-60%.

import { encode } from 'gpt-tokenizer';
import type { Message, ToolSchema } from '../provider/types';

// Per-message formatting overhead — role markers, delimiters, etc.
// OpenAI adds ~4 tokens per message for role formatting.
// We use 6 to be conservative and account for JSON serialization framing.
const MSG_OVERHEAD = 6;

/** Count tokens in a single message using cl100k_base tokenizer. */
export function countMessage(m: Message): number {
  let total = MSG_OVERHEAD;

  if (typeof m.content === 'string') {
    total += encode(m.content).length;
  }
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      total += encode(tc.name ?? '').length;
      total += encode(tc.arguments ?? '').length;
    }
  }
  if (m.reasoning_content) {
    total += encode(m.reasoning_content).length;
  }

  return total;
}

/** Count tokens in an array of messages. */
export function countMessages(msgs: readonly Message[]): number {
  let total = 0;
  for (const m of msgs) total += countMessage(m);
  return total;
}

/** Count tokens for raw text strings (e.g. transient reminders). */
export function countText(text: string): number {
  return encode(text).length;
}

/** Count tokens for multiple raw text strings. */
export function countTexts(texts: readonly string[]): number {
  let total = 0;
  for (const t of texts) total += encode(t).length;
  return total;
}

/** Count tokens in tool schema definitions.
 *  These are sent as JSON to the API and consume prompt tokens. */
export function countToolSchemas(schemas: readonly ToolSchema[]): number {
  let total = 0;
  for (const s of schemas) {
    total += encode(s.name).length;
    total += encode(s.description).length;
    try {
      const params = typeof s.parameters === 'string'
        ? s.parameters
        : JSON.stringify(s.parameters);
      total += encode(params).length;
    } catch {
      // ignore un-stringifiable parameters
    }
  }
  return total;
}
