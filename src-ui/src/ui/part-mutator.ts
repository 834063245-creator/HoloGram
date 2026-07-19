// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// part-mutator — single source of truth for AgentEvent → AssistantPart[] mutation.
// Used by both main agent (chat-stream.ts) and sub-agent (subagent-sink.ts).
// One function, one implementation — no more drifting duplicates.

import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { AssistantPart } from './message-model';
import { findToolPart, lastTextPart } from './message-model';

/**
 * Apply one AgentEvent to a parts array. Mutates in-place.
 * Returns true if the array was changed.
 *
 * Handles: Reasoning, Text, Message, ToolDispatch, ToolProgress, ToolResult.
 * Does NOT handle: TurnStarted, Usage, Notice, SessionChanged — those have
 * display-specific side effects that callers manage separately.
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
          // Upsert: ToolCallStart + ToolCall both emit ToolDispatch for
          // the same tool id — the second event carries the full args.
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
          if (ev.tool.output) tp.output = (tp.output || '') + ev.tool.output;
          return true;
        }
      }
      return false;

    case EventKind.ToolResult:
      if (ev.tool) {
        const tr = findToolPart(parts, ev.tool.id);
        if (tr) {
          tr.status = ev.tool.err ? 'error' : 'done';
          // ponytail: ToolResult carries the complete final output.
          // REPLACE (not append) — ToolProgress already accumulated incremental
          // chunks, and ToolResult sends the authoritative full result.
          if (!ev.tool.err) tr.output = ev.tool.output;
          if (ev.tool.err) tr.err = ev.tool.err;
          tr.truncated = ev.tool.truncated;
          return true;
        }
      }
      return false;

    default:
      return false;
  }
}
