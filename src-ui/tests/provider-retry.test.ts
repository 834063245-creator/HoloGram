// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';

import { isRetryableStatus, sendWithRetry } from '../src/provider/retry';

describe('isRetryableStatus', () => {
  it('returns true for 408 (Request Timeout)', () => {
    expect(isRetryableStatus(408)).toBe(true);
  });

  it('returns true for 429 (Too Many Requests)', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('returns true for 500-599 range', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it('returns false for 200 (OK)', () => {
    expect(isRetryableStatus(200)).toBe(false);
  });

  it('returns false for 400 (Bad Request)', () => {
    expect(isRetryableStatus(400)).toBe(false);
  });

  it('returns false for 401 (Unauthorized)', () => {
    expect(isRetryableStatus(401)).toBe(false);
  });

  it('returns false for 403 (Forbidden)', () => {
    expect(isRetryableStatus(403)).toBe(false);
  });

  it('returns false for 404 (Not Found)', () => {
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe('sendWithRetry', () => {
  it('returns response immediately on success', async () => {
    const mockResponse = new Response('{}', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const result = await sendWithRetry({
      url: 'https://api.test.com/v1/chat',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test":true}',
      signal: new AbortController().signal,
      name: 'test',
    });

    expect(result.status).toBe(200);
    vi.restoreAllMocks();
  });

  it('throws immediately on 401 (not retryable)', async () => {
    const mockResponse = new Response('{"error":"invalid api key"}', { status: 401 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    await expect(
      sendWithRetry({
        url: 'https://api.test.com/v1/chat',
        headers: {},
        body: '',
        signal: new AbortController().signal,
        name: 'testprov',
      }),
    ).rejects.toThrow('[密钥错误]');

    vi.restoreAllMocks();
  });

  it('throws immediately on 403 (not retryable)', async () => {
    const mockResponse = new Response('Forbidden', { status: 403 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    await expect(
      sendWithRetry({
        url: 'https://api.test.com/v1/chat',
        headers: {},
        body: '',
        signal: new AbortController().signal,
        name: 'testprov',
      }),
    ).rejects.toThrow('[权限不足]');

    vi.restoreAllMocks();
  });

  it('throws immediately on 404 (not retryable)', async () => {
    const mockResponse = new Response('Not Found', { status: 404 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    await expect(
      sendWithRetry({
        url: 'https://api.test.com/v1/chat',
        headers: {},
        body: '',
        signal: new AbortController().signal,
        name: 'testprov',
      }),
    ).rejects.toThrow('[地址错误]');

    vi.restoreAllMocks();
  });

  it('retries on 429 then succeeds', async () => {
    const mock429 = new Response('Too Many Requests', { status: 429 });
    const mock200 = new Response('{}', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mock429).mockResolvedValueOnce(mock200);

    const result = await sendWithRetry({
      url: 'https://api.test.com/v1/chat',
      headers: {},
      body: '',
      signal: new AbortController().signal,
      name: 'testprov',
    });

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('retries on 500 up to 3 times then throws', async () => {
    const mock500 = new Response('Internal Server Error', { status: 500 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mock500);

    await expect(
      sendWithRetry({
        url: 'https://api.test.com/v1/chat',
        headers: {},
        body: '',
        signal: new AbortController().signal,
        name: 'testprov',
      }),
    ).rejects.toThrow('[服务商故障]');

    expect(fetch).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  it('throws on aborted signal before first attempt', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      sendWithRetry({
        url: 'https://api.test.com/v1/chat',
        headers: {},
        body: '',
        signal: controller.signal,
        name: 'testprov',
      }),
    ).rejects.toThrow('aborted');
  });

  it('retries on network error (fetch throws)', async () => {
    const networkErr = new TypeError('Failed to fetch');
    const mock200 = new Response('{}', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(networkErr).mockResolvedValueOnce(mock200);

    const result = await sendWithRetry({
      url: 'https://api.test.com/v1/chat',
      headers: {},
      body: '',
      signal: new AbortController().signal,
      name: 'testprov',
    });

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
