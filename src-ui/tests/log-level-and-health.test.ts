// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 日志可观测性批 3 —— **级别开关**与**日志健康度**（`agent/logger.ts`）守护。
//
// 批 1 测门面不变量（log-observability.test.ts）、批 2 测接缝接线
// （log-observability-seams.test.ts）；本文件测批 3 的两件事：
//
//   ① 级别过滤与运行时开关：默认 `info`（**debug 默认丢弃**——事故那份 1158 行
//      log 里 1024 行是同一条 invoke debug，信号被自己的噪声淹了）；优先级
//      `LANTAI_LOG_LEVEL`（壳读 → `log_level_hint` RPC）> `localStorage`
//      > 默认；认不出的值**不猜**（回落下一档）。
//   ② 健康度：写失败计数 + **首次** console.error，下一条成功写入补一条
//      `log.self{dropped:N}`——「日志里没有」必须能分出「没发生」与「写不出去」。
//
// 走真 logger + mock rpc-contract（内存 fs + 可控的级别提示），断言落在**实际
// 落盘的 NDJSON** 上：过滤与丢条补偿都是「写出去之后」的性质。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 顶层触发 rpc-contract 的 vi.mock 工厂求值（logger 的 appendToFile / 级别提示
// 都是动态 import，不在文件加载期触发则首调前 H.kernelFs 仍为 null）。
import { kernelLogAppend } from '../src/rpc-contract';

void kernelLogAppend;

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
  /** `LANTAI_LOG_LEVEL` 的壳侧读数（'' = 未设）。 */
  hint: '' as string,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return {
    ...actual,
    ...H.kernelFs.overrides,
    // 站到壳那一侧：真 WebView 里读不到进程环境变量，壳经这条 RPC 递进来
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

describe('日志可观测性批 3 · 级别开关与健康度', () => {
  let logger: LoggerMod;
  let drainSeq = 0;

  /** 当前级别下**能通过**的写入口：本文件的被测性质就是级别本身，drain 的信号行
   *  与填充行必须过得了自己的过滤，否则批次到不了 50 条、flush 永不触发（假红）。 */
  function emitThrough(mod: LoggerMod): (m: string) => void {
    switch (mod.logLevel().level) {
      case 'error':
        return (m) => mod.log.error('test', m);
      case 'warn':
        return (m) => mod.log.warn('test', m);
      default:
        return (m) => mod.log.info('test', m);
    }
  }

  /** 逼出一次 flush 并回读落盘的 NDJSON 条目（同 log-observability.test.ts 的
   *  手法：写满阈值逼同步 splice，**不用** fake timers）。信号必须是本次唯一标记
   *  ——内存 fs 跨用例复用，固定串会被上一轮残留骗过（假绿）。 */
  async function drain(mod: LoggerMod = logger): Promise<Record<string, unknown>[]> {
    const fs = H.kernelFs!.fs;
    fs.files.clear();
    const mark = `drain-mark-${++drainSeq}`;
    const emit = emitThrough(mod);
    emit(mark);
    for (let i = 0; i < 50; i++) emit('filler');
    await waitFor(() => (fs.files.get(LOG_PATH) ?? '').includes(mark));
    return (fs.files.get(LOG_PATH) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function fileText(): string {
    return H.kernelFs!.fs.files.get(LOG_PATH) ?? '';
  }

  beforeEach(async () => {
    H.hint = '';
    try {
      localStorage.removeItem('lantai.log.level');
    } catch {
      /* 存储被禁：与 logger 同判（回落默认） */
    }
    const k = H.kernelFs!;
    k.fs.files.clear();
    k.fs.dirs.clear();
    k.fs.writes.length = 0;
    k.fs.fail = {};
    // 重置模块缓存：级别与丢条账都是模块级状态，跨用例必须从零开始
    //（否则上一轮的 dropped 会被算进本轮——假绿）。
    vi.resetModules();
    logger = await import('../src/agent/logger');
    await logger.initLogger('/ws');
  });

  // ── ① 级别过滤与运行时开关 ────────────────────────────────────────

  it('默认级别 info：debug 被丢弃（88% 噪声的来源），info 照常落盘', async () => {
    expect(logger.logLevel()).toEqual({ level: 'info', source: 'default' });
    logger.log.debug('t', 'DBG-DROPPED');
    logger.log.info('t', 'INFO-KEPT');
    await drain();
    expect(fileText()).not.toContain('DBG-DROPPED');
    expect(fileText()).toContain('INFO-KEPT');
  });

  it('优先级：LANTAI_LOG_LEVEL（壳提示）> localStorage > 默认', async () => {
    // 档 1：壳提示（环境变量）胜出——即便 localStorage 说 error
    H.hint = ' debug ';
    localStorage.setItem('lantai.log.level', 'error');
    await logger.applyLogLevelFromShell();
    expect(logger.logLevel()).toEqual({ level: 'debug', source: 'env' });
    logger.log.debug('t', 'DBG-KEPT-BY-ENV');
    await drain();
    expect(fileText()).toContain('DBG-KEPT-BY-ENV');

    // 档 2：壳提示认不出（`trace` 不在前端档位表里）⇒ **不猜**，回落 localStorage
    H.hint = 'trace';
    await logger.applyLogLevelFromShell();
    expect(logger.logLevel()).toEqual({ level: 'error', source: 'storage' });
    logger.log.warn('t', 'WARN-DROPPED-AT-ERROR');
    logger.log.error('t', 'ERROR-KEPT');
    await drain();
    expect(fileText()).not.toContain('WARN-DROPPED-AT-ERROR');
    expect(fileText()).toContain('ERROR-KEPT');

    // 档 3：两者都没有 ⇒ 默认 info
    H.hint = '';
    localStorage.removeItem('lantai.log.level');
    await logger.applyLogLevelFromShell();
    expect(logger.logLevel()).toEqual({ level: 'info', source: 'default' });
  });

  it('localStorage 单独生效（没有 UI 开关时，这是用户侧可写的旋钮）', async () => {
    localStorage.setItem('lantai.log.level', 'warn');
    await logger.applyLogLevelFromShell();
    expect(logger.logLevel()).toEqual({ level: 'warn', source: 'storage' });
    logger.log.info('t', 'INFO-DROPPED-AT-WARN');
    logger.log.warn('t', 'WARN-KEPT');
    await drain();
    expect(fileText()).not.toContain('INFO-DROPPED-AT-WARN');
    expect(fileText()).toContain('WARN-KEPT');
  });

  it('级别读数上得了台面：`logLevel()` 是诊断面（boot 的 log_level_source）', async () => {
    // boot 事件把它写进启动锚——收到的 log 少了 debug 行时必须能回答
    //「是没发生，还是被级别挡了」。此处钉住读数本身（端到端断言在 obs 侧）。
    expect(logger.logLevel().level).toBe('info');
    H.hint = 'warn';
    await logger.applyLogLevelFromShell();
    expect(logger.logLevel()).toMatchObject({ level: 'warn', source: 'env' });
  });

  // ── ② 健康度：丢条可见 ───────────────────────────────────────────

  it('写失败计数 + 下一条成功写入补 log.self{dropped:N}；首次失败只 console 一次', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fs = H.kernelFs!.fs;

    // 第一批：写入失败（一整批 50 条丢失）——此前这条路径**静默吞掉**
    fs.fail.write = 'disk full';
    for (let i = 0; i < 50; i++) logger.log.info('t', `lost ${i}`);
    await waitFor(() => errSpy.mock.calls.length > 0);
    expect(String(errSpy.mock.calls[0][0])).toContain('日志写入失败');
    expect(fs.files.get(LOG_PATH)).toBeUndefined();

    // 第二批仍失败：只计数，不再刷屏（首次留痕的纪律）
    for (let i = 0; i < 50; i++) logger.log.info('t', `lost again ${i}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(errSpy).toHaveBeenCalledTimes(1);

    // 恢复可写：下一条成功写入补账（100 条 = 两批，丢掉的是 100 条）
    fs.fail = {};
    for (let i = 0; i < 150; i++) logger.log.info('t', `ok ${i}`);
    await waitFor(() => fileText().includes('log.self'));

    const entries = fileText()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const self = entries.filter((e) => e.event === 'log.self');
    expect(self).toHaveLength(1);
    expect(self[0].module).toBe('logger');
    expect(self[0].ctx).toMatchObject({ dropped: 100, channel: 'ok', level: 'info', source: 'default' });
    expect(String(self[0].message)).toContain('100');

    errSpy.mockRestore();
  });

  it('未 init（无工作区）时条目留在缓冲、**不计丢条**——init 后照样落盘', async () => {
    // logPath = null 时 flush 提前返回：条目还在缓冲里，**没丢**，故不得计入
    // dropped（否则健康度读数会说谎：把「攒着」报成「丢了」）。
    vi.resetModules();
    const mod = await import('../src/agent/logger');
    mod.log.info('t', 'BEFORE-INIT');
    await mod.initLogger('/ws');
    await drain(mod);
    expect(fileText()).toContain('BEFORE-INIT');
    expect(fileText()).not.toContain('log.self');
  });
});
