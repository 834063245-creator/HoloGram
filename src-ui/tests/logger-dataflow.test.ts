// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 验证 logBuffer 数据流链路：
//   debug/info/warn/error → write() → logBuffer.push() → flush() → appendToFile()
//
// 图分析声称的边：
//   - [debug,info,warn,error] --reads--> write
//   - write --shares--> logBuffer (Medium)
//   - write --reads--> flush
//   - flush --shares--> logBuffer
//   - flush --triggers--> appendToFile
//
// 此测试通过 mock Tauri invoke 来验证整条链路的实际运行时行为。
//
// fs 域收口（2026-09-04）：appendToFile 经 kernelLogAppend（rpc-contract 具名
// helper，内部直呼 fs_cap）——mock 站到 helper 层（不再拦 bridge + shim 翻
// 信封）。append 内容记录在共享内存 fs 的文件表里（log_append = 追加语义）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 顶层触发 rpc-contract 的 vi.mock 工厂求值（vi.mock 惰性执行于首个 import
// 目标模块时——本文件 logger 全动态 import，不在文件加载期触发则 beforeEach
// 时 H.kernelFs 仍 null）。
import { kernelLogAppend } from '../src/rpc-contract';

void kernelLogAppend;

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

// flush 是 fire-and-forget：appendToFile 内动态 import rpc-contract（vi.resetModules
// 后冷装载，实测首调可达 ~100ms）——固定 10ms 等待在该窗口内断言会假红（存量
// 时序敏感，2026-09-04 main 复现存红后根治）。轮询等待调用真正落地再断言。
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: 超时未落地');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Logger 数据流链路验证', () => {
  let log: any;
  let initLogger: any;

  beforeEach(async () => {
    const k = H.kernelFs!;
    k.fs.files.clear();
    k.fs.dirs.clear();
    k.fs.writes.length = 0;
    k.fs.fail = {};
    // 重置模块缓存以确保每次测试从干净的 logBuffer 开始
    vi.resetModules();

    // 动态导入 — vi.mock 已拦截 rpc-contract，logger 内部动态 import 拿到 mock
    const mod = await import('../src/agent/logger.js');
    log = mod.log;
    initLogger = mod.initLogger;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('级别过滤：默认 info 下 debug 不入缓冲，其余三个入口照写（批 3）', async () => {
    // 初始化日志路径
    await initLogger('/fake/project');

    // 4 个入口函数调用 write，其中 debug 在默认级别下被丢弃
    log.debug('mod', 'debug msg');
    log.info('mod', 'info msg');
    log.warn('mod', 'warn msg');
    log.error('mod', 'error msg');

    // 缓冲里只有 3 条（< MAX_BUFFER 50）⇒ 未触发自动 flush（appendToFile 未被调用）
    expect(H.kernelFs!.fs.files.size).toBe(0);

    // 补 47 条逼出 flush：批次里**没有** debug 行 = 过滤真的生效（不是没写）
    for (let i = 0; i < 47; i++) log.info('mod', `fill ${i}`);
    await waitFor(() => H.kernelFs!.fs.files.size >= 1);
    const content = [...H.kernelFs!.fs.files.entries()].find(([p]) => p.includes('ui.log'))![1] as string;
    expect(content).not.toContain('debug msg');
    expect(content).toContain('info msg');
    expect(content.split('\n').filter(Boolean)).toHaveLength(50);
  });

  it('write → 达到阈值 → 自动触发 flush', async () => {
    await initLogger('/fake/project');

    // 写入 50 条日志，触发自动 flush
    for (let i = 0; i < 50; i++) {
      log.info('mod', `msg ${i}`);
    }
    // flush() 是 fire-and-forget 异步，等调用真正落地（冷 import 可达 ~100ms）
    await waitFor(() => H.kernelFs!.fs.files.size >= 1);

    // 第 50 条写入时，logBuffer.length >= MAX_BUFFER → write 内部调用 flush
    // flush → appendToFile → kernelLogAppend(path, content)
    const logFiles = [...H.kernelFs!.fs.files.entries()].filter(([p]) => p.includes('ui.log'));
    expect(logFiles.length).toBeGreaterThanOrEqual(1);
    expect(logFiles[0][0]).toContain('ui.log');
    expect(logFiles[0][1].length).toBeGreaterThan(0);
  });

  it('手动触发 flush → 清空 logBuffer → appendToFile 接收完整批次', async () => {
    // 此测试依赖前一个测试清空了 buffer，从头开始
    await initLogger('/fake/project');

    // 先写入 2 条，再写入 48 条 → 总计 50，触发 flush
    // 注意：write 内部在 push 后检查 >= MAX_BUFFER(50)，所以第 50 条 push 后触发
    log.info('mod', 'message 1');
    log.warn('mod', 'message 2');

    // 再写 48 条，第 48 次时 buffer 达到 50，触发 flush
    // （批 3 起默认级别 info，debug 不入缓冲——这里的填充行必须是 info，
    //  否则 batch 只有 2 条、永不触发 flush）
    for (let i = 0; i < 48; i++) {
      log.info('mod', `batch msg ${i}`);
    }
    // flush() 是 fire-and-forget 异步，等调用真正落地（冷 import 可达 ~100ms）
    await waitFor(() => H.kernelFs!.fs.files.size >= 1);

    // 文件表只应有 1 个 ui.log（单次追加——kernelLogAppend 追加语义）
    const logFiles = [...H.kernelFs!.fs.files.entries()].filter(([p]) => p.includes('ui.log'));
    expect(logFiles.length).toBe(1);

    // append 内容 = 完整批次（50 条，log_append 的 content 是单批全量）
    const content: string = logFiles[0][1];
    const lines = content.trim().split('\n');
    // 2 条手动 + 48 条循环 = 50 条，flush 将其全部 splice 出来
    expect(lines.length).toBe(50);

    // 每条都是合法 JSON
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry).toHaveProperty('ts');
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('message');
    }

    // 验证批次顺序：前两条是我们手动写入的
    expect(lines[0]).toContain('message 1');
    expect(lines[1]).toContain('message 2');
  });

  it('数据流完整性：logLevel → entry → buffer → batch → file', async () => {
    // 直接写满 50 条（含一条带 ctx 的错误日志）触发 flush，避免跨测试 buffer 状态干扰
    await initLogger('/fake/project');

    // 第一条：带上下文的消息（验证完整的数据流转换链）
    log.error('AuthModule', 'token expired', { userId: 'u123', retry: 3 });

    // 填充 49 条以达到 MAX_BUFFER，触发 flush
    for (let i = 0; i < 49; i++) {
      log.info('fill', `padding ${i}`);
    }
    // flush() 是 fire-and-forget 异步，等调用真正落地（冷 import 可达 ~100ms）
    await waitFor(() => H.kernelFs!.fs.files.size >= 1);

    // 读回 ui.log 内容，解析全部条目
    const logFiles = [...H.kernelFs!.fs.files.entries()].filter(([p]) => p.includes('ui.log'));
    const content: string = logFiles[0][1];
    const allEntries = content
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l));

    // 验证批次包含 50 条
    expect(allEntries.length).toBe(50);

    // 在批次中找到那条带 ctx 的错误日志
    // 源码: write(buildEntry('error', 'AuthModule', 'token expired', { userId: 'u123', retry: 3 }))
    // → entry = { ts, level:'error', module:'AuthModule', message:'token expired', ctx:{...} }
    // → logBuffer.push(JSON.stringify(entry))
    // → flush: logBuffer.splice(0).join('\n')
    // → appendToFile(path, batch)
    const targetEntry = allEntries.find((e: any) => e.module === 'AuthModule' && e.message === 'token expired');

    expect(targetEntry).toBeDefined();
    expect(targetEntry?.level).toBe('error');
    expect(targetEntry?.ctx).toEqual({ userId: 'u123', retry: 3 });
    expect(targetEntry?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('Logger 工作区切换', () => {
  let initLogger: any;
  let log: any;

  beforeEach(async () => {
    const k = H.kernelFs!;
    k.fs.files.clear();
    k.fs.dirs.clear();
    k.fs.writes.length = 0;
    k.fs.fail = {};
    vi.resetModules();

    const mod = await import('../src/agent/logger.js');
    log = mod.log;
    initLogger = mod.initLogger;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initLogger 切换工作区时先 flush 旧缓冲再创建新 timer', async () => {
    // 工作区 A：写入几条日志，不触发自动 flush（< 50）
    await initLogger('/project-a');
    log.info('mod', 'msg from A');

    // 工作区 B：initLogger 应该先 flush 旧缓冲
    await initLogger('/project-b');

    // 旧缓冲（包含 "msg from A"）应该在 initLogger 内部被 flush 到 project-a 的日志文件
    const logFiles = [...H.kernelFs!.fs.files.entries()].filter(([p]) => p.includes('/project-a/.lantai/logs/ui.log'));
    expect(logFiles.length).toBeGreaterThanOrEqual(1);
    expect(logFiles[0][1]).toContain('msg from A');
  });

  it('initLogger 切换工作区时清除旧 setInterval', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    await initLogger('/project-a');
    // 此时 setInterval 已经被调用过 1 次
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    await initLogger('/project-b');
    // 第二次 initLogger 应该先 clearInterval
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    clearIntervalSpy.mockRestore();
  });

  it('initLogger 后日志写入新工作区路径', async () => {
    await initLogger('/project-a');
    H.kernelFs!.fs.files.clear();

    await initLogger('/project-b');

    // 手动触发 flush 并等待完成：写满 50 条 → write() 内部调 flush()
    for (let i = 0; i < 50; i++) {
      log.info('mod', `msg ${i}`);
    }
    // flush() 是 fire-and-forget，等调用真正落地（冷 import 可达 ~100ms）
    await waitFor(() => H.kernelFs!.fs.files.size >= 1);

    // 验证写入的是 project-b 的日志路径
    const logFiles = [...H.kernelFs!.fs.files.entries()].filter(([p]) => p.includes('/project-b/.lantai/logs/ui.log'));
    expect(logFiles.length).toBeGreaterThanOrEqual(1);
  });
});
