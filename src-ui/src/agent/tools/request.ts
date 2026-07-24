// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent_request — 同步请求，阻塞等待回复
//
// 基于 MessageBus 的 send + subscribe 实现，不修改 runLoop。
// 核心流程：
//   Agent A 调 agent_request(target=B, type="question", content="...")
//     → bus.send({ from: A, to: B, type: "request", ... })
//     → bus.subscribe({ replyTo: msgId }) — 等待回复
//     → Promise.race([replyPromise, timeoutPromise])
//     → B 收到消息（_injectInbox 注入），用 agent_reply 回复
//     → bus.reply 触发 replyTo 匹配的 subscribe handler
//     → resolve(replyPayload) 或 timeout
//
// 不做死锁检测 — timeout 兜底是工业标准（Erlang gen_server 40 年验证）。

import type { MessageBus } from '../message-bus';
import type { Tool } from '../tool';

export function createRequestTool(bus: MessageBus, getAgentId: () => string): Tool {
  return {
    name: () => 'agent_request',
    description: () =>
      'Send a synchronous request to another agent and wait for a reply. ' +
      'Blocks until the target agent replies or timeout expires. ' +
      'Use agent_message for fire-and-forget; use agent_request when you need a direct answer. ' +
      'Timeout defaults to 30s (max 120s). The target agent must use agent_reply to respond.',
    parameters: () => ({
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Target agent ID to send the request to',
        },
        type: {
          type: 'string',
          description: 'Request type (e.g. "question", "lookup", "verify")',
        },
        content: {
          type: 'string',
          description: 'Request content — what you want the other agent to do or answer',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds (default 30, max 120)',
        },
      },
      required: ['target', 'type', 'content'],
    }),
    readOnly: () => false,
    execute: async (args) => {
      const target = args.target as string;
      const type = args.type as string;
      const content = args.content as string;
      const timeoutSec = Math.min((args.timeout_seconds as number) ?? 30, 120);
      const from = getAgentId();

      if (!target || !type || !content) {
        return 'Failed: target, type, and content are required';
      }

      // 拓扑检查
      if (!bus.canSend(from, target)) {
        return `Failed: topology denied — you cannot request from '${target}'. Check agent_list for allowed targets.`;
      }

      // Check target exists
      try {
        bus.canSend(from, target); // already checked above
      } catch {
        return `Failed: agent '${target}' not found`;
      }

      // 发送请求消息
      let msgId: string;
      try {
        msgId = bus.send({
          from,
          to: target,
          type: 'request',
          payload: content,
          meta: { requestType: type },
        });
      } catch (e: any) {
        return `Failed to send request: ${e?.message || String(e)}`;
      }

      // 等待回复 — subscribe 匹配 replyTo = msgId
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          unsub();
          resolve(`请求超时（${timeoutSec}s）— ${target} 未在时限内回复。消息仍在对方 inbox 中，你可用 agent_message 跟进。`);
        }, timeoutSec * 1000);

        const unsub = bus.subscribe(
          {
            to: from,
            predicate: (msg) => msg.replyTo === msgId,
          },
          (reply) => {
            clearTimeout(timer);
            unsub();
            const payload =
              typeof reply.payload === 'string'
                ? reply.payload
                : JSON.stringify(reply.payload);
            resolve(`回复来自 ${reply.from}:\n${payload}`);
          },
        );
      });
    },
  };
}
