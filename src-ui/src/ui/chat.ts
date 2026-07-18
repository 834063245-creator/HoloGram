// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Panel — 聊天面板 UI
// 纯 DOM 渲染，EventSink → 消息气泡 / 工具卡片 / 思考折叠
// Agent 引擎 (agent.ts) 已完整，此文件只管"把事件画到屏幕上"

import type gsap from 'gsap';
import hljs from 'highlight.js';
import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { ChatAgentHandle, GoalRunResult } from '../agent/chat-agent-handle';
import { createExecState, type ExecStateInstance } from '../agent/execution-state';
import { GoalManager, type GoalRecord } from '../agent/goal-manager';
import { rpc } from '../bridge';
import type { ToolSchema } from '../provider/types';
import { loadSettings, saveSettings } from '../settings';
// ── Extracted animations (GSAP-powered panel mode morphing) ──
import * as Anim from './chat-anim';
// ── Extracted DOM construction and event wiring ──
import * as Dom from './chat-dom';
// ── Extracted session management (CRUD, persistence, restore) ──
import * as Session from './chat-session';
import { stripLineNumbers } from './chat-session';
import {
  bumpChat,
  bumpSession,
  getChatStore,
  getExpandedReasoningSet,
  getStreamingAssistantId,
  getUserScrolledUp,
  msgStoreFor,
  msgStoreForActive,
} from './chat-store';
// ── Extracted stream rendering (Agent events → DOM messages) ──
import * as Stream from './chat-stream';
import { type CommandDef, CommandRegistry, DEFAULT_COMMANDS } from './command-registry';
import { bus } from './events';
import type { StarGraph } from './graph';
// ── New message model (data-driven render) ──
import {
  type AssistantMessage,
  type AssistantPart,
  type ChatMessage,
  createAssistantMessage,
  createNoticeMessage,
  createUserMessage,
  type FileAttachment,
  type MessageId,
  nextMsgId,
  resetMsgIdCounter,
  type UserMessage,
} from './message-model';
import { AtAutocompleteController } from './react/AtAutocomplete';
import { FooterController } from './react/ChatFooter';
import { ChatHintController } from './react/ChatHint';
import { ChatMessagesPanel } from './react/ChatMessages';
import { type AskPrompt, type PermissionPrompt, PromptShelfController } from './react/PromptShelf';
import { SlashPanelController } from './react/SlashPanel';

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
  private headerEl!: HTMLElement;
  private sessionTabs!: HTMLElement;

  // Session state (managed by chat-session.ts)
  // Access via Session.getSessions(), Session.getActiveIdx(), etc.

  // ⚡ userFocusFile / userFocusNode → chat-store.ts

  // Execution state — per-panel instance (phase 1 of multi-window)
  private _exec: ExecStateInstance;

  // Streaming state
  private starGraph: StarGraph | null = null;

  // ── New: data-driven message model — reads/writes per-session store ──
  // ponytail: no panel-level messages array. Each session owns its messages-store
  // instance. React subscribes to the active session's store directly.
  private get messages(): ChatMessage[] {
    const store = msgStoreForActive(this.panelId);
    return store?.getState().messages ?? [];
  }
  private set messages(msgs: ChatMessage[]) {
    const store = msgStoreForActive(this.panelId);
    if (store) store.getState().setMessages(msgs);
  }
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
  private _onTrailToggle: (() => void) | null = null;

  // ⚡ pillEventCount / lastAgentState → chat-store.ts
  private pillBadge!: HTMLElement;

  // ── Slash panel (React-based) ──
  private _slashController: SlashPanelController | null = null;

  // ── Footer (React-based) ──
  private _footerController!: FooterController;

  // ── @ autocomplete (React-based) ──
  private _atAutocomplete!: AtAutocompleteController;

  // ── Hint (React-based) ──
  private _chatHint!: ChatHintController;

  // ── Messages (React-based) ──
  private _chatMessages: ChatMessagesPanel | null = null;

  // ── Goal status strip ──
  private _goalStrip: HTMLElement | null = null;
  private _goalStripRecord: GoalRecord | null = null;

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

  setToolSchemas(schemas: ToolSchema[]): void {
    getChatStore(this.panelId).panel.getState().setToolSchemas(schemas);
  }

  setOnOpenSettings(fn: () => void): void {
    this.onOpenSettings = fn;
  }
  setOnTrailToggle(fn: () => void): void {
    this._onTrailToggle = fn;
  }

  /** Panel-scoped event sink for agent events — prevents cross-panel leaks. */
  get eventSink(): (ev: AgentEvent) => void {
    return (ev: AgentEvent) => this._bus.emit('agent:event', ev);
  }
  /** Panel-scoped event sink for agent progress. */
  get progressSink(): (data: { step: number; toolName: string }) => void {
    return (data: { step: number; toolName: string }) => this._bus.emit('agent:progress', data);
  }
  setAgentFactory(fn: () => Promise<ChatAgentHandle | null>): void {
    Session.setAgentFactory(this.panelId, fn);
  }

  constructor(container: HTMLElement) {
    this.container = container;
    this.panelId = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this._bus = bus.withPrefix(`p:${this.panelId}:`);
    this._exec = createExecState();
    this.buildDOM();
    this._initSlashPanel();
    this._initFooter();
    this._initAtAutocomplete();
    this._initChatHint();

    // ⚡ React-based message list — own container, shared messages array
    const reactRoot = document.createElement('div');
    reactRoot.className = 'chat-messages';
    this.msgList.style.display = 'none';
    this.msgList.parentElement?.insertBefore(reactRoot, this.msgList);
    // ── Goal status strip — 目标状态条(消息列表上方,goal:state 驱动显隐) ──
    this._goalStrip = this._buildGoalStrip();
    this.msgList.parentElement?.insertBefore(this._goalStrip, reactRoot);
    this._chatMessages = new ChatMessagesPanel(reactRoot, this.panelId);
    this._chatMessages.setCallbacks({
      onCopyText: (text) => navigator.clipboard.writeText(text).catch(() => {}),
      onNavigateToNode: (nodeName) => {
        if (this.starGraph) this.starGraph.focusNode(nodeName);
      },
      onEditUserMessage: (msg) => {
        if (this._activeExec().isRunning) {
          this.addNotice('Agent 正在运行，请先停止再编辑', 'warn');
          return;
        }
        this.inputArea.value = msg.text;
        this.inputArea.style.height = 'auto';
        this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
        this.inputArea.focus();
        this.inputArea.selectionStart = this.inputArea.selectionEnd = msg.text.length;
        this._retractUserMessage(msg);
      },
      onResendUserMessage: (msg) => {
        if (this._activeExec().isRunning) {
          this.addNotice('Agent 正在运行，请先停止再重发', 'warn');
          return;
        }
        this.inputArea.value = msg.text;
        this._retractUserMessage(msg);
        this.sendMessage();
      },
      onRetryAssistant: (assistant) => {
        if (this._activeExec().isRunning) {
          this.addNotice('Agent 正在运行，请先停止再重试', 'warn');
          return;
        }
        const userMsg = this.messages.find((m) => m.role === 'user' && m._id === assistant.respondingTo);
        const userText = userMsg && 'text' in userMsg ? ((userMsg as any).text as string) : '';
        if (!userText) return;
        this.inputArea.value = '';
        const signal = this._activeExec().start();
        Stream.addTurnSep(this._streamCtx());
        const agent = this.agent;
        if (!agent) return;
        const sessIdx = agent.getSession().length;
        Session.getTurnPairs(this.panelId).push({
          userText,
          userBubble: null,
          assistantBubble: null,
          sessionIndex: sessIdx,
        });
        {
          const sessStore = getChatStore(this.panelId).sess.getState();
          const activeSid = sessStore.sessions[sessStore.activeIdx]?.id;
          if (activeSid != null) Stream.setPendingStreamingSession(this.panelId, activeSid);
        }
        agent
          .run(signal, userText)
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
    bus.on(
      'prompt:ask',
      (data: {
        id: string;
        question: string;
        header: string;
        options: { label: string; description: string }[];
        multiSelect: boolean;
        callback: (answer: string[] | null) => void;
      }) => {
        if (!this._promptShelf) {
          data.callback(null);
          return;
        }
        this._promptShelf
          .showAsk({
            type: 'ask',
            id: data.id,
            question: data.question,
            header: data.header,
            options: data.options,
            multiSelect: data.multiSelect,
          })
          .then(data.callback);
      },
    );
    // ── Track user focus — file viewer / file tree / graph selection ──
    bus.on('highlight:file', (filePath: string) => {
      getChatStore(this.panelId).panel.setState({ userFocusFile: filePath, userFocusNode: null });
    });
    bus.on('navigate:file', (filePath: string) => {
      getChatStore(this.panelId).panel.setState({ userFocusFile: filePath, userFocusNode: null });
    });
    bus.on(
      'graph:node-clicked',
      (data: { nodeName: string; nodeType: string; nodeId: string; degree: number; location: string }) => {
        getChatStore(this.panelId).panel.setState({
          userFocusNode: { name: data.nodeName, location: data.location || undefined },
          userFocusFile: null,
        });
      },
    );
    // Feed visible node names to @ autocomplete after every full render
    bus.on('graph:rendered', () => {
      if (this.starGraph) this._atAutocomplete?.setNodeNames(this.starGraph.getNodeNames());
    });
    // ── Listen for Agent diagnostics so we can show WHY agent isn't ready ──
    bus.on('agent:diag', (d: { text: string; ready: boolean }) => {
      getChatStore(this.panelId).panel.setState({ lastAgentDiag: d.text });
    });
    // ── Goal strip:状态迁移驱动显隐;切换工作区后重载 ──
    bus.on('goal:state', (record: GoalRecord) => this._updateGoalStrip(record));
    bus.on('workspace:switched', () => this._refreshGoalStrip());
    this._refreshGoalStrip();
    // ⚡ ExecutionState → UI sync: subscribe to active session's execState, re-bind on session switch
    let _execUnsub: (() => void) | null = null;
    const _onExecChange = (exec: ExecStateInstance) => {
      this._updateStopButton();
      if (exec.isRunning) {
        this.inputArea.placeholder = 'Agent 思考中… 可直接输入消息插入对话';
        this._updateStatusBar('thinking', '分析中…');
      } else {
        this.inputArea.placeholder = '输入消息… (Enter 发送, Shift+Enter 换行)';
        this.inputArea.focus();
        this._updateStatusBar('idle');
        this._promptShelf?.dismiss(); // ⚡ dismiss ask/permission on stop
        this.panel.classList.remove('chat-pill-running');
      }
    };
    const _bindExecState = () => {
      if (_execUnsub) {
        _execUnsub();
        _execUnsub = null;
      }
      const exec = this._activeExec();
      _execUnsub = exec.onChange(() => _onExecChange(exec));
      _onExecChange(exec); // initial sync
    };
    _bindExecState();
    // Re-bind when user switches active session
    getChatStore(this.panelId).sess.subscribe(() => _bindExecState());
    // ── Detect graph interaction to auto-dismiss the panel ──
    // ── Receive Agent events via panel-scoped bus — prevents cross-panel leaks ──
    this._bus.on('agent:event', (ev: AgentEvent) => this.renderEvent(ev));
    this.setupGraphClickHandler();
    // ── Drag-and-drop files onto the chat panel ──
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

  // ── Public API ──

  private get agent(): ChatAgentHandle | null {
    return Session.getActiveAgent(this.panelId);
  }

  /** Active session's execution state (per-session isolation). */
  private _activeExec(): ExecStateInstance {
    const s = getChatStore(this.panelId).sess.getState();
    const sid = s.sessions[s.activeIdx]?.id;
    return sid ? Session.getSessionExecState(this.panelId, sid) : this._exec;
  }

  setAgent(agent: ChatAgentHandle | null): void {
    if (!agent) return;
    // Replace all sessions — setAgent is boot/setup, not session management.
    // ponytail: clear old sessions (including placeholder) so the workspace
    // switch always lands on the fresh agent. Old stale sessions caused the
    // agent to answer with "当前没有加载项目" after a project was loaded.
    Session.resetSessionState(this.panelId, agent);
    getChatStore(this.panelId).panel.getState().setTotalTokensUsed(0);
    Session.syncActiveSessionTokens(this.panelId, 0);
    getChatStore(this.panelId).panel.getState().clearToolUsage();
    getChatStore(this.panelId).panel.getState().clearToolHistory();
    this.renderSessionTabs();
    this.messages = [];
    resetMsgIdCounter(this.panelId);
    getChatStore(this.panelId).msg.getState().setStreamingAssistantId(null);
    this.msgList.innerHTML = '';
    this.addNotice('已连接到当前项目', 'info');
  }

  getAgent(): ChatAgentHandle | null {
    return this.agent;
  }
  setStarGraph(g: StarGraph): void {
    this.starGraph = g;
  }
  setProjectPath(p: string): void {
    // ponytail: clear user focus when project changes — stale node/file refs
    // from the old workspace would misdirect the agent's tool calls.
    if (p && p !== getChatStore(this.panelId).panel.getState().projectPath) {
      getChatStore(this.panelId).panel.setState({ userFocusFile: null, userFocusNode: null });
    }
    getChatStore(this.panelId).panel.setState({ projectPath: p });
  }

  toggle(): void {
    switch (getChatStore(this.panelId).panel.getState().panelMode) {
      case 'pill':
        this.summonPanel();
        break;
      case 'input':
        this.summonPanel();
        break;
      case 'panel':
        this.collapseToInput();
        break;
      case 'hud':
        this.restoreFromHud();
        break;
    }
  }

  open(): void {
    this.summonPanel();
  }

  /** Programmatically ask the agent a question. Summons panel and sends. */
  ask(question: string): void {
    // Only summon if not already in panel/hud mode — avoids GSAP conflict with
    // the DOM mutations from sendMessage (bubble render, tool cards, etc.)
    const alreadyOpen =
      getChatStore(this.panelId).panel.getState().panelMode == 'panel' ||
      getChatStore(this.panelId).panel.getState().panelMode == 'hud';
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
    danger?: string,
  ): Promise<{ allow: boolean; remember: boolean }> {
    // Ensure panel is open
    if (getChatStore(this.panelId).panel.getState().panelMode !== 'panel') {
      Anim.killPanelTweens(this._animCtx());
      Anim.summonPanel(this._animCtx());
    }
    // ⚡ Use PromptShelf instead of inline message
    if (!this._promptShelf) {
      return Promise.resolve({ allow: false, remember: false });
    }
    return this._activeExec().enqueuePerm(() =>
      this._promptShelf!.showPermission({
        type: 'permission',
        id: `perm-${toolName}-${Date.now()}`,
        toolName,
        reason,
        subject: subject || '',
        danger,
      }),
    );
  }

  close(): void {
    // Panel/HUD → input; input → pill
    if (
      getChatStore(this.panelId).panel.getState().panelMode == 'panel' ||
      getChatStore(this.panelId).panel.getState().panelMode == 'hud'
    ) {
      this.collapseToInput();
    } else if (getChatStore(this.panelId).panel.getState().panelMode == 'input') {
      this.collapseToPill();
    }
  }

  isOpen(): boolean {
    return (
      getChatStore(this.panelId).panel.getState().panelMode == 'panel' ||
      getChatStore(this.panelId).panel.getState().panelMode == 'hud'
    );
  }

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
    getChatStore(this.panelId).panel.getState().addToolUsage(toolName, args);
    // Update badge on tools tab
    const toolsTab = this.tabBar.querySelector('[data-tab="tools"]') as HTMLElement;
    if (toolsTab) {
      const usage = getChatStore(this.panelId).panel.getState().toolUsage;
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
        'explore_deps',
        'search_symbols',
        'get_neighbors',
        'trace_impact',
        'find_dep_path',
        'inspect_symbol',
        'symbol_history',
        'get_community',
        'cluster_report',
        'async_edges',
        'fragile_modules',
        'detect_cycles',
        'thread_conflicts',
        'coupling_report',
        'project_timeline',
        'arch_blindspots',
        'graph_summary',
        'graph_diff',
        'analyze_project',
        'preflight_check',
        'validate_project',
        'project_health',
        'rename_symbol',
        'engine_status',
        'check_boundaries',
        'find_unused',
        'trace_dataflow',
        'resolve_call',
        'infer_type',
        'find_implementations',
        'find_references',
        'dataflow_save',
        'dataflow_query',
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
    const storeId = this.panelId;
    return {
      storeId,
      panel: this.panel,
      sessionTabs: this.sessionTabs,
      tabBar: this.tabBar,
      getProjectPath: () => getChatStore(storeId).panel.getState().projectPath,
      // ponytail: messages in per-session stores — no ctx.getMessages() needed
      flushReasoning: () => {},
      flushText: () => {},
      clearPendingToolCards: () => {},
      getRunning: () => this._activeExec().isRunning,
      abort: () => this.abort(),
      addNotice: (text, level) => this.addNotice(text, level as 'info' | 'warn' | 'error'),
      updateFooter: () => this.updateFooter(),
      getTotalTokensUsed: () => getChatStore(storeId).panel.getState().totalTokensUsed,
      setTotalTokensUsed: (n) => {
        getChatStore(storeId).panel.getState().setTotalTokensUsed(n);
      },
      clearToolUsage: () => {
        getChatStore(storeId).panel.getState().clearToolUsage();
      },
      clearToolHistory: () => {
        getChatStore(storeId).panel.getState().clearToolHistory();
      },
      getLastUsageText: () => getChatStore(storeId).panel.getState().lastUsageText,
      setLastUsageText: (s) => {
        getChatStore(storeId).panel.setState({ lastUsageText: s });
      },
      getLastAgentDiag: () => getChatStore(storeId).panel.getState().lastAgentDiag,
      clearInputHistory: () => {
        const s = getChatStore(storeId).input.getState();
        s.setInputHistory([]);
        s.setInputHistoryIdx(-1);
        s.setDraftText('');
      },
      getStarGraph: () => this.starGraph,
    };
  }

  /** Build AnimContext bridge for extracted animation functions. */
  private _animCtx(): Anim.AnimContext {
    return {
      panel: this.panel,
      requestFocus: () => {
        this.inputArea.focus();
      },
      getMode: () => getChatStore(this.panelId).panel.getState().panelMode,
      setMode: (m) => {
        getChatStore(this.panelId).panel.getState().setPanelMode(m);
      },
      getRunning: () => this._activeExec().isRunning,
      execState: this._exec,
      getProjectPath: () => getChatStore(this.panelId).panel.getState().projectPath,
      getActiveIdx: () => Session.getActiveIdx(this.panelId),
      updateFooter: () => this.updateFooter(),
      resetPillBadge: () => this._resetPillBadge(),
      closeHistory: () => this.closeHistory(),
      hideSlashPanel: () => this._hideSlashPanel(),
      saveActiveSession: (p) => this.saveActiveSession(p),
      scheduleAutoSave: (p) => Session.scheduleAutoSave(this._sessionCtx(), p),
    };
  }

  /** Build DomContext bridge for extracted DOM construction functions. */
  private _domCtx(): Dom.DomContext {
    const self = this; // ponytail: captured for getters — getter `this` is ctx object, not ChatPanel
    return {
      panelId: this.panelId,
      container: this.container,
      getMode: () => getChatStore(this.panelId).panel.getState().panelMode,
      getAgent: () => this.agent,
      getStarGraph: () => this.starGraph,
      getMessages: () => this.messages,
      getProjectPath: () => getChatStore(this.panelId).panel.getState().projectPath,
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
      // ponytail: getters — live reads, not snapshots
      get running() {
        return self._activeExec().isRunning;
      },
      // DOM element setters
      setPanel: (el) => {
        this.panel = el;
      },
      setMsgList: (el) => {
        this.msgList = el;
      },
      setInputArea: (el) => {
        this.inputArea = el;
      },
      setSendBtn: (el) => {
        this.sendBtn = el;
      },
      setStopBtn: (el) => {
        this.stopBtn = el;
      },
      setHeaderEl: (el) => {
        this.headerEl = el;
      },
      setSessionTabs: (el) => {
        this.sessionTabs = el;
      },
      setPillBadge: (el) => {
        this.pillBadge = el;
      },
      setTabBar: (el) => {
        this.tabBar = el;
      },
      setTabContent: (el) => {
        this.tabContent = el;
      },
      setChatPanel: (el) => {
        this.chatPanel = el;
      },
      setToolsPanel: (el) => {
        this.toolsPanel = el;
      },
      setContextPanel: (el) => {
        this.contextPanel = el;
      },
      setStatusBar: (el) => {
        this.statusBar = el;
      },
      setStatusDot: (el) => {
        this.statusDot = el;
      },
      setStatusText: (el) => {
        this.statusText = el;
      },
      setStatusTokens: (el) => {
        this.statusTokens = el;
      },
      setAttachPillsEl: (el) => {
        this.attachPillsEl = el;
      },
      setGraphClickCleanup: (fn) => {
        this.graphClickCleanup = fn;
      },
      // DOM getters
      getPanel: () => this.panel,
      getInputArea: () => this.inputArea,
      // Slash panel — migrated to React
      get _slashController() {
        return self._slashController;
      },
      // Settings
      get onOpenSettings() {
        return self.onOpenSettings;
      },
      get _onTrailToggle() {
        return self._onTrailToggle;
      },
      // Tool — live from Zustand store
      get _toolSchemas() {
        return getChatStore(self.panelId).panel.getState().toolSchemas;
      },
      get toolUsage() {
        return getChatStore(self.panelId).panel.getState().toolUsage;
      },
      get toolHistory() {
        return getChatStore(self.panelId).panel.getState().toolHistory;
      },
      // Input state — routed to input-store (Zustand, per-panel)
      get inputHistory() {
        return getChatStore(self.panelId).input.getState().inputHistory;
      },
      setInputHistory: (h) => {
        getChatStore(self.panelId).input.setState({ inputHistory: h });
      },
      get historyIdx() {
        return getChatStore(self.panelId).input.getState().inputHistoryIdx;
      },
      setHistoryIdx: (n) => {
        getChatStore(self.panelId).input.setState({ inputHistoryIdx: n });
      },
      get draftText() {
        return getChatStore(self.panelId).input.getState().draftText;
      },
      setDraftText: (s) => {
        getChatStore(self.panelId).input.setState({ draftText: s });
      },
      get attachedFiles() {
        return getChatStore(self.panelId).input.getState().attachedFiles;
      },
      addAttachedFile: (f) => {
        getChatStore(self.panelId).input.getState().addAttachedFile(f);
      },
      removeAttachedFile: (idx) => {
        getChatStore(self.panelId).input.getState().removeAttachedFile(idx);
      },
      // Callbacks
      handleAtInput: () => this.handleAtInput(),
      handleSlashInput: () => this.handleSlashInput(),
      hideSlashPanel: () => this._hideSlashPanel(),
      navigateSlashPanel: (dir) => this._navigateSlashPanel(dir),
      selectSlashItem: () => this._selectSlashItem(),
      atNavigate: (d) => this._atNavigate(d),
      atSelect: () => this._atSelect(),
      atOpen: () => this._atOpen,
      expandToInput: () => this.expandToInput(),
      restoreFromHud: () => this.restoreFromHud(),
      fadeToHud: () => this.fadeToHud(),
      collapseToPill: () => this.collapseToPill(),
      toggleReasoning: (btn, content) => this.toggleReasoning(btn, content),
      toggleToolCard: (card) => this.toggleToolCard(card),
      killPanelTweens: () => this.killPanelTweens(),
      setupResize: (handle) => this.setupResize(handle),
      getLastAgentDiag: () => getChatStore(this.panelId).panel.getState().lastAgentDiag,
      // State — live from Zustand store
      get _lastAgentState() {
        return getChatStore(self.panelId).panel.getState().lastAgentState;
      },
      get lastUsageText() {
        return getChatStore(self.panelId).panel.getState().lastUsageText;
      },
      get totalTokensUsed() {
        return getChatStore(self.panelId).panel.getState().totalTokensUsed;
      },
      // ponytail: _expandedReasoning bridges store array→Set; kept snapshot for now since
      // it's only consumed via toggleReasoning callback, not read directly from ctx
      _expandedReasoning: new Set(getChatStore(this.panelId).msg.getState().expandedReasoning),
      get _activeTab() {
        return getChatStore(self.panelId).panel.getState().activeTab;
      },
      get historyPanel() {
        return self.historyPanel;
      },
      setHistoryPanel: (el) => {
        self.historyPanel = el;
      },
      get historyOpen() {
        return self.historyOpen;
      },
      setHistoryOpen: (v) => {
        self.historyOpen = v;
      },
      toolCategory: (name) => ChatPanel.toolCategory(name),
      // Session persistence callbacks
      listSavedSessions: (p) => this.listSavedSessions(p),
      loadSessionFromDisk: (p, id) => this.loadSessionFromDisk(p, id),
      deleteSessionFile: (p, id) => this.deleteSessionFile(p, id),
    };
  }

  /** Build StreamContext bridge for extracted stream rendering functions. */
  private _streamCtx(): Stream.StreamContext {
    const storeId = this.panelId;
    return {
      storeId,
      // ponytail: messages live in per-session stores, not panel-level messages-store
      getSessionMessages: (sid: number) => msgStoreFor(storeId, sid).getState().messages,
      getActiveMessages: () => {
        const s = msgStoreForActive(storeId);
        return s?.getState().messages ?? [];
      },
      setSessionMessages: (sid: number, msgs: ChatMessage[]) => {
        msgStoreFor(storeId, sid).getState().setMessages(msgs);
      },
      bumpSessionMessages: (sid: number) => {
        msgStoreFor(storeId, sid).getState().bump();
      },
      getStreamingAssistantId: () => getStreamingAssistantId(storeId),
      setStreamingAssistantId: (id) => {
        getChatStore(storeId).msg.getState().setStreamingAssistantId(id);
      },
      getUserScrolledUp: () => getUserScrolledUp(storeId),
      setUserScrolledUp: (v) => {
        getChatStore(storeId).msg.getState().setUserScrolledUp(v);
      },
      getSyncRafId: () => this._syncRafId,
      setSyncRafId: (id) => {
        this._syncRafId = id;
      },
      getTurnPairs: () => Session.getTurnPairs(this.panelId),
      getAgent: () => this.agent,
      getStarGraph: () => this.starGraph,
      updateFooter: () => this.updateFooter(),
      setLastUsageText: (s) => {
        getChatStore(storeId).panel.getState().setLastUsageText(s);
      },
      addNotice: (text, level) => this.addNotice(text, level as 'info' | 'warn' | 'error'),
      saveActiveSession: (p) => this.saveActiveSession(p),
      scheduleAutoSave: (p) => Session.scheduleAutoSave(this._sessionCtx(), p),
      bumpPillBadge: () => {
        getChatStore(storeId).panel.getState().bumpPillEventCount();
      },
      animateBubbleIn: (el, delay) => this.animateBubbleIn(el, delay),
      setRunning: (_r: boolean) => {
        /* migrated to execState */
      },
      abort: () => this.abort(),
      _updateStatusBar: (s, d) => this._updateStatusBar(s, d),
      _recordToolUsage: (n, a) => {
        getChatStore(storeId).panel.getState().addToolUsage(n, a);
      },
      _retractUserMessage: (m) => this._retractUserMessage(m),
      retractTurn: (i) => this.retractTurn(i),
      sendMessage: () => this.sendMessage(),
      _updateTokens: (n) => {
        getChatStore(storeId).panel.getState().setTotalTokensUsed(n);
      },
      getProjectPath: () => getChatStore(storeId).panel.getState().projectPath,
      getRunning: () => this._activeExec().isRunning,
      getAbortCtrl: () =>
        this._activeExec().abortSignal ? ({ signal: this._activeExec().abortSignal } as AbortController) : null,
      setAbortCtrl: (_c: any) => {
        /* managed by execState */
      },
      getExpandedReasoning: () => getExpandedReasoningSet(storeId),
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

  private renderSessionTabs(): void {
    Session.renderSessionTabs(this._sessionCtx());
  }
  private switchSession(idx: number): void {
    Session.switchSession(this._sessionCtx(), idx);
  }
  private closeSession(idx: number): void {
    Session.closeSession(this._sessionCtx(), idx);
  }
  private async createNewSession(): Promise<void> {
    return Session.createNewSession(this._sessionCtx());
  }

  // ── Session persistence (delegated to chat-session.ts) ──

  async saveActiveSession(projectPath: string): Promise<void> {
    return Session.saveActiveSession(this._sessionCtx(), projectPath);
  }
  scheduleAutoSave(projectPath: string): void {
    Session.scheduleAutoSave(this._sessionCtx(), projectPath);
  }
  async autoRestoreLastSession(projectPath: string): Promise<void> {
    return Session.autoRestoreLastSession(this._sessionCtx(), projectPath);
  }
  async listSavedSessions(
    projectPath: string,
  ): Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string }>> {
    return Session.listSavedSessions(this._sessionCtx(), projectPath);
  }
  async loadSessionFromDisk(projectPath: string, sessionId: number): Promise<void> {
    return Session.loadSessionFromDisk(this._sessionCtx(), projectPath, sessionId);
  }
  async deleteSessionFile(projectPath: string, sessionId: number): Promise<void> {
    return Session.deleteSessionFile(this._sessionCtx(), projectPath, sessionId);
  }

  // ── Turn retraction (delegated to chat-session.ts) ──

  private retractTurn(idx: number): string | null {
    return Session.retractTurn(this._sessionCtx(), idx);
  }
  private _retractUserMessage(msg: UserMessage): void {
    Session._retractUserMessage(this._sessionCtx(), msg);
  }

  // ── Export (delegated to chat-session.ts) ──

  private async exportSession(): Promise<void> {
    return Session.exportSession(this._sessionCtx());
  }

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

  /** Send an instruction to the agent, optionally showing a user bubble.
   *  @param text The instruction sent to the agent
   *  @param displayLabel If set, shows this as a user bubble (for slash commands) */
  private sendAgentText(text: string, displayLabel?: string): void {
    this._runAgentTurn({
      userText: displayLabel,
      bubbleLabel: displayLabel,
      drive: (signal) => this.agent!.run(signal, text),
    });
  }

  /** Resume a previously paused goal. */
  private runGoalResume(): void {
    this._runAgentTurn({
      userText: '/goal resume',
      bubbleLabel: '🔄 恢复目标',
      drive: (signal) => this.agent!.resumeGoal(signal),
      onResult: (r) => this._notifyGoalResult(r),
    });
  }

  private runGoal(goal: string): void {
    this._runAgentTurn({
      userText: `/goal ${goal}`,
      bubbleLabel: `🎯 ${goal}`,
      drive: (signal) => this.agent!.runGoal(signal, goal),
      onResult: (r) => this._notifyGoalResult(r),
    });
  }

  /** /goal status — 显示活体目标 + 最近历史。 */
  private async showGoalStatus(): Promise<void> {
    const path = getChatStore(this.panelId).panel.getState().projectPath;
    if (!path) return;
    const mgr = new GoalManager(path);
    const active = await mgr.getActive();
    const history = (await mgr.list()).filter((r) => r.status !== 'active' && r.status !== 'paused');
    if (!active && history.length === 0) {
      this.addNotice('当前没有目标。用法: /goal 目标描述 — Agent 会自主循环直到完成', 'info');
      return;
    }
    if (active) {
      const label = active.status === 'paused' ? '已暂停' : '进行中';
      const hint = active.status === 'paused' ? ' — /goal resume 继续' : '';
      this.addNotice(`🎯 ${active.text.slice(0, 60)} · ${label} · 第 ${active.iteration + 1} 轮${hint}`, 'info');
    }
    for (const r of history.slice(-3).reverse()) {
      const icon = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : '🚫';
      this.addNotice(`${icon} ${r.text.slice(0, 50)} — ${(r.summary || r.status).slice(0, 60)}`, 'info');
    }
  }

  /** /goal cancel — 取消活体目标(运行中需先停止)。 */
  private async cancelGoal(): Promise<void> {
    const path = getChatStore(this.panelId).panel.getState().projectPath;
    if (!path) return;
    if (this._activeExec().isRunning) {
      this.addNotice('目标运行中 — 请先点击停止(或状态条上的暂停),再 /goal cancel', 'warn');
      return;
    }
    const mgr = new GoalManager(path);
    const active = await mgr.getActive();
    if (!active) {
      this.addNotice('没有可取消的目标', 'info');
      return;
    }
    await mgr.cancel(active.id);
    this.addNotice(`🚫 已取消目标: ${active.text.slice(0, 50)}`, 'info');
  }

  /** Shared scaffolding for agent turns — sendAgentText / runGoal / runGoalResume converge here.
   *  守卫、exec signal、滚动重置、turn pair、用户气泡、pending session、finally 收尾。 */
  private _runAgentTurn(opts: {
    userText?: string;
    bubbleLabel?: string;
    drive: (signal: AbortSignal) => Promise<GoalRunResult | void>;
    onResult?: (result: GoalRunResult) => void;
  }): void {
    if (!this.agent || this._activeExec().isRunning) return;
    if (Session.hasRunningBackgroundSession(this.panelId)) {
      this.addNotice('有后台会话运行中，请等待完成', 'info');
      return;
    }
    const signal = this._activeExec().start();

    // Reset auto-scroll for this new turn
    getChatStore(this.panelId).msg.setState({ userScrolledUp: false });

    if (opts.userText) {
      Session.getTurnPairs(this.panelId).push({
        userText: opts.userText,
        userBubble: null,
        assistantBubble: null,
        sessionIndex: this.agent.nextInsertIndex,
      });
    }
    if (opts.bubbleLabel) {
      this.appendUserBubble(opts.bubbleLabel);
    }

    {
      const sessStore = getChatStore(this.panelId).sess.getState();
      const activeSid = sessStore.sessions[sessStore.activeIdx]?.id;
      if (activeSid != null) Stream.setPendingStreamingSession(this.panelId, activeSid);
    }
    opts
      .drive(signal)
      .then((result) => {
        if (result) opts.onResult?.(result);
      })
      .catch((err: any) => {
        if (err.message?.includes('aborted') || err.message?.includes('AbortError')) {
          this.addNotice('已中止', 'info');
        } else if (err.message?.includes('paused after')) {
          this.addNotice(err.message, 'warn');
        } else {
          this.addNotice(`错误: ${err.message || err}`, 'error');
        }
      })
      .finally(() => {
        this._activeExec().done();
        this.finishTurn();
        bus.emit('chat:turn-done', {});
      });
  }

  private _notifyGoalResult(result: GoalRunResult): void {
    if (result.status === 'completed') {
      this.addNotice(`✅ 目标达成: ${result.summary.slice(0, 120)}`, 'info');
    } else if (result.status === 'paused') {
      this.addNotice(`⏸️ ${result.summary}`, 'info');
    } else if (result.status === 'failed') {
      this.addNotice(`❌ 目标失败: ${result.summary.slice(0, 120)}`, 'warn');
    } else {
      this.addNotice('目标被中断', 'warn');
    }
  }

  // ── Goal status strip ──

  private _buildGoalStrip(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'goal-strip';
    el.style.display = 'none';
    el.innerHTML =
      '<span class="goal-strip-icon">🎯</span>' +
      '<span class="goal-strip-text"></span>' +
      '<span class="goal-strip-meta"></span>' +
      '<button type="button" class="goal-strip-btn" data-act="pause">暂停</button>' +
      '<button type="button" class="goal-strip-btn" data-act="resume">恢复</button>' +
      '<button type="button" class="goal-strip-btn goal-strip-btn-danger" data-act="cancel">取消</button>';
    el.querySelector('[data-act="pause"]')!.addEventListener('click', () => this.abort());
    el.querySelector('[data-act="resume"]')!.addEventListener('click', () => this.runGoalResume());
    el.querySelector('[data-act="cancel"]')!.addEventListener('click', () => this.cancelGoal());
    return el;
  }

  private _updateGoalStrip(record: GoalRecord): void {
    if (record.status === 'active' || record.status === 'paused') {
      this._goalStripRecord = record;
    } else if (this._goalStripRecord?.id === record.id) {
      this._goalStripRecord = null; // 终态 — 收起状态条
    }
    this._renderGoalStrip();
  }

  private async _refreshGoalStrip(): Promise<void> {
    const path = getChatStore(this.panelId).panel.getState().projectPath;
    if (!path) return;
    this._goalStripRecord = await new GoalManager(path).getActive();
    this._renderGoalStrip();
  }

  private _renderGoalStrip(): void {
    const el = this._goalStrip;
    if (!el) return;
    const rec = this._goalStripRecord;
    if (!rec) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    el.querySelector('.goal-strip-text')!.textContent = rec.text.length > 40 ? `${rec.text.slice(0, 40)}…` : rec.text;
    const label = rec.status === 'paused' ? '已暂停' : '进行中';
    el.querySelector('.goal-strip-meta')!.textContent = `${label} · 第 ${rec.iteration + 1} 轮`;
    (el.querySelector('[data-act="pause"]') as HTMLElement).style.display = rec.status === 'active' ? '' : 'none';
    (el.querySelector('[data-act="resume"]') as HTMLElement).style.display = rec.status === 'paused' ? '' : 'none';
  }

  private async sendMessage(): Promise<void> {
    // Reset auto-scroll for this new turn
    getChatStore(this.panelId).msg.setState({ userScrolledUp: false });

    const text = this.inputArea.value.trim();
    if (!text) return;

    if (!this.agent) {
      const detail = getChatStore(this.panelId).panel.getState().lastAgentDiag
        ? `${getChatStore(this.panelId).panel.getState().lastAgentDiag} (factory:${Session.getAgentFactory(this.panelId) ? 'yes' : 'NO'})`
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
        if (!fact) {
          this.addNotice('用法: /remember 要记住的内容', 'info');
          return;
        }
        import('../agent/memory.js').then((m) => m.authorizeFactSave());
        this.sendAgentText(
          `请将以下事实保存到记忆库：${fact}\n\n使用 hologram_memory_save 工具。选择合适的 type（user/feedback/project/reference），起一个简短的 kebab-case 名称，写清楚 description。`,
          `/remember ${fact}`,
        );
        return;
      }
      if (text === '/goal' || text.startsWith('/goal ')) {
        const arg = text === '/goal' ? '' : text.slice('/goal '.length).trim();
        this.inputArea.value = '';
        this.inputArea.style.height = 'auto';
        if (arg === '' || arg === 'status') {
          this.showGoalStatus();
          return;
        }
        if (arg === 'resume') {
          this.runGoalResume();
          return;
        }
        if (arg === 'cancel') {
          this.cancelGoal();
          return;
        }
        this.runGoal(arg);
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
      getChatStore(this.panelId).input.getState().pushInputHistory(text);
      getChatStore(this.panelId).input.setState({ draftText: '' });
      // Show panel if collapsed
      if (getChatStore(this.panelId).panel.getState().panelMode == 'input') this.summonPanel();
      // Track turn pair (sessionIndex valid: queued messages are applied at safe boundary)
      Session.getTurnPairs(this.panelId).push({
        userText: text,
        userBubble: null,
        assistantBubble: null,
        sessionIndex: sessIdx,
      });
      this.appendUserBubble(text);
      return;
    }
    // ⚡ Block new runs if ANY background session still has an agent running.
    // Two agents streaming simultaneously would interleave events and cross sessions.
    if (Session.hasRunningBackgroundSession(this.panelId)) {
      this.addNotice('有后台会话正在运行中，请等待完成', 'info');
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
    if (getChatStore(this.panelId).panel.getState().panelMode == 'input') {
      this.summonPanel();
    }

    // Push input history (item 1)
    getChatStore(this.panelId).input.getState().pushInputHistory(text);
    getChatStore(this.panelId).input.setState({ draftText: '' });

    this.inputArea.value = '';
    this.inputArea.style.height = 'auto';
    const signal = this._activeExec().start();

    // Turn pair for retry (item 4) — sessionIndex is where user msg will land
    const sessIdx = this.agent.getSession().length;
    Session.getTurnPairs(this.panelId).push({
      userText: text,
      userBubble: null,
      assistantBubble: null,
      sessionIndex: sessIdx,
    });

    // User bubble (original text, focus context is for Agent eyes only)
    const files = getChatStore(this.panelId).input.getState().attachedFiles;
    const filesSnapshot = [...files];
    this.appendUserBubble(text, filesSnapshot);

    // Build focus context prefix — tells Agent what the user is looking at
    let focusPrefix = '';
    const focusNode = getChatStore(this.panelId).panel.getState().userFocusNode;
    if (focusNode) {
      focusPrefix = `[用户当前选中了图中的节点 "${focusNode.name}"`;
      if (focusNode.location) {
        focusPrefix += ` (位于 ${focusNode.location})`;
      }
      focusPrefix += ']\n\n';
    } else if (getChatStore(this.panelId).panel.getState().userFocusFile) {
      focusPrefix = `[用户当前正在查看文件 "${getChatStore(this.panelId).panel.getState().userFocusFile}"]\n\n`;
    }

    // Attached files — expose paths so Agent can read them
    if (files.length > 0) {
      focusPrefix += '用户附加了以下文件：\n';
      for (const f of files) {
        const sizeStr =
          f.size < 1024
            ? `${f.size} B`
            : f.size < 1024 * 1024
              ? `${(f.size / 1024).toFixed(1)} KB`
              : `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
        focusPrefix += `- \`${f.path}\` (${sizeStr})\n`;
      }
      focusPrefix += '你可以用 read_file 读取这些文件。\n\n';
      // Clear attachments after sending
      getChatStore(this.panelId).input.getState().clearAttachedFiles();
      this.renderAttachments();
    }

    // Track which session started this run — so streaming events route correctly
    // even if the user switches tabs before the first text event arrives.
    {
      const sessStore = getChatStore(this.panelId).sess.getState();
      const activeSid = sessStore.sessions[sessStore.activeIdx]?.id;
      if (activeSid != null) Stream.setPendingStreamingSession(this.panelId, activeSid);
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
        this.addNotice(
          `错误: ${err.message || String(err)}。发送任意消息重试，或输入 /compact 压缩上下文，或输入 /new 新建会话`,
          'error',
        );
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
        this._activeExec().forceReset();
        this.finishTurn();
        this.addNotice('已强制中止（超时）', 'warn');
      }
    }, 3000);
    // Zustand 订阅代替 setInterval 轮询 — 状态变为 idle 时自动取消超时
    const exec = this._activeExec();
    const unsub = exec.onChange(() => {
      if (!exec.isBusy) {
        clearTimeout(safety);
        unsub();
      }
    });
  }

  /** Sync stop button visibility — call whenever state may have changed. */
  private _updateStopButton(): void {
    const busy = this._activeExec().isBusy;
    this.stopBtn.classList.toggle('hidden', !busy);
    if (!busy) {
      this.sendBtn.classList.remove('hidden');
    }
  }

  // ⚡ migrated to ExecutionState.onChange callback in constructor

  // ═══════════════════════════════════════════════════════
  // Data-driven message model — delegated to chat-stream.ts
  // ═══════════════════════════════════════════════════════

  // ponytail: _streamingAssistant() and _updateTokens() deleted — dead code that
  // wrote to a panel-level messages array that no longer exists. All streaming
  // writes go through chat-stream.ts → per-session stores.

  private _addNoticeMessage(text: string, level: 'info' | 'warn' | 'error'): void {
    Stream._addNoticeMessage(this._streamCtx(), text, level);
  }

  private _finaliseStreamingAssistant(): void {
    Stream._finaliseStreamingAssistant(this._streamCtx());
  }

  private _expandedReasoning = new Set<number>();

  // ── Event Sink — render Agent events to DOM (NEW data-driven path) ──

  private renderEvent(ev: AgentEvent): void {
    Stream.renderEvent(this._streamCtx(), ev);
  }

  // ── Text (streaming via data-driven message model) ──

  // ── Inline permission cards ──

  // ponytail: single entry point — all notices go through the message model
  // so _syncMessagesToDOM() never wipes them.
  private addNotice(text: string, level: 'info' | 'warn' | 'error'): void {
    Stream.addNotice(this._streamCtx(), text, level);
  }

  // ── Footer — React-based, auto-subscribes to panel store ──

  private updateFooter(): void {
    // React component subscribes to panel store — token usage + model badge
    // auto-update. refresh() only needed on settings change to pick up model name.
    this._footerController?.refresh();
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

  // ── Helpers ──

  private appendUserBubble(
    text: string,
    files?: { path: string; name: string; size: number }[],
    skipActions?: boolean,
  ): void {
    Stream.appendUserBubble(this._streamCtx(), text, files, skipActions);
  }

  /** Finalize current assistant bubble — link to latest turnPair, reset streaming state.
   *  Called at TurnStarted boundaries (including mid-run inserts) and at run end. */
  private finishCurrentTurn(): void {
    Stream.finishCurrentTurn(this._streamCtx());
  }

  private finishTurn(): void {
    Stream.finishTurn(this._streamCtx());
  }

  // ── @ file reference autocomplete (React-based) ──

  private handleAtInput(): void {
    const val = this.inputArea.value;
    const cursorPos = this.inputArea.selectionStart || 0;
    const textBefore = val.slice(0, cursorPos);
    this._atAutocomplete.update(textBefore, cursorPos);
  }

  private _atNavigate(delta: number): void {
    this._atAutocomplete.navigate(delta);
  }
  private _atSelect(): void {
    this._atAutocomplete.select();
  }
  private get _atOpen(): boolean {
    return this._atAutocomplete?.open ?? false;
  }

  // ── Slash inline panel (item 14, registry-driven) ──

  /** Create slash panel once in constructor. Anchored to panel. */
  private _initSlashPanel(): void {
    CommandRegistry.instance.registerAll(DEFAULT_COMMANDS);
    this._wireCommandHandlers();
    this._slashController = new SlashPanelController(this.panel, CommandRegistry.instance.getAll(), (cmd) =>
      this._executeCommand(cmd),
    );
  }

  private _initFooter(): void {
    const slashTrigger = () => {
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
    };
    this._footerController = new FooterController(this.panel, this.panelId, {
      onOpenSettings: () => this.onOpenSettings?.(),
      onTriggerSlash: slashTrigger,
      onAttachFile: () => this.openFilePicker(),
    });
  }

  private _initAtAutocomplete(): void {
    this._atAutocomplete = new AtAutocompleteController(this.panel, this.panelId);
    this._atAutocomplete.setOnSelect((atIdx, token) => {
      const val = this.inputArea.value;
      const cursorPos = this.inputArea.selectionStart || 0;
      this.inputArea.value = val.slice(0, atIdx) + token + val.slice(cursorPos);
      this.inputArea.focus();
    });
  }

  private _initChatHint(): void {
    this._chatHint = new ChatHintController(this.msgList.parentElement!, this.panelId);
  }

  /** Wire local handlers for commands that need `this` context (new/compact/trail/export). */
  private _wireCommandHandlers(): void {
    const reg = CommandRegistry.instance;
    // Update local-action commands that need ChatPanel instance
    const override = (id: string, handler: () => void) => {
      const idx = DEFAULT_COMMANDS.findIndex((c) => c.id === id);
      if (idx >= 0 && DEFAULT_COMMANDS[idx].action.type === 'local') {
        (DEFAULT_COMMANDS[idx].action as any).handler = handler;
      }
    };
    override('new', () => {
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      this.createNewSession();
    });
    override('compact', () => {
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      if (!this.agent) return;
      // Guard: compaction rewrites the session — racing a running turn corrupts it.
      if (this._activeExec().isRunning) {
        this.addNotice('Agent 正在运行，请先停止或等待完成后再压缩。', 'warn');
        return;
      }
      this.appendUserBubble('/compact');
      this.addNotice('正在压缩上下文…', 'info');
      // Track via execState so the stop button can abort the summarization call.
      const exec = this._activeExec();
      const signal = exec.start();
      this.agent
        .compactNow(signal)
        .then(() => {
          this.messages = [];
          resetMsgIdCounter(this.panelId);
          getChatStore(this.panelId).msg.getState().setStreamingAssistantId(null);
          this.msgList.innerHTML = '';
          Session._rebuildMessagesFromSession(this._sessionCtx());
          this._chatMessages?.bump();
        })
        .catch((err) => {
          this.addNotice(`压缩失败: ${err.message}`, 'error');
        })
        .finally(() => {
          exec.done();
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
    // If user continues typing after / (e.g. "/mem"), still filter —
    // but only when / is at line start or after a space (not mid-word like URLs)
    else {
      const slashIdx = textBefore.lastIndexOf('/');
      if (slashIdx > 0 && textBefore[slashIdx - 1] !== ' ') {
        this._hideSlashPanel();
        return;
      }
      const query = textBefore.slice(slashIdx + 1).trimStart();
      if (query.length > 0) {
        this._showSlashPanel(query);
      } else {
        this._showSlashPanel('');
      }
    }
  }

  // ── Pill badge — agent event counter when collapsed ──

  /** Bump the pill badge count. Call from event handlers when pill-mode streaming. */
  private _bumpPillBadge(): void {
    if (getChatStore(this.panelId).panel.getState().panelMode !== 'pill') return;
    getChatStore(this.panelId).panel.getState().pillEventCount++;
    this.pillBadge.textContent = String(
      getChatStore(this.panelId).panel.getState().pillEventCount > 99
        ? '99+'
        : getChatStore(this.panelId).panel.getState().pillEventCount,
    );
    this.pillBadge.classList.add('show');
  }

  private _resetPillBadge(): void {
    getChatStore(this.panelId).panel.setState({ pillEventCount: 0 });
    this.pillBadge.textContent = '';
    this.pillBadge.classList.remove('show');
  }

  // ── Sink getter (used by main.ts to wire Agent) ──

  get sink() {
    return (ev: AgentEvent) => this.renderEvent(ev);
  }
}
