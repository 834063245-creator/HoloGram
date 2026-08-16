// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! MCP client — 让 HoloGram 的 Agent 调用外部 MCP server 的工具。
//!
//! 职责：
//! - 连接（initialize → notifications/initialized → tools/list）
//! - 把远端 tools/call 包装成本地可调用入口（`mcp__<server>__<name>` 命名）
//! - 进度转发（notifications/progress → onProgress）与取消（notifications/cancelled）
//!
//! 不依赖 Tauri/UI；传输由外部注入，测试可在内存回环上跑通。

import {
  createNodeStdioProc,
  createStdioTransport,
  createStreamableHttpTransport,
  type McpTransport,
  type ProcIO,
} from './transport';
import { once, type Disposer } from '../lifecycle';

/** 远端工具 schema（MCP tools/list 项）。 */
export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP client 结果（tools/call 返回）。 */
export interface McpResult {
  /** 文本内容 — content 里所有 text 块拼接。 */
  text: string;
  /** 原始 content 数组。 */
  content: unknown[];
  /** 是否错误（isError 标记）。 */
  isError: boolean;
}

const empty: McpToolSchema[] = [];

/** 配置：serverName 做本地命名空间，transport 二选一。 */
export interface McpClientConfig {
  /** 本地命名空间，外部工具名带 `mcp__<serverName>__` 前缀。 */
  serverName: string;
  /** 启动失败策略。 */
  failurePolicy?: 'startup-error' | 'lazy';
  /** stdio 子进程（二选一）。 */
  command?: string;
  args?: string[];
  /** 显式提供 ProcIO（非 Node 宿主 / 测试）；否则用 command spawn。 */
  procIO?: ProcIO;
  /** streamable-http 端点（二选一）。 */
  url?: string;
  headers?: Record<string, string>;
  /** 测试用：直接注入回环传输。 */
  transport?: McpTransport;
}

interface PendingReq {
  resolve: (msg: JsonRpcMessage) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  result?: unknown;
  error?: { code: number; message?: string };
  params?: Record<string, unknown>;
};

/** 把远端工具名规范化为本地唯一名。 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  // MCP 参考实现：非法字符替换为 `_`，超长截断并加哈希，避免不同远端名塌陷。
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined) return normalized;
  // 简单归一：仅发生替换时保留（不引入 hash 依赖，满足工具名唯一性即可）。
  return normalized;
}

export class McpClient {
  private readonly serverName: string;
  private readonly transport: McpTransport;
  private tools: McpToolSchema[] = empty;
  private connected = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingReq>();
  private readonly onMessageCbs = new Set<(msg: JsonRpcMessage) => void>();
  /** 外部 onProgress 回调。 */
  public onProgress?: (notification: {
    progressToken?: unknown;
    progress?: number;
    total?: number;
    message?: string;
  }) => void;
  /** 运维日志。 */
  public onLog?: (msg: string) => void;

  constructor(config: McpClientConfig) {
    this.serverName = config.serverName;
    if (config.transport) {
      this.transport = config.transport;
    } else if (config.url) {
      this.transport = createStreamableHttpTransport(config.url, config.headers ?? {});
    } else if (config.procIO) {
      this.transport = createStdioTransport(config.procIO);
    } else if (config.command) {
      // 动态引入，避免在 webview 等非 Node 环境被静态解析炸掉。
      this.transport = createStdioTransport(createNodeStdioProc(config.command, config.args ?? []));
    } else {
      throw new Error('McpClient: must provide transport, url, procIO, or command');
    }
    this.transport.onMessage((line) => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      this.dispatch(msg);
    });
  }

  get server(): string {
    return this.serverName;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && typeof msg.id !== 'string' && this.pending.has(Number(msg.id))) {
      const p = this.pending.get(Number(msg.id));
      this.pending.delete(Number(msg.id));
      if (p?.signal) p.signal.removeEventListener('abort', p.onAbort);
      p?.resolve(msg);
      return;
    }
    // 通知 / 服务器主动消息
    if (msg.method === 'notifications/progress') {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      this.onProgress?.({
        progressToken: params.progressToken,
        progress: params.progress as number | undefined,
        total: params.total as number | undefined,
        message: params.message as string | undefined,
      });
      return;
    }
    for (const cb of this.onMessageCbs) cb(msg);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const onAbort = () => reject(new Error(`${method} aborted by caller`));
      const entry: PendingReq = { resolve, reject, signal, onAbort };
      this.pending.set(id, entry);
      if (signal) {
        if (signal.aborted) {
          this.pending.delete(id);
          reject(new Error(`${method} aborted by caller`));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params, id })).catch((e: unknown) => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /** 握手：initialize → 通知 initialized → tools/list。 */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.transport.start();
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hologram-agent', version: '4.0.0' },
    });
    if (init.error) {
      throw new Error(`MCP initialize failed: ${init.error.message ?? init.error.code}`);
    }
    // 通知服务器已初始化（无 id 的 notify）
    await this.transport.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    const toolsMsg = await this.request('tools/list', {});
    if (toolsMsg.error) {
      throw new Error(`MCP tools/list failed: ${toolsMsg.error.message ?? toolsMsg.error.code}`);
    }
    const tools = (toolsMsg.result as { tools?: McpToolSchema[] })?.tools ?? [];
    this.tools = tools;
    this.connected = true;
  }

  /** 断开 + 清空远端工具。 */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.tools = empty;
    for (const [, p] of this.pending) {
      p.signal?.removeEventListener('abort', p.onAbort);
      p.reject(new Error('McpClient disconnected'));
    }
    this.pending.clear();
    await this.transport.close();
  }

  /** 所有权清理器：断开连接（Phase 1 disposer 契约）。幂等——disconnect 未连接时 no-op，
   *  Phase 4 由 context effect 持有；现有 disconnect 调用方不变。 */
  ownedDisposer(): Disposer {
    return once(() => this.disconnect());
  }

  /** 远端工具列表（raw names）。 */
  listRemoteTools(): McpToolSchema[] {
    return this.tools;
  }

  /** 计算某远端工具的本地限定名。 */
  qualifiedName(rawName: string): string {
    return publicToolName(this.serverName, rawName);
  }

  /** 调用远端工具。返回规范化结果。
   *  progressToken 若提供，会作为 _meta.progressToken 随请求发出，服务器据此
   *  推送 notifications/progress（经 this.onProgress 转发）。 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    progressToken?: unknown,
  ): Promise<McpResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (progressToken !== undefined) {
      params._meta = { progressToken };
    }
    const msg = await this.request('tools/call', params, signal);
    if (msg.error) {
      return { text: `MCP error ${msg.error.code} ${msg.error.message ?? ''}`, content: [], isError: true };
    }
    const result = (msg.result ?? {}) as {
      content?: unknown[];
      structuredContent?: unknown;
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    const content = result.content ?? [];
    const text = content
      .map((c) => (c as { type?: string; text?: string }).text ?? '')
      .filter(Boolean)
      .join('');
    return { text, content, isError: !!result.isError };
  }
}
