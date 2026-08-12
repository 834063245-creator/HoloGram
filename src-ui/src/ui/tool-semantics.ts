// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// UI 渲染层工具语义解析 — 工具收敛后模型调用领域工具（fs/shell/search/...），
// 而 UI 的特殊渲染（diff 视图 / bash 代码块 / 写入预览 / 修改简报触发等）按
// 旧工具名匹配。此处把领域调用归一化回旧语义名，动作→旧名映射直接反查
// DOMAIN_SPECS（agent/tools/domains.ts 为单一权威源，不另存第三份映射表）。

import { DOMAIN_SPECS } from '../agent/tools/domains';

const DOMAIN_NAMES = new Set(DOMAIN_SPECS.map((s) => s.name));

/** 从工具参数 JSON 中提取领域 action 字段。完整 JSON 解析；失败返回 undefined。 */
export function parseAction(argsJson?: string): string | undefined {
  if (!argsJson) return undefined;
  try {
    const a = (JSON.parse(argsJson) as { action?: unknown }).action;
    return typeof a === 'string' ? a : undefined;
  } catch {
    return undefined;
  }
}

/** 领域工具调用 → 旧语义工具名（fs + write → write_file）。非领域工具或无法解析时原样返回。 */
export function resolveSemanticToolName(toolName: string, argsJson?: string): string {
  const action = parseAction(argsJson);
  if (!action) return toolName;
  const spec = DOMAIN_SPECS.find((s) => s.name === toolName);
  return spec?.actions[action] ?? toolName;
}

/** 领域工具显示名（fs + write → "fs(write)"），用于工具卡片 / 摘要标题。
 *  非领域工具或 action 缺失时返回原名。 */
export function displayToolName(toolName: string, argsJson?: string): string {
  const action = parseAction(argsJson);
  if (!action || !DOMAIN_NAMES.has(toolName)) return toolName;
  return `${toolName}(${action})`;
}

/** 判断工具调用是否由子 Agent 专属卡片（SubAgentBlock）渲染，避免与 ToolCard 重复。
 *  兼容收敛前的旧名 agent_spawn 与收敛后的领域调用 agent(action=spawn)。
 *  partial=true 的分发（ToolCallStart，args 尚未流到）无法判定 action ——
 *  agent 领域一律视为 spawn 嫌疑跳过建卡；非 spawn 动作待完整分发到达时
 *  由 part-mutator 的 upsert 路径补建 ToolCard。 */
export function isSubagentSpawnTool(name: string, argsJson?: string, partial?: boolean): boolean {
  if (name === 'agent_spawn') return true;
  if (name === 'agent') {
    if (partial) return true;
    return parseAction(argsJson) === 'spawn';
  }
  return false;
}
