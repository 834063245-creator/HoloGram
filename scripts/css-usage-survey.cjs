// 一次性勘察脚本：交叉比对「活代码引用的 class/id」与「三大旧 CSS 定义的 selector」
// 用法: node scripts/css-usage-survey.cjs
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src-ui', 'src');
const CSS_FILES = [
  'src-ui/src/ui/react/base.css',
  'src-ui/src/ui/react/chat.css',
  'src-ui/src/ui/react/panels.css',
];

// ── 1. 收集活代码里出现的 class / id 引用 ──────────────────────
const exts = new Set(['.ts', '.tsx']);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (exts.has(path.extname(e.name))) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const usedClasses = new Map(); // name -> Set<file>
const usedIds = new Map();
function mark(map, name, file) {
  if (!name || /^[0-9]/.test(name)) return;
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(path.relative(SRC, file));
}

const classAttrRe = /(?:className|class)\s*=\s*(?:\{`([^`]+)`\}|"([^"]+)"|'([^']+)'|\{['"]([^'"]+)['"]\})/g;
const strRe = /[`'"]([^`'"]+)[`'"]/g;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  // className="..." / class="..." / clsx(`...`)
  for (const m of text.matchAll(/(?:className|class)\s*=\s*\{?`([^`]+)`\}?/g))
    for (const tok of m[1].split(/[\s${}()?:'"&|!]+/)) mark(usedClasses, tok, f);
  for (const m of text.matchAll(/(?:className|class)\s*=\s*["']([^"']+)["']/g))
    for (const tok of m[1].split(/\s+/)) mark(usedClasses, tok, f);
  // classList.add/remove/toggle('x'), querySelector('.x' / '#x'), getElementById
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*['"`]([^'"`]+)['"`]/g))
    mark(usedClasses, m[1], f);
  for (const m of text.matchAll(/querySelector(?:All)?(?:<[^>]+>)?\(\s*['"`]([^'"`]+)['"`]/g)) {
    for (const m2 of m[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) mark(usedClasses, m2[1], f);
    for (const m2 of m[1].matchAll(/#([a-zA-Z][\w-]*)/g)) mark(usedIds, m2[1], f);
  }
  for (const m of text.matchAll(/getElementById\(\s*['"`]([^'"`]+)['"`]/g)) mark(usedIds, m[1], f);
  // createElement 后 id 赋值 / el.id = 'x'
  for (const m of text.matchAll(/\.id\s*=\s*['"`]([^'"`]+)['"`]/g)) mark(usedIds, m[1], f);
  // innerHTML 模板里的 class="..."
  for (const m of text.matchAll(/class="([^"]+)"/g))
    for (const tok of m[1].split(/\s+/)) mark(usedClasses, tok, f);
  // id="..."（模板字符串 html）
  for (const m of text.matchAll(/id="([^"]+)"/g)) mark(usedIds, m[1], f);
}

// ── 2. 解析旧 CSS 的 selector ──────────────────────────────────
function parseSelectors(cssText) {
  const noComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Map(); // name -> {kind, lines[]}
  const lines = noComments.split('\n');
  let buf = '';
  let bufStart = 0;
  const flush = (endLine) => {
    const sel = buf.trim();
    buf = '';
    if (!sel || sel.startsWith('@') || sel.includes('{') === false) return;
    const head = sel.split('{')[0];
    for (const part of head.split(',')) {
      for (const m of part.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
        if (!names.has(m[1])) names.set(m[1], { kind: 'class', lines: [] });
        names.get(m[1]).lines.push(bufStart + 1);
      }
      for (const m of part.matchAll(/#([a-zA-Z][\w-]*)/g)) {
        if (!names.has(m[1])) names.set(m[1], { kind: 'id', lines: [] });
        names.get(m[1]).lines.push(bufStart + 1);
      }
    }
  };
  for (let i = 0; i < lines.length; i++) {
    if (buf === '') bufStart = i;
    buf += lines[i] + '\n';
    if (lines[i].includes('{')) flush(i);
  }
  return names;
}

// ── 3. 交叉比对输出 ────────────────────────────────────────────
const report = {};
for (const cssPath of CSS_FILES) {
  const full = path.join(__dirname, '..', cssPath);
  const sels = parseSelectors(fs.readFileSync(full, 'utf8'));
  const live = [];
  const dead = [];
  for (const [name, meta] of [...sels.entries()].sort()) {
    if (usedClasses.has(name) || usedIds.has(name)) live.push({ name, ...meta, usedBy: [...(usedClasses.get(name) || usedIds.get(name))] });
    else dead.push(name);
  }
  report[cssPath] = { live, deadCount: dead.length, dead };
}

// index.html 的 id（welcome/space/scanlines/vignette/graph/app-root）
const html = fs.readFileSync(path.join(__dirname, '..', 'src-ui', 'index.html'), 'utf8');
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

console.log(JSON.stringify({ report, htmlIds }, null, 1));
