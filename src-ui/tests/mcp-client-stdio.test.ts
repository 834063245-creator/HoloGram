// @vitest-environment node
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP client 真实 stdio 集成测试 — 用 Node 起真实 MCP 测试 server 子进程，
// TS client 经 createNodeStdioProc 走真实 stdio 传输握手/列工具/调工具/收进度。
// 验证"真传输穿通"，不只是回环单测。注意：只 import 纯 client/transport，
// 不拉 agent/tool（后者引 window，需 jsdom 环境）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../src/agent/mcp/client';
import { createNodeStdioProc } from '../src/agent/mcp/transport';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'mcp-server.cjs');

describe('McpClient over real stdio', () => {
  it('handshakes, lists tools, calls tools, and reports unknown-tool errors', async () => {
    const proc = createNodeStdioProc(process.execPath, [FIXTURE]);
    const client = new McpClient({ serverName: 'fix', procIO: proc });
    await client.connect();
    expect(client.isConnected).toBe(true);

    const tools = client.listRemoteTools().map((t) => t.name);
    expect(tools).toContain('greet');
    expect(tools).toContain('add');

    const res = await client.callTool('greet', { name: 'world' });
    expect(res.text).toBe('hello world');
    expect(res.isError).toBe(false);

    const sum = await client.callTool('add', { a: 2, b: 3 });
    expect(sum.text).toBe('sum=5');

    const unk = await client.callTool('nope', {});
    expect(unk.isError).toBe(true);

    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('forwards server progress notifications to onProgress during a slow tool call', async () => {
    const proc = createNodeStdioProc(process.execPath, [FIXTURE]);
    const client = new McpClient({ serverName: 'fix', procIO: proc });
    await client.connect();
    const progress: string[] = [];
    client.onProgress = (n) => {
      if (n.message) progress.push(n.message);
    };
    // 带 progressToken 请求 slow → 服务器推 halfway → client.onProgress 收到
    await client.callTool('slow', {}, undefined, 'tok-test');
    // slow 完成
    const out = await client.callTool('slow', {}, undefined, 'tok-test2');
    expect(out.text).toContain('done slowly');
    expect(progress.some((p) => p.includes('halfway'))).toBe(true);
    await client.disconnect();
  });
});
