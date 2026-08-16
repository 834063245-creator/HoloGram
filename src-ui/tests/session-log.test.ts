// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Phase 5 T1 — SessionLog 原语行为规约（验证计划 §4 Phase 5 T1）。
// append / snapshot / deriveMessages / derivePayload / 重复 append 拒绝 /
// 投影折叠层语义（compaction reset 失效、retract 保留、工具折叠镜像）。

import { describe, expect, it } from 'vitest';
import {
  buildCompactedSummaryMessage,
  SESSION_EVENT_KINDS,
  type SessionEvent,
  SessionLog,
} from '../src/agent/session-log';
import type { Message } from '../src/provider/types';

const SYS: Message = { role: 'system', content: 'sys' };
const U1: Message = { role: 'user', content: '你好' };
const A1: Message = {
  role: 'assistant',
  content: '收到',
  tool_calls: [{ id: 'c1', name: 'echo', arguments: '{"v":1}' }],
};
const T1: Message = { role: 'tool', content: 'ok:1', tool_call_id: 'c1', name: 'echo' };

/** 镜像 Agent 运行形状的迷你会话序列（run 输入 → assistant+call → tool result）。 */
function seedConversation(log: SessionLog): void {
  log.append('session/reset', { messages: [SYS], reason: 'init' });
  log.append('turn/start', { model: 'mock' });
  log.append('user/message', { message: U1 });
  log.append('assistant/text', { message: A1 });
  log.append('tool/call', { call: { id: 'c1', name: 'echo', arguments: '{"v":1}' } });
  log.append('tool/result', { message: T1 });
}

describe('SessionLog T1 — append 与 seq 不变式', () => {
  it('append 自动分配从 1 起严格递增的 seq', () => {
    const log = new SessionLog();
    const e1 = log.append('user/message', { message: U1 });
    const e2 = log.append('assistant/text', { message: A1 });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(log.lastSeq).toBe(2);
    expect(log.size).toBe(2);
  });

  it('appendEvent 拒绝重复与乱序 seq（重复 append 拒绝）', () => {
    const log = new SessionLog();
    const e1 = log.append('user/message', { message: U1 });
    expect(() => log.appendEvent(e1)).toThrow(/重复\/乱序 append 拒绝/);
    expect(() => log.appendEvent({ ...e1, seq: 1, ts: 2 } as SessionEvent)).toThrow(/重复\/乱序/);
    expect(log.size).toBe(1); // 拒绝后状态不受污染
    // 严格递增合法
    log.appendEvent({ seq: 2, ts: 2, kind: 'user/message', data: { message: U1 } });
    expect(log.lastSeq).toBe(2);
  });

  it('appendEvent 拒绝未知 kind 与非法 seq', () => {
    const log = new SessionLog();
    expect(() => log.appendEvent({ seq: 1, ts: 1, kind: 'nope' as never, data: {} })).toThrow(/未知事件 kind/);
    expect(() => log.appendEvent({ seq: 0, ts: 1, kind: 'user/message', data: { message: U1 } })).toThrow(/非法 seq/);
  });

  it('SESSION_EVENT_KINDS 是冻结的封闭集合且含主计划规定的 7 种', () => {
    expect(Object.isFrozen(SESSION_EVENT_KINDS)).toBe(true);
    for (const k of [
      'turn/start',
      'user/message',
      'assistant/text',
      'assistant/reasoning',
      'tool/call',
      'tool/result',
      'session/compaction',
    ] as const) {
      expect(SESSION_EVENT_KINDS).toContain(k);
    }
  });
});

describe('SessionLog T1 — deriveMessages 投影', () => {
  it('完整历史投影：消息按 append 顺序逐条对应', () => {
    const log = new SessionLog();
    seedConversation(log);
    expect(log.deriveMessages()).toEqual([SYS, U1, A1, T1]);
  });

  it('turn/start 与 tool/call 不进消息投影（边界/审计记录）', () => {
    const log = new SessionLog();
    log.append('turn/start', { model: 'mock' });
    log.append('tool/call', { call: { id: 'x', name: 'n', arguments: '{}' } });
    log.append('assistant/reasoning', { text: '思考' });
    expect(log.deriveMessages()).toEqual([]);
  });

  it('session/reset 整体替换投影', () => {
    const log = new SessionLog();
    seedConversation(log);
    const restored: Message[] = [SYS, { role: 'user', content: '恢复' }];
    log.append('session/reset', { messages: restored, reason: 'restore' });
    expect(log.deriveMessages()).toEqual(restored);
  });

  it('session/retract 区间撤回（[from, to) splice 语义）', () => {
    const log = new SessionLog();
    seedConversation(log);
    log.append('user/message', { message: { role: 'user', content: '第二轮' } });
    log.append('assistant/text', { message: { role: 'assistant', content: '好' } });
    // 撤回第二轮：[4, 6)
    log.append('session/retract', { fromIndex: 4, toIndex: 6 });
    expect(log.deriveMessages()).toEqual([SYS, U1, A1, T1]);
  });
});

describe('SessionLog T1 — derivePayload 折叠层', () => {
  it('无压缩：payload = 完整历史（window=0 不折叠）', () => {
    const log = new SessionLog();
    seedConversation(log);
    expect(log.derivePayload({ toolResultWindow: 0 })).toEqual([SYS, U1, A1, T1]);
  });

  it('压缩折叠：head + <compacted-context> 摘要 + tail，格式与 agent 逐字节一致', () => {
    const log = new SessionLog();
    seedConversation(log);
    // 压缩折叠 [head, 3)：U1/A1 进摘要，tail = [T1]
    log.append('session/compaction', { summary: '讨论了问候', tailStart: 3 });
    const payload = log.derivePayload({ toolResultWindow: 0 });
    expect(payload).toEqual([SYS, buildCompactedSummaryMessage('讨论了问候'), T1]);
    // 摘要消息字节级格式（前缀缓存硬不变式）
    expect(payload[1].content).toBe(
      '<compacted-context>\n以下是对前面讨论的总结（原始消息仍完整保留在会话历史中）:\n\n讨论了问候\n</compacted-context>',
    );
  });

  it('session/reset 后压缩折叠失效（setSession/newSession 语义）', () => {
    const log = new SessionLog();
    seedConversation(log);
    log.append('session/compaction', { summary: 's', tailStart: 3 });
    log.append('session/reset', { messages: [SYS, U1], reason: 'new-session' });
    expect(log.derivePayload({ toolResultWindow: 0 })).toEqual([SYS, U1]);
  });

  it('session/retract 不清压缩折叠（retractTurnAt 语义 — tailStart 越界时钳制）', () => {
    const log = new SessionLog();
    seedConversation(log);
    log.append('session/compaction', { summary: 's', tailStart: 3 });
    // 撤回到只剩 [SYS, U1]（撤掉 A1/T1）→ tailStart=3 超界，钳制到 length=2
    log.append('session/retract', { fromIndex: 2, toIndex: 4 });
    const payload = log.derivePayload({ toolResultWindow: 0 });
    expect(payload).toEqual([SYS, buildCompactedSummaryMessage('s')]);
  });

  it('工具结果批量折叠：窗口镜像 Agent 边界（含调用时推进语义）', () => {
    const log = new SessionLog();
    log.append('session/reset', { messages: [SYS], reason: 'init' });
    log.append('user/message', { message: { role: 'user', content: 'go' } });
    for (let i = 0; i < 6; i++) {
      log.append('assistant/text', {
        message: { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'echo', arguments: '{}' }] },
      });
      log.append('tool/result', {
        message: { role: 'tool', content: `ok-${i}`, tool_call_id: `c${i}`, name: 'echo' },
      });
    }
    const toolContents = (opts: { toolResultWindow: number; toolFoldBoundary?: number }) =>
      log
        .derivePayload(opts)
        .filter((m) => m.role === 'tool')
        .map((m) => m.content);
    // 5 条结果、boundary=2、window=2：5-2=3 < 2×2 → 边界不动，恰折叠前 2 条
    // （去掉最后一条 tool/result 后的等价视窗 —— 这里直接用 6 条对照两种边界态）
    // 6 条、boundary=2：6-2=4 ≥ 4 → 边界推进到 4（与 agent payloadMessages 调用时推进一致）
    expect(toolContents({ toolResultWindow: 2, toolFoldBoundary: 2 })).toEqual([
      expect.stringMatching(/^\[工具结果已折叠: echo #c0 /),
      expect.stringMatching(/^\[工具结果已折叠: echo #c1 /),
      expect.stringMatching(/^\[工具结果已折叠: echo #c2 /),
      expect.stringMatching(/^\[工具结果已折叠: echo #c3 /),
      'ok-4',
      'ok-5',
    ]);
    // 镜像已推进的 boundary=4：6-4=2 < 4 → 不再推进，折叠前 4 条
    expect(toolContents({ toolResultWindow: 2, toolFoldBoundary: 4 })).toEqual([
      expect.stringMatching(/^\[工具结果已折叠: echo #c0 /),
      expect.stringMatching(/^\[工具结果已折叠: echo #c1 /),
      expect.stringMatching(/^\[工具结果已折叠: echo #c2 /),
      expect.stringMatching(/^\[工具结果已折叠: echo #c3 /),
      'ok-4',
      'ok-5',
    ]);
    // window=0（默认）：不折叠
    expect(toolContents({ toolResultWindow: 0 })).toEqual(['ok-0', 'ok-1', 'ok-2', 'ok-3', 'ok-4', 'ok-5']);
  });
});

describe('SessionLog T1 — onEvent 内部事件', () => {
  it('每次 append 通知监听器；Disposer 取消后不再通知', () => {
    const log = new SessionLog();
    const seen: number[] = [];
    const off = log.onEvent((ev) => seen.push(ev.seq));
    log.append('user/message', { message: U1 });
    log.append('assistant/text', { message: A1 });
    off();
    log.append('tool/result', { message: T1 });
    expect(seen).toEqual([1, 2]);
  });

  it('监听器抛错不阻断 append', () => {
    const log = new SessionLog();
    log.onEvent(() => {
      throw new Error('listener boom');
    });
    expect(() => log.append('user/message', { message: U1 })).not.toThrow();
    expect(log.size).toBe(1);
  });
});
