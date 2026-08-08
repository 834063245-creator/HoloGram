import { describe, expect, it } from 'vitest';
import { foldToolResults, DEFAULT_TOOL_RESULT_WINDOW } from '../src/agent/tool-fold';
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
  it('默认窗口内（≤40 条）全部保留完整', () => {
    const session = buildSession(40);
    const out = foldToolResults(session, DEFAULT_TOOL_RESULT_WINDOW);
    expect(out).toBe(session);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(40);
    expect(out[3].content).toContain('tool output');
  });

  it('窗口外折叠成占位：工具名 + 调用 id 尾段 + 原文大小', () => {
    const session = buildSession(42);
    const out = foldToolResults(session, 40);
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
    const out = foldToolResults(session, 40);
    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs[0].tool_call_id).toBe('call_0');
    expect(toolMsgs[44].tool_call_id).toBe('call_44');
    // 顺序不变
    expect(out[3].tool_call_id).toBe('call_0');
    expect(out[out.length - 1].tool_call_id).toBe('call_44');
  });

  it('window=-1 禁用折叠（兼容旧行为），返回原数组', () => {
    const session = buildSession(100);
    const out = foldToolResults(session, -1);
    expect(out).toBe(session);
  });

  it('window=0 全折叠', () => {
    const session = buildSession(3);
    const out = foldToolResults(session, 0);
    expect(out.filter((m) => m.role === 'tool' && m.content.startsWith('[工具结果已折叠'))).toHaveLength(3);
  });

  it('不可变：不修改原消息对象', () => {
    const session = buildSession(45);
    const snapshot = JSON.stringify(session);
    foldToolResults(session, 40);
    expect(JSON.stringify(session)).toBe(snapshot);
  });

  it('窗口外的 user/assistant 消息不受影响', () => {
    const session = buildSession(45);
    const out = foldToolResults(session, 40);
    const users = out.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe('do the work');
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants.every((m) => m.tool_calls && m.tool_calls.length === 1)).toBe(true);
  });
});
