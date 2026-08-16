// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 从 src-tauri/src/rpc.rs 生成 docs/agents/frontend-rpc-contract.md。
// 用法：node scripts/gen-rpc-contract-md.cjs
// 纪律：md 是生成物，勿手改；改 rpc.rs 后重新运行本脚本。
//
// 实现说明：rpc.rs 为 GBK 编码，方法名/参数名均为 ASCII 可直读；
// 分区标题以「重复字节对占行 80% 以上」的箱线行识别边界，标题文本硬编码。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RPC_RS = path.join(ROOT, 'src-tauri', 'src', 'rpc.rs');
const OUT_MD = path.join(ROOT, 'docs', 'agents', 'frontend-rpc-contract.md');

// 与 rpc.rs 中分区注释顺序一致（仅用于 md 标题；序号与文件行序绑定）
const SECTIONS = [
  'Engine 调度',
  'Graph',
  'Git',
  '文件系统',
  '搜索',
  'Web',
  'CDP 浏览器控制',
  'Shell',
  '编辑器',
  '身份认证 / 权限',
  'Agent 隔离（worktree）',
  '外部服务',
  'Hologram 遗留命令',
  '工作区',
  '会话持久化',
  '约束',
  '数据流',
  'Aura 记忆',
  'PTY',
  'LSP',
];

function readLines(file) {
  const buf = fs.readFileSync(file);
  return buf.toString('utf8').split(/\r?\n/);
}

// 判断箱线分隔行：rpc.rs 混合编码，箱线 ═ 是合法 UTF-8（U+2550），
// 中文注释是 GBK。箱线行 = 连续 30+ 个 U+2550。
function isBoxLine(rawUtf8Line) {
  return /^\s*\/\/\s*\u2550{30,}/.test(rawUtf8Line);
}

const OPT_HELPERS = /opt_(str|bool|i32|u32|u64|usize)\(\s*&params,\s*"([a-z_]+)"/g;
const REQ_HELPERS = /req_(str|strs|u16)\(\s*&params,\s*"([a-z_]+)"/g;

function extractParams(branch) {
  const req = [];
  const opt = [];
  const seen = new Set();
  let m;

  REQ_HELPERS.lastIndex = 0;
  while ((m = REQ_HELPERS.exec(branch)) !== null) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      req.push(m[2]);
    }
  }

  // 内联必选：params.get("x") ... ok_or(else)
  const inlineReq = /params\.get\("([a-z_]+)"\)[\s\S]*?\.ok_or/gi;
  inlineReq.lastIndex = 0;
  while ((m = inlineReq.exec(branch)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      req.push(m[1]);
    }
  }

  // opt helper + ok_or_else 组合：语义上仍是必选（如 opt_u32(&params, "session_id").ok_or_else(...)?）
  const optReq = /opt_(?:str|bool|i32|u32|u64|usize)\(\s*&params,\s*"([a-z_]+)"\)[\s\S]{0,120}?\.ok_or/gi;
  optReq.lastIndex = 0;
  while ((m = optReq.exec(branch)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      req.push(m[1]);
    }
  }

  OPT_HELPERS.lastIndex = 0;
  while ((m = OPT_HELPERS.exec(branch)) !== null) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      opt.push(m[2]);
    }
  }

  // 内联可选：params.get("x") 且无 ok_or 后缀（args/paths/rewrite/level/params 等）
  const inlineOpt = /params\.get\("([a-z_]+)"\)/g;
  inlineOpt.lastIndex = 0;
  while ((m = inlineOpt.exec(branch)) !== null) {
    if (!seen.has(m[1])) {
      const fromIdx = branch.indexOf('params.get("' + m[1] + '")');
      const chunk = branch.slice(fromIdx, fromIdx + 200);
      if (!chunk.includes('.ok_or')) {
        seen.add(m[1]);
        opt.push(m[1]);
      }
    }
  }

  return { req, opt };
}

function resultKind(branch) {
  if (branch.includes('ok_unit(')) return '`null`（unit）';
  if (branch.includes('.map(|_| "null"')) return '`null`（unit）';
  if (branch.includes('ok_json(')) return 'JSON 字符串';
  return '字符串';
}

// ── 事件表：从 src-tauri 的 app.emit("...") 调用提取 ──

function appendEvents(md, root) {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.rs')) files.push(p);
    }
  })(path.join(root, 'src-tauri', 'src'));

  const events = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/emit\("([a-z][a-z:-]*)"\s*,/g)) {
      const rel = path.relative(root, f).replace(/\\/g, '/');
      if (!events.has(m[1])) events.set(m[1], []);
      if (!events.get(m[1]).includes(rel)) events.get(m[1]).push(rel);
    }
  }

  md += '\n## 事件（Rust 侧 emit → 前端 listen）\n\n';
  md += 'payload 类型见 `src-ui/src/rpc-contract.ts` 的 `EventContract`（前端类型化入口 `typedListen`）。\n\n';
  md += '| 事件名 | 发射源 |\n|--------|--------|\n';
  for (const [name, sources] of [...events.entries()].sort()) {
    md += `| \`${name}\` | ${sources.join(', ')} |\n`;
  }
  md += '\n> `goal:state` 等事件为前端内部 EventBus（非 IPC），不走 listen。\n';
  return md;
}

function main() {
  const lines = readLines(RPC_RS);
  const src = fs.readFileSync(RPC_RS, 'utf8');
  let branchBlocks = [];
  // 分支闭合行要求 `}` 后紧跟行尾（CRLF 容忍），避免被分支内 `};` 提前截断
  const branchRe = /^\s*"([a-z0-9_]+)"\s*=>\s*\{([\s\S]*?)\n\s*\}\r?\n/gm;
  let bm;
  while ((bm = branchRe.exec(src)) !== null) {
    branchBlocks.push({ name: bm[1], body: bm[2], pos: bm.index });
  }
  // 单行分支（如 "stop_mcp_server" => commands::external::stop_mcp_server().await,）
  const singleRe = /^\s*"([a-z0-9_]+)"\s*=>\s*([^\n]+),\s*$/gm;
  singleRe.lastIndex = 0;
  let sm;
  while ((sm = singleRe.exec(src)) !== null) {
    if (!branchBlocks.some((b) => b.name === sm[1])) {
      branchBlocks.push({ name: sm[1], body: sm[2], pos: sm.index });
    }
  }
  // 只保留外层 match method.as_str() 的直接分支：按大括号深度解析。
  // 内层 match（如 browser_cookies 的 "list"/"set"/"delete"）不是 RPC 方法，
  // 误缩进的顶层分支（如 "bash_kill" 16 空格）也按深度正确识别。
  const matchLine = lines.findIndex((l) => l.includes('match method.as_str() {'));
  if (matchLine >= 0) {
    let depth = 0;
    const topLevelNames = new Set();
    for (let i = matchLine; i < lines.length; i++) {
      const arm = lines[i].match(/^\s*"([a-z0-9_]+)"\s*=>/);
      if (arm && depth === 1) topLevelNames.add(arm[1]);
      const code = lines[i].replace(/\/\/.*$/, '');
      for (const ch of code) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth <= 0) break;
    }
    branchBlocks = branchBlocks.filter((b) => topLevelNames.has(b.name));
  }

  // 用 match 位置排序（indexOf 会被 rpc.rs 头注释中的同名示例串干扰）
  branchBlocks.sort((a, b) => a.pos - b.pos);

  // 分区边界：箱线成对出现（标题上下各一条，中间可夹多行注释），
  // 间隙 ≤5 行的箱线归并为同一标题块（分区间间隙 ≥8，不会误并）；
  // 方法所属分区 = 起始行之前最后一个完整块的下标
  const sepIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBoxLine(lines[i])) sepIdx.push(i);
  }
  // 箱线成对判定：开口线后紧跟分区标题注释（非箱线），闭合线后紧跟方法代码。
  // 不能用固定行距合并——CDP 分区注释有 13 行，而相邻分区开口线只隔 8 行。
  const sepBlocks = [];
  let open = null;
  for (const i of sepIdx) {
    const next = (lines[i + 1] ?? '').trim();
    const isOpening = next.startsWith('//') && !isBoxLine(next);
    if (isOpening) {
      if (open !== null) sepBlocks.push([open]); // 容错：保留未闭合开口
      open = i;
    } else if (open !== null) {
      sepBlocks.push([open, i]);
      open = null;
    } else {
      sepBlocks.push([i]); // 容错：孤立闭合线
    }
  }
  if (open !== null) sepBlocks.push([open]);
  let md = '';  md += '# 前端 RPC 契约（生成物）\n\n';
  md += '> 由 `scripts/gen-rpc-contract-md.cjs` 从 `src-tauri/src/rpc.rs` 生成 — 勿手改。\n';
  md += '> 生成时间：' + new Date().toISOString() + '\n';
  md += '> 方法总数：' + branchBlocks.length + '（rpc.rs 头注释为历史数字，以此表为准）\n\n';
  md += '前端类型化入口：`src-ui/src/rpc-contract.ts`（`typedRpc` / `typedListen`，编译期接线检查）。\n\n';
  md += '约定：参数键一律 snake_case；返回均为字符串，`JSON 字符串` 类需 `JSON.parse`（`null` 为 unit 返回）。\n\n';

  let sectionIdx = -1;
  let warned = false;
  branchBlocks.forEach((b, i) => {
    const lineNo = src.slice(0, b.pos).split('\n').length - 1;
    const section = sepBlocks.filter((blk) => blk[blk.length - 1] < lineNo).length - 1; 
    if (section >= SECTIONS.length) {
      if (!warned) {
        console.warn('[warn] 分支行号超过分区数，请检查 SECTIONS 与 rpc.rs 是否同步');
        warned = true;
      }
      return;
    }
    if (section !== sectionIdx) {
      if (sectionIdx !== 0) md += '\n';
      md += '## ' + SECTIONS[section] + '\n\n';
      md += '| 方法 | 必选参数 | 可选参数 | 返回 |\n|------|----------|----------|------|\n';
      sectionIdx = section;
    }
    const { req, opt } = extractParams(b.body);
    md += `| \`${b.name}\` | ${req.join(', ') || '—'} | ${opt.join(', ') || '—'} | ${resultKind(b.body)} |\n`;
  });

  md = appendEvents(md, ROOT);
  fs.writeFileSync(OUT_MD, md, 'utf8');
  console.log(`[ok] ${branchBlocks.length} methods → ${OUT_MD}`);
}

main();
