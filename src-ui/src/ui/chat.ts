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
import { shell } from './app-shell';
import { cancelPendingApprovals } from '../agent/permission';
import { execState } from '../agent/execution-state';
import { loadSettings, saveSettings, CHAT_MODES } from '../settings';
import { invoke } from '../bridge';
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
import { escapeHtml, showCopiedFeedback, truncateArgs, formatToolResult, extractCodeTokens, linkifyTextNode } from './chat-utils';

// ── New message model (data-driven render) ──
import {
  type ChatMessage,
  type UserMessage,
  type AssistantMessage,
  type AssistantPart,
  type MessageId,
  type FileAttachment,
  type PermissionMessage,
  nextMsgId,
  resetMsgIdCounter,
  createUserMessage,
  createAssistantMessage,
  createNoticeMessage,
  createPermissionMessage,
  lastTextPart,
  findToolPart,
} from './message-model';
import { renderMessage, type RenderCallbacks } from './message-renderer';
import { CommandRegistry, DEFAULT_COMMANDS, type CommandDef } from './command-registry';
import { SlashPanelController } from './react/SlashPanel';

// ── Constants ──

const PANEL_ID = 'chat-panel';

// ── ChatPanel ──

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

  // Session state (managed by chat-session.ts)
  // Access via Session.getSessions(), Session.getActiveIdx(), etc.

  // User focus tracking — so the Agent knows what file/node the user is looking at
  private _userFocusFile: string | null = null;
  private _userFocusNode: { name: string; location?: string } | null = null;

  // Streaming state
  private starGraph: StarGraph | null = null;
  // ⚡ running / abortCtrl migrated to ExecutionState — use execState.isRunning / execState.start()

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

  // ── Slash panel (React-based) ──
  private _slashController: SlashPanelController | null = null;

  // ── Messages (React-based) ──


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
  setAgentFactory(fn: () => Promise<ChatAgentHandle | null>): void { Session.setAgentFactory(fn); }

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
    // ⚡ ExecutionState → UI sync: full state → DOM binding
    execState.onChange(() => {
      this._updateStopButton();
      if (execState.isRunning) {
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
      if (!this.progressBar || !execState.isRunning) return;
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

  private get agent(): ChatAgentHandle | null {
    return Session.getActiveAgent();
  }

  setAgent(agent: ChatAgentHandle | null): void {
    if (!agent) return;
    // Replace all sessions — setAgent is boot/setup, not session management.
    // ponytail: clear old sessions (including placeholder) so the workspace
    // switch always lands on the fresh agent. Old stale sessions caused the
    // agent to answer with "当前没有加载项目" after a project was loaded.
    Session.resetSessionState(agent);
    this.totalTokensUsed = 0;
    Session.syncActiveSessionTokens(0);
    this.toolUsage.clear();
    this.toolHistory = [];
    this.renderSessionTabs();
    this.messages = [];
    resetMsgIdCounter();
    this._streamingAssistantId = null;
    this.msgList.innerHTML = '';
    this.addNotice('已连接到当前项目', 'info');
  }

  getAgent(): ChatAgentHandle | null { return this.agent; }
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
    // Only summon if not already in panel/hud mode — avoids GSAP conflict with
    // the DOM mutations from sendMessage (bubble render, tool cards, etc.)
    const alreadyOpen = this.mode === 'panel' || this.mode === 'hud';
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

  /** Render a permission request inline in the chat — no modal, no outside-click-to-deny.
   *  ponytail: serialises concurrent Ask requests — only one card shown at a time.
   *  Subsequent callers queue behind the active card, preventing card-stacking flicker
   *  when parent + sub-agent both trigger permission dialogs simultaneously.
   *  ⚡ Refactored: queue managed by ExecutionState.enqueuePerm() */

  showPermissionCard(
    toolName: string,
    reason: string,
    subject: string,
  ): Promise<{ allow: boolean; remember: boolean }> {
    // Ensure panel is open
    if (this.mode !== 'panel') {
      Anim.killPanelTweens(this._animCtx());
      Anim.summonPanel(this._animCtx());
    }
    // ⚡ Serialise via execState queue — prevents stacking + properly resets on abort (R5 fix)
    return execState.enqueuePerm(() =>
      new Promise<{ allow: boolean; remember: boolean }>((resolve) => {
        // Wrap resolve so we can clean up the message from the array
        const wrappedResolve = (result: { allow: boolean; remember: boolean }) => {
          // Remove the permission message from the array
          const idx = this.messages.findIndex(
            (m) => m.role === 'perm' && (m as PermissionMessage).toolName === toolName
          );
          if (idx >= 0) this.messages.splice(idx, 1);
          resolve(result);
          this._updateStopButton();
          this._syncMessagesToDOM();
        };
        // Push permission message into model — renderer handles the rest
        this.messages.push(createPermissionMessage(toolName, reason, subject, wrappedResolve));
        this._syncMessagesToDOM();
        this._userScrolledUp = false;
        this.scrollBottom();
      })
    );
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
    Dom.switchTab(this._domCtx(), tab);
  }

  // ── Agent status bar ──

  private _updateStatusBar(state: 'idle' | 'thinking' | 'running' | 'error', detail?: string): void {
    Dom._updateStatusBar(this._domCtx(), state, detail);
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
      panel: this.panel,
      msgList: this.msgList,
      sessionTabs: this.sessionTabs,
      tabBar: this.tabBar,
      getProjectPath: () => this.projectPath,
      agentFactory: Session.getAgentFactory(),
      getMessages: () => this.messages,
      setMessages: (msgs) => { this.messages = msgs; },
      getStreamingAssistantId: () => this._streamingAssistantId,
      setStreamingAssistantId: (id) => { this._streamingAssistantId = id; },
      scrollBottom: () => this.scrollBottom(),
      syncMessagesToDOM: () => this._syncMessagesToDOM(),
      flushReasoning: () => {},
      flushText: () => {},
      clearPendingToolCards: () => {},
      getRunning: () => execState.isRunning,
      abort: () => this.abort(),
      addNotice: (text, level) => this.addNotice(text, level as 'info' | 'warn' | 'error'),
      updateFooter: () => this.updateFooter(),
      reWireHandlers: () => this._reWireHandlers(),
      getTotalTokensUsed: () => this.totalTokensUsed,
      setTotalTokensUsed: (n) => { this.totalTokensUsed = n; },
      clearToolUsage: () => { this.toolUsage.clear(); },
      clearToolHistory: () => { this.toolHistory = []; },
      getLastUsageText: () => this.lastUsageText,
      setLastUsageText: (s) => { this.lastUsageText = s; },
      getLastAgentDiag: () => this.lastAgentDiag,
      clearInputHistory: () => { this.inputHistory = []; this.historyIdx = 0; this.draftText = ''; },
      getStarGraph: () => this.starGraph,
    };
  }

  /** Build AnimContext bridge for extracted animation functions. */
  private _animCtx(): Anim.AnimContext {
    return {
      panel: this.panel,
      msgList: this.msgList,
      inputArea: this.inputArea,
      getMode: () => this.mode,
      setMode: (m) => { this.mode = m; },
      getRunning: () => execState.isRunning,
      getProjectPath: () => this.projectPath,
      getActiveIdx: () => Session.getActiveIdx(),
      updateFooter: () => this.updateFooter(),
      scrollBottom: () => this.scrollBottom(),
      resetPillBadge: () => this._resetPillBadge(),
      closeHistory: () => this.closeHistory(),
      hideSlashPanel: () => this._hideSlashPanel(),
      saveActiveSession: (p) => this.saveActiveSession(p),
    };
  }

  /** Build DomContext bridge for extracted DOM construction functions. */
  private _domCtx(): Dom.DomContext {
    return {
      container: this.container,
      getMode: () => this.mode,
      getAgent: () => this.agent,
      getStarGraph: () => this.starGraph,
      getMessages: () => this.messages,
      getProjectPath: () => this.projectPath,
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
      running: execState.isRunning,
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
      getMsgList: () => this.msgList,
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
      _toolSchemas: this._toolSchemas,
      toolUsage: this.toolUsage,
      toolHistory: this.toolHistory,
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
      getUserScrolledUp: () => this._userScrolledUp,
      setUserScrolledUp: (v) => { this._userScrolledUp = v; },
      scrollBottom: () => this.scrollBottom(),
      hintText: () => this.hintText(),
      refreshHint: () => this.refreshHint(),
      getLastAgentDiag: () => this.lastAgentDiag,
      // State
      _lastAgentState: this._lastAgentState,
      lastUsageText: this.lastUsageText,
      totalTokensUsed: this.totalTokensUsed,
      _expandedReasoning: this._expandedReasoning,
      _activeTab: this._activeTab,
      attachedFiles: this.attachedFiles,
      historyPanel: this.historyPanel,
      setHistoryPanel: (el) => { this.historyPanel = el; },
      historyOpen: this.historyOpen,
      setHistoryOpen: (v) => { this.historyOpen = v; },
      toolCategory: (name) => ChatPanel.toolCategory(name),
      reWireHandlers: () => this._reWireHandlers(),
      // Session persistence callbacks
      listSavedSessions: (p) => this.listSavedSessions(p),
      loadSessionFromDisk: (p, id) => this.loadSessionFromDisk(p, id),
      deleteSessionFile: (p, id) => this.deleteSessionFile(p, id),
    };
  }

  /** Build StreamContext bridge for extracted stream rendering functions. */
  private _streamCtx(): Stream.StreamContext {
    return {
      msgList: this.msgList,
      inputArea: this.inputArea,
      getMessages: () => this.messages,
      setMessages: (msgs) => { this.messages = msgs; },
      getStreamingAssistantId: () => this._streamingAssistantId,
      setStreamingAssistantId: (id) => { this._streamingAssistantId = id; },
      getUserScrolledUp: () => this._userScrolledUp,
      setUserScrolledUp: (v) => { this._userScrolledUp = v; },
      getSyncRafId: () => this._syncRafId,
      setSyncRafId: (id) => { this._syncRafId = id; },
      getTurnPairs: () => Session.getTurnPairs(),
      getAgent: () => this.agent,
      getStarGraph: () => this.starGraph,
      updateFooter: () => this.updateFooter(),
      setLastUsageText: (s) => { this.lastUsageText = s; },
      addNotice: (text, level) => this.addNotice(text, level as 'info' | 'warn' | 'error'),
      saveActiveSession: (p) => this.saveActiveSession(p),
      bumpPillBadge: () => this._bumpPillBadge(),
      injectCodeBlockButtons: (b) => this.injectCodeBlockButtons(b),
      animateBubbleIn: (el, delay) => this.animateBubbleIn(el, delay),
      linkifyNodeNames: () => this.linkifyNodeNames(),
      setRunning: (_r: boolean) => { /* migrated to execState */ },
      abort: () => this.abort(),
      _updateStatusBar: (s, d) => this._updateStatusBar(s, d),
      _recordToolUsage: (n, a) => this._recordToolUsage(n, a),
      _retractUserMessage: (m) => this._retractUserMessage(m),
      retractTurn: (i) => this.retractTurn(i),
      sendMessage: () => this.sendMessage(),
      _upsertToolPart: (...args) => this._upsertToolPart(...args),
      _updateTokens: (n) => this._updateTokens(n),
      getProjectPath: () => this.projectPath,
      getRunning: () => execState.isRunning,
      getAbortCtrl: () => execState.abortSignal ? { signal: execState.abortSignal } as AbortController : null,
      setAbortCtrl: (_c: any) => { /* managed by execState */ },
      getExpandedReasoning: () => this._expandedReasoning,
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

  // ── DOM event re-wiring (delegated to chat-dom.ts) ──

  private _reWireHandlers(): void {
    Dom._reWireHandlers(this._domCtx());
  }

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
    // 先中止当前运行 — abort() 已包含安全超时，不强制 running=false
    // （强制设 false 会导致旧 run 还在执行时新消息就能发送，污染会话）
    if (execState.isRunning) {
      this.abort();
    }
    // Clear message list UI and accumulated state
    this.agent.newSession(); // 递增 sessionGen，旧 run 检测到 gen 变化自动丢弃
    this.messages = [];
    resetMsgIdCounter();
    this._streamingAssistantId = null;
    this.msgList.innerHTML = '';
    this.inputHistory = [];
    this.historyIdx = 0;
    this.draftText = '';
    Session.setTurnPairs([]);
    this.totalTokensUsed = 0;
    Session.syncActiveSessionTokens(0);
    this.addNotice('已开启新会话 — 上下文已清空', 'info');
    this.finishTurn();
    this.updateFooter();
  }

  /** Send an instruction to the agent, optionally showing a user bubble.
   *  @param text The instruction sent to the agent
   *  @param displayLabel If set, shows this as a user bubble (for slash commands) */
  private sendAgentText(text: string, displayLabel?: string): void {
    if (!this.agent || execState.isRunning) return;
    const signal = execState.start();

    // Reset auto-scroll for this new turn
    this._userScrolledUp = false;

    const hint = this.msgList.querySelector('.chat-hint');
    if (hint) hint.remove();

    if (displayLabel) {
      Session.getTurnPairs().push({ userText: displayLabel, userBubble: null, assistantBubble: null, sessionIndex: this.agent.nextInsertIndex });
      this.appendUserBubble(displayLabel);
    }
    this.scrollBottom();

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
      execState.done();
      this.finishTurn();
      bus.emit('chat:turn-done', {});
    });
  }

  /** Run a goal autonomously — Agent keeps going until done or failed.
   *  ponytail: same UI scaffolding as sendAgentText, but calls runGoal instead of run. */
  private runGoal(goal: string): void {
    if (!this.agent || execState.isRunning) return;
    const signal = execState.start();
    this._userScrolledUp = false;

    const hint = this.msgList.querySelector('.chat-hint');
    if (hint) hint.remove();

    Session.getTurnPairs().push({ userText: `/goal ${goal}`, userBubble: null, assistantBubble: null, sessionIndex: this.agent.nextInsertIndex });
    this.appendUserBubble(`🎯 ${goal}`);

    this.scrollBottom();

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
      execState.done();
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
        ? `${this.lastAgentDiag} (factory:${Session.getAgentFactory() ? 'yes' : 'NO'})`
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
    if (execState.isRunning) {
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
      Session.getTurnPairs().push({ userText: text, userBubble: null, assistantBubble: null, sessionIndex: sessIdx });
      this.appendUserBubble(text);
      this.scrollBottom();
      return;
    }

    // Auto-label session on first user message
    if (Session.getActiveIdx() >= 0) {
      const session = Session.getSessions()[Session.getActiveIdx()];
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
    const signal = execState.start();

    // Remove hint if present
    const hint = this.msgList.querySelector('.chat-hint');
    if (hint) hint.remove();

    // Turn pair for retry (item 4) — sessionIndex is where user msg will land
    const sessIdx = this.agent.getSession().length;
    Session.getTurnPairs().push({ userText: text, userBubble: null, assistantBubble: null, sessionIndex: sessIdx });

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
      execState.done();
      this.finishTurn();
    }
    // Signal main.ts to persist sessions
    bus.emit('chat:turn-done', {});
  }

  private abort(): void {
    if (!execState.isRunning) return;
    
    // ⚡ 统一状态管理：停止主Agent + 级联子Agent + 清权限队列
    execState.stop();
    this.agent?.cascadeAbort(); // agent-specific cleanup (isolation worktrees, etc.)
    
    // DOM-specific cleanup (execState doesn't own UI)
    this.inputArea.disabled = false;
    this.inputArea.placeholder = '输入消息… (Enter 发送, Shift+Enter 换行)';
    this.addNotice('正在中止…', 'info');
    
    // 安全超时：3 秒内若 Agent 没响应，强制复位
    const safety = setTimeout(() => {
      if (execState.isRunning) {
        execState.forceReset();
        this.finishTurn();
        this.addNotice('已强制中止（超时）', 'warn');
      }
    }, 3000);
    // 如果 Agent 正常响应了，取消安全超时
    const poll = setInterval(() => {
      if (!execState.isBusy) {
        clearTimeout(safety);
        clearInterval(poll);
      }
    }, 200);
    this._updateStopButton();
  }

  /** Is ANY agent (main or sub) currently working? Delegates to ExecutionState. */
  private _isBusy(): boolean {
    return execState.isBusy;
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
  private _appendReasoningPart(text: string): void { Stream._appendReasoningPart(this._streamCtx(), text); }

  /** Append streaming text — merges into the last text part if one exists. */
  private _appendTextPart(text: string): void { Stream._appendTextPart(this._streamCtx(), text); }

  /** Mark the last text part as finalised (streaming text is complete for this step). */
  private _finaliseTextPart(): void { Stream._finaliseTextPart(this._streamCtx()); }

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

  /** Build the renderer callback bag — resolves user text, handles edit/resend. */
  private _renderCallbacks(): RenderCallbacks { return Stream._renderCallbacks(this._streamCtx()); }

  /** Re-render a single message at the given index (in-place DOM replace). */
  private _rerenderMessageAt(index: number): void { Stream._rerenderMessageAt(this._streamCtx(), index); }

  /** Full sync: rebuild DOM from messages[]. Efficient for streaming (only last changes). */
  private _syncMessagesToDOM(): void { Stream._syncMessagesToDOM(this._streamCtx()); }

  private _doSyncMessagesToDOM(): void { Stream._doSyncMessagesToDOM(this._streamCtx()); }

  // ── Throttled rAF sync — avoids O(n²) re-render on high-frequency streams ──
  private _scheduleSync(): void { Stream._scheduleSync(this._streamCtx()); }

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

  private scrollBottom(): void { Stream.scrollBottom(this._streamCtx()); }

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
      this.scrollBottom();
      this.addNotice('正在压缩上下文…', 'info');
      const ctrl = new AbortController();
      this.agent.compactNow(ctrl.signal).then(() => {
        this.messages = [];
        resetMsgIdCounter();
        this._streamingAssistantId = null;
        this.msgList.innerHTML = '';
        Session._rebuildMessagesFromSession(this._sessionCtx());
        this._syncMessagesToDOM();
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
    this._bumpPillBadge();

    const subEl = document.createElement('div');
    subEl.className = 'msg-sub-agent';
    subEl.dataset['subId'] = data.id;
    subEl.dataset['startedAt'] = String(Date.now());
    subEl.dataset['mode'] = data.mode;
    subEl.title = `${data.description} · ${data.mode === 'fork' ? '继承上下文' : '独立'} · 运行中…`;
    subEl.innerHTML = `
      <div class="msg-sub-agent-header">
        ${iconHtml('puzzle', 12)} 子 Agent: ${escapeHtml(data.description)}
        <span class="sub-agent-mode">${data.mode === 'fork' ? '继承上下文' : '独立'}</span>
        <span class="sub-agent-status">⚡ 运行中</span>
      </div>
      <div class="msg-sub-agent-body open"></div>`;
    this.msgList.appendChild(subEl);
    this.scrollBottom();
  }

  private handleSubProgress(data: { parentToolId: string; text: string }): void {
    // Search globally — sub-agent events arrive asynchronously, currentBubble may have changed
    const subEl = this.msgList.querySelector(`[data-sub-id="${data.parentToolId}"]`) as HTMLElement;
    if (!subEl) return;
    const body = subEl.querySelector('.msg-sub-agent-body');
    if (body) {
      body.textContent += data.text;
      body.scrollTop = body.scrollHeight;
    }
    // Update status hover
    const status = subEl.querySelector('.sub-agent-status') as HTMLElement;
    if (status) {
      const lines = (body?.textContent || '').split('\n').filter(l => l.trim()).length;
      const started = Number(subEl.dataset['startedAt']) || Date.now();
      const elapsed = Math.round((Date.now() - started) / 1000);
      subEl.title = `${subEl.dataset['mode'] || 'fork'} · ${lines} 行输出 · ${elapsed}s`;
    }
  }

  private handleSubDone(data: { parentToolId: string; summary: any }): void {
    // Search globally — sub-agent completes asynchronously
    const subEl = this.msgList.querySelector(`[data-sub-id="${data.parentToolId}"]`) as HTMLElement;
    if (!subEl) return;
    const body = subEl.querySelector('.msg-sub-agent-body') as HTMLElement;
    const status = subEl.querySelector('.sub-agent-status') as HTMLElement;
    const header = subEl.querySelector('.msg-sub-agent-header') as HTMLElement;
    if (body) body.classList.remove('open');
    this._bumpPillBadge();
    this._updateStopButton(); // sub-agent done → may need to hide stop btn

    // Update status indicator + hover
    const icon = data.summary?.hasError ? '❌' : '✅';
    const elapsed = data.summary?.elapsedMs
      ? (data.summary.elapsedMs / 1000).toFixed(1) + 's'
      : '';
    if (status) status.innerHTML = `${icon} 完成 · ${elapsed}`;
    if (body) {
      const lines = (body.textContent || '').split('\n').filter(l => l.trim()).length;
      subEl.title = `${data.summary?.description || ''} · ${icon} · ${lines} 行输出 · ${elapsed}`;
    }

    // Prepend summary bar WITHOUT destroying body (preserves body reference for toggle)
    const summaryBar = document.createElement('div');
    summaryBar.className = 'msg-sub-agent-summary';
    summaryBar.innerHTML =
      `${iconHtml('puzzle', 12)} 子 Agent 完成 · ${data.summary?.steps || '?'} 步 · ${elapsed}` +
      `${data.summary?.hasError ? ` · ${iconHtml('alert', 10)} 有错误` : ''}` +
      ` · <button class="pre-code-btn" style="display:inline">${body?.style.display === 'none' ? '展开输出' : '收起输出'}</button>`;

    // Toggle: show/hide body, flip button text
    const toggleBtn = summaryBar.querySelector('button');
    toggleBtn?.addEventListener('click', () => {
      if (!body) return;
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      (toggleBtn as HTMLElement).textContent = hidden ? '收起输出' : '展开输出';
    });

    // Insert summary before body
    subEl.insertBefore(summaryBar, body);
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

  // ── Sink getter (used by main.ts to wire Agent) ──

  get sink() {
    return (ev: AgentEvent) => this.renderEvent(ev);
  }
}