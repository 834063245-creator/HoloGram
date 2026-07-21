// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { classifyError } from '../src/provider/types';

describe('classifyError', () => {
  const name = 'testprov';

  it('detects special characters in headers (status 0)', () => {
    const msg = classifyError(name, 0, '', 'Failed to decode using ISO-8859-1');
    expect(msg).toContain('[用户输入错误]');
    expect(msg).toContain('中文/特殊字符');
  });

  it('detects DNS resolution failure (status 0)', () => {
    const msg = classifyError(name, 0, '', 'getaddrinfo ENOTFOUND api.example.com');
    expect(msg).toContain('[网络问题]');
    expect(msg).toContain('无法解析');
  });

  it('detects connection refused (status 0)', () => {
    const msg = classifyError(name, 0, '', 'fetch failed: ECONNREFUSED');
    expect(msg).toContain('[网络问题]');
    expect(msg).toContain('无法连接');
  });

  it('detects timeout (status 0)', () => {
    const msg = classifyError(name, 0, '', 'ETIMEDOUT');
    expect(msg).toContain('[网络问题]');
    expect(msg).toContain('超时');
  });

  it('detects manual abort (status 0)', () => {
    const msg = classifyError(name, 0, '', 'The user aborted a request');
    expect(msg).toContain('[已取消]');
  });

  it('classifies 401 as invalid key', () => {
    const msg = classifyError(name, 401, 'Unauthorized');
    expect(msg).toContain('[密钥错误]');
    expect(msg).toContain('API Key 无效');
  });

  it('classifies 403 with invalid in body as key error', () => {
    const msg = classifyError(name, 403, '{"error":"invalid api key"}');
    expect(msg).toContain('[密钥错误]');
  });

  it('classifies 403 without invalid as permission issue', () => {
    const msg = classifyError(name, 403, 'Forbidden');
    expect(msg).toContain('[权限不足]');
  });

  it('classifies 429 as rate limit', () => {
    const msg = classifyError(name, 429, 'Too Many Requests');
    expect(msg).toContain('[服务商限流]');
  });

  it('classifies rate limit from body text', () => {
    const msg = classifyError(name, 200, '{"error":"rate limit exceeded"}');
    expect(msg).toContain('[服务商限流]');
  });

  it('classifies 500 as server error', () => {
    const msg = classifyError(name, 500, 'Internal Server Error');
    expect(msg).toContain('[服务商故障]');
    expect(msg).toContain('500');
  });

  it('classifies overloaded from body text (non-5xx status)', () => {
    // 529 would hit the 5xx branch first; use a non-5xx status with "overloaded" in body
    const msg = classifyError(name, 400, '{"error":"Overloaded"}');
    expect(msg).toContain('[服务商繁忙]');
  });

  it('classifies insufficient quota from body', () => {
    const msg = classifyError(name, 400, '{"error":"insufficient_quota"}');
    expect(msg).toContain('[余额不足]');
  });

  it('classifies model not found from body', () => {
    const msg = classifyError(name, 400, '{"error":"model_not_found"}');
    expect(msg).toContain('[模型不存在]');
  });

  it('classifies 404 as wrong URL', () => {
    const msg = classifyError(name, 404, 'Not Found');
    expect(msg).toContain('[地址错误]');
    expect(msg).toContain('404');
  });

  it('falls through to unknown error', () => {
    const msg = classifyError(name, 418, "I'm a teapot");
    expect(msg).toContain('[未知错误]');
    expect(msg).toContain('418');
  });
});
