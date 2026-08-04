// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Stream — 流式渲染管线
// ponytail: 消息存放在会话级 store 中（getMessagesStore(`${storeId}:${sid}`)）。
// 无面板级消息数组，无 sessionMessageModels 缓存，无手动同步。
// 流式写入直接指向会话的 store — 无论哪个标签页活跃都始终正确。

import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import { autoTitleSessionIfDefault } from './chat-session';
import { bumpChat, getChatStore } from './chat-store';
import type { StarGraph } from './graph';
import type { AssistantMessage, ChatMessage, FileAttachment, MessageId, PlanPart, UserMessage } from './message-model';
import { createAssistantMessage, createNoticeMessage, createUserMessage } from './message-model';
import { applyEventToParts } from './part-mutator';

// ── 轮次配对类型（与 chat-session 共享）──
type TurnPair = {
  userText: string;
  userBubble: HTMLElement | null;
  assistantBubble: HTMLElement | null;
  sessionIndex: number;
};

// ── StreamContext ──────────────────────────────────────────

export interface StreamContext {
  storeId: string;

  // ── 会话级消息 store（ponytail: 唯一数据源）──
  getSessionMessages: (sid: number) => ChatMessage[];
  getActiveMessages: () => ChatMessage[];
  setSessionMessages: (sid: number, msgs: ChatMessage[]) => void;
  bumpSessionMessages: (sid: number) => void;

  // ── 流式状态（面板级 — 每个面板一个流）──
  getStreamingAssistantId: () => MessageId | null;
  setStreamingAssistantId: (id: MessageId | null) => void;
  getUserScrolledUp: () => boolean;
  setUserScrolledUp: (v: boolean) => void;
  getSyncRafId: () => number | null;
  setSyncRafId: (id: number | null) => void;

  // ── 流式目标会话（替代 _pendingStreamingSessions 全局 Map）──
  getStreamingTargetSid: () => number | null;
  setStreamingTargetSid: (sid: number | null) => void;

  // ── turnPairs ──
  getTurnPairs: () => TurnPair[];

  // ── Agent ──
  getAgent: () => ChatAgentHandle | null;

  // ── Graph ──
  getStarGraph: () => StarGraph | null;

  // ── 回调 ──
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

// ── 会话路由 ───────────────────────────────────────
// ponytail: 解析哪个会话拥有流式助手。
// 策略：
//   1. 若 assistantId 已知 → 扫描会话 store 查找（O(sessions)，≤10）
//   2. 若尚无 assistant → 检查 pendingStreamingSession（由 sendMessage 在 agent.run 前设置）
//   3. 兜底 → 活跃会话
// 防止用户在 sendMessage 后、第一个文本事件到达前切换标签页的竞态
// （此时 streamingAssistantId 仍为 null）。

interface SessionTarget {
  sessionId: number;
  messages: ChatMessage[];
  isActive: boolean;
}

/** 跟踪哪个会话启动了当前流式运行。
 *  由 sendMessage（或 sendAgentText/runGoal）在 agent.run() 前设置，
 *  在 _finaliseStreamingAssistant 或调用者的 finally 块中清除。
 *  现存储在 RenderContext 上（getStreamingTargetSid/setStreamingTargetSid）
 *  而非模块级 Map — 消除全局可变状态。 */

function _resolveSessionTarget(ctx: StreamContext, assistantId: MessageId | null): SessionTarget | null {
  const sessStore = getChatStore(ctx.storeId).sess;
  const { sessions, activeIdx } = sessStore.getState();
  const activeSid = sessions[activeIdx]?.id;

  // 1) 已知 assistant → 查找其所属会话
  if (assistantId) {
    for (const s of sessions) {
      const msgs = ctx.getSessionMessages(s.id);
      if (msgs.some((m) => m._id === assistantId)) {
        return { sessionId: s.id, messages: msgs, isActive: s.id === activeSid };
      }
    }
  }

  // 2) 尚无 assistant → 使用启动运行的会话
  const pendingSid = ctx.getStreamingTargetSid();
  if (pendingSid != null) {
    const msgs = ctx.getSessionMessages(pendingSid);
    return { sessionId: pendingSid, messages: msgs, isActive: pendingSid === activeSid };
  }

  // 3) 最后手段：活跃会话
  if (activeSid != null) {
    return {
      sessionId: activeSid,
      messages: ctx.getActiveMessages(),
      isActive: true,
    };
  }
  return null;
}

// ── 流式助手辅助函数 ─────────────────────────────

function _streamingAssistant(ctx: StreamContext): AssistantMessage {
  const id = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, id);
  if (!target) {
    // ponytail: 无会话 → 无法渲染。不应发生（面板始终有 ≥1 个会话）。
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

  // 持久化 + 递增会话的 store
  ctx.setSessionMessages(target.sessionId, [...msgs]);
  ctx.bumpSessionMessages(target.sessionId);
  // ponytail: assistant ID 已确立 — 后续事件通过会话 store
  // 扫描找到它。流式目标不再需要用于本次运行。
  ctx.setStreamingTargetSid(null);
  return assistant;
}

/** 推送通知消息到日志。在 10 分钟窗口内去重相同文本。 */
const NOTICE_DEDUP_MS = 10 * 60 * 1000;
const _recentNotices = new Map<string, number>(); // storeId:text → 上次显示时间戳

function _addNoticeMessage(ctx: StreamContext, text: string, level: 'info' | 'warn' | 'error'): void {
  // L3 去重：若相同文本在时间窗口内已显示则跳过（按 storeId 限定作用域，避免跨会话抑制）
  const now = Date.now();
  const dedupKey = `${ctx.storeId}:${text}`;
  const lastShown = _recentNotices.get(dedupKey);
  if (lastShown != null && now - lastShown < NOTICE_DEDUP_MS) {
    return;
  }
  _recentNotices.set(dedupKey, now);
  // 清理过期条目，防止无限增长
  if (_recentNotices.size > 50) {
    for (const [key, ts] of _recentNotices) {
      if (now - ts >= NOTICE_DEDUP_MS) _recentNotices.delete(key);
    }
  }

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

// ── 公共通知 ──

export function addNotice(ctx: StreamContext, text: string, level: 'info' | 'warn' | 'error'): void {
  _addNoticeMessage(ctx, text, level);
}

// ═══════════════════════════════════════════════════════════
// _finaliseStreamingAssistant
// ═══════════════════════════════════════════════════════════

/** 标记当前流式助手为完成。 */
function _finaliseStreamingAssistant(ctx: StreamContext): void {
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
    // 替换为新的消息对象：AssistantBubble 的 memo 比较器在
    // prev.msg === next.msg 时直接跳过，因此仅原地修改永远不会
    // 渲染流式→完成的转换（卡住的旋转器/光标）。
    // 浅拷贝共享 parts 数组 — 实时的 part 修改保持可见。
    const idx = msgs.indexOf(assistant);
    if (idx >= 0) msgs[idx] = { ...assistant };
  }

  // 刷新待渲染
  const timerId = ctx.getSyncRafId();
  if (timerId !== null) {
    clearTimeout(timerId);
    ctx.setSyncRafId(null);
  }

  // 在 streamingAssistantId 仍设置时做最终递增
  if (sid && target) {
    ctx.setSessionMessages(target.sessionId, [...msgs]);
    ctx.bumpSessionMessages(target.sessionId);
  } else if (sid) {
    bumpChat(ctx.storeId);
  }

  ctx.setStreamingAssistantId(null);
  // ponytail: 不要在此清除 pending。TurnStarted 在第一个 Text 事件创建新 assistant 之前
  // 触发 _finaliseStreamingAssistant。若用户在此窗口内切换标签页，
  // pending 是 _resolveSessionTarget 唯一的线索。在 _streamingAssistant 中
  // assistant ID 确立后清除 pending。
}

// ═══════════════════════════════════════════════════════════
// 流式递增 — 触发流式会话的重新渲染
// ═══════════════════════════════════════════════════════════

function _streamingBump(ctx: StreamContext): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, sid);
  if (target) {
    // 单一写入路径：替换流式消息的引用，使 memoized 的
    // 气泡能观察到原地 part 修改（见 messages-store.ts）。
    if (sid) {
      const idx = target.messages.findIndex((m) => m._id === sid);
      if (idx >= 0) target.messages[idx] = { ...target.messages[idx] };
    }
    ctx.setSessionMessages(target.sessionId, [...target.messages]);
    ctx.bumpSessionMessages(target.sessionId);
  } else {
    // ponytail: 兜底 — 递增活跃会话的 store（React 订阅的是
    // 会话级 store，而非 bumpChat 所针对的面板级 msg store）。
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

// ponytail: 使用 setTimeout(16) 防抖替代 requestAnimationFrame。
// rAF 在 Tauri WebView 中（后台/最小化标签页）可能被暂停/节流，
// 导致 syncRafId 守卫永久阻塞后续流式渲染。
// setTimeout 总会触发 — 无卡死标志 bug，无需安全超时。
// （复发 bug：相同的 rAF 守卫模式也曾冻结 graph-scene；
// 在 a231b89 中用 15 秒安全超时修复。）
export function _scheduleSync(ctx: StreamContext): void {
  if (ctx.getSyncRafId() !== null) return;
  const timerId = window.setTimeout(() => {
    ctx.setSyncRafId(null);
    _streamingBump(ctx);
  }, 16);
  ctx.setSyncRafId(timerId);
}

// ═══════════════════════════════════════════════════════════
// renderEvent — Agent 事件分发
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
        // agent_spawn 通过 SubAgentBlock 渲染 — 跳过 ToolCard
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

    case EventKind.PlanReview:
      if (ev.plan) {
        const p = ev.plan;
        const planPart: PlanPart = {
          type: 'plan',
          planId: `plan-card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          planFilePath: p.planFilePath,
          content: p.planContent,
          options: p.options,
          status: 'pending',
          _callback: p.callback,
        };
        const assistant = _streamingAssistant(ctx);
        assistant.parts.push(planPart);
        _streamingBump(ctx);
      }
      break;

    default:
      console.warn('[chat] renderEvent: unknown event kind', (ev as any).kind);
      break;
  }
}

// ═══════════════════════════════════════════════════════════
// 气泡辅助函数（数据驱动模型）
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
  // ponytail: 通过 bumpSession 递增，使 React（订阅会话级 store）重新渲染
    if (ctx.bumpSessionMessages) ctx.bumpSessionMessages(activeSid);
  }

  const pair = ctx.getTurnPairs()[ctx.getTurnPairs().length - 1];
  if (pair) pair.userBubble = null;
}
// （2026-08-04 清理：addTurnSep 空操作导出已删 — 视觉分隔由 CSS 处理）

// ═══════════════════════════════════════════════════════════
// 轮次生命周期
// ═══════════════════════════════════════════════════════════

function finishCurrentTurn(ctx: StreamContext): void {
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