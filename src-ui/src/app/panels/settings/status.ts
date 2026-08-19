// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 页「信号源状态」推导 — 唯一事实源：
// 无 Key = 未配置；有 Key 且最近测试通过 = 正常；有 Key 且最近测试失败 = 异常；
// 有 Key 但从未测试（或测试结果丢失）= 已配置。

import type { ProviderSettings } from '../../../settings';

export type ProviderStatus = 'unconfigured' | 'configured' | 'ok' | 'fail';

export const STATUS_LABEL: Record<ProviderStatus, string> = {
  unconfigured: '未配置',
  configured: '已配置',
  ok: '正常',
  fail: '异常',
};

export function providerStatus(p: Pick<ProviderSettings, 'apiKey' | 'lastTest'>): ProviderStatus {
  if (!p.apiKey?.trim()) return 'unconfigured';
  if (p.lastTest?.status === 'ok') return 'ok';
  if (p.lastTest?.status === 'fail') return 'fail';
  return 'configured';
}

export function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function formatTestAt(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
