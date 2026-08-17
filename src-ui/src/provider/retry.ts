// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HTTP 请求的共享重试逻辑 — 从 openai.ts 和 anthropic.ts 中提取

import { classifyError } from './types';
import { proxyFetch } from './transport';

export interface RetryConfig {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  name: string;
}

export function isRetryableStatus(s: number): boolean {
  return s === 408 || s === 429 || (s >= 500 && s <= 599);
}

/** POST 最多 3 次尝试，指数退避。抛出分类后的错误。 */
export async function sendWithRetry(cfg: RetryConfig): Promise<Response> {
  const maxAttempts = 3;
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = 500 * 2 ** (attempt - 1) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
    }
    if (cfg.signal.aborted) throw new Error(`${cfg.name}: aborted`);

    let resp: Response;
    try {
      resp = await proxyFetch(cfg.url, {
        method: 'POST',
        headers: cfg.headers,
        body: cfg.body,
        signal: cfg.signal,
      });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.name === 'AbortError') throw new Error(`${cfg.name}: aborted`);
      lastErr = new Error(classifyError(cfg.name, 0, '', e.message));
      continue;
    }

    if (resp.ok) return resp;

    const msg = await resp.text().catch(() => '');
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(classifyError(cfg.name, resp.status, msg));
    }
    const statusErr = new Error(classifyError(cfg.name, resp.status, msg));
    if (!isRetryableStatus(resp.status)) throw statusErr;
    lastErr = statusErr;
  }

  throw lastErr ?? new Error(`${cfg.name}: retry exhausted with no error`);
}
