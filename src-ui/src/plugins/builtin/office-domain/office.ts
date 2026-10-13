// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// office 域（C 路）——OfficeCLI 一等域工具
// ═══════════════════════════════════════════════════════════════
// 为什么不再走 MCP 挂接（2026-09-13 改判，过程见
// docs/archive/kernel-tooling-line/office-cli-integration-plan.md §10）：MCP 挂接把 OfficeCLI 原样搬成
// 「一个收命令行字符串的工具」——它绕开兰台的强制面（MCP 子进程是全权用户进程：
// 不经 fs_cap、不受 os_sandbox 约束）、参数无类型、整块被标成一个写动作（plan 模式
// 连 view 都被拦）。本域把同一能力做成兰台原生形状：
//   · zod 真源收窄动作面（不做 CLI 全语法复刻——11 个动作够交付物/注疏/xlsx 三批用）；
//   · 经 process_cap 能力口的 **office_exec** 动作受控 spawn（2026-09-15 R3 重构，见下）：
//     os_sandbox 沙箱 + Office 权限族（OfficeTool）+ 审计。**不新增能力口**——office 仍是
//     process 族的消费者（口数 = 能力族数），只是不再伪装成一条 shell 命令串；
//   · readOnlyActions 白名单 ⇒ plan 模式按 action 分读写（view/get/query/validate 放行）；
//   · 相对路径按工作区根解析（模型不碰引号/转义——命令由强制层拼装）。
//
// 三个刻意的产品决定（**R3.1 修订**，2026-09-15 受控实测后）：
//   1) **不起常驻进程**（`OFFICECLI_NO_AUTO_RESIDENT=1`）——officecli 缺省会为**每个被碰过的
//      文件**留一个 `__resident-serve__` 常驻进程：实测 **42 MB / 16 线程**，只在闲置
//      **12 分钟**后才退，而每次调用都重置那个计时器 ⇒ 一场文档密集会话能堆起十几个进程、
//      几百个线程（用户报的"线程泄露"）。关掉后每次调用自成一次 open/save，字节当场写盘。
//      代价：失去 warm resident 的加速（每次重新 open/parse）——以"不泄露 + 落盘语义确定"换。
//   2) 写动作仍带 `OFFICECLI_RESIDENT_FLUSH=each`：**万一**调用被路由进一个外部 resident
//      （用户自己起的 watch），这条钉扎保证改动立刻落盘（不再依赖对方的 idle-autosave）。
//   3) 关掉后台更新检查（`OFFICECLI_SKIP_UPDATE=1`）：确定性优先，升级走 pin + 安装器。
//
// ⚠️ 已知边界（2026-09-15 受控实测复核，**修正**了此前那条未复现的观察）：
//    外部 resident（用户 `watch` / 旧进程残留）持有目标文件时——
//    · `set`/`add`/`remove`/`batch` 的写入**照常落盘**，等过对方 idle-autosave 窗口也**不被
//      覆盖**（实测 D/E/F 三组读回全命中）⇒ **不存在**"回执成功而磁盘无字节"这类静默丢写；
//    · 唯一真实的互踩是**文件锁**：`create` 被硬拒（`currently opened by a resident process`，
//      **`--force` 也无效**）⇒ 所以只有 `create` 会先 `close` 掉那个 resident（见 Rust
//      `pre_close_target`）；其余动作不无差别 close，免得顺手掐掉用户的活预览窗；
//    · 外部程序（Excel/WPS/兰台媒体回读）在 resident 持有期间读该文件会被锁住——这是
//      "改完看不到效果"的真实来源之一，交人判 + 用 `view` 复核（`view` 走 resident，看得见）。
//
// ── 2026-09-15 事故修复批（用户会话 23「复杂 excel」实测复盘）────────────────
// 那场测试里模型只调了 5 次本工具、其余 71 次全在绕路（shell / code_execution），
// 最后用一个 Node 脚本直接驱动 officecli 收场。四处病灶 + 修法：
//   · 假成功信号 → 结果脚注改**退出码感知**（失败/未知一律不声明落盘）。
//   · 一次 batch 塞 2174 项（>100KB argv）→ 回执"零失败"而磁盘只落 19/180 行：
//     现在 >100 项或 >12KB 自动切块顺序执行，失败停在原地并报"前 N 批已落盘"。
//   · playbook 正文是 officecli 自带的**命令行**指南（488 行 / 101 条 officecli 命令，
//     含强制的 Help-First Rule）→ 模型照它下 shell → `command not found` → 转去找二进制
//     → 与本工具抢 resident。正文改不了，改为返回时前置护栏头（PLAYBOOK_GUARD_HEADER）。
//   · cleanShellOutput 的"找不到二进制"判定过宽（任何 No such file or directory 都命中）
//     → 收窄为 officecli(.exe) 与错误文案相邻。
//
// ── R3 已修（2026-09-15 探针实证 → 重构）─────────────────────────────────
// 病灶：本工具的命令串在**默认（ask）/ auto 模式下每次调用都触发权限卡**，且任何 allow
// 规则都压不住——`bash::check` 把 argv 里含 `/` 的 token 一律当文件系统路径解析：
//   ① `BIN=${…}` 赋值段；② DOM 路径 `/body/p[1]`；③ batch 的 JSON 载荷（含 `/Sheet1/A1`）。
// 三者都解析失败 ⇒ 判"项目外路径" ⇒ Ask，而该判定在 **allow 规则匹配之前提前返回**
// （bash.rs 步骤 3 → 4）⇒「始终允许」写进去也不生效。只在 yolo 下不可见（用户那次测试
// 正是 yolo，所以完全没暴露）。**"改一行 BIN_RESOLVE"不够**——DOM 路径与 JSON 载荷各自
// 独立触发同一判定。
// 修法（强制层重构，见 docs/archive/kernel-tooling-line/office-cli-integration-plan.md §11.3）：
//   · 本工具不再拼 shell 命令串 ⇒ 命令、二进制定位、引号、环境钉扎搬进 Rust
//     （`commands/process_cap.rs::office_exec`）；
//   · 门禁换成 `tools::OfficeTool`（同批新增）：**只审 officeTargets 声明的目标文件**
//     （走 fs 家族同一套路径策略：沙箱边界 + 安全检查 + 内容级规则），DOM 路径 / JSON
//     载荷不参与判定——它们在文档内寻址；
//   · office_exec 的动词白名单挡 CLI 逃生舱（raw / raw-set / add-part / watch …）。
//   结果：项目内目标不弹卡；项目外/敏感路径仍要问，且「始终允许」真的生效。

import { z } from 'zod';
import type { Tool, ToolExecutor } from './host';
import { defineTool, isAbsolutePath, ownerContext, resolveAgainstRoot, stickyCwdOf } from './host';

/** 动作面（收窄）——**只收真会用的**：读（view/get/query/validate）、写（create/set/
 *  add/remove/batch）、交付（merge/screenshot）。CLI 的 raw/raw-set/add-part/refresh/
 *  mark/watch/load_skill 等不进模型面：前三个属 L3 逃生舱（真需要时走 shell 域），
 *  load_skill 由兰台技能体系承担，watch 是活预览窗的事。 */
export const OFFICE_ACTIONS = [
  'view',
  'get',
  'query',
  'validate',
  'create',
  'set',
  'add',
  'remove',
  'batch',
  'merge',
  'screenshot',
  'playbook',
] as const;
export type OfficeAction = (typeof OFFICE_ACTIONS)[number];

/** plan 模式放行的只读动作（screenshot 会写 PNG 文件，不算只读）。 */
export const OFFICE_READONLY_ACTIONS = ['view', 'get', 'query', 'validate', 'playbook'] as const;

/** 专项技能名（officecli 内置 load_skill 的清单——逐格式构建指南，正文 25–65 KB）。 */
export const OFFICE_PLAYBOOKS = [
  'word',
  'academic-paper',
  'word-form',
  'pptx',
  'pitch-deck',
  'morph-ppt',
  'morph-ppt-3d',
  'excel',
  'financial-model',
  'data-dashboard',
] as const;

/** 会改动目标文件的动作（用于结果里的落盘提示文案）。 */
const MUTATING_ACTIONS = new Set<OfficeAction>(['create', 'set', 'add', 'remove', 'batch', 'merge']);

/** view 的读数模式（透传 officecli；`screenshot` 走独立动作）。 */
const VIEW_MODES = ['text', 'annotated', 'outline', 'stats', 'issues', 'html', 'svg', 'forms'] as const;

/** officecli 的命令行**不再由本层拼装**（2026-09-15 R3）：二进制定位、单引号、
 *  环境钉扎（`OFFICECLI_SKIP_UPDATE=1` / `OFFICECLI_RESIDENT_FLUSH=each`）全部搬进
 *  Rust 侧 `commands/process_cap.rs`（`office_exec` 动作）。原因见文件头 R3 段：
 *  TS 拼出的命令串里必然带 `BIN=${…}` 赋值段与 DOM 路径/JSON 载荷，而 shell 能力口的
 *  路径检查按"含 `/` 就当文件系统路径"解析它们 ⇒ 每次调用弹权限卡且 allow 规则失效。
 *  现在本层只交 **argv + 声明的目标文件**，命令与闸都在强制层。 */

/** 域工具入参（zod infer 的对偶形状——纯函数构造器只依赖这些字段，便于单测）。 */
export interface OfficeToolArgs {
  action: OfficeAction;
  /** 目标文件（playbook 不需要）。 */
  file?: string;
  path?: string;
  mode?: (typeof VIEW_MODES)[number];
  selector?: string;
  props?: Record<string, string>;
  /** add 的元素类型（如 paragraph/slide/shape/table）。 */
  type?: string;
  /** add 的父路径（缺省 / ——元素类型自身决定层级语义）。 */
  parent?: string;
  json?: boolean;
  items?: unknown[];
  data?: Record<string, string>;
  out?: string;
  page?: number;
  grid?: boolean;
  depth?: number;
  /** 专项技能名（load_skill）。 */
  playbook?: (typeof OFFICE_PLAYBOOKS)[number];
}

/** 动作 → argv（纯函数；`resolve` 负责把相对路径按工作区根解析为绝对路径）。
 *  返回 string = 参数不合法（作为工具结果直给模型，不抛）；返回 string[] = argv。 */
export function buildOfficeArgv(a: OfficeToolArgs, resolve: (p: string) => string): string | string[] {
  // playbook 不需要文件；其余动作都要。
  if (a.action !== 'playbook' && (!a.file || a.file.trim() === '')) {
    return `${a.action} 需要 file（目标 .docx/.xlsx/.pptx；相对路径按工作区根解析）`;
  }
  const f = resolve(a.file ?? '');
  const json = a.json === true ? ['--json'] : [];
  const props = Object.entries(a.props ?? {}).flatMap(([k, v]) => ['--prop', `${k}=${v}`]);
  switch (a.action) {
    case 'view': {
      // 无 mode 缺省 text：读数最常用且最省 token。
      const mode = a.mode ?? 'text';
      const page = a.page !== undefined ? ['--page', String(a.page)] : [];
      return ['view', f, mode, ...json, ...page];
    }
    case 'get': {
      if (!a.path) return 'get 需要 path（元素路径，如 /body/p[2]、/slide[1]/shape[@id=2]、/Sheet1/A1）';
      const depth = a.depth !== undefined ? ['--depth', String(a.depth)] : [];
      return ['get', f, a.path, ...depth, ...json];
    }
    case 'query': {
      if (!a.selector) return 'query 需要 selector（CSS 式选择器，如 paragraph[style=Heading1]、cell[value>5000]）';
      return ['query', f, a.selector, ...json];
    }
    case 'validate':
      return ['validate', f];
    case 'create':
      return ['create', f];
    case 'set': {
      if (!a.path) return 'set 需要 path';
      if (props.length === 0) return 'set 需要至少一个 props（key=value，如 {"bold":"true","color":"red"}）';
      return ['set', f, a.path, ...props];
    }
    case 'add': {
      if (!a.type) return 'add 需要 type（元素类型，如 paragraph/slide/shape/table/cell）';
      return ['add', f, a.parent ?? '/', '--type', a.type, ...props];
    }
    case 'remove': {
      if (!a.path) return 'remove 需要 path';
      return ['remove', f, a.path];
    }
    case 'batch': {
      // 3 处以上改动走 batch：一次开关 + 原子回滚；JSON 走 argv 单引号形态（免 shell 撕碎）。
      if (!a.items || a.items.length === 0) {
        return (
          'batch 需要 items（数组，不能为空）。每项形状：' +
          '{command:"set"|"add"|"remove"|"move"|"swap", path?, parent?, type?, props?, selector?, to?, after?, before?} —— ' +
          'command 是**裸动词**，动词的参数是**同级字段**（不是塞进 command 的字符串）。' +
          '例：[{command:"set",path:"/Sheet1/A1",props:{value:"标题"}},{command:"add",parent:"/Sheet1",type:"row",props:{}}]'
        );
      }
      return ['batch', f, '--commands', JSON.stringify(a.items), ...json];
    }
    case 'merge': {
      if (!a.out) return 'merge 需要 out（成品输出路径）';
      if (!a.data) return 'merge 需要 data（{"{{key}}": "值"} 的映射）';
      return ['merge', f, resolve(a.out), '--data', JSON.stringify(a.data)];
    }
    case 'screenshot': {
      if (!a.out) return 'screenshot 需要 out（PNG 输出路径；建议工作区内绝对路径）';
      const page = a.grid === true ? ['--grid', 'auto'] : a.page !== undefined ? ['--page', String(a.page)] : [];
      return ['view', f, 'screenshot', '-o', resolve(a.out), ...page];
    }
    case 'playbook': {
      // 专项技能：officecli 内置逐格式构建指南（load_skill）。保留这一动作是为了不丢
      // MCP 路原有的能力面——研报/路演/财务模型这些场景的权威规则都在里面（正文 25–65 KB）。
      if (!a.playbook) return `playbook 需要 playbook 参数（可选：${OFFICE_PLAYBOOKS.join(' / ')}）`;
      return ['load_skill', a.playbook];
    }
    default:
      return `unsupported action "${String(a.action)}". Available: ${OFFICE_ACTIONS.join(', ')}`;
  }
}

/** 声明的文件系统目标 —— 强制层（Rust `OfficeTool`）**只审这些**：
 *  DOM 路径（`/Sheet1/A1`）与 batch 的 JSON 载荷在**文档内**寻址，不是文件系统路径，
 *  不参与判定（2026-09-15 R3 的核心改动）。`file` 按动作判读/写（MUTATING_ACTIONS），
 *  `out`（merge 成品 / screenshot 的 PNG）一律写。 */
export function officeTargets(
  a: OfficeToolArgs,
  resolve: (p: string) => string,
): Array<{ path: string; write: boolean }> {
  const targets: Array<{ path: string; write: boolean }> = [];
  if (a.action !== 'playbook' && a.file) {
    targets.push({ path: resolve(a.file), write: MUTATING_ACTIONS.has(a.action) });
  }
  if ((a.action === 'merge' || a.action === 'screenshot') && a.out) {
    targets.push({ path: resolve(a.out), write: true });
  }
  return targets;
}

/** 透传 executor 注入的 meta 键（`_owner_id`/`_agent_id`/`_callId`——身份与审计），
 *  与 fs/shell provider 的 toCapArgs 同款。 */
function metaForward(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('_')) out[k] = v;
  }
  return out;
}

/** shell 层返回包的清洗：剥掉粘性 cwd 回显行（officecli 调用一律绝对路径，cwd 回显
 *  对模型是噪声），并在"找不到二进制"时补安装指引（错误不静默——别让模型去猜）。
 *
 *  ⚠️ 判定必须**只认二进制缺席**（2026-09-15 收窄）：早先只匹配 `No such file or directory`
 *  ⇒ 目标文件不存在、路径写错、DOM 路径里带空格等一切"文件找不到"都被误报成"officecli 没装"，
 *  把模型推去装二进制。现在要求 officecli(可选 .exe) 与错误文案相邻出现。 */
export function cleanShellOutput(raw: string): string {
  const withoutCwd = raw
    .split('\n')
    .filter((line) => !/^\[cwd: .*\]$/.test(line.trim()))
    .join('\n')
    .trimEnd();
  if (/officecli(\.exe)?["']?:\s*(command not found|no such file or directory)/i.test(withoutCwd)) {
    return `${withoutCwd}\n[office] 未找到 officecli 可执行文件（解析序：$OFFICECLI_PATH → ~/.lantai/tools/officecli/officecli.exe → 随包件（宿主 exe 同级）→ PATH）。后端随兰台安装包分发，缺失时让用户重装/修复兰台；开发机由 node scripts/fetch-officecli.mjs 取件。**不要**自己下 shell 找二进制跑——那会另起常驻进程抢同一个文件。`;
  }
  return withoutCwd;
}

/** 结果里的退出码。两种形态都认：
 *   - `[exit N]`：流式 shell seam（`runtime/queued-shell.ts`）给 shell 域加的前缀；
 *   - `[exit code: N]`：能力口原文——office 域**不经 seam**（直呼
 *     `process_cap::office_exec`），Rust 侧成功补 `[exit code: 0]`、失败/超时带
 *     `[exit code: N]`。
 *  2026-09-16 反馈回路审计：此前只认第一种 ⇒ office 的成功与失败都读成 null
 *  （landmine O3 的三态逻辑被 R3 重构静默放回：写动作恒报"结果未知"、多批 batch
 *  第 1 批假失败）。负数也认（超时是 `[exit -1]`，旧正则同样漏了）。
 *  读不到 = null —— **绝不把未知当成功**。 */
export function parseShellExit(raw: string): number | null {
  const m = raw.match(/^\s*\[exit(?:\s+code:)?\s+(-?\d+)\]/i);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/** batch 单次 CLI 调用的两条硬上限（取先到者）：
 *  · 条数 100 —— officecli 官方建议 ≤50 ops/块、实测 80+ 零失败（见 playbook），留余量；
 *  · 序列化 12KB —— 命令是经 `bash -c` 单串进 CreateProcess 的，Windows 命令行上限
 *    32767 字符，**超限静默截断**。2026-09-15 实测事故：2174 项塞一条命令（>100KB），
 *    回执「零失败」而磁盘只落 19/180 行，没有任何一层报错。 */
export const OFFICE_BATCH_MAX_ITEMS = 100;
export const OFFICE_BATCH_MAX_BYTES = 12_000;

/** batch items → 分块（超大单项独占一块；空表 → 空块表）。 */
export function splitOfficeBatchItems(
  items: readonly unknown[],
  maxItems: number = OFFICE_BATCH_MAX_ITEMS,
  maxBytes: number = OFFICE_BATCH_MAX_BYTES,
): unknown[][] {
  const chunks: unknown[][] = [];
  let cur: unknown[] = [];
  let bytes = 2; // '[' + ']'
  for (const item of items) {
    const size = (JSON.stringify(item) ?? '').length + 1; // +1 = 分隔逗号
    if (cur.length > 0 && (cur.length >= maxItems || bytes + size > maxBytes)) {
      chunks.push(cur);
      cur = [];
      bytes = 2;
    }
    cur.push(item);
    bytes += size;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** batch 项内的裸动词面（权威形状见 buildOfficeArgv 的 batch 缺参报错 + officecli 技能 §5.1）。
 *  注意：这是**项内**动词，与 CLI 顶层动词表（Rust `OFFICE_VERBS`，11 个）不是同一张表
 *  ——项内动词由 officecli 的 batch 解析器消费，本仓此前两侧都不校验。 */
const OFFICE_ITEM_REQUIRED: Record<string, readonly string[]> = {
  // props 不列入必需：本仓权威形状文本（buildOfficeArgv 的 batch 缺参报错）把 props 标为
  // `props?`，且无 props 的 set 在 officecli 侧是否报错本仓无证据 ⇒ 不误拒（宁窄勿宽）。
  set: ['path'],
  remove: ['path'],
  add: ['type'],
};

/** batch 项形状预检（返回错误文案；null = 通过）。
 *
 *  Why（landmine O5 + 2026-09-16 审计）：`items` 是模型可见 schema 里**唯一既无形状
 *  描述、也不指向技能章节**的参数（兄弟参数都有），而 batch 恰是动作面里最复杂的那个
 *  ——模型只能猜。猜错的两种典型形态在这里给**字段级带窗报错**（此前只等 officecli
 *  的批次原始报错）：
 *    ① 键名猜错（`{op:…}`）或 command 缺失 → 报"缺 command + 收到哪些键"；
 *    ② command 塞成**命令行串**（`"officecli set --path …"`）或含空格 → 报"要裸动词"。
 *  只查两层（command 形态 + 已知动词的必需字段），**不查 props 内部键**——宁可放过
 *  让 officecli 判，也不要误拒合法项（宁窄勿宽）。预检在**任何派发之前**跑，
 *  所以形状错不会留下"前几批已落盘"。 */
export function validateOfficeBatchItems(items: readonly unknown[]): string | null {
  const problems: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === null || typeof it !== 'object' || Array.isArray(it)) {
      problems.push(`第 ${i + 1} 项不是对象（收到 ${Array.isArray(it) ? '数组' : typeof it}）`);
      continue;
    }
    const rec = it as Record<string, unknown>;
    const cmd = rec.command;
    if (typeof cmd !== 'string' || cmd.trim() === '') {
      problems.push(`第 ${i + 1} 项缺 command（收到的键：${Object.keys(rec).join('/') || '（无）'}）`);
      continue;
    }
    const verb = cmd.trim();
    if (!/^[a-z][a-z-]*$/i.test(verb)) {
      problems.push(`第 ${i + 1} 项的 command 是命令行串（"${verb.slice(0, 40)}"）——要的是**裸动词**`);
      continue;
    }
    const required = OFFICE_ITEM_REQUIRED[verb.toLowerCase()];
    if (required) {
      const missing = required.filter((k) => rec[k] === undefined || rec[k] === null || rec[k] === '');
      if (missing.length > 0) problems.push(`第 ${i + 1} 项 command="${verb}" 缺 ${missing.join('/')}`);
    }
  }
  if (problems.length === 0) return null;
  return (
    `batch 项形状不对（${problems.length}/${items.length} 项）：\n  · ${problems.slice(0, 8).join('\n  · ')}\n` +
    '每项形状：{command:"set"|"add"|"remove"|"move"|"swap", path?, parent?, type?, props?, selector?, to?, after?, before?}——' +
    'command 是**裸动词**，动词的参数是**同级字段**。例：' +
    '[{command:"set",path:"/Sheet1/A1",props:{value:"标题"}},{command:"add",parent:"/Sheet1",type:"row",props:{}}]。' +
    '形状与逐格式示例见 officecli 技能 §5.1。**本次未执行任何一项**（预检在派发前）。'
  );
}

/** 单次 CLI 调用载荷上限（保守值）。
 *
 *  真源 = Windows CreateProcess 命令行 32767 字符：命令由 Rust 侧拼成一条 `bash -c`
 *  串（`OFFICECLI_*` 环境钉扎 ~75 字符 + 二进制定位 + 每 token POSIX 单引号），因此按
 *  argv 的 **JSON 长度**估——JSON 还会多转义换行/引号，是偏保守的上界；24 000 与
 *  32767 之间留的余量覆盖固定开销与框架串。
 *  超限 = **静默截断**（landmine O3② 的机理：回执说零失败而字节没全进去），
 *  所以必须在派发前拦。 */
export const OFFICE_ARGV_MAX_CHARS = 24_000;

/** 尺寸体检（返回错误文案；null = 通过）。`payload` 传 argv 的 JSON（非 batch）或单块 items 的 JSON。 */
export function officeArgvOversize(payload: string, max: number = OFFICE_ARGV_MAX_CHARS): string | null {
  if (payload.length <= max) return null;
  return (
    `本次载荷 ${payload.length} 字符 > 单次上限 ${max}（Windows 命令行 32767 字符，超限**静默截断**——回执可能说成功而字节没全进去）。` +
    '修法：把大内容拆成多次调用（长正文分几段 add）；≥3 处改动一律用 batch（它会自动分批）。**不要**原样重发。'
  );
}

/** 分批执行时单批输出的展示上限（防 20+ 批把工具结果撑爆）。 */
function clipBatchOutput(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[本批输出已截断，共 ${text.length} 字符]`;
}

/** playbook 正文的护栏头（2026-09-15 实测事故补丁）：正文是 **officecli 自带的命令行
 *  指南**，模型照它去 shell 里跑 `officecli help …` → `command not found` → 转去找二进制
 *  → 另起常驻进程与本工具抢同一文件 → 写入静默丢失。正文不在本仓、改不了，只能在返回时
 *  补这一层「翻译 + 禁止」。 */
export const PLAYBOOK_GUARD_HEADER = [
  '[兰台] 以下正文来自 OfficeCLI 自带的构建指南。**正文里的 `officecli …` 命令行在本环境不可执行**：',
  '① `officecli` 不在 shell 的 PATH 里；② 直调它会另起一个常驻进程，与本工具的 resident 抢同一个文件 ⇒ 写入静默丢失（2026-09-15 实测：回执「零失败」而磁盘只落 19/180 行）。',
  '读法：把正文每条命令**翻译**成 office 域工具动作（view/get/query/validate/create/set/add/remove/batch/merge/screenshot）。',
  '正文要求「先查 help 确认属性名」——本环境没有 help 通道：属性名没把握时用**一条最小 batch（1 项）**试探，不要下 shell 去试。',
].join('\n');

const officeSchema = z.object({
  action: z
    .enum(OFFICE_ACTIONS)
    .describe('动作（读：view/get/query/validate/playbook；写：create/set/add/remove/batch；交付：merge/screenshot）'),
  file: z
    .string()
    .optional()
    .describe('目标 Office 文件（.docx/.xlsx/.pptx）。相对路径按工作区根解析。除 playbook 外所有动作必填。'),
  playbook: z
    .enum(OFFICE_PLAYBOOKS)
    .optional()
    .describe(
      'playbook 动作的专项技能名（逐格式构建指南，正文 25–65 KB）：word/academic-paper/word-form/pptx/pitch-deck/morph-ppt/morph-ppt-3d/excel/financial-model/data-dashboard。一件产物只载一个，别重复载。',
    ),
  path: z
    .string()
    .optional()
    .describe('元素路径（get/set/remove 用）：1-based 本地名路径，如 /body/p[2]、/slide[1]/shape[@id=2]、/Sheet1/A1。'),
  mode: z
    .enum(VIEW_MODES)
    .optional()
    .describe('view 的读数模式（缺省 text）：text/annotated/outline/stats/issues/html/svg/forms。'),
  selector: z.string().optional().describe('query 的 CSS 式选择器，如 paragraph[style=Heading1]、cell[value>5000]。'),
  props: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'set/add 的属性表（值一律字符串，如 {"text":"标题","style":"Heading1"}；单位/颜色写法见 officecli 技能 §8）。',
    ),
  type: z.string().optional().describe('add 的元素类型：paragraph/run/table/slide/shape/picture/comment/sheet/cell…'),
  parent: z.string().optional().describe('add 的父路径（缺省 /），如 /body、/slide[1]、/Sheet1、/styles。'),
  json: z
    .boolean()
    .optional()
    .describe('view/get/query/validate/batch 追加 --json（结构化输出；token 更贵，按需开）。'),
  items: z.array(z.unknown()).optional().describe('batch 的改动项数组（≥3 处改动优先用它：一次开关 + 原子回滚）。'),
  data: z.record(z.string(), z.string()).optional().describe('merge 的数据映射（键 = 模板里的 {{key}}）。'),
  out: z.string().optional().describe('输出路径（screenshot 的 PNG / merge 的成品文件）。相对路径按工作区根解析。'),
  page: z.number().int().optional().describe('screenshot 的页号（1-based）。'),
  grid: z.boolean().optional().describe('screenshot 出整册联系表（--grid auto）而不是单页。'),
  depth: z.number().int().optional().describe('get 的展开深度。'),
});

/** office 域工具族（S1 三层里的域插件经 ctx.tools 贡献；本族只有一条工具）。 */
export function createOfficeTools(exec: ToolExecutor): Tool[] {
  const tool = defineTool({
    name: 'office',
    description:
      'Read, edit, and produce Office files (.docx / .xlsx / .pptx) through OfficeCLI — the same engine as the `officecli` command line, but with typed actions and no quoting on your side.\n' +
      'Actions: view (read text/annotated/outline/stats/issues) · get (element + children) · query (CSS-like selector) · validate (OpenXML schema) · create · set / add / remove (element edits) · batch (≥3 edits in one atomic pass) · merge (fill {{key}} templates) · screenshot (render page/slides to PNG) · playbook (load a per-format build guide: word/academic-paper/pptx/pitch-deck/excel/financial-model/…).\n' +
      'Writes flush to disk immediately, so other tools and the user see fresh bytes at once.\n' +
      'Before producing a deliverable, run the delivery gate: validate → view issues (overflow/format/structure) → scan view text for leftover placeholders — note issues does NOT catch placeholders, missing image alt text, or empty content; and it does catch pptx overflow/off-slide shapes and xlsx formula errors.\n' +
      'Load the `officecli` skill for the full playbook (units, colors, template flow, tracked changes, pitfalls).',
    schema: officeSchema,
    domain: 'office',
    actions: OFFICE_ACTIONS,
    readOnlyActions: OFFICE_READONLY_ACTIONS,
    readOnly: false,
    execute: async (args, _onProgress, signal) => {
      const a = args as OfficeToolArgs;
      // meta key（executor 注入）取 owner 身份：相对路径按**该会话的工作区根**解析。
      const owner =
        typeof (args as { _owner_id?: unknown })._owner_id === 'string'
          ? ((args as { _owner_id?: string })._owner_id as string)
          : typeof (args as { _agent_id?: unknown })._agent_id === 'string'
            ? ((args as { _agent_id?: string })._agent_id as string)
            : undefined;
      const ctx = ownerContext(owner);
      const root = ctx?.workspaceRoot;
      const resolve = (p: string): string => {
        const norm = p.replace(/\\/g, '/');
        if (isAbsolutePath(norm) || !root) return norm;
        return resolveAgainstRoot(root, norm).replace(/\\/g, '/');
      };
      // cwd：沿用该 owner 的粘性 cwd（若无则工作区根）——execStreamedShell 会按命令
      // 落点回写粘性 cwd，这里刻意给"当前值"以免 office 调用把 shell 域的 cwd 顶掉。
      const cwd = stickyCwdOf(owner) ?? root;

      const runOne = async (argv: readonly string[]): Promise<{ text: string; exit: number | null }> => {
        // 经 process_cap 的 office_exec 动作（2026-09-15 R3）：命令由 Rust 侧拼装，
        // 门禁 = OfficeTool（只审 officeTargets 声明的目标文件）。本层不碰引号/二进制定位。
        const out = await exec(
          'process_cap',
          {
            action: 'office_exec',
            office: { argv: [...argv], targets: officeTargets(a, resolve) },
            timeout_ms: 120_000,
            ...(cwd ? { cwd } : {}),
            ...metaForward(args),
          },
          undefined,
          signal,
        );
        return { text: cleanShellOutput(out), exit: parseShellExit(out) };
      };

      // 落盘脚注：**只看退出码说话**（2026-09-15 事故——失败也追加"已落盘"，模型据此
      // 当成功继续）。成功语义自 R3.1 起变硬：Rust 侧钉 OFFICECLI_NO_AUTO_RESIDENT=1
      // ⇒ 每次调用自成一次 open/save、字节当场写盘，不再依赖谁去 flush；exit 0 = 字节在盘上。
      const flushTail = (exit: number | null, text: string): string => {
        if (!MUTATING_ACTIONS.has(a.action)) return '';
        const closedForeign = /Resident closed for/i.test(text)
          ? '\n[office] 该文件上有一个**外部**常驻进程（用户起的 watch / 旧进程残留），create 之前已先 close 掉它——否则 create 会被它的文件锁硬拒，连 --force 也无效。若你在用活预览窗，请重新起 watch。'
          : '';
        if (exit === 0) {
          return `${closedForeign}\n[office] 改动已落盘（本次不常驻：自成一次 open/save，字节当场写盘）。`;
        }
        if (exit === null) {
          return '\n[office] ⚠️ 本次调用没拿到退出码 —— 结果**未知**，不要当成功继续。';
        }
        return `\n[office] ⚠️ 本次改动**未成功**（退出码 ${exit}）：上面的报错才是真相，按它修参数后重试，不要当成功继续。`;
      };

      // batch：项形状预检 + 超大载荷切块（见 OFFICE_BATCH_MAX_*）。
      // 两条闸都在**任何派发之前**（fail fast，杜绝"前几批已落盘"才发现形状错）。
      if (a.action === 'batch' && Array.isArray(a.items) && a.items.length > 0) {
        const badItems = validateOfficeBatchItems(a.items);
        if (badItems) return `[office] ${badItems}`;
        const chunks = splitOfficeBatchItems(a.items);
        // 单块超限（例如**单项**就很大，切不开）：这也是静默截断的入口，必须拦在派发前
        // ——此前只有 chunks.length > 1 才走护栏，单块直接落回普通路径无检查（2026-09-16）。
        for (let i = 0; i < chunks.length; i++) {
          const oversize = officeArgvOversize(JSON.stringify(chunks[i] ?? []));
          if (oversize) {
            return `[office] batch 第 ${i + 1}/${chunks.length} 块（${chunks[i]?.length ?? 0} 项）无法单次送达：${oversize}`;
          }
        }
        if (chunks.length > 1) {
          const lines: string[] = [
            `[office] batch 共 ${a.items.length} 项 → 分 ${chunks.length} 批执行（每批自身原子回滚；**批与批之间不原子**，已成功的批次不回退）。`,
          ];
          let failedAt = 0;
          let failedUnknown = false;
          let lastText = '';
          for (let i = 0; i < chunks.length; i++) {
            const argv = buildOfficeArgv({ ...a, items: chunks[i] }, resolve);
            if (typeof argv === 'string') return `[office] ${argv}`;
            const r = await runOne(argv);
            lastText = r.text;
            lines.push(`── 批 ${i + 1}/${chunks.length}（${chunks[i]?.length ?? 0} 项）──\n${clipBatchOutput(r.text)}`);
            if (r.exit !== 0) {
              failedAt = i + 1;
              failedUnknown = r.exit === null;
              break;
            }
          }
          lines.push(
            failedAt === 0
              ? `[office] ${chunks.length} 批全部成功，共 ${a.items.length} 项。${flushTail(0, lastText)}`
              : failedUnknown
                ? `[office] ⚠️ 第 ${failedAt}/${chunks.length} 批**结果未知**（没拿到退出码）并已停下：前 ${failedAt - 1} 批已落盘。先 office(view) 核对目标文件判断第 ${failedAt} 批是否已生效，再决定要不要补做——**不要整表重来**。`
                : `[office] ⚠️ 第 ${failedAt}/${chunks.length} 批失败并已停下：前 ${failedAt - 1} 批已落盘、第 ${failedAt} 批起**未执行**。修好该批的报错后**只补做第 ${failedAt} 批起的数据**，不要整表重来。`,
          );
          return lines.join('\n');
        }
      }

      const argv = buildOfficeArgv(a, resolve);
      if (typeof argv === 'string') return `[office] ${argv}`;
      // 非 batch 写动作同样要过尺寸闸（长 props / 大 data 一样会撞 Windows 命令行上限，
      // 此前只有多块 batch 有护栏）。
      const oversize = officeArgvOversize(JSON.stringify(argv));
      if (oversize) return `[office] ${a.action} 无法单次送达：${oversize}`;
      const r = await runOne(argv);
      const body = a.action === 'playbook' ? `${PLAYBOOK_GUARD_HEADER}\n\n────────────\n\n${r.text}` : r.text;
      return `${body}${flushTail(r.exit, r.text)}`;
    },
  });
  return [tool];
}
