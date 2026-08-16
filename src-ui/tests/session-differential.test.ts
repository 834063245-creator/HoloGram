// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Phase 5 T2 核心差分（验证计划 §4 Phase 5 — 本 phase 的生命线）。
//
// 旧消息数组路径（this.session + payloadMessages，生产行为）vs 新日志投影路径
// （sessionLog.deriveMessages / derivePayload）在同一 run 序列下逐步对拍：
//   1. 每一步的 provider 请求消息（录制型 Provider 在请求时刻同时快照日志投影）；
//   2. compaction 边界（session/compaction 事件的 tailStart 镜像 Agent 折叠状态）；
//   3. retract / setSession / newSession / insertMessage 安全边界后的投影。
//
// 折叠层覆盖（交接文档 §6）：压缩折叠、工具结果批量折叠（window>0 方法级差分）、
// 临时提醒（本夹具 Agent 无 plan/bus/preRunHook — transients 恒空，请求 = 载荷）、
// retract 后折叠状态保留 + tailStart 钳制。
//
// 边界镜像说明：_toolFoldBoundary 是 payloadMessages 调用序列的累积态（不在事件流内）。
// derivePayload 接收调用前边界并在内部执行同样的 nextFoldBoundary 推进 —— 与旧路径
// 单次调用从同一起点做同一推进，任何状态下都逐字节相等。请求级对拍在 window=0
// （生产默认，边界恒 0）下进行，window>0 只做方法级差分。

import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../src/provider/types';

const appendCalls: Array<{ agentId: string; messages: Message[]; rewrite: boolean }> = [];
const logAppends: Array<{ path: string; content: string }> = [];

const mockInvoke = vi.fn(async (_cmd: string, payload: { method: string; params: Record<string, unknown> }) => {
  const { method, params: p } = payload;
  switch (method) {
    case 'create_directory':
    case 'write_file_content':
      return '{}';
    case 'agent_session_append': {
      appendCalls.push({
        agentId: p.agent_id as string,
        messages: p.messages as unknown as Message[],
        rewrite: !!p.rewrite,
      });
      return '{}';
    }
    case 'log_append': {
      logAppends.push({ path: p.path as string, content: p.content as string });
      return '{}';
    }
    default:
      // drain_bg_notifications / credential_get 等 — 保持"未模拟即失败"的真实形状，
      // 调用方（runLoop/压缩模型选择）自带静默降级
      throw new Error(`unexpected rpc: ${method}`);
  }
});

vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) =>
    mockInvoke(...(args as [string, { method: string; params: Record<string, unknown> }])),
  rpc: (method: string, params?: Record<string, unknown>) => {
    const normalized: Record<string, unknown> = {};
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        normalized[key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] = value;
      }
    }
    return mockInvoke('rpc', { method, params: normalized });
  },
  listen: vi.fn(),
  isMockMode: () => false,
}));

// 钉死摘要模型选择（compactNow 场景）：无 key、无候选 → 回退主 mock provider
// （模式同 compaction-pipeline.test.ts；目录恒空 → selectSummaryProvider 无候选）
vi.mock('../src/provider/catalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getAllModels: () => [] };
});

import { Agent } from '../src/agent/agent';
import { AgentStore } from '../src/agent/agent-store';
import { SessionLog } from '../src/agent/session-log';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';

// ── 录制型脚本 Provider：每次调用记录请求消息，并在请求时刻快照日志投影 ──

interface RecordedRequest {
  /** 请求消息（深拷贝 — 不受后续会话变更影响）。 */
  request: Message[];
  /** 请求时刻的日志派生载荷（深拷贝；请求 = 载荷 + 临时提醒后缀，本夹具恒无提醒）。 */
  derivedPayload: Message[];
}

function makeHarness(scripts: Chunk[][], opts?: { toolResultWindow?: number }) {
  const requests: RecordedRequest[] = [];
  let agentBox: Agent | null = null;
  let callIdx = 0;
  const prov: Provider = {
    name: () => 'mock',
    async *stream(_signal: AbortSignal, req: { messages: Message[] }) {
      const log = agentBox?.getSessionLog();
      const internals = agentBox as unknown as { _toolResultWindow: number; _toolFoldBoundary: number } | null;
      requests.push({
        request: JSON.parse(JSON.stringify(req.messages)) as Message[],
        derivedPayload: log
          ? (JSON.parse(
              JSON.stringify(
                log.derivePayload({
                  toolResultWindow: internals?._toolResultWindow ?? 0,
                  toolFoldBoundary: internals?._toolFoldBoundary ?? 0,
                }),
              ),
            ) as Message[])
          : [],
      });
      const script = scripts[Math.min(callIdx++, scripts.length - 1)];
      for (const c of script) yield c;
    },
  };
  const tools = new ToolRegistry();
  const echo: Tool = {
    name: () => 'echo_tool',
    description: () => 'echo fixture',
    parameters: () => ({ type: 'object', properties: { v: { type: 'string' } }, required: ['v'] }),
    readOnly: () => true,
    execute: async (args) => `ok:${String((args as { v?: unknown }).v ?? '')}`,
  };
  tools.register(echo);
  const agent = new Agent(prov, tools, 'sys-fixture', {
    agentId: 'diff-agent',
    contextWindow: 10_000_000, // 差分基线：不触发自动压缩（压缩走显式 compactNow）
    toolResultWindow: opts?.toolResultWindow ?? 0,
  });
  agentBox = agent;
  return { agent, requests };
}

// ── chunk 构造 ──

const text = (t: string): Chunk => ({ type: ChunkType.Text, text: t });
const toolCall = (id: string, v: string): Chunk => ({
  type: ChunkType.ToolCall,
  tool_call: { id, name: 'echo_tool', arguments: JSON.stringify({ v }) },
});
const done: Chunk = { type: ChunkType.Done };

/** Agent 私有折叠状态的测试视图。 */
function internals(agent: Agent): {
  payloadMessages(): Message[];
  _toolResultWindow: number;
  _toolFoldBoundary: number;
  _compactSummary: string | null;
  _compactTailStart: number;
} {
  return agent as unknown as ReturnType<typeof internals>;
}

/** 全量投影断言：deriveMessages ≡ session；derivePayload（镜像边界前值）≡ payloadMessages。 */
function expectProjectionEquivalence(agent: Agent): void {
  const log = agent.getSessionLog();
  const a = internals(agent);
  expect(JSON.stringify(log.deriveMessages())).toBe(JSON.stringify(agent.getSession()));
  // 先取调用前边界：derivePayload 内部执行与旧路径同起的单次推进，任何状态逐字节相等
  const boundaryBefore = a._toolFoldBoundary;
  const oldPayload = a.payloadMessages();
  const newPayload = log.derivePayload({
    toolResultWindow: a._toolResultWindow,
    toolFoldBoundary: boundaryBefore,
  });
  expect(JSON.stringify(newPayload)).toBe(JSON.stringify(oldPayload));
}

/** 回放等价断言：snapshot → replay 重建后投影逐字节一致。 */
function expectReplayEquivalence(agent: Agent): void {
  const log = agent.getSessionLog();
  const rebuilt = SessionLog.replay(log.snapshot());
  const a = internals(agent);
  expect(JSON.stringify(rebuilt.deriveMessages())).toBe(JSON.stringify(log.deriveMessages()));
  const fold = { toolResultWindow: a._toolResultWindow, toolFoldBoundary: a._toolFoldBoundary } as const;
  expect(JSON.stringify(rebuilt.derivePayload(fold))).toBe(JSON.stringify(log.derivePayload(fold)));
}

/** 取必有值 — 断言失败时给出可读定位（替代非空断言）。 */
function def<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`缺失: ${what}`);
  return v;
}

/** 请求级对拍：第 i 次 provider 调用的请求 ≡ 同时刻的日志派生载荷（字节级）。 */
function expectRequestMatchesDerived(requests: RecordedRequest[], i: number): void {
  const r = def(requests[i], `第 ${i} 次请求`);
  expect(JSON.stringify(r.request), `第 ${i} 次请求与日志派生载荷不一致`).toBe(JSON.stringify(r.derivedPayload));
}

const SIG = new AbortController().signal;

describe('T2 差分 — 基础对话与工具循环', () => {
  it('纯文本轮：每步投影等价 + 请求对拍 + 事件形状', async () => {
    const { agent, requests } = makeHarness([
      [text('收到'), done],
      [text('好的'), done],
    ]);
    await agent.run(SIG, '你好');
    expectProjectionEquivalence(agent);
    await agent.run(SIG, '第二句');
    expectProjectionEquivalence(agent);
    expectRequestMatchesDerived(requests, 0);
    expectRequestMatchesDerived(requests, 1);
    // 事件形状：reset(init) → run() 先落 user/message，runLoop 再发 turn/start
    const kinds = agent
      .getSessionLog()
      .events()
      .map((e) => e.kind);
    expect(kinds).toEqual([
      'session/reset',
      'user/message',
      'turn/start',
      'assistant/text',
      'user/message',
      'turn/start',
      'assistant/text',
    ]);
    expectReplayEquivalence(agent);
  });

  it('工具循环：assistant(tool_calls) → tool/call 审计 → tool/result 投影', async () => {
    const { agent, requests } = makeHarness([
      [toolCall('c1', '1'), done],
      [text('完成'), done],
    ]);
    await agent.run(SIG, '查一下');
    expectProjectionEquivalence(agent);
    expectRequestMatchesDerived(requests, 0); // 首请求：[sys, user]
    expectRequestMatchesDerived(requests, 1); // 次请求：[sys, user, assistant+calls, tool]
    const session = agent.getSession();
    expect(session.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    const toolMsg = def(session[3], 'session[3]');
    expect(toolMsg.tool_call_id).toBe('c1');
    expect(toolMsg.name).toBe('echo_tool');
    expect(toolMsg.content).toBe('ok:1');
    const kinds = agent
      .getSessionLog()
      .events()
      .map((e) => e.kind);
    expect(kinds).toEqual([
      'session/reset',
      'user/message',
      'turn/start',
      'assistant/text',
      'tool/call',
      'tool/result',
      'assistant/text',
    ]);
    expectReplayEquivalence(agent);
  });

  it('多工具批：单 assistant 轮两个调用 → 两条 tool/result', async () => {
    const { agent } = makeHarness([
      [toolCall('c1', 'a'), toolCall('c2', 'b'), done],
      [text('批完成'), done],
    ]);
    await agent.run(SIG, '并行查');
    expectProjectionEquivalence(agent);
    expect(agent.getSession().map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'assistant']);
    const toolCallEvents = agent
      .getSessionLog()
      .events()
      .filter((e) => e.kind === 'tool/call');
    expect(toolCallEvents.map((e) => (e.data as { call: { id: string } }).call.id)).toEqual(['c1', 'c2']);
    expectReplayEquivalence(agent);
  });

  it('insertMessage 安全边界：排队消息在下一轮以 user/message 事件落地', async () => {
    const { agent } = makeHarness([
      [text('第一轮'), done],
      [text('第二轮'), done],
    ]);
    await agent.run(SIG, '第一句');
    agent.insertMessage('插队消息', { silent: true });
    await agent.run(SIG, '第二句');
    expectProjectionEquivalence(agent);
    // 安全边界语义：run() 先落本轮 user 输入，插队消息在 runLoop 顶部
    // （_applyPendingInserts）落地 —— 顺序为 触发消息在前、插队在后
    expect(
      agent
        .getSession()
        .filter((m) => m.role === 'user')
        .map((m) => m.content),
    ).toEqual(['第一句', '第二句', '插队消息']);
    expectReplayEquivalence(agent);
  });
});

describe('T2 差分 — retract 与会话替换', () => {
  it('retractTurnAt：投影裁剪一致 + 请求对拍 + 后续轮正常', async () => {
    const { agent, requests } = makeHarness([
      [text('第一轮回答'), done],
      [text('第二轮回答'), done],
      [text('第三轮回答'), done],
    ]);
    await agent.run(SIG, '第一句');
    await agent.run(SIG, '第二句');
    expectProjectionEquivalence(agent);
    // 撤回第二轮：其 user 消息在 index 3（sys, user, assistant | user, assistant）
    agent.retractTurnAt(3);
    expectProjectionEquivalence(agent);
    expect(agent.getSession().map((m) => m.content)).toEqual(['sys-fixture', '第一句', '第一轮回答']);
    await agent.run(SIG, '第三句');
    expectProjectionEquivalence(agent);
    expectRequestMatchesDerived(requests, 2); // 撤回后的请求不含被裁剪轮
    expect(def(requests[2], 'requests[2]').request.map((m) => m.content)).toEqual([
      'sys-fixture',
      '第一句',
      '第一轮回答',
      '第三句',
    ]);
    expectReplayEquivalence(agent);
  });

  it('setSession（恢复）：投影替换 + 折叠状态失效 + 后续请求对拍', async () => {
    const { agent, requests } = makeHarness([
      [text('回答'), done],
      [text('续答'), done],
    ]);
    await agent.run(SIG, '旧消息');
    agent.setSession([
      { role: 'system', content: 'sys-fixture' },
      { role: 'user', content: '恢复的消息' },
      { role: 'assistant', content: '恢复的回答' },
    ]);
    expectProjectionEquivalence(agent);
    expect(internals(agent)._compactSummary).toBeNull(); // 折叠失效语义保留
    await agent.run(SIG, '继续');
    expectProjectionEquivalence(agent);
    expectRequestMatchesDerived(requests, 1);
    expectReplayEquivalence(agent);
  });

  it('newSession：投影回到 [sys]，事件流记录 reset', async () => {
    const { agent } = makeHarness([[text('回答'), done]]);
    await agent.run(SIG, '会丢掉的消息');
    agent.newSession();
    expectProjectionEquivalence(agent);
    expect(agent.getSession().map((m) => m.content)).toEqual(['sys-fixture']);
    const resets = agent
      .getSessionLog()
      .events()
      .filter((e) => e.kind === 'session/reset');
    expect(resets.map((e) => (e.data as { reason: string }).reason)).toEqual(['init', 'new-session']);
    expectReplayEquivalence(agent);
  });
});

describe('T2 差分 — compaction 边界', () => {
  it('compactNow：压缩事件镜像折叠状态，载荷 head+summary+tail 等价，后续请求对拍', async () => {
    const { agent, requests } = makeHarness([
      [text('第一轮回答'), done],
      [text('第二轮回答'), done],
      [text('第三轮回答'), done],
      // index 3 = compactNow 的 callSummaryLLM（2 消息摘要调用，不参与主循环对拍）
      [text('压缩摘要文本'), done],
      [text('压缩后的回答'), done], // index 4 = 压缩后主循环
    ]);
    await agent.run(SIG, '第一句长消息');
    await agent.run(SIG, '第二句长消息');
    await agent.run(SIG, '第三句长消息');
    expectProjectionEquivalence(agent);
    const summary = await agent.compactNow(SIG);
    expect(summary).not.toBe('stuck');
    expectProjectionEquivalence(agent);
    const a = internals(agent);
    expect(a._compactSummary).toBe('压缩摘要文本');
    const compactEvents = agent
      .getSessionLog()
      .events()
      .filter((e) => e.kind === 'session/compaction');
    expect(compactEvents).toHaveLength(1);
    const compactData = def(compactEvents[0], 'compactEvents[0]').data as { summary: string; tailStart: number };
    expect(compactData.summary).toBe('压缩摘要文本');
    expect(compactData.tailStart).toBe(a._compactTailStart); // 边界镜像
    // 压缩后下一轮：请求 = head + <compacted-context> + tail + 新 user —— 与日志派生载荷一致
    await agent.run(SIG, '压缩后继续');
    expectProjectionEquivalence(agent);
    expectRequestMatchesDerived(requests, 4);
    const req = def(requests[4], 'requests[4]').request;
    const compactedMsg = def(req[1], 'req[1]');
    expect(compactedMsg.content).toContain('<compacted-context>');
    expect(compactedMsg.content).toContain('压缩摘要文本');
    expect(def(req.at(-1), 'req.at(-1)').content).toBe('压缩后继续');
    expectReplayEquivalence(agent);
  });

  it('retract 后压缩折叠保留 + tailStart 越界钳制（投影与旧路径一致）', async () => {
    const { agent } = makeHarness([
      [text('第一轮回答'), done],
      [text('第二轮回答'), done],
      [text('第三轮回答'), done],
      [text('压缩摘要文本'), done],
    ]);
    await agent.run(SIG, '第一句');
    await agent.run(SIG, '第二句');
    await agent.run(SIG, '第三句'); // 7 条消息 — 保证有可折叠区域（tailCount=4）
    const summary = await agent.compactNow(SIG);
    expect(summary).not.toBe('stuck');
    expectProjectionEquivalence(agent);
    const tailBefore = internals(agent)._compactTailStart;
    expect(tailBefore).toBeGreaterThan(0);
    // 撤回压掉 tail 一部分 — Agent 不清折叠状态，靠 payloadMessages 的钳制兜底；
    // 投影侧同样钳制（session/retract 不清 compaction — 与 retractTurnAt 语义一致）
    agent.retractTurnAt(agent.getSession().length - 2);
    expectProjectionEquivalence(agent);
    expect(internals(agent)._compactSummary).toBe('压缩摘要文本'); // Agent 侧确实未清
    expectReplayEquivalence(agent);
  });
});

describe('T2 差分 — 工具结果批量折叠（window>0）', () => {
  it('折叠层方法级差分：镜像边界下单次推进与旧路径逐字节相等', async () => {
    // window=2：单轮 4 个并行工具调用 → 4 条 tool 结果，跨过 2×batch 阈值边界推进到 2
    const { agent } = makeHarness(
      [
        [toolCall('c1', '1'), toolCall('c2', '2'), toolCall('c3', '3'), toolCall('c4', '4'), done],
        [text('收尾'), done],
      ],
      { toolResultWindow: 2 },
    );
    await agent.run(SIG, '多轮工具');
    expectProjectionEquivalence(agent);
    expect(internals(agent)._toolFoldBoundary).toBeGreaterThan(0); // 确认折叠确已发生
    expectReplayEquivalence(agent);
  });
});

describe('T2 差分 — 持久化双写（P1-15 游标不受破坏）', () => {
  it('saveState 增量追加事件到 session-log.ndjson，消息游标语义不变', async () => {
    appendCalls.length = 0;
    logAppends.length = 0;
    const store = new AgentStore('/p');
    const { agent } = makeHarness([
      [text('回答'), done],
      [text('再答'), done],
    ]);
    agent.setAgentStore(store);
    await agent.run(SIG, '你好');
    await agent.saveState('running');
    await agent.run(SIG, '第二句');
    await agent.saveState('done');

    // P1-15 消息游标不受破坏：两轮各一次增量 append，无 rewrite
    expect(appendCalls).toHaveLength(2);
    expect(def(appendCalls[0], 'appendCalls[0]').messages.map((m) => m.content)).toEqual([
      'sys-fixture',
      '你好',
      '回答',
    ]);
    expect(def(appendCalls[1], 'appendCalls[1]').messages.map((m) => m.content)).toEqual(['第二句', '再答']);
    expect(appendCalls.every((c) => !c.rewrite)).toBe(true);
    // 事件日志双写：全部经 log_append 追加到 session-log.ndjson
    const logFile = logAppends.filter((l) => l.path === '/p/.hologram/agents/diff-agent/session-log.ndjson');
    const lines = logFile.flatMap((l) => l.content.split('\n').filter((s) => s.trim().length > 0));
    const events = lines.map((l) => JSON.parse(l) as { seq: number; kind: string });
    expect(events.map((e) => e.kind)).toEqual([
      'session/reset',
      'user/message',
      'turn/start',
      'assistant/text',
      'user/message',
      'turn/start',
      'assistant/text',
    ]);
    // 落盘事件重放可重建投影（seq 严格递增由 appendEvent 保证）
    const replayed = SessionLog.replay(events.map((e) => e as Parameters<typeof SessionLog.replay>[0][number]));
    expect(JSON.stringify(replayed.deriveMessages())).toBe(JSON.stringify(agent.getSession()));
  });
});
