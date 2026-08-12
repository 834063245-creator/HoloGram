import { describe, expect, it } from 'vitest';
import { isSubagentSpawnTool } from '../src/ui/tool-semantics';

describe('isSubagentSpawnTool — 子 Agent 卡片去重', () => {
  it('旧名 agent_spawn 命中（跳过 ToolCard）', () => {
    expect(isSubagentSpawnTool('agent_spawn', '{"description":"x"}')).toBe(true);
    expect(isSubagentSpawnTool('agent_spawn', undefined)).toBe(true);
  });

  it('领域调用 agent(action=spawn) 命中', () => {
    expect(isSubagentSpawnTool('agent', '{"action":"spawn","description":"x"}')).toBe(true);
  });

  it('partial 分发（ToolCallStart 无参数）对 agent 领域一律命中 — 延迟建卡', () => {
    expect(isSubagentSpawnTool('agent', '', true)).toBe(true);
    expect(isSubagentSpawnTool('agent', undefined, true)).toBe(true);
  });

  it('partial 分发不影响其他工具', () => {
    expect(isSubagentSpawnTool('fs', '', true)).toBe(false);
    expect(isSubagentSpawnTool('shell', undefined, true)).toBe(false);
  });

  it('agent 其他动作不命中', () => {
    expect(isSubagentSpawnTool('agent', '{"action":"status"}')).toBe(false);
    expect(isSubagentSpawnTool('agent', '{"action":"kill"}')).toBe(false);
  });

  it('普通工具与坏 JSON 不命中且不抛异常', () => {
    expect(isSubagentSpawnTool('fs', '{"action":"write"}')).toBe(false);
    expect(isSubagentSpawnTool('agent', 'not-json')).toBe(false);
    expect(isSubagentSpawnTool('agent', '')).toBe(false);
  });
});
