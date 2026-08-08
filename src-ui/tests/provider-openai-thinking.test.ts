// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildChatRequest } from '../src/provider/openai';
import type { Message } from '../src/provider/types';

const msgs: Message[] = [{ role: 'user', content: 'hi' }];

describe('buildChatRequest — thinking / reasoning_effort wire', () => {
  it('deepseek high → thinking enabled + effort high', () => {
    const body = buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'high', 'deepseek');
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('deepseek max passes through', () => {
    const body = buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'max', 'deepseek');
    expect(body.reasoning_effort).toBe('max');
  });

  it('deepseek low/medium normalize to high (server would coerce anyway)', () => {
    expect(buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'low', 'deepseek').reasoning_effort).toBe('high');
    expect(buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'medium', 'deepseek').reasoning_effort).toBe('high');
  });

  it('deepseek auto sends nothing (server default high)', () => {
    const body = buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, '', 'deepseek');
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('deepseek off disables thinking', () => {
    const body = buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'off', 'deepseek');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('openai low/medium/high pass through; max degrades to high', () => {
    expect(buildChatRequest(msgs, [], 'gpt-5.4', 100, 'low', 'openai').reasoning_effort).toBe('low');
    expect(buildChatRequest(msgs, [], 'gpt-5.4', 100, 'medium', 'openai').reasoning_effort).toBe('medium');
    expect(buildChatRequest(msgs, [], 'gpt-5.4', 100, 'high', 'openai').reasoning_effort).toBe('high');
    const max = buildChatRequest(msgs, [], 'gpt-5.4', 100, 'max', 'openai');
    expect(max.reasoning_effort).toBe('high');
    expect(max.thinking).toEqual({ type: 'enabled' });
  });

  it('openai off disables thinking', () => {
    const body = buildChatRequest(msgs, [], 'gpt-5.4', 100, 'off', 'openai');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('unknown vendor ignores named tiers (no fabricated params)', () => {
    const body = buildChatRequest(msgs, [], 'glm-5', 100, 'high', 'unknown');
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});
