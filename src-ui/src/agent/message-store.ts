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

  /** 读取所有 agent 目录下的 inbox.json，组装成 Map 返回。
   *  空 inbox.json 或不可解析的目录会被当作孤儿清理。 */
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
          } else {
            // 空 inbox.json — 清理孤儿
            await this.delete(agentId)
          }
        } catch {
          // inbox.json 不存在或损坏 — 清理孤儿目录
          await this.delete(agentId)
        }
      }
    } catch {
      /* baseDir 不存在 — 无可恢复数据 */
    }
    return result
  }

  /** 删除指定 agent 的 inbox 持久化文件和目录。
   *  在 bus.unregister() 时调用，清理磁盘残留。best-effort。 */
  async delete(agentId: string): Promise<void> {
    try {
      const dirPath = `${this.baseDir}/${agentId}`
      // 删 inbox.json
      await rpc('delete_file_or_dir', { path: this.inboxPath(agentId) })
      // 尝试删 agent 目录（如果为空）
      try {
        const raw = await rpc<string>('list_directory', { path: dirPath })
        const entries = JSON.parse(raw)
        if (Array.isArray(entries) && entries.length === 0) {
          await rpc('delete_file_or_dir', { path: dirPath })
        }
      } catch {
        // 目录已不存在或不可访问 — 无需处理
      }
    } catch {
      /* best-effort — 文件可能已不存在 */
    }
  }
}
