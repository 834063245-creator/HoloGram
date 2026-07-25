// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多 Agent 通信层 — LLM 工具定义
//
// Phase 1 提供 5 个工具：
//   agent_message — 异步发送消息（fire-and-forget）
//   agent_reply  — 回复 inbox 中的消息（自动 ack 原消息）
//   agent_ack    — 确认消息已读（从 inbox 移除）
//   agent_inbox  — 查看未读消息列表
//   agent_list   — 列出可通信的 agent
//
// agent_request（同步请求）推迟到 Phase 2+。

import type { MessageBus } from '../message-bus';
import { AgentNotFoundError, InboxFullError, MessageNotFoundError, TopologyDeniedError } from '../message-types';
import type { Tool } from '../tool';

/**
 * 创建通信工具集。闭包捕获 bus 和 agentId，不捕获 Agent 实例。
 * bus 在工具注册时已就绪，execute 时从闭包取值。
 *
 * @param bus    MessageBus 实例
 * @param agentId 调用方 agentId（工具执行时确定）
 */
export function createCommunicationTools(bus: MessageBus, agentId: () => string): Tool[] {
  // ── agent_message — 异步消息 ──
  const agentMessage: Tool = {
    name: () => 'agent_message',
    description: () =>
      'Send a message to another agent. Fire-and-forget — does not wait for a reply. ' +
      'Use agent_list to see which agents you can communicate with.',
    parameters: () => ({
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target agent ID' },
        type: {
          type: 'string',
          description: 'Message type (e.g. "question", "status", "handoff")',
        },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['target', 'type', 'content'],
    }),
    readOnly: () => false,
    execute: async (args) => {
      const target = args.target as string;
      const type = args.type as string;
      const content = args.content as string;
      if (!target || !type || !content) return 'Failed: target, type, and content are required';
      try {
        const msgId = bus.send({
          from: agentId(),
          to: target,
          type,
          payload: content,
        });
        return `Message sent (id: ${msgId})`;
      } catch (e) {
        if (e instanceof TopologyDeniedError) return `Failed: topology denied — you cannot send to '${target}'`;
        if (e instanceof AgentNotFoundError) return `Failed: agent '${target}' not found`;
        if (e instanceof InboxFullError) return `Failed: inbox full for '${target}' (capacity exceeded)`;
        return `Failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };

  // ── agent_reply — 回复消息 ──
  const agentReply: Tool = {
    name: () => 'agent_reply',
    description: () =>
      'Reply to a message received in your inbox. The message_id comes from the inbox notification. ' +
      'Replying also ACKs the original message (removes it from your inbox).',
    parameters: () => ({
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'ID of the message to reply to (from inbox notification)',
        },
        content: { type: 'string', description: 'Reply content' },
      },
      required: ['message_id', 'content'],
    }),
    readOnly: () => false,
    execute: async (args) => {
      const msgId = args.message_id as string;
      const content = args.content as string;
      if (!msgId || !content) return 'Failed: message_id and content are required';
      try {
        const replyId = bus.reply(agentId(), msgId, content);
        return `Reply sent (id: ${replyId})`;
      } catch (e) {
        if (e instanceof MessageNotFoundError)
          return `Failed: message '${msgId}' not found in your inbox. result/reply messages are auto-consumed on injection and cannot be replied to. To send a new message to the agent, use agent_message instead.`;
        if (e instanceof AgentNotFoundError)
          return `Failed: original sender no longer exists (may have been unregistered)`;
        if (e instanceof TopologyDeniedError) return `Failed: topology denied — cannot reply to the original sender`;
        return `Failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };

  // ── agent_ack — 确认已读 ──
  const agentAck: Tool = {
    name: () => 'agent_ack',
    description: () =>
      'Acknowledge a free-type message as read/processed. Removes it from your inbox. ' +
      'Note: result/request/reply messages are auto-consumed on injection and do not need ack.',
    parameters: () => ({
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'ID of the message to acknowledge',
        },
      },
      required: ['message_id'],
    }),
    readOnly: () => false,
    execute: async (args) => {
      const msgId = args.message_id as string;
      if (!msgId) return 'Failed: message_id is required';
      const ok = bus.ackMessage(agentId(), msgId);
      return ok ? `Message ${msgId} acknowledged` : `Message ${msgId} not found in your inbox`;
    },
  };

  // ── agent_inbox — 查看未读消息 ──
  const agentInbox: Tool = {
    name: () => 'agent_inbox',
    description: () =>
      'Query your inbox. With no parameters, returns a summary (count + id/from/type per message, no content). ' +
      'Pass message_id to read a specific message. Filter by sender (from) or type, and limit results. ' +
      'result/reply messages are auto-consumed; only request and free-type messages remain here. ' +
      'Unread messages expire after 30 minutes.',
    parameters: () => ({
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'Read a specific message by ID. Returns full content.',
        },
        from: {
          type: 'string',
          description: 'Filter by sender agent ID.',
        },
        type: {
          type: 'string',
          description: 'Filter by message type (e.g. "request", "status", "handoff").',
        },
        limit: {
          type: 'number',
          description: 'Max messages to return (newest first). Default: all.',
        },
      },
    }),
    readOnly: () => true,
    execute: async (args) => {
      const msgId = args.message_id as string | undefined;
      const from = args.from as string | undefined;
      const type = args.type as string | undefined;
      const limit = args.limit as number | undefined;

      // If no filter at all — return summary only (id/from/type/ts, no payload)
      const summaryOnly = !msgId && !from && !type && !limit;

      const result = bus.queryInbox(agentId(), { msgId, from, type, limit, summaryOnly });

      if (Array.isArray(result)) {
        if (result.length === 0) return '(no matching messages)';
        // Full content — truncate each payload to 2000 chars
        return result
          .map(
            (m) => {
              const payload = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
              const truncated = payload.length > 2000 ? payload.slice(0, 2000) + '…[截断]' : payload;
              return `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${truncated}`;
            },
          )
          .join('\n\n');
      }

      // Summary mode
      if (result.messages.length === 0) return '(inbox empty)';
      const lines = result.messages
        .map((m) => `- [msg_id:${m.id}] from:${m.from} type:${m.type}`)
        .join('\n');
      return `Inbox: ${result.count} 条消息\n${lines}\n\n用 message_id 参数查看具体消息内容。`;
    },
  };

  // ── agent_list — 列出可通信的 agent ──
  const agentList: Tool = {
    name: () => 'agent_list',
    description: () => 'List all agents you can communicate with, based on the current topology.',
    parameters: () => ({
      type: 'object',
      properties: {},
    }),
    readOnly: () => true,
    execute: async () => {
      const topology = bus.getTopology();
      const targets = topology.allowedTargets(agentId(), bus);
      if (targets.length === 0) return '(no communicable agents)';
      return targets.map((id) => `- ${id}`).join('\n');
    },
  };

  return [agentMessage, agentReply, agentAck, agentInbox, agentList];
}
