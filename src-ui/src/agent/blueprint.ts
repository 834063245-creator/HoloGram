// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// AgentBlueprint — 声明式组合层（agent-core-convergence Phase 6）。
//
// 目标：Agent 的组成（工具/hook/接线）以 capability 表描述，不再靠往
// AgentConfig 加字段 + 在 _assembleAgent 里写 if。新增一个工具或 hook =
// 在 blueprint 上 add 一个 capability（或经 createAgentFromContext 第 3 参
// 注入扩展蓝图）——AgentConfig 字段面从此冻结（specs/phase-6 T0 钉住）。
//
// 铁律（Phase 6 重写 _assembleAgent 的等价性基础）：
//   1. 注册顺序 = capability 表声明顺序。工具 schema 面的字节稳定性
//      （DeepSeek 前缀缓存 + phase-1 effective 快照）依赖此序——
//      第一方 capability 表（firstPartyCapabilities()，B⑤ 起经
//      ctx.capabilities 通道贡献）的表序与 Phase 5 末 _assembleAgent
//      的手写注册序一一对应，插入新 capability 必须显式选择位置
//      （表是唯一的序真源）；
//   2. capability 分两个阶段执行：'context'（Agent 构造前，可写 ctx 服务）与
//      'agent'（Agent 构造后）。阶段内按表序，阶段间先 context 后 agent；
//   3. 生命周期所有权（board/lifecycle/runtime-maps 的 ctx.effect）留在
//      runtime 装配层（Phase 4 语义）——capability 只做组合，不做 teardown；
//   4. hooks / preStep 统一注册进 scope 上的共享注册表，由 runtime 在
//      capability 循环后一次性 setHooks / setPreStep（整体替换语义，
//      capability 各自 set 会互相覆盖）。
//
// 行为规约（tests/blueprint.test.ts 钉住）：重复 key 拒绝；capabilities()
// 保持声明序；when() 缺省恒装；fromRoster 每次返回全新实例（调用方扩展
// 不得污染标准装配——标准面经组合解析产物派生，B⑤ 后 = 通道快照）。
//
// P4 B⑤（2026-08-24，agent-plugin-architecture-plan §5 B 表 ⑤ 收官）：
// 出厂 builtinCapabilities() 退役（B④ builtinPromptSections 退役同款终态）
// ——十四项定义改名 firstPartyCapabilities() 供第一方 capability 插件经
// ctx.capabilities 通道注册装载；装配缺省蓝图 = fromRoster(组合解析产物)
// （S2-1 既有穿线，零 runtime 改动），standard() 快捷方式随之退役（生产标准面
// = 通道快照，测试钉面经 composition/first-party-capabilities.ts 的
// withFirstPartyCapabilityChannel）。
//
// 批 9h-1（2026-09-26）：**内容随包**——十四项 capability 定义搬进产物
// `plugins/builtin/capability-segments/segments.ts`（改一项 = 换产物热更），
// 本文件自此只剩**机制与形状**（`AgentCapability` / `BlueprintScope` /
// `BlueprintDeps` / `AgentBlueprint` 类）。

import type { Agent } from './agent';
import type { AgentContext } from './context';
import type { HookRegistry, PreflightHookRegistry } from './hooks';
import type { MessageBus } from './message-contract';
import type { PreStepRegistry } from './pre-step';
import type { AgentAssemblyInputs } from './runtime/types';
import type { DiagnosticsSource } from './state-inject';
import type { TaskManagerFace } from './task-contract';
import type { ToolRegistry } from './tool';

// ── 装配视图 ──

/** capability 装配阶段 — Agent 构造前（可写 ctx 服务）或构造后。 */
export type CapabilityPhase = 'context' | 'agent';

/** runtime 私有依赖经此注入 blueprint（capability 不直接触碰 runtime 内部状态）。 */
export interface BlueprintDeps {
  /** 隔离命令执行器（agent_isolation_* 的 invoke 包装 — merge/kill 共用）。 */
  isolationExec: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** runtime 全局消息总线 — 通信族工具的路由面（与旧装配的 this._bus 同源）。 */
  messageBus: MessageBus;
  /** LSP 诊断源（state hooks 用；缺省不注册 state 注入）。 */
  diagnosticsSource?: DiagnosticsSource;
  /** plan 模式变更通知（runtime notifier 路由；缺省静默）。 */
  onPlanModeChange?: (active: boolean, planFilePath: string | null) => void;
  /** 登记 per-Agent TaskManagerFace（UI TasksPanel 经 runtime 读取）。 */
  registerTaskManager?: (tm: TaskManagerFace) => void;
}

/** capability 安装时拿到的装配视图（只读材料 + 写入面）。 */
export interface BlueprintScope {
  /** 装配 context — 身份与服务真源。 */
  readonly ctx: AgentContext;
  /** 非服务装配输入（提示词原料/调优参数/工厂注入）。 */
  readonly inputs: AgentAssemblyInputs;
  /** 工具有效注册表（克隆件 — 模型可见面的唯一写入点）。 */
  readonly tools: ToolRegistry;
  /** 共享 hook 注册表 — capability 只注册，runtime 统一 setHooks。 */
  readonly hooks: HookRegistry;
  /** 共享 preflight hook 注册表 — 同上。 */
  readonly preflightHooks: PreflightHookRegistry;
  /** 共享步前裁决注册表 — capability 只注册，runtime 折叠通道贡献后统一 setPreStep。 */
  readonly preStep: PreStepRegistry;
  /** runtime 私有依赖。 */
  readonly deps: BlueprintDeps;
  /** 已构造的 Agent 实例 — 仅 'agent' 阶段可用。 */
  readonly agent?: Agent;
}

/** 一项声明式装配能力：条件 + 安装动作。id 全局唯一（重复即拒绝）。 */
export interface AgentCapability {
  /** 稳定标识 — 审计/排序/差分对拍/通道寻址用（M1 收口：字段名与其余七条
   *  贡献通道统一为 id；历史名 key 已废弃）。 */
  readonly id: string;
  /** 装配阶段。 */
  readonly phase: CapabilityPhase;
  /** 缺省恒装；返回 false 跳过。 */
  when?(scope: BlueprintScope): boolean;
  /** 安装动作 — 注册工具/hook、接线。不得做 teardown（那是 ctx.effect 的职责）。 */
  install(scope: BlueprintScope): void;
}

// ── AgentBlueprint ──

export class AgentBlueprint {
  private readonly _caps: AgentCapability[];

  /** 构造蓝图。capabilities 的 id 必须唯一（重复抛错 — 序与审计都依赖 id 唯一）。 */
  constructor(capabilities: AgentCapability[] = []) {
    const seen = new Set<string>();
    for (const cap of capabilities) {
      if (seen.has(cap.id)) throw new Error(`[blueprint] capability id 重复: ${cap.id}`);
      seen.add(cap.id);
    }
    this._caps = [...capabilities];
  }

  /** 追加 capability（链式）。返回本实例 — 扩展只应作用于调用方私有蓝图。 */
  add(...caps: AgentCapability[]): this {
    for (const cap of caps) {
      if (this._caps.some((c) => c.id === cap.id)) {
        throw new Error(`[blueprint] capability id 重复: ${cap.id}`);
      }
      this._caps.push(cap);
    }
    return this;
  }

  /** 按 id 查找。 */
  capability(id: string): AgentCapability | undefined {
    return this._caps.find((c) => c.id === id);
  }

  /** 全部 capability id（声明序）。 */
  ids(): string[] {
    return this._caps.map((c) => c.id);
  }

  /** 按阶段过滤（保持声明序）。缺省返回全部。 */
  capabilities(phase?: CapabilityPhase): AgentCapability[] {
    return phase ? this._caps.filter((c) => c.phase === phase) : [...this._caps];
  }

  /** 从 roster 行列表构造蓝图（S2-1 组合外化的装配入口；B⑤ 后唯一构造
   *  入口——standard() 快捷方式已退役）。表序 = 行序（roster 解析产物
   *  保序）；每次返回全新实例：调用方 add() 的扩展不得污染标准装配
   *  ——Phase 6 铁律「换真源不改语义」的表序契约在此保持。 */
  static fromRoster(capabilities: AgentCapability[]): AgentBlueprint {
    return new AgentBlueprint([...capabilities]);
  }
}
