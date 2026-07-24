// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多 Agent 通信层 — MessageBus 核心实现
//
// 拓扑无关、格式无关的异步消息总线。
// Phase 1：仅异步 send（发完即走），不包含同步 request。
//
// 核心设计：
//   - 每个 agent 有有界 inbox，满了不会 OOM（背压控制）
//   - 消息保留在 inbox 直到被显式 ack（peek + ack 模型）
//   - msgIndex 提供 O(1) 消息查找（reply / ack 不需遍历）
//   - 拓扑策略注入，默认 TreeTopology
//   - 传输层可替换（InProcessTransport 默认，未来可换跨进程/跨机器）

import type {
  AgentAddress,
  AgentMessage,
  BackpressureStrategy,
  MessageFilter,
  MessageStore,
  MessageTransport,
  TopologyPolicy,
} from './message-types';
import { AgentNotFoundError, InboxFullError, MessageNotFoundError, TopologyDeniedError } from './message-types';
import { TreeTopology } from './topology';

const DEFAULT_INBOX_CAPACITY = 100;
const DEFAULT_BACKPRESSURE: BackpressureStrategy = 'reject';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── InProcessTransport — 内存直达传输 ──
//
// 把消息直接写入目标 agent 的 inbox 数组。
// 未来可替换为 TauriEventTransport / RpcTransport。

class InProcessTransport implements MessageTransport {
  constructor(
    private inboxes: Map<string, AgentMessage[]>,
    private msgIndex: Map<string, { agentId: string; index: number }>,
    private getCapacity: () => number,
    private getStrategy: () => BackpressureStrategy,
  ) {}

  deliver(agentId: string, msg: AgentMessage): void {
    let inbox = this.inboxes.get(agentId);
    if (!inbox) {
      inbox = [];
      this.inboxes.set(agentId, inbox);
    }

    const capacity = this.getCapacity();
    const strategy = this.getStrategy();

    // 检查 inbox 容量
    if (inbox.length >= capacity) {
      switch (strategy) {
        case 'reject':
          throw new InboxFullError(`inbox full for '${agentId}' (capacity ${capacity} exceeded)`, agentId);
        case 'drop': {
          // 移除最旧消息
          const oldest = inbox.shift();
          if (oldest) this.msgIndex.delete(oldest.id);
          break;
        }
        case 'block':
          // Phase 1 中不适用 — 仅同步 request 场景，Phase 2+
          throw new InboxFullError(`inbox full for '${agentId}' (block strategy not supported in Phase 1)`, agentId);
      }
    }

    const index = inbox.length;
    inbox.push(msg);
    this.msgIndex.set(msg.id, { agentId, index });
  }
}

export class MessageBus {
  // 注册的 agent 地址表
  private agents = new Map<string, AgentAddress>();

  // 每个 agent 的 inbox（有界队列）— 消息保留直到被 ack
  private inboxes = new Map<string, AgentMessage[]>();

  // 消息索引：msgId → { agentId, index } — O(1) 查找
  private msgIndex = new Map<string, { agentId: string; index: number }>();

  // 订阅者列表
  private subscribers = [] as {
    filter: MessageFilter;
    handler: (msg: AgentMessage) => void;
  }[];

  // 拓扑策略
  private topology: TopologyPolicy = new TreeTopology();

  // 持久化后端（Phase 1: null → flush/restore 为 no-op）
  private store: MessageStore | null = null;

  // 背压配置
  private inboxCapacity = DEFAULT_INBOX_CAPACITY;
  private backpressureStrategy: BackpressureStrategy = DEFAULT_BACKPRESSURE;

  // 消息到达回调 — agent idle 时用来唤醒 runLoop
  private wakeCallbacks = new Map<string, () => void>();

  // 传输层 — 可替换（默认 InProcessTransport）
  private transport: MessageTransport;

  constructor(transport?: MessageTransport) {
    this.transport =
      transport ??
      new InProcessTransport(
        this.inboxes,
        this.msgIndex,
        () => this.inboxCapacity,
        () => this.backpressureStrategy,
      );
  }

  // ── 注册 ──

  /** 注册 agent 地址。可选传入 onWake 回调 — 消息到达时触发，用于唤醒 idle agent。 */
  register(addr: AgentAddress, onWake?: () => void): void {
    this.agents.set(addr.agentId, addr);
    if (!this.inboxes.has(addr.agentId)) {
      this.inboxes.set(addr.agentId, []);
    }
    if (onWake) {
      this.wakeCallbacks.set(addr.agentId, onWake);
    }
  }

  unregister(agentId: string): void {
    // 清理 inbox + msgIndex 中属于该 agent 的条目
    const inbox = this.inboxes.get(agentId);
    if (inbox) {
      for (const msg of inbox) {
        this.msgIndex.delete(msg.id);
      }
    }
    this.inboxes.delete(agentId);
    this.agents.delete(agentId);
    this.wakeCallbacks.delete(agentId);
  }

  // ── 通信原语（Phase 1: 仅异步） ──

  /** 投递消息到 inbox + 触发唤醒回调 */
  private _deliver(agentId: string, msg: AgentMessage): void {
    this.transport.deliver(agentId, msg);
    this.transport.onDelivered?.(agentId);
    // 投递成功后触发唤醒 — agent idle 时用来启动 runLoop
    this.wakeCallbacks.get(agentId)?.();
  }

  /** 异步发送：发完即走，不等待回复。返回消息 ID */
  send(msg: Omit<AgentMessage, 'id' | 'ts'> & { from: string }): string {
    const fullMsg: AgentMessage = {
      id: generateId(),
      ts: Date.now(),
      from: msg.from,
      to: msg.to,
      type: msg.type,
      payload: msg.payload,
      replyTo: msg.replyTo,
      meta: msg.meta,
    };

    // ── 查找目标 agent（在拓扑检查之前，确保未注册的 agent 报 AgentNotFoundError 而非 TopologyDeniedError） ──
    if (!this.agents.has(fullMsg.to)) {
      throw new AgentNotFoundError(`agent '${fullMsg.to}' not found`, fullMsg.to);
    }

    // ── 拓扑策略检查 ──
    if (!this.topology.canSend(fullMsg.from, fullMsg.to, this)) {
      throw new TopologyDeniedError(`topology denied: ${fullMsg.from} → ${fullMsg.to}`, fullMsg.from, fullMsg.to);
    }

    // ── 投递到 inbox + 触发唤醒 ──
    this._deliver(fullMsg.to, fullMsg);

    // ── 通知订阅者 ──
    this._notifySubscribers(fullMsg);

    // Phase 2: 实现内容指纹去重 hash(from+to+type+payload)

    return fullMsg.id;
  }

  /** 回复某条消息 — 回复消息的 replyTo 自动设为 originalMsgId。
   *  callerId = 回复者的 agentId（只搜自己的 inbox 找原消息） */
  reply(callerId: string, originalMsgId: string, payload: unknown, meta?: Record<string, unknown>): string {
    // 在 callerId 的 inbox 中查找原消息（O(1) via msgIndex）
    const entry = this.msgIndex.get(originalMsgId);
    if (!entry || entry.agentId !== callerId) {
      throw new MessageNotFoundError(`message '${originalMsgId}' not found in inbox of '${callerId}'`, originalMsgId);
    }

    const inbox = this.inboxes.get(callerId);
    if (!inbox) {
      throw new MessageNotFoundError(`inbox for '${callerId}' not found`, originalMsgId);
    }

    // 找到原消息 — index 可能因 splice 失效，回退到线性搜索
    let originalMsg = inbox[entry.index];
    if (!originalMsg || originalMsg.id !== originalMsgId) {
      const found = inbox.find((m) => m.id === originalMsgId);
      if (!found) {
        throw new MessageNotFoundError(`message '${originalMsgId}' not found in inbox`, originalMsgId);
      }
      originalMsg = found;
    }

    // 构造回复消息
    const replyMsg: AgentMessage = {
      id: generateId(),
      ts: Date.now(),
      from: callerId,
      to: originalMsg.from,
      type: 'reply',
      payload,
      replyTo: originalMsgId,
      meta,
    };

    // ── 先检查拓扑 + 目标存在性，都通过后才移除原消息 ──
    // 这样如果投递失败，原消息仍在 inbox 中不会丢失

    if (!this.agents.has(replyMsg.to)) {
      throw new AgentNotFoundError(
        `agent '${replyMsg.to}' not found (original sender may have been unregistered)`,
        replyMsg.to,
      );
    }

    if (!this.topology.canSend(replyMsg.from, replyMsg.to, this)) {
      throw new TopologyDeniedError(
        `topology denied for reply: ${replyMsg.from} → ${replyMsg.to}`,
        replyMsg.from,
        replyMsg.to,
      );
    }

    // 全部通过 — 移除原消息（自动 ack）+ 投递回复
    this._removeFromInbox(callerId, originalMsgId);
    this._deliver(replyMsg.to, replyMsg);
    this._notifySubscribers(replyMsg);

    return replyMsg.id;
  }

  /** 广播：当前 scope 内所有 agent 收到（受拓扑策略限制） */
  broadcast(from: string, type: string, payload: unknown, meta?: Record<string, unknown>): string[] {
    const delivered: string[] = [];
    const msg: AgentMessage = {
      id: generateId(),
      ts: Date.now(),
      from,
      to: 'broadcast',
      type,
      payload,
      meta,
    };

    for (const [agentId] of this.agents) {
      if (agentId === from) continue;
      if (this.topology.canSend(from, agentId, this)) {
        try {
          // 为每个接收者创建独立的副本（独立 ID 以便 msgIndex 追踪）
          const copy: AgentMessage = { ...msg, id: generateId(), to: agentId };
          this._deliver(agentId, copy);
          this._notifySubscribers(copy);
          delivered.push(agentId);
        } catch {
          // 单个 agent 投递失败不影响其他 agent
        }
      }
    }

    return delivered;
  }

  // ── 订阅 ──

  subscribe(filter: MessageFilter, handler: (msg: AgentMessage) => void): () => void {
    const sub = { filter, handler };
    this.subscribers.push(sub);
    return () => {
      const idx = this.subscribers.indexOf(sub);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  // ── Inbox ──

  peekInbox(agentId: string): AgentMessage[] {
    return this.inboxes.get(agentId) ?? [];
  }

  ackMessage(agentId: string, msgId: string): boolean {
    return this._removeFromInbox(agentId, msgId);
  }

  unreadCount(agentId: string): number {
    return this.inboxes.get(agentId)?.length ?? 0;
  }

  // ── 拓扑策略 ──

  setTopology(policy: TopologyPolicy): void {
    this.topology = policy;
  }

  /** 暴露拓扑策略给外部（工具层用） */
  getTopology(): TopologyPolicy {
    return this.topology;
  }

  // ── 背压配置 ──

  setInboxCapacity(capacity: number): void {
    this.inboxCapacity = capacity;
  }

  setBackpressureStrategy(strategy: BackpressureStrategy): void {
    this.backpressureStrategy = strategy;
  }

  // ── 持久化（Phase 1: no-op；Phase 2 实现） ──

  async flush(): Promise<void> {
    if (!this.store) return;
    await this.store.flush(this.inboxes);
  }

  async restore(): Promise<void> {
    if (!this.store) return;
    const restored = await this.store.restore();
    for (const [agentId, msgs] of restored) {
      this.inboxes.set(agentId, msgs);
      for (let i = 0; i < msgs.length; i++) {
        this.msgIndex.set(msgs[i].id, { agentId, index: i });
      }
    }
  }

  // ── TopologyPolicy 适配器方法 ──

  getAgent(id: string): AgentAddress | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentAddress[] {
    return Array.from(this.agents.values());
  }

  // ── 内部方法 ──

  private _removeFromInbox(agentId: string, msgId: string): boolean {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return false;

    const entry = this.msgIndex.get(msgId);
    if (!entry || entry.agentId !== agentId) return false;

    // 线性查找（index 可能因之前的移除而不准确）
    const idx = inbox.findIndex((m) => m.id === msgId);
    if (idx < 0) return false;

    inbox.splice(idx, 1);
    this.msgIndex.delete(msgId);

    // 重建该 inbox 中剩余消息的 index
    for (let i = idx; i < inbox.length; i++) {
      this.msgIndex.set(inbox[i].id, { agentId, index: i });
    }

    return true;
  }

  private _notifySubscribers(msg: AgentMessage): void {
    for (const sub of this.subscribers) {
      if (this._matchesFilter(msg, sub.filter)) {
        try {
          sub.handler(msg);
        } catch {
          // 订阅者异常不影响其他订阅者和消息投递
        }
      }
    }
  }

  private _matchesFilter(msg: AgentMessage, filter: MessageFilter): boolean {
    if (filter.from && msg.from !== filter.from) return false;
    if (filter.to && msg.to !== filter.to) return false;
    if (filter.type) {
      if (Array.isArray(filter.type)) {
        if (!filter.type.includes(msg.type)) return false;
      } else {
        if (msg.type !== filter.type) return false;
      }
    }
    if (filter.predicate && !filter.predicate(msg)) return false;
    return true;
  }
}
