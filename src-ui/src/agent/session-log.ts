// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionLog — 模型可见事实的事件溯源日志（agent-core-convergence Phase 5）。
//
// Cordis 事件溯源原语的 HoloGram 落地（双写阶段）：
//   - Agent 的每一条模型可见会话变更先 append 为事件，同一消息对象再进
//     this.session（旧数组路径保留为投影真源，restore/UI 零改动）；
//   - deriveMessages() 从事件重放完整历史，必须与旧 session 数组逐字节等价；
//   - derivePayload() 从事件派生发送载荷，复刻 payloadMessages() 的全部折叠层：
//       1. 压缩折叠（session/compaction：summary + tailStart，reset 后失效）；
//       2. 工具结果批量折叠（foldToolResults + nextFoldBoundary）。
//     载荷字节稳定是硬不变式（DeepSeek 前缀缓存）——差分矩阵见
//     tests/session-differential.test.ts，契约快照见 baseline/phase-5/。
//
// 折叠边界的状态性说明（诚实边界，勿隐去）：
//   _toolFoldBoundary 是随 payloadMessages() 调用序列累积推进的运行时状态，
//   不在事件流内。derivePayload 因此显式接收 toolFoldBoundary（调用方镜像
//   Agent 当前值），不自作主张从事件重算——重算只能得到无状态近似，
//   与累积值在 retract/替换后会分叉。window=0（默认）时边界恒 0，无此问题。
//
// 行为规约（tests/session-log.test.ts / session-replay.test.ts 钉住）：
//   1. append 自动分配严格递增 seq；appendEvent 拒绝 seq ≤ lastSeq（重复/乱序）；
//   2. replay(snapshot) 重建的日志与原日志 deriveMessages/derivePayload 等价；
//   3. session/reset 清空压缩折叠状态（与 setSession/newSession 语义一致），
//      session/retract 不清空（与 retractTurnAt 语义一致——仅 _applyCompactState
//      的边界钳制兜底）。

import type { Message, ToolCall } from '../provider/types';
import type { Disposer } from './lifecycle';
import { foldToolResults, nextFoldBoundary } from './tool-fold';

// ── 事件类型（封闭可扩展 — T0：新 kind 必须同步 SESSION_EVENT_KINDS 与
//    SessionEventDataMap，两者由 Record 关系在编译期强制对齐）──

/** 事件种类。主计划 §6 Phase 5 规定 7 种；session/reset 与 session/retract
 *  是覆盖既有会话变异点（替换/撤回/goal 清场）的必要补充。 */
export type SessionEventKind =
  | 'turn/start'
  | 'user/message'
  | 'assistant/text'
  | 'assistant/reasoning'
  | 'tool/call'
  | 'tool/result'
  | 'session/compaction'
  | 'session/reset'
  | 'session/retract';

/** kind 封闭集合（运行时枚举，冻结）。 */
export const SESSION_EVENT_KINDS: readonly SessionEventKind[] = Object.freeze([
  'turn/start',
  'user/message',
  'assistant/text',
  'assistant/reasoning',
  'tool/call',
  'tool/result',
  'session/compaction',
  'session/reset',
  'session/retract',
]);

/** session/reset 的来源标注（审计用；不影响投影）。 */
export type SessionResetReason = 'init' | 'restore' | 'new-session' | 'goal-resume' | 'goal-parked';

/** 各 kind 的 data 形状。 */
export interface SessionEventDataMap {
  /** runLoop 一次调用开始（轮次边界标记，无消息投影）。 */
  'turn/start': { model: string };
  /** 用户可见消息 append（run 输入 / 安全边界插入 / inbox 持久部分 / goal 提示）。 */
  'user/message': { message: Message };
  /** assistant 轮次提交（content + reasoning + tool_calls 整体，原子事实）。 */
  'assistant/text': { message: Message };
  /** reasoning 独立记录（双写阶段不发射——reasoning 已在 assistant/text 消息内；
   *  kind 保留给未来的流式追加形态）。 */
  'assistant/reasoning': { text: string; signature?: string };
  /** 工具调用审计记录（每调用一条；投影取自 assistant/text 内嵌 tool_calls，
   *  此事件不参与 deriveMessages——单一事实源原则）。 */
  'tool/call': { call: ToolCall };
  /** 工具结果消息 append。 */
  'tool/result': { message: Message };
  /** 压缩折叠状态应用（summary + tailStart；session 保持完整历史）。 */
  'session/compaction': { summary: string; tailStart: number };
  /** 会话整体替换（构造 init / setSession 恢复 / newSession / goal 恢复与清场）。 */
  'session/reset': { messages: Message[]; reason: SessionResetReason };
  /** 区间撤回（splice 语义，[fromIndex, toIndex) — retractTurnAt / goal 暂停裁剪）。 */
  'session/retract': { fromIndex: number; toIndex: number };
}

/** 一条会话事件。seq 由日志分配、只增不减；ts 为 append 时刻。 */
export interface SessionEvent<K extends SessionEventKind = SessionEventKind> {
  readonly seq: number;
  readonly ts: number;
  readonly kind: K;
  readonly data: SessionEventDataMap[K];
}

/** 日志快照（JSON 可序列化；持久化到 session-log.ndjson 的单元）。 */
export interface SessionSnapshot {
  version: 1;
  events: SessionEvent[];
}

// ── 共享构造：压缩摘要消息（agent.ts payloadMessages 与 derivePayload 同源，
//    字节级一致由单一实现保证）──

/** 构造 <compacted-context> 摘要消息 — 与 agent.ts 旧实现逐字节一致（来源替换）。 */
export function buildCompactedSummaryMessage(summary: string): Message {
  return {
    role: 'user',
    content:
      '<compacted-context>\n以下是对前面讨论的总结（原始消息仍完整保留在会话历史中）:\n\n' +
      summary +
      '\n</compacted-context>',
  };
}

// ── 投影状态 ──

interface ProjectionState {
  messages: Message[];
  /** 最新压缩折叠状态；session/reset 后为 null（与 Agent 侧折叠失效语义一致）。 */
  compaction: { summary: string; tailStart: number } | null;
}

/** 派生载荷的折叠参数（镜像 Agent 的运行时值）。 */
export interface DerivePayloadOptions {
  /** 工具结果折叠窗口（Agent.toolResultWindow；0 = 禁用）。 */
  toolResultWindow: number;
  /** 当前折叠边界（Agent._toolFoldBoundary 镜像；缺省 0 — 仅 window>0 时有差异）。 */
  toolFoldBoundary?: number;
}

// ── SessionLog ──

export class SessionLog {
  private _events: SessionEvent[] = [];
  private _nextSeq = 1;
  private _listeners: Array<(ev: SessionEvent) => void> = [];

  /** 已记录事件数。 */
  get size(): number {
    return this._events.length;
  }

  /** 最大已分配 seq（空日志为 0）。 */
  get lastSeq(): number {
    return this._nextSeq - 1;
  }

  /** 追加一条事件（自动分配严格递增 seq）。返回冻结的事件对象。 */
  append<K extends SessionEventKind>(kind: K, data: SessionEventDataMap[K]): SessionEvent<K> {
    const ev: SessionEvent<K> = Object.freeze({ seq: this._nextSeq, ts: Date.now(), kind, data });
    this.appendEvent(ev as SessionEvent);
    return ev;
  }

  /** 追加既有事件（replay / 持久化恢复路径）。
   *  seq 必须严格大于当前 lastSeq —— 重复或乱序 append 即拒绝（T1 规约）。 */
  appendEvent(ev: SessionEvent): void {
    if (!ev || !SESSION_EVENT_KINDS.includes(ev.kind)) {
      throw new Error(`[SessionLog] 未知事件 kind: ${String((ev as SessionEvent | undefined)?.kind)}`);
    }
    if (!(ev.seq > 0) || !Number.isInteger(ev.seq)) {
      throw new Error(`[SessionLog] 非法 seq: ${String(ev?.seq)}（必须为正整数）`);
    }
    if (ev.seq <= this.lastSeq) {
      throw new Error(`[SessionLog] 重复/乱序 append 拒绝: seq=${ev.seq} ≤ lastSeq=${this.lastSeq}`);
    }
    this._events.push(ev);
    if (ev.seq >= this._nextSeq) this._nextSeq = ev.seq + 1;
    for (const fn of [...this._listeners]) {
      try {
        fn(ev);
      } catch {
        /* 监听器异常不阻断日志（观察面尽力而为） */
      }
    }
  }

  /** 订阅 append（session/event 内部事件 — 测试观测与未来回放的接入点；
   *  UI/EventSink 不在此面）。返回取消订阅的 Disposer。 */
  onEvent(listener: (ev: SessionEvent) => void): Disposer {
    this._listeners.push(listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  /** 事件只读视图。 */
  events(): readonly SessionEvent[] {
    return this._events;
  }

  /** seq 之后的事件（saveState 增量持久化取段）。 */
  eventsAfter(seq: number): SessionEvent[] {
    return this._events.filter((e) => e.seq > seq);
  }

  /** 日志快照（深拷贝，可 JSON 序列化；与 replay 配对重建）。 */
  snapshot(): SessionSnapshot {
    return { version: 1, events: this._events.map((e) => jsonClone(e) as SessionEvent) };
  }

  /** 从快照/事件序列重建日志。seq 非严格递增（重复/乱序/回退）即抛错。 */
  static replay(source: SessionSnapshot | SessionEvent[]): SessionLog {
    const events = Array.isArray(source) ? source : source.events;
    const log = new SessionLog();
    for (const ev of events) log.appendEvent(jsonClone(ev) as SessionEvent);
    return log;
  }

  /** 完整历史投影 — 必须与旧 session 数组逐字节等价（T1/T2 差分钉住）。 */
  deriveMessages(): Message[] {
    return this.project().messages;
  }

  /** 发送载荷投影 — 复刻 agent.ts payloadMessages() 的全部折叠层。
   *  折叠参数须镜像 Agent 当前运行时值（见文件头"折叠边界的状态性说明"）。 */
  derivePayload(opts: DerivePayloadOptions): Message[] {
    const { messages, compaction } = this.project();
    let msgs: Message[];
    if (!compaction?.summary || compaction.tailStart < 0) {
      msgs = messages;
    } else {
      const head = foldHead(messages);
      const tailStart = Math.min(Math.max(compaction.tailStart, head), messages.length);
      msgs = [
        ...messages.slice(0, head),
        buildCompactedSummaryMessage(compaction.summary),
        ...messages.slice(tailStart),
      ];
    }
    // 工具总数按完整历史计（与 agent.ts payloadMessages 一致，非折叠视图）
    let totalTool = 0;
    for (const m of messages) if (m.role === 'tool') totalTool++;
    const boundary = nextFoldBoundary(totalTool, opts.toolFoldBoundary ?? 0, opts.toolResultWindow);
    return foldToolResults(msgs, boundary);
  }

  /** 事件流 → 投影状态（单一 fold，reset/retract/compaction 语义逐点镜像 Agent）。 */
  private project(): ProjectionState {
    const state: ProjectionState = { messages: [], compaction: null };
    for (const ev of this._events) {
      switch (ev.kind) {
        case 'user/message':
        case 'assistant/text':
        case 'tool/result': {
          const data = ev.data as { message: Message };
          state.messages.push(data.message);
          break;
        }
        case 'session/reset': {
          const data = ev.data as { messages: Message[] };
          state.messages = [...data.messages];
          state.compaction = null; // 替换 → 折叠状态失效（setSession/newSession 语义）
          break;
        }
        case 'session/retract': {
          const data = ev.data as { fromIndex: number; toIndex: number };
          const from = Math.max(0, Math.min(data.fromIndex, state.messages.length));
          const to = Math.max(from, Math.min(data.toIndex, state.messages.length));
          state.messages.splice(from, to - from); // 撤回不清折叠状态（retractTurnAt 语义）
          break;
        }
        case 'session/compaction': {
          const data = ev.data as { summary: string; tailStart: number };
          state.compaction = { summary: data.summary, tailStart: data.tailStart };
          break;
        }
        case 'turn/start':
        case 'tool/call':
        case 'assistant/reasoning':
          break; // 边界/审计记录，无消息投影
      }
    }
    return state;
  }
}

/** session 头部偏移：首条为 system 则 1，否则 0（与 agent.ts _foldHead 同语义）。 */
function foldHead(messages: readonly Message[]): number {
  return messages.length > 0 && messages[0].role === 'system' ? 1 : 0;
}

/** JSON 深拷贝（事件/消息树均为 JSON 形状；同时剥离冻结态与共享引用）。 */
function jsonClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
