// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool 系统 — Tool 接口 + Registry 注册表 + Hologram 工具定义

import { rpc } from '../bridge';
import type { ToolSchema } from '../provider/types';

// ---- Tool 接口 ----

/** Tool 是 agent 可分发的一个可调用工具。 */
export interface Tool {
  /** 机器名，如 "fragile_modules" */
  name(): string;
  /** 面向模型的描述 */
  description(): string;
  /** 参数的 JSON Schema */
  parameters(): Record<string, unknown>;
  /** 是否只读（可安全并行） */
  readOnly(): boolean;
  /** 用原始 JSON 参数执行工具。返回结果字符串。
   *  onProgress 是可选回调，用于在执行期间流式输出部分结果。 */
  execute(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<string>;
}

// ---- Tool 注册表 ----

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(t: Tool): void {
    if (this.tools.has(t.name())) {
      throw new Error(`ToolRegistry: duplicate tool "${t.name()}"`);
    }
    this.tools.set(t.name(), t);
  }

  /** 按名称移除工具。工具不存在时无操作。 */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** 注册别名 — 相同实现，向 LLM 显示不同名称。
   *  别名也出现在 schemas() 中，LLM 可用任一名称。 */
  alias(aliasName: string, existingName: string): void {
    const original = this.tools.get(existingName);
    if (!original) throw new Error(`ToolRegistry: cannot alias unknown tool "${existingName}"`);
    if (this.tools.has(aliasName)) return; // 已存在（真实工具或先前的别名）

    // 包装以覆盖 name() — schemas() 必须显示别名而非原名
    const wrapper: Tool = {
      name: () => aliasName,
      description: () => original.description(),
      parameters: () => original.parameters(),
      readOnly: () => original.readOnly(),
      execute: (args, onProgress) => original.execute(args, onProgress),
    };
    this.tools.set(aliasName, wrapper);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  schemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name(),
      description: t.description(),
      parameters: t.parameters(),
    }));
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  filterReadOnly(): Tool[] {
    return this.all().filter((t) => t.readOnly());
  }

  /** 返回仅包含指定名称工具的新 ToolRegistry（按给定顺序）。
   *  缺失的名称静默跳过。用于构建限定范围的 agent 工具集。 */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const n of names) {
      const t = this.tools.get(n);
      if (t) sub.register(t);
    }
    return sub;
  }
}

// ---- Hologram 图查询工具 (28 tools — 与引擎 MCP 双线对齐) ----
// 硬编码工具 = Agent 的"嘴"：描述经过 LLM 调优，告诉 Agent 什么时候用、用完了下一步调什么。
// MCP = 执行通道：长驻引擎进程 <100ms 响应，挂了降级到进程内 ToolRegistry::dispatch 直调。
// 两者永远对齐——引擎新增 MCP 工具必须同步在此补硬编码定义。

/** 工具执行器：通过 MCP（快速、长驻）或进程内分发（回退）调用工具。
 *  onProgress 是可选回调，用于在执行期间流式输出部分结果。 */
export type ToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  onProgress?: (chunk: string) => void,
) => Promise<string>;

/** Agent → backend invoke 包装。恒定注入 isAgent:true，让 Rust 命令走权限路径
 *  (require_read/require_write/git_dispatch) 而非沙箱化的 user-UI 路径。
 *  camelCase 契约: Rust 参数 `is_agent` ↔ JS key `isAgent`。
 *  旧名 `_agent` 因 Tauri 默认 camelCase 重命名永远匹配不上 → is_agent 恒 false
 *  → agent 文件操作被沙箱静默硬拒且不弹 Ask（见 tests/agent-exec.test.ts 守护）。 */
export async function agentInvoke<T = string>(name: string, args: Record<string, unknown>): Promise<T> {
  return rpc<T>(name, { ...args, isAgent: true });
}

// ═══════════════════════════════════════════════════════
// Tool 实现已移至 agent/tools/
// ═══════════════════════════════════════════════════════

export { createCodingTools } from './tools/coding';
export { createSubAgentTool, type SubAgentSpawner } from './tools/subagent';