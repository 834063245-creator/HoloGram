// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 动态插件宿主半沙箱（平台化 Phase 4 · D7，2026-08-27）——运行时定义的
// cordis 插件包在受控环境中求值与激活（对齐 DSH cordis-host-runner 的角色，
// 对齐 code-run 协议的敌意校验纪律）。
//
// 沙箱定位（R4 如实声明）：浏览器主文档没有进程级硬边界——安全面 =
// 本文件的实现质量，三层防线：
//   1. **求值面阴影**：插件工厂以 new Function 编译，危险全局（DOM/网络/
//      存储/worker/动态求值）全部以形参阴影为 undefined——插件拿不到
//      window/fetch/eval/Function 等逃逸面；能力经唯一形参 `lantai` 注入。
//   2. **注册面守卫**：apply 收到的 ctx 是守卫代理——只暴露 effect 与各
//      service 的 register（注册动作逐个校验形状 + 预算计数 + 取消后拒绝），
//      任何其他属性访问 / 赋值响亮报错（错误不静默宪法）。
//   3. **预算**：源码字节上限 / apply 时限 / 贡献条数上限；超限即取消，
//      fiber dispose 链式回收已注册贡献。
// 敌意校验测试（伪造形状/超预算/畸形源码/阴影逃逸）钉死本文件承诺。

import type { Context } from '../../cordis';

/** 源码字节上限（对齐 IPC 护栏量级——插件是「小包」）。 */
export const DYNAMIC_SOURCE_MAX_BYTES = 256 * 1024;
/** apply 时限（注册型 apply 的合理上界——不是服务进程预算）。 */
export const DYNAMIC_APPLY_TIMEOUT_MS = 10_000;
/** 单插件贡献条数上限。 */
export const DYNAMIC_MAX_CONTRIBUTIONS = 64;

/** 沙箱违约（形状/预算/守卫）——统一错误前缀，供 cordis 工具面辨识。 */
export class DynamicSandboxError extends Error {
  constructor(message: string) {
    super('[dynamic-runner] ' + message);
    this.name = 'DynamicSandboxError';
  }
}

/** 求值面阴影清单：动态插件源码内这些标识符恒为 undefined。 */
const SHADOWED_GLOBALS: readonly string[] = [
  // Web 主文档面
  'window',
  'document',
  'globalThis',
  'self',
  'parent',
  'top',
  'frames',
  'navigator',
  'location',
  // 网络与进程外通道
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'importScripts',
  // 存储
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  // 动态求值逃逸
  'eval',
  'Function',
  // 环境幻觉（webview 无 Node——阴影掉防止误用）
  'require',
  'process',
  'Buffer',
];

/** 守卫注册面预算（宿主持有，取消后所有 register 拒绝）。 */
export interface GuardBudget {
  count: number;
  cancelled: boolean;
}

/** 求值产物（形状校验后的插件对象）。 */
export interface CompiledDynamicPlugin {
  name: string;
  apply: (ctx: unknown) => void | Promise<void>;
}

function fail(message: string): never {
  throw new DynamicSandboxError(message);
}

/** 语法预检（define 阶段——不执行工厂，只编译）。SyntaxError → 显式拒绝。 */
export function checkDynamicSyntax(source: string): void {
  if (typeof source !== 'string' || source.trim() === '') fail('source 必须是非空字符串');
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > DYNAMIC_SOURCE_MAX_BYTES) {
    fail(`source 超预算（${bytes} > ${DYNAMIC_SOURCE_MAX_BYTES} 字节）`);
  }
  try {
    // 仅编译不调用：SyntaxError 在此抛出（阴影面与求值面同一形参表）。
    // new Function 是 D7 的产品功能本体——阴影形参表即沙箱边界，见文件头三层防线。
    new Function(...SHADOWED_GLOBALS, '__lantaiHost', source);
  } catch (e) {
    fail(`source 语法错误: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 求值：编译插件工厂 → 调用（阴影面 + 宿主桥）→ 形状校验。
 *  工厂执行（顶层代码）的异常在此显式抛出——不留半初始化插件。 */
export function evaluateDynamicPlugin(source: string, fallbackName: string): CompiledDynamicPlugin {
  checkDynamicSyntax(source);
  let factory: (...args: unknown[]) => unknown;
  try {
    // new Function 是 D7 的产品功能本体——阴影形参表即沙箱边界（同上）。
    factory = new Function(...SHADOWED_GLOBALS, '__lantaiHost', source) as (...args: unknown[]) => unknown;
  } catch (e) {
    fail(`source 编译失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  let result: unknown;
  try {
    // 阴影实参全 undefined（顺序与形参表一致）+ 宿主桥占位（预留能力注入）
    const shadowArgs = SHADOWED_GLOBALS.map(() => undefined);
    result = factory(...shadowArgs, Object.freeze({ sandbox: 'lantai-dynamic-runner/v1' }));
  } catch (e) {
    fail(`插件工厂执行失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (result == null || typeof result !== 'object') {
    fail('插件工厂必须返回对象（{ name?, apply }）');
  }
  const record = result as Record<string, unknown>;
  if (typeof record.apply !== 'function') {
    fail('插件对象缺 apply 函数');
  }
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : fallbackName;
  return { name, apply: record.apply as (ctx: unknown) => void | Promise<void> };
}

// ── 注册面校验（按 service 的承重字段——错误在装载期暴露，不潜伏到调用期）──

/** 各注册面的函数成员要求（presence 校验；缺即拒绝）。
 *  键集同时是：守卫白名单 + 可解析服务清单（服务经 reflect.get 免 inject
 *  通道解析——runner 不声明 inject（依赖集编译期不可知））。 */
export const GUARDED_SERVICES: readonly string[] = [
  // 贡献通道（与 composition/contribution-channel.ts 的通道同集——2026-10-13 补
  // steps，agent-hooks-plan 一期步前裁决面 + 二期扩展为步骤钩子家族）
  'tools',
  'panels',
  'commands',
  'llm',
  'prompts',
  'hooks',
  'steps',
  'capabilities',
  'renderers',
  'overlays',
  // 五条可换后端 seam（同一内核，消费语义是「替换默认 provider」）
  'fs',
  'shell',
  'sessionPersistence',
  'subagents',
  'agentLoop',
];

/** 自持登记：上面那张表的键集**就是**白名单（gate 读本表，错误文案读 GUARDED_SERVICES）
 *  ——两处必须同集，由 tests/dynamic-runner.test.ts 的「注册面 ↔ 真装配」用例对拍。
 *
 *  2026-09-14 校准（此前漂移已久，技能文档 `lantai-plugin-dev` 曾照抄错误清单）：
 *    - **删 `graph`**：图谱能力 2026-09-09 全量退役，该条目恒解析失败，是死条目；
 *    - **补 `overlays`**：画布覆盖层（`{ id, slot, component }`——与 panels 同形）；
 *    - **补 `agentLoop`**：流式循环 seam（`{ id, run }`）；
 *    - **补 `hooks`**：工具管道钩子——承重成员是**嵌套形状**（`{ id, kind, hook }`，
 *      函数成员在 `hook` 里面），presence 表表达不了，由下方 SHAPE_CHECKS 承担；
 *    - **补 `steps`**（2026-10-13）：步骤钩子（pre-step / turn-stopping）——同样是
 *      嵌套形状（`{ id, on, hook }`，函数成员在 `hook` 里面），SHAPE_CHECKS 承担。 */
const REQUIRED_FN_MEMBERS: Record<string, readonly string[]> = {
  tools: ['factory'],
  panels: ['component'],
  commands: [],
  llm: ['create'],
  prompts: ['render'],
  hooks: [], // 嵌套形状——见 SHAPE_CHECKS
  steps: [], // 嵌套形状——见 SHAPE_CHECKS
  capabilities: ['install'],
  renderers: ['component'],
  overlays: ['component'],
  fs: ['execute'],
  shell: ['execute'],
  sessionPersistence: ['execute'],
  subagents: ['spawn'],
  agentLoop: ['run'],
};

/** 逐面附加形状校验（函数成员之外的承重形状——返回错误串，null = 通过）。 */
const SHAPE_CHECKS: Record<string, (def: Record<string, unknown>) => string | null> = {
  // HookContribution = { id, kind: 'enrich' | 'preflight', hook }——hook 是对象，
  // 其函数成员随 kind 而变（enrich 族：shouldEnrich + enrich；preflight 族：
  // shouldCheck + check）。畸形形状在装载期拒绝，不潜伏到工具调用期（那时
  // 才 TypeError 就晚了：hook 在结果路径上跑）。
  hooks: (def) => {
    const kind = def.kind;
    if (kind !== 'enrich' && kind !== 'preflight') return 'kind 必须是 "enrich" | "preflight"';
    const hook = def.hook as Record<string, unknown> | undefined;
    if (hook == null || typeof hook !== 'object') return 'hook 必须是对象（Hook 或 PreflightHook）';
    if (typeof hook.name !== 'string' || hook.name.trim() === '') return 'hook.name 必须是非空 string';
    const members = kind === 'enrich' ? ['shouldEnrich', 'enrich'] : ['shouldCheck', 'check'];
    for (const m of members) {
      if (typeof hook[m] !== 'function') return `hook 缺 ${m} 函数成员`;
    }
    return null;
  },
  // StepHookContribution = { id, on, hook, create? }——on 分派两个事件、hook 是对象
  // （name + decide 函数；shouldRun/shouldAsk 可选）、create 可选函数。
  // 畸形形状在装载期拒绝，不潜伏到每步裁决期。
  steps: (def) => {
    const on = def.on;
    if (on !== 'pre-step' && on !== 'turn-stopping') return 'on 必须是 "pre-step" | "turn-stopping"';
    const hook = def.hook as Record<string, unknown> | undefined;
    if (hook == null || typeof hook !== 'object') return 'hook 必须是对象（PreStepHook / TurnStoppingHook）';
    if (typeof hook.name !== 'string' || hook.name.trim() === '') return 'hook.name 必须是非空 string';
    if (typeof hook.decide !== 'function') return 'hook 缺 decide 函数';
    if (def.create !== undefined && typeof def.create !== 'function') return 'create 必须是函数';
    return null;
  },
};

/** 守卫 ctx：动态插件 apply 收到的唯一宿主面。 */
export type DynamicGuardedCtx = Record<string, { register: (def: unknown) => () => void }> & {
  effect: (fn: () => () => void, label: string) => () => void;
};

/** 构造守卫 ctx（宿主半执行器的注册边界）。
 *  - **realCtx**：插件自身 fiber（effect 登记面——fiber dispose 链式回收）；
 *  - **resolverCtx**：runner 服务 ctx（服务解析面——插件 fiber 不声明
 *    inject（依赖集编译期不可知），服务访问经 runner 代解析；未挂载的
 *    service 访问在此响亮报错）；
 *  - **bag**：本次激活的服务贡献 disposer 袋（runner 在 stop/失败/超时/
 *    undefine 时逆序 dispose——服务注册不挂插件 fiber，生命周期归 runner）；
 *  - 白名单外属性访问 / 任何赋值 → 响亮拒绝；
 *  - register 前逐个校验（对象形状 / id·key / 函数成员 / 贡献预算 / 取消态）。 */
export function makeGuardedCtx(
  realCtx: Context,
  resolverCtx: Context,
  bag: Array<() => void>,
  budget: GuardBudget,
): DynamicGuardedCtx {
  const assertOpen = (): void => {
    if (budget.cancelled) fail('插件已停用/超时——注册被拒绝（贡献面已回收）');
  };
  const validateDef = (svcName: string, def: unknown): void => {
    if (def == null || typeof def !== 'object') fail(`${svcName}.register(def) 的 def 必须是对象`);
    const record = def as Record<string, unknown>;
    // 行身份统一为 `id`（2026-09-14 M1 收口：九条通道一律 id，capability 的历史
    // 字段名 `key` 已退役不留别名）。本处曾按服务特判 needId='key'——那是改名
    // 漏掉的连带面：外部/dynamic 插件给正确的 `id` 会被这里拒掉，给旧 `key`
    // 又会随后被通道的 assertContributionShape 拒掉，即动态注册 capability
    // 整条路恒失败。现统一 id。
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      fail(`${svcName}.register 的 def 缺合法 id`);
    }
    for (const member of REQUIRED_FN_MEMBERS[svcName] ?? []) {
      if (typeof record[member] !== 'function') {
        fail(`${svcName}.register 的 def 缺 ${member} 函数成员`);
      }
    }
    const shapeError = SHAPE_CHECKS[svcName]?.(record);
    if (shapeError != null) {
      fail(`${svcName}.register 的 def 形状非法：${shapeError}`);
    }
  };
  const guarded = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') fail('非法属性访问');
        if (prop === 'effect') {
          return (fn: unknown, label: unknown): (() => void) => {
            assertOpen();
            if (typeof fn !== 'function' || typeof label !== 'string' || label.trim() === '') {
              fail('effect(fn, label) 形状非法——fn 与非空 label 必填');
            }
            return realCtx.effect(fn as () => () => void, `dynamic:${label}`);
          };
        }
        if (!(prop in REQUIRED_FN_MEMBERS)) {
          fail(`非法访问 ctx.${prop}——动态插件只能使用注册面（effect + ${GUARDED_SERVICES.join('/')}）`);
        }
        // 服务解析走 reflect.get（内核免 inject 读取通道——vendored cordis
        // 为框架内部代解析设计的面）。不能用 resolverCtx[prop]：生产消费单点
        // activeDynamicRunner() 是裸服务实例，其 this.ctx = runner 自身
        // fiber 的 ctx（fiber.runtime 非空）——有 runtime 的 ctx 上属性访问
        // 被内核 inject 拦截沿 fiber 链找 impl，而 runner 不声明 inject
        // （依赖集编译期不可知）、组合层服务的 impl 又在兄弟 fiber 上，
        // 恒抛 "without inject"（platform-bugs 2026-09-07）。reflect.get 直读
        // 根 store，两种宿主形态（无 runtime 的 root / 有 runtime 的 runner
        // fiber）恒同路解析；strict 默认语义（提供方 fiber 非 ACTIVE 不解析）
        // 正确拒递半拆服务。
        let svc: { register: (def: unknown) => () => void } | undefined;
        try {
          svc = resolverCtx.reflect.get(prop) as { register: (def: unknown) => () => void } | undefined;
        } catch (e) {
          fail(`ctx.${prop} 服务不可解析（未挂载或被裁剪）: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (svc == null || typeof svc.register !== 'function') {
          fail(`ctx.${prop} 服务未装配——无法注册贡献`);
        }
        const service = svc; // 闭包捕获窄化后的服务引用（let 窄化不进闭包）
        return {
          register: (def: unknown): (() => void) => {
            assertOpen();
            validateDef(prop, def);
            budget.count += 1;
            if (budget.count > DYNAMIC_MAX_CONTRIBUTIONS) {
              fail(`贡献条数超预算（>${DYNAMIC_MAX_CONTRIBUTIONS}）`);
            }
            const dispose = service.register(def);
            bag.push(dispose); // 生命周期归 runner（stop/失败/undefine 逆序回收）
            return dispose;
          },
        };
      },
      set() {
        fail('动态插件不得写 ctx');
      },
    },
  );
  return guarded as DynamicGuardedCtx;
}

/** 受时限的 apply 执行。超限 → onTimeout（宿主取消预算 + dispose fiber）
 *  → DynamicSandboxError。apply 的注册型契约 = 预算内落定。 */
export async function runDynamicApply(
  apply: (ctx: unknown) => void | Promise<void>,
  guarded: DynamicGuardedCtx,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new DynamicSandboxError(`apply 超预算（>${timeoutMs}ms）——fiber 已回收`));
    }, timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve(apply(guarded)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
