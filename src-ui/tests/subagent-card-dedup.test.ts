import { describe, expect, it } from 'vitest';
import { isSubagentSpawnTool } from '../src/ui/chat-stream';

describe('isSubagentSpawnTool — 子 Agent 卡片去重', () => {
  it('旧名 agent_spawn 命中（跳过 ToolCard）', () => {
    expect(isSubagentSpawnTool('agent_spawn', '{"description":"x"}')).toBe(true);
    expect(isSubagentSpawnTool('agent_spawn', undefined)).toBe(true);
  });

  it('领域调用 agent(action=spawn) 命中', () => {
    expect(isSubagentSpawnTool('agent', '{"action":"spawn","description":"x"}')).toBe(true);
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
