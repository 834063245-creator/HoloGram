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
//      standard() 的表序与 Phase 5 末 _assembleAgent 的手写注册序一一对应，
//      插入新 capability 必须显式选择位置（表是唯一的序真源）；
//   2. capability 分两个阶段执行：'context'（Agent 构造前，可写 ctx 服务）与
//      'agent'（Agent 构造后）。阶段内按表序，阶段间先 context 后 agent；
//   3. 生命周期所有权（board/lifecycle/runtime-maps 的 ctx.effect）留在
//      runtime 装配层（Phase 4 语义）——capability 只做组合，不做 teardown；
//   4. hooks 统一注册进 scope 上的共享 HookRegistry/PreflightHookRegistry，
//      由 runtime 在 capability 循环后一次性 setHooks（Agent.setHooks 是
//      整体替换语义，capability 各自 set 会互相覆盖）。
//
// 行为规约（tests/blueprint.test.ts 钉住）：重复 key 拒绝；capabilities()
// 保持声明序；when() 缺省恒装；standard() 每次返回全新实例（调用方扩展
// 不得污染标准装配）。

import type { Agent } from './agent';
import type { AgentContext } from './context';
import {
  createGraphContextHook,
  createGraphPreflightHook,
  createStatePreflightHook,
  createStateReadHook,
  type HookRegistry,
  type PreflightHookRegistry,
} from './hooks';
import { createBoardTrackingHook } from './hooks/board-tracking-hook';
import type { MessageBus } from './message-bus';
import { createPlanExploreHook, createPlanWriteHook } from './plan/plan-graph-hook';
import { PlanModeInjector } from './plan/plan-injection';
import { createEnterPlanModeTool, createExitPlanModeTool } from './plan/plan-tools';
import { loadEngineSnapshot, registerCompactionTools } from './runtime/agent-builder';
import type { AgentAssemblyInputs } from './runtime/types';
import type { DiagnosticsSource } from './state-inject';
import { createTaskTools, TaskManager } from './task';
import type { ToolRegistry } from './tool';
import { createBoardStatusTool } from './tools/board-status';
import { createCommunicationTools } from './tools/communication';
import { createDiscoveryTools } from './tools/discovery';
import { convergeRegistry } from './tools/domains';
import { createMergeTool } from './tools/merge';
import { createRequestTool } from './tools/request';
import { createAgentKillTool, createSubAgentTool } from './tools/subagent';

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
  /** 登记 per-Agent TaskManager（UI TasksPanel 经 runtime 读取）。 */
  registerTaskManager?: (tm: TaskManager) => void;
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
  /** runtime 私有依赖。 */
  readonly deps: BlueprintDeps;
  /** 已构造的 Agent 实例 — 仅 'agent' 阶段可用。 */
  readonly agent?: Agent;
}

/** 一项声明式装配能力：条件 + 安装动作。key 全局唯一（重复即拒绝）。 */
export interface AgentCapability {
  /** 稳定标识 — 审计/排序/差分对拍用。 */
  readonly key: string;
  /** 装配阶段。 */
  readonly phase: CapabilityPhase;
  /** 缺省恒装；返回 false 跳过。 */
  when?(scope: BlueprintScope): boolean;
  /** 安装动作 — 注册工具/hook、接线。不得做 teardown（那是 ctx.effect 的职责）。 */
  install(scope: BlueprintScope): void;
}

/** 取 'agent' 阶段的 Agent 实例 — context 阶段误用即抛错。 */
function requireAgent(scope: BlueprintScope): Agent {
  if (!scope.agent) {
    throw new Error('[blueprint] 该 capability 需要 Agent 实例 — phase 必须是 "agent"');
  }
  return scope.agent;
}

// ── AgentBlueprint ──

export class AgentBlueprint {
  private readonly _caps: AgentCapability[];

  /** 构造蓝图。capabilities 的 key 必须唯一（重复抛错 — 序与审计都依赖 key 唯一）。 */
  constructor(capabilities: AgentCapability[] = []) {
    const seen = new Set<string>();
    for (const cap of capabilities) {
      if (seen.has(cap.key)) throw new Error(`[blueprint] capability key 重复: ${cap.key}`);
      seen.add(cap.key);
    }
    this._caps = [...capabilities];
  }

  /** 追加 capability（链式）。返回本实例 — 扩展只应作用于调用方私有蓝图。 */
  add(...caps: AgentCapability[]): this {
    for (const cap of caps) {
      if (this._caps.some((c) => c.key === cap.key)) {
        throw new Error(`[blueprint] capability key 重复: ${cap.key}`);
      }
      this._caps.push(cap);
    }
    return this;
  }

  /** 按 key 查找。 */
  capability(key: string): AgentCapability | undefined {
    return this._caps.find((c) => c.key === key);
  }

  /** 全部 capability key（声明序）。 */
  keys(): string[] {
    return this._caps.map((c) => c.key);
  }

  /** 按阶段过滤（保持声明序）。缺省返回全部。 */
  capabilities(phase?: CapabilityPhase): AgentCapability[] {
    return phase ? this._caps.filter((c) => c.phase === phase) : [...this._caps];
  }

  /** 标准装配面 — 与 Phase 5 末 _assembleAgent 的注册序一一对应（表序 = 序真源）。
   *  每次返回全新实例：调用方 add() 的扩展不得污染标准装配。 */
  static standard(): AgentBlueprint {
    return new AgentBlueprint([
      // ── context 阶段（Agent 构造前）──
      {
        key: 'plan-tools',
        phase: 'context',
        install: ({ ctx, tools }) => {
          // readOnly: true → 两种模式都存活；planState 由 ctx 提供（翻译层或物化层创建）
          tools.register(createEnterPlanModeTool(ctx.resolve('planState'), ctx.projectPath));
          // exit_plan_mode 使用 eventSink 将 PlanReview 事件推入聊天流
          tools.register(createExitPlanModeTool(ctx.resolve('planState'), ctx.get('eventSink')));
        },
      },
      // ── agent 阶段（Agent 构造后 — 表序即工具面注册序）──
      {
        // 通信族 — bus 注册本身在 Agent 构造内经 ctx 完成，这里补模型可见工具面
        key: 'communication-tools',
        phase: 'agent',
        install: (scope) => {
          const agent = requireAgent(scope);
          for (const tool of createCommunicationTools(scope.deps.messageBus, () => agent.id)) {
            scope.tools.register(tool);
          }
        },
      },
      {
        // discovery 族 — 同上；proxy 已由物化层静态绑定到该 Agent 的会话板
        key: 'discovery-tools',
        phase: 'agent',
        install: (scope) => {
          const agent = requireAgent(scope);
          for (const tool of createDiscoveryTools(scope.ctx.resolve('discoveryBoard'), () => agent.id)) {
            scope.tools.register(tool);
          }
        },
      },
      {
        // 子 Agent 管理族（merge/board/kill）— 需要会话级 pool
        key: 'merge-tools',
        phase: 'agent',
        when: ({ ctx }) => !!ctx.get('subAgentPool'),
        install: (scope) => {
          const agent = requireAgent(scope);
          const subPool = scope.ctx.get('subAgentPool');
          if (!subPool) return;
          const taskProxy = scope.ctx.resolve('taskBoard');
          scope.tools.register(
            createMergeTool(taskProxy, () => agent.id, scope.deps.isolationExec, {
              projectPath: scope.ctx.projectPath,
            }),
          );
          scope.tools.register(createBoardStatusTool(taskProxy, () => agent.id));
          scope.tools.register(createAgentKillTool(subPool, scope.deps.isolationExec));
        },
      },
      {
        // 同步请求工具 — agent_request
        key: 'request-tool',
        phase: 'agent',
        install: (scope) => {
          const agent = requireAgent(scope);
          scope.tools.register(createRequestTool(scope.deps.messageBus, () => agent.id));
        },
      },
      {
        // 替换 agent_spawn 为绑定本 Agent 的版本 — 修复多会话下 spawn 路由错位
        key: 'spawn-tool',
        phase: 'agent',
        when: ({ ctx, inputs }) => !!ctx.get('subAgentPool') && !!inputs.subAgentSpawner,
        install: (scope) => {
          const agent = requireAgent(scope);
          const subPool = scope.ctx.get('subAgentPool');
          const spawner = scope.inputs.subAgentSpawner;
          if (!subPool || !spawner) return;
          scope.tools.unregister('agent_spawn');
          scope.tools.register(
            createSubAgentTool(
              (desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride, outputSchema) =>
                agent.spawnSubAgent(desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride, outputSchema),
              subPool,
            ),
          );
        },
      },
      {
        // 替换 task_* 为绑定本 Agent 实例的专属待办 — 每 Agent 一份清单
        key: 'task-tools',
        phase: 'agent',
        install: (scope) => {
          const perAgentTaskManager = new TaskManager();
          for (const taskTool of createTaskTools(perAgentTaskManager)) {
            scope.tools.unregister(taskTool.name());
            scope.tools.register(taskTool);
          }
          scope.deps.registerTaskManager?.(perAgentTaskManager);
        },
      },
      {
        // 压缩工具 + tracker 持久化路径
        key: 'compaction-tools',
        phase: 'agent',
        install: (scope) => {
          const agent = requireAgent(scope);
          agent.setCompactionConfigPath(scope.ctx.projectPath);
          registerCompactionTools(agent, scope.tools);
        },
      },
      {
        // 工具层收敛：领域工具 + 隐藏旧名（必须在全部工具注册之后 — 表序保证）
        key: 'converge-tools',
        phase: 'agent',
        install: ({ tools }) => {
          convergeRegistry(tools);
        },
      },
      {
        // 图上下文 + 状态 + plan 增强 hooks（提示注入类 — 受 hooksEnabled 总开关）
        key: 'graph-hooks',
        phase: 'agent',
        when: ({ inputs }) => !!inputs.graphContext && inputs.hooksEnabled !== false,
        install: ({ ctx, inputs, hooks, preflightHooks, deps }) => {
          const graphContext = inputs.graphContext;
          if (!graphContext) return;
          void loadEngineSnapshot(graphContext, ctx.projectPath).catch(() => {});
          hooks.register(createGraphContextHook(graphContext));
          if (deps.diagnosticsSource) {
            hooks.register(createStateReadHook(ctx.projectPath, deps.diagnosticsSource));
          }
          preflightHooks.register(createGraphPreflightHook(graphContext));
          if (deps.diagnosticsSource) {
            preflightHooks.register(createStatePreflightHook(deps.diagnosticsSource));
          }
          const planState = ctx.resolve('planState');
          // Plan 模式图增强 hook — 探索时注入影响面，写计划时追加分析
          hooks.register(createPlanExploreHook(graphContext, planState));
          hooks.register(createPlanWriteHook(graphContext, planState));
        },
      },
      {
        // Board 追踪 hook — board 可用时始终注册（有实际副作用，不受 hooksEnabled 影响）
        key: 'board-tracking-hook',
        phase: 'agent',
        install: ({ ctx, hooks }) => {
          hooks.register(createBoardTrackingHook(ctx.agentId, ctx.resolve('taskBoard')));
        },
      },
      {
        // Plan 模式接线 — runLoop 提醒注入器 + 状态通知
        key: 'plan-injector',
        phase: 'agent',
        install: (scope) => {
          const agent = requireAgent(scope);
          const planInjector = new PlanModeInjector();
          agent.setPlanState(scope.ctx.resolve('planState'), planInjector, scope.ctx.projectPath);
          scope.ctx.resolve('planState').onChange((s) => {
            scope.deps.onPlanModeChange?.(s.active, s.planFilePath);
          });
        },
      },
      {
        // pre-run hook（AuraSDK 语义检索）
        key: 'pre-run-hook',
        phase: 'agent',
        when: ({ inputs }) => !!inputs.preRunHook,
        install: (scope) => {
          const agent = requireAgent(scope);
          const hook = scope.inputs.preRunHook;
          if (hook) agent.setPreRunHook(hook);
        },
      },
      {
        // 自动调优 — fire-and-forget
        key: 'auto-tune',
        phase: 'agent',
        install: (scope) => {
          const agent = requireAgent(scope);
          void agent.applyAutoTuneConfig().catch(() => {});
        },
      },
    ]);
  }
}
