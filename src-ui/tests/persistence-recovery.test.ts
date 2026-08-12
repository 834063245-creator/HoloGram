// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 持久化与崩溃恢复 — Phase 2 收尾测试
//
// 5 组测试：
//   3.1 MessageBus flush → restore 往返一致性
//   3.2 TaskBoard flush → restore 往返一致性
//   3.3 debounced flush 不丢数据
//   3.4 空启动恢复不报错
//   3.5 孤儿检测（running 条目 → stop + discard）

import { describe, expect, it, vi } from "vitest"

// ── bridge mock — 内存文件系统 ──

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
import { JsonMessageStore } from "../src/agent/message-store"
import { AgentRuntime } from "../src/agent/runtime/runtime"
import type { AgentAddress } from "../src/agent/message-types"

// ═══════════════════════════════════════════════════════
// 内存文件系统 helper
// ═══════════════════════════════════════════════════════

interface MemFS {
  files: Map<string, string>
  dirs: Set<string>
}

function createMemFS(): MemFS {
  return { files: new Map(), dirs: new Set() }
}

/** 设置 mockRpc 为内存文件系统模式 */
function setupMemFs(fs: MemFS): void {
  mockRpc.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case 'create_directory': {
        fs.dirs.add(args.path as string)
        return 'ok'
      }
      case 'write_file_content': {
        fs.files.set(args.file_path as string, args.content as string)
        return 'ok'
      }
      case 'read_file_content': {
        const content = fs.files.get(args.file_path as string)
        if (content === undefined) throw new Error('file not found')
        return content
      }
      case 'list_directory': {
        const dirPath = args.path as string
        const entries: { name: string; is_dir: boolean }[] = []
        const seen = new Set<string>()
        for (const fp of fs.files.keys()) {
          // fp = dirPath + '/subdir/...'
          if (fp.startsWith(dirPath + '/')) {
            const rest = fp.slice(dirPath.length + 1)
            const firstSeg = rest.split('/')[0]
            if (!seen.has(firstSeg)) {
              seen.add(firstSeg)
              entries.push({ name: firstSeg, is_dir: rest.includes('/') })
            }
          }
        }
        for (const d of fs.dirs) {
          if (d.startsWith(dirPath + '/')) {
            const rest = d.slice(dirPath.length + 1)
            const firstSeg = rest.split('/')[0]
            if (!seen.has(firstSeg)) {
              seen.add(firstSeg)
              entries.push({ name: firstSeg, is_dir: true })
            }
          }
        }
        return JSON.stringify(entries)
      }
      case 'agent_isolation_discard': {
        return 'discarded'
      }
      default:
        return 'ok'
    }
  })
}

/** 设置 mockRpc 为全部 reject 模式（模拟无文件） */
function setupRejectAll(): void {
  mockRpc.mockRejectedValue(new Error('not found'))
}

function addr(agentId: string, parentId: string | null = null, depth = 0): AgentAddress {
  return { agentId, parentId, depth }
}

// ═══════════════════════════════════════════════════════
// 3.1 MessageBus — flush/restore 往返一致性
// ═══════════════════════════════════════════════════════

describe("MessageBus — flush/restore 往返一致性", () => {
  it("flush 写入 inbox.json，restore 后消息完全一致", async () => {
    const fs = createMemFS()
    setupMemFs(fs)

    // 构造 MessageBus + store
    const store = new JsonMessageStore("/fake/project")
    const bus = new MessageBus(undefined, store)
    bus.setTopology(new MeshTopology())

    // 注册 2 个 agent
    bus.register(addr("agent-a"))
    bus.register(addr("agent-b"))

    // 发送 3 条消息：send / reply / broadcast
    // send: agent-a → agent-b
    const msgId1 = bus.send({ from: "agent-a", to: "agent-b", type: "task", payload: "hello-b" })

    // reply: agent-b 回复 agent-a
    const msgId2 = bus.reply("agent-b", msgId1, "reply-payload")

    // broadcast: agent-a 广播
    bus.broadcast("agent-a", "notification", { text: "broadcast-msg" })

    // 手动 flush
    await bus.flush()

    // 验证 mockRpc 被调了 write_file_content，路径含 .hologram/agents/{agentId}/inbox.json
    const writeCalls = mockRpc.mock.calls.filter(
      (c: any[]) => c[0] === 'write_file_content',
    )
    expect(writeCalls.length).toBeGreaterThanOrEqual(1)

    const writtenPaths = writeCalls.map((c: any[]) => (c[1] as Record<string, unknown>).file_path as string)
    // agent-a 和 agent-b 的 inbox 都应该被写入
    expect(writtenPaths.some((p) => p.includes(".hologram/agents/agent-a/inbox.json"))).toBe(true)
    expect(writtenPaths.some((p) => p.includes(".hologram/agents/agent-b/inbox.json"))).toBe(true)

    // 验证写入的内容是合法 JSON 数组
    const inboxAFile = fs.files.get("/fake/project/.hologram/agents/agent-a/inbox.json")
    expect(inboxAFile).toBeDefined()
    const inboxAMsgs = JSON.parse(inboxAFile!)
    expect(Array.isArray(inboxAMsgs)).toBe(true)

    // 新建第二个 store + bus2，调 restore
    const store2 = new JsonMessageStore("/fake/project")
    const bus2 = new MessageBus(undefined, store2)
    bus2.setTopology(new MeshTopology())
    await bus2.restore()

    // 验证 bus2.peekInbox("agent-a") 与 bus.peekInbox("agent-a") 消息数量一致
    const origA = bus.peekInbox("agent-a")
    const restoredA = bus2.peekInbox("agent-a")
    expect(restoredA.length).toBe(origA.length)

    // 验证每条消息的 id、from、to、type、payload 完全一致
    for (let i = 0; i < origA.length; i++) {
      expect(restoredA[i].id).toBe(origA[i].id)
      expect(restoredA[i].from).toBe(origA[i].from)
      expect(restoredA[i].to).toBe(origA[i].to)
      expect(restoredA[i].type).toBe(origA[i].type)
      expect(restoredA[i].payload).toEqual(origA[i].payload)
    }

    // 验证 unreadCount 一致
    expect(bus2.unreadCount("agent-a")).toBe(bus.unreadCount("agent-a"))
    expect(bus2.unreadCount("agent-b")).toBe(bus.unreadCount("agent-b"))

    // 验证 reply 消息的 replyTo 字段也一致
    const origB = bus.peekInbox("agent-b")
    const restoredB = bus2.peekInbox("agent-b")
    if (origB.length > 0 && restoredB.length > 0) {
      expect(restoredB[0].replyTo).toBe(origB[0].replyTo)
    }
  })
})

// ═══════════════════════════════════════════════════════
// 3.2 TaskBoard — flush/restore 往返一致性
// ═══════════════════════════════════════════════════════

describe("TaskBoard — flush/restore 往返一致性", () => {
  it("flush 写入 taskboard.json，restore 后所有字段完全一致", async () => {
    const fs = createMemFS()
    setupMemFs(fs)

    const board = new TaskBoard("/fake/project", "default")

    // register 2 个条目（1 个有 isolationId，1 个无）
    board.register({
      agentId: "sub-1",
      parentAgentId: "main",
      description: "task with isolation",
      isolationId: "iso-1",
    })
    board.register({
      agentId: "sub-2",
      parentAgentId: "main",
      description: "task without isolation",
      isolationId: null,
    })

    // 对第一个调 recordFileTouch 2 个文件
    board.recordFileTouch("sub-1", "/a.ts")
    board.recordFileTouch("sub-1", "/b.ts")

    // 对第一个调 complete，对第二个调 fail
    board.complete("sub-1", "done summary", "diff content")
    board.fail("sub-2", "error message")

    // flush
    await board.flush()

    // 验证 mockRpc 被调了 write_file_content，路径含 .hologram/taskboard/default.json
    const writeCalls = mockRpc.mock.calls.filter(
      (c: any[]) => c[0] === 'write_file_content',
    )
    expect(writeCalls.length).toBeGreaterThanOrEqual(1)
    const boardWrite = writeCalls.find(
      (c: any[]) => ((c[1] as Record<string, unknown>).file_path as string).includes(".hologram/taskboard/default.json"),
    )
    expect(boardWrite).toBeDefined()
    const boardPath = (boardWrite![1] as Record<string, unknown>).file_path as string
    expect(boardPath).toContain(".hologram/taskboard/default.json")

    // 验证内容是合法 JSON 数组
    const raw = fs.files.get("/fake/project/.hologram/taskboard/default.json")
    expect(raw).toBeDefined()
    const arr = JSON.parse(raw!)
    expect(Array.isArray(arr)).toBe(true)
    expect(arr).toHaveLength(2)

    // 新建 board2，调 restore
    const board2 = new TaskBoard("/fake/project", "default")
    await board2.restore()

    // 验证所有字段完全一致
    const e1 = board.getEntry("sub-1")!
    const r1 = board2.getEntry("sub-1")!
    expect(r1.agentId).toBe(e1.agentId)
    expect(r1.parentAgentId).toBe(e1.parentAgentId)
    expect(r1.description).toBe(e1.description)
    expect(r1.status).toBe(e1.status)
    expect(r1.isolationId).toBe(e1.isolationId)
    expect(r1.filesTouched).toEqual(e1.filesTouched)
    expect(r1.summary).toBe(e1.summary)
    expect(r1.diff).toBe(e1.diff)
    expect(r1.startedAt).toBe(e1.startedAt)
    expect(r1.finishedAt).toBe(e1.finishedAt)

    const e2 = board.getEntry("sub-2")!
    const r2 = board2.getEntry("sub-2")!
    expect(r2.agentId).toBe(e2.agentId)
    expect(r2.parentAgentId).toBe(e2.parentAgentId)
    expect(r2.description).toBe(e2.description)
    expect(r2.status).toBe(e2.status)
    expect(r2.isolationId).toBe(e2.isolationId)
    expect(r2.filesTouched).toEqual(e2.filesTouched)
    expect(r2.summary).toBe(e2.summary)
    expect(r2.diff).toBe(e2.diff)
    expect(r2.startedAt).toBe(e2.startedAt)
    expect(r2.finishedAt).toBe(e2.finishedAt)
  })
})

// ═══════════════════════════════════════════════════════
// 3.3 debounced flush — 定时器 pending 时 flush 不丢数据
// ═══════════════════════════════════════════════════════

describe("debounced flush — 定时器 pending 时 flush 不丢数据", () => {
  it("TaskBoard: 手动 flush 在定时器 pending 时写入全部状态，之后定时器触发不丢数据", async () => {
    vi.useFakeTimers()

    const fs = createMemFS()
    setupMemFs(fs)

    const board = new TaskBoard("/fake/project", "default")
    board.register({
      agentId: "sub-1",
      parentAgentId: "main",
      description: "debounced task",
      isolationId: "iso-1",
    })
    // recordFileTouch 触发 _scheduleFlush() — 2 秒后 flush
    board.recordFileTouch("sub-1", "/a.ts")

    // 推进 1 秒 — 定时器还没触发
    await vi.advanceTimersByTimeAsync(1000)

    // 手动 flush — 应写入当前全部状态
    await board.flush()

    const writeCallsBefore = mockRpc.mock.calls.filter(
      (c: any[]) => c[0] === 'write_file_content',
    )
    expect(writeCallsBefore.length).toBeGreaterThanOrEqual(1)

    // 验证 JSON 内容包含该条目
    const raw = fs.files.get("/fake/project/.hologram/taskboard/default.json")
    expect(raw).toBeDefined()
    const arr = JSON.parse(raw!)
    expect(arr.some((e: [string, unknown]) => e[0] === "sub-1")).toBe(true)

    const firstWriteContent = raw!

    // 继续推进到 2 秒 — debounced flush 触发，再次写入
    await vi.advanceTimersByTimeAsync(2000)

    const writeCallsAfter = mockRpc.mock.calls.filter(
      (c: any[]) => c[0] === 'write_file_content',
    )
    // 至少被调了 2 次
    expect(writeCallsAfter.length).toBeGreaterThanOrEqual(2)

    // 两次内容一致（不丢数据）
    const secondWriteContent = fs.files.get("/fake/project/.hologram/taskboard/default.json")
    expect(secondWriteContent).toBe(firstWriteContent)

    // clearFlushTimer() 后不再有额外 flush
    board.clearFlushTimer()
    const countBefore = mockRpc.mock.calls.filter(
      (c: any[]) => c[0] === 'write_file_content',
    ).length
    await vi.advanceTimersByTimeAsync(5000)
    const countAfter = mockRpc.mock.calls.filter(
      (c: any[]) => c[0] === 'write_file_content',
    ).length
    expect(countAfter).toBe(countBefore)

    vi.useRealTimers()
  })

  it("MessageBus: clearFlushTimer + flush 后不再有额外写入", async () => {
    vi.useFakeTimers()

    const fs = createMemFS()
    setupMemFs(fs)

    const store = new JsonMessageStore("/fake/project")
    const bus = new MessageBus(undefined, store)
    bus.setTopology(new MeshTopology())
    bus.register(addr("sender"))
    bus.register(addr("receiver"))

    // 发消息（触发 debounced flush）
    bus.send({ from: "sender", to: "receiver", type: "msg", payload: "hello" })

    // 1 秒时调 clearFlushTimer() + flush — 验证数据写入
    await vi.advanceTimersByTimeAsync(1000)
    bus.clearFlushTimer()
    await bus.flush()

    const writeCount = mockRpc.mock.calls.filter(
      (c: any[]) => c[0] === 'write_file_content',
    ).length
    expect(writeCount).toBeGreaterThanOrEqual(1)

    // 推进 3 秒，验证没有额外的 write_file_content 调用（定时器已被 clear）
    await vi.advanceTimersByTimeAsync(3000)

    const writeCountAfter = mockRpc.mock.calls.filter(
      (c: any[]) => c[0] === 'write_file_content',
    ).length
    expect(writeCountAfter).toBe(writeCount)

    vi.useRealTimers()
  })
})

// ═══════════════════════════════════════════════════════
// 3.4 空启动恢复 — 无持久化文件时不报错
// ═══════════════════════════════════════════════════════

describe("空启动恢复 — 无持久化文件时不报错", () => {
  it("JsonMessageStore.restore() 返回空 Map", async () => {
    setupRejectAll()

    const store = new JsonMessageStore("/fake/project")
    const result = await store.restore()
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
  })

  it("MessageBus.restore() 后 inbox 为空", async () => {
    mockRpc.mockReset()
    setupRejectAll()

    const store = new JsonMessageStore("/fake/project")
    const bus = new MessageBus(undefined, store)
    await bus.restore()
    expect(bus.peekInbox("any-agent")).toEqual([])
  })

  it("TaskBoard.restore() 后无条目", async () => {
    mockRpc.mockReset()
    setupRejectAll()

    const board = new TaskBoard("/fake/project", "default")
    await board.restore()
    expect(board.getAllEntries()).toHaveLength(0)
  })

  it("AgentRuntime.ready() 不抛异常，bus/board 为空", async () => {
    mockRpc.mockReset()
    setupRejectAll()

    const runtime = new AgentRuntime("/fake/project")
    await runtime.ready()
    expect(runtime.getBus().listAgents()).toHaveLength(0)
    expect(runtime.getTaskBoard().getAllEntries()).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════
// 3.5 孤儿检测 — running 条目 → stop + discard
// ═══════════════════════════════════════════════════════

describe("孤儿检测 — running 条目 → stop + discard", () => {
  it("restore 后 running 条目变 stopped，completed 条目不变", async () => {
    const fs = createMemFS()
    setupMemFs(fs)

    // 构造 TaskBoard，写入 2 个条目
    const board = new TaskBoard("/fake/project", "default")
    board.register({
      agentId: "sub-completed",
      parentAgentId: "main",
      description: "completed task",
      isolationId: "iso-completed",
    })
    board.register({
      agentId: "sub-orphan",
      parentAgentId: "main",
      description: "orphan task",
      isolationId: "iso-orphan",
    })
    // 标记第一个 complete，第二个保持 running
    board.complete("sub-completed", "done", "diff-completed")

    await board.flush()

    // 新建 AgentRuntime — 构造函数会触发 _restore()
    const runtime = new AgentRuntime("/fake/project")
    await runtime.ready()

    // 验证 running 的条目状态变为 stopped
    const orphanEntry = runtime.getTaskBoard().getEntry("sub-orphan")
    expect(orphanEntry).toBeDefined()
    expect(orphanEntry!.status).toBe("stopped")

    // 验证 completed 的条目状态保持 completed（不被误改）
    const completedEntry = runtime.getTaskBoard().getEntry("sub-completed")
    expect(completedEntry).toBeDefined()
    expect(completedEntry!.status).toBe("completed")

    // 验证 mockRpc 被调了 agent_isolation_discard（孤儿 worktree 清理）
    const discardCalls = mockRpc.mock.calls.filter(
      (c: any[]) => c[0] === 'agent_isolation_discard',
    )
    expect(discardCalls.length).toBeGreaterThanOrEqual(1)
    // discard 的 agent_id 应该是孤儿的 isolationId
    const discardArgs = discardCalls.map((c: any[]) => (c[1] as Record<string, unknown>).agent_id as string)
    expect(discardArgs).toContain("iso-orphan")
  })
})

// ═══════════════════════════════════════════════════════
// P0-6 回归 — 瞬时读错误不得删除 inbox（雷区地图）
// ═══════════════════════════════════════════════════════

describe("P0-6: JsonMessageStore 区分「不存在」与「读错误」", () => {
  it("瞬时读错误（IPC 抖动）时 inbox.json 必须保留", async () => {
    mockRpc.mockReset()
    const deleteCalls: string[] = []
    mockRpc.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      switch (cmd) {
        case 'list_directory':
          return JSON.stringify([{ name: 'agent-x', is_dir: true }])
        case 'read_file_content':
          throw new Error('IPC timeout — 瞬时错误')
        case 'delete_file_or_dir':
          deleteCalls.push(args.path as string)
          return 'ok'
        default:
          return 'ok'
      }
    })

    const store = new JsonMessageStore("/fake/project")
    const result = await store.restore()
    expect(result.size).toBe(0) // 读不到就不返回，但绝不可删
    expect(deleteCalls).toEqual([])
  })

  it("文件不存在时仍清理孤儿目录", async () => {
    mockRpc.mockReset()
    const deleteCalls: string[] = []
    mockRpc.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = (args.path ?? '') as string
      switch (cmd) {
        case 'list_directory':
          if (p.endsWith('/agents')) return JSON.stringify([{ name: 'agent-x', is_dir: true }])
          return JSON.stringify([]) // agent 目录列为空 → delete 会继续删目录
        case 'read_file_content':
          throw new Error(`路径不存在: ${(args.file_path ?? '') as string}`)
        case 'delete_file_or_dir':
          deleteCalls.push(p)
          return 'ok'
        default:
          return 'ok'
      }
    })

    const store = new JsonMessageStore("/fake/project")
    await store.restore()
    expect(deleteCalls.some((p) => p.includes('inbox.json'))).toBe(true)
  })

  it("inbox.json 损坏（JSON 解析失败）时保留文件并告警", async () => {
    mockRpc.mockReset()
    const deleteCalls: string[] = []
    mockRpc.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      switch (cmd) {
        case 'list_directory':
          return JSON.stringify([{ name: 'agent-x', is_dir: true }])
        case 'read_file_content':
          return '{{corrupted'
        case 'delete_file_or_dir':
          deleteCalls.push(args.path as string)
          return 'ok'
        default:
          return 'ok'
      }
    })

    const store = new JsonMessageStore("/fake/project")
    const result = await store.restore()
    expect(result.size).toBe(0)
    expect(deleteCalls).toEqual([])
  })
})
