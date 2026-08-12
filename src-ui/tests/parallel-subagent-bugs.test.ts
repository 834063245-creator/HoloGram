// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 并行子 Agent 恶性 bug 回归测试（2026-08-13 事故）
// 事故报告：docs/agents/platform-bugs-2026-08-13.md
//
// 覆盖：
//   1. edit_file 透传 _agent_id（fork 子 Agent 的 edit 必须落进 worktree，而非主仓）
//   2. rename_file 透传 _agent_id
//   3. 领域工具 fs(edit) 路径同样透传 _agent_id
//   4. fresh 子 Agent 经 fs(edit) 写文件必须命中所有权包装（不被领域工具绕过）
//   5. fork worktree 创建失败必须显式上抛/告警，不得静默降级直写主仓
//   6. merge 无产物（worktree 无变更）不得报「已自动合并回主仓」假成功

import { describe, expect, it, vi } from "vitest"

;(globalThis as any).__HOLOGRAM_MERGE_GATE__ = { graph: false }

const mockRpc = vi.fn()
vi.mock("../src/bridge", () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}))
vi.mock("../src/ui/events", () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }))

import { ToolRegistry, type ToolExecutor } from "../src/agent/tool"
import { createCodingTools } from "../src/agent/tools/coding"
import { createDomainTools, convergeRegistry } from "../src/agent/tools/domains"
import { Agent } from "../src/agent/agent"
import { FileOwnership } from "../src/agent/file-ownership"
import { createMergeTool } from "../src/agent/tools/merge"
import { TaskBoard } from "../src/agent/task-board"
import { MessageBus } from "../src/agent/message-bus"
import { MeshTopology } from "../src/agent/topology"
import { SubAgentPool } from "../src/agent/coordinator"
import { AgentLifecycleManager } from "../src/agent/lifecycle-manager"
import { enqueueIsolationOp } from "../src/agent/isolation-queue"
import type { Chunk, Provider, Usage } from "../src/provider/types"
import { ChunkType } from "../src/provider/types"

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function recordingExec() {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const exec: ToolExecutor = async (name, args) => {
    calls.push({ name, args: args as Record<string, unknown> })
    return "ok"
  }
  return { calls, exec }
}

// ═══════════════════════════════════════════════════════
// 1/2. edit_file / rename_file 必须透传 _agent_id
//      fork 子 Agent 的 worktree 路由完全靠这个参数（Rust 侧 forward_map_path）
//      丢掉它 = 子 Agent 的编辑直写主仓真身 → merge 时 worktree 无变更 → 假成功
// ═══════════════════════════════════════════════════════

describe("edit/rename 透传 _agent_id（worktree 路由）", () => {
  it("edit_file 保留 _agent_id", async () => {
    const { calls, exec } = recordingExec()
    const tools = createCodingTools(exec)
    const edit = tools.find((t) => t.name() === "edit_file")!

    await edit.execute({
      filePath: "D:/p/a.ts",
      oldString: "foo",
      newString: "bar",
      _agent_id: "agent-123",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe("edit_file")
    expect(calls[0].args._agent_id).toBe("agent-123")
  })

  it("rename_file 保留 _agent_id", async () => {
    const { calls, exec } = recordingExec()
    const tools = createCodingTools(exec)
    const rename = tools.find((t) => t.name() === "rename_file")!

    await rename.execute({
      path: "D:/p/a.ts",
      new_name: "b.ts",
      _agent_id: "agent-123",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].args._agent_id).toBe("agent-123")
  })

  it("fs(edit) 领域工具路径同样保留 _agent_id", async () => {
    const { calls, exec } = recordingExec()
    const registry = new ToolRegistry()
    for (const t of createCodingTools(exec)) registry.register(t)
    const domains = createDomainTools(registry)
    const fs = domains.find((t) => t.name() === "fs")!

    await fs.execute({
      action: "edit",
      filePath: "D:/p/a.ts",
      oldString: "foo",
      newString: "bar",
      _agent_id: "agent-123",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe("edit_file")
    expect(calls[0].args._agent_id).toBe("agent-123")
  })
})

// ═══════════════════════════════════════════════════════
// 共用 Helpers（Agent 级场景）
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

// 必须 >300 字符 — 低于 CONTEXT_LINE_LIMIT 会触发摘要提纯的额外 run，
// 无状态脚本 provider 会在提纯轮再发一次工具调用（把测试自己骗了）
const LONG_SUMMARY =
  "任务完成。已读取目标文件并应用修改，改动点逐处回读复核确认落盘；" +
  "未运行构建与测试（并行纪律），建议主 Agent 统一验证。".repeat(12)

/** 无状态脚本 provider：首个流发一次工具调用，工具结果回来后发长总结。
 *  两个并发子 Agent 共享同一 provider 实例也能各自走对脚本（按 req.messages 末条 role 判定），
 *  toolResults 收集每个子 Agent 第二次流看到的工具结果文本。 */
function editOnceProvider(toolName: string, toolArgs: Record<string, unknown>, toolResults: string[]): Provider {
  return {
    name: () => "mock",
    stream: async function* (_signal: AbortSignal, req: { messages: { role: string; content?: string }[] }) {
      const last = req.messages[req.messages.length - 1]
      if (last?.role === "tool") {
        toolResults.push(typeof last.content === "string" ? last.content : "")
        yield { type: ChunkType.Text, text: LONG_SUMMARY }
      } else {
        yield {
          type: ChunkType.ToolCall,
          tool_call: { id: "tc-1", name: toolName, arguments: JSON.stringify(toolArgs) },
        }
      }
      yield { type: ChunkType.Usage, usage: USAGE }
      yield { type: ChunkType.Done }
    },
  }
}

function longTextProvider(): Provider {
  return {
    name: () => "mock",
    stream: async function* () {
      yield { type: ChunkType.Text, text: LONG_SUMMARY }
      yield { type: ChunkType.Usage, usage: USAGE }
      yield { type: ChunkType.Done }
    },
  }
}

function shortTextProvider(): Provider {
  return {
    name: () => "mock",
    stream: async function* () {
      yield { type: ChunkType.Text, text: "嗯" }
      yield { type: ChunkType.Usage, usage: USAGE }
      yield { type: ChunkType.Done }
    },
  }
}

function makeParent(prov: Provider, exec: ToolExecutor): Agent {
  const registry = new ToolRegistry()
  for (const t of createCodingTools(exec)) registry.register(t)
  convergeRegistry(registry) // 与生产 agent-builder 一致：领域工具 + 隐藏旧名
  return new Agent(prov, registry, "test", { eventSink: () => {}, contextWindow: 0 })
}

// ═══════════════════════════════════════════════════════
// 4. R13 — fresh 子 Agent 经 fs(edit) 必须命中所有权包装
//    事故：fs 闭包绑父注册表，子 Agent 走领域工具绕过所有权，
//    两个 fresh 子 Agent 并发写同一文件 → 后写覆盖先写，双双假成功
// ═══════════════════════════════════════════════════════

describe("R13 所有权不被领域工具绕过", () => {
  it("两个 fresh 子 Agent 并发 fs(edit) 同一文件：先写者落盘，后写者收到 [已拒绝]", async () => {
    const editCalls: string[] = []
    const exec: ToolExecutor = async (name, args) => {
      if (name === "edit_file") {
        editCalls.push((args as { filePath: string }).filePath)
        await new Promise((r) => setTimeout(r, 10)) // 拉宽交错窗口
      }
      return "ok"
    }
    const toolResults: string[] = []
    const prov = editOnceProvider(
      "fs",
      { action: "edit", filePath: "D:/p/shared.ts", oldString: "a", newString: "b" },
      toolResults,
    )
    const parent = makeParent(prov, exec)

    const [r1, r2] = await Promise.all([
      parent.spawnSubAgent("task A", "p", undefined, "fresh", null, undefined, false, "sub-a"),
      parent.spawnSubAgent("task B", "p", undefined, "fresh", null, undefined, false, "sub-b"),
    ])

    expect(r1.err).toBeUndefined()
    expect(r2.err).toBeUndefined()
    // 核心断言：只有一个写真正到了执行层 — 另一个是显式拒绝而非静默覆盖
    expect(editCalls).toHaveLength(1)
    expect(toolResults.some((c) => c.includes("[已拒绝]"))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// 5. R2 — fork worktree 创建失败不得静默降级
// ═══════════════════════════════════════════════════════

describe("R2 worktree 创建失败显式告警", () => {
  it("agent_isolation_create 抛错 → spawn 结果带 [隔离降级] 告警", async () => {
    const exec: ToolExecutor = async (name) => {
      if (name === "agent_isolation_create") throw new Error("git worktree add 失败: no space left on device")
      return "ok"
    }
    const parent = makeParent(longTextProvider(), exec)

    const r = await parent.spawnSubAgent("task", "p", undefined, "fork", null, undefined, false, "sub-x")

    expect(r.err).toBeUndefined()
    expect(r.text).toContain("[隔离降级]")
    expect(r.text).toContain("no space left")
    // 降级态系统提示不得再声称「在独立 worktree 中」— 提示词谎言是事故的放大器
    // （间接验证：degradeNote 已置顶，说明 isolationId 为 null 走了降级分支）
  })
})

// ═══════════════════════════════════════════════════════
// 6. R7 — sync merge 据实报告（A1 事故：报告与事实对调）
// ═══════════════════════════════════════════════════════

describe("R7 _finalizeIsolation 据实报告", () => {
  function forkExec(mergeBehavior: "empty" | "ok" | "conflict") {
    const calls: string[] = []
    const exec: ToolExecutor = async (name) => {
      calls.push(name)
      if (name === "agent_isolation_merge") {
        if (mergeBehavior === "empty") return "没有变更需要合并"
        if (mergeBehavior === "ok") return "已合并变更 (commit: abc12345)"
        throw new Error("合并失败 (cherry-pick 已中止): CONFLICT in file.ts")
      }
      if (name === "agent_isolation_diff") return "diff-full-content-here"
      return "ok"
    }
    return { calls, exec }
  }

  it("merge 返回「没有变更需要合并」→ 报无产出，不得报 ✅", async () => {
    const { exec } = forkExec("empty")
    const parent = makeParent(longTextProvider(), exec)
    const r = await parent.spawnSubAgent("task", "p", undefined, "fork", null, undefined, false, "sub-e")

    expect(r.text).toContain("无产出")
    expect(r.text).not.toContain("✅")
  })

  it("merge 成功 → 据实转述 commit hash", async () => {
    const { exec } = forkExec("ok")
    const parent = makeParent(longTextProvider(), exec)
    const r = await parent.spawnSubAgent("task", "p", undefined, "fork", null, undefined, false, "sub-ok")

    expect(r.text).toContain("✅")
    expect(r.text).toContain("abc12345")
  })

  it("merge 冲突 → worktree 保留不丢 + diff 入报告 + 不 discard（R3）", async () => {
    const { calls, exec } = forkExec("conflict")
    const parent = makeParent(longTextProvider(), exec)
    const r = await parent.spawnSubAgent("task", "p", undefined, "fork", null, undefined, false, "sub-c")

    expect(r.text).toContain("自动合并失败")
    expect(r.text).toContain("worktree 已保留")
    expect(r.text).toContain("diff-full-content-here")
    // 冲突现场必须保留 — 旧实现 discard 后全量改动只剩 8KB 截断 diff
    expect(calls).not.toContain("agent_isolation_discard")
  })
})

// ═══════════════════════════════════════════════════════
// 7. R16 — 子 Agent 无产出报告必须显式标记（A2 事故）
// ═══════════════════════════════════════════════════════

describe("R16 空报告显式标记", () => {
  it("summary 提纯后仍 <50 字符 → 结果带 [报告缺失] 警告", async () => {
    const exec: ToolExecutor = async () => "ok"
    const parent = makeParent(shortTextProvider(), exec)
    const r = await parent.spawnSubAgent("task", "p", undefined, "fresh", null, undefined, false, "sub-s")

    expect(r.text).toContain("[报告缺失]")
  })
})

// ═══════════════════════════════════════════════════════
// 8. R9/R10/R3 — agent_merge 工具层口径与互斥
// ═══════════════════════════════════════════════════════

describe("agent_merge 据实口径与互斥", () => {
  function boardWith(entries: { agentId: string; isolationId: string | null; diff?: string }[]) {
    const board = new TaskBoard()
    for (const e of entries) {
      board.register({ agentId: e.agentId, parentAgentId: "main", description: `desc-${e.agentId}`, isolationId: e.isolationId })
      board.complete(e.agentId, "summary", e.diff ?? "saved-diff")
    }
    return board
  }

  it("R9: fresh 条目（无 worktree）不计入「已合并 N 个」", async () => {
    const board = boardWith([{ agentId: "sub-f", isolationId: null }])
    const exec: ToolExecutor = async () => "ok"
    const tool = createMergeTool(board, () => "main", exec, { projectPath: "P" })

    const result = await tool.execute({})

    expect(result).toContain("已合并 0 个子Agent")
    expect(result).toContain("无合并产物")
    expect(board.getEntry("sub-f")!.status).toBe("merged")
  })

  it("R7-async: merge 返回「没有变更需要合并」→ 无产出桶，不计已合并", async () => {
    const board = boardWith([{ agentId: "sub-1", isolationId: "agent-1" }])
    const exec: ToolExecutor = async (name) => (name === "agent_isolation_merge" ? "没有变更需要合并" : "ok")
    const tool = createMergeTool(board, () => "main", exec, { projectPath: "P" })

    const result = await tool.execute({})

    expect(result).toContain("已合并 0 个子Agent")
    expect(result).toContain("无产出")
  })

  it("merge 成功 → 报告附 merge 返回文本（commit hash）", async () => {
    const board = boardWith([{ agentId: "sub-1", isolationId: "agent-1" }])
    const exec: ToolExecutor = async (name) => (name === "agent_isolation_merge" ? "已合并变更 (commit: def98765)" : "ok")
    const tool = createMergeTool(board, () => "main", exec, { projectPath: "P" })

    const result = await tool.execute({})

    expect(result).toContain("已合并 1 个子Agent")
    expect(result).toContain("def98765")
  })

  it("R3: 冲突 → diff 重抓写回 board + worktree 保留（不 discard）", async () => {
    const board = boardWith([{ agentId: "sub-1", isolationId: "agent-1", diff: "short" }])
    const calls: string[] = []
    const exec: ToolExecutor = async (name) => {
      calls.push(name)
      if (name === "agent_isolation_merge") throw new Error("合并失败 (cherry-pick 已中止): CONFLICT")
      if (name === "agent_isolation_diff") return "x".repeat(5000) // 比 board 上的长 → 应写回
      return "ok"
    }
    const tool = createMergeTool(board, () => "main", exec, { projectPath: "P" })

    const result = await tool.execute({})

    expect(result).toContain("1 个冲突")
    expect(result).toContain("worktree 已保留")
    expect(board.getEntry("sub-1")!.diff).toHaveLength(5000)
    expect(calls).not.toContain("agent_isolation_discard")
    expect(calls).not.toContain("agent_isolation_force_purge")
  })

  it("R10: 同轮并发两次 agent_merge 串行 — 第二次据实报「没有待合并」", async () => {
    const board = boardWith([{ agentId: "sub-1", isolationId: "agent-1" }])
    const exec: ToolExecutor = async (name) => {
      if (name === "agent_isolation_merge") {
        await new Promise((r) => setTimeout(r, 20)) // 拉宽交错窗口
        return "已合并变更 (commit: aaaabbbb)"
      }
      return "ok"
    }
    const tool = createMergeTool(board, () => "main", exec, { projectPath: "P" })

    const [r1, r2] = await Promise.all([tool.execute({}), tool.execute({})])
    const results = [r1, r2]

    // 串行化后：一个真合并，另一个看到已更新的 board 据实报空 — 不得有假冲突
    // （旧病的假冲突文案是「没有活跃的隔离环境」；注意「0 个冲突。」是正常表头，不能当冲突断言）
    expect(results.some((r) => r.includes("已合并 1 个子Agent"))).toBe(true)
    expect(results.some((r) => r.includes("没有待合并"))).toBe(true)
    expect(results.some((r) => r.includes("没有活跃的隔离环境"))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// 9. R15 — 所有权键归一化
// ═══════════════════════════════════════════════════════

describe("R15 所有权键归一化", () => {
  it("反斜杠/正斜杠拼写同文件 → 视为同一键", () => {
    const o = new FileOwnership()
    expect(o.claim("D:\\p\\a.ts", "sub-a").ok).toBe(true)
    const r = o.claim("D:/p/a.ts", "sub-b")
    expect(r.ok).toBe(false)
    expect(o.ownerOf("D:/p//a.ts")).toBe("sub-a")
    // 同一 Agent 任意拼写重入均放行
    expect(o.claim("D:/p/a.ts", "sub-a").ok).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// 10. R4 — TTL 清理不得销毁无记录的工作成果
// ═══════════════════════════════════════════════════════

describe("R4 TTL 误杀防护", () => {
  function ttlFixture(diffOnBoard: string) {
    const pool = new SubAgentPool()
    const board = new TaskBoard()
    const bus = new MessageBus()
    bus.setTopology(new MeshTopology())
    bus.register({ agentId: "main", parentId: null, depth: 0 })
    board.register({ agentId: "sub-1", parentAgentId: "main", description: "task", isolationId: "agent-1" })
    board.complete("sub-1", "sum", diffOnBoard)
    // 回拨 finishedAt 超过 30 分钟 TTL
    board.getEntry("sub-1")!.finishedAt = Date.now() - 31 * 60 * 1000
    const notices: string[] = []
    const sink = (ev: { kind: unknown; level?: string; text?: string }) => notices.push(ev.text ?? "")
    return { pool, board, bus, notices, sink }
  }

  it("diff 可保全 → 清理 + 通知父 Agent 模型上下文", async () => {
    const { pool, board, bus, sink } = ttlFixture("old-diff")
    const calls: string[] = []
    const exec: ToolExecutor = async (name) => {
      calls.push(name)
      if (name === "agent_isolation_diff") return "fresher-longer-diff-content"
      return "ok"
    }
    const mgr = new AgentLifecycleManager(pool, board, bus, exec, sink as never)
    ;(mgr as unknown as { _enforceTTL(): void })._enforceTTL()
    await enqueueIsolationOp(async () => {}) // 等队列排空

    expect(calls).toContain("agent_isolation_discard")
    expect(board.getEntry("sub-1")!.status).toBe("stopped")
    expect(board.getEntry("sub-1")!.diff).toBe("fresher-longer-diff-content")
    // 模型上下文可见（不只 UI）
    const inbox = bus.peekInbox("main")
    expect(inbox.some((m) => m.type === "notification")).toBe(true)
  })

  it("diff 提取不到且 board 无记录 → 保留现场不清理", async () => {
    const { pool, board, bus, sink, notices } = ttlFixture("")
    const calls: string[] = []
    const exec: ToolExecutor = async (name) => {
      calls.push(name)
      return "" // diff 为空
    }
    const mgr = new AgentLifecycleManager(pool, board, bus, exec, sink as never)
    ;(mgr as unknown as { _enforceTTL(): void })._enforceTTL()
    await enqueueIsolationOp(async () => {})

    expect(calls).not.toContain("agent_isolation_discard")
    expect(board.getEntry("sub-1")!.status).toBe("completed")
    expect(notices.some((t) => t.includes("已保留现场不清理"))).toBe(true)
  })
})
