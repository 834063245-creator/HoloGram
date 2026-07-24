// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// JsonMessageStore — MessageStore 的 JSON 文件实现
//
// 将每个 agent 的 inbox 持久化到 .hologram/agents/{agentId}/inbox.json
// 模式参照 agent-store.ts：rpc 文件 I/O、ensureDir、stripNums。
// 所有操作 best-effort — 永不抛异常阻塞主流程。

import { rpc } from '../bridge'
import type { AgentMessage, MessageStore } from './message-types'

// ── Helpers ──

function stripNums(text: string): string {
  return text.replace(/^\s*\d+\t/gm, '')
}

// ── JsonMessageStore ──

export class JsonMessageStore implements MessageStore {
  private dirReady = false

  constructor(private projectPath: string) {}

  private get baseDir(): string {
    return this.projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.hologram/agents'
  }

  private inboxPath(agentId: string): string {
    return `${this.baseDir}/${agentId}/inbox.json`
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return
    try {
      await rpc('create_directory', { path: this.baseDir })
    } catch {
      /* already exists */
    }
    this.dirReady = true
  }

  /** 遍历所有 inbox，每个写一个 JSON 文件。空 inbox 跳过。 */
  async flush(inboxes: Map<string, AgentMessage[]>): Promise<void> {
    await this.ensureDir()
    for (const [agentId, msgs] of inboxes) {
      try {
        // 空 inbox 不写文件
        if (msgs.length === 0) continue
        await rpc('create_directory', { path: `${this.baseDir}/${agentId}` })
        await rpc('write_file_content', {
          filePath: this.inboxPath(agentId),
          content: JSON.stringify(msgs, null, 2),
        })
      } catch {
        /* best-effort — 单个 inbox 写失败不影响其他 */
      }
    }
  }

  /** 读取所有 agent 目录下的 inbox.json，组装成 Map 返回。读失败跳过。 */
  async restore(): Promise<Map<string, AgentMessage[]>> {
    const result = new Map<string, AgentMessage[]>()
    try {
      const raw = await rpc<string>('list_directory', { path: this.baseDir })
      const entries = JSON.parse(raw) as Array<{ name: string; is_dir: boolean }>
      if (!Array.isArray(entries)) return result

      for (const entry of entries) {
        if (!entry.is_dir) continue
        const agentId = entry.name
        try {
          const rawInbox = await rpc<string>('read_file_content', {
            filePath: this.inboxPath(agentId),
          })
          const msgs = JSON.parse(stripNums(rawInbox)) as AgentMessage[]
          if (Array.isArray(msgs) && msgs.length > 0) {
            result.set(agentId, msgs)
          }
        } catch {
          /* inbox.json 可能不存在 — 跳过 */
        }
      }
    } catch {
      /* baseDir 不存在 — 无可恢复数据 */
    }
    return result
  }
}
