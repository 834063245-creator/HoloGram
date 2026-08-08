import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIRS = [
  path.join(ROOT, '.hologram', 'sessions'),
  path.join(ROOT, '.hologram', 'agents'),
];
const LOOKAHEAD = Number(process.env.LOOKAHEAD) || 5;

const MARKERS = [
  { hook: 'graph-context', marker: '📊 [图上下文]' },
  { hook: 'state-read', marker: '📋 [状态]' },
  { hook: 'plan-explore-graph', marker: '📊 [Plan 图上下文]' },
  { hook: 'plan-write-graph', marker: '📊 [自动影响面分析' },
  { hook: 'graph-preflight', marker: '⚠️ [自动影响分析]' },
  { hook: 'graph-preflight-git', marker: '⚠️ [切换分支]' },
  { hook: 'graph-preflight-git', marker: '⚠️ [提交]' },
  { hook: 'state-preflight', marker: '[LSP]' },
];

const KNOWN_TOOLS = new Set([
  'read_file_content', 'read_file', 'search_content', 'glob', 'list_directory',
  'trace_dataflow', 'search_symbols', 'inspect_symbol', 'git_diff', 'run_shell',
  'resolve_call', 'infer_type', 'find_implementations', 'find_references',
  'edit_file', 'write_file', 'delete_file', 'rename_file', 'move_file',
  'git_discard', 'git_checkout', 'git_commit', 'trace_impact', 'explore_deps',
  'get_neighbors', 'get_community', 'fragile_modules', 'graph_summary',
  'git_status', 'git_stash_push', 'git_log', 'git_branch', 'hologram_explore',
  'web_search', 'agent_spawn', 'apply_patch',
]);

const GUIDANCE_RE = /(?:调|调用|使用|用|check|use)\s*(?:[`"'“”])?\s*([a-zA-Z_][a-zA-Z0-9_.\-]*)/g;
const ARROW_RE = /→\s*(?:调\s*)?([a-zA-Z_][a-zA-Z0-9_.\-]*)/g;

function collectFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function loadMessages(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size < 200) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (!Array.isArray(j.messages) || j.messages.length === 0) return null;
    return j.messages;
  } catch {
    return null;
  }
}

function extractBlock(content, marker) {
  const idx = content.indexOf(marker);
  if (idx < 0) return null;
  const slice = content.slice(idx, idx + 2000);
  const sep = slice.search(/(?:^|\n)[─\-]{30,}/);
  const cut = sep > 0 ? slice.slice(0, sep) : slice;
  const block = cut.slice(0, 1500);
  return block.length > 30 ? block : null;
}

function extractSuggestions(block) {
  const found = new Map();
  for (const re of [GUIDANCE_RE, ARROW_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(block)) !== null) {
      const tool = m[1].toLowerCase();
      if (KNOWN_TOOLS.has(tool)) found.set(tool, true);
    }
  }
  return [...found.keys()];
}

const suggestions = [];
let injections = 0;
const sessionStats = [];
const hookInjections = new Map();
const toolCallsTotal = new Map();

for (const dir of DIRS) {
  for (const file of collectFiles(dir)) {
    const messages = loadMessages(file);
    if (!messages) continue;

    const calls = [];
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          calls.push({ type: 'call', name: tc.name, pos: calls.length });
          toolCallsTotal.set(tc.name, (toolCallsTotal.get(tc.name) || 0) + 1);
        }
      } else if (msg.role === 'tool' && typeof msg.content === 'string') {
        calls.push({ type: 'result', name: msg.name || '', content: msg.content, pos: calls.length });
      }
    }

    const callPositions = calls.map((c, i) => (c.type === 'call' ? i : -1)).filter((i) => i >= 0);
    let sessionInj = 0;
    let sessionSug = 0;
    let sessionAdopt = 0;

    for (const c of calls) {
      if (c.type !== 'result' || !c.content) continue;
      const isWriteResult = ['edit_file', 'write_file', 'delete_file', 'rename_file', 'move_file', 'git_discard', 'git_checkout', 'git_commit'].includes(c.name);

      for (const { hook, marker } of MARKERS) {
        if (marker === '[LSP]' && !isWriteResult) continue;
        if (!c.content.includes(marker)) continue;
        const block = extractBlock(c.content, marker);
        if (!block) continue;

        injections++;
        sessionInj++;
        hookInjections.set(hook, (hookInjections.get(hook) || 0) + 1);

        const suggested = extractSuggestions(block);
        if (suggested.length === 0) continue;

        for (const tool of suggested) {
          sessionSug++;
          const nextCalls = callPositions.filter((p) => p > c.pos).slice(0, LOOKAHEAD);
          const adopted = nextCalls.some((p) => calls[p].name.toLowerCase() === tool);
          if (adopted) sessionAdopt++;
          suggestions.push({ hook, tool, adopted });
        }
      }
    }
    sessionStats.push({
      file: path.basename(path.dirname(file)) + '/' + path.basename(file),
      injections: sessionInj,
      suggestions: sessionSug,
      adoptions: sessionAdopt,
    });
  }
}

function rate(n, d) {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}

const perTool = new Map();
for (const s of suggestions) {
  if (!perTool.has(s.tool)) perTool.set(s.tool, { sug: 0, adopt: 0 });
  const e = perTool.get(s.tool);
  e.sug++;
  if (s.adopted) e.adopt++;
}

const perHook = new Map();
for (const [hook, inj] of hookInjections) {
  perHook.set(hook, { sug: 0, adopt: 0, inj });
}
for (const s of suggestions) {
  if (!perHook.has(s.hook)) perHook.set(s.hook, { sug: 0, adopt: 0, inj: 0 });
  const e = perHook.get(s.hook);
  e.sug++;
  if (s.adopted) e.adopt++;
}

const lines = [];
lines.push('═══ HoloGram Hook 引导采纳率报告 ═══');
lines.push(`数据范围: ${sessionStats.length} 个会话, 注入块 ${injections} 条, 引导建议 ${suggestions.length} 条 (lookahead=${LOOKAHEAD} 次工具调用)`);
lines.push('');
lines.push('── 按引导目标工具 ──');
lines.push('目标工具                    建议次数  采纳次数  采纳率');
for (const [tool, e] of [...perTool.entries()].sort((a, b) => b[1].sug - a[1].sug)) {
  lines.push(`${tool.padEnd(28)}${String(e.sug).padStart(6)}${String(e.adopt).padStart(10)}${rate(e.adopt, e.sug).padStart(9)}`);
}
lines.push('');
lines.push('── 基线对照 (建议 vs 总调用) ──');
lines.push('工具                          总调用  建议次数  采纳次数  采纳率');
for (const [tool, e] of [...perTool.entries()].sort((a, b) => b[1].sug - a[1].sug)) {
  const total = toolCallsTotal.get(tool) || 0;
  lines.push(`${tool.padEnd(28)}${String(total).padStart(6)}${String(e.sug).padStart(10)}${String(e.adopt).padStart(10)}${rate(e.adopt, e.sug).padStart(9)}`);
}
lines.push('');
lines.push('── 按 Hook ──');lines.push('Hook                          注入块  建议次数  采纳率');
for (const [hook, e] of [...perHook.entries()].sort((a, b) => b[1].inj - a[1].inj)) {
  lines.push(`${hook.padEnd(28)}${String(e.inj).padStart(6)}${String(e.sug).padStart(10)}${rate(e.adopt, e.sug).padStart(9)}`);
}
lines.push('');
lines.push('── 会话明细 (注入 ≥ 5 条) ──');
lines.push('会话                          注入块  建议  采纳');
for (const s of sessionStats.filter((s) => s.injections >= 5).sort((a, b) => b.injections - a.injections)) {
  lines.push(`${s.file.padEnd(30)}${String(s.injections).padStart(6)}${String(s.suggestions).padStart(6)}${String(s.adoptions).padStart(6)}`);
}
const report = lines.join('\n');
console.log(report);

const outDir = path.join(ROOT, '.hologram', 'docs');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'hook-adoption-report.md'), `# Hook 引导采纳率报告\n\n\`\`\`\n${report}\n\`\`\`\n`, 'utf8');
console.log(`\n报告已保存: .hologram/docs/hook-adoption-report.md`);
