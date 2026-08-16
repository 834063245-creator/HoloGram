#!/usr/bin/env node
// convergence 门禁入口 — check / record / report（验证计划 §2）。
//
//   check  : 跑当前 phase 的契约比对（baseline 只读），任何漂移 exit 1 并写报告到 reports/
//   record : 仅限 CONVERGENCE_RECORD=1（npm run record:convergence）；
//            重写 baseline，只允许出现在人类审批的 baseline 专用提交中
//   report : 打印最近一次运行的报告
//
// phase 选择：环境变量 CONVERGENCE_PHASE=N 只跑 specs/phase-N.test.ts；缺省跑全部 specs。
// 门禁脚本自身不接受并行修改 — 测试工程改动属于独立 work package（验证计划 §5.2）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '../..'); // src-ui/
const reportsDir = path.join(here, 'reports');

const [command] = process.argv.slice(2);
const phase = process.env.CONVERGENCE_PHASE || '';
const target = phase ? `tests/convergence/specs/phase-${phase}.test.ts` : 'tests/convergence/specs';

function runSpecs(record) {
  const env = { ...process.env };
  if (record) env.CONVERGENCE_RECORD = '1';
  const res = spawnSync('npx', ['vitest', 'run', target], {
    cwd: pkgRoot,
    env,
    encoding: 'utf8',
    shell: true,
  });
  return { code: res.status ?? 1, output: `${res.stdout || ''}\n${res.stderr || ''}` };
}

function extractSummary(output) {
  const lines = output.split('\n').filter((l) => /Test Files|Tests |Duration|FAIL/.test(l));
  return lines.length > 0 ? lines.join('\n') : '（未能提取摘要）';
}

function tail(text, n) {
  const lines = text
    .replace(/\n{2,}/g, '\n')
    .trimEnd()
    .split('\n');
  return lines.slice(-n).join('\n');
}

function writeReport(cmd, code, output) {
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const body = [
    `# convergence ${cmd}`,
    '',
    `- 日期: ${new Date().toISOString()}`,
    `- 目标: ${target}`,
    `- 退出码: ${code}`,
    '',
    '## 摘要',
    '',
    '```',
    extractSummary(output),
    '```',
    '',
    '## vitest 输出（尾部 40 行）',
    '',
    '```',
    tail(output, 40),
    '```',
    '',
  ].join('\n');
  const file = path.join(reportsDir, `${cmd}-${stamp}.md`);
  writeFileSync(file, body, 'utf8');
  writeFileSync(path.join(reportsDir, 'latest.md'), body, 'utf8');
  return file;
}

function usage() {
  console.log('用法: node tests/convergence/gate.mjs <check|record|report>');
  console.log('环境: CONVERGENCE_PHASE=<N>  只跑指定 phase 的 specs');
  process.exit(64);
}

if (command === 'check') {
  const { code, output } = runSpecs(false);
  const file = writeReport('check', code, output);
  console.log(`[convergence] check ${code === 0 ? '通过' : '失败'}（exit ${code}）`);
  console.log(`[convergence] 报告: ${file}`);
  if (code !== 0) {
    console.log('[convergence] baseline 漂移不是修代码能解决时：写 baseline-change-request.md 停止实现，交人类审批。');
  }
  process.exit(code === 0 ? 0 : 1);
} else if (command === 'record') {
  if (process.env.CONVERGENCE_RECORD !== '1') {
    console.error('[convergence] record 需要显式 CONVERGENCE_RECORD=1（用 npm run record:convergence）。');
    console.error('[convergence] record 只允许出现在人类审批的 baseline 专用提交中 — 实现期禁止。');
    process.exit(2);
  }
  console.warn('[convergence] record 模式：即将重写 baseline/*.json — 确认本提交是 baseline 审批提交。');
  const { code, output } = runSpecs(true);
  const file = writeReport('record', code, output);
  console.log(`[convergence] record 完成（exit ${code}），报告: ${file}`);
  process.exit(code === 0 ? 0 : 1);
} else if (command === 'report') {
  const latest = path.join(reportsDir, 'latest.md');
  if (!existsSync(latest)) {
    console.log('（还没有任何运行报告 — 先跑 verify:convergence）');
    process.exit(0);
  }
  console.log(readFileSync(latest, 'utf8'));
} else {
  usage();
}
