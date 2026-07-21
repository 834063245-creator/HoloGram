// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  findModels,
  getAllModels,
  getCatalogProviders,
  getDefaultModel,
  getModel,
  searchModels,
} from '../src/provider/catalog';

describe('catalog', () => {
  it('loads models from all 6 providers', () => {
    const all = getAllModels();
    // deepseek(2) + anthropic(14) + openai(29) + moonshotai(10) + minimax(3) + qwen(5) = 63
    expect(all.length).toBeGreaterThanOrEqual(30);
  });

  it('returns all catalog provider names', () => {
    const providers = getCatalogProviders();
    expect(providers).toContain('deepseek');
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
    expect(providers).toContain('moonshotai');
    expect(providers).toContain('minimax');
    expect(providers).toContain('qwen-token-plan');
  });

  it('findModels returns only models for the specified provider', () => {
    const deepseekModels = findModels('deepseek');
    expect(deepseekModels.length).toBeGreaterThan(0);
    expect(deepseekModels.every((m) => m.provider === 'deepseek')).toBe(true);
    // Should include deepseek-v4-pro
    expect(deepseekModels.some((m) => m.id === 'deepseek-v4-pro')).toBe(true);
  });

  it('findModels returns empty array for unknown provider', () => {
    expect(findModels('nonexistent')).toEqual([]);
  });

  it('getModel returns a model by id', () => {
    const model = getModel('deepseek-v4-pro');
    expect(model).toBeDefined();
    if (!model) return; // narrow for type-checker
    expect(model.id).toBe('deepseek-v4-pro');
    expect(model.name).toBe('DeepSeek V4 Pro');
    expect(model.kind).toBe('openai');
    expect(model.provider).toBe('deepseek');
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

  it('searchModels matches by provider name', () => {
    const results = searchModels('anthropic');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((m) => m.provider === 'anthropic')).toBe(true);
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

  it('getDefaultModel returns a model for each known provider', () => {
    for (const providerName of ['deepseek', 'anthropic', 'openai', 'moonshotai', 'minimax', 'qwen-token-plan']) {
      const model = getDefaultModel(providerName);
      expect(model, `default model for ${providerName}`).toBeDefined();
      if (model) expect(model.provider).toBe(providerName);
    }
  });

  it('getDefaultModel returns undefined for unknown provider', () => {
    expect(getDefaultModel('nonexistent')).toBeUndefined();
  });

  it('anthropic models have kind=anthropic', () => {
    const anthropicModels = findModels('anthropic');
    expect(anthropicModels.every((m) => m.kind === 'anthropic')).toBe(true);
  });

  it('deepseek models have baseUrl ending with /v1', () => {
    const deepseekModels = findModels('deepseek');
    for (const m of deepseekModels) {
      expect(m.baseUrl).toMatch(/\/v1$/);
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
});
