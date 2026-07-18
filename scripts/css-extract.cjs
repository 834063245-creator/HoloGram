// P5 一次性迁移脚本：从 base/chat/panels.css 抽取活规则 → 新 app CSS，变量映射到 --obs-*
// 用法: node scripts/css-extract.cjs   （依赖 /tmp/css-survey.json 的活 selector 集）
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const survey = JSON.parse(fs.readFileSync('/tmp/css-survey.json', 'utf8'));

// 活 selector 全集（class/id 名）
const live = new Set();
for (const d of Object.values(survey.report)) for (const s of d.live) live.add(s.name);

// ── 变量映射：旧 token → obs token / 字面量 ─────────────────────
const VAR_MAP = [
  [/--void-deep\b/g, '--obs-void-deep'],
  [/--void\b/g, '--obs-void'],
  [/--panel-bg\b/g, '--obs-glass-hi'],
  [/--panel-edge\b/g, '--obs-line'],
  [/--starlight-dim\b/g, '--obs-text'],
  [/--starlight\b/g, '--obs-text'],
  [/--text-muted\b/g, '--obs-text-2'],
  [/--text-faint\b/g, '--obs-text-3'],
  [/--text-dim\b/g, '--obs-text-2'],
  [/--text-soft\b/g, '--obs-text'],
  [/--signal-bright\b/g, '--obs-blue'],
  [/--signal-glow\b/g, 'rgba(125, 179, 232, 0.3)'],
  [/--signal\b/g, '--obs-blue'],
  [/--sol-bright\b/g, '--obs-brass-hi'],
  [/--sol-glow\b/g, 'var(--obs-brass-dim)'],
  [/--sol\b/g, '--obs-brass'],
  [/--nebula-bright\b/g, '#c0a8ff'],
  [/--nebula-glow\b/g, 'rgba(160, 136, 224, 0.25)'],
  [/--nebula\b/g, '#a088e0'],
  [/--anomaly-red\b/g, '--obs-fail'],
  [/--anomaly-orange\b/g, '--obs-warn'],
  [/--anomaly-green\b/g, '--obs-pass'],
  [/--pass\b/g, '--obs-pass'],
  [/--fail\b/g, '--obs-fail'],
  [/--warn\b/g, '--obs-warn'],
  [/--font-hud\b/g, '--obs-font-mono'],
  [/--font-mono\b/g, '--obs-font-mono'],
  [/--font-body\b/g, '--obs-font-body'],
  [/--snap\b/g, '--obs-snap'],
  [/--glide\b/g, '--obs-glide'],
  [/--orbit\b/g, '0.45s cubic-bezier(0.34, 1.56, 0.64, 1)'],
  [/--blur\b/g, 'blur(8px)'],
  [/--toolbar-h\b/g, '--obs-bar-h'],
  [/--status-h\b/g, '--obs-status-h'],
];
function mapVars(text) {
  let out = text;
  for (const [re, to] of VAR_MAP) out = out.replace(re, to);
  return out;
}

// ── CSS 解析：顶层块（规则 / @keyframes / 注释）─────────────────
function parseBlocks(css) {
  const blocks = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    // 跳过空白
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;
    // 注释
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i) + 2;
      blocks.push({ type: 'comment', text: css.slice(i, end) });
      i = end;
      continue;
    }
    // 找第一个 { 或 ;
    let j = i;
    while (j < n && css[j] !== '{' && css[j] !== ';') j++;
    const header = css.slice(i, j).trim();
    if (j >= n) break;
    if (css[j] === ';') {
      blocks.push({ type: 'atleaf', header, text: css.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // 平衡大括号
    let depth = 0;
    let k = j;
    while (k < n) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') {
        depth--;
        if (depth === 0) { k++; break; }
      }
      k++;
    }
    const text = css.slice(i, k);
    const type = header.startsWith('@keyframes') ? 'keyframes' : header.startsWith('@') ? 'atrule' : 'rule';
    blocks.push({ type, header, text });
    i = k;
  }
  return blocks;
}

function selTokens(header) {
  const names = [];
  const head = header.split('{')[0];
  for (const m of head.matchAll(/\.([a-zA-Z][\w-]*)/g)) names.push(m[1]);
  for (const m of head.matchAll(/#([a-zA-Z][\w-]*)/g)) names.push(m[1]);
  return names;
}

// ── 路由 ───────────────────────────────────────────────────────
const CHROME = new Set([
  'graph-legend', 'legend-section', 'legend-title', 'legend-row', 'legend-swatch', 'legend-edge-swatch',
  'graph-focus-banner', 'graph-tooltip', 'tt-name', 'tt-meta', 'tt-loc',
  'detail-card', 'galaxy-label', 'galaxy-flash-label', 'corner-brackets', 'cb-bottom',
  'file-viewer', 'fv-preview', 'fv-grip', 'fv-open', 'hg-icon',
]);
function route(srcFile, block) {
  const toks = selTokens(block.header);
  if (srcFile === 'base.css') {
    if (toks.some((t) => t.startsWith('dc-') || CHROME.has(t))) return 'graph-chrome';
    return 'foundation';
  }
  if (srcFile === 'chat.css') {
    if (toks.some((t) => t.startsWith('check-') || t === 'check-panel')) return 'dock-panels';
    return 'chat';
  }
  // panels.css
  if (toks.length === 1 && toks[0] === 'hidden') return 'foundation';
  return 'dock-panels';
}

// base.css 里 selector 无 class/id 但必留的（reset/body/scrollbar）
const FORCE_FOUNDATION = /^(?:\*|html|::-webkit-scrollbar)/;

// ── 主流程 ─────────────────────────────────────────────────────
const out = { foundation: [], 'graph-chrome': [], chat: [], 'dock-panels': [] };
const keyframesAll = {}; // name -> text (mapped)
const stats = { kept: 0, dropped: 0 };

for (const srcFile of ['base.css', 'chat.css', 'panels.css']) {
  const css = fs.readFileSync(path.join(ROOT, 'src-ui/src/ui/react', srcFile), 'utf8');
  const blocks = parseBlocks(css);
  for (const b of blocks) {
    if (b.type === 'comment') continue; // 段落注释不带（新文件自己写头）
    if (b.type === 'atleaf') continue;  // @import 等
    if (b.type === 'keyframes') {
      const name = b.header.match(/@keyframes\s+([\w-]+)/)?.[1];
      if (name) keyframesAll[name] = mapVars(b.text);
      continue;
    }
    if (b.type === 'atrule') { stats.dropped++; continue; } // 无 @media
    const toks = selTokens(b.header);
    const isLive = toks.some((t) => live.has(t));
    const forced = srcFile === 'base.css' && toks.length === 0 && FORCE_FOUNDATION.test(b.header.trim());
    if (!isLive && !forced) { stats.dropped++; continue; }
    // welcome 旧样式不搬（按原型重写）；space/scanlines/vignette 同理
    if (toks.includes('welcome') || toks.includes('space') || toks.includes('scanlines') || toks.includes('vignette')) {
      stats.dropped++;
      continue;
    }
    const dest = route(srcFile, b);
    out[dest].push({ src: srcFile, text: mapVars(b.text) });
    stats.kept++;
  }
}

// keyframes 引用扫描：只输出被引用者
function emitFile(dest, headerComment) {
  const rules = out[dest];
  const body = rules.map((r) => r.text).join('\n\n');
  const usedKf = new Set();
  for (const m of body.matchAll(/animation(?:-name)?\s*:\s*([\w-]+)/g)) {
    const name = m[1];
    if (keyframesAll[name]) usedKf.add(name);
  }
  // 多值 animation 简写里名字可能不在第一个 token —— 兜底全量名匹配
  for (const name of Object.keys(keyframesAll)) {
    if (new RegExp(`animation[^;{]*\\b${name}\\b`).test(body)) usedKf.add(name);
  }
  const kfText = [...usedKf].map((k) => keyframesAll[k]).join('\n\n');
  const final = `${headerComment}\n\n${body}${kfText ? `\n\n/* ── keyframes ── */\n\n${kfText}` : ''}\n`;
  return { text: final, kf: [...usedKf], count: rules.length };
}

const HEADERS = {
  foundation: `/* ═══════════════════════════════════════════════════════════════
   HOLOGRAM · 地基样式（P5 — 自 base.css/panels.css 抽取，变量已映射 --obs-*）
   内容：reset / body / 滚动条 / #graph 画布容器 / 全局 .hidden
   ═══════════════════════════════════════════════════════════════ */`,
  'graph-chrome': `/* ═══════════════════════════════════════════════════════════════
   HOLOGRAM · 星图铬件（P5 — 自 base.css 抽取，变量已映射 --obs-*）
   内容：图例 / 聚焦横幅 / 节点 tooltip / detail-card / 星系标签 /
   corner-brackets / file-viewer / hg-icon
   操控方：ui/graph-ui.ts · graph-tooltip.ts · graph-fold.ts · file-viewer.ts
   ═══════════════════════════════════════════════════════════════ */`,
  chat: `/* ═══════════════════════════════════════════════════════════════
   HOLOGRAM · 聊天样式（P5 — 自 ui/react/chat.css + beacon.css 抽取合并，
   变量已映射 --obs-*；类契约不变，组件零改动）
   ═══════════════════════════════════════════════════════════════ */`,
  'dock-panels': `/* ═══════════════════════════════════════════════════════════════
   HOLOGRAM · dock 六面板样式（P5 — 自 panels.css + chat.css 的 check-* 抽取，
   变量已映射 --obs-*；面板根 id 定位契约不变）
   ═══════════════════════════════════════════════════════════════ */`,
};

const results = {};
for (const dest of Object.keys(out)) results[dest] = emitFile(dest, HEADERS[dest]);

// beacon.css 内容并进 chat.css（本身已是 obs 风格，无需映射）
const beacon = fs.readFileSync(path.join(ROOT, 'src-ui/src/app/chat/beacon.css'), 'utf8');
results.chat.text = results.chat.text.replace(/\n$/, `\n\n/* ── P2′ 信标增量（原 beacon.css）── */\n\n${beacon.replace(/\/\*[=\s\S]*?\*\/\s*/, '')}\n`);

fs.mkdirSync(path.join(ROOT, 'src-ui/src/app/panels'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'src-ui/src/app/foundation.css'), results.foundation.text);
fs.writeFileSync(path.join(ROOT, 'src-ui/src/app/graph-chrome.css'), results['graph-chrome'].text);
fs.writeFileSync(path.join(ROOT, 'src-ui/src/app/chat/chat.css'), results.chat.text);
fs.writeFileSync(path.join(ROOT, 'src-ui/src/app/panels/dock-panels.css'), results['dock-panels'].text);

for (const [d, r] of Object.entries(results)) console.log(d, 'rules:', r.count, 'keyframes:', r.kf.join(','), 'bytes:', r.text.length);
console.log('stats', stats);
