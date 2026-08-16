// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentContext — 身份 + 服务容器 + ownership（agent-core-convergence Phase 3）。
//
// Cordis Context 原语的 HoloGram 落地：Agent 的外部依赖收敛为显式服务表，
// createAgent 从"30 字段手工装配"变为"翻译层 → context + 装配输入"：
//   - 身份字段只读（agentId/parentId/subagentDepth/isolationId/projectPath/sessionId）；
//   - 服务经 get（可缺）/ resolve（必备显式报错）访问；
//   - effect() 把注册类资源的清理器纳入 DisposerBag（Phase 4 接线全量 ownership）；
//   - child() 派生子 Agent context：只继承白名单服务，不复制父的全部字段。
//
// 行为规约（tests/agent-context.test.ts 钉住）：
//   1. resolve 缺失服务抛错（依赖显式化，不用 undefined 静默传播）；
//   2. effect 注册的清理器逆序释放（复用 lifecycle.DisposerBag 契约）；
//   3. child 隔离：独立 effect bag、身份按父子关系派生、继承表之外的服务不泄露。

import type { Provider } from '../provider/types';
import type { AgentStore } from './agent-store';
import type { EventSink } from './agent-types';
import type { SubAgentPool } from './coordinator';
import type { DiscoveryBoard } from './discovery-board';
import type { ExecStateInstance } from './execution-state';
import type { GoalManager } from './goal-manager';
import type { HookRegistry, PreflightHookRegistry } from './hooks';
import { type Disposer, DisposerBag, runInContext } from './lifecycle';
import type { MemoryManager } from './memory';
import type { MessageBus } from './message-bus';
import type { PlanStateManager } from './plan/plan-state';
import type { SessionLog } from './session-log';
import type { TaskBoard } from './task-board';
import type { ToolRegistry } from './tool';

// ── 服务表 ──

/** Agent 的服务依赖表。全部可选 — 必备依赖在消费点用 ctx.resolve 显式声明，
 *  缺失时抛错而不是 undefined 静默传播。新增服务必须先进此接口（封闭集合）。 */
export interface AgentServices {
  /** LLM Provider — Agent 主循环的模型入口（必备） */
  provider?: Provider;
  /** 工具注册表（输入面；runtime 克隆后以克隆件装配 Agent） */
  tools?: ToolRegistry;
  /** 事件 sink — Agent 事件流出口（UI/测试观测） */
  eventSink?: EventSink;
  /** PreToolUse 富化 hooks */
  hooks?: HookRegistry;
  /** Preflight 告警 hooks */
  preflightHooks?: PreflightHookRegistry;
  /** Agent 间通信总线 */
  messageBus?: MessageBus;
  /** TaskBoard — 会话级共享状态区（经 proxy 静态绑定） */
  taskBoard?: TaskBoard;
  /** DiscoveryBoard — 会话级共享发现区（经 proxy 静态绑定） */
  discoveryBoard?: DiscoveryBoard;
  /** Plan 模式状态机（运行时 enter/exit） */
  planState?: PlanStateManager;
  /** Goal 管理器 — 主 Agent 专属，子 Agent 不继承 */
  goalManager?: GoalManager;
  /** Agent 持久化存储 */
  agentStore?: AgentStore;
  /** 子 Agent 池 — 主 Agent 专属，子 Agent 不继承 */
  subAgentPool?: SubAgentPool;
  /** 执行状态实例 — 缺省由 runtime 物化 createExecState() */
  execState?: ExecStateInstance;
  /** 记忆管理器 — system prompt 记忆段来源 */
  memoryManager?: MemoryManager;
  /** 会话事件溯源日志 — Phase 5 双写：模型可见事实 append 为事件，Message[] 成为投影
   *  （deriveMessages/derivePayload 见 session-log.ts）。缺省由 runtime 物化（每 Agent
   *  独立实例）；child() 白名单不继承 — 子 Agent 各自持有。 */
  sessionLog?: SessionLog;
}

/** 服务名 — AgentServices 的 key 全集。 */
export type AgentServiceName = keyof AgentServices;

// ── 身份 ──

/** AgentContext 的身份与派生选项。全部可选 — 缺省值见构造函数。 */
export interface AgentContextInit {
  /** Agent 唯一标识（模型可见；bus/board 注册地址）。缺省自动生成。 */
  agentId?: string;
  /** 父 Agent ID。根 Agent 为 null；child() 派生时自动取父 agentId。 */
  parentId?: string | null;
  /** 子 Agent 嵌套深度（0 = 根）。child() 派生时自动取父深度 + 1。 */
  subagentDepth?: number;
  /** worktree 隔离 ID（无隔离为 undefined）。 */
  isolationId?: string;
  /** 项目根路径 — 持久化与图查询的锚点。 */
  projectPath?: string;
  /** 会话隔离键 — 会话级 board 的路由键。缺省按父继承或 'default'（runtime 物化时解析）。 */
  sessionId?: string;
}

/** child() 的派生覆盖项。身份只允许覆盖 agentId/isolationId，其余按父子关系派生。 */
export interface AgentChildOverrides {
  /** 子 Agent 标识；缺省生成 sub-<ts>-<rand>（模型可见子 Agent ID 约定）。 */
  agentId?: string;
  /** worktree 隔离 ID；显式传 undefined 表示无隔离。 */
  isolationId?: string;
  /** 服务覆盖 — 与继承表合并，同名键以覆盖为准。 */
  services?: Partial<AgentServices>;
}

// ── AgentContext ──

export class AgentContext {
  /** Agent 唯一标识 — 模型可见，注册进 bus/board 的地址。 */
  readonly agentId: string;
  /** 父 Agent ID（根 Agent 为 null）。 */
  readonly parentId: string | null;
  /** 子 Agent 嵌套深度（0 = 根）。 */
  readonly subagentDepth: number;
  /** worktree 隔离 ID（无隔离为 undefined）。 */
  readonly isolationId: string | undefined;
  /** 项目根路径 — 持久化与图查询的锚点。 */
  readonly projectPath: string;
  /** 会话隔离键 — 会话级 board 的路由键（缺省由 runtime 按父继承或 'default' 解析）。 */
  readonly sessionId: string | undefined;

  private readonly _services: Partial<AgentServices>;
  private readonly _bag: DisposerBag;

  /** 构造 context。init 为身份，services 为初始服务表；二者之后均可经 set/effect 增补。 */
  constructor(init: AgentContextInit = {}, services: Partial<AgentServices> = {}) {
    this.agentId = init.agentId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.parentId = init.parentId ?? null;
    this.subagentDepth = init.subagentDepth ?? 0;
    this.isolationId = init.isolationId;
    this.projectPath = init.projectPath ?? '';
    this.sessionId = init.sessionId;
    this._services = { ...services };
    this._bag = new DisposerBag();
  }

  /** 生命周期是否已结束（dispose 后拒绝新注册/新服务）。 */
  get disposed(): boolean {
    return this._bag.disposed;
  }

  /** 读取服务 — 可缺依赖用此入口，缺失返回 undefined。 */
  get<K extends AgentServiceName>(name: K): AgentServices[K] {
    return this._services[name];
  }

  /** 读取必备服务 — 缺失抛错（依赖显式化，报出服务名与 agentId 便于定位漏配）。 */
  resolve<K extends AgentServiceName>(name: K): NonNullable<AgentServices[K]> {
    const v = this._services[name];
    if (v === undefined) {
      throw new Error(`[AgentContext] 服务缺失: ${name}（agent=${this.agentId}）— 必备依赖必须显式注入`);
    }
    return v as NonNullable<AgentServices[K]>;
  }

  /** 写入/替换服务 — 装配期与 Agent setter write-through 的目标；
   *  dispose 后拒绝写入（生命周期已结束）。 */
  set<K extends AgentServiceName>(name: K, value: AgentServices[K]): void {
    if (this._bag.disposed) {
      throw new Error(`[AgentContext] 已 dispose，拒绝写入服务 ${name}（agent=${this.agentId}）`);
    }
    this._services[name] = value;
  }

  /** 立即执行注册并把返回的清理器纳入本 context 所有权 — "注册即 ownership"。
   *  返回该项的单独释放器；整体逆序释放经 dispose()。 */
  effect(register: () => Disposer, label = 'unnamed'): Disposer {
    return runInContext(this._bag, register, label);
  }

  /** 派生子 Agent context。身份按父子关系派生（parentId=父 agentId、depth+1）；
   *  服务只继承白名单（provider/messageBus/agentStore — 与 spawnSubAgent 的
   *  继承语义一致），tools/eventSink/execState 等子 Agent 专属依赖经 overrides.services
   *  显式注入，不复制父的全部字段。effect 所有权独立 — 父子互不代管清理。 */
  child(overrides: AgentChildOverrides = {}): AgentContext {
    const inherited: Partial<AgentServices> = {
      provider: this._services.provider,
      messageBus: this._services.messageBus,
      agentStore: this._services.agentStore,
    };
    return new AgentContext(
      {
        agentId: overrides.agentId ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        parentId: this.agentId,
        subagentDepth: this.subagentDepth + 1,
        isolationId: overrides.isolationId,
        projectPath: this.projectPath,
      },
      { ...inherited, ...overrides.services },
    );
  }

  /** 逆序释放全部 effects 并结束生命周期。单次执行；单个失败不阻断后续（聚合抛出）。
   *  Phase 3 仅提供契约（T1 钉住）；runtime 侧接线属 Phase 4。 */
  async dispose(): Promise<void> {
    await this._bag.dispose();
  }
}
