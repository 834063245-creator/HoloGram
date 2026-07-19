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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 顶层 mockRpc 供 vi.mock 工厂闭包引用；vi.mock 是 hoisted 的，可拦截动态 import()
const mockRpc = vi.fn();

vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

describe('Logger 数据流链路验证', () => {
  let log: any;
  let initLogger: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue('ok');
    // 重置模块缓存以确保每次测试从干净的 logBuffer 开始
    vi.resetModules();

    // 动态导入 — vi.mock 已拦截 bridge，logger 内部 await import('../bridge') 会拿到 mock
    const mod = await import('../src/agent/logger.js');
    log = mod.log;
    initLogger = mod.initLogger;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('debug/info/warn/error 都会调用 write → 写入 logBuffer', async () => {
    // 初始化日志路径
    await initLogger('/fake/project');

    // 4 个入口函数调用 write，写入 buffer
    log.debug('mod', 'debug msg');
    log.info('mod', 'info msg');
    log.warn('mod', 'warn msg');
    log.error('mod', 'error msg');

    // 4 条日志都在 buffer 里，未满 50 条不会触发 flush
    // 我们无法直接读私有变量，但通过 flush 的间接行为来验证
    // 验证：flush 应该被 write 内部的 >= MAX_BUFFER 条件触发
    // 这里 4 条 < 50，所以不会自动 flush —— 证明 buffer 在积累
    // 4 条日志 < MAX_BUFFER(50)，不会触发自动 flush
    // 因此 rpc 不应该被调用
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('write → 达到阈值 → 自动触发 flush', async () => {
    await initLogger('/fake/project');

    // 写入 50 条日志，触发自动 flush
    for (let i = 0; i < 50; i++) {
      log.info('mod', `msg ${i}`);
    }
    // flush() 是 fire-and-forget 异步，等一个 tick
    await new Promise((r) => setTimeout(r, 10));

    // 第 50 条写入时，logBuffer.length >= MAX_BUFFER → write 内部调用 flush
    // flush → appendToFile → rpc('log_append', { path, content })
    expect(mockRpc).toHaveBeenCalledWith(
      'log_append',
      expect.objectContaining({
        path: expect.stringContaining('ui.log'),
        content: expect.any(String),
      }),
    );
  });

  it('手动触发 flush → 清空 logBuffer → appendToFile 接收完整批次', async () => {
    // 此测试依赖前一个测试清空了 buffer，从头开始
    await initLogger('/fake/project');

    // 先写入 2 条，再写入 48 条 → 总计 50，触发 flush
    // 注意：write 内部在 push 后检查 >= MAX_BUFFER(50)，所以第 50 条 push 后触发
    log.info('mod', 'message 1');
    log.warn('mod', 'message 2');

    // 再写 48 条，第 48 次时 buffer 达到 50，触发 flush
    for (let i = 0; i < 48; i++) {
      log.debug('mod', `batch msg ${i}`);
    }
    // flush() 是 fire-and-forget 异步，等一个 tick
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRpc).toHaveBeenCalledTimes(1);

    const callArgs = mockRpc.mock.calls[0];
    const content: string = callArgs[1].content;
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
    // flush() 是 fire-and-forget 异步，等一个 tick
    await new Promise((r) => setTimeout(r, 10));

    const content: string = mockRpc.mock.calls[0][1].content;
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
    vi.clearAllMocks();
    mockRpc.mockResolvedValue('ok');
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

    const callCountAfterA = mockRpc.mock.calls.length;

    // 工作区 B：initLogger 应该先 flush 旧缓冲
    await initLogger('/project-b');

    // 旧缓冲（包含 "msg from A"）应该在 initLogger 内部被 flush 到 project-a 的日志文件
    expect(mockRpc).toHaveBeenCalledTimes(callCountAfterA + 1);
    const lastCall = mockRpc.mock.calls[callCountAfterA];
    expect(lastCall[0]).toBe('log_append');
    expect(lastCall[1].path).toContain('/project-a/.hologram/logs/ui.log');
    expect(lastCall[1].content).toContain('msg from A');
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
    mockRpc.mockClear();

    await initLogger('/project-b');

    // 手动触发 flush 并等待完成：写满 50 条 → write() 内部调 flush()
    for (let i = 0; i < 50; i++) {
      log.info('mod', `msg ${i}`);
    }
    // flush() 是 fire-and-forget（内部 appendToFile 是 async），等一个 tick
    await new Promise((r) => setTimeout(r, 10));

    // 验证写入的是 project-b 的日志路径
    const calls = mockRpc.mock.calls.filter((c: any) => c[0] === 'log_append');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const lastLogCall = calls[calls.length - 1];
    expect(lastLogCall[1].path).toContain('/project-b/.hologram/logs/ui.log');
  });
});
