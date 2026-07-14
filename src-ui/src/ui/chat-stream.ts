// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Stream — streaming render pipeline extracted from ChatPanel
// Handles Agent event → DOM message bubble conversion: Text, Reasoning, ToolCall, etc.
// All functions receive StreamContext as first parameter instead of accessing `this`.

import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import { iconHtml } from './icons';
import { bumpChat } from './chat-store';
import { autoTitleSessionIfDefault } from './chat-session';
import { getChatStore } from './chat-store';
import type { StarGraph } from './graph';
import type {
  ChatMessage,
  UserMessage,
  AssistantMessage,
  AssistantPart,
  MessageId,
  FileAttachment,
} from './message-model';
import {
  nextMsgId,
  createUserMessage,
  createAssistantMessage,
  createNoticeMessage,
} from './message-model';
import { applyEventToParts } from '../agent/part-mutator';

// ── Turn pair type (shared with chat-session) ──
type TurnPair = {
  userText: string;
  userBubble: HTMLElement | null;
  assistantBubble: HTMLElement | null;
  sessionIndex: number;
};

// ── StreamContext ──────────────────────────────────────────

export interface StreamContext {
  /** Store ID for panel-scoped state isolation. */
  storeId: string;

  // ── 消息数组 ──
  getMessages: () => ChatMessage[];
  setMessages: (msgs: ChatMessage[]) => void;

  // ── 流式状态 ──
  getStreamingAssistantId: () => MessageId | null;
  setStreamingAssistantId: (id: MessageId | null) => void;
  getUserScrolledUp: () => boolean;
  setUserScrolledUp: (v: boolean) => void;
  getSyncRafId: () => number | null;
  setSyncRafId: (id: number | null) => void;

  // ── turnPairs ──
  getTurnPairs: () => TurnPair[];

  // ── Agent ──
  getAgent: () => ChatAgentHandle | null;

  // ── Graph ──
  getStarGraph: () => StarGraph | null;

  // ── 回调（ChatPanel methods not extracted）──
  updateFooter: () => void;
  setLastUsageText: (s: string) => void;
  addNotice: (text: string, level?: string) => void;
  saveActiveSession: (path: string) => Promise<void>;
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

  // ── 项目路径 ──
  getProjectPath: () => string;

  // ── 运行状态 ──
  getRunning: () => boolean;
  getAbortCtrl: () => AbortController | null;
  setAbortCtrl: (c: AbortController | null) => void;

  // ── 展开的推理 ──
  getExpandedReasoning: () => Set<number>;
}

// ── Session cache routing ──────────────────────────────────
// ponytail: streaming events write to sessionMessageModels directly,
// not to the active messages array. This prevents tab-switch leaks
// because the correct session's cache is the write target regardless
// of which tab is currently active.

interface StreamingTarget {
  sessionId: number;
  isActive: boolean;
  messages: ChatMessage[];
  /** Persist to cache; sync to active array + trigger re-render if active. */
  commit(storeId: string, setActive: (msgs: ChatMessage[]) => void): void;
}

function _resolveStreamingTarget(ctx: StreamContext, assistantId: MessageId | null): StreamingTarget | null {
  const sess = getChatStore(ctx.storeId).sess;
  const { sessionMessageModels, sessionStreamingIds, sessions, activeIdx } = sess.getState();
  const activeSid = sessions[activeIdx]?.id;

  // Find which session owns this streaming assistant
  let ownerSid: number | undefined;
  if (assistantId) {
    for (const [key, val] of Object.entries(sessionStreamingIds)) {
      if (val === assistantId) { ownerSid = Number(key); break; }
    }
  }
  // Fall back to active session if no tracking found
  const targetSid = ownerSid ?? activeSid;
  if (targetSid == null) return null;

  const msgs = sessionMessageModels[targetSid] || [];
  const isActive = targetSid === activeSid;

  return {
    sessionId: targetSid,
    isActive,
    messages: msgs,
    commit(storeId, setActive) {
      sess.getState().setSessionMessageModels(targetSid, msgs);
      if (isActive) {
        setActive(msgs);
        bumpChat(storeId);
      }
    },
  };
}

// ── Streaming assistant helper ─────────────────────────────

function _streamingAssistant(ctx: StreamContext): AssistantMessage {
  const id = ctx.getStreamingAssistantId();
  const target = _resolveStreamingTarget(ctx, id);
  const msgs = target ? target.messages : ctx.getMessages();

  if (id) {
    const found = msgs.find(m => m.role === 'assistant' && m._id === id) as AssistantMessage | undefined;
    if (found) return found;
  }
  // Create a new one — find the last user message to link to
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const assistant = createAssistantMessage(lastUser?._id ?? '');
  msgs.push(assistant);
  ctx.setStreamingAssistantId(assistant._id);
  if (target) target.commit(ctx.storeId, (m) => ctx.setMessages(m));
  return assistant;
}

/** Push a notice message to the log. */
export function _addNoticeMessage(ctx: StreamContext, text: string, level: 'info' | 'warn' | 'error'): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveStreamingTarget(ctx, sid);
  const msgs = target ? target.messages : ctx.getMessages();
  if (sid) {
    const assistIdx = msgs.findIndex(
      (m) => m.role === 'assistant' && (m as AssistantMessage)._id === sid,
    );
    if (assistIdx >= 0) {
      msgs.splice(assistIdx, 0, createNoticeMessage(text, level));
    } else {
      msgs.push(createNoticeMessage(text, level));
    }
  } else {
    msgs.push(createNoticeMessage(text, level));
  }
  if (target) target.commit(ctx.storeId, (m) => ctx.setMessages(m));
  _scheduleSync(ctx);
}

// ── Public notice (thin wrapper) ──

export function addNotice(ctx: StreamContext, text: string, level: 'info' | 'warn' | 'error'): void {
  _addNoticeMessage(ctx, text, level);
}

// ═══════════════════════════════════════════════════════════
// _finaliseStreamingAssistant
// ═══════════════════════════════════════════════════════════

/** Mark the current streaming assistant as done and start a new turn. */
export function _finaliseStreamingAssistant(ctx: StreamContext): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveStreamingTarget(ctx, sid);
  const msgs = target ? target.messages : ctx.getMessages();
  const assistant = msgs.find(
    (m) => m.role === 'assistant' && m._id === sid,
  ) as AssistantMessage | undefined;
  if (assistant) {
    assistant.status = 'done';
    for (const part of assistant.parts) {
      if (part.type === 'text') (part as any).finalised = true;
    }
  }
  // Flush ALL pending render gates BEFORE clearing _streamingAssistantId.
  const rafId = ctx.getSyncRafId();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    ctx.setSyncRafId(null);
  }
  // Always run one final render while _streamingAssistantId is still set
  if (sid) {
    if (target) target.commit(ctx.storeId, (m) => ctx.setMessages(m));
    else bumpChat(ctx.storeId);
  }
  ctx.setStreamingAssistantId(null);
  // Also clear any stale session-level streaming IDs pointing to this assistant.
  if (sid) {
    const sess = getChatStore(ctx.storeId).sess;
    const ids = sess.getState().sessionStreamingIds;
    for (const [key, val] of Object.entries(ids)) {
      if (val === sid) sess.getState().setSessionStreamingId(Number(key), null);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Streaming bump — commits session cache + triggers re-render
// ═══════════════════════════════════════════════════════════

/** Commit the streaming target's session cache and bump if it's the active session. */
function _streamingBump(ctx: StreamContext): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveStreamingTarget(ctx, sid);
  if (target) {
    // Update session cache from mutated messages array (parts were mutated in-place)
    target.commit(ctx.storeId, (m) => ctx.setMessages(m));
  } else {
    bumpChat(ctx.storeId);
  }
}

// ═══════════════════════════════════════════════════════════
// _scheduleSync
// ═══════════════════════════════════════════════════════════

/** rAF-throttled sync — avoids O(n²) re-render on high-frequency streams. */
export function _scheduleSync(ctx: StreamContext): void {
  if (ctx.getSyncRafId() !== null) return;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const rafId = requestAnimationFrame(() => {
    if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
    ctx.setSyncRafId(null);
    _streamingBump(ctx);
  });
  ctx.setSyncRafId(rafId);
  // Safety net: if rAF is lost (tab hidden / OS suspend), force render after 500ms.
  timeoutId = setTimeout(() => {
    if (timeoutId !== null) { timeoutId = null; }
    ctx.setSyncRafId(null);
    _streamingBump(ctx);
  }, 500);
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
        _streamingBump(ctx);
      }
      break;

    case EventKind.ToolDispatch:
      if (ev.tool) {
        const t = ev.tool;
        ctx._recordToolUsage(t.name, t.args || '');
        ctx._updateStatusBar('running', `执行 ${t.name}`);
        applyEventToParts(_streamingAssistant(ctx).parts, ev);
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
        const hitRate = inputTokens > 0 ? (cached / inputTokens * 100) : 0;
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
  ctx.getMessages().push(userMsg);

  const pair = ctx.getTurnPairs()[ctx.getTurnPairs().length - 1];
  if (pair) pair.userBubble = null;

  // Sync active session cache so switchSession/restoreMessages picks it up
  const sess = getChatStore(ctx.storeId).sess;
  const st = sess.getState();
  const activeSid = st.sessions[st.activeIdx]?.id;
  if (activeSid != null) {
    sess.getState().setSessionMessageModels(activeSid, [...ctx.getMessages()]);
  }
  bumpChat(ctx.storeId);
}

export function addTurnSep(_ctx: StreamContext): void {
  // No-op with the new message model — visual separation is handled
  // by margins/padding on .msg-bubble elements via CSS.
}

// ═══════════════════════════════════════════════════════════
// Turn lifecycle
// ═══════════════════════════════════════════════════════════

/** Finalize current assistant bubble — link to latest turnPair, reset streaming state. */
export function finishCurrentTurn(ctx: StreamContext): void {
  _finaliseStreamingAssistant(ctx);
  _streamingBump(ctx);
}

export function finishTurn(ctx: StreamContext): void {
  finishCurrentTurn(ctx);
  autoTitleSessionIfDefault(ctx.storeId);
  const pp = ctx.getProjectPath();
  if (pp) {
    ctx.saveActiveSession(pp).catch(() => {});
  }
}