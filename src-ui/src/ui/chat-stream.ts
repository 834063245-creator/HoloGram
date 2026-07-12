// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Stream — streaming render pipeline extracted from ChatPanel
// Handles Agent event → DOM message bubble conversion: Text, Reasoning, ToolCall, etc.
// All functions receive StreamContext as first parameter instead of accessing `this`.

import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import { iconHtml } from './icons';
import { execState } from '../agent/execution-state';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { escapeHtml, showCopiedFeedback } from './chat-utils';
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
  lastTextPart,
  findToolPart,
} from './message-model';
import { renderMessage, type RenderCallbacks } from './message-renderer';

// ── Turn pair type (shared with chat-session) ──
type TurnPair = {
  userText: string;
  userBubble: HTMLElement | null;
  assistantBubble: HTMLElement | null;
  sessionIndex: number;
};

// ── StreamContext ──────────────────────────────────────────

export interface StreamContext {
  // ── 核心 DOM ──
  msgList: HTMLElement;
  inputArea: HTMLTextAreaElement;

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
  injectCodeBlockButtons: (bubble: HTMLElement) => void;
  animateBubbleIn: (el: HTMLElement, delay?: number) => any;
  linkifyNodeNames: () => void;
  setRunning: (r: boolean) => void;
  abort: () => void;
  _updateStatusBar: (state: 'idle' | 'thinking' | 'running' | 'error', detail?: string) => void;
  _recordToolUsage: (toolName: string, args: string) => void;
  _retractUserMessage: (msg: UserMessage) => void;
  retractTurn: (idx: number) => string | null;
  sendMessage: () => Promise<void>;
  _upsertToolPart: (
    toolId: string, name: string, args: string, label: string,
    readOnly: boolean, status: 'pending' | 'running' | 'done' | 'error',
    output?: string, err?: string, truncated?: boolean,
  ) => void;
  _updateTokens: (tokensUsed: number) => void;

  // ⚡ React: 消息数组变更后通知重渲染（替代全量 DOM 重建）
  bumpMessages?: () => void;

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
// Used by _appendTextPart, _appendReasoningPart, _finaliseTextPart

function _streamingAssistant(ctx: StreamContext): AssistantMessage {
  const id = ctx.getStreamingAssistantId();
  if (id) {
    const found = ctx.getMessages().find(
      (m) => m.role === 'assistant' && m._id === id,
    );
    if (found) return found as AssistantMessage;
  }
  // Create a new one — find the last user message to link to
  const lastUser = [...ctx.getMessages()].reverse().find((m) => m.role === 'user');
  const assistant = createAssistantMessage(lastUser?._id ?? '');
  ctx.getMessages().push(assistant);
  ctx.setStreamingAssistantId(assistant._id);
  return assistant;
}

// ═══════════════════════════════════════════════════════════
// Data-driven message model — append parts
// ═══════════════════════════════════════════════════════════

/** Append reasoning text — accumulates into the last reasoning part if one exists. */
export function _appendReasoningPart(ctx: StreamContext, text: string): void {
  const assistant = _streamingAssistant(ctx);
  const last = assistant.parts.length > 0
    ? assistant.parts[assistant.parts.length - 1]
    : null;
  if (last && last.type === 'reasoning') {
    last.text += text;
  } else {
    assistant.parts.push({ type: 'reasoning', text });
  }
}

/** Append streaming text — merges into the last text part if one exists. */
export function _appendTextPart(ctx: StreamContext, text: string): void {
  const assistant = _streamingAssistant(ctx);
  const last = lastTextPart(assistant.parts);
  if (last && !last.finalised) {
    last.text += text;
  } else {
    assistant.parts.push({ type: 'text', text, finalised: false });
  }
}

/** Mark the last text part as finalised (streaming text is complete for this step). */
export function _finaliseTextPart(ctx: StreamContext): void {
  const assistant = _streamingAssistant(ctx);
  const last = lastTextPart(assistant.parts);
  if (last) last.finalised = true;
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
  scrollBottom(ctx);
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
  const assistant = ctx.getMessages().find(
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
  ctx.bumpMessages?.();
  }
  ctx.setStreamingAssistantId(null);
}

// ═══════════════════════════════════════════════════════════
// _renderCallbacks
// ═══════════════════════════════════════════════════════════

/** Build the renderer callback bag — resolves user text, handles edit/resend. */
export function _renderCallbacks(ctx: StreamContext): RenderCallbacks {
  return {
    isReasoningExpanded: (idx) => ctx.getExpandedReasoning().has(idx),
    onToggleReasoning: (idx) => {
      if (ctx.getExpandedReasoning().has(idx)) ctx.getExpandedReasoning().delete(idx);
      else ctx.getExpandedReasoning().add(idx);
    },
    onEditUserMessage: (msg) => {
      if (ctx.getRunning()) { ctx.addNotice('Agent 正在运行，请先停止再编辑', 'warn'); return; }
      ctx.inputArea.value = msg.text;
      ctx.inputArea.style.height = 'auto';
      ctx.inputArea.style.height = Math.min(ctx.inputArea.scrollHeight, 120) + 'px';
      ctx.inputArea.focus();
      ctx.inputArea.selectionStart = ctx.inputArea.selectionEnd = msg.text.length;
      ctx._retractUserMessage(msg);
    },
    onResendUserMessage: (msg) => {
      if (ctx.getRunning()) { ctx.addNotice('Agent 正在运行，请先停止再重发', 'warn'); return; }
      ctx.inputArea.value = msg.text;
      ctx._retractUserMessage(msg);
      ctx.sendMessage();
    },
    onRetryAssistant: (assistant, _userText) => {
      if (ctx.getRunning()) { ctx.addNotice('Agent 正在运行，请先停止再重试', 'warn'); return; }
      const pair = ctx.getTurnPairs().find(
        (tp) =>
          tp.assistantBubble &&
          tp.assistantBubble.dataset.messageId === assistant._id,
      );
      const userText = pair?.userText || '';
      if (!userText) return;
      ctx.inputArea.value = '';
      const signal = execState.start();
      addTurnSep(ctx);
      const agent = ctx.getAgent();
      if (!agent) return;
      const sessIdx = agent.getSession().length;
      ctx.getTurnPairs().push({
        userText,
        userBubble: null,
        assistantBubble: null,
        sessionIndex: sessIdx,
      });
      agent
        .run(signal, userText)
        .catch((err: any) => {
          if (!err.message?.includes('aborted')) {
            ctx.addNotice(`重试失败: ${err.message || String(err)}`, 'error');
          }
        })
        .finally(() => {
          execState.done();
          finishTurn(ctx);
        });
    },
    onCopyText: (text, button) => {
      navigator.clipboard.writeText(text).then(() => showCopiedFeedback(button, 12)).catch(() => {});
    },
    onToggleToolCard: (card) => {
      card.classList.toggle('tool-expanded');
    },
  };
}

// ═══════════════════════════════════════════════════════════
// _rerenderMessageAt
// ═══════════════════════════════════════════════════════════

/** Re-render a single message at the given index (in-place DOM replace). */
export function _rerenderMessageAt(ctx: StreamContext, index: number): void {
  const msg = ctx.getMessages()[index];
  if (!msg) return;
  const callbacks = _renderCallbacks(ctx);
  const el = renderMessage(msg, callbacks);
  el.dataset.messageId = msg._id;
  const children = ctx.msgList.children;
  if (index < children.length) {
    children[index].replaceWith(el);
  } else {
    ctx.msgList.appendChild(el);
  }
}

// ═══════════════════════════════════════════════════════════
// _syncMessagesToDOM / _doSyncMessagesToDOM / _scheduleSync
// ═══════════════════════════════════════════════════════════

/** Full sync: rebuild DOM from messages[]. Efficient for streaming (only last changes). */
export function _syncMessagesToDOM(ctx: StreamContext): void {
  if (ctx.getStreamingAssistantId()) {
    if (ctx.getSyncRafId() !== null) return;
    ctx.setSyncRafId(requestAnimationFrame(() => {
      ctx.setSyncRafId(null);
    ctx.bumpMessages?.();
    }));
    return;
  }
  _doSyncMessagesToDOM(ctx);
}

/** Actual DOM sync — incremental during streaming, full rebuild otherwise. */
export function _doSyncMessagesToDOM(ctx: StreamContext): void {
  const callbacks = _renderCallbacks(ctx);
  const msgs = ctx.getMessages();
  const msgCount = msgs.length;

  // Count non-injected children (task notifications are injected, rest is messages)
  let msgChildCount = 0;
  for (const child of ctx.msgList.children) {
    if (!(child instanceof Element && child.classList.contains('task-notification'))) {
      msgChildCount++;
    }
  }

  const sid = ctx.getStreamingAssistantId();

  // If only the last message changed (streaming), re-render just that
  if (
    msgCount === msgChildCount &&
    msgCount > 0 &&
    sid
  ) {
    const lastIdx = msgCount - 1;
    const lastMsg = msgs[lastIdx];
    if (lastMsg.role === 'assistant' && lastMsg._id === sid) {
      const domIdx = ctx.msgList.children.length - 1;
      if (domIdx >= 0) {
        const oldEl = ctx.msgList.children[domIdx] as HTMLElement;
        const el = renderMessage(lastMsg, callbacks);
        el.dataset.messageId = lastMsg._id;
        // Keep reasoning blocks open if they were open before
        const wasOpen = oldEl.querySelector('.msg-reasoning-open');
        if (wasOpen) {
          for (const block of el.querySelectorAll('.msg-reasoning')) {
            block.querySelector('.msg-reasoning-content')?.classList.add('msg-reasoning-open');
            const tgl = block.querySelector('.msg-reasoning-toggle');
            if (tgl) tgl.innerHTML = `${iconHtml('chevron-down')} 收起思考`;
          }
        }
        oldEl.replaceWith(el);
        scrollBottom(ctx);
        return;
      }
    }
  }

  // Snapshot scroll position before rebuild
  const savedScrollTop = ctx.msgList.scrollTop;
  const savedScrollHeight = ctx.msgList.scrollHeight;
  const wasAtBottom = (savedScrollHeight - savedScrollTop - ctx.msgList.clientHeight) <= 40;

  // Full rebuild — preserve injected siblings (task notifications only;
  // permission cards are now first-class messages in the model, not injects)
  const existing = Array.from(ctx.msgList.children);

  const injects: { el: Element; afterIdx: number }[] = [];
  for (let i = 0; i < existing.length; i++) {
    const el = existing[i];
    if (el.classList.contains('task-notification')) {
      injects.push({ el, afterIdx: i - 1 });
      existing.splice(i, 1);
      i--;
    }
  }

  for (let i = 0; i < msgCount; i++) {
    const msg = msgs[i];
    const el = renderMessage(msg, callbacks);
    el.dataset.messageId = msg._id;
    if (i < existing.length) {
      existing[i].replaceWith(el);
      existing[i] = el;
    } else {
      ctx.msgList.appendChild(el);
    }
  }

  // Remove excess children (skip injects: task notifications)
  while (ctx.msgList.children.length > msgCount) {
    const last = ctx.msgList.lastChild;
    if (last instanceof Element && last.classList.contains('task-notification')) {
      break;
    }
    last?.remove();
  }

  // Re-insert preserved injects
  for (const { el, afterIdx } of injects) {
    const ref = ctx.msgList.children[afterIdx + 1] || null;
    ctx.msgList.insertBefore(el, ref);
  }

  // Restore scroll position
  if (wasAtBottom || !ctx.getUserScrolledUp()) {
    scrollBottom(ctx);
  } else {
    const newHeight = ctx.msgList.scrollHeight;
    const offset = newHeight - savedScrollHeight;
    ctx.msgList.scrollTop = Math.max(0, savedScrollTop + offset);
  }
}

/** rAF-throttled sync — avoids O(n²) re-render on high-frequency streams. */
export function _scheduleSync(ctx: StreamContext): void {
  if (ctx.getSyncRafId() !== null) return;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const rafId = requestAnimationFrame(() => {
    if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
    ctx.setSyncRafId(null);
  ctx.bumpMessages?.();
  });
  ctx.setSyncRafId(rafId);
  // Safety net: if rAF is lost (tab hidden / OS suspend), force render after 500ms.
  timeoutId = setTimeout(() => {
    if (timeoutId !== null) { timeoutId = null; }
    ctx.setSyncRafId(null);
  ctx.bumpMessages?.();
  }, 500);
}

// ═══════════════════════════════════════════════════════════
// renderEvent — Agent event dispatch
// ═══════════════════════════════════════════════════════════

export function renderEvent(ctx: StreamContext, ev: AgentEvent): void {
  switch (ev.kind) {
    case EventKind.TurnStarted:
      _finaliseStreamingAssistant(ctx);
      // Link assistant bubble to last turn pair before resetting
      if (ctx.getTurnPairs().length > 0) {
        const bubbles = ctx.msgList.querySelectorAll<HTMLElement>('.msg-bubble.assistant');
        const lastBubble = bubbles[bubbles.length - 1];
        if (lastBubble) ctx.getTurnPairs()[ctx.getTurnPairs().length - 1].assistantBubble = lastBubble;
      }
      ctx.getExpandedReasoning().clear();
      break;

    case EventKind.Reasoning:
      if (ev.text) {
        const isFirst = !ctx.getStreamingAssistantId();
        _appendReasoningPart(ctx, ev.text);
        if (isFirst) _syncMessagesToDOM(ctx);
        else _scheduleSync(ctx);
      }
      break;

    case EventKind.Text:
      if (ev.text) {
        const isFirst = !ctx.getStreamingAssistantId();
        _appendTextPart(ctx, ev.text);
        if (isFirst) _syncMessagesToDOM(ctx);
        else _scheduleSync(ctx);
      }
      break;

    case EventKind.Message:
      if (ev.text) {
        _finaliseTextPart(ctx);
      }
      _syncMessagesToDOM(ctx);
      ctx.linkifyNodeNames();
      break;

    case EventKind.ToolDispatch:
      if (ev.tool) {
        const t = ev.tool;
        ctx._recordToolUsage(t.name, t.args || '');
        ctx._updateStatusBar('running', `执行 ${t.name}`);
        ctx._upsertToolPart(
          t.id, t.name, t.args || '', t.name,
          t.read_only ?? false,
          t.partial ? 'pending' : 'running',
        );
        _syncMessagesToDOM(ctx);
      }
      break;

    case EventKind.ToolProgress:
      if (ev.tool) {
        const t = ev.tool;
        ctx._upsertToolPart(
          t.id, t.name, t.args || '', t.name,
          t.read_only ?? false,
          'running',
          t.output,
        );
        _scheduleSync(ctx);
      }
      break;

    case EventKind.ToolResult:
      if (ev.tool) {
        const t = ev.tool;
        ctx._upsertToolPart(
          t.id, t.name, t.args || '', t.name,
          t.read_only ?? false,
          t.err ? 'error' : 'done',
          !t.err ? t.output : undefined,
          t.err,
          t.truncated,
        );
        _syncMessagesToDOM(ctx);
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
        _syncMessagesToDOM(ctx);
      }
      break;

    case EventKind.Notice:
      _addNoticeMessage(ctx, ev.text || '', ev.level || 'info');
      break;

    case EventKind.SessionChanged:
      _syncMessagesToDOM(ctx);
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

  _syncMessagesToDOM(ctx);

  const rows = ctx.msgList.querySelectorAll('.msg-user-row');
  const row = rows[rows.length - 1] as HTMLElement | undefined;
  if (row && pair) pair.userBubble = row;

  if (row) ctx.animateBubbleIn(row.querySelector('.msg-bubble.user') as HTMLElement);
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
  _syncMessagesToDOM(ctx);
  if (ctx.getTurnPairs().length > 0) {
    const bubbles = ctx.msgList.querySelectorAll<HTMLElement>('.msg-bubble.assistant');
    const lastBubble = bubbles[bubbles.length - 1];
    if (lastBubble) ctx.getTurnPairs()[ctx.getTurnPairs().length - 1].assistantBubble = lastBubble;
  }
}

export function finishTurn(ctx: StreamContext): void {
  finishCurrentTurn(ctx);
  const pp = ctx.getProjectPath();
  if (pp) {
    ctx.saveActiveSession(pp).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════
// Scroll
// ═══════════════════════════════════════════════════════════

export function scrollBottom(ctx: StreamContext): void {
  if (ctx.getUserScrolledUp()) return;
  requestAnimationFrame(() => {
    if (ctx.getUserScrolledUp()) return;
    ctx.msgList.scrollTop = ctx.msgList.scrollHeight;
  });
}
