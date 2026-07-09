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
import { shell } from './app-shell';
import { cancelPendingApprovals, registerPendingCard } from '../agent/permission';
import { loadSettings, saveSettings, CHAT_MODES } from '../settings';
import { invoke } from '../bridge';
import type { Message, ToolSchema } from '../provider/types';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import gsap from 'gsap';

// ── New message model (data-driven render) ──
import {
  type ChatMessage,
  type UserMessage,
  type AssistantMessage,
  type AssistantPart,
  type MessageId,
  type FileAttachment,
  nextMsgId,
  resetMsgIdCounter,
  createUserMessage,
  createAssistantMessage,
  createNoticeMessage,
  lastTextPart,
  findToolPart,
} from './message-model';
import { renderMessage, type RenderCallbacks } from './message-renderer';
import { CommandRegistry, DEFAULT_COMMANDS, type CommandDef } from './command-registry';

/** Copy-to-clipboard with visual feedback. Shows check-circle icon for 1.5s then restores copy icon. */
function showCopiedFeedback(btn: HTMLElement, iconSize = 12): void {
  const copyHtml = iconHtml('copy', iconSize);
  btn.innerHTML = iconHtml('check-circle', iconSize);
  setTimeout(() => { btn.innerHTML = copyHtml; }, 1500);
}

// ── Constants ──

const PANEL_ID = 'chat-panel';

// ── ChatPanel ──

interface ChatSession {
  id: number;
  label: string;
  agent: Agent;
}

let nextSessionId = 1;

/** djb2 hash for project path → localStorage key isolation. Exported for testing. */
export function hashProjectPath(projectPath: string): number {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

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

  // ── New: data-driven message model (replaces currentBubble + manual DOM) ──
  // All chat messages are stored here. The renderer builds DOM from this array.
  // Streaming updates mutate the last assistant message → then re-render only that one.
  private messages: ChatMessage[] = [];
  /** The ID of the assistant message currently being streamed (null = none). */
  private _streamingAssistantId: MessageId | null = null;
  /** User scrolled up during streaming — pause auto-scroll until they scroll back to bottom. */
  private _userScrolledUp = false;
  /** rAF handle for batching streaming DOM updates (avoid destroying click targets mid-interaction). */
  private _syncRafId: number | null = null;
  // Legacy fields — kept for backward compat during migration, will be removed
  private currentBubble: HTMLElement | null = null;
  private currentReasoning: HTMLElement | null = null;
  private currentReasoningContent: HTMLElement | null = null;
  private currentTextEl: HTMLElement | null = null;
  private pendingToolCards = new Map<string, HTMLElement>(); // id → card element
  private completedToolCount = 0; // ponytail: group completed tools into summary
  private toolSummaryEl: HTMLElement | null = null; // "已执行 N 个工具" line

    // Per-session message cache (DOM elements) — legacy
  private sessionMessages = new Map<number, HTMLElement[]>();
  // Per-session message model cache (ChatMessage[]) — new
  private sessionMessageModels = new Map<number, ChatMessage[]>();

  // File attachments (dragged/selected files)
  private attachedFiles: { path: string; name: string; size: number }[] = [];
  private attachPillsEl: HTMLElement | null = null;

  // Panel mode: pill (44px circle) → panel (summoned) → hud (faded) → input (collapsed bar)
  // All states are CSS classes on the SAME element — one morphing container, zero jump.
  private mode: 'pill' | 'input' | 'panel' | 'hud' = 'pill';
  private graphClickCleanup: (() => void) | null = null;

  private lastUsageText = '';
  private projectPath = '';
  private onOpenSettings: (() => void) | null = null;
  private _onModeChange: (() => void) | null = null;
  private _onTrailToggle: (() => void) | null = null;
  private footerClickCleanup: (() => void) | null = null;
  private lastAgentDiag = '';

  // ── New: input history navigation (item 1) ──
  private inputHistory: string[] = [];
  private historyIdx = 0;
  private draftText = '';

  // ── New: message retry (item 4) ──
  private turnPairs: Array<{ userText: string; userBubble: HTMLElement | null; assistantBubble: HTMLElement | null; sessionIndex: number }> = [];

  // ── New: progress bar (item 3) ──
  private progressBar: HTMLElement | null = null;

  // ── New: @ autocomplete (item 5) ──
  private atPopup: HTMLElement | null = null;
  private atFileCache: { data: string; ts: number } | null = null;
  private atIdx = 0;

  // ── New: token accumulation (item 12) ──
  private totalTokensUsed = 0;

  // ── Pill badge — agent event counter when collapsed ──
  private pillEventCount = 0;
  private pillBadge!: HTMLElement;
  private _lastAgentState: 'idle' | 'thinking' | 'running' | 'error' = 'idle';

  // ── Slash inline panel (command palette, registry-driven) ──
  private _slashPanel: HTMLElement | null = null;
  private _slashNavIdx = 0;
  private _slashVisibleCmds: CommandDef[] = [];

  // ── New: agent panel tabs + status bar ──
  private _activeTab: 'chat' | 'tools' | 'context' = 'chat';
  private tabBar!: HTMLElement;
  private tabContent!: HTMLElement;
  private chatPanel!: HTMLElement;
  private toolsPanel!: HTMLElement;
  private contextPanel!: HTMLElement;
  private statusBar!: HTMLElement;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private statusTokens!: HTMLElement;
  private toolUsage: Map<string, number> = new Map();
  private toolHistory: Array<{ name: string; args: string; ts: number }> = [];
  private _toolSchemas: ToolSchema[] = [];

  setToolSchemas(schemas: ToolSchema[]): void { this._toolSchemas = schemas; }

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
  setOnTrailToggle(fn: () => void): void { this._onTrailToggle = fn; }
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
      if (!d.ready && this.isOpen()) {
        this.refreshHint();
      }
    });
    // ── Detect graph interaction to auto-dismiss the panel ──
    this.setupGraphClickHandler();
    // ── Agent progress feedback (item 3) ──
        bus.on('agent:progress', (data: { step: number; toolName: string }) => {
      if (!this.progressBar || !this.running) return;
      const label = this.progressBar.querySelector('.chat-progress-label');
      if (label) label.textContent = data.step > 0
        ? `步骤 ${data.step}  ·  ${data.toolName}`
        : `正在执行 ${data.toolName}`;
    });
    // ── Sub-agent events (item 10) ──
    bus.on('agent:sub-spawn', (data: { id: string; description: string; prompt: string; mode: string }) => {
      this.handleSubSpawn(data);
    });
    bus.on('agent:sub-progress', (data: { parentToolId: string; text: string }) => {
      this.handleSubProgress(data);
    });
    bus.on('agent:sub-done', (data: { parentToolId: string; summary: any }) => {
      this.handleSubDone(data);
    });
  }

  // ── Public API ──

  private get agent(): Agent | null {
    return this.sessions[this.activeIdx]?.agent ?? null;
  }

  setAgent(agent: Agent | null): void {
    if (!agent) return;
    // Replace all sessions — setAgent is boot/setup, not session management.
    // ponytail: clear old sessions (including placeholder) so the workspace
    // switch always lands on the fresh agent. Old stale sessions caused the
    // agent to answer with "当前没有加载项目" after a project was loaded.
    this.sessionMessages.clear();
    this.sessions = [{
      id: nextSessionId++,
      label: `会话 1`,
      agent,
    }];
    this.activeIdx = 0;
    this.turnPairs = [];
    this.totalTokensUsed = 0;
    this.toolUsage.clear();
    this.toolHistory = [];
    this.renderSessionTabs();
    this.messages = [];
    resetMsgIdCounter();
    this._streamingAssistantId = null;
    this.msgList.innerHTML = '';
    this.addNotice('已连接到当前项目', 'info');
  }

  getAgent(): Agent | null { return this.agent; }
  setStarGraph(g: StarGraph): void { this.starGraph = g; }
  setProjectPath(p: string): void {
    // ponytail: clear user focus when project changes — stale node/file refs
    // from the old workspace would misdirect the agent's tool calls.
    if (p && p !== this.projectPath) {
      this._userFocusFile = null;
      this._userFocusNode = null;
    }
    this.projectPath = p;
  }

  toggle(): void {
    switch (this.mode) {
      case 'pill':  this.summonPanel(); break;
      case 'input': this.summonPanel(); break;
      case 'panel': this.collapseToInput(); break;
      case 'hud':   this.restoreFromHud(); break;
    }
  }

  open(): void {
    this.summonPanel();
  }

  /** Programmatically ask the agent a question. Summons panel and sends. */
  ask(question: string): void {
    this.summonPanel();
    this.inputArea.value = question;
    this.inputArea.style.height = 'auto';
    this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
    // Small delay to let panel animate open before sending
    setTimeout(() => this.sendMessage(), 200);
  }

  /** Render a permission request inline in the chat — no modal, no outside-click-to-deny. */
  showPermissionCard(
    toolName: string,
    reason: string,
    subject: string,
  ): Promise<{ allow: boolean; remember: boolean }> {
    // Only summon the panel if it's not already open — avoids a full
    // morphToMode animation cycle (killTweens → removeClasses → height
    // snap → fadeContentIn 0→1) that makes the chat flash white.
    // When we DO need to open, kill GSAP tweens first: morphToMode has
    // an `if (this._animating) return` guard that silently bails during
    // streaming, leaving the card invisible in a collapsed input bar.
    if (this.mode !== 'panel') {
      this.killPanelTweens();
      this.summonPanel();
    }
    return new Promise((resolve) => {
      const card = document.createElement('div');
      card.className = 'perm-inline-card';

      const header = document.createElement('div');
      header.className = 'perm-inline-header';
      header.innerHTML = `${iconHtml('shield', 14)} <span>授权请求</span>`;

      const toolEl = document.createElement('div');
      toolEl.className = 'perm-inline-tool';
      toolEl.textContent = toolName;

      const descEl = document.createElement('div');
      descEl.className = 'perm-inline-desc';
      descEl.textContent = reason.length > 200 ? reason.slice(0, 197) + '...' : reason;

      const btnRow = document.createElement('div');
      btnRow.className = 'msg-perm-btns';

      const cleanupCard = () => {
        document.removeEventListener('keydown', onKey);
        // Collapse to a one-line notice so streaming replies don't look displaced
        card.style.transition = 'all 0.25s ease';
        card.style.maxHeight = card.scrollHeight + 'px';
        requestAnimationFrame(() => {
          const resultLabel = resultRef.allow
            ? (resultRef.remember ? '本次会话已允许' : '已允许')
            : '已拒绝';
          const icon = resultRef.allow ? 'check-circle' : 'close';
          const color = resultRef.allow ? 'var(--pass, #48cc68)' : 'var(--fail, #d94444)';
          card.innerHTML = `<span style="font-size:calc(11px*var(--font-scale));color:${color};display:flex;align-items:center;gap:6px;padding:4px 0">${iconHtml(icon, 12)} ${toolName} — ${resultLabel}</span>`;
          card.className = 'msg-notice ' + (resultRef.allow ? 'msg-notice-info' : 'msg-notice-warn');
          card.style.maxHeight = '40px';
        });
      };

      let resultRef: { allow: boolean; remember: boolean } = { allow: false, remember: false };
      const resolveAndClose = (result: { allow: boolean; remember: boolean }) => {
        resultRef = result;
        cleanupCard();
        resolve(result);
      };
      registerPendingCard(resolve, cleanupCard);

      const makeBtn = (label: string, cssClass: string, result: { allow: boolean; remember: boolean }) => {
        const btn = document.createElement('button');
        btn.className = `msg-perm-btn ${cssClass}`;
        btn.textContent = label;
        btn.addEventListener('click', (e) => { e.stopPropagation(); resolveAndClose(result); });
        return btn;
      };

      btnRow.appendChild(makeBtn('本次会话允许', 'perm-always', { allow: true, remember: true }));
      btnRow.appendChild(makeBtn('允许', 'perm-once', { allow: true, remember: false }));
      btnRow.appendChild(makeBtn('拒绝', 'perm-deny', { allow: false, remember: false }));

      card.appendChild(header);
      if (subject) {
        const subEl = document.createElement('div');
        subEl.className = 'perm-inline-subject';
        subEl.textContent = subject.length > 120 ? subject.slice(0, 117) + '...' : subject;
        card.appendChild(subEl);
      }
      card.appendChild(toolEl);
      card.appendChild(descEl);
      card.appendChild(btnRow);

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); resolveAndClose({ allow: true, remember: false }); }
        else if (e.key === 'Escape') { e.preventDefault(); resolveAndClose({ allow: false, remember: false }); }
        else if (e.key === 'y' && e.ctrlKey) { e.preventDefault(); resolveAndClose({ allow: true, remember: true }); }
      };
      document.addEventListener('keydown', onKey);

      // Force-reset scroll suppression: this is a blocking interaction
      // point and the user MUST see the card.  If _userScrolledUp was
      // set during earlier text streaming in this turn, scrollBottom()
      // would silently skip — the card lands off-screen and the
      // Promise hangs forever waiting for a click that never comes.
      this._userScrolledUp = false;

      // Insert directly into msgList, NOT into currentBubble.  The
      // streaming DOM path (_doSyncMessagesToDOM) does replaceWith on
      // the bubble every rAF frame, which forces us to detach + re-
      // attach the card (triggering layout + scroll events that falsely
      // set _userScrolledUp).  As a sibling of the assistant bubble,
      // the card lives outside the streaming render path entirely.
      if (this.currentBubble && this.currentBubble.parentNode) {
        this.currentBubble.parentNode.insertBefore(card, this.currentBubble.nextSibling);
      } else {
        this.msgList.appendChild(card);
      }
      this.scrollBottom();
    });
  }

  close(): void {
    // Panel/HUD → input; input → pill
    if (this.mode === 'panel' || this.mode === 'hud') {
      this.collapseToInput();
    } else if (this.mode === 'input') {
      this.collapseToPill();
    }
  }

  isOpen(): boolean { return this.mode === 'panel' || this.mode === 'hud'; }

  // ── Tab switching ──

  private switchTab(tab: 'chat' | 'tools' | 'context'): void {
    if (this._activeTab === tab) return;
    this._activeTab = tab;

    // Update tab buttons
    this.tabBar.querySelectorAll('.chat-panel-tab').forEach(btn => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset['tab'] === tab);
    });

    // Update panels
    this.tabContent.querySelectorAll('.chat-tab-panel').forEach(p => {
      const el = p as HTMLElement;
      el.classList.toggle('active', el.dataset['panel'] === tab);
    });

    // Render on switch
    if (tab === 'tools') this.renderToolsView();
    else if (tab === 'context') this.renderContextView();
  }

  // ── Agent status bar ──

  private _updateStatusBar(state: 'idle' | 'thinking' | 'running' | 'error', detail?: string): void {
    this._lastAgentState = state;
    this.statusDot.className = 'chat-status-dot ' + state;
    const statusLabel = detail || (state === 'idle' ? '就绪' : state === 'thinking' ? '思考中…' : state === 'running' ? '执行工具' : '错误');
    this.statusText.textContent = statusLabel;
    // Update model in status
    const settings = loadSettings();
    const active = settings.providers.find(p => p.name === settings.activeProvider) || settings.providers[0];
    const modelEl = this.statusBar.querySelector('#chat-status-model') as HTMLElement;
    if (modelEl && active) {
      let ml = active.model || '';
      if (ml.length > 20) ml = ml.slice(0, 19) + '…';
      modelEl.textContent = active.name ? `${active.name}/${ml}` : ml;
    }
    if (this.totalTokensUsed > 0) {
      this.statusTokens.textContent = `${(this.totalTokensUsed / 1000).toFixed(1)}k tok`;
    }

  }

  // ── Tool usage tracking ──

  private _recordToolUsage(toolName: string, args: string): void {
    this.toolUsage.set(toolName, (this.toolUsage.get(toolName) || 0) + 1);
    this.toolHistory.unshift({ name: toolName, args, ts: Date.now() });
    if (this.toolHistory.length > 50) this.toolHistory.length = 50;
    // Update badge on tools tab
    const toolsTab = this.tabBar.querySelector('[data-tab="tools"]') as HTMLElement;
    if (toolsTab) {
      const total = Array.from(this.toolUsage.values()).reduce((a, b) => a + b, 0);
      let badge = toolsTab.querySelector('.tab-badge') as HTMLElement;
      if (total > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'tab-badge';
          toolsTab.appendChild(badge);
        }
        badge.textContent = String(total);
      } else if (badge) {
        badge.remove();
      }
    }
  }

  /** Categorize a tool name for visual grouping. */
  // ponytail: graph tools renamed (no hologram_ prefix), matched by known set + memory tools keep prefix
  private static _holoTools?: Set<string>;
  private static isHoloTool(name: string): boolean {
    if (name.startsWith('hologram_')) return true; // memory / legacy tools
    if (!ChatPanel._holoTools) {
      ChatPanel._holoTools = new Set([
        'explore_deps', 'search_symbols', 'get_neighbors', 'trace_impact',
        'find_dep_path', 'inspect_symbol', 'symbol_history', 'get_community',
        'cluster_report', 'async_edges', 'fragile_modules', 'detect_cycles',
        'thread_conflicts', 'coupling_report', 'project_timeline', 'arch_blindspots',
        'graph_summary', 'graph_diff', 'analyze_project', 'preflight_check',
        'validate_project', 'project_health', 'rename_symbol', 'engine_status',
        'check_boundaries', 'find_unused', 'trace_dataflow',
        'resolve_call', 'infer_type', 'find_implementations', 'find_references',
        'dataflow_save', 'dataflow_query',
      ]);
    }
    return ChatPanel._holoTools.has(name);
  }
  private static toolCategory(name: string): 'read' | 'write' | 'exec' | 'holo' {
    if (ChatPanel.isHoloTool(name)) return 'holo';
    if (/^(read|search|grep|glob|list|view|show|get|find|cat|head|tail)/i.test(name)) return 'read';
    if (/^(write|edit|create|delete|remove|mv|cp|rename|save)/i.test(name)) return 'write';
    if (/^(run|exec|bash|shell|cmd|build|test|cargo|npm|git|python|node|web_|ask_|agent_)/i.test(name)) return 'exec';
    return 'read';
  }

  // ── Tools view ──

  private renderToolsView(): void {
    // ponytail: read from ToolRegistry instead of hardcoded list — 50 tools, not 19
    const tools = this._toolSchemas.length > 0
      ? this._toolSchemas.map(t => ({ name: t.name, desc: (t.description||'').split('\n')[0].slice(0,60), cat: ChatPanel.toolCategory(t.name) }))
      : [];

    const maxUsage = Math.max(1, ...Array.from(this.toolUsage.values()));

    let html = '<div class="chat-tools-view">';
    html += '<div class="chat-tools-section-title">工具清单</div>';
    html += '<div class="chat-tools-grid">';
    for (const t of tools) {
      const count = this.toolUsage.get(t.name) || 0;
      const pct = (count / maxUsage) * 100;
      html += `<div class="chat-tool-card tool-cat-${t.cat}" title="${t.name} — ${t.desc}">
        <div class="chat-tool-card-name">${t.name}</div>
        <div class="chat-tool-card-desc">${t.desc}</div>
        ${count > 0 ? `<div class="chat-tool-card-meta"><span>${count} 次调用</span></div>
        <div class="tool-usage-bar"><div class="tool-usage-fill" style="width:${pct}%"></div></div>` : ''}
      </div>`;
    }
    html += '</div>';

    // Recent tool calls
    if (this.toolHistory.length > 0) {
      html += '<div class="chat-tools-section-title" style="margin-top:4px">最近调用</div>';
      html += '<div class="chat-tools-recent">';
      for (const h of this.toolHistory.slice(0, 10)) {
        const argsShort = h.args ? (h.args.length > 40 ? h.args.slice(0, 39) + '…' : h.args) : '';
        html += `<div class="chat-tool-recent-item">
          <span class="chat-tool-recent-name">${h.name}</span>
          <span class="chat-tool-recent-args">${argsShort}</span>
          <span class="chat-tool-recent-count">${new Date(h.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </div>`;
      }
      html += '</div>';
    }

    html += '</div>';
    this.toolsPanel.innerHTML = html;
  }

  // ── Context view ──

  private renderContextView(): void {
    const settings = loadSettings();
    const active = settings.providers.find(p => p.name === settings.activeProvider) || settings.providers[0];
    const ctxWin = settings.agent?.contextWindow || 0;
    const pct = ctxWin > 0 ? Math.min((this.totalTokensUsed / ctxWin) * 100, 100) : 0;
    let meterClass = 'safe';
    if (pct >= 90) meterClass = 'danger';
    else if (pct >= 80) meterClass = 'warn';

    let html = '<div class="chat-context-view">';

    // Context window meter
    html += '<div class="chat-context-section">';
    html += '<div class="chat-context-section-label">上下文窗口</div>';
    html += `<div class="chat-context-meter">
      <div class="chat-context-meter-bar"><div class="chat-context-meter-fill ${meterClass}" style="width:${pct}%"></div></div>
      <span class="chat-context-meter-val">${ctxWin > 0 ? `${(this.totalTokensUsed / 1000).toFixed(1)}k / ${(ctxWin / 1000).toFixed(0)}k` : '未配置'}</span>
    </div>`;
    html += '</div>';

    // Model info
    html += '<div class="chat-context-section">';
    html += '<div class="chat-context-section-label">当前模型</div>';
    html += `<div style="font-family:var(--font-mono);font-size: calc(12px * var(--font-scale));color:var(--signal)">
      ${active?.name || '未知'} / ${active?.model || '未配置'}
      ${active?.thinking ? ' · 思考模式' : ''}
    </div>`;
    html += '</div>';

    // System prompt (scrollable, full content)
    html += '<div class="chat-context-section">';
    html += '<div class="chat-context-section-label">系统提示词</div>';
    const sysMsg = this.agent?.getSession()?.find(m => m.role === 'system');
    if (sysMsg?.content) {
      html += `<pre class="chat-context-system-prompt">${escapeHtml(sysMsg.content)}</pre>`;
    } else {
      html += '<div class="chat-context-empty">Agent 未就绪</div>';
    }
    html += '</div>';

    // Session stats
    html += '<div class="chat-context-section">';
    html += '<div class="chat-context-section-label">会话统计</div>';
    const msgCount = this.agent?.getSession()?.filter(m => m.role !== 'system').length || 0;
    const turnCount = this.turnPairs.length;
    const toolTotal = Array.from(this.toolUsage.values()).reduce((a, b) => a + b, 0);
    html += `<div style="font-family:var(--font-mono);font-size: calc(11px * var(--font-scale));color:rgba(145,180,225,0.55);display:flex;gap:16px">
      <span>${msgCount} 条消息</span>
      <span>${turnCount} 轮对话</span>
      <span>${toolTotal} 次工具调用</span>
    </div>`;
    html += '</div>';

    html += '</div>';
    this.contextPanel.innerHTML = DOMPurify.sanitize(html);
  }

  // ── State transitions (GSAP-powered) ──

  // Content elements that participate in morph animations
  private static readonly CONTENT_SEL =
    '.chat-header, .chat-messages, .chat-input-area, .chat-footer, .chat-expand-handle, .corner-brackets, .chat-resize, .chat-status-bar, .chat-panel-tabs, .chat-tab-content, .chat-progress';

  private contentEls(): HTMLElement[] {
    return gsap.utils.toArray(ChatPanel.CONTENT_SEL, this.panel);
  }

  private killPanelTweens(): void {
    gsap.killTweensOf(this.panel);
    gsap.killTweensOf(this.contentEls());
  }

  /** Strip all modal classes from the panel */
  private removeAllPanelClasses(): void {
    this.panel.classList.remove('chat-pill', 'chat-input-mode', 'chat-open', 'chat-hud');
  }

  /** Animation guard — check if GSAP is actively tweening panel or content */
  private get _animating(): boolean {
    return gsap.isTweening(this.panel) || gsap.isTweening(this.contentEls());
  }

  /**
   * Snapshot CSS-computed opacities BEFORE GSAP touches inline styles.
   * `gsap.fromTo` applies `fromVars` (opacity:0) immediately, then evaluates
   * function-based `toVars` — at that point getComputedStyle returns 0, not the
   * CSS value. We save targets upfront to avoid the self-shadowing.
   */
  private snapshotContentOpacities(): number[] {
    return this.contentEls().map(el => parseFloat(getComputedStyle(el).opacity));
  }

  /** Fade content in from 0 → current CSS opacities. For elements that were display:none. */
  private fadeContentIn(delay = 0.12, duration = 0.2): void {
    const c = this.contentEls();
    const targets = this.snapshotContentOpacities();
    gsap.fromTo(c,
      { opacity: 0 },
      { opacity: (i) => targets[i], duration, ease: 'power2.out', delay },
    );
  }

  /**
   * Cross-fade content between two visible modes (panel ↔ hud).
   * Snapshot current inline opacities BEFORE class change, apply new mode's CSS,
   * then tween from old → new CSS values. No flash to 0.
   */
  private crossfadeContent(fromOpacities: number[], duration = 0.2, ease = 'power2.out'): void {
    const c = this.contentEls();
    const targets = this.snapshotContentOpacities(); // new mode's CSS opacities
    gsap.fromTo(c,
      { opacity: (i) => fromOpacities[i] },
      { opacity: (i) => targets[i], duration, ease },
    );
  }

  // ── Per-bubble entrance animation ──
  // ponytail: single shared method, reused by restore + streaming paths
  private animateBubbleIn(el: HTMLElement, delay = 0): gsap.core.Tween {
    return gsap.fromTo(el,
      { y: 12, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.28, ease: 'power2.out', delay, clearProps: 'transform,opacity' },
    );
  }

  // ── Tool card expand/collapse (GSAP height) ──

  private toggleToolCard(card: HTMLElement): void {
    const result = card.querySelector('.msg-tool-result') as HTMLElement;
    if (!result) return;
    gsap.killTweensOf(result);
    const isOpen = card.classList.contains('tool-expanded');

    if (isOpen) {
      // Collapse → animate to 0, then remove class
      gsap.to(result, {
        height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0,
        duration: 0.2, ease: 'power2.in',
        onComplete: () => {
          card.classList.remove('tool-expanded');
          gsap.set(result, { clearProps: 'all' });
        },
      });
    } else {
      // Expand → add class (triggers display:block), measure, animate from 0
      card.classList.add('tool-expanded');
      const h = result.scrollHeight;
      gsap.fromTo(result,
        { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0 },
        { height: h, opacity: 1, paddingTop: '', paddingBottom: '', duration: 0.25, ease: 'power2.out',
          onComplete: () => gsap.set(result, { clearProps: 'height,opacity,paddingTop,paddingBottom' }) },
      );
    }
  }

  // ── Reasoning block toggle (GSAP height) ──

  private toggleReasoning(toggleBtn: HTMLElement, content: HTMLElement): void {
    gsap.killTweensOf(content);
    const isOpen = content.classList.contains('msg-reasoning-open');

    if (isOpen) {
      // Collapse
      gsap.to(content, {
        height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0,
        duration: 0.2, ease: 'power2.in',
        onComplete: () => {
          content.classList.remove('msg-reasoning-open');
          gsap.set(content, { clearProps: 'all' });
          toggleBtn.innerHTML = `${iconHtml('chevron-right')} 思考过程`;
        },
      });
    } else {
      // Expand
      content.classList.add('msg-reasoning-open');
      content.style.display = 'block';
      const h = content.scrollHeight;
      content.style.display = '';
      gsap.fromTo(content,
        { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0 },
        { height: h, opacity: 1, paddingTop: '', paddingBottom: '', marginTop: '', duration: 0.28, ease: 'power2.out',
          onComplete: () => {
            gsap.set(content, { clearProps: 'height,opacity,paddingTop,paddingBottom,marginTop' });
          },
        },
      );
      toggleBtn.innerHTML = `${iconHtml('chevron-down')} 收起思考`;
    }
  }
  // Expand: pill → input/panel (full morph) or input → panel (height only)
  private morphToMode(mode: 'input' | 'panel', cls: string): void {
    if (this._animating) return;
    const prevMode = this.mode;  // capture before overwriting
    this.mode = mode;
    this.killPanelTweens();

    const fromH = this.panel.offsetHeight;

    this.removeAllPanelClasses();
    this.panel.classList.add(cls);
    this.panel.style.maxHeight = ''; this.panel.style.minHeight = '';
    this.updateFooter();

    if (prevMode === 'pill') {
      // ── Pill → Input/Panel: full radial expand ──
      this.panel.style.width = '560px';
      this.panel.style.borderRadius = '0';
      this.panel.style.height = 'auto';
      const toH = this.panel.offsetHeight;
      // Reset to pill dimensions for animation start (sync — no paint between set+read)
      this.panel.style.width = '48px';
      this.panel.style.height = fromH + 'px';
      this.panel.style.borderRadius = '50%';

      gsap.to(this.panel, {
        width: 560, height: toH, borderRadius: 0,
        duration: 0.38, ease: 'power2.out',
        onComplete: () => { this.panel.style.height = ''; },
      });
      this.fadeContentIn(0.2, 0.22);

      // Handle — elastic stretch-in
      const hi = this.panel.querySelector('.chat-expand-handle-inner') as HTMLElement;
      gsap.fromTo(hi,
        { scaleX: 0, transformOrigin: 'center center' },
        { scaleX: 1, duration: 0.5, delay: 0.24, ease: 'elastic.out(1, 0.4)' },
      );
    } else {
      // ── Input → Panel: already at 560px, animate height only ──
      this.panel.style.width = '560px';
      this.panel.style.borderRadius = '0';
      this.panel.style.height = fromH + 'px';
      // Measure natural target height
      this.panel.style.height = 'auto';
      const toH = this.panel.offsetHeight;
      this.panel.style.height = fromH + 'px';

      gsap.to(this.panel, {
        height: toH, duration: 0.3, ease: 'power2.out',
        onComplete: () => { this.panel.style.height = ''; },
      });
      this.fadeContentIn(0.1, 0.18);

      // Handle — quick pulse (already visible)
      const hi = this.panel.querySelector('.chat-expand-handle-inner') as HTMLElement;
      gsap.to(hi, {
        scaleX: 1.15, duration: 0.1, ease: 'power2.out', transformOrigin: 'center center',
        onComplete: () => gsap.to(hi, { scaleX: 1, duration: 0.25, ease: 'elastic.out(1, 0.5)' }),
      });
    }

    setTimeout(() => this.inputArea.focus(), 380);
    shell.notifyPanelChanged();
  }

  /** Pill → Input: 44px circle morphs into floating input bar */
  private expandToInput(): void {
    this.morphToMode('input', 'chat-input-mode');
  }

  /** Any state → Panel: summon the full conversation card */
  private summonPanel(): void {
    // If agent is running in background, restore to full panel
    if (this.running) this.panel.classList.remove('chat-pill-running');
    this._resetPillBadge();
    this.morphToMode('panel', 'chat-open');
    this.scrollBottom();
  }

  /** Panel/HUD → Input: collapse card to floating input bar */
  private collapseToInput(): void {
    if (this._animating) return;
    this.killPanelTweens();
    const c = this.contentEls();
    const targets = this.snapshotContentOpacities();
    const fromH = this.panel.offsetHeight;

    // Restore panel from any HUD transform
    gsap.to(this.panel, { scale: 1, y: 0, opacity: 1, duration: 0.1, ease: 'power2.out' });

    // Content out → class switch → height down + content in (all overlapped)
    gsap.to(c, {
      opacity: 0, duration: 0.1, ease: 'power2.in',
      onComplete: () => {
        this.mode = 'input';
        this.removeAllPanelClasses();
        this.panel.classList.add('chat-input-mode');
        this.panel.style.maxHeight = ''; this.panel.style.minHeight = '';
        gsap.set(this.panel, { clearProps: 'scale,y,opacity' });

        // Measure target input-bar height then lock back to panel height
        this.panel.style.width = '560px';
        this.panel.style.borderRadius = '0';
        this.panel.style.height = 'auto';
        const toH = this.panel.offsetHeight;
        this.panel.style.height = fromH + 'px';

        // Height + content animate together, snappy ease
        gsap.to(this.panel, {
          height: toH, duration: 0.24, ease: 'power3.out',
          onComplete: () => { this.panel.style.height = ''; },
        });
        gsap.fromTo(c,
          { opacity: 0 },
          { opacity: (i) => targets[i], duration: 0.16, ease: 'power2.out' },
        );

        const hi = this.panel.querySelector('.chat-expand-handle-inner') as HTMLElement;
        gsap.fromTo(hi,
          { scaleX: 0, transformOrigin: 'center center' },
          { scaleX: 1, duration: 0.35, delay: 0.08, ease: 'elastic.out(1, 0.5)' },
        );
      },
    });

    if (this.running) this.panel.classList.add('chat-pill-running');
    if (this.projectPath && this.activeIdx >= 0) {
      this.saveActiveSession(this.projectPath).catch(() => {});
    }
    cancelPendingApprovals();
    this.closeHistory();
    shell.notifyPanelChanged();
  }

  /** Input → Pill: collapse to 48px star circle */
  private collapseToPill(): void {
    if (this._animating) return;
    this.killPanelTweens();
    const c = this.contentEls();

    // Handle snaps shut instantly
    const hi = this.panel.querySelector('.chat-expand-handle-inner') as HTMLElement;
    gsap.to(hi, { scaleX: 0, duration: 0.05, ease: 'power2.in', transformOrigin: 'center center' });

    // Restore panel to full presence
    gsap.to(this.panel, { scale: 1, y: 0, opacity: 1, duration: 0.1, ease: 'power2.in' });

    // Content fades AND panel shrinks simultaneously — no stagger, no dead zone
    gsap.to(c, { opacity: 0, duration: 0.18, ease: 'power2.in' });

    gsap.to(this.panel, {
      width: 48, height: 48, borderRadius: '50%',
      duration: 0.3, ease: 'power3.in',
      onComplete: () => {
        this.mode = 'pill';
        this.removeAllPanelClasses();
        this.panel.classList.add('chat-pill');
        if (this.running) {
          this.panel.classList.add('chat-pill-running');
        }
        this.panel.style.maxHeight = '';
        this.panel.style.minHeight = '';
        this.panel.style.height = '';
        gsap.set(c, { clearProps: 'opacity' });
        gsap.set(this.panel, { clearProps: 'scale,y,opacity' });
      },
    });

    if (this.projectPath && this.activeIdx >= 0) {
      this.saveActiveSession(this.projectPath).catch(() => {});
    }
    cancelPendingApprovals();
    this.closeHistory();
    shell.notifyPanelChanged();
  }

  /** Panel → HUD: ghost the card — panel retreats into star field, messages dissolve bottom→top */
  private fadeToHud(): void {
    if (this.mode !== 'panel' || this._animating) return;
    this.killPanelTweens();
    // Snapshot current content opacities BEFORE changing classes
    const fromOpacities = this.snapshotContentOpacities();
    this.mode = 'hud';
    this.removeAllPanelClasses();
    this.panel.classList.add('chat-hud');
    this.panel.style.maxHeight = ''; this.panel.style.minHeight = '';

    // Panel retreat: scale down, push back, go translucent
    gsap.to(this.panel, {
      scale: 0.96, y: 14, opacity: 0.62,
      duration: 0.45, ease: 'power2.out',
    });
    // Content elements fade to HUD opacities
    this.crossfadeContent(fromOpacities, 0.4);
  }

  /** HUD → Panel: restore the full card — reverse retreat animation */
  private restoreFromHud(): void {
    if (this.mode !== 'hud' || this._animating) return;
    this.killPanelTweens();
    const fromOpacities = this.snapshotContentOpacities();
    this.mode = 'panel';
    this.removeAllPanelClasses();
    this.panel.classList.add('chat-open');
    this.panel.style.maxHeight = ''; this.panel.style.minHeight = '';

    // Reverse the retreat
    gsap.to(this.panel, {
      scale: 1, y: 0, opacity: 1,
      duration: 0.35, ease: 'power2.out',
      onComplete: () => {
        // Clear GSAP inline transform so CSS translateX(-50%) takes over cleanly
        gsap.set(this.panel, { clearProps: 'scale,y,opacity' });
      },
    });
    this.crossfadeContent(fromOpacities, 0.3);
    setTimeout(() => this.inputArea.focus(), 150);
  }

  // ── Graph click detection — dismiss panel when user interacts with the star field ──

  private setupGraphClickHandler(): void {
    const graphEl = document.getElementById('graph');
    if (!graphEl) return;

    const handler = (e: MouseEvent) => {
      // Use 'click' (not mousedown) so camera drag/rotate doesn't dismiss the panel.
      // 'click' only fires on completed clicks without significant pointer movement.
      if (this.mode === 'panel') {
        this.fadeToHud();
      } else if (this.mode === 'hud') {
        this.collapseToPill(); // ghosted → pill directly, no intermediate input bar
      } else if (this.mode === 'input') {
        this.collapseToPill();
      }
    };

    graphEl.addEventListener('click', handler);
    this.graphClickCleanup = () => graphEl.removeEventListener('click', handler);
  }

  // ── Session management ──

  private renderSessionTabs(): void {
    this.sessionTabs.innerHTML = '';
    const multi = this.sessions.length > 1;
    this.sessionTabs.style.display = multi ? '' : 'none';

    for (let i = 0; i < this.sessions.length; i++) {
      const s = this.sessions[i];
      const tab = document.createElement('button');
      tab.className = 'chat-session-tab';
      if (i === this.activeIdx) tab.classList.add('active');
      const shortLabel = s.label.length > 8 ? s.label.slice(0, 7) + '…' : s.label;
      tab.textContent = shortLabel;
      tab.title = `${s.label} (点击切换)`;
      tab.addEventListener('click', () => this.switchSession(i));

      if (multi) {
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

    // When multiple sessions: "对话" tab shows active session name
    const chatTab = this.tabBar.querySelector<HTMLElement>('.chat-panel-tab[data-tab="chat"]');
    if (chatTab) {
      const activeSess = this.sessions[this.activeIdx];
      chatTab.textContent = multi && activeSess
        ? (activeSess.label.length > 6 ? activeSess.label.slice(0, 5) + '…' : activeSess.label)
        : '对话';
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
    this.messages = [];
    resetMsgIdCounter();
    this._streamingAssistantId = null;
    this.msgList.innerHTML = '';
    this.inputHistory = [];
    this.historyIdx = 0;
    this.draftText = '';
    this.turnPairs = [];
    this.totalTokensUsed = 0;
    this.addNotice('新会话已创建 — 可以开始对话', 'info');
    this.lastUsageText = '';
    this.updateFooter();
  }

  private saveCurrentMessages(): void {
    const sid = this.sessions[this.activeIdx]?.id;
    if (!sid) return;
    const children = Array.from(this.msgList.children) as HTMLElement[];
    this.sessionMessages.set(sid, children);
    // Also save the message model so restoreMessages can use the new renderer
    this.sessionMessageModels.set(sid, [...this.messages]);
  }

  private restoreMessages(): void {
    this.msgList.innerHTML = '';
    const sid = this.sessions[this.activeIdx]?.id;
    if (!sid) return;

    // Try to restore from message model cache first
    const cachedMessages = this.sessionMessageModels.get(sid);
    if (cachedMessages) {
      this.messages = cachedMessages;
      this._syncMessagesToDOM();
      return;
    }

    // Fall back: rebuild from agent session (no DOM cloning — that bypassed
    // the model and got wiped by the next _syncMessagesToDOM).
    if (this.agent) {
      this._rebuildMessagesFromSession();
      this._syncMessagesToDOM();
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
    }
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
    // Tool card expand/collapse (GSAP)
    this.msgList.querySelectorAll('.msg-tool-header').forEach((header) => {
      const card = header.parentElement;
      if (card) header.addEventListener('click', () => this.toggleToolCard(card));
    });
    // Reasoning toggle — handled by delegated listener on msgList (buildDOM).
    // No direct handlers here — they'd conflict and cause double-toggle.
    // Copy buttons
    this.msgList.querySelectorAll('.msg-action-btn').forEach((el) => {
      const btn = el as HTMLElement;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bubble = btn.closest('.msg-bubble');
        const txt = (bubble as HTMLElement).innerText || '';
        navigator.clipboard.writeText(txt).then(() => showCopiedFeedback(btn, 12)).catch(() => {});
      });
    });
  }

  // ── Session persistence — one file per session, localStorage backup ──

  /** Strip read_file_content's cat -n line numbers. Rust backend always returns
   *  "{:>6}\t{content}" format. Session JSON files need this stripped before parse. */
  static stripLineNumbers(text: string): string {
    return text.split('\n').map(l => l.replace(/^\s*\d+\t/, '')).join('\n');
  }

  /** Read a session file and parse as JSON. Handles read_file_content's line numbers. */
  private async readSessionJSON(filePath: string): Promise<any> {
    const raw = await invoke<string>('read_file_content', { filePath });
    return JSON.parse(ChatPanel.stripLineNumbers(raw));
  }

  private lsKey(projectPath: string, id: number): string {
    return `hologram_session_${hashProjectPath(projectPath).toString(36)}_${id}`;
  }

  private sessionsDir(projectPath: string): string {
    return `${projectPath.replace(/\\/g, '/')}/.hologram/sessions`;
  }

  private sessionFile(projectPath: string, id: number): string {
    return `${this.sessionsDir(projectPath)}/${id}.json`;
  }

  private trackerFile(projectPath: string): string {
    return `${this.sessionsDir(projectPath)}/_active.json`;
  }

  /** Scan sessions directory for the highest numeric session ID. Returns 0 if no sessions found. */
  private async scanMaxSessionId(projectPath: string): Promise<number> {
    try {
      const entries = await invoke<any[]>('list_directory', { path: this.sessionsDir(projectPath) });
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
        localStorage.setItem(this.lsKey(projectPath, s.id), json);
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
      const t = await this.readSessionJSON(this.trackerFile(projectPath));
      lastId = t.lastId || 0;
      // ponytail: never let tracker push nextSessionId backwards — it causes ID collisions
      // when the tracker was saved with a stale value (e.g. after workspace switch)
      const trackerNextId = t.nextId || (lastId + 1) || 1;
      nextSessionId = Math.max(nextSessionId, trackerNextId);
    } catch { /* tracker missing — try localStorage scan below */ }

    // 2) If tracker missing, scan localStorage for newest session IN THIS WORKSPACE
    if (!lastId && typeof localStorage !== 'undefined') {
      // Compute workspace prefix so we don't pick up sessions from other projects
      const wsPrefix = this.lsKey(projectPath, 0).replace(/_0$/, '_');
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
      this.addNotice('未找到历史会话，已创建新会话', 'info');
      return;
    }

    // ── Load session data (file first, localStorage fallback) ──
    let data: any = null;
    // 1) Try disk file
    try {
      data = await this.readSessionJSON(this.sessionFile(projectPath, lastId));
    } catch { /* file missing — try localStorage */ }

    // 2) localStorage fallback (may be newer if beforeunload save didn't complete)
    if (typeof localStorage !== 'undefined') {
      const lsRaw = localStorage.getItem(this.lsKey(projectPath, lastId));
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
      this.addNotice('历史会话数据为空，已创建新会话', 'info');
      return;
    }

    // ponytail: if the tracked session has no user messages (only system prompt),
    // scan localStorage for a session with actual conversation (no backend dependency)
    {
      const convMsgs = (data.messages as any[]).filter((m: any) => m.role !== 'system');
      if (convMsgs.length === 0 && typeof localStorage !== 'undefined') {
        const wsPrefix = this.lsKey(projectPath, 0).replace(/_0$/, '_');
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
            const lsRaw = localStorage.getItem(this.lsKey(projectPath, bestId));
            if (lsRaw) { data = JSON.parse(lsRaw); lastId = bestId; }
          } catch { /* keep original empty data */ }
        }
      }
    }

    const agent = await this.agentFactory();
    if (!agent) {
      this.addNotice('Agent 未就绪（API Key 未配置？），历史会话暂未恢复', 'warn');
      return;
    }

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
    const dirPath = this.sessionsDir(projectPath);
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

    const result: Array<{ id: number; label: string; msgCount: number; savedAt: string }> = [];
    for (const e of entries) {
      if (e.is_dir || !e.name.endsWith('.json') || e.name === '_active.json') continue;
      const sid = parseInt(e.name.replace('.json', ''), 10);
      if (isNaN(sid)) continue;

      try {
        const d = await this.readSessionJSON(e.path);
        if (d.deleted) continue;
        result.push({
          id: d.id || sid,
          label: d.label || `会话 ${sid}`,
          msgCount: (d.messages as any[])?.filter((m: any) => m.role !== 'system').length || 0,
          savedAt: d.savedAt || '',
        });
      } catch (err) {
        console.error(`[chat] listSavedSessions: failed to read ${e.name}`, err);
      }
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
      data = await this.readSessionJSON(this.sessionFile(projectPath, sessionId));
    } catch { /* try localStorage */ }

    // 2) localStorage fallback
    if (!data && typeof localStorage !== 'undefined') {
      const lsRaw = localStorage.getItem(this.lsKey(projectPath, sessionId));
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
      if (typeof localStorage !== 'undefined') localStorage.removeItem(this.lsKey(projectPath, sessionId));
    } catch { /* ignore */ }
    // If this session is open in a tab, close that tab
    const idx = this.sessions.findIndex(s => s.id === sessionId);
    if (idx >= 0) this.closeSession(idx);
  }

  /** Walk through active agent's session array and build ChatMessage[] + turnPairs. */
  private renderRestoredSession(): void {
    if (!this.agent) return;
    this._rebuildMessagesFromSession();
    this._syncMessagesToDOM();

    // Wire up turnPairs userBubble refs
    let pairIdx = 0;
    const userRows = this.msgList.querySelectorAll<HTMLElement>('.msg-user-row');
    userRows.forEach((row) => {
      if (pairIdx < this.turnPairs.length) {
        this.turnPairs[pairIdx].userBubble = row;
        pairIdx++;
      }
    });

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

  /** Populate this.messages[] + this.turnPairs from this.agent.getSession().
   *  Pure data rebuild — no DOM sync, no notices. */
  private _rebuildMessagesFromSession(): void {
    const agent = this.agent;
    if (!agent) return;

    const msgs = agent.getSession();

    // Reset messages and rebuild from session data
    resetMsgIdCounter();
    this.messages = [];
    this.turnPairs = [];

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
          this.messages.push(createNoticeMessage('📋 上下文已压缩', 'info'));
          continue;
        }
        // Finalize previous pair
        if (pendingUserText && pendingUserId) {
          this.turnPairs.push({ userText: pendingUserText, userBubble: null, assistantBubble: null, sessionIndex: pendingSessionIdx });
        }
        pendingUserText = m.content || '';
        pendingUserId = nextMsgId();
        pendingSessionIdx = idx;
        const um = createUserMessage(m.content || '', undefined, idx);
        this.messages.push(um);
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

        this.messages.push(am);

        // Link to pending user turn
        if (pendingUserText) {
          this.turnPairs.push({ userText: pendingUserText, userBubble: null, assistantBubble: null, sessionIndex: pendingSessionIdx });
          pendingUserText = null;
          pendingUserId = null;
        }
      }
    }

    // Flush any trailing user message
    if (pendingUserText) {
      this.turnPairs.push({ userText: pendingUserText, userBubble: null, assistantBubble: null, sessionIndex: pendingSessionIdx });
    }
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
        width: '20px', height: '20px', padding: '0', fontSize: 'calc(14px * var(--font-scale))',
        background: 'none', border: 'none', color: 'var(--text-muted, #4a5568)',
        cursor: 'pointer', borderRadius: '0', lineHeight: '1',
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

    // ── Panel tabs (Chat | Tools | Context) ──
    this.tabBar = document.createElement('div');
    this.tabBar.className = 'chat-panel-tabs';
    const tabs: Array<{ id: 'chat' | 'tools' | 'context'; label: string }> = [
      { id: 'chat', label: '对话' },
      { id: 'tools', label: '工具' },
      { id: 'context', label: '上下文' },
    ];
    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.className = 'chat-panel-tab';
      btn.dataset['tab'] = t.id;
      btn.textContent = t.label;
      btn.addEventListener('click', () => this.switchTab(t.id));
      this.tabBar.appendChild(btn);
    }
    this.headerEl.appendChild(this.tabBar);

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

    // ── Agent status bar ──
    this.statusBar = document.createElement('div');
    this.statusBar.className = 'chat-status-bar';
    this.statusDot = document.createElement('span');
    this.statusDot.className = 'chat-status-dot idle';
    this.statusText = document.createElement('span');
    this.statusText.className = 'chat-status-text';
    this.statusText.textContent = '就绪';
    const statusModel = document.createElement('span');
    statusModel.className = 'chat-status-model';
    statusModel.id = 'chat-status-model';
    this.statusTokens = document.createElement('span');
    this.statusTokens.className = 'chat-status-tokens';
    this.statusBar.append(this.statusDot, this.statusText, this.statusTokens, statusModel);
    this.panel.appendChild(this.statusBar);

    // ── Tab content container ──
    this.tabContent = document.createElement('div');
    this.tabContent.className = 'chat-tab-content';

    // Chat panel
    this.chatPanel = document.createElement('div');
    this.chatPanel.className = 'chat-tab-panel active';
    this.chatPanel.dataset['panel'] = 'chat';

    // Messages
    this.msgList = document.createElement('div');
    this.msgList.className = 'chat-messages';
    this.chatPanel.appendChild(this.msgList);

    // Delegated click: reasoning toggle survives replaceWith during streaming.
    // msgList itself is never replaced — only its children are.  This handler
    // catches clicks even when the button DOM node was just recreated.
    this.msgList.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const toggle = target.closest('.msg-reasoning-toggle') as HTMLElement | null;
      if (!toggle) return;
      const block = toggle.closest('.msg-reasoning') as HTMLElement | null;
      if (!block) return;
      const content = block.querySelector('.msg-reasoning-content') as HTMLElement | null;
      if (!content) return;
      // Find blockIndex so _expandedReasoning survives DOM replacement
      const bubble = block.closest('.msg-bubble');
      if (bubble) {
        const blocks = Array.from(bubble.querySelectorAll(':scope > .msg-reasoning'));
        const idx = blocks.indexOf(block);
        if (idx >= 0) {
          if (this._expandedReasoning.has(idx)) this._expandedReasoning.delete(idx);
          else this._expandedReasoning.add(idx);
        }
      }
      this.toggleReasoning(toggle, content);
    });

    // Scroll tracking: use wheel (mouse) + touchstart (mobile) to detect
    // user-initiated scroll-up.  The generic `scroll` event also fires on
    // programmatic scrollBottom() calls — those can race with streaming DOM
    // updates (rAF + replaceWith) and produce a stale dist > 40, falsely
    // setting _userScrolledUp when the user never touched anything.
    this.msgList.addEventListener('wheel', (e) => {
      if (e.deltaY < 0) this._userScrolledUp = true;
    });
    this.msgList.addEventListener('touchstart', () => {
      // After touch start, check if user ended up scrolled away from bottom
      setTimeout(() => {
        const dist = this.msgList.scrollHeight - this.msgList.scrollTop - this.msgList.clientHeight;
        if (dist > 40) this._userScrolledUp = true;
      }, 150);
    });
    // Use scroll event only for the "back at bottom → resume" direction
    this.msgList.addEventListener('scroll', () => {
      if (!this._userScrolledUp) return; // nothing to resume
      const dist = this.msgList.scrollHeight - this.msgList.scrollTop - this.msgList.clientHeight;
      if (dist <= 40) this._userScrolledUp = false;
    });

    // Welcome hint
    const hint = document.createElement('div');
    hint.className = 'chat-hint';
    hint.id = 'chat-hint';
    hint.textContent = this.agent
      ? '向我提问代码库的问题，或直接聊天'
      : this.hintText();
    this.msgList.appendChild(hint);

    this.tabContent.appendChild(this.chatPanel);

    // Tools panel
    this.toolsPanel = document.createElement('div');
    this.toolsPanel.className = 'chat-tab-panel';
    this.toolsPanel.dataset['panel'] = 'tools';
    this.tabContent.appendChild(this.toolsPanel);

    // Context panel
    this.contextPanel = document.createElement('div');
    this.contextPanel.className = 'chat-tab-panel';
    this.contextPanel.dataset['panel'] = 'context';
    this.tabContent.appendChild(this.contextPanel);

    this.panel.appendChild(this.tabContent);

    // Expand handle — pull tab to summon panel (visible in input-only mode)
    const expandHandle = document.createElement('div');
    expandHandle.className = 'chat-expand-handle';
    expandHandle.title = '展开对话面板';
    const expandHandleInner = document.createElement('div');
    expandHandleInner.className = 'chat-expand-handle-inner';
    expandHandle.appendChild(expandHandleInner);
    expandHandle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.mode === 'input') this.summonPanel();
      else if (this.mode === 'panel') this.collapseToInput();
    });
    this.panel.appendChild(expandHandle);

    // Input area
    const inputWrap = document.createElement('div');
    inputWrap.className = 'chat-input-area';

    this.inputArea = document.createElement('textarea');
    this.inputArea.className = 'chat-input';
    this.inputArea.placeholder = '输入消息… (Enter 发送, Shift+Enter 换行)';
    this.inputArea.rows = 2;
    this.inputArea.addEventListener('keydown', (e) => {
      // ── @ popup keyboard nav ──
      if (this.atPopup?.classList.contains('open')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const items = this.atPopup.querySelectorAll('.at-item');
          this.atIdx = Math.min(this.atIdx + 1, items.length - 1);
          this.updateAtSelection();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.atIdx = Math.max(this.atIdx - 1, 0);
          this.updateAtSelection();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          this.confirmAtSelection();
          return;
        }
        if (e.key === 'Escape') {
          this.atPopup.classList.remove('open');
          return;
        }
      }
      // ── / slash panel keyboard nav ──
      if (this._slashPanel?.classList.contains('open')) {
        if (e.key === 'ArrowDown') { e.preventDefault(); this._navigateSlashPanel(1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); this._navigateSlashPanel(-1); return; }
        if (e.key === 'Enter')     { e.preventDefault(); this._selectSlashItem(); return; }
        if (e.key === 'Escape')    { this._hideSlashPanel(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
        return;
      }
      // ── Input history navigation ──
      if (e.key === 'ArrowUp' && this.inputHistory.length > 0) {
        const cursorAtStart = this.inputArea.selectionStart === 0 && this.inputArea.selectionEnd === 0;
        if (cursorAtStart) {
          e.preventDefault();
          if (this.historyIdx === this.inputHistory.length) {
            this.draftText = this.inputArea.value;
          }
          if (this.historyIdx > 0) {
            this.historyIdx--;
            this.inputArea.value = this.inputHistory[this.historyIdx];
            this.inputArea.style.height = 'auto';
            this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
          }
          return;
        }
      }
      if (e.key === 'ArrowDown' && this.inputHistory.length > 0) {
        const cursorAtEnd = this.inputArea.selectionStart === this.inputArea.value.length;
        if (cursorAtEnd) {
          e.preventDefault();
          if (this.historyIdx < this.inputHistory.length - 1) {
            this.historyIdx++;
            this.inputArea.value = this.inputHistory[this.historyIdx];
          } else {
            this.historyIdx = this.inputHistory.length;
            this.inputArea.value = this.draftText;
          }
          this.inputArea.style.height = 'auto';
          this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
          return;
        }
      }
      if (e.key === 'Escape') {
        // Close popups first
        if (this._slashPanel?.classList.contains('open')) {
          this._hideSlashPanel();
          return;
        }
        this.close();
      }
    });
    // Auto-resize + @/slash detection
    this.inputArea.addEventListener('input', () => {
      this.inputArea.style.height = 'auto';
      this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
      this.handleAtInput();
      this.handleSlashInput();
    });

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'chat-send-btn';
    this.sendBtn.innerHTML = iconHtml('send');
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'chat-stop-btn hidden';
    this.stopBtn.innerHTML = iconHtml('stop');
    this.stopBtn.addEventListener('click', () => this.abort());

    // Attachment pills — shows between messages and input when files are attached
    this.attachPillsEl = document.createElement('div');
    this.attachPillsEl.className = 'attach-pills';
    this.attachPillsEl.style.display = 'none';
    this.panel.appendChild(this.attachPillsEl);

    inputWrap.append(this.inputArea, this.sendBtn, this.stopBtn);
    this.panel.appendChild(inputWrap);

    // Input footer — model badge, slash commands, usage
    this.footerEl = document.createElement('div');
    this.footerEl.className = 'chat-footer';
    this.panel.appendChild(this.footerEl);

    // ── Pill core — optical sapphire reticle ──
    // ponytail: single clean geometric mark instead of 4 overlapping polygons
    const pillStar = document.createElement('div');
    pillStar.className = 'chat-pill-star';
    const starSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    starSvg.setAttribute('viewBox', '0 0 32 32');
    starSvg.setAttribute('width', '22');
    starSvg.setAttribute('height', '22');
    starSvg.innerHTML = [
      '<circle cx="16" cy="16" r="3" fill="currentColor" opacity="0.9"/>',
      '<polygon points="16,4 28,16 16,28 4,16" fill="none" stroke="currentColor" stroke-width="0.7" opacity="0.45"/>',
    ].join('');
    pillStar.appendChild(starSvg);
    this.panel.appendChild(pillStar);

    // ── Inner tracking ring — dashed orbit with tracer dot ──
    const innerRing = document.createElement('div');
    innerRing.className = 'chat-pill-inner-ring';
    const orbitDot = document.createElement('div');
    orbitDot.className = 'chat-pill-orbit-dot';
    innerRing.appendChild(orbitDot);
    this.panel.appendChild(innerRing);

    // ── Event badge — counts agent events when pill is collapsed ──
    this.pillBadge = document.createElement('div');
    this.pillBadge.className = 'chat-pill-badge';
    this.panel.appendChild(this.pillBadge);

    this.container.appendChild(this.panel);
    // Ensure initial mode class matches this.mode = 'pill'
    this.panel.classList.add('chat-pill');

    // ── Click on panel: HUD restores, pill expands to input bar ──
    this.panel.addEventListener('click', (e) => {
      if (this.mode === 'hud') {
        e.stopPropagation();
        this.restoreFromHud();
      } else if (this.mode === 'pill') {
        e.stopPropagation();
        this.expandToInput();
      }
    });
  }

  // ── Resize ──

  private setupResize(handle: HTMLElement): void {
    let dragging = false;
    let startY = 0;
    let startH = 0;

    const MIN_HEIGHT = 180;
    const MAX_HEIGHT_PCT = 0.7; // 70vh max

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startH = this.panel.offsetHeight;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_PCT);
      const h = Math.max(MIN_HEIGHT, Math.min(maxH, startH + (startY - e.clientY)));
      this.panel.style.maxHeight = h + 'px';
      this.panel.style.minHeight = h + 'px'; // lock both so the card respects the drag
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
    // Clear message list UI and accumulated state
    this.messages = [];
    resetMsgIdCounter();
    this._streamingAssistantId = null;
    this.msgList.innerHTML = '';
    this.inputHistory = [];
    this.historyIdx = 0;
    this.draftText = '';
    this.turnPairs = [];
    this.totalTokensUsed = 0;
    this.addNotice('已开启新会话 — 上下文已清空', 'info');
    this.finishTurn();
    this.updateFooter();
  }

  /** Send an instruction to the agent, optionally showing a user bubble.
   *  @param text The instruction sent to the agent
   *  @param displayLabel If set, shows this as a user bubble (for slash commands) */
  private sendAgentText(text: string, displayLabel?: string): void {
    if (!this.agent || this.running) return;
    this.setRunning(true);

    // Reset auto-scroll for this new turn
    this._userScrolledUp = false;

    const hint = this.msgList.querySelector('.chat-hint');
    if (hint) hint.remove();

    this.addTurnSep();
    if (displayLabel) {
      this.turnPairs.push({ userText: displayLabel, userBubble: null, assistantBubble: null, sessionIndex: this.agent.nextInsertIndex });
      this.appendUserBubble(displayLabel);
    }
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

  /** Run a goal autonomously — Agent keeps going until done or failed.
   *  ponytail: same UI scaffolding as sendAgentText, but calls runGoal instead of run. */
  private runGoal(goal: string): void {
    if (!this.agent || this.running) return;
    this.setRunning(true);
    this._userScrolledUp = false;

    const hint = this.msgList.querySelector('.chat-hint');
    if (hint) hint.remove();

    this.addTurnSep();
    this.turnPairs.push({ userText: `/goal ${goal}`, userBubble: null, assistantBubble: null, sessionIndex: this.agent.nextInsertIndex });
    this.appendUserBubble(`🎯 ${goal}`);

    this.scrollBottom();
    this.abortCtrl = new AbortController();

    this.agent.runGoal(this.abortCtrl.signal, goal).then((result) => {
      this.addNotice(
        result.status === 'completed' ? `✅ 目标达成: ${result.summary.slice(0, 120)}` :
        result.status === 'failed' ? `❌ 目标失败: ${result.summary.slice(0, 120)}` :
        '目标被中断',
        result.status === 'completed' ? 'info' : 'warn',
      );
    }).catch((err: any) => {
      if (err.message?.includes('aborted')) {
        this.addNotice('目标执行已中止', 'info');
      } else {
        this.addNotice(`目标错误: ${err.message || err}`, 'error');
      }
    }).finally(() => {
      this.setRunning(false);
      this.abortCtrl = null;
      this.finishTurn();
      bus.emit('chat:turn-done', {});
    });
  }

  private async sendMessage(): Promise<void> {
    // Reset auto-scroll for this new turn
    this._userScrolledUp = false;

    const text = this.inputArea.value.trim();
    if (!text) return;

    if (!this.agent) {
      const detail = this.lastAgentDiag
        ? `${this.lastAgentDiag} (factory:${this.agentFactory ? 'yes' : 'NO'})`
        : '请先配置 API Key 或等待项目加载';
      this.addNotice(`Agent 未就绪 — ${detail}`, 'error');
      return;
    }

    // ── Registry-driven slash commands ──
    if (text.startsWith('/')) {
      // Parameterized commands — need special handling
      if (text.startsWith('/remember ')) {
        const fact = text.slice('/remember '.length).trim();
        this.inputArea.value = '';
        this.inputArea.style.height = 'auto';
        if (!fact) { this.addNotice('用法: /remember 要记住的内容', 'info'); return; }
        import('../agent/memory.js').then(m => m.authorizeFactSave());
        this.sendAgentText(
          `请将以下事实保存到记忆库：${fact}\n\n使用 hologram_memory_save 工具。选择合适的 type（user/feedback/project/reference），起一个简短的 kebab-case 名称，写清楚 description。`,
          `/remember ${fact}`,
        );
        return;
      }
      if (text.startsWith('/goal ')) {
        const goal = text.slice('/goal '.length).trim();
        this.inputArea.value = '';
        this.inputArea.style.height = 'auto';
        if (!goal) { this.addNotice('用法: /goal 目标描述 — Agent 会自主循环直到完成', 'info'); return; }
        this.runGoal(goal);
        return;
      }
      // Look up simple commands in registry
      const cmd = CommandRegistry.instance.findByShortcut(text.trim());
      if (cmd) {
        this._executeCommand(cmd);
        return;
      }
      // Unknown slash command — route to Skill tool
      if (!text.includes(' ')) {
        const skillName = text.slice(1);
        this.inputArea.value = '';
        this.inputArea.style.height = 'auto';
        this.sendAgentText(`Execute skill: ${skillName}`, text);
        return;
      }
    }

    // ── Insert path: Agent is running, inject message into session ──
    if (this.running) {
      const sessIdx = this.agent.nextInsertIndex;
      this.agent.insertMessage(text);
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      // Push input history
      this.inputHistory.push(text);
      this.historyIdx = this.inputHistory.length;
      this.draftText = '';
      // Show panel if collapsed
      if (this.mode === 'input') this.summonPanel();
      const hint = this.msgList.querySelector('.chat-hint');
      if (hint) hint.remove();
      // Track turn pair (sessionIndex valid: queued messages are applied at safe boundary)
      this.turnPairs.push({ userText: text, userBubble: null, assistantBubble: null, sessionIndex: sessIdx });
      this.addTurnSep();
      this.appendUserBubble(text);
      this.scrollBottom();
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

    // If we're in the floating input bar, summon the full panel before sending
    if (this.mode === 'input') {
      this.summonPanel();
    }

    // Push input history (item 1)
    this.inputHistory.push(text);
    this.historyIdx = this.inputHistory.length;
    this.draftText = '';

    this.inputArea.value = '';
    this.inputArea.style.height = 'auto';
    this.setRunning(true);

    // Remove hint if present
    const hint = this.msgList.querySelector('.chat-hint');
    if (hint) hint.remove();

    // Turn pair for retry (item 4) — sessionIndex is where user msg will land
    const sessIdx = this.agent.getSession().length;
    this.turnPairs.push({ userText: text, userBubble: null, assistantBubble: null, sessionIndex: sessIdx });

    // User bubble (original text, focus context is for Agent eyes only)
    const filesSnapshot = [...this.attachedFiles];
    this.appendUserBubble(text, filesSnapshot);
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

    // Attached files — expose paths so Agent can read them
    if (this.attachedFiles.length > 0) {
      focusPrefix += '用户附加了以下文件：\n';
      for (const f of this.attachedFiles) {
        const sizeStr = f.size < 1024 ? `${f.size} B` :
          f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` :
          `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
        focusPrefix += `- \`${f.path}\` (${sizeStr})\n`;
      }
      focusPrefix += '你可以用 read_file 读取这些文件。\n\n';
      // Clear attachments after sending
      this.attachedFiles = [];
      this.renderAttachments();
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
        // Error card with actions (item 8)
        this.addErrorNotice(err.message || String(err), '', [
          { label: '重试本次请求', onClick: () => { this.inputArea.value = text; this.sendMessage(); } },
          { label: '压缩上下文', onClick: () => { this.inputArea.value = '/compact'; this.sendMessage(); } },
          { label: '新建会话', onClick: () => { this.newSession(); } },
        ]);
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
    // ponytail: keep input + send enabled during run so user can insert messages
    this.stopBtn.classList.toggle('hidden', !r);
    if (r) {
      this.inputArea.placeholder = 'Agent 思考中… 可直接输入消息插入对话';
      this._updateStatusBar('thinking', '分析中…');
      // Insert progress bar (item 3)
      if (!this.progressBar) {
        this.progressBar = document.createElement('div');
        this.progressBar.className = 'chat-progress';
        this.progressBar.innerHTML =
          '<span class="chat-progress-label">准备中…</span><div class="chat-progress-bar"><div class="chat-progress-fill"></div></div>';
        this.headerEl.after(this.progressBar);
      }
    } else {
      this.inputArea.placeholder = '输入消息… (Enter 发送, Shift+Enter 换行)';
      this.inputArea.focus();
      this._updateStatusBar('idle');
      // Remove progress bar
      if (this.progressBar) {
        this.progressBar.remove();
        this.progressBar = null;
      }
      // Clear background-running pill indicator
      this.panel.classList.remove('chat-pill-running');
    }
  }

  // ═══════════════════════════════════════════════════════
  // Data-driven message model — replaces manual DOM append
  // ═══════════════════════════════════════════════════════

  /** Get the assistant message currently being streamed, or create one. */
  private _streamingAssistant(): AssistantMessage {
    if (this._streamingAssistantId) {
      const found = this.messages.find(
        (m) => m.role === 'assistant' && m._id === this._streamingAssistantId,
      );
      if (found) return found as AssistantMessage;
    }
    // Create a new one — find the last user message to link to
    const lastUser = [...this.messages].reverse().find((m) => m.role === 'user');
    const assistant = createAssistantMessage(lastUser?._id ?? '');
    this.messages.push(assistant);
    this._streamingAssistantId = assistant._id;
    return assistant;
  }

  /** Append reasoning text — accumulates into the last reasoning part if one exists. */
  private _appendReasoningPart(text: string): void {
    const assistant = this._streamingAssistant();
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
  private _appendTextPart(text: string): void {
    const assistant = this._streamingAssistant();
    const last = lastTextPart(assistant.parts);
    if (last && !last.finalised) {
      last.text += text;
    } else {
      assistant.parts.push({ type: 'text', text, finalised: false });
    }
  }

  /** Mark the last text part as finalised (streaming text is complete for this step). */
  private _finaliseTextPart(): void {
    const assistant = this._streamingAssistant();
    const last = lastTextPart(assistant.parts);
    if (last) last.finalised = true;
  }

  /** Add or update a tool part. Called from ToolDispatch (create) and ToolProgress (update output). */
  private _upsertToolPart(
    toolId: string,
    name: string,
    args: string,
    label: string,
    readOnly: boolean,
    status: 'pending' | 'running' | 'done' | 'error',
    output?: string,
    err?: string,
    truncated?: boolean,
  ): void {
    const assistant = this._streamingAssistant();
    const existing = findToolPart(assistant.parts, toolId);
    if (existing) {
      existing.status = status;
      if (output !== undefined) existing.output = (existing.output || '') + output;
      if (err !== undefined) existing.err = err;
      if (truncated !== undefined) existing.truncated = truncated;
      // Update args if they grew (partial → complete)
      if (args && args.length > existing.args.length) existing.args = args;
    } else {
      assistant.parts.push({
        type: 'tool',
        toolId, name, args, label, readOnly, status, output, err, truncated,
      });
    }
  }

  /** Update token usage on the current assistant. */
  private _updateTokens(tokensUsed: number): void {
    this.totalTokensUsed += tokensUsed;
    const assistant = this._streamingAssistant();
    assistant.tokensUsed = (assistant.tokensUsed || 0) + tokensUsed;
  }

  /** Push a notice message to the log.
   *  ponytail: uses _scheduleSync (debounced rAF) instead of direct _syncMessagesToDOM.
   *  This breaks the tight coupling between notice creation and full DOM rebuild,
   *  weakening the 21-node render cycle. Notices batch with other pending renders. */
  private _addNoticeMessage(text: string, level: 'info' | 'warn' | 'error'): void {
    this.messages.push(createNoticeMessage(text, level));
    this._scheduleSync();
    this.scrollBottom();
  }

  /** Mark the current streaming assistant as done and start a new turn. */
  private _finaliseStreamingAssistant(): void {
    const assistant = this.messages.find(
      (m) => m.role === 'assistant' && m._id === this._streamingAssistantId,
    ) as AssistantMessage | undefined;
    if (assistant) {
      assistant.status = 'done';
      // Finalise any remaining text parts
      for (const part of assistant.parts) {
        if (part.type === 'text') (part as any).finalised = true;
      }
    }
    // Flush ALL pending render gates BEFORE clearing _streamingAssistantId.
    // _syncRafId = direct rAF from _syncMessagesToDOM,
    // _syncPending = outer rAF from _scheduleSync (double-buffered).
    if (this._syncRafId !== null) {
      cancelAnimationFrame(this._syncRafId);
      this._syncRafId = null;
    }
    this._syncPending = false;
    // Always run one final render while _streamingAssistantId is still set —
    // takes the streaming incremental path instead of a full rebuild, avoiding
    // a visible scroll-to-top-then-bottom jump.
    if (this._streamingAssistantId) {
      this._doSyncMessagesToDOM();
    }
    this._streamingAssistantId = null;
    this._streamTextBuf = '';
  }

  // ── Expanded reasoning blocks (survives DOM replacement during streaming) ──
  private _expandedReasoning = new Set<number>();

  /** Build the renderer callback bag — resolves user text, handles edit/resend. */
  private _renderCallbacks(): RenderCallbacks {
    return {
      isReasoningExpanded: (idx) => this._expandedReasoning.has(idx),
      onToggleReasoning: (idx) => {
        if (this._expandedReasoning.has(idx)) this._expandedReasoning.delete(idx);
        else this._expandedReasoning.add(idx);
      },
      onEditUserMessage: (msg) => {
        if (this.running) { this.addNotice('Agent 正在运行，请先停止再编辑', 'warn'); return; }
        this.inputArea.value = msg.text;
        this.inputArea.style.height = 'auto';
        this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
        this.inputArea.focus();
        this.inputArea.selectionStart = this.inputArea.selectionEnd = msg.text.length;
        this._retractUserMessage(msg);
      },
      onResendUserMessage: (msg) => {
        if (this.running) { this.addNotice('Agent 正在运行，请先停止再重发', 'warn'); return; }
        this.inputArea.value = msg.text;
        this._retractUserMessage(msg);
        this.sendMessage();
      },
      onRetryAssistant: (assistant, _userText) => {
        if (this.running) { this.addNotice('Agent 正在运行，请先停止再重试', 'warn'); return; }
        // Find the user message this assistant was responding to
        const pair = this.turnPairs.find(
          (tp) =>
            tp.assistantBubble &&
            tp.assistantBubble.dataset.messageId === assistant._id,
        );
        const userText = pair?.userText || '';
        if (!userText) return;
        this.inputArea.value = '';
        this.setRunning(true);
        this.addTurnSep();
        if (!this.agent) return;
        const sessIdx = this.agent.getSession().length;
        this.turnPairs.push({
          userText,
          userBubble: null,
          assistantBubble: null,
          sessionIndex: sessIdx,
        });
        this.abortCtrl = new AbortController();
        this.agent
          .run(this.abortCtrl.signal, userText)
          .catch((err: any) => {
            if (!err.message?.includes('aborted')) {
              this.addErrorNotice(err.message || String(err), '', [
                {
                  label: '重试',
                  onClick: () => {
                    this.inputArea.value = userText;
                    this.sendMessage();
                  },
                },
              ]);
            }
          })
          .finally(() => {
            this.setRunning(false);
            this.abortCtrl = null;
            this.finishTurn();
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

  /** Remove a user message from the messages array and take it out of the agent session. */
  private _retractUserMessage(msg: UserMessage): void {
    const idx = this.messages.indexOf(msg as any as ChatMessage);
    if (idx >= 0) {
      // Remove the user message and its assistant response
      const toRemove: number[] = [idx];
      // Find the assistant that responded to this
      for (let i = idx + 1; i < this.messages.length; i++) {
        const m = this.messages[i];
        if (m.role === 'assistant' && (m as AssistantMessage).respondingTo === msg._id) {
          toRemove.push(i);
          break;
        } else if (m.role === 'user') {
          break; // next user message → stop
        }
      }
      for (const i of toRemove.reverse()) {
        this.messages.splice(i, 1);
      }
    }
    // Also retract from agent session
    if (msg.sessionIndex >= 0) {
      this.agent?.retractTurnAt(msg.sessionIndex);
    }
    this._syncMessagesToDOM();
  }

  /** Re-render a single message at the given index (in-place DOM replace). */
  private _rerenderMessageAt(index: number): void {
    const msg = this.messages[index];
    if (!msg) return;
    const callbacks = this._renderCallbacks();
    const el = renderMessage(msg, callbacks);
    // Track message ID on the element so turnPairs can find it
    el.dataset.messageId = msg._id;
    const children = this.msgList.children;
    if (index < children.length) {
      children[index].replaceWith(el);
    } else {
      this.msgList.appendChild(el);
    }
    // If this is an assistant message done rendering, inject code block buttons
    if (msg.role === 'assistant' && (msg as AssistantMessage).status === 'done') {
      // injectCodeBlockButtons is in message-renderer.ts
    }
  }

  /** Full sync: rebuild DOM from messages[]. Efficient for streaming (only last changes). */
  private _syncMessagesToDOM(): void {
    // During streaming, batch DOM updates to animation frames.  This prevents
    // rapid replaceWith calls from destroying event listeners (e.g. reasoning
    // toggle button) between mousedown and click — the button stays alive.
    if (this._streamingAssistantId) {
      if (this._syncRafId !== null || this._syncPending) return; // already scheduled this frame
      this._syncRafId = requestAnimationFrame(() => {
        this._syncRafId = null;
        this._doSyncMessagesToDOM();
      });
      return;
    }
    this._doSyncMessagesToDOM();
  }

  private _doSyncMessagesToDOM(): void {
    const callbacks = this._renderCallbacks();
    const currentChildCount = this.msgList.children.length;
    const msgCount = this.messages.length;

    // If only the last message changed (streaming), re-render just that
    if (
      msgCount === currentChildCount &&
      msgCount > 0 &&
      this._streamingAssistantId
    ) {
      const lastIdx = msgCount - 1;
      const lastMsg = this.messages[lastIdx];
      if (lastMsg.role === 'assistant' && lastMsg._id === this._streamingAssistantId) {
        const oldEl = this.msgList.children[lastIdx] as HTMLElement;
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
        this.scrollBottom();
        return;
      }
    }

    // Full rebuild — preserve injected siblings (permission cards) across re-render.
    // Streaming executor (Window B) can trigger this while a perm card is showing.
    const existing = Array.from(this.msgList.children);

    // Collect injected elements (perm cards, task notifications) to preserve
    const injects: { el: Element; afterIdx: number }[] = [];
    for (let i = 0; i < existing.length; i++) {
      const el = existing[i];
      if (el.classList.contains('perm-inline-card') || el.classList.contains('task-notification')) {
        injects.push({ el, afterIdx: i - 1 }); // re-insert after the preceding message
        existing.splice(i, 1);
        i--;
      }
    }

    for (let i = 0; i < msgCount; i++) {
      const msg = this.messages[i];
      const el = renderMessage(msg, callbacks);
      el.dataset.messageId = msg._id;
      if (i < existing.length) {
        existing[i].replaceWith(el);
        existing[i] = el;
      } else {
        this.msgList.appendChild(el);
      }
    }

    // Remove excess children (skip injects — already removed above)
    while (this.msgList.children.length > msgCount) {
      const last = this.msgList.lastChild;
      if (last instanceof Element && (last.classList.contains('perm-inline-card') || last.classList.contains('task-notification'))) {
        break; // don't remove injects
      }
      last?.remove();
    }

    // Re-insert preserved injects after their original preceding message
    for (const { el, afterIdx } of injects) {
      const ref = this.msgList.children[afterIdx + 1] || null;
      this.msgList.insertBefore(el, ref);
    }

    this.scrollBottom();
  }

  // ── Throttled rAF sync — avoids O(n²) re-render on high-frequency streams ──
  // ponytail: _scheduleSync is now a thin wrapper that reuses _syncMessagesToDOM's
  // single rAF gate (_syncRafId). The old double-buffering (_syncPending → rAF →
  // _syncMessagesToDOM → rAF → _doSyncMessagesToDOM) added 2-frame latency and
  // left a gap where renders could be dropped by _finaliseStreamingAssistant.
  private _syncPending = false;
  private _scheduleSync(): void {
    if (this._syncPending || this._syncRafId !== null) return;
    this._syncPending = true;
    this._syncRafId = requestAnimationFrame(() => {
      this._syncRafId = null;
      this._syncPending = false;
      this._doSyncMessagesToDOM();
    });
  }

  // ── Event Sink — render Agent events to DOM (NEW data-driven path) ──

  private renderEvent(ev: AgentEvent): void {
    switch (ev.kind) {
      case EventKind.TurnStarted:
        this._finaliseStreamingAssistant();
        // Link assistant bubble to last turn pair before resetting
        if (this.turnPairs.length > 0) {
          const bubbles = this.msgList.querySelectorAll<HTMLElement>('.msg-bubble.assistant');
          const lastBubble = bubbles[bubbles.length - 1];
          if (lastBubble) this.turnPairs[this.turnPairs.length - 1].assistantBubble = lastBubble;
        }
        this.pendingToolCards.clear();
        this.resetReasoningBlock();
        this.completedToolCount = 0;
        if (this.toolSummaryEl) { this.toolSummaryEl.remove(); this.toolSummaryEl = null; }
        this._expandedReasoning.clear();
        this.currentBubble = null;
        this.currentTextEl = null;
        this._streamTextBuf = '';
        this._streamStableLen = 0;
        this._streamStableEl = null;
        this._streamUnstableEl = null;
        break;

      case EventKind.Reasoning:
        if (ev.text) {
          const isFirst = !this._streamingAssistantId;
          this._appendReasoningPart(ev.text);
          // First chunk: show bubble immediately. Subsequent: rAF throttle.
          if (isFirst) this._syncMessagesToDOM();
          else this._scheduleSync();
        }
        break;

      case EventKind.Text:
        if (ev.text) {
          const isFirst = !this._streamingAssistantId;
          this._appendTextPart(ev.text);
          if (isFirst) this._syncMessagesToDOM();
          else this._scheduleSync();
        }
        break;

      case EventKind.Message:
        if (ev.text) {
          this._finaliseTextPart();
        }
        // ponytail: flushReasoning/flushText are legacy no-ops in the data-driven path;
        // kept as markers — the next turn's Reasoning will create a new part naturally.
        this._syncMessagesToDOM();
        this.linkifyNodeNames();
        break;

      case EventKind.ToolDispatch:
        if (ev.tool) {
          const t = ev.tool;
          this._recordToolUsage(t.name, t.args || '');
          this._updateStatusBar('running', `执行 ${t.name}`);
          this._upsertToolPart(
            t.id, t.name, t.args || '', t.name,
            t.read_only ?? false,
            t.partial ? 'pending' : 'running',
          );
          // Tool dispatch is low-frequency — render immediately so user sees feedback
          this._syncMessagesToDOM();
        }
        break;

      case EventKind.ToolProgress:
        if (ev.tool) {
          const t = ev.tool;
          this._upsertToolPart(
            t.id, t.name, t.args || '', t.name,
            t.read_only ?? false,
            'running',
            t.output, // append output
          );
          // Streaming tool output — throttle to animation frame
          this._scheduleSync();
        }
        break;

      case EventKind.ToolResult:
        if (ev.tool) {
          const t = ev.tool;
          this._upsertToolPart(
            t.id, t.name, t.args || '', t.name,
            t.read_only ?? false,
            t.err ? 'error' : 'done',
            !t.err ? t.output : undefined,
            t.err,
            t.truncated,
          );
          this._syncMessagesToDOM();
        }
        break;

      case EventKind.Usage:
        if (ev.usage?.total_tokens) {
          this._updateTokens(ev.usage.total_tokens);
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
          this.lastUsageText = label;
          this.totalTokensUsed = total;
          this.updateFooter();
          this._syncMessagesToDOM();
        }
        break;

      case EventKind.Notice:
        this._addNoticeMessage(ev.text || '', ev.level || 'info');
        break;

      case EventKind.SessionChanged:
        this._syncMessagesToDOM();
        break;
    }
  }

  // ── Reasoning (collapsible) ──

  // ponytail: accumulate all reasoning in a turn into ONE collapsible block.
  // The toggle is created once; subsequent reasoning blocks append to the same content.
  private reasoningBlock: HTMLElement | null = null;
  private reasoningBlockContent: HTMLElement | null = null;
  private reasoningBlockToggle: HTMLElement | null = null;

  private appendReasoning(text: string): void {
    this.ensureAssistantBubble();

    if (!this.reasoningBlock) {
      this.reasoningBlock = document.createElement('div');
      this.reasoningBlock.className = 'msg-reasoning';

      this.reasoningBlockContent = document.createElement('div');
      this.reasoningBlockContent.className = 'msg-reasoning-content';

      this.reasoningBlockToggle = document.createElement('button');
      this.reasoningBlockToggle.className = 'msg-reasoning-toggle';
      this.reasoningBlockToggle.innerHTML = `${iconHtml('chevron-right')} 思考过程`;
      // Capture toggle + content locally — the class-level refs get reset
      // by flushReasoning() between rounds, so closure over `this.xxx` is wrong.
      const capturedToggle = this.reasoningBlockToggle;
      const capturedContent = this.reasoningBlockContent;
      capturedToggle.addEventListener('click', () => {
        this.toggleReasoning(capturedToggle, capturedContent);
      });

      this.reasoningBlock.append(this.reasoningBlockToggle, this.reasoningBlockContent);
      this.currentBubble!.appendChild(this.reasoningBlock);
    }
    this.reasoningBlockContent!.textContent += text;
  }

  private flushReasoning(): void {
    // Close the current reasoning block so the next LLM reasoning round
    // creates a fresh collapsible block instead of appending to the old one.
    // The DOM elements stay visible in the bubble; we just null the refs.
    this.resetReasoningBlock();
  }

  private resetReasoningBlock(): void {
    this.reasoningBlock = null;
    this.reasoningBlockContent = null;
    this.reasoningBlockToggle = null;
  }

  // ── Text (streaming → assistant bubble) ──
  // ponytail: stable-prefix incremental markdown — only the trailing incomplete
  // block is re-rendered each frame. Completed blocks are moved to a stable
  // child div and rendered once via marked.parse(). This avoids O(n) full-text
  // re-parse + DOM reflow on every frame, the root cause of streaming jitter.
  // Reference: Claude Code's StreamingMarkdown stable-prefix algorithm.

  private _streamTextBuf = '';
  private _streamRenderScheduled = false;
  private _streamStableLen = 0;       // char offset of stable prefix already rendered
  private _streamStableEl: HTMLElement | null = null;
  private _streamUnstableEl: HTMLElement | null = null;

  private appendText(text: string, _isFinal: boolean): void {
    this.ensureAssistantBubble();
    this._streamTextBuf += text;

    if (!this.currentTextEl) {
      this.currentTextEl = document.createElement('div');
      this.currentTextEl.className = 'msg-text msg-markdown streaming';

      // Two-layer DOM: stable (completed blocks, rarely updated) + unstable (tail, updated per frame)
      this._streamStableEl = document.createElement('div');
      this._streamStableEl.className = 'msg-markdown-stable';
      this._streamUnstableEl = document.createElement('div');
      this._streamUnstableEl.className = 'msg-markdown-unstable';
      this.currentTextEl.appendChild(this._streamStableEl);
      this.currentTextEl.appendChild(this._streamUnstableEl);

      this.currentBubble!.appendChild(this.currentTextEl);
      this._streamStableLen = 0;
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
    if (!this.currentTextEl || !this._streamStableEl || !this._streamUnstableEl || !this._streamTextBuf) return;
    const raw = this._streamTextBuf;

    // 1. Strip last incomplete line — mid-line arrivals cause paragraph reflow
    const lastNL = raw.lastIndexOf('\n');
    const visible = lastNL >= 0 ? raw.substring(0, lastNL + 1) : '';
    const trailingLine = lastNL >= 0 ? raw.substring(lastNL + 1) : raw;

    // 2. Use marked.lexer() to find safe token boundary.
    //    Unclosed code fences, half-written tables, etc. are each a single token —
    //    the lexer naturally handles all markdown block types.
    let stableText = '';
    let unstableText = '';

    if (visible) {
      try {
        const tokens = marked.lexer(visible);
        // Find last non-space token
        let lastNonSpace = -1;
        for (let i = tokens.length - 1; i >= 0; i--) {
          const t = tokens[i] as { raw?: string };
          if (t.raw && t.raw.trim()) { lastNonSpace = i; break; }
        }

        if (lastNonSpace >= 0) {
          let cut = 0;
          for (let i = 0; i < lastNonSpace; i++) {
            cut += (tokens[i] as { raw?: string }).raw?.length || 0;
          }
          stableText = visible.substring(0, cut);
          unstableText = visible.substring(cut);
        } else {
          unstableText = visible;
        }
      } catch {
        // lexer failed (unlikely) — treat everything as unstable
        unstableText = visible;
      }
    }

    // 3. Update stable child: only re-render when the stable prefix grew
    if (stableText.length > this._streamStableLen) {
      this._streamStableLen = stableText.length;
      if (stableText) {
        this._streamStableEl.innerHTML = DOMPurify.sanitize(marked.parse(stableText) as string);
      }
    }

    // 4. Update unstable child: re-render the incomplete tail + trailing line each frame
    let unstableHtml = '';
    if (unstableText) {
      unstableHtml += `<span class="streaming-pending">${escapeHtml(unstableText)}</span>`;
    }
    if (trailingLine) {
      unstableHtml += `<span class="streaming-typing">${escapeHtml(trailingLine)}</span>`;
    }
    this._streamUnstableEl.innerHTML = unstableHtml;
  }

  private flushText(): void {
    if (this.currentTextEl && this._streamTextBuf) {
      this.currentTextEl.classList.remove('streaming');
      // Final render: replace two-layer streaming DOM with single full markdown + syntax highlight
      const raw = this._streamTextBuf;
      const html = DOMPurify.sanitize(marked.parse(raw) as string);
      this.currentTextEl.innerHTML = html;
      this.currentTextEl.dataset.rawMarkdown = raw;
      this.currentTextEl.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block as HTMLElement);
      });
      if (this.currentBubble) {
        this.addMessageActions(this.currentBubble);
        this.injectCodeBlockButtons(this.currentBubble);
      }
    }
    this._streamTextBuf = '';
    this._streamStableLen = 0;
    this._streamStableEl = null;
    this._streamUnstableEl = null;
    this.currentTextEl = null;
    // ponytail: currentBubble lives until finishTurn() — tool cards, usage,
    // and multi-step text all share one bubble per assistant response.
  }

  // ── Markdown rendering (final only, via EventKind.Message) ──

  private renderMarkdownText(text: string): void {
    this.ensureAssistantBubble();
    // If the final text matches what was already streamed, just finalize in place
    if (this.currentTextEl && text === this._streamTextBuf) {
      this.currentTextEl.classList.remove('streaming');
      // Replace two-layer streaming DOM with final single-element render
      const html = DOMPurify.sanitize(marked.parse(text) as string);
      this.currentTextEl.innerHTML = html;
      this.currentTextEl.dataset.rawMarkdown = text;
      this.currentTextEl.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block as HTMLElement);
      });
      if (this.currentBubble) {
        this.addMessageActions(this.currentBubble);
        this.injectCodeBlockButtons(this.currentBubble);
      }
      this._streamTextBuf = '';
      this._streamStableLen = 0;
      this._streamStableEl = null;
      this._streamUnstableEl = null;
      this.currentTextEl = null;
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
    el.dataset.rawMarkdown = text;
    el.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
    this.currentBubble!.appendChild(el);
    this._streamTextBuf = '';
    this._streamStableLen = 0;
    this._streamStableEl = null;
    this._streamUnstableEl = null;
    this.currentTextEl = null;
    if (this.currentBubble) {
      this.addMessageActions(this.currentBubble);
      this.injectCodeBlockButtons(this.currentBubble);
    }
    this.scrollBottom();
  }

  // ── Message actions (copy button) ──

  /** actionHost is where the actions div gets appended. Defaults to bubble.
   *  For user bubbles, actionHost is the row wrapper so buttons sit outside. */
  private addMessageActions(bubble: HTMLElement, actionHost?: HTMLElement): void {
    const host = actionHost || bubble;
    if (host.querySelector('.msg-actions')) return;
    const textEl = bubble.querySelector('.msg-text');
    if (!textEl) return;

    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    if (bubble.classList.contains('assistant')) {
      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'msg-action-btn';
      copyBtn.innerHTML = iconHtml('copy', 12);
      copyBtn.title = '复制回复';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const txt = (textEl as HTMLElement).dataset?.rawMarkdown || textEl.textContent || '';
        navigator.clipboard.writeText(txt).then(() => showCopiedFeedback(copyBtn, 12)).catch(() => {});
      });
      actions.append(copyBtn);

      // Retry button (item 4) — find matching turn pair
      for (let i = this.turnPairs.length - 1; i >= 0; i--) {
        if (this.turnPairs[i].assistantBubble === bubble) {
          const pairIdx = i;
          const retryBtn = document.createElement('button');
          retryBtn.className = 'msg-action-btn';
          retryBtn.innerHTML = iconHtml('refresh', 12);
          retryBtn.title = '重试此回复';
          retryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.running) { this.addNotice('Agent 正在运行，请先停止再重试', 'warn'); return; }
            if (!this.agent) return;
            const text = this.turnPairs[pairIdx]?.userText;
            if (!text) return;
            // Retract old turn before re-sending
            this.retractTurn(pairIdx);
            this.inputArea.value = '';
            this.setRunning(true);
            this.addTurnSep();
            const sessIdx = this.agent.getSession().length;
            this.turnPairs.push({ userText: text, userBubble: null, assistantBubble: null, sessionIndex: sessIdx });
            this.abortCtrl = new AbortController();
            this.agent.run(this.abortCtrl.signal, text)
              .catch((err: any) => {
                if (!err.message?.includes('aborted')) {
                  this.addErrorNotice(err.message || String(err), '', [
                    { label: '重试', onClick: () => { this.inputArea.value = text; this.sendMessage(); } },
                  ]);
                }
              })
              .finally(() => {
                this.setRunning(false);
                this.abortCtrl = null;
                this.finishTurn();
              });
          });
          actions.append(retryBtn);
          break;
        }
      }
    }

    if (bubble.classList.contains('user')) {
      // Find turn pair index for this user bubble
      let pairIdx = -1;
      for (let i = this.turnPairs.length - 1; i >= 0; i--) {
        if (this.turnPairs[i].userBubble === host) { pairIdx = i; break; }
      }

      // Edit button
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn';
      editBtn.innerHTML = iconHtml('edit', 12);
      editBtn.title = '编辑消息';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.running) { this.addNotice('Agent 正在运行，请先停止再编辑', 'warn'); return; }
        if (pairIdx < 0) return;
        const txt = this.retractTurn(pairIdx);
        if (txt == null) return;
        this.inputArea.value = txt;
        this.inputArea.style.height = 'auto';
        this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
        this.inputArea.focus();
        this.inputArea.selectionStart = this.inputArea.selectionEnd = txt.length;
      });
      actions.append(editBtn);

      // Resend button
      const resendBtn = document.createElement('button');
      resendBtn.className = 'msg-action-btn';
      resendBtn.innerHTML = iconHtml('refresh', 12);
      resendBtn.title = '重新发送';
      resendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.running) { this.addNotice('Agent 正在运行，请先停止再重发', 'warn'); return; }
        if (pairIdx < 0) return;
        const txt = this.retractTurn(pairIdx);
        if (txt == null) return;
        this.inputArea.value = txt;
        this.sendMessage();
      });
      actions.append(resendBtn);
    }

    if (actions.children.length > 0) {
      host.appendChild(actions);
    }
  }

  /** Retract a turn from DOM and agent session. Returns userText or null. */
  private retractTurn(idx: number): string | null {
    const pair = this.turnPairs[idx];
    if (!pair) return null;
    // Remove user row + assistant bubble from DOM
    if (pair.userBubble) pair.userBubble.remove();
    if (pair.assistantBubble) pair.assistantBubble.remove();
    // Remove from agent session — search by content if index is stale (inserted mid-run)
    let sessIdx = pair.sessionIndex;
    if (sessIdx < 0) {
      const session = this.agent?.getSession() || [];
      for (let i = 0; i < session.length; i++) {
        if (session[i].role === 'user' && session[i].content === pair.userText) {
          sessIdx = i; break;
        }
      }
    }
    if (sessIdx >= 0) this.agent?.retractTurnAt(sessIdx);
    // Remove from turnPairs
    this.turnPairs.splice(idx, 1);
    // Re-index sessionIndex for remaining pairs from the actual session
    const session = this.agent?.getSession() || [];
    const userMsgIndices: number[] = [];
    for (let i = 0; i < session.length; i++) {
      if (session[i].role === 'user') userMsgIndices.push(i);
    }
    for (let i = 0; i < this.turnPairs.length && i < userMsgIndices.length; i++) {
      this.turnPairs[i].sessionIndex = userMsgIndices[i];
    }
    return pair.userText;
  }

  // ── Tool cards ──

  private handleToolDispatch(tool: AgentEvent['tool']): void {
    if (!tool) return;

    // Track usage
    this._recordToolUsage(tool.name, tool.args || '');
    this._updateStatusBar('running', `执行 ${tool.name}`);

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

    this.ensureAssistantBubble();

    const card = document.createElement('div');
    card.className = 'msg-tool-card';
    card.dataset['toolId'] = tool.id;

    const cat = ChatPanel.toolCategory(tool.name);
    card.classList.add(`tool-cat-${cat}`);

    // ponytail: compact header — icon + name + status only, no args column
    const header = document.createElement('div');
    header.className = 'msg-tool-header';

    const icon = tool.read_only
      ? iconHtml('search', 12)
      : iconHtml('code', 12);
    const nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.innerHTML = `${icon} ${tool.name}`;

    // Show command subtitle for run_shell / bash_output
    let subCmd = '';
    if (tool.name === 'run_shell' || tool.name === 'bash_output') {
      try {
        const a = JSON.parse(tool.args || '{}');
        subCmd = (a.command || '').slice(0, 80);
        if ((a.command || '').length > 80) subCmd += '…';
      } catch { /* ignore */ }
    }

    const nameWrap = document.createElement('div');
    nameWrap.className = 'tool-name-wrap';
    nameWrap.appendChild(nameEl);
    if (subCmd) {
      const sub = document.createElement('div');
      sub.className = 'tool-name-sub';
      sub.textContent = subCmd;
      nameWrap.appendChild(sub);
    }

    const status = document.createElement('span');
    status.className = 'tool-status tool-status-running';
    status.innerHTML = iconHtml('dot', 10);

    header.append(nameWrap, status);
    header.addEventListener('click', () => this.toggleToolCard(card));

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

    this.pendingToolCards.delete(tool.id);
    this.completedToolCount++;

    const status = card.querySelector('.tool-status') as HTMLElement;
    if (status) {
      status.innerHTML = tool.err ? iconHtml('close', 12) : iconHtml('check-circle', 12);
      status.className = `tool-status ${tool.err ? 'tool-err' : 'tool-ok'}`;
      status.style.opacity = '0.6';
    }

    // Collapse header to minimal height
    card.classList.add('tool-done');
    const header = card.querySelector('.msg-tool-header') as HTMLElement;
    if (header) header.style.padding = '2px 8px';

    const resultEl = card.querySelector('.msg-tool-result') as HTMLElement;
    if (resultEl) {
      const text = tool.err || tool.output || '';
      resultEl.innerHTML = formatToolResult(tool.name, text, !!tool.truncated, tool.args);
      resultEl.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block as HTMLElement);
      });
    }

    if (tool.err) {
      card.classList.add('tool-expanded');
    }

    // ponytail: group completed tools behind a summary when we have 3+
    this.updateToolSummary();
  }

  /** Collapse completed tool cards into a compact summary line.
   *  Accumulates across rounds — existing collapsed cards stay hidden and
   *  are counted into the total. New cards are folded and added to the count. */
  private updateToolSummary(): void {
    if (!this.currentBubble) return;

    // Only fold cards that haven't been collapsed yet
    const freshCards = this.currentBubble.querySelectorAll('.msg-tool-card.tool-done:not([data-collapsed])');
    if (freshCards.length === 0) return;

    // Count already-collapsed cards from previous rounds
    const prevCollapsed = this.currentBubble.querySelectorAll('.msg-tool-card.tool-done[data-collapsed]');
    const prevCount = prevCollapsed.length;

    // Fold fresh cards
    const names: string[] = [];
    freshCards.forEach((c) => {
      const nameEl = c.querySelector('.tool-name');
      if (nameEl) names.push(nameEl.textContent?.trim() || '');
      (c as HTMLElement).style.display = 'none';
      (c as HTMLElement).dataset['collapsed'] = '1';
    });

    const total = prevCount + freshCards.length;
    if (total < 3) {
      // Un-hide everything if total is too low for a summary
      freshCards.forEach((c) => {
        (c as HTMLElement).style.display = '';
        delete (c as HTMLElement).dataset['collapsed'];
      });
      if (prevCollapsed.length > 0) {
        prevCollapsed.forEach((c) => {
          (c as HTMLElement).style.display = '';
          delete (c as HTMLElement).dataset['collapsed'];
        });
        if (this.toolSummaryEl) { this.toolSummaryEl.remove(); this.toolSummaryEl = null; }
      }
      return;
    }

    // Update or create summary
    const unique = [...new Set(names)].slice(0, 3);
    const label = unique.join(', ') + (names.length > 3 ? ` 等 ${names.length} 个` : '');

    if (this.toolSummaryEl) {
      // Update existing summary — increment count
      const countSpan = this.toolSummaryEl.querySelector('.tool-summary-count');
      if (countSpan) countSpan.textContent = String(total);
      this.toolSummaryEl.innerHTML = `${iconHtml('check-circle', 12)} 已执行 <span class="tool-summary-count">${total}</span> 个工具`;
    } else {
      // Create new summary
      this.toolSummaryEl = document.createElement('div');
      this.toolSummaryEl.className = 'msg-tool-summary';
      this.toolSummaryEl.innerHTML = `${iconHtml('check-circle', 12)} 已执行 <span class="tool-summary-count">${total}</span> 个工具`;
      this.toolSummaryEl.style.cursor = 'pointer';
      this.toolSummaryEl.title = '点击展开所有工具';

      // Insert before the first tool card (collapsed or not)
      const firstCard = this.currentBubble.querySelector('.msg-tool-card');
      if (firstCard) {
        firstCard.parentNode?.insertBefore(this.toolSummaryEl, firstCard);
      } else {
        this.currentBubble.appendChild(this.toolSummaryEl);
      }
    }

    this.toolSummaryEl.addEventListener('click', () => {
      const allCollapsed = this.currentBubble!.querySelectorAll('.msg-tool-card.tool-done[data-collapsed]');
      allCollapsed.forEach((c) => {
        (c as HTMLElement).style.display = '';
        delete (c as HTMLElement).dataset['collapsed'];
      });
      this.toolSummaryEl?.remove();
      this.toolSummaryEl = null;
    });
  }

  // ── Usage ──

  private addUsage(ev: AgentEvent): void {
    this.ensureAssistantBubble();
    const pill = document.createElement('div');
    pill.className = 'msg-usage';

        const u = ev.usage;
    const total = u ? (u.total_tokens ?? 0) : 0;
    const cached = u ? (u.cache_hit_tokens ?? 0) : 0;
    const missTokens = u ? (u.cache_miss_tokens ?? 0) : 0;
    const inputTokens = cached + missTokens;
    const hitRate = inputTokens > 0 ? (cached / inputTokens * 100) : 0;

    let label = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
    label += ' tok';
    if (cached > 0) label += ` · ${cached >= 1000 ? (cached / 1000).toFixed(1) + 'k' : cached} cache`;
    if (cached > 0) label += ` · ${hitRate.toFixed(0)}% 命中`;

    this.lastUsageText = label;
    pill.textContent = label;
    this.currentBubble!.appendChild(pill);
    // Replace (not accumulate) — each API response's total_tokens already includes
    // the full prompt+completion for that request, so it IS the current context size.
    this.totalTokensUsed = total;
    this.scrollBottom();
    this.updateFooter();
  }

  // ── Notice ──

  // ponytail: single entry point — all notices go through the message model
  // so _syncMessagesToDOM() never wipes them.
  private addNotice(text: string, level: 'info' | 'warn' | 'error'): void {
    this._addNoticeMessage(text, level);
  }

  /** Show a lightweight DOM toast in the footer (does NOT go through message model).
   *  Used for UI-only notifications (e.g. mode switch) to avoid feeding back into
   *  the render cycle via addNotice → _addNoticeMessage → _scheduleSync. */
  private _showFooterToast(text: string): void {
    const toast = document.createElement('div');
    toast.className = 'chat-footer-toast';
    toast.textContent = text;
    this.footerEl.appendChild(toast);
    // Trigger CSS transition
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
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

    // Token bar (item 12)
    let tokenBarHtml = '';
    const ctxWin = settings.agent?.contextWindow || 0;
    if (ctxWin > 0 && this.totalTokensUsed > 0) {
      const pct = Math.min((this.totalTokensUsed / ctxWin) * 100, 100);
      let cls = '';
      if (pct >= 90) cls = 'danger';
      else if (pct >= 80) cls = 'warn';
      const labelK = `${(this.totalTokensUsed / 1000).toFixed(1)}k / ${(ctxWin / 1000).toFixed(0)}k`;
      tokenBarHtml = `<div class="chat-token-bar-wrap" title="上下文窗口用量">
        <span>${labelK}</span>
        <div class="chat-token-bar"><div class="chat-token-bar-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>
      </div>`;
    }

    this.footerEl.innerHTML = DOMPurify.sanitize(`
      <div class="chat-footer-left">
        <button class="chat-model-badge chat-model-clickable" title="点击切换模型 · ${active?.name} / ${active?.model}">
          ${iconHtml('agent', 10)} ${modelLabel}${thinking}
        </button>
        <button class="chat-mode-badge" id="chat-mode-badge" title="切换模式 · 当前: ${mode.label}">
          ${iconHtml('agent', 10)} ${mode.label}
        </button>
        ${tokenBarHtml}
        <span class="chat-usage-badge">${usageStr}</span>
      </div>
      <div class="chat-footer-right">
        <button class="chat-shortcuts-btn" data-tooltip="Ctrl+L    打开/关闭面板&#10;Enter     发送 (输入框)&#10;Shift+Enter  换行&#10;Esc       关闭面板&#10;Ctrl+Y    始终允许 (权限)&#10;↑↓        历史导航 (输入框)">${iconHtml('keyboard', 13)}</button>
        <button class="chat-slash-trigger" title="命令菜单">
          ${iconHtml('code', 12)}<span class="chat-slash-label">/</span>
        </button>
        <button class="chat-session-add chat-attach-btn" title="附加文件">${iconHtml('file-plus', 13)}</button>
      </div>`);

    this._buildModePopup(mode);

    // ── Slash panel: create once, re-append after footer wipe ──
    const panel = this._setupSlashPanel();

    // Model badge click → open settings
    this.footerEl.querySelector('.chat-model-clickable')?.addEventListener('click', () => {
      this.onOpenSettings?.();
    });

    // / button → focus input + trigger inline panel
    const trigger = this.footerEl.querySelector('.chat-slash-trigger') as HTMLElement;
    trigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.inputArea.focus();
      const val = this.inputArea.value;
      const pos = this.inputArea.selectionStart || 0;
      if (!val || pos === val.length) {
        this.inputArea.value = val + '/';
        this.inputArea.setSelectionRange((val + '/').length, (val + '/').length);
      }
      this.inputArea.style.height = 'auto';
      this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
      this.inputArea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Close panel on outside click
    if (this.footerClickCleanup) {
      document.removeEventListener('click', this.footerClickCleanup as unknown as EventListener);
    }
    const handler = (e: MouseEvent) => {
      if (!panel.contains(e.target as Node) && e.target !== trigger && !this.inputArea.contains(e.target as Node)) {
        this._hideSlashPanel();
      }
    };
    document.addEventListener('click', handler);
    this.footerClickCleanup = handler as unknown as (() => void);

    // Attach file button
    this.footerEl.querySelector('.chat-attach-btn')?.addEventListener('click', () => {
      this.openFilePicker();
    });

    // Drag-and-drop files onto the chat panel
    this.panel.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    this.panel.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleFileDrop(e);
    });
  }

  // ── File attachments ──

  private async openFilePicker(): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({ multiple: true, title: '选择文件', filters: [] });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      for (const p of paths) {
        const name = p.replace(/\\/g, '/').split('/').pop() || p;
        this.addAttachedFile(p, name, 0);
      }
    } catch {
      // Fallback for browser dev mode
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.addEventListener('change', () => {
        if (!input.files) return;
        for (let i = 0; i < input.files.length; i++) {
          const f = input.files[i];
          const path = (f as any).path || f.name;
          this.addAttachedFile(path, f.name, f.size);
        }
      });
      input.click();
    }
  }

  private handleFileDrop(e: DragEvent): void {
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const path = (f as any).path || f.name;
      this.addAttachedFile(path, f.name, f.size);
    }
  }

  private addAttachedFile(path: string, name: string, size: number): void {
    // deduplicate
    if (this.attachedFiles.some(f => f.path === path)) return;
    this.attachedFiles.push({ path, name, size });
    this.renderAttachments();
  }

  private removeAttachedFile(idx: number): void {
    this.attachedFiles.splice(idx, 1);
    this.renderAttachments();
  }

  private renderAttachments(): void {
    if (!this.attachPillsEl) return;
    if (this.attachedFiles.length === 0) {
      this.attachPillsEl.style.display = 'none';
      this.attachPillsEl.innerHTML = '';
      return;
    }
    this.attachPillsEl.style.display = 'flex';
    this.attachPillsEl.innerHTML = this.attachedFiles.map((f, i) => {
      const sizeStr = f.size < 1024 ? `${f.size} B` :
        f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` :
        `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
      return `<span class="attach-pill" title="${f.path}">
        <span class="attach-pill-icon">${iconHtml('file', 10)}</span>
        <span class="attach-pill-name">${f.name}</span>
        <span class="attach-pill-size">${sizeStr}</span>
        <span class="attach-pill-remove" data-idx="${i}">×</span>
      </span>`;
    }).join('');
    // Wire remove buttons
    this.attachPillsEl.querySelectorAll('.attach-pill-remove').forEach(el => {
      const idx = parseInt((el as HTMLElement).dataset['idx'] || '');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeAttachedFile(idx);
      });
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
        // ponytail: use DOM toast instead of addNotice to avoid feeding back into
        // the message render cycle (updateFooter → _buildModePopup → addNotice →
        // _addNoticeMessage → _syncMessagesToDOM / _scheduleSync → render).
        const modeLabel = CHAT_MODES.find(m => m.id === modeId)?.label || modeId;
        this._showFooterToast(`模式已切换为 "${modeLabel}"`);
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
    this.animateBubbleIn(this.currentBubble);
    this._bumpPillBadge();
  }

  private appendUserBubble(text: string, files?: { path: string; name: string; size: number }[], skipActions?: boolean): void {
    // Push to the data model — _syncMessagesToDOM() will handle rendering
    const fileAttachments: FileAttachment[] = (files || []).map((f) => ({
      path: f.path,
      name: f.name,
      size: f.size,
    }));
    const userMsg = createUserMessage(text, fileAttachments.length > 0 ? fileAttachments : undefined);
    this.messages.push(userMsg);

    // Track in turnPairs
    const pair = this.turnPairs[this.turnPairs.length - 1];
    if (pair) pair.userBubble = null; // will be set after DOM sync

    // Sync to DOM
    this._syncMessagesToDOM();

    // Now find the rendered DOM element and link it
    const rows = this.msgList.querySelectorAll('.msg-user-row');
    const row = rows[rows.length - 1] as HTMLElement | undefined;
    if (row && pair) pair.userBubble = row;

    if (row) this.animateBubbleIn(row.querySelector('.msg-bubble.user') as HTMLElement);
  }

  private addTurnSep(): void {
    // No-op with the new message model — visual separation is handled
    // by margins/padding on .msg-bubble elements via CSS.
  }

  /** Finalize current assistant bubble — link to latest turnPair, reset streaming state.
   *  Called at TurnStarted boundaries (including mid-run inserts) and at run end. */
  private finishCurrentTurn(): void {
    this._finaliseStreamingAssistant();
    this.flushReasoning();
    this.flushText();
    this._syncMessagesToDOM();
    // ponytail: data-driven path — find last assistant bubble in DOM after sync
    if (this.turnPairs.length > 0) {
      const bubbles = this.msgList.querySelectorAll<HTMLElement>('.msg-bubble.assistant');
      const lastBubble = bubbles[bubbles.length - 1];
      if (lastBubble) this.turnPairs[this.turnPairs.length - 1].assistantBubble = lastBubble;
    }
    this.pendingToolCards.clear();
    this.resetReasoningBlock();
    this.completedToolCount = 0;
    if (this.toolSummaryEl) { this.toolSummaryEl.remove(); this.toolSummaryEl = null; }
    this.currentBubble = null;
    this.currentTextEl = null;
    this._streamTextBuf = '';
    this._streamStableLen = 0;
    this._streamStableEl = null;
    this._streamUnstableEl = null;
  }

  private finishTurn(): void {
    this.finishCurrentTurn();
    // Auto-save after every turn so sessions survive crash / force-close
    if (this.projectPath) {
      this.saveActiveSession(this.projectPath).catch(() => {});
    }
  }

  private scrollBottom(): void {
    // Only suppress auto-scroll during active text streaming, not during
    // tool execution or between turns.  Otherwise one manual scroll-up
    // during a long tool call freezes the view for the rest of the turn.
    if (this._userScrolledUp && this._streamingAssistantId) return;
    requestAnimationFrame(() => {
      if (this._userScrolledUp && this._streamingAssistantId) return;
      this.msgList.scrollTop = this.msgList.scrollHeight;
    });
  }

  // ── Node name linking ──

  private linkifyNodeNames(): void {
    if (!this.starGraph) return;
    // Find the last assistant bubble in the DOM
    const bubbles = this.msgList.querySelectorAll<HTMLElement>('.msg-bubble.assistant');
    const target = bubbles[bubbles.length - 1];
    if (!target) return;
    const texts = target.querySelectorAll('.msg-text');
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

  // ── Error card (item 8) ──

  private addErrorNotice(text: string, detail: string, actions: Array<{ label: string; onClick: () => void }>): void {
    const el = document.createElement('div');
    el.className = 'msg-error-card';
    const title = document.createElement('div');
    title.className = 'msg-error-card-title';
    title.innerHTML = `${iconHtml('alert', 13)} ${escapeHtml(text)}`;
    el.appendChild(title);

    if (detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'msg-error-card-detail';
      detailEl.textContent = detail;
      // Expand toggle
      const expandBtn = document.createElement('button');
      expandBtn.className = 'msg-error-card-btn';
      expandBtn.textContent = '展开详情';
      expandBtn.addEventListener('click', () => {
        detailEl.classList.toggle('expanded');
        expandBtn.textContent = detailEl.classList.contains('expanded') ? '收起' : '展开详情';
      });
      el.appendChild(detailEl);
      el.appendChild(expandBtn);
    }

    const actionsRow = document.createElement('div');
    actionsRow.className = 'msg-error-card-actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'msg-error-card-btn';
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      actionsRow.appendChild(btn);
    }
    el.appendChild(actionsRow);
    this.msgList.appendChild(el);
    this.scrollBottom();
  }

  // ── @ file reference autocomplete (item 5) ──

  private async handleAtInput(): Promise<void> {
    const val = this.inputArea.value;
    const cursorPos = this.inputArea.selectionStart || 0;
    // Find last @ that starts a token (preceded by space or line start, only ASCII @)
    const textBefore = val.slice(0, cursorPos);
    const atIdx = (() => {
      for (let i = textBefore.length - 1; i >= 0; i--) {
        if (textBefore[i] === '@' && (i === 0 || textBefore[i - 1] === ' ' || textBefore[i - 1] === '\n')) {
          // Ensure it's ASCII @ (not Chinese full-width)
          return i;
        }
      }
      return -1;
    })();

    if (atIdx < 0) {
      if (this.atPopup) this.atPopup.classList.remove('open');
      return;
    }

    const query = textBefore.slice(atIdx + 1).toLowerCase();
    await this.buildAtPopup(query);
    this.atIdx = 0;
    this.updateAtSelection();
  }

  private async buildAtPopup(query: string): Promise<void> {
    if (!this.atPopup) {
      this.atPopup = document.createElement('div');
      this.atPopup.className = 'chat-at-popup';
      this.panel.querySelector('.chat-input-area')?.appendChild(this.atPopup);
    }

    // Cache glob results for 30s
    const CACHE_TTL = 30000;
    if (!this.atFileCache || Date.now() - this.atFileCache.ts > CACHE_TTL) {
      try {
        const data = await invoke<string>('glob', {
          pattern: '**/*.{ts,js,py,rs,html,css,vue,svelte,json,toml,yaml,yml,md}',
          path: this.projectPath || '.',
        });
        this.atFileCache = { data, ts: Date.now() };
      } catch {
        // glob failed — use empty list
        this.atFileCache = { data: '[]', ts: Date.now() };
      }
    }

    // Parse cached results
    let files: string[] = [];
    try {
      const parsed = JSON.parse(this.atFileCache.data);
      files = (parsed.results || []).map((r: any) => r.path).slice(0, 100);
    } catch {}

    // Also get node names from starGraph
    const nodeNames = this.starGraph?.getNodeNames?.() || [];

    // Build combined results
    const allItems: Array<{ kind: string; name: string }> = [];
    for (const f of files) {
      const base = f.replace(/\\/g, '/').split('/').pop() || f;
      allItems.push({ kind: '文件', name: f });
    }
    for (const n of nodeNames) {
      allItems.push({ kind: '节点', name: n });
    }

    // Filter by query (substring match)
    const filtered = query
      ? allItems.filter(item => item.name.toLowerCase().includes(query))
      : allItems;

    const top = filtered.slice(0, 10);
    this.atPopup.innerHTML = top.length > 0
      ? top.map((item, i) => `<div class="at-item${i === 0 ? ' active' : ''}">
          <span class="at-kind">${escapeHtml(item.kind)}</span>
          <span>${escapeHtml(item.name)}</span>
        </div>`).join('')
      : '<div class="at-item" style="opacity:0.4">无匹配结果</div>';

    this.atPopup.classList.toggle('open', top.length > 0);
  }

  private updateAtSelection(): void {
    if (!this.atPopup) return;
    const items = this.atPopup.querySelectorAll('.at-item');
    items.forEach((item, i) => {
      item.classList.toggle('active', i === this.atIdx);
    });
  }

  private confirmAtSelection(): void {
    if (!this.atPopup || !this.atPopup.classList.contains('open')) return;
    const items = this.atPopup.querySelectorAll('.at-item');
    const selected = items[this.atIdx];
    if (!selected) return;

    const kindEl = selected.querySelector('.at-kind');
    const kind = kindEl?.textContent || '';
    const nameEl = selected.querySelector('span:last-child');
    const name = nameEl?.textContent || '';

    // Find the @ position before cursor
    const val = this.inputArea.value;
    const cursorPos = this.inputArea.selectionStart || 0;
    const textBefore = val.slice(0, cursorPos);
    let atIdx = -1;
    for (let i = textBefore.length - 1; i >= 0; i--) {
      if (textBefore[i] === '@' && (i === 0 || textBefore[i - 1] === ' ' || textBefore[i - 1] === '\n')) {
        atIdx = i;
        break;
      }
    }
    if (atIdx < 0) return;

    const token = kind === '节点' ? `\`${name}\`` : `[@${name.split('/').pop()?.replace(/\.\w+$/, '') || name}](${name})`;
    this.inputArea.value = val.slice(0, atIdx) + token + val.slice(cursorPos);
    this.atPopup.classList.remove('open');
    this.inputArea.focus();
  }

  // ── Slash inline panel (item 14, registry-driven) ──

  /** Create slash panel once, wire events once, re-append after each footer wipe.
   *  Called from updateFooter which does footerEl.innerHTML = ... every time. */
  private _setupSlashPanel(): HTMLElement {
    if (!this._slashPanel) {
      const panel = document.createElement('div');
      panel.className = 'chat-slash-panel';
      this._slashPanel = panel;

      // One-time setup
      CommandRegistry.instance.registerAll(DEFAULT_COMMANDS);
      this._wireCommandHandlers();

      // Panel click → execute command
      panel.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const item = (e.target as HTMLElement).closest('.sp-item') as HTMLElement;
        if (!item) return;
        const cmdId = item.dataset['cmdId'] || '';
        const cmd = this._slashVisibleCmds.find(c => c.id === cmdId);
        if (cmd) this._executeCommand(cmd);
      });
    }
    // Re-append after footerEl.innerHTML wipe
    this.footerEl.appendChild(this._slashPanel);
    return this._slashPanel;
  }

  /** Wire local handlers for commands that need `this` context (new/compact/trail/export). */
  private _wireCommandHandlers(): void {
    const reg = CommandRegistry.instance;
    // Update local-action commands that need ChatPanel instance
    const override = (id: string, handler: () => void) => {
      const idx = DEFAULT_COMMANDS.findIndex(c => c.id === id);
      if (idx >= 0 && DEFAULT_COMMANDS[idx].action.type === 'local') {
        (DEFAULT_COMMANDS[idx].action as any).handler = handler;
      }
    };
    override('new', () => { this.inputArea.value = ''; this.inputArea.style.height = 'auto'; this.newSession(); });
    override('compact', () => {
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      if (!this.agent) return;
      this.addTurnSep();
      this.appendUserBubble('/compact');
      this.scrollBottom();
      this.addNotice('正在压缩上下文…', 'info');
      const ctrl = new AbortController();
      this.agent.compactNow(ctrl.signal).then(() => {
        this.messages = [];
        resetMsgIdCounter();
        this._streamingAssistantId = null;
        this.msgList.innerHTML = '';
        this.renderRestoredSession();
      }).catch((err) => {
        this.addNotice(`压缩失败: ${err.message}`, 'error');
      });
    });
    override('export', () => this.exportSession());
    override('trail', () => {
      this._onTrailToggle?.();
      this.addNotice(this._onTrailToggle ? '已切换探索轨迹显示' : '轨迹功能未就绪', 'info');
    });
  }

  /** Execute a command from the registry. */
  private _executeCommand(cmd: CommandDef): void {
    this._hideSlashPanel();
    const action = cmd.action;
    switch (action.type) {
      case 'send':
        this.sendAgentText(action.text, action.displayLabel);
        break;
      case 'fill':
        this.inputArea.value = action.text;
        this.inputArea.style.height = 'auto';
        this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
        this.inputArea.focus();
        this.inputArea.setSelectionRange(action.text.length, action.text.length);
        break;
      case 'local':
        action.handler();
        break;
      case 'skill':
        this.sendAgentText(`Execute skill: ${action.skillName}`, `/${action.skillName}`);
        break;
    }
  }

  /** Show the slash panel with optional query filter. */
  private _showSlashPanel(query?: string): void {
    if (!this._slashPanel) return;
    const cmds = query ? CommandRegistry.instance.filter(query) : CommandRegistry.instance.getAll();
    this._slashVisibleCmds = cmds;
    this._slashNavIdx = 0;
    this._slashPanel.innerHTML = CommandRegistry.instance.renderPanel(cmds, query);
    this._slashPanel.classList.add('open');
    // Highlight first item
    this._highlightSlashItem(0);
  }

  /** Hide the slash panel. */
  private _hideSlashPanel(): void {
    if (!this._slashPanel) return;
    this._slashPanel.classList.remove('open');
    this._slashVisibleCmds = [];
    this._slashNavIdx = 0;
  }

  /** Highlight the nth visible item in the slash panel. */
  private _highlightSlashItem(idx: number): void {
    if (!this._slashPanel) return;
    const items = this._slashPanel.querySelectorAll('.sp-item');
    items.forEach((el, i) => {
      el.classList.toggle('sp-active', i === idx);
      if (i === idx) (el as HTMLElement).scrollIntoView?.({ block: 'nearest' });
    });
    this._slashNavIdx = idx;
  }

  /** Execute the currently highlighted slash command. */
  private _selectSlashItem(): void {
    if (!this._slashPanel?.classList.contains('open')) return;
    const cmd = this._slashVisibleCmds[this._slashNavIdx];
    if (cmd) this._executeCommand(cmd);
  }

  /** Navigate slash panel items with arrow keys. Returns true if handled. */
  private _navigateSlashPanel(delta: number): boolean {
    if (!this._slashPanel?.classList.contains('open')) return false;
    const max = this._slashVisibleCmds.length;
    if (max === 0) return false;
    const next = (this._slashNavIdx + delta + max) % max;
    this._highlightSlashItem(next);
    return true;
  }

  private handleSlashInput(): void {
    const val = this.inputArea.value;
    const cursorPos = this.inputArea.selectionStart || 0;
    const textBefore = val.slice(0, cursorPos);

    // Show on / at line start or after space
    const showPanel = /(?:^|\s)\/$/.test(textBefore);

    if (showPanel) {
      const slashIdx = textBefore.lastIndexOf('/');
      const query = textBefore.slice(slashIdx + 1);
      this._showSlashPanel(query);
    } else if (!textBefore.includes('/')) {
      this._hideSlashPanel();
    }
    // If user continues typing after / (e.g. "/mem"), still filter
    else {
      const slashIdx = textBefore.lastIndexOf('/');
      const query = textBefore.slice(slashIdx + 1);
      if (query.length > 0) {
        this._showSlashPanel(query);
      }
    }
  }

  // ── Pill badge — agent event counter when collapsed ──

  /** Bump the pill badge count. Call from event handlers when pill-mode streaming. */
  private _bumpPillBadge(): void {
    if (this.mode !== 'pill') return;
    this.pillEventCount++;
    this.pillBadge.textContent = String(this.pillEventCount > 99 ? '99+' : this.pillEventCount);
    this.pillBadge.classList.add('show');
  }

  private _resetPillBadge(): void {
    this.pillEventCount = 0;
    this.pillBadge.textContent = '';
    this.pillBadge.classList.remove('show');
  }

  // ── Sub-agent event handlers (item 10) ──

  private handleSubSpawn(data: { id: string; description: string; prompt: string; mode: string }): void {
    // Find the pending agent_spawn tool card and add sub-agent wrapper
    this.flushReasoning();
    this.flushText();
    this.ensureAssistantBubble();
    this._bumpPillBadge();

    const subEl = document.createElement('div');
    subEl.className = 'msg-sub-agent';
    subEl.dataset['subId'] = data.id;
    subEl.innerHTML = `
      <div class="msg-sub-agent-header">
        ${iconHtml('puzzle', 12)} 子 Agent: ${escapeHtml(data.description)}
        <span style="font-size: calc(8px * var(--font-scale));opacity:0.5">${data.mode === 'fork' ? '继承上下文' : '独立'}</span>
      </div>
      <div class="msg-sub-agent-body open"></div>`;
    this.currentBubble!.appendChild(subEl);
    this.scrollBottom();
  }

  private handleSubProgress(data: { parentToolId: string; text: string }): void {
    const subEl = this.currentBubble?.querySelector(`[data-sub-id="${data.parentToolId}"]`) as HTMLElement;
    if (!subEl) return;
    const body = subEl.querySelector('.msg-sub-agent-body');
    if (body) {
      body.textContent += data.text;
      body.scrollTop = body.scrollHeight;
    }
  }

  private handleSubDone(data: { parentToolId: string; summary: any }): void {
    const subEl = this.currentBubble?.querySelector(`[data-sub-id="${data.parentToolId}"]`) as HTMLElement;
    if (!subEl) return;
    const body = subEl.querySelector('.msg-sub-agent-body') as HTMLElement;
    const header = subEl.querySelector('.msg-sub-agent-header') as HTMLElement;
    if (body) body.classList.remove('open');
    this._bumpPillBadge();

    // Collapse and show summary
    subEl.innerHTML = `
      <div class="msg-sub-agent-summary">
        ${iconHtml('puzzle', 12)} 子 Agent 完成 · ${data.summary?.steps || '?'} 步 · ${data.summary?.elapsedMs ? (data.summary.elapsedMs / 1000).toFixed(1) + 's' : ''}
        ${data.summary?.hasError ? ` · ${iconHtml('alert', 10)} 有错误` : ''}
        · <button class="pre-code-btn" style="display:inline">查看输出</button>
      </div>`;

    // Toggle body visibility
    const toggleBtn = subEl.querySelector('button');
    const origBody = body;
    toggleBtn?.addEventListener('click', () => {
      if (subEl.contains(origBody)) {
        origBody.remove();
      } else {
        subEl.appendChild(origBody);
        origBody.classList.add('open');
      }
    });
  }

  // ── Code block action buttons (item 6) ──

  /** Inject copy + view-file buttons into code blocks. Called from flushText/renderMarkdownText. */
  private injectCodeBlockButtons(bubble: HTMLElement): void {
    bubble.querySelectorAll('.msg-markdown pre').forEach((pre) => {
      // Already injected
      if (pre.querySelector('.pre-code-actions')) return;

      const codeEl = pre.querySelector('code');
      if (!codeEl) return;

      const actions = document.createElement('div');
      actions.className = 'pre-code-actions';

      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'pre-code-btn';
      copyBtn.innerHTML = iconHtml('copy', 10);
      copyBtn.title = '复制代码';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = codeEl.textContent || '';
        navigator.clipboard.writeText(code).then(() => showCopiedFeedback(copyBtn, 10)).catch(() => {});
      });
      actions.appendChild(copyBtn);

      // View file button — only if first line looks like a file path
      const firstLine = codeEl.textContent?.split('\n')[0]?.trim() || '';
      const isFilePath = /^[\w./\\-]+\.[\w]+(?::\d+)?$/.test(firstLine) && firstLine.includes('/');
      if (isFilePath) {
        const viewBtn = document.createElement('button');
        viewBtn.className = 'pre-code-btn';
        viewBtn.innerHTML = iconHtml('folder-open', 10);
        viewBtn.title = `打开: ${firstLine}`;
        viewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          shell.navigateToFile(firstLine);
        });
        actions.appendChild(viewBtn);
      }

      pre.appendChild(actions);
    });
  }

  // ── Conversation export (item 13) ──

  private async exportSession(): Promise<void> {
    const agent = this.agent;
    if (!agent) { this.addNotice('没有可导出的会话', 'info'); return; }

    const msgs = agent.getSession();
    const settings = loadSettings();
    const active = settings.providers.find(p => p.name === settings.activeProvider) || settings.providers[0];
    const mode = CHAT_MODES.find(m => m.id === (settings.agent?.chatMode || 'general')) || CHAT_MODES[0];
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    let md = `# HoloGram 会话 — ${dateStr}\n`;
    md += `> 模型: ${active?.model || 'unknown'} · 模式: ${mode.label} · 总 token: ${this.totalTokensUsed.toLocaleString()}\n\n`;

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
        this.addNotice(`会话已导出: ${filePath}`, 'info');
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
      this.addNotice('会话已下载', 'info');
    }
  }

  // ── Sink getter (used by main.ts to wire Agent) ──

  get sink() {
    return (ev: AgentEvent) => this.renderEvent(ev);
  }
}

// ── Static helpers ──

/** Format tool output for display — JSON gets pretty-printed, code gets highlighted. */
function formatToolResult(toolName: string, text: string, truncated: boolean, args?: string): string {
  let body = text;
  if (truncated) body += '\n…[截断]…';

  // ── trace_dataflow — inline flow card ──
  if (toolName === 'trace_dataflow') {
    const card = formatDataflowCard(text);
    if (card) return card;
  }

  // ── JSON: pretty-print in code block ──
  try {
    const parsed = JSON.parse(body);
    const formatted = JSON.stringify(parsed, null, 2);
    return `<pre><code class="language-json">${escapeHtml(formatted)}</code></pre>`;
  } catch {}

  // ── Empty / very short ──
  if (!body.trim()) return escapeHtml('(无输出)');
  if (body.length < 60 && !body.includes('\n')) return escapeHtml(body);

  // ── Diff view for edit_file / write_file / read_file_content (item 7) ──
  if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'write_file_content' || toolName === 'read_file_content') {
    return formatDiffResult(body, args);
  }

  // ── Code: run_shell, search_content → code block ──
  if (toolName === 'run_shell') {
    return `<pre><code class="language-bash">${escapeHtml(body)}</code></pre>`;
  }
  if (toolName === 'search_content') {
    return `<pre><code>${escapeHtml(body)}</code></pre>`;
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

// ── Dataflow inline card renderer ──

interface DfScope {
  name: string;
  reads: string[];
  writes: string[];
  triggers: string[];
  awaits_callbacks: string[];
  sequence_calls: string[];
}

interface DfShared {
  var: string;
  readers: string[];
  writers: string[];
}

interface DfFileResult {
  file: string;
  error?: string;
  scopes?: DfScope[];
  shared?: DfShared[];
}

export function formatDataflowCard(text: string): string | null {
  let data: { results: DfFileResult[] };
  try { data = JSON.parse(text); } catch { return null; }
  if (!data?.results?.length) return null;

  const ico = (n: string, s?: number) => iconHtml(n, s ?? 13);
  let html = '<div class="df-card">';
  for (const fr of data.results) {
    html += '<div class="df-file">';
    html += `<div class="df-file-hdr">${ico('file')} ${escapeHtml(fr.file)}</div>`;

    if (fr.error) {
      html += `<div class="df-empty">${ico('alert-circle')} ${escapeHtml(fr.error)}</div>`;
      html += '</div>';
      continue;
    }

    const scopes = fr.scopes || [];
    for (const s of scopes) {
      html += '<div class="df-scope">';
      html += `<div class="df-scope-name">${ico('code', 14)} ${escapeHtml(s.name)}</div>`;

      // Two-column layout: reads (in) | writes (out)
      const hasReads = s.reads && s.reads.length > 0;
      const hasWrites = s.writes && s.writes.length > 0;
      if (hasReads || hasWrites) {
        html += '<div class="df-rw-row">';
        html += '<div class="df-rw-col df-rw-in">';
        html += `<span class="df-label">${ico('arrow-down', 11)} 读取</span>`;
        if (hasReads) {
          for (const v of s.reads) {
            html += `<span class="df-tag df-tag-read">${escapeHtml(v)}</span>`;
          }
        } else { html += '<span class="df-tag-none">—</span>'; }
        html += '</div>';
        html += '<div class="df-rw-col df-rw-out">';
        html += `<span class="df-label">${ico('arrow-up', 11)} 写入</span>`;
        if (hasWrites) {
          for (const v of s.writes) {
            html += `<span class="df-tag df-tag-write">${escapeHtml(v)}</span>`;
          }
        } else { html += '<span class="df-tag-none">—</span>'; }
        html += '</div>';
        html += '</div>';
      }

      // Call chain
      if (s.sequence_calls && s.sequence_calls.length > 0) {
        html += '<div class="df-flow">';
        html += `<span class="df-label">${ico('arrow-right', 11)} 调用链</span>`;
        for (let i = 0; i < s.sequence_calls.length; i++) {
          if (i > 0) html += '<span class="df-flow-arrow">→</span>';
          html += `<span class="df-flow-item">${escapeHtml(s.sequence_calls[i])}</span>`;
        }
        html += '</div>';
      }

      // Triggers & awaits
      const hasTriggers = s.triggers && s.triggers.length > 0;
      const hasAwaits = s.awaits_callbacks && s.awaits_callbacks.length > 0;
      if (hasTriggers || hasAwaits) {
        html += '<div class="df-async-row">';
        html += '<div class="df-async-col">';
        html += `<span class="df-label">${ico('zap', 11)} 触发</span>`;
        if (hasTriggers) {
          for (const t of s.triggers) {
            html += `<span class="df-tag df-tag-trigger">${escapeHtml(t)}</span>`;
          }
        } else { html += '<span class="df-tag-none">—</span>'; }
        html += '</div>';
        html += '<div class="df-async-col">';
        html += `<span class="df-label">${ico('hourglass', 11)} 等待</span>`;
        if (hasAwaits) {
          for (const cb of s.awaits_callbacks) {
            html += `<span class="df-tag df-tag-await">${escapeHtml(cb)}</span>`;
          }
        } else { html += '<span class="df-tag-none">—</span>'; }
        html += '</div>';
        html += '</div>';
      }

      html += '</div>'; // .df-scope
    }

    // Shared state — mini table
    const shared = fr.shared || [];
    if (shared.length > 0) {
      html += '<div class="df-shared">';
      html += `<div class="df-shared-title">${ico('layers')} 跨函数共享状态</div>`;
      html += '<div class="df-shared-table">';
      html += '<div class="df-shared-th"><span>变量</span><span>读取方</span><span>写入方</span></div>';
      for (const sh of shared) {
        html += '<div class="df-shared-tr">';
        html += `<span class="df-shared-var">${escapeHtml(sh.var)}</span>`;
        html += `<span>${(sh.readers || []).map(escapeHtml).join(', ') || '—'}</span>`;
        html += `<span>${(sh.writers || []).map(escapeHtml).join(', ') || '—'}</span>`;
        html += '</div>';
      }
      html += '</div></div>';
    }

    if (!scopes.length && !shared.length) {
      html += '<div class="df-empty">未检测到数据流（无函数作用域或跨函数共享变量）</div>';
    }

    html += '</div>'; // .df-file
  }
  html += '</div>';
  return html;
}

function truncateArgs(args: string, max = 60): string {
  if (args.length <= max) return args;
  return args.slice(0, max) + '…';
}

/** Simple line-based diff for edit_file results (item 7). */
function formatDiffResult(body: string, argsJson?: string): string {
  // Extract file path from args if available
  let filePath = '';
  if (argsJson) {
    try {
      const args = JSON.parse(argsJson);
      filePath = args['file_path'] || args['path'] || '';
    } catch {}
  }

  // Try to extract old/new from args for real diff
  let oldStr = '';
  let newStr = '';
  if (argsJson) {
    try {
      const args = JSON.parse(argsJson);
      // Agent sends camelCase (tool.ts), but also handle snake_case from any legacy paths
      oldStr = args['oldString'] || args['old_string'] || args['old_text'] || args['oldText'] || '';
      newStr = args['newString'] || args['new_string'] || args['new_text'] || args['newText'] || args['content'] || '';
    } catch {}
  }

  let headerHtml = filePath ? `<div class="diff-header">📄 ${escapeHtml(filePath)}</div>` : '';
  const MAX_LINES = 40;

  if (oldStr && newStr) {
    // Real diff: compare old vs new
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const diffLines = computeSimpleDiff(oldLines, newLines);
    const totalLines = diffLines.length;
    const collapsed = totalLines > MAX_LINES;

    let html = headerHtml;
    const linesToShow = collapsed ? diffLines.slice(0, MAX_LINES) : diffLines;
    const visibleLines = collapsed
      ? linesToShow.map(d => `<div class="diff-line ${d.kind}">${d.prefix}${escapeHtml(d.text)}</div>`).join('')
      : diffLines.map(d => `<div class="diff-line ${d.kind}">${d.prefix}${escapeHtml(d.text)}</div>`).join('');

    html += `<div class="diff-lines${collapsed ? ' diff-folded' : ''}">${visibleLines}</div>`;
    if (collapsed) {
      html += `<button class="diff-collapsed" onclick="this.previousElementSibling.classList.remove('diff-folded');this.previousElementSibling.querySelectorAll('.diff-line').forEach(d=>d.style.display='');this.remove();">展开全部 (${totalLines} 行)</button>`;
    }
    return html;
  }

  // Fallback: show full body with + / - line detection
  const lines = body.split('\n');
  if (lines.length > MAX_LINES) {
    const visible = lines.slice(0, MAX_LINES).map(l => {
      if (l.startsWith('+')) return `<div class="diff-line diff-added">${escapeHtml(l)}</div>`;
      if (l.startsWith('-')) return `<div class="diff-line diff-removed">${escapeHtml(l)}</div>`;
      return `<div class="diff-line">${escapeHtml(l)}</div>`;
    }).join('');
    return headerHtml + visible + `<button class="diff-collapsed" onclick="this.previousElementSibling.querySelectorAll('.diff-line').forEach(d=>d.style.display='');const next=this.nextElementSibling;if(next)next.style.display='';this.remove();">展开全部 (${lines.length} 行)</button>`;
  }
  return headerHtml + `<pre><code>${escapeHtml(body)}</code></pre>`;
}

/** Compute simple line-by-line diff — marks added/removed lines. ponytail: O(n*m), fine for <100 lines. */
function computeSimpleDiff(oldLines: string[], newLines: string[]): Array<{ kind: string; prefix: string; text: string }> {
  // LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrack
  const result: Array<{ kind: string; prefix: string; text: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ kind: '', prefix: ' ', text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ kind: 'diff-added', prefix: '+', text: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ kind: 'diff-removed', prefix: '-', text: oldLines[i - 1] });
      i--;
    }
  }
  return result;
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