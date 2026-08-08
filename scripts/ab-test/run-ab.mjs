import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const UI_DIR = path.join(ROOT, 'src-ui');
const TASKS_FILE = path.join(ROOT, 'scripts', 'ab-test', 'tasks.json');
const WT_BASE = process.env.AB_WT_BASE || path.join('D:', 'tmp', 'opencode', 'abwt');
const REPS = Number(process.env.AB_REPS || 2);
const GRAPH_DB = path.join(ROOT, '.hologram', 'hologram.db');

const apiKey = process.env.AB_API_KEY || '';
const baseUrl = process.env.AB_BASE_URL || 'https://api.deepseek.com';
const model = process.env.AB_MODEL || 'deepseek-v4-flash';

if (!apiKey) {
  console.error('AB_API_KEY 未设置');
  process.exit(1);
}

const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
fs.mkdirSync(WT_BASE, { recursive: true });

function runWorktreeCommand(args, opts = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', ...opts });
  } catch (e) {
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr || e.message}`);
  }
}

function runTrial(task, arm, rep) {
  const wt = path.join(WT_BASE, `${task.id}-${arm}-r${rep}`);
  if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  runWorktreeCommand(['worktree', 'add', '--detach', wt, 'HEAD']);
  const out = path.join(WT_BASE, `${task.id}-${arm}-r${rep}.json`);
  const env = {
    ...process.env,
    AB_ARM: arm,
    AB_TASK_JSON: JSON.stringify(task),
    AB_WT: wt,
    AB_OUT: out,
    AB_GRAPH_DB: GRAPH_DB,
    AB_API_KEY: apiKey,
    AB_BASE_URL: baseUrl,
    AB_MODEL: model,
  };
  const started = Date.now();
  const res = spawnSync(
    'cmd.exe',
    ['/d', '/s', '/c', 'npx vitest run tests/ab/ab-trial.test.ts'],
    {
      cwd: UI_DIR,
      env,
      encoding: 'utf8',
      timeout: 16 * 60 * 1000,
    },
  );
  const durationMs = Date.now() - started;
  let result = null;
  if (fs.existsSync(out)) {
    result = JSON.parse(fs.readFileSync(out, 'utf8'));
  } else {
    result = {
      taskId: task.id,
      arm,
      success: false,
      why: `trial crashed (exit ${res.status}): ${(res.stdout || '').slice(-500)}`,
      tokens: -1,
      toolCalls: -1,
      toolNames: [],
      durationMs,
      finalAnswer: '',
    };
  }
  runWorktreeCommand(['worktree', 'remove', '--force', wt]);
  return result;
}

function rate(n, d) {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`;
}

const results = [];
for (const task of tasks) {
  for (let rep = 1; rep <= REPS; rep++) {
    const order = rep % 2 === 0 ? ['off', 'on'] : ['on', 'off'];
    for (const arm of order) {
      const r = runTrial(task, arm, rep);
      console.log(`[${task.id}] ${arm} rep${rep}: ${r.success ? 'PASS' : 'FAIL'} (${r.tokens}t, ${r.toolCalls} calls, ${(r.durationMs / 1000).toFixed(0)}s) ${r.why}`);
      results.push(r);
    }
  }
}

const lines = [];
lines.push('═══ HoloGram Hook A/B 测试报告 ═══');
lines.push(`配置: model=${model}, reps=${REPS}, tasks=${tasks.length}`);
lines.push('');
lines.push('── 汇总 (每任务 × 每臂) ──');
for (const task of tasks) {
  const rows = results.filter((r) => r.taskId === task.id);
  const armRows = (a) => rows.filter((r) => r.arm === a);
  const summarize = (a) => {
    const rs = armRows(a);
    const ok = rs.filter((r) => r.success).length;
    const tokens = rs.filter((r) => r.tokens >= 0).reduce((s, r) => s + r.tokens, 0) / Math.max(rs.length, 1);
    const calls = rs.filter((r) => r.toolCalls >= 0).reduce((s, r) => s + r.toolCalls, 0) / Math.max(rs.length, 1);
    const dur = rs.reduce((s, r) => s + r.durationMs, 0) / Math.max(rs.length, 1);
    return `${rate(ok, rs.length).padStart(4)} 成功率 | ${Math.round(tokens)}t | ${calls.toFixed(1)} 次调用 | ${(dur / 1000).toFixed(0)}s`;
  };
  lines.push(task.id);
  lines.push(`  hooks ON : ${summarize('on')}`);
  lines.push(`  hooks OFF: ${summarize('off')}`);
  lines.push('');
}
lines.push('── 明细 ──');
for (const r of results) {
  lines.push(`[${r.taskId}] ${r.arm} r=${r.toolCalls}: ${r.success ? 'PASS' : 'FAIL'} — ${r.why} | tokens=${r.tokens} | calls=${r.toolCalls} | ${(r.durationMs / 1000).toFixed(0)}s`);
}

const report = lines.join('\n');
console.log('\n' + report);
const outDir = path.join(ROOT, '.hologram', 'docs');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'ab-test-report.md'), `# Hook A/B 测试报告\n\n\`\`\`\n${report}\n\`\`\`\n`, 'utf8');
