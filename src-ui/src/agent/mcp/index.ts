// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! MCP client 模块出口。

export type { McpClientConfig, McpResult, McpToolSchema } from './client';
export { McpClient, publicToolName } from './client';
export { mcpClientTool, registerMcpTools, unregisterMcpTools } from './registry';
export type { McpTransport, ProcIO } from './transport';
export {
  createLoopbackTransport,
  createNodeStdioProc,
  createStdioTransport,
  createStreamableHttpTransport,
} from './transport';
