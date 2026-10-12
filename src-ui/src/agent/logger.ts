// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 兰台 UI 日志器 — 结构化 NDJSON 写入 .lantai/logs/ui.log
// 零外部依赖。通过 rpc('log_append') 写入。
//
// ⚡ 2026-09-27 日志可观测性批 1：本文件从「唯一的写口」升为**两层**——
//   传输层（本文件：缓冲 / flush / 落盘）不动，之上加事件层 `agent/obs.ts`
//   （公共字段 + 唯一脱敏点 + 事件名规范）。旧 `log.debug/info/warn/error`
//   调用**零迁移**（本批零回归面）：它们只是多了一个**可选的第 4 参** `extra`
//   （event/ids/dur_ms/out/err/build/truncated），不传 = 逐字节同旧行为。
//   ⚡ 事件字段**搭既有 `log.*` 而不是另开写口**是刻意的：`log.*` 是本仓库测试
//   替身（vi.mock logger）唯一复现过的写面——另开导出会让几十处替身当场缺键
//   （写口 undefined），而那是**测试替身与模块面不一致**的问题，不该由产品面
//   替它兜。形态上也不发明第二套写 API。
//   立项理由见 docs/plans/log-observability-plan.md。
//
// ⚡ 2026-10-12 日志可观测性批 3：本文件再添两件事——
//   ① **级别过滤与运行时开关**（`debug` 默认丢弃）：事故那份 1158 行 log 里
//      1024 行是同一条无 `method` 的 `invoke` debug 行（88%）——**信号被自己的
//      噪声淹了**。优先级 `LANTAI_LOG_LEVEL`（壳读 → `log_level_hint` RPC）
//      > `localStorage['lantai.log.level']` > 默认 `info`；级别与来源由
//      `obs.boot` 的 `log_level` / `log_level_source` 如实上报。
//   ② **健康度**（丢条计数）：写失败此前静默吞掉 ⇒「日志里没有」分不清
//      「没发生」与「写不出去」（事故里两条 `denied: outside project root`
//      就是这样丢的现场）。现在失败计数 + 首次 `console.error`，下一条成功
//      写入补一条 `log.self{dropped:N}`。

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 落盘条目。前五个字段是历史形状（解析器依赖），其余为 obs 事件层扩展。 */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  message: string;
  ctx?: Record<string, unknown>;
  /** ASCII 点分稳定事件名（`boot` / `config.load` / `llm.error` / `turn.failed`…）。
   *  ⚡ 不用中文句子当事件名——事件名是**判据**，文案是给人读的（两者混同正是
   *  本次事故里「日志答不了问题」的一半原因）。 */
  event?: string;
  /** 会话/回合/运行身份（哪个卷、哪一轮、哪条运行记录）。 */
  ids?: Record<string, unknown>;
  /** 耗时（毫秒）——有起止的事件才带。 */
  dur_ms?: number;
  /** 结局：`ok` / `fail` / `miss` / `hit` / `skip`。 */
  out?: string;
  /** 失败结构化面：`{kind,status,phase,raw}`（raw = 原始错误文本，经脱敏）。 */
  err?: Record<string, unknown>;
  /** 构建锚：`{v,commit}` —— 收到的 log 靠它定位代码（事故里只能靠「有无
   *  method 字段」反推壳的构建时间，这是补上这一课）。 */
  build?: Record<string, unknown>;
  /** 条目超过 4KB 上限被截断（截断后仍是一条可读记录，不是丢弃）。 */
  truncated?: boolean;
}

let logPath: string | null = null;
let logBuffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
const MAX_BUFFER = 50;
const FLUSH_MS = 2000;

// ── 级别过滤与运行时开关（批 3）──────────────────────────────────────
//
// 优先级：`LANTAI_LOG_LEVEL` 环境变量（壳读 → `log_level_hint` RPC 递进来）
// > `localStorage['lantai.log.level']` > 默认 `info`。
// 环境变量优先是因为它**当前是唯一不需要 UI 的开关**（设置页开关留到下一批）：
// `LANTAI_LOG_LEVEL=debug` 放进启动环境即得全量日志。

/** 级别序（越大越安静；过滤判据 = 条目级别 ≥ 当前级别）。 */
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 缺省级别——`debug` 默认丢弃（噪声源，见文件头注）。 */
const DEFAULT_LEVEL: LogLevel = 'info';

/** 运行时可调开关的 localStorage 键（设置页 UI 开关留到下一批）。 */
export const LOG_LEVEL_STORAGE_KEY = 'lantai.log.level';

/** 级别是从哪来的（诊断面读数，上报在 `obs.boot` 的 `log_level_source`）。 */
export type LogLevelSource = 'env' | 'storage' | 'default';

let minLevel: LogLevel = DEFAULT_LEVEL;
let levelSource: LogLevelSource = 'default';

/** 规范化级别名（大小写 / 空白容错）；认不出回 null——**不猜**：猜错会把
 *  「我明明设了 debug」变成更难查的形态（与 boot_log.rs 的 `level_from` 同判）。 */
function normalizeLevel(raw: unknown): LogLevel | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : null;
}

/** localStorage 里的级别意图（读不到 / 坏值 / 存储被禁 → null）。 */
function storedLevel(): LogLevel | null {
  try {
    return normalizeLevel(globalThis.localStorage?.getItem(LOG_LEVEL_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 当前级别与来源（诊断面：`obs.boot` 读它——「这份 log 里没有 debug 行，
 *  是没发生还是被挡了」必须能答）。 */
export function logLevel(): { level: LogLevel; source: LogLevelSource } {
  return { level: minLevel, source: levelSource };
}

/** `LANTAI_LOG_LEVEL` 的壳侧读数（空串 = 未设 / 认不出 / IPC 不通）。
 *  动态 import rpc-contract：与 appendToFile 同一条纪律（本模块不静态依赖 rpc 层）。 */
async function shellLevelHint(): Promise<string> {
  try {
    const { typedRpc } = await import('../rpc-contract');
    const raw = await typedRpc('log_level_hint', {});
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/**
 * 解析并应用日志级别（env > localStorage > 默认）。**幂等**——改完 localStorage
 * 再调一次即生效（下一批的设置页开关走的就是这条路）。
 *
 * ⚡ 时序：调用点必须在 `initLogger` **之前**调（见 workspace.ts）——否则级别就位
 * 之前的条目会按旧级别判（该丢的写了 / 该留的丢了）。
 * 本函数**不抛**（读不到环境变量不是失败，是回落）。
 */
export async function applyLogLevelFromShell(): Promise<void> {
  const env = normalizeLevel(await shellLevelHint());
  const stored = storedLevel();
  if (env) {
    minLevel = env;
    levelSource = 'env';
  } else if (stored) {
    minLevel = stored;
    levelSource = 'storage';
  } else {
    minLevel = DEFAULT_LEVEL;
    levelSource = 'default';
  }
}

/** 该不该写（级别过滤——`debug` 默认丢弃）。 */
function shouldWrite(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

// ── 日志健康度（批 3）────────────────────────────────────────────────
//
// 「日志里没有」有两种可能：**没发生**，或**写不出去**。旧的 appendToFile 把
// 失败静默吞掉 ⇒ 第二种在用户侧不可分辨。故：失败计数 + 首次 console.error，
// 下一条成功写入补一条 `log.self{dropped:N}`。
//
// ⚡ `log.self` 由本文件直接写、不经 `obs.ts` 门面：import 方向是 logger ← obs
// （单向），反向调用会成环；且本条载荷只有级别名与计数（无用户文本），不需要
// 过脱敏。事件名登记在 obs.ts 的事件表与 `docs/design/log-observability-spec.md` §2。

/** 丢条账：一次写失败丢**一整批**，按条目数累加。 */
let droppedEntries = 0;
/** 本次失败是否已 console 过（首次留痕，之后交给计数——不刷屏）。 */
let firstDropReported = false;

export async function initLogger(projectPath: string): Promise<void> {
  // 刷新旧 workspace 的剩余日志，然后清除旧定时器
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();

  try {
    logPath = `${projectPath}/.lantai/logs/ui.log`;
  } catch {
    logPath = null;
  }
  flushTimer = setInterval(flush, FLUSH_MS);
}

function buildEntry(level: LogLevel, module: string, message: string, ctx?: Record<string, unknown>): LogEntry {
  return { ts: new Date().toISOString(), level, module, message, ctx };
}

/** 落盘（**失败向上抛**——批 3：丢条必须可见，见 `flush` 的计数与补偿）。 */
async function appendToFile(path: string, content: string): Promise<void> {
  const { kernelLogAppend } = await import('../rpc-contract');
  await kernelLogAppend(path, content);
}

function write(entry: LogEntry): void {
  if (!shouldWrite(entry.level)) return; // 级别过滤（debug 默认丢弃）
  logBuffer.push(JSON.stringify(entry));
  if (logBuffer.length >= MAX_BUFFER) flush();
}

/** 下一条成功写入时补账：`log.self{dropped:N}`——丢过多少必须能查回来。 */
function reportDroppedEntries(): void {
  if (droppedEntries === 0) return;
  const n = droppedEntries;
  droppedEntries = 0;
  firstDropReported = false;
  write({
    ...buildEntry('warn', 'logger', `日志丢条补偿：此前 ${n} 条写入失败`),
    ctx: { channel: logChannelState(), dropped: n, level: minLevel, source: levelSource },
    event: 'log.self',
  });
}

async function flush(): Promise<void> {
  if (logBuffer.length === 0 || !logPath) return;
  const batch = logBuffer.splice(0);
  logBuffer = [];
  try {
    await appendToFile(logPath, batch.join('\n') + '\n');
    reportDroppedEntries();
  } catch (e) {
    // 丢条可见（批 3）：计数 + **首次** console.error。日志器自己坏掉这件事必须
    // 留痕——否则「日志里没有」会被读成「没发生」。仍不抛：日志不能破坏应用。
    droppedEntries += batch.length;
    if (!firstDropReported) {
      firstDropReported = true;
      console.error(
        `[logger] 日志写入失败，本批 ${batch.length} 条丢失（此后只计数，下一条成功写入时补 log.self）：`,
        e,
      );
    }
  }
}

export const log = {
  debug(m: string, msg: string, ctx?: Record<string, unknown>, extra?: Partial<LogEntry>) {
    write({ ...buildEntry('debug', m, msg, ctx), ...extra });
  },
  info(m: string, msg: string, ctx?: Record<string, unknown>, extra?: Partial<LogEntry>) {
    write({ ...buildEntry('info', m, msg, ctx), ...extra });
  },
  warn(m: string, msg: string, ctx?: Record<string, unknown>, extra?: Partial<LogEntry>) {
    write({ ...buildEntry('warn', m, msg, ctx), ...extra });
    console.warn(`[${m}] ${msg}`, ctx ?? '');
  },
  error(m: string, msg: string, ctx?: Record<string, unknown>, extra?: Partial<LogEntry>) {
    write({ ...buildEntry('error', m, msg, ctx), ...extra });
    console.error(`[${m}] ${msg}`, ctx ?? '');
  },
};

/** 日志通道当前是否可写（`boot` 事件如实上报；批 3 的健康度计数同源）。 */
export function logChannelState(): 'ok' | 'unavailable' {
  return logPath ? 'ok' : 'unavailable';
}

/** 当前日志文件绝对路径（诊断面读；未 init = null）。 */
export function logFilePath(): string | null {
  return logPath;
}
