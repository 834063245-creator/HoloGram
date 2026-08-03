// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// token-counter 回归测试 — 会话内容混入字面特殊 token（如模型输出
// 泄漏的 `<|im_end|>`）时，计数必须返回数字而非抛出。
// 回归背景：gpt-tokenizer 默认对特殊 token 抛
// `Disallowed special token found`，曾导致预检/压缩链路整轮崩掉。

import { describe, expect, it } from 'vitest';
import { countMessage, countMessages, countText, countTexts, countToolSchemas } from '../src/agent/token-counter';

describe('token-counter 特殊 token 容错', () => {
  it('countText 遇到 <|im_end|> 不抛出', () => {
    expect(() => countText('hello <|im_end|> world')).not.toThrow();
    expect(countText('hello <|im_end|> world')).toBeGreaterThan(0);
  });

  it('countText 遇到其它 ChatML/GPT 特殊 token 不抛出', () => {
    for (const tok of ['<|im_start|>', '<|endoftext|>', '<|fim_prefix|>', '<|endofprompt|>']) {
      expect(() => countText(`prefix ${tok} suffix`)).not.toThrow();
    }
  });

  it('countMessage 覆盖 content / tool_calls / reasoning_content 各字段', () => {
    const m = {
      role: 'assistant' as const,
      content: '正文 <|im_end|>',
      reasoning_content: '思考 <|im_start|>',
      tool_calls: [{ id: '1', name: 'run_shell', arguments: '{"cmd":"echo <|im_end|>"}' }],
    };
    expect(() => countMessage(m)).not.toThrow();
    expect(countMessage(m)).toBeGreaterThan(0);
  });

  it('countMessages 数组计数不抛出', () => {
    const msgs = [
      { role: 'user' as const, content: '带 <|im_end|> 的用户消息' },
      { role: 'tool' as const, content: '工具结果 <|endoftext|>', name: 'read_file' },
    ];
    expect(() => countMessages(msgs)).not.toThrow();
  });

  it('countTexts / countToolSchemas 不抛出', () => {
    expect(() => countTexts(['a <|im_end|>', 'b'])).not.toThrow();
    expect(() =>
      countToolSchemas([{ name: 't', description: 'd <|im_end|>', parameters: { type: 'object' } }]),
    ).not.toThrow();
  });

  it('普通文本计数结果与裸 encode 一致（无回归）', () => {
    const plain = '这是一段普通的中文文本 with some English mixed in 12345';
    // safeCount 对普通文本应走 encode 路径 — 结果稳定且非 fallback 估算
    expect(countText(plain)).not.toBe(Math.ceil(plain.length / 2.5));
  });
});
