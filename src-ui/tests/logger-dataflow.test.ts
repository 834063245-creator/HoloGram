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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Tauri invoke BEFORE importing the module under test
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('Logger 数据流链路验证', () => {
  let log: any;
  let initLogger: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // 重置模块缓存以确保每次测试从干净的 logBuffer 开始
    vi.resetModules();
    // 动态导入以确保 mock 先生效
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
    const { invoke } = await import('@tauri-apps/api/core');
    // 4 条日志 < MAX_BUFFER(50)，不会触发自动 flush
    // 因此 invoke 不应该被调用
    expect(invoke).not.toHaveBeenCalled();
  });

  it('write → 达到阈值 → 自动触发 flush', async () => {
    await initLogger('/fake/project');

    // 写入 50 条日志，触发自动 flush
    for (let i = 0; i < 50; i++) {
      log.info('mod', `msg ${i}`);
    }

    const { invoke } = await import('@tauri-apps/api/core');
    // 第 50 条写入时，logBuffer.length >= MAX_BUFFER → write 内部调用 flush
    expect(invoke).toHaveBeenCalledWith('log_append', expect.objectContaining({
      path: expect.stringContaining('ui.log'),
      content: expect.any(String),
    }));
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

    const { invoke } = await import('@tauri-apps/api/core');
    expect(invoke).toHaveBeenCalledTimes(1);

    const callArgs = (invoke as any).mock.calls[0];
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

    const { invoke } = await import('@tauri-apps/api/core');
    const content: string = (invoke as any).mock.calls[0][1].content;
    const allEntries = content.trim().split('\n').map((l: string) => JSON.parse(l));

    // 验证批次包含 50 条
    expect(allEntries.length).toBe(50);

    // 在批次中找到那条带 ctx 的错误日志
    // 源码: write(buildEntry('error', 'AuthModule', 'token expired', { userId: 'u123', retry: 3 }))
    // → entry = { ts, level:'error', module:'AuthModule', message:'token expired', ctx:{...} }
    // → logBuffer.push(JSON.stringify(entry))
    // → flush: logBuffer.splice(0).join('\n')
    // → appendToFile(path, batch)
    const targetEntry = allEntries.find(
      (e: any) => e.module === 'AuthModule' && e.message === 'token expired'
    );

    expect(targetEntry).toBeDefined();
    expect(targetEntry!.level).toBe('error');
    expect(targetEntry!.ctx).toEqual({ userId: 'u123', retry: 3 });
    expect(targetEntry!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
