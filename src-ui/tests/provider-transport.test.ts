// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LLM 本地代理传输（provider/transport.ts）回归测试：
// - 后端代理可用（端口>0）时，请求转发到本地代理并携带 x-hologram-target。
// - 代理不可用（端口 0 / 后端取不到）时回退直连 fetch。
// 背景：2026-08-16 全链路断链审计 — provider 调用必须能走后端代理绕开 CORS。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyFetch, resetProxyPort } from '../src/provider/transport';

// 本地代理端口走 typedRpc → bridge.rpc；这里 mock 掉 bridge，使
// llm_proxy_port 返回指定端口。
vi.mock('../src/bridge', () => ({ rpc: vi.fn() }));
import { rpc } from '../src/bridge';

describe('provider/transport.proxyFetch', () => {
  beforeEach(() => {
    resetProxyPort();
    vi.restoreAllMocks();
    (rpc as unknown as ReturnType<typeof vi.fn>).mockReset();
    // 默认未 mock 全局 fetch 时，先给一个直连兜底实现（测试里一般不真正联网）。
    globalThis.fetch = vi.fn(async () => new Response('direct', { status: 200 })) as typeof fetch;
  });

  it('代理端口可用时转发到本地代理并带 target 头', async () => {
    (rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('14570');
    // 这里 fetch 应该被代理路径调用（local fetch），断言 URL 与 header。
    const fetchSpy = vi.fn(async () => new Response('ook', { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;

    const resp = await proxyFetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk' },
      body: '{}',
    });

    expect(resp).toBeTruthy();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:14570/proxy');
    const h = new Headers(init.headers);
    expect(h.get('x-hologram-target')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(h.get('Authorization')).toBe('Bearer sk');
    expect(init.method).toBe('POST');
  });

  it('代理端口不可用（返回非数字）时回退直连', async () => {
    (rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('{"mock":true,"note":"no proxy"}');
    const fetchSpy = vi.fn(async () => new Response('direct', { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;

    const resp = await proxyFetch('http://localhost:11434/v1/models');
    expect(resp).toBeTruthy();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/models');
    const h = new Headers(init.headers);
    expect(h.get('x-hologram-target')).toBeNull();
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('代理端口 RPC 抛错时回退直连', async () => {
    (rpc as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no backend'));
    const fetchSpy = vi.fn(async () => new Response('direct', { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;

    await proxyFetch('https://api.openai.com/v1/models');
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('https://api.openai.com/v1/models');
  });

  it('代理端口解析结果缓存（同一会话只取一次）', async () => {
    (rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('14570');
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;

    await proxyFetch('https://a.example/x');
    await proxyFetch('https://b.example/y');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
