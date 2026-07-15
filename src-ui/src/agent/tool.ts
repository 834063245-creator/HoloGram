// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool 系统 — Tool 接口 + Registry 注册表 + Hologram 工具定义

import { rpc } from '../bridge';
import type { ToolSchema } from '../provider/types';

// ---- Tool 接口 ----

/** A Tool is one callable tool the agent can dispatch. */
export interface Tool {
  /** Machine name, e.g. "fragile_modules" */
  name(): string;
  /** Human-readable description for the model */
  description(): string;
  /** JSON Schema for the arguments */
  parameters(): Record<string, unknown>;
  /** Whether this tool is read-only (safe to parallelize) */
  readOnly(): boolean;
  /** Execute the tool with raw JSON arguments. Returns the result string.
   *  onProgress is an optional callback for streaming partial output during execution. */
  execute(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<string>;
}

// ---- Tool Registry ----

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(t: Tool): void {
    if (this.tools.has(t.name())) {
      throw new Error(`ToolRegistry: duplicate tool "${t.name()}"`);
    }
    this.tools.set(t.name(), t);
  }

  /** Remove a tool by name. No-op if the tool doesn't exist. */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** Register an alias — same implementation, different name shown to LLM.
   *  Alias also appears in schemas() so LLM can use either name. */
  alias(aliasName: string, existingName: string): void {
    const original = this.tools.get(existingName);
    if (!original) throw new Error(`ToolRegistry: cannot alias unknown tool "${existingName}"`);
    if (this.tools.has(aliasName)) return; // already exists (real tool or earlier alias)

    // Wrap to override name() — schemas() must show the alias name, not the original
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

  /** Return a new ToolRegistry containing only the named tools (in given order).
   *  Missing names are skipped silently. Used to build scoped agent toolsets. */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const n of names) {
      const t = this.tools.get(n);
      if (t) sub.register(t);
    }
    return sub;
  }
}

// ---- Hologram 图查询工具 (25 tools — 与引擎 MCP 双线对齐) ----
// 硬编码工具 = Agent 的"嘴"：描述经过 LLM 调优，告诉 Agent 什么时候用、用完了下一步调什么。
// MCP = 执行通道：长驻引擎进程 <100ms 响应，挂了自动降级 CLI。
// 两者永远对齐——引擎新增 MCP 工具必须同步在此补硬编码定义。

/** Tool executor: invokes tools via MCP (fast, persistent) or CLI (fallback).
 *  onProgress is an optional callback for streaming partial output during execution. */
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
// Tool implementations moved to agent/tools/
// ═══════════════════════════════════════════════════════

export { createHologramTestTools } from './tools/hologram';
export { createCodingTools } from './tools/coding';
export { type SubAgentSpawner, createSubAgentTool, createAgentMessageTool, createAgentStatusTool, createAgentStopTool, createAgentStopAllTool } from './tools/subagent';
