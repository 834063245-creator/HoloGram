// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Workspace 生命周期守护（T0 静态断言，仿 tests/convergence/gate.mjs 的源码断言先例）。
// 回归背景：
// - H3：forceClearState()（deactivate 超时的紧急路径）此前不调 disposeAll ——
//   每个存活 Agent 的 60s 巡检 timer 永久存活，_enforceTTL 会继续对共享后端发
//   agent_isolation_discard（真实删除 git worktree）；saveState('done') 不落盘留死账。
// - H4：runCheck 在途 RPC resolve 后无 _active 守卫 —— 旧项目检查结果写进
//   新项目 dock store 并自动弹开 check 面板。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(path.resolve(process.cwd(), 'src/workspace.ts'), 'utf8');

/** 截取从 anchor 开始、长度为 span 的源码窗口做断言。 */
function windowOf(anchor: string, span = 4000): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`锚点不存在: ${anchor}`);
  return src.slice(i, i + span);
}

describe('forceClearState 紧急路径清理（H3）', () => {
  const body = windowOf('forceClearState(): void {');

  it('disposeAll 在 runtime = null 之前调用（同步），且委托 bag 统一释放', () => {
    const dispose = body.indexOf('.disposeAll()');
    const detach = body.indexOf('this.runtime = null');
    expect(dispose, 'forceClearState 必须调 disposeAll').toBeGreaterThan(-1);
    expect(detach).toBeGreaterThan(-1);
    expect(dispose, 'disposeAll 必须先于 runtime 解绑').toBeLessThan(detach);
    // 其余清理（aura/cache）走 fiber effect 单一机制 — forceClearState 委托 _fiber.dispose()
    expect(body).toContain('void this._fiber.dispose()');
    expect(body).toContain('bumpWorkspaceEpoch()');
  });

  it('aura 单例释放登记进 bag（aura-shutdown 清理器）', () => {
    expect(src).toContain("'aura-shutdown'");
    expect(src).toContain('auraShutdown');
  });

  it('agent 注入缓存清理登记进 bag（reset-agent-caches 清理器）', () => {
    expect(src).toContain("'reset-agent-caches'");
    expect(src).toContain('resetAgentCaches()');
  });
});

describe('runCheck/scheduleCheck 切换守卫（H4）', () => {
  it('runCheck 入口有 _active 守卫', () => {
    const body = windowOf('async runCheck(): Promise<void> {');
    expect(body.slice(0, 200)).toContain('this._active');
  });

  it('scheduleCheck 入口有 _active 守卫', () => {
    const body = windowOf('scheduleCheck(): void {');
    expect(body.slice(0, 200)).toContain('this._active');
  });

  it('finally 重武装 checkTimer 前有 _active 守卫', () => {
    const body = windowOf('async runCheck(): Promise<void> {');
    const finallyIdx = body.indexOf('finally');
    expect(finallyIdx).toBeGreaterThan(-1);
    const tail = body.slice(finallyIdx);
    expect(tail).toContain('this._active');
  });
});
