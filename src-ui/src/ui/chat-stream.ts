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

// ── Streaming assistant helper ─────────────────────────────

function _streamingAssistant(ctx: StreamContext): AssistantMessage {
  const id = ctx.getStreamingAssistantId();
  if (id) {
    const found = _findAssistantById(ctx, id);
    if (found) return found;
  }
  // Create a new one — find the last user message to link to
  const lastUser = [...ctx.getMessages()].reverse().find((m) => m.role === 'user');
  const assistant = createAssistantMessage(lastUser?._id ?? '');
  ctx.getMessages().push(assistant);
  ctx.setStreamingAssistantId(assistant._id);
  return assistant;
}

/** Push a notice message to the log.
 *  ponytail: insert BEFORE the streaming assistant (if any) so the incremental
 *  render path in _doSyncMessagesToDOM stays active. */
export function _addNoticeMessage(ctx: StreamContext, text: string, level: 'info' | 'warn' | 'error'): void {
  const sid = ctx.getStreamingAssistantId();
  if (sid) {
    const assistIdx = ctx.getMessages().findIndex(
      (m) => m.role === 'assistant' && (m as AssistantMessage)._id === sid,
    );
    if (assistIdx >= 0) {
      ctx.getMessages().splice(assistIdx, 0, createNoticeMessage(text, level));
    } else {
      ctx.getMessages().push(createNoticeMessage(text, level));
    }
  } else {
    ctx.getMessages().push(createNoticeMessage(text, level));
  }
  _scheduleSync(ctx);
}

// ── Public notice (thin wrapper) ──

export function addNotice(ctx: StreamContext, text: string, level: 'info' | 'warn' | 'error'): void {
  _addNoticeMessage(ctx, text, level);
}

// ═══════════════════════════════════════════════════════════
// _finaliseStreamingAssistant
// ═══════════════════════════════════════════════════════════

/** Find assistant in active messages or background session caches. */
function _findAssistantById(ctx: StreamContext, id: MessageId | null): AssistantMessage | undefined {
  if (!id) return undefined;
  const found = ctx.getMessages().find(
    (m) => m.role === 'assistant' && m._id === id,
  );
  if (found) return found as AssistantMessage;
  // Search background session caches (tab switched while agent ran)
  const models = getChatStore(ctx.storeId).sess.getState().sessionMessageModels;
  for (const sid of Object.keys(models)) {
    const cached = models[Number(sid)];
    const bg = cached.find((m) => m.role === 'assistant' && m._id === id);
    if (bg) return bg as AssistantMessage;
  }
  return undefined;
}

/** Mark the current streaming assistant as done and start a new turn. */
export function _finaliseStreamingAssistant(ctx: StreamContext): void {
  const sid = ctx.getStreamingAssistantId();
  const assistant = _findAssistantById(ctx, sid);
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
  bumpChat(ctx.storeId);
  }
  ctx.setStreamingAssistantId(null);
  // Also clear any stale session-level streaming IDs pointing to this assistant.
  // ponytail: scan instead of tracking owner — session count is small.
  if (sid) {
    const sess = getChatStore(ctx.storeId).sess;
    const ids = sess.getState().sessionStreamingIds;
    for (const [key, val] of Object.entries(ids)) {
      if (val === sid) sess.getState().setSessionStreamingId(Number(key), null);
    }
  }
}

// ═══════════════════════════════════════════════════════════
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
  bumpChat(ctx.storeId);
  });
  ctx.setSyncRafId(rafId);
  // Safety net: if rAF is lost (tab hidden / OS suspend), force render after 500ms.
  timeoutId = setTimeout(() => {
    if (timeoutId !== null) { timeoutId = null; }
    ctx.setSyncRafId(null);
  bumpChat(ctx.storeId);
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
        bumpChat(ctx.storeId);
      }
      break;

    case EventKind.ToolDispatch:
      if (ev.tool) {
        const t = ev.tool;
        ctx._recordToolUsage(t.name, t.args || '');
        ctx._updateStatusBar('running', `执行 ${t.name}`);
        applyEventToParts(_streamingAssistant(ctx).parts, ev);
        bumpChat(ctx.storeId);
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
        bumpChat(ctx.storeId);
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
        // Note: totalTokensUsed updated by _updateTokens callback internally
        ctx.setLastUsageText(label);
        ctx.updateFooter();
        bumpChat(ctx.storeId);
      }
      break;

    case EventKind.Notice:
      _addNoticeMessage(ctx, ev.text || '', ev.level || 'info');
      break;

    case EventKind.SessionChanged:
      bumpChat(ctx.storeId);
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
  bumpChat(ctx.storeId);
}

export function finishTurn(ctx: StreamContext): void {
  finishCurrentTurn(ctx);
  autoTitleSessionIfDefault(ctx.storeId);
  const pp = ctx.getProjectPath();
  if (pp) {
    ctx.saveActiveSession(pp).catch(() => {});
  }
}