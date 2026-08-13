// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP client 测试 — 用内存回环传输连一个 fake MCP server，验证握手/工具列表/调用/错误。

import { describe, expect, it } from 'vitest';
import { McpClient, publicToolName } from '../src/agent/mcp/client';
import { mcpClientTool, registerMcpTools } from '../src/agent/mcp/registry';
import { createLoopbackTransport } from '../src/agent/mcp/transport';
import { ToolRegistry } from '../src/agent/tool';

/** 构造一个 fake MCP server 的响应处理器（回环，同步返回）。 */
function makeFakeServer() {
  const handler = (line: string): string[] => {
    const req = JSON.parse(line);
    const id = req.id;
    if (id === undefined) return []; // notification
    const method = req.method;
    if (method === 'initialize') {
      return [
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1.0' },
          },
        }),
      ];
    }
    if (method === 'tools/list') {
      return [
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'echo back',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
              },
              { name: 'boom', description: 'always errors', inputSchema: { type: 'object', properties: {} } },
            ],
          },
        }),
      ];
    }
    if (method === 'tools/call') {
      const name = req.params.name;
      if (name === 'echo') {
        const text = req.params.arguments?.text ?? '';
        return [JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo:${text}` }] } })];
      }
      if (name === 'boom') {
        return [JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], isError: true } })];
      }
      return [JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } })];
    }
    return [JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } })];
  };
  return { handler };
}

describe('McpClient', () => {
  it('publicToolName prefixes with mcp__server__', () => {
    expect(publicToolName('repo', 'get_file')).toBe('mcp__repo__get_file');
  });

  it('connects, lists tools, and calls a tool via loopback transport', async () => {
    const fake = makeFakeServer();
    const client = new McpClient({
      serverName: 'fake',
      transport: createLoopbackTransport(fake.handler),
    });
    await client.connect();
    expect(client.isConnected).toBe(true);
    expect(client.listRemoteTools().map((t) => t.name)).toEqual(['echo', 'boom']);

    const res = await client.callTool('echo', { text: 'hi' });
    expect(res.text).toBe('echo:hi');
    expect(res.isError).toBe(false);

    const err = await client.callTool('boom', {});
    expect(err.isError).toBe(true);

    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('registers remote tools into a ToolRegistry with qualified names', async () => {
    const fake = makeFakeServer();
    const client = new McpClient({
      serverName: 'repo',
      transport: createLoopbackTransport(fake.handler),
    });
    await client.connect();
    const registry = new ToolRegistry();
    const names = registerMcpTools(client, registry);
    expect(names).toContain('mcp__repo__echo');
    expect(registry.get('mcp__repo__echo')).toBeDefined();

    const tool = registry.get('mcp__repo__echo')!;
    expect(tool.readOnly()).toBe(true);
    const out = await tool.execute({ text: 'yo' });
    expect(out).toContain('echo:yo');
  });

  it('calls a wrapped tool with signal support', async () => {
    const fake = makeFakeServer();
    const client = new McpClient({
      serverName: 'repo',
      transport: createLoopbackTransport(fake.handler),
    });
    await client.connect();
    const tool = mcpClientTool(client, client.listRemoteTools()[0]);
    const ac = new AbortController();
    const out = await tool.execute({ text: 'x' }, undefined, ac.signal);
    expect(out).toContain('echo:x');
  });
});
