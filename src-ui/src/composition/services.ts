// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 组合层 service（S1-1）——panels / commands / tools / llm 挂根 Context；
// S6 P3a（2026-09-15）增第五个：ctx.activation（插件激活账，见
// composition/activation-service.ts ——「登记 ≠ 激活」的装配期引用计数）。
//
// llm 通道（平台化 Phase 1 · D2 修订版，2026-08-27）：providers 键升格更名为
// llm——方言贡献道即 LLM adapter seam 本体（agent-platformization-plan §3 D2/D5 注记）。
//
// 宪法定位（composition-architecture README「内核线」第 3 条）：slot / 注册表本身是
// 特权代码，永不插件化——本文件在内核线内。四 service 只做注册与注销（行生命周期的
// 锚点），不做任何业务：面板渲染、命令分发、工具执行都仍在各自既有实现。
//
// 契约（S1 设计件 §3 S1-1 + 计划 README S1 节第 5 条）：
//   - register(def) → Disposer：调用方负责挂 ctx.effect（对齐 agent 工具面
//     ToolRegistry.register 与工作区资源两原语的裸 disposer 契约——vendored cordis
//     不提供运行时 caller-fiber 追踪，所有权登记是调用方纪律，见 AGENTS.md §6）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖——「错误不静默」宪法）；
//   - disposer 幂等且不误删后注册的同名行（与 ToolRegistry 相同的陈旧性守卫）；
//   - 工具/provider 贡献下次 Agent 装配生效；命令/面板即时生效（生效时机语义由
//     消费方实现，本文件不实现任何生效逻辑）。
//
// S1-1 是纯新增批：既有内置装配（PANEL_DEFS / buildToolRegistry）
// 不改读这里；S1-2/S1-3 起内置面才逐族迁行接管。四 service 经 compositionServicesPlugin
// 挂根 Context（loadBuiltinPlugins 引导，先于外部插件装载——inject 依赖可解析）。
// v42（2026-09-19 command-surface-rework）：命令通道成为**斜杠命令唯一真源**——
// 旧 ui/command-registry 单例（模块级裸表 + 就地 mutate handler）已删除；消费
// 合流点 = src/app/commands/command-catalog.ts（内建命令 + 本通道贡献 + 技能候选）。

import type { ComponentType } from 'react';
import type { Tool } from '../agent/tool';
import { type Context, Service } from '../cordis';
import type { Provider } from '../provider/types';
import { bumpCommands, bumpPanelDefs } from '../state/panel-defs-store';
import { ActivationService } from './activation-service';
import { ContributionChannel } from './contribution-channel';
import { type SeamDisabledMap, seamDisabled } from './seam-resolution';
import type { ToolRowContext } from './tool-rows';

// ── 工具贡献变更监听（S4-1.5）──
// ToolsService 的 onChange：不 bump 即时信号（下次装配语义），但触发
// 「贡献变更」钩子——pluginToolRows() 的实例缓存按贡献生命周期管理
// （register 时 factory 调用一次缓存实例；dispose 清缓存——工具实例
// 不随每次装配重建，设计件 §2.3 ToolRow 折算规则）。
type ContributionsChangedListener = () => void;
const contributionListeners = new Set<ContributionsChangedListener>();

/** 订阅工具贡献变更（register/dispose）。返回退订函数。 */
export function onToolContributionsChanged(cb: ContributionsChangedListener): () => void {
  contributionListeners.add(cb);
  return () => contributionListeners.delete(cb);
}

function fireContributionsChanged(): void {
  for (const cb of [...contributionListeners]) cb();
}

// ── def 形状（字段对齐既有消费面：PanelDef / CommandContribution；tools 行对齐 S1-0 的
//    ToolContribution 概念——S1-2 起行表统一到此形状）──

export interface PanelContribution {
  /** 面板 id——string 开集（S1-5 起 DockPanelId union 退役，合法清单由
   *  panel-def 装载期校验守门；外部插件面板经本 service 注册走同款语义）。 */
  id: string;
  /** 轨道侧；null = 不上轨道（命令面板 / 快捷键唤起） */
  side: 'left' | 'right' | null;
  title: string;
  icon: string;
  /** 面板内提供「问 Agent」入口 */
  askAgent?: boolean;
  /** 关闭即卸载、重开重置状态 */
  unmountOnClose?: boolean;
  /** 关闭时播出场动画（§15 退场对称）——与 `app/panels/panel-def.ts` 的
   *  `PanelDef.animateExit` **逐字段同义**（两处形状是「贡献面 / 消费面」一对，
   *  合流时 `panelDefs()` 原样透传）；语义与消费面见那里。 */
  animateExit?: boolean;
  component: ComponentType;
}

export interface CommandContribution {
  id: string;
  /** 显示名称 */
  label: string;
  /** 副标题 / 描述 */
  description?: string;
  /** 分组 */
  group: string;
  /** 斜杠触发词（如 '/memory'）。缺省 = 不可斜杠触达（纯键位/面板命令）——
   *  v42 起与键位提示分家：旧 `shortcut` 一个字段兼表两义（'/dock' 与 'ctrl P'
   *  同处一栏），命令面板把键位当快捷键显示、斜杠面板把键位当命令列出的病灶。 */
  slash?: string;
  /** 键位提示（如 'ctrl P'）——仅展示，真实绑定在 useGlobalKeys 全局层。 */
  kbd?: string;
  action: CommandAction;
}

/** 命令执行面四型（v42：`local` 收斜杠参数——`/goal resume` 一类带参命令
 *  不再需要在 sendMessage 里硬编码解析，缺省空串 = 无参调用）。 */
export type CommandAction =
  | { type: 'send'; text: string; displayLabel: string }
  | { type: 'local'; handler: (arg: string) => void }
  | { type: 'fill'; text: string }
  | { type: 'skill'; skillName: string };

export interface ToolContribution {
  /** 行 id（S1-2 起由行表寻址；与 Tool.name 可不同——行 id 稳定寻址，name 是模型可见名）。 */
  id: string;
  /** 工具工厂。三种形态：
   *  - 无参 factory → Tool（外部插件经典形态，S4-1.5 契约）；
   *  - factory(rowCtx) → Tool（B① 放宽：第一方域插件收装配上下文取 codingExec
   *    等装配期依赖——收 ctx 的贡献自担「首装配实例跨装配复用」的语义等价责任）；
   *  - factory → Tool[]（S4-4 乙放宽：MCP 机器桥行——一个 server 贡献整组
   *    远端工具，惰性连接后动态产出；空集不缓存，下次装配重试）。
   *  实例缓存对非空结果跨装配复用（工具可能持状态/连接）；dispose 清缓存。 */
  factory: (ctx?: ToolRowContext) => Tool | Tool[] | Promise<Tool | Tool[]>;
  /** 无缓存行（①c 路线一，2026-08-23 拍板 #2）：factory 每装配重调、产物不进
   *  实例缓存——依赖装配期真值的族（wait 的 subAgentPool / ask 的 ui 回调 /
   *  hologram 的 graphData 开关）经此标记跨装配取新真值。缓存行为等价于
   *  「永远 miss」：每装配新实例（无跨装配串扰面）。 */
  noCache?: boolean;
  /** 默认关（S6 P1，2026-09-15）：**登记但默认不进任何组合**的行——装载面照常
   *  注册（通道在册、可寻址、可诊断），组合解析时初始 disabled；只有 patch/preset
   *  显式写 `disabled: false` 才回开（roster.ts 已立此语义，此前无生产者）。
   *  用途：装了就占位的重装备/实验性行——出厂面（standard/minimal）的字节契约
   *  不动，用户按自己的环境回开（用户四项定调④：平台只提供环境）。
   *  诊断面据此区分「未选中」（本标记且未被任何层回开）与「被禁用」（显式 disabled）。 */
  defaultOff?: boolean;
}

/** Provider 工厂收到的运行期实参形状（真源在 provider/types.ts；此处 type-only 别名防环）。 */
type ProviderRuntimeArgs = import('../provider/types').ProviderRuntimeArgs;

export interface LlmAdapterContribution {
  /** 注册表寻址 id（稳定行标识）。 */
  id: string;
  /** 适配的 settings.kind（'anthropic' | 'openai' 由第一方 llm-adapters 插件提供默认，
   *  同 kind 后注册胜——对齐 renderer-service 覆盖语义；未知 kind 由 createProvider
   *  请求期响亮报错）。 */
  kind: string;
  /** 协议下拉/展示用的人类可读标签（Phase 1A provider-refactor：协议开放后
   *  AddProviderSheet 的协议 select 与 PROTOCOL_LABELS 的回落链查此标签；
   *  缺省 = 直接显示 kind 字符串）。 */
  label?: string;
  /** 方言工厂：从 createProvider 解析好的运行期实参构建完整 Provider。 */
  create: (rt: ProviderRuntimeArgs) => Provider;
}

// ── 注册表内核 ──
//
// M1 收口（2026-09-14）：内核已上收到 composition/contribution-channel.ts
// （ContributionChannel——全平台唯一注册表实现，见该文件头注）。本条通道的
// 差异只剩三件**声明式数据**：kind / timing / onChanged——不再各自持有一份
// 手抄的类。历史上本文件内的 ContributionRegistry 是七份复制中的「正本」，
// 其余六份抄它又各自少了成员（get/变更通知），现已全部收编。

// ── 四 service 本体（结构同构，分立四个服务名：inject 面各自独立）──

export class PanelsService extends Service {
  // 即时生效语义：DockRail/DockPanel 经 bumpPanelDefs 信号 store 重取清单。
  private registry = new ContributionChannel<PanelContribution>('panels', {
    timing: 'immediate',
    onChanged: bumpPanelDefs,
  });

  constructor(ctx: Context) {
    super(ctx, 'panels');
    setActivePanels(this); // S4-1.5：消费闭环读取面（panelDefs() 合流点）
  }

  register(def: PanelContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): PanelContribution | undefined {
    return this.registry.get(id);
  }

  list(): PanelContribution[] {
    return this.registry.list();
  }
}

export class CommandsService extends Service {
  // 即时生效语义：CommandPalette/effectiveActions 经 bumpCommands 信号 store 重取清单。
  private registry = new ContributionChannel<CommandContribution>('commands', {
    timing: 'immediate',
    onChanged: bumpCommands,
  });

  constructor(ctx: Context) {
    super(ctx, 'commands');
    setActiveCommands(this); // S4-1.5：消费闭环读取面（effectiveActions() 合流点）
  }

  register(def: CommandContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): CommandContribution | undefined {
    return this.registry.get(id);
  }

  list(): CommandContribution[] {
    return this.registry.list();
  }
}

export class ToolsService extends Service {
  // 下次装配生效语义：无即时 React 消费面，变更是「组合输入变更」
  // （preset-assembly cache 代数失效 + bootShell 重应用 + pluginToolRows 实例缓存清）。
  private registry = new ContributionChannel<ToolContribution>('tools', {
    timing: 'next-assembly',
    onChanged: fireContributionsChanged,
  });

  constructor(ctx: Context) {
    super(ctx, 'tools');
    setActiveTools(this); // S4-1.5：消费闭环读取面（pluginToolRows() 折算源）
  }

  register(def: ToolContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): ToolContribution | undefined {
    return this.registry.get(id);
  }

  list(): ToolContribution[] {
    return this.registry.list();
  }
}

export class LlmService extends Service {
  // 请求期解析语义：createProvider 按 kind 扫描注册序取最后一个同 kind 实现。
  private registry = new ContributionChannel<LlmAdapterContribution>('llm', { timing: 'request' });

  constructor(ctx: Context) {
    super(ctx, 'llm');
    // 消费读取面（createProvider 方言解析——2026-08-27 S2 收口 + Phase 1 升格为 ctx.llm）
    setActiveLlm(this);
  }

  register(def: LlmAdapterContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): LlmAdapterContribution | undefined {
    return this.registry.get(id);
  }

  list(): LlmAdapterContribution[] {
    return this.registry.list();
  }
}

// ── S4-1.5 消费闭环读取面 ──
//
// React 消费面（DockRail/DockPanel/CommandPalette）与装配面（buildToolRegistry）
// 不持根 Context 引用——经此模块级「活动服务」间接层读取贡献清单。服务的
// set/bump 都发生在构造期（loadBuiltinPlugins 引导），fiber dispose 卸载
// 时无消费者残留（app 生命周期 = 根 fiber 生命周期）。模块级可变态归属
// CONVENTIONS §1.10 第 3 类（键控自清理：单一键，生命周期 = 进程）。

let _activePanels: PanelsService | null = null;
let _activeCommands: CommandsService | null = null;
let _activeTools: ToolsService | null = null;
let _activeLlm: LlmService | null = null;

/** 服务构造期登记（loadBuiltinPlugins 引导的唯一入口）。 */
function setActivePanels(svc: PanelsService): void {
  _activePanels = svc;
}
function setActiveCommands(svc: CommandsService): void {
  _activeCommands = svc;
}
function setActiveTools(svc: ToolsService): void {
  _activeTools = svc;
}
function setActiveLlm(svc: LlmService): void {
  _activeLlm = svc;
}

/** 当前面板贡献（无服务/无注册 = 空集——合流点读这个，常量面零改写）。 */
export function activePanelContributions(): PanelContribution[] {
  return _activePanels?.list() ?? [];
}

/** 当前面板贡献按 id 查找。 */
export function getPanelContribution(id: string): PanelContribution | undefined {
  return _activePanels?.get(id);
}

/** 当前命令贡献（无服务/无注册 = 空集）。 */
export function activeCommandContributions(): CommandContribution[] {
  return _activeCommands?.list() ?? [];
}

/** 当前工具贡献（无服务/无注册 = 空集——pluginToolRows 折算源）。 */
export function activeToolContributions(): ToolContribution[] {
  return _activeTools?.list() ?? [];
}

/** LLM adapter 注册表原始清单（寻址行源——factoryComposition 的 `seam/llm`
 *  域快照收编本清单；被组合禁用的行仍在此处，patch 才能重新启用）。 */
export function registeredLlmAdapters(): LlmAdapterContribution[] {
  return _activeLlm?.list() ?? [];
}

/** 当前 LLM adapter 贡献（无服务/无注册 = 空集——createProvider 方言解析的
 *  「后注册胜」扫描源）。裁剪面（平台化 Phase 3）：组合 seam 裁剪域
 *  `seam/llm` 禁用的 adapter id 从视图剔除（消费视图 = 注册表 − 禁用集）。
 *  view（S6 P2b）= 本次 provider 构建所属组合的裁剪面（会话卷级组合 / 工作区
 *  组合经 createProvider 的 options.seamView 传入）；**缺省 = 全局当前选择**
 *  （无组合上下文路径——设置面板连通性测试 / 翻译压缩旁路——零漂移）。 */
export function activeLlmAdapters(view?: SeamDisabledMap | null): LlmAdapterContribution[] {
  const disabled = seamDisabled('llm', view);
  return registeredLlmAdapters().filter((a) => !disabled.has(a.id));
}

// ── 组合层挂载插件（根 Context 装配四 service；经 loadBuiltinPlugins 引导）──

declare module '../cordis/context' {
  interface Context {
    /** 面板注册表（S1-1）——def 注册 → disposer；即时生效语义。 */
    panels: PanelsService;
    /** 命令注册表（S1-1）——def 注册 → disposer；即时生效语义。 */
    commands: CommandsService;
    /** 工具注册表（S1-1）——行注册 → disposer；下次 Agent 装配生效语义。 */
    tools: ToolsService;
    /** LLM adapter 注册表（S1-1 起；平台化 Phase 1 升格为 ctx.llm seam）——
     *  行注册 → disposer；请求期解析语义见 provider/index.ts 方言解析器。 */
    llm: LlmService;
  }
}

/** 内核线第 3 条的实体化：注册表常驻根上下文，先于任何外部插件装载。
 *  空间服务（ctx.space）独立成 spaceServicePlugin（依赖 chat-store 链，
 *  不并入本插件——见 composition/space-service.ts 头注）。
 *  S6 P3a：第五个 service `ctx.activation`（插件激活账）同挂此处——它是组合层
 *  service 本体的一员，**不新增插件条目**（first-party-manifest 的 13 内核计数
 *  与手册文案因此不动）。 */
export const compositionServicesPlugin = {
  name: 'hologram/composition-services',
  apply(ctx: Context) {
    new PanelsService(ctx);
    new CommandsService(ctx);
    new ToolsService(ctx);
    new LlmService(ctx);
    new ActivationService(ctx);
  },
};
