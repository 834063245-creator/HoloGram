// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// File Ownership — runtime file-level write protection for parallel sub-agents.
//
// When multiple sub-agents edit the same working tree concurrently, the last
// writer silently overwrites the first. This module implements a "claim"
// mechanism: the first agent to write a file owns it; subsequent agents get
// rejected with a clear error.
//
// Ownership is per-agent-run, not global — the parent agent (main session)
// is exempt. Only sub-agents created via spawnSubAgent are subject to claims.

/** Shared registry of file ownership across all sub-agents in a session. */
export class FileOwnership {
  private claimed = new Map<string, string>(); // filePath → agentId

  /** Try to claim a file for an agent.
   *  Returns true if the agent now owns the file (or already did).
   *  Returns false if another agent already owns it. */
  claim(filePath: string, agentId: string): { ok: true } | { ok: false; owner: string } {
    const existing = this.claimed.get(filePath);
    if (existing && existing !== agentId) {
      return { ok: false, owner: existing };
    }
    this.claimed.set(filePath, agentId);
    return { ok: true };
  }

  /** Release all claims held by an agent (called when sub-agent finishes). */
  release(agentId: string): void {
    for (const [path, owner] of this.claimed) {
      if (owner === agentId) this.claimed.delete(path);
    }
  }

  /** Check who owns a file (for debugging / agent_inbox-like queries). */
  ownerOf(filePath: string): string | undefined {
    return this.claimed.get(filePath);
  }
}

/** Extract the target file path from tool args for write-class tools. */
export function extractFilePath(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'write_file':
    case 'edit_file':
      return (args.filePath as string) || null;
    case 'delete_file_or_dir':
      return (args.path as string) || null;
    case 'move_file':
      // Claim both source and destination
      return (args.from as string) || null;
    case 'rename_file':
      return (args.path as string) || null;
    default:
      return null;
  }
}

/** Tools that modify files and should be subject to ownership checks. */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file_or_dir', 'move_file', 'rename_file']);
