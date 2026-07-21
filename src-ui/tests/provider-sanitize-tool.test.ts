// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { type Message, sanitizeToolPairing } from '../src/provider/types';

describe('sanitizeToolPairing', () => {
  it('passes through normal messages', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = sanitizeToolPairing(msgs);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('keeps assistant tool_calls with matching tool results', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'What is the weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: 'Sunny, 25°C' },
      { role: 'assistant', content: 'The weather in Tokyo is sunny, 25°C.' },
    ];
    const result = sanitizeToolPairing(msgs);
    expect(result).toHaveLength(4);
    // tool result preserved
    expect(result[2].role).toBe('tool');
    expect(result[2].content).toBe('Sunny, 25°C');
  });

  it('inserts placeholder for missing tool results', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'What is the weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }],
      },
      // No tool result follows — was interrupted
      { role: 'user', content: 'Never mind, tell me a joke' },
    ];
    const result = sanitizeToolPairing(msgs);
    // user + assistant(tool_calls) + tool(placeholder) + next user
    expect(result).toHaveLength(4);
    expect(result[2].role).toBe('tool');
    expect(result[2].content).toContain('interrupted');
    expect(result[3].role).toBe('user');
  });

  it('drops orphan tool messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Hello' },
      // Orphan tool message with no preceding assistant tool_calls
      { role: 'tool', tool_call_id: 'orphan_1', name: 'some_tool', content: 'orphan result' },
      { role: 'assistant', content: 'Hi' },
    ];
    const result = sanitizeToolPairing(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('drops empty assistant messages (DeepSeek rejects them)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = sanitizeToolPairing(msgs);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe('Hi there');
  });

  it('handles multiple tool calls in one assistant message', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Check both' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', name: 'tool_a', arguments: '{}' },
          { id: 'call_2', name: 'tool_b', arguments: '{}' },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'tool_a', content: 'result_a' },
      { role: 'tool', tool_call_id: 'call_2', name: 'tool_b', content: 'result_b' },
      { role: 'assistant', content: 'Done' },
    ];
    const result = sanitizeToolPairing(msgs);
    // user + assistant(tool_calls) + tool_a + tool_b + assistant
    expect(result).toHaveLength(5);
    expect(result[2].content).toBe('result_a');
    expect(result[3].content).toBe('result_b');
  });

  it('handles partial missing results among multiple calls', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Check both' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', name: 'tool_a', arguments: '{}' },
          { id: 'call_2', name: 'tool_b', arguments: '{}' },
        ],
      },
      // Only call_1 has a result, call_2 was interrupted
      { role: 'tool', tool_call_id: 'call_1', name: 'tool_a', content: 'result_a' },
    ];
    const result = sanitizeToolPairing(msgs);
    // user + assistant(tool_calls) + tool_a (real result) + tool_b (placeholder)
    expect(result).toHaveLength(4);
    expect(result[2].role).toBe('tool');
    expect(result[2].content).toBe('result_a');
    expect(result[3].role).toBe('tool');
    expect(result[3].content).toContain('interrupted');
  });
});
