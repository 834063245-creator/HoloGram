// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Stream — streaming render pipeline
// ponytail: messages live in per-session stores (getMessagesStore(`${storeId}:${sid}`)).
// No panel-level messages array, no sessionMessageModels cache, no manual sync.
// Streaming writes directly to the session's store — always correct regardless of
// which tab is active.

import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import { autoTitleSessionIfDefault } from './chat-session';
import { bumpChat, getChatStore } from './chat-store';
import type { StarGraph } from './graph';
import type { AssistantMessage, ChatMessage, FileAttachment, MessageId, UserMessage } from './message-model';
import { createAssistantMessage, createNoticeMessage, createUserMessage } from './message-model';
import { applyEventToParts } from './part-mutator';

// ── Turn pair type (shared with chat-session) ──
type TurnPair = {
  userText: string;
  userBubble: HTMLElement | null;
  assistantBubble: HTMLElement | null;
  sessionIndex: number;
};

// ── StreamContext ──────────────────────────────────────────

export interface StreamContext {
  storeId: string;

  // ── Per-session messages stores (ponytail: single source of truth) ──
  getSessionMessages: (sid: number) => ChatMessage[];
  getActiveMessages: () => ChatMessage[];
  setSessionMessages: (sid: number, msgs: ChatMessage[]) => void;
  bumpSessionMessages: (sid: number) => void;

  // ── Streaming state (panel-level — one stream per panel) ──
  getStreamingAssistantId: () => MessageId | null;
  setStreamingAssistantId: (id: MessageId | null) => void;
  getUserScrolledUp: () => boolean;
  setUserScrolledUp: (v: boolean) => void;
  getSyncRafId: () => number | null;
  setSyncRafId: (id: number | null) => void;

  // ── Streaming target session (replaces _pendingStreamingSessions global Map) ──
  getStreamingTargetSid: () => number | null;
  setStreamingTargetSid: (sid: number | null) => void;

  // ── turnPairs ──
  getTurnPairs: () => TurnPair[];

  // ── Agent ──
  getAgent: () => ChatAgentHandle | null;

  // ── Graph ──
  getStarGraph: () => StarGraph | null;

  // ── Callbacks ──
  updateFooter: () => void;
  setLastUsageText: (s: string) => void;
  addNotice: (text: string, level?: string) => void;
  saveActiveSession: (path: string) => Promise<void>;
  scheduleAutoSave: (path: string) => void;
  bumpPillBadge: () => void;
  animateBubbleIn: (el: HTMLElement, delay?: number) => any;
  setRunning: (r: boolean) => void;
  abort: () => void;
  _updateStatusBar: (state: 'idle' | 'thinking' | 'running' | 'error', detail?: string) => void;
  _recordToolUsage: (toolName: string, args: string) => void;
  _retractUserMessage: (msg: UserMessage) => void;
  retractTurn: (idx: number) => string | null;
  sendMessage: () => Promise<void>;
  _updateTokens: (tokensUsed: number) => void;

  getProjectPath: () => string;
  getRunning: () => boolean;
  getAbortCtrl: () => AbortController | null;
  setAbortCtrl: (c: AbortController | null) => void;
  getExpandedReasoning: () => Set<number>;
}

// ── Session routing ───────────────────────────────────────
// ponytail: resolve which session owns the streaming assistant.
// Strategy:
//   1. If assistantId is known → scan session stores for it (O(sessions), ≤10)
//   2. If no assistant yet → check pendingStreamingSession (set by sendMessage before agent.run)
//   3. Fallback → active session
// This prevents the race where user switches tabs after sendMessage but before
// the first text event arrives (streamingAssistantId still null at that point).

interface SessionTarget {
  sessionId: number;
  messages: ChatMessage[];
  isActive: boolean;
}

/** Track which session started the current streaming run.
 *  Set by sendMessage (or sendAgentText/runGoal) before agent.run(),
 *  cleared in _finaliseStreamingAssistant or by the caller's finally block.
 *  Now stored on RenderContext (getStreamingTargetSid/setStreamingTargetSid)
 *  instead of a module-level Map — eliminates global mutable state. */

function _resolveSessionTarget(ctx: StreamContext, assistantId: MessageId | null): SessionTarget | null {
  const sessStore = getChatStore(ctx.storeId).sess;
  const { sessions, activeIdx } = sessStore.getState();
  const activeSid = sessions[activeIdx]?.id;

  // 1) Known assistant → find its owner session
  if (assistantId) {
    for (const s of sessions) {
      const msgs = ctx.getSessionMessages(s.id);
      if (msgs.some((m) => m._id === assistantId)) {
        return { sessionId: s.id, messages: msgs, isActive: s.id === activeSid };
      }
    }
  }

  // 2) No assistant yet → use the session that started the run
  const pendingSid = ctx.getStreamingTargetSid();
  if (pendingSid != null) {
    const msgs = ctx.getSessionMessages(pendingSid);
    return { sessionId: pendingSid, messages: msgs, isActive: pendingSid === activeSid };
  }

  // 3) Last resort: active session
  if (activeSid != null) {
    return {
      sessionId: activeSid,
      messages: ctx.getActiveMessages(),
      isActive: true,
    };
  }
  return null;
}

// ── Streaming assistant helper ─────────────────────────────

function _streamingAssistant(ctx: StreamContext): AssistantMessage {
  const id = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, id);
  if (!target) {
    // ponytail: no session → can't render. Shouldn't happen (panel always has ≥1 session).
    return createAssistantMessage('');
  }

  const msgs = target.messages;

  if (id) {
    const found = msgs.find((m) => m.role === 'assistant' && m._id === id) as AssistantMessage | undefined;
    if (found) return found;
  }

  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const assistant = createAssistantMessage(lastUser?._id ?? '');
  msgs.push(assistant);
  ctx.setStreamingAssistantId(assistant._id);

  // Persist + bump the session's store
  ctx.setSessionMessages(target.sessionId, [...msgs]);
  ctx.bumpSessionMessages(target.sessionId);
  // ponytail: assistant ID is now established — future events find it via
  // session store scan. Streaming target no longer needed for this run.
  ctx.setStreamingTargetSid(null);
  return assistant;
}

/** Push a notice message to the log. */
export function _addNoticeMessage(ctx: StreamContext, text: string, level: 'info' | 'warn' | 'error'): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, sid);
  if (!target) return;

  const msgs = target.messages;
  if (sid) {
    const assistIdx = msgs.findIndex((m) => m.role === 'assistant' && (m as AssistantMessage)._id === sid);
    if (assistIdx >= 0) {
      msgs.splice(assistIdx, 0, createNoticeMessage(text, level));
    } else {
      msgs.push(createNoticeMessage(text, level));
    }
  } else {
    msgs.push(createNoticeMessage(text, level));
  }
  ctx.setSessionMessages(target.sessionId, [...msgs]);
  _scheduleSync(ctx);
}

// ── Public notice ──

export function addNotice(ctx: StreamContext, text: string, level: 'info' | 'warn' | 'error'): void {
  _addNoticeMessage(ctx, text, level);
}

// ═══════════════════════════════════════════════════════════
// _finaliseStreamingAssistant
// ═══════════════════════════════════════════════════════════

/** Mark the current streaming assistant as done. */
export function _finaliseStreamingAssistant(ctx: StreamContext): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, sid);
  const msgs = target ? target.messages : ctx.getActiveMessages();

  const assistant = msgs.find((m) => m.role === 'assistant' && m._id === sid) as AssistantMessage | undefined;
  if (assistant) {
    assistant.status = 'done';
    for (const part of assistant.parts) {
      if (part.type === 'text') (part as any).finalised = true;
      if (part.type === 'tool' && ((part as any).status === 'running' || (part as any).status === 'pending')) {
        (part as any).status = 'error';
      }
    }
  }

  // Flush pending render
  const timerId = ctx.getSyncRafId();
  if (timerId !== null) {
    clearTimeout(timerId);
    ctx.setSyncRafId(null);
  }

  // Final bump while streamingAssistantId is still set
  if (sid && target) {
    ctx.setSessionMessages(target.sessionId, [...msgs]);
    ctx.bumpSessionMessages(target.sessionId);
  } else if (sid) {
    bumpChat(ctx.storeId);
  }

  ctx.setStreamingAssistantId(null);
  // ponytail: do NOT clear pending here. TurnStarted fires _finaliseStreamingAssistant
  // BEFORE the first Text event creates the new assistant. If the user switches tabs
  // in that window, pending is the only clue _resolveSessionTarget has. Clear pending
  // in _streamingAssistant after the assistant ID is established.
}

// ═══════════════════════════════════════════════════════════
// Streaming bump — trigger re-render for the streaming session
// ═══════════════════════════════════════════════════════════

function _streamingBump(ctx: StreamContext): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, sid);
  if (target) {
    ctx.setSessionMessages(target.sessionId, [...target.messages]);
    ctx.bumpSessionMessages(target.sessionId);
  } else {
    // ponytail: fallback — bump the active session's store (React subscribes to
    // per-session stores, not the panel-level msg store that bumpChat targets).
    const sessStore = getChatStore(ctx.storeId).sess;
    const { sessions, activeIdx } = sessStore.getState();
    const activeSid = sessions[activeIdx]?.id;
    if (activeSid != null) {
      ctx.bumpSessionMessages(activeSid);
    } else {
      bumpChat(ctx.storeId);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// _scheduleSync
// ═══════════════════════════════════════════════════════════

// ponytail: setTimeout(16) debounce instead of requestAnimationFrame.
// rAF can be paused/throttled in Tauri WebView (background/minimized tabs),
// causing the syncRafId guard to permanently block subsequent streaming
// renders. setTimeout always fires — no stuck-flag bug, no safety timeout
// needed. (Recurring bug: same rAF-guard pattern also froze graph-scene;
// fixed there with a 15s safety timeout in a231b89.)
export function _scheduleSync(ctx: StreamContext): void {
  if (ctx.getSyncRafId() !== null) return;
  const timerId = window.setTimeout(() => {
    ctx.setSyncRafId(null);
    _streamingBump(ctx);
  }, 16);
  ctx.setSyncRafId(timerId);
}

// ═══════════════════════════════════════════════════════════
// renderEvent — Agent event dispatch
// ═══════════════════════════════════════════════════════════

export function renderEvent(ctx: StreamContext, ev: AgentEvent): void {
  switch (ev.kind) {
    case EventKind.TurnStarted:
      _finaliseStreamingAssistant(ctx);
      ctx.getExpandedReasoning().clear();
      break;

    case EventKind.Reasoning:
    case EventKind.Text:
    case EventKind.Message:
      if (ev.text || ev.kind === EventKind.Message) {
        applyEventToParts(_streamingAssistant(ctx).parts, ev);
        _scheduleSync(ctx);
      }
      break;

    case EventKind.ToolDispatch:
      if (ev.tool) {
        const t = ev.tool;
        ctx._recordToolUsage(t.name, t.args || '');
        ctx._updateStatusBar('running', `执行 ${t.name}`);
        // agent_spawn renders via SubAgentBlock — skip ToolCard
        if (t.name !== 'agent_spawn') {
          applyEventToParts(_streamingAssistant(ctx).parts, ev);
        }
        _streamingBump(ctx);
      }
      break;

    case EventKind.ToolProgress:
      if (ev.tool) {
        applyEventToParts(_streamingAssistant(ctx).parts, ev);
        _scheduleSync(ctx);
      }
      break;

    case EventKind.ToolResult:
      if (ev.tool) {
        applyEventToParts(_streamingAssistant(ctx).parts, ev);
        _streamingBump(ctx);
        ctx._updateStatusBar('thinking', '分析中…');
      }
      break;

    case EventKind.Usage:
      if (ev.usage?.total_tokens) {
        ctx._updateTokens(ev.usage.total_tokens);
        const u = ev.usage;
        const total = u.total_tokens ?? 0;
        const cached = u.cache_hit_tokens ?? 0;
        const missTokens = u.cache_miss_tokens ?? 0;
        const inputTokens = cached + missTokens;
        const hitRate = inputTokens > 0 ? (cached / inputTokens) * 100 : 0;
        let label = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
        label += ' tok';
        if (cached > 0) label += ` · ${cached >= 1000 ? (cached / 1000).toFixed(1) + 'k' : cached} cache`;
        if (cached > 0) label += ` · ${hitRate.toFixed(0)}% 命中`;
        ctx.setLastUsageText(label);
        ctx.updateFooter();
        _streamingBump(ctx);
      }
      break;

    case EventKind.Notice:
      _addNoticeMessage(ctx, ev.text || '', ev.level || 'info');
      break;

    case EventKind.SessionChanged:
      _streamingBump(ctx);
      break;

    default:
      console.warn('[chat] renderEvent: unknown event kind', (ev as any).kind);
      break;
  }
}

// ═══════════════════════════════════════════════════════════
// Bubble helpers (data-driven model)
// ═══════════════════════════════════════════════════════════

export function appendUserBubble(
  ctx: StreamContext,
  text: string,
  files?: { path: string; name: string; size: number }[],
  _skipActions?: boolean,
): void {
  const fileAttachments: FileAttachment[] = (files || []).map((f) => ({
    path: f.path,
    name: f.name,
    size: f.size,
  }));
  const userMsg = createUserMessage(text, fileAttachments.length > 0 ? fileAttachments : undefined);

  const msgs = ctx.getActiveMessages();
  msgs.push(userMsg);
  const sessStore = getChatStore(ctx.storeId).sess;
  const st = sessStore.getState();
  const activeSid = st.sessions[st.activeIdx]?.id;
  if (activeSid != null) {
    ctx.setSessionMessages(activeSid, [...msgs]);
    // ponytail: bump via bumpSession so React (subscribed to per-session store) re-renders
    if (ctx.bumpSessionMessages) ctx.bumpSessionMessages(activeSid);
  }

  const pair = ctx.getTurnPairs()[ctx.getTurnPairs().length - 1];
  if (pair) pair.userBubble = null;
}

export function addTurnSep(_ctx: StreamContext): void {
  // No-op with the new message model — visual separation is CSS-only.
}

// ═══════════════════════════════════════════════════════════
// Turn lifecycle
// ═══════════════════════════════════════════════════════════

export function finishCurrentTurn(ctx: StreamContext): void {
  _finaliseStreamingAssistant(ctx);
  _streamingBump(ctx);
}

export function finishTurn(ctx: StreamContext): void {
  finishCurrentTurn(ctx);
  autoTitleSessionIfDefault(ctx.storeId);
  const pp = ctx.getProjectPath();
  if (pp) {
    ctx.scheduleAutoSave(pp);
  }
}