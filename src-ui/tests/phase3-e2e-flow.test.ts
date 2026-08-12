// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Phase 3 端到端冒烟测试 — 验证多 Agent 系统全链路
//
// 5 个场景：
//   1. async spawn → bus result → agent_merge 完整流程
//   2. bus 唤醒 idle agent 触发 runLoop
//   3. 系统提示词包含多 Agent 协作段落
//   4. Agent 状态变更回调触发
//   5. AgentPanelStore 数据更新

import { describe, expect, it, vi, beforeEach } from "vitest"

// 单测环境无真实引擎图 — 关闭 merge 门禁的图检查（merge.ts 预留旁路）
;(globalThis as any).__HOLOGRAM_MERGE_GATE__ = { graph: false }

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
import { ToolRegistry, type ToolExecutor } from "../src/agent/tool"
import { createSubAgentTool, type SubAgentSpawner } from "../src/agent/tools/subagent"
import { createMergeTool } from "../src/agent/tools/merge"
import { createExecState } from "../src/agent/execution-state"
import { buildSystemPrompt } from "../src/agent/runtime/agent-builder"
import { useAgentPanelStore } from "../src/ui/agent-panel-store"
import type { Chunk, Provider, Usage } from "../src/provider/types"
import { ChunkType } from "../src/provider/types"
import type { AgentAddress } from "../src/agent/message-types"

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
// 1. async spawn → bus result → agent_merge 完整流程
// ═══════════════════════════════════════════════════════

describe("端到端：async spawn → bus result → agent_merge", () => {
  it("完整流程：异步 spawn → bus 通知 → merge 合并", async () => {
    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register(addr("main"))

    // mock spawner — 模拟 async 模式完整生命周期
    const spawner: SubAgentSpawner = async (desc, _prompt, _prog, _mode, _al, _sig, asyncMode, agentIdOverride) => {
      const agentId = agentIdOverride ?? `sub-${Date.now()}`
      if (asyncMode) {
        // 1. 注册到 board
        board.register({
          agentId,
          parentAgentId: "main",
          description: desc,
          isolationId: `iso-${agentId}`,
        })
        // 2. 模拟后台工作
        await new Promise((r) => setTimeout(r, 50))
        // 3. 完成时保全 diff + 发 bus 消息
        board.complete(agentId, `${desc} 完成`, `diff-${agentId}`)
        bus.register(addr(agentId, "main", 1))
        bus.send({
          from: agentId,
          to: "main",
          type: "result",
          payload: { summary: `${desc} done`, success: true, agentId },
        })
      }
      return { text: `子Agent已启动 (id: ${agentId})` }
    }

    const tool = createSubAgentTool(spawner, pool)

    // spawn 3 个异步子 Agent
    await tool.execute({ description: "task-A", prompt: "p", async: true })
    await tool.execute({ description: "task-B", prompt: "p", async: true })
    await tool.execute({ description: "task-C", prompt: "p", async: true })
    expect(pool.runningCount).toBe(3)

    // 等待全部完成
    await new Promise((r) => setTimeout(r, 150))
    expect(pool.runningCount).toBe(0)

    // 验证：bus 收到 3 条 result 消息
    const inbox = bus.peekInbox("main")
    expect(inbox).toHaveLength(3)
    expect(inbox.every((m) => m.type === "result")).toBe(true)

    // 验证：board 上 3 个条目都是 completed
    const children = board.getChildren("main")
    expect(children).toHaveLength(3)
    expect(children.every((e) => e.status === "completed")).toBe(true)
    expect(children.every((e) => e.diff != null && e.diff.length > 0)).toBe(true)

    // agent_merge — 串行合并
    const mergeCalls: string[] = []
    const exec: ToolExecutor = async (name, args) => {
      if (name === "agent_isolation_merge") {
        mergeCalls.push(args.agent_id as string)
        return "merged"
      }
      if (name === "agent_isolation_discard") return "discarded"
      return "ok"
    }
    const mergeTool = createMergeTool(board, () => "main", exec, { projectPath: "TEST_PROJECT" })
    const result = await mergeTool.execute({})

    expect(result).toContain("已合并 3 个子Agent")
    expect(result).toContain("0 个冲突")
    expect(children.every((e) => e.status === "merged")).toBe(true)
    expect(mergeCalls).toHaveLength(3)
  })
})

// ═══════════════════════════════════════════════════════
// 2. bus 唤醒 idle agent 触发 runLoop
// ═══════════════════════════════════════════════════════

describe("端到端：bus 唤醒 idle agent", () => {
  it("idle agent 收到消息后自动启动 runLoop，注入 inbox + 产生输出", async () => {
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())

    const agent = makeAgent(textProvider("wakeup response"), {
      messageBus: bus,
      execState: createExecState(),
    })
    agent.setBus(bus)

    // 注册一个 sender
    bus.register(addr("sender"))

    // 给 idle agent 发消息
    bus.send({ from: "sender", to: agent.id, type: "result", payload: "hello-wakeup" })

    // bus 唤醒会异步触发 run(signal, '') — 等它跑完
    await new Promise((r) => setTimeout(r, 100))

    // 验证：session 中有 inbox 注入的 system-reminder
    const session = agent.getSession()
    const reminder = session.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("📬 消息"),
    )
    expect(reminder).toBeDefined()
    expect(reminder!.content).toContain("hello-wakeup")

    // 验证：agent 产生了输出（被唤醒后跑了一轮 provider）
    const assistantMsg = session.find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("wakeup response"))
    expect(assistantMsg).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════
// 3. 系统提示词包含多 Agent 协作段落
// ═══════════════════════════════════════════════════════

describe("端到端：系统提示词验证", () => {
  it("系统提示词包含多 Agent 协作段落", () => {
    const prompt = buildSystemPrompt(
      { nodes: [], edges: [] },
      "/fake/project",
      "",
      "",
      "",
      "deepseek",
    )

    expect(prompt).toContain("多 Agent 协作")
    expect(prompt).toContain("异步子 Agent")
    expect(prompt).toContain("async=true")
    expect(prompt).toContain("agent(merge)")
    expect(prompt).toContain("agent(message)")
    expect(prompt).toContain("决策指南")
  })

  it("系统提示词模式无关：多 Agent 段落在规划/执行模式下一致", () => {
    // 协作模式不再影响系统提示词（footer 热切换不重建，避免击穿前缀缓存）；
    // 规划模式约束由 PlanModeInjector 的运行时提醒下发。
    const prompt = buildSystemPrompt(
      { nodes: [], edges: [] },
      "/fake/project",
      "",
      "",
      "",
      "deepseek",
    )

    expect(prompt).toContain("多 Agent 协作")
    expect(prompt).toContain("## 协作模式")
    expect(prompt).toContain("规划模式")
    expect(prompt).not.toContain("当前激活")
  })
})

// ═══════════════════════════════════════════════════════
// 4. Agent 状态变更回调触发
// ═══════════════════════════════════════════════════════

describe("端到端：Agent 状态变更回调", () => {
  it("run() 期间 onStatusChange 被调用：true → false", async () => {
    const statusCalls: boolean[] = []
    const agent = makeAgent(textProvider("done"), {
      ui: {
        onStatusChange: (running: boolean) => statusCalls.push(running),
      },
    })

    const ctrl = new AbortController()
    await agent.run(ctrl.signal, "hello")

    // run() 开始时触发 true
    expect(statusCalls[0]).toBe(true)
    // runLoop finally 触发 false
    expect(statusCalls[statusCalls.length - 1]).toBe(false)
  })

  it("Agent.isRunning getter 正确反映状态", async () => {
    const agent = makeAgent(textProvider("done"))
    expect(agent.isRunning).toBe(false)

    // run() 会设置 _isRunning = true，但 runLoop 结束后回到 false
    const ctrl = new AbortController()
    await agent.run(ctrl.signal, "go")

    expect(agent.isRunning).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// 5. AgentPanelStore 数据更新
// ═══════════════════════════════════════════════════════

describe("端到端：AgentPanelStore 数据更新", () => {
  beforeEach(() => {
    // 重置 store 状态
    useAgentPanelStore.setState({
      agents: [],
      taskBoard: [],
      messageFlow: [],
      alerts: [],
      runtimeRef: null,
    })
  })

  it("setAgents / pushMessage / pushAlert 正确更新 store", () => {
    const store = useAgentPanelStore.getState()

    // setAgents
    store.setAgents([
      { id: "main", parentId: null, status: "running", description: "主Agent", subagentDepth: 0 },
      { id: "sub-1", parentId: "main", status: "idle", description: "子Agent", subagentDepth: 1 },
    ])
    expect(useAgentPanelStore.getState().agents).toHaveLength(2)
    expect(useAgentPanelStore.getState().agents[0].id).toBe("main")
    expect(useAgentPanelStore.getState().agents[1].parentId).toBe("main")

    // pushMessage
    store.pushMessage({
      id: "msg-1",
      from: "sub-1",
      to: "main",
      type: "result",
      payload: "task done",
      ts: Date.now(),
    })
    expect(useAgentPanelStore.getState().messageFlow).toHaveLength(1)
    expect(useAgentPanelStore.getState().messageFlow[0].msg.from).toBe("sub-1")

    // pushAlert
    store.pushAlert({
      id: "alert-1",
      level: "warn",
      text: "检测到未合并的 worktree",
    })
    expect(useAgentPanelStore.getState().alerts).toHaveLength(1)
    expect(useAgentPanelStore.getState().alerts[0].level).toBe("warn")
  })

  it("pushMessage 超过 50 条自动淘汰最旧的", () => {
    const store = useAgentPanelStore.getState()

    for (let i = 0; i < 55; i++) {
      store.pushMessage({
        id: `msg-${i}`,
        from: "sender",
        to: "receiver",
        type: "test",
        payload: `message-${i}`,
        ts: Date.now() + i,
      })
    }

    const flow = useAgentPanelStore.getState().messageFlow
    expect(flow).toHaveLength(50)
    // 最旧的 5 条被淘汰
    expect(flow[0].msg.id).toBe("msg-5")
    expect(flow[flow.length - 1].msg.id).toBe("msg-54")
  })

  it("pushAlert 超过 20 条自动淘汰最旧的", () => {
    const store = useAgentPanelStore.getState()

    for (let i = 0; i < 25; i++) {
      store.pushAlert({
        id: `alert-${i}`,
        level: "info",
        text: `alert-${i}`,
      })
    }

    const alerts = useAgentPanelStore.getState().alerts
    expect(alerts).toHaveLength(20)
    expect(alerts[0].id).toBe("alert-5")
    expect(alerts[alerts.length - 1].id).toBe("alert-24")
  })
})
