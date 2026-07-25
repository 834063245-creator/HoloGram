// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// subagent-sink — wraps applyEventToParts with throttled React bump.
// All event→part logic lives in part-mutator.ts; this file only adds the
// throttled rendering layer specific to sub-agent block rendering.

import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { SubAgentPart } from './message-model';
import { applyEventToParts } from './part-mutator';

export interface SubAgentSinkOpts {
  subPart: SubAgentPart;
  /** Called to trigger React re-render (typically bumpChat). Throttled to one
   *  per ~16ms tick so that 5000 streaming tokens don't cause 5000 full
   *  message-list renders. (setTimeout, not rAF — rAF is paused in background
   *  WebView tabs and would stall the stream.) */
  bump: () => void;
  /** Optional: forward tool dispatch names for parent tool-card progress. */
  onProgress?: (chunk: string) => void;
}

/** Create an AgentEvent sink that writes events into a SubAgentPart.
 *  Mutations are delegated to applyEventToParts (shared with main agent).
 *  Bump is throttled to at most one per 16ms tick.
 *  subPart.version counts total mutations for potential fine-grained subscriptions. */
export function createSubAgentSink(opts: SubAgentSinkOpts): (ev: AgentEvent) => void {
  const { subPart, bump } = opts;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    subPart.version++;
    if (timerId !== null) return; // already pending
    timerId = setTimeout(() => {
      timerId = null;
      bump();
    }, 16);
  };

  return (ev: AgentEvent) => {
    const mutated = applyEventToParts(subPart.parts, ev);
    if (!mutated) return;

    // Side effect: forward tool name to parent for progress display
    if (ev.kind === EventKind.ToolDispatch && ev.tool) {
      opts.onProgress?.(`🔧 ${ev.tool.name}\n`);
    }

    tick();
  };
}
