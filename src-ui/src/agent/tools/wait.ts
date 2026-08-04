// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// wait — 事件驱动等待工具。
//
// 正确语义 = bash_wait 的"等目标完成"，不是"睡 N 秒"：
//   - 传 agentId → 阻塞到该子 Agent 完成（内部轮询 pool 状态，500ms 粒度，
//     不消耗 LLM 轮次；完成后立即返回最终状态，LLM 不需要猜时长）
//   - 不传 agentId → 兜底固定时长 sleep（仅用于无事件可等的场景：
//     watcher 增量分析、文件出现等）
//
// 背景：之前 Agent 等子 Agent 用 agent_status 轮询循环（工具调用刷屏）。
// 第一版 wait 做成了固定 sleep（LLM 猜秒数，猜错白等/等不够）——同样不对。
// 事件驱动 + 超时兜底才是"等"，bash_wait 已验证这个模式。

import { z } from 'zod';
import type { Tool } from '../tool';
import type { SubAgentPool } from '../coordinator';
import { SubAgentStatus } from '../coordinator';
import { defineTool } from './define-tool';

const MAX_WAIT_MS = 600_000; // 10 分钟上限，对齐 SHELL_TIMEOUT
const POLL_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function statusLabel(status: SubAgentStatus): string {
  switch (status) {
    case SubAgentStatus.Completed: return '✅ 已完成';
    case SubAgentStatus.Failed: return '❌ 失败';
    case SubAgentStatus.Stopped: return '⏹️ 已停止';
    default: return '运行中';
  }
}

export function createWaitTool(pool?: SubAgentPool): Tool {
  return defineTool({
    name: 'wait',
    description:
      'Block until a target completes, then return immediately — event-driven, NOT a fixed sleep. ' +
      'Pass agentId to wait for that sub-agent to finish: returns its final status the moment it completes (no polling loops, no guessing durations). ' +
      'For background shell jobs use bash_wait (dedicated tool). ' +
      'Omit agentId and pass durationMs ONLY as a fallback for non-event waits (watcher re-analysis, file appearance). ' +
      'Max 10 minutes per call.',
    schema: z.object({
      agentId: z
        .string()
        .optional()
        .describe('Sub-agent ID to wait for (from agent_spawn result or agent_status). Waits until it completes/fails/stops.'),
      // zod: coerce + default(10000) + max(600000) 替代手写 Number(args.durationMs) || 10_000 静默兜底
      durationMs: z
        .coerce.number()
        .max(MAX_WAIT_MS)
        .optional()
        .default(10_000)
        .describe('Fallback sleep when agentId is omitted (1000 = 1s, max 600000). Prefer agentId/bash_wait.'),
      // timeoutMs 缺省 = MAX_WAIT_MS（对齐 description "default 600000 = 10 min"）— 替代 Number(args.timeoutMs) 的 NaN 静默 bug
      timeoutMs: z
        .coerce.number()
        .max(MAX_WAIT_MS)
        .optional()
        .default(MAX_WAIT_MS)
        .describe('Max wait in ms (default 600000 = 10 min).'),
    }),
    readOnly: true,
    execute: async (args) => {
      const start = Date.now();
      const timeoutMs = args.timeoutMs;
      const agentId = args.agentId;

      // ── 事件驱动：等子 Agent 完成 ──
      if (agentId && pool) {
        for (;;) {
          const handle = pool.getHandle(agentId);
          if (!handle) {
            return `未找到子 Agent ${agentId}（可能已清理或 id 错误）。可用 agent_status 查看当前子 Agent。`;
          }
          if (handle.status !== SubAgentStatus.Running) {
            const waited = ((Date.now() - start) / 1000).toFixed(1);
            const extra = handle.result ? `\n结果: ${handle.result.slice(0, 500)}` : '';
            return `子 Agent ${agentId} ${statusLabel(handle.status)}（等待 ${waited}s）。${extra}`;
          }
          if (Date.now() - start >= timeoutMs) {
            return `⏱ 等待子 Agent ${agentId} 超时（${timeoutMs / 1000}s），仍在运行。可用 agent_status 查看进度，或 agent_kill 终止。`;
          }
          await sleep(POLL_INTERVAL_MS);
        }
      }

      // ── 兜底：无 agentId → 固定时长 sleep（仅限无事件可等的场景）──
      const durationMs = args.durationMs;
      await sleep(durationMs);
      return `已等待 ${(durationMs / 1000).toFixed(1)}s。现在检查目标状态（优先使用 wait agentId / bash_wait 等事件驱动方式）。`;
    },
  });
}
