// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置收口测试（2026-08-07 provider 系统整合）：
//   1. loadSettingsWithSecrets — 读取含密钥设置的唯一入口（localStorage + 加密凭据回填）
//   2. onSettingsSaved — saveSettings 触发订阅（UI 响应式标签）
//   3. PROVIDER_PROTOCOL_DEFAULTS / defaultBaseUrl / isFactoryBaseUrl — URL 单一事实源

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as bridge from '../src/bridge';
import {
  defaultBaseUrl,
  isFactoryBaseUrl,
  loadSettings,
  loadSettingsWithSecrets,
  onSettingsSaved,
  PROVIDER_PROTOCOL_DEFAULTS,
  saveSettings,
} from '../src/settings';

vi.mock('../src/bridge', () => ({ rpc: vi.fn() }));

const STORAGE_KEY = 'hologram_settings';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('loadSettingsWithSecrets', () => {
  it('returns defaults with keys filled from credential store', async () => {
    (bridge.rpc as any).mockImplementation(async (method: string, params: any) => {
      if (method === 'credential_get' && params.provider === 'deepseek') return '"sk-deep"';
      return 'null';
    });
    const s = await loadSettingsWithSecrets();
    const deepseek = s.providers.find((p) => p.name === 'deepseek')!;
    expect(deepseek.apiKey).toBe('sk-deep');
    // 未命中凭据的 provider 保持空 key
    const anthropic = s.providers.find((p) => p.name === 'anthropic')!;
    expect(anthropic.apiKey).toBe('');
  });

  it('reads localStorage config and never persists keys back', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeProvider: 'custom',
        providers: [{ kind: 'openai', name: 'custom', apiKey: '', baseUrl: 'https://x.example/v1', model: 'm1' }],
      }),
    );
    (bridge.rpc as any).mockResolvedValue('"sk-custom"');
    const s = await loadSettingsWithSecrets();
    expect(s.activeProvider).toBe('custom');
    expect(s.providers[0].apiKey).toBe('sk-custom');
    // 铁律：回填密钥不得落回 localStorage
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.providers[0].apiKey).toBe('');
  });

  it('survives credential store failure (bridge down)', async () => {
    (bridge.rpc as any).mockRejectedValue(new Error('no backend'));
    const s = await loadSettingsWithSecrets();
    expect(s.providers.length).toBeGreaterThan(0);
  });
});

describe('onSettingsSaved', () => {
  it('fires on every saveSettings and stops after unsubscribe', () => {
    const calls: number[] = [];
    const off = onSettingsSaved(() => calls.push(1));
    saveSettings(loadSettings());
    saveSettings(loadSettings());
    off();
    saveSettings(loadSettings());
    expect(calls).toHaveLength(2);
  });

  it('saveSettings still strips apiKey from localStorage (铁律回归)', () => {
    const s = loadSettings();
    s.providers[0].apiKey = 'sk-secret';
    saveSettings(s);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.providers[0].apiKey).toBe('');
  });
});

describe('provider URL 单一事实源', () => {
  it('PROVIDER_PROTOCOL_DEFAULTS covers both protocols', () => {
    expect(PROVIDER_PROTOCOL_DEFAULTS.anthropic).toBe('https://api.anthropic.com');
    expect(PROVIDER_PROTOCOL_DEFAULTS.openai).toBe('https://api.openai.com/v1');
  });

  it('defaultBaseUrl prefers catalog entry, falls back to protocol default', () => {
    // 目录内厂商 → 目录 baseUrl
    expect(defaultBaseUrl('deepseek', 'openai')).toBe('https://api.deepseek.com/v1');
    // 目录外厂商 → 协议默认
    expect(defaultBaseUrl('my-local-llm', 'openai')).toBe('https://api.openai.com/v1');
    expect(defaultBaseUrl('my-claude-proxy', 'anthropic')).toBe('https://api.anthropic.com');
  });

  it('isFactoryBaseUrl recognizes defaults but not user-customized URLs', () => {
    expect(isFactoryBaseUrl('https://api.deepseek.com/v1')).toBe(true);
    expect(isFactoryBaseUrl('https://api.anthropic.com')).toBe(true);
    expect(isFactoryBaseUrl('https://api.openai.com/v1')).toBe(true);
    expect(isFactoryBaseUrl('https://my-proxy.internal/v1')).toBe(false);
  });

  it('DEFAULTS use the centralized URLs', () => {
    const s = loadSettings();
    expect(s.providers.find((p) => p.name === 'deepseek')!.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(s.providers.find((p) => p.name === 'anthropic')!.baseUrl).toBe('https://api.anthropic.com');
  });
});
