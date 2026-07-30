// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// part-mutator — AgentEvent → AssistantPart[] 变更的唯一真相源。
// 主 agent（chat-stream.ts）和子 agent（subagent-sink.ts）共用。
// 一个函数，一套实现 — 不再有漂移的重复代码。

import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { AssistantPart } from './message-model';
import { findToolPart, lastTextPart } from './message-model';

/**
 * 将一个 AgentEvent 应用到 parts 数组。原地变更。
 * 数组有变化时返回 true。
 *
 * 处理：Reasoning、Text、Message、ToolDispatch、ToolProgress、ToolResult。
 * 不处理：TurnStarted、Usage、Notice、SessionChanged — 这些有显示特定的
 * 副作用，由调用方单独管理。
 */
export function applyEventToParts(parts: AssistantPart[], ev: AgentEvent): boolean {
  switch (ev.kind) {
    case EventKind.Reasoning:
      if (ev.text) {
        const last = parts.length > 0 ? parts[parts.length - 1] : null;
        if (last && last.type === 'reasoning') {
          last.text += ev.text;
        } else {
          parts.push({ type: 'reasoning', text: ev.text });
        }
        return true;
      }
      return false;

    case EventKind.Text:
      if (ev.text) {
        const last = lastTextPart(parts);
        if (last && !last.finalised) {
          last.text += ev.text;
        } else {
          parts.push({ type: 'text', text: ev.text, finalised: false });
        }
        return true;
      }
      return false;

    case EventKind.Message: {
      const lt = lastTextPart(parts);
      if (lt) lt.finalised = true;
      return true;
    }

    case EventKind.ToolDispatch:
      if (ev.tool) {
        const existing = findToolPart(parts, ev.tool.id);
        if (existing) {
          // Upsert：ToolCallStart + ToolCall 都发出同一 toolId 的
          // ToolDispatch — 第二个事件携带完整参数。
          existing.status = ev.tool.partial ? 'pending' : 'running';
          if (ev.tool.args && ev.tool.args.length > existing.args.length) {
            existing.args = ev.tool.args;
          }
          if (ev.tool.name) existing.name = ev.tool.name;
        } else {
          parts.push({
            type: 'tool',
            toolId: ev.tool.id,
            name: ev.tool.name,
            args: ev.tool.args || '',
            label: ev.tool.name,
            readOnly: ev.tool.read_only ?? false,
            status: ev.tool.partial ? 'pending' : 'running',
          });
        }
        return true;
      }
      return false;

    case EventKind.ToolProgress:
      if (ev.tool) {
        const tp = findToolPart(parts, ev.tool.id);
        if (tp) {
          tp.status = 'running';
          if (ev.tool.output) {
            // ponytail: 写入/编辑工具替换（预览内容随模型流式增长），
            // shell 工具追加（stdout 块累积）
            const isWrite = tp.name === 'write_file' || tp.name === 'write_file_content' || tp.name === 'edit_file';
            tp.output = isWrite ? ev.tool.output : (tp.output || '') + ev.tool.output;
          }
          return true;
        }
      }
      return false;

    case EventKind.ToolResult:
      if (ev.tool) {
        const tr = findToolPart(parts, ev.tool.id);
        if (tr) {
          tr.status = ev.tool.err ? 'error' : 'done';
          // ponytail: ToolResult 携带完整的最终输出。
          // 替换（非追加）— ToolProgress 已累积增量块，
          // ToolResult 发送权威的完整结果。
          if (!ev.tool.err) tr.output = ev.tool.output;
          if (ev.tool.err) {
            tr.err = ev.tool.err;
            tr.output = undefined;
          }
          tr.truncated = ev.tool.truncated;
          return true;
        }
      }
      return false;

    default:
      return false;
  }
}
