// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent_spawn synchronous semantics — the sub-agent's report IS the tool result.
// Regressions covered: dropped tool_allowlist, undefined pool signal.

import { describe, expect, it } from 'vitest';
import { SubAgentPool } from '../src/agent/coordinator';
import { createSubAgentTool, type SubAgentSpawner } from '../src/agent/tools/subagent';

function makeSpawner(result: { text: string; err?: string }, delayMs = 5): SubAgentSpawner {
  return async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return result;
  };
}

describe('agent_spawn — synchronous result flow', () => {
  it('blocks until the sub-agent finishes and returns its report as the tool result', async () => {
    const pool = new SubAgentPool();
    const tool = createSubAgentTool(makeSpawner({ text: 'REPORT: all done' }), pool);
    const out = await tool.execute({ description: 't', prompt: 'do it' });
    expect(out).toBe('REPORT: all done');
    expect(pool.runningCount).toBe(0);
  });

  it('returns error text when the sub-agent fails', async () => {
    const pool = new SubAgentPool();
    const tool = createSubAgentTool(makeSpawner({ text: '', err: 'boom' }), pool);
    const out = await tool.execute({ description: 't', prompt: 'do it' });
    expect(out).toContain('失败');
    expect(out).toContain('boom');
  });

  it('reports queued when the pool is at maxConcurrent (async mode)', async () => {
    const pool = new SubAgentPool(1);
    pool.spawn('blocker', () => new Promise<{ text: string }>(() => {}));
    const tool = createSubAgentTool(makeSpawner({ text: 'x' }), pool);
    // Async mode — returns immediately with "queued" instead of "busy"
    const out = await tool.execute({ description: 't', prompt: 'p', async: true });
    expect(out).toContain('已排队');
    pool.stopAll();
  });

  it('requires a prompt', async () => {
    const pool = new SubAgentPool();
    const tool = createSubAgentTool(makeSpawner({ text: 'x' }), pool);
    // zod 契约: prompt 是 required 字段 — 缺失时 defineTool 校验抛错（替代旧的字符串兜底）
    await expect(tool.execute({ description: 't' })).rejects.toThrow(/参数校验失败/);
  });

  it('passes tool_allowlist and mode through to the spawner (dropped-allowlist regression)', async () => {
    const pool = new SubAgentPool();
    let gotAllowlist: string[] | null | undefined;
    let gotMode: string | undefined;
    const spawner: SubAgentSpawner = async (_d, _p, _o, mode, allowlist) => {
      gotMode = mode;
      gotAllowlist = allowlist;
      return { text: 'ok' };
    };
    const tool = createSubAgentTool(spawner, pool);
    await tool.execute({
      description: 't',
      prompt: 'p',
      subagent_type: 'fresh',
      tool_allowlist: ['read_file', 'search_content'],
    });
    expect(gotMode).toBe('fresh');
    expect(gotAllowlist).toEqual(['read_file', 'search_content']);
  });

  it('defaults to fork mode when subagent_type is omitted', async () => {
    const pool = new SubAgentPool();
    let gotMode: string | undefined;
    const spawner: SubAgentSpawner = async (_d, _p, _o, mode) => {
      gotMode = mode;
      return { text: 'ok' };
    };
    const tool = createSubAgentTool(spawner, pool);
    await tool.execute({ description: 't', prompt: 'p' });
    expect(gotMode).toBe('fork');
  });

  it('pool abort signal reaches the spawner', async () => {
    const pool = new SubAgentPool();
    let gotSignal: AbortSignal | undefined;
    const spawner: SubAgentSpawner = async (_d, _p, _o, _m, _a, signal) => {
      gotSignal = signal;
      return { text: 'ok' };
    };
    const tool = createSubAgentTool(spawner, pool);
    await tool.execute({ description: 't', prompt: 'p' });
    expect(gotSignal).toBeInstanceOf(AbortSignal);
  });

  it('parallel spawns in one turn resolve independently', async () => {
    const pool = new SubAgentPool();
    const tool = createSubAgentTool(async (description) => {
      await new Promise((r) => setTimeout(r, description === 'slow' ? 40 : 5));
      return { text: `done:${description}` };
    }, pool);
    const [fast, slow] = await Promise.all([
      tool.execute({ description: 'fast', prompt: 'p' }),
      tool.execute({ description: 'slow', prompt: 'p' }),
    ]);
    expect(fast).toBe('done:fast');
    expect(slow).toBe('done:slow');
  });

  it('timeout_minutes is applied and clamped', async () => {
    const pool = new SubAgentPool();
    const tool = createSubAgentTool(
      () => new Promise<{ text: string }>(() => {}), // never finishes
      pool,
    );
    // 0.001 minutes = 60ms → should time out quickly
    const out = await tool.execute({ description: 't', prompt: 'p', timeout_minutes: 0.001 });
    expect(out).toContain('失败');
    expect(out).toContain('timeout');
  });
});