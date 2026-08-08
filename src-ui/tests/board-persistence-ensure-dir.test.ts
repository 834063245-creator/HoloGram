// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1-22 回归：BoardPersistence._ensureDir 失败不得假成功。
// 修复前：catch 把一切错误当「已存在」→ _dirReady=true 永久锁存
// → board 永不落盘、永不再试、零信号，重启全丢。
// （后端 create_dir_all 本就幂等，「已存在」不会抛错，catch 到的全是真实失败。）
// 修复后：失败不置位（下次 flush 重试）+ warn 信号（每段连续失败一次）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { BoardPersistence } from '../src/agent/board-persistence';

function makeBoard(): BoardPersistence {
  return new BoardPersistence({ projectPath: '/fake/project', sessionId: 's1', dirName: 'taskboard' });
}

describe('P1-22: BoardPersistence._ensureDir 假成功', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('create_directory 失败不锁存 _dirReady，下次 flush 重试', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failDir = true;
    mockRpc.mockImplementation(async (cmd: string) => {
      if (cmd === 'create_directory' && failDir) throw new Error('磁盘只读');
      return undefined;
    });

    const bp = makeBoard();
    await bp.flush('{"v":1}');
    // 第一次失败：create_directory 被调，write_file_content 未调，有 warn
    expect(mockRpc.mock.calls.filter((c) => c[0] === 'create_directory').length).toBe(1);
    expect(mockRpc.mock.calls.some((c) => c[0] === 'write_file_content')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    // 恢复后第二次 flush：必须重试 create_directory（修复前因 _dirReady 锁存而直接写文件）
    failDir = false;
    await bp.flush('{"v":2}');
    expect(mockRpc.mock.calls.filter((c) => c[0] === 'create_directory').length).toBe(2);
    expect(mockRpc.mock.calls.some((c) => c[0] === 'write_file_content')).toBe(true);
    warn.mockRestore();
  });

  it('连续失败只 warn 一次，成功落盘后复位', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    mockRpc.mockImplementation(async (cmd: string) => {
      if (fail && (cmd === 'create_directory' || cmd === 'write_file_content')) throw new Error('IO 错误');
      return undefined;
    });

    const bp = makeBoard();
    await bp.flush('a');
    await bp.flush('b');
    expect(warn).toHaveBeenCalledTimes(1);

    fail = false;
    await bp.flush('c');
    expect(warn).toHaveBeenCalledTimes(1); // 成功不 warn

    // 再次失败：复位后应重新 warn
    fail = true;
    await bp.flush('d');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
