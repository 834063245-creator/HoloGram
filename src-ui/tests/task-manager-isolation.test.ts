// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 回归：主 Agent 待办按 Agent 实例隔离 + 变更订阅（UI TasksPanel 依赖）。
// TaskManager 在 runtime.createAgent 里每会话主 Agent 一个实例，实例之间
// 互不可见 → 每会话独立托盘；且必须通过 subscribe/getSnapshot 让 UI 即时反映。

import { describe, expect, it } from 'vitest';
import { TaskManager, createTaskTools } from '../src/agent/task';

describe('TaskManager per-agent isolation', () => {
  it('两个 Agent 实例的待办互不可见', () => {
    const a = new TaskManager();
    const b = new TaskManager();

    a.create('T1', 'A 的任务');
    b.create('T2', 'B 的任务');
    b.create('T3', 'B 的另一个任务');

    // 每个实例都只看到自己的待办（list 按创建时间倒序，同毫秒序不稳定 → 断言集合）
    expect(a.list().map((t) => t.title)).toEqual(['T1']);
    expect(a.list().length).toBe(1);
    expect(b.list().length).toBe(2);
    const bTitles = new Set(b.list().map((t) => t.title));
    expect(bTitles).toEqual(new Set(['T2', 'T3']));
    expect(a.list().some((t) => t.title === 'T2')).toBe(false);
    expect(b.list().some((t) => t.title === 'T1')).toBe(false);
    // 两个实例的 id 空间互不重叠（各自从 1 起）
    expect(a.get(1)?.title).toBe('T1');
    expect(b.get(1)?.title).toBe('T2');
  });

  it('subscribe / getSnapshot 让 UI 感知变更', () => {
    const mgr = new TaskManager();
    let snapshots = 0;
    const unsub = mgr.subscribe(() => { snapshots++; });

    mgr.create('A', '');
    expect(snapshots).toBe(1);
    expect(mgr.getSnapshot().length).toBe(1);

    mgr.update(1, { status: 'in_progress' });
    expect(snapshots).toBe(2);
    expect(mgr.getSnapshot()[0].status).toBe('in_progress');

    mgr.stop(1);
    expect(snapshots).toBe(3);
    expect(mgr.getSnapshot()[0].status).toBe('cancelled');

    unsub();
    mgr.create('B', '');
    expect(snapshots).toBe(3); // 退订后不再通知
  });

  it('createTaskTools 操作绑定到所属实例', async () => {
    const mgr = new TaskManager();
    const [create, , list, get] = createTaskTools(mgr);
    const created = JSON.parse(await create.execute({ title: '标题', detail: '详情' }));
    const listed = JSON.parse(await list.execute({}));
    const got = JSON.parse(await get.execute({ id: 1 }));
    expect(created.id).toBe(1);
    expect(listed.tasks.length).toBe(1);
    expect(listed.tasks[0].title).toBe('标题');
    expect(got.title).toBe('标题');
  });
});
