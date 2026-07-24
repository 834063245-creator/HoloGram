// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多 Agent 事件生命周期 — 集成测试
//
// 验证组件协作：
//   1. 3 个异步 spawn 并行跑 → 统一 merge 无冲突
//   2. 2 个异步 spawn 改同一文件 → merge 冲突保全
//   3. sync + async 混合 spawn
//   4. lifecycle manager 泄漏检测 + TTL 清理

import { describe, expect, it, vi } from "vitest"

// ── bridge mock ──

const mockRpc = vi.fn()
vi.mock("../src/bridge", () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}))
vi.mock("../src/ui/events", () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }))

import { TaskBoard } from "../src/agent/task-board"
import { MessageBus } from "../src/agent/message-bus"
import { MeshTopology } from "../src/agent/topology"
import { SubAgentPool } from "../src/agent/coordinator"
import { ToolRegistry, type ToolExecutor } from "../src/agent/tool"
import { createSubAgentTool, type SubAgentSpawner } from "../src/agent/tools/subagent"
import { createMergeTool } from "../src/agent/tools/merge"
import { AgentLifecycleManager } from "../src/agent/lifecycle-manager"
import type { AgentEvent } from "../src/agent/agent-types"
import { EventKind } from "../src/agent/agent-types"

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function addr(agentId: string, parentId: string | null = null, depth = 0) {
  return { agentId, parentId, depth }
}

/** 收集 EventSink 事件 */
function collectSink(): { sink: (ev: AgentEvent) => void; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  return { sink: (ev) => events.push(ev), events }
}

// ═══════════════════════════════════════════════════════
// 1. 3 个异步 spawn 并行跑 → 统一 merge 无冲突
// ═══════════════════════════════════════════════════════

describe("集成：3 个异步 spawn 并行 → 统一 merge 无冲突", () => {
  it("三个子 Agent 各自完成后，agent_merge 串行合并全部成功", async () => {
    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())

    // spawner — 异步模式，完成后在 board 上记录结果
    const spawner: SubAgentSpawner = async (desc, _prompt, _prog, _mode, _al, _sig, asyncMode, agentIdOverride) => {
      const agentId = agentIdOverride ?? `sub-${Date.now()}`
      if (asyncMode) {
        // 注册到 board（模拟 agent.ts 中 spawnSubAgent 的行为）
        board.register({
          agentId,
          parentAgentId: "main",
          description: desc,
          isolationId: `iso-${agentId}`,
        })
        // 模拟工作完成
        await new Promise((r) => setTimeout(r, 50))
        board.complete(agentId, `${desc} 完成`, `diff-${agentId}`)
        // 通过 bus 通知
        bus.register(addr("main"))
        bus.register(addr(agentId, "main", 1))
        bus.send({ from: agentId, to: "main", type: "result", payload: `${desc} done` })
      }
      return { text: `子Agent已启动 (id: ${agentId})` }
    }

    const tool = createSubAgentTool(spawner, pool)

    // 启动 3 个异步子 Agent
    const r1 = await tool.execute({ description: "task-A", prompt: "p", async: true })
    const r2 = await tool.execute({ description: "task-B", prompt: "p", async: true })
    const r3 = await tool.execute({ description: "task-C", prompt: "p", async: true })

    expect(r1).toContain("子Agent已启动")
    expect(r2).toContain("子Agent已启动")
    expect(r3).toContain("子Agent已启动")
    expect(pool.runningCount).toBe(3)

    // 等待所有子 Agent 完成
    await new Promise((r) => setTimeout(r, 150))
    expect(pool.runningCount).toBe(0)

    // 验证 board 状态 — 3 个都 completed
    const children = board.getChildren("main")
    expect(children).toHaveLength(3)
    expect(children.every((e) => e.status === "completed")).toBe(true)

    // agent_merge — 串行合并
    const discardCalls: string[] = []
    const mergeCalls: string[] = []
    const exec: ToolExecutor = async (name, args) => {
      if (name === "agent_isolation_merge") {
        mergeCalls.push(args.agent_id as string)
        return "merged"
      }
      if (name === "agent_isolation_discard") {
        discardCalls.push(args.agent_id as string)
        return "discarded"
      }
      return "ok"
    }

    const mergeTool = createMergeTool(board, () => "main", exec)
    const result = await mergeTool.execute({})

    expect(result).toContain("已合并 3 个子Agent")
    expect(result).toContain("0 个冲突")
    expect(children.every((e) => e.status === "merged")).toBe(true)
    expect(mergeCalls).toHaveLength(3)
    expect(discardCalls).toHaveLength(3)
  })
})

// ═══════════════════════════════════════════════════════
// 2. 2 个异步 spawn 改同一文件 → merge 冲突保全
// ═══════════════════════════════════════════════════════

describe("集成：2 个异步 spawn 改同一文件 → merge 冲突", () => {
  it("第二个 merge 冲突时保全 diff + 清理 worktree", async () => {
    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register(addr("main"))

    const spawner: SubAgentSpawner = async (desc, _prompt, _prog, _mode, _al, _sig, asyncMode, agentIdOverride) => {
      const agentId = agentIdOverride ?? `sub-${Date.now()}`
      if (asyncMode) {
        board.register({
          agentId,
          parentAgentId: "main",
          description: desc,
          isolationId: `iso-${agentId}`,
        })
        board.recordFileTouch(agentId, "/shared.ts")
        await new Promise((r) => setTimeout(r, 30))
        board.complete(agentId, `${desc} 完成`, `diff-${agentId}`)
        bus.register(addr(agentId, "main", 1))
        bus.send({ from: agentId, to: "main", type: "result", payload: "done" })
      }
      return { text: `子Agent已启动 (id: ${agentId})` }
    }

    const tool = createSubAgentTool(spawner, pool)

    await tool.execute({ description: "task-X", prompt: "p", async: true })
    await tool.execute({ description: "task-Y", prompt: "p", async: true })

    await new Promise((r) => setTimeout(r, 100))
    expect(pool.runningCount).toBe(0)

    // merge — 第一个成功，第二个冲突
    const exec: ToolExecutor = async (name, args) => {
      if (name === "agent_isolation_merge") {
        const isoId = args.agent_id as string
        if (isoId.includes("second") || mergeCalls.length > 0) {
          throw new Error("CONFLICT: both modified /shared.ts")
        }
        mergeCalls.push(isoId)
        return "merged"
      }
      if (name === "agent_isolation_discard") {
        return "discarded"
      }
      return "ok"
    }
    const mergeCalls: string[] = []

    const mergeTool = createMergeTool(board, () => "main", exec)
    const result = await mergeTool.execute({})

    expect(result).toContain("1 个冲突")
    expect(result).toContain("CONFLICT")
    expect(result).toContain("diff 已保存在 TaskBoard")

    // 冲突的条目仍为 completed（未被 markMerged）
    const children = board.getChildren("main")
    const merged = children.filter((e) => e.status === "merged")
    const stillCompleted = children.filter((e) => e.status === "completed")
    expect(merged.length + stillCompleted.length).toBe(2)

    // 冲突条目的 diff 保留
    expect(stillCompleted.every((e) => e.diff != null && e.diff.length > 0)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// 3. sync + async 混合 spawn
// ═══════════════════════════════════════════════════════

describe("集成：sync + async 混合 spawn", () => {
  it("sync spawn 阻塞返回结果，async spawn 立即返回 — 互不干扰", async () => {
    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register(addr("main"))

    let asyncAgentId: string | null = null

    const spawner: SubAgentSpawner = async (desc, _prompt, _prog, _mode, _al, _sig, asyncMode, agentIdOverride) => {
      if (asyncMode) {
        const agentId = agentIdOverride ?? `sub-async-${Date.now()}`
        asyncAgentId = agentId
        board.register({
          agentId,
          parentAgentId: "main",
          description: desc,
          isolationId: `iso-${agentId}`,
        })
        // 后台运行
        await new Promise((r) => setTimeout(r, 80))
        board.complete(agentId, "async done", "async-diff")
        bus.register(addr(agentId, "main", 1))
        bus.send({ from: agentId, to: "main", type: "result", payload: "async result" })
        return { text: `子Agent已启动 (id: ${agentId})` }
      }
      // sync 模式 — 直接返回结果
      await new Promise((r) => setTimeout(r, 20))
      return { text: `sync result for: ${desc}` }
    }

    const tool = createSubAgentTool(spawner, pool)

    // 先启动 async（立即返回）
    const asyncResult = await tool.execute({ description: "bg", prompt: "p", async: true })
    expect(asyncResult).toContain("子Agent已启动")
    expect(pool.runningCount).toBe(1)

    // 同时启动 sync（阻塞 ~20ms）
    const syncResult = await tool.execute({ description: "fg", prompt: "p" })
    expect(syncResult).toBe("sync result for: fg")
    // sync 已完成，但 async 仍在跑
    expect(pool.runningCount).toBe(1)

    // 等待 async 完成
    await new Promise((r) => setTimeout(r, 100))
    expect(pool.runningCount).toBe(0)

    // board 只注册了 async 子 Agent（sync 不注册）
    const children = board.getChildren("main")
    expect(children).toHaveLength(1)
    expect(children[0].status).toBe("completed")
    expect(children[0].summary).toBe("async done")

    // bus 有未读消息
    expect(bus.unreadCount("main")).toBe(1)

    // merge async 子 Agent
    const exec: ToolExecutor = async (name) => (name === "agent_isolation_merge" ? "ok" : "discarded")
    const mergeTool = createMergeTool(board, () => "main", exec)
    const mergeResult = await mergeTool.execute({})
    expect(mergeResult).toContain("已合并 1 个子Agent")
  })
})

// ═══════════════════════════════════════════════════════
// 4. lifecycle manager 泄漏检测 + TTL 清理
// ═══════════════════════════════════════════════════════

describe("集成：AgentLifecycleManager 泄漏检测 + TTL 清理", () => {
  it("isIdle — 全部空闲时返回 true", () => {
    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register(addr("main"))

    const { sink } = collectSink()
    const exec: ToolExecutor = async () => "ok"
    const mgr = new AgentLifecycleManager(pool, board, bus, exec, sink)

    // 空 board + 空 pool + 无未读消息 → idle
    expect(mgr.isIdle()).toBe(true)

    // 有运行中 agent → not idle
    pool.spawn("running", () => new Promise<{ text: string }>(() => {}))
    expect(mgr.isIdle()).toBe(false)
    pool.stopAll()

    // 有未 merge 的 completed 条目 → not idle
    board.register({ agentId: "sub-1", parentAgentId: "main", description: "t", isolationId: "iso-1" })
    board.complete("sub-1", "done", "diff")
    expect(mgr.isIdle()).toBe(false)

    // merge 后 → idle
    board.markMerged("sub-1")
    // 但 bus 可能有未读消息（如果 register 了 sub-1）
    // main 没有未读消息
    expect(mgr.isIdle()).toBe(true)
  })

  it("isIdle — bus 有未读消息时返回 false", () => {
    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register(addr("main"))
    bus.register(addr("child", "main", 1))

    const { sink } = collectSink()
    const exec: ToolExecutor = async () => "ok"
    const mgr = new AgentLifecycleManager(pool, board, bus, exec, sink)

    expect(mgr.isIdle()).toBe(true)

    bus.send({ from: "child", to: "main", type: "result", payload: "hello" })
    expect(mgr.isIdle()).toBe(false)

    bus.ackMessage("main", bus.peekInbox("main")[0].id)
    expect(mgr.isIdle()).toBe(true)
  })

  it("泄漏检测 — completed + isolationId 的条目触发告警", () => {
    vi.useFakeTimers()

    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register(addr("main"))

    const { sink, events } = collectSink()
    const exec: ToolExecutor = async () => "ok"
    const mgr = new AgentLifecycleManager(pool, board, bus, exec, sink)

    // 制造泄漏：completed + isolationId，且不在 pool 中
    board.register({ agentId: "sub-leak", parentAgentId: "main", description: "leaked", isolationId: "iso-leak" })
    board.complete("sub-leak", "done", "diff-leak")

    mgr.start()

    // 推进 60 秒 — 触发第一次巡检
    vi.advanceTimersByTime(60_000)

    const notice = events.find((e) => e.kind === EventKind.Notice && e.level === "warn")
    expect(notice).toBeDefined()
    expect(notice!.text).toContain("1 个未合并")
    expect(notice!.text).toContain("sub-leak")

    mgr.stop()
    vi.useRealTimers()
  })

  it("泄漏去重 — 同一组泄漏不重复告警", () => {
    vi.useFakeTimers()

    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register(addr("main"))

    const { sink, events } = collectSink()
    const exec: ToolExecutor = async () => "ok"
    const mgr = new AgentLifecycleManager(pool, board, bus, exec, sink)

    board.register({ agentId: "sub-a", parentAgentId: "main", description: "a", isolationId: "iso-a" })
    board.complete("sub-a", "done", "diff")

    mgr.start()

    vi.advanceTimersByTime(60_000)
    const warns1 = events.filter((e) => e.kind === EventKind.Notice && e.level === "warn")

    vi.advanceTimersByTime(60_000)
    const warns2 = events.filter((e) => e.kind === EventKind.Notice && e.level === "warn")

    // 第一次巡检告警了
    expect(warns1.length).toBe(1)
    // 第二次巡检不重复告警（同一组泄漏）
    expect(warns2.length).toBe(warns1.length)

    mgr.stop()
    vi.useRealTimers()
  })

  it("TTL 清理 — finishedAt 超 30 分钟自动 discard + 标记 stopped", async () => {
    vi.useFakeTimers()

    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register(addr("main"))

    const discardCalls: string[] = []
    const exec: ToolExecutor = async (name, args) => {
      if (name === "agent_isolation_discard") {
        discardCalls.push(args.agent_id as string)
        return "discarded"
      }
      return "ok"
    }
    const { sink, events } = collectSink()
    const mgr = new AgentLifecycleManager(pool, board, bus, exec, sink)

    // 注册一个 completed 条目，finishedAt 为 31 分钟前
    board.register({ agentId: "sub-expired", parentAgentId: "main", description: "old", isolationId: "iso-expired" })
    board.complete("sub-expired", "done", "diff")
    // 手动调整 finishedAt — simulate 31 minutes ago
    const entry = board.getEntry("sub-expired")!
    entry.finishedAt = Date.now() - 31 * 60 * 1000

    mgr.start()

    // 推进 60 秒 — 触发巡检 + flush microtasks
    await vi.advanceTimersByTimeAsync(60_000)

    // discard 被调用
    expect(discardCalls).toContain("iso-expired")

    // board 状态变为 stopped
    expect(board.getEntry("sub-expired")!.status).toBe("stopped")

    // 发了告警
    const notice = events.find(
      (e) => e.kind === EventKind.Notice && e.text.includes("自动清理"),
    )
    expect(notice).toBeDefined()
    expect(notice!.text).toContain("sub-expired")

    mgr.stop()
    vi.useRealTimers()
  })

  it("泄漏 + merge 后不再告警", () => {
    vi.useFakeTimers()

    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register(addr("main"))

    const { sink, events } = collectSink()
    const exec: ToolExecutor = async () => "ok"
    const mgr = new AgentLifecycleManager(pool, board, bus, exec, sink)

    board.register({ agentId: "sub-fix", parentAgentId: "main", description: "fix", isolationId: "iso-fix" })
    board.complete("sub-fix", "done", "diff")

    mgr.start()

    // 第一次巡检 — 检测到泄漏
    vi.advanceTimersByTime(60_000)
    expect(events.some((e) => e.kind === EventKind.Notice && e.text.includes("sub-fix"))).toBe(true)

    // merge 后不再泄漏
    board.markMerged("sub-fix")

    events.length = 0
    vi.advanceTimersByTime(60_000)
    expect(events.some((e) => e.kind === EventKind.Notice && e.text.includes("未合并"))).toBe(false)

    mgr.stop()
    vi.useRealTimers()
  })
})
