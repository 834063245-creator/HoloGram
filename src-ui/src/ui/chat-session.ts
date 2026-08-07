// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 聊天面板 — 会话管理（CRUD、持久化、恢复）
// 从 chat.ts 的 ChatPanel 类中提取。
// 所有函数接收 SessionContext，而非访问 `this`。

import { agentSessionState, type OwnedAgentHandle, type TurnPair } from '../agent/agent-session-state';
import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import { createExecState, type ExecStateInstance } from '../agent/execution-state';
import { rpc } from '../bridge';
import type { Message } from '../provider/types';
import { loadSettings, getActiveProvider } from '../settings';
import { useAgentPanelStore } from './agent-panel-store';
import { bumpSession, getChatStore, msgStoreFor } from './chat-store';
import type { AssistantMessage, ChatMessage, MessageId, SubAgentPart, UserMessage } from './message-model';
import {
  createAssistantMessage,
  createNoticeMessage,
  createUserMessage,
  nextMsgId,
  resetMsgIdCounter,
} from './message-model';

// ── 模块级会话状态 ──
//
// 纯数据存放在 chat-store.ts（会话列表、activeIdx、token、nextId）。
// 不可序列化的句柄（Agent 实例、DOM 引用、回调）保留在此处。

export interface ChatSession {
  id: number;
  label: string;
  agent: ChatAgentHandle;
}

// ── 面板级模块状态（复合键：panelId:sessionId）──
// ponytail: 原为单例 Maps/数组 — 多个 ChatPanel 实例共享同一模块级状态
// 时导致跨面板泄漏。会话 ID 在不同面板间冲突（都从 1 开始），复合键
// 可防止错误的 agent / 错误的 execState / 错误的 turnPairs 等 bug。

/** Agent 在 session 中注入的内部上下文消息（非用户输入），恢复/导出时应跳过 */
const INTERNAL_PREFIXES = ['<system-reminder>', '<goal>', '<truncated-context>', '<compacted-context>'];
function isInternalMessage(content: string | undefined): boolean {
  if (!content) return false;
  return INTERNAL_PREFIXES.some((p) => content.startsWith(p));
}

// 模块级 Maps 已迁移到 AgentSessionState（agent/agent-session-state.ts）

// ── 辅助函数：将 store 会话桥接到 ChatSession（含 agent 句柄）──

function storeSessionsWithAgents(storeId: string): ChatSession[] {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  return sessions.map((s) => ({ ...s, agent: agentSessionState.getAgent(storeId, s.id)! }));
}

// ── 访问器（ChatPanel 用于桥接模块状态）──

export function getSessions(storeId: string): ChatSession[] {
  return storeSessionsWithAgents(storeId);
}
export function getActiveIdx(storeId: string): number {
  return getChatStore(storeId).sess.getState().activeIdx;
}
export function getActiveAgent(storeId: string): ChatAgentHandle | null {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  const s = sessions[activeIdx];
  return s ? (agentSessionState.getAgent(storeId, s.id) ?? null) : null;
}
export function getNextSessionId(storeId: string): number {
  return getChatStore(storeId).sess.getState().nextSessionId;
}
export function setNextSessionId(storeId: string, id: number): void {
  getChatStore(storeId).sess.setState({ nextSessionId: id });
}
/** 将活跃会话的 token 计数同步到会话级映射中。 */
export function syncActiveSessionTokens(storeId: string, count: number): void {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  const s = sessions[activeIdx];
  if (s) getChatStore(storeId).sess.getState().setSessionTokens(s.id, count);
}
export function getTurnPairs(storeId: string): TurnPair[] {
  return agentSessionState.getTurnPairs(storeId);
}
export function setTurnPairs(storeId: string, pairs: TurnPair[]): void {
  agentSessionState.setTurnPairs(storeId, pairs);
}
export function getAgentFactory(storeId: string) {
  return agentSessionState.getAgentFactory(storeId);
}
export function setAgentFactory(storeId: string, fn: (() => Promise<OwnedAgentHandle | null>) | null): void {
  agentSessionState.setAgentFactory(storeId, fn);
}

/** 获取或创建会话的 execState。 */
export function getSessionExecState(storeId: string, sessionId: number): ExecStateInstance {
  return agentSessionState.getOrCreateExec(storeId, sessionId);
}

/** 检查活跃会话以外的任何会话是否有运行中的 Agent。
 *  两个 Agent 同时流式输出会导致事件交错。 */
export function hasRunningBackgroundSession(storeId: string): boolean {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  for (let i = 0; i < sessions.length; i++) {
    if (i === activeIdx) continue;
    const es = agentSessionState.getExec(storeId, sessions[i].id);
    if (es?.isRunning) return true;
  }
  return false;
}

/** 清理已关闭会话的 execState。 */
export function removeSessionExecState(storeId: string, sessionId: number): void {
  agentSessionState.removeExec(storeId, sessionId);
}

/** 拆除面板全部 Agent 句柄与 exec 状态（dispose）— ChatCore.setAgent(null) 用，
 *  API Key 清空后旧 provider/工厂不得继续服务会话。 */
export function clearPanelAgents(storeId: string): void {
  agentSessionState.clearPanelState(storeId);
}

/** 全量重置 — 用于 ChatPanel 中切换工作区时的 setAgent。 */
export function resetSessionState(storeId: string, ag: OwnedAgentHandle): void {
  const id = getChatStore(storeId).sess.getState().nextSessionId;
  const label = '会话 1';
  // 仅清除本面板的 agent 句柄和 exec 状态
  agentSessionState.clearPanelState(storeId);
  agentSessionState.setAgent(storeId, id, ag);
  // 静态绑定该 Agent 的 board 到此会话 — 此后不再随会话切换重定向
  ag.bindSession?.(String(id));
  agentSessionState.setExec(storeId, id, createExecState());
  getChatStore(storeId).sess.setState({
    sessions: [{ id, label }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: id + 1,
  });
  // ponytail: 创建会话级消息 store — 唯一数据源
  msgStoreFor(storeId, id).getState().setMessages([]);
  setTurnPairs(storeId, []);
}

/** 若活跃会话仍为默认标签（"会话 N"），则从第一条用户消息自动命名。
 *  在每轮对话完成后调用。 */
export function autoTitleSessionIfDefault(storeId: string): void {
  const st = getChatStore(storeId).sess.getState();
  const { sessions, activeIdx } = st;
  const s = sessions[activeIdx];
  if (!s) return;

  // 仅在标签仍为默认的 "会话 N" 格式时自动命名
  if (!/^会话 \d+$/.test(s.label)) return;

  const agent = agentSessionState.getAgent(storeId, s.id);
  if (!agent) return;

  const msgs = agent.getSession();
  const firstUser = msgs.find((m) => m.role === 'user' && m.content && !m.content.startsWith('<compacted-context>'));
  if (!firstUser?.content) return;

  const derived = firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '');
  const updated = sessions.map((x, i) => (i === activeIdx ? { ...x, label: derived } : x));
  getChatStore(storeId).sess.setState({ sessions: updated });
}

// ── SessionContext — 独立会话函数与 ChatPanel 状态之间的桥接 ──

export interface SessionContext {
  storeId: string;

  // DOM 元素
  panel: HTMLElement;
  sessionTabs: HTMLElement;
  tabBar: HTMLElement;

  getProjectPath: () => string;

  // 流式辅助
  flushReasoning: () => void;
  flushText: () => void;
  clearPendingToolCards: () => void;

  // 运行状态
  getRunning: () => boolean;
  abort: () => void;

  // 通知与底栏
  addNotice: (text: string, level?: 'info' | 'warn' | 'error') => void;
  updateFooter: () => void;

  // Token 用量
  getTotalTokensUsed: () => number;
  setTotalTokensUsed: (n: number) => void;
  clearToolUsage: () => void;
  clearToolHistory: () => void;

  getLastUsageText: () => string;
  setLastUsageText: (s: string) => void;
  getLastAgentDiag: () => string;

  clearInputHistory: () => void;
  getStarGraph: () => import('./graph').StarGraph | null;

  /** 运行时访问，用于会话级 board 切换 */
  getRuntime?: () => import('../agent/runtime/types').RuntimePort | null;
}

// ── 辅助函数 ──

/** djb2 哈希，用于项目路径 → localStorage 键隔离。 */
export function hashProjectPath(projectPath: string): number {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = (hash << 5) - hash + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/** 去除 read_file_content 的 cat -n 行号。Rust 后端始终返回
 *  "{:>6}\t{content}" 格式。会话 JSON 文件在解析前需去除行号。 */
export function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

// ── 会话 CRUD ──

export function switchSession(ctx: SessionContext, idx: number): void {
  const st = getChatStore(ctx.storeId).sess.getState();
  const { sessions, activeIdx } = st;
  if (idx === activeIdx || idx < 0 || idx >= sessions.length) return;

  // ponytail: 消息存放在会话级 store 中 — 无需保存/恢复。
  // 只需保存 token 计数，切换 activeIdx，React 从新 store 重新渲染。
  if (activeIdx >= 0) {
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sessions[activeIdx].id, ctx.getTotalTokensUsed());
  }
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  getChatStore(ctx.storeId).sess.setState({ activeIdx: idx });

  // 切换会话级 board 到新会话
  const newSessionId = String(sessions[idx].id);
  const runtime = ctx.getRuntime?.();
  if (runtime) {
    runtime.setCurrentSession(newSessionId);
    useAgentPanelStore.getState().setCurrentSessionId(newSessionId);
  }

  // 恢复目标会话的 token 计数
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
  agentSessionState.removeAgent(ctx.storeId, s.id);

  const newSessions = [...st.sessions];
  newSessions.splice(idx, 1);
  // 调整 activeIdx：若关闭的会话在活跃会话之前，则左移；
  // 若关闭的是活跃会话，则下一个会话变为活跃（或钳制）。
  let newIdx = st.activeIdx;
  if (idx < st.activeIdx) newIdx = st.activeIdx - 1;
  if (newIdx >= newSessions.length) newIdx = newSessions.length - 1;
  if (newIdx < 0) newIdx = 0;

  // 在销毁旧 board 之前将面板指向新活跃会话 —
  // 已关闭会话的 Agent 已在上方 dispose（removeAgent），其 proxies 随句柄消亡；
  // 静态绑定下不存在指向已销毁 board 的残留 proxy，destroy 不会复活文件。
  const runtime = ctx.getRuntime?.();
  const newSessionId = String(newSessions[newIdx].id);
  if (runtime) {
    runtime.setCurrentSession(newSessionId);
    useAgentPanelStore.getState().setCurrentSessionId(newSessionId);
  }

  getChatStore(ctx.storeId).sess.setState({ sessions: newSessions, activeIdx: newIdx });
  // ponytail: 无需 restoreMessages — React 自动从会话级 store 读取
  ctx.updateFooter();

  // 现在销毁已关闭会话的 board（尽力而为，异步触发）
  if (runtime) {
    runtime.destroySessionBoards(String(s.id)).catch(() => {});
  }

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
  // ponytail: 消息在会话级 store 中 — 无需保存/恢复。
  // 只需保存旧会话的 token 计数。
  if (st.activeIdx >= 0) {
    const oldSid = st.sessions[st.activeIdx].id;
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(oldSid, ctx.getTotalTokensUsed());
  }
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  const id = st.nextSessionId;
  const label = `会话 ${st.sessions.length + 1}`;
  agentSessionState.setAgent(ctx.storeId, id, newAgent);
  // 静态绑定该 Agent 的 board 到新会话（id 在 factory 之后才确定）
  newAgent.bindSession?.(String(id));
  agentSessionState.setExec(ctx.storeId, id, createExecState());
  getChatStore(ctx.storeId).sess.setState({
    sessions: [...st.sessions, { id, label }],
    activeIdx: st.sessions.length,
    nextSessionId: id + 1,
  });
  // ponytail: 创建会话级消息 store — 唯一数据源
  msgStoreFor(ctx.storeId, id).getState().setMessages([]);
  resetMsgIdCounter();
  ctx.clearInputHistory();
  setTurnPairs(ctx.storeId, []);
  ctx.setTotalTokensUsed(0);
  getChatStore(ctx.storeId).sess.getState().setSessionTokens(id, 0);

  // 切换会话级 board 到新会话
  const runtime = ctx.getRuntime?.();
  if (runtime) {
    runtime.setCurrentSession(String(id));
    useAgentPanelStore.getState().setCurrentSessionId(String(id));
  }

  ctx.addNotice(`新会话已创建 — 会话 ${st.sessions[st.activeIdx]?.label ?? ''} 仍在后台运行`, 'info');
  ctx.setLastUsageText('');
  ctx.updateFooter();
}

// ── 会话持久化 — 每个会话一个文件，localStorage 备份 ──

/** 读取会话文件并解析为 JSON。处理 read_file_content 的行号。 */
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

/** 扫描会话目录，查找最大的数字会话 ID。无会话时返回 0。 */
export async function scanMaxSessionId(projectPath: string): Promise<number> {
  try {
    const raw = await rpc<string>('list_directory', { path: sessionsDir(projectPath), filter_ignored: false });
    const entries: any[] = JSON.parse(raw);
    if (!Array.isArray(entries)) return 0;
    let maxId = 0;
    for (const e of entries) {
      if (e.is_dir || !e.name || e.name === '_active.json') continue;
      const sid = parseInt(String(e.name).replace(/\.json$/, ''), 10);
      if (!Number.isNaN(sid) && sid > maxId) maxId = sid;
    }
    return maxId;
  } catch {
    return 0;
  }
}

/** 将活跃会话保存到其独立文件。更新 _active.json 跟踪器。
 *  同时写入同步 localStorage 备份，确保会话在应用崩溃/强制关闭后仍可恢复。 */
export async function saveActiveSession(ctx: SessionContext, projectPath: string): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  if (!projectPath || activeIdx < 0) return;
  const sMeta = sessions[activeIdx];
  if (!sMeta) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sMeta.id);
  if (!agent) return;

  const messages = agent.getSession();
  // 不持久化空会话（仅系统提示，无用户消息）
  if (!messages.some((m) => m.role !== 'system')) return;

  // ponytail: 消息已在会话级 store 中 — 无需 saveCurrentMessages
  getChatStore(ctx.storeId).sess.getState().setSessionTokens(sMeta.id, ctx.getTotalTokensUsed());

  const data = {
    id: sMeta.id,
    label: sMeta.label,
    savedAt: new Date().toISOString(),
    messages,
    tokensUsed: ctx.getTotalTokensUsed(),
  };

  // 1) 同步 localStorage 备份 — 可在 beforeunload 超时/进程被杀时存活
  const json = JSON.stringify(data);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(lsKey(projectPath, sMeta.id), json);
    }
  } catch {
    /* 超出配额 — 磁盘写入作为兜底 */
  }

  // 2) 异步磁盘写入（原子操作：tmp → rename）
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
    /* 非关键 */
  }
}

// ═══════════════════════════════════════════════════════════════
// 防抖自动保存 — 将密集的保存触发合并为
// 每 500ms 窗口内一次写入。显式保存（失活、设置
// 重新初始化）应直接调用 saveActiveSession。
// ═══════════════════════════════════════════════════════════════

const _autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTO_SAVE_DELAY_MS = 500;

export function scheduleAutoSave(ctx: SessionContext, projectPath: string): void {
  const existing = _autoSaveTimers.get(ctx.storeId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    _autoSaveTimers.delete(ctx.storeId);
    saveActiveSession(ctx, projectPath).catch(() => {});
  }, AUTO_SAVE_DELAY_MS);
  _autoSaveTimers.set(ctx.storeId, timer);
}

/** 增量追加最后一条用户/助手消息到后端 NDJSON。
 *  在 chat:turn-done 时调用 — 确保大部分消息在 beforeunload 触发前
 *  已写入磁盘，减少对同步 localStorage 保存的依赖。 */
export async function appendLastMessage(ctx: SessionContext, projectPath: string): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  if (!projectPath || activeIdx < 0) return;
  const sMeta = sessions[activeIdx];
  if (!sMeta) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sMeta.id);
  if (!agent) return;
  const messages = agent.getSession();
  // 查找最后一条非系统消息
  const last = [...messages].reverse().find((m) => m.role !== 'system');
  if (!last || !last.content) return;
  if (isInternalMessage(last.content)) return;
  try {
    await rpc('session_append', {
      path: projectPath,
      session_id: String(sMeta.id),
      message: { role: last.role, content: typeof last.content === 'string' ? last.content : JSON.stringify(last.content) },
    });
  } catch {
    /* best-effort — saveActiveSession 兜底 */
  }
}

/** 恢复项目打开时最后活跃的会话。
 *  优先尝试文件，回退到 localStorage（可在应用崩溃/强制关闭后恢复）。 */
export async function autoRestoreLastSession(ctx: SessionContext, projectPath: string): Promise<void> {
  if (!getAgentFactory(ctx.storeId) || !projectPath) return;

  let curNextId = getChatStore(ctx.storeId).sess.getState().nextSessionId;

  // ── 解析最后会话 ID ──
  let lastId = 0;
  // 1) 跟踪文件
  try {
    const t = await readSessionJSON(trackerFile(projectPath));
    lastId = t.lastId || 0;
    const trackerNextId = t.nextId || lastId + 1 || 1;
    curNextId = Math.max(curNextId, trackerNextId);
  } catch {
    /* 跟踪文件缺失 — 尝试下方 localStorage 扫描 */
  }

  // 2) 若跟踪文件缺失，扫描 localStorage 中本工作区最新的会话
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
        /* 跳过损坏条目 */
      }
    }
    if (lastId) curNextId = lastId + 1;
  }
  if (!lastId) {
    getChatStore(ctx.storeId).sess.setState({ nextSessionId: 1 });
    ctx.addNotice('未找到历史会话，已创建新会话', 'info');
    return;
  }

  // ── 加载会话数据（优先文件，回退 localStorage）──
  let data: any = null;
  // 1) 尝试磁盘文件
  try {
    data = await readSessionJSON(sessionFile(projectPath, lastId));
  } catch {
    /* 文件缺失 — 尝试 localStorage */
  }

  // 2) localStorage 回退（若 beforeunload 保存未完成，可能比文件更新）
  if (typeof localStorage !== 'undefined') {
    const lsRaw = localStorage.getItem(lsKey(projectPath, lastId));
    if (lsRaw) {
      try {
        const lsData = JSON.parse(lsRaw);
        // 若文件缺失或 localStorage 数据更新则使用 localStorage
        if (!data?.savedAt || (lsData.savedAt && lsData.savedAt > data.savedAt)) {
          data = lsData;
        }
      } catch {
        /* localStorage 条目损坏 */
      }
    }
  }
  if (!data?.messages || data.messages.length === 0) {
    ctx.addNotice('历史会话数据为空，已创建新会话', 'info');
    return;
  }

  // ponytail: 若跟踪的会话无用户消息（仅有系统提示），
  // 扫描 localStorage 查找有实际对话的会话（不依赖后端）
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
            // 快速检查：是否有非系统消息？
            const hasConv = (d.messages as any[])?.some?.((m: any) => m.role !== 'system');
            if (hasConv) {
              bestTs = d.savedAt;
              bestId = d.id;
            }
          }
        } catch {
          /* 跳过 */
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
          /* 保留原始空数据 */
        }
      }
    }
  }

  const newAgent = await getAgentFactory(ctx.storeId)?.();
  if (!newAgent) {
    ctx.addNotice('Agent 未就绪（API Key 未配置？），历史会话暂未恢复', 'warn');
    return;
  }

  const freshSys = newAgent.getSession().filter((m: Message) => m.role === 'system');
  const conv = (data.messages as Message[]).filter((m: Message) => m.role !== 'system');
  newAgent.setSession([...freshSys, ...conv]);

  const curSt = getChatStore(ctx.storeId).sess.getState();
  // ponytail: 消息在会话级 store 中 — 无需 saveCurrentMessages
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  const label = data.label || '已恢复的会话';
  agentSessionState.clearPanelState(ctx.storeId);
  agentSessionState.setAgent(ctx.storeId, data.id, newAgent);
  // 静态绑定该 Agent 的 board 到恢复的会话
  newAgent.bindSession?.(String(data.id));
  getChatStore(ctx.storeId).sess.setState({
    sessions: [{ id: data.id, label }],
    activeIdx: 0,
    nextSessionId: Math.max(curNextId, curSt.nextSessionId),
  });
  // ponytail: 创建会话级消息 store + 从恢复数据填充
  msgStoreFor(ctx.storeId, data.id).getState().setMessages([]);

  try {
    renderRestoredSession(ctx);
  } catch (e) {
    console.error('[chat] render 崩溃', e);
  }

  ctx.setLastUsageText('');
  ctx.updateFooter();
}

/** 扫描会话目录 — 无需 Agent。 */
export async function listSavedSessions(
  _ctx: SessionContext,
  projectPath: string,
): Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string }>> {
  const dirPath = sessionsDir(projectPath);
  let entries: any[];
  try {
    const raw = await rpc<string>('list_directory', { path: dirPath, filter_ignored: false });
    entries = JSON.parse(raw);
  } catch (e) {
    console.error('[chat] listSavedSessions: list_directory failed', e);
    return [];
  }

  if (!Array.isArray(entries)) {
    console.error('[chat] listSavedSessions: unexpected result', typeof entries);
    return [];
  }

  // 过滤有效的 JSON 会话文件（跳过目录、_active.json、非 json）
  const targets = entries.filter(
    (e) =>
      !e.is_dir &&
      e.name.endsWith('.json') &&
      e.name !== '_active.json' &&
      !Number.isNaN(parseInt(e.name.replace('.json', ''), 10)),
  );

  // ── 并行读取所有会话文件，超时 10 秒 ──
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

/** 从磁盘加载已保存的会话到新标签页。回退到 localStorage。 */
export async function loadSessionFromDisk(ctx: SessionContext, projectPath: string, sessionId: number): Promise<void> {
  if (!getAgentFactory(ctx.storeId)) {
    const extra = ctx.getLastAgentDiag() ? `\n诊断: ${ctx.getLastAgentDiag()}` : '';
    ctx.addNotice(`请先配置 API Key${extra}`, 'error');
    return;
  }

  let data: any;
  // 1) 尝试磁盘文件
  try {
    data = await readSessionJSON(sessionFile(projectPath, sessionId));
  } catch {
    /* 尝试 localStorage */
  }

  // 2) localStorage 回退
  if (!data && typeof localStorage !== 'undefined') {
    const lsRaw = localStorage.getItem(lsKey(projectPath, sessionId));
    if (lsRaw) {
      try {
        data = JSON.parse(lsRaw);
      } catch {
        /* 损坏 */
      }
    }
  }
  if (!data) {
    ctx.addNotice('会话文件读取失败', 'error');
    return;
  }

  const newAgent = await getAgentFactory(ctx.storeId)?.();
  if (!newAgent) {
    ctx.addNotice('无法创建 Agent', 'error');
    return;
  }

  const freshSys = newAgent.getSession().filter((m: Message) => m.role === 'system');
  const conv = (data.messages as Message[]).filter((m: Message) => m.role !== 'system');
  newAgent.setSession([...freshSys, ...conv]);

  const firstUser = conv.find((m: Message) => m.role === 'user' && !isInternalMessage(m.content));
  const st1 = getChatStore(ctx.storeId).sess.getState();
  const label =
    data.label && !data.label.startsWith('会话 ') && data.label !== '已恢复的会话'
      ? data.label
      : firstUser
        ? firstUser.content?.slice(0, 28) + (firstUser.content?.length > 28 ? '…' : '')
        : `会话 ${st1.sessions.length + 1}`;

  // ponytail: 消息在会话级 store 中 — 无需 saveCurrentMessages
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  const sid = data.id || sessionId;
  agentSessionState.setAgent(ctx.storeId, sid, newAgent);
  // 静态绑定该 Agent 的 board 到加载的会话
  newAgent.bindSession?.(String(sid));
  getChatStore(ctx.storeId).sess.setState({
    sessions: [...st1.sessions, { id: sid, label }],
    activeIdx: st1.sessions.length,
  });
  // ponytail: 创建会话级消息 store
  msgStoreFor(ctx.storeId, sid).getState().setMessages([]);
  if (typeof data.tokensUsed === 'number') {
    ctx.setTotalTokensUsed(data.tokensUsed);
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sid, data.tokensUsed);
  } else {
    ctx.setTotalTokensUsed(0);
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sid, 0);
  }

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

/** 将磁盘上的会话文件标记为已删除。 */
export async function deleteSessionFile(ctx: SessionContext, projectPath: string, sessionId: number): Promise<void> {
  // 用删除标记覆盖 — listSavedSessions 会过滤掉这些
  try {
    await rpc('write_file_content', {
      filePath: sessionFile(projectPath, sessionId),
      content: JSON.stringify({ id: sessionId, deleted: true, label: '', messages: [], savedAt: '' }),
    });
  } catch (e) {
    console.error('[chat] deleteSessionFile failed:', e);
    ctx.addNotice('删除会话文件失败', 'error');
    return; // 写入失败则不关闭标签页
  }
  // 清理 localStorage 备份
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(lsKey(projectPath, sessionId));
  } catch {
    /* 忽略 */
  }
  // 若该会话在标签页中打开，则关闭该标签页
  const idx = getChatStore(ctx.storeId)
    .sess.getState()
    .sessions.findIndex((s) => s.id === sessionId);
  if (idx >= 0) closeSession(ctx, idx);
}

// ── 会话恢复（内部辅助函数）──

/** 遍历活跃 agent 的会话数组，构建 ChatMessage[] + turnPairs。 */
function renderRestoredSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sid);
  if (!agent) return;
  _rebuildMessagesFromSession(ctx);
  bumpSession(ctx.storeId, sid);
  ctx.addNotice(`已恢复 ${sessions.length} 个会话`, 'info');
}

/** 从 agent 的 getSession() 原始消息填充活跃会话的会话级消息 store + turnPairs。
 *  纯数据重建 — 无 DOM 操作，无通知。 */
export function rebuildMessagesFromMessages(
  msgs: Message[],
  storeId: string,
  sessionId: number,
): void {
  const rebuilt: ChatMessage[] = [];

  // 保留按助手消息序号索引的活跃 SubAgentPart 对象。
  // 子 Agent 汇持持有这些对象的引用并持续流式写入 —
  // 仅从 provider 消息重建会丢弃卡片并使汇持孤立
  // （冻结的卡片、丢失的输出）。同样的对象会在
  // 下方重新附加到重建的消息中。
  const preservedSubAgents = new Map<number, SubAgentPart[]>();
  {
    const existing = msgStoreFor(storeId, sessionId).getState().messages;
    let aIdx = 0;
    for (const m of existing) {
      if (m.role !== 'assistant') continue;
      const subs = (m as AssistantMessage).parts.filter((p): p is SubAgentPart => p.type === 'subagent');
      if (subs.length > 0) preservedSubAgents.set(aIdx, subs);
      aIdx++;
    }
  }

  resetMsgIdCounter();
  setTurnPairs(storeId, []);

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
      if (isInternalMessage(m.content)) {
        if (m.content?.startsWith('<compacted-context>')) {
          rebuilt.push(createNoticeMessage('📋 上下文已压缩', 'info'));
        }
        continue;
      }
      if (pendingUserText && pendingUserId) {
        getTurnPairs(storeId).push({
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
        getTurnPairs(storeId).push({
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
    getTurnPairs(storeId).push({
      userText: pendingUserText,
      userBubble: null,
      assistantBubble: null,
      sessionIndex: pendingSessionIdx,
    });
  }

  // 按助手消息序号重新附加保留的子 Agent 部件。
  // 超出重建范围的序号（如仍在流式输出但尚未出现在
  // provider 消息中的轮次）回退到最后一条重建的助手消息。
  if (preservedSubAgents.size > 0) {
    const rebuiltAssistants = rebuilt.filter((m): m is AssistantMessage => m.role === 'assistant');
    for (const [ordinal, subs] of preservedSubAgents) {
      const target = rebuiltAssistants[ordinal] ?? rebuiltAssistants[rebuiltAssistants.length - 1];
      if (target) target.parts.push(...subs);
    }
  }

  // ponytail: 写入会话级 store — 唯一数据源
  msgStoreFor(storeId, sessionId).getState().setMessages(rebuilt);
  bumpSession(storeId, sessionId);
}

/** 包装器：解析活跃 agent 的会话并委托给 rebuildMessagesFromMessages。 */
export function _rebuildMessagesFromSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sid);
  if (!agent) return;

  rebuildMessagesFromMessages(agent.getSession(), ctx.storeId, sid);
}

// ── 轮次撤回 ──

/** 从 DOM 和 agent 会话中撤回一轮对话。返回 userText 或 null。 */
export function retractTurn(ctx: SessionContext, idx: number): string | null {
  const tp = getTurnPairs(ctx.storeId);
  const pair = tp[idx];
  if (!pair) return null;
  // ⚡ React 处理 DOM 移除，只需清理模型
  // 从 agent 会话中移除 — 若索引已过期（运行中插入），按内容搜索
  let sessIdx = pair.sessionIndex;
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const agent = agentSessionState.getAgent(ctx.storeId, sessions[activeIdx]?.id ?? -1);
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
  // 从 turnPairs 中移除
  tp.splice(idx, 1);
  // 从实际会话中重新索引剩余配对的 sessionIndex
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

/** 从模型中撤回单条用户消息（及其助手回复）。 */
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
    agentSessionState.getAgent(ctx.storeId, sid)?.retractTurnAt(msg.sessionIndex);
  }
}

// ── 对话导出 ──

export async function exportSession(ctx: SessionContext): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const agent = agentSessionState.getAgent(ctx.storeId, sessions[activeIdx]?.id ?? -1);
  if (!agent) {
    ctx.addNotice('没有可导出的会话', 'info');
    return;
  }

  const msgs = agent.getSession();
  const settings = loadSettings();
  const active = getActiveProvider(settings);
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  let md = `# HoloGram 会话 — ${dateStr}\n`;
  md += `> 模型: ${active?.model || 'unknown'} · 总 token: ${ctx.getTotalTokensUsed().toLocaleString()}\n\n`;

  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (isInternalMessage(m.content)) {
        if (m.content?.startsWith('<compacted-context>')) {
          md += `> *[上下文压缩]*\n\n`;
        }
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

  // 尝试 Tauri 保存对话框，回退到浏览器下载
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const filePath = await save({
      defaultPath: `hologram-session-${now.toISOString().slice(0, 10)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (filePath) {
      await rpc('write_file_content', { filePath, content: md });
      ctx.addNotice(`会话已导出: ${filePath}`, 'info');
    }
  } catch {
    // 浏览器回退
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
