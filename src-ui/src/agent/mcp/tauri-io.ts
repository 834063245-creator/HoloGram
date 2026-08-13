// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! MCP / ACP 的 Tauri stdio 桥适配 — 把 Rust 侧 protocol_bridge 命令/事件包装成
//! ProcIO / 行 I/O，让 webview 里的 MCP client / ACP server 能驱动真实子进程。
//! 与 base transport / acp 解耦（它们保持纯逻辑、可测），本文件只在 Tauri 宿主组装。

import { typedListen, typedRpc } from '../../rpc-contract';
import type { AcpLineIO } from '../acp/server';
import type { ProcIO } from './transport';

/** 用 Rust protocol_bridge 起子进程并返回 ProcIO（webview 用）。spawn 完成后 resolve。 */
export async function createTauriProcIO(bridgeId: string, command: string, args: string[]): Promise<ProcIO> {
  await typedRpc('protocol_bridge_spawn', { id: bridgeId, command, args: args ?? [] });
  const lineCbs: Set<(line: string) => void> = new Set();
  const exitCbs: Set<(code: number | null) => void> = new Set();
  const unsubOut = await typedListen('protocol-bridge:output', (payload) => {
    if (payload.id !== bridgeId) return;
    for (const cb of lineCbs) cb(payload.line);
  });
  const unsubExit = await typedListen('protocol-bridge:exit', (payload) => {
    if (payload.id !== bridgeId) return;
    for (const cb of exitCbs) cb(0);
  });
  return {
    writeLine: (line) => {
      void typedRpc('protocol_bridge_write', { id: bridgeId, line });
    },
    onStdoutLine: (cb) => {
      lineCbs.add(cb);
      return () => {
        lineCbs.delete(cb);
      };
    },
    onExit: (cb) => {
      exitCbs.add(cb);
      return () => {
        exitCbs.delete(cb);
      };
    },
    kill: () => {
      try {
        unsubOut();
        unsubExit();
      } catch {
        // ignore
      }
      void typedRpc('protocol_bridge_kill', { id: bridgeId });
    },
  };
}

/** 用 Rust protocol_bridge 构造 ACP 行 I/O（webview 用）。 */
export async function createTauriAcpLineIO(bridgeId: string, command: string, args: string[]): Promise<AcpLineIO> {
  const proc = await createTauriProcIO(bridgeId, command, args);
  const pending: Array<(line: string) => void> = [];
  proc.onStdoutLine((line) => {
    const cb = pending.shift();
    if (cb) cb(line);
  });
  proc.onExit(() => {
    for (const cb of pending.splice(0)) cb('__eof__');
  });
  return {
    readLine() {
      return new Promise<string | null>((resolve) => {
        pending.push((line) => {
          resolve(line === '__eof__' ? null : line);
        });
      });
    },
    writeLine(line) {
      proc.writeLine(line);
    },
  };
}
