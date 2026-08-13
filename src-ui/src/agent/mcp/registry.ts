// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! MCP 工具注册 — 把外部 MCP server 工具包装成 ToolRegistry 里的 Tool。
//!
//! 命名规范：`mcp__<serverName>__<rawName>`，避免与本地 hologram 工具冲突。
//! 每个远端工具包装成 `Tool`：execute 走 McpClient.callTool（signal 支持取消），
//! readOnly 默认 true（外部工具大多只读；写入型由调用方按需覆盖）。

import type { Tool, ToolRegistry } from '../tool';
import type { McpClient } from './client';

interface RawMcpSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** 把远端 schema 包装成本地 Tool（执行经 McpClient，signal 透传支持取消）。 */
export function mcpClientTool(client: McpClient, schema: RawMcpSchema, execOverrides?: Partial<Tool>): Tool {
  const rawName = schema.name;
  const qualified = client.qualifiedName(rawName);
  const inputSchema = schema.inputSchema ?? { type: 'object', properties: {} };
  const required = inputSchema.required ?? [];
  return {
    name: () => qualified,
    description: () => schema.description ?? `(external MCP tool from ${client.server})`,
    parameters: () => ({
      type: 'object',
      properties: inputSchema.properties ?? {},
      required,
    }),
    readOnly: () => true,
    execute: async (args: Record<string, unknown>, onProgress?: (chunk: string) => void, signal?: AbortSignal) => {
      // 请求带 progressToken 触发服务器进度推送，桥接成 onProgress 文本块。
      const token = onProgress ? `tok-${rawName}-${Date.now()}` : undefined;
      const res = await client.callTool(rawName, args, signal, token);
      if (res.isError) {
        return `[MCP ${qualified} ERROR] ${res.text}`;
      }
      return res.text;
    },
    ...execOverrides,
  };
}

/** 把当前 client 的整组远端工具注册进 registry。返回注册的限定名集合。 */
export function registerMcpTools(client: McpClient, registry: ToolRegistry): string[] {
  const names: string[] = [];
  for (const schema of client.listRemoteTools()) {
    const tool = mcpClientTool(client, schema);
    try {
      registry.register(tool);
      names.push(tool.name());
    } catch {
      // 重名（多个 client 同 serverName）→ 跳过，避免注册冲突
    }
  }
  return names;
}

/** 卸载某 client 的远端工具（断开时调用）。 */
export function unregisterMcpTools(client: McpClient, registry: ToolRegistry): void {
  for (const schema of client.listRemoteTools()) {
    registry.unregister(client.qualifiedName(schema.name));
  }
}
