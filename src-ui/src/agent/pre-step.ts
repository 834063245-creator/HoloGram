// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Pre-step 裁决面 —— Agent 每步进入前的可裁决 / 可注入扩展点（agent-hooks-plan 一期）。
//
// 语义对标 DSH 的 `agent/pre-step`（interception extension points，参照
// d:\useful\deepseek-harness 的 packages/hooks/ 与 2026-06-30-interception-extension-points）：
// 每步进入前，注册的钩子按注册序收到裁决请求，返回两类决策——
//   - enter：放行本步，可附「注入批」（落会话的 user/message，content 原样，
//     贡献者自备文本形态）；
//   - reject：拦下本步（不开步、不发请求，本轮收尾；reason 只给 UI 可见）。
//
// 合并语义（对齐 hook-protocol 的 most-restrictive fold，不做 DSH 的 next 链）：
//   - 全跑：每个 shouldRun 通过的钩子都收到调用（审计友好——任一钩子都能观察本轮）；
//   - 最严折叠：任一 reject ⇒ 整体 reject（reason 取第一个非空）；
//   - 注入累积：全部 enter 时注入批按注册序拼接。
//
// 消费方唯一 = default-loop（经 AgentLoopHost.preStep 直读，不走 eventBus：
// 装配期需要独立注册面对象——capability 在 Agent 构造前注册、bus 在构造内才创建；
// 先例 = planInjector 直读面）。无注册者 / 未接面（null）= 直通 enter——
// 逐字节零行为变化（tests/pre-step.test.ts 的回归门）。
//
// 纪律：
//   - 钩子崩溃 / 畸形返回值 → catch + console.error + 视作未投（不阻断、不否决）——
//     对齐 HookRegistry「崩溃静默降级，绝不影响结果」的既有语义；
//   - 子 Agent 不继承（spawnSubAgent 不接本面 ⇒ host.preStep = null）。

import type { Disposer } from './lifecycle';

/** 每步裁决请求载荷（最小可用集；扩展是纯增字段）。 */
export interface PreStepPayload {
  agentId: string;
  /** 0 起步的步号（与 step/start 载荷同口径）。 */
  step: number;
  signal: AbortSignal;
}

/** 注入批的单条消息。 */
export interface PreStepMessage {
  content: string;
}

/** 裁决结果：放行（可附注入批）或拦下（reason 只给 UI）。 */
export type PreStepDecision = { action: 'enter'; messages?: PreStepMessage[] } | { action: 'reject'; reason?: string };

/** 步前裁决钩子（形状与 Hook/PreflightHook 同族：name + 主函数）。 */
export interface PreStepHook {
  name: string;
  /** 缺省恒跑；返回 false 跳过本钩子。 */
  shouldRun?(payload: PreStepPayload): boolean;
  decide(payload: PreStepPayload): PreStepDecision | Promise<PreStepDecision>;
}

export class PreStepRegistry {
  private hooks: PreStepHook[] = [];

  /** 当前注册数——消费点（default-loop）用它跳过空表的异步调用：
   *  无注册者时**连同步时序都零变化**（landmine-l3-hang 的「同步通到底」守护）。 */
  get size(): number {
    return this.hooks.length;
  }

  /** 注册钩子并返回所有权清理器（Disposer 契约：幂等）。 */
  register(hook: PreStepHook): Disposer {
    this.hooks.push(hook);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** 跑本轮全部钩子并折叠决策（合并语义见文件头）。 */
  async decide(payload: PreStepPayload): Promise<PreStepDecision> {
    const messages: PreStepMessage[] = [];
    let rejected = false;
    let rejectReason: string | undefined;
    // 快照遍历：钩子在 decide 期间增删注册不改本轮名单（HookRegistry 同族纪律）。
    for (const hook of [...this.hooks]) {
      try {
        if (hook.shouldRun && !hook.shouldRun(payload)) continue;
        const decision = await hook.decide(payload);
        if (decision == null || (decision.action !== 'enter' && decision.action !== 'reject')) {
          console.error(`[PreStepRegistry] hook "${hook.name}" 返回畸形决策，视作未投:`, decision);
          continue;
        }
        if (decision.action === 'reject') {
          // 全跑语义：不短路，后续钩子照常收到调用（注入批最终丢弃）。
          rejected = true;
          if (!rejectReason && decision.reason) rejectReason = decision.reason;
          continue;
        }
        if (decision.messages && decision.messages.length > 0) messages.push(...decision.messages);
      } catch (e) {
        // 钩子崩溃静默降级（不阻断、不否决）
        console.error(`[PreStepRegistry] hook "${hook.name}" failed:`, e);
      }
    }
    if (rejected) return rejectReason ? { action: 'reject', reason: rejectReason } : { action: 'reject' };
    return messages.length > 0 ? { action: 'enter', messages } : { action: 'enter' };
  }
}
