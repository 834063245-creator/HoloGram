// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 流空闲超时守卫 — Agent 主循环 / 摘要调用 / dataflow NL 解析共用。
// N 秒无任何 chunk 视为挂起：abort 底层流，是否命中超时经 idleTimedOut 暴露，
// 各调用方保持各自的错误文案/日志。外部 signal 只做转发，不直接传给
// stream —— 避免超时 abort 连累调用方。
//（2026-08-07 提取自 agent.ts streamOnce / callSummaryLLM 的两份内联拷贝。）

import type { Chunk, Provider, Request } from './types';

export const STREAM_IDLE_TIMEOUT_MS = 60_000;

export interface IdleTimeoutStream {
  /** 包装后的 chunk 流 — 每到一个 chunk 重置空闲计时。 */
  chunks: AsyncGenerator<Chunk>;
  /** 是否因空闲超时（而非外部 abort / 协议错误）中止。 */
  readonly idleTimedOut: boolean;
}

/** 用空闲超时守卫包装 prov.stream。计时器与外部 signal 监听随流结束自动清理。 */
export function streamWithIdleTimeout(
  prov: Provider,
  signal: AbortSignal,
  req: Request,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): IdleTimeoutStream {
  let timedOut = false;
  const ctrl = new AbortController();
  const onIdleTimeout = () => {
    timedOut = true;
    ctrl.abort();
  };
  let timer = setTimeout(onIdleTimeout, idleMs);
  const onExternalAbort = () => ctrl.abort();
  signal.addEventListener('abort', onExternalAbort, { once: true });

  const self: IdleTimeoutStream = {
    chunks: (async function* () {
      try {
        for await (const chunk of prov.stream(ctrl.signal, req)) {
          // 流仍在产出 — 重置空闲计时
          clearTimeout(timer);
          timer = setTimeout(onIdleTimeout, idleMs);
          yield chunk;
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onExternalAbort);
      }
    })(),
    get idleTimedOut() {
      return timedOut;
    },
  };
  return self;
}
