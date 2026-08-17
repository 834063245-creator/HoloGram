// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LLM 本地代理传输 — 把 provider 的真实 HTTP 调用转发到 Rust 侧反向代理，
// 绕开 WebView 的 CORS 限制（2026-08-16 全链路断链审计）。
//
// 背景：provider 请求从 WebView 直接 fetch 受浏览器 CORS 约束——Anthropic/OpenAI
// 不返回 Access-Control-Allow-Origin，浏览器必被挡；只有少数厂商放行。Rust 侧
// （src-tauri/src/llm_proxy.rs）起了一个 127.0.0.1 本地代理，本模块把
// fetch(url) 改造成 fetch(http://127.0.0.1:<port>, { x-hologram-target: url })。
//
// 降级：代理端口取不到（dev 无后端 / 端口 0）→ 回退直连。直连对本地端点
// （Ollama 等本就走 127.0.0.1，无 CORS 问题）与测试（mock fetch）仍然成立。

import { typedRpc } from '../rpc-contract';

let portResolved = 0;
let portPromise: Promise<number> | null = null;

/** 惰性解析代理端口（一次性）。0 = 不可用（回退直连）。 */
export function getProxyPort(): Promise<number> {
  if (portResolved) return Promise.resolve(portResolved);
  if (!portPromise) {
    portPromise = (async () => {
      try {
        // typedRpc 返回 string；parse 出端口号
        const raw = await typedRpc('llm_proxy_port', {});
        const n = Number.parseInt(String(raw ?? '').trim(), 10);
        if (Number.isFinite(n) && n > 0 && n < 65536) {
          portResolved = n;
          return n;
        }
      } catch {
        /* 后端不可用（dev / 测试）— 回退直连 */
      }
      return 0;
    })();
  }
  return portPromise;
}

/** 重置缓存的代理端口（测试/热更新用）。 */
export function resetProxyPort(): void {
  portResolved = 0;
  portPromise = null;
}

/**
 * 转发 provider 请求——优先走本地后端代理（绕 CORS），代理不可用则直连。
 * 保持与原生 fetch 相同的签名契约（method/headers/body/signal），供
 * openai.ts / anthropic.ts / shared.ts 直接替换使用。
 */
export async function proxyFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<Response> {
  const port = await getProxyPort();
  if (!port) return fetch(url, init);

  const { signal, ...rest } = init;
  const headers = new Headers(rest.headers || {});
  headers.set('x-hologram-target', url);
  // 浏览器自动加的 host 等 hop-by-hop 头由 Rust 侧过滤，这里直接删 host
  headers.delete('host');
  return fetch(`http://127.0.0.1:${port}/proxy`, {
    ...rest,
    method: rest.method || 'GET',
    headers,
    signal,
  });
}
