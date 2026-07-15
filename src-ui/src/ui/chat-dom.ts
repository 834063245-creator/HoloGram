// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Panel — DOM construction and event wiring
// Extracted from chat.ts ChatPanel class.
// All functions receive DomContext instead of accessing `this`.

import DOMPurify from 'dompurify';
import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import type { ToolSchema } from '../provider/types';
import { loadSettings } from '../settings';
import * as Session from './chat-session';
import { getChatStore } from './chat-store';
import { escapeHtml } from './chat-utils';
import type { CommandDef } from './command-registry';
import type { StarGraph } from './graph';
import { iconHtml } from './icons';
import type { ChatMessage, MessageId } from './message-model';

// ── Constants ──

// Panel ID now dynamic — see DomContext.panelId

// ── DomContext — the bridge between standalone DOM functions and ChatPanel state ──

export interface DomContext {
  /** Unique panel ID for DOM ID scoping. */
  panelId: string;

  // 容器
  container: HTMLElement;

  // 模式
  getMode: () => 'pill' | 'input' | 'panel' | 'hud';

  // Agent
  getAgent: () => ChatAgentHandle | null;

  // Graph
  getStarGraph: () => StarGraph | null;

  // 消息
  getMessages: () => ChatMessage[];

  // 项目路径
  getProjectPath: () => string;

  // 回调
  sendMessage: () => void;
  abort: () => void;
  summonPanel: () => void;
  collapseToInput: () => void;
  close: () => void;
  isOpen: () => boolean;

  // 通知
  addNotice: (text: string, level?: string) => void;

  // 会话
  createNewSession: () => Promise<void>;
  switchSession: (idx: number) => void;
  closeSession: (idx: number) => void;
  toggleHistory: () => void;
  closeHistory: () => void;

  // 权限
  running: boolean;

  // ── DOM element references (set by buildDOM, read by other methods) ──
  setPanel: (el: HTMLElement) => void;
  setMsgList: (el: HTMLElement) => void;
  setInputArea: (el: HTMLTextAreaElement) => void;
  setSendBtn: (el: HTMLButtonElement) => void;
  setStopBtn: (el: HTMLButtonElement) => void;
  setFooterEl: (el: HTMLElement) => void;
  setHeaderEl: (el: HTMLElement) => void;
  setSessionTabs: (el: HTMLElement) => void;
  setProgressBar: (el: HTMLElement) => void;
  setPillBadge: (el: HTMLElement) => void;
  setTabBar: (el: HTMLElement) => void;
  setTabContent: (el: HTMLElement) => void;
  setChatPanel: (el: HTMLElement) => void;
  setToolsPanel: (el: HTMLElement) => void;
  setContextPanel: (el: HTMLElement) => void;
  setStatusBar: (el: HTMLElement) => void;
  setStatusDot: (el: HTMLElement) => void;
  setStatusText: (el: HTMLElement) => void;
  setStatusTokens: (el: HTMLElement) => void;
  setAttachPillsEl: (el: HTMLElement) => void;
  setGraphClickCleanup: (fn: (() => void) | null) => void;
  setFooterClickCleanup: (fn: (() => void) | null) => void;

  // DOM getters (for reading back elements set by buildDOM)
  getPanel: () => HTMLElement;
  getInputArea: () => HTMLTextAreaElement;

  // Slash panel — migrated to React SlashPanelController
  _slashController: {
    show(query?: string): void;
    hide(): void;
    navigate(delta: number): boolean;
    select(): CommandDef | null;
    visible: boolean;
  } | null;

  // @ autocomplete
  atPopup: HTMLElement | null;
  setAtPopup: (el: HTMLElement | null) => void;
  atIdx: number;
  setAtIdx: (n: number) => void;
  atFileCache: { data: string; ts: number } | null;
  setAtFileCache: (c: { data: string; ts: number } | null) => void;

  // Settings
  onOpenSettings: (() => void) | null;
  _onModeChange: (() => void) | null;
  _onTrailToggle: (() => void) | null;

  // Tool
  _toolSchemas: ToolSchema[];
  toolUsage: Record<string, number>;
  toolHistory: Array<{ name: string; args: string; ts: number }>;

  // 输入历史
  inputHistory: string[];
  setInputHistory: (h: string[]) => void;
  historyIdx: number;
  setHistoryIdx: (n: number) => void;
  draftText: string;
  setDraftText: (s: string) => void;

  // ── Callbacks for methods not extracted ──
  handleAtInput: () => void;
  handleSlashInput: () => void;
  hideSlashPanel: () => void;
  navigateSlashPanel: (dir: number) => void;
  selectSlashItem: () => void;
  updateAtSelection: () => void;
  confirmAtSelection: () => void;
  expandToInput: () => void;
  restoreFromHud: () => void;
  fadeToHud: () => void;
  collapseToPill: () => void;
  toggleReasoning: (toggleBtn: HTMLElement, content: HTMLElement) => void;
  toggleToolCard: (card: HTMLElement) => void;
  killPanelTweens: () => void;
  setupResize: (handle: HTMLElement) => void;

  // 滚动
  // 滚动 — React handles internally

  // 提示
  hintText: () => string;
  refreshHint: () => void;

  // 最后代理诊断
  getLastAgentDiag: () => string;

  // ── 通过 getter/setter 暴露状态（需要双向读写） ──
  _lastAgentState: 'idle' | 'thinking' | 'running' | 'error';
  lastUsageText: string;
  totalTokensUsed: number;
  _expandedReasoning: Set<number>;
  _activeTab: 'chat' | 'tools' | 'context';

  // ── 文件附件 ──
  attachedFiles: { path: string; name: string; size: number }[];
  addAttachedFile: (file: { path: string; name: string; size: number }) => void;
  removeAttachedFile: (idx: number) => void;

  // 历史面板状态
  historyPanel: HTMLElement | null;
  setHistoryPanel: (el: HTMLElement | null) => void;
  historyOpen: boolean;
  setHistoryOpen: (v: boolean) => void;

  // 静态方法需要
  toolCategory: (name: string) => 'read' | 'write' | 'exec' | 'holo';

  // Session persistence callbacks (for openHistory)
  listSavedSessions: (
    projectPath: string,
  ) => Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string }>>;
  loadSessionFromDisk: (projectPath: string, sessionId: number) => Promise<void>;
  deleteSessionFile: (projectPath: string, sessionId: number) => Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════
// A. buildDOM — 构建整个聊天面板的 DOM 树
// ═══════════════════════════════════════════════════════════════════

export function buildDOM(ctx: DomContext): void {
  // Panel root
  const panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.id = `chat-panel-${ctx.panelId}`;

  // Corner brackets
  const brackets = document.createElement('div');
  brackets.className = 'corner-brackets';
  brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
  panel.appendChild(brackets);

  // Resize handle
  const resize = document.createElement('div');
  resize.className = 'chat-resize';
  panel.appendChild(resize);
  ctx.setupResize(resize);

  // ── Header — two-tier: row for nav/actions, row for session tabs ──
  const headerEl = document.createElement('div');
  headerEl.className = 'chat-header';
  const headerRow = document.createElement('div');
  headerRow.className = 'chat-header-row';
  const title = document.createElement('span');
  title.className = 'chat-title';
  title.innerHTML = `${iconHtml('chat')} 全息对话`;
  const closeBtn = document.createElement('button');
  headerRow.append(title);

  // ── Panel tabs (Chat | Tools | Context) ──
  const tabBar = document.createElement('div');
  tabBar.className = 'chat-panel-tabs';
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
    btn.addEventListener('click', () => switchTab(ctx, t.id));
    tabBar.appendChild(btn);
  }
  headerRow.appendChild(tabBar);

  // ── Action buttons (right-aligned) ──
  const headerRight = document.createElement('div');
  headerRight.className = 'chat-header-right';

  // + new session
  const addBtn = document.createElement('button');
  addBtn.className = 'chat-session-add';
  addBtn.innerHTML = iconHtml('plus', 12);
  addBtn.title = '新建会话';
  addBtn.addEventListener('click', () => ctx.createNewSession());
  headerRight.appendChild(addBtn);

  // History button
  const historyBtn = document.createElement('button');
  historyBtn.className = 'chat-session-add';
  historyBtn.innerHTML = iconHtml('bookmark', 12);
  historyBtn.title = '历史记录';
  historyBtn.addEventListener('click', () => toggleHistory(ctx));
  headerRight.appendChild(historyBtn);

  closeBtn.className = 'chat-close-btn';
  closeBtn.innerHTML = iconHtml('close', 16);
  closeBtn.addEventListener('click', () => ctx.close());
  headerRight.appendChild(closeBtn);
  headerRow.appendChild(headerRight);
  headerEl.appendChild(headerRow);

  // ── Session tab bar — dedicated full-width row, hidden when ≤ 1 session ──
  const sessionBar = document.createElement('div');
  sessionBar.className = 'chat-session-bar';
  const sessionTabs = document.createElement('div');
  sessionTabs.className = 'chat-session-tabs';
  sessionBar.appendChild(sessionTabs);
  headerEl.appendChild(sessionBar);
  panel.appendChild(headerEl);

  // ── Agent status bar ──
  const statusBar = document.createElement('div');
  statusBar.className = 'chat-status-bar';
  const statusDot = document.createElement('span');
  statusDot.className = 'chat-status-dot idle';
  const statusText = document.createElement('span');
  statusText.className = 'chat-status-text';
  statusText.textContent = '就绪';
  const statusModel = document.createElement('span');
  statusModel.className = 'chat-status-model';
  statusModel.id = `chat-status-model-${ctx.panelId}`;
  const statusTokens = document.createElement('span');
  statusTokens.className = 'chat-status-tokens';
  statusBar.append(statusDot, statusText, statusTokens, statusModel);
  panel.appendChild(statusBar);

  // ── Tab content container ──
  const tabContent = document.createElement('div');
  tabContent.className = 'chat-tab-content';

  // Chat panel
  const chatPanel = document.createElement('div');
  chatPanel.className = 'chat-tab-panel active';
  chatPanel.dataset['panel'] = 'chat';

  // Messages
  const msgList = document.createElement('div');
  msgList.className = 'chat-messages';
  chatPanel.appendChild(msgList);

  // Welcome hint
  const hint = document.createElement('div');
  hint.className = 'chat-hint';
  hint.id = `chat-hint-${ctx.panelId}`;
  hint.textContent = ctx.getAgent() ? '向我提问代码库的问题，或直接聊天' : ctx.hintText();
  msgList.appendChild(hint);

  tabContent.appendChild(chatPanel);

  // Tools panel
  const toolsPanel = document.createElement('div');
  toolsPanel.className = 'chat-tab-panel';
  toolsPanel.dataset['panel'] = 'tools';
  tabContent.appendChild(toolsPanel);

  // Context panel
  const contextPanel = document.createElement('div');
  contextPanel.className = 'chat-tab-panel';
  contextPanel.dataset['panel'] = 'context';
  tabContent.appendChild(contextPanel);

  panel.appendChild(tabContent);

  // Expand handle — pull tab to summon panel (visible in input-only mode)
  const expandHandle = document.createElement('div');
  expandHandle.className = 'chat-expand-handle';
  expandHandle.title = '展开对话面板';
  const expandHandleInner = document.createElement('div');
  expandHandleInner.className = 'chat-expand-handle-inner';
  expandHandle.appendChild(expandHandleInner);
  expandHandle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ctx.getMode() === 'input') ctx.summonPanel();
    else if (ctx.getMode() === 'panel') ctx.collapseToInput();
  });
  panel.appendChild(expandHandle);

  // Input area
  const inputWrap = document.createElement('div');
  inputWrap.className = 'chat-input-area';

  const inputArea = document.createElement('textarea');
  inputArea.className = 'chat-input';
  inputArea.placeholder = '输入消息… (Enter 发送, Shift+Enter 换行)';
  inputArea.rows = 2;
  inputArea.addEventListener('keydown', (e) => {
    // ── @ popup keyboard nav ──
    if (ctx.atPopup?.classList.contains('open')) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = ctx.atPopup.querySelectorAll('.at-item');
        ctx.setAtIdx(Math.min(ctx.atIdx + 1, items.length - 1));
        ctx.updateAtSelection();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        ctx.setAtIdx(Math.max(ctx.atIdx - 1, 0));
        ctx.updateAtSelection();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        ctx.confirmAtSelection();
        return;
      }
      if (e.key === 'Escape') {
        ctx.atPopup.classList.remove('open');
        return;
      }
    }
    // ── / slash panel keyboard nav ──
    if (ctx._slashController?.visible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        ctx.navigateSlashPanel(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        ctx.navigateSlashPanel(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        ctx.selectSlashItem();
        return;
      }
      if (e.key === 'Escape') {
        ctx.hideSlashPanel();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ctx.sendMessage();
      return;
    }
    // ── Input history navigation ──
    if (e.key === 'ArrowUp' && ctx.inputHistory.length > 0) {
      const cursorAtStart = inputArea.selectionStart === 0 && inputArea.selectionEnd === 0;
      if (cursorAtStart) {
        e.preventDefault();
        if (ctx.historyIdx === ctx.inputHistory.length) {
          ctx.setDraftText(inputArea.value);
        }
        if (ctx.historyIdx > 0) {
          ctx.setHistoryIdx(ctx.historyIdx - 1);
          inputArea.value = ctx.inputHistory[ctx.historyIdx];
          inputArea.style.height = 'auto';
          inputArea.style.height = Math.min(inputArea.scrollHeight, 120) + 'px';
        }
        return;
      }
    }
    if (e.key === 'ArrowDown' && ctx.inputHistory.length > 0) {
      const cursorAtEnd = inputArea.selectionStart === inputArea.value.length;
      if (cursorAtEnd) {
        e.preventDefault();
        if (ctx.historyIdx < ctx.inputHistory.length - 1) {
          ctx.setHistoryIdx(ctx.historyIdx + 1);
          inputArea.value = ctx.inputHistory[ctx.historyIdx];
        } else {
          ctx.setHistoryIdx(ctx.inputHistory.length);
          inputArea.value = ctx.draftText;
        }
        inputArea.style.height = 'auto';
        inputArea.style.height = Math.min(inputArea.scrollHeight, 120) + 'px';
        return;
      }
    }
    if (e.key === 'Escape') {
      // Close popups first
      if (ctx._slashController?.visible) {
        ctx.hideSlashPanel();
        return;
      }
      ctx.close();
    }
  });
  // Auto-resize + @/slash detection
  inputArea.addEventListener('input', () => {
    inputArea.style.height = 'auto';
    inputArea.style.height = Math.min(inputArea.scrollHeight, 120) + 'px';
    ctx.handleAtInput();
    ctx.handleSlashInput();
  });

  const sendBtn = document.createElement('button');
  sendBtn.className = 'chat-send-btn';
  sendBtn.innerHTML = iconHtml('send');
  sendBtn.addEventListener('click', () => ctx.sendMessage());

  const stopBtn = document.createElement('button');
  stopBtn.className = 'chat-stop-btn hidden';
  stopBtn.innerHTML = iconHtml('stop');
  stopBtn.addEventListener('click', () => ctx.abort());

  // Attachment pills — shows between messages and input when files are attached
  const attachPillsEl = document.createElement('div');
  attachPillsEl.className = 'attach-pills';
  attachPillsEl.style.display = 'none';
  panel.appendChild(attachPillsEl);

  inputWrap.append(inputArea, sendBtn, stopBtn);
  panel.appendChild(inputWrap);

  // Input footer — model badge, slash commands, usage
  const footerEl = document.createElement('div');
  footerEl.className = 'chat-footer';
  panel.appendChild(footerEl);

  // ── Pill core — optical sapphire reticle ──
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
  panel.appendChild(pillStar);

  // ── Inner tracking ring — dashed orbit with tracer dot ──
  const innerRing = document.createElement('div');
  innerRing.className = 'chat-pill-inner-ring';
  const orbitDot = document.createElement('div');
  orbitDot.className = 'chat-pill-orbit-dot';
  innerRing.appendChild(orbitDot);
  panel.appendChild(innerRing);

  // ── Event badge — counts agent events when pill is collapsed ──
  const pillBadge = document.createElement('div');
  pillBadge.className = 'chat-pill-badge';
  panel.appendChild(pillBadge);

  ctx.container.appendChild(panel);
  // Ensure initial mode class matches mode = 'pill'
  panel.classList.add('chat-pill');

  // ── Click on panel: HUD restores, pill expands to input bar ──
  panel.addEventListener('click', (e) => {
    if (ctx.getMode() === 'hud') {
      e.stopPropagation();
      ctx.restoreFromHud();
    } else if (ctx.getMode() === 'pill') {
      e.stopPropagation();
      ctx.expandToInput();
    }
  });

  // ── Set all DOM references on the context ──
  ctx.setPanel(panel);
  ctx.setMsgList(msgList);
  ctx.setInputArea(inputArea);
  ctx.setSendBtn(sendBtn);
  ctx.setStopBtn(stopBtn);
  ctx.setFooterEl(footerEl);
  ctx.setHeaderEl(headerEl);
  ctx.setSessionTabs(sessionTabs);
  ctx.setPillBadge(pillBadge);
  ctx.setTabBar(tabBar);
  ctx.setTabContent(tabContent);
  ctx.setChatPanel(chatPanel);
  ctx.setToolsPanel(toolsPanel);
  ctx.setContextPanel(contextPanel);
  ctx.setStatusBar(statusBar);
  ctx.setStatusDot(statusDot);
  ctx.setStatusText(statusText);
  ctx.setStatusTokens(statusTokens);
  ctx.setAttachPillsEl(attachPillsEl);
}

// ═══════════════════════════════════════════════════════════════════
// B. Tab 视图
// ═══════════════════════════════════════════════════════════════════

export function switchTab(ctx: DomContext, tab: 'chat' | 'tools' | 'context'): void {
  const store = getChatStore(ctx.panelId).panel.getState();
  if (store.activeTab === tab) return;
  store.setActiveTab(tab);

  // Update tab buttons
  ctx
    .getPanel()
    .querySelectorAll('.chat-panel-tab')
    .forEach((btn) => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset['tab'] === tab);
    });

  // Update panels
  ctx
    .getPanel()
    .querySelectorAll('.chat-tab-panel')
    .forEach((p) => {
      const el = p as HTMLElement;
      el.classList.toggle('active', el.dataset['panel'] === tab);
    });

  // Render on switch
  if (tab === 'tools') renderToolsView(ctx);
  else if (tab === 'context') renderContextView(ctx);
}

export function _updateStatusBar(
  ctx: DomContext,
  state: 'idle' | 'thinking' | 'running' | 'error',
  detail?: string,
): void {
  getChatStore(ctx.panelId).panel.getState().setLastAgentState(state);
  const panel = ctx.getPanel();
  const dot = panel.querySelector('.chat-status-dot') as HTMLElement;
  if (dot) dot.className = 'chat-status-dot ' + state;
  const text = panel.querySelector('.chat-status-text') as HTMLElement;
  if (text) {
    const statusLabel =
      detail ||
      (state === 'idle' ? '就绪' : state === 'thinking' ? '思考中…' : state === 'running' ? '执行工具' : '错误');
    text.textContent = statusLabel;
  }
  // Update model in status
  const settings = loadSettings();
  const active = settings.providers.find((p) => p.name === settings.activeProvider) || settings.providers[0];
  const modelEl = panel.querySelector(`#chat-status-model-${ctx.panelId}`) as HTMLElement;
  if (modelEl && active) {
    let ml = active.model || '';
    if (ml.length > 20) ml = ml.slice(0, 19) + '…';
    modelEl.textContent = active.name ? `${active.name}/${ml}` : ml;
  }
  const tokensEl = panel.querySelector('.chat-status-tokens') as HTMLElement;
  const tokensUsed = getChatStore(ctx.panelId).panel.getState().totalTokensUsed;
  if (tokensEl && tokensUsed > 0) {
    tokensEl.textContent = `${(tokensUsed / 1000).toFixed(1)}k tok`;
  }
}

export function renderToolsView(ctx: DomContext): void {
  // ponytail: read schemas/usage/history from the live store, NOT from ctx
  // which is a stale snapshot captured at DomContext creation time.
  const s = getChatStore(ctx.panelId).panel.getState();
  const schemas = s.toolSchemas || [];
  const usage = s.toolUsage || {};
  const history = s.toolHistory || [];
  const tools =
    schemas.length > 0
      ? schemas.map((t: any) => ({
          name: t.name,
          desc: (t.description || '').split('\n')[0].slice(0, 60),
          cat: ctx.toolCategory(t.name),
        }))
      : [];

  const maxUsage = Math.max(1, ...Object.values(usage));

  let html = '<div class="chat-tools-view">';
  html += '<div class="chat-tools-section-title">工具清单</div>';
  html += '<div class="chat-tools-grid">';
  for (const t of tools) {
    const count = usage[t.name] || 0;
    const pct = (count / maxUsage) * 100;
    html += `<div class="chat-tool-card tool-cat-${t.cat}" title="${t.name} — ${t.desc}">
      <div class="chat-tool-card-name">${t.name}</div>
      <div class="chat-tool-card-desc">${t.desc}</div>
      ${
        count > 0
          ? `<div class="chat-tool-card-meta"><span>${count} 次调用</span></div>
      <div class="tool-usage-bar"><div class="tool-usage-fill" style="width:${pct}%"></div></div>`
          : ''
      }
    </div>`;
  }
  html += '</div>';

  // Recent tool calls
  if (history.length > 0) {
    html += '<div class="chat-tools-section-title" style="margin-top:4px">最近调用</div>';
    html += '<div class="chat-tools-recent">';
    for (const h of history.slice(0, 10)) {
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
  ctx.getPanel().querySelector('[data-panel="tools"]')!.innerHTML = html;
}

export function renderContextView(ctx: DomContext): void {
  // ponytail: read tokens/usage from the live store, not from stale ctx snapshot
  const s = getChatStore(ctx.panelId).panel.getState();
  const settings = loadSettings();
  const active = settings.providers.find((p) => p.name === settings.activeProvider) || settings.providers[0];
  const ctxWin = settings.agent?.contextWindow || 0;
  const tokensUsed = s.totalTokensUsed;
  const pct = ctxWin > 0 ? Math.min((tokensUsed / ctxWin) * 100, 100) : 0;
  let meterClass = 'safe';
  if (pct >= 90) meterClass = 'danger';
  else if (pct >= 80) meterClass = 'warn';

  let html = '<div class="chat-context-view">';

  // Context window meter
  html += '<div class="chat-context-section">';
  html += '<div class="chat-context-section-label">上下文窗口</div>';
  html += `<div class="chat-context-meter">
    <div class="chat-context-meter-bar"><div class="chat-context-meter-fill ${meterClass}" style="width:${pct}%"></div></div>
    <span class="chat-context-meter-val">${ctxWin > 0 ? `${(tokensUsed / 1000).toFixed(1)}k / ${(ctxWin / 1000).toFixed(0)}k` : '未配置'}</span>
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
  const agent = ctx.getAgent();
  const sysMsg = agent?.getSession()?.find((m) => m.role === 'system');
  if (sysMsg?.content) {
    html += `<pre class="chat-context-system-prompt">${escapeHtml(sysMsg.content)}</pre>`;
  } else {
    html += '<div class="chat-context-empty">Agent 未就绪</div>';
  }
  html += '</div>';

  // Session stats
  html += '<div class="chat-context-section">';
  html += '<div class="chat-context-section-label">会话统计</div>';
  const msgCount = agent?.getSession()?.filter((m) => m.role !== 'system').length || 0;
  const turnCount = Session.getTurnPairs(ctx.panelId).length;
  const toolTotal = Object.values(s.toolUsage || {}).reduce((a: number, b: any) => a + b, 0);
  html += `<div style="font-family:var(--font-mono);font-size: calc(11px * var(--font-scale));color:rgba(145,180,225,0.55);display:flex;gap:16px">
    <span>${msgCount} 条消息</span>
    <span>${turnCount} 轮对话</span>
    <span>${toolTotal} 次工具调用</span>
  </div>`;
  html += '</div>';

  html += '</div>';
  ctx.getPanel().querySelector('[data-panel="context"]')!.innerHTML = DOMPurify.sanitize(html);
}

// ═══════════════════════════════════════════════════════════════════
// D. 历史面板 — 挂在 document.body，完全脱离聊天面板的 CSS transform 容器
// ═══════════════════════════════════════════════════════════════════

let _historyBackdrop: HTMLElement | null = null;
let _historyPanel: HTMLElement | null = null;
let _historyCloseTimer: ReturnType<typeof setTimeout> | null = null;

export function toggleHistory(ctx: DomContext): void {
  if (_historyPanel) {
    closeHistory(ctx);
    return;
  }
  openHistory(ctx);
}

export function openHistory(ctx: DomContext): void {
  // ponytail: HMR resets module vars but leaves DOM orphans — sweep first
  document.body.querySelectorAll('.chat-history-backdrop, .chat-history-panel').forEach((el) => el.remove());
  closeHistory(ctx); // ensure clean state

  // ── Backdrop — full viewport, closes on click ──
  const backdrop = document.createElement('div');
  backdrop.className = 'chat-history-backdrop';
  backdrop.addEventListener('click', () => closeHistory(ctx));
  document.body.appendChild(backdrop);
  _historyBackdrop = backdrop;

  // ── Panel — centered floating card ──
  const panel = document.createElement('div');
  panel.className = 'chat-history-panel';
  panel.addEventListener('click', (e) => e.stopPropagation()); // don't close when clicking inside

  const header = document.createElement('div');
  header.className = 'chat-history-panel-header';
  header.innerHTML = `<span class="chat-history-panel-title">历史会话</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'chat-history-panel-close';
  closeBtn.innerHTML = '×';
  closeBtn.title = '关闭';
  closeBtn.addEventListener('click', () => closeHistory(ctx));
  header.appendChild(closeBtn);

  panel.appendChild(header);

  const list = document.createElement('div');
  list.className = 'chat-history-panel-list';

  // ── Section: 当前打开 ──
  const memorySessions = Session.getSessions(ctx.panelId);
  if (memorySessions.length > 0) {
    renderSection(
      list,
      `当前打开 (${memorySessions.length})`,
      memorySessions.map((s, i) => {
        const msgCount = s.agent.getSession().filter((m) => m.role !== 'system').length;
        return {
          label: s.label,
          subtitle: `消息: ${msgCount}`,
          active: i === Session.getActiveIdx(ctx.panelId),
          onClick: () => {
            if (i !== Session.getActiveIdx(ctx.panelId)) ctx.switchSession(i);
            closeHistory(ctx);
          },
        };
      }),
    );
  }

  // ── Section: 磁盘存档 ──
  const projectPath = ctx.getProjectPath();
  if (projectPath) {
    const diskSection = document.createElement('div');
    diskSection.className = 'chat-history-section';
    diskSection.textContent = '磁盘存档';
    list.appendChild(diskSection);

    const loading = document.createElement('div');
    loading.className = 'chat-history-entry';
    loading.textContent = '加载中…';
    list.appendChild(loading);

    const SESSION_LOAD_TIMEOUT = 15_000;
    const timeoutP = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('history list timeout')), SESSION_LOAD_TIMEOUT),
    );

    Promise.race([ctx.listSavedSessions(projectPath), timeoutP])
      .then((sessions) => {
        if (!_historyPanel) return;
        loading.remove();

        if (sessions.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'chat-history-entry';
          empty.textContent = '暂无存档';
          list.appendChild(empty);
          return;
        }

        sessions.forEach((s) => {
          const already = memorySessions.findIndex((t) => t.id === s.id);
          const entry = buildHistoryEntry(
            s.label,
            `${s.msgCount} 条消息${s.savedAt ? ' · ' + new Date(s.savedAt).toLocaleString('zh-CN') : ''}`,
            () => {
              closeHistory(ctx);
              if (already >= 0) {
                ctx.switchSession(already);
              } else {
                ctx.loadSessionFromDisk(projectPath, s.id);
              }
            },
            already >= 0 && already === Session.getActiveIdx(ctx.panelId),
            () => {
              if (confirm(`删除会话 "${s.label}"？`)) {
                ctx.deleteSessionFile(projectPath, s.id);
                entry.remove();
              }
            },
          );
          list.appendChild(entry);
        });
      })
      .catch(() => {
        if (_historyPanel) loading.textContent = '加载超时，请重试';
      });
  }

  panel.appendChild(list);
  document.body.appendChild(panel);
  _historyPanel = panel;
}

export function closeHistory(ctx: DomContext): void {
  if (_historyBackdrop) {
    _historyBackdrop.remove();
    _historyBackdrop = null;
  }
  if (_historyPanel) {
    _historyPanel.remove();
    _historyPanel = null;
  }
  if (_historyCloseTimer) {
    clearTimeout(_historyCloseTimer);
    _historyCloseTimer = null;
  }
  ctx.setHistoryOpen(false);
}

/** Tiny helper: render a section of entries into the list. */
function renderSection(
  list: HTMLElement,
  heading: string,
  entries: Array<{ label: string; subtitle: string; active: boolean; onClick: () => void }>,
): void {
  const hdr = document.createElement('div');
  hdr.className = 'chat-history-section';
  hdr.textContent = heading;
  list.appendChild(hdr);
  entries.forEach((e) => {
    list.appendChild(buildHistoryEntry(e.label, e.subtitle, e.onClick, e.active));
  });
}

export function buildHistoryEntry(
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
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete();
    });
    entry.appendChild(delBtn);
  }

  return entry;
}

// ═══════════════════════════════════════════════════════════════════
// E. 文件附件
// ═══════════════════════════════════════════════════════════════════

export function renderAttachments(ctx: DomContext): void {
  const panel = ctx.getPanel();
  const pillsEl = panel.querySelector('.attach-pills') as HTMLElement;
  if (!pillsEl) return;
  if (ctx.attachedFiles.length === 0) {
    pillsEl.style.display = 'none';
    pillsEl.innerHTML = '';
    return;
  }
  pillsEl.style.display = 'flex';
  pillsEl.innerHTML = ctx.attachedFiles
    .map((f, i) => {
      const sizeStr =
        f.size < 1024
          ? `${f.size} B`
          : f.size < 1024 * 1024
            ? `${(f.size / 1024).toFixed(1)} KB`
            : `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
      return `<span class="attach-pill" title="${f.path}">
      <span class="attach-pill-icon">${iconHtml('file', 10)}</span>
      <span class="attach-pill-name">${f.name}</span>
      <span class="attach-pill-size">${sizeStr}</span>
      <span class="attach-pill-remove" data-idx="${i}">×</span>
    </span>`;
    })
    .join('');
  // Wire remove buttons
  pillsEl.querySelectorAll('.attach-pill-remove').forEach((el) => {
    const idx = parseInt((el as HTMLElement).dataset['idx'] || '');
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      removeAttachedFile(ctx, idx);
    });
  });
}

export function removeAttachedFile(ctx: DomContext, idx: number): void {
  ctx.removeAttachedFile(idx);
  renderAttachments(ctx);
}

export function addAttachedFile(ctx: DomContext, path: string, name: string, size: number): void {
  if (ctx.attachedFiles.some((f) => f.path === path)) return;
  ctx.addAttachedFile({ path, name, size });
  renderAttachments(ctx);
}

export async function openFilePicker(ctx: DomContext): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ multiple: true, title: '选择文件', filters: [] });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    for (const p of paths) {
      const name = p.replace(/\\/g, '/').split('/').pop() || p;
      addAttachedFile(ctx, p, name, 0);
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
        addAttachedFile(ctx, path, f.name, f.size);
      }
    });
    input.click();
  }
}

// ═══════════════════════════════════════════════════════════════════
// F. 图形点击处理
// ═══════════════════════════════════════════════════════════════════

export function setupGraphClickHandler(ctx: DomContext): void {
  const graphEl = document.getElementById('graph');
  if (!graphEl) return;

  const handler = (e: MouseEvent) => {
    if (ctx.getMode() === 'panel') {
      ctx.fadeToHud();
    } else if (ctx.getMode() === 'hud') {
      ctx.collapseToPill();
    } else if (ctx.getMode() === 'input') {
      ctx.collapseToPill();
    }
  };

  graphEl.addEventListener('click', handler);
  ctx.setGraphClickCleanup(() => graphEl.removeEventListener('click', handler));
}
