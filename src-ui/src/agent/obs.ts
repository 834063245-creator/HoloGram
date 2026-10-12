// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// obs.ts — 日志可观测性**事件门面**（内核基础设施，2026-09-27 立规）。
//
// 立项理由见 docs/plans/log-observability-plan.md。一句话：现状不是「缺日志」，
// 是「**失败默认无痕**」被结构性排除——2026-09-27 用户报本地模型（baseUrl
// http://127.0.0.1:8080/v1）配好了却调不通，附的 ui.log 1158 行里对该问题的
// 可答信息 **0 条**（1024 行是同一条无 method 的 invoke 噪声；87 条 error 全是
// 路径噪声；8080 / 127.0.0.1 / localhost 出现 0 次）。
//
// 本文件是**唯一脱敏审查点**：任何要落盘的字符串都经这里的 scrub* 过一遍，
// 评审只看这一个文件。新增接缝 = 在这里加一个函数（不散点、不改旧调用）。
//
// ⚡ 两条设计裁定（与计划原文的偏离处，理由在此）：
//
//   ① **不做模块级「当前回合上下文」自动注入**。计划 §2.2 写「ids 由门面自动
//      注入（从当前会话/回合上下文取）」，但本仓库的并发模型是**多卷同时跑**
//      （chat-core 的运行账按卷各记一条，见 agent/execution-state.ts；子 Agent
//      另持私账）——单个 ambient 槽位会把 A 卷的失败记到 B 卷头上，正是
//      INVARIANTS #1「全局变量 = 跨面板串流」那一族的形态。故 `ids` 由**调用点
//      显式给**：调用点本来就持有（chat-core 有 turnSid / turnGen / run.id，
//      Agent 有 this.id / _uiSessionId），且显式传参让「谁的身份」在代码里可读。
//      代价 = 每次调用多写一行 ids；收益 = 并发正确 + 门面零状态（可纯函数测）。
//
//   ② **不记中文句子当事件名**。既有 `log.*` 的中文 message 原样保留、**零迁移**
//      （本批零回归面）；`event` 是 ASCII 点分**判据**名，`message` 是给人读的
//      一句话。两者混同正是「日志答不了问题」的一半原因。
//
// ⚡ 模块级可变状态（CONVENTIONS §1.10 四级归属）：只有 `_turnFailSeen`
//    （turn.failed 去重表）——**键控自清理**（回合结束 `endTurn` 清；另有 256
//    条上限兜底），无跨工作区所有权问题。`BUILD` 是**冻结常量表**（模块加载期
//    求值一次，此后只读）。

import { type LogEntry, log, logChannelState, logLevel } from './logger';

// ── 构建锚（构建期烙进 define，见 vite.config.ts 的 buildAnchor）──
//
// 裸标识符 + typeof 守卫：产物域（esbuild 构建内置插件）不走 vite 配置 ⇒
// 那里得 'undefined'，安全降级为 unknown。形态与 plugins/builtin/face-css.ts
// 的 __LANTAI_FACE_ARTIFACT__ 一致。
declare const __LANTAI_BUILD__: { v: string; commit: string } | undefined;

const BUILD: { v: string; commit: string } =
  typeof __LANTAI_BUILD__ === 'undefined' ? { v: 'unknown', commit: 'unknown' } : __LANTAI_BUILD__;

// ── 事件表（事件名 = ASCII 点分稳定名；新增接缝在这里加一行 + 一个函数）──
//
//   boot                     壳/工作区启动一次（版本·commit·平台·时区·工作区·
//                            providers.yml 路径·proxy 端口·日志通道可写性）
//   config.load              provider 文档装载出口（**成功也写**）
//   panel.providers_reload   设置面板重读（两条路径）
//   cred.get / cred.store / cred.remove   凭据读写（只记长度与存在性，无明文）
//   llm.send / llm.first_byte / llm.done / llm.error   出网四相（公共面）
//   turn.failed              用户可见的回合失败（唯一漏斗，按 (session,turn,phase) 去重）
//   ui.toast                 error 级 toast 出口（用户看见了）
//   log.self                 日志器自身健康度（丢条补偿；级别见 boot 的
//                            log_level/log_level_source）——生产者在 logger.ts
//                            （不经本门面：反向调用会与 import 方向成环）
//
// 字段纪律（**不记**）：apiKey / token 明文、消息正文、请求体全文、URL query、
// 工具输出全文。只记：长度、存在性、`host:port`、节数、错误原文（经脱敏）。

export type ObsEvent =
  | 'boot'
  | 'config.load'
  | 'panel.providers_reload'
  | 'cred.get'
  | 'cred.store'
  | 'cred.remove'
  | 'llm.send'
  | 'llm.first_byte'
  | 'llm.done'
  | 'llm.error'
  | 'turn.failed'
  | 'ui.toast'
  | 'log.self';

/** 失败发生层——定位的关键（「哪一层」比「什么错」先要答出来）。 */
export type ObsPhase = 'preflight' | 'stream' | 'tool';

/** 会话/回合/运行身份。`session` = 卷 id；`turn` = 该卷的轮次代数
 *  （chat-core `_turnGenBySid`）；`run` = 运行记录 id（execution-state）。 */
export interface ObsIds {
  session?: number | null;
  agent?: string;
  turn?: number;
  run?: number;
}

/** 内置日志的模块名（沿用既有词表：bridge/agent/chat/provider/ui/shell/boot…）。 */
type ObsModule = 'boot' | 'provider' | 'llm' | 'chat' | 'ui';

type Level = 'debug' | 'info' | 'warn' | 'error';

// ── 脱敏（唯一审查点）────────────────────────────────────────────────

/** 单字段脱敏后的字符上限——超长的「原文」对定位无用，对日志体积有害。 */
const SCRUB_MAX_CHARS = 2000;

/** 脱敏规则表（**顺序敏感**）：
 *  ① 先削 URL query（端点可能把 Key 放 query——Azure 风格 `?api-key=`）；
 *  ② **再抹裸 Bearer**——必须早于「显式凭据字段」那条：后者会把
 *     `Authorization: Bearer XXX` 整段吃成 `Authorization=<redacted>`，连
 *     `Bearer` 这个词一起吃掉，于是 XXX 变成孤儿裸串、第 ③ 条再也匹配不上
 *     （2026-09-27 本文件首版实测漏网形态，已钉在测试里）；
 *  ③ 显式凭据字段/头（`apiKey: "sk-…"` / `x-api-key: …` / `authorization=…`），
 *     值可带引号。⚠ `\b` 边界让 `max_tokens` / `tokens` 这类**计数**字段不误伤
 *     （下划线是词字符）；
 *  ④ 各家 Key 的字面形态（即便没有字段名陪着）。 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, '$1?<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  [
    /\b(authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|token|secret|password)\b\s*[:=]\s*["']?[^\s,;"'}\]]+/gi,
    '$1=<redacted>',
  ],
  [/\b(sk|gsk|xai|r8|ark)[-_][A-Za-z0-9_-]{12,}/gi, '$1-<redacted>'],
];

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[clipped]` : s;
}

/** 文本脱敏：抹凭据、削 URL query、封长度。**唯一出口**——所有要落盘的字符串
 *  （含 `err.raw`、`ctx` 里的每个字符串值）都过这里。 */
export function scrubText(input: string): string {
  let out = clip(input, SCRUB_MAX_CHARS);
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

/** 递归脱敏（对象/数组/字符串；数字与布尔原样）。 */
function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return scrubText(v);
  if (v === null || typeof v !== 'object' || depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = scrubValue(val, depth + 1);
  return out;
}

function scrubRecord(r: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return r === undefined ? undefined : (scrubValue(r) as Record<string, unknown>);
}

/** URL → `host:port`（**只记这个**：协议面、路径、query 一律不落盘）。 */
export function hostPort(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return '<unparsable>';
  }
}

// ── 条目装配与 4KB 上限 ──────────────────────────────────────────────

/** 单条上限（字节）。超出**截断并标 `truncated:true`**——截断后仍是一条可读
 *  记录，不是丢弃（丢条正是本次事故里「日志答不了问题」的另一半）。 */
const MAX_ENTRY_BYTES = 4096;

/** `ctx` 里长数组在收缩档保留的项数（留 `…(+N)` 计数，不静默丢项）。 */
const CTX_ARRAY_MAX = 8;

/** 是否超预算。字符数 ≤ 1024 ⇒ 字节数 ≤ 4096（UTF-8 单字符最多 4 字节）⇒ 必在上限内，
 *  省掉绝大多数条目的 TextEncoder 开销。序列化本身**不抛**（循环引用等 → 当超限处理，
 *  走收缩路径；真写不出去由 safeWrite 兜）。 */
function overBudget(json: string): boolean {
  if (json.length <= 1024) return false;
  return new TextEncoder().encode(json).length > MAX_ENTRY_BYTES;
}

/** 序列化（不抛）：`ctx`/`err` 里混进循环引用时 JSON.stringify 会抛——那是
 *  **调用点**的数据问题，不该让门面把用户动作打断。返回 '' 即按超限走收缩。 */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** 落盘（**绝不抛**）。日志是诊断侧信道：写不出去最多丢一条，绝不能把用户动作
 *  本身打断——这是 logger.ts 立过的同一条纪律（「日志不能破坏应用」）。真实
 *  风险有两条：① `ctx`/`err` 混进循环引用 → 序列化抛（见 safeJson）；
 *  ② 传输层自身抛（配额/编码）。丢条本身不静默——console 有痕（批 3 健康度接管）。 */
function safeWrite(level: Level, module: ObsModule, entry: LogEntry, extra: Partial<LogEntry>): void {
  try {
    switch (level) {
      case 'debug':
        log.debug(module, entry.message, entry.ctx, extra);
        break;
      case 'info':
        log.info(module, entry.message, entry.ctx, extra);
        break;
      case 'warn':
        log.warn(module, entry.message, entry.ctx, extra);
        break;
      case 'error':
        log.error(module, entry.message, entry.ctx, extra);
        break;
    }
  } catch (e) {
    console.error('[obs] 日志条目写入失败（本条丢弃）', e);
  }
}

/** 通道状态读取（**不抛**）：`logChannelState` 是读侧 helper，测试替身未必复现
 *  （既有 vi.mock 只造 `log`）——缺席即按 unavailable 记，boot 如实上报。 */
function channelState(): 'ok' | 'unavailable' {
  try {
    return typeof logChannelState === 'function' ? logChannelState() : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** 当前日志级别与来源读取（**不抛**，同 channelState 的替身纪律）。
 *  这条读数的用途：收到一份**没有 debug 行**的 log，必须能回答「是没发生，
 *  还是级别把它挡了」——批 3 前这个问题的答案是「不知道」。 */
function levelInfo(): { level: string; source: string } {
  try {
    return typeof logLevel === 'function' ? logLevel() : { level: 'unknown', source: 'unknown' };
  } catch {
    return { level: 'unknown', source: 'unknown' };
  }
}

/** 逐级收缩直到进预算（**保信号优先**，不是一刀切）：
 *  ① 削 `err.raw` → ② `ctx` 字符串值削到 160 字 + 长数组裁到前 8 项（留 `…(+N)` 计数，
 *  不静默丢）→ ③ 丢 `ctx` → ④ 削 `message`。任何一级生效都标 `truncated:true`。 */
function enforceBudget(entry: LogEntry): LogEntry {
  if (!overBudget(safeJson(entry))) return entry;
  const out: LogEntry = { ...entry, truncated: true };
  if (typeof out.err?.raw === 'string') out.err = { ...out.err, raw: clip(out.err.raw, 400) };
  if (overBudget(safeJson(out)) && out.ctx) {
    const shrunk = scrubRecord(out.ctx) ?? {};
    for (const [k, v] of Object.entries(shrunk)) {
      if (typeof v === 'string') shrunk[k] = clip(v, 160);
      else if (Array.isArray(v)) {
        // 长数组：裁到前 N 项（项内字符串同档削），尾巴留 `…(+N)` 计数——不静默丢项
        const items: unknown[] = v.slice(0, CTX_ARRAY_MAX).map((x) => (typeof x === 'string' ? clip(x, 160) : x));
        if (v.length > CTX_ARRAY_MAX) items.push(`…(+${v.length - CTX_ARRAY_MAX})`);
        shrunk[k] = items;
      }
    }
    out.ctx = shrunk;
  }
  if (overBudget(safeJson(out))) {
    out.ctx = undefined;
    if (out.err) out.err = { ...out.err, raw: clip(String(out.err.raw ?? ''), 120) };
  }
  if (overBudget(safeJson(out))) out.message = clip(out.message, 200);
  return out;
}

interface EmitFields {
  ids?: ObsIds;
  ctx?: Record<string, unknown>;
  err?: Record<string, unknown>;
  dur_ms?: number;
  out?: string;
}

function emit(level: Level, module: ObsModule, event: ObsEvent, message: string, f: EmitFields = {}): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    module,
    message: scrubText(message),
    event,
    build: BUILD,
  };
  if (f.ids) entry.ids = scrubRecord(f.ids as Record<string, unknown>);
  if (f.ctx) entry.ctx = scrubRecord(f.ctx);
  if (f.err) entry.err = scrubRecord(f.err);
  if (f.dur_ms !== undefined) entry.dur_ms = f.dur_ms;
  if (f.out !== undefined) entry.out = f.out;
  const finalEntry = enforceBudget(entry);
  // 事件字段搭 `log.*` 的 extra 槽（见 logger.ts 头注：不另开写口）
  safeWrite(level, module, finalEntry, {
    event: finalEntry.event,
    build: finalEntry.build,
    ids: finalEntry.ids,
    dur_ms: finalEntry.dur_ms,
    out: finalEntry.out,
    err: finalEntry.err,
    truncated: finalEntry.truncated,
  });
}

// ── ① boot ──────────────────────────────────────────────────────────

/** 平台描述（`boot` 用；navigator 缺席的 node 环境降级为 unknown）。 */
function platformDesc(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform ?? nav.platform ?? 'unknown';
}

/** 时区（IANA 名 + UTC 偏移分钟）——「用户那边几点」是排查时序错位的第一个输入。 */
function tzDesc(): { tz: string; utc_offset_min: number } {
  try {
    return {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      utc_offset_min: -new Date().getTimezoneOffset(),
    };
  } catch {
    return { tz: 'unknown', utc_offset_min: 0 };
  }
}

/**
 * 启动锚（工作区打开、logger init 之后一次）。
 *
 * ⚡ 为什么这条最值钱：收到的 log 若不带版本/commit/工作区/端口，**无法定位代码**
 * ——事故里只能靠「invoke 有没有 method 字段」反推壳的构建时间。这条把「用户跑的是
 * 哪个构建、哪个工作区、日志通道通不通」一次说清。
 */
export function boot(f: {
  /** 当前工作区绝对路径（'' = 未打开工作区）。 */
  workspace: string;
  /** 用户级 providers.yml 路径（配置面的单一入口）。 */
  providersPath: string;
  /** LLM 反代端口（'0' = 不可用）。 */
  proxyPort: string;
  ids?: ObsIds;
}): void {
  const { tz, utc_offset_min } = tzDesc();
  const channel = channelState();
  const lvl = levelInfo();
  emit('info', 'boot', 'boot', `启动 v${BUILD.v} (${BUILD.commit}) · 工作区 ${f.workspace || '<未打开>'}`, {
    ids: f.ids,
    out: channel === 'ok' ? 'ok' : 'fail',
    ctx: {
      platform: platformDesc(),
      tz,
      utc_offset_min,
      workspace: f.workspace,
      providers_yml: f.providersPath,
      proxy_port: f.proxyPort,
      log_channel: channel,
      log_level: lvl.level,
      log_level_source: lvl.source,
    },
    err:
      channel === 'ok'
        ? undefined
        : { kind: 'LOG_CHANNEL_UNAVAILABLE', raw: '日志通道未初始化——本次会话的日志不会落盘' },
  });
}

// ── ② provider 配置装载 / 面板重读 ──────────────────────────────────

/** 逐节错误（名 + 原因）——`config.load` 与 `panel.providers_reload` 共用形状。 */
export interface ObsSectionError {
  name: string;
  reason: string;
}

/** provider 文档一次装载的读数（真源 = `provider/providers-store.ts` 的 state）。 */
export interface ObsDocSnapshot {
  /** 文件路径（读/写的是哪一个文件——事故里的第一个岔路口）。 */
  path: string;
  /** 文件里解析出的节数（面板路径拿不到就省——那里只有投影行数）。 */
  sections?: number;
  /** 投影后的行表条数（用户**实际看到几行**）——与 `sections` 不等正是要暴露的形态。 */
  rows?: number;
  /** 逐节错误（名 + 原因）。 */
  errors: ReadonlyArray<ObsSectionError>;
  /** 整档 fatal 原因（undefined = 无）。 */
  fatal?: string;
  /** 文档为空（空文档**不算**权威——见 providersFileReady 头注）。 */
  empty: boolean;
  /** 投影来源：文件 or localStorage 意图副本。 */
  source: 'file' | 'localStorage';
  /** 投影后有多少行带着 Key（`withKey/total`）——「这行有没有 Key」的直接读数。 */
  keysCarried?: { withKey: number; total: number };
}

function docFields(s: ObsDocSnapshot): Record<string, unknown> {
  return {
    path: s.path,
    sections: s.sections,
    rows: s.rows,
    section_errors: s.errors.map((e) => `${e.name}: ${e.reason}`),
    fatal: s.fatal,
    empty: s.empty,
    source: s.source,
    keys: s.keysCarried ? `${s.keysCarried.withKey}/${s.keysCarried.total}` : undefined,
  };
}

function docLevel(s: ObsDocSnapshot): Level {
  if (s.fatal) return 'error';
  if (s.errors.length > 0) return 'warn';
  return 'info';
}

function docOut(s: ObsDocSnapshot): string {
  if (s.fatal) return 'fail';
  if (s.empty) return 'empty';
  return 'ok';
}

/** 「几节」的人读表述（节数/行数都可缺——面板路径只有投影行数）。
 *  `sections` 与 `rows` 不等时两个都报：**文件里有几节**与**用户看到几行**分家
 *  正是本接缝要暴露的形态（事故里用户说「之前配好的供应商没了」）。 */
function docCounts(s: ObsDocSnapshot): string {
  const parts: string[] = [];
  if (s.sections !== undefined) parts.push(`${s.sections} 节`);
  if (s.rows !== undefined && s.rows !== s.sections) parts.push(`投影 ${s.rows} 行`);
  return parts.length > 0 ? parts.join('，') : '读数不可用';
}

/** provider 文档装载出口——**成功也写**（旧实现只在 fatal 时留痕，于是「配置到底
 *  装进来没有」在日志上不可答）。 */
export function configLoad(s: ObsDocSnapshot & { ids?: ObsIds }): void {
  emit(
    docLevel(s),
    'provider',
    'config.load',
    `provider 配置装载：${docCounts(s)}${s.errors.length ? `，${s.errors.length} 节有错` : ''}` +
      `${s.fatal ? `，fatal: ${s.fatal}` : ''}${s.empty ? '（空文档）' : ''}`,
    {
      ids: s.ids,
      ctx: docFields(s),
      out: docOut(s),
      err: s.fatal ? { kind: 'CONFIG_FATAL', raw: s.fatal } : undefined,
    },
  );
}

/** 设置面板重读（两条路径）——与 `config.load` 同形状，多一个 `trigger` 说明
 *  「谁触发的重读」（面板打开 / 保存后 / watcher）。 */
export function panelReload(s: ObsDocSnapshot & { trigger: string; ids?: ObsIds }): void {
  emit(
    docLevel(s),
    'provider',
    'panel.providers_reload',
    `面板重读 provider 配置（${s.trigger}）：${docCounts(s)}，Key 携带 ` +
      `${s.keysCarried ? `${s.keysCarried.withKey}/${s.keysCarried.total}` : '未知'}`,
    { ids: s.ids, ctx: { ...docFields(s), trigger: s.trigger }, out: docOut(s) },
  );
}

// ── ③ 凭据（无明文；只记存在性与长度）───────────────────────────────

/** 读凭据结果。`error` = IPC 抛错（**与「没配」必须分得开**——2026-09 事故形态：
 *  一次 IPC 抖动被记成「这个提供方没有 Key」，整个进程生命周期恒报
 *  MISSING_CREDENTIAL，见 provider/credentials.ts 头注）。 */
export function credGet(f: {
  provider: string;
  hit: boolean;
  /** 命中的 Key 长度（**只记长度**）。 */
  len?: number;
  /** IPC 层错误原文（命中/未命中之外的第三条路径）。 */
  error?: string;
  ids?: ObsIds;
}): void {
  emit(
    f.error ? 'error' : f.hit ? 'info' : 'warn',
    'provider',
    'cred.get',
    `凭据读取「${f.provider}」：${f.error ? 'IPC 失败' : f.hit ? `命中（${f.len ?? '?'} 字符）` : '未命中'}`,
    {
      ids: f.ids,
      out: f.error ? 'fail' : f.hit ? 'hit' : 'miss',
      ctx: { provider: f.provider, len: f.len },
      err: f.error ? { kind: 'CRED_IPC_ERROR', raw: f.error } : undefined,
    },
  );
}

/** 写凭据结果（逐 provider ok/err）。 */
export function credStore(f: { provider: string; ok: boolean; error?: string; ids?: ObsIds }): void {
  emit(f.ok ? 'info' : 'error', 'provider', 'cred.store', `凭据保存「${f.provider}」：${f.ok ? '成功' : '失败'}`, {
    ids: f.ids,
    out: f.ok ? 'ok' : 'fail',
    ctx: { provider: f.provider },
    err: f.ok ? undefined : { kind: 'CRED_STORE_ERROR', raw: f.error ?? '未知失败' },
  });
}

/** 删凭据结果。 */
export function credRemove(f: { provider: string; ok: boolean; error?: string; ids?: ObsIds }): void {
  emit(f.ok ? 'info' : 'error', 'provider', 'cred.remove', `凭据删除「${f.provider}」：${f.ok ? '成功' : '失败'}`, {
    ids: f.ids,
    out: f.ok ? 'ok' : 'fail',
    ctx: { provider: f.provider },
    err: f.ok ? undefined : { kind: 'CRED_REMOVE_ERROR', raw: f.error ?? '未知失败' },
  });
}

// ── ④ 出网四相（公共面：方言无关，新方言自动继承）────────────────────

/** 出网请求的公共身份面。 */
export interface ObsLlmBase {
  provider: string;
  model: string;
  /** 方言名（openai / anthropic / responses）。 */
  kind: string;
  /** 请求 URL（**整条递进来**，门面自己削成 `host:port`——协议面/路径/query
   *  一律不落盘）。收整条而不是收削好的，是为了让调用点**忘不了**这件事：
   *  脱敏只有一处（本文件），调用点不需要也不应该知道该削成什么。 */
  url: string;
  ids?: ObsIds;
}

/** 身份面的公共 ctx（四处共用，保证四相的字段面一致）。 */
function llmCtx(f: ObsLlmBase): Record<string, unknown> {
  return { provider: f.provider, model: f.model, kind: f.kind, target: hostPort(f.url) };
}

/** 请求发出前（含重试第 n 次）。 */
export function llmSend(
  f: ObsLlmBase & {
    /** 本轮携带的工具 schema 数。 */
    tools?: number;
    /** prompt 侧 token 估算（构成是估算不是账单——见 token-meter 口径纪律）。 */
    promptEstimate?: number;
    /** 第几次尝试（1 起；>1 = 重试）。 */
    attempt?: number;
  },
): void {
  emit(
    'info',
    'llm',
    'llm.send',
    `→ ${f.provider}/${f.model}（${f.kind}）${f.attempt && f.attempt > 1 ? `第 ${f.attempt} 次尝试` : ''}`,
    {
      ids: f.ids,
      out: 'ok',
      ctx: { ...llmCtx(f), tools: f.tools, prompt_est: f.promptEstimate, attempt: f.attempt },
    },
  );
}

/** 首字节到达（挂起判定的分水岭：`send` 有而 `first_byte` 无 = 服务商零字节）。 */
export function llmFirstByte(f: ObsLlmBase & { ms: number }): void {
  emit('info', 'llm', 'llm.first_byte', `← ${f.provider}/${f.model} 首字节 ${f.ms}ms`, {
    ids: f.ids,
    dur_ms: f.ms,
    out: 'ok',
    ctx: llmCtx(f),
  });
}

/** 请求正常结束（流读完 / 无流返回）。 */
export function llmDone(
  f: ObsLlmBase & {
    ms: number;
    status?: number;
    finishReason?: string;
    /** 提供方报的 prompt/completion token（有才记）。 */
    promptTokens?: number;
    completionTokens?: number;
    /** SSE 事件条数（流式路径的「读了多少」读数）。 */
    events?: number;
  },
): void {
  emit(
    'info',
    'llm',
    'llm.done',
    `✓ ${f.provider}/${f.model} ${f.ms}ms${f.finishReason ? ` (${f.finishReason})` : ''}`,
    {
      ids: f.ids,
      dur_ms: f.ms,
      out: 'ok',
      ctx: {
        ...llmCtx(f),
        status: f.status,
        finish_reason: f.finishReason,
        prompt_tokens: f.promptTokens,
        completion_tokens: f.completionTokens,
        events: f.events,
      },
    },
  );
}

/** 请求失败（含重试链上的每一次——重试耗尽由 `turn.failed` 收口）。 */
export function llmError(
  f: ObsLlmBase & {
    ms?: number;
    status?: number;
    /** 错误分类标记（transient / rate_limited / auth_or_param / context_overflow）。 */
    errorKind?: string;
    /** 原始错误文本（经脱敏）。 */
    raw: string;
  },
): void {
  emit('error', 'llm', 'llm.error', `✗ ${f.provider}/${f.model} 失败${f.status ? ` (HTTP ${f.status})` : ''}`, {
    ids: f.ids,
    dur_ms: f.ms,
    out: 'fail',
    ctx: { ...llmCtx(f), status: f.status },
    err: { kind: f.errorKind ?? 'UNKNOWN', status: f.status ?? null, raw: f.raw },
  });
}

// ── ⑤ 唯一漏斗：用户可见的回合失败 ──────────────────────────────────

/** 回合失败的机器可读类别（`phase` 之外的第二问：「哪个判据」）。
 *  ⚠ 用户主动停止**不在**此列——它不是失败（chat-core 的 `!signal.aborted` 分支
 *  已把它排除在漏斗之外），刻意不设 `ABORTED`：没有生产者的枚举值是死词汇。 */
export type TurnFailKind = 'MISSING_CREDENTIAL' | 'PROVIDER_ERROR' | 'RUN_DEADLINE_EXCEEDED' | 'PAUSED' | 'UNKNOWN';

/** 预检失败的判据标记（请求**未发出**）。
 *  ⚡ 用标记而非错误类型：这些是**具名契约标记**——历史上 `provider/live.ts` 的
 *  凭据闸就抛带 `MISSING_CREDENTIAL` 前缀的普通 Error（2026-09-28 无 Key 放行批
 *  已撤除该闸：空 Key 照发，鉴权失败改由 `classifyError` 的 keyless 支在**响应侧**
 *  点名——那条路带 HTTP status，故按下方判据记 `stream` 而非 `preflight`）。
 *  标记表保留为**防御面**：第三方/未来路径抛同名标记时仍按预检归类。 */
const PREFLIGHT_MARKERS = ['MISSING_CREDENTIAL', 'PROVIDER_NOT_FOUND', 'PROTOCOL_UNSUPPORTED'];

/** 从任意错误推导 `{phase, kind, status, raw}`——调用点不知道更细时用这个。 */
export function classifyTurnFailure(err: unknown): {
  phase: ObsPhase;
  kind: TurnFailKind;
  status: number | null;
  raw: string;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;
  const kind = typeof (err as { kind?: unknown })?.kind === 'string' ? (err as { kind: string }).kind : undefined;
  if (PREFLIGHT_MARKERS.some((m) => raw.includes(m))) {
    return { phase: 'preflight', kind: 'MISSING_CREDENTIAL', status, raw };
  }
  if (kind !== undefined || status !== null) return { phase: 'stream', kind: 'PROVIDER_ERROR', status, raw };
  return { phase: 'stream', kind: 'UNKNOWN', status, raw };
}

/** 去重表：`session:turn:phase`（同一回合同一层的失败只留一条——六处出口不许刷屏）。
 *  键控自清理：回合结束 `endTurn` 清，另有上限兜底（漏调 endTurn 也不会无界增长）。 */
const _turnFailSeen = new Set<string>();
const TURN_FAIL_SEEN_MAX = 256;

function turnFailKey(ids: ObsIds, phase: ObsPhase): string {
  return `${ids.session ?? -1}:${ids.turn ?? -1}:${phase}`;
}

/**
 * **唯一漏斗**：任何让用户看见的回合失败（墓碑 / toast）都在这里留一条。
 *
 * 覆盖性硬要求（本计划的核心性质）：任何未知 bug，只要它让用户看见了失败，
 * 日志里**至少留下一条**，且带**发生层**（phase）与**原始错误文本**（raw）。
 *
 * @returns 本条是否真的写入（false = 同回合同层已记过，去重拦下）。
 */
export function turnFailed(f: {
  ids: ObsIds;
  phase: ObsPhase;
  kind: TurnFailKind;
  /** 原始错误文本（经脱敏）。 */
  raw: string;
  status?: number | null;
  level?: 'warn' | 'error';
  /** 用户可见的墓碑文案（截断后入 message——它是用户在界面上真正看到的那句）。 */
  message: string;
}): boolean {
  const key = turnFailKey(f.ids, f.phase);
  if (_turnFailSeen.has(key)) return false;
  if (_turnFailSeen.size >= TURN_FAIL_SEEN_MAX) _turnFailSeen.clear();
  _turnFailSeen.add(key);
  emit(f.level ?? 'error', 'chat', 'turn.failed', f.message, {
    ids: f.ids,
    out: 'fail',
    err: { kind: f.kind, status: f.status ?? null, phase: f.phase, raw: f.raw },
  });
  return true;
}

/** 回合结束清去重表（chat-core 的 finally 调）——键控自清理，防无界增长。 */
export function endTurn(ids: ObsIds): void {
  const prefix = `${ids.session ?? -1}:${ids.turn ?? -1}:`;
  for (const k of [..._turnFailSeen]) {
    if (k.startsWith(prefix)) _turnFailSeen.delete(k);
  }
}

// ── ui.toast：用户「看见了」的另一条通道 ────────────────────────────

/** error 级 toast 出口。用户看见 toast 就说明「有一次失败被呈现」——漏斗的
 *  兜底面（墓碑之外的第二条呈现路径，两条都要留痕）。 */
export function toast(f: { text: string; level: string }): void {
  if (f.level !== 'error') return;
  emit('error', 'ui', 'ui.toast', `toast(error): ${f.text}`, {
    out: 'fail',
    ctx: { text: f.text },
  });
}

// ⚠ `log.self`（日志器健康度：丢条补偿 `dropped` / 级别 `level`+`source`）**刻意不在
//   本文件实现**——它的生产者在 `agent/logger.ts`（批 3 落地：写失败计数 + 下一条
//   成功写入补一条）。理由 = import 方向：本文件 import logger，反向调用会成环；
//   且那条载荷只有级别名与计数（无用户文本），不需要过本文件的脱敏。事件名登记在
//   上方事件表与 `docs/design/log-observability-spec.md` §2；级别读数则挂在
//   `boot` 的 `log_level` / `log_level_source`（启动锚里一次说清，不另发事件）。
