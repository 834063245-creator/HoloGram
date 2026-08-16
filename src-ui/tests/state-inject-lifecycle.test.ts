// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 状态注入缓存生命周期守护。
// 回归背景：注入缓存是进程级全局单例且此前无任何清理 —
// 1) 工作区 deactivate/forceClear 不清缓存 → 旧项目的 git/blame/check
//    状态注入下一个工作区的 turn-start；
// 2) 在途的 fire-and-forget 刷新在切换后 resolve → 旧项目数据回填全局槽；
// 3) buildResult 全局单槽无归属 → A 会话的构建结果注入 B 会话上下文；
// 4) blame 条目永不过期 → agent 自己编辑文件后注入的仍是旧 blame。
import { beforeEach, describe, expect, it, vi } from 'vitest';

// state-inject.ts 经 rpc-contract → bridge.rpc 发 IPC — mock 掉真实 Tauri 调用
const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import {
  getBlameCache,
  getBuildResultCache,
  getCacheEpoch,
  getCheckCache,
  getTimelineCache,
  invalidateBlameEntry,
  resetAgentCaches,
  setBlameEntry,
  setCheckCache,
  setGitCache,
  setTimelineCache,
} from '../src/agent/cache-store';
import {
  buildTurnStartBlock,
  cacheBuildResult,
  formatBuildResult,
  getGitStatusCached,
  refreshGitStatus,
} from '../src/agent/state-inject';

beforeEach(() => {
  mockRpc.mockReset();
  resetAgentCaches();
});

describe('resetAgentCaches（工作区切换清理）', () => {
  it('清空全部注入缓存并推进代际', () => {
    setGitCache(
      { branch: 'main', ahead: 0, behind: 0, dirtyCount: 1, dirtyFiles: [{ file: 'a.ts', status: 'M' }] },
      Date.now(),
    );
    setBlameEntry('a.ts', 'alice');
    setCheckCache({ passed: true, violationCount: 0, newCount: 0, resolvedCount: 0, persistentCount: 0 });
    cacheBuildResult({ command: 'cargo test', outcome: 'pass', summary: 'ok', ts: Date.now() });
    setTimelineCache([{ event_type: 'agent_write', timestamp: 't' }], Date.now());
    const epoch = getCacheEpoch();

    resetAgentCaches();

    expect(getGitStatusCached()).toBeNull();
    expect(getBlameCache()).toEqual({});
    expect(getCheckCache()).toBeNull();
    expect(getBuildResultCache()).toBeNull();
    expect(getTimelineCache()).toEqual([]);
    expect(getCacheEpoch()).toBe(epoch + 1);
  });
});

describe('refreshGitStatus stale-resolve 防护', () => {
  const gitJson = JSON.stringify({ branch: 'main', ahead: 0, behind: 0, files: [] });

  it('工作区未切换时正常写入缓存', async () => {
    mockRpc.mockResolvedValue(gitJson);
    await refreshGitStatus('/p');
    expect(getGitStatusCached()?.branch).toBe('main');
  });

  it('代际变更（工作区切换）后 resolve 的旧数据被丢弃', async () => {
    let resolveRpc: (v: string) => void = () => {};
    mockRpc.mockImplementation(
      () =>
        new Promise<string>((res) => {
          resolveRpc = res;
        }),
    );
    const pending = refreshGitStatus('/old-project');
    resetAgentCaches(); // 模拟工作区切换（deactivate 清缓存 + 推进代际）
    resolveRpc(gitJson);
    await pending;
    expect(getGitStatusCached()).toBeNull();
  });
});

describe('buildResult 归属与滞留', () => {
  it('不匹配的消费者不注入也不消费，本尊可读取消耗', () => {
    cacheBuildResult({ command: 'cargo test', outcome: 'fail', summary: '3 failed', ts: Date.now() }, 'agent-A');

    expect(formatBuildResult('agent-B')).toBeNull();
    expect(getBuildResultCache()).not.toBeNull(); // 留在槽位等本尊

    expect(formatBuildResult('agent-A')).toContain('cargo test');
    expect(getBuildResultCache()).toBeNull(); // 消费一次即清
  });

  it('无归属条目（旧路径）由首个读者消费', () => {
    cacheBuildResult({ command: 'npm test', outcome: 'pass', summary: 'ok', ts: Date.now() });
    expect(formatBuildResult('agent-B')).toContain('npm test');
    expect(getBuildResultCache()).toBeNull();
  });

  it('超龄条目直接丢弃不注入（无匹配消费者的兜底清理）', () => {
    cacheBuildResult({ command: 'cargo build', outcome: 'pass', summary: 'ok', ts: Date.now() - 11 * 60 * 1000 });
    expect(formatBuildResult()).toBeNull();
    expect(getBuildResultCache()).toBeNull();
  });

  it('buildTurnStartBlock 把 consumerId 传给 buildResult 归属匹配', () => {
    cacheBuildResult({ command: 'cargo test', outcome: 'pass', summary: '5 passed', ts: Date.now() }, 'agent-A');
    expect(buildTurnStartBlock('agent-B')).toBe('');
    expect(buildTurnStartBlock('agent-A')).toContain('[构建]');
  });
});

describe('invalidateBlameEntry（编辑后失效）', () => {
  it('只移除被编辑文件的条目', () => {
    setBlameEntry('a.ts', 'alice');
    setBlameEntry('b.ts', 'bob');
    invalidateBlameEntry('a.ts');
    expect(getBlameCache()).toEqual({ 'b.ts': 'bob' });
  });

  it('条目不存在时静默跳过', () => {
    setBlameEntry('a.ts', 'alice');
    invalidateBlameEntry('nope.ts');
    expect(getBlameCache()).toEqual({ 'a.ts': 'alice' });
  });
});
