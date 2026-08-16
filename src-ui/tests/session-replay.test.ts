// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Phase 5 T1 — SessionLog 回放（验证计划 §4 Phase 5 replay + 主计划
// session-replay.test.ts）：从事件序列重建日志，投影与原日志等价；
// 非单调事件流（重复/回退 seq）重建即拒绝。

import { describe, expect, it } from 'vitest';
import { SessionLog } from '../src/agent/session-log';
import type { Message } from '../src/provider/types';

const SYS: Message = { role: 'system', content: 'sys' };

/** 模拟一段真实运行形状的事件流：两轮对话 + 工具 + 压缩 + 撤回。 */
function seedScenario(): SessionLog {
  const log = new SessionLog();
  log.append('session/reset', { messages: [SYS], reason: 'init' });
  log.append('turn/start', { model: 'mock' });
  log.append('user/message', { message: { role: 'user', content: '第一轮' } });
  log.append('assistant/text', {
    message: {
      role: 'assistant',
      content: '调用工具',
      reasoning_content: '思考中',
      tool_calls: [{ id: 'c1', name: 'echo', arguments: '{"v":1}' }],
    },
  });
  log.append('tool/call', { call: { id: 'c1', name: 'echo', arguments: '{"v":1}' } });
  log.append('tool/result', { message: { role: 'tool', content: 'ok:1', tool_call_id: 'c1', name: 'echo' } });
  log.append('assistant/text', { message: { role: 'assistant', content: '完成第一轮' } });
  log.append('user/message', { message: { role: 'user', content: '第二轮' } });
  log.append('assistant/text', { message: { role: 'assistant', content: '第二轮回答' } });
  log.append('session/compaction', { summary: '前两轮摘要', tailStart: 4 });
  log.append('session/retract', { fromIndex: 7, toIndex: 9 });
  return log;
}

describe('SessionLog replay', () => {
  it('snapshot → replay 重建：deriveMessages/derivePayload 与原日志逐字节等价', () => {
    const log = seedScenario();
    const rebuilt = SessionLog.replay(log.snapshot());
    expect(rebuilt.deriveMessages()).toEqual(log.deriveMessages());
    expect(JSON.stringify(rebuilt.deriveMessages())).toBe(JSON.stringify(log.deriveMessages()));
    expect(rebuilt.derivePayload({ toolResultWindow: 0 })).toEqual(log.derivePayload({ toolResultWindow: 0 }));
    expect(rebuilt.lastSeq).toBe(log.lastSeq);
    expect(rebuilt.size).toBe(log.size);
  });

  it('replay 后可继续 append（seq 从原流之后严格递增）', () => {
    const log = seedScenario();
    const rebuilt = SessionLog.replay(log.snapshot());
    const next = rebuilt.append('user/message', { message: { role: 'user', content: '回放后新消息' } });
    expect(next.seq).toBe(log.lastSeq + 1);
    const originalNext = log.append('user/message', { message: { role: 'user', content: '回放后新消息' } });
    expect(originalNext.seq).toBe(next.seq);
    expect(rebuilt.deriveMessages()).toEqual(log.deriveMessages());
  });

  it('快照是深拷贝 — 原日志后续 append 不影响已取快照', () => {
    const log = seedScenario();
    const snap = log.snapshot();
    const sizeAtSnapshot = snap.events.length;
    log.append('user/message', { message: { role: 'user', content: '后续' } });
    expect(snap.events).toHaveLength(sizeAtSnapshot);
    expect(SessionLog.replay(snap).size).toBe(sizeAtSnapshot);
  });

  it('事件数组直接 replay 与快照 replay 等价', () => {
    const log = seedScenario();
    const fromArray = SessionLog.replay([...log.events()]);
    const fromSnapshot = SessionLog.replay(log.snapshot());
    expect(fromArray.deriveMessages()).toEqual(fromSnapshot.deriveMessages());
  });

  it('非单调事件流（重复 seq / 回退 seq）replay 即拒绝', () => {
    const log = seedScenario();
    const events = [...log.events()];
    expect(() => SessionLog.replay([...events, events[events.length - 1]])).toThrow(/重复\/乱序/);
    const regressed = { ...events[events.length - 1], seq: 1 } as (typeof events)[number];
    expect(() => SessionLog.replay([...events, regressed])).toThrow(/重复\/乱序/);
  });
});
