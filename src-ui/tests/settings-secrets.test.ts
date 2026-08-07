// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// restoreSecrets / parseRpcString 回归测试。
// 背景（2026-08-07 实锤）：rpc 返回 JSON 编码字符串（"sk-xxx" 带引号），
// restoreSecrets 曾直接 trim 导致 key 前后残留双引号——provider 读 KEY 链路断裂。
// 2026-08-04 治理后 localStorage 不再存明文，此路径才首次真正被走到。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as bridge from '../src/bridge';
import { loadSettings, parseRpcString, persistSecrets, restoreSecrets } from '../src/settings';

vi.mock('../src/bridge', () => ({ rpc: vi.fn() }));

describe('parseRpcString', () => {
  it('unwraps JSON-encoded string (双引号回归)', () => {
    expect(parseRpcString('"sk-abc123"')).toBe('sk-abc123');
  });

  it('passes through plain string (Tauri 行为变化的兼容形态)', () => {
    expect(parseRpcString('sk-abc123')).toBe('sk-abc123');
  });

  it('returns null for JSON null / empty / non-string', () => {
    expect(parseRpcString('null')).toBeNull();
    expect(parseRpcString('')).toBeNull();
    expect(parseRpcString(null)).toBeNull();
    expect(parseRpcString('{}')).toBeNull();
    expect(parseRpcString(123 as unknown)).toBeNull();
  });

  it('returns null for JSON-encoded "null" literal (null 复活回归)', () => {
    // 凭据库里被写入字面量 "null" 后，rpc 返回带引号的 '"null"'——
    // parse 出字符串 "null" 必须按 null 处理，否则回填后重新写回、删不掉
    expect(parseRpcString('"null"')).toBeNull();
    expect(parseRpcString(' "null" ')).toBeNull();
  });
});

describe('restoreSecrets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fills apiKey from credential store, unwrapping JSON quotes (读 KEY 链路回归)', async () => {
    (bridge.rpc as any).mockResolvedValue('"sk-encrypted-key"');
    const s = { activeProvider: 'deepseek', providers: [{ name: 'deepseek', apiKey: '' }] } as any;
    const out = await restoreSecrets(s);
    expect(out.providers[0].apiKey).toBe('sk-encrypted-key');
    expect(bridge.rpc).toHaveBeenCalledWith('credential_get', { provider: 'deepseek' });
  });

  it('skips providers that already have a key', async () => {
    const s = { activeProvider: 'deepseek', providers: [{ name: 'deepseek', apiKey: 'sk-existing' }] } as any;
    await restoreSecrets(s);
    expect(bridge.rpc).not.toHaveBeenCalled();
  });

  it('ignores null credential', async () => {
    (bridge.rpc as any).mockResolvedValue('null');
    const s = { activeProvider: 'deepseek', providers: [{ name: 'deepseek', apiKey: '' }] } as any;
    const out = await restoreSecrets(s);
    expect(out.providers[0].apiKey).toBe('');
  });

  it('survives rpc failure without throwing', async () => {
    (bridge.rpc as any).mockRejectedValue(new Error('dpapi failed'));
    const s = { activeProvider: 'deepseek', providers: [{ name: 'deepseek', apiKey: '' }] } as any;
    const out = await restoreSecrets(s);
    expect(out.providers[0].apiKey).toBe('');
  });

  it('ignores stored "null" literal (null 复活回归)', async () => {
    (bridge.rpc as any).mockResolvedValue('"null"');
    const s = { activeProvider: 'deepseek', providers: [{ name: 'deepseek', apiKey: '' }] } as any;
    const out = await restoreSecrets(s);
    expect(out.providers[0].apiKey).toBe('');
  });
});

describe('persistSecrets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores non-empty keys only', async () => {
    (bridge.rpc as any).mockResolvedValue('null');
    const s = {
      activeProvider: 'deepseek',
      providers: [
        { name: 'deepseek', apiKey: 'sk-new' },
        { name: 'anthropic', apiKey: '' },
      ],
    } as any;
    await persistSecrets(s);
    expect(bridge.rpc).toHaveBeenCalledTimes(1);
    expect(bridge.rpc).toHaveBeenCalledWith('credential_store', { provider: 'deepseek', key: 'sk-new' });
  });

  it('never deletes on empty key (未回填竞态误删回归)', async () => {
    (bridge.rpc as any).mockResolvedValue('null');
    const s = { activeProvider: 'deepseek', providers: [{ name: 'deepseek', apiKey: '' }] } as any;
    await persistSecrets(s);
    const calls = (bridge.rpc as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).not.toContain('credential_delete');
  });

  it('never stores "null" literal (null 复活回归)', async () => {
    (bridge.rpc as any).mockResolvedValue('null');
    const s = { activeProvider: 'deepseek', providers: [{ name: 'deepseek', apiKey: 'null' }] } as any;
    await persistSecrets(s);
    expect(bridge.rpc).not.toHaveBeenCalled();
  });
});

describe('loadSettings', () => {
  it('sanitizes apiKey:"null" literal from localStorage (毒化残留清洗)', () => {
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'deepseek',
        providers: [
          { name: 'deepseek', apiKey: 'null' },
          { name: 'glm', apiKey: '' },
        ],
      }),
    );
    const s = loadSettings();
    expect(s.providers[0].apiKey).toBe('');
    localStorage.removeItem('hologram_settings');
  });
});
