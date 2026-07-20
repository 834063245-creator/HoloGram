// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：应用级动作注册表 — 命令面板 / CommandBar / 全局快捷键的统一入口。
// 处理函数由 main.ts 在 init 期间注入（依赖 StarGraph / Workspace / 面板单例），
// React 侧只认 action id —— 双方解耦，互不 import。

export interface AppAction {
  id: string;
  /** 命令面板分组标签（操作 / 面板 / 设置…） */
  group: string;
  label: string;
  /** ui/icons.ts 的图标名 */
  icon?: string;
  /** 快捷键展示文本（如 'ctrl D'） */
  kbd?: string;
  run: (arg?: string) => void;
}

const registry = new Map<string, AppAction>();

/** 注册一组动作；重复 id 后者覆盖前者（main.ts 重注入场景安全） */
export function registerActions(list: AppAction[]): void {
  for (const a of list) registry.set(a.id, a);
}

export function listActions(): AppAction[] {
  return [...registry.values()];
}

export function getAction(id: string): AppAction | undefined {
  return registry.get(id);
}

/** 执行动作；未注册（init 尚未注入）时静默忽略 — 启动早期的按钮点击安全 */
export function runAction(id: string, arg?: string): void {
  registry.get(id)?.run(arg);
}
