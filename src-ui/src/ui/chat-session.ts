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
import { invoke } from '../bridge';
import { loadSettings, CHAT_MODES } from '../settings';
import type { Message } from '../provider/types';
import { iconHtml } from './icons';

// ── Module-level session state ──

export interface ChatSession {
  id: number;
  label: string;
  agent: ChatAgentHandle;
}

let sessions: ChatSession[] = [];
let activeIdx = -1;
const sessionMessages = new Map<number, HTMLElement[]>();
const sessionMessageModels = new Map<number, ChatMessage[]>();
/** Per-session token count — saved/restored on switch to prevent cross-session contamination. */
const sessionTokens = new Map<number, number>();
let turnPairs: Array<{ userText: string; userBubble: HTMLElement | null; assistantBubble: HTMLElement | null; sessionIndex: number }> = [];
let agentFactory: (() => Promise<ChatAgentHandle | null>) | null = null;
let nextSessionId = 1;

// ── Accessors (used by ChatPanel to bridge module state) ──

export function getSessions(): ChatSession[] { return sessions; }
export function getActiveIdx(): number { return activeIdx; }
export function getActiveAgent(): ChatAgentHandle | null { return sessions[activeIdx]?.agent ?? null; }
export function getNextSessionId(): number { return nextSessionId; }
export function setNextSessionId(id: number): void { nextSessionId = id; }
/** Sync the active session's token count into the per-session map. Call after direct totalTokensUsed mutations outside switchSession. */
export function syncActiveSessionTokens(count: number): void {
  const s = sessions[activeIdx];
  if (s) sessionTokens.set(s.id, count);
}
export function getSessionMessages(): Map<number, HTMLElement[]> { return sessionMessages; }
export function getSessionMessageModels(): Map<number, ChatMessage[]> { return sessionMessageModels; }
export function getTurnPairs(): Array<{ userText: string; userBubble: HTMLElement | null; assistantBubble: HTMLElement | null; sessionIndex: number }> { return turnPairs; }
export function setTurnPairs(pairs: Array<{ userText: string; userBubble: HTMLElement | null; assistantBubble: HTMLElement | null; sessionIndex: number }>): void { turnPairs = pairs; }
export function getAgentFactory(): (() => Promise<ChatAgentHandle | null>) | null { return agentFactory; }
export function setAgentFactory(fn: (() => Promise<ChatAgentHandle | null>) | null): void { agentFactory = fn; }

/** Full reset — used by setAgent in ChatPanel when switching workspace. */
export function resetSessionState(ag: ChatAgentHandle): void {
  sessionMessages.clear();
  sessionTokens.clear();
  sessions = [{ id: nextSessionId++, label: `会话 1`, agent: ag }];
  activeIdx = 0;
  turnPairs = [];
}

// ── SessionContext — the bridge between standalone session functions and ChatPanel state ──

export interface SessionContext {
  // DOM elements
  panel: HTMLElement;
  msgList: HTMLElement;
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

  // DOM sync & scroll
  scrollBottom: () => void;
  syncMessagesToDOM: () => void;

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

  // Handlers
  reWireHandlers: () => void;

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
  ctx.sessionTabs.innerHTML = '';
  const multi = sessions.length > 1;
  // Toggle the entire session bar row — hidden when ≤ 1 session
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

  // When multiple sessions: "对话" tab shows active session name
  const chatTab = ctx.tabBar.querySelector<HTMLElement>('.chat-panel-tab[data-tab="chat"]');
  if (chatTab) {
    const activeSess = sessions[activeIdx];
    chatTab.textContent = multi && activeSess
      ? (activeSess.label.length > 6 ? activeSess.label.slice(0, 5) + '…' : activeSess.label)
      : '对话';
  }
}

export function switchSession(ctx: SessionContext, idx: number): void {
  if (idx === activeIdx || idx < 0 || idx >= sessions.length) return;
  // Save current messages + token count to cache
  if (activeIdx >= 0) {
    saveCurrentMessages(ctx);
    sessionTokens.set(sessions[activeIdx].id, ctx.getTotalTokensUsed());
  }
  // Flush any in-progress streaming
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  // Switch
  activeIdx = idx;
  renderSessionTabs(ctx);
  restoreMessages(ctx);
  // Restore target session's token count
  ctx.setTotalTokensUsed(sessionTokens.get(sessions[idx].id) || 0);
  ctx.setLastUsageText('');
  ctx.updateFooter();
}

export function closeSession(ctx: SessionContext, idx: number): void {
  if (sessions.length <= 1) {
    ctx.addNotice('至少保留一个会话', 'info');
    return;
  }
  // Abort if closing active running session
  if (idx === activeIdx && ctx.getRunning()) ctx.abort();
  // Remove session — persist before mutating memory
  const s = sessions[idx];
  sessionMessages.delete(s.id);
  sessionTokens.delete(s.id);
  // Persist deletion
  const projectPath = ctx.getProjectPath();
  if (projectPath) {
    saveActiveSession(ctx, projectPath).then(() => {
      sessions.splice(idx, 1);
      if (activeIdx >= sessions.length) activeIdx = sessions.length - 1;
      if (activeIdx < 0) activeIdx = 0;
      renderSessionTabs(ctx);
      restoreMessages(ctx);
      ctx.updateFooter();
    }).catch((e: unknown) => {
      console.error('[chat] closeSession save failed:', e);
      sessionMessages.set(s.id, []); // restore
      ctx.addNotice('关闭会话失败', 'error');
    });
  } else {
    sessions.splice(idx, 1);
    if (activeIdx >= sessions.length) activeIdx = sessions.length - 1;
    if (activeIdx < 0) activeIdx = 0;
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
  // Save current messages
  if (activeIdx >= 0) saveCurrentMessages(ctx);
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  // Add new session
  const s: ChatSession = {
    id: nextSessionId++,
    label: `会话 ${sessions.length + 1}`,
    agent: newAgent,
  };
  sessions.push(s);
  activeIdx = sessions.length - 1;
  renderSessionTabs(ctx);
  // Clear displayed messages for the new session
  ctx.setMessages([]);
  resetMsgIdCounter();
  ctx.setStreamingAssistantId(null);
  ctx.msgList.innerHTML = '';
  ctx.clearInputHistory();
  setTurnPairs([]);
  ctx.setTotalTokensUsed(0);
  sessionTokens.set(s.id, 0);
  ctx.addNotice('新会话已创建 — 可以开始对话', 'info');
  ctx.setLastUsageText('');
  ctx.updateFooter();
}

// ── Session message cache ──

function saveCurrentMessages(ctx: SessionContext): void {
  const sid = sessions[activeIdx]?.id;
  if (!sid) return;
  const children = Array.from(ctx.msgList.children) as HTMLElement[];
  sessionMessages.set(sid, children);
  // Also save the message model so restoreMessages can use the new renderer
  sessionMessageModels.set(sid, [...ctx.getMessages()]);
}

function restoreMessages(ctx: SessionContext): void {
  ctx.msgList.innerHTML = '';
  const sid = sessions[activeIdx]?.id;
  if (!sid) return;

  // Try to restore from message model cache first
  const cachedMessages = sessionMessageModels.get(sid);
  if (cachedMessages) {
    ctx.setMessages(cachedMessages);
    ctx.syncMessagesToDOM();
    return;
  }

  // Fall back: rebuild from agent session (no DOM cloning — that bypassed
  // the model and got wiped by the next _syncMessagesToDOM).
  const agent = sessions[activeIdx]?.agent;
  if (agent) {
    _rebuildMessagesFromSession(ctx);
    ctx.syncMessagesToDOM();
    // Re-wire node-link click handlers
    ctx.msgList.querySelectorAll('.node-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = (link as HTMLElement).dataset['nodename'] || '';
        const sg = ctx.getStarGraph();
        if (name && sg) {
          const found = sg.focusNode(name);
          if (!found) ctx.addNotice(`未在图中找到 "${name}"`, 'info');
        }
      });
    });
  }
  ctx.scrollBottom();
}

// ── Session persistence — one file per session, localStorage backup ──

/** Read a session file and parse as JSON. Handles read_file_content's line numbers. */
async function readSessionJSON(filePath: string): Promise<any> {
  const raw = await invoke<string>('read_file_content', { filePath });
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
    const entries = await invoke<any[]>('list_directory', { path: sessionsDir(projectPath) });
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
  if (!projectPath || activeIdx < 0) return;
  const s = sessions[activeIdx];
  if (!s) return;

  saveCurrentMessages(ctx);

  // Snapshot current token count before persisting
  sessionTokens.set(s.id, ctx.getTotalTokensUsed());

  const data = {
    id: s.id,
    label: s.label,
    savedAt: new Date().toISOString(),
    messages: s.agent.getSession(),
    tokensUsed: ctx.getTotalTokensUsed(),
  };

  // 1) Sync localStorage backup — survives beforeunload timeout / process kill
  const json = JSON.stringify(data);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(lsKey(projectPath, s.id), json);
    }
  } catch { /* quota exceeded — disk write is the fallback */ }

  // 2) Async disk write (atomic: tmp → rename)
  try {
    await invoke('write_file_content', {
      filePath: sessionFile(projectPath, s.id),
      content: json,
    });
  } catch (e) {
    console.error('[chat] saveActiveSession 失败:', e);
  }

  try {
    await invoke('write_file_content', {
      filePath: trackerFile(projectPath),
      content: JSON.stringify({ lastId: s.id, nextId: nextSessionId }),
    });
  } catch { /* non-critical */ }
}

/** Restore the last active session on project open.
 *  Tries file first, falls back to localStorage (survives app crash / force-close). */
export async function autoRestoreLastSession(ctx: SessionContext, projectPath: string): Promise<void> {
  if (!ctx.agentFactory || !projectPath) return;

  // ── Resolve last session id ──
  let lastId = 0;
  // 1) Tracker file
  try {
    const t = await readSessionJSON(trackerFile(projectPath));
    lastId = t.lastId || 0;
    // ponytail: never let tracker push nextSessionId backwards — it causes ID collisions
    // when the tracker was saved with a stale value (e.g. after workspace switch)
    const trackerNextId = t.nextId || (lastId + 1) || 1;
    nextSessionId = Math.max(nextSessionId, trackerNextId);
  } catch { /* tracker missing — try localStorage scan below */ }

  // 2) If tracker missing, scan localStorage for newest session IN THIS WORKSPACE
  if (!lastId && typeof localStorage !== 'undefined') {
    // Compute workspace prefix so we don't pick up sessions from other projects
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
    if (lastId) nextSessionId = lastId + 1;
  }
  if (!lastId) {
    // Fresh workspace — reset session ID counter to avoid carry-over from previous project
    nextSessionId = 1;
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

  if (activeIdx >= 0) saveCurrentMessages(ctx);
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  const label = data.label && !data.label.startsWith('会话 ') ? data.label : '已恢复的会话';
  // Replace ALL sessions — switch workspace = fresh start
  sessionMessages.clear();
  sessions = [{ id: data.id, label, agent: newAgent }];
  activeIdx = 0;
  renderSessionTabs(ctx);
  ctx.msgList.innerHTML = '';

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
    entries = await invoke<any[]>('list_directory', { path: dirPath });
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
  const label = (data.label && !data.label.startsWith('会话 '))
    ? data.label
    : firstUser ? firstUser.content!.slice(0, 28) + (firstUser.content!.length > 28 ? '…' : '') : `会话 ${sessions.length + 1}`;

  if (activeIdx >= 0) saveCurrentMessages(ctx);
  ctx.flushReasoning(); ctx.flushText(); ctx.clearPendingToolCards();

  sessions.push({ id: data.id || sessionId, label, agent: newAgent });
  activeIdx = sessions.length - 1;
  // Restore persisted token count
  if (typeof data.tokensUsed === 'number') {
    ctx.setTotalTokensUsed(data.tokensUsed);
    sessionTokens.set(data.id || sessionId, data.tokensUsed);
  } else {
    ctx.setTotalTokensUsed(0);
    sessionTokens.set(data.id || sessionId, 0);
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
    await invoke('write_file_content', {
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
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx >= 0) closeSession(ctx, idx);
}

// ── Session restore (internal helpers) ──

/** Walk through active agent's session array and build ChatMessage[] + turnPairs. */
function renderRestoredSession(ctx: SessionContext): void {
  const agent = sessions[activeIdx]?.agent;
  if (!agent) return;
  _rebuildMessagesFromSession(ctx);
  ctx.syncMessagesToDOM();

  // Wire up turnPairs userBubble refs
  let pairIdx = 0;
  const userRows = ctx.msgList.querySelectorAll<HTMLElement>('.msg-user-row');
  userRows.forEach((row) => {
    if (pairIdx < turnPairs.length) {
      turnPairs[pairIdx].userBubble = row;
      pairIdx++;
    }
  });

  // Re-wire node-link click handlers
  ctx.msgList.querySelectorAll('.node-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = (link as HTMLElement).dataset['nodename'] || '';
      const sg = ctx.getStarGraph();
      if (name && sg) {
        const found = sg.focusNode(name);
        if (!found) ctx.addNotice(`未在图中找到 "${name}"`, 'info');
      }
    });
  });

  ctx.scrollBottom();
  ctx.addNotice(`已恢复 ${sessions.length} 个会话`, 'info');
}

/** Populate ctx.getMessages()[] + turnPairs from active agent's getSession().
 *  Pure data rebuild — no DOM sync, no notices. */
export function _rebuildMessagesFromSession(ctx: SessionContext): void {
  const agent = sessions[activeIdx]?.agent;
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
  // Remove user row + assistant bubble from DOM
  if (pair.userBubble) pair.userBubble.remove();
  if (pair.assistantBubble) pair.assistantBubble.remove();
  // Remove from agent session — search by content if index is stale (inserted mid-run)
  let sessIdx = pair.sessionIndex;
  const agent = sessions[activeIdx]?.agent;
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
    sessions[activeIdx]?.agent?.retractTurnAt(msg.sessionIndex);
  }
  ctx.syncMessagesToDOM();
}

// ── Conversation export ──

export async function exportSession(ctx: SessionContext): Promise<void> {
  const agent = sessions[activeIdx]?.agent;
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
      await invoke('write_file_content', { path: filePath, content: md });
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
