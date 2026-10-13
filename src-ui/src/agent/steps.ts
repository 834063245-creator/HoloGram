// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 步骤钩子家族（agent-hooks-plan：一期「步前裁决」竣工 2026-10-13 · 二期面扩展）——
// Agent 循环边界上的可裁决 / 可注入扩展点，两个事件：
//   - 'pre-step'：每步进入前（裁决 enter/reject + 注入）；
//   - 'turn-stopping'：自然停止边界（裁决 stop/continue + 注入）。
//
// 语义对标 DSH 的 interception extension points（参照 d:\useful\deepseek-harness
// 的 packages/hooks/ 与 2026-06-30-interception-extension-points）：
// 每步进入前 / 自然停止前，注册的钩子按注册序收到裁决请求——
//   - pre-step：enter（放行本步，可附注入）/ reject（拦下本步：不开步、不发请求，
//     本轮收尾；reason 只给 UI 可见）；
//   - turn-stopping：stop（结束本轮，缺省）/ continue（再开下一步，可附注入；
//     消费侧有 MAX_TURN_CONTINUES 护栏防「无条件继续」死循环）。
//
// 注入两类形态（durable / transient 分工与全平台一致）：
//   - messages：落会话的 user/message（durable——「每步注入一段文字」的正式入口）；
//   - reminders：content 原样进 transientReminders（只给本次请求、不落会话）。
//
// 合并语义（对齐 hook-protocol 的 most-restrictive fold，不做 DSH 的 next 链）：
//   - 全跑：每个 shouldRun/shouldAsk 通过的钩子都收到调用（审计友好——任一钩子都能观察本轮）；
//   - 折叠方向各按默认值对称：pre-step 任一 reject ⇒ 整体 reject（默认进、有人拦则停）；
//     turn-stopping 任一 continue ⇒ 整体 continue（默认停、有人推则走）；
//   - 注入累积（向同向折叠时按注册序拼接）；reason 取第一个非空。
//
// 消费方唯一 = default-loop（经 AgentLoopHost.steps 直读，不走 eventBus：
// 装配期需要独立注册面对象——capability 在 Agent 构造前注册、bus 在构造内才创建；
// 先例 = planInjector 直读面）。**未接面（null）/ 该事件零注册者 = 同步短路**：
// 不进入调用，连同步时序都零变化（tests/steps.test.ts 的回归门）。
//
// 纪律：
//   - **同步时序守恒**：全同步钩子的折叠**同步返回**（`decidePreStep` /
//     `decideTurnStopping` 返回 `T | Promise<T>`——无 promise 时不产生微任务边界）。
//     内建发现钩子（同步 decide）依赖此性质：loop 的步前前缀保持「同步通到底」
//     （landmine-l3-hang ⑤ 守护）。含异步钩子时转入异步**串行**续（前一个 settle
//     后才调用下一个——串行语义不因快路径改变）；
//   - 钩子崩溃 / 畸形返回值 → catch + console.error + 视作未投（不阻断、不否决）——
//     对齐 HookRegistry「崩溃静默降级，绝不影响结果」的既有语义；
//   - 子 Agent 不继承（spawnSubAgent 不接本面 ⇒ host.steps = null）。

import type { Disposer } from './lifecycle';

/** 步骤钩子事件名（闭集——新增事件必须同时落注册表与消费点，两处一起改）。 */
export type StepEventName = 'pre-step' | 'turn-stopping';

/** pre-step 裁决请求载荷（最小可用集；扩展是纯增字段）。 */
export interface PreStepPayload {
  agentId: string;
  /** 0 起步的步号（与 step/start 载荷同口径）。 */
  step: number;
  signal: AbortSignal;
}

/** turn-stopping 裁决请求载荷（与 pre-step 同形——语义分属两个事件）。 */
export interface TurnStoppingPayload {
  agentId: string;
  step: number;
  signal: AbortSignal;
}

/** 注入批的单条消息（durable——作为 user/message 落会话）。 */
export interface PreStepMessage {
  content: string;
}

/** 临时提醒（transient——content 原样进 transientReminders，只给本次请求、不落会话）。 */
export interface PreStepReminder {
  content: string;
}

/** pre-step 裁决结果：放行（可附注入批）或拦下（reason 只给 UI）。 */
export type PreStepDecision =
  | { action: 'enter'; messages?: PreStepMessage[]; reminders?: PreStepReminder[] }
  | { action: 'reject'; reason?: string };

/** turn-stopping 裁决结果：停 或 继续（可附注入批）。 */
export type TurnStopDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: string; messages?: PreStepMessage[]; reminders?: PreStepReminder[] };

/** 步前裁决钩子（形状与 Hook/PreflightHook 同族：name + 主函数）。 */
export interface PreStepHook {
  name: string;
  /** 缺省恒跑；返回 false 跳过本钩子。 */
  shouldRun?(payload: PreStepPayload): boolean;
  decide(payload: PreStepPayload): PreStepDecision | Promise<PreStepDecision>;
}

/** 停止边界裁决钩子（默认停——任一 continue 才继续）。 */
export interface TurnStoppingHook {
  name: string;
  /** 缺省恒跑；返回 false 跳过本钩子。 */
  shouldAsk?(payload: TurnStoppingPayload): boolean;
  decide(payload: TurnStoppingPayload): TurnStopDecision | Promise<TurnStopDecision>;
}

/** 注册表内部的行类型（每条通道按事件分派）。 */
type StepHook = PreStepHook | TurnStoppingHook;

/** pre-step 折叠的状态累加器（同步/异步两段共用——折叠语义单份）。 */
interface PreStepFoldState {
  messages: PreStepMessage[];
  reminders: PreStepReminder[];
  rejected: boolean;
  rejectReason?: string;
}

/** turn-stopping 折叠的状态累加器（同上）。 */
interface TurnStopFoldState {
  messages: PreStepMessage[];
  reminders: PreStepReminder[];
  continued: boolean;
  continueReason?: string;
}

export class StepsRegistry {
  private hooks: Record<StepEventName, StepHook[]> = { 'pre-step': [], 'turn-stopping': [] };

  /** 该事件有没有注册者——消费点（default-loop）用它跳过空表的异步调用：
   *  零注册者时**连同步时序都零变化**（landmine-l3-hang 的「同步通到底」守护）。 */
  hasListeners(on: StepEventName): boolean {
    return this.hooks[on].length > 0;
  }

  /** 注册钩子并返回所有权清理器（Disposer 契约：幂等）。 */
  register(on: 'pre-step', hook: PreStepHook): Disposer;
  register(on: 'turn-stopping', hook: TurnStoppingHook): Disposer;
  register(on: StepEventName, hook: StepHook): Disposer {
    const list = this.hooks[on];
    list.push(hook);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = list.indexOf(hook);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** pre-step 裁决：跑本轮全部钩子并折叠（合并语义见文件头）。
   *  **同步时序守恒**：全同步钩子时同步返回（无微任务边界）；含异步钩子时
   *  返回 promise（异步串行续——前一个 settle 后才调用下一个）。 */
  decidePreStep(payload: PreStepPayload): PreStepDecision | Promise<PreStepDecision> {
    const state: PreStepFoldState = { messages: [], reminders: [], rejected: false };
    const hooks = [...this.hooks['pre-step']]; // 快照遍历：期间增删注册不改本轮名单
    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i] as PreStepHook;
      let value: PreStepDecision | Promise<PreStepDecision>;
      try {
        if (h.shouldRun && !h.shouldRun(payload)) continue;
        value = h.decide(payload);
      } catch (e) {
        console.error(`[StepsRegistry] pre-step hook "${h.name}" failed:`, e);
        continue;
      }
      if (value instanceof Promise) return this._decidePreStepAsync(payload, hooks, i, h.name, value, state);
      this._foldPreStepDecision(state, h.name, value);
    }
    return this._buildPreStepDecision(state);
  }

  /** pre-step 异步续：第 i 个钩子（首个异步）settle 后，其余钩子继续**串行**跑完。 */
  private async _decidePreStepAsync(
    payload: PreStepPayload,
    hooks: StepHook[],
    i: number,
    name: string,
    first: Promise<PreStepDecision>,
    state: PreStepFoldState,
  ): Promise<PreStepDecision> {
    try {
      this._foldPreStepDecision(state, name, await first);
    } catch (e) {
      console.error(`[StepsRegistry] pre-step hook "${name}" failed:`, e);
    }
    for (let j = i + 1; j < hooks.length; j++) {
      const h = hooks[j] as PreStepHook;
      let value: PreStepDecision | Promise<PreStepDecision>;
      try {
        if (h.shouldRun && !h.shouldRun(payload)) continue;
        value = h.decide(payload);
      } catch (e) {
        console.error(`[StepsRegistry] pre-step hook "${h.name}" failed:`, e);
        continue;
      }
      if (value instanceof Promise) {
        try {
          value = await value;
        } catch (e) {
          console.error(`[StepsRegistry] pre-step hook "${h.name}" failed:`, e);
          continue;
        }
      }
      this._foldPreStepDecision(state, h.name, value);
    }
    return this._buildPreStepDecision(state);
  }

  /** 单条 pre-step 决策折叠（同步/异步两段共用——折叠语义单份）。 */
  private _foldPreStepDecision(state: PreStepFoldState, name: string, decision: PreStepDecision): void {
    if (decision == null || (decision.action !== 'enter' && decision.action !== 'reject')) {
      console.error(`[StepsRegistry] pre-step hook "${name}" 返回畸形决策，视作未投:`, decision);
      return;
    }
    if (decision.action === 'reject') {
      // 全跑语义：不短路，后续钩子照常收到调用（注入批最终丢弃）。
      state.rejected = true;
      if (!state.rejectReason && decision.reason) state.rejectReason = decision.reason;
      return;
    }
    if (decision.messages && decision.messages.length > 0) state.messages.push(...decision.messages);
    if (decision.reminders && decision.reminders.length > 0) state.reminders.push(...decision.reminders);
  }

  private _buildPreStepDecision(state: PreStepFoldState): PreStepDecision {
    if (state.rejected) {
      return state.rejectReason ? { action: 'reject', reason: state.rejectReason } : { action: 'reject' };
    }
    // 形状精确：无注入时不带字段（零注册/未注入路径逐字节对拍——回归门）。
    const enter: { action: 'enter'; messages?: PreStepMessage[]; reminders?: PreStepReminder[] } = {
      action: 'enter',
    };
    if (state.messages.length > 0) enter.messages = state.messages;
    if (state.reminders.length > 0) enter.reminders = state.reminders;
    return enter;
  }

  /** turn-stopping 裁决：跑本轮全部钩子并折叠（默认停——任一 continue ⇒ 继续）。
   *  **同步时序守恒**同 decidePreStep（全同步钩子⇒同步返回；含异步⇒串行 promise）。 */
  decideTurnStopping(payload: TurnStoppingPayload): TurnStopDecision | Promise<TurnStopDecision> {
    const state: TurnStopFoldState = { messages: [], reminders: [], continued: false };
    const hooks = [...this.hooks['turn-stopping']];
    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i] as TurnStoppingHook;
      let value: TurnStopDecision | Promise<TurnStopDecision>;
      try {
        if (h.shouldAsk && !h.shouldAsk(payload)) continue;
        value = h.decide(payload);
      } catch (e) {
        console.error(`[StepsRegistry] turn-stopping hook "${h.name}" failed:`, e);
        continue;
      }
      if (value instanceof Promise) return this._decideTurnStoppingAsync(payload, hooks, i, h.name, value, state);
      this._foldTurnStopDecision(state, h.name, value);
    }
    return this._buildTurnStopDecision(state);
  }

  private async _decideTurnStoppingAsync(
    payload: TurnStoppingPayload,
    hooks: StepHook[],
    i: number,
    name: string,
    first: Promise<TurnStopDecision>,
    state: TurnStopFoldState,
  ): Promise<TurnStopDecision> {
    try {
      this._foldTurnStopDecision(state, name, await first);
    } catch (e) {
      console.error(`[StepsRegistry] turn-stopping hook "${name}" failed:`, e);
    }
    for (let j = i + 1; j < hooks.length; j++) {
      const h = hooks[j] as TurnStoppingHook;
      let value: TurnStopDecision | Promise<TurnStopDecision>;
      try {
        if (h.shouldAsk && !h.shouldAsk(payload)) continue;
        value = h.decide(payload);
      } catch (e) {
        console.error(`[StepsRegistry] turn-stopping hook "${h.name}" failed:`, e);
        continue;
      }
      if (value instanceof Promise) {
        try {
          value = await value;
        } catch (e) {
          console.error(`[StepsRegistry] turn-stopping hook "${h.name}" failed:`, e);
          continue;
        }
      }
      this._foldTurnStopDecision(state, h.name, value);
    }
    return this._buildTurnStopDecision(state);
  }

  /** 单条 turn-stopping 决策折叠（同步/异步两段共用）。 */
  private _foldTurnStopDecision(state: TurnStopFoldState, name: string, decision: TurnStopDecision): void {
    if (decision == null || (decision.action !== 'stop' && decision.action !== 'continue')) {
      console.error(`[StepsRegistry] turn-stopping hook "${name}" 返回畸形决策，视作未投:`, decision);
      return;
    }
    if (decision.action === 'continue') {
      // 全跑语义：不短路（对称 pre-step 的 reject 折叠——那里是最严胜，这里是最宽胜）。
      state.continued = true;
      if (!state.continueReason && decision.reason) state.continueReason = decision.reason;
      if (decision.messages && decision.messages.length > 0) state.messages.push(...decision.messages);
      if (decision.reminders && decision.reminders.length > 0) state.reminders.push(...decision.reminders);
    }
  }

  private _buildTurnStopDecision(state: TurnStopFoldState): TurnStopDecision {
    if (!state.continued) return { action: 'stop' };
    const out: { action: 'continue'; reason?: string; messages?: PreStepMessage[]; reminders?: PreStepReminder[] } = {
      action: 'continue',
    };
    if (state.continueReason) out.reason = state.continueReason;
    if (state.messages.length > 0) out.messages = state.messages;
    if (state.reminders.length > 0) out.reminders = state.reminders;
    return out;
  }
}
