// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { effortVendor, thinkingModesFor, toOpenAIEffort } from '../src/provider/thinking';

describe('effortVendor', () => {
  it('anthropic kind always maps to anthropic', () => {
    expect(effortVendor('anything', 'anthropic')).toBe('anthropic');
  });

  it('recognizes deepseek by name, baseUrl, or model', () => {
    expect(effortVendor('deepseek', 'openai')).toBe('deepseek');
    expect(effortVendor('my-ds', 'openai', 'https://api.deepseek.com/v1')).toBe('deepseek');
    expect(effortVendor('my-ds', 'openai', '', 'deepseek-v4-pro')).toBe('deepseek');
  });

  it('recognizes openai by name, baseUrl, or model prefix', () => {
    expect(effortVendor('openai', 'openai')).toBe('openai');
    expect(effortVendor('gpt-box', 'openai', 'https://api.openai.com/v1')).toBe('openai');
    expect(effortVendor('gpt-box', 'openai', '', 'gpt-5.4')).toBe('openai');
  });

  it('unknown for vendors without effort evidence', () => {
    expect(effortVendor('glm', 'openai')).toBe('unknown');
    expect(effortVendor('mimo', 'openai', 'https://api.mimo.com/v1')).toBe('unknown');
    expect(effortVendor('', 'openai')).toBe('unknown');
  });
});

describe('toOpenAIEffort', () => {
  it('deepseek: only high/max on the wire; low/medium normalize to high', () => {
    expect(toOpenAIEffort('deepseek', 'low')).toBe('high');
    expect(toOpenAIEffort('deepseek', 'medium')).toBe('high');
    expect(toOpenAIEffort('deepseek', 'high')).toBe('high');
    expect(toOpenAIEffort('deepseek', 'max')).toBe('max');
    expect(toOpenAIEffort('deepseek', '')).toBeUndefined();
    expect(toOpenAIEffort('deepseek', 'off')).toBeUndefined();
  });

  it('openai: low/medium/high pass through; max degrades to high', () => {
    expect(toOpenAIEffort('openai', 'low')).toBe('low');
    expect(toOpenAIEffort('openai', 'medium')).toBe('medium');
    expect(toOpenAIEffort('openai', 'high')).toBe('high');
    expect(toOpenAIEffort('openai', 'max')).toBe('high');
    expect(toOpenAIEffort('openai', '')).toBeUndefined();
  });

  it('unknown: never fabricates effort', () => {
    expect(toOpenAIEffort('unknown', 'high')).toBeUndefined();
    expect(toOpenAIEffort('unknown', 'max')).toBeUndefined();
  });
});

describe('thinkingModesFor', () => {
  it('anthropic keeps all six modes', () => {
    const modes = thinkingModesFor('anthropic', 'anthropic');
    expect(modes.map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'max', 'off']);
  });

  it('deepseek hides low/medium', () => {
    const modes = thinkingModesFor('openai', 'deepseek');
    expect(modes.map((o) => o.value)).toEqual(['', 'high', 'max', 'off']);
  });

  it('openai keeps all modes and annotates max degradation', () => {
    const modes = thinkingModesFor('openai', 'openai');
    expect(modes.map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'max', 'off']);
    expect(modes.find((o) => o.value === 'max')?.label).toContain('high');
  });

  it('unknown vendors get no effort UI (fallback to deep-think switch)', () => {
    expect(thinkingModesFor('openai', 'glm')).toEqual([]);
  });
});
