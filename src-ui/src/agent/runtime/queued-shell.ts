// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 流式 shell 执行 — 从 agent-builder 抽取，供 codingExec 与 merge-gate 共用。
//
// 2026-08-10 退役队列（shell-queue.ts 已删）：多 Agent 构建锁互斥下沉到
// Rust 侧 BuildLock（资源级原子检查 + 带路径打回，见 src-tauri/src/utils.rs）。
// 前端不再做串行化调度——互斥交给 OS/工具自带锁，决策交给 LLM。
//
// 职责：
//   - exec_command 的流式执行（shell:output/shell:done 事件监听 + 600s 兜底超时）
//   - 取消语义：signal abort 时 bash_kill 运行中进程（job_id 来自 Rust started 响应，
//     携带 agent_id 身份——Rust 侧校验只能 kill 自己发起的 job）

import { listen } from '../../bridge';
import { agentInvoke } from '../tool';

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
 * 执行前台流式 shell 命令。
 * - signal abort：bash_kill 后 resolve 取消文案（agent_id 随命令身份透传，
 *   Rust 侧仅允许 kill 自己发起的 job）。
 * - 构建锁冲突由 Rust 侧 BuildLock 打回（返回错误信息，不排队）。
 */
export async function execStreamedShell(
  args: Record<string, unknown>,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const agentId = typeof args._agent_id === 'string' ? args._agent_id : undefined;
  /** Rust 侧 ledger job_id — started 响应到达前为 null（此窗口内 abort 无进程可杀） */
  let jobId: number | null = null;

  const streamId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return await new Promise<string>((resolve) => {
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
      const onAbort = () => {
        if (jobId != null) {
          void agentInvoke('bash_kill', { jobId, agentId }).catch(() => {});
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const startedRaw = await agentInvoke<string>('exec_command', { ...args, streamToolId: streamId });
        jobId = parseStartedJobId(startedRaw);
      } catch (e: unknown) {
        resolveOnce(`错误: ${e}`);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    })();
  });
}
