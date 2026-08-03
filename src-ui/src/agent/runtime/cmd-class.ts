// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Shell 命令分类 —— 资源租约层的"命令知识"。
//
// 为 shell 队列提供预计等待估算所需的类别（read/write/heavy/unknown）。
// 分类只影响估算与展示，不改变调度行为（v1 全串行，见 shell-queue.ts）。
//
// 种子来源（先抄再写，不发明新名单）：
//   - agent.ts:2250 的 BUILD_TEST_RE（子 Agent 禁用的构建/测试命令）
//   - src-tauri/src/permissions/git.rs:38-56 的 git 安全子命令清单
//
// ⚠️ v2 若引入"只读并行"（按资源类型分队列），unknown 必须归 write（串行）——
//    未知命令可能是写操作，并行会撞。此注释即未来切换点。

import type { ShellCmdClass } from './shell-queue';

// ── token 提取（quote-aware，镜像 os_sandbox::split_cmdline 逻辑）──

/** 拆分命令行 token，支持引号包裹（"cargo build" / 'cargo build' 视为单 token） */
export function tokens(cmdline: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmdline)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/** 首个 token = 命令名 */
export function firstToken(cmdline: string): string {
  return tokens(cmdline)[0] ?? '';
}

// ── wrapper 解包（bash -c "cargo build" 取引号内负载重新分类）──

const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh']);
const WRAPPER_FLAGS = new Set(['-c', '/c', '-Command', '-command']);

function unwrap(cmdline: string): string {
  const t = tokens(cmdline);
  if (t.length >= 3 && WRAPPERS.has(t[0]) && WRAPPER_FLAGS.has(t[1])) {
    return t.slice(2).join(' ');
  }
  return cmdline;
}

// ── 静态分类表 ──

/** 整体重型工具：任何调用都算构建/测试/包管理 */
const HEAVY_TOOLS = new Set([
  'rustc', 'tsc', 'esbuild', 'webpack', 'vite', 'rollup',
  'gradle', 'gradlew', 'mvn', 'mvnw', 'cmake', 'make', 'ninja',
  'pytest', 'dotnet', 'xcodebuild', 'zig', 'npx', 'gcc', 'g++', 'clang', 'cl',
]);

/** 子命令级重型：首 token 命中 + 子命令在集合内（种子抄 BUILD_TEST_RE） */
const HEAVY_SUB: Record<string, ReadonlySet<string>> = {
  cargo: new Set(['build', 'test', 'check', 'clippy', 'run', 'install', 'bench', 'audit']),
  npm: new Set(['install', 'ci', 'build', 'test', 'run', 'exec', 'audit', 'start']),
  pnpm: new Set(['install', 'ci', 'build', 'test', 'run', 'exec', 'audit', 'start']),
  yarn: new Set(['install', 'build', 'test', 'run', 'start']),
  go: new Set(['build', 'test', 'vet', 'run', 'install']),
  docker: new Set(['build', 'compose']),
};

/** 整体只读工具 */
const READ_TOOLS = new Set([
  'ls', 'dir', 'find', 'grep', 'rg', 'cat', 'type', 'head', 'tail', 'wc',
  'echo', 'pwd', 'whoami', 'date', 'env', 'printenv', 'which', 'where',
]);

/** git 只读子命令（抄 git.rs:38-56 安全清单的只读部分 + 常用查询） */
const GIT_READ_SUB = new Set([
  'status', 'diff', 'show', 'log', 'blame', 'ls-files', 'branch', 'rev-parse',
  'remote', 'diff-tree', 'ls-tree', 'describe', 'tag', 'shortlog', 'stash', // stash list 只读（保守处见下）
]);

/** git 写子命令（git.rs 中 Ask 类 + 会改工作区/refs 的） */
const GIT_WRITE_SUB = new Set([
  'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'switch', 'create-branch',
  'init', 'reset', 'merge', 'rebase', 'cherry-pick', 'revert', 'clean',
  'restore', 'rm', 'mv', 'stage', 'unstage', 'stash', 'tag', 'apply', 'am',
]);

/** 整体写工具 */
const WRITE_TOOLS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'unlink',
  'python', 'python3', 'node', 'sqlite3', 'zip', 'unzip', 'tar', 'gzip', 'gunzip',
  'curl', 'wget', 'scp', 'rsync', // 下载/传输 → 写磁盘
  'kill', 'killall', 'taskkill',
]);

// ── 分类入口 ──

export function classifyShellCommand(cmdline: string): ShellCmdClass {
  const t = tokens(unwrap(cmdline));
  const tool = t[0] ?? '';
  const sub = t[1] ?? '';

  // 版本/帮助查询 → 只读（任何工具）
  if (sub === '--version' || sub === '-v' || sub === '--help' || sub === '-h' || sub === 'help') {
    return 'read';
  }

  // 整体重型工具
  if (HEAVY_TOOLS.has(tool)) return 'heavy';

  // 子命令级重型（cargo build / npm install / go test / docker build）
  const heavySubs = HEAVY_SUB[tool];
  if (heavySubs && heavySubs.has(sub)) return 'heavy';

  // python -m pytest → 重型
  if ((tool === 'python' || tool === 'python3') && sub === '-m' && (t[2] ?? '').includes('pytest')) {
    return 'heavy';
  }

  // git 特殊：第二 token 细分
  if (tool === 'git') {
    if (GIT_READ_SUB.has(sub)) return 'read';
    if (GIT_WRITE_SUB.has(sub)) return 'write';
    return 'write'; // 未知 git 子命令保守归写（git 默认会动 index/refs）
  }

  // 整体只读
  if (READ_TOOLS.has(tool)) return 'read';

  // 整体写
  if (WRITE_TOOLS.has(tool)) return 'write';

  // 包管理器剩余子命令（npm ls / cargo metadata 等查询类，保守归写——无行为风险只有估算差异）
  if (tool === 'npm' || tool === 'pnpm' || tool === 'yarn' || tool === 'cargo' || tool === 'go' || tool === 'docker') {
    return 'write';
  }

  // 未知 → write（保守，见文件头注释）
  return 'write';
}

/** 类别的中文标签（供队列反馈文案） */
export function commandLabel(cls: ShellCmdClass): string {
  switch (cls) {
    case 'read': return '只读';
    case 'write': return '写操作';
    case 'heavy': return '重型构建';
    default: return '未知';
  }
}
