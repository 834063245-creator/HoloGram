// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// API retry — error classification + exponential backoff
// CC ref: services/api/errors.ts:1163-1182, withRetry.ts

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 16000;
const JITTER_MS = 1000;

/** Check if an error is worth retrying. */
export function isRetryable(err: Error): boolean {
  const msg = err.message || String(err);
  // Abort → don't retry
  if (
    msg.includes('[已取消]') ||
    err.name === 'AbortError' ||
    msg.includes('aborted')
  )
    return false;

  // Auth / permissions → don't retry (won't fix itself)
  if (
    msg.includes('[密钥错误]') ||
    msg.includes('[权限不足]') ||
    msg.includes('[余额不足]') ||
    msg.includes('[模型不存在]') ||
    msg.includes('[地址错误]') ||
    msg.includes('[用户输入错误]')
  )
    return false;

  // Rate limit / server errors / overload → retry
  if (
    msg.includes('[服务商限流]') ||
    msg.includes('[服务商故障]') ||
    msg.includes('[服务商繁忙]')
  )
    return true;

  // Network errors — retry timeouts and resets, but not DNS/config errors
  if (msg.includes('[网络问题]')) {
    if (msg.includes('超时') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED'))
      return true;
    // ENOTFOUND / getaddrinfo = DNS → won't fix itself
    return false;
  }

  // Unknown errors → retry once (might be transient)
  if (msg.includes('[未知错误]')) return true;

  // Catch-all: raw fetch errors (network flakes)
  if (
    err.name === 'TypeError' &&
    (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch'))
  )
    return true;

  return false;
}

/** Exponential backoff with full jitter: delay = min(base*2^attempt, max) + rand(0, jitter). */
export function backoffDelay(attempt: number): number {
  const exp = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  return exp + Math.floor(Math.random() * JITTER_MS);
}

/** Wait for a delay, but abort if the signal fires first. Returns true if aborted. */
export async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export { MAX_RETRIES };
