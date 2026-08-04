// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Plan 模式去重上下文注入
//
// 首次进入 → 全量提醒
// 2 轮后 → 稀疏提醒
// 5 轮后 → 刷新全量
// 退出后 → 一次性退出提醒
// 用户输入后的下一轮 → 刷新全量

import type { PlanState } from './plan-state';
import { PLAN_EXIT_REMINDER, PLAN_FULL_REMINDER, PLAN_REENTRY_REMINDER, PLAN_SPARSE_REMINDER } from './plan-prompts';

const DEDUP_MIN_TURNS = 2;
const FULL_REFRESH_TURNS = 5;

export class PlanModeInjector {
  private _wasActive = false;
  private _lastInjectTurn = -1;

  /** 在 runLoop 每轮开始时调用，返回要注入的提醒文本（或 null = 跳过）。 */
  getReminder(turn: number, planState: PlanState, planContent: string): string | null {
    if (!planState.active) {
      // plan 刚退出 → 注入一次性退出提醒
      if (this._wasActive) {
        this._wasActive = false;
        return PLAN_EXIT_REMINDER;
      }
      return null;
    }

    // plan 刚激活
    if (!this._wasActive) {
      this._wasActive = true;
      this._lastInjectTurn = turn;
      // 计划已有内容（恢复场景）
      if (planContent.trim()) return PLAN_REENTRY_REMINDER(planState.planFilePath);
      return PLAN_FULL_REMINDER(planState.planFilePath);
    }

    // 已激活，按轮次去重
    const turnsSince = turn - this._lastInjectTurn;
    if (turnsSince < DEDUP_MIN_TURNS) return null; // 跳过
    if (turnsSince >= FULL_REFRESH_TURNS) {
      this._lastInjectTurn = turn;
      return PLAN_FULL_REMINDER(planState.planFilePath);
    }
    this._lastInjectTurn = turn;
    return PLAN_SPARSE_REMINDER(planState.planFilePath);
  }

  /** 用户发新消息时重置计数（下一轮注入全量提醒）。 */
  resetOnUserInput(): void {
    this._lastInjectTurn = -1; // 下次 getReminder 会走「已激活但 turnsSince 很大」→ full
  }
}
