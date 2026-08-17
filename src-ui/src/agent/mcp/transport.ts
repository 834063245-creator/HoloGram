// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! MCP client 传输层 — 屏蔽 stdio / streamable-http / 内存测试回环。

/**
 * 传输接口：发送一行 JSON-RPC，逐行回调收到的 JSON-RPC 消息（请求/响应/通知）。
 * 本层只负责可靠的字节/消息搬运与生命周期；JSON-RPC 语义在 client.ts。
 */
export interface McpTransport {
  /** 发送一行完整 JSON-RPC 消息（不含换行）。失败 reject。 */
  send(line: string): Promise<void>;
  /** 订阅来自服务器的行（响应与通知）。返回退订函数。 */
  onMessage(cb: (line: string) => void): () => void;
  /** 启动就绪。 */
  start(): Promise<void>;
  /** 关闭传输。 */
  close(): Promise<void>;
}

/** stdio 子进程的对象接口 — 允许测试注入 fake，也允许宿主把 Rust 桥包装成同形状。 */
export interface ProcIO {
  /** 向子进程 stdin 写一行（不含换行）。 */
  writeLine(line: string): void;
  /** 订阅子进程 stdout 的一行。 */
  onStdoutLine(cb: (line: string) => void): () => void;
  /** 子进程退出/连接关闭。 */
  onExit(cb: (code: number | null) => void): () => void;
  /** 关闭子进程。 */
  kill(): void;
}

/** Node child_process 模块的最小形状（避免全量 @types/node 依赖）。 */
interface NodeChildLike {
  stdout: { setEncoding(enc: string): void; on(ev: 'data', cb: (d: string) => void): void } | null;
  stdin: { write(s: string): boolean } | null;
  on(ev: 'close', cb: (code: number | null) => void): void;
  kill(): void;
}
interface NodeChildProcessModule {
  spawn(command: string, args: string[], opts: { stdio: Array<'pipe' | 'inherit'>; windowsHide?: boolean }): NodeChildLike;
}

/** 解析 child_process 模块（Node）。webview / 非 Node 宿主 → null，调用方应注入 ProcIO。 */
function loadChildProcess(): unknown {
  // Node 20+ 提供 process.getBuiltinModule，ESM/CJS 都可靠。
  const g = globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } };
  if (g.process?.getBuiltinModule) {
    try {
      return g.process.getBuiltinModule('child_process') as (m: string) => unknown;
    } catch {
      // fall through
    }
  }
  // CJS require 回退
  const cp = (globalThis as { require?: (m: string) => unknown }).require;
  return cp ?? null;
}

/** 用 Node child_process 起 stdio 子进程。非 Node 宿主（Tauri webview）应注入自己的 ProcIO。 */
export function createNodeStdioProc(command: string, args: string[]): ProcIO {
  const child_process = loadChildProcess();
  if (!child_process) {
    throw new Error('child_process unavailable in this runtime — supply a ProcIO for non-Node hosts');
  }
  // windowsHide: true 防 Windows 弹窗（Node 宿主下本函数直接 spawn；
  // Tauri webview 走 tauri-io → Rust protocol_bridge，那边已强制 HIDDEN_CONSOLE）
  const child = (child_process as NodeChildProcessModule).spawn(command, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const lineCbs: Array<(line: string) => void> = [];
  const exitCbs: Array<(code: number | null) => void> = [];
  let buf = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => {
    buf += d;
    for (;;) {
      const idx = buf.indexOf('\n');
      if (idx < 0) break;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const line = raw.replace(/\r$/, '');
      if (line.trim().length === 0) continue;
      for (const cb of lineCbs) cb(line);
    }
  });
  child.on('close', (code: number | null) => {
    for (const cb of exitCbs) cb(code);
    lineCbs.length = 0;
  });
  return {
    writeLine: (l) => child.stdin?.write(l + '\n'),
    onStdoutLine: (cb) => {
      lineCbs.push(cb);
      return () => {
        const i = lineCbs.indexOf(cb);
        if (i >= 0) lineCbs.splice(i, 1);
      };
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return () => {
        const i = exitCbs.indexOf(cb);
        if (i >= 0) exitCbs.splice(i, 1);
      };
    },
    kill: () => child.kill(),
  };
}

/** stdio 传输：通过 ProcIO 搬运 JSON-RPC 行。 */
export function createStdioTransport(proc: ProcIO): McpTransport {
  const cbs: Set<(line: string) => void> = new Set();
  const exitCbs: Set<() => void> = new Set();
  const unsubOut = proc.onStdoutLine((line) => {
    for (const cb of cbs) cb(line);
  });
  const unsubExit = proc.onExit((_code: number | null) => {
    for (const cb of exitCbs) cb();
  });
  return {
    async send(line: string) {
      proc.writeLine(line);
    },
    onMessage(cb: (line: string) => void) {
      cbs.add(cb);
      return () => {
        cbs.delete(cb);
      };
    },
    async start() {
      /* 子进程已由 spawn 启动 */
      return Promise.resolve();
    },
    async close() {
      unsubOut();
      unsubExit();
      proc.kill();
    },
  };
}

/** streamable-http 传输：用 fetch POST JSON-RPC（webview / Node 皆可用）。 */
export function createStreamableHttpTransport(url: string, headers: Record<string, string>): McpTransport {
  const cbs: Set<(line: string) => void> = new Set();
  return {
    async send(line: string) {
      const msg = JSON.parse(line);
      const id = msg.id;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: line,
        });
        if (!res.ok) {
          emitIdError(cbs, id, res.status, res.statusText);
          return;
        }
        const ctype = res.headers.get('content-type') || '';
        if (ctype.includes('text/event-stream')) {
          const reader = res.body?.getReader();
          if (!reader) return;
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            for (;;) {
              const idx = buf.indexOf('\n');
              if (idx < 0) break;
              const seg = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (seg.startsWith('data:')) {
                const payload = seg.slice(5).trim();
                if (payload) for (const cb of cbs) cb(payload);
              }
            }
          }
        } else {
          parseJsonLines(await res.text(), cbs);
        }
      } catch (e: unknown) {
        emitIdError(cbs, id, -32000, String(e && (e as Error).message ? (e as Error).message : e));
      }
    },
    onMessage(cb) {
      cbs.add(cb);
      return () => {
        cbs.delete(cb);
      };
    },
    async start() {
      return Promise.resolve();
    },
    async close() {
      cbs.clear();
      return Promise.resolve();
    },
  };
}

function emitIdError(cbs: Set<(line: string) => void>, id: unknown, code: number, message: string): void {
  for (const cb of cbs) cb(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
}

function parseJsonLines(text: string, cbs: Set<(line: string) => void>): void {
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    for (const cb of cbs) cb(t);
  }
}

/** 测试用回环传输：把 JSON-RPC 行发给一个内存处理器，逐行返回其响应。 */
export function createLoopbackTransport(handler: (line: string) => string[] | string): McpTransport {
  const cbs: Set<(line: string) => void> = new Set();
  return {
    async send(line: string) {
      const out = handler(line);
      const lines = Array.isArray(out) ? out : [out];
      for (const l of lines) {
        if (!l) continue;
        for (const cb of cbs) cb(l);
      }
    },
    onMessage(cb) {
      cbs.add(cb);
      return () => {
        cbs.delete(cb);
      };
    },
    async start() {
      return Promise.resolve();
    },
    async close() {
      cbs.clear();
      return Promise.resolve();
    },
  };
}
