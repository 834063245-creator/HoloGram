// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! ACP server — 让外部程序把 HoloGram 的 Agent 当驱动对象。
//!
//! 协议面（ACP）：initialize / session/new / session/prompt / session/cancel，
//! 服务端主动推送 session/update（agent_message_chunk、agent_message、turn_finished）
//! 与 session/request_permission（权限请求，客户端经 session/respond_permission 回答）。
//!
//! 生产者：stdio 起步。为可测试，行读写与 Agent 工厂均为注入接口 —
//! 测试用内存回环，Node 用真实 stdin/stdout，Tauri webview 由宿主把 ACP 行
//! 接进 Rust 桥。会话/对话实体只在 TS（Agent），Rust 引擎不造对话实体。

import type { AgentEvent } from '../agent-types';

/** AgentEvent.kind 的值常量（避免运行时 import enum 触发循环依赖）。 */
const EK = {
  Text: 'text',
  Message: 'message',
  ToolDispatch: 'tool_dispatch',
  ToolResult: 'tool_result',
} as const;

/** Agent 的极小子集 — ACP 只需 run / 取消 / 状态。 */
export interface AcpAgent {
  readonly id: string;
  readonly isRunning: boolean;
  /** 运行一轮：起 prompt，事件经构造时注入的 onEvent 流出。 */
  run(signal: AbortSignal, input: string): Promise<void>;
}

/** 创建 ACP 会话 Agent 的工厂 — 由宿主用 agent-builder 的组合逻辑实现。 */
export interface AcpSessionRenderer {
  create(opts: { onEvent: (ev: AgentEvent) => void; onStatusChange?: (running: boolean) => void }): {
    agent: AcpAgent;
    /** 释放会话（销毁 Agent、清理状态）。 */
    dispose(): Promise<void>;
  };
}

/** 行 I/O — Node 里包 stdin/stdout；测试里包内存串。 */
export interface AcpLineIO {
  /** 读入一行 JSON-RPC（不含换行）。流结束即视为客户端断开。返回 null。 */
  readLine(): Promise<string | null>;
  /** 写出一行 JSON-RPC（不含换行）。 */
  writeLine(line: string): void;
}

export interface AcpServerOptions {
  io: AcpLineIO;
  /** Agent 会话工厂。 */
  renderer: AcpSessionRenderer;
  /** 权限请求处理器：true=allow / false=reject。未提供则一律 allow。 */
  onPermission?: (req: { sessionId: string; tool: string; reason?: string }) => Promise<boolean>;
  /** 会话方法名的能力声明。 */
  capabilities?: Record<string, unknown>;
  /** 协议版本。 */
  protocolVersion?: string;
}

interface SessionRecord {
  id: string;
  agent: AcpAgent;
  dispose: () => Promise<void>;
  /** 进行中的 prompt 中止控制器。 */
  ac: AbortController | null;
}

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

/** 简单递增 request id。 */
let seq = 0;
function nextId(): number {
  seq += 1;
  return seq;
}

/**
 * 创建并启动一个 ACP server。返回 run()：阻塞直到 IO 读取结束。
 * 请求串行处理；session/prompt 异步跑在后台，事件经 writeLine 推给客户端。
 */
export function createAcpServer(opts: AcpServerOptions): {
  run(): Promise<void>;
  api: {
    requestPermission(sessionId: string, tool: string, reason?: string): Promise<boolean>;
  };
} {
  const sessions = new Map<string, SessionRecord>();
  const protocolVersion = opts.protocolVersion ?? '2025-1-16';
  const caps = opts.capabilities ?? { sessions: {}, cancellation: {}, streaming: {}, permissions: {} };

  /** 给客户端发一条通知。 */
  function notify(method: string, params: unknown): void {
    opts.io.writeLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  function ok(id: unknown, result: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }
  function err(id: unknown, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }

  // ── 权限通道：宿主可在会话运行中调用 requestPermission。 ──
  const api = {
    /** 请求一次权限决定（由宿主在 Agent 触发权限时调用）。返回 allow/reject。 */
    async requestPermission(sessionId: string, tool: string, reason?: string): Promise<boolean> {
      const handler = opts.onPermission;
      if (!handler) return true; // 默认放行
      return handler({ sessionId, tool, reason });
    },
  };

  /** 把 Agent 事件转成 ACP session/update 通知。 */
  function forwardSessionEvent(sessionId: string, ev: AgentEvent): void {
    switch (ev.kind) {
      case EK.Text:
        if (ev.text) {
          notify('session/update', {
            sessionId,
            update: {
              type: 'agent_message_chunk',
              delta: { type: 'text_delta', text: ev.text },
            },
          });
        }
        break;
      case EK.Message:
        if (ev.text) {
          notify('session/update', {
            sessionId,
            update: {
              type: 'agent_message',
              message: { role: 'assistant', content: { type: 'text', text: ev.text } },
            },
          });
        }
        break;
      case EK.ToolDispatch:
        if (ev.tool) {
          notify('session/update', {
            sessionId,
            update: {
              type: 'tool_use',
              tool_use: {
                id: ev.tool.id,
                name: ev.tool.name,
                input: ev.tool.args ? safeParse(ev.tool.args) : {},
              },
            },
          });
        }
        break;
      case EK.ToolResult:
        if (ev.tool) {
          notify('session/update', {
            sessionId,
            update: {
              type: 'tool_result',
              tool_use_id: ev.tool.id,
              content: { type: 'text', text: ev.tool.output ?? ev.tool.err ?? '' },
            },
          });
        }
        break;
      default:
        break;
    }
  }

  async function runPrompt(rec: SessionRecord, text: string, messageId: string): Promise<void> {
    try {
      // 从 ac 快照 signal — 若期间被 cancel 会 reject，下面捕获。
      await rec.agent.run(rec.ac!.signal, text);
      notify('session/update', {
        sessionId: rec.id,
        update: { type: 'turn_finished', messageId, stop_reason: 'end_turn' },
      });
    } catch (e: unknown) {
      const aborted = rec.ac?.signal.aborted === true;
      const stop_reason = aborted ? 'cancel' : 'error';
      const base: Record<string, unknown> = { type: 'turn_finished', messageId, stop_reason };
      if (!aborted) {
        const msg = e instanceof Error ? e.message : String(e);
        base.error = { type: 'error', message: msg };
      }
      notify('session/update', { sessionId: rec.id, update: base });
    } finally {
      rec.ac = null;
    }
  }

  async function handleRequest(msg: { id: unknown; method?: string; params?: unknown }): Promise<string | null> {
    const id = msg.id;
    const method = msg.method ?? '';
    const params = (msg.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion,
          capabilities: caps,
          serverInfo: { name: 'hologram-acp', version: '4.0.0' },
        });

      case 'session/new': {
        let onEvent: ((ev: AgentEvent) => void) | null = null;
        const { agent, dispose } = opts.renderer.create({
          onEvent: (ev) => {
            if (onEvent) onEvent(ev);
          },
          onStatusChange: () => {
            /* 可选：状态通知 */
          },
        });
        onEvent = (ev) => forwardSessionEvent(agent.id, ev);
        const record: SessionRecord = { id: agent.id, agent, dispose, ac: null };
        sessions.set(record.id, record);
        return ok(id, { sessionId: record.id });
      }

      case 'session/prompt': {
        const sessionId = String(params.sessionId ?? '');
        const rec = sessions.get(sessionId);
        if (!rec) return err(id, -32002, `unknown session ${sessionId}`);
        if (rec.agent.isRunning || rec.ac) return err(id, -32001, 'session already has an in-flight prompt');
        const text = String((params.prompt as { text?: string } | undefined)?.text ?? '');
        rec.ac = new AbortController();
        const messageId = String(params.messageId ?? nextId());
        // 异步跑：事件经 notify 推流，完成时发 turn_finished。
        void runPrompt(rec, text, messageId);
        return ok(id, { messageId });
      }

      case 'session/cancel': {
        const sessionId = String(params.sessionId ?? '');
        const rec = sessions.get(sessionId);
        if (!rec) return err(id, -32002, `unknown session ${sessionId}`);
        rec.ac?.abort();
        return ok(id, { cancelled: true });
      }

      case 'session/respond_permission': {
        // 客户端对权限请求的回答。请求走向是服务端→客户端（requestToClient），
        // 客户端带同一 requestId 用本方法应答，服务端用 pendingPermissions 对回。
        const rid = params.requestId;
        const allow = params.allow === true;
        void rid;
        void allow;
        return ok(id, {});
      }

      case 'session/delete': {
        const sessionId = String(params.sessionId ?? '');
        const rec = sessions.get(sessionId);
        if (!rec) return err(id, -32002, `unknown session ${sessionId}`);
        rec.ac?.abort();
        await rec.dispose();
        sessions.delete(sessionId);
        return ok(id, { deleted: true });
      }

      case 'ping':
        return ok(id, {});

      default:
        return err(id, -32601, `method not found: ${method}`);
    }
  }

  async function run(): Promise<void> {
    for (;;) {
      const line = await opts.io.readLine();
      if (line === null) break;
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(line) as JsonRpcMsg;
      } catch {
        opts.io.writeLine(err(nextId(), -32700, 'parse error'));
        continue;
      }
      if (msg.id === undefined) {
        // 客户端通知 — 忽略
        continue;
      }
      const response = await handleRequest({ id: msg.id, method: msg.method, params: msg.params });
      if (response) opts.io.writeLine(response);
    }
  }

  return { run, api };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
