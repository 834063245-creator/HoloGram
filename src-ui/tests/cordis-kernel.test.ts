// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Cordis 内核冒烟测试（cordis-migration P0 验收）。
// 钉住 vendor 内核在本项目工具链（vitest + jsdom + tsc strict）下的核心契约：
//   1. 根 Context 创建与品牌检查；
//   2. boot 单例：init 幂等 / 未初始化 get 抛错（显式失败）；
//   3. plugin 挂载 fiber，ctx.effect 清理器随 fiber dispose 逆序执行
//      （P1 Workspace fiber 化、INVARIANT #12 重写的语义地基）；
//   4. Service 子类 super(ctx, name) 提供服务 → 属性读取 / ctx.get 解析 /
//      fiber dispose 后解除；
//   5. 事件：fiber 内 global 监听 + 根 emit 收发，dispose 后监听移除
//      （global 语义对齐 DSH invariants 测试用法）。

import { describe, expect, it } from 'vitest';
import { _resetCordisKernelForTest, getCordisRoot, initCordisKernel } from '../src/cordis/boot';
import { Context, Service } from '../src/cordis/index';

// 测试事件声明进内核 Events 表（对齐 DSH 测试的 declare module 用法）
declare module '../src/cordis/index' {
  interface Events {
    'cordis-test/ping'(): void;
  }
}

class DemoProbeService extends Service {
  readonly tag: string;

  constructor(ctx: Context, tag: string) {
    super(ctx, 'demoProbe');
    this.tag = tag;
  }
}

describe('cordis kernel (vendored) smoke', () => {
  it('根 Context 创建 + Context.is 品牌检查', () => {
    const ctx = new Context();
    expect(Context.is(ctx)).toBe(true);
    expect(Context.is({})).toBe(false);
    expect(Context.is(undefined)).toBe(false);
  });

  it('boot 单例：init 幂等，未初始化的 getCordisRoot 抛错', () => {
    _resetCordisKernelForTest();
    expect(() => getCordisRoot()).toThrow(/not initialized/);
    const a = initCordisKernel();
    expect(initCordisKernel()).toBe(a);
    expect(getCordisRoot()).toBe(a);
    expect(Context.is(a)).toBe(true);
    _resetCordisKernelForTest();
  });

  it('plugin 挂载 fiber，effect setup 立即执行、清理器随 dispose 逆序释放', async () => {
    // ctx.effect 语义（对齐 events.ts 内部用法）：setup 立即执行，
    // 返回值是清理器；fiber dispose 时清理器逆序（LIFO）释放。
    const ctx = new Context();
    const order: string[] = [];
    const fiber = ctx.plugin({
      name: 'demo-effects',
      apply(self) {
        self.effect(() => {
          order.push('setup-1');
          return () => {
            order.push('dispose-1');
          };
        });
        self.effect(() => {
          order.push('setup-2');
          return () => {
            order.push('dispose-2');
          };
        });
      },
    });
    await fiber;
    expect(order).toEqual(['setup-1', 'setup-2']);
    await fiber.dispose();
    expect(order).toEqual(['setup-1', 'setup-2', 'dispose-2', 'dispose-1']);
  });

  it('Service 提供与消费，fiber dispose 后解除', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin({
      name: 'demo-svc',
      apply(self) {
        new DemoProbeService(self, 'v1');
      },
    });
    await fiber;
    expect((ctx as unknown as Record<string, unknown>).demoProbe).toBeInstanceOf(DemoProbeService);
    expect((ctx.get('demoProbe', false) as DemoProbeService | undefined)?.tag).toBe('v1');
    await fiber.dispose();
    expect(ctx.get('demoProbe', false)).toBeUndefined();
  });

  it('事件：fiber 内监听（global），dispose 后监听移除', async () => {
    const ctx = new Context();
    let hits = 0;
    const fiber = ctx.plugin({
      name: 'demo-listener',
      apply(self) {
        self.on(
          'cordis-test/ping',
          () => {
            hits += 1;
          },
          { global: true },
        );
      },
    });
    await fiber;
    ctx.emit('cordis-test/ping');
    expect(hits).toBe(1);
    await fiber.dispose();
    ctx.emit('cordis-test/ping');
    expect(hits).toBe(1);
  });
});
