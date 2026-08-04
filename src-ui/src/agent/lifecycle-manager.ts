// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentLifecycleManager — 多 Agent 事件生命周期管理器
//
// 三个子系统的状态信息汇合点：
//   - SubAgentPool (coordinator.ts) — 知道谁在跑 (runningCount)
//   - TaskBoard (task-board.ts) — 知道谁 completed 但没 merge
//   - MessageBus (message-bus.ts) — 知道谁有未读消息 (unreadCount)
//
// 职责：
//   1. 全局空闲判定 — "所有 agent 都停了"
//   2. 泄漏检测 — 子 Agent 完成后 worktree 未被 merge
//   3. 泄漏告警 — 通过 EventSink 发 Notice 事件
//   4. worktree TTL 清理 — 超时未 merge 的 worktree 自动清理

import type { SubAgentPool } from "./coordinator"
import type { TaskBoard, BoardEntry } from "./task-board"
import type { MessageBus } from "./message-bus"
import { EventKind } from "./agent-types"
import type { EventSink } from "./agent-types"
import type { ToolExecutor } from "./tool"
import { enqueueIsolationOp } from "./isolation-queue"

// 巡检间隔 — 60 秒
const LEAK_CHECK_INTERVAL_MS = 60_000
// worktree TTL — 30 分钟
const WORKTREE_TTL_MS = 30 * 60 * 1000

export class AgentLifecycleManager {
  private timer: ReturnType<typeof setInterval> | null = null
  // 已告警的 agentId 集合 — 避免每轮重复告警
  private warnedKeys = new Set<string>()

  constructor(
    private pool: SubAgentPool,
    private board: TaskBoard,
    private bus: MessageBus,
    private exec: ToolExecutor,
    private sink: EventSink,
  ) {}

  /** 全局空闲判定：所有 agent 都停了
   *  pool 无运行中 agent && board 无未 merge 的 completed 条目 && bus 无未读消息 */
  isIdle(): boolean {
    // 1. pool 无运行中 agent
    if (this.pool.runningCount > 0) return false

    // 2. board 无未 merge 的 completed 条目
    //    status === 'completed' 表示子 Agent 已完成但尚未被 merge（merge 后变为 'merged'）
    for (const entry of this._collectAllEntries()) {
      if (entry.status === "completed" && entry.isolationId) {
        return false
      }
    }

    // 3. bus 无未读消息
    for (const addr of this.bus.listAgents()) {
      if (this.bus.unreadCount(addr.agentId) > 0) {
        return false
      }
    }

    return true
  }

  /** 启动定期巡检 */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this._sweep(), LEAK_CHECK_INTERVAL_MS)
  }

  /** 停止巡检 — AgentHandle.dispose() 或 runtime 销毁时调用 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.warnedKeys.clear()
  }

  // ── 内部方法 ──

  /** 巡检：泄漏检测 + TTL 清理 */
  private _sweep(): void {
    this._detectLeaks()
    this._enforceTTL()
  }

  /** 收集所有 board 条目 — 通过 bus 注册的 agent 遍历其 children */
  private _collectAllEntries(): BoardEntry[] {
    const entries: BoardEntry[] = []
    for (const addr of this.bus.listAgents()) {
      entries.push(...this.board.getChildren(addr.agentId))
    }
    return entries
  }

  /** 泄漏检测：completed + isolationId + 未 merge + 不在 pool 中 */
  private _detectLeaks(): void {
    const allEntries = this._collectAllEntries()
    // 泄漏条件：status === 'completed'（已完成但未被 merge） + isolationId 存在
    // 'merged' 状态的条目已被 merge 工具处理过，不再视为泄漏
    const leaked = allEntries.filter(
      (e) => e.status === "completed" && e.isolationId != null,
    )

    // 过滤掉仍在 pool 中运行的 agent（安全检查 — completed 意味着已结束）
    const trulyLeaked = leaked.filter((e) => !this.pool.getHandle(e.agentId))

    if (trulyLeaked.length === 0) {
      // 不清除 warnedKeys — 如果同一泄漏下个周期重新出现，我们不想
      // 重复报告。warnedKeys 只增不减，直到 stop() 清除。
      return
    }

    // 去重：只报告 warnedKeys 中没有的新泄漏 id
    const newLeaks = trulyLeaked.filter((e) => !this.warnedKeys.has(e.agentId))
    if (newLeaks.length === 0) return

    // 更新 warnedKeys 以包含所有当前泄漏的（不只是新增的）
    for (const e of trulyLeaked) {
      this.warnedKeys.add(e.agentId)
    }

    // 只报告新泄漏的 Agent
    const newIds = newLeaks.map((e) => e.agentId).join(", ")
    this._notify(
      "warn",
      `⚠️ 检测到 ${newLeaks.length} 个新的未合并子 Agent worktree (${newIds})，请调用 agent_merge 合并或手动清理`,
    )
  }

  /** worktree TTL 清理：finishedAt 超过 30 分钟仍未 merge，自动清理 worktree */
  private _enforceTTL(): void {
    const now = Date.now()
    const allEntries = this._collectAllEntries()
    const expired = allEntries.filter(
      (e) =>
        e.status === "completed" &&
        e.isolationId != null &&
        e.finishedAt != null &&
        now - e.finishedAt > WORKTREE_TTL_MS,
    )

    for (const entry of expired) {
      const isolationId = entry.isolationId!
      // discard 操作通过 isolation queue 串行化，避免 git index lock 竞争
      enqueueIsolationOp(async () => {
        await this.exec("agent_isolation_discard", { agent_id: isolationId }).catch(() => {})
      })
      // 标记 board 状态为 stopped（复用现有 BoardStatus）
      this.board.stop(entry.agentId)
      this.warnedKeys.delete(entry.agentId)
      this._notify("warn", `⚠️ 子 Agent ${entry.agentId} 的 worktree 已超过 30 分钟未合并，已自动清理`)
    }
  }

  /** 通过 EventSink 发 Notice 事件 */
  private _notify(level: "info" | "warn" | "error", text: string): void {
    this.sink({ kind: EventKind.Notice, level, text })
  }
}
