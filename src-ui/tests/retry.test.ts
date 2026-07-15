// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { backoffDelay, isRetryable, sleepWithAbort } from '../src/agent/retry';

describe('isRetryable', () => {
  it('retries rate limit errors', () => {
    expect(isRetryable(new Error('[服务商限流] "test" 请求过于频繁'))).toBe(true);
  });

  it('retries server errors (5xx)', () => {
    expect(isRetryable(new Error('[服务商故障] "test" 服务器异常 (503)'))).toBe(true);
  });

  it('retries overload errors', () => {
    expect(isRetryable(new Error('[服务商繁忙] "test" 当前负载过高'))).toBe(true);
  });

  it('retries connection timeout', () => {
    expect(isRetryable(new Error('[网络问题] 连接 "test" 超时'))).toBe(true);
  });

  it('retries connection reset', () => {
    expect(isRetryable(new Error('[网络问题] ECONNRESET'))).toBe(true);
  });

  it('retries unknown errors once', () => {
    expect(isRetryable(new Error('[未知错误] "test" 返回了意外错误 (500)'))).toBe(true);
  });

  it('does NOT retry auth errors', () => {
    expect(isRetryable(new Error('[密钥错误] "test" API Key 无效'))).toBe(false);
  });

  it('does NOT retry permission errors', () => {
    expect(isRetryable(new Error('[权限不足] "test" 拒绝了请求'))).toBe(false);
  });

  it('does NOT retry insufficient quota', () => {
    expect(isRetryable(new Error('[余额不足] "test" 账户余额不足'))).toBe(false);
  });

  it('does NOT retry DNS errors', () => {
    expect(isRetryable(new Error('[网络问题] ENOTFOUND nonexistent.api.com'))).toBe(false);
  });

  it('does NOT retry aborted', () => {
    expect(isRetryable(new Error('[已取消] 请求被手动中止'))).toBe(false);
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    expect(isRetryable(abortErr)).toBe(false);
  });

  it('does NOT retry model not found', () => {
    expect(isRetryable(new Error('[模型不存在] "test" 返回的模型名不在可用列表中'))).toBe(false);
  });

  it('retries raw fetch failures', () => {
    const err = new TypeError('Failed to fetch');
    expect(isRetryable(err)).toBe(true);
  });
});

describe('backoffDelay', () => {
  it('returns increasing delays', () => {
    const d0 = backoffDelay(0);
    const d1 = backoffDelay(1);
    const d2 = backoffDelay(2);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it('caps at max delay', () => {
    const d5 = backoffDelay(5);
    expect(d5).toBeLessThanOrEqual(16000 + 1000); // max + jitter
  });

  it('is at least base delay', () => {
    const d0 = backoffDelay(0);
    expect(d0).toBeGreaterThanOrEqual(1000);
  });
});

describe('sleepWithAbort', () => {
  it('resolves false after delay', async () => {
    const ctrl = new AbortController();
    const aborted = await sleepWithAbort(50, ctrl.signal);
    expect(aborted).toBe(false);
  });

  it('resolves true when aborted during sleep', async () => {
    const ctrl = new AbortController();
    const promise = sleepWithAbort(5000, ctrl.signal);
    // Abort after a short delay
    setTimeout(() => ctrl.abort(), 50);
    const aborted = await promise;
    expect(aborted).toBe(true);
  });

  it('resolves true immediately if already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await sleepWithAbort(5000, ctrl.signal);
    expect(aborted).toBe(true);
  });
});
