// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Panel — 聊天面板 UI
// 纯 DOM 渲染，EventSink → 消息气泡 / 工具卡片 / 思考折叠
// Agent 引擎 (agent.ts) 已完整，此文件只管"把事件画到屏幕上"

import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { StarGraph } from './graph';
import { iconHtml } from './icons';
import { bus } from './events';

import { createExecState, type ExecStateInstance } from '../agent/execution-state';
import { loadSettings, saveSettings, CHAT_MODES } from '../settings';
import { rpc } from '../bridge';
import type { ToolSchema } from '../provider/types';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import gsap from 'gsap';

// ── Extracted animations (GSAP-powered panel mode morphing) ──
import * as Anim from './chat-anim';
// ── Extracted session management (CRUD, persistence, restore) ──
import * as Session from './chat-session';
import { stripLineNumbers } from './chat-session';
// ── Extracted DOM construction and event wiring ──
import * as Dom from './chat-dom';
// ── Extracted stream rendering (Agent events → DOM messages) ──
import * as Stream from './chat-stream';
// ── Extracted static utility functions ──
import { escapeHtml } from './chat-utils';

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
} from './message-model';
import { CommandRegistry, DEFAULT_COMMANDS, type CommandDef } from './command-registry';
import { SlashPanelController } from './react/SlashPanel';
import { ChatMessagesPanel } from './react/ChatMessages';
import { PromptShelfController, type AskPrompt, type PermissionPrompt } from './react/PromptShelf';
import {
  getChatStore,
  getChatMessages, setChatMessages, bumpChat,
  getStreamingAssistantId, getUserScrolledUp, getExpandedReasoningSet,
} from './chat-store';

// ── Constants ──

// Panel ID now dynamic — see ChatPanel.panelId

// ── ChatPanel ──

export class ChatPanel {
  /** Unique panel instance ID. Auto-generated for DOM scoping + store isolation. */
  readonly panelId: string;

  /** Per-panel event bus — prefixed to prevent cross-panel event leaks. */
  private _bus: typeof bus;

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

  // Session state (managed by chat-session.ts)
  // Access via Session.getSessions(), Session.getActiveIdx(), etc.

  // ⚡ userFocusFile / userFocusNode → chat-store.ts

  // Execution state — per-panel instance (phase 1 of multi-window)
  private _exec: ExecStateInstance;

  // Streaming state
  private starGraph: StarGraph | null = null;

  // ── New: data-driven message model (replaces currentBubble + manual DOM) ──
  // ⚡ Zustand store-backed — getter/setter routes through chat-store.ts
  private get messages(): ChatMessage[] { return getChatMessages(); }
  private set messages(msgs: ChatMessage[]) { setChatMessages(msgs); }
  // ⚡ streamingAssistantId / userScrolledUp → chat-store.ts
  /** rAF handle for batching streaming DOM updates (avoid destroying click targets mid-interaction). */
  private _syncRafId: number | null = null;
  // File attachments (dragged/selected files)
  private attachedFiles: { path: string; name: string; size: number }[] = [];
  private attachPillsEl: HTMLElement | null = null;

  // ⚡ panelMode → chat-store.ts
  private graphClickCleanup: (() => void) | null = null;

  // ⚡ lastUsageText / projectPath / lastAgentDiag → chat-store.ts
  private onOpenSettings: (() => void) | null = null;
  private _onModeChange: (() => void) | null = null;
  private _onTrailToggle: (() => void) | null = null;
  private footerClickCleanup: (() => void) | null = null;
  // ⚡ lastAgentDiag → chat-store.ts

  // ── New: input history navigation (item 1) ──
  private inputHistory: string[] = [];
  private historyIdx = 0;
  private draftText = '';

  // ── New: progress bar (item 3) ──
  private progressBar: HTMLElement | null = null;

  // ── New: @ autocomplete (item 5) ──
  private atPopup: HTMLElement | null = null;
  private atFileCache: { data: string; ts: number } | null = null;
  private atIdx = 0;

  // ⚡ totalTokensUsed → chat-store.ts

  // ⚡ pillEventCount / lastAgentState → chat-store.ts
  private pillBadge!: HTMLElement;

  // ── Slash panel (React-based) ──
  private _slashController: SlashPanelController | null = null;

  // ── Messages (React-based) ──
  private _chatMessages: ChatMessagesPanel | null = null;

  // ── Prompt shelf (React-based) — ask_user + permission cards ──
  private _promptShelf: PromptShelfController | null = null;




  // ── New: agent panel tabs + status bar ──
  // ⚡ activeTab → chat-store.ts
  private tabBar!: HTMLElement;
  private tabContent!: HTMLElement;
  private chatPanel!: HTMLElement;
  private toolsPanel!: HTMLElement;
  private contextPanel!: HTMLElement;
  private statusBar!: HTMLElement;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private statusTokens!: HTMLElement;
  // ⚡ toolUsage / toolHistory / toolSchemas → chat-store.ts

  setToolSchemas(schemas: ToolSchema[]): void { getChatStore(this.panelId).getState().setToolSchemas(schemas); }

  private hintText(): string {
    const base = '请先配置 API Key（点击工具栏 设置 或在对话中设置）';
    return getChatStore(this.panelId).getState().lastAgentDiag ? `${base}\n\n诊断: ${getChatStore(this.panelId).getState().lastAgentDiag}` : base;
  }

  private refreshHint(): void {
    const hint = this.panel.querySelector('.chat-hint') as HTMLElement | null;
    if (hint && !this.agent) {
      hint.textContent = this.hintText();
    }
  }

  setOnOpenSettings(fn: () => void): void { this.onOpenSettings = fn; }
  setOnModeChange(fn: () => void): void { this._onModeChange = fn; }
  setOnTrailToggle(fn: () => void): void { this._onTrailToggle = fn; }
  setAgentFactory(fn: () => Promise<ChatAgentHandle | null>): void { Session.setAgentFactory(fn); }

  constructor(container: HTMLElement) {
    this.container = container;
    this.panelId = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this._bus = bus.withPrefix(`p:${this.panelId}:`);
    this._exec = createExecState();
    this.buildDOM();

    // ⚡ React-based message list — own container, shared messages array
    const reactRoot = document.createElement('div');
    reactRoot.className = 'chat-messages';
    this.msgList.style.display = 'none';
    this.msgList.parentElement?.insertBefore(reactRoot, this.msgList);
    this._chatMessages = new ChatMessagesPanel(reactRoot);
    this._chatMessages.setCallbacks({
      onCopyText: (text) => navigator.clipboard.writeText(text).catch(() => {}),
      onNavigateToNode: (nodeName) => {
        if (this.starGraph) this.starGraph.focusNode(nodeName);
      },
      onEditUserMessage: (msg) => {
        if (this._activeExec().isRunning) { this.addNotice('Agent 正在运行，请先停止再编辑', 'warn'); return; }
        this.inputArea.value = msg.text;
        this.inputArea.style.height = 'auto';
        this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
        this.inputArea.focus();
        this.inputArea.selectionStart = this.inputArea.selectionEnd = msg.text.length;
        this._retractUserMessage(msg);
      },
      onResendUserMessage: (msg) => {
        if (this._activeExec().isRunning) { this.addNotice('Agent 正在运行，请先停止再重发', 'warn'); return; }
        this.inputArea.value = msg.text;
        this._retractUserMessage(msg);
        this.sendMessage();
      },
      onRetryAssistant: (assistant) => {
        if (this._activeExec().isRunning) { this.addNotice('Agent 正在运行，请先停止再重试', 'warn'); return; }
        const userMsg = this.messages.find(m => m.role === 'user' && m._id === assistant.respondingTo);
        const userText = (userMsg && 'text' in userMsg) ? (userMsg as any).text as string : '';
        if (!userText) return;
        this.inputArea.value = '';
        const signal = this._activeExec().start();
        Stream.addTurnSep(this._streamCtx());
        const agent = this.agent;
        if (!agent) return;
        const sessIdx = agent.getSession().length;
        Session.getTurnPairs().push({ userText, userBubble: null, assistantBubble: null, sessionIndex: sessIdx });
        agent.run(signal, userText)
          .catch((err: any) => {
            if (!err.message?.includes('aborted')) {
              this.addNotice(`重试失败: ${err.message || String(err)}`, 'error');
            }
          })
          .finally(() => {
            this._activeExec().done();
            this.finishTurn();
          });
      },
    });
    // ── Prompt shelf: unified ask_user + permission cards (above input) ──
    this._promptShelf = new PromptShelfController(this.panel);
    // ── ask_user tool → prompt shelf ──
    bus.on('prompt:ask', (data: {
      id: string; question: string; header: string;
      options: { label: string; description: string }[]; multiSelect: boolean;
      callback: (answer: string[] | null) => void;
    }) => {
      if (!this._promptShelf) { data.callback(null); return; }
      this._promptShelf.showAsk({
        type: 'ask', id: data.id,
        question: data.question, header: data.header,
        options: data.options, multiSelect: data.multiSelect,
      }).then(data.callback);
    });
    // ── Track user focus — file viewer / file tree / graph selection ──
    bus.on('highlight:file', (filePath: string) => { getChatStore(this.panelId).getState().userFocusFile = filePath; getChatStore(this.panelId).getState().userFocusNode = null; });
    bus.on('navigate:file', (filePath: string) => { getChatStore(this.panelId).getState().userFocusFile = filePath; getChatStore(this.panelId).getState().userFocusNode = null; });
    bus.on('graph:node-clicked', (data: { nodeName: string; nodeType: string; nodeId: string; degree: number; location: string }) => {
      getChatStore(this.panelId).getState().userFocusNode = { name: data.nodeName, location: data.location || undefined };
      getChatStore(this.panelId).getState().userFocusFile = null;
    });
    // ── Listen for Agent diagnostics so we can show WHY agent isn't ready ──
    bus.on('agent:diag', (d: { text: string; ready: boolean }) => {
      getChatStore(this.panelId).getState().lastAgentDiag = d.text;
      if (!d.ready && this.isOpen()) {
        this.refreshHint();
      }
    });
    // ⚡ ExecutionState → UI sync: full state → DOM binding
    this._exec.onChange(() => {
      this._updateStopButton();
      if (this._activeExec().isRunning) {
        this.inputArea.placeholder = 'Agent 思考中… 可直接输入消息插入对话';
        this._updateStatusBar('thinking', '分析中…');
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
        this._promptShelf?.dismiss(); // ⚡ dismiss ask/permission on stop
        if (this.progressBar) {
          this.progressBar.remove();
          this.progressBar = null;
        }
        this.panel.classList.remove('chat-pill-running');
      }
    });
    // ── Detect graph interaction to auto-dismiss the panel ──
    // ── Receive Agent events via bus (decoupled from Agent class) ──
    bus.on('agent:event', (ev: AgentEvent) => this.renderEvent(ev));
    this.setupGraphClickHandler();
    // ── Agent progress feedback (item 3) ──
        bus.on('agent:progress', (data: { step: number; toolName: string }) => {
      if (!this.progressBar || !this._activeExec().isRunning) return;
      const label = this.progressBar.querySelector('.chat-progress-label');
      if (label) label.textContent = data.step > 0
        ? `步骤 ${data.step}  ·  ${data.toolName}`
        : `正在执行 ${data.toolName}`;
    });
  }

  // ── Public API ──

  private get agent(): ChatAgentHandle | null {
    return Session.getActiveAgent(this.panelId);
  }

  /** Active session's execution state (per-session isolation). */
  private _activeExec(): ExecStateInstance {
    const s = getChatStore(this.panelId).getState();
    const sid = s.sessions[s.activeIdx]?.id;
    return sid ? Session.getSessionExecState(sid) : this._exec;
  }

  setAgent(agent: ChatAgentHandle | null): void {
    if (!agent) return;
    // Replace all sessions — setAgent is boot/setup, not session management.
    // ponytail: clear old sessions (including placeholder) so the workspace
    // switch always lands on the fresh agent. Old stale sessions caused the
    // agent to answer with "当前没有加载项目" after a project was loaded.
    Session.resetSessionState(this.panelId, agent);
    getChatStore(this.panelId).getState().setTotalTokensUsed(0);
    Session.syncActiveSessionTokens(this.panelId, 0);
    getChatStore(this.panelId).getState().clearToolUsage();
    getChatStore(this.panelId).getState().clearToolHistory();
    this.renderSessionTabs();
    this.messages = [];
    resetMsgIdCounter(this.panelId);
    getChatStore(this.panelId).getState().setStreamingAssistantId(null);
    this.msgList.innerHTML = '';
    this.addNotice('已连接到当前项目', 'info');
  }

  getAgent(): ChatAgentHandle | null { return this.agent; }
  setStarGraph(g: StarGraph): void { this.starGraph = g; }
  setProjectPath(p: string): void {
    // ponytail: clear user focus when project changes — stale node/file refs
    // from the old workspace would misdirect the agent's tool calls.
    if (p && p !== getChatStore(this.panelId).getState().projectPath) {
      getChatStore(this.panelId).getState().userFocusFile = null;
      getChatStore(this.panelId).getState().userFocusNode = null;
    }
    getChatStore(this.panelId).getState().projectPath = p;
  }

  toggle(): void {
    switch (getChatStore(this.panelId).getState().panelMode) {
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
    // Only summon if not already in panel/hud mode — avoids GSAP conflict with
    // the DOM mutations from sendMessage (bubble render, tool cards, etc.)
    const alreadyOpen = getChatStore(this.panelId).getState().panelMode== 'panel' || getChatStore(this.panelId).getState().panelMode== 'hud';
    if (!alreadyOpen) {
      this.summonPanel();
    }
    this.inputArea.value = question;
    this.inputArea.style.height = 'auto';
    this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
    // Small delay to let panel animate open before sending
    const delay = alreadyOpen ? 0 : 200;
    setTimeout(() => this.sendMessage(), delay);
  }

  /** Render a permission request via PromptShelf (above input, not inline). */

  showPermissionCard(
    toolName: string,
    reason: string,
    subject: string,
  ): Promise<{ allow: boolean; remember: boolean }> {
    // Ensure panel is open
    if (getChatStore(this.panelId).getState().panelMode !== 'panel') {
      Anim.killPanelTweens(this._animCtx());
      Anim.summonPanel(this._animCtx());
    }
    // ⚡ Use PromptShelf instead of inline message
    if (!this._promptShelf) {
      return Promise.resolve({ allow: false, remember: false });
    }
    return this._exec.enqueuePerm(() =>
      this._promptShelf!.showPermission({
        type: 'permission',
        id: `perm-${toolName}-${Date.now()}`,
        toolName,
        reason,
        subject: subject || '',
      })
    );
  }

  close(): void {
    // Panel/HUD → input; input → pill
    if (getChatStore(this.panelId).getState().panelMode== 'panel' || getChatStore(this.panelId).getState().panelMode== 'hud') {
      this.collapseToInput();
    } else if (getChatStore(this.panelId).getState().panelMode== 'input') {
      this.collapseToPill();
    }
  }

  isOpen(): boolean { return getChatStore(this.panelId).getState().panelMode== 'panel' || getChatStore(this.panelId).getState().panelMode== 'hud'; }

  // ── Tab switching ──

  private switchTab(tab: 'chat' | 'tools' | 'context'): void {
    Dom.switchTab(this._domCtx(), tab);
  }

  // ── Agent status bar ──

  private _updateStatusBar(state: 'idle' | 'thinking' | 'running' | 'error', detail?: string): void {
    Dom._updateStatusBar(this._domCtx(), state, detail);
  }

  // ── Tool usage tracking ──

  private _recordToolUsage(toolName: string, args: string): void {
    getChatStore(this.panelId).getState().addToolUsage(toolName, args);
    // Update badge on tools tab
    const toolsTab = this.tabBar.querySelector('[data-tab="tools"]') as HTMLElement;
    if (toolsTab) {
      const usage = getChatStore(this.panelId).getState().toolUsage;
      const total = Object.values(usage).reduce((a, b) => a + b, 0);
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
    Dom.renderToolsView(this._domCtx());
  }

  // ── Context view ──

  private renderContextView(): void {
    Dom.renderContextView(this._domCtx());
  }

  // ── State transitions (GSAP-powered) ──

  /** Build SessionContext bridge for extracted session management functions. */
  private _sessionCtx(): Session.SessionContext {
    return {
      storeId: this.panelId,
      panel: this.panel,
      sessionTabs: this.sessionTabs,
      tabBar: this.tabBar,
      getProjectPath: () => getChatStore(this.panelId).getState().projectPath,
      agentFactory: Session.getAgentFactory(),
      getMessages: () => getChatMessages(),
      setMessages: (msgs) => { setChatMessages(msgs); },
      getStreamingAssistantId: () => getChatStore(this.panelId).getState().streamingAssistantId,
      setStreamingAssistantId: (id) => { getChatStore(this.panelId).getState().setStreamingAssistantId(id); },
      // ⚡ Zustand store triggers React re-render on mutation
      flushReasoning: () => {},
      flushText: () => {},
      clearPendingToolCards: () => {},
      getRunning: () => this._activeExec().isRunning,
      abort: () => this.abort(),
      addNotice: (text, level) => this.addNotice(text, level as 'info' | 'warn' | 'error'),
      updateFooter: () => this.updateFooter(),
      getTotalTokensUsed: () => getChatStore(this.panelId).getState().totalTokensUsed,
      setTotalTokensUsed: (n) => { getChatStore(this.panelId).getState().setTotalTokensUsed(n); },
      clearToolUsage: () => { getChatStore(this.panelId).getState().clearToolUsage(); },
      clearToolHistory: () => { getChatStore(this.panelId).getState().clearToolHistory(); },
      getLastUsageText: () => getChatStore(this.panelId).getState().lastUsageText,
      setLastUsageText: (s) => { getChatStore(this.panelId).getState().lastUsageText = s; },
      getLastAgentDiag: () => getChatStore(this.panelId).getState().lastAgentDiag,
      clearInputHistory: () => { this.inputHistory = []; this.historyIdx = 0; this.draftText = ''; },
      getStarGraph: () => this.starGraph,
    };
  }

  /** Build AnimContext bridge for extracted animation functions. */
  private _animCtx(): Anim.AnimContext {
    return {
      panel: this.panel,
      requestFocus: () => { this.inputArea.focus(); },
      getMode: () => getChatStore(this.panelId).getState().panelMode,
      setMode: (m) => { getChatStore(this.panelId).getState().setPanelMode(m); },
      getRunning: () => this._activeExec().isRunning,
      execState: this._exec,
      getProjectPath: () => getChatStore(this.panelId).getState().projectPath,
      getActiveIdx: () => Session.getActiveIdx(this.panelId),
      updateFooter: () => this.updateFooter(),
      resetPillBadge: () => this._resetPillBadge(),
      closeHistory: () => this.closeHistory(),
      hideSlashPanel: () => this._hideSlashPanel(),
      saveActiveSession: (p) => this.saveActiveSession(p),
    };
  }

  /** Build DomContext bridge for extracted DOM construction functions. */
  private _domCtx(): Dom.DomContext {
    return {
      panelId: this.panelId,
      container: this.container,
      getMode: () => getChatStore(this.panelId).getState().panelMode,
      getAgent: () => this.agent,
      getStarGraph: () => this.starGraph,
      getMessages: () => this.messages,
      getProjectPath: () => getChatStore(this.panelId).getState().projectPath,
      sendMessage: () => this.sendMessage(),
      abort: () => this.abort(),
      summonPanel: () => this.summonPanel(),
      collapseToInput: () => this.collapseToInput(),
      close: () => this.close(),
      isOpen: () => this.isOpen(),
      addNotice: (text, level) => this.addNotice(text, level as 'info' | 'warn' | 'error'),
      createNewSession: () => this.createNewSession(),
      switchSession: (idx) => this.switchSession(idx),
      closeSession: (idx) => this.closeSession(idx),
      toggleHistory: () => this.toggleHistory(),
      closeHistory: () => this.closeHistory(),
      running: this._activeExec().isRunning,
      // DOM element setters
      setPanel: (el) => { this.panel = el; },
      setMsgList: (el) => { this.msgList = el; },
      setInputArea: (el) => { this.inputArea = el; },
      setSendBtn: (el) => { this.sendBtn = el; },
      setStopBtn: (el) => { this.stopBtn = el; },
      setFooterEl: (el) => { this.footerEl = el; },
      setHeaderEl: (el) => { this.headerEl = el; },
      setSessionTabs: (el) => { this.sessionTabs = el; },
      setProgressBar: (el) => { this.progressBar = el; },
      setPillBadge: (el) => { this.pillBadge = el; },
      setTabBar: (el) => { this.tabBar = el; },
      setTabContent: (el) => { this.tabContent = el; },
      setChatPanel: (el) => { this.chatPanel = el; },
      setToolsPanel: (el) => { this.toolsPanel = el; },
      setContextPanel: (el) => { this.contextPanel = el; },
      setStatusBar: (el) => { this.statusBar = el; },
      setStatusDot: (el) => { this.statusDot = el; },
      setStatusText: (el) => { this.statusText = el; },
      setStatusTokens: (el) => { this.statusTokens = el; },
      setAttachPillsEl: (el) => { this.attachPillsEl = el; },
      setGraphClickCleanup: (fn) => { this.graphClickCleanup = fn; },
      setFooterClickCleanup: (fn) => { this.footerClickCleanup = fn; },
      // DOM getters
      getPanel: () => this.panel,
      getInputArea: () => this.inputArea,
      // Slash panel — migrated to React
      _slashController: this._slashController,      // @ autocomplete
      atPopup: this.atPopup,
      setAtPopup: (el) => { this.atPopup = el; },
      atIdx: this.atIdx,
      setAtIdx: (n) => { this.atIdx = n; },
      atFileCache: this.atFileCache,
      setAtFileCache: (c) => { this.atFileCache = c; },
      // Settings
      onOpenSettings: this.onOpenSettings,
      _onModeChange: this._onModeChange,
      _onTrailToggle: this._onTrailToggle,
      // Tool
      _toolSchemas: getChatStore(this.panelId).getState().toolSchemas,
      toolUsage: getChatStore(this.panelId).getState().toolUsage,
      toolHistory: getChatStore(this.panelId).getState().toolHistory,
      // Input history
      inputHistory: this.inputHistory,
      setInputHistory: (h) => { this.inputHistory = h; },
      historyIdx: this.historyIdx,
      setHistoryIdx: (n) => { this.historyIdx = n; },
      draftText: this.draftText,
      setDraftText: (s) => { this.draftText = s; },
      // Callbacks
      handleAtInput: () => this.handleAtInput(),
      handleSlashInput: () => this.handleSlashInput(),
      hideSlashPanel: () => this._hideSlashPanel(),
      navigateSlashPanel: (dir) => this._navigateSlashPanel(dir),
      selectSlashItem: () => this._selectSlashItem(),
      updateAtSelection: () => this.updateAtSelection(),
      confirmAtSelection: () => this.confirmAtSelection(),
      expandToInput: () => this.expandToInput(),
      restoreFromHud: () => this.restoreFromHud(),
      fadeToHud: () => this.fadeToHud(),
      collapseToPill: () => this.collapseToPill(),
      toggleReasoning: (btn, content) => this.toggleReasoning(btn, content),
      toggleToolCard: (card) => this.toggleToolCard(card),
      killPanelTweens: () => this.killPanelTweens(),
      setupResize: (handle) => this.setupResize(handle),
      hintText: () => this.hintText(),
      refreshHint: () => this.refreshHint(),
      getLastAgentDiag: () => getChatStore(this.panelId).getState().lastAgentDiag,
      // State
      _lastAgentState: getChatStore(this.panelId).getState().lastAgentState,
      lastUsageText: getChatStore(this.panelId).getState().lastUsageText,
      totalTokensUsed: getChatStore(this.panelId).getState().totalTokensUsed,
      _expandedReasoning: new Set(getChatStore(this.panelId).getState().expandedReasoning),
      _activeTab: getChatStore(this.panelId).getState().activeTab,
      attachedFiles: this.attachedFiles,
      historyPanel: this.historyPanel,
      setHistoryPanel: (el) => { this.historyPanel = el; },
      historyOpen: this.historyOpen,
      setHistoryOpen: (v) => { this.historyOpen = v; },
      toolCategory: (name) => ChatPanel.toolCategory(name),
      // Session persistence callbacks
      listSavedSessions: (p) => this.listSavedSessions(p),
      loadSessionFromDisk: (p, id) => this.loadSessionFromDisk(p, id),
      deleteSessionFile: (p, id) => this.deleteSessionFile(p, id),
    };
  }

  /** Build StreamContext bridge for extracted stream rendering functions. */
  private _streamCtx(): Stream.StreamContext {
    return {
      storeId: this.panelId,
      getMessages: () => getChatMessages(),
      setMessages: (msgs) => { setChatMessages(msgs); },
      getStreamingAssistantId: () => getStreamingAssistantId(),
      setStreamingAssistantId: (id) => { getChatStore(this.panelId).getState().setStreamingAssistantId(id); },
      getUserScrolledUp: () => getUserScrolledUp(),
      setUserScrolledUp: (v) => { getChatStore(this.panelId).getState().setUserScrolledUp(v); },
      getSyncRafId: () => this._syncRafId,
      setSyncRafId: (id) => { this._syncRafId = id; },
      getTurnPairs: () => Session.getTurnPairs(),
      getAgent: () => this.agent,
      getStarGraph: () => this.starGraph,
      updateFooter: () => this.updateFooter(),
      setLastUsageText: (s) => { getChatStore(this.panelId).getState().setLastUsageText(s); },
      addNotice: (text, level) => this.addNotice(text, level as 'info' | 'warn' | 'error'),
      saveActiveSession: (p) => this.saveActiveSession(p),
      bumpPillBadge: () => { getChatStore(this.panelId).getState().bumpPillEventCount(); },
      animateBubbleIn: (el, delay) => this.animateBubbleIn(el, delay),
      setRunning: (_r: boolean) => { /* migrated to execState */ },
      abort: () => this.abort(),
      _updateStatusBar: (s, d) => this._updateStatusBar(s, d),
      _recordToolUsage: (n, a) => { getChatStore(this.panelId).getState().addToolUsage(n, a); },
      _retractUserMessage: (m) => this._retractUserMessage(m),
      retractTurn: (i) => this.retractTurn(i),
      sendMessage: () => this.sendMessage(),
      _updateTokens: (n) => { getChatStore(this.panelId).getState().setTotalTokensUsed(n); },
      getProjectPath: () => getChatStore(this.panelId).getState().projectPath,
      getRunning: () => this._activeExec().isRunning,
      getAbortCtrl: () => this._activeExec().abortSignal ? { signal: this._activeExec().abortSignal } as AbortController : null,
      setAbortCtrl: (_c: any) => { /* managed by execState */ },
      getExpandedReasoning: () => getExpandedReasoningSet(),
    };
  }

  private contentEls(): HTMLElement[] {
    return Anim.contentEls(this._animCtx());
  }

  private killPanelTweens(): void {
    Anim.killPanelTweens(this._animCtx());
  }

  /** Strip all modal classes from the panel */
  private removeAllPanelClasses(): void {
    Anim.removeAllPanelClasses(this._animCtx());
  }

  /** Animation guard — check if GSAP is actively tweening panel or content */
  private get _animating(): boolean {
    return Anim.getAnimating(this._animCtx());
  }

  /**
   * Snapshot CSS-computed opacities BEFORE GSAP touches inline styles.
   */
  private snapshotContentOpacities(): number[] {
    return Anim.snapshotContentOpacities(this._animCtx());
  }

  /** Fade content in from 0 → current CSS opacities. */
  private fadeContentIn(delay = 0.12, duration = 0.2): void {
    Anim.fadeContentIn(this._animCtx(), delay, duration);
  }

  /** Cross-fade content between two visible modes (panel ↔ hud). */
  private crossfadeContent(fromOpacities: number[], duration = 0.2, ease = 'power2.out'): void {
    Anim.crossfadeContent(this._animCtx(), fromOpacities, duration, ease);
  }

  // ── Per-bubble entrance animation ──
  private animateBubbleIn(el: HTMLElement, delay = 0): gsap.core.Tween {
    return Anim.animateBubbleIn(el, delay);
  }

  // ── Tool card expand/collapse (GSAP height) ──
  private toggleToolCard(card: HTMLElement): void {
    Anim.toggleToolCard(card);
  }

  // ── Reasoning block toggle (GSAP height) ──
  private toggleReasoning(toggleBtn: HTMLElement, content: HTMLElement): void {
    Anim.toggleReasoning(toggleBtn, content);
  }

  // Expand: pill → input/panel (full morph) or input → panel (height only)
  private morphToMode(mode: 'input' | 'panel', cls: string): void {
    Anim.morphToMode(this._animCtx(), mode, cls);
  }

  /** Pill → Input: 44px circle morphs into floating input bar */
  private expandToInput(): void {
    Anim.expandToInput(this._animCtx());
  }

  /** Any state → Panel: summon the full conversation card */
  private summonPanel(): void {
    Anim.summonPanel(this._animCtx());
  }

  /** Panel/HUD → Input: collapse card to floating input bar */
  private collapseToInput(): void {
    Anim.collapseToInput(this._animCtx());
  }

  /** Input → Pill: collapse to 48px star circle */
  private collapseToPill(): void {
    Anim.collapseToPill(this._animCtx());
  }

  /** Panel → HUD: ghost the card */
  private fadeToHud(): void {
    Anim.fadeToHud(this._animCtx());
  }

  /** HUD → Panel: restore the full card */
  private restoreFromHud(): void {
    Anim.restoreFromHud(this._animCtx());
  }

  // ── Graph click detection — dismiss panel when user interacts with the star field ──

  private setupGraphClickHandler(): void {
    Dom.setupGraphClickHandler(this._domCtx());
  }

  // ── Session management (delegated to chat-session.ts) ──

  private renderSessionTabs(): void { Session.renderSessionTabs(this._sessionCtx()); }
  private switchSession(idx: number): void { Session.switchSession(this._sessionCtx(), idx); }
  private closeSession(idx: number): void { Session.closeSession(this._sessionCtx(), idx); }
  private async createNewSession(): Promise<void> { return Session.createNewSession(this._sessionCtx()); }

  // ── Session persistence (delegated to chat-session.ts) ──

  async saveActiveSession(projectPath: string): Promise<void> { return Session.saveActiveSession(this._sessionCtx(), projectPath); }
  async autoRestoreLastSession(projectPath: string): Promise<void> { return Session.autoRestoreLastSession(this._sessionCtx(), projectPath); }
  async listSavedSessions(projectPath: string): Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string }>> { return Session.listSavedSessions(this._sessionCtx(), projectPath); }
  async loadSessionFromDisk(projectPath: string, sessionId: number): Promise<void> { return Session.loadSessionFromDisk(this._sessionCtx(), projectPath, sessionId); }
  async deleteSessionFile(projectPath: string, sessionId: number): Promise<void> { return Session.deleteSessionFile(this._sessionCtx(), projectPath, sessionId); }

  // ── Turn retraction (delegated to chat-session.ts) ──

  private retractTurn(idx: number): string | null { return Session.retractTurn(this._sessionCtx(), idx); }
  private _retractUserMessage(msg: UserMessage): void { Session._retractUserMessage(this._sessionCtx(), msg); }

  // ── Export (delegated to chat-session.ts) ──

  private async exportSession(): Promise<void> { return Session.exportSession(this._sessionCtx()); }

  // ── History panel — browse saved conversation files ──

  private historyPanel: HTMLElement | null = null;
  private historyOpen = false;

  private toggleHistory(): void {
    Dom.toggleHistory(this._domCtx());
  }

  private openHistory(): void {
    Dom.openHistory(this._domCtx());
  }

  private closeHistory(): void {
    Dom.closeHistory(this._domCtx());
  }

  private buildHistoryEntry(
    title: string,
    subtitle: string,
    onClick: () => void,
    active: boolean,
    onDelete?: () => void,
  ): HTMLElement {
    return Dom.buildHistoryEntry(title, subtitle, onClick, active, onDelete);
  }

  // ── Build DOM ──

  private buildDOM(): void {
    Dom.buildDOM(this._domCtx());
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
    // Create new session via Session — doesn't abort running session anymore
    this.createNewSession();
  }

  /** Send an instruction to the agent, optionally showing a user bubble.
   *  @param text The instruction sent to the agent
   *  @param displayLabel If set, shows this as a user bubble (for slash commands) */
  private sendAgentText(text: string, displayLabel?: string): void {
    if (!this.agent || this._activeExec().isRunning) return;
    const signal = this._activeExec().start();

    // Reset auto-scroll for this new turn
    getChatStore(this.panelId).getState().userScrolledUp = false;

    const hint = this.panel.querySelector('.chat-hint') as HTMLElement | null;
    if (hint) hint.remove();

    if (displayLabel) {
      Session.getTurnPairs().push({ userText: displayLabel, userBubble: null, assistantBubble: null, sessionIndex: this.agent.nextInsertIndex });
      this.appendUserBubble(displayLabel);
    }

    this.agent.run(signal, text).then(() => {
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
      this._activeExec().done();
      this.finishTurn();
      bus.emit('chat:turn-done', {});
    });
  }

  /** Run a goal autonomously — Agent keeps going until done or failed.
   *  ponytail: same UI scaffolding as sendAgentText, but calls runGoal instead of run. */
  private runGoal(goal: string): void {
    if (!this.agent || this._activeExec().isRunning) return;
    const signal = this._activeExec().start();
    getChatStore(this.panelId).getState().userScrolledUp = false;

    const hint = this.panel.querySelector('.chat-hint') as HTMLElement | null;
    if (hint) hint.remove();

    Session.getTurnPairs().push({ userText: `/goal ${goal}`, userBubble: null, assistantBubble: null, sessionIndex: this.agent.nextInsertIndex });
    this.appendUserBubble(`🎯 ${goal}`);


    this.agent.runGoal(signal, goal).then((result) => {
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
      this._activeExec().done();
      this.finishTurn();
      bus.emit('chat:turn-done', {});
    });
  }

  private async sendMessage(): Promise<void> {
    // Reset auto-scroll for this new turn
    getChatStore(this.panelId).getState().userScrolledUp = false;

    const text = this.inputArea.value.trim();
    if (!text) return;

    if (!this.agent) {
      const detail = getChatStore(this.panelId).getState().lastAgentDiag
        ? `${getChatStore(this.panelId).getState().lastAgentDiag} (factory:${Session.getAgentFactory() ? 'yes' : 'NO'})`
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
    if (this._activeExec().isRunning) {
      const sessIdx = this.agent.nextInsertIndex;
      this.agent.insertMessage(text);
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      // Push input history
      this.inputHistory.push(text);
      this.historyIdx = this.inputHistory.length;
      this.draftText = '';
      // Show panel if collapsed
      if (getChatStore(this.panelId).getState().panelMode== 'input') this.summonPanel();
      const hint = this.panel.querySelector('.chat-hint') as HTMLElement | null;
      if (hint) hint.remove();
      // Track turn pair (sessionIndex valid: queued messages are applied at safe boundary)
      Session.getTurnPairs().push({ userText: text, userBubble: null, assistantBubble: null, sessionIndex: sessIdx });
      this.appendUserBubble(text);
        return;
    }

    // Auto-label session on first user message
    if (Session.getActiveIdx(this.panelId) >= 0) {
      const session = Session.getSessions(this.panelId)[Session.getActiveIdx(this.panelId)];
      if (session && (session.label.startsWith('会话 ') || session.label === '已恢复的会话')) {
        session.label = text.length > 28 ? text.slice(0, 27) + '…' : text;
        this.renderSessionTabs();
      }
    }

    // If we're in the floating input bar, summon the full panel before sending
    if (getChatStore(this.panelId).getState().panelMode== 'input') {
      this.summonPanel();
    }

    // Push input history (item 1)
    this.inputHistory.push(text);
    this.historyIdx = this.inputHistory.length;
    this.draftText = '';

    this.inputArea.value = '';
    this.inputArea.style.height = 'auto';
    const signal = this._activeExec().start();

    // Remove hint if present
    const hint = this.panel.querySelector('.chat-hint') as HTMLElement | null;
    if (hint) hint.remove();

    // Turn pair for retry (item 4) — sessionIndex is where user msg will land
    const sessIdx = this.agent.getSession().length;
    Session.getTurnPairs().push({ userText: text, userBubble: null, assistantBubble: null, sessionIndex: sessIdx });

    // User bubble (original text, focus context is for Agent eyes only)
    const filesSnapshot = [...this.attachedFiles];
    this.appendUserBubble(text, filesSnapshot);

    // Build focus context prefix — tells Agent what the user is looking at
    let focusPrefix = '';
    const focusNode = getChatStore(this.panelId).getState().userFocusNode;
    if (focusNode) {
      focusPrefix = `[用户当前选中了图中的节点 "${focusNode.name}"`;
      if (focusNode.location) {
        focusPrefix += ` (位于 ${focusNode.location})`;
      }
      focusPrefix += ']\n\n';
    } else if (getChatStore(this.panelId).getState().userFocusFile) {
      focusPrefix = `[用户当前正在查看文件 "${getChatStore(this.panelId).getState().userFocusFile}"]\n\n`;
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

    // Run agent
    try {
      await this.agent.run(signal, focusPrefix + text);
    } catch (err: any) {
      if (err.message?.includes('aborted') || err.message?.includes('AbortError')) {
        this.addNotice('已中止', 'info');
      } else if (err.message?.includes('paused after')) {
        this.addNotice(err.message, 'warn');
      } else {
        this.addNotice(`错误: ${err.message || String(err)}。发送任意消息重试，或输入 /compact 压缩上下文，或输入 /new 新建会话`, 'error');
      }
    } finally {
      this._activeExec().done();
      this.finishTurn();
    }
    // Signal main.ts to persist sessions
    bus.emit('chat:turn-done', {});
  }

  private abort(): void {
    if (!this._activeExec().isRunning) return;
    
    // ⚡ 统一状态管理：停止主Agent + 级联子Agent + 清权限队列
    this._activeExec().stop();
    this.agent?.cascadeAbort(); // agent-specific cleanup (isolation worktrees, etc.)
    
    // DOM-specific cleanup (execState doesn't own UI)
    this.inputArea.disabled = false;
    this.inputArea.placeholder = '输入消息… (Enter 发送, Shift+Enter 换行)';
    this.addNotice('正在中止…', 'info');
    
    // 安全超时：3 秒内若 Agent 没响应，强制复位
    const safety = setTimeout(() => {
      if (this._activeExec().isRunning) {
        this._exec.forceReset();
        this.finishTurn();
        this.addNotice('已强制中止（超时）', 'warn');
      }
    }, 3000);
    // 如果 Agent 正常响应了，取消安全超时
    const poll = setInterval(() => {
      if (!this._exec.isBusy) {
        clearTimeout(safety);
        clearInterval(poll);
      }
    }, 200);
    this._updateStopButton();
  }

  /** Is ANY agent (main or sub) currently working? Delegates to ExecutionState. */
  private _isBusy(): boolean {
    return this._exec.isBusy;
  }

  /** Sync stop button visibility to _isBusy() truth — call whenever state may have changed. */
  private _updateStopButton(): void {
    const busy = this._isBusy();
    this.stopBtn.classList.toggle('hidden', !busy);
    if (!busy) {
      this.sendBtn.classList.remove('hidden');
    }
  }

  // ⚡ migrated to ExecutionState.onChange callback in constructor

  // ═══════════════════════════════════════════════════════
  // Data-driven message model — replaces manual DOM append
  // ═══════════════════════════════════════════════════════

  /** Get the assistant message currently being streamed, or create one. */
  private _streamingAssistant(): AssistantMessage {
    if (getChatStore(this.panelId).getState().streamingAssistantId) {
      const found = this.messages.find(
        (m) => m.role === 'assistant' && m._id === getChatStore(this.panelId).getState().streamingAssistantId,
      );
      if (found) return found as AssistantMessage;
    }
    // Create a new one — find the last user message to link to
    const lastUser = [...this.messages].reverse().find((m) => m.role === 'user');
    const assistant = createAssistantMessage(lastUser?._id ?? '');
    this.messages.push(assistant);
    getChatStore(this.panelId).getState().setStreamingAssistantId(assistant._id);
    return assistant;
  }

  /** Update token usage on the current assistant. */
  private _updateTokens(tokensUsed: number): void {
    getChatStore(this.panelId).getState().totalTokensUsed += tokensUsed;
    const assistant = this._streamingAssistant();
    assistant.tokensUsed = (assistant.tokensUsed || 0) + tokensUsed;
  }

  /** Push a notice message to the log.
   *  ponytail: insert BEFORE the streaming assistant (if any) so the incremental
   *  render path in _doSyncMessagesToDOM stays active. If the notice is at the
   *  tail, lastMsg.role !== 'assistant' and every rAF frame does a full rebuild. */
  private _addNoticeMessage(text: string, level: 'info' | 'warn' | 'error'): void {
    Stream._addNoticeMessage(this._streamCtx(), text, level);
  }

  /** Mark the current streaming assistant as done and start a new turn. */
  private _finaliseStreamingAssistant(): void { Stream._finaliseStreamingAssistant(this._streamCtx()); }

  // ── Expanded reasoning blocks (survives DOM replacement during streaming) ──
  private _expandedReasoning = new Set<number>();

  // ⚡ React handles scrolling internally
  // ⚡ React handles scrolling internally

  // ── Event Sink — render Agent events to DOM (NEW data-driven path) ──

  private renderEvent(ev: AgentEvent): void { Stream.renderEvent(this._streamCtx(), ev); }

  // ── Text (streaming via data-driven message model) ──

  // ── Inline permission cards ──

  // ponytail: single entry point — all notices go through the message model
  // so _syncMessagesToDOM() never wipes them.
  private addNotice(text: string, level: 'info' | 'warn' | 'error'): void {
    Stream.addNotice(this._streamCtx(), text, level);
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
    const usageStr = getChatStore(this.panelId).getState().lastUsageText ? ` · ${getChatStore(this.panelId).getState().lastUsageText}` : '';
    const mode = CHAT_MODES.find(m => m.id === (settings.agent?.chatMode || 'general')) || CHAT_MODES[0];

    // Token bar (item 12)
    let tokenBarHtml = '';
    const ctxWin = settings.agent?.contextWindow || 0;
    if (ctxWin > 0 && getChatStore(this.panelId).getState().totalTokensUsed > 0) {
      const pct = Math.min((getChatStore(this.panelId).getState().totalTokensUsed / ctxWin) * 100, 100);
      let cls = '';
      if (pct >= 90) cls = 'danger';
      else if (pct >= 80) cls = 'warn';
      const labelK = `${(getChatStore(this.panelId).getState().totalTokensUsed / 1000).toFixed(1)}k / ${(ctxWin / 1000).toFixed(0)}k`;
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

    // ── Slash panel: React-based, mounted outside footerEl so rebuilds don't touch it ──
    this._setupSlashPanel(); // registers commands + wires local handlers
    if (!this._slashController) {
      this._slashController = new SlashPanelController(
        this.panel,
        CommandRegistry.instance.getAll(),
        (cmd) => this._executeCommand(cmd),
      );
    }
    this._slashController.hide();

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
      if (this._slashController?.visible && e.target !== trigger && !this.inputArea.contains(e.target as Node)) {
        this._slashController.hide();
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
    return Dom.openFilePicker(this._domCtx());
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
    Dom.addAttachedFile(this._domCtx(), path, name, size);
  }

  private removeAttachedFile(idx: number): void {
    Dom.removeAttachedFile(this._domCtx(), idx);
  }

  private renderAttachments(): void {
    Dom.renderAttachments(this._domCtx());
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

  private appendUserBubble(text: string, files?: { path: string; name: string; size: number }[], skipActions?: boolean): void {
    Stream.appendUserBubble(this._streamCtx(), text, files, skipActions);
  }

  /** Finalize current assistant bubble — link to latest turnPair, reset streaming state.
   *  Called at TurnStarted boundaries (including mid-run inserts) and at run end. */
  private finishCurrentTurn(): void { Stream.finishCurrentTurn(this._streamCtx()); }

  private finishTurn(): void { Stream.finishTurn(this._streamCtx()); }

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
        const data = await rpc<string>('glob', {
          pattern: '**/*.{ts,js,py,rs,html,css,vue,svelte,json,toml,yaml,yml,md}',
          path: getChatStore(this.panelId).getState().projectPath || '.',
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

  /** Create slash panel once, outside footerEl so updateFooter's innerHTML wipe
   *  doesn't destroy it. Anchored to panel (position:fixed), floats above footer. */
  private _setupSlashPanel(): void {
    // ⚡ React-based — SlashPanelController handles all rendering.
    // Command registry + local handlers still wired here for ChatPanel context.
    CommandRegistry.instance.registerAll(DEFAULT_COMMANDS);
    this._wireCommandHandlers();
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
      this.appendUserBubble('/compact');
        this.addNotice('正在压缩上下文…', 'info');
      const ctrl = new AbortController();
      this.agent.compactNow(ctrl.signal).then(() => {
        this.messages = [];
        resetMsgIdCounter(this.panelId);
        getChatStore(this.panelId).getState().setStreamingAssistantId(null);
        this.msgList.innerHTML = '';
        Session._rebuildMessagesFromSession(this._sessionCtx());
        this._chatMessages?.bump();
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

  /** Show the slash panel with optional query filter. Delegate to React. */
  private _showSlashPanel(query?: string): void {
    this._slashController?.show(query);
  }

  /** Hide the slash panel. Delegate to React — no CSS hack needed. */
  private _hideSlashPanel(): void {
    this._slashController?.hide();
  }

  /** Navigate slash panel items with arrow keys. Returns true if handled. */
  private _navigateSlashPanel(delta: number): boolean {
    return this._slashController?.navigate(delta) ?? false;
  }

  /** Execute the currently highlighted slash command. */
  private _selectSlashItem(): void {
    this._slashController?.select();
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
      } else {
        // Slash exists but no query (e.g. multi-slash paths like "a/b/" or just "/")
        // Keep panel open but show all commands — prevents ghost-panel state
        this._showSlashPanel('');
      }
    }
  }

  // ── Pill badge — agent event counter when collapsed ──

  /** Bump the pill badge count. Call from event handlers when pill-mode streaming. */
  private _bumpPillBadge(): void {
    if (getChatStore(this.panelId).getState().panelMode !== 'pill') return;
    getChatStore(this.panelId).getState().pillEventCount++;
    this.pillBadge.textContent = String(getChatStore(this.panelId).getState().pillEventCount > 99 ? '99+' : getChatStore(this.panelId).getState().pillEventCount);
    this.pillBadge.classList.add('show');
  }

  private _resetPillBadge(): void {
    getChatStore(this.panelId).getState().pillEventCount = 0;
    this.pillBadge.textContent = '';
    this.pillBadge.classList.remove('show');
  }

  // ── Sink getter (used by main.ts to wire Agent) ──

  get sink() {
    return (ev: AgentEvent) => this.renderEvent(ev);
  }
}