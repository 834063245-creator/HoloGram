// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 日志可观测性批 3 —— **级别开关**、**日志健康度**、**debug 前情环形缓冲**
// （`agent/logger.ts`）守护。
//
// 批 1 测门面不变量（log-observability.test.ts）、批 2 测接缝接线
// （log-observability-seams.test.ts）；本文件测批 3 的三件事：
//
//   ① 级别过滤与运行时开关：默认 `info`（**debug 默认丢弃**——事故那份 1158 行
//      log 里 1024 行是同一条 invoke）；优先级 `LANTAI_LOG_LEVEL`（壳读 →
//      `log_level_hint` RPC）> `localStorage` > 默认；认不出的值**不猜**。
//   ② 健康度：写失败计数 + **首次** console.error，下一条成功写入补
//      `log.self{dropped:N}`——「日志里没有」必须能分出「没发生」与「写不出去」。
//   ③ debug 前情环形缓冲（2026-10-12 用户拍板「不靠人记得开开关」）：被级别挡下的
//      debug 条目留在内存（定长），失败（错误级 + 带 event）时连前情一起落盘。
//
// 走真 logger + mock rpc-contract（内存 fs + 可控的级别提示），断言落在**实际
// 落盘的 NDJSON** 上：过滤、丢条补偿、倒前情都是「写出去之后」的性质。

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

describe('日志可观测性批 3 · 级别开关 / 健康度 / 前情缓冲', () => {
  let logger: LoggerMod;
  let drainSeq = 0;

  function fileText(): string {
    return H.kernelFs!.fs.files.get(LOG_PATH) ?? '';
  }

  /** 当前落盘文件解析出的条目（**全量**——批 3 的 dump 会一口气 append 十几万字节，
   *  见 drain 的说明：这里的文件是累积的，清文件只在 beforeEach 做）。 */
  function lines(): Record<string, unknown>[] {
    return fileText()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function byEvent(event: string): Record<string, unknown>[] {
    return lines().filter((e) => e.event === event);
  }

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

  /** 逼出一次 flush（写满阈值逼同步 splice，不用 fake timers），回读文件全量条目。
   *
   *  ⚡ **不在 drain 里清文件**（旧版这么做）：本批的 dump 会一口气 append 十几万
   *  字节，而内存 fs 的 append 是「读-改-写」——「清文件」会与在途 append 抢同一把
   *  钥匙：清掉的可能正是刚落地的 dump，之后又可能被在途 append 补回来，两个方向都
   *  会造出假红/假绿（2026-10-12 实测踩到）。清文件改在 beforeEach（那时没有在途
   *  append，见那里的等待）。 */
  async function drain(mod: LoggerMod = logger): Promise<Record<string, unknown>[]> {
    const mark = `drain-mark-${++drainSeq}`;
    const emit = emitThrough(mod);
    emit(mark);
    for (let i = 0; i < 50; i++) emit('filler');
    await waitFor(() => fileText().includes(mark));
    return lines();
  }

  beforeEach(async () => {
    H.hint = '';
    try {
      localStorage.removeItem('lantai.log.level');
    } catch {
      /* 存储被禁：与 logger 同判（回落默认） */
    }
    // 等在途 append 落地**再**清：上一轮用例的最后一批可能还在 append 的微任务链上，
    // 不先让位就会把它的内容补进本轮的干净文件里（假绿/假红）。
    await new Promise((r) => setTimeout(r, 5));
    const k = H.kernelFs!;
    k.fs.files.clear();
    k.fs.dirs.clear();
    k.fs.writes.length = 0;
    k.fs.fail = {};
    // 重置模块缓存：级别、丢条账、前情缓冲都是模块级状态，跨用例必须从零开始
    //（否则上一轮的 dropped / ring 会被算进本轮——假绿）。
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

    const self = byEvent('log.self');
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
    expect(byEvent('log.self')).toHaveLength(0);
  });

  // ── ③ debug 前情环形缓冲（用户拍板：不靠人记得开开关）─────────────────

  it('失败自动倒前情：平时不写盘的 debug 条目，在失败那一刻连现场一起落盘', async () => {
    logger.log.debug('bridge', 'invoke', { command: 'rpc', method: 'fs_cap' });
    logger.log.debug('bridge', 'invoke', { command: 'rpc', method: 'credential_get' });
    // 平时（无失败）：debug 一条都不在文件里（只躺在内存前情缓冲里）
    await drain();
    expect(fileText()).not.toContain('invoke');
    expect(byEvent('log.self')).toHaveLength(0);

    // 失败（错误级 + 带 event = 接缝认定的失败）→ 前情 + 失败一起落盘
    logger.log.debug('bridge', 'invoke', { command: 'rpc', method: 'credential_store' });
    logger.log.error('chat', '回合失败：本地模型连不上', { provider: 'local' }, { event: 'turn.failed' });
    await drain();
    const text = fileText();
    expect(text).toContain('credential_store'); // 前情在
    expect(text).toContain('credential_get'); // 更早的前情也在（没被挤掉）
    expect(text).toContain('turn.failed'); // 失败自己
    const self = byEvent('log.self');
    expect(self).toHaveLength(1);
    expect(self[0].ctx).toMatchObject({ ring_dumped: 3 });
    // 顺序：前情在失败**之前**（读起来是「前情 → 失败」）
    expect(text.indexOf('credential_store')).toBeLessThan(text.indexOf('turn.failed'));
  });

  it('裸 log.error（无 event，路径噪声那类）**不触发**倒前情——否则被噪声泵爆', async () => {
    logger.log.debug('bridge', 'invoke', { command: 'rpc', method: 'fs_cap' });
    logger.log.error('fs', 'stat 失败：系统找不到指定的文件', { path: 'D:/x' }); // 无 event
    await drain();
    expect(byEvent('log.self')).toHaveLength(0);
    expect(fileText()).toContain('系统找不到指定的文件'); // error 自己照写
  });

  it('前情缓冲定长：写 3000 条后仍被上限截住（内存不随运行时长增长），最旧的先被挤掉', async () => {
    for (let i = 0; i < 3000; i++) logger.log.debug('t', `RING-${i}`);
    logger.log.error('chat', 'boom', undefined, { event: 'turn.failed' });
    // ⚡ 本用例**不再灌填充行逼 flush**：dump 批次自己就有上千条（远过 50 条阈值），
    //    落地即是被测事实。原因见 drain 的说明——十几万字节的在途 append 与紧随其后
    //    的批次在这个内存 fs 的「读-改-写」append 上会互相抢跑，测的就不是产品行为了。
    await waitFor(() => fileText().includes('RING-2999'));
    const self = byEvent('log.self')[0];
    const dumped = Number((self.ctx as Record<string, unknown>).ring_dumped);
    // 不钉死条数：两条上限（2000 条 / 128K 字符）谁先到算谁——契约是「有界」。
    expect(dumped).toBeLessThanOrEqual(2000);
    expect(dumped).toBeGreaterThan(500);
    const text = fileText();
    expect(text).not.toContain('RING-0"'); // 最旧的被挤掉
    expect(text).toContain('RING-2999"'); // 最新的在
    // 自洽：报出的条数 == 真正落盘的前情条数（读数不许虚报）
    expect(lines().filter((e) => e.level === 'debug')).toHaveLength(dumped);
  });

  it('单条超长不入缓冲（一条巨物不许撑内存），且不破坏 NDJSON', async () => {
    logger.log.debug('t', `HUGE-${'x'.repeat(5000)}`);
    logger.log.debug('t', 'SMALL-KEPT');
    logger.log.error('chat', 'boom', undefined, { event: 'turn.failed' });
    await drain();
    expect(fileText()).toContain('SMALL-KEPT');
    expect(fileText()).not.toContain('HUGE-');
    expect(byEvent('log.self')[0].ctx).toMatchObject({ ring_dumped: 1 });
    // 落盘条目逐行可解析（NDJSON 不被截断破坏）——lines() 会解析全文，抛错即红
    expect(lines().length).toBeGreaterThan(0);
  });

  it('级别真的开到 debug 时不倒前情（条目直接进文件，避免写两遍）', async () => {
    H.hint = 'debug';
    await logger.applyLogLevelFromShell();
    logger.log.debug('t', 'DBG-ONCE');
    logger.log.error('chat', 'boom', undefined, { event: 'turn.failed' });
    await drain();
    const text = fileText();
    expect(byEvent('log.self')).toHaveLength(0);
    expect(text.split('DBG-ONCE').length - 1).toBe(1); // 恰好一次
  });

  it('错误风暴不刷屏：倒过一次后要再攒够 25 条才倒第二次', async () => {
    logger.log.debug('t', 'SEED-1');
    logger.log.error('chat', 'boom-1', undefined, { event: 'turn.failed' });
    logger.log.error('chat', 'boom-2', undefined, { event: 'turn.failed' });
    await drain();
    // 第二次错误时缓冲是空的（刚倒完、且没有新 debug）⇒ 只有一条 log.self
    expect(byEvent('log.self')).toHaveLength(1);

    for (let i = 0; i < 25; i++) logger.log.debug('t', `REFILL-${i}`);
    logger.log.error('chat', 'boom-3', undefined, { event: 'turn.failed' });
    await drain();
    expect(byEvent('log.self')).toHaveLength(2); // 攒够 25 条 → 又倒了一次
    expect(fileText()).toContain('REFILL-24');
  });
});
