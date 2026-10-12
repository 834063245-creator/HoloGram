// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层 service —— 步前裁决贡献注册表（agent-hooks-plan 一期，
// 对标 DSH 的 interception extension points / `agent/pre-step`）。
//
// 贡献形状 = `agent/pre-step.ts` 的 PreStepHook（内核机制件——插件贡献与
// capability 注册的是同一接口）：
//   - enter：放行本步，可附注入批（落会话 user/message——「每步注入一段文字」
//     的正式入口）；
//   - reject：拦下本步（不开步、不发请求；reason 只给 UI 可见）。
//
// 契约对齐 hooks 通道（hook-service.ts）——注册表内核同走 ContributionChannel：
//   - register(def) → Disposer：调用方挂 ctx.effect（所有权登记是调用方纪律）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖）；
//   - disposer 幂等 + 陈旧性守卫；
//   - validate：装载期形状守卫（外部插件是纯 JS 无 tsc——同 capabilities 通道先例）；
//   - 生效时机 = 下次 Agent 装配（next-assembly）——runtime._assembleAgent 折叠进
//     per-Agent 的 PreStepRegistry，在途会话保持创建时点的裁决面不变（KV-cache 纪律）；
//   - 子 Agent 不自动继承（spawnSubAgent 不接 pre-step 面 ⇒ host.preStep = null 直通）。
//
// 组合解析域：钩子贡献**不进** roster 寻址域（同 hooks 通道——卸载/禁用整个
// 插件走插件开关；裁决粒度裁剪无既定需求，不做预防性扩展）。

import type { PreStepHook } from '../agent/pre-step';
import { type Context, Service } from '../cordis';
import { ContributionChannel } from './contribution-channel';

/** 步前裁决贡献。id 约定 '<插件名>/<钩子名>'（npm scope 风格——跨插件防撞名）。 */
export interface PreStepContribution {
  id: string;
  hook: PreStepHook;
}

/** 运行时形状守卫（装载期拒绝畸形贡献，不潜伏到每步裁决期）。 */
function assertContributionShape(def: PreStepContribution): void {
  if (typeof def.id !== 'string' || def.id === '') {
    throw new Error('[preStep] 贡献 id 必须是非空 string');
  }
  const hook = def.hook as PreStepHook | undefined;
  if (hook == null || typeof hook !== 'object') {
    throw new Error(`[preStep] 贡献 "${def.id}" 的 hook 必须是对象（PreStepHook）`);
  }
  if (typeof hook.name !== 'string' || hook.name.trim() === '') {
    throw new Error(`[preStep] 贡献 "${def.id}" 的 hook.name 必须是非空 string`);
  }
  if (typeof hook.decide !== 'function') {
    throw new Error(`[preStep] 贡献 "${def.id}" 的 hook 缺 decide 函数`);
  }
}

// ── service 本体 ──

export class PreStepService extends Service {
  private registry = new ContributionChannel<PreStepContribution>('preStep', {
    timing: 'next-assembly',
    validate: assertContributionShape,
  });

  constructor(ctx: Context) {
    super(ctx, 'preStep');
    _activePreStep = this; // 消费闭环读取面（runtime 装配折叠）
  }

  register(def: PreStepContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): PreStepContribution | undefined {
    return this.registry.get(id);
  }

  list(): PreStepContribution[] {
    return this.registry.list();
  }
}

// ── 消费闭环读取面（模块级活动服务——services.ts 同款第 3 类可变态：
//    单一键，生命周期 = 进程，服务构造期登记）──

let _activePreStep: PreStepService | null = null;

/** 当前步前裁决贡献（无服务/无注册 = 空集——runtime 装配折叠读这个）。 */
export function activePreStepContributions(): PreStepContribution[] {
  return _activePreStep?.list() ?? [];
}

// ── 组合层挂载插件（根 Context 装载；经 loadBuiltinPlugins 引导）──

declare module '../cordis/context' {
  interface Context {
    /** 步前裁决注册表（agent-hooks-plan 一期）——hook 贡献注册 → disposer；
     *  下次 Agent 装配生效语义。 */
    preStep: PreStepService;
  }
}

/** 内核线实体化：步前裁决贡献注册表常驻根上下文，先于外部插件装载。 */
export const preStepServicePlugin = {
  name: 'hologram/pre-step-service',
  apply(ctx: Context) {
    const svc = new PreStepService(ctx);
    // 服务随根 fiber 常驻（app 生命周期）。dispose 路径（测试拆卸）守卫式
    // 清空活动指针：读取面必须随服务生命周期归零——不残留陈旧注册污染
    // 后续装配（vitest 同 worker 模块态跨测试共享，残留即静默串味）。
    ctx.effect(
      () => () => {
        if (_activePreStep === svc) _activePreStep = null;
      },
      'pre-step-active-clear',
    );
  },
};
