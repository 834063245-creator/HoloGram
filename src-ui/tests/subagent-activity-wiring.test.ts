// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// spawnSubAgent → wrapSubAgentSink 端到端接线测试。
// 回归目标：agent.ts 中 `subSink = wrapSubAgentSink(subAgentId, rawSubSink)`
// 一旦被删（tee 断开），子Agent 的事件不再进入活动追踪器，agent_status 变成
// 盲的 —— 本测试驱动真实 spawnSubAgent（fresh 模式、headless sink），在子Agent
// 工具执行期间断言 getSubAgentActivity 反映了 dispatch。

import { describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { Agent } from '../src/agent/agent';
import { getSubAgentActivity } from '../src/agent/subagent-activity';
import { type Tool, ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider, Usage } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';

const USAGE: Usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  cache_hit_tokens: 0,
  cache_miss_tokens: 10,
  reasoning_tokens: 0,
  cache_creation_tokens: 0,
  finish_reason: 'stop',
};

// ≥300 字符，跳过 spawnSubAgent 的摘要扩写续轮
const FINAL_REPORT = '子任务完成。'.repeat(60);

/** 第一轮流返回一个 stub_tool 调用，之后每轮返回最终报告文本。 */
function makeProvider(): Provider {
  let streams = 0;
  return {
    name: () => 'mock',
    stream: () => {
      streams++;
      const n = streams;
      return (async function* (): AsyncGenerator<Chunk> {
        if (n === 1) {
          yield { type: ChunkType.ToolCall, tool_call: { id: 'c1', name: 'stub_tool', arguments: '{}' } };
        } else {
          yield { type: ChunkType.Text, text: FINAL_REPORT };
        }
        yield { type: ChunkType.Usage, usage: USAGE };
        yield { type: ChunkType.Done };
      })();
    },
  };
}

describe('spawnSubAgent — wrapSubAgentSink 接线（tee 端到端）', () => {
  it('子Agent 工具执行期间，活动追踪器可见当前工具；结束后清理', async () => {
    let entered!: () => void;
    let release!: () => void;
    const toolEntered = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));

    const stubTool: Tool = {
      name: () => 'stub_tool',
      description: () => 'blocks until released',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      execute: async () => {
        entered();
        await gate;
        return 'stub output';
      },
    };
    const registry = new ToolRegistry();
    registry.register(stubTool);

    const parent = new Agent(makeProvider(), registry, 'test system prompt', {
      eventSink: () => {},
      contextWindow: 0, // no compaction interference
    });

    // fresh 模式 — 不建 worktree；headless（无 ui port）→ rawSubSink 为 noop，
    // 追踪器数据只能来自 wrapSubAgentSink 的 tee。
    const spawnPromise = parent.spawnSubAgent(
      'tee 接线测试',
      'do it',
      undefined,
      'fresh',
      null,
      undefined,
      false,
      'sub-tee-1',
    );

    // 工具开始执行 — 此时 ToolDispatch 必须已经过 tee 进入追踪器
    await toolEntered;
    const act = getSubAgentActivity('sub-tee-1');
    expect(act?.currentTool).toBe('stub_tool');
    expect(typeof act?.toolStartedAt).toBe('number');

    // 放行 → ToolResult 过 tee 清除 currentTool → 子Agent 完成 → finally 清理
    release();
    const result = await spawnPromise;
    expect(result.err).toBeUndefined();
    expect(result.text).toContain('子任务完成');
    expect(getSubAgentActivity('sub-tee-1')).toBeUndefined();
  });
});
