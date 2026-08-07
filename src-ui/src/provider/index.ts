// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider factory — unified entry point for creating Provider instances from settings

import type { ProviderSettings } from '../settings';
import { createAnthropicProvider } from './anthropic';
import { createOpenAIProvider } from './openai';
import type { Provider } from './types';

export interface CreateProviderOptions {
  /** Disable reasoning/thinking on OpenAI-compatible providers (e.g. for translation). */
  disableThinking?: boolean;
}

/** Create a Provider from ProviderSettings, dispatching to the correct implementation. */
export function createProvider(settings: ProviderSettings, options?: CreateProviderOptions): Provider {
  if (settings.kind === 'anthropic') {
    return createAnthropicProvider({
      name: settings.name,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      // disableThinking 语义统一到两种协议：true → 强制关闭扩展思考。
      // 翻译器/摘要路径都传 disableThinking: true，anthropic 在此同样关闭。
      thinking: options?.disableThinking ? 'off' : settings.thinking || undefined,
    });
  }
  return createOpenAIProvider({
    name: settings.name,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    disableThinking: options?.disableThinking,
  });
}
