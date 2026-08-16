// Disposer 契约行为测试（agent-core-convergence Phase 1 / 验证计划 T1）。
// 钉住 lifecycle.ts 头注释里的五条行为规约。
import { describe, expect, it } from 'vitest';
import { DisposerBag, once, runInContext, type Disposer } from '../src/agent/lifecycle';

describe('DisposerBag — 逆序清理', () => {
  it('后注册的先释放（依赖建的反方向拆）', async () => {
    const order: string[] = [];
    const bag = new DisposerBag();
    bag.add(() => order.push('a'), 'a');
    bag.add(() => order.push('b'), 'b');
    bag.add(() => order.push('c'), 'c');
    await bag.dispose();
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('单项释放器只释放自己，bag.dispose 不再重复执行', async () => {
    const order: string[] = [];
    const bag = new DisposerBag();
    const releaseA = bag.add(() => order.push('a'), 'a');
    bag.add(() => order.push('b'), 'b');
    releaseA();
    releaseA(); // 幂等
    expect(order).toEqual(['a']);
    expect(bag.size).toBe(1);
    await bag.dispose();
    expect(order).toEqual(['a', 'b']);
  });
});

describe('DisposerBag — 单次执行与停新注册', () => {
  it('dispose 重复调用为 no-op', async () => {
    const order: string[] = [];
    const bag = new DisposerBag();
    bag.add(() => order.push('x'), 'x');
    await bag.dispose();
    await bag.dispose();
    expect(order).toEqual(['x']);
  });

  it('dispose 后 add 抛错', async () => {
    const bag = new DisposerBag();
    await bag.dispose();
    expect(() => bag.add(() => {})).toThrow(/已 dispose/);
  });
});

describe('DisposerBag — async 串行等待', () => {
  it('前一个 async 清理 settle 后才执行下一个', async () => {
    const order: string[] = [];
    const bag = new DisposerBag();
    // 释放顺序 = 注册的逆序：slow 后注册 → 先释放；follow 必须等 slow 完成后才启动
    bag.add(() => order.push('follow-start'), 'follow');
    const slow: Disposer = async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('slow-done');
    };
    bag.add(slow, 'slow');
    const p = bag.dispose();
    expect(order).toEqual([]); // slow 未完成前，follow 不得启动
    await p;
    expect(order).toEqual(['slow-done', 'follow-start']);
  });

  it('dispose 返回的 promise 等待全部清理完成', async () => {
    let flag = false;
    const bag = new DisposerBag();
    bag.add(
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        flag = true;
      },
      'slow',
    );
    await bag.dispose();
    expect(flag).toBe(true);
  });
});

describe('DisposerBag — 部分失败不阻断后续', () => {
  it('失败的清理器不影响其余清理，错误聚合抛出且带 label', async () => {
    const order: string[] = [];
    const bag = new DisposerBag();
    bag.add(() => order.push('a'), 'a');
    bag.add(
      () => {
        throw new Error('boom');
      },
      'boom-label',
    );
    bag.add(
      async () => {
        order.push('c');
        throw new Error('boom-async');
      },
      'c-label',
    );
    // 错误按释放序（注册的逆序）收集：c-label 先释放先入列
    await expect(bag.dispose()).rejects.toThrow(/2 个清理器失败.*c-label.*boom-label/s);
    expect(order).toEqual(['c', 'a']); // 逆序 + 失败者之后的照常执行
  });
});

describe('once / runInContext', () => {
  it('once 包装的清理器最多执行一次', () => {
    const order: string[] = [];
    const d = once(() => order.push('x'));
    d();
    d();
    expect(order).toEqual(['x']);
  });

  it('runInContext 立即注册并纳入 bag；返回的释放器单独生效', async () => {
    const order: string[] = [];
    const bag = new DisposerBag();
    const release = runInContext(
      bag,
      () => () => order.push('registered-cleanup'),
      'via-run',
    );
    expect(bag.size).toBe(1);
    release();
    expect(order).toEqual(['registered-cleanup']);
    expect(bag.size).toBe(0);
    await bag.dispose();
    expect(order).toEqual(['registered-cleanup']);
  });
});
