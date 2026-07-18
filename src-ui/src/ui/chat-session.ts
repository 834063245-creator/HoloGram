// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Panel — session management (CRUD, persistence, restore)
// Extracted from chat.ts ChatPanel class.
// All functions receive SessionContext instead of accessing `this`.

import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import { createExecState, type ExecStateInstance } from '../agent/execution-state';
import { rpc } from '../bridge';
import type { Message } from '../provider/types';
import { loadSettings } from '../settings';
import type { ChatSessionMeta } from './chat-store';
import { bumpChat, bumpSession, getChatStore, msgStoreFor, msgStoreForActive } from './chat-store';
import { iconHtml } from './icons';
import type { AssistantMessage, ChatMessage, MessageId, UserMessage } from './message-model';
import {
  createAssistantMessage,
  createNoticeMessage,
  createUserMessage,
  nextMsgId,
  resetMsgIdCounter,
} from './message-model';

// ── Module-level session state ──
//
// Pure data lives in chat-store.ts (sessions list, activeIdx, tokens, nextId).
// Non-serializable handles (agent instances, DOM refs, callbacks) stay here.

export interface ChatSession {
  id: number;
  label: string;
  agent: ChatAgentHandle;
}

// ── Per-panel module state (composite key: panelId:sessionId) ──
// ponytail: was singleton Maps/arrays — caused cross-panel leaks when
// multiple ChatPanel instances shared the same module-level state.
// session IDs collide across panels (both start at 1), so composite keys
// prevent wrong-agent / wrong-execState / wrong-turnPairs bugs.

function agentKey(storeId: string, sid: number): string {
  return `${storeId}:${sid}`;
}

const agentHandles = new Map<string, ChatAgentHandle>();
const sessionExecStates = new Map<string, ExecStateInstance>();
const turnPairsByPanel = new Map<
  string,
  Array<{ userText: string; userBubble: null; assistantBubble: null; sessionIndex: number }>
>();
const agentFactoryByPanel = new Map<string, () => Promise<ChatAgentHandle | null>>();

// ── Helpers: bridge store sessions to ChatSession (with agent handles) ──

function storeSessionsWithAgents(storeId: string): ChatSession[] {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  return sessions.map((s) => ({ ...s, agent: agentHandles.get(agentKey(storeId, s.id))! }));
}

// ── Accessors (used by ChatPanel to bridge module state) ──

export function getSessions(storeId: string): ChatSession[] {
  return storeSessionsWithAgents(storeId);
}
export function getActiveIdx(storeId: string): number {
  return getChatStore(storeId).sess.getState().activeIdx;
}
export function getActiveAgent(storeId: string): ChatAgentHandle | null {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  const s = sessions[activeIdx];
  return s ? (agentHandles.get(agentKey(storeId, s.id)) ?? null) : null;
}
export function getNextSessionId(storeId: string): number {
  return getChatStore(storeId).sess.getState().nextSessionId;
}
export function setNextSessionId(storeId: string, id: number): void {
  getChatStore(storeId).sess.setState({ nextSessionId: id });
}
/** Sync the active session's token count into the per-session map. */
export function syncActiveSessionTokens(storeId: string, count: number): void {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  const s = sessions[activeIdx];
  if (s) getChatStore(storeId).sess.getState().setSessionTokens(s.id, count);
}
type TurnPair = { userText: string; userBubble: null; assistantBubble: null; sessionIndex: number };

function ensureTurnPairs(storeId: string): TurnPair[] {
  let tp = turnPairsByPanel.get(storeId);
  if (!tp) {
    tp = [];
    turnPairsByPanel.set(storeId, tp);
  }
  return tp;
}
export function getTurnPairs(storeId: string): TurnPair[] {
  return ensureTurnPairs(storeId);
}
export function setTurnPairs(storeId: string, pairs: TurnPair[]): void {
  turnPairsByPanel.set(storeId, pairs);
}
export function getAgentFactory(storeId: string) {
  return agentFactoryByPanel.get(storeId) ?? null;
}
export function setAgentFactory(storeId: string, fn: (() => Promise<ChatAgentHandle | null>) | null): void {
  if (fn) agentFactoryByPanel.set(storeId, fn);
  else agentFactoryByPanel.delete(storeId);
}

/** Get or create the execState for a session. */
export function getSessionExecState(storeId: string, sessionId: number): ExecStateInstance {
  const k = agentKey(storeId, sessionId);
  let es = sessionExecStates.get(k);
  if (!es) {
    es = createExecState();
    sessionExecStates.set(k, es);
  }
  return es;
}

/** Check if any session other than the active one has a running agent.
 *  Two agents streaming simultaneously would interleave events. */
export function hasRunningBackgroundSession(storeId: string): boolean {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  for (let i = 0; i < sessions.length; i++) {
    if (i === activeIdx) continue;
    const es = sessionExecStates.get(agentKey(storeId, sessions[i].id));
    if (es?.isRunning) return true;
  }
  return false;
}

/** Clean up execState for a closed session. */
export function removeSessionExecState(storeId: string, sessionId: number): void {
  const k = agentKey(storeId, sessionId);
  const es = sessionExecStates.get(k);
  if (es) {
    // Cascade-stop sub-agents first — their abort chain is independent of the
    // session's execState and would otherwise keep running detached.
    agentHandles.get(k)?.cascadeAbort();
    es.stop();
    sessionExecStates.delete(k);
  }
}

/** Full reset — used by setAgent in ChatPanel when switching workspace. */
export function resetSessionState(storeId: string, ag: ChatAgentHandle): void {
  const id = getChatStore(storeId).sess.getState().nextSessionId;
  const label = '会话 1';
  // Clear only this panel's agent handles and exec states
  for (const k of [...agentHandles.keys()]) {
    if (k.startsWith(storeId + ':')) agentHandles.delete(k);
  }
  for (const k of [...sessionExecStates.keys()]) {
    if (k.startsWith(storeId + ':')) sessionExecStates.delete(k);
  }
  agentHandles.set(agentKey(storeId, id), ag);
  sessionExecStates.set(agentKey(storeId, id), createExecState());
  getChatStore(storeId).sess.setState({
    sessions: [{ id, label }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: id + 1,
  });
  // ponytail: create per-session messages store — the ONLY source of truth
  msgStoreFor(storeId, id).getState().setMessages([]);
  setTurnPairs(storeId, []);
}

/** If the active session still has a default label ("会话 N"), auto-title it
 *  from the first user message. Called after each turn completes. */
export function autoTitleSessionIfDefault(storeId: string): void {
  const st = getChatStore(storeId).sess.getState();
  const { sessions, activeIdx } = st;
  const s = sessions[activeIdx];
  if (!s) return;

  // Only auto-title if label is still the default "会话 N" pattern
  if (!/^会话 \d+$/.test(s.label)) return;

  const agent = agentHandles.get(agentKey(storeId, s.id));
  if (!agent) return;

  const msgs = agent.getSession();
  const firstUser = msgs.find((m) => m.role === 'user' && m.content && !m.content.startsWith('<compacted-context>'));
  if (!firstUser?.content) return;

  const derived = firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '');
  const updated = sessions.map((x, i) => (i === activeIdx ? { ...x, label: derived } : x));
  getChatStore(storeId).sess.setState({ sessions: updated });
}

// ── SessionContext — the bridge between standalone session functions and ChatPanel state ──

export interface SessionContext {
  storeId: string;

  // DOM elements
  panel: HTMLElement;
  sessionTabs: HTMLElement;
  tabBar: HTMLElement;

  getProjectPath: () => string;

  // Streaming helpers
  flushReasoning: () => void;
  flushText: () => void;
  clearPendingToolCards: () => void;

  // Running state
  getRunning: () => boolean;
  abort: () => void;

  // Notices & footer
  addNotice: (text: string, level?: 'info' | 'warn' | 'error') => void;
  updateFooter: () => void;

  // Token usage
  getTotalTokensUsed: () => number;
  setTotalTokensUsed: (n: number) => void;
  clearToolUsage: () => void;
  clearToolHistory: () => void;

  getLastUsageText: () => string;
  setLastUsageText: (s: string) => void;
  getLastAgentDiag: () => string;

  clearInputHistory: () => void;
  getStarGraph: () => import('./graph').StarGraph | null;
}

// ── Helpers ──

/** djb2 hash for project path → localStorage key isolation. */
export function hashProjectPath(projectPath: string): number {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = (hash << 5) - hash + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/** Strip read_file_content's cat -n line numbers. Rust backend always returns
 *  "{:>6}\t{content}" format. Session JSON files need this stripped before parse. */
export function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

// ── Session CRUD ──

export function renderSessionTabs(ctx: SessionContext): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  ctx.sessionTabs.innerHTML = '';
  const multi = sessions.length > 1;
  const bar = ctx.sessionTabs.parentElement;
  if (bar) bar.style.display = multi ? '' : 'none';

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const tab = document.createElement('button');
    tab.className = 'chat-session-tab';
    if (i === activeIdx) tab.classList.add('active');
    const shortLabel = s.label.length > 8 ? s.label.slice(0, 7) + '…' : s.label;
    tab.textContent = shortLabel;
    tab.title = `${s.label} (点击切换)`;
    tab.addEventListener('click', () => switchSession(ctx, i));

    if (multi) {
      const xBtn = document.createElement('span');
      xBtn.className = 'chat-session-x';
      xBtn.innerHTML = '×';
      xBtn.title = '关闭会话';
      xBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSession(ctx, i);
      });
      tab.appendChild(xBtn);
    }
    ctx.sessionTabs.appendChild(tab);
  }

  const chatTab = ctx.tabBar.querySelector<HTMLElement>('.chat-panel-tab[data-tab="chat"]');
  if (chatTab) {
    const activeSess = sessions[activeIdx];
    chatTab.textContent =
      multi && activeSess
        ? activeSess.label.length > 6
          ? activeSess.label.slice(0, 5) + '…'
          : activeSess.label
        : '对话';
  }
}

export function switchSession(ctx: SessionContext, idx: number): void {
  const st = getChatStore(ctx.storeId).sess.getState();
  const { sessions, activeIdx } = st;
  if (idx === activeIdx || idx < 0 || idx >= sessions.length) return;

  // ponytail: messages live in per-session stores — no save/restore needed.
  // Just save token count, switch activeIdx, React re-renders from new store.
  if (activeIdx >= 0) {
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sessions[activeIdx].id, ctx.getTotalTokensUsed());
  }
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  getChatStore(ctx.storeId).sess.setState({ activeIdx: idx });
  renderSessionTabs(ctx);

  // Restore token count for target session
  ctx.setTotalTokensUsed(st.sessionTokens[sessions[idx].id] || 0);
  ctx.setLastUsageText('');
  ctx.updateFooter();
}

export function closeSession(ctx: SessionContext, idx: number): void {
  const st = getChatStore(ctx.storeId).sess.getState();
  if (st.sessions.length <= 1) {
    ctx.addNotice('至少保留一个会话', 'info');
    return;
  }
  const s = st.sessions[idx];
  removeSessionExecState(ctx.storeId, s.id);
  agentHandles.delete(agentKey(ctx.storeId, s.id));

  const newSessions = [...st.sessions];
  newSessions.splice(idx, 1);
  let newIdx = st.activeIdx;
  if (newIdx >= newSessions.length) newIdx = newSessions.length - 1;
  if (newIdx < 0) newIdx = 0;
  getChatStore(ctx.storeId).sess.setState({ sessions: newSessions, activeIdx: newIdx });
  renderSessionTabs(ctx);
  // ponytail: no restoreMessages — React reads from per-session store automatically
  ctx.updateFooter();

  const projectPath = ctx.getProjectPath();
  if (projectPath) {
    scheduleAutoSave(ctx, projectPath);
  }
}

export async function createNewSession(ctx: SessionContext): Promise<void> {
  const factory = getAgentFactory(ctx.storeId);
  if (!factory) {
    const extra = ctx.getLastAgentDiag() ? `\n诊断: ${ctx.getLastAgentDiag()}` : '';
    ctx.addNotice(`请先配置 API Key（设置 → Provider）${extra}`, 'info');
    return;
  }
  const newAgent = await factory();
  if (!newAgent) {
    ctx.addNotice('无法创建会话: Agent 工厂返回空', 'error');
    return;
  }
  const st = getChatStore(ctx.storeId).sess.getState();
  // ponytail: messages in per-session stores — no save/restore needed.
  // Just save token count for the old session.
  if (st.activeIdx >= 0) {
    const oldSid = st.sessions[st.activeIdx].id;
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(oldSid, ctx.getTotalTokensUsed());
  }
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  const id = st.nextSessionId;
  const label = `会话 ${st.sessions.length + 1}`;
  agentHandles.set(agentKey(ctx.storeId, id), newAgent);
  sessionExecStates.set(agentKey(ctx.storeId, id), createExecState());
  getChatStore(ctx.storeId).sess.setState({
    sessions: [...st.sessions, { id, label }],
    activeIdx: st.sessions.length,
    nextSessionId: id + 1,
  });
  // ponytail: create per-session messages store — the ONLY source of truth
  msgStoreFor(ctx.storeId, id).getState().setMessages([]);
  renderSessionTabs(ctx);
  resetMsgIdCounter();
  ctx.clearInputHistory();
  setTurnPairs(ctx.storeId, []);
  ctx.setTotalTokensUsed(0);
  getChatStore(ctx.storeId).sess.getState().setSessionTokens(id, 0);
  ctx.addNotice(`新会话已创建 — 会话 ${st.sessions[st.activeIdx]?.label ?? ''} 仍在后台运行`, 'info');
  ctx.setLastUsageText('');
  ctx.updateFooter();
}

// ── Session persistence — one file per session, localStorage backup ──

/** Read a session file and parse as JSON. Handles read_file_content's line numbers. */
async function readSessionJSON(filePath: string): Promise<any> {
  const raw = await rpc<string>('read_file_content', { filePath });
  return JSON.parse(stripLineNumbers(raw));
}

function lsKey(projectPath: string, id: number): string {
  return `hologram_session_${hashProjectPath(projectPath).toString(36)}_${id}`;
}

function sessionsDir(projectPath: string): string {
  return `${projectPath.replace(/\\/g, '/')}/.hologram/sessions`;
}

function sessionFile(projectPath: string, id: number): string {
  return `${sessionsDir(projectPath)}/${id}.json`;
}

function trackerFile(projectPath: string): string {
  return `${sessionsDir(projectPath)}/_active.json`;
}

/** Scan sessions directory for the highest numeric session ID. Returns 0 if no sessions found. */
export async function scanMaxSessionId(projectPath: string): Promise<number> {
  try {
    const raw = await rpc<string>('list_directory', { path: sessionsDir(projectPath) });
    const entries: any[] = JSON.parse(raw);
    if (!Array.isArray(entries)) return 0;
    let maxId = 0;
    for (const e of entries) {
      if (e.is_dir || !e.name || e.name === '_active.json') continue;
      const sid = parseInt(String(e.name).replace(/\.json$/, ''), 10);
      if (!isNaN(sid) && sid > maxId) maxId = sid;
    }
    return maxId;
  } catch {
    return 0;
  }
}

/** Save the active session to its own file. Updates _active.json tracker.
 *  Also writes a sync localStorage backup so the session survives app crash / force-close. */
export async function saveActiveSession(ctx: SessionContext, projectPath: string): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  if (!projectPath || activeIdx < 0) return;
  const sMeta = sessions[activeIdx];
  if (!sMeta) return;
  const agent = agentHandles.get(agentKey(ctx.storeId, sMeta.id));
  if (!agent) return;

  const messages = agent.getSession();
  // Don't persist empty sessions (only system prompt, no user messages)
  if (!messages.some((m) => m.role !== 'system')) return;

  // ponytail: messages are already in per-session store — no saveCurrentMessages needed
  getChatStore(ctx.storeId).sess.getState().setSessionTokens(sMeta.id, ctx.getTotalTokensUsed());

  const data = {
    id: sMeta.id,
    label: sMeta.label,
    savedAt: new Date().toISOString(),
    messages,
    tokensUsed: ctx.getTotalTokensUsed(),
  };

  // 1) Sync localStorage backup — survives beforeunload timeout / process kill
  const json = JSON.stringify(data);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(lsKey(projectPath, sMeta.id), json);
    }
  } catch {
    /* quota exceeded — disk write is the fallback */
  }

  // 2) Async disk write (atomic: tmp → rename)
  try {
    await rpc('write_file_content', {
      filePath: sessionFile(projectPath, sMeta.id),
      content: json,
    });
  } catch (e) {
    console.error('[chat] saveActiveSession 失败:', e);
  }

  try {
    await rpc('write_file_content', {
      filePath: trackerFile(projectPath),
      content: JSON.stringify({ lastId: sMeta.id, nextId: getChatStore(ctx.storeId).sess.getState().nextSessionId }),
    });
  } catch {
    /* non-critical */
  }
}

// ═══════════════════════════════════════════════════════════════
// Debounced auto-save — coalesces rapid-fire save triggers into
// one write per 500ms window. Explicit saves (deactivate, settings
// reinit) should call saveActiveSession directly.
// ═══════════════════════════════════════════════════════════════

let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_SAVE_DELAY_MS = 500;

export function scheduleAutoSave(ctx: SessionContext, projectPath: string): void {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    _autoSaveTimer = null;
    saveActiveSession(ctx, projectPath).catch(() => {});
  }, AUTO_SAVE_DELAY_MS);
}

/** Restore the last active session on project open.
 *  Tries file first, falls back to localStorage (survives app crash / force-close). */
export async function autoRestoreLastSession(ctx: SessionContext, projectPath: string): Promise<void> {
  if (!getAgentFactory(ctx.storeId) || !projectPath) return;

  let curNextId = getChatStore(ctx.storeId).sess.getState().nextSessionId;

  // ── Resolve last session id ──
  let lastId = 0;
  // 1) Tracker file
  try {
    const t = await readSessionJSON(trackerFile(projectPath));
    lastId = t.lastId || 0;
    const trackerNextId = t.nextId || lastId + 1 || 1;
    curNextId = Math.max(curNextId, trackerNextId);
  } catch {
    /* tracker missing — try localStorage scan below */
  }

  // 2) If tracker missing, scan localStorage for newest session IN THIS WORKSPACE
  if (!lastId && typeof localStorage !== 'undefined') {
    const wsPrefix = lsKey(projectPath, 0).replace(/_0$/, '_');
    let newestTs = '';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(wsPrefix)) continue;
      try {
        const d = JSON.parse(localStorage.getItem(key)!);
        if (d.id && !d.deleted && d.savedAt > newestTs) {
          newestTs = d.savedAt;
          lastId = d.id;
        }
      } catch {
        /* skip corrupt entry */
      }
    }
    if (lastId) curNextId = lastId + 1;
  }
  if (!lastId) {
    getChatStore(ctx.storeId).sess.setState({ nextSessionId: 1 });
    ctx.addNotice('未找到历史会话，已创建新会话', 'info');
    return;
  }

  // ── Load session data (file first, localStorage fallback) ──
  let data: any = null;
  // 1) Try disk file
  try {
    data = await readSessionJSON(sessionFile(projectPath, lastId));
  } catch {
    /* file missing — try localStorage */
  }

  // 2) localStorage fallback (may be newer if beforeunload save didn't complete)
  if (typeof localStorage !== 'undefined') {
    const lsRaw = localStorage.getItem(lsKey(projectPath, lastId));
    if (lsRaw) {
      try {
        const lsData = JSON.parse(lsRaw);
        // Use localStorage if file was missing OR localStorage has newer data
        if (!data || !data.savedAt || (lsData.savedAt && lsData.savedAt > data.savedAt)) {
          data = lsData;
        }
      } catch {
        /* corrupt localStorage entry */
      }
    }
  }
  if (!data || !data.messages || data.messages.length === 0) {
    ctx.addNotice('历史会话数据为空，已创建新会话', 'info');
    return;
  }

  // ponytail: if the tracked session has no user messages (only system prompt),
  // scan localStorage for a session with actual conversation (no backend dependency)
  {
    const convMsgs = (data.messages as any[]).filter((m: any) => m.role !== 'system');
    if (convMsgs.length === 0 && typeof localStorage !== 'undefined') {
      const wsPrefix = lsKey(projectPath, 0).replace(/_0$/, '_');
      let bestId = 0;
      let bestTs = '';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(wsPrefix)) continue;
        try {
          const d = JSON.parse(localStorage.getItem(key)!);
          if (d.id && !d.deleted && d.savedAt > bestTs) {
            // Quick check: does it have non-system messages?
            const hasConv = (d.messages as any[])?.some?.((m: any) => m.role !== 'system');
            if (hasConv) {
              bestTs = d.savedAt;
              bestId = d.id;
            }
          }
        } catch {
          /* skip */
        }
      }
      if (bestId > 0 && bestId !== lastId) {
        try {
          const lsRaw = localStorage.getItem(lsKey(projectPath, bestId));
          if (lsRaw) {
            data = JSON.parse(lsRaw);
            lastId = bestId;
          }
        } catch {
          /* keep original empty data */
        }
      }
    }
  }

  const newAgent = await getAgentFactory(ctx.storeId)!();
  if (!newAgent) {
    ctx.addNotice('Agent 未就绪（API Key 未配置？），历史会话暂未恢复', 'warn');
    return;
  }

  const freshSys = newAgent.getSession().filter((m: Message) => m.role === 'system');
  const conv = (data.messages as Message[]).filter((m: Message) => m.role !== 'system');
  newAgent.setSession([...freshSys, ...conv]);

  const curSt = getChatStore(ctx.storeId).sess.getState();
  // ponytail: messages in per-session stores — no saveCurrentMessages needed
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  const label = data.label || '已恢复的会话';
  for (const k of [...agentHandles.keys()]) {
    if (k.startsWith(ctx.storeId + ':')) agentHandles.delete(k);
  }
  agentHandles.set(agentKey(ctx.storeId, data.id), newAgent);
  getChatStore(ctx.storeId).sess.setState({
    sessions: [{ id: data.id, label }],
    activeIdx: 0,
    nextSessionId: Math.max(curNextId, curSt.nextSessionId),
  });
  // ponytail: create per-session messages store + populate from restored data
  msgStoreFor(ctx.storeId, data.id).getState().setMessages([]);
  renderSessionTabs(ctx);

  try {
    renderRestoredSession(ctx);
  } catch (e) {
    console.error('[chat] render 崩溃', e);
  }

  ctx.setLastUsageText('');
  ctx.updateFooter();
}

/** Scan sessions directory — no agent required. */
export async function listSavedSessions(
  ctx: SessionContext,
  projectPath: string,
): Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string }>> {
  const dirPath = sessionsDir(projectPath);
  let entries: any[];
  try {
    const raw = await rpc<string>('list_directory', { path: dirPath });
    entries = JSON.parse(raw);
  } catch (e) {
    console.error('[chat] listSavedSessions: list_directory failed', e);
    return [];
  }

  if (!Array.isArray(entries)) {
    console.error('[chat] listSavedSessions: unexpected result', typeof entries);
    return [];
  }

  // Filter valid JSON session files (skip dirs, _active.json, non-json)
  const targets = entries.filter(
    (e) =>
      !e.is_dir &&
      e.name.endsWith('.json') &&
      e.name !== '_active.json' &&
      !isNaN(parseInt(e.name.replace('.json', ''), 10)),
  );

  // ── Read all session files in parallel with a 10s timeout ──
  const TIMEOUT_MS = 10_000;
  type SessionEntry = { id: number; label: string; msgCount: number; savedAt: string };
  const readPromises: Promise<SessionEntry | null>[] = targets.map(async (e) => {
    try {
      const d = await readSessionJSON(e.path);
      if (d.deleted) return null;
      const sid = parseInt(e.name.replace('.json', ''), 10);
      return {
        id: d.id || sid,
        label: d.label || `会话 ${sid}`,
        msgCount: (d.messages as any[])?.filter((m: any) => m.role !== 'system').length || 0,
        savedAt: d.savedAt || '',
      };
    } catch (err) {
      console.error(`[chat] listSavedSessions: failed to read ${e.name}`, err);
      return null;
    }
  });

  const timeout: Promise<null[]> = new Promise((resolve) =>
    setTimeout(() => {
      console.warn('[chat] listSavedSessions: timed out after 10s');
      resolve([]);
    }, TIMEOUT_MS),
  );

  const results = await Promise.race([Promise.all(readPromises), timeout]);
  if (!Array.isArray(results)) return [];

  const result = results.filter((r) => r !== null) as SessionEntry[];
  result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return result;
}

/** Load a saved session from disk into a new tab. Falls back to localStorage. */
export async function loadSessionFromDisk(ctx: SessionContext, projectPath: string, sessionId: number): Promise<void> {
  if (!getAgentFactory(ctx.storeId)) {
    const extra = ctx.getLastAgentDiag() ? `\n诊断: ${ctx.getLastAgentDiag()}` : '';
    ctx.addNotice(`请先配置 API Key${extra}`, 'error');
    return;
  }

  let data: any;
  // 1) Try disk file
  try {
    data = await readSessionJSON(sessionFile(projectPath, sessionId));
  } catch {
    /* try localStorage */
  }

  // 2) localStorage fallback
  if (!data && typeof localStorage !== 'undefined') {
    const lsRaw = localStorage.getItem(lsKey(projectPath, sessionId));
    if (lsRaw) {
      try {
        data = JSON.parse(lsRaw);
      } catch {
        /* corrupt */
      }
    }
  }
  if (!data) {
    ctx.addNotice('会话文件读取失败', 'error');
    return;
  }

  const newAgent = await getAgentFactory(ctx.storeId)!();
  if (!newAgent) {
    ctx.addNotice('无法创建 Agent', 'error');
    return;
  }

  const freshSys = newAgent.getSession().filter((m: Message) => m.role === 'system');
  const conv = (data.messages as Message[]).filter((m: Message) => m.role !== 'system');
  newAgent.setSession([...freshSys, ...conv]);

  const firstUser = conv.find((m: Message) => m.role === 'user' && !m.content?.startsWith('<compacted-context>'));
  const st1 = getChatStore(ctx.storeId).sess.getState();
  const label =
    data.label && !data.label.startsWith('会话 ') && data.label !== '已恢复的会话'
      ? data.label
      : firstUser
        ? firstUser.content!.slice(0, 28) + (firstUser.content!.length > 28 ? '…' : '')
        : `会话 ${st1.sessions.length + 1}`;

  // ponytail: messages in per-session stores — no saveCurrentMessages needed
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  const sid = data.id || sessionId;
  agentHandles.set(agentKey(ctx.storeId, sid), newAgent);
  getChatStore(ctx.storeId).sess.setState({
    sessions: [...st1.sessions, { id: sid, label }],
    activeIdx: st1.sessions.length,
  });
  // ponytail: create per-session messages store
  msgStoreFor(ctx.storeId, sid).getState().setMessages([]);
  if (typeof data.tokensUsed === 'number') {
    ctx.setTotalTokensUsed(data.tokensUsed);
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sid, data.tokensUsed);
  } else {
    ctx.setTotalTokensUsed(0);
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sid, 0);
  }
  renderSessionTabs(ctx);

  try {
    renderRestoredSession(ctx);
  } catch (e) {
    console.error('[chat] loadSessionFromDisk: render 崩溃', e);
    ctx.addNotice(`会话已加载但渲染失败: ${label}`, 'error');
  }

  ctx.setLastUsageText('');
  ctx.updateFooter();
  ctx.addNotice(`已加载: ${label}`, 'info');
}

/** Mark a session file as deleted on disk. */
export async function deleteSessionFile(ctx: SessionContext, projectPath: string, sessionId: number): Promise<void> {
  // Overwrite with deleted marker — listSavedSessions filters these out
  try {
    await rpc('write_file_content', {
      filePath: sessionFile(projectPath, sessionId),
      content: JSON.stringify({ id: sessionId, deleted: true, label: '', messages: [], savedAt: '' }),
    });
  } catch (e) {
    console.error('[chat] deleteSessionFile failed:', e);
    ctx.addNotice('删除会话文件失败', 'error');
    return; // Don't close tab if write failed
  }
  // Clean localStorage backup
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(lsKey(projectPath, sessionId));
  } catch {
    /* ignore */
  }
  // If this session is open in a tab, close that tab
  const idx = getChatStore(ctx.storeId)
    .sess.getState()
    .sessions.findIndex((s) => s.id === sessionId);
  if (idx >= 0) closeSession(ctx, idx);
}

// ── Session restore (internal helpers) ──

/** Walk through active agent's session array and build ChatMessage[] + turnPairs. */
function renderRestoredSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;
  const agent = agentHandles.get(agentKey(ctx.storeId, sid));
  if (!agent) return;
  _rebuildMessagesFromSession(ctx);
  bumpSession(ctx.storeId, sid);
  ctx.addNotice(`已恢复 ${sessions.length} 个会话`, 'info');
}

/** Populate the active session's per-session messages store + turnPairs from the
 *  agent's getSession() raw messages. Pure data rebuild — no DOM, no notices. */
export function _rebuildMessagesFromSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;
  const agent = agentHandles.get(agentKey(ctx.storeId, sid));
  if (!agent) return;

  const msgs = agent.getSession();
  const rebuilt: ChatMessage[] = [];

  resetMsgIdCounter();
  setTurnPairs(ctx.storeId, []);

  const toolResults = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolResults.set(m.tool_call_id, m.content || '');
    }
  }

  let pendingUserText: string | null = null;
  let pendingUserId: MessageId | null = null;
  let pendingSessionIdx = -1;
  let sessionIdx = 0;

  for (const m of msgs) {
    const idx = sessionIdx++;

    if (m.role === 'system') continue;

    if (m.role === 'user') {
      if (m.content?.startsWith('<compacted-context>')) {
        rebuilt.push(createNoticeMessage('📋 上下文已压缩', 'info'));
        continue;
      }
      if (pendingUserText && pendingUserId) {
        getTurnPairs(ctx.storeId).push({
          userText: pendingUserText,
          userBubble: null,
          assistantBubble: null,
          sessionIndex: pendingSessionIdx,
        });
      }
      pendingUserText = m.content || '';
      pendingUserId = nextMsgId();
      pendingSessionIdx = idx;
      const um = createUserMessage(m.content || '', undefined, idx);
      rebuilt.push(um);
      pendingUserId = um._id;
      continue;
    }

    if (m.role === 'tool') continue;

    if (m.role === 'assistant') {
      const am = createAssistantMessage(pendingUserId || '');
      am.status = 'done';

      if (m.reasoning_content) {
        am.parts.push({ type: 'reasoning', text: m.reasoning_content });
      }

      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          am.parts.push({
            type: 'tool',
            toolId: tc.id,
            name: tc.name,
            args: tc.arguments || '',
            label: tc.name,
            readOnly: false,
            status: 'done',
            output: toolResults.get(tc.id),
          });
        }
      }

      if (m.content) {
        am.parts.push({ type: 'text', text: m.content, finalised: true });
      }

      rebuilt.push(am);

      if (pendingUserText) {
        getTurnPairs(ctx.storeId).push({
          userText: pendingUserText,
          userBubble: null,
          assistantBubble: null,
          sessionIndex: pendingSessionIdx,
        });
        pendingUserText = null;
        pendingUserId = null;
      }
    }
  }

  if (pendingUserText) {
    getTurnPairs(ctx.storeId).push({
      userText: pendingUserText,
      userBubble: null,
      assistantBubble: null,
      sessionIndex: pendingSessionIdx,
    });
  }

  // ponytail: write to per-session store — the ONLY source of truth
  msgStoreFor(ctx.storeId, sid).getState().setMessages(rebuilt);
}

// ── Turn retraction ──

/** Retract a turn from DOM and agent session. Returns userText or null. */
export function retractTurn(ctx: SessionContext, idx: number): string | null {
  const tp = getTurnPairs(ctx.storeId);
  const pair = tp[idx];
  if (!pair) return null;
  // ⚡ React handles DOM removal, just clean the model
  // Remove from agent session — search by content if index is stale (inserted mid-run)
  let sessIdx = pair.sessionIndex;
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const agent = agentHandles.get(agentKey(ctx.storeId, sessions[activeIdx]?.id ?? -1));
  if (sessIdx < 0 && agent) {
    const agentSession = agent.getSession();
    for (let i = 0; i < agentSession.length; i++) {
      if (agentSession[i].role === 'user' && agentSession[i].content === pair.userText) {
        sessIdx = i;
        break;
      }
    }
  }
  if (sessIdx >= 0) agent?.retractTurnAt(sessIdx);
  // Remove from turnPairs
  tp.splice(idx, 1);
  // Re-index sessionIndex for remaining pairs from the actual session
  if (agent) {
    const agentSession = agent.getSession();
    const userMsgIndices: number[] = [];
    for (let i = 0; i < agentSession.length; i++) {
      if (agentSession[i].role === 'user') userMsgIndices.push(i);
    }
    for (let i = 0; i < tp.length && i < userMsgIndices.length; i++) {
      tp[i].sessionIndex = userMsgIndices[i];
    }
  }
  return pair.userText;
}

/** Retract a single user message (and its assistant response) from the model. */
export function _retractUserMessage(ctx: SessionContext, msg: UserMessage): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;

  const msgs = msgStoreFor(ctx.storeId, sid).getState().messages;
  const idx = msgs.indexOf(msg as any as ChatMessage);
  if (idx >= 0) {
    const toRemove: number[] = [idx];
    for (let i = idx + 1; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'assistant' && (m as AssistantMessage).respondingTo === msg._id) {
        toRemove.push(i);
        break;
      } else if (m.role === 'user') {
        break;
      }
    }
    for (const i of toRemove.reverse()) {
      msgs.splice(i, 1);
    }
    msgStoreFor(ctx.storeId, sid)
      .getState()
      .setMessages([...msgs]);
    bumpSession(ctx.storeId, sid);
  }
  if (msg.sessionIndex >= 0) {
    agentHandles.get(agentKey(ctx.storeId, sid))?.retractTurnAt(msg.sessionIndex);
  }
}

// ── Conversation export ──

export async function exportSession(ctx: SessionContext): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const agent = agentHandles.get(agentKey(ctx.storeId, sessions[activeIdx]?.id ?? -1));
  if (!agent) {
    ctx.addNotice('没有可导出的会话', 'info');
    return;
  }

  const msgs = agent.getSession();
  const settings = loadSettings();
  const active = settings.providers.find((p) => p.name === settings.activeProvider) || settings.providers[0];
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  let md = `# HoloGram 会话 — ${dateStr}\n`;
  md += `> 模型: ${active?.model || 'unknown'} · 总 token: ${ctx.getTotalTokensUsed().toLocaleString()}\n\n`;

  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (m.content?.startsWith('<compacted-context>')) {
        md += `> *[上下文压缩]*\n\n`;
        continue;
      }
      md += `## 用户\n${m.content || ''}\n\n`;
    }
    if (m.role === 'assistant') {
      md += `## Agent\n${m.content || ''}\n`;
      if ((m as any).tool_calls && (m as any).tool_calls.length > 0) {
        for (const tc of (m as any).tool_calls) {
          md += `\n### 工具调用: ${tc.name}\n`;
          md += `> 参数: \`${tc.arguments || ''}\`\n`;
        }
      }
      md += '\n';
    }
  }

  // Try Tauri save dialog, fallback to browser download
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const filePath = await save({
      defaultPath: `hologram-session-${now.toISOString().slice(0, 10)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (filePath) {
      await rpc('write_file_content', { path: filePath, content: md });
      ctx.addNotice(`会话已导出: ${filePath}`, 'info');
    }
  } catch {
    // Browser fallback
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hologram-session-${now.toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    ctx.addNotice('会话已下载', 'info');
  }
}
