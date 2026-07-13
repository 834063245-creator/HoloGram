// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// subagent-sink — converts AgentEvent stream into SubAgentPart mutations.
// Extracted from agent.ts:spawnSubAgent so it can be unit-tested independently.
//
// ponytail: this is where the event→part mapping lives. If a new event kind
// should appear in sub-agent blocks, add the case here AND in the test.

import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { SubAgentPart } from '../ui/message-model';
import { lastTextPart, lastReasoningPart, findToolPart } from '../ui/message-model';

export interface SubAgentSinkOpts {
  subPart: SubAgentPart;
  /** Called after each mutation to trigger React re-render (typically bumpChat). */
  bump: () => void;
  /** Optional: forward tool dispatch names for parent tool-card progress. */
  onProgress?: (chunk: string) => void;
}

/** Create an AgentEvent sink that writes events into a SubAgentPart.
 *  Mutations are in-place; the `bump` callback triggers Zustand → React.
 *  subPart.version is also bumped on every change for potential fine-grained
 *  subscriptions in the future. */
export function createSubAgentSink(opts: SubAgentSinkOpts): (ev: AgentEvent) => void {
  const { subPart, bump, onProgress } = opts;

  const tick = () => { subPart.version++; bump(); };

  return (ev: AgentEvent) => {
    switch (ev.kind) {
      case EventKind.Reasoning:
        if (ev.text) {
          const last = lastReasoningPart(subPart.parts);
          if (last) { last.text += ev.text; }
          else { subPart.parts.push({ type: 'reasoning', text: ev.text }); }
          tick();
        }
        break;

      case EventKind.Text:
        if (ev.text) {
          const last = lastTextPart(subPart.parts);
          if (last && !last.finalised) { last.text += ev.text; }
          else { subPart.parts.push({ type: 'text', text: ev.text, finalised: false }); }
          tick();
        }
        break;

      case EventKind.Message:
        { const lt = lastTextPart(subPart.parts); if (lt) lt.finalised = true; tick(); }
        break;

      case EventKind.ToolDispatch:
        if (ev.tool) {
          subPart.parts.push({
            type: 'tool', toolId: ev.tool.id, name: ev.tool.name,
            args: ev.tool.args || '', label: ev.tool.name,
            readOnly: ev.tool.read_only ?? false,
            status: ev.tool.partial ? 'pending' : 'running',
          });
          tick();
          if (onProgress) onProgress(`🔧 ${ev.tool.name}\n`);
        }
        break;

      case EventKind.ToolProgress:
        if (ev.tool) {
          const tp = findToolPart(subPart.parts, ev.tool.id);
          if (tp) { tp.status = 'running'; if (ev.tool.output) tp.output = (tp.output || '') + ev.tool.output; tick(); }
        }
        break;

      case EventKind.ToolResult:
        if (ev.tool) {
          const tr = findToolPart(subPart.parts, ev.tool.id);
          if (tr) {
            tr.status = ev.tool.err ? 'error' : 'done';
            if (!ev.tool.err) tr.output = ev.tool.output;
            if (ev.tool.err) tr.err = ev.tool.err;
            tr.truncated = ev.tool.truncated;
            tick();
          }
        }
        break;

      // TurnStarted, Usage, SessionChanged, Notice — intentionally ignored
    }
  };
}
