// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层 service —— 步骤钩子贡献注册表（agent-hooks-plan：一期步前裁决面，
// 二期扩展为步骤钩子家族 / `ctx.steps`）。
//
// 贡献形状 = `agent/steps.ts` 的 PreStepHook / TurnStoppingHook union（内核机制件
// ——插件贡献与 capability 注册的是同一接口）：
//   - on: 'pre-step'：每步进入前裁决（enter + 注入 / reject）；
//   - on: 'turn-stopping'：自然停止边界裁决（stop / continue + 注入）；
//   - create 工厂（可选，给定时优先）：装配折叠时为**每个 Agent 调一次**——
//     需要 per-Agent 状态的钩子有正确归属（补齐一期「贡献实例跨装配复用、
//     插件自担状态性」的缺口；未给定时贡献实例跨装配复用）。
//
// 契约对齐 hooks 通道（hook-service.ts）——注册表内核同走 ContributionChannel：
//   - register(def) → Disposer：调用方挂 ctx.effect（所有权登记是调用方纪律）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖）；
//   - disposer 幂等 + 陈旧性守卫；
//   - validate：装载期形状守卫（外部插件是纯 JS 无 tsc——同 capabilities 通道先例）；
//   - 生效时机 = 下次 Agent 装配（next-assembly）——runtime._assembleAgent 折叠进
//     per-Agent 的 StepsRegistry，在途会话保持创建时点的裁决面不变（KV-cache 纪律）；
//   - 子 Agent 不自动继承（spawnSubAgent 不接本面 ⇒ host.steps = null 直通）。
//
// 组合解析域：钩子贡献**不进** roster 寻址域（同 hooks 通道——卸载/禁用整个
// 插件走插件开关；裁决粒度裁剪无既定需求，不做预防性扩展）。

import type { PreStepHook, TurnStoppingHook } from '../agent/steps';
import { type Context, Service } from '../cordis';
import { ContributionChannel } from './contribution-channel';

/** create 工厂的作用域信息（装配折叠时给——per-Agent 实例的归属标识）。 */
export interface StepHookScope {
  agentId: string;
}

/** 步骤钩子贡献。id 约定 '<插件名>/<钩子名>'（npm scope 风格——跨插件防撞名）。 */
export type StepHookContribution =
  | { id: string; on: 'pre-step'; hook: PreStepHook; create?: (scope: StepHookScope) => PreStepHook }
  | { id: string; on: 'turn-stopping'; hook: TurnStoppingHook; create?: (scope: StepHookScope) => TurnStoppingHook };

/** 运行时形状守卫（装载期拒绝畸形贡献，不潜伏到每步裁决期）。
 *  外部插件是纯 JS——装载期形状可能偏离静态类型，故逐项宽读校验。 */
function assertContributionShape(def: StepHookContribution): void {
  const raw = def as { id?: unknown; on?: unknown; hook?: unknown; create?: unknown };
  if (typeof raw.id !== 'string' || raw.id === '') {
    throw new Error('[steps] 贡献 id 必须是非空 string');
  }
  if (raw.on !== 'pre-step' && raw.on !== 'turn-stopping') {
    throw new Error(`[steps] 贡献 "${raw.id}" 的 on 必须是 'pre-step' | 'turn-stopping'`);
  }
  const hook = raw.hook as PreStepHook | TurnStoppingHook | undefined;
  if (hook == null || typeof hook !== 'object') {
    throw new Error(`[steps] 贡献 "${raw.id}" 的 hook 必须是对象（PreStepHook / TurnStoppingHook）`);
  }
  if (typeof hook.name !== 'string' || hook.name.trim() === '') {
    throw new Error(`[steps] 贡献 "${raw.id}" 的 hook.name 必须是非空 string`);
  }
  if (typeof hook.decide !== 'function') {
    throw new Error(`[steps] 贡献 "${raw.id}" 的 hook 缺 decide 函数`);
  }
  if (raw.create !== undefined && typeof raw.create !== 'function') {
    throw new Error(`[steps] 贡献 "${raw.id}" 的 create 必须是函数`);
  }
}

// ── service 本体 ──

export class StepsService extends Service {
  private registry = new ContributionChannel<StepHookContribution>('steps', {
    timing: 'next-assembly',
    validate: assertContributionShape,
  });

  constructor(ctx: Context) {
    super(ctx, 'steps');
    _activeSteps = this; // 消费闭环读取面（runtime 装配折叠）
  }

  register(def: StepHookContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): StepHookContribution | undefined {
    return this.registry.get(id);
  }

  list(): StepHookContribution[] {
    return this.registry.list();
  }
}

// ── 消费闭环读取面（模块级活动服务——services.ts 同款第 3 类可变态：
//    单一键，生命周期 = 进程，服务构造期登记）──

let _activeSteps: StepsService | null = null;

/** 当前步骤钩子贡献（无服务/无注册 = 空集——runtime 装配折叠读这个）。 */
export function activeStepHookContributions(): StepHookContribution[] {
  return _activeSteps?.list() ?? [];
}

// ── 组合层挂载插件（根 Context 装载；经 loadBuiltinPlugins 引导）──

declare module '../cordis/context' {
  interface Context {
    /** 步骤钩子注册表（agent-hooks-plan）——钩子贡献注册 → disposer；
     *  下次 Agent 装配生效语义。 */
    steps: StepsService;
  }
}

/** 内核线实体化：步骤钩子贡献注册表常驻根上下文，先于外部插件装载。 */
export const stepsServicePlugin = {
  name: 'hologram/steps-service',
  apply(ctx: Context) {
    const svc = new StepsService(ctx);
    // 服务随根 fiber 常驻（app 生命周期）。dispose 路径（测试拆卸）守卫式
    // 清空活动指针：读取面必须随服务生命周期归零——不残留陈旧注册污染
    // 后续装配（vitest 同 worker 模块态跨测试共享，残留即静默串味）。
    ctx.effect(
      () => () => {
        if (_activeSteps === svc) _activeSteps = null;
      },
      'steps-active-clear',
    );
  },
};
