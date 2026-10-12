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
//   ⚡ 2026-10-12 日志可观测性批 4：本文件再加一件事——**轮转触发**：
//   ui.log 此前是纯追加、无上限（实测涨到 75 MB）。现在 logger 每累计写
//   `ROTATE_CHECK_BYTES` 问一次壳侧（`log_rotate` RPC）：壳自己 stat、自己
//   判上限（8 MiB / 保 2 代，真源 `logging.rs`，与 bridge/boot 同一套），
//   越限则滚成 `.1`/`.2`。轮转失败**不阻断**写日志（宁可文件大，不丢日志）
//   但必须可见：首次 console.error + 下一条成功写入补 `log.self{rotate_failed:N}`。
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
//   ③ **debug 前情环形缓冲**（同日追加，用户拍板）：被级别挡下的 debug 条目
//      **不丢**，留在内存（定长 ≤2000 条/128K 字符，实测 ≈0.2MB）；一旦出现
//      用户可见的失败（错误级 + 带 `event`），连前情一起倒进日志。**用户不需要
//      知道这个开关存在**——这是①的开关不被「忘记拧」的兜底。详见 dumpRing 上方注。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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

/** 持久化级别偏好并立即生效（设置页开关的路径）：写 `localStorage` 再
 *  `applyLogLevelFromShell()`（幂等）。`null` = 清除偏好（回落环境变量/默认）。
 *  返回应用后的**真实**级别与来源——不撒谎：环境变量压过偏好时，UI 据此如实
 *  显示（“拨了没生效”比“拨不动”好解得多）。本函数不抛。 */
export async function setLogLevelPreference(
  level: LogLevel | null,
): Promise<{ level: LogLevel; source: LogLevelSource }> {
  try {
    if (level) globalThis.localStorage?.setItem(LOG_LEVEL_STORAGE_KEY, level);
    else globalThis.localStorage?.removeItem(LOG_LEVEL_STORAGE_KEY);
  } catch {
    // 存储被禁：偏好写不进，仍尝试应用（回落默认）——写不进不是失败，是回落。
  }
  await applyLogLevelFromShell();
  return logLevel();
}

// ── 轮转触发（批 4）───────────────────────────────────────────────
//
// 大小判据真源在**壳侧**（`logging.rs` 的 LOG_MAX_BYTES/LOG_KEEP，与 bridge/boot
// 同一套）；前端只知道“检查频率”（每累计写这么多字节问一次）——两份语言不共
// 常量，避免上限值两边漂移。问“该不该滚”时壳自己 stat（一次便宜的本地 IPC）。

/** 轮转检查间隔（字节）：每累计写入这么多就问一次壳侧。1 MiB 下正常日志
 *  几小时才问一次；debug 全开时也远低于 IPC 压力上限。 */
const ROTATE_CHECK_BYTES = 1024 * 1024;

let bytesSinceRotateCheck = 0;
/** init 后的首写检查旗（见 initLogger）：第一次真写盘前先问一次壳，
 *  「存量越限文件不等累计」的判据由此承接。 */
let pendingInitialRotateCheck = false;
/** 轮转失败计数（与 dropped 同构：下一条成功写入时补 `log.self` 落账）。 */
let rotateFailures = 0;
let rotateFailureReported = false;

/** 问一次壳侧：ui.log 越限了吗？越限壳会滚代（`.1`/`.2`，保 2 代）。
 *  失败**不阻断**日志写入（宁可文件大，不丢一条），但必须可见：
 *  首次 console.error，下一条成功写入补 `log.self{rotate_failed:N}`。 */
async function rotateIfNeeded(): Promise<void> {
  if (!logPath) return;
  try {
    const { kernelLogRotate } = await import('../rpc-contract');
    await kernelLogRotate(logPath);
  } catch (e) {
    rotateFailures += 1;
    if (!rotateFailureReported) {
      rotateFailureReported = true;
      console.error('[logger] 日志轮转失败（文件将继续增长；下一条成功写入时补记）：', e);
    }
  }
}

/** 轮转失败补偿（与 `reportDroppedEntries` 同节奏）：`log.self{rotate_failed:N}`
 *  —— “滚代滚不动、文件会无限涨”这件事不许静默。 */
function reportRotateFailures(): void {
  if (rotateFailures === 0) return;
  const n = rotateFailures;
  rotateFailures = 0;
  rotateFailureReported = false;
  write({
    ...buildEntry('warn', 'logger', `日志轮转失败补偿：此前 ${n} 次滚代未成功（日志文件会超出上限继续增长）`),
    ctx: { channel: logChannelState(), rotate_failed: n, level: minLevel, source: levelSource },
    event: 'log.self',
  });
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

// ── debug 前情环形缓冲（批 3 追加，2026-10-12 用户拍板「不要靠人记得开开关」）──
//
// 用户侧的现实：**没人会记得去拧调试开关**（用户原话「我都不知道还需要有调试开关来着」）。
// 故不靠开关，靠缓冲：debug 条目平时**不写盘**，只留在内存环形缓冲里；一旦出现
// 用户可见的失败（= 错误级 **且带 `event`** 的条目，即接缝认定的失败），就把缓冲里的
// 前情连同失败一起倒进日志（前情在前、失败在后，读起来是一条完整现场）。
//
// 体积（定长，跑多久都不涨）：上限 `RING_MAX_ENTRIES` 条 / `RING_MAX_CHARS` 字符，
// 谁先到算谁。实测本机 ui.log 的 debug 行平均 112 字节（几乎是同一条 rpc invoke）⇒
// 现实里先撞**字符**上限 ≈1150 条 / 128KB ≈ 0.13MB；极端情形（整屏中文，3 字节/字符）
// 最坏 ≈0.4MB。对比：一张粘贴的截图 6.4MB、前端 bundle 3MB。
//
// 三条触发纪律：
//   ① **只认「错误级 + 带 event」**——裸 `log.error`（路径噪声那类）不触发：本机
//      ui.log 里有 5.2 万条这种 error，认它们等于让噪声把文件泵爆。
//   ② 倒一次清空缓冲，且**下一次要攒够 `RING_REPEAT_MIN` 条**才再倒（错误风暴不刷屏）。
//   ③ 级别真的开到 debug 时，条目直接进文件、缓冲恒空（不倒，避免重复写两遍）。
const RING_MAX_ENTRIES = 2000;
const RING_MAX_CHARS = 128 * 1024;
/** 单条超此长度**不入缓冲**（宁可少一条前情，也不让一条巨物撑爆内存；
 *  截断会破坏 NDJSON 可解析性，故选择不缓存）。 */
const RING_MAX_LINE = 4096;
/** 首次有前情就倒；此后需攒够这么多条才再倒。 */
const RING_REPEAT_MIN = 25;

let ring: string[] = [];
let ringChars = 0;
let ringMinDump = 1;

/** debug 条目入缓冲（已序列化的行直接进；超长/序列化失败 = 这条前情不要）。 */
function pushRing(entry: LogEntry): void {
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    return; // ctx 里混进循环引用之类：丢这一条前情，绝不打扰调用方
  }
  if (line.length > RING_MAX_LINE) return;
  ring.push(line);
  ringChars += line.length + 1;
  while (ring.length > RING_MAX_ENTRIES || (ringChars > RING_MAX_CHARS && ring.length > 1)) {
    const evicted = ring.shift();
    if (evicted === undefined) break;
    ringChars -= evicted.length + 1;
  }
}

/** 入写出缓冲（不做级别判断、不触发倒前情——`write` 与 `dumpRing` 共用）。 */
function enqueue(entry: LogEntry): void {
  logBuffer.push(JSON.stringify(entry));
  if (logBuffer.length >= MAX_BUFFER) flush();
}

/**
 * 错误触发：把缓冲里的 debug 前情倒进日志。判据见上方三条纪律①。
 * 前情行**不再过一遍级别过滤**——它们是「当时被级别挡下」的条目，补写的目的就是它们。
 */
function dumpRing(entry: LogEntry): void {
  if (entry.level !== 'error' || entry.event === undefined) return;
  if (ring.length < ringMinDump) return;
  const lines = ring;
  ring = [];
  ringChars = 0;
  ringMinDump = RING_REPEAT_MIN;
  enqueue({
    ...buildEntry('warn', 'logger', `失败现场：前面 ${lines.length} 条 debug 前情（平时只在内存环形缓冲，不写盘）`),
    ctx: { ring_dumped: lines.length, level: minLevel, source: levelSource, channel: logChannelState() },
    event: 'log.self',
  });
  for (const line of lines) logBuffer.push(line);
  if (logBuffer.length >= MAX_BUFFER) flush();
}

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
  // 打开工作区后的首次真写要**先问一次壳**（存量越限文件不等累计到检查间隔）。
  // 2026-10-12 实测修正：不在本函数里 fire-and-forget 那次检查——那会让
  // 「检查的 import」与「写入的 import」并发，测试面（mock 工厂的 importOriginal
  // 与消费方动态 import 同 ID）在 resetModules 后会撞出替身/真身竞态（假红假绿）；
  // 改由首次 flush 消化（pendingInitialRotateCheck），检查与写入严格串行。
  pendingInitialRotateCheck = true;
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
  if (!shouldWrite(entry.level)) {
    // 级别挡下的 **debug** 不丢：进环形缓冲，等失败时连前情一起倒出（见 dumpRing）。
    // 其余级别（未来若加更细的档）直接丢弃。
    if (entry.level === 'debug') pushRing(entry);
    return;
  }
  // 失败（错误级 + 带 event）先把前情倒出来，再写自己——日志里读起来是「前情 → 失败」。
  dumpRing(entry);
  enqueue(entry);
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
  const text = batch.join('\n') + '\n';
  // 写前轮转检查（批 4）：首写无条件问一次（承接「打开即查存量」）；此后
  // 每累计够一个检查间隔问一次。壳自己 stat、自己判上限（★检查与写入串行）。
  if (pendingInitialRotateCheck || bytesSinceRotateCheck >= ROTATE_CHECK_BYTES) {
    pendingInitialRotateCheck = false;
    bytesSinceRotateCheck = 0;
    await rotateIfNeeded();
  }
  try {
    await appendToFile(logPath, text);
    bytesSinceRotateCheck += text.length;
    reportDroppedEntries();
    reportRotateFailures();
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
