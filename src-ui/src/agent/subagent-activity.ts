// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// subagent-activity — 子Agent 活动追踪器。
//
// 父Agent 原本只能看到子Agent「运行中/已结束」，分不清「慢」与「死」，
// agent_kill 的决策是盲的。本模块在子Agent 的事件流上开一个旁路（tee），
// 记录每个子Agent：当前正在执行的工具调用（或 null）、该调用的开始时间、
// 最近一次任意事件的时间戳。agent_status 工具读取这里的数据做卡死判断。
//
// 事件形状（见 streaming-executor.ts / part-mutator.ts）：
//   - 工具开始：EventKind.ToolDispatch（tool.name；同一次调用可能来两次——
//     ToolCallStart(partial) + ToolCall(全量参数)，首次见到即记开始时间）
//   - 工具结束：EventKind.ToolResult
//   - 其他任意事件：只刷新 lastEventAt
//
// 单槽设计：一个子Agent 只记一个 currentTool。并发工具调用时后到的 dispatch
// 覆盖前一个（最近开始者优先）；名字不匹配的 ToolResult 不清除当前工具——
// 对「卡死检测」这一用途足够，刻意不维护 per-call 表。

import type { AgentEvent, EventSink } from './agent-types';
import { EventKind } from './agent-types';

/** 工具调用等待超过该秒数 → agent_status 标记 ⚠️ 疑似卡死 */
export const STUCK_THRESHOLD_S = 120;

export interface SubAgentActivity {
  /** 当前正在执行的工具名（null = 空闲/生成中） */
  currentTool: string | null;
  /** 当前工具调用的开始时间（Date.now() ms，null = 无进行中调用） */
  toolStartedAt: number | null;
  /** 最近一次任意事件的时间戳（Date.now() ms） */
  lastEventAt: number;
}

const activities = new Map<string, SubAgentActivity>();

function ensure(agentId: string): SubAgentActivity {
  let a = activities.get(agentId);
  if (!a) {
    a = { currentTool: null, toolStartedAt: null, lastEventAt: Date.now() };
    activities.set(agentId, a);
  }
  return a;
}

/** 任意事件 — 刷新 lastEventAt。 */
export function noteSubAgentEvent(agentId: string): void {
  ensure(agentId).lastEventAt = Date.now();
}

/** 工具调用开始。同名工具的重复 dispatch（ToolCallStart → ToolCall）不重置开始时间。 */
export function noteSubAgentToolStart(agentId: string, toolName: string): void {
  const a = ensure(agentId);
  if (a.currentTool !== toolName || a.toolStartedAt == null) {
    a.currentTool = toolName;
    a.toolStartedAt = Date.now();
  }
}

/** 工具调用结束。带了名字且与当前工具不匹配时（并发调用的结果）不清除。 */
export function noteSubAgentToolEnd(agentId: string, toolName?: string): void {
  const a = activities.get(agentId);
  if (!a) return;
  if (toolName && a.currentTool && toolName !== a.currentTool) return;
  a.currentTool = null;
  a.toolStartedAt = null;
}

/** 读取某个子Agent 的活动（无记录 → undefined）。 */
export function getSubAgentActivity(agentId: string): SubAgentActivity | undefined {
  return activities.get(agentId);
}

/** 子Agent 结束后调用，防止 Map 泄漏。 */
export function removeSubAgentActivity(agentId: string): void {
  activities.delete(agentId);
}

/** 按事件类型分发到上面的三个记录函数（任意事件都先刷 lastEventAt）。 */
export function trackSubAgentEvent(agentId: string, ev: AgentEvent): void {
  noteSubAgentEvent(agentId);
  if (ev.kind === EventKind.ToolDispatch && ev.tool?.name) {
    noteSubAgentToolStart(agentId, ev.tool.name);
  } else if (ev.kind === EventKind.ToolResult) {
    noteSubAgentToolEnd(agentId, ev.tool?.name);
  }
}

/** 旁路包装：事件先送进追踪器，再原样转发给原 sink（tee，不改变 sink 行为）。 */
export function wrapSubAgentSink(agentId: string, sink: EventSink): EventSink {
  return (ev) => {
    trackSubAgentEvent(agentId, ev);
    sink(ev);
  };
}
