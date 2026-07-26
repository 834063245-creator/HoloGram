// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-status.test.ts — agent_status 工具输出（tool_wait 字段 / 空闲 null / 卡死标记）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubAgentPool } from '../src/agent/coordinator';
import {
  noteSubAgentEvent,
  noteSubAgentToolStart,
  removeSubAgentActivity,
  STUCK_THRESHOLD_S,
} from '../src/agent/subagent-activity';
import { createAgentStatusTool } from '../src/agent/tools/subagent';

const T0 = 1_700_000_000_000;

function neverFinishes() {
  return (_signal: AbortSignal) => new Promise<{ text: string; err?: string }>(() => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

/** 起一个永不结束的运行中子Agent，并注册模型可见别名（sub-... → subagent-...）。 */
function spawnRunning(pool: SubAgentPool, aliasId: string, description: string): void {
  const spawned = pool.spawn(description, neverFinishes());
  if (!spawned) throw new Error('spawn failed');
  pool.registerAlias(aliasId, spawned.id);
}

describe('agent_status tool', () => {
  it('工具元数据：名字 agent_status，只读', () => {
    const tool = createAgentStatusTool(new SubAgentPool());
    expect(tool.name()).toBe('agent_status');
    expect(tool.readOnly()).toBe(true);
  });

  it('无运行中子Agent → 明确提示', async () => {
    const pool = new SubAgentPool();
    const out = await createAgentStatusTool(pool).execute({});
    expect(out).toBe('当前没有运行中的子Agent。');
  });

  it('运行中 + 正在执行工具 → 报告 id/描述/总耗时/当前工具/等待秒数/最近事件', async () => {
    const pool = new SubAgentPool();
    spawnRunning(pool, 'sub-run-1', '修复登录bug');
    noteSubAgentEvent('sub-run-1'); // T0 最近事件
    vi.setSystemTime(T0 + 10_000);
    noteSubAgentToolStart('sub-run-1', 'run_shell'); // T0+10s 开始等待（与最近事件错开，防止字段互换仍通过）
    vi.setSystemTime(T0 + 30_000);
    const out = await createAgentStatusTool(pool).execute({});
    expect(out).toContain('sub-run-1'); // 模型可见 id（别名解析后）
    expect(out).toContain('修复登录bug');
    expect(out).toContain('已运行 30s');
    expect(out).toContain('run_shell');
    expect(out).toContain('已等待 20s');
    expect(out).toContain('最近事件: 30s 前');
    expect(out).not.toContain('⚠️'); // 未超阈值
    pool.stopAll();
    removeSubAgentActivity('sub-run-1');
  });

  it('运行中但空闲（无当前工具）→ 当前工具为无，无等待秒数', async () => {
    const pool = new SubAgentPool();
    spawnRunning(pool, 'sub-idle-1', '写测试');
    noteSubAgentEvent('sub-idle-1');
    vi.setSystemTime(T0 + 12_000);
    const out = await createAgentStatusTool(pool).execute({});
    expect(out).toContain('当前工具: 无');
    expect(out).not.toContain('已等待');
    expect(out).toContain('最近事件: 12s 前');
    pool.stopAll();
    removeSubAgentActivity('sub-idle-1');
  });

  it(`工具等待超过 ${STUCK_THRESHOLD_S}s → ⚠️ 疑似卡死`, async () => {
    const pool = new SubAgentPool();
    spawnRunning(pool, 'sub-stuck-1', '批量重构');
    noteSubAgentToolStart('sub-stuck-1', 'run_shell');
    vi.setSystemTime(T0 + (STUCK_THRESHOLD_S + 1) * 1000);
    const out = await createAgentStatusTool(pool).execute({});
    expect(out).toContain(`已等待 ${STUCK_THRESHOLD_S + 1}s`);
    expect(out).toContain('⚠️ 疑似卡死');
    pool.stopAll();
    removeSubAgentActivity('sub-stuck-1');
  });

  it('空闲但 200s 无任何事件 → ⚠️ 疑似卡死（120s 无事件）', async () => {
    const pool = new SubAgentPool();
    spawnRunning(pool, 'sub-silent-1', '长任务');
    noteSubAgentEvent('sub-silent-1'); // T0 最后一个事件
    vi.setSystemTime(T0 + 200_000);
    const out = await createAgentStatusTool(pool).execute({});
    expect(out).toContain('当前工具: 无');
    expect(out).toContain('最近事件: 200s 前');
    expect(out).toContain(`⚠️ 疑似卡死（${STUCK_THRESHOLD_S}s 无事件）`);
    pool.stopAll();
    removeSubAgentActivity('sub-silent-1');
  });

  it('空闲但 5s 前有事件 → 无卡死标记（活跃生成不误报）', async () => {
    const pool = new SubAgentPool();
    spawnRunning(pool, 'sub-fresh-1', '生成中');
    noteSubAgentEvent('sub-fresh-1');
    vi.setSystemTime(T0 + 5_000);
    const out = await createAgentStatusTool(pool).execute({});
    expect(out).toContain('当前工具: 无');
    expect(out).toContain('最近事件: 5s 前');
    expect(out).not.toContain('⚠️');
    pool.stopAll();
    removeSubAgentActivity('sub-fresh-1');
  });

  it('无任何事件记录 → 最近事件显示暂无记录', async () => {
    const pool = new SubAgentPool();
    spawnRunning(pool, 'sub-quiet-1', '静默任务');
    const out = await createAgentStatusTool(pool).execute({});
    expect(out).toContain('当前工具: 无');
    expect(out).toContain('暂无记录');
    pool.stopAll();
  });
});
