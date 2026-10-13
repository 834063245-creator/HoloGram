// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 发现提醒钩子钉住（agent-hooks-plan 二期 §7.3 收编——对拍 git 史旧实现
// `Agent._injectDiscoveries`，内容与判据逐条对齐）：
//   ① 判据三件套：非己（e.agentId !== agentId）+ 未见（去重集）+ 5 分钟窗；
//   ② 注入内容逐字对拍（<system-reminder>🔬 共享发现 …</system-reminder>）；
//   ③ loop 集成：runtime 装配路径的 Agent 每步收到发现注入（transient——进请求、
//      不落会话）；空板 / 全己方 / 已注入过 ⇒ 不注入（enter 直通）。
//
// 顺序位移（显式记录）：注入落点由「注入链中段」（injectInbox 之后立即）移到
// 「链尾」（步骤钩子注入的统一点、压缩预检之前）——内容与判据不变。

import { describe, expect, it } from 'vitest';
import { installCompactionForTest } from './helpers/compaction-impl';

installCompactionForTest();

import { DiscoveryBoard } from '../src/agent/discovery-board';
import { createDiscoveryReminderHook } from '../src/agent/discovery-reminder-hook';
import type { PreStepPayload } from '../src/agent/steps';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider, Request } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';

function payload(step = 0): PreStepPayload {
  return { agentId: 'me', step, signal: new AbortController().signal };
}

const FIVE_MIN_MS = 5 * 60 * 1000;

describe('createDiscoveryReminderHook — 判据与内容（对拍旧实现）', () => {
  it('空板 ⇒ enter 直通（无 reminders）', async () => {
    const board = new DiscoveryBoard();
    const hook = createDiscoveryReminderHook({ agentId: 'me', board });
    expect(await hook.decide(payload())).toEqual({ action: 'enter' });
  });

  it('非己 + 未见 + 5 分钟内 ⇒ 注入一条；内容逐字对拍旧实现', async () => {
    const board = new DiscoveryBoard();
    const hook = createDiscoveryReminderHook({ agentId: 'me', board });
    board.post('other', 'k1', 'v1', 'fact');
    expect(await hook.decide(payload())).toEqual({
      action: 'enter',
      reminders: [
        {
          content:
            '<system-reminder>\n🔬 共享发现 (1 条):\n[fact] k1: v1 (by other)\n\n用 agent_discover 发布你的发现，agent_lookup 查询全部。\n</system-reminder>',
        },
      ],
    });
  });

  it('去重：同一发现只注入一次（首次注入后第二次 enter 直通）', async () => {
    const board = new DiscoveryBoard();
    const hook = createDiscoveryReminderHook({ agentId: 'me', board });
    board.post('other', 'k1', 'v1', 'fact');
    expect(await hook.decide(payload())).toHaveProperty('reminders');
    expect(await hook.decide(payload())).toEqual({ action: 'enter' });
  });

  it('判据过滤：自己发的 / 超过 5 分钟的一律不注入', async () => {
    const board = new DiscoveryBoard();
    const hook = createDiscoveryReminderHook({ agentId: 'me', board });
    board.post('me', 'self', 'v-self', 'fact'); // 自己发的
    board.post('other-old', 'old', 'v-old', 'fact'); // 超 5 分钟
    // Board 内部条目是 query 结果的同一对象引用——直接改 ts 模拟过期（旧行为同款窗口判据）
    for (const e of board.query()) {
      if (e.key === 'old') e.ts = Date.now() - (FIVE_MIN_MS + 1000);
    }
    expect(await hook.decide(payload())).toEqual({ action: 'enter' });

    // 只有非己 + 窗内的才注入
    board.post('other-new', 'new', 'v-new', 'note');
    const decision = await hook.decide(payload());
    expect(decision).toEqual({
      action: 'enter',
      reminders: [
        {
          content:
            '<system-reminder>\n🔬 共享发现 (1 条):\n[note] new: v-new (by other-new)\n\n用 agent_discover 发布你的发现，agent_lookup 查询全部。\n</system-reminder>',
        },
      ],
    });
  });

  it('多条同批注入（按板面顺序，逐行拼接）', async () => {
    const board = new DiscoveryBoard();
    const hook = createDiscoveryReminderHook({ agentId: 'me', board });
    board.post('a1', 'k1', 'v1', 'cat');
    board.post('a2', 'k2', 'v2', 'cat');
    const decision = await hook.decide(payload());
    if (decision.action !== 'enter' || !decision.reminders) throw new Error('期望带 reminders 的 enter');
    expect(decision.reminders[0].content).toContain('🔬 共享发现 (2 条):');
    expect(decision.reminders[0].content).toContain('[cat] k1: v1 (by a1)');
    expect(decision.reminders[0].content).toContain('[cat] k2: v2 (by a2)');
  });
});

/** 记录每次请求的消息投影（`request.messages`）——观测模型可见面。 */
function recordingProvider(): { prov: Provider; requests: Array<Array<{ role: string; content: string }>> } {
  const requests: Array<Array<{ role: string; content: string }>> = [];
  const prov: Provider = {
    name: () => 'mock-provider',
    model: () => 'mock-model',
    stream: async function* (_signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      requests.push(
        req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      );
      yield { type: ChunkType.Text, text: 'ok' } as Chunk;
      yield { type: ChunkType.Done } as Chunk;
    },
  };
  return { prov, requests };
}

describe('发现注入 — runtime 装配路径（收编后的 loop 集成）', () => {
  it('板上有他人发现 ⇒ 进请求（transient）、不落会话；空板 ⇒ 请求里没有发现提醒', async () => {
    const { prov, requests } = recordingProvider();
    const { AgentRuntime } = await import('../src/agent/runtime/runtime');
    const runtime = new AgentRuntime();
    const handle = await runtime.createAgent({
      agentId: 'main-disc',
      parentId: null,
      projectPath: 'D:/wsDisc',
      provider: prov,
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
      eventSink: () => {},
      contextWindow: 0,
    });
    const agent = (
      handle as unknown as {
        _getAgent(): {
          _discoveryBoard: DiscoveryBoard | null;
          run(signal: AbortSignal, input: string): Promise<void>;
          getSession(): Array<{ role: string; content?: unknown }>;
        };
      }
    )._getAgent();

    // 空板：第一步请求无发现提醒（收编后内建钩子照跑——空板 = enter 直通）
    await agent.run(new AbortController().signal, 'hi');
    expect(requests[0].some((m) => m.content.includes('🔬 共享发现'))).toBe(false);

    // 他人发布 → 第二步请求可见（transient；不进会话）
    const board = agent._discoveryBoard;
    expect(board).not.toBeNull();
    board?.post('sub-other', 'finding-1', 'value-1', 'fact');
    await agent.run(new AbortController().signal, '再来一次');
    expect(requests[1].some((m) => m.content.includes('🔬 共享发现 (1 条)'))).toBe(true);
    expect(requests[1].some((m) => m.content.includes('[fact] finding-1: value-1 (by sub-other)'))).toBe(true);
    // transient——不落会话
    expect(agent.getSession().some((m) => String(m.content).includes('🔬 共享发现'))).toBe(false);
  }, 20_000);
});
