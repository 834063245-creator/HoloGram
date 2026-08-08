// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具检索/注入 — 目录（catalog）可以很大，但每轮只给模型 limit 个 schema。
// 策略：
//   - 常驻集（核心编码 + 交互 + 计划），永远可见；
//   - 其余按上下文 token 与工具描述/领域/动作名的命中数打分，取 top；
//   - limit <= 0 或超过全量时回退全量（兼容旧行为）。

import type { ToolSchema } from '../provider/types';
import type { ToolRegistry } from './tool';

const STOPWORDS = new Set([
  '帮我', '请', '一下', '一个', '这个', '那个', '可以', '需要', '我们', '你们', '他们',
  '的', '了', '吗', '呢', '吧', '啊', '是', '在', '有', '和', '与', '或', '把', '被', '对',
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'please', 'can',
  'you', 'your', 'this', 'that', 'it', 'is', 'are', 'be', 'do', 'does', 'not',
]);

/** 常驻工具：核心交互 + 计划模式 + 三个高频领域。 */
const ALWAYS_ON = ['ask_user', 'Skill', 'wait', 'enter_plan_mode', 'exit_plan_mode', 'fs', 'shell', 'git'];

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z][a-z0-9_-]*/g) ?? [];
  const cjk = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...ascii, ...cjk].filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

function scoreTool(
  c: { description: string; domain?: string; actions?: string[] } | undefined,
  tokens: string[],
): number {
  if (!c || tokens.length === 0) return 0;
  const hay = `${c.description} ${c.domain ?? ''} ${(c.actions ?? []).join(' ')}`.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (hay.includes(t)) score++;
  }
  return score;
}

export function selectToolSchemas(registry: ToolRegistry, contextText: string, limit: number): ToolSchema[] {
  const all = registry.schemas();
  if (limit <= 0 || all.length <= limit) return all;

  const catalog = new Map(registry.catalog().map((c) => [c.name, c]));
  const picked = new Set<string>(ALWAYS_ON.filter((n) => all.some((t) => t.name === n)));
  const tokens = tokenize(contextText);

  const order = new Map(all.map((t, i) => [t.name, i]));
  const scored = all
    .filter((t) => !picked.has(t.name))
    .map((t) => ({ name: t.name, score: scoreTool(catalog.get(t.name), tokens) }))
    .sort((a, b) => b.score - a.score || (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));

  for (const s of scored) {
    if (picked.size >= limit) break;
    picked.add(s.name);
  }

  return all.filter((t) => picked.has(t.name));
}
