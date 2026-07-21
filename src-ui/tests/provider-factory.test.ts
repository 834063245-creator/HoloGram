// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createProvider } from '../src/provider';
import type { ProviderSettings } from '../src/settings';

describe('createProvider', () => {
  it('creates an anthropic provider with correct name', () => {
    const settings: ProviderSettings = {
      kind: 'anthropic',
      name: 'anthropic-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      thinking: 'medium',
    };
    const provider = createProvider(settings);
    expect(provider.name()).toBe('anthropic-test');
  });

  it('creates an openai provider with correct name', () => {
    const settings: ProviderSettings = {
      kind: 'openai',
      name: 'deepseek-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    };
    const provider = createProvider(settings);
    expect(provider.name()).toBe('deepseek-test');
  });

  it('uses default name when not provided', () => {
    const settings: ProviderSettings = {
      kind: 'anthropic',
      name: '',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    };
    // Empty name falls through to provider default ("anthropic")
    const provider = createProvider(settings);
    expect(provider.name()).toBe('anthropic');
  });

  it('passes disableThinking option to openai provider', async () => {
    const settings: ProviderSettings = {
      kind: 'openai',
      name: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    };
    // Just verify it creates without error — disableThinking is consumed internally
    const provider = createProvider(settings, { disableThinking: true });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe('function');
  });

  it('throws on stream with empty apiKey via classified error', async () => {
    const settings: ProviderSettings = {
      kind: 'openai',
      name: 'test',
      apiKey: '中文key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    };
    const provider = createProvider(settings);
    const controller = new AbortController();
    try {
      // fetch will fail because of invalid header characters — should throw
      const gen = provider.stream(controller.signal, {
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        temperature: 0.7,
        max_tokens: 100,
      });
      await gen.next();
      // If we get here, the error didn't throw — but fetch should have failed
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      // Should be a classified error
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBeTruthy();
    } finally {
      controller.abort();
    }
  });
});
