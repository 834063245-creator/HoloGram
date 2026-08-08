// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ThinkingPolicy — CONTEXT.md「ThinkingPolicy」：用户对「模型作答前推理多少」的配置。
// 存储字段名保持 `thinking`（遗留名）；领域词 ThinkingPolicy。
// 数字字符串是历史遗留（Anthropic 支持直接写 token 预算），UI 仅提供命名档位。

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
