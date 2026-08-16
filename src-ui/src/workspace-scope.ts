// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-scope — 工作区级生命周期原语（landmine-map 工作区生命周期/状态管理家族）。
//
// 病根：工作区"存活期"没有结构体 —— 状态散在 Workspace 实例 / 进程级单例 /
// scoped store 三处，切换时靠人肉枚举清理对象。本文件提供两个原语：
//   1. epoch 代际：跨工作区的 fire-and-forget 写共享态前先记 epoch、async resolve
//      后 isCurrentEpoch 校验，代际变了就丢弃（缓存注入 / LSP / autoRestore / runCheck 同族）。
//   2. （bag 原语在 agent/lifecycle.ts 的 DisposerBag，Workspace 直接复用，不在此再建。）
//
// 实现选择：state 用 zustand vanilla store 承载（仿 agent/cache-store.ts），
// 避开 INVARIANTS #1 的模块顶层 let 禁令（模块级多写全局 = 跨面板串流历史）。

import { createStore } from 'zustand/vanilla';

interface WorkspaceScopeState {
  /** 工作区代际 — Workspace 激活/停用/强清时递增；异步回调 resolve 后比对，过期即丢弃。 */
  epoch: number;
}

const scopeStore = createStore<WorkspaceScopeState>(() => ({
  epoch: 0,
}));

/** 当前工作区代际。跨工作区异步操作入口先记下，resolve 后与它比对判过期。 */
export function getWorkspaceEpoch(): number {
  return scopeStore.getState().epoch;
}

/** 工作区切换/停用/强清时推进代际 — 使所有在途的旧项目 fire-and-forget 回调过期。 */
export function bumpWorkspaceEpoch(): void {
  scopeStore.setState((s) => ({ epoch: s.epoch + 1 }));
}

/** 校验传入代际是否仍是当前代际。false 表示工作区已切换，调用方应丢弃在途结果。 */
export function isCurrentEpoch(epoch: number): boolean {
  return epoch === scopeStore.getState().epoch;
}
