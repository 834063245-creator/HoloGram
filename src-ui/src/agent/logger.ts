// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram UI 日志器 — 结构化 NDJSON 写入 .hologram/logs/ui.log
// 零外部依赖。通过 rpc('log_append') 写入。

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  message: string;
  ctx?: Record<string, unknown>;
}

let logPath: string | null = null;
let logBuffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
const MAX_BUFFER = 50;
const FLUSH_MS = 2000;

export async function initLogger(projectPath: string): Promise<void> {
  // 刷新旧 workspace 的剩余日志，然后清除旧定时器
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();

  try {
    logPath = `${projectPath}/.hologram/logs/ui.log`;
  } catch {
    logPath = null;
  }
  flushTimer = setInterval(flush, FLUSH_MS);
}

function buildEntry(level: LogLevel, module: string, message: string, ctx?: Record<string, unknown>): LogEntry {
  return { ts: new Date().toISOString(), level, module, message, ctx };
}

async function appendToFile(path: string, content: string): Promise<void> {
  try {
    const { typedRpc } = await import('../rpc-contract');
    await typedRpc('log_append', { path, content });
  } catch {
    // 日志写入失败静默忽略 — 日志不能破坏应用
  }
}

function write(entry: LogEntry): void {
  logBuffer.push(JSON.stringify(entry));
  if (logBuffer.length >= MAX_BUFFER) flush();
}

async function flush(): Promise<void> {
  if (logBuffer.length === 0 || !logPath) return;
  const batch = logBuffer.splice(0).join('\n') + '\n';
  logBuffer = [];
  try {
    await appendToFile(logPath, batch);
  } catch {
    // silent
  }
}

export const log = {
  debug(m: string, msg: string, ctx?: Record<string, unknown>) {
    write(buildEntry('debug', m, msg, ctx));
  },
  info(m: string, msg: string, ctx?: Record<string, unknown>) {
    write(buildEntry('info', m, msg, ctx));
  },
  warn(m: string, msg: string, ctx?: Record<string, unknown>) {
    write(buildEntry('warn', m, msg, ctx));
    console.warn(`[${m}] ${msg}`, ctx ?? '');
  },
  error(m: string, msg: string, ctx?: Record<string, unknown>) {
    write(buildEntry('error', m, msg, ctx));
    console.error(`[${m}] ${msg}`, ctx ?? '');
  },
};
