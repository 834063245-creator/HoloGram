// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Plan 状态管理 — 跟踪 plan 模式的激活状态和计划文件路径
//
// 借鉴 kimi-code 的生命周期管理模式：
//   - 持久化 { active, id } 到 session（可恢复）
//   - planFilePath 从 id 派生，不持久化
//   - enter 时只确定 id 和路径，不创建文件（LLM 第一次 Write 时创建）
//   - exit/cancel 都把 active 设为 false，plan 文件保留（可回溯）
//
// 不用事件溯源 / wire Op —— HoloGram 没有那套架构。
// 简单状态 + 监听器 + save/restore 快照。

export interface PlanState {
  active: boolean;
  /** 计划 id — 从 enter 时生成，用于派生 planFilePath */
  id: string | null;
  /** 计划文件路径 — 从 id 派生，不持久化 */
  planFilePath: string | null;
}

/** 可序列化的快照 — 用于 session 持久化 */
export interface PlanStateSnapshot {
  active: boolean;
  id: string | null;
}

export class PlanStateManager {
  private _state: PlanState = { active: false, id: null, planFilePath: null };
  private _listeners = new Set<(s: PlanState) => void>();
  private _projectPath: string = '';

  get state(): PlanState {
    return this._state;
  }

  /** 进入 plan 模式。返回计划文件路径。 */
  enter(projectPath: string): string {
    this._projectPath = projectPath;
    const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const planFilePath = this._derivePlanPath(id, projectPath);
    this._state = { active: true, id, planFilePath };
    this._notify();
    return planFilePath;
  }

  /** 退出 plan 模式（审批通过）。plan 文件保留。 */
  exit(): void {
    this._state = { active: false, id: null, planFilePath: null };
    this._notify();
  }

  /** 取消 plan 模式（用户手动退出，非审批）。plan 文件保留。 */
  cancel(): void {
    this._state = { active: false, id: null, planFilePath: null };
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

  // ── 持久化 ──

  /** 导出可序列化快照 — 用于 session 保存 */
  toSnapshot(): PlanStateSnapshot {
    return { active: this._state.active, id: this._state.id };
  }

  /** 从快照恢复 — 用于 session 恢复。
   *  planFilePath 从 id 重新派生（不持久化路径，与 kimi-code 一致）。 */
  fromSnapshot(snapshot: PlanStateSnapshot | null, projectPath: string): void {
    this._projectPath = projectPath;
    if (snapshot && snapshot.active && snapshot.id) {
      this._state = {
        active: true,
        id: snapshot.id,
        planFilePath: this._derivePlanPath(snapshot.id, projectPath),
      };
    } else {
      this._state = { active: false, id: null, planFilePath: null };
    }
    this._notify();
  }

  // ── 内部 ──

  private _derivePlanPath(id: string, projectPath: string): string {
    const base = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
    return `${base}/.hologram/plans/${id}.md`;
  }

  private _notify(): void {
    for (const fn of this._listeners) fn(this._state);
  }
}
