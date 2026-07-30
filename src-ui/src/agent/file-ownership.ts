// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// File Ownership — 并行子 Agent 的运行时文件级写保护。
//
// 当多个子 Agent 同时编辑同一个工作树时，后写者会静默覆盖先写者。
// 本模块实现"声明"机制：第一个写入文件的 Agent 拥有它；
// 后续 Agent 会收到清晰的错误而被拒绝。
//
// 所有权是每 Agent 运行的，非全局 — 父 Agent（主会话）不受限。
// 仅通过 spawnSubAgent 创建的子 Agent 受声明约束。

/** 会话内所有子 Agent 共享的文件所有权注册表。 */
export class FileOwnership {
  private claimed = new Map<string, string>(); // filePath → agentId

  /** 尝试为 Agent 声明一个文件。
   *  如果该 Agent 现在拥有该文件（或已经拥有）则返回 true。
   *  如果另一个 Agent 已拥有该文件则返回 false。 */
  claim(filePath: string, agentId: string): { ok: true } | { ok: false; owner: string } {
    const existing = this.claimed.get(filePath);
    if (existing && existing !== agentId) {
      return { ok: false, owner: existing };
    }
    this.claimed.set(filePath, agentId);
    return { ok: true };
  }

  /** 释放 Agent 持有的所有声明（子 Agent 完成时调用）。 */
  release(agentId: string): void {
    for (const [path, owner] of this.claimed) {
      if (owner === agentId) this.claimed.delete(path);
    }
  }

  /** 查看谁拥有某文件（用于调试 / agent_inbox 式查询）。 */
  ownerOf(filePath: string): string | undefined {
    return this.claimed.get(filePath);
  }
}

/** 从工具参数中提取写类工具的目标文件路径。 */
export function extractFilePath(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'write_file':
    case 'edit_file':
      return (args.filePath as string) || null;
    case 'delete_file_or_dir':
      return (args.path as string) || null;
    case 'move_file':
      // 同时声明源和目标
      return (args.from as string) || null;
    case 'rename_file':
      return (args.path as string) || null;
    default:
      return null;
  }
}

/** 修改文件且应受所有权检查约束的工具。 */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file_or_dir', 'move_file', 'rename_file']);
