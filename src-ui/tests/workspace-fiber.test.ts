// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Workspace fiber 生命周期运行时验证（cordis-migration P1）。
// 与 workspace-lifecycle / workspace-scope 的 T0 静态断言互补：这里跑真实
// Workspace（placeholder 路径 — 不触 RPC），钉住 fiber 的可观测契约：
//   1. placeholder 工作区持有 cordis fiber（ctx 是 Context 品牌）；
//   2. 获取点 effect 登记 → forceClearState 快通道释放（清理器执行、epoch 推进）；
//   3. deactivate 走 fiber dispose-to-quiescence（await 返回即清理器全部 settle）；
//   4. dispose 后拒绝新增 effect（显式失败，对齐旧 DisposerBag 的停注册契约）。

import { describe, expect, it } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { Context } from '../src/cordis';
import { Workspace } from '../src/workspace';
import { getWorkspaceEpoch } from '../src/workspace-scope';

/** 冲刷微任务 + 定时器（快通道清理器在首个微任务内执行）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeChatPanel(): ChatCore {
  return { saveActiveSession: async () => {} } as unknown as ChatCore;
}

describe('Workspace fiber 生命周期（P1）', () => {
  it('placeholder 工作区持有 cordis fiber，cordisCtx 是 Context 品牌', async () => {
    const ws = Workspace.placeholder();
    expect(Context.is(ws.cordisCtx)).toBe(true);
    await ws.deactivate(fakeChatPanel());
  });

  it('effect 随 forceClearState 快通道释放，epoch 同步推进', async () => {
    const ws = Workspace.placeholder();
    const events: string[] = [];
    ws.cordisCtx.effect(() => {
      events.push('setup');
      return () => {
        events.push('dispose');
      };
    }, 'probe');
    const epoch = getWorkspaceEpoch();
    ws.forceClearState();
    await flush();
    expect(events).toEqual(['setup', 'dispose']);
    expect(getWorkspaceEpoch()).toBe(epoch + 1);
  });

  it('deactivate 是 dispose-to-quiescence：await 返回即清理器已全部执行', async () => {
    const ws = Workspace.placeholder();
    let disposed = false;
    ws.cordisCtx.effect(
      () => async () => {
        // async 清理器 — deactivate 的 await 必须等它 settle
        await new Promise((resolve) => setTimeout(resolve, 5));
        disposed = true;
      },
      'async-probe',
    );
    await ws.deactivate(fakeChatPanel());
    expect(disposed).toBe(true);
  });

  it('fiber dispose 后拒绝新增 effect（显式失败契约保持）', async () => {
    const ws = Workspace.placeholder();
    ws.forceClearState();
    await flush();
    expect(() => ws.cordisCtx.effect(() => {}, 'late')).toThrow();
  });
});
