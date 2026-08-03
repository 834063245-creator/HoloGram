// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// wait — 等待工具。
//
// 解决"轮询刷屏"问题：Agent 等子 Agent / 后台任务 / 构建完成时，
// 之前只能反复调 agent_status / bash_output 轮询（每次都是一次工具调用，
// 刷屏 + 耗 token）。wait 让 Agent 一次性阻塞指定时长，
// 醒来后做【一次】状态检查即可。

import type { Tool } from '../tool';

const MAX_WAIT_MS = 600_000; // 10 分钟上限，对齐 SHELL_TIMEOUT

export function createWaitTool(): Tool {
  return {
    name: () => 'wait',
    description: () =>
      'Block for a specified duration, then return immediately. ' +
      'Use this INSTEAD of polling loops (repeated agent_status / bash_output calls in a loop — that spams tool calls). ' +
      'Pattern: call wait → then make ONE status check. ' +
      'For unknown wait durations, prefer shorter waits (10-30s) and re-check, ' +
      'or estimate generously for known operations (e.g. cargo build ~60s). ' +
      'Max 10 minutes per call.',
    parameters: () => ({
      type: 'object',
      properties: {
        durationMs: {
          type: 'integer',
          description: 'Milliseconds to wait (1000 = 1s). Max 600000 (10 min).',
          default: 10_000,
        },
      },
      required: [],
    }),
    readOnly: () => true,
    execute: async (args) => {
      const requested = Number(args.durationMs);
      const ms = Math.min(Math.max(Number.isFinite(requested) ? requested : 10_000, 0), MAX_WAIT_MS);
      const start = Date.now();
      await new Promise((r) => setTimeout(r, ms));
      const waited = ((Date.now() - start) / 1000).toFixed(1);
      return `已等待 ${waited}s。现在检查你要等的目标状态（子 Agent / 后台任务 / 构建结果）。`;
    },
  };
}
