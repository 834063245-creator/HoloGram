// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 生命周期原语 — Disposer 契约（agent-core-convergence Phase 1）。
//
// 取自 Cordis 的 ownership 思想，以 HoloGram 自己的 TS runtime 落地：
//   - 一切注册 API 返回 Disposer（清理器）——"谁注册，谁拿到所有权"；
//   - DisposerBag 是清理器的单一 owner：逆序释放、单次执行、async 串行等待；
//   - Phase 3 的 AgentContext.effect() 在此之上组装服务级 ownership。
//
// 行为规约（tests/lifecycle-disposer.test.ts 钉住）：
//   1. 逆序清理（后注册的先释放——依赖建的反方向拆）；
//   2. dispose 单次执行（重复调用 no-op）；
//   3. async 清理被串行等待（前一个 settle 后才跑下一个）；
//   4. 单个清理失败不阻断后续，错误聚合抛出（可观测）；
//   5. dispose 后 add 抛错（停新注册——Phase 4 生命周期统一的前置语义）。

/** 清理器：返回 void 或 Promise——bag 会串行等待。幂等性由 once()/调用方包装保证。 */
export type Disposer = () => void | Promise<void>;

interface Entry {
  disposer: Disposer;
  label: string;
}

export class DisposerBag {
  private entries: Entry[] = [];
  private _disposed = false;

  get disposed(): boolean {
    return this._disposed;
  }

  get size(): number {
    return this.entries.length;
  }

  /** 登记一个清理器，返回"单独释放这一项"的 Disposer（从 bag 移除并执行一次）。 */
  add(disposer: Disposer, label = 'unnamed'): Disposer {
    if (this._disposed) {
      throw new Error(`[DisposerBag] 已 dispose，拒绝新增清理器（${label}）——生命周期已结束`);
    }
    const entry: Entry = { disposer: once(disposer), label };
    this.entries.push(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
      void entry.disposer();
    };
  }

  /** 逆序串行释放全部清理器。单次执行；单个失败不阻断后续，全部跑完后聚合抛出。
   *  同步快通道（Phase 4）：清理器返回非 Promise 时不产生微任务边界——全 sync
   *  链在 dispose() 返回 promise 之前同步执行完毕（调用方无需 await 即可观测
   *  副作用，`_disposeAgent` 的同步语义依赖此点）；async 清理器仍串行等待。 */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    const remaining = this.entries;
    this.entries = [];
    remaining.reverse();
    const errors: Array<{ label: string; error: unknown }> = [];
    for (const e of remaining) {
      try {
        const r = e.disposer();
        if (r && typeof (r as PromiseLike<void>).then === 'function') {
          await r;
        }
      } catch (err) {
        errors.push({ label: e.label, error: err });
      }
    }
    if (errors.length > 0) {
      const detail = errors.map((e) => `${e.label}: ${String(e.error)}`).join('; ');
      throw new Error(`[DisposerBag] ${errors.length} 个清理器失败 — ${detail}`);
    }
  }
}

/** 幂等包装：任意 Disposer 包一层后最多执行一次。 */
export function once(disposer: Disposer): Disposer {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    return disposer();
  };
}

/** 立即执行注册并把返回的清理器纳入 bag 所有权；返回该项的单独释放器。
 *  Phase 3 的 AgentContext.effect(register, label) 在此之上挂身份与审计。 */
export function runInContext(bag: DisposerBag, register: () => Disposer, label = 'unnamed'): Disposer {
  return bag.add(register(), label);
}
