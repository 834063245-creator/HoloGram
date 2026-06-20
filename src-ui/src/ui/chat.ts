// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Panel — 聊天面板 UI
// 纯 DOM 渲染，EventSink → 消息气泡 / 工具卡片 / 思考折叠
// Agent 引擎 (agent.ts) 已完整，此文件只管"把事件画到屏幕上"

import type { Agent, AgentEvent } from '../agent/agent';
import { EventKind } from '../agent/agent';
import type { StarGraph } from './graph';
import { iconHtml } from './icons';
import { bus } from './events';
import { cancelPendingApprovals } from '../agent/permission';
import { loadSettings, saveSettings, CHAT_MODES } from '../settings';
import { invoke } from '../bridge';
import type { Message } from '../provider/types';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';

// ── Constants ──

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const PANEL_ID = 'chat-panel';

// ── ChatPanel ──

interface ChatSession {
  id: number;
  label: string;
  agent: Agent;
}

let nextSessionId = 1;

export class ChatPanel {
  private container: HTMLElement;

  // DOM roots (created in buildDOM)
  private panel!: HTMLElement;
  private msgList!: HTMLElement;
  private inputArea!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private footerEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private sessionTabs!: HTMLElement;

  // Session state
  private sessions: ChatSession[] = [];
  private activeIdx = -1;
  private agentFactory: (() => Promise<Agent | null>) | null = null;

  // User focus tracking — so the Agent knows what file/node the user is looking at
  private _userFocusFile: string | null = null;
  private _userFocusNode: { name: string; location?: string } | null = null;

  // Streaming state
  private starGraph: StarGraph | null = null;
  private abortCtrl: AbortController | null = null;
  private running = false;

  // Current message DOM refs (streaming targets)
  private currentBubble: HTMLElement | null = null;
  private currentReasoning: HTMLElement | null = null;
  private currentReasoningContent: HTMLElement | null = null;
  private currentTextEl: HTMLElement | null = null;
  private pendingToolCards = new Map<string, HTMLElement>(); // id → card element

  // Per-session message cache (DOM elements)
  private sessionMessages = new Map<number, HTMLElement[]>();

  private openState = false;
  private lastUsageText = '';
  private projectPath = '';
  private onOpenSettings: (() => void) | null = null;
  private _onModeChange: (() => void) | null = null;
  private footerClickCleanup: (() => void) | null = null;
  private lastAgentDiag = '';

  private hintText(): string {
    const base = '请先配置 API Key（点击工具栏 设置 或在对话中设置）';
    return this.lastAgentDiag ? `${base}\n\n诊断: ${this.lastAgentDiag}` : base;
  }

  private refreshHint(): void {
    const hint = document.getElementById('chat-hint');
    if (hint && !this.agent) {
      hint.textContent = this.hintText();
    }
  }

  setOnOpenSettings(fn: () => void): void { this.onOpenSettings = fn; }
  setOnModeChange(fn: () => void): void { this._onModeChange = fn; }
  setAgentFactory(fn: () => Promise<Agent | null>): void { this.agentFactory = fn; }

  constructor(container: HTMLElement) {
    this.container = container;
    this.buildDOM();
    // ── Track user focus — file viewer / file tree / graph selection ──
    bus.on('highlight:file', (filePath: string) => { this._userFocusFile = filePath; this._userFocusNode = null; });
    bus.on('navigate:file', (filePath: string) => { this._userFocusFile = filePath; this._userFocusNode = null; });
    bus.on('graph:node-clicked', (data: { nodeName: string; nodeType: string; nodeId: string; degree: number; location: string }) => {
      this._userFocusNode = { name: data.nodeName, location: data.location || undefined };
      this._userFocusFile = null;
    });
    // ── Listen for Agent diagnostics so we can show WHY agent isn't ready ──
    bus.on('agent:diag', (d: { text: string; ready: boolean }) => {
      this.lastAgentDiag = d.text;
      if (!d.ready && this.openState) {
        this.refreshHint();
      }
    });
  }

  // ── Public API ──

  private get agent(): Agent | null {
    return this.sessions[this.activeIdx]?.agent ?? null;
  }

  setAgent(agent: Agent | null): void {
    if (!agent) return;
    // Add as a new session
    const s: ChatSession = {
      id: nextSessionId++,
      label: `会话 ${this.sessions.length + 1}`,
      agent,
    };
    this.sessions.push(s);
    if (this.activeIdx < 0) this.activeIdx = 0;
    this.renderSessionTabs();
  }

  getAgent(): Agent | null { return this.agent; }
  setStarGraph(g: StarGraph): void { this.starGraph = g; }
  setProjectPath(p: string): void { this.projectPath = p; }

  toggle(): void { this.openState ? this.close() : this.open(); }

  open(): void {
    this.openState = true;
    this.panel.classList.add('chat-open');
    this.updateFooter();
    setTimeout(() => this.inputArea.focus(), 200);
    bus.emit('panel:toggle');
  }

  /** Programmatically ask the agent a question. Opens the panel and sends. */
  ask(question: string): void {
    if (!this.openState) this.open();
    this.inputArea.value = question;
    this.inputArea.style.height = 'auto';
    this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
    // Small delay to let panel animate open before sending
    setTimeout(() => this.sendMessage(), 150);
  }

  close(): void {
    this.openState = false;
    this.panel.classList.remove('chat-open');
    if (this.running) this.abort();
    // Save before closing — prevents data loss if app crashes while panel is closed
    if (this.projectPath && this.activeIdx >= 0) {
      this.saveActiveSession(this.projectPath).catch(() => {});
    }
    // Dismiss any pending permission modal
    cancelPendingApprovals();
    bus.emit('panel:toggle');
  }

  isOpen(): boolean { return this.openState; }

  // ── Session management ──

  private renderSessionTabs(): void {
    this.sessionTabs.innerHTML = '';
    for (let i = 0; i < this.sessions.length; i++) {
      const s = this.sessions[i];
      const tab = document.createElement('button');
      tab.className = 'chat-session-tab';
      if (i === this.activeIdx) tab.classList.add('active');
      // Short label
      const shortLabel = s.label.length > 8 ? s.label.slice(0, 7) + '…' : s.label;
      tab.textContent = shortLabel;
      tab.title = `${s.label} (点击切换)`;
      tab.addEventListener('click', () => this.switchSession(i));

      if (this.sessions.length > 1) {
        // Close button on each tab
        const xBtn = document.createElement('span');
        xBtn.className = 'chat-session-x';
        xBtn.innerHTML = '×';
        xBtn.title = '关闭会话';
        xBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closeSession(i);
        });
        tab.appendChild(xBtn);
      }
      this.sessionTabs.appendChild(tab);
    }
  }

  private switchSession(idx: number): void {
    if (idx === this.activeIdx || idx < 0 || idx >= this.sessions.length) return;
    // Save current messages to cache
    if (this.activeIdx >= 0) {
      this.saveCurrentMessages();
    }
    // Flush any in-progress streaming
    this.flushReasoning();
    this.flushText();
    this.pendingToolCards.clear();
    // Switch
    this.activeIdx = idx;
    this.renderSessionTabs();
    this.restoreMessages();
    this.lastUsageText = '';
    this.updateFooter();
  }

  private closeSession(idx: number): void {
    if (this.sessions.length <= 1) {
      this.addNotice('至少保留一个会话', 'info');
      return;
    }
    // Abort if closing active running session
    if (idx === this.activeIdx && this.running) this.abort();
    // Remove session — persist before mutating memory
    const s = this.sessions[idx];
    this.sessionMessages.delete(s.id);
    // Persist deletion
    if (this.projectPath) {
      this.saveActiveSession(this.projectPath).then(() => {
        this.sessions.splice(idx, 1);
        if (this.activeIdx >= this.sessions.length) this.activeIdx = this.sessions.length - 1;
        if (this.activeIdx < 0) this.activeIdx = 0;
        this.renderSessionTabs();
        this.restoreMessages();
        this.updateFooter();
      }).catch((e: unknown) => {
        console.error('[chat] closeSession save failed:', e);
        this.sessionMessages.set(s.id, []); // restore
        this.addNotice('关闭会话失败', 'error');
      });
    } else {
      this.sessions.splice(idx, 1);
      if (this.activeIdx >= this.sessions.length) this.activeIdx = this.sessions.length - 1;
      if (this.activeIdx < 0) this.activeIdx = 0;
      this.renderSessionTabs();
      this.restoreMessages();
      this.updateFooter();
    }
  }

  private async createNewSession(): Promise<void> {
    if (!this.agentFactory) {
      const extra = this.lastAgentDiag ? `\n诊断: ${this.lastAgentDiag}` : '';
      this.addNotice(`请先配置 API Key（设置 → Provider）${extra}`, 'info');
      return;
    }
    const newAgent = await this.agentFactory();
    if (!newAgent) {
      this.addNotice('无法创建会话: Agent 工厂返回空', 'error');
      return;
    }
    // Save current messages
    if (this.activeIdx >= 0) this.saveCurrentMessages();
    this.flushReasoning();
    this.flushText();
    this.pendingToolCards.clear();
    // Add new session
    const s: ChatSession = {
      id: nextSessionId++,
      label: `会话 ${this.sessions.length + 1}`,
      agent: newAgent,
    };
    this.sessions.push(s);
    this.activeIdx = this.sessions.length - 1;
    this.renderSessionTabs();
    // Clear displayed messages for the new session
    this.msgList.innerHTML = '';
    this.addNotice('新会话已创建 — 可以开始对话', 'info');
    this.lastUsageText = '';
    this.updateFooter();
  }

  private saveCurrentMessages(): void {
    const sid = this.sessions[this.activeIdx]?.id;
    if (!sid) return;
    const children = Array.from(this.msgList.children) as HTMLElement[];
    this.sessionMessages.set(sid, children);
  }

  private restoreMessages(): void {
    this.msgList.innerHTML = '';
    const sid = this.sessions[this.activeIdx]?.id;
    if (!sid) return;
    const cached = this.sessionMessages.get(sid);
    if (cached) {
      for (const el of cached) {
        this.msgList.appendChild(el.cloneNode(true));
      }
    }
    // Re-wire all interactive handlers lost by cloneNode
    this._reWireHandlers();
    this.scrollBottom();
  }

  private _reWireHandlers(): void {
    // Node links
    this.msgList.querySelectorAll('.node-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = (link as HTMLElement).dataset['nodename'] || '';
        if (name && this.starGraph) {
          let found = this.starGraph.focusNode(name);
          if (!found) {
            const alt = name.split('.').pop() || '';
            if (alt && alt !== name) found = this.starGraph.focusNode(alt);
          }
          if (!found) this.addNotice(`未在图中找到 "${name}"`, 'info');
        }
      });
    });
    // Tool card expand/collapse
    this.msgList.querySelectorAll('.msg-tool-header').forEach((header) => {
      header.addEventListener('click', () => {
        header.parentElement?.classList.toggle('tool-expanded');
      });
    });
    // Reasoning toggle
    this.msgList.querySelectorAll('.msg-reasoning-toggle').forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const reasoning = toggle.parentElement;
        if (reasoning) reasoning.classList.toggle('reasoning-expanded');
      });
    });
    // Copy buttons
    this.msgList.querySelectorAll('.msg-action-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bubble = btn.closest('.msg-bubble');
        const txt = bubble?.querySelector('.msg-text')?.textContent || '';
        navigator.clipboard.writeText(txt).then(() => {
          btn.innerHTML = iconHtml('check-circle', 12);
          setTimeout(() => { btn.innerHTML = iconHtml('copy', 12); }, 1500);
        }).catch(() => {});
      });
    });
  }

  // ── Session persistence — one file per session, localStorage backup ──

  private lsKey(id: number): string { return `hologram_session_${id}`; }

  private sessionsDir(projectPath: string): string {
    return `${projectPath.replace(/\\/g, '/')}/.hologram/sessions`;
  }

  private sessionFile(projectPath: string, id: number): string {
    return `${this.sessionsDir(projectPath)}/${id}.json`;
  }

  private trackerFile(projectPath: string): string {
    return `${this.sessionsDir(projectPath)}/_active.json`;
  }

  /** Save the active session to its own file. Updates _active.json tracker.
   *  Also writes a sync localStorage backup so the session survives app crash / force-close. */
  async saveActiveSession(projectPath: string): Promise<void> {
    if (!projectPath || this.activeIdx < 0) return;
    const s = this.sessions[this.activeIdx];
    if (!s) return;

    this.saveCurrentMessages();

    const data = {
      id: s.id,
      label: s.label,
      savedAt: new Date().toISOString(),
      messages: s.agent.getSession(),
    };

    // 1) Sync localStorage backup — survives beforeunload timeout / process kill
    const json = JSON.stringify(data);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.lsKey(s.id), json);
      }
    } catch { /* quota exceeded — disk write is the fallback */ }

    // 2) Async disk write (atomic: tmp → rename)
    try {
      await invoke('write_file_content', {
        filePath: this.sessionFile(projectPath, s.id),
        content: json,
      });
    } catch (e) {
      console.error('[chat] saveActiveSession 失败:', e);
    }

    try {
      await invoke('write_file_content', {
        filePath: this.trackerFile(projectPath),
        content: JSON.stringify({ lastId: s.id, nextId: nextSessionId }),
      });
    } catch { /* non-critical */ }
  }

  /** Restore the last active session on project open.
   *  Tries file first, falls back to localStorage (survives app crash / force-close). */
  async autoRestoreLastSession(projectPath: string): Promise<void> {
    if (!this.agentFactory || !projectPath) return;

    // ── Resolve last session id ──
    let lastId = 0;
    // 1) Tracker file
    try {
      const raw = await invoke<string>('read_file_content', { filePath: this.trackerFile(projectPath) });
      const t = JSON.parse(raw);
      lastId = t.lastId || 0;
      nextSessionId = Math.max(nextSessionId, t.nextId || 0);
    } catch { /* tracker missing — try localStorage scan below */ }

    // 2) If tracker missing, scan localStorage for newest session
    if (!lastId && typeof localStorage !== 'undefined') {
      let newestTs = '';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith('hologram_session_')) continue;
        try {
          const d = JSON.parse(localStorage.getItem(key)!);
          if (d.id && !d.deleted && d.savedAt > newestTs) {
            newestTs = d.savedAt;
            lastId = d.id;
          }
        } catch { /* skip corrupt entry */ }
      }
      if (lastId) nextSessionId = Math.max(nextSessionId, lastId + 1);
    }
    if (!lastId) return;

    // ── Load session data (file first, localStorage fallback) ──
    let data: any = null;
    // 1) Try disk file
    try {
      const fileRaw = await invoke<string>('read_file_content', { filePath: this.sessionFile(projectPath, lastId) });
      data = JSON.parse(fileRaw);
    } catch { /* file missing — try localStorage */ }

    // 2) localStorage fallback (may be newer if beforeunload save didn't complete)
    if (typeof localStorage !== 'undefined') {
      const lsRaw = localStorage.getItem(this.lsKey(lastId));
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
    if (!data || !data.messages || data.messages.length === 0) return;

    const agent = await this.agentFactory();
    if (!agent) return;

    const freshSys = agent.getSession().filter((m: Message) => m.role === 'system');
    const conv = (data.messages as Message[]).filter((m: Message) => m.role !== 'system');
    agent.setSession([...freshSys, ...conv]);

    if (this.activeIdx >= 0) this.saveCurrentMessages();
    this.flushReasoning();
    this.flushText();
    this.pendingToolCards.clear();

    const label = data.label && !data.label.startsWith('会话 ') ? data.label : '已恢复的会话';
    // Replace ALL sessions — switch workspace = fresh start
    this.sessionMessages.clear();
    this.sessions = [{ id: data.id, label, agent }];
    this.activeIdx = 0;
    this.renderSessionTabs();
    this.msgList.innerHTML = '';

    try { this.renderRestoredSession(); } catch (e) {
      console.error('[chat] render 崩溃', e);
    }

    this.lastUsageText = '';
    this.updateFooter();
  }

  /** Scan sessions directory — no agent required. */
  async listSavedSessions(projectPath: string): Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string }>> {
    let entries: any[];
    try {
      entries = await invoke<any[]>('list_directory', { path: this.sessionsDir(projectPath) });
    } catch {
      return [];
    }

    const result: Array<{ id: number; label: string; msgCount: number; savedAt: string }> = [];
    for (const e of entries) {
      if (e.is_dir || !e.name.endsWith('.json') || e.name === '_active.json') continue;
      const sid = parseInt(e.name.replace('.json', ''), 10);
      if (isNaN(sid)) continue;

      try {
        const d = JSON.parse(await invoke<string>('read_file_content', { filePath: e.path }));
        if (d.deleted) continue;
        result.push({
          id: d.id || sid,
          label: d.label || `会话 ${sid}`,
          msgCount: (d.messages as any[])?.filter((m: any) => m.role !== 'system').length || 0,
          savedAt: d.savedAt || '',
        });
      } catch { /* skip unreadable */ }
    }
    result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return result;
  }

  /** Load a saved session from disk into a new tab. Falls back to localStorage. */
  async loadSessionFromDisk(projectPath: string, sessionId: number): Promise<void> {
    if (!this.agentFactory) {
      const extra = this.lastAgentDiag ? `\n诊断: ${this.lastAgentDiag}` : '';
      this.addNotice(`请先配置 API Key${extra}`, 'error');
      return;
    }

    let data: any;
    // 1) Try disk file
    try {
      data = JSON.parse(await invoke<string>('read_file_content', { filePath: this.sessionFile(projectPath, sessionId) }));
    } catch { /* try localStorage */ }

    // 2) localStorage fallback
    if (!data && typeof localStorage !== 'undefined') {
      const lsRaw = localStorage.getItem(this.lsKey(sessionId));
      if (lsRaw) {
        try { data = JSON.parse(lsRaw); } catch { /* corrupt */ }
      }
    }
    if (!data) {
      this.addNotice('会话文件读取失败', 'error');
      return;
    }

    const agent = await this.agentFactory();
    if (!agent) { this.addNotice('无法创建 Agent', 'error'); return; }

    const freshSys = agent.getSession().filter((m: Message) => m.role === 'system');
    const conv = (data.messages as Message[]).filter((m: Message) => m.role !== 'system');
    agent.setSession([...freshSys, ...conv]);

    const firstUser = conv.find((m: Message) => m.role === 'user' && !m.content?.startsWith('<compacted-context>'));
    const label = (data.label && !data.label.startsWith('会话 '))
      ? data.label
      : firstUser ? firstUser.content!.slice(0, 28) + (firstUser.content!.length > 28 ? '…' : '') : `会话 ${this.sessions.length + 1}`;

    if (this.activeIdx >= 0) this.saveCurrentMessages();
    this.flushReasoning(); this.flushText(); this.pendingToolCards.clear();

    this.sessions.push({ id: data.id || sessionId, label, agent });
    this.activeIdx = this.sessions.length - 1;
    this.renderSessionTabs();
    this.renderRestoredSession();
    this.lastUsageText = '';
    this.updateFooter();
    this.addNotice(`已加载: ${label}`, 'info');
  }

  /** Mark a session file as deleted on disk. */
  async deleteSessionFile(projectPath: string, sessionId: number): Promise<void> {
    // Overwrite with deleted marker — listSavedSessions filters these out
    try {
      await invoke('write_file_content', {
        filePath: this.sessionFile(projectPath, sessionId),
        content: JSON.stringify({ id: sessionId, deleted: true, label: '', messages: [], savedAt: '' }),
      });
    } catch (e) {
      console.error('[chat] deleteSessionFile failed:', e);
      this.addNotice('删除会话文件失败', 'error');
      return; // Don't close tab if write failed
    }
    // Clean localStorage backup
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(this.lsKey(sessionId));
    } catch { /* ignore */ }
    // If this session is open in a tab, close that tab
    const idx = this.sessions.findIndex(s => s.id === sessionId);
    if (idx >= 0) this.closeSession(idx);
  }

  /** Walk through active agent's session array and build DOM bubbles. */
  private renderRestoredSession(): void {
    const agent = this.agent;
    if (!agent) return;

    const msgs = agent.getSession();
    // Index tool results by call_id
    const toolResults = new Map<string, string>();
    for (const m of msgs) {
      if (m.role === 'tool' && m.tool_call_id) {
        toolResults.set(m.tool_call_id, m.content || '');
      }
    }

    for (const m of msgs) {
      if (m.role === 'system') continue;

      if (m.role === 'user') {
        if (m.content?.startsWith('<compacted-context>')) {
          const el = document.createElement('div');
          el.className = 'msg-notice msg-notice-info';
          el.textContent = '📋 上下文已压缩';
          this.msgList.appendChild(el);
          continue;
        }
        this.appendUserBubble(m.content || '');
        continue;
      }

      if (m.role === 'tool') continue; // handled inline with tool cards

      if (m.role === 'assistant') {
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble assistant';

        // Reasoning (collapsed by default)
        if (m.reasoning_content) {
          const reasoning = document.createElement('div');
          reasoning.className = 'msg-reasoning';
          const toggle = document.createElement('button');
          toggle.className = 'msg-reasoning-toggle';
          toggle.innerHTML = `${iconHtml('chevron-right')} 思考过程`;
          const content = document.createElement('div');
          content.className = 'msg-reasoning-content';
          content.textContent = m.reasoning_content;
          toggle.addEventListener('click', () => {
            const show = content.classList.toggle('msg-reasoning-open');
            toggle.innerHTML = show
              ? `${iconHtml('chevron-down')} 收起思考`
              : `${iconHtml('chevron-right')} 思考过程`;
          });
          reasoning.append(toggle, content);
          bubble.appendChild(reasoning);
        }

        // Text content — markdown rendered
        if (m.content) {
          const textEl = document.createElement('div');
          textEl.className = 'msg-text msg-markdown';
          try {
            const html = DOMPurify.sanitize(marked.parse(m.content) as string);
            textEl.innerHTML = html;
            textEl.querySelectorAll('pre code').forEach((block) => {
              hljs.highlightElement(block as HTMLElement);
            });
          } catch {
            textEl.textContent = m.content;
          }
          bubble.appendChild(textEl);
        }

        // Tool calls — render as completed cards with results
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            const card = document.createElement('div');
            card.className = 'msg-tool-card';
            const header = document.createElement('div');
            header.className = 'msg-tool-header';

            const nameEl = document.createElement('span');
            nameEl.className = 'tool-name';
            nameEl.innerHTML = `${iconHtml('check-circle', 12)} ${tc.name}`;

            const argsEl = document.createElement('span');
            argsEl.className = 'tool-args';
            if (tc.arguments) {
              argsEl.textContent = truncateArgs(tc.arguments);
              argsEl.title = tc.arguments;
            }

            const status = document.createElement('span');
            status.className = 'tool-status tool-ok';
            status.innerHTML = iconHtml('check-circle', 12);

            header.append(nameEl, argsEl, status);
            header.addEventListener('click', () => card.classList.toggle('tool-expanded'));

            const resultEl = document.createElement('div');
            resultEl.className = 'msg-tool-result';
            resultEl.textContent = toolResults.get(tc.id) || '(无输出)';

            card.append(header, resultEl);
            bubble.appendChild(card);
          }
        }

        // Message actions (copy button)
        const actions = document.createElement('div');
        actions.className = 'msg-actions';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'msg-action-btn';
        copyBtn.innerHTML = iconHtml('copy', 12);
        copyBtn.title = '复制回复';
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const txt = bubble.querySelector('.msg-text')?.textContent || '';
          navigator.clipboard.writeText(txt).then(() => {
            copyBtn.innerHTML = iconHtml('check-circle', 12);
            setTimeout(() => { copyBtn.innerHTML = iconHtml('copy', 12); }, 1500);
          }).catch(() => {});
        });
        actions.append(copyBtn);
        bubble.appendChild(actions);

        this.msgList.appendChild(bubble);
      }
    }

    // Re-wire node-link click handlers
    this.msgList.querySelectorAll('.node-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = (link as HTMLElement).dataset['nodename'] || '';
        if (name && this.starGraph) {
          const found = this.starGraph.focusNode(name);
          if (!found) this.addNotice(`未在图中找到 "${name}"`, 'info');
        }
      });
    });

    this.scrollBottom();
    this.addNotice(`已恢复 ${this.sessions.length} 个会话`, 'info');
  }

  // ── History panel — browse saved conversation files ──

  private historyPanel: HTMLElement | null = null;
  private historyOpen = false;

  private toggleHistory(): void {
    if (this.historyOpen) { this.closeHistory(); return; }
    this.openHistory();
  }

  private openHistory(): void {
    if (this.historyPanel) this.historyPanel.remove();

    this.historyPanel = document.createElement('div');
    this.historyPanel.className = 'chat-history-panel';

    const title = document.createElement('div');
    title.className = 'chat-history-title';
    title.textContent = '历史会话';
    this.historyPanel.appendChild(title);

    const list = document.createElement('div');
    list.className = 'chat-history-list';

    // In-memory sessions
    if (this.sessions.length > 0) {
      const hdr = document.createElement('div');
      hdr.className = 'chat-history-section';
      hdr.textContent = `当前打开 (${this.sessions.length})`;
      list.appendChild(hdr);

      for (let i = 0; i < this.sessions.length; i++) {
        const s = this.sessions[i];
        const entry = this.buildHistoryEntry(
          s.label,
          `消息: ${s.agent.getSession().filter(m => m.role !== 'system').length}`,
          () => { if (i !== this.activeIdx) this.switchSession(i); this.closeHistory(); },
          i === this.activeIdx,
        );
        list.appendChild(entry);
      }
    }

    // Disk sessions — scanned from .hologram/sessions/
    if (this.projectPath) {
      const hdr = document.createElement('div');
      hdr.className = 'chat-history-section';
      hdr.textContent = '磁盘存档';
      list.appendChild(hdr);

      const loading = document.createElement('div');
      loading.className = 'chat-history-entry';
      loading.textContent = '加载中…';
      list.appendChild(loading);

      this.listSavedSessions(this.projectPath).then(sessions => {
        if (!this.historyOpen) return; // panel closed while loading
        loading.remove();
        if (sessions.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'chat-history-entry';
          empty.textContent = '暂无存档';
          list.appendChild(empty);
          return;
        }
        for (const s of sessions) {
          const already = this.sessions.findIndex(t => t.id === s.id);
          const entry = this.buildHistoryEntry(
            s.label,
            `${s.msgCount} 条消息${s.savedAt ? ' · ' + new Date(s.savedAt).toLocaleString('zh-CN') : ''}`,
            () => {
              this.closeHistory();
              if (already >= 0) { this.switchSession(already); }
              else { this.loadSessionFromDisk(this.projectPath!, s.id); }
            },
            already >= 0 && already === this.activeIdx,
            () => {
              if (confirm(`删除会话 "${s.label}"？`)) {
                this.deleteSessionFile(this.projectPath!, s.id);
                entry.remove();
              }
            },
          );
          if (this.historyOpen) list.appendChild(entry);
        }
      }).catch(() => { if (this.historyOpen) loading.textContent = '加载失败'; });
    }

    this.historyPanel.appendChild(list);

    const overlay = document.createElement('div');
    overlay.className = 'chat-history-overlay';
    overlay.addEventListener('click', () => this.closeHistory());
    this.historyPanel.appendChild(overlay);

    this.panel.appendChild(this.historyPanel);
    this.historyOpen = true;
  }

  private closeHistory(): void {
    if (this.historyPanel) { this.historyPanel.remove(); this.historyPanel = null; }
    this.historyOpen = false;
  }

  private buildHistoryEntry(
    title: string,
    subtitle: string,
    onClick: () => void,
    active: boolean,
    onDelete?: () => void,
  ): HTMLElement {
    const entry = document.createElement('div');
    entry.className = 'chat-history-entry' + (active ? ' active' : '');
    const titleEl = document.createElement('div');
    titleEl.className = 'chat-history-entry-title';
    titleEl.textContent = title;
    const subEl = document.createElement('div');
    subEl.className = 'chat-history-entry-sub';
    subEl.textContent = subtitle;
    entry.append(titleEl, subEl);
    entry.addEventListener('click', onClick);

    if (onDelete) {
      const delBtn = document.createElement('button');
      delBtn.className = 'chat-history-del';
      delBtn.innerHTML = '×';
      delBtn.title = '删除此会话';
      Object.assign(delBtn.style, {
        position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
        width: '20px', height: '20px', padding: '0', fontSize: '14px',
        background: 'none', border: 'none', color: 'var(--text-muted, #4a5568)',
        cursor: 'pointer', borderRadius: '3px', lineHeight: '1',
      });
      delBtn.addEventListener('mouseenter', () => { delBtn.style.color = '#e53e3e'; delBtn.style.background = 'rgba(229,62,62,0.1)'; });
      delBtn.addEventListener('mouseleave', () => { delBtn.style.color = 'var(--text-muted)'; delBtn.style.background = 'none'; });
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
      entry.appendChild(delBtn);
      entry.style.position = 'relative';
    }

    return entry;
  }

  // ── Build DOM ──

  private buildDOM(): void {
    // Panel root
    this.panel = document.createElement('div');
    this.panel.id = PANEL_ID;

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // Resize handle
    const resize = document.createElement('div');
    resize.className = 'chat-resize';
    this.panel.appendChild(resize);
    this.setupResize(resize);

    // Header
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'chat-header';
    const title = document.createElement('span');
    title.className = 'chat-title';
    title.innerHTML = `${iconHtml('chat')} 全息对话`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'chat-close-btn';
    closeBtn.innerHTML = iconHtml('close', 16);
    closeBtn.addEventListener('click', () => this.close());
    this.headerEl.append(title);

    // Session tabs
    this.sessionTabs = document.createElement('div');
    this.sessionTabs.className = 'chat-session-tabs';
    this.headerEl.appendChild(this.sessionTabs);

    // + new session button
    const addBtn = document.createElement('button');
    addBtn.className = 'chat-session-add';
    addBtn.innerHTML = iconHtml('plus', 12);
    addBtn.title = '新建会话';
    addBtn.addEventListener('click', () => this.createNewSession());
    this.headerEl.appendChild(addBtn);

    // History button — browse saved conversations
    const historyBtn = document.createElement('button');
    historyBtn.className = 'chat-session-add';
    historyBtn.innerHTML = iconHtml('bookmark', 12);
    historyBtn.title = '历史记录';
    historyBtn.addEventListener('click', () => this.toggleHistory());
    this.headerEl.appendChild(historyBtn);

    this.headerEl.appendChild(closeBtn);
    this.panel.appendChild(this.headerEl);

    // Messages
    this.msgList = document.createElement('div');
    this.msgList.className = 'chat-messages';
    this.panel.appendChild(this.msgList);

    // Welcome hint
    const hint = document.createElement('div');
    hint.className = 'chat-hint';
    hint.id = 'chat-hint';
    hint.textContent = this.agent
      ? '向我提问代码库的问题，或直接聊天'
      : this.hintText();
    this.msgList.appendChild(hint);

    // Input area
    const inputWrap = document.createElement('div');
    inputWrap.className = 'chat-input-area';

    this.inputArea = document.createElement('textarea');
    this.inputArea.className = 'chat-input';
    this.inputArea.placeholder = '输入消息… (Enter 发送, Shift+Enter 换行)';
    this.inputArea.rows = 2;
    this.inputArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
      if (e.key === 'Escape') {
        this.close();
      }
    });
    // Auto-resize textarea
    this.inputArea.addEventListener('input', () => {
      this.inputArea.style.height = 'auto';
      this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
    });

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'chat-send-btn';
    this.sendBtn.innerHTML = iconHtml('send');
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'chat-stop-btn hidden';
    this.stopBtn.innerHTML = iconHtml('stop');
    this.stopBtn.addEventListener('click', () => this.abort());

    inputWrap.append(this.inputArea, this.sendBtn, this.stopBtn);
    this.panel.appendChild(inputWrap);

    // Input footer — model badge, slash commands, usage
    this.footerEl = document.createElement('div');
    this.footerEl.className = 'chat-footer';
    this.panel.appendChild(this.footerEl);

    this.container.appendChild(this.panel);
  }

  // ── Resize ──

  private setupResize(handle: HTMLElement): void {
    let dragging = false;
    let startX = 0;
    let startW = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = this.panel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + (startX - e.clientX)));
      this.panel.style.width = w + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Send ──

  private newSession(): void {
    if (!this.agent) return;
    // 先中止当前运行 — abort() 已包含安全超时，不强制 running=false
    // （强制设 false 会导致旧 run 还在执行时新消息就能发送，污染会话）
    if (this.running) {
      this.abort();
    }
    // Save current messages before clearing
    if (this.activeIdx >= 0) this.saveCurrentMessages();
    this.agent.newSession(); // 递增 sessionGen，旧 run 检测到 gen 变化自动丢弃
    // Clear message list UI
    this.msgList.innerHTML = '';
    this.addNotice('已开启新会话 — 上下文已清空', 'info');
    this.finishTurn();
    this.updateFooter();
  }

  /** Send a hidden instruction to the agent (no user bubble shown). For slash commands. */
  private sendAgentText(text: string): void {
    if (!this.agent || this.running) return;
    this.setRunning(true);

    const hint = this.msgList.querySelector('.chat-hint');
    if (hint) hint.remove();

    this.addTurnSep();
    this.scrollBottom();

    this.abortCtrl = new AbortController();
    this.agent.run(this.abortCtrl.signal, text).then(() => {
      // Success
    }).catch((err: any) => {
      if (err.message?.includes('aborted') || err.message?.includes('AbortError')) {
        this.addNotice('已中止', 'info');
      } else if (err.message?.includes('paused after')) {
        this.addNotice(err.message, 'warn');
      } else {
        this.addNotice(`错误: ${err.message || err}`, 'error');
      }
    }).finally(() => {
      this.setRunning(false);
      this.abortCtrl = null;
      this.finishTurn();
      bus.emit('chat:turn-done', {});
    });
  }

  private async sendMessage(): Promise<void> {
    const text = this.inputArea.value.trim();
    if (!text || this.running) return;

    if (!this.agent) {
      const detail = this.lastAgentDiag
        ? `${this.lastAgentDiag} (factory:${this.agentFactory ? 'yes' : 'NO'})`
        : '请先配置 API Key 或等待项目加载';
      this.addNotice(`Agent 未就绪 — ${detail}`, 'error');
      return;
    }

    // Redirect slash commands to sendAgentText
    if (text === '/memory') {
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      this.sendAgentText('列出所有已保存的记忆（使用 hologram_memory_list）');
      return;
    }
    if (text.startsWith('/remember ')) {
      const fact = text.slice('/remember '.length).trim();
      if (!fact) {
        this.addNotice('用法: /remember 要记住的内容', 'info');
        this.inputArea.value = '';
        this.inputArea.style.height = 'auto';
        return;
      }
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      this.sendAgentText(
        `请将以下事实保存到记忆库：${fact}\n\n使用 hologram_memory_save 工具。选择合适的 type（user/feedback/project/reference），起一个简短的 kebab-case 名称，写清楚 description。`,
      );
      return;
    }

    // Detect /new command
    if (text === '/new') {
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      this.newSession();
      return;
    }

    // Detect /compact command
    if (text === '/compact') {
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      if (!this.agent) return;
      this.addNotice('正在压缩上下文…', 'info');
      const ctrl = new AbortController();
      this.agent.compactNow(ctrl.signal).then(() => {
        this.msgList.innerHTML = '';
        // Rebuild message list from agent session
        const msgs = this.agent!.getSession();
        for (const m of msgs) {
          if (m.role === 'system') continue;
          if (m.role === 'user' && m.content?.startsWith('<compacted-context>')) {
            const el = document.createElement('div');
            el.className = 'msg-notice msg-notice-info';
            el.textContent = '📋 上下文已压缩';
            this.msgList.appendChild(el);
            continue;
          }
          if (m.role === 'user') {
            this.appendUserBubble(m.content || '');
          }
          if (m.role === 'assistant') {
            const bubble = document.createElement('div');
            bubble.className = 'msg-bubble assistant';
            const textEl = document.createElement('div');
            textEl.className = 'msg-text msg-markdown';
            textEl.textContent = m.content || '';
            bubble.appendChild(textEl);
            this.msgList.appendChild(bubble);
          }
        }
        this.scrollBottom();
      }).catch((err) => {
        this.addNotice(`压缩失败: ${err.message}`, 'error');
      });
      return;
    }

    // Auto-label session on first user message
    if (this.activeIdx >= 0) {
      const session = this.sessions[this.activeIdx];
      if (session && session.label.startsWith('会话 ')) {
        session.label = text.length > 28 ? text.slice(0, 27) + '…' : text;
        this.renderSessionTabs();
      }
    }

    this.inputArea.value = '';
    this.inputArea.style.height = 'auto';
    this.setRunning(true);

    // Remove hint if present
    const hint = this.msgList.querySelector('.chat-hint');
    if (hint) hint.remove();

    // User bubble (original text, focus context is for Agent eyes only)
    this.appendUserBubble(text);
    this.scrollBottom();

    // Build focus context prefix — tells Agent what the user is looking at
    let focusPrefix = '';
    if (this._userFocusNode) {
      focusPrefix = `[用户当前选中了图中的节点 "${this._userFocusNode.name}"`;
      if (this._userFocusNode.location) {
        focusPrefix += ` (位于 ${this._userFocusNode.location})`;
      }
      focusPrefix += ']\n\n';
    } else if (this._userFocusFile) {
      focusPrefix = `[用户当前正在查看文件 "${this._userFocusFile}"]\n\n`;
    }

    // Start turn separator
    this.addTurnSep();

    // Run agent
    this.abortCtrl = new AbortController();
    try {
      await this.agent.run(this.abortCtrl.signal, focusPrefix + text);
    } catch (err: any) {
      if (err.message?.includes('aborted') || err.message?.includes('AbortError')) {
        this.addNotice('已中止', 'info');
      } else if (err.message?.includes('paused after')) {
        this.addNotice(err.message, 'warn');
      } else {
        this.addNotice(`错误: ${err.message || err}`, 'error');
      }
    } finally {
      this.setRunning(false);
      this.abortCtrl = null;
      this.finishTurn();
    }
    // Signal main.ts to persist sessions
    bus.emit('chat:turn-done', {});
  }

  private abort(): void {
    if (this.abortCtrl) {
      this.abortCtrl.abort();
      // 解散所有待审批弹窗（防止权限门死锁）
      cancelPendingApprovals();
      // 立即视觉反馈 — 不等 .finally()，防止卡死时 UI 无响应
      this.inputArea.disabled = false;
      this.inputArea.placeholder = '输入消息… (Enter 发送, Shift+Enter 换行)';
      this.stopBtn.classList.add('hidden');
      this.sendBtn.classList.remove('hidden');
      this.addNotice('正在中止…', 'info');
      // 安全超时：3 秒内若 Agent 没响应，强制复位
      const safety = setTimeout(() => {
        if (this.running) {
          this.running = false;
          this.abortCtrl = null;
          this.finishTurn();
          this.addNotice('已强制中止（超时）', 'warn');
        }
      }, 3000);
      // 如果 Agent 正常响应了，取消安全超时
      const poll = setInterval(() => {
        if (!this.running) {
          clearTimeout(safety);
          clearInterval(poll);
        }
      }, 200);
      this.abortCtrl = null;
    }
  }

  private setRunning(r: boolean): void {
    this.running = r;
    this.inputArea.disabled = r;
    this.sendBtn.classList.toggle('hidden', r);
    this.stopBtn.classList.toggle('hidden', !r);
    if (r) {
      this.inputArea.placeholder = 'Agent 思考中…';
    } else {
      this.inputArea.placeholder = '输入消息… (Enter 发送, Shift+Enter 换行)';
      this.inputArea.focus();
    }
  }

  // ── Event Sink — render Agent events to DOM ──

  private renderEvent(ev: AgentEvent): void {
    switch (ev.kind) {
      case EventKind.Reasoning:
        if (ev.text) this.appendReasoning(ev.text);
        break;

      case EventKind.Text:
        if (ev.text) this.appendText(ev.text, false);
        break;

      case EventKind.Message:
        if (ev.text) {
          // Markdown 渲染：流式阶段用 textContent 积累的纯文本，完成后一次性渲染
          this.renderMarkdownText(ev.text);
        }
        this.flushReasoning();
        this.flushText();
        this.linkifyNodeNames();
        break;

      case EventKind.ToolDispatch:
        this.handleToolDispatch(ev.tool!);
        break;

      case EventKind.ToolProgress:
        this.handleToolProgress(ev.tool!);
        break;

      case EventKind.ToolResult:
        this.handleToolResult(ev.tool!);
        break;

      case EventKind.Usage:
        this.addUsage(ev);
        break;

      case EventKind.Notice:
        this.addNotice(ev.text || '', ev.level || 'info');
        break;
    }
  }

  // ── Reasoning (collapsible) ──

  private appendReasoning(text: string): void {
    if (!this.currentReasoning) {
      // Ensure we have an assistant bubble
      this.ensureAssistantBubble();

      this.currentReasoning = document.createElement('div');
      this.currentReasoning.className = 'msg-reasoning';

      const toggle = document.createElement('button');
      toggle.className = 'msg-reasoning-toggle';
      toggle.innerHTML = `${iconHtml('chevron-right')} 思考过程`;
      toggle.addEventListener('click', () => {
        const content = toggle.nextElementSibling as HTMLElement;
        if (!content) return;
        const show = content.classList.toggle('msg-reasoning-open');
        toggle.innerHTML = show ? `${iconHtml('chevron-down')} 收起思考` : `${iconHtml('chevron-right')} 思考过程`;
      });

      this.currentReasoningContent = document.createElement('div');
      this.currentReasoningContent.className = 'msg-reasoning-content';

      this.currentReasoning.append(toggle, this.currentReasoningContent);
      this.currentBubble!.appendChild(this.currentReasoning);
    }
    this.currentReasoningContent!.textContent += text;
  }

  private flushReasoning(): void {
    this.currentReasoning = null;
    this.currentReasoningContent = null;
  }

  // ── Text (streaming → assistant bubble) ──
  // Incremental markdown rendering: parse safe portions, keep unclosed blocks raw.

  private _streamTextBuf = '';
  private _streamRenderScheduled = false;

  private appendText(text: string, _isFinal: boolean): void {
    this.ensureAssistantBubble();
    this._streamTextBuf += text;

    if (!this.currentTextEl) {
      this.currentTextEl = document.createElement('div');
      this.currentTextEl.className = 'msg-text msg-markdown streaming';
      this.currentBubble!.appendChild(this.currentTextEl);
    }

    // Throttle re-renders: at most once per animation frame
    if (!this._streamRenderScheduled) {
      this._streamRenderScheduled = true;
      requestAnimationFrame(() => {
        this._streamRenderScheduled = false;
        this._renderStreamingMarkdown();
      });
    }
    this.scrollBottom();
  }

  private _renderStreamingMarkdown(): void {
    if (!this.currentTextEl || !this._streamTextBuf) return; // already flushed
    const raw = this._streamTextBuf;

    // Detect odd number of ``` — means the last code fence hasn't been closed
    const fenceCount = (raw.match(/(?:^|\n)```/gm) || []).length;
    let safe = raw, pending = '';

    if (fenceCount % 2 === 1) {
      // Split at the last ``` — everything before it is safe to render
      const lastFence = raw.lastIndexOf('\n```');
      const idx = lastFence >= 0 ? lastFence : raw.lastIndexOf('```');
      if (idx >= 0) {
        safe = raw.slice(0, idx);
        pending = raw.slice(idx);
      } else {
        safe = '';
        pending = raw;
      }
    }

    // Render safe portion as markdown, append pending as plain escaped text
    let html = safe ? (DOMPurify.sanitize(marked.parse(safe) as string)) : '';
    if (pending) {
      html += `<span class="streaming-pending">${escapeHtml(pending)}</span>`;
    }

    this.currentTextEl.innerHTML = html;
    // Syntax highlighting deferred to flushText (expensive, skip during streaming)
  }

  private flushText(): void {
    if (this.currentTextEl && this._streamTextBuf) {
      this.currentTextEl.classList.remove('streaming');
      // Final render: full markdown + syntax highlight (only if not already rendered by renderMarkdownText)
      const raw = this._streamTextBuf;
      const html = DOMPurify.sanitize(marked.parse(raw) as string);
      this.currentTextEl.innerHTML = html;
      this.currentTextEl.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block as HTMLElement);
      });
    }
    this._streamTextBuf = '';
    if (this.currentBubble) {
      this.addMessageActions(this.currentBubble);
    }
    this.currentTextEl = null;
    this.currentBubble = null;
  }

  // ── Markdown rendering (final only, via EventKind.Message) ──

  private renderMarkdownText(text: string): void {
    this.ensureAssistantBubble();
    // If the final text matches what was already streamed, just finalize in place
    if (this.currentTextEl && text === this._streamTextBuf) {
      this.currentTextEl.classList.remove('streaming');
      this.currentTextEl.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block as HTMLElement);
      });
      if (this.currentBubble) {
        this.addMessageActions(this.currentBubble);
      }
      this._streamTextBuf = '';
      this.currentTextEl = null;
      this.currentBubble = null;
      this.scrollBottom();
      return;
    }
    // Different content: replace streaming text element with final rendered version
    if (this.currentTextEl) {
      this.currentTextEl.remove();
    }
    const el = document.createElement('div');
    el.className = 'msg-text msg-markdown';
    const html = DOMPurify.sanitize(marked.parse(text) as string);
    el.innerHTML = html;
    el.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
    this.currentBubble!.appendChild(el);
    this.currentTextEl = el;
    this._streamTextBuf = '';
    this.scrollBottom();
  }

  // ── Message actions (copy button) ──

  private addMessageActions(bubble: HTMLElement): void {
    // Only for assistant bubbles
    if (!bubble.classList.contains('assistant')) return;
    const textEl = bubble.querySelector('.msg-text');
    if (!textEl) return;

    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.innerHTML = iconHtml('copy', 12);
    copyBtn.title = '复制回复';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const txt = textEl.textContent || '';
      navigator.clipboard.writeText(txt).then(() => {
        copyBtn.innerHTML = iconHtml('check-circle', 12);
        setTimeout(() => { copyBtn.innerHTML = iconHtml('copy', 12); }, 1500);
      }).catch(() => {});
    });

    actions.append(copyBtn);
    bubble.appendChild(actions);
  }

  // ── Tool cards ──

  private handleToolDispatch(tool: AgentEvent['tool']): void {
    if (!tool) return;

    // Update existing card (partial → complete args)
    if (this.pendingToolCards.has(tool.id)) {
      const card = this.pendingToolCards.get(tool.id)!;
      const argsEl = card.querySelector('.tool-args') as HTMLElement;
      if (argsEl && tool.args && tool.args.length > 60) {
        argsEl.textContent = truncateArgs(tool.args);
        argsEl.title = tool.args;
      }
      return;
    }

    this.flushReasoning();
    this.flushText();
    this.ensureAssistantBubble();

    const card = document.createElement('div');
    card.className = 'msg-tool-card';
    card.dataset['toolId'] = tool.id;

    const header = document.createElement('div');
    header.className = 'msg-tool-header';

    const icon = tool.read_only
      ? iconHtml('search', 13) // read-only → magnifying glass
      : iconHtml('chevron-right', 13); // write → action arrow
    const nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.innerHTML = `${icon} ${tool.name}`;

    const status = document.createElement('span');
    status.className = 'tool-status';
    status.innerHTML = tool.partial
      ? `<span class="tool-status-spin">${iconHtml('dot', 10)}</span>`
      : iconHtml('blink-dot', 10);

    const argsEl = document.createElement('span');
    argsEl.className = 'tool-args';
    if (tool.args) {
      argsEl.textContent = truncateArgs(tool.args);
      argsEl.title = tool.args;
    }

    header.append(nameEl, argsEl, status);
    header.addEventListener('click', () => {
      card.classList.toggle('tool-expanded');
    });

    const resultEl = document.createElement('div');
    resultEl.className = 'msg-tool-result';

    card.append(header, resultEl);
    this.currentBubble!.appendChild(card);
    this.pendingToolCards.set(tool.id, card);
    this.scrollBottom();
  }

  private handleToolProgress(tool: AgentEvent['tool']): void {
    if (!tool) return;
    const card = this.pendingToolCards.get(tool.id);
    if (!card) return;

    const resultEl = card.querySelector('.msg-tool-result') as HTMLElement;
    if (resultEl && tool.output) {
      resultEl.textContent += tool.output;
      // Auto-expand so user sees the streaming output
      card.classList.add('tool-expanded');
    }
    this.scrollBottom();
  }

  private handleToolResult(tool: AgentEvent['tool']): void {
    if (!tool) return;
    const card = this.pendingToolCards.get(tool.id);
    if (!card) return;

    const status = card.querySelector('.tool-status') as HTMLElement;
    if (status) {
      status.innerHTML = tool.err
        ? iconHtml('close', 12)
        : iconHtml('check-circle', 12);
      status.className = `tool-status ${tool.err ? 'tool-err' : 'tool-ok'}`;
    }

    const resultEl = card.querySelector('.msg-tool-result') as HTMLElement;
    if (resultEl) {
      const text = tool.err || tool.output || '(无输出)';
      resultEl.innerHTML = formatToolResult(tool.name, text, !!tool.truncated);
      // Syntax highlight code blocks in the result
      resultEl.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block as HTMLElement);
      });
    }

    // Auto-expand on error
    if (tool.err) {
      card.classList.add('tool-expanded');
    }

    // Graph visualization is now handled by AgentVisualizer via EventBus
    // (single entry point — eliminates the old triple-call bug)
  }

  // ── Usage ──

  private addUsage(ev: AgentEvent): void {
    this.ensureAssistantBubble();
    const pill = document.createElement('div');
    pill.className = 'msg-usage';

    const u = ev.usage;
    const total = u ? (u.total_tokens ?? 0) : 0;
    const cached = u ? (u.cache_hit_tokens ?? 0) : 0;
    const cost = computeCostStr(ev.pricing, u);

    let label = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
    label += ' tok';
    if (cached > 0) label += ` · ${cached >= 1000 ? (cached / 1000).toFixed(1) + 'k' : cached} cache`;
    if (cost) label += ` · ${cost}`;

    this.lastUsageText = label;
    pill.textContent = label;
    this.currentBubble!.appendChild(pill);
    this.scrollBottom();
    this.updateFooter();
  }

  // ── Notice ──

  private addNotice(text: string, level: 'info' | 'warn' | 'error'): void {
    const el = document.createElement('div');
    el.className = `msg-notice msg-notice-${level}`;
    el.textContent = text;
    this.msgList.appendChild(el);
    this.scrollBottom();
  }

  // ── Footer — model badge, slash commands, usage ──

  private updateFooter(): void {
    const settings = loadSettings();
    const active = settings.providers.find((p) => p.name === settings.activeProvider) || settings.providers[0];

    let modelLabel = active?.model || 'unknown';
    if (modelLabel.length > 18) modelLabel = modelLabel.slice(0, 17) + '…';

    const thinking = active?.thinking ? ' · 思考' : '';
    const usageStr = this.lastUsageText ? ` · ${this.lastUsageText}` : '';
    const mode = CHAT_MODES.find(m => m.id === (settings.agent?.chatMode || 'general')) || CHAT_MODES[0];

    this.footerEl.innerHTML = `
      <div class="chat-footer-left">
        <button class="chat-model-badge chat-model-clickable" title="点击切换模型 · ${active?.name} / ${active?.model}">
          ${iconHtml('agent', 10)} ${modelLabel}${thinking}
        </button>
        <button class="chat-mode-badge" id="chat-mode-badge" title="切换模式 · 当前: ${mode.label}">
          ${iconHtml('agent', 10)} ${mode.label}
        </button>
        <span class="chat-usage-badge">${usageStr}</span>
      </div>
      <div class="chat-footer-right">
        <button class="chat-slash-trigger" title="命令菜单">
          ${iconHtml('code', 12)}<span class="chat-slash-label">/</span>
        </button>
        <button class="chat-session-add" title="新建会话">${iconHtml('plus', 12)}</button>
      </div>`;

    this._buildModePopup(mode);

    // Popup menu for /
    const popup = document.createElement('div');
    popup.className = 'chat-slash-popup';
    popup.innerHTML = `
      <div class="sp-group">
        <div class="sp-group-title">操作</div>
        <button class="sp-item" data-cmd="new">${iconHtml('refresh', 10)} 重置当前会话<span class="sp-key">/new</span></button>
        <button class="sp-item" data-cmd="compact">${iconHtml('save', 10)} 压缩上下文<span class="sp-key">/compact</span></button>
        <button class="sp-item" data-cmd="memory">${iconHtml('bookmark', 10)} 查看记忆<span class="sp-key">/memory</span></button>
        <button class="sp-item" data-cmd="remember">${iconHtml('save', 10)} 记住一件事<span class="sp-key">/remember</span></button>
      </div>
      <div class="sp-group">
        <div class="sp-group-title">查询</div>
        <button class="sp-item" data-cmd="q" data-text="哪些模块最脆弱？">${iconHtml('alert', 10)} 查找脆弱模块</button>
        <button class="sp-item" data-cmd="q" data-text="检查循环依赖">${iconHtml('refresh', 10)} 检查循环依赖</button>
        <button class="sp-item" data-cmd="q" data-text="分析最近改动的影响">${iconHtml('blast', 10)} 影响分析</button>
        <button class="sp-item" data-cmd="q" data-text="" data-placeholder="追踪从 ">${iconHtml('link', 10)} 依赖路径查询</button>
      </div>`;
    this.footerEl.appendChild(popup);

    // Model badge click → open settings
    this.footerEl.querySelector('.chat-model-clickable')?.addEventListener('click', () => {
      this.onOpenSettings?.();
    });

    // / button → toggle popup
    const trigger = this.footerEl.querySelector('.chat-slash-trigger') as HTMLElement;
    trigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      popup.classList.toggle('open');
    });

    // Close popup on outside click (clean up previous listener to prevent zombie handlers)
    if (this.footerClickCleanup) {
      document.removeEventListener('click', this.footerClickCleanup as unknown as EventListener);
    }
    const handler = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node) && e.target !== trigger) {
        popup.classList.remove('open');
      }
    };
    document.addEventListener('click', handler);
    this.footerClickCleanup = handler as unknown as (() => void);

    // Popup items
    popup.querySelectorAll('.sp-item').forEach((item) => {
      item.addEventListener('click', () => {
        popup.classList.remove('open');
        const el = item as HTMLElement;
        const cmd = el.dataset['cmd'];
        if (cmd === 'new') {
          this.inputArea.value = '/new';
          this.sendMessage();
          return;
        }
        if (cmd === 'compact') {
          this.inputArea.value = '/compact';
          this.sendMessage();
          return;
        }
        if (cmd === 'memory') {
          this.inputArea.value = '/memory';
          this.sendMessage();
          return;
        }
        if (cmd === 'remember') {
          this.inputArea.value = '/remember ';
          this.inputArea.focus();
          return;
        }
        // Query commands — fill input text
        const text = el.dataset['text'] || '';
        const placeholder = el.dataset['placeholder'] || '';
        this.inputArea.value = text;
        if (placeholder && !text) {
          this.inputArea.value = placeholder;
          this.inputArea.setSelectionRange(placeholder.length, placeholder.length);
        }
        this.inputArea.style.height = 'auto';
        this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
        this.inputArea.focus();
      });
    });

    // + new session
    this.footerEl.querySelector('.chat-session-add')?.addEventListener('click', () => {
      this.createNewSession();
    });
  }

  // ── Mode selector popup ──

  private _buildModePopup(currentMode: typeof CHAT_MODES[0]): void {
    const badge = this.footerEl.querySelector('#chat-mode-badge') as HTMLElement;
    if (!badge) return;

    // Remove any existing popup
    const existing = this.footerEl.querySelector('.chat-mode-popup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.className = 'chat-mode-popup';
    popup.innerHTML = CHAT_MODES.map(m => `
      <button class="chat-mode-item${m.id === currentMode.id ? ' active' : ''}" data-mode="${m.id}">
        <span class="chat-mode-item-label">${m.label}</span>
        <span class="chat-mode-item-desc">${m.description}</span>
      </button>
    `).join('');

    this.footerEl.appendChild(popup);

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      popup.classList.toggle('open');
    });

    popup.querySelectorAll('.chat-mode-item').forEach(item => {
      item.addEventListener('click', () => {
        const modeId = (item as HTMLElement).dataset['mode'] as string;
        const s = loadSettings();
        s.agent.chatMode = modeId as any;
        saveSettings(s);
        popup.classList.remove('open');
        this._onModeChange?.();
        this.addNotice(`模式已切换为 "${CHAT_MODES.find(m => m.id === modeId)?.label}"`, 'info');
      });
    });

    // Close on outside click
    const handler = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node) && e.target !== badge) {
        popup.classList.remove('open');
      }
    };
    document.addEventListener('click', handler);
    // Cleanup old handler when popup is destroyed (next updateFooter wipes it)
  }

  // ── Helpers ──

  private ensureAssistantBubble(): void {
    if (this.currentBubble) return;
    this.currentBubble = document.createElement('div');
    this.currentBubble.className = 'msg-bubble assistant';
    this.msgList.appendChild(this.currentBubble);
  }

  private appendUserBubble(text: string): void {
    const el = document.createElement('div');
    el.className = 'msg-bubble user';
    const p = document.createElement('div');
    p.className = 'msg-text';
    p.textContent = text;
    el.appendChild(p);
    this.msgList.appendChild(el);
  }

  private addTurnSep(): void {
    const sep = document.createElement('div');
    sep.className = 'msg-turn-sep';
    this.msgList.appendChild(sep);
  }

  private finishTurn(): void {
    this.flushReasoning();
    this.flushText();
    this.pendingToolCards.clear();
    // Auto-save after every turn so sessions survive crash / force-close
    if (this.projectPath) {
      this.saveActiveSession(this.projectPath).catch(() => {});
    }
  }

  private scrollBottom(): void {
    requestAnimationFrame(() => {
      this.msgList.scrollTop = this.msgList.scrollHeight;
    });
  }

  // ── Node name linking ──

  private linkifyNodeNames(): void {
    if (!this.starGraph || !this.currentBubble) return;
    const texts = this.currentBubble.querySelectorAll('.msg-text');
    for (const el of texts) {
      this.autoLink(el as HTMLElement);
    }
  }

  private autoLink(el: HTMLElement): void {
    // Already linkified
    if (el.querySelector('.node-link')) return;

    const graph = this.starGraph;
    if (!graph) return;

    // Use TreeWalker to only touch text nodes — safe for markdown HTML
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text);
    }

    for (const node of textNodes) {
      const text = node.textContent || '';
      const tokens = extractCodeTokens(text);
      if (tokens.length === 0) continue;

      const fragment = linkifyTextNode(text, tokens, (token) => {
        const span = document.createElement('span');
        span.className = 'node-link';
        span.dataset['nodename'] = token;
        span.title = `点击定位: ${token}`;
        span.textContent = token;
        span.addEventListener('click', (e) => {
          e.stopPropagation();
          if (graph) {
            // Try exact match, then prefix, then contains (case-insensitive)
            let found = graph.focusNode(token);
            if (!found) {
              // Try alternative forms: last segment of dotted name, lowercase
              const alt = token.split('.').pop() || '';
              if (alt && alt !== token) found = graph.focusNode(alt);
            }
            if (!found) {
              this.addNotice(`未在图中找到 "${token}"`, 'info');
            }
          }
        });
        return span;
      });

      if (fragment) {
        node.parentNode!.replaceChild(fragment, node);
      }
    }
  }

  // ── Sink getter (used by main.ts to wire Agent) ──

  get sink() {
    return (ev: AgentEvent) => this.renderEvent(ev);
  }
}

// ── Static helpers ──

/** Format tool output for display — JSON gets pretty-printed, code gets highlighted. */
function formatToolResult(toolName: string, text: string, truncated: boolean): string {
  let body = text;
  if (truncated) body += '\n…[截断]…';

  // ── JSON: pretty-print in code block ──
  try {
    const parsed = JSON.parse(body);
    const formatted = JSON.stringify(parsed, null, 2);
    return `<pre><code class="language-json">${escapeHtml(formatted)}</code></pre>`;
  } catch {}

  // ── Empty / very short ──
  if (!body.trim()) return escapeHtml('(无输出)');
  if (body.length < 60 && !body.includes('\n')) return escapeHtml(body);

  // ── Code: read_file_content, run_shell, search_content → code block ──
  if (toolName === 'read_file_content') {
    // Detect language from path? For now, generic code block
    return `<pre><code>${escapeHtml(body)}</code></pre>`;
  }
  if (toolName === 'run_shell') {
    return `<pre><code class="language-bash">${escapeHtml(body)}</code></pre>`;
  }
  if (toolName === 'search_content') {
    return `<pre><code>${escapeHtml(body)}</code></pre>`;
  }

  // ── Edit / write ──
  if (toolName === 'edit_file' || toolName === 'write_file') {
    return `<div class="tool-result-edit">${escapeHtml(body)}</div>`;
  }

  // ── Glob / list_directory — compact list ──
  if (toolName === 'glob') {
    try {
      const data = JSON.parse(text);
      const lines = (data.results || []).map((r: any) => `<span class="glob-entry">📄 ${escapeHtml(r.path)}</span>`);
      const header = `<div class="glob-summary">${data.count} 个文件${data.truncated ? ' (结果已截断)' : ''}</div>`;
      return header + (lines.length > 30
        ? lines.slice(0, 30).join('\n') + `\n<div class="glob-truncated">… 及其他 ${lines.length - 30} 个结果</div>`
        : lines.join('\n'));
    } catch { return escapeHtml(body); }
  }

  // ── Hologram tools: try parsing as JSON (already handled above), fall through ──
  // ── Default: render as markdown (supports tables, lists, etc.) ──
  try {
    const html = DOMPurify.sanitize(marked.parse(body) as string);
    if (html && html !== body) return html;
  } catch {}
  return escapeHtml(body);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateArgs(args: string, max = 60): string {
  if (args.length <= max) return args;
  return args.slice(0, max) + '…';
}

function computeCostStr(pricing: AgentEvent['pricing'], usage: AgentEvent['usage']): string {
  if (!pricing || !usage || !usage.total_tokens) return '';
  const cost =
    ((usage.cache_hit_tokens || 0) * pricing.cache_hit +
      (usage.cache_miss_tokens || 0) * pricing.input +
      (usage.completion_tokens || 0) * pricing.output) /
    1_000_000;
  if (cost < 0.001) return '';
  return `${pricing.currency}${cost.toFixed(cost < 0.01 ? 4 : 3)}`;
}

/** Extract identifiers that look like code symbols from natural language text. */
function extractCodeTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  // Patterns to match: snake_case, CamelCase, dot.paths, paths/with/slashes
  const patterns = [
    /\b[a-z_][a-z0-9_]{2,}(?:\.[a-z_][a-z0-9_]{2,})+\b/gi,  // dot.separated
    /\b[a-z_][a-z0-9_]*_[a-z0-9_]{2,}\b/gi,                   // snake_case
    /\b[A-Z][a-z]+(?:[A-Z][a-z]+){1,}\b/g,                    // CamelCase
    /\b[a-z]+(?:\/[a-z]+){1,}\b/gi,                            // path/like
  ];

  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const t = m[0];
      if (t.length >= 3 && t.length <= 120 && !seen.has(t)) {
        seen.add(t);
        tokens.push(t);
      }
    }
  }

  return tokens.slice(0, 30); // cap to avoid DOM bloat
}

/** Build a DocumentFragment from a text node, wrapping code tokens in link spans. */
function linkifyTextNode(
  text: string,
  tokens: string[],
  createLink: (token: string) => HTMLElement,
): DocumentFragment | null {
  const fragment = document.createDocumentFragment();
  let pos = 0;
  let changed = false;

  while (pos < text.length) {
    let bestIdx = text.length;
    let bestToken = '';
    for (const t of tokens) {
      const idx = text.indexOf(t, pos);
      if (idx >= 0 && idx < bestIdx) {
        bestIdx = idx;
        bestToken = t;
      }
    }
    if (!bestToken) {
      fragment.appendChild(document.createTextNode(text.slice(pos)));
      break;
    }
    if (bestIdx > pos) {
      fragment.appendChild(document.createTextNode(text.slice(pos, bestIdx)));
    }
    fragment.appendChild(createLink(bestToken));
    pos = bestIdx + bestToken.length;
    changed = true;
  }
  return changed ? fragment : null;
}
