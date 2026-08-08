// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  findModels,
  getAllModels,
  getDefaultModel,
  getModel,
  mergeDynamicModels,
  searchModels,
  getCatalogVendors,
} from '../src/provider/catalog';
import { guessReasoning } from '../src/provider/openai';

describe('catalog', () => {
  it('loads models from all catalog providers', () => {
    const all = getAllModels();
    // deepseek(2) + anthropic(14) + openai(29) + moonshotai(10) + minimax(3) + qwen(5) + glm(3) + ollama(3)
    expect(all.length).toBeGreaterThanOrEqual(30);
  });

  it('returns all catalog vendor names', () => {
    const vendors = getCatalogVendors();
    expect(vendors).toContain('deepseek');
    expect(vendors).toContain('anthropic');
    expect(vendors).toContain('openai');
    expect(vendors).toContain('moonshotai');
    expect(vendors).toContain('minimax');
    expect(vendors).toContain('qwen-token-plan');
    expect(vendors).toContain('glm');
    expect(vendors).toContain('ollama');
  });

  it('findModels returns only models for the specified vendor', () => {
    const deepseekModels = findModels('deepseek');
    expect(deepseekModels.length).toBeGreaterThan(0);
    expect(deepseekModels.every((m) => m.vendor === 'deepseek')).toBe(true);
    // Should include deepseek-v4-pro
    expect(deepseekModels.some((m) => m.id === 'deepseek-v4-pro')).toBe(true);
  });

  it('findModels returns empty array for unknown vendor', () => {
    expect(findModels('nonexistent')).toEqual([]);
  });

  it('getModel returns a model by id', () => {
    const model = getModel('deepseek-v4-pro');
    expect(model).toBeDefined();
    if (!model) return; // narrow for type-checker
    expect(model.id).toBe('deepseek-v4-pro');
    expect(model.name).toBe('DeepSeek V4 Pro');
    expect(model.kind).toBe('openai');
    expect(model.vendor).toBe('deepseek');
    expect(model.reasoning).toBe(true);
    expect(model.contextWindow).toBeGreaterThan(0);
  });

  it('getModel returns undefined for unknown model id', () => {
    expect(getModel('nonexistent-model')).toBeUndefined();
  });

  it('searchModels matches by id substring', () => {
    const results = searchModels('deepseek');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((m) => m.id.includes('deepseek'))).toBe(true);
  });

  it('searchModels matches by vendor name', () => {
    const results = searchModels('anthropic');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((m) => m.vendor === 'anthropic')).toBe(true);
  });

  it('searchModels is case-insensitive', () => {
    const lower = searchModels('claude');
    const upper = searchModels('CLAUDE');
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBeGreaterThan(0);
  });

  it('searchModels returns all models for empty query', () => {
    const all = searchModels('');
    const allDirect = getAllModels();
    expect(all.length).toBe(allDirect.length);
  });

  it('getDefaultModel returns a model for each known vendor', () => {
    for (const providerName of [
      'deepseek',
      'anthropic',
      'openai',
      'moonshotai',
      'minimax',
      'qwen-token-plan',
      'glm',
      'ollama',
    ]) {
      const model = getDefaultModel(providerName);
      expect(model, `default model for ${providerName}`).toBeDefined();
      if (model) expect(model.vendor).toBe(providerName);
    }
  });

  it('getDefaultModel returns undefined for unknown vendor', () => {
    expect(getDefaultModel('nonexistent')).toBeUndefined();
  });

  it('anthropic models have kind=anthropic', () => {
    const anthropicModels = findModels('anthropic');
    expect(anthropicModels.every((m) => m.kind === 'anthropic')).toBe(true);
  });

  it('deepseek models have baseUrl ending with /v1 (OpenAI protocol)', () => {
    const deepseekModels = findModels('deepseek');
    for (const m of deepseekModels) {
      if (m.kind === 'openai') expect(m.baseUrl).toMatch(/\/v1$/);
    }
  });

  it('all models have valid cost structure', () => {
    for (const m of getAllModels()) {
      expect(m.cost).toBeDefined();
      expect(typeof m.cost.input).toBe('number');
      expect(typeof m.cost.output).toBe('number');
      expect(typeof m.cost.cacheRead).toBe('number');
    }
  });

  it('no model declares image input (P0: 多模态未落地，禁止假声明)', () => {
    for (const m of getAllModels()) {
      expect(m.input.includes('image'), `${m.id} declares image input`).toBe(false);
    }
  });

  it('mergeDynamicModels adds out-of-catalog ids, skips existing ones', () => {
    mergeDynamicModels('testprov', [
      {
        id: 'brand-new-model-x',
        name: 'Brand New',
        kind: 'openai',
        vendor: 'testprov',
        baseUrl: 'https://api.testprov.com/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.1, output: 0.2, cacheRead: 0 },
        contextWindow: 0,
        maxTokens: 0,
      },
      {
        id: 'deepseek-v4-pro', // 静态目录已有 — 应被跳过（静态元数据优先）
        name: 'stale',
        kind: 'openai',
        vendor: 'testprov',
        baseUrl: 'https://stale.invalid/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0 },
        contextWindow: 0,
        maxTokens: 0,
      },
    ]);
    const added = getModel('brand-new-model-x');
    expect(added).toBeDefined();
    expect(added?.vendor).toBe('testprov');
    // 静态条目未被覆盖
    const staticOne = getModel('deepseek-v4-pro');
    expect(staticOne?.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('guessReasoning heuristic (P0: 动态模型 reasoning 启发式)', () => {
    expect(guessReasoning('deepseek-v4-pro')).toBe(true);
    expect(guessReasoning('deepseek-reasoner')).toBe(true);
    expect(guessReasoning('kimi-k2-thinking')).toBe(true);
    expect(guessReasoning('gpt-4o')).toBe(false);
    expect(guessReasoning('claude-3-5-sonnet')).toBe(false);
  });
});
