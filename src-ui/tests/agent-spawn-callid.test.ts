import { describe, expect, it } from 'vitest';
import { type AgentEvent, EventKind } from '../src/agent/agent-types';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';

// ── Helpers ──

function makeSpawnTool(onExecute: (args: Record<string, unknown>) => Promise<string>): Tool {
  return {
    name: () => 'agent_spawn',
    description: () => 'spawn sub-agent',
    parameters: () => ({
      type: 'object',
      properties: { description: { type: 'string' }, prompt: { type: 'string' } },
      required: ['description', 'prompt'],
    }),
    readOnly: () => false,
    execute: async (args) => onExecute(args),
  };
}

// ── Tests ──

describe('StreamingToolExecutor — agent_spawn _callId injection', () => {
  it('streaming path injects _callId into agent_spawn args', async () => {
    const receivedArgs: Record<string, unknown>[] = [];
    const tool = makeSpawnTool(async (args) => {
      receivedArgs.push({ ...args });
      return JSON.stringify({ task_id: 't1', status: 'started' });
    });
    const registry = new ToolRegistry();
    registry.register(tool);

    const events: AgentEvent[] = [];
    const sink = (ev: AgentEvent) => {
      events.push(ev);
    };

    const executor = new StreamingToolExecutor(registry, sink, null, null);
    executor.addTool({ id: 'call-42', name: 'agent_spawn', arguments: '{"description":"test","prompt":"hello"}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);

    // The tool should receive _callId = call.id
    expect(receivedArgs).toHaveLength(1);
    expect(receivedArgs[0]._callId).toBe('call-42');
    expect(receivedArgs[0].description).toBe('test');
    expect(receivedArgs[0].prompt).toBe('hello');
  });

  it('streaming path does NOT inject _callId for non-agent_spawn tools', async () => {
    const receivedArgs: Record<string, unknown>[] = [];
    const tool: Tool = {
      name: () => 'read_file_content',
      description: () => 'read file',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      execute: async (args) => {
        receivedArgs.push({ ...args });
        return 'content';
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const executor = new StreamingToolExecutor(registry, () => {}, null, null);
    executor.addTool({ id: 'call-99', name: 'read_file_content', arguments: '{"filePath":"/test.txt"}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(receivedArgs).toHaveLength(1);
    expect(receivedArgs[0]._callId).toBeUndefined();
  });

  it('agent_spawn ToolDispatch event has correct call id', async () => {
    const tool = makeSpawnTool(async () => JSON.stringify({ task_id: 't2' }));
    const registry = new ToolRegistry();
    registry.register(tool);

    const events: AgentEvent[] = [];
    const sink = (ev: AgentEvent) => {
      events.push(ev);
    };

    const executor = new StreamingToolExecutor(registry, sink, null, null);
    executor.addTool({ id: 'call-7', name: 'agent_spawn', arguments: '{"description":"d","prompt":"p"}' });

    await executor.awaitRemaining();

    // Should have ToolDispatch + ToolResult events
    const dispatch = events.find((e) => e.kind === EventKind.ToolDispatch);
    expect(dispatch).toBeDefined();
    expect(dispatch?.tool?.id).toBe('call-7');
    expect(dispatch?.tool?.name).toBe('agent_spawn');
  });
});
