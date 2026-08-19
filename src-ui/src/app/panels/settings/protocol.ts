// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Protocol（协议）展示层唯一事实源（CONTEXT.md「Protocol」）：
// 全仓库的「OpenAI 兼容 / Anthropic」标签只在这里定义，
// 禁止在组件里再写 kindLabel 之类的内联拷贝。

import type { Protocol } from '../../../provider/types';

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI 兼容',
};

export function protocolLabel(k: Protocol): string {
  return PROTOCOL_LABELS[k];
}

export function isAnthropic(k: Protocol): boolean {
  return k === 'anthropic';
}
