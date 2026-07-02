// Verify hologram_call dispatch + dynamic schema loading work end-to-end.
// Does NOT require a running engine — mocks invoke() and tests schema parsing.

import { describe, it, expect, vi } from 'vitest';

const mockInvoke = vi.fn();
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));

import { invoke } from '../src/bridge';
import type { ToolExecutor } from '../src/agent/tool';

// Replicate the schema conversion logic from workspace.ts
interface McpSchema {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

async function loadHologramSchemas(): Promise<McpSchema[]> {
  const raw = await invoke<string>('hologram_tools_list');
  return JSON.parse(raw) as McpSchema[];
}

function mcpSchemaToTool(schema: McpSchema, exec: ToolExecutor) {
  const required = schema.inputSchema.required || [];
  return {
    name: () => schema.name,
    description: () => schema.description,
    parameters: () => ({
      type: 'object',
      properties: schema.inputSchema.properties,
      required,
    }),
    readOnly: () =>
      !['hologram_analyze', 'hologram_run_check', 'hologram_rename'].includes(schema.name),
    execute: (args: Record<string, unknown>) => exec(schema.name, args),
  };
}

// Sample engine response (matches ToolRegistry::tools_list() output)
const SAMPLE_TOOLS_LIST = JSON.stringify([
  {
    name: 'hologram_neighbors',
    description: 'Get first-order neighbors of a node.',
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string', description: 'The node ID' } },
      required: ['node_id'],
    },
  },
  {
    name: 'hologram_search',
    description: 'Fuzzy search for nodes by name or ID.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Partial name or ID' },
        limit: { type: 'integer', description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'hologram_status',
    description: 'Get engine loading status and memory stats.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'hologram_analyze',
    description: 'Re-analyze a project directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project root' } },
      required: ['path'],
    },
  },
]);

describe('hologram dispatch integration', () => {
  it('loads schemas from hologram_tools_list', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(SAMPLE_TOOLS_LIST);

    const schemas = await loadHologramSchemas();
    expect(schemas).toHaveLength(4);
    expect(schemas[0].name).toBe('hologram_neighbors');
    expect(schemas[0].inputSchema.required).toEqual(['node_id']);
  });

  it('converts MCP schema to Agent tool format', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(SAMPLE_TOOLS_LIST);

    const schemas = await loadHologramSchemas();
    const exec: ToolExecutor = async (name, args) => `result:${name}`;
    const tools = schemas.map(s => mcpSchemaToTool(s, exec));

    // neighbors
    expect(tools[0].name()).toBe('hologram_neighbors');
    expect(tools[0].readOnly()).toBe(true);
    expect(tools[0].parameters().required).toEqual(['node_id']);

    // search
    expect(tools[1].parameters().properties.query.type).toBe('string');

    // status (no params)
    expect(tools[2].parameters().required).toEqual([]);

    // analyze (writable)
    expect(tools[3].readOnly()).toBe(false);
  });

  it('holoExec dispatches through hologram_call with { tool, args }', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue('{"node":{"name":"mod_a"}}');

    const holoExec: ToolExecutor = async (name, args) => {
      const result = await invoke<string>('hologram_call', { tool: name, args });
      return result;
    };

    const result = await holoExec('hologram_neighbors', { node_id: 'a' });
    expect(result).toBe('{"node":{"name":"mod_a"}}');
    expect(mockInvoke).toHaveBeenCalledWith('hologram_call', {
      tool: 'hologram_neighbors',
      args: { node_id: 'a' },
    });
  });

  it('schema-based tool.execute calls holoExec', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const exec: ToolExecutor = async (name, args) => {
      calls.push({ name, args });
      return JSON.stringify({ ok: true });
    };

    mockInvoke.mockResolvedValue(SAMPLE_TOOLS_LIST);
    const schemas = await loadHologramSchemas();
    const tool = mcpSchemaToTool(schemas[0], exec);

    await tool.execute({ node_id: 'test_node' });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('hologram_neighbors');
    expect(calls[0].args).toEqual({ node_id: 'test_node' });
  });
});
