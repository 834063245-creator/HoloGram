import { describe, expect, it } from 'vitest';
import { foldToolResults, nextFoldBoundary, DEFAULT_TOOL_FOLD_BATCH } from '../src/agent/tool-fold';
import type { Message } from '../src/provider/types';

function toolMsg(i: number, content = `tool output ${i} `.repeat(50)): Message {
  return { role: 'tool', content, tool_call_id: `call_${i}`, name: i % 2 === 0 ? 'fs' : 'shell' };
}

function buildSession(toolCount: number, extraBefore: Message[] = []): Message[] {
  const msgs: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do the work' },
    ...extraBefore,
  ];
  for (let i = 0; i < toolCount; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `call_${i}`, name: 'fs', arguments: '{}' }] });
    msgs.push(toolMsg(i));
  }
  return msgs;
}

describe('foldToolResults', () => {
  it('foldBoundary<=0 不折叠（兼容旧行为），返回原数组', () => {
    const session = buildSession(100);
    expect(foldToolResults(session, 0)).toBe(session);
    expect(foldToolResults(session, -1)).toBe(session);
  });

  it('折叠序号 < boundary 的 tool 消息：工具名 + 调用 id 尾段 + 原文大小', () => {
    const session = buildSession(42);
    const out = foldToolResults(session, 2);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(42);
    const folded = out.filter((m) => m.role === 'tool' && m.content.startsWith('[工具结果已折叠'));
    expect(folded).toHaveLength(2);
    expect(folded[0].content).toContain('fs');
    expect(folded[0].content).toContain('call_0'.slice(-6));
    expect(folded[0].content).toContain('KB');
    expect(folded[0].content).toContain('重新调用');
    expect(folded[1].content).toContain('shell');
  });

  it('折叠保留 tool_call_id 与顺序（API 配对约束）', () => {
    const session = buildSession(45);
    const out = foldToolResults(session, 3);
    expect(out[3].tool_call_id).toBe('call_0');
    expect(out[3].content.startsWith('[工具结果已折叠')).toBe(true);
    expect(out[9].tool_call_id).toBe('call_3');
    expect(out[9].content).toContain('tool output');
    expect(out[out.length - 1].tool_call_id).toBe('call_44');
  });

  it('不可变：不修改原消息对象', () => {
    const session = buildSession(45);
    const snapshot = JSON.stringify(session);
    foldToolResults(session, 10);
    expect(JSON.stringify(session)).toBe(snapshot);
  });

  it('窗口外的 user/assistant 消息不受影响', () => {
    const session = buildSession(45);
    const out = foldToolResults(session, 5);
    const users = out.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe('do the work');
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants.every((m) => m.tool_calls && m.tool_calls.length === 1)).toBe(true);
  });
});

describe('nextFoldBoundary（缓存纪律：批量前移，不逐轮滚动）', () => {
  it('未跨阈值时边界不变 — 相邻轮次折叠集合稳定', () => {
    let b = nextFoldBoundary(40, 0, DEFAULT_TOOL_FOLD_BATCH);
    expect(b).toBe(0); // 前 40 条全部保留
    for (let total = 1; total <= 79; total++) {
      expect(nextFoldBoundary(total, 0, DEFAULT_TOOL_FOLD_BATCH)).toBe(0);
    }
  });

  it('边界后积累满 2×batch 才前移一批（一次最多一批），推进后保留 ≥batch 条完整', () => {
    expect(nextFoldBoundary(79, 0, 40)).toBe(0); // 差 79 < 80，不折
    expect(nextFoldBoundary(80, 0, 40)).toBe(40); // 差 80 = 2×40，折最早 40 条，剩 40 条完整
    expect(nextFoldBoundary(120, 40, 40)).toBe(80); // 120-40=80 >= 80，再折一批
    expect(nextFoldBoundary(119, 40, 40)).toBe(40); // 未跨阈值
    expect(nextFoldBoundary(200, 40, 40)).toBe(80); // 一次最多一批，不跳批
  });

  it('batch<=0 时边界归零（禁用折叠）', () => {
    expect(nextFoldBoundary(100, 40, 0)).toBe(0);
    expect(nextFoldBoundary(100, 40, -5)).toBe(0);
  });

  it('会话增长模拟：每积累 40 条新 tool 消息才折叠一次，其余轮次边界稳定', () => {
    let boundary = 0;
    const foldEvents = [];
    for (let total = 1; total <= 200; total++) {
      const before = boundary;
      boundary = nextFoldBoundary(total, boundary, DEFAULT_TOOL_FOLD_BATCH);
      if (boundary !== before) foldEvents.push(total);
    }
    expect(foldEvents).toEqual([80, 120, 160, 200]);
  });
});
