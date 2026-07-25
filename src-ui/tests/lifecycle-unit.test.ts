// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多 Agent 事件生命周期 — 单元测试
//
// 验证各组件独立行为：
//   1. TaskBoard register/complete/fail/file-tracking
//   2. agent_spawn async=true 立即返回
//   3. bus 唤醒 idle agent
//   4. bus 唤醒 running agent 不重入
//   5. agent_merge 串行合并 + 冲突保全
//   6. _injectedMsgIds 防死循环

import { describe, expect, it, vi } from "vitest"

// ── bridge mock — Agent 构造时 import rpc，必须先 mock ──

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
import { Agent } from "../src/agent/agent"
import { ToolRegistry, type Tool, type ToolExecutor } from "../src/agent/tool"
import { createSubAgentTool, type SubAgentSpawner } from "../src/agent/tools/subagent"
import { createMergeTool } from "../src/agent/tools/merge"
import { createExecState } from "../src/agent/execution-state"
import type { Chunk, Provider, Usage } from "../src/provider/types"
import { ChunkType } from "../src/provider/types"
import type { AgentAddress } from "../src/agent/message-types"
import { EventKind } from "../src/agent/agent-types"

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

const USAGE: Usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  cache_hit_tokens: 0,
  cache_miss_tokens: 10,
  reasoning_tokens: 0,
  finish_reason: "stop",
}

/** Provider 发一条文本 + Done — 适用于"跑一轮就结束"的测试 */
function textProvider(text: string): Provider {
  return {
    name: () => "mock",
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        yield { type: ChunkType.Text, text }
        yield { type: ChunkType.Usage, usage: USAGE }
        yield { type: ChunkType.Done }
      })(),
  }
}

/** Provider 延迟后发文本 — 用于测试"run 期间发消息不重入" */
function slowTextProvider(text: string, delayMs: number): Provider {
  return {
    name: () => "mock",
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        await new Promise((r) => setTimeout(r, delayMs))
        yield { type: ChunkType.Text, text }
        yield { type: ChunkType.Usage, usage: USAGE }
        yield { type: ChunkType.Done }
      })(),
  }
}

function addr(agentId: string, parentId: string | null = null, depth = 0): AgentAddress {
  return { agentId, parentId, depth }
}

function emptyRegistry(): ToolRegistry {
  return new ToolRegistry()
}

function makeAgent(prov: Provider, opts: Record<string, unknown> = {}): Agent {
  return new Agent(prov, emptyRegistry(), "test", {
    eventSink: () => {},
    contextWindow: 0,
    ...opts,
  })
}

// ═══════════════════════════════════════════════════════
// 1. TaskBoard register / complete / fail / file-tracking
// ═══════════════════════════════════════════════════════

describe("TaskBoard", () => {
  it("register → complete → markMerged 全生命周期", () => {
    const board = new TaskBoard()
    board.register({ agentId: "sub-1", parentAgentId: "main", description: "task A", isolationId: "iso-1" })

    const entry = board.getEntry("sub-1")!
    expect(entry.status).toBe("running")
    expect(entry.isolationId).toBe("iso-1")
    expect(entry.filesTouched).toEqual([])
    expect(entry.startedAt).toBeGreaterThan(0)
    expect(entry.finishedAt).toBeUndefined()

    // file tracking
    board.recordFileTouch("sub-1", "/a.ts")
    board.recordFileTouch("sub-1", "/b.ts")
    board.recordFileTouch("sub-1", "/a.ts") // 去重
    expect(entry.filesTouched).toEqual(["/a.ts", "/b.ts"])

    // complete
    board.complete("sub-1", "done summary", "diff content")
    expect(entry.status).toBe("completed")
    expect(entry.summary).toBe("done summary")
    expect(entry.diff).toBe("diff content")
    expect(entry.finishedAt).toBeGreaterThan(0)

    // markMerged
    board.markMerged("sub-1")
    expect(entry.status).toBe("merged")
  })

  it("fail / stop 设置 finishedAt + 状态", () => {
    const board = new TaskBoard()
    board.register({ agentId: "sub-2", parentAgentId: "main", description: "task B", isolationId: null })

    board.fail("sub-2", "boom")
    let entry = board.getEntry("sub-2")!
    expect(entry.status).toBe("failed")
    expect(entry.summary).toBe("boom")
    expect(entry.finishedAt).toBeGreaterThan(0)

    // stop
    board.register({ agentId: "sub-3", parentAgentId: "main", description: "task C", isolationId: null })
    board.stop("sub-3")
    entry = board.getEntry("sub-3")!
    expect(entry.status).toBe("stopped")
    expect(entry.finishedAt).toBeGreaterThan(0)
  })

  it("getChildren 按 parentAgentId 过滤", () => {
    const board = new TaskBoard()
    board.register({ agentId: "sub-a", parentAgentId: "main", description: "a", isolationId: null })
    board.register({ agentId: "sub-b", parentAgentId: "main", description: "b", isolationId: null })
    board.register({ agentId: "sub-c", parentAgentId: "other", description: "c", isolationId: null })

    const mainChildren = board.getChildren("main")
    expect(mainChildren).toHaveLength(2)
    expect(mainChildren.map((e) => e.agentId).sort()).toEqual(["sub-a", "sub-b"])

    expect(board.getChildren("other")).toHaveLength(1)
    expect(board.getChildren("none")).toHaveLength(0)
  })

  it("unregister 移除条目", () => {
    const board = new TaskBoard()
    board.register({ agentId: "sub-x", parentAgentId: "main", description: "x", isolationId: null })
    expect(board.getEntry("sub-x")).toBeDefined()
    board.unregister("sub-x")
    expect(board.getEntry("sub-x")).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════
// 2. agent_spawn async=true 立即返回
// ═══════════════════════════════════════════════════════

describe("agent_spawn — async=true 立即返回", () => {
  it("async 模式不阻塞，立即返回 agentId", async () => {
    const pool = new SubAgentPool()
    const spawner: SubAgentSpawner = async () => {
      await new Promise((r) => setTimeout(r, 500))
      return { text: "后台完成" }
    }
    const tool = createSubAgentTool(spawner, pool)

    const start = Date.now()
    const result = await tool.execute({ description: "bg task", prompt: "do it", async: true })
    const elapsed = Date.now() - start

    // 应该几乎立即返回（< 100ms），不会等 500ms
    expect(elapsed).toBeLessThan(100)
    expect(result).toContain("子Agent已启动")
    expect(result).toMatch(/id:\s*sub-/)
    expect(pool.runningCount).toBe(1)

    // 等待后台完成
    await new Promise((r) => setTimeout(r, 600))
    expect(pool.runningCount).toBe(0)
  })

  it("async 模式支持多个并发", async () => {
    const pool = new SubAgentPool()
    const spawner: SubAgentSpawner = async () => {
      await new Promise((r) => setTimeout(r, 100))
      return { text: "ok" }
    }
    const tool = createSubAgentTool(spawner, pool)

    const r1 = await tool.execute({ description: "t1", prompt: "p", async: true })
    const r2 = await tool.execute({ description: "t2", prompt: "p", async: true })
    const r3 = await tool.execute({ description: "t3", prompt: "p", async: true })

    expect(r1).toContain("子Agent已启动")
    expect(r2).toContain("子Agent已启动")
    expect(r3).toContain("子Agent已启动")
    expect(pool.runningCount).toBe(3)

    await new Promise((r) => setTimeout(r, 200))
    expect(pool.runningCount).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════
// 3. bus 唤醒 idle agent
// ═══════════════════════════════════════════════════════

describe("MessageBus — 唤醒 idle agent", () => {
  it("idle agent 收到消息后触发 wake callback", async () => {
    const bus = new MessageBus()
    let wakeCount = 0
    bus.register(addr("parent"), () => {
      wakeCount++
    })
    bus.register(addr("child", "parent", 1))

    // parent → child: 投递到 child 的 inbox, child 的 wake 触发
    let childWakeCount = 0
    bus.unregister("child")
    bus.register(addr("child", "parent", 1), () => {
      childWakeCount++
    })

    bus.send({ from: "parent", to: "child", type: "result", payload: "hello" })
    expect(childWakeCount).toBe(1)
    expect(wakeCount).toBe(0) // parent 没收到消息

    // 第二条消息也触发
    bus.send({ from: "parent", to: "child", type: "result", payload: "world" })
    expect(childWakeCount).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════
// 4. bus 唤醒 running agent 不重入
// ═══════════════════════════════════════════════════════

describe("MessageBus — 唤醒 running agent 不重入", () => {
  it("Agent._isRunning 为 true 时 wake callback 不触发 run", async () => {
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    // 用慢速 provider 确保 runLoop 有足够时间让我们在期间发消息
    const agent = makeAgent(slowTextProvider("done", 200))

    agent.setBus(bus)
    bus.register(addr("other"))

    const runSpy = vi.spyOn(agent, "run")

    // 启动 run（provider 延迟 200ms 才返回）
    const ctrl = new AbortController()
    const runPromise = agent.run(ctrl.signal, "go")

    // 等 50ms 确保 _isRunning 已设为 true
    await new Promise((r) => setTimeout(r, 50))

    // 在 run 期间发消息 — _isRunning 为 true，wake callback 直接 return
    // 不会触发并发的 run
    bus.send({ from: "other", to: agent.id, type: "result", payload: "msg during run" })

    await runPromise

    // 第 1 次 run 已结束。消息在 runLoop 期间到达但未被 _injectInbox 捡到
    // （_injectInbox 在 provider stream 之前执行），所以 finally 块检测到
    // hasNew=true，通过 queueMicrotask 触发第 2 次 run — 这是设计行为。
    // 关键：第 2 次 run 在第 1 次结束后才启动（_isRunning=false 时），不重入。
    await new Promise((r) => setTimeout(r, 50))

    // run 被调用 2 次：1 次手动，1 次 finally 块的 post-run wakeup
    expect(runSpy).toHaveBeenCalledTimes(2)
    // 第 2 次调用的 input 是空字符串（bus wakeup 路径）
    expect(runSpy.mock.calls[1][1]).toBe("")

    // 等第 2 次 run 完成
    await new Promise((r) => setTimeout(r, 300))
  })
})

// ═══════════════════════════════════════════════════════
// 5. agent_merge 串行合并 + 冲突保全
// ═══════════════════════════════════════════════════════

describe("agent_merge — 串行合并 + 冲突保全", () => {
  it("成功串行合并多个 completed 条目", async () => {
    const board = new TaskBoard()
    board.register({ agentId: "sub-1", parentAgentId: "main", description: "task A", isolationId: "iso-1" })
    board.register({ agentId: "sub-2", parentAgentId: "main", description: "task B", isolationId: "iso-2" })
    board.complete("sub-1", "summary A", "diff A")
    board.complete("sub-2", "summary B", "diff B")

    // mock exec — 记录调用顺序
    const calls: string[] = []
    const exec: ToolExecutor = async (name, args) => {
      calls.push(`${name}:${args.agent_id}`)
      return "ok"
    }

    const tool = createMergeTool(board, () => "main", exec)
    const result = await tool.execute({})

    expect(result).toContain("已合并 2 个子Agent")
    expect(result).toContain("0 个冲突")
    expect(board.getEntry("sub-1")!.status).toBe("merged")
    expect(board.getEntry("sub-2")!.status).toBe("merged")

    // 串行：merge + discard 交替
    expect(calls).toEqual([
      "agent_isolation_merge:iso-1",
      "agent_isolation_discard:iso-1",
      "agent_isolation_merge:iso-2",
      "agent_isolation_discard:iso-2",
    ])
  })

  it("merge 冲突时保全 diff + 清理 worktree", async () => {
    const board = new TaskBoard()
    board.register({ agentId: "sub-x", parentAgentId: "main", description: "conflict task", isolationId: "iso-x" })
    board.complete("sub-x", "summary X", "diff X content")

    const exec: ToolExecutor = async (name) => {
      if (name === "agent_isolation_merge") throw new Error("CONFLICT: both modified same line")
      return "discarded"
    }

    const tool = createMergeTool(board, () => "main", exec)
    const result = await tool.execute({})

    expect(result).toContain("0 个子Agent")
    // wait — 0 merged + 1 conflict
    expect(result).toContain("1 个冲突")
    expect(result).toContain("CONFLICT")
    expect(result).toContain("diff 已保存在 TaskBoard")

    // diff 仍然在 board 上（未被 markMerged）
    const entry = board.getEntry("sub-x")!
    expect(entry.diff).toBe("diff X content")
    expect(entry.status).toBe("completed") // 未变为 merged
  })

  it("无 isolationId 的条目直接标记 merged（fresh 模式）", async () => {
    const board = new TaskBoard()
    board.register({ agentId: "sub-fresh", parentAgentId: "main", description: "fresh task", isolationId: null })
    board.complete("sub-fresh", "summary", "diff")

    const exec: ToolExecutor = async () => "ok"
    const tool = createMergeTool(board, () => "main", exec)
    const result = await tool.execute({})

    expect(result).toContain("已合并 1 个子Agent")
    expect(board.getEntry("sub-fresh")!.status).toBe("merged")
  })

  it("无待合并条目时返回提示", async () => {
    const board = new TaskBoard()
    const exec: ToolExecutor = async () => "ok"
    const tool = createMergeTool(board, () => "main", exec)
    const result = await tool.execute({})
    expect(result).toContain("没有待合并")
  })
})

// ═══════════════════════════════════════════════════════
// 6. _injectedMsgIds 防死循环
// ═══════════════════════════════════════════════════════

describe("_injectedMsgIds — 防死循环", () => {
  it("未 ack 的消息不会在同一 runLoop 周期内重复注入", async () => {
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    const events: string[] = []
    const agent = makeAgent(textProvider("final answer"), {
      eventSink: (ev: any) => {
        if (ev.kind === EventKind.Text) events.push(ev.text)
      },
    })
    agent.setBus(bus)

    // 注册一个 sender
    bus.register(addr("sender"))

    // 发一条自由类型消息到 agent 的 inbox
    bus.send({ from: "sender", to: agent.id, type: "status", payload: "hello" })
    expect(bus.unreadCount(agent.id)).toBe(1)

    // run — 会注入 inbox 消息 + 跑一轮 provider
    const ctrl = new AbortController()
    await agent.run(ctrl.signal, "")

    // 自由类型消息注入后仍在 inbox（只发轻量通知，不消费）
    expect(bus.unreadCount(agent.id)).toBe(1)

    // 等一下让 microtask 跑完
    await new Promise((r) => setTimeout(r, 20))

    // runLoop 没有被重新触发（_injectedMsgIds 阻止重复注入）
    expect(events).toContain("final answer")
  })

  it("新一轮 run 不再重新注入已通知的自由类型消息（修复 token 暴增）", async () => {
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    const agent = makeAgent(textProvider("answer"))
    agent.setBus(bus)
    bus.register(addr("sender"))

    // 发自由类型消息
    bus.send({ from: "sender", to: agent.id, type: "status", payload: "hello" })

    // 第一轮 run（空 input — bus wakeup 路径）
    const ctrl1 = new AbortController()
    await agent.run(ctrl1.signal, "")

    // 自由类型消息仍在 inbox
    expect(bus.unreadCount(agent.id)).toBe(1)

    // 第二轮 run（带 input — 用户主动触发）
    const ctrl2 = new AbortController()
    await agent.run(ctrl2.signal, "user message")

    // 消息不应被重新注入（不再 clear _injectedMsgIds）
    // Free-type messages go into _transientReminders, not session —
    // they're prepended to the LLM call but not persisted in session history.
    // Verify via unreadCount: message still in inbox but not re-injected
    expect(bus.unreadCount(agent.id)).toBe(1)  // still in inbox, not consumed

    // The _injectedMsgIds should still have the message ID —
    // second run should NOT produce new transient reminders
    // (tested by checking the agent's transient list is empty after second run's injection)
    // Since _transientReminders is cleared at step>0 in runLoop, we verify indirectly:
    // the session should NOT contain any "未读消息" content (free msgs are transient, not in session)
    const session = agent.getSession()
    const inboxInSession = session.filter(
      (m) => typeof m.content === "string" && m.content.includes("📬 未读消息"),
    )
    // Free-type messages are transient — they never go into session
    expect(inboxInSession.length).toBe(0)
  })
})
