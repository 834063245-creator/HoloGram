// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Runtime 类型定义 — Agent 层与 UI 层的契约边界
//
// agent/ 层只依赖这些接口，不 import 任何 ui/ 模块。
// ui/ 层实现 RuntimeNotifier，通过 RuntimePort 驱动 Agent。

import type { AgentEvent, EventSink } from '../agent-types';
import type { ExecStateInstance } from '../execution-state';
import type { Message, Provider } from '../../provider/types';
import type { Pricing } from '../agent-types';
import type { AgentStore } from '../agent-store';
import type { GoalManager } from '../goal-manager';
import type { GraphContext } from '../hooks';
import type { MemoryManager } from '../memory';
import type { SkillRegistry } from '../skills';
import type { SubAgentPool } from '../coordinator';
import type { TaskManager } from '../task';
import type { ToolRegistry } from '../tool';
import type { MessageBus } from '../message-bus';
import type { TaskBoard } from '../task-board';

// ── Agent 状态 ──

export type AgentStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

// ── Runtime → UI 的通知接口 ──
//
// UI 层实现此接口，Runtime 通过它推送事件。
// 每个 Agent 实例有自己的 notifier，Runtime 负责路由。
// 这是 AgentUINotifier 的演化版本 — 不再绑死 zustand store。

export interface RuntimeNotifier {
  /** Agent 产生了事件（文本流、工具调用、推理等） */
  onAgentEvent(agentId: string, event: AgentEvent): void;
  /** Agent 状态变更（idle/running/paused/...） */
  onAgentStatus(agentId: string, status: AgentStatus): void;
  /** Agent session 被替换（compaction/retract/setSession） */
  onSessionReplaced(agentId: string, messages: Message[]): void;
  /** 子 Agent 启动 — UI 构建渲染状态并返回 EventSink */
  onSubAgentSpawn(info: SubAgentSpawnInfo): EventSink | undefined;
    /** 子 Agent 结束 — UI 收尾渲染状态 */
  onSubAgentFinished(agentId: string, parentAgentId: string, sessionId: number, ok: boolean): void;
  /** 工具执行完成（面板自动刷新） */
  onToolDone(agentId: string, toolName: string, args: Record<string, unknown>, output: string): void;
  /** 循环进度（状态栏） */
  onProgress(agentId: string, step: number, toolName: string): void;
  /** LifecycleManager 告警（泄漏检测、TTL 清理） */
  onLifecycleAlert?(agentId: string, level: 'info' | 'warn' | 'error', text: string): void;
  /** Plan 模式状态变更（UI 更新 plan 模式指示器） */
  onPlanModeChange?(agentId: string, active: boolean, planFilePath: string | null): void;
}

// ── 子 Agent 启动信息 ──

export interface SubAgentSpawnInfo {
  agentId: string;
  parentAgentId: string;
  description: string;
  sessionId: number;
  onProgress?: (chunk: string) => void;
}

// ── Agent 创建配置 ──
//
// 调用者（Workspace 或其他编排者）构造此对象传入 Runtime。
// Runtime 不负责创建 Provider / MemoryManager 等 — 那些由调用者创建。

export interface AgentConfig {
  /** 显式指定 agentId（如 'main'）；不传则自动生成 */
  agentId?: string;
  /** 父 Agent ID（子 Agent 场景） */
  parentId?: string | null;
  /** 子 Agent 深度（0 = 根 Agent） */
  subagentDepth?: number;
  /** 会话 ID — 用于会话级 board 隔离 */
  sessionId?: string;
  /** 项目路径 */
  projectPath: string;
  /** 图数据（null = 无图模式） */
  graphData?: any;
  /** LLM Provider */
  provider: Provider;
  /** 工具注册表（已按权限过滤） */
  tools: ToolRegistry;
  /** 记忆管理器 */
  memoryManager?: MemoryManager;
  /** 技能注册表 */
  skillRegistry?: SkillRegistry;
  /** 目标管理器 */
  goalManager?: GoalManager;
  /** Agent 持久化存储 */
  agentStore?: AgentStore;
  /** 子 Agent 池 */
  subAgentPool?: SubAgentPool;
  /** 子 Agent 派生函数 — 由调用者注入；createAgent 内会用绑定本 Agent 的版本替换
   *  agent_spawn 工具（修复多会话下 spawn 路由到错误 Agent 实例的错位） */
  subAgentSpawner?: import('../tools/subagent').SubAgentSpawner;
  /** 任务管理器 */
  taskManager?: TaskManager;
  /** 执行状态实例 */
  execState?: ExecStateInstance;
  /** 事件接收器（Agent 事件流） */
  eventSink?: EventSink;
  /** 图上下文（用于 hooks） */
  graphContext?: GraphContext | null;
  /** 隔离 ID（worktree） */
  isolationId?: string;
  /** Agent 选项 */
  temperature?: number;
  contextWindow?: number;
  maxTokens?: number;
  pricing?: Pricing;
  /** 协作模式 */
  collaborationMode?: 'normal' | 'plan';
  /** 系统提示词（如果已预构建） */
  systemPrompt?: string;
  /** 预运行钩子（语义记忆召回） */
  preRunHook?: (input: string) => Promise<string | null>;
  /** 会话持久化回调 */
  onSessionPersisted?: (sessionId: string, messages: Message[]) => void;
  /** 通信总线（可选 — 无则为 headless 无通信能力） */
  messageBus?: MessageBus;
  /** TaskBoard — 共享状态区，追踪异步子 Agent 的工作状态 */
  taskBoard?: TaskBoard;
  /** DiscoveryBoard — 共享发现区，Agent 间交换探索结果 */
  discoveryBoard?: import('../discovery-board').DiscoveryBoard;
}

// ── Agent 句柄 ──
//
// 调用者通过此接口操作 Agent — 不直接接触 Agent 类。
// 继承 ChatAgentHandle 以保持与 ChatCore 的兼容性。

import type { ChatAgentHandle } from '../chat-agent-handle';

export interface AgentHandle extends ChatAgentHandle {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: AgentStatus;
  /** 销毁并注销此 Agent（幂等）。
   *  句柄即所有权 — 创建者持有句柄，生命周期结束时必须 dispose；
   *  调用后 Agent 从 runtime 注册表、MessageBus、LifecycleManager 中完全移除。 */
  dispose(): void;
  /** 把 board proxies 静态绑定到指定会话（正常只调用一次，重复调用为重绑）。
   *  聊天会话的数字 id 在 createAgent 之后才分配 — 会话层在登记句柄时调用，
   *  此后该 Agent 的 board 写入不再随会话切换改变。 */
  bindSession(sessionId: string): void;
}

// ── Agent 概况 ──

export interface AgentSummary {
  id: string;
  parentId: string | null;
  status: AgentStatus;
  description: string;
  subagentDepth: number;
}

// ── UI → Runtime 的调用接口 ──

export interface RuntimePort {
  /** 等待启动恢复完成 — createAgent 前必须 await */
  ready(): Promise<void>;
  /** 创建一个 Agent 实例。返回的句柄拥有该 Agent 的生命周期 —
   *  调用者负责在生命周期结束时 handle.dispose()。 */
  createAgent(config: AgentConfig): Promise<AgentHandle>;
  /** 获取 Agent */
  getAgent(agentId: string): AgentHandle | null;
  /** 销毁所有 Agent — 编排者（Workspace）整体停用时调用。
   *  单个 Agent 的销毁只能经 AgentHandle.dispose()（句柄即所有权），
   *  不提供按 id 的外部销毁入口。 */
  disposeAll(): void;
  /** 获取所有 Agent 概况 */
  listAgents(): AgentSummary[];
  /** 获取指定会话的 TaskBoard（UI 面板用） */
  getTaskBoard(sessionId?: string): TaskBoard;
  /** 获取指定会话的 DiscoveryBoard（UI 面板用） */
  getDiscoveryBoard(sessionId?: string): import('../discovery-board').DiscoveryBoard;
  /** 销毁会话级 board 并删除持久化文件 */
  destroySessionBoards(sessionId: string): Promise<void>;
  /** 切换当前活跃会话 — 仅触发该会话 board 的懒加载恢复（供面板查询），
   *  不改写任何 Agent 的 board 绑定（由 AgentHandle.bindSession 静态绑定） */
  setCurrentSession(sessionId: string): void;
}