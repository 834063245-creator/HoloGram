// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// subagent-activity.test.ts — 子Agent 活动追踪器（tool 起止 / 最近事件 / tee 包装）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';
import {
  getSubAgentActivity,
  noteSubAgentEvent,
  noteSubAgentToolEnd,
  noteSubAgentToolStart,
  removeSubAgentActivity,
  trackSubAgentEvent,
  wrapSubAgentSink,
} from '../src/agent/subagent-activity';

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('subagent-activity tracker', () => {
  it('noteEvent 创建记录并刷新 lastEventAt', () => {
    noteSubAgentEvent('a1');
    expect(getSubAgentActivity('a1')).toEqual({ currentTool: null, toolStartedAt: null, lastEventAt: T0 });
    vi.setSystemTime(T0 + 5000);
    noteSubAgentEvent('a1');
    expect(getSubAgentActivity('a1')?.lastEventAt).toBe(T0 + 5000);
    removeSubAgentActivity('a1');
  });

  it('noteToolStart 记录当前工具与开始时间；同名重复 dispatch 不重置', () => {
    noteSubAgentToolStart('a2', 'run_shell');
    expect(getSubAgentActivity('a2')).toMatchObject({ currentTool: 'run_shell', toolStartedAt: T0 });
    // 同一工具的第二次 dispatch（ToolCallStart → ToolCall 全量参数）不重置开始时间
    vi.setSystemTime(T0 + 2000);
    noteSubAgentToolStart('a2', 'run_shell');
    expect(getSubAgentActivity('a2')?.toolStartedAt).toBe(T0);
    removeSubAgentActivity('a2');
  });

  it('noteToolStart 换一个工具 → 覆盖并重置开始时间（并发时后到优先）', () => {
    noteSubAgentToolStart('a3', 'read_file');
    vi.setSystemTime(T0 + 3000);
    noteSubAgentToolStart('a3', 'write_file');
    expect(getSubAgentActivity('a3')).toMatchObject({ currentTool: 'write_file', toolStartedAt: T0 + 3000 });
    removeSubAgentActivity('a3');
  });

  it('noteToolEnd 清除当前工具；名字不匹配（并发调用的结果）不清除', () => {
    noteSubAgentToolStart('a4', 'run_shell');
    noteSubAgentToolStart('a4', 'read_file'); // 并发：当前工具是 read_file
    noteSubAgentToolEnd('a4', 'run_shell'); // 另一个调用的结果 — 不清除
    expect(getSubAgentActivity('a4')?.currentTool).toBe('read_file');
    noteSubAgentToolEnd('a4', 'read_file');
    expect(getSubAgentActivity('a4')).toMatchObject({ currentTool: null, toolStartedAt: null });
    removeSubAgentActivity('a4');
  });

  it('remove 删除记录', () => {
    noteSubAgentEvent('a5');
    removeSubAgentActivity('a5');
    expect(getSubAgentActivity('a5')).toBeUndefined();
  });

  it('trackSubAgentEvent：ToolDispatch → 当前工具，ToolResult → 清除，Text → 只刷时间', () => {
    trackSubAgentEvent('a6', {
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'search_content', read_only: true, partial: true },
    });
    expect(getSubAgentActivity('a6')).toMatchObject({
      currentTool: 'search_content',
      toolStartedAt: T0,
      lastEventAt: T0,
    });
    vi.setSystemTime(T0 + 7000);
    trackSubAgentEvent('a6', {
      kind: EventKind.ToolResult,
      tool: { id: 't1', name: 'search_content', read_only: true, output: 'ok' },
    });
    expect(getSubAgentActivity('a6')).toMatchObject({ currentTool: null, toolStartedAt: null, lastEventAt: T0 + 7000 });
    vi.setSystemTime(T0 + 9000);
    trackSubAgentEvent('a6', { kind: EventKind.Text, text: 'hi' });
    expect(getSubAgentActivity('a6')?.lastEventAt).toBe(T0 + 9000);
    expect(getSubAgentActivity('a6')?.currentTool).toBeNull();
    removeSubAgentActivity('a6');
  });

  it('未知工具的 dispatch → 带 err 的 ToolResult 到达 → currentTool 清除（不残留假卡死）', () => {
    trackSubAgentEvent('a8', {
      kind: EventKind.ToolDispatch,
      tool: { id: 't-ghost', name: 'hallucinated_tool', read_only: false },
    });
    expect(getSubAgentActivity('a8')?.currentTool).toBe('hallucinated_tool');
    trackSubAgentEvent('a8', {
      kind: EventKind.ToolResult,
      tool: {
        id: 't-ghost',
        name: 'hallucinated_tool',
        read_only: false,
        output: 'error: unknown tool "hallucinated_tool"',
        err: 'unknown tool "hallucinated_tool"',
      },
    });
    expect(getSubAgentActivity('a8')).toMatchObject({ currentTool: null, toolStartedAt: null });
    removeSubAgentActivity('a8');
  });
});

describe('wrapSubAgentSink', () => {
  it('tee：事件原样转发给原 sink，同时进追踪器（不打断事件流）', () => {
    const received: AgentEvent[] = [];
    const sink = wrapSubAgentSink('a7', (ev) => received.push(ev));
    const events: AgentEvent[] = [
      { kind: EventKind.Text, text: 'hello' },
      { kind: EventKind.ToolDispatch, tool: { id: 't1', name: 'run_shell', read_only: false } },
      { kind: EventKind.ToolResult, tool: { id: 't1', name: 'run_shell', read_only: false, output: 'done' } },
    ];
    for (const ev of events) sink(ev);
    // 原 sink 收到全部事件，且是同一个对象引用（未被改写）
    expect(received).toHaveLength(3);
    expect(received[0]).toBe(events[0]);
    expect(received[1]).toBe(events[1]);
    expect(received[2]).toBe(events[2]);
    // 追踪器记录了完整生命周期：结果到达 → 当前工具清除，时间刷新
    expect(getSubAgentActivity('a7')).toMatchObject({ currentTool: null, toolStartedAt: null, lastEventAt: T0 });
    removeSubAgentActivity('a7');
  });
});
