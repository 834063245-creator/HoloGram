// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Panel — session management (CRUD, persistence, restore)
// Extracted from chat.ts ChatPanel class.
// All functions receive SessionContext instead of accessing `this`.

import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import type { ChatMessage, MessageId, UserMessage, AssistantMessage } from './message-model';
import {
  resetMsgIdCounter,
  nextMsgId,
  createUserMessage,
  createAssistantMessage,
  createNoticeMessage,
} from './message-model';
import { rpc } from '../bridge';
import {
  useChatStore,
  bumpChat,
  getChatMessages,
  setChatMessages,
} from './chat-store';
import type { ChatSessionMeta } from './chat-store';
import { loadSettings, CHAT_MODES } from '../settings';
import type { Message } from '../provider/types';
import { iconHtml } from './icons';

// ── Module-level session state ──
//
// Pure data lives in chat-store.ts (sessions list, activeIdx, tokens, nextId).
// Non-serializable handles (agent instances, DOM refs, callbacks) stay here.

export interface ChatSession {
  id: number;
  label: string;
  agent: ChatAgentHandle;
}

/** Agent handles keyed by session id — non-serializable, stays module-level. */
const agentHandles = new Map<number, ChatAgentHandle>();

/** DOM elements for legacy session rendering — stays module-level. */
const sessionMessages = new Map<number, HTMLElement[]>();

/** Turn pairs for retract/resend — HTMLElement refs prevent Zustand serialization. */
let turnPairs: Array<{ userText: string; userBubble: HTMLElement | null; assistantBubble: HTMLElement | null; sessionIndex: number }> = [];

/** Agent factory function — set once by ChatPanel. */
let agentFactory: (() => Promise<ChatAgentHandle | null>) | null = null;

// ── Helpers: bridge store sessions to ChatSession (with agent handles) ──

function storeSessionsWithAgents(): ChatSession[] {
  const { sessions, activeIdx } = useChatStore.getState();
  return sessions.map(s => ({ ...s, agent: agentHandles.get(s.id)! }));
}

// ── Accessors (used by ChatPanel to bridge module state) ──

export function getSessions(): ChatSession[] { return storeSessionsWithAgents(); }
export function getActiveIdx(): number { return useChatStore.getState().activeIdx; }
export function getActiveAgent(): ChatAgentHandle | null {
  const { sessions, activeIdx } = useChatStore.getState();
  const s = sessions[activeIdx];
  return s ? agentHandles.get(s.id) ?? null : null;
}
export function getNextSessionId(): number { return useChatStore.getState().nextSessionId; }
export function setNextSessionId(id: number): void {
  useChatStore.setState({ nextSessionId: id });
}
/** Sync the active session's token count into the per-session map. */
export function syncActiveSessionTokens(count: number): void {
  const { sessions, activeIdx } = useChatStore.getState();
  const s = sessions[activeIdx];
  if (s) useChatStore.getState().setSessionTokens(s.id, count);
}
export function getSessionMessages(): Map<number, HTMLElement[]> { return sessionMessages; }
export function getSessionMessageModels(): Map<number, ChatMessage[]> {
  // ponytail: adapter — callers expect Map, store uses Record
  const models = useChatStore.getState().sessionMessageModels;
  return new Map(Object.entries(models).map(([k, v]) => [Number(k), v]));
}
export function getTurnPairs(): Array<{ userText: string; userBubble: HTMLElement | null; assistantBubble: HTMLElement | null; sessionIndex: number }> { return turnPairs; }
export function setTurnPairs(pairs: Array<{ userText: string; userBubble: HTMLElement | null; assistantBubble: HTMLElement | null; sessionIndex: number }>): void { turnPairs = pairs; }
export function getAgentFactory(): (() => Promise<ChatAgentHandle | null>) | null { return agentFactory; }
export function setAgentFactory(fn: (() => Promise<ChatAgentHandle | null>) | null): void { agentFactory = fn; }

/** Full reset — used by setAgent in ChatPanel when switching workspace. */
export function resetSessionState(ag: ChatAgentHandle): void {
  sessionMessages.clear();
  const id = useChatStore.getState().nextSessionId;
  const label = '会话 1';
  agentHandles.clear();
  agentHandles.set(id, ag);
  useChatStore.setState({
    sessions: [{ id, label }],
    activeIdx: 0,
    sessionTokens: {},
    sessionMessageModels: {},
    nextSessionId: id + 1,
  });
  turnPairs = [];
}

// ── SessionContext — the bridge between standalone session functions and ChatPanel state ──

export interface SessionContext {
  // DOM elements
  panel: HTMLElement;
  sessionTabs: HTMLElement;
  tabBar: HTMLElement;

  // Project path
  getProjectPath: () => string;

  // Agent
  agentFactory: (() => Promise<ChatAgentHandle | null>) | null;

  // Message model
  getMessages: () => ChatMessage[];
  setMessages: (msgs: ChatMessage[]) => void;
  getStreamingAssistantId: () => MessageId | null;
  setStreamingAssistantId: (id: MessageId | null) => void;

  // ⚡ Zustand store drives React re-render — no bump needed

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

  // Usage text
  getLastUsageText: () => string;
  setLastUsageText: (s: string) => void;

  // Agent diagnostics (for error messages)
  getLastAgentDiag: () => string;

  // Input history (reset on new session)
  clearInputHistory: () => void;

  // StarGraph (for node-link wiring in restored sessions)
  getStarGraph: () => import('./graph').StarGraph | null;
}

// ── Helpers ──

/** djb2 hash for project path → localStorage key isolation. */
export function hashProjectPath(projectPath: string): number {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/** Strip read_file_content's cat -n line numbers. Rust backend always returns
 *  "{:>6}\t{content}" format. Session JSON files need this stripped before parse. */
export function stripLineNumbers(text: string): string {
  return text.split('\n').map(l => l.replace(/^\s*\d+\t/, '')).join('\n');
}

// ── Session CRUD ──

export function renderSessionTabs(ctx: SessionContext): void {
  const { sessions, activeIdx } = useChatStore.getState();
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
    chatTab.textContent = multi && activeSess
      ? (activeSess.label.length > 6 ? activeSess.label.slice(0, 5) + '…' : activeSess.label)
      : '对话';
  }
}

export function switchSession(ctx: SessionContext, idx: number): void {
  const { sessions, activeIdx } = useChatStore.getState();
  if (idx === activeIdx || idx < 0 || idx >= sessions.length) return;
  // Save current messages + token count to cache
  if (activeIdx >= 0) {
    saveCurrentMessages(ctx);
    useChatStore.getState().setSessionTokens(sessions[activeIdx].id, ctx.getTotalTokensUsed());
  }
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  // Switch
  useChatStore.setState({ activeIdx: idx });
  renderSessionTabs(ctx);
  restoreMessages(ctx);
  // Restore target session's token count
  ctx.setTotalTokensUsed(useChatStore.getState().sessionTokens[sessions[idx].id] || 0);
  ctx.setLastUsageText('');
  ctx.updateFooter();
}

export function closeSession(ctx: SessionContext, idx: number): void {
  const st = useChatStore.getState();
  if (st.sessions.length <= 1) {
    ctx.addNotice('至少保留一个会话', 'info');
    return;
  }
  if (idx === st.activeIdx && ctx.getRunning()) ctx.abort();
  const s = st.sessions[idx];
  sessionMessages.delete(s.id);
  agentHandles.delete(s.id);
  st.removeSession(s.id);
  const projectPath = ctx.getProjectPath();
  if (projectPath) {
    saveActiveSession(ctx, projectPath).then(() => {
      const st2 = useChatStore.getState();
      const newSessions = [...st2.sessions];
      newSessions.splice(idx, 1);
      let newIdx = st2.activeIdx;
      if (newIdx >= newSessions.length) newIdx = newSessions.length - 1;
      if (newIdx < 0) newIdx = 0;
      useChatStore.setState({ sessions: newSessions, activeIdx: newIdx });
      renderSessionTabs(ctx);
      restoreMessages(ctx);
      ctx.updateFooter();
    }).catch((e: unknown) => {
      console.error('[chat] closeSession save failed:', e);
      sessionMessages.set(s.id, []); // restore
      ctx.addNotice('关闭会话失败', 'error');
    });
  } else {
    const newSessions = [...st.sessions];
    newSessions.splice(idx, 1);
    let newIdx = st.activeIdx;
    if (newIdx >= newSessions.length) newIdx = newSessions.length - 1;
    if (newIdx < 0) newIdx = 0;
    useChatStore.setState({ sessions: newSessions, activeIdx: newIdx });
    renderSessionTabs(ctx);
    restoreMessages(ctx);
    ctx.updateFooter();
  }
}

export async function createNewSession(ctx: SessionContext): Promise<void> {
  if (!ctx.agentFactory) {
    const extra = ctx.getLastAgentDiag() ? `\n诊断: ${ctx.getLastAgentDiag()}` : '';
    ctx.addNotice(`请先配置 API Key（设置 → Provider）${extra}`, 'info');
    return;
  }
  const newAgent = await ctx.agentFactory();
  if (!newAgent) {
    ctx.addNotice('无法创建会话: Agent 工厂返回空', 'error');
    return;
  }
  const st = useChatStore.getState();
  if (st.activeIdx >= 0) saveCurrentMessages(ctx);
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  const id = st.nextSessionId;
  const label = `会话 ${st.sessions.length + 1}`;
  agentHandles.set(id, newAgent);
  useChatStore.setState({
    sessions: [...st.sessions, { id, label }],
    activeIdx: st.sessions.length,
    nextSessionId: id + 1,
  });
  renderSessionTabs(ctx);
  ctx.setMessages([]);
  bumpChat();
  resetMsgIdCounter();
  ctx.setStreamingAssistantId(null);
  ctx.clearInputHistory();
  setTurnPairs([]);
  ctx.setTotalTokensUsed(0);
  useChatStore.getState().setSessionTokens(id, 0);
  ctx.addNotice('新会话已创建 — 可以开始对话', 'info');
  ctx.setLastUsageText('');
  ctx.updateFooter();
}

// ── Session message cache ──

function saveCurrentMessages(ctx: SessionContext): void {
  const { sessions, activeIdx } = useChatStore.getState();
  const sid = sessions[activeIdx]?.id;
  if (!sid) return;
  useChatStore.getState().setSessionMessageModels(sid, [...ctx.getMessages()]);
}

function restoreMessages(ctx: SessionContext): void {
  const { sessions, activeIdx, sessionMessageModels } = useChatStore.getState();
  const sid = sessions[activeIdx]?.id;
  if (!sid) return;

  const cachedMessages = sessionMessageModels[sid];
  if (cachedMessages && cachedMessages.length > 0) {
    ctx.setMessages(cachedMessages);
    bumpChat();
    return;
  }

  const agent = agentHandles.get(sid);
  if (agent) {
    _rebuildMessagesFromSession(ctx);
    bumpChat();
  }
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
    const entries = await rpc<any[]>('list_directory', { path: sessionsDir(projectPath) });
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
  const { sessions, activeIdx } = useChatStore.getState();
  if (!projectPath || activeIdx < 0) return;
  const sMeta = sessions[activeIdx];
  if (!sMeta) return;
  const agent = agentHandles.get(sMeta.id);
  if (!agent) return;

  saveCurrentMessages(ctx);
  useChatStore.getState().setSessionTokens(sMeta.id, ctx.getTotalTokensUsed());

  const data = {
    id: sMeta.id,
    label: sMeta.label,
    savedAt: new Date().toISOString(),
    messages: agent.getSession(),
    tokensUsed: ctx.getTotalTokensUsed(),
  };

  // 1) Sync localStorage backup — survives beforeunload timeout / process kill
  const json = JSON.stringify(data);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(lsKey(projectPath, sMeta.id), json);
    }
  } catch { /* quota exceeded — disk write is the fallback */ }

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
      content: JSON.stringify({ lastId: sMeta.id, nextId: useChatStore.getState().nextSessionId }),
    });
  } catch { /* non-critical */ }
}

/** Restore the last active session on project open.
 *  Tries file first, falls back to localStorage (survives app crash / force-close). */
export async function autoRestoreLastSession(ctx: SessionContext, projectPath: string): Promise<void> {
  if (!ctx.agentFactory || !projectPath) return;

  let curNextId = useChatStore.getState().nextSessionId;

  // ── Resolve last session id ──
  let lastId = 0;
  // 1) Tracker file
  try {
    const t = await readSessionJSON(trackerFile(projectPath));
    lastId = t.lastId || 0;
    const trackerNextId = t.nextId || (lastId + 1) || 1;
    curNextId = Math.max(curNextId, trackerNextId);
  } catch { /* tracker missing — try localStorage scan below */ }

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
      } catch { /* skip corrupt entry */ }
    }
    if (lastId) curNextId = lastId + 1;
  }
  if (!lastId) {
    useChatStore.setState({ nextSessionId: 1 });
    ctx.addNotice('未找到历史会话，已创建新会话', 'info');
    return;
  }

  // ── Load session data (file first, localStorage fallback) ──
  let data: any = null;
  // 1) Try disk file
  try {
    data = await readSessionJSON(sessionFile(projectPath, lastId));
  } catch { /* file missing — try localStorage */ }

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
      } catch { /* corrupt localStorage entry */ }
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
      let bestId = 0; let bestTs = '';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(wsPrefix)) continue;
        try {
          const d = JSON.parse(localStorage.getItem(key)!);
          if (d.id && !d.deleted && d.savedAt > bestTs) {
            // Quick check: does it have non-system messages?
            const hasConv = (d.messages as any[])?.some?.((m: any) => m.role !== 'system');
            if (hasConv) { bestTs = d.savedAt; bestId = d.id; }
          }
        } catch { /* skip */ }
      }
      if (bestId > 0 && bestId !== lastId) {
        try {
          const lsRaw = localStorage.getItem(lsKey(projectPath, bestId));
          if (lsRaw) { data = JSON.parse(lsRaw); lastId = bestId; }
        } catch { /* keep original empty data */ }
      }
    }
  }

  const newAgent = await ctx.agentFactory();
  if (!newAgent) {
    ctx.addNotice('Agent 未就绪（API Key 未配置？），历史会话暂未恢复', 'warn');
    return;
  }

  const freshSys = newAgent.getSession().filter((m: Message) => m.role === 'system');
  const conv = (data.messages as Message[]).filter((m: Message) => m.role !== 'system');
  newAgent.setSession([...freshSys, ...conv]);

  const curSt = useChatStore.getState();
  if (curSt.activeIdx >= 0) saveCurrentMessages(ctx);
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  const label = data.label && !data.label.startsWith('会话 ') ? data.label : '已恢复的会话';
  // Replace ALL sessions — switch workspace = fresh start
  sessionMessages.clear();
  agentHandles.clear();
  agentHandles.set(data.id, newAgent);
  useChatStore.setState({
    sessions: [{ id: data.id, label }],
    activeIdx: 0,
    nextSessionId: Math.max(curNextId, curSt.nextSessionId),
  });
  renderSessionTabs(ctx);

  try { renderRestoredSession(ctx); } catch (e) {
    console.error('[chat] render 崩溃', e);
  }

  ctx.setLastUsageText('');
  ctx.updateFooter();
}

/** Scan sessions directory — no agent required. */
export async function listSavedSessions(ctx: SessionContext, projectPath: string): Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string }>> {
  const dirPath = sessionsDir(projectPath);
  let entries: any[];
  try {
    entries = await rpc<any[]>('list_directory', { path: dirPath });
  } catch (e) {
    console.error('[chat] listSavedSessions: list_directory failed', e);
    return [];
  }

  if (!Array.isArray(entries)) {
    console.error('[chat] listSavedSessions: unexpected result', typeof entries);
    return [];
  }

  // Filter valid JSON session files (skip dirs, _active.json, non-json)
  const targets = entries.filter(e =>
    !e.is_dir && e.name.endsWith('.json') && e.name !== '_active.json' && !isNaN(parseInt(e.name.replace('.json', ''), 10)),
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
    setTimeout(() => { console.warn('[chat] listSavedSessions: timed out after 10s'); resolve([]); }, TIMEOUT_MS),
  );

  const results = await Promise.race([Promise.all(readPromises), timeout]);
  if (!Array.isArray(results)) return [];

  const result = results.filter(r => r !== null) as SessionEntry[];
  result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return result;
}

/** Load a saved session from disk into a new tab. Falls back to localStorage. */
export async function loadSessionFromDisk(ctx: SessionContext, projectPath: string, sessionId: number): Promise<void> {
  if (!ctx.agentFactory) {
    const extra = ctx.getLastAgentDiag() ? `\n诊断: ${ctx.getLastAgentDiag()}` : '';
    ctx.addNotice(`请先配置 API Key${extra}`, 'error');
    return;
  }

  let data: any;
  // 1) Try disk file
  try {
    data = await readSessionJSON(sessionFile(projectPath, sessionId));
  } catch { /* try localStorage */ }

  // 2) localStorage fallback
  if (!data && typeof localStorage !== 'undefined') {
    const lsRaw = localStorage.getItem(lsKey(projectPath, sessionId));
    if (lsRaw) {
      try { data = JSON.parse(lsRaw); } catch { /* corrupt */ }
    }
  }
  if (!data) {
    ctx.addNotice('会话文件读取失败', 'error');
    return;
  }

  const newAgent = await ctx.agentFactory();
  if (!newAgent) { ctx.addNotice('无法创建 Agent', 'error'); return; }

  const freshSys = newAgent.getSession().filter((m: Message) => m.role === 'system');
  const conv = (data.messages as Message[]).filter((m: Message) => m.role !== 'system');
  newAgent.setSession([...freshSys, ...conv]);

  const firstUser = conv.find((m: Message) => m.role === 'user' && !m.content?.startsWith('<compacted-context>'));
  const st1 = useChatStore.getState();
  const label = (data.label && !data.label.startsWith('会话 '))
    ? data.label
    : firstUser ? firstUser.content!.slice(0, 28) + (firstUser.content!.length > 28 ? '…' : '') : `会话 ${st1.sessions.length + 1}`;

  if (st1.activeIdx >= 0) saveCurrentMessages(ctx);
  ctx.flushReasoning(); ctx.flushText(); ctx.clearPendingToolCards();

  const sid = data.id || sessionId;
  agentHandles.set(sid, newAgent);
  useChatStore.setState({
    sessions: [...st1.sessions, { id: sid, label }],
    activeIdx: st1.sessions.length,
  });
  if (typeof data.tokensUsed === 'number') {
    ctx.setTotalTokensUsed(data.tokensUsed);
    useChatStore.getState().setSessionTokens(sid, data.tokensUsed);
  } else {
    ctx.setTotalTokensUsed(0);
    useChatStore.getState().setSessionTokens(sid, 0);
  }
  renderSessionTabs(ctx);
  renderRestoredSession(ctx);
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
  } catch { /* ignore */ }
  // If this session is open in a tab, close that tab
  const idx = useChatStore.getState().sessions.findIndex(s => s.id === sessionId);
  if (idx >= 0) closeSession(ctx, idx);
}

// ── Session restore (internal helpers) ──

/** Walk through active agent's session array and build ChatMessage[] + turnPairs. */
function renderRestoredSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = useChatStore.getState();
  const agent = agentHandles.get(sessions[activeIdx]?.id ?? -1);
  if (!agent) return;
  _rebuildMessagesFromSession(ctx);
  bumpChat();
  ctx.addNotice(`已恢复 ${sessions.length} 个会话`, 'info');
}

/** Populate ctx.getMessages()[] + turnPairs from active agent's getSession().
 *  Pure data rebuild — no DOM sync, no notices. */
export function _rebuildMessagesFromSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = useChatStore.getState();
  const agent = agentHandles.get(sessions[activeIdx]?.id ?? -1);
  if (!agent) return;

  const msgs = agent.getSession();

  // Reset messages and rebuild from session data
  resetMsgIdCounter();
  ctx.setMessages([]);
  setTurnPairs([]);

  // Index tool results by call_id so we can attach outputs to tool parts
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
        ctx.getMessages().push(createNoticeMessage('📋 上下文已压缩', 'info'));
        continue;
      }
      // Finalize previous pair
      if (pendingUserText && pendingUserId) {
        turnPairs.push({ userText: pendingUserText, userBubble: null, assistantBubble: null, sessionIndex: pendingSessionIdx });
      }
      pendingUserText = m.content || '';
      pendingUserId = nextMsgId();
      pendingSessionIdx = idx;
      const um = createUserMessage(m.content || '', undefined, idx);
      ctx.getMessages().push(um);
      pendingUserId = um._id;
      continue;
    }

    if (m.role === 'tool') continue;

    if (m.role === 'assistant') {
      const am = createAssistantMessage(pendingUserId || '');
      am.status = 'done';

      // Reasoning
      if (m.reasoning_content) {
        am.parts.push({ type: 'reasoning', text: m.reasoning_content });
      }

      // Tool calls — output comes from matching tool-result messages
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

      // Text content — always add if present, regardless of tool calls
      if (m.content) {
        am.parts.push({ type: 'text', text: m.content, finalised: true });
      }

      ctx.getMessages().push(am);

      // Link to pending user turn
      if (pendingUserText) {
        turnPairs.push({ userText: pendingUserText, userBubble: null, assistantBubble: null, sessionIndex: pendingSessionIdx });
        pendingUserText = null;
        pendingUserId = null;
      }
    }
  }

  // Flush any trailing user message
  if (pendingUserText) {
    turnPairs.push({ userText: pendingUserText, userBubble: null, assistantBubble: null, sessionIndex: pendingSessionIdx });
  }
}

// ── Turn retraction ──

/** Retract a turn from DOM and agent session. Returns userText or null. */
export function retractTurn(ctx: SessionContext, idx: number): string | null {
  const pair = turnPairs[idx];
  if (!pair) return null;
  // ⚡ React handles DOM removal, just clean the model
  // Remove from agent session — search by content if index is stale (inserted mid-run)
  let sessIdx = pair.sessionIndex;
  const { sessions, activeIdx } = useChatStore.getState();
  const agent = agentHandles.get(sessions[activeIdx]?.id ?? -1);
  if (sessIdx < 0 && agent) {
    const agentSession = agent.getSession();
    for (let i = 0; i < agentSession.length; i++) {
      if (agentSession[i].role === 'user' && agentSession[i].content === pair.userText) {
        sessIdx = i; break;
      }
    }
  }
  if (sessIdx >= 0) agent?.retractTurnAt(sessIdx);
  // Remove from turnPairs
  turnPairs.splice(idx, 1);
  // Re-index sessionIndex for remaining pairs from the actual session
  if (agent) {
    const agentSession = agent.getSession();
    const userMsgIndices: number[] = [];
    for (let i = 0; i < agentSession.length; i++) {
      if (agentSession[i].role === 'user') userMsgIndices.push(i);
    }
    for (let i = 0; i < turnPairs.length && i < userMsgIndices.length; i++) {
      turnPairs[i].sessionIndex = userMsgIndices[i];
    }
  }
  return pair.userText;
}

/** Retract a single user message (and its assistant response) from the model + DOM. */
export function _retractUserMessage(ctx: SessionContext, msg: UserMessage): void {
  const msgs = ctx.getMessages();
  const idx = msgs.indexOf(msg as any as ChatMessage);
  if (idx >= 0) {
    // Remove the user message and its assistant response
    const toRemove: number[] = [idx];
    // Find the assistant that responded to this
    for (let i = idx + 1; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'assistant' && (m as AssistantMessage).respondingTo === msg._id) {
        toRemove.push(i);
        break;
      } else if (m.role === 'user') {
        break; // next user message → stop
      }
    }
    for (const i of toRemove.reverse()) {
      msgs.splice(i, 1);
    }
  }
  // Also retract from agent session
  if (msg.sessionIndex >= 0) {
    const { sessions, activeIdx } = useChatStore.getState();
    agentHandles.get(sessions[activeIdx]?.id ?? -1)?.retractTurnAt(msg.sessionIndex);
  }
}

// ── Conversation export ──

export async function exportSession(ctx: SessionContext): Promise<void> {
  const { sessions, activeIdx } = useChatStore.getState();
  const agent = agentHandles.get(sessions[activeIdx]?.id ?? -1);
  if (!agent) { ctx.addNotice('没有可导出的会话', 'info'); return; }

  const msgs = agent.getSession();
  const settings = loadSettings();
  const active = settings.providers.find(p => p.name === settings.activeProvider) || settings.providers[0];
  const mode = CHAT_MODES.find(m => m.id === (settings.agent?.chatMode || 'general')) || CHAT_MODES[0];
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  let md = `# HoloGram 会话 — ${dateStr}\n`;
  md += `> 模型: ${active?.model || 'unknown'} · 模式: ${mode.label} · 总 token: ${ctx.getTotalTokensUsed().toLocaleString()}\n\n`;

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
