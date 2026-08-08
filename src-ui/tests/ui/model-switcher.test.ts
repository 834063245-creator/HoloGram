// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSwitcher（聊天面板模型切换器）组件测试：
// 切模型 / 切信号源 / 思考强度 / 深度思考开关 → 立即 saveSettings + 重建 Agent。

import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSave = vi.fn();
const mockRebuild = vi.fn();
const mockOpenSettings = vi.fn();

const mockModels = [
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    kind: 'openai',
    vendor: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 2, output: 8, cacheRead: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: 'deepseek-v4',
    name: 'DeepSeek V4',
    kind: 'openai',
    vendor: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 1, output: 4, cacheRead: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    kind: 'anthropic',
    vendor: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text'],
    cost: { input: 3, output: 15, cacheRead: 0.3 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
];

const mockDefaultUrls = new Set(['https://api.deepseek.com/v1', 'https://api.anthropic.com']);

vi.mock('../../src/ui/icons', () => ({ iconHtml: () => '' }));
vi.mock('../../src/provider/catalog', () => ({
  getAllModels: () => mockModels,
  getDefaultModel: (name: string) => mockModels.find((m) => m.vendor === name) ?? undefined,
}));
vi.mock('../../src/settings', () => ({
  getActiveProvider: (s: any) => s.providers.find((p: any) => p.name === s.activeProvider) || s.providers[0],
  isFactoryBaseUrl: (u: string) => mockDefaultUrls.has(u),
  saveSettings: (s: any) => mockSave(s),
  updateProvider: (s: any, name: string, patch: any) => ({
    ...s,
    providers: s.providers.map((p: any) => (p.name === name ? { ...p, ...patch } : p)),
  }),
}));
vi.mock('../../src/ui/dock-config', () => ({ getOnSettingsSave: () => mockRebuild }));

import { ModelSwitcher } from '../../src/ui/react/ModelSwitcher';
import type { AppSettings } from '../../src/settings';

function makeSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    activeProvider: 'deepseek',
    providers: [
      {
        kind: 'openai',
        name: 'deepseek' as any,
        apiKey: 'sk-deep',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
      },
      {
        kind: 'anthropic',
        name: 'anthropic' as any,
        apiKey: 'sk-anth',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        thinking: '',
      },
    ],
    projectPath: '.',
    agent: { temperature: 0.7, contextWindow: 0, disableThinking: false },
    display: { language: 'zh', fontScale: 1 },
    ...overrides,
  };
}

describe('ModelSwitcher', () => {
  let container: HTMLElement;
  let root: Root;

  const render = async (settings: AppSettings) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(ModelSwitcher, { settings, onOpenSettings: mockOpenSettings }));
    });
  };

  const click = async (el: Element | null) => {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  beforeEach(() => {
    mockSave.mockReset();
    mockRebuild.mockReset();
    mockOpenSettings.mockReset();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    root?.unmount();
  });

  it('opens popover: current-vendor models + deep-think switch for openai', async () => {
    await render(makeSettings());
    await click(document.querySelector('.chat-model-clickable'));

    expect(document.querySelector('.ms-pop')).not.toBeNull();
    expect(document.querySelector('.ms-pop-check')).not.toBeNull(); // deepseek = openai → 深度思考开关
    const trigger = document.querySelector<HTMLButtonElement>('.chat-model-clickable')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.ms-pop')?.getAttribute('role')).toBe('menu');
    const modelItems = [
      ...document.querySelector<HTMLDivElement>('.ms-pop-list')!.querySelectorAll<HTMLButtonElement>('.ms-pop-item'),
    ];
    expect(modelItems.every((b) => b.getAttribute('role') === 'menuitemradio')).toBe(true);
    const selected = modelItems.find((b) => b.classList.contains('selected'));
    expect(selected?.getAttribute('aria-checked')).toBe('true');
    const ids = [...document.querySelectorAll('.ms-pop-item-id')].map((n) => n.textContent);
    expect(ids).toContain('deepseek-v4');
    expect(ids).not.toContain('claude-sonnet-4-6'); // 当前信号源只列自己的模型
  });

  it('selecting a model saves immediately and rebuilds agent', async () => {
    await render(makeSettings());
    await click(document.querySelector('.chat-model-clickable'));
    await click([...document.querySelectorAll('.ms-pop-item')].find((n) => n.textContent?.includes('deepseek-v4'))!);

    expect(mockSave).toHaveBeenCalledTimes(1);
    const next = mockSave.mock.calls[0][0] as AppSettings;
    expect(next.providers[0].model).toBe('deepseek-v4');
    expect(next.providers[0].baseUrl).toBe('https://api.deepseek.com/v1'); // 出厂 URL 自动带出
    expect(mockRebuild).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.ms-pop')).toBeNull(); // 选择后关闭
  });

  it('switching provider saves activeProvider and closes popover', async () => {
    await render(makeSettings());
    await click(document.querySelector('.chat-model-clickable'));
    await click([...document.querySelectorAll('.ms-pop-item')].find((n) => n.textContent?.includes('anthropic'))!);

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect((mockSave.mock.calls[0][0] as AppSettings).activeProvider).toBe('anthropic');
    expect(mockRebuild).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.ms-pop')).toBeNull();
  });

  it('thinking effort writes to provider and keeps popover open (anthropic)', async () => {
    await render(makeSettings({ activeProvider: 'anthropic' }));
    await click(document.querySelector('.chat-model-clickable'));

    const sel = document.querySelector<HTMLSelectElement>('.ms-pop-select');
    expect(sel).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(sel, 'high');
      sel!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(mockSave).toHaveBeenCalledTimes(1);
    const next = mockSave.mock.calls[0][0] as AppSettings;
    expect(next.providers[1].thinking).toBe('high');
    expect(document.querySelector('.ms-pop')).not.toBeNull(); // 思考设置不关闭弹层
  });

  it('deep-think toggle flips global disableThinking and keeps popover open', async () => {
    await render(makeSettings());
    await click(document.querySelector('.chat-model-clickable'));

    const box = document.querySelector<HTMLInputElement>('.ms-pop-check input');
    await click(box);

    expect(mockSave).toHaveBeenCalledTimes(1);
    const next = mockSave.mock.calls[0][0] as AppSettings;
    expect(next.agent.disableThinking).toBe(true);
    expect(document.querySelector('.ms-pop')).not.toBeNull();
  });
});
