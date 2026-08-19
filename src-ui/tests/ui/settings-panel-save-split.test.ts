// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SettingsPanel 保存拆域回归测试（P6/P9）：
// Provider dirty 与全局 dirty 互不牵连；任一保存成功后两个 dirty 一并复位。

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
const mockRpc = vi.fn(async () => 'null');
const mockConfigChanged = vi.fn();

vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('9.0.0') }));
vi.mock('../../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  listen: vi.fn(),
  isMockMode: () => true,
  rpc: (...args: unknown[]) => mockRpc(...args),
}));
vi.mock('../../src/i18n', () => ({ setLang: vi.fn() }));
vi.mock('../../src/state/agent-config-store', () => ({
  notifyAgentConfigChanged: (...args: unknown[]) => mockConfigChanged(...args),
}));
vi.mock('../../src/ui/icons', () => ({ iconHtml: () => '' }));

import { SettingsPanel } from '../../src/app/panels/SettingsPanel';

const STORAGE_KEY = 'hologram_settings';
const tick = () => new Promise((r) => setTimeout(r, 50));

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickTab(label: string): void {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('.sp-tab')].find((b) => b.textContent?.includes(label));
  tab?.click();
}

describe('SettingsPanel — 保存拆域', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    mockInvoke.mockReset();
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('null');
    mockConfigChanged.mockReset();
    localStorage.clear();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(createElement(SettingsPanel));
    await tick();
  });

  afterEach(() => {
    root?.unmount();
  });

  it('Provider tab 隐藏全局保存按钮，编辑后出现独立保存条', async () => {
    expect(document.querySelector('.sp-footer .sp-btn-save')).toBeNull();

    const urlInput = [...document.querySelectorAll<HTMLInputElement>('.pp-field input')].find((i) =>
      i.placeholder.includes('https://'),
    )!;
    setInputValue(urlInput, 'https://custom.example/v1');
    await tick();

    expect(document.querySelector('.pp-save-bar')).not.toBeNull();
    expect(document.querySelector('.sp-footer .sp-btn-save')).toBeNull();
  });

  it('保存 Provider：落盘 + 重建 Agent + 保存条消失', async () => {
    const urlInput = [...document.querySelectorAll<HTMLInputElement>('.pp-field input')].find((i) =>
      i.placeholder.includes('https://'),
    )!;
    setInputValue(urlInput, 'https://custom.example/v1');
    await tick();

    document.querySelector<HTMLButtonElement>('.pp-save-btn')!.click();
    await tick();

    expect(document.querySelector('.pp-save-bar')).toBeNull();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.providers.find((p: any) => p.name === 'deepseek').baseUrl).toBe('https://custom.example/v1');
    expect(mockConfigChanged).toHaveBeenCalledTimes(1);
    expect(mockConfigChanged).toHaveBeenCalledWith('settings-saved');
  });

  it('Provider dirty 不点亮全局保存；Provider 保存后全局保存仍禁用', async () => {
    const urlInput = [...document.querySelectorAll<HTMLInputElement>('.pp-field input')].find((i) =>
      i.placeholder.includes('https://'),
    )!;
    setInputValue(urlInput, 'https://custom.example/v1');
    await tick();

    clickTab('Agent');
    await tick();
    const globalSave = document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!;
    expect(globalSave).not.toBeNull();
    expect(globalSave.disabled).toBe(true); // 全局 dirty 未亮

    clickTab('Provider');
    await tick();
    expect(document.querySelector('.pp-save-bar')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.pp-save-btn')!.click();
    await tick();
    expect(document.querySelector('.pp-save-bar')).toBeNull();

    clickTab('Agent');
    await tick();
    expect(document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!.disabled).toBe(true);
  });

  it('全局保存只由非 Provider tab 的 dirty 点亮，保存后两域一并复位', async () => {
    clickTab('Agent');
    await tick();
    const save = document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!;
    expect(save.disabled).toBe(true);

    const ctxInput = document.querySelector<HTMLInputElement>('.sp-input-num')!;
    setInputValue(ctxInput, '8000');
    await tick();
    expect(save.disabled).toBe(false);

    save.click();
    await tick();
    expect(save.disabled).toBe(true);
    expect(mockConfigChanged).toHaveBeenCalledTimes(1);
    expect(mockConfigChanged).toHaveBeenCalledWith('settings-saved');
  });
});
