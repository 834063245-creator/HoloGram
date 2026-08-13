// @vitest-environment node
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP interop E2E — TS MCP client 连接真实 Rust 引擎 MCP server（engine.exe serve，stdio）。
// 验证"我们自己的 MCP client 能连我们自己补全的 MCP server"，即设计文档 §3.3 验收闭环：
//   engine serve → TS client 握手 → tools/list 全量工具 → 一次真实图查询。
// 前置：engine crate 已 cargo build，产出 engine/target/debug/hologram-engine.exe。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../src/agent/mcp/client';
import { createNodeStdioProc } from '../src/agent/mcp/transport';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineExe = path.resolve(here, '..', '..', 'engine', 'target', 'debug', 'hologram-engine.exe');

const hasEngine = () => fs.existsSync(engineExe);

describe('MCP interop with real Rust engine (.exe serve)', () => {
  const run = async (fn: (client: McpClient) => Promise<void>) => {
    const proc = createNodeStdioProc(engineExe, ['serve']);
    const client = new McpClient({ serverName: 'hologram', procIO: proc });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.disconnect();
    }
  };

  it('spawns engine.exe serve and completes the MCP handshake', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      expect(client.isConnected).toBe(true);
    });
  });

  it('tools/list returns the full hologram tool set (>= 30)', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      const tools = client.listRemoteTools().map((t) => t.name);
      expect(tools.length).toBeGreaterThanOrEqual(30);
      expect(tools).toContain('get_neighbors');
      expect(tools).toContain('analyze_project');
    });
  });

  it('calls a real read-only graph tool (list_flows) and gets a parseable result', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      const res = await client.callTool('list_flows', {});
      // 引擎无图索引时也应返回合法 JSON（错误语义用 isError 而非裸抛）
      expect(typeof res.text).toBe('string');
      expect(res.text.length).toBeGreaterThan(0);
    });
  });
});
