// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 日志可观测性批 4 —— **轮转触发**（`agent/logger.ts`）守护。
//
// ui.log 的轮转判据在**壳侧**（`logging.rs`：8 MiB / 保 2 代，与 bridge/boot
// 同一套）；前端只负责**触发**：首次真写盘前问一次壳（存量越限文件不等累计），
// 此后每累计写 `ROTATE_CHECK_BYTES`（1 MiB）再问一次（`log_rotate` RPC）。
// 本文件钉三条行为：
//   ① 触发时机：首写一次 + 每满 1 MiB 一次（不足不额外问——别把 RPC 打成轮询）；
//   ② 失败不阻断：轮转失败时日志照常写（宁可文件大，不丢一条）；
//   ③ 失败可见：首次 console.error + 下一条成功写入补 `log.self{rotate_failed:N}`
//      （与批 3 的 dropped 补偿同一节奏——「滚不动、文件会无限涨」不许静默）。
//
// 走真 logger + mock rpc-contract（内存 fs + kernelLogRotate 记录面），
// 断言落在「有没有被要求轮转」与**实际落盘的 NDJSON** 上。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 顶层触发 rpc-contract 的 vi.mock 工厂求值（logger 的 appendToFile / 轮转
// 触发都是动态 import，不在文件加载期触发则首调前 H.kernelFs 仍为 null）。
import { kernelLogAppend } from '../src/rpc-contract';

void kernelLogAppend;

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
  hint: '' as string,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return {
    ...actual,
    ...H.kernelFs.overrides,
    typedRpc: async (method: string) => {
      if (method === 'log_level_hint') return H.hint;
      throw new Error(`unexpected typedRpc in test: ${method}`);
    },
  };
});

type LoggerMod = typeof import('../src/agent/logger');

const LOG_PATH = '/ws/.lantai/logs/ui.log';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: 超时未落地');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('日志可观测性批 4 · 轮转触发（ui.log）', () => {
  let logger: LoggerMod;

  function fileText(): string {
    return H.kernelFs!.fs.files.get(LOG_PATH) ?? '';
  }
  function rotates(): string[] {
    return H.kernelFs!.fs.logRotates;
  }
  /** 逼出一批 flush（写满 MAX_BUFFER=50 条）：小条目凑数。 */
  function flushByFill(mark: string): void {
    logger.log.info('test', mark);
    for (let i = 0; i < 50; i++) logger.log.info('test', `filler-${i}`);
  }
  /** 一条大条目：让「累计写入」快速越过 1 MiB 检查间隔。 */
  function bigEntry(tag: string): void {
    logger.log.info('test', `${tag}:${'x'.repeat(40 * 1024)}`);
  }

  beforeEach(async () => {
    H.hint = '';
    try {
      localStorage.removeItem('lantai.log.level');
    } catch {
      /* 存储被禁：与 logger 同判（回落默认） */
    }
    // 等在途 append 落地再清（内存 fs 的 append 是读-改-写，见 log-level-and-health 注）。
    await new Promise((r) => setTimeout(r, 5));
    const k = H.kernelFs!;
    k.fs.files.clear();
    k.fs.dirs.clear();
    k.fs.writes.length = 0;
    k.fs.logRotates.length = 0;
    k.fs.fail = {};
    vi.resetModules();
    logger = await import('../src/agent/logger');
    await logger.initLogger('/ws');
  });

  it('首次真写盘前先问一次壳（存量越限文件不等累计）；路径就是本卷 ui.log', async () => {
    expect(rotates().length).toBe(0); // 未写盘 = 未问（检查只在「有东西要写」时发生）
    flushByFill('first-write');
    await waitFor(() => rotates().length >= 1);
    expect(rotates()[0]).toBe(LOG_PATH);
  });

  it('累计不足一个检查间隔：只问过首写那一次（不把 RPC 打成轮询）', async () => {
    flushByFill('small-1');
    await waitFor(() => rotates().length >= 1);
    const baseline = rotates().length;
    flushByFill('small-2');
    await waitFor(() => fileText().includes('small-2'));
    expect(rotates().length).toBe(baseline);
  });

  it('累计写满 1 MiB：下一次 flush 前再问一次；此后清账（不会每批都问）', async () => {
    // 第一批：大条目把累计推过 1 MiB（本批只消化首写检查）。
    for (let i = 0; i < 50; i++) bigEntry(`big-${i}`);
    await waitFor(() => fileText().includes('big-49'));
    expect(rotates().length).toBe(1);

    // 第二批：写前检查命中 → 再问壳。
    flushByFill('after-big');
    await waitFor(() => rotates().length >= 2);
    expect(rotates().length).toBe(2);

    // 第三批：账已清，不再问（要再攒满 1 MiB 才问下一次）。
    flushByFill('after-after');
    await waitFor(() => fileText().includes('after-after'));
    expect(rotates().length).toBe(2);
  });

  it('轮转失败不阻断写入，且可见：首次 console + 下一条成功写入补 log.self{rotate_failed:N}', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 让轮转从「首写检查」就失败——本批日志照写（不阻断的判据）。
    H.kernelFs!.fs.fail.rotate = 'disk busy';
    flushByFill('kept-anyway');
    await waitFor(() => fileText().includes('kept-anyway'));
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('日志轮转失败'))).toBe(true);
    expect(rotates().length).toBe(0);

    // 补偿：下一条成功写入把失败落账（log.self 进缓冲，再一批落盘）。
    flushByFill('settle');
    await waitFor(() => fileText().includes('log.self'));
    const self = fileText()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.event === 'log.self');
    expect(self).toHaveLength(1);
    expect(self[0].ctx).toMatchObject({ rotate_failed: 1, channel: 'ok' });
    // 失败期间的日志一条不少（不阻断的判据）。
    for (const tag of ['kept-anyway', 'settle']) expect(fileText()).toContain(tag);

    errSpy.mockRestore();
  });
});
