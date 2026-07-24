// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多 Agent 通信层 — 类型定义
//
// 拓扑无关、格式无关的消息总线类型契约。
// MessageBus / Topology / Communication Tools 都依赖这些类型。

// ── Agent 身份与路由 ──

export interface AgentAddress {
  /** agentId 在 runtime 内唯一 */
  agentId: string;
  /** parentId 用于拓扑策略判断（树形） */
  parentId: string | null;
  /** subagentDepth 用于深度限制 */
  depth: number;
}

// ── 消息信封 ──

export interface AgentMessage {
  /** 唯一 ID，用于去重和回复关联 */
  id: string;
  /** 发送者 agentId */
  from: string;
  /** 接收者 agentId，或 'broadcast' 表示广播 */
  to: string;
  /** 消息类型，用于订阅过滤（如 'question', 'result', 'status', 'notification'） */
  type: string;
  /** 消息内容，类型不限 */
  payload: unknown;
  /** 时间戳 */
  ts: number;
  /** 如果是回复某条消息，关联原消息 ID */
  replyTo?: string;
  /** 扩展元数据 */
  meta?: Record<string, unknown>;
}

// ── 订阅过滤 ──

export interface MessageFilter {
  /** 仅匹配特定发送者 */
  from?: string;
  /** 仅匹配特定接收者 */
  to?: string;
  /** 仅匹配特定消息类型 */
  type?: string | string[];
  /** 自定义谓词，最终决定是否匹配 */
  predicate?: (msg: AgentMessage) => boolean;
}

// ── 拓扑策略接口 ──

export interface TopologyPolicy {
  /** 判断 from→to 的消息是否允许通过 */
  canSend(from: string, to: string, bus: { getAgent: (id: string) => AgentAddress | undefined }): boolean;
  /** 返回允许的通信目标列表（供工具描述使用） */
  allowedTargets(agentId: string, bus: { listAgents: () => AgentAddress[] }): string[];
}

// ── 背压策略 ──

export type BackpressureStrategy = 'block' | 'drop' | 'reject';

// ── 持久化接口（Phase 2 实现，Phase 1 为 no-op） ──

export interface MessageStore {
  flush(inboxes: Map<string, AgentMessage[]>): Promise<void>;
  restore(): Promise<Map<string, AgentMessage[]>>;
}

// ── 自定义错误类型 ──

export class TopologyDeniedError extends Error {
  constructor(
    message: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(message);
    this.name = 'TopologyDeniedError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(
    message: string,
    public readonly agentId: string,
  ) {
    super(message);
    this.name = 'AgentNotFoundError';
  }
}

export class InboxFullError extends Error {
  constructor(
    message: string,
    public readonly agentId: string,
  ) {
    super(message);
    this.name = 'InboxFullError';
  }
}

export class MessageNotFoundError extends Error {
  constructor(
    message: string,
    public readonly msgId: string,
  ) {
    super(message);
    this.name = 'MessageNotFoundError';
  }
}

// Phase 2+ 预留（暂不实现）
// export class DeadlockError extends Error { ... }
// export class RequestTimeoutError extends Error { ... }
