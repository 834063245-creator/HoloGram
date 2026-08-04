// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// ChatCore — 聊天无头核心（P2′ 原地重构）
// 从 ui/chat.ts 的 ChatPanel 提炼：保留全部会话/流式/权限/goal 编排，
// 剥离一切 DOM 操作 —— 视图层是 src/app/chat/ChatBeacon.tsx（React）。
//
// 输入文本：textarea 不再存在于此，唯一数据源是 input-store.inputText。
// 面板模式：panel-store.panelMode（pill/input/panel/hud），视图据此渲染。
// chat-session.ts / chat-stream.ts / part-mutator.ts / execution-state.ts
// 全部原样保留 —— 会话 ctx 的 DOM 字段由分离桩元素吸收（写入不可见但兼容）。
// ═══════════════════════════════════════════════════════════════

import type { AgentEvent } from '../../agent/agent-types';
import type { OwnedAgentHandle } from '../../agent/agent-session-state';
import type { ChatAgentHandle, GoalRunResult } from '../../agent/chat-agent-handle';
import { createExecState, type ExecStateInstance } from '../../agent/execution-state';
import { GoalManager, type GoalRecord } from '../../agent/goal-manager';
import type { ToolSchema } from '../../provider/types';
import * as Session from '../../ui/chat-session';
import {
  getChatStore,
  getExpandedReasoningSet,
  getStreamingAssistantId,
  getUserScrolledUp,
  msgStoreFor,
  msgStoreForActive,
} from '../../ui/chat-store';
import * as Stream from '../../ui/chat-stream';
import { type CommandDef, CommandRegistry, DEFAULT_COMMANDS } from '../../ui/command-registry';
import { bus } from '../../ui/events';
import { useShellStore } from '../../app/shell-store';
import type { StarGraph } from '../../ui/graph';
import { useAgentPanelStore } from '../../ui/agent-panel-store';
import { type AssistantMessage, type ChatMessage, resetMsgIdCounter, type UserMessage } from '../../ui/message-model';
import type { AtAutocompleteHandle } from '../../ui/react/AtAutocomplete';
import type { ChatFooterHandle } from '../../ui/react/ChatFooter';
import type { PromptShelfHandle } from '../../ui/react/PromptShelf';
import type { SlashPanelHandle } from '../../ui/react/SlashPanel';

/** 视图注册的输入框命令式接口（聚焦/全选），其余输入状态一律走 input-store */
export interface ComposerApi {
  focus: () => void;
  selectEnd: () => void;
}

/** 消息列表命令式句柄 —— /compact 重建会话后强制重拉（bump = bumpChat(panelId)） */
export interface MessagesApi {
  bump(): void;
}

export class ChatCore {
  /** 面板唯一实例 ID。自动生成，用于 store 隔离 + 事件前缀。 */
  readonly panelId: string;

  /** 面板级事件总线 — 加前缀以防止跨面板事件泄漏。 */
  private _bus: typeof bus;

  /** 执行状态 — 面板级实例。 */
  private _exec: ExecStateInstance;
  /** workspace 接线的公开访问器。 */
  get execState(): ExecStateInstance { return this._exec; }

  private starGraph: StarGraph | null = null;

  /** rAF 句柄，用于批量合并流式更新。 */
  private _syncRafId: number | null = null;

  /** 流式目标会话 ID — 替代 _pendingStreamingSessions 全局 Map。 */
  private _streamingTargetSid: number | null = null;

  private onOpenSettings: (() => void) | null = null;
  private _onTrailToggle: (() => void) | null = null;

  // ── 视图注册槽（ChatBeacon 挂载后注入组件 ref 句柄）──
  private _composer: ComposerApi | null = null;
  private _promptShelf: PromptShelfHandle | null = null;
  private _slashController: SlashPanelHandle | null = null;
  private _atAutocomplete: AtAutocompleteHandle | null = null;
  private _footerController: ChatFooterHandle | null = null;
  private _chatMessages: MessagesApi | null = null;

  // ── chat-session ctx 的 DOM 桩：分离元素，吸收写入，永不挂载 ──
  private _stubPanel: HTMLElement = document.createElement('div');
  private _stubSessionTabs: HTMLElement = document.createElement('div');
  private _stubTabBar: HTMLElement = document.createElement('div');

  // ── exec 状态广播（视图订阅 stop 按钮/运行态）──
  private _execListeners = new Set<() => void>();

  private get messages(): ChatMessage[] {
    const store = msgStoreForActive(this.panelId);
    return store?.getState().messages ?? [];
  }
  private set messages(msgs: ChatMessage[]) {
    const store = msgStoreForActive(this.panelId);
    if (store) store.getState().setMessages(msgs);
  }

  // ═══════════════════════════════════════════════════════════
  // 构造 — 只做总线订阅与 exec 绑定，不碰 DOM
  // ═══════════════════════════════════════════════════════════

  constructor() {
    this.panelId = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this._bus = bus.withPrefix(`p:${this.panelId}:`);
    this._exec = createExecState();

    CommandRegistry.instance.registerAll(DEFAULT_COMMANDS);
    this._wireCommandHandlers();

    // ── ask_user tool → prompt shelf（视图注册后生效）──
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
    // ── 追踪用户焦点 — 文件查看器 / 图谱选择 ──
    bus.on('highlight:file', (filePath: string) => {
      const panel = getChatStore(this.panelId).panel.getState();
      panel.setUserFocusFile(filePath);
      panel.setUserFocusNode(null);
    });
    bus.on('navigate:file', (filePath: string) => {
      const panel = getChatStore(this.panelId).panel.getState();
      panel.setUserFocusFile(filePath);
      panel.setUserFocusNode(null);
    });
    bus.on(
      'graph:node-clicked',
      (data: { nodeName: string; nodeType: string; nodeId: string; degree: number; location: string }) => {
        const panel = getChatStore(this.panelId).panel.getState();
        panel.setUserFocusNode({ name: data.nodeName, location: data.location || undefined });
        panel.setUserFocusFile(null);
      },
    );
    // 每次完整渲染后将可见节点名喂给 @ 自动补全
    bus.on('graph:rendered', () => {
      if (this.starGraph) this._atAutocomplete?.setNodeNames(this.starGraph.getNodeNames());
    });
    bus.on('agent:diag', (d: { text: string; ready: boolean }) => {
      getChatStore(this.panelId).panel.getState().setLastAgentDiag(d.text);
    });
    // ── Goal strip：状态迁移驱动显隐；切换工作区后重载 ──
    bus.on('goal:state', (record: GoalRecord) => this._updateGoalRecord(record));
    bus.on('workspace:switched', () => this._refreshGoalRecord());
    this._refreshGoalRecord();

    // ⚡ ExecutionState → store 同步：订阅活动会话的 execState，会话切换时重绑
    let _execUnsub: (() => void) | null = null;
    const _onExecChange = (exec: ExecStateInstance) => {
      if (exec.isRunning) {
        this._updateStatusBar('thinking', '分析中…');
      } else {
        this._updateStatusBar('idle');
        this._promptShelf?.dismiss(); // ⚡ 停止时关闭 ask/permission 弹层
        this._composer?.focus();
      }
      for (const cb of this._execListeners) cb();
    };
    const _bindExecState = () => {
      if (_execUnsub) {
        _execUnsub();
        _execUnsub = null;
      }
      const exec = this._activeExec();
      _execUnsub = exec.onChange(() => _onExecChange(exec));
      _onExecChange(exec); // 初始同步
    };
    _bindExecState();
    // 用户切换活动会话时重新绑定
    getChatStore(this.panelId).sess.subscribe(() => _bindExecState());

    // ── Agent 事件通过 eventSink 直接投递 → renderEvent ──
    // (4.2: 取消总线中转 — Agent → ChatCore 是 1:1，无需总线)
  }

  // ═══════════════════════════════════════════════════════════
  // 视图注册
  // ═══════════════════════════════════════════════════════════

  registerComposer(api: ComposerApi): void {
    this._composer = api;
  }
  registerPromptShelf(c: PromptShelfHandle): void {
    this._promptShelf = c;
  }
  registerSlash(c: SlashPanelHandle): void {
    this._slashController = c;
  }
  registerAt(c: AtAutocompleteHandle): void {
    this._atAutocomplete = c;
    if (this.starGraph) c.setNodeNames(this.starGraph.getNodeNames());
  }
  registerFooter(c: ChatFooterHandle): void {
    this._footerController = c;
  }
  registerMessages(c: MessagesApi): void {
    this._chatMessages = c;
  }

  /** 视图订阅 exec 状态变化（运行/权限卡计数）；返回退订函数 */
  onExecChange(cb: () => void): () => void {
    this._execListeners.add(cb);
    return () => this._execListeners.delete(cb);
  }
  get execBusy(): boolean {
    return this._activeExec().isBusy;
  }

  // ═══════════════════════════════════════════════════════════
  // 公共 API（main.ts / workspace.ts 契约面，与旧 ChatPanel 一致）
  // ═══════════════════════════════════════════════════════════

  setToolSchemas(schemas: ToolSchema[]): void {
    getChatStore(this.panelId).panel.getState().setToolSchemas(schemas);
  }
  setOnOpenSettings(fn: () => void): void {
    this.onOpenSettings = fn;
  }
  setOnTrailToggle(fn: () => void): void {
    this._onTrailToggle = fn;
  }
  /** 由视图转发 — Footer 的设置按钮 */
  fireOpenSettings(): void {
    this.onOpenSettings?.();
  }
  fireTrailToggle(): void {
    this._onTrailToggle?.();
  }

  /** 面板级事件接收器 — 直接调用，无总线中转。 */
  get eventSink(): (ev: AgentEvent) => void {
    return (ev: AgentEvent) => this.renderEvent(ev);
  }
  /** 面板级 Agent 进度事件接收器。 */
  get progressSink(): (data: { step: number; toolName: string }) => void {
    return (data: { step: number; toolName: string }) => this._updateStatusBar('thinking', `${data.toolName}…`);
  }
  setAgentFactory(fn: () => Promise<OwnedAgentHandle | null>): void {
    Session.setAgentFactory(this.panelId, fn);
  }

  private get agent(): ChatAgentHandle | null {
    return Session.getActiveAgent(this.panelId);
  }

  /** 活动会话的执行状态（按会话隔离）。 */
  private _activeExec(): ExecStateInstance {
    const s = getChatStore(this.panelId).sess.getState();
    const sid = s.sessions[s.activeIdx]?.id;
    return sid ? Session.getSessionExecState(this.panelId, sid) : this._exec;
  }

  setAgent(agent: OwnedAgentHandle | null): void {
    if (!agent) return;
    // 替换所有会话 — setAgent 是启动/设置阶段，非会话管理。
    Session.resetSessionState(this.panelId, agent);
    getChatStore(this.panelId).panel.getState().setTotalTokensUsed(0);
    Session.syncActiveSessionTokens(this.panelId, 0);
    getChatStore(this.panelId).panel.getState().clearToolUsage();
    getChatStore(this.panelId).panel.getState().clearToolHistory();
    this.messages = [];
    resetMsgIdCounter(this.panelId);
    getChatStore(this.panelId).msg.getState().setStreamingAssistantId(null);
    this.addNotice('已连接到当前项目', 'info');
  }

  getAgent(): ChatAgentHandle | null {
    return this.agent;
  }
  setStarGraph(g: StarGraph): void {
    this.starGraph = g;
  }
  setProjectPath(p: string): void {
    // projectPath 单一权威 = shell-store（2026-08-04 状态治理收口）。
    // 项目变更时清除用户焦点 — 过期的引用会误导 Agent。
    const shell = useShellStore.getState();
    if (p && p !== shell.projectPath) {
      const panel = getChatStore(this.panelId).panel.getState();
      panel.setUserFocusFile(null);
      panel.setUserFocusNode(null);
    }
    shell.setProjectPath(p);
  }

  // ── 模式机（pill/input/panel/hud → panel-store，视图渲染）──

  toggle(): void {
    const mode = getChatStore(this.panelId).panel.getState().panelMode;
    switch (mode) {
      case 'pill':
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
  close(): void {
    const mode = getChatStore(this.panelId).panel.getState().panelMode;
    if (mode === 'panel' || mode === 'hud') this.collapseToInput();
    else if (mode === 'input') this.collapseToPill();
  }
  isOpen(): boolean {
    const mode = getChatStore(this.panelId).panel.getState().panelMode;
    return mode === 'panel' || mode === 'hud';
  }
  summonPanel(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('panel');
    this._resetPillBadge();
    this._hideSlashPanel();
    this.closeHistory();
    setTimeout(() => this._composer?.focus(), 60);
  }
  collapseToInput(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('input');
  }
  collapseToPill(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('pill');
  }
  expandToInput(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('input');
    setTimeout(() => this._composer?.focus(), 60);
  }
  fadeToHud(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('hud');
  }
  restoreFromHud(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('panel');
    setTimeout(() => this._composer?.focus(), 60);
  }

  /** 以编程方式向 Agent 提问。唤起面板并发送。 */
  ask(question: string): void {
    const mode = getChatStore(this.panelId).panel.getState().panelMode;
    const alreadyOpen = mode === 'panel' || mode === 'hud';
    if (!alreadyOpen) this.summonPanel();
    getChatStore(this.panelId).input.getState().setInputText(question);
    // 延迟片刻，等面板出现后再发送
    setTimeout(() => this.sendMessage(), alreadyOpen ? 0 : 200);
  }

  /** 通过 PromptShelf 渲染权限请求（位于输入框上方，非内联）。 */
  showPermissionCard(
    toolName: string,
    reason: string,
    subject: string,
    danger?: string,
  ): Promise<{ allow: boolean; remember: boolean }> {
    if (getChatStore(this.panelId).panel.getState().panelMode !== 'panel') {
      this.summonPanel();
    }
    if (!this._promptShelf) {
      return Promise.resolve({ allow: false, remember: false });
    }
    const shelf = this._promptShelf;
    return this._activeExec().enqueuePerm(() =>
      shelf.showPermission({
        type: 'permission',
        id: `perm-${toolName}-${Date.now()}`,
        toolName,
        reason,
        subject: subject || '',
        danger,
      }),
    );
  }

  // ── Agent status bar → panel-store（视图渲染）──

  private _updateStatusBar(state: 'idle' | 'thinking' | 'running' | 'error', detail?: string): void {
    const p = getChatStore(this.panelId).panel.getState();
    p.setLastAgentState(state);
    p.setLastAgentDetail(detail ?? null);
  }

  // ── 工具使用追踪 ──

  private _recordToolUsage(toolName: string, args: string): void {
    getChatStore(this.panelId).panel.getState().addToolUsage(toolName, args);
  }

  /** 对工具名称进行分类，用于可视化分组。 */
  private static _holoTools?: Set<string>;
  static isHoloTool(name: string): boolean {
    if (name.startsWith('hologram_')) return true; // 记忆 / 遗留工具
    if (!ChatCore._holoTools) {
      ChatCore._holoTools = new Set([
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
    return ChatCore._holoTools.has(name);
  }
  static toolCategory(name: string): 'read' | 'write' | 'exec' | 'holo' {
    if (ChatCore.isHoloTool(name)) return 'holo';
    if (/^(read|search|grep|glob|list|view|show|get|find|cat|head|tail)/i.test(name)) return 'read';
    if (/^(write|edit|create|delete|remove|mv|cp|rename|save)/i.test(name)) return 'write';
    if (/^(run|exec|bash|shell|cmd|build|test|cargo|npm|git|python|node|web_|ask_|agent_)/i.test(name)) return 'exec';
    return 'read';
  }

  // ── Context bridges（chat-session / chat-stream 原样消费）──

  private _sessionCtx(): Session.SessionContext {
    const storeId = this.panelId;
    return {
      storeId,
      panel: this._stubPanel,
      sessionTabs: this._stubSessionTabs,
      tabBar: this._stubTabBar,
      getProjectPath: () => useShellStore.getState().projectPath,
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
        getChatStore(storeId).panel.getState().setLastUsageText(s);
      },
      getLastAgentDiag: () => getChatStore(storeId).panel.getState().lastAgentDiag,
      clearInputHistory: () => {
        const s = getChatStore(storeId).input.getState();
        s.setInputHistory([]);
        s.setInputHistoryIdx(-1);
        s.setDraftText('');
      },
      getStarGraph: () => this.starGraph,
      getRuntime: () => useAgentPanelStore.getState().runtimeRef as any,
    };
  }

  private _streamCtx(): Stream.StreamContext {
    const storeId = this.panelId;
    return {
      storeId,
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
      getStreamingTargetSid: () => this._streamingTargetSid,
      setStreamingTargetSid: (sid) => {
        this._streamingTargetSid = sid;
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
        this._bumpPillBadge();
      },
      // React 视图没有 DOM 气泡 — 入场动画由组件 CSS 负责
      animateBubbleIn: () => undefined as never,
      setRunning: (_r: boolean) => {
        /* 已迁移到 execState */
      },
      abort: () => this.abort(),
      _updateStatusBar: (s, d) => this._updateStatusBar(s, d),
      _recordToolUsage: (n, a) => this._recordToolUsage(n, a),
      _retractUserMessage: (m) => this._retractUserMessage(m),
      retractTurn: (i) => this.retractTurn(i),
      sendMessage: () => this.sendMessage(),
      _updateTokens: (n) => {
        getChatStore(storeId).panel.getState().setTotalTokensUsed(n);
      },
      getProjectPath: () => useShellStore.getState().projectPath,
      getRunning: () => this._activeExec().isRunning,
      getAbortCtrl: () =>
        this._activeExec().abortSignal ? ({ signal: this._activeExec().abortSignal } as AbortController) : null,
      setAbortCtrl: (_c: unknown) => {
        /* 由 execState 管理 */
      },
      getExpandedReasoning: () => getExpandedReasoningSet(storeId),
    };
  }

  // ── 会话管理（委托给 chat-session.ts）──

  switchSession(idx: number): void {
    Session.switchSession(this._sessionCtx(), idx);
  }
  closeSession(idx: number): void {
    Session.closeSession(this._sessionCtx(), idx);
  }
  async createNewSession(): Promise<void> {
    return Session.createNewSession(this._sessionCtx());
  }

  // ── 会话持久化（委托给 chat-session.ts）──

  async saveActiveSession(projectPath: string): Promise<void> {
    return Session.saveActiveSession(this._sessionCtx(), projectPath);
  }
  scheduleAutoSave(projectPath: string): void {
    Session.scheduleAutoSave(this._sessionCtx(), projectPath);
  }
  /** 增量持久化最后一条消息到后端 NDJSON（即发即忘）。 */
  appendLastMessage(projectPath: string): void {
    Session.appendLastMessage(this._sessionCtx(), projectPath);
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

  // ── 轮次撤回（委托给 chat-session.ts）──

  private retractTurn(idx: number): string | null {
    return Session.retractTurn(this._sessionCtx(), idx);
  }
  private _retractUserMessage(msg: UserMessage): void {
    Session._retractUserMessage(this._sessionCtx(), msg);
  }

  private async exportSession(): Promise<void> {
    return Session.exportSession(this._sessionCtx());
  }

  // ── History panel（视图渲染；core 只提供开关与数据）──

  toggleHistory(): void {
    const p = getChatStore(this.panelId).panel.getState();
    p.setHistoryOpen(!p.historyOpen);
  }
  closeHistory(): void {
    getChatStore(this.panelId).panel.getState().setHistoryOpen(false);
  }

  // ── 发送 ──

  private async sendAgentText(text: string, displayLabel?: string): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    await this._runAgentTurn({
      userText: displayLabel,
      bubbleLabel: displayLabel,
      drive: (signal) => agent.run(signal, text),
    });
  }

  /** 恢复先前暂停的目标。 */
  async runGoalResume(): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    await this._runAgentTurn({
      userText: '/goal resume',
      bubbleLabel: '🔄 恢复目标',
      drive: (signal) => agent.resumeGoal(signal),
      onResult: (r) => this._notifyGoalResult(r),
    });
  }

  private async runGoal(goal: string): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    await this._runAgentTurn({
      userText: `/goal ${goal}`,
      bubbleLabel: `🎯 ${goal}`,
      drive: (signal) => agent.runGoal(signal, goal),
      onResult: (r) => this._notifyGoalResult(r),
    });
  }

  /** /goal status — 显示活体目标 + 最近历史。 */
  private async showGoalStatus(): Promise<void> {
    const path = useShellStore.getState().projectPath;
    if (!path) return;
    const mgr = new GoalManager(path, (r) => bus.emit('goal:state', r));
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
  async cancelGoal(): Promise<void> {
    const path = useShellStore.getState().projectPath;
    if (!path) return;
    if (this._activeExec().isRunning) {
      this.addNotice('目标运行中 — 请先点击停止(或状态条上的暂停),再 /goal cancel', 'warn');
      return;
    }
    const mgr = new GoalManager(path, (r) => bus.emit('goal:state', r));
    const active = await mgr.getActive();
    if (!active) {
      this.addNotice('没有可取消的目标', 'info');
      return;
    }
    await mgr.cancel(active.id);
    this.addNotice(`🚫 已取消目标: ${active.text.slice(0, 50)}`, 'info');
  }

  /** Agent 轮次的共享脚手架。 */
  private async _runAgentTurn(opts: {
    userText?: string;
    bubbleLabel?: string;
    drive: (signal: AbortSignal) => Promise<unknown>;
    onResult?: (result: GoalRunResult) => void;
  }): Promise<void> {
    if (!this.agent || this._activeExec().isRunning) return;
    if (Session.hasRunningBackgroundSession(this.panelId)) {
      this.addNotice('有后台会话运行中，请等待完成', 'info');
      return;
    }
    const signal = this._activeExec().start();

    // 为新轮次重置自动滚动
    getChatStore(this.panelId).msg.getState().setUserScrolledUp(false);

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

    // 3.6: 在 Agent 上设置 UI 会话 ID，使子 Agent 通知能正确路由到对应会话
    {
      const sessStore = getChatStore(this.panelId).sess.getState();
      const activeSid = sessStore.sessions[sessStore.activeIdx]?.id;
      if (activeSid != null) {
        this._streamingTargetSid = activeSid;
        this.agent.setUiSessionId(activeSid);
      }
    }

    try {
      const result = await opts.drive(signal);
      if (result) opts.onResult?.(result as GoalRunResult);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('aborted') || msg.includes('AbortError')) {
        this.addNotice('已中止', 'info');
      } else if (msg.includes('paused after')) {
        this.addNotice(msg, 'warn');
      } else {
        this.addNotice(`错误: ${msg}`, 'error');
      }
    } finally {
      this._streamingTargetSid = null;
      this._activeExec().done();
      this.finishTurn();
      bus.emit('chat:turn-done');
    }
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

  // ── Goal 状态记录 → panel-store.goalRecord（GoalStrip 组件渲染）──

  private _updateGoalRecord(record: GoalRecord): void {
    const p = getChatStore(this.panelId).panel.getState();
    if (record.status === 'active' || record.status === 'paused') {
      p.setGoalRecord(record);
    } else if (p.goalRecord?.id === record.id) {
      p.setGoalRecord(null); // 终态 — 收起状态条
    }
  }

  private async _refreshGoalRecord(): Promise<void> {
    const path = useShellStore.getState().projectPath;
    if (!path) return;
    try {
      const rec = await new GoalManager(path, (r) => bus.emit('goal:state', r)).getActive();
      getChatStore(this.panelId).panel.getState().setGoalRecord(rec);
    } catch (e) {
      // fire-and-forget 路径：goal 状态条读取失败不应当让未处理的 rejection 外泄
      console.error('[chat] _refreshGoalRecord failed:', e);
    }
  }

  async sendMessage(): Promise<void> {
    // 为新轮次重置自动滚动
    getChatStore(this.panelId).msg.getState().setUserScrolledUp(false);

    const text = getChatStore(this.panelId).input.getState().inputText.trim();
    if (!text) return;

    if (!this.agent) {
      const detail = getChatStore(this.panelId).panel.getState().lastAgentDiag
        ? `${getChatStore(this.panelId).panel.getState().lastAgentDiag} (factory:${Session.getAgentFactory(this.panelId) ? 'yes' : 'NO'})`
        : '请先配置 API Key 或等待项目加载';
      this.addNotice(`Agent 未就绪 — ${detail}`, 'error');
      return;
    }

    // ── 注册表驱动的斜杠命令 ──
    if (text.startsWith('/')) {
      if (text.startsWith('/remember ')) {
        const fact = text.slice('/remember '.length).trim();
        getChatStore(this.panelId).input.getState().setInputText('');
        if (!fact) {
          this.addNotice('用法: /remember 要记住的内容', 'info');
          return;
        }
        import('../../agent/memory.js').then((m) => m.authorizeFactSave());
        this.sendAgentText(
          `请将以下事实保存到记忆库：${fact}\n\n使用 hologram_memory_save 工具。选择合适的 type（user/feedback/project/reference），起一个简短的 kebab-case 名称，写清楚 description。`,
          `/remember ${fact}`,
        );
        return;
      }
      if (text === '/goal' || text.startsWith('/goal ')) {
        const arg = text === '/goal' ? '' : text.slice('/goal '.length).trim();
        getChatStore(this.panelId).input.getState().setInputText('');
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
      const cmd = CommandRegistry.instance.findByShortcut(text.trim());
      if (cmd) {
        this._executeCommand(cmd);
        return;
      }
      // 未知斜杠命令 — 路由到 Skill 工具
      if (!text.includes(' ')) {
        const skillName = text.slice(1);
        getChatStore(this.panelId).input.getState().setInputText('');
        this.sendAgentText(`Execute skill: ${skillName}`, text);
        return;
      }
    }

    // ── 插入路径：Agent 运行中，将消息注入会话 ──
    if (this._activeExec().isRunning) {
      const sessIdx = this.agent.nextInsertIndex;
      this.agent.insertMessage(text);
      getChatStore(this.panelId).input.getState().setInputText('');
      getChatStore(this.panelId).input.getState().pushInputHistory(text);
      getChatStore(this.panelId).input.getState().setDraftText('');
      if (getChatStore(this.panelId).panel.getState().panelMode === 'input') this.summonPanel();
      Session.getTurnPairs(this.panelId).push({
        userText: text,
        userBubble: null,
        assistantBubble: null,
        sessionIndex: sessIdx,
      });
      this.appendUserBubble(text);
      return;
    }
    // ⚡ 若有任何后台会话仍有 Agent 在运行，则阻止新轮次。
    if (Session.hasRunningBackgroundSession(this.panelId)) {
      this.addNotice('有后台会话正在运行中，请等待完成', 'info');
      return;
    }

    // 首条用户消息时自动标记会话
    if (Session.getActiveIdx(this.panelId) >= 0) {
      const session = Session.getSessions(this.panelId)[Session.getActiveIdx(this.panelId)];
      if (session && (session.label.startsWith('会话 ') || session.label === '已恢复的会话')) {
        session.label = text.length > 28 ? text.slice(0, 27) + '…' : text;
        // in-place 变更不会触发 store 订阅 — 换数组引用通知视图
        getChatStore(this.panelId)
          .sess.getState()
          .setSessions([...Session.getSessions(this.panelId)]);
      }
    }

    // 若当前在浮动输入栏中，发送前先唤起完整面板
    if (getChatStore(this.panelId).panel.getState().panelMode === 'input') {
      this.summonPanel();
    }

    // 推入输入历史
    getChatStore(this.panelId).input.getState().pushInputHistory(text);
    getChatStore(this.panelId).input.getState().setDraftText('');
    getChatStore(this.panelId).input.getState().setInputText('');

    const signal = this._activeExec().start();

    // 重试用轮次对 — sessionIndex 是用户消息将要落地的位置
    const sessIdx = this.agent.getSession().length;
    Session.getTurnPairs(this.panelId).push({
      userText: text,
      userBubble: null,
      assistantBubble: null,
      sessionIndex: sessIdx,
    });

    // 用户气泡（原始文本，焦点上下文仅供 Agent 读取）
    const files = getChatStore(this.panelId).input.getState().attachedFiles;
    const filesSnapshot = [...files];
    this.appendUserBubble(text, filesSnapshot);

        // 构建焦点上下文前缀 — 告诉 Agent 用户正在查看什么。
    // 每次发送消费一次后清除，防止过期焦点泄漏到后续轮次。
    let focusPrefix = '';
    const focusNode = getChatStore(this.panelId).panel.getState().userFocusNode;
    const focusFile = getChatStore(this.panelId).panel.getState().userFocusFile;
    if (focusNode) {
      focusPrefix = `[用户当前选中了图中的节点 "${focusNode.name}"`;
      if (focusNode.location) {
        focusPrefix += ` (位于 ${focusNode.location})`;
      }
      focusPrefix += ']\n\n';
      getChatStore(this.panelId).panel.getState().setUserFocusNode(null);
    } else if (focusFile) {
      focusPrefix = `[用户当前正在查看文件 "${focusFile}"]\n\n`;
      getChatStore(this.panelId).panel.getState().setUserFocusFile(null);
    }

    // 附加文件 — 暴露路径以便 Agent 读取
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
      getChatStore(this.panelId).input.getState().clearAttachedFiles();
    }

    // 追踪启动本次运行的会话 — 切换标签页时流式仍能正确路由
    {
      const sessStore = getChatStore(this.panelId).sess.getState();
      const activeSid = sessStore.sessions[sessStore.activeIdx]?.id;
      if (activeSid != null) {
        this._streamingTargetSid = activeSid;
        this.agent?.setUiSessionId(activeSid);
      }
    }

    // 运行 Agent
    try {
      await this.agent.run(signal, focusPrefix + text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('aborted') || msg.includes('AbortError')) {
        this.addNotice('已中止', 'info');
      } else if (msg.includes('paused after')) {
        this.addNotice(msg, 'warn');
      } else {
        this.addNotice(`错误: ${msg}。发送任意消息重试，或输入 /compact 压缩上下文，或输入 /new 新建会话`, 'error');
      }
    } finally {
      this._streamingTargetSid = null;
      this._activeExec().done();
      this.finishTurn();
    }
    // 通知 main.ts 持久化会话
    bus.emit('chat:turn-done');
  }

  abort(): void {
    if (!this._activeExec().isRunning) return;

    // ⚡ 统一状态管理：停止主Agent + 级联子Agent + 清权限队列
    this._activeExec().stop();
    this.agent?.cascadeAbort();

    this.addNotice('正在中止…', 'info');

    // 安全超时：3 秒内若 Agent 没响应，强制复位
    const safety = setTimeout(() => {
      if (this._activeExec().isRunning) {
        this._activeExec().forceReset();
        this.finishTurn();
        this.addNotice('已强制中止（超时）', 'warn');
      }
    }, 3000);
    // Zustand 订阅代替轮询 — 状态变为 idle 时自动取消超时
    const exec = this._activeExec();
    const unsub = exec.onChange(() => {
      if (!exec.isBusy) {
        clearTimeout(safety);
        unsub();
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  // ── 数据驱动的消息模型 — 委托给 chat-stream.ts ──
  // ═══════════════════════════════════════════════════════

  private addNotice(text: string, level: 'info' | 'warn' | 'error'): void {
    Stream.addNotice(this._streamCtx(), text, level);
  }

  private renderEvent(ev: AgentEvent): void {
    Stream.renderEvent(this._streamCtx(), ev);
  }

  // ── Footer — 视图挂载；settings 变更时刷新模型名 ──

  private updateFooter(): void {
    this._footerController?.refresh();
  }

  // ── 文件附件 ──

  async openFilePicker(): Promise<void> {
    const input = getChatStore(this.panelId).input.getState();
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({ multiple: true, title: '选择文件', filters: [] });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      for (const p of paths) {
        const name = p.replace(/\\/g, '/').split('/').pop() || p;
        if (!input.attachedFiles.some((f) => f.path === p)) input.addAttachedFile({ path: p, name, size: 0 });
      }
    } catch {
      // 浏览器开发模式下的回退方案
      const el = document.createElement('input');
      el.type = 'file';
      el.multiple = true;
      el.addEventListener('change', () => {
        if (!el.files) return;
        for (let i = 0; i < el.files.length; i++) {
          const f = el.files[i];
          const path = (f as File & { path?: string }).path || f.name;
          if (!input.attachedFiles.some((x) => x.path === path))
            input.addAttachedFile({ path, name: f.name, size: f.size });
        }
      });
      el.click();
    }
  }

  /** 视图拖放转发 */
  handleFileDrop(e: DragEvent): void {
    const files = e.dataTransfer?.files;
    if (!files) return;
    const input = getChatStore(this.panelId).input.getState();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const path = (f as File & { path?: string }).path || f.name;
      if (!input.attachedFiles.some((x) => x.path === path))
        input.addAttachedFile({ path, name: f.name, size: f.size });
    }
  }

  removeAttachedFile(idx: number): void {
    getChatStore(this.panelId).input.getState().removeAttachedFile(idx);
  }

  // ── 辅助函数 ──

  private appendUserBubble(
    text: string,
    files?: { path: string; name: string; size: number }[],
    skipActions?: boolean,
  ): void {
    Stream.appendUserBubble(this._streamCtx(), text, files, skipActions);
  }

  private finishTurn(): void {
    Stream.finishTurn(this._streamCtx());
  }

  // ── 消息操作回调（视图 ChatMessages 委托）──

  copyText(text: string): void {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  navigateToNode(nodeName: string): void {
    if (this.starGraph) this.starGraph.focusNode(nodeName);
  }
  editUserMessage(msg: UserMessage): void {
    if (this._activeExec().isRunning) {
      this.addNotice('Agent 正在运行，请先停止再编辑', 'warn');
      return;
    }
    getChatStore(this.panelId).input.getState().setInputText(msg.text);
    this._composer?.focus();
    this._composer?.selectEnd();
    this._retractUserMessage(msg);
  }
  resendUserMessage(msg: UserMessage): void {
    if (this._activeExec().isRunning) {
      this.addNotice('Agent 正在运行，请先停止再重发', 'warn');
      return;
    }
    getChatStore(this.panelId).input.getState().setInputText(msg.text);
    this._retractUserMessage(msg);
    this.sendMessage();
  }
  retryAssistant(assistant: AssistantMessage): void {
    if (this._activeExec().isRunning) {
      this.addNotice('Agent 正在运行，请先停止再重试', 'warn');
      return;
    }
    const userMsg = this.messages.find((m) => m.role === 'user' && m._id === assistant.respondingTo);
    const userText = userMsg && 'text' in userMsg ? (userMsg.text as string) : '';
    if (!userText) return;
    getChatStore(this.panelId).input.getState().setInputText('');
    const signal = this._activeExec().start();
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
      if (activeSid != null) {
        this._streamingTargetSid = activeSid;
        this.agent?.setUiSessionId(activeSid);
      }
    }
    agent
      .run(signal, userText)
      .catch((err: Error) => {
        if (!err.message?.includes('aborted')) {
          this.addNotice(`重试失败: ${err.message || String(err)}`, 'error');
        }
      })
      .finally(() => {
        this._streamingTargetSid = null;
        this._activeExec().done();
        this.finishTurn();
      });
  }

  // ── @ file reference autocomplete（视图注册控制器，core 转发）──

  private _lastAtCursor = 0;
  handleAtInput(textBefore: string, cursorPos: number): void {
    this._lastAtCursor = cursorPos;
    this._atAutocomplete?.update(textBefore, cursorPos);
  }
  atNavigate(delta: number): void {
    this._atAutocomplete?.navigate(delta);
  }
  atSelect(): void {
    this._atAutocomplete?.select();
  }
  get atOpen(): boolean {
    return this._atAutocomplete?.open ?? false;
  }
  /** @ 弹层选中回填：atIdx(@ 位置) → 当前光标处替换为 token */
  applyAtSelect(atIdx: number, token: string): void {
    const input = getChatStore(this.panelId).input.getState();
    const v = input.inputText;
    input.setInputText(v.slice(0, atIdx) + token + v.slice(this._lastAtCursor));
    this._composer?.focus();
  }

  // ── Slash panel（视图注册控制器，core 转发）──

  get slashVisible(): boolean {
    return this._slashController?.visible ?? false;
  }
  slashNavigate(delta: number): boolean {
    return this._slashController?.navigate(delta) ?? false;
  }
  slashSelect(): void {
    this._slashController?.select();
  }
  hideSlash(): void {
    this._hideSlashPanel();
  }
  /** Escape 专用：剥离输入框中的 /query 文本再隐藏，避免下次按键触发 handleSlashInput 重新弹出 */
  dismissSlash(): void {
    const input = getChatStore(this.panelId).input.getState();
    const v = input.inputText;
    const slashIdx = v.lastIndexOf('/');
    if (slashIdx >= 0) {
      input.setInputText(v.slice(0, slashIdx));
    }
    this._hideSlashPanel();
    this._composer?.focus();
  }
  private _hideSlashPanel(): void {
    this._slashController?.hide();
  }

  /** 为需要实例上下文的命令（new/compact/trail/export）挂载本地处理器。 */
  private _wireCommandHandlers(): void {
    const override = (id: string, handler: () => void) => {
      const idx = DEFAULT_COMMANDS.findIndex((c) => c.id === id);
      if (idx >= 0 && DEFAULT_COMMANDS[idx].action.type === 'local') {
        (DEFAULT_COMMANDS[idx].action as { handler: () => void }).handler = handler;
      }
    };
    override('new', () => {
      getChatStore(this.panelId).input.getState().setInputText('');
      this.createNewSession();
    });
    override('compact', () => {
      getChatStore(this.panelId).input.getState().setInputText('');
      if (!this.agent) return;
      // 守卫：压缩会重写会话 — 与运行中的轮次竞争会损坏数据。
      if (this._activeExec().isRunning) {
        this.addNotice('Agent 正在运行，请先停止或等待完成后再压缩。', 'warn');
        return;
      }
      this.appendUserBubble('/compact');
      this.addNotice('正在压缩上下文…', 'info');
      const exec = this._activeExec();
      const signal = exec.start();
      this.agent
        .compactNow(signal)
        .then(() => {
          this.messages = [];
          resetMsgIdCounter(this.panelId);
          getChatStore(this.panelId).msg.getState().setStreamingAssistantId(null);
          Session._rebuildMessagesFromSession(this._sessionCtx());
          this._chatMessages?.bump();
        })
        .catch((err: Error) => {
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

  /** 从注册表执行命令（SlashPanel onCommit 委托）。 */
  executeCommand(cmd: CommandDef): void {
    this._executeCommand(cmd);
  }

  private _executeCommand(cmd: CommandDef): void {
    this._hideSlashPanel();
    const action = cmd.action;
    switch (action.type) {
      case 'send':
        getChatStore(this.panelId).input.getState().setInputText('');
        this.sendAgentText(action.text, action.displayLabel);
        break;
      case 'fill':
        getChatStore(this.panelId).input.getState().setInputText(action.text);
        this._composer?.focus();
        this._composer?.selectEnd();
        break;
      case 'local':
        getChatStore(this.panelId).input.getState().setInputText('');
        action.handler();
        break;
      case 'skill':
        getChatStore(this.panelId).input.getState().setInputText('');
        this.sendAgentText(`Execute skill: ${action.skillName}`, `/${action.skillName}`);
        break;
    }
  }

  handleSlashInput(textBefore: string): void {
    // 行首或空格后的 / 时显示面板
    const showPanel = /(?:^|\s)\/$/.test(textBefore);
    if (showPanel) {
      const slashIdx = textBefore.lastIndexOf('/');
      const query = textBefore.slice(slashIdx + 1);
      this._slashController?.show(query);
    } else if (!textBefore.includes('/')) {
      this._hideSlashPanel();
    } else {
      const slashIdx = textBefore.lastIndexOf('/');
      if (slashIdx > 0 && textBefore[slashIdx - 1] !== ' ') {
        this._hideSlashPanel();
        return;
      }
      const query = textBefore.slice(slashIdx + 1).trimStart();
      this._slashController?.show(query.length > 0 ? query : '');
    }
  }

  // ── Pill 徽章 → panel-store.pillEventCount ──

  private _bumpPillBadge(): void {
    if (getChatStore(this.panelId).panel.getState().panelMode !== 'pill') return;
    getChatStore(this.panelId).panel.getState().bumpPillEventCount();
  }
  private _resetPillBadge(): void {
    getChatStore(this.panelId).panel.getState().setPillEventCount(0);
  }

  // ── Sink getter（兼容旧契约）──

  get sink() {
    return (ev: AgentEvent) => this.renderEvent(ev);
  }
}