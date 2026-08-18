// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Cordis 内核引导（cordis-migration P0）——应用根 Context 的唯一创建点。
//
// 定位：本文件是 HoloGram 自有代码（非 vendor）。src/cordis/ 其余 *.ts 是从
// DSH vendor/cordis 原样拷贝的内核源码，溯源与升级纪律见 ./README.md。
//
// 为什么允许模块级单例：根 Context 是服务定位器根（app 级单例，层级等同
// shell-store / dock-store），不是响应式业务状态——不落入 CONVENTIONS §1.2
// 「禁止模块顶层变量存业务状态」针对的跨面板流式状态串台雷区。语义约定：
//   - initCordisKernel() 幂等：重复调用返回同一根，不重复装配；
//   - getCordisRoot() 严格：未初始化直接抛错，杜绝 undefined 静默传播
//     （对齐 agent/context.ts AgentServices「resolve 显式报错」的既有约定）；
//   - P1 起各子系统（Workspace / agent 装配 / 面板）以 fiber 挂载到这棵树上，
//     生命周期清理由 fiber dispose 语义接管（替代 Workspace._bag —— 见
//     docs/plans/cordis-migration/ 的阶段划分）。

import { Context } from './index';

let root: Context | undefined;

/** 创建（或返回已存在的）应用根 Context。main.ts 引导期调用一次。 */
export function initCordisKernel(): Context {
  if (!root) {
    root = new Context();
  }
  return root;
}

/** 取应用根 Context。未初始化时抛错（显式失败，不做隐式兜底创建）。 */
export function getCordisRoot(): Context {
  if (!root) {
    throw new Error('[cordis] kernel not initialized — call initCordisKernel() during app bootstrap first');
  }
  return root;
}

/** 测试辅助：重置内核单例。仅测试使用；运行时禁止调用。 */
export function _resetCordisKernelForTest(): void {
  root = undefined;
}
