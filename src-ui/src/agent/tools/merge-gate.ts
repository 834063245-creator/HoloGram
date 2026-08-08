// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Merge 门禁执行器 —— 资源租约层的验证机制。
//
// 时序（merge-then-verify，见计划 F1）：
//   1. merge 前（可选，默认关）：worktree 内编译测试 —— 唯一有意义的 pre-merge 检查
//   2. merge 后：轮询 hologram_run_check 直到非 quiet —— watcher 已增量分析主仓，
//      changed_files 自动携带本次 merge 的变更，无需前端解析 git diff
//   3. 判定：quiet（无源码变更）→ 视为通过附注；passed → 通过；否则失败
//   4. 失败：调用方回滚（git reset --hard 到 rev-parse 快照）
//
// 关键行为依据：
//   - run_check 在 changed_files 为空时静默 quiet PASS（engine/src/routing/preflight.rs:143-145）
//   - run_check 每次调用都会 save_baseline（hologram.rs:79），quiet 轮询推进基线无害
//   - 60s 超时 fail-closed：watcher 可能暂停，未验证视为失败并回滚

import type { BoardEntry } from '../task-board';
import type { ToolExecutor } from '../tool';
import { execQueuedShell } from '../runtime/queued-shell';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MergeGateOptions {
  /** 项目根路径（merge 发生在主仓） */
  projectPath: string;
  /** 工具执行器（同 merge.ts 的 exec） */
  exec: ToolExecutor;
  /** 图检查轮询总超时（默认 60s） */
  maxCheckWaitMs?: number;
  /** 轮询间隔（默认 1.5s，对齐 watcher 增量分析节奏） */
  pollIntervalMs?: number;
  /** 编译测试命令（默认 cargo check --message-format short） */
  compileCommand?: string;
  /** 编译测试超时（默认 10min） */
  compileTimeoutMs?: number;
}

export interface GateResult {
  passed: boolean;
  quiet: boolean;
  report: string;
}

/**
 * 图检查（merge 后调用）：轮询 hologram_run_check 直到非 quiet，
 * 第一个非 quiet 结果即本次 merge 的真实检查。
 * 60s 内持续 quiet → 视为未验证（报告注明，不拦截）。
 *
 * 门禁定位：**信息报告，不是裁决**。
 * L5 红线（blast radius / 跨社区边 / L4 穿透）是启发式，有噪音——
 * 自动回滚会误伤正常改动（子 Agent 白做）。故失败只标记 + 报告，
 * 改动保留在主仓，由主 Agent 决定修复 / revert / 接受。
 */
export async function runGraphGate(_entry: BoardEntry, opts: MergeGateOptions): Promise<GateResult> {
  const { exec, projectPath } = opts;
  const maxWait = opts.maxCheckWaitMs ?? 60_000;
  const interval = opts.pollIntervalMs ?? 1_500;

  const deadline = Date.now() + maxWait;
  let last: Record<string, unknown> | null = null;

  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      const raw = await exec('hologram_run_check', { path: projectPath });
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      last = parsed;
      if (parsed.quiet !== true) break;
    } catch {
      // 解析失败（引擎未就绪等）— 继续轮询
    }
  }

  if (!last) {
    return { passed: false, quiet: true, report: '60s 内未获得图检查结果（引擎未就绪），视为未验证' };
  }

  if (last.quiet === true) {
    // 无源码变更（子 Agent 只改了文档/被忽略文件）或基线刚建立 → 视为通过
    return { passed: true, quiet: true, report: '无源码变更（或基线已建立），跳过图检查' };
  }

  const passed = last.passed === true;
  const violations = Array.isArray(last.violations) ? last.violations as unknown[] : [];
  const changed = Array.isArray(last.changed_files)
    ? (last.changed_files as unknown[]).slice(0, 10).join(', ')
    : '';
  const report = [
    passed ? '✅ 图检查通过' : '⚠️ 门禁未通过',
    `违规数: ${String(last.violation_count ?? 0)}${violations.length > 0 ? `（${violations.map((v) => String((v as { rule?: string }).rule ?? v)).join('; ')}）` : ''}`,
    last.new_violations ? `新增违规: ${String(last.new_violations)}` : '',
    last.blast_radius ? `波及半径: ${JSON.stringify(last.blast_radius)}` : '',
    changed ? `变更文件: ${changed}` : '',
  ].filter(Boolean).join('\n');

  return { passed, quiet: false, report };
}

/**
 * 编译测试（默认关）：merge 前在 worktree 内跑 cargo check。
 * worktree 自带独立 target/ 目录，是唯一有意义的 pre-merge 检查；
 * 冷构建可达分钟级，故 v1 默认关闭（时间盒警告）。
 */
export async function runCompileTest(entry: BoardEntry, opts: MergeGateOptions): Promise<GateResult> {
  if (!entry.isolationId) {
    return { passed: true, quiet: true, report: '无 worktree（fresh 模式），跳过编译测试' };
  }
  const command = opts.compileCommand ?? 'cargo check --message-format short';
  // isolationId 已含 agent- 前缀（agent.ts spawn 生成 agent-{ts}-{rand}），
  // Rust 侧 slug 也不重复拼接 — cwd 直接用 isolationId。
  const cwd = `${opts.projectPath}/.hologram/worktrees/${entry.isolationId}`;
  try {
    // 经 shell 队列执行（heavy → 互斥车道）— 与前台命令正确互斥，
    // 不再绕过队列裸调 exec_command 与排队中的 cargo 并发抢锁。
    const out = await execQueuedShell({ command, cwd, timeoutMs: opts.compileTimeoutMs ?? 600_000 });
    // 输出可能带 [shell 队列] 排队前缀行 — [exit 标记用多行匹配（fail-closed 语义不变）
    const passed = !/^\[exit [^0]\]/m.test(out.trimStart());
    return { passed, quiet: false, report: passed ? '✅ 编译测试通过' : `⚠️ 编译测试失败:\n${out.slice(0, 2000)}` };
  } catch (e: any) {
    return { passed: false, quiet: false, report: `⚠️ 编译测试异常: ${e?.message ?? String(e)}` };
  }
}
