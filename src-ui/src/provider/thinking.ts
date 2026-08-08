// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ThinkingPolicy — CONTEXT.md「ThinkingPolicy」：用户对「模型作答前推理多少」的配置。
// 存储字段名保持 `thinking`（遗留名）；领域词 ThinkingPolicy。
// 数字字符串是历史遗留（Anthropic 支持直接写 token 预算），UI 仅提供命名档位。

import type { Protocol } from './types';

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

export type ThinkingMode = '' | 'off' | ThinkingEffort;

/** ProviderSettings.thinking 的完整存储形态：命名档位 + 历史遗留数字预算。 */
export type StoredThinking = ThinkingMode | `${number}`;

/** 思考策略的 UI 档位（顺序即展示顺序；'' = 自动，存储值即 select value）。 */
export const THINKING_MODES: readonly { value: ThinkingMode; label: string }[] = [
  { value: '', label: '自动（模型自定）' },
  { value: 'low', label: '低 (low)' },
  { value: 'medium', label: '中 (medium)' },
  { value: 'high', label: '高 (high)' },
  { value: 'max', label: '极限 (max)' },
  { value: 'off', label: '关闭' },
];

/** 命名档位 → Anthropic budget_tokens（唯一事实源，原 anthropic.ts 内联映射收口于此）。 */
export const THINKING_EFFORT_BUDGETS: Record<ThinkingEffort, number> = {
  low: 4000,
  medium: 8000,
  high: 16000,
  max: 32000,
};

/** 全局「深度思考」开关的展示文案（SettingsPanel / ModelSwitcher 共用）。 */
export const DEEP_THINK_LABEL = '深度思考（DeepSeek Think 模式）';

export function isThinkingMode(v: string): v is ThinkingMode {
  return THINKING_MODES.some((o) => o.value === v);
}

export function thinkingModeLabel(v: string | undefined): string {
  if (!v) return THINKING_MODES[0].label;
  return THINKING_MODES.find((o) => o.value === v)?.label ?? `自定义 (${v})`;
}

/** 全局 disableThinking 对单 Provider 思考策略的生效结果（provider/index.ts 使用）。 */
export function withThinkingDisabled(
  thinking: StoredThinking | undefined,
  disableThinking: boolean | undefined,
): StoredThinking | undefined {
  return disableThinking ? 'off' : thinking || undefined;
}

/** OpenAI 兼容协议的 reasoning_effort 线上取值（DeepSeek / OpenAI 各自子集）。 */
export type OpenAIWireEffort = 'low' | 'medium' | 'high' | 'max';

/** ThinkingPolicy 的 wire 适配档案：统一档位 → 各家线上参数由谁翻译。 */
export type EffortVendor = 'anthropic' | 'deepseek' | 'openai' | 'unknown';

/** 识别一个 Provider 的 effort 档案：Anthropic 走 budget_tokens；
 *  DeepSeek / OpenAI 官方走 reasoning_effort（取值不同）；其余 OpenAI 兼容
 *  厂商（MiMo / GLM 等）无 effort 证据 → unknown，不编造参数。 */
export function effortVendor(
  name: string,
  kind: Protocol,
  baseUrl?: string,
  model?: string,
): EffortVendor {
  if (kind === 'anthropic') return 'anthropic';
  const id = name.toLowerCase();
  const url = (baseUrl || '').toLowerCase();
  const mid = (model || '').toLowerCase();
  if (id === 'deepseek' || url.includes('deepseek') || mid.includes('deepseek')) return 'deepseek';
  if (id === 'openai' || url.includes('api.openai.com') || /^(gpt-|o3|o4)/.test(mid)) return 'openai';
  return 'unknown';
}

/** 统一档位 → OpenAI 兼容协议 reasoning_effort 的 wire 映射：
 *  DeepSeek 只认 high/max（low/medium 服务端按 high，本地一并归一）；
 *  OpenAI 官方只认 low/medium/high（max 降级 high）；unknown 不发送。 */
export function toOpenAIEffort(
  vendor: EffortVendor,
  level: ThinkingMode,
): OpenAIWireEffort | undefined {
  if (vendor === 'deepseek') {
    if (level === 'low' || level === 'medium' || level === 'high') return 'high';
    if (level === 'max') return 'max';
    return undefined;
  }
  if (vendor === 'openai') {
    if (level === 'low' || level === 'medium' || level === 'high') return level;
    if (level === 'max') return 'high';
    return undefined;
  }
  return undefined;
}

/** 按厂商过滤「思考强度」UI 档位（ProviderDetail / ModelSwitcher 共用）：
 *  Anthropic 全档；DeepSeek 只给 high/max；OpenAI 全档但 max 标注降级；
 *  其余厂商无 effort 证据 → 空列表，UI 回退「深度思考」开关。 */
export function thinkingModesFor(
  kind: Protocol,
  name: string,
  baseUrl?: string,
  model?: string,
): readonly { value: ThinkingMode; label: string }[] {
  const vendor = effortVendor(name, kind, baseUrl, model);
  if (vendor === 'anthropic') return THINKING_MODES;
  if (vendor === 'deepseek') {
    return THINKING_MODES.filter(
      (o) => o.value === '' || o.value === 'high' || o.value === 'max' || o.value === 'off',
    );
  }
  if (vendor === 'openai') {
    return THINKING_MODES.map((o) =>
      o.value === 'max' ? { value: o.value as ThinkingMode, label: '极限 (max → high)' } : o,
    );
  }
  return [];
}
