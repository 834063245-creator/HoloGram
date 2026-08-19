// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// scoped-store — 多实例 zustand store 的统一注册表基座。
//
// 背景：messages/session/panel/input 四个工厂 store 曾各自复制粘贴一套
// "window 注册表 + 惰性创建 + dispose + 非响应式访问器"样板（约 200 行重复）。
// 本文件收口为泛型工具，四个 store 只保留领域定义。
//
// 设计要点：
//   - store Map 存 window（Vite HMR 不会清除模块级变量，避免热重载破坏 React 订阅）
//   - getStore(storeId?) 惰性创建，默认实例 id 为 '__default__'
//   - disposeStore 精确移除；disposeStoresByPrefix 按前缀批量移除（含精确匹配）
//   - getState(storeId?) 非响应式读取（组件外消费路径）
//
// 用法：
//   const scoped = createScopedStore<MessagesStore>('__hologram_msg_stores__', createMessagesStoreImpl);
//   export const getMessagesStore = scoped.getStore;

import type { StoreApi } from 'zustand';

const DEFAULT_ID = '__default__';

// T = store 实例类型：既可是 React 绑定（UseBoundStore<StoreApi<S>>，可调用），
// 也可是 vanilla（StoreApi<S>）。统一要求具备 getState()。
export interface ScopedStore<T extends { getState(): unknown }> {
  /** 获取实例（惰性创建；缺省 '__default__'） */
  getStore: (storeId?: string) => T;
  /** 精确移除一个实例（默认实例也可移除，调用方自负） */
  disposeStore: (storeId: string) => void;
  /** 移除 key === prefix 或 key.startsWith(`${prefix}:`) 的全部实例 */
  disposeStoresByPrefix: (prefix: string) => void;
  /** 非响应式读取状态（组件外路径；等价 getStore(storeId).getState()） */
  getState: (storeId?: string) => ReturnType<T['getState']>;
}

export function createScopedStore<T extends { getState(): unknown }>(
  key: string,
  createImpl: () => T,
): ScopedStore<T> {
  const w = window as unknown as Record<string, unknown>;
  if (!w[key]) {
    const m = new Map<string, T>();
    m.set(DEFAULT_ID, createImpl());
    w[key] = m;
  }
  const stores = w[key] as Map<string, T>;

  function getStore(storeId?: string): T {
    const id = storeId || DEFAULT_ID;
    let s = stores.get(id);
    if (!s) {
      s = createImpl();
      stores.set(id, s);
    }
    return s;
  }

  return {
    getStore,
    disposeStore: (storeId) => {
      stores.delete(storeId);
    },
    disposeStoresByPrefix: (prefix) => {
      for (const k of Array.from(stores.keys())) {
        if (k === prefix || k.startsWith(`${prefix}:`)) {
          stores.delete(k);
        }
      }
    },
    getState: (storeId?: string) => getStore(storeId).getState() as ReturnType<T['getState']>,
  };
}
