// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-scope 原语 — 工作区代际语义 + Workspace bag 接线（landmine-map
// 工作区生命周期/状态管理家族 Commit 4）。
//
// 回归背景：工作区"存活期"没有结构体，切换时靠人肉枚举清理。本套原语让
//  - epoch 代际：跨工作区 fire-and-forget 写共享态前记 epoch、resolve 后校验；
//  - Workspace._bag（DisposerBag）：所有获取点登记清理，deactivate/forceClearState 统一释放。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bumpWorkspaceEpoch, getWorkspaceEpoch, isCurrentEpoch } from '../src/workspace-scope';

describe('workspace-scope epoch 代际', () => {
  it('初始代际为 0；bump 单调递增', () => {
    const start = getWorkspaceEpoch();
    expect(start).toBeGreaterThanOrEqual(0);
    bumpWorkspaceEpoch();
    expect(getWorkspaceEpoch()).toBe(start + 1);
  });

  it('isCurrentEpoch：当前代际 true，过期代际 false', () => {
    const e = getWorkspaceEpoch();
    expect(isCurrentEpoch(e)).toBe(true);
    bumpWorkspaceEpoch();
    expect(isCurrentEpoch(e)).toBe(false);
    expect(isCurrentEpoch(getWorkspaceEpoch())).toBe(true);
  });
});

describe('Workspace bag 接线（T0 静态断言）', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'src/workspace.ts'), 'utf8');

  function windowOf(anchor: string, span = 6000): string {
    const i = src.indexOf(anchor);
    if (i < 0) throw new Error(`锚点不存在: ${anchor}`);
    return src.slice(i, i + span);
  }

  it('deactivate 尾部含 bag.dispose 且 catch 可见性（不静默）', () => {
    const body = windowOf('async deactivate(');
    const disposeIdx = body.indexOf('this._bag.dispose()');
    expect(disposeIdx).toBeGreaterThan(-1);
    // 聚合错误不静默 — 必须 catch 并 log.warn
    expect(body.slice(disposeIdx, disposeIdx + 800)).toContain('console.warn');
  });

  it('deactivate 尾部推进工作区代际', () => {
    const body = windowOf('async deactivate(');
    const bumpIdx = body.indexOf('bumpWorkspaceEpoch()');
    expect(bumpIdx).toBeGreaterThan(-1);
  });

  it('forceClearState 含 bag.dispose（同步快通道）', () => {
    const body = windowOf('forceClearState(): void {');
    expect(body).toContain('void this._bag.dispose()');
    expect(body).toContain('bumpWorkspaceEpoch()');
  });

  it('Workspace 类声明 _bag（DisposerBag 单一 owner）', () => {
    expect(src).toContain('private readonly _bag = new DisposerBag()');
  });

  it('deactivate 不再人肉枚举清理 — 只委托 bag + bump（无 _unlisteners 数组）', () => {
    const body = windowOf('async deactivate(');
    expect(src).not.toContain('_unlisteners');
    expect(body).toContain('await this._bag.dispose()');
    // 关键资源清理都是 bag 登记的标签（获取点登记制 — review 可见）
    for (const label of [
      "'listener:graph-updated'",
      "'listener:tool-done'",
      "'runtime-dispose'",
      "'reset-agent-caches'",
      "'aura-shutdown'",
      "'agent-panel-store-clear'",
      "'checkTimer-clear'",
      "'engine-snapshot-refresh-cancel'",
    ]) {
      expect(src, `缺少 bag 登记: ${label}`).toContain(label);
    }
  });
});
