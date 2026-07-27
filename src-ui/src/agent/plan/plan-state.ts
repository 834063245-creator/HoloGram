// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Plan 状态管理 — 跟踪 plan 模式的激活状态和计划文件路径
//
// 不用事件溯源 / wire Op —— HoloGram 没有那套架构。
// 简单状态 + 监听器，planFilePath 在 enter 时确定。

export interface PlanState {
  active: boolean;
  planFilePath: string | null;
}

export class PlanStateManager {
  private _state: PlanState = { active: false, planFilePath: null };
  private _listeners = new Set<(s: PlanState) => void>();

  get state(): PlanState {
    return this._state;
  }

  /** 进入 plan 模式。返回计划文件路径。 */
  enter(projectPath: string): string {
    const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const base = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
    this._state = { active: true, planFilePath: `${base}/.hologram/plans/${id}.md` };
    this._notify();
    return this._state.planFilePath!;
  }

  /** 退出 plan 模式。 */
  exit(): void {
    this._state = { active: false, planFilePath: null };
    this._notify();
  }

  /** 检查路径是否为当前计划文件（用于 plan 模式下的写入放行）。 */
  isPlanFile(filePath: string): boolean {
    if (!this._state.planFilePath) return false;
    return filePath.replace(/\\/g, '/') === this._state.planFilePath.replace(/\\/g, '/');
  }

  /** 注册状态变更监听器，返回取消函数。 */
  onChange(fn: (s: PlanState) => void): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  private _notify(): void {
    for (const fn of this._listeners) fn(this._state);
  }
}
