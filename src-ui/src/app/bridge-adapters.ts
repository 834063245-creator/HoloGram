// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：bus → shell-store 适配器。
// 旧事件总线冻结不拆（见 src/app/README.md），但新组件不订阅 bus ——
// 所有新 chrome 需要的 bus 事件在此集中转写进 shell-store。

import { bus } from '../ui/events';
import { useShellStore } from './shell-store';

/** 挂接全部适配器；App 生命周期内常驻，无需清理 */
export function initBridgeAdapters(): void {
  // 简报结果 → 工具栏「简报」徽标
  bus.on('check:result', ({ passed, violations }: { passed: boolean; violations: number }) => {
    useShellStore.getState().setViolations(passed ? 0 : violations);
  });
}
