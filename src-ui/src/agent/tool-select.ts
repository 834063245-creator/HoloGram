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

/** 常驻工具：核心交互 + 计划模式 + 高频领域（编码、搜索、记忆）。 */
const ALWAYS_ON = [
  'ask_user',
  'Skill',
  'wait',
  'enter_plan_mode',
  'exit_plan_mode',
  'fs',
  'shell',
  'git',
  'search',
  'memory',
];

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

/** 从会话消息中派生打分上下文 — 只取 user 消息（稳定性契约）。
 *  工具循环中的 assistant/tool 消息不进打分：同一用户请求的整个
 *  工具循环内 schema 子集保持逐字节一致，DeepSeek 前缀缓存才能命中
 *  tools 段（schema 漂移会让 200K+ 输入整段 miss 按全价计费）。 */
export function userContext(messages: { role: string; content: string }[], maxUserMsgs = 3): string {
  return messages
    .filter((m) => m.role === 'user')
    .slice(-maxUserMsgs)
    .map((m) => m.content)
    .join('\n');
}

export interface StableSchemaSelector {
  /** 返回工具 schema。仅当 (registry 引用, limit, user 上下文) 任一变化时重算。 */
  select(registry: ToolRegistry, limit: number, contextText: string): ToolSchema[];
}

/** 工具 schema 稳定选择器 — 锁存上次结果，避免每轮动态打分击穿缓存。
 *  plan 模式切换（registry 引用变化）或用户新消息（contextText 变化）时自动失效重算。 */
export function createStableSchemaSelector(): StableSchemaSelector {
  let cache: { reg: ToolRegistry; limit: number; key: string; value: ToolSchema[] } | null = null;
  return {
    select(registry: ToolRegistry, limit: number, contextText: string): ToolSchema[] {
      if (cache && cache.reg === registry && cache.limit === limit && cache.key === contextText) {
        return cache.value;
      }
      const value = selectToolSchemas(registry, contextText, limit);
      cache = { reg: registry, limit, key: contextText, value };
      return value;
    },
  };
}
