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

import { z } from 'zod';
import type { MessageBus } from '../message-bus';
import { AgentNotFoundError, InboxFullError, MessageNotFoundError, TopologyDeniedError } from '../message-types';
import type { Tool } from '../tool';
import { defineTool } from './define-tool';

/**
 * 创建通信工具集。闭包捕获 bus 和 agentId，不捕获 Agent 实例。
 * bus 在工具注册时已就绪，execute 时从闭包取值。
 *
 * @param bus    MessageBus 实例
 * @param agentId 调用方 agentId（工具执行时确定）
 */
export function createCommunicationTools(bus: MessageBus, agentId: () => string): Tool[] {
  return [
    // ── agent_message — 异步消息 ──
    defineTool({
      name: 'agent_message',
      description:
        'Send a message to another agent. Fire-and-forget — does not wait for a reply. ' +
        'Use agent_list to see which agents you can communicate with.',
      schema: z.object({
        target: z.string().describe('Target agent ID'),
        type: z.string().describe('Message type (e.g. "question", "status", "handoff")'),
        content: z.string().describe('Message content'),
      }),
      execute: async (args) => {
        try {
          const msgId = bus.send({
            from: agentId(),
            to: args.target,
            type: args.type,
            payload: args.content,
          });
          return `Message sent (id: ${msgId})`;
        } catch (e) {
          if (e instanceof TopologyDeniedError) return `Failed: topology denied — you cannot send to '${args.target}'`;
          if (e instanceof AgentNotFoundError) return `Failed: agent '${args.target}' not found`;
          if (e instanceof InboxFullError) return `Failed: inbox full for '${args.target}' (capacity exceeded)`;
          return `Failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    // ── agent_reply — 回复消息 ──
    defineTool({
      name: 'agent_reply',
      description:
        'Reply to a message received in your inbox. The message_id comes from the inbox notification. ' +
        'Replying also ACKs the original message (removes it from your inbox).',
      schema: z.object({
        message_id: z.string().describe('ID of the message to reply to (from inbox notification)'),
        content: z.string().describe('Reply content'),
      }),
      execute: async (args) => {
        try {
          const replyId = bus.reply(agentId(), args.message_id, args.content);
          return `Reply sent (id: ${replyId})`;
        } catch (e) {
          if (e instanceof MessageNotFoundError)
            return `Failed: message '${args.message_id}' not found in your inbox. result/reply messages are auto-consumed on injection and cannot be replied to. To send a new message to the agent, use agent_message instead.`;
          if (e instanceof AgentNotFoundError)
            return `Failed: original sender no longer exists (may have been unregistered)`;
          if (e instanceof TopologyDeniedError) return `Failed: topology denied — cannot reply to the original sender`;
          return `Failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    // ── agent_ack — 确认已读 ──
    defineTool({
      name: 'agent_ack',
      description:
        'Acknowledge a free-type message as read/processed. Removes it from your inbox. ' +
        'Note: result/request/reply messages are auto-consumed on injection and do not need ack.',
      schema: z.object({
        message_id: z.string().describe('ID of the message to acknowledge'),
      }),
      execute: async (args) => {
        const ok = bus.ackMessage(agentId(), args.message_id);
        return ok ? `Message ${args.message_id} acknowledged` : `Message ${args.message_id} not found in your inbox`;
      },
    }),

    // ── agent_inbox — 查看未读消息 ──
    defineTool({
      name: 'agent_inbox',
      description:
        'Query your inbox. With no parameters, returns a summary (count + id/from/type per message, no content). ' +
        'Pass message_id to read a specific message. Filter by sender (from) or type, and limit results. ' +
        'result/reply messages are auto-consumed; only request and free-type messages remain here. ' +
        'Unread messages expire after 30 minutes.',
      schema: z.object({
        message_id: z.string().optional().describe('Read a specific message by ID. Returns full content.'),
        from: z.string().optional().describe('Filter by sender agent ID.'),
        type: z.string().optional().describe('Filter by message type (e.g. "request", "status", "handoff").'),
        limit: z.number().optional().describe('Max messages to return (newest first). Default: all.'),
      }),
      readOnly: true,
      execute: async (args) => {
        // 无任何过滤条件 — 仅返回摘要（id/from/type/ts，不含内容）
        const summaryOnly = !args.message_id && !args.from && !args.type && !args.limit;

        const result = bus.queryInbox(agentId(), {
          msgId: args.message_id,
          from: args.from,
          type: args.type,
          limit: args.limit,
          summaryOnly,
        });

        if (Array.isArray(result)) {
          if (result.length === 0) return '(no matching messages)';
          // 完整内容 — 每条 payload 截断到 2000 字符
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

        // 摘要模式
        if (result.messages.length === 0) return '(inbox empty)';
        const lines = result.messages
          .map((m) => `- [msg_id:${m.id}] from:${m.from} type:${m.type}`)
          .join('\n');
        return `Inbox: ${result.count} 条消息\n${lines}\n\n用 message_id 参数查看具体消息内容。`;
      },
    }),

    // ── agent_list — 列出可通信的 agent ──
    defineTool({
      name: 'agent_list',
      description: 'List all agents you can communicate with, based on the current topology.',
      schema: z.object({}),
      readOnly: true,
      execute: async () => {
        const topology = bus.getTopology();
        const targets = topology.allowedTargets(agentId(), bus);
        if (targets.length === 0) return '(no communicable agents)';
        return targets.map((id) => `- ${id}`).join('\n');
      },
    }),
  ];
}
