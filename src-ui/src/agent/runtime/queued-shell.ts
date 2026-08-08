// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 流式 shell 执行（经队列）— 从 agent-builder 抽取，供 codingExec 与 merge-gate 共用。
//
// 职责：
//   - exec_command 的流式执行（shell:output/shell:done 事件监听 + 600s 兜底超时）
//   - 经 shell-queue 分车道调度（read 并发 / write·heavy·unknown 串行）
//   - 取消语义：signal abort 时取消排队（reject AbortError）或 bash_kill 运行中进程
//     （job_id 来自 Rust started 响应，见 src-tauri/src/commands/shell.rs）
//   - 排队期反馈：onProgress 定期报告车道位置（模型/UI 可见），结果前缀排队时长

import { listen } from '../../bridge';
import { agentInvoke } from '../tool';
import { classifyShellCommand, commandLabel } from './cmd-class';
import { enqueueShellOp, getShellQueueStatus, SHELL_CANCELLED_MESSAGE } from './shell-queue';

const SHELL_TIMEOUT = 600_000;

/** streamId → 事件解绑函数 — resolveOnce 时统一清理 */
const _shellCleanups = new Map<string, Array<() => void>>();

/** Rust started 响应（shell.rs）：{"streamId","status","job_id"} */
function parseStartedJobId(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { job_id?: unknown };
    return typeof parsed.job_id === 'number' ? parsed.job_id : null;
  } catch {
    return null;
  }
}

/**
 * 经队列执行前台流式 shell 命令。
 * - onProgress 可选：不传时静默入队（merge-gate 路径），仍有排队/执行语义。
 * - signal abort：排队中 → reject AbortError；运行中 → bash_kill 后 resolve 取消文案。
 */
export async function execQueuedShell(
  args: Record<string, unknown>,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const cmd = String(args.command || '');
  const cls = classifyShellCommand(cmd);
  const queuedAt = Date.now();
  /** Rust 侧 ledger job_id — started 响应到达前为 null（此窗口内 abort 无进程可杀） */
  let jobId: number | null = null;
  /** fn 已开始执行 — 队列反馈定时器据此停报（执行期流式输出接管） */
  let startedFlag = false;

  const { promise: shellPromise, status } = enqueueShellOp(
    () => {
      startedFlag = true;
      const streamId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      return new Promise<string>((resolve) => {
        void (async () => {
          let fullOutput = '';
          let timer: ReturnType<typeof setTimeout> | null = null;
          let settled = false;
          const cleanup = () => {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            const fns = _shellCleanups.get(streamId);
            if (fns) {
              for (const fn of fns) fn();
              _shellCleanups.delete(streamId);
            }
          };
          const resolveOnce = (v: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(v);
          };
          const unOut = await listen<{ streamId: string; chunk: string }>('shell:output', (e) => {
            if (e.payload.streamId !== streamId) return;
            fullOutput += e.payload.chunk;
            onProgress?.(e.payload.chunk);
          });
          const unDone = await listen<{ streamId: string; exitCode: number; error?: string }>('shell:done', (e) => {
            if (e.payload.streamId !== streamId) return;
            if (e.payload.error) resolveOnce(`[exit ${e.payload.exitCode}]\n${fullOutput}\n${e.payload.error}`);
            else if (e.payload.exitCode !== 0) resolveOnce(`[exit ${e.payload.exitCode}]\n${fullOutput}`);
            else resolveOnce(fullOutput || '(无输出)');
          });
          _shellCleanups.set(streamId, [unOut, unDone]);
          timer = setTimeout(
            () => resolveOnce(`[exit -1] shell 超时 (${SHELL_TIMEOUT / 1000}s)\n${fullOutput}`),
            SHELL_TIMEOUT,
          );
          try {
            const startedRaw = await agentInvoke<string>('exec_command', { ...args, streamToolId: streamId });
            jobId = parseStartedJobId(startedRaw);
          } catch (e: unknown) {
            resolveOnce(`错误: ${e}`);
          }
        })();
      });
    },
    { cmd, cls },
    {
      signal,
      onCancelRunning: () => {
        if (jobId != null) {
          void agentInvoke('bash_kill', { jobId }).catch(() => {});
        }
      },
    },
  );

  // 等待期反馈：仅当同车道前方有命令时启动（3s 间隔刷新，UI 实时可见；
  // startedFlag 后停报，执行期流式输出不受影响）
  const laneName = cls === 'read' ? '只读' : '互斥';
  const aheadCount = (s: ReturnType<typeof status>) => {
    const lane = cls === 'read' ? s.lanes.read : s.lanes.exclusive;
    // 刚入队的自己是 waiters 末尾 — 前方 = 运行中 + 排在我前面的
    return lane.running.length + Math.max(0, lane.waiters.length - 1);
  };
  let queueTimer: ReturnType<typeof setInterval> | null = null;
  if (onProgress && aheadCount(status()) > 0) {
    queueTimer = setInterval(() => {
      if (startedFlag) {
        if (queueTimer) clearInterval(queueTimer);
        queueTimer = null;
        return;
      }
      const s = status();
      const lane = cls === 'read' ? s.lanes.read : s.lanes.exclusive;
      const head = lane.running[0];
      if (!head) return;
      const budgetNote = head.overBudget ? '（已超过预期，可能卡住，shell 上限 600s）' : '';
      onProgress(
        `[shell 队列] 等待中… ${laneName}车道前方 ${aheadCount(s)} 个命令。当前: "${head.cmd.slice(0, 60)}"` +
          `（${commandLabel(head.cls)}，已运行 ${Math.floor(head.elapsedMs / 1000)}s，预计还需 ~${Math.ceil(head.remainingMs / 1000)}s）${budgetNote}`,
      );
    }, 3000);
  }

  const out = await shellPromise;
  if (queueTimer) {
    clearInterval(queueTimer);
    queueTimer = null;
  }
  const waitMs = Date.now() - queuedAt;
  // 模型可见反馈：等待 >500ms 时加前缀（不污染快速命令的输出；取消文案不加）
  if (waitMs > 500 && out !== SHELL_CANCELLED_MESSAGE) {
    return `[shell 队列] ⏱ ${laneName}车道排队 ${(waitMs / 1000).toFixed(1)}s 后执行。\n${out}`;
  }
  return out;
}

/**
 * 后台 heavy 命令与互斥车道 heavy 前台命令的锁竞争警告（C1）。
 * 后台任务可无限运行，不能持车道租约 — 只做信息提示不阻塞。
 */
export function heavyBackgroundConflictWarning(cmd: string): string {
  if (classifyShellCommand(cmd) !== 'heavy') return '';
  const runningHeavy = getShellQueueStatus().lanes.exclusive.running.find((r) => r.cls === 'heavy');
  if (!runningHeavy) return '';
  return (
    `\n⚠️ 锁竞争警告：前台互斥车道正在运行重型命令 "${runningHeavy.cmd.slice(0, 60)}"，` +
    `此后台任务可能与之争抢构建锁（target/、node_modules/、.git/index.lock）。` +
    `若长时间无输出，可用 bash_kill 终止后改用前台执行（会自动排队）。`
  );
}
