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
import { cancelPendingApprovals } from '../agent/permission';
import { loadSettings, saveSettings, CHAT_MODES } from '../settings';
import { invoke } from '../bridge';
import type { Message } from '../provider/types';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import gsap from 'gsap';

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

  // Panel mode: pill (44px circle) → panel (summoned) → hud (faded) → input (collapsed bar)
  // All states are CSS classes on the SAME element — one morphing container, zero jump.
  private mode: 'pill' | 'input' | 'panel' | 'hud' = 'pill';
  private graphClickCleanup: (() => void) | null = null;

  private lastUsageText = '';
  private projectPath = '';
  private onOpenSettings: (() => void) | null = null;
  private _onModeChange: (() => void) | null = null;
  private footerClickCleanup: (() => void) | null = null;
  private lastAgentDiag = '';

  // ── New: input history navigation (item 1) ──
  private inputHistory: string[] = [];
  private historyIdx = 0;
  private draftText = '';

  // ── New: message retry (item 4) ──
  private turnPairs: Array<{ userText: string; assistantBubble: HTMLElement | null }> = [];

  // ── New: progress bar (item 3) ──
  private progressBar: HTMLElement | null = null;

  // ── New: @ autocomplete (item 5) ──
  private atPopup: HTMLElement | null = null;
  private atFileCache: { data: string; ts: number } | null = null;
  private atIdx = 0;

  // ── New: token accumulation (item 12) ──
  private totalTokensUsed = 0;

  // ── New: slash auto-popup ref (item 14) ──
  private _slashPopup: HTMLElement | null = null;

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
      if (!d.ready && this.isOpen()) {
        this.refreshHint();
      }
    });
    // ── Detect graph interaction to auto-dismiss the panel ──
    this.setupGraphClickHandler();
    // ── Agent progress feedback (item 3) ──
    bus.on('agent:progress', (data: { step: number; maxSteps: number; toolName: string }) => {
      if (!this.progressBar || !this.running) return;
      const label = this.progressBar.querySelector('.chat-progress-label');
      const fill = this.progressBar.querySelector('.chat-progress-fill') as HTMLElement;
      if (label) label.textContent = data.step > 0
        ? `步骤 ${data.step}/${data.maxSteps}  ·  ${data.toolName}`
        : `正在执行 ${data.toolName}`;
      if (fill && data.maxSteps > 0) {
        fill.style.width = `${(data.step / data.maxSteps) * 100}%`;
      }
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
    this.statusDot.className = 'chat-status-dot ' + state;
    this.statusText.textContent = detail || (state === 'idle' ? '就绪' : state === 'thinking' ? '思考中…' : state === 'running' ? '执行工具' : '错误');
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
  private static toolCategory(name: string): 'read' | 'write' | 'exec' | 'holo' {
    if (name.startsWith('hologram_')) return 'holo';
    if (/^(read|search|grep|glob|list|view|show|get|find|cat|head|tail)/i.test(name)) return 'read';
    if (/^(write|edit|create|delete|remove|mv|cp|rename|save)/i.test(name)) return 'write';
    if (/^(run|exec|bash|shell|cmd|build|test|cargo|npm|git|python|node)/i.test(name)) return 'exec';
    return 'read';
  }

  // ── Tools view ──

  private renderToolsView(): void {
    const TOOLS_INFO: Array<{ name: string; desc: string; cat: 'read' | 'write' | 'exec' | 'holo' }> = [
      { name: 'hologram_explore', desc: '依赖波及范围查询', cat: 'holo' },
      { name: 'hologram_impact', desc: '改动影响分析', cat: 'holo' },
      { name: 'hologram_path', desc: '依赖路径追踪', cat: 'holo' },
      { name: 'hologram_neighbors', desc: '邻接节点查询', cat: 'holo' },
      { name: 'hologram_fragile', desc: '脆弱模块检测', cat: 'holo' },
      { name: 'hologram_cycle', desc: '循环依赖检测', cat: 'holo' },
      { name: 'hologram_coupling_report', desc: '耦合度报告', cat: 'holo' },
      { name: 'hologram_community', desc: '社区结构分析', cat: 'holo' },
      { name: 'hologram_blindspots', desc: '盲点扫描', cat: 'holo' },
      { name: 'hologram_diff', desc: '变更差异对比', cat: 'holo' },
      { name: 'hologram_run_check', desc: '运行健康检查', cat: 'holo' },
      { name: 'hologram_history', desc: '文件变更历史', cat: 'holo' },
      { name: 'hologram_changes', desc: '最近变更查询', cat: 'holo' },
      { name: 'read_file', desc: '读取文件内容', cat: 'read' },
      { name: 'glob', desc: '文件名模式匹配', cat: 'read' },
      { name: 'grep', desc: '内容正则搜索', cat: 'read' },
      { name: 'list_directory', desc: '目录列表', cat: 'read' },
      { name: 'edit_file', desc: '精确文本替换', cat: 'write' },
      { name: 'write_file', desc: '写入文件', cat: 'write' },
      { name: 'run_shell', desc: '执行 Shell 命令', cat: 'exec' },
    ];

    const maxUsage = Math.max(1, ...Array.from(this.toolUsage.values()));

    let html = '<div class="chat-tools-view">';
    html += '<div class="chat-tools-section-title">工具清单</div>';
    html += '<div class="chat-tools-grid">';
    for (const t of TOOLS_INFO) {
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
    html += `<div style="font-family:var(--font-mono);font-size:10px;color:var(--signal)">
      ${active?.name || '未知'} / ${active?.model || '未配置'}
      ${active?.thinking ? ' · 思考模式' : ''}
    </div>`;
    html += '</div>';

    // System prompt preview
    html += '<div class="chat-context-section">';
    html += '<div class="chat-context-section-label">系统提示词</div>';
    const sysMsg = this.agent?.getSession()?.find(m => m.role === 'system');
    if (sysMsg?.content) {
      const preview = sysMsg.content.length > 500 ? sysMsg.content.slice(0, 500) + '…' : sysMsg.content;
      html += `<div class="chat-context-system-prompt">${escapeHtml(preview)}</div>`;
    } else {
      html += '<div class="chat-context-empty">Agent 未就绪</div>';
    }
    html += '</div>';

    // Memory items
    html += '<div class="chat-context-section">';
    html += '<div class="chat-context-section-label">已配置工具</div>';
    html += '<div class="chat-context-empty">使用默认工具集</div>';
    html += '</div>';

    // Session stats
    html += '<div class="chat-context-section">';
    html += '<div class="chat-context-section-label">会话统计</div>';
    const msgCount = this.agent?.getSession()?.filter(m => m.role !== 'system').length || 0;
    const turnCount = this.turnPairs.length;
    const toolTotal = Array.from(this.toolUsage.values()).reduce((a, b) => a + b, 0);
    html += `<div style="font-family:var(--font-mono);font-size:9px;color:rgba(145,180,225,0.55);display:flex;gap:16px">
      <span>${msgCount} 条消息</span>
      <span>${turnCount} 轮对话</span>
      <span>${toolTotal} 次工具调用</span>
    </div>`;
    html += '</div>';

    html += '</div>';
    this.contextPanel.innerHTML = html;
  }

  // ── State transitions (GSAP-powered) ──

  // Content elements that participate in morph animations
  private static readonly CONTENT_SEL =
    '.chat-header, .chat-messages, .chat-input-area, .chat-footer, .chat-expand-handle, .corner-brackets, .chat-resize';

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

  /** Pill → Input: 44px circle morphs into floating input bar */
  private expandToInput(): void {
    if (this._animating) return;
    this.mode = 'input';
    this.killPanelTweens();
    this.removeAllPanelClasses();
    this.panel.classList.add('chat-input-mode');
    this.panel.style.maxHeight = ''; this.panel.style.minHeight = '';
    this.updateFooter();

    gsap.to(this.panel, { width: 560, borderRadius: 0, duration: 0.35, ease: 'power2.out' });
    this.fadeContentIn();

    setTimeout(() => this.inputArea.focus(), 350);
    shell.notifyPanelChanged();
  }

  /** Any state → Panel: summon the full conversation card */
  private summonPanel(): void {
    if (this._animating) return;
    this.mode = 'panel';
    this.killPanelTweens();
    this.removeAllPanelClasses();
    this.panel.classList.add('chat-open');
    this.panel.style.maxHeight = ''; this.panel.style.minHeight = '';
    this.updateFooter();

    gsap.to(this.panel, { width: 560, borderRadius: 0, duration: 0.35, ease: 'power2.out' });
    this.fadeContentIn();

    setTimeout(() => this.inputArea.focus(), 350);
    shell.notifyPanelChanged();
    this.scrollBottom();
  }

  /** Panel/HUD → Input: collapse card, keep floating input bar */
  private collapseToInput(): void {
    if (this._animating) return;
    this.killPanelTweens();
    const c = this.contentEls();
    // Snapshot target opacities BEFORE the fade-out, while inline styles are clean
    // (panel mode has no opacity tweens running, so computed === CSS)
    const targets = this.snapshotContentOpacities();

    // Restore panel from any HUD transform (scale/y/opacity) before morphing
    gsap.to(this.panel, { scale: 1, y: 0, opacity: 1, duration: 0.15, ease: 'power2.out' });

    gsap.to(c, {
      opacity: 0, duration: 0.15, ease: 'power2.in',
      onComplete: () => {
        this.mode = 'input';
        this.removeAllPanelClasses();
        this.panel.classList.add('chat-input-mode');
        this.panel.style.maxHeight = ''; this.panel.style.minHeight = '';
        // Clean up GSAP inline transform/opacity so CSS takes over
        gsap.set(this.panel, { clearProps: 'scale,y,opacity' });
        // Now fade in from 0 → target opacities captured before the fade-out
        gsap.fromTo(c,
          { opacity: 0 },
          { opacity: (i) => targets[i], duration: 0.15, ease: 'power2.out' },
        );
      },
    });

    if (this.running) this.abort();
    if (this.projectPath && this.activeIdx >= 0) {
      this.saveActiveSession(this.projectPath).catch(() => {});
    }
    cancelPendingApprovals();
    shell.notifyPanelChanged();
  }

  /** Input → Pill: collapse to 44px star circle — works from HUD too */
  private collapseToPill(): void {
    if (this._animating) return;
    this.killPanelTweens();
    const c = this.contentEls();

    // Restore panel to full presence before shrinking to pill
    gsap.to(this.panel, { scale: 1, y: 0, opacity: 1, duration: 0.15, ease: 'power2.in' });

    gsap.to(c, {
      opacity: 0, duration: 0.15, ease: 'power2.in',
      onComplete: () => {
        this.mode = 'pill';
        this.removeAllPanelClasses();
        this.panel.classList.add('chat-pill');
        this.panel.style.maxHeight = ''; this.panel.style.minHeight = '';
        gsap.set(c, { clearProps: 'opacity' });
        gsap.set(this.panel, { clearProps: 'scale,y,opacity' });
      },
    });
    gsap.to(this.panel, { width: 44, borderRadius: '50%', duration: 0.35, ease: 'power2.in', delay: 0.15 });

    if (this.running) this.abort();
    if (this.projectPath && this.activeIdx >= 0) {
      this.saveActiveSession(this.projectPath).catch(() => {});
    }
    cancelPendingApprovals();
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
        navigator.clipboard.writeText(txt).then(() => showCopiedFeedback(btn, 12)).catch(() => {});
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
          navigator.clipboard.writeText(txt).then(() => showCopiedFeedback(copyBtn, 12)).catch(() => {});
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
      // ── / slash popup keyboard nav ──
      if (this._slashPopup?.classList.contains('open')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') {
          // handled by existing sp-item click logic — only close on Escape here
          if (e.key === 'Escape') {
            this._slashPopup.classList.remove('open');
          }
          return;
        }
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
        if (this._slashPopup?.classList.contains('open')) {
          this._slashPopup.classList.remove('open');
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

    inputWrap.append(this.inputArea, this.sendBtn, this.stopBtn);
    this.panel.appendChild(inputWrap);

    // Input footer — model badge, slash commands, usage
    this.footerEl = document.createElement('div');
    this.footerEl.className = 'chat-footer';
    this.panel.appendChild(this.footerEl);

    // ── Pill star — four-pointed lens flare, lives inside the panel ──
    const pillStar = document.createElement('div');
    pillStar.className = 'chat-pill-star';
    const starSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    starSvg.setAttribute('viewBox', '0 0 32 32');
    starSvg.setAttribute('width', '16');
    starSvg.setAttribute('height', '16');
    starSvg.innerHTML = '<path d="M16 1.5 L17.5 13.5 L31 15 L17.5 16.5 L16 28.5 L14.5 16.5 L1 15 L14.5 13.5 Z" fill="currentColor"/>';
    pillStar.appendChild(starSvg);
    this.panel.appendChild(pillStar);

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

    // Detect /export command
    if (text === '/export') {
      this.inputArea.value = '';
      this.inputArea.style.height = 'auto';
      this.exportSession();
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

    // Turn pair for retry (item 4)
    this.turnPairs.push({ userText: text, assistantBubble: null });

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
    this.inputArea.disabled = r;
    this.sendBtn.classList.toggle('hidden', r);
    this.stopBtn.classList.toggle('hidden', !r);
    if (r) {
      this.inputArea.placeholder = 'Agent 思考中…';
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
      this.injectCodeBlockButtons(this.currentBubble);
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
    if (this.currentBubble) {
      this.addMessageActions(this.currentBubble);
      this.injectCodeBlockButtons(this.currentBubble);
    }
    this.scrollBottom();
  }

  // ── Message actions (copy button) ──

  private addMessageActions(bubble: HTMLElement): void {
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
        const txt = textEl.textContent || '';
        navigator.clipboard.writeText(txt).then(() => showCopiedFeedback(copyBtn, 12)).catch(() => {});
      });
      actions.append(copyBtn);

      // Retry button (item 4) — find matching turn pair
      for (let i = this.turnPairs.length - 1; i >= 0; i--) {
        if (this.turnPairs[i].assistantBubble === bubble) {
          const pair = this.turnPairs[i];
          const retryBtn = document.createElement('button');
          retryBtn.className = 'msg-action-btn';
          retryBtn.innerHTML = iconHtml('refresh', 12);
          retryBtn.title = '重试此回复';
          retryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!this.agent) return;
            this.inputArea.value = '';
            this.setRunning(true);
            this.addTurnSep();
            this.turnPairs.push({ userText: pair.userText, assistantBubble: null });
            this.abortCtrl = new AbortController();
            this.agent.run(this.abortCtrl.signal, pair.userText)
              .catch((err: any) => {
                if (!err.message?.includes('aborted')) {
                  this.addErrorNotice(err.message || String(err), '', [
                    { label: '重试', onClick: () => { this.inputArea.value = pair.userText; this.sendMessage(); } },
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
      // Edit button (item 2)
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn';
      editBtn.innerHTML = iconHtml('edit', 12);
      editBtn.title = '编辑消息';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const txt = textEl.textContent || '';
        this.inputArea.value = txt;
        this.inputArea.style.height = 'auto';
        this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
        this.inputArea.focus();
        this.inputArea.selectionStart = this.inputArea.selectionEnd = txt.length;
      });
      actions.append(editBtn);

      // Resend button (item 2)
      const resendBtn = document.createElement('button');
      resendBtn.className = 'msg-action-btn';
      resendBtn.innerHTML = iconHtml('refresh', 12);
      resendBtn.title = '重新发送';
      resendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const txt = textEl.textContent || '';
        if (txt && !this.running) {
          this.inputArea.value = txt;
          this.sendMessage();
        }
      });
      actions.append(resendBtn);
    }

    if (actions.children.length > 0) {
      bubble.appendChild(actions);
    }
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

    this.flushReasoning();
    this.flushText();
    this.ensureAssistantBubble();

    const card = document.createElement('div');
    card.className = 'msg-tool-card';
    card.dataset['toolId'] = tool.id;

    const cat = ChatPanel.toolCategory(tool.name);
    card.classList.add(`tool-cat-${cat}`);

    const header = document.createElement('div');
    header.className = 'msg-tool-header';

    const isSubAgent = tool.name === 'agent_spawn';
    const icon = isSubAgent
      ? iconHtml('puzzle', 13)
      : tool.read_only
        ? iconHtml('search', 13)
        : iconHtml('chevron-right', 13);
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
      resultEl.innerHTML = formatToolResult(tool.name, text, !!tool.truncated, tool.args);
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
    this.totalTokensUsed += total; // accumulate for token bar (item 12)
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

    this.footerEl.innerHTML = `
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
        <button class="sp-item" data-cmd="export">${iconHtml('export-file', 10)} 导出对话<span class="sp-key">/export</span></button>
      </div>
      <div class="sp-group">
        <div class="sp-group-title">查询</div>
        <button class="sp-item" data-cmd="q" data-text="哪些模块最脆弱？">${iconHtml('alert', 10)} 查找脆弱模块</button>
        <button class="sp-item" data-cmd="q" data-text="检查循环依赖">${iconHtml('refresh', 10)} 检查循环依赖</button>
        <button class="sp-item" data-cmd="q" data-text="分析最近改动的影响">${iconHtml('blast', 10)} 影响分析</button>
        <button class="sp-item" data-cmd="q" data-text="" data-placeholder="追踪从 ">${iconHtml('link', 10)} 依赖路径查询</button>
      </div>`;
    this.footerEl.appendChild(popup);
    this._slashPopup = popup;

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
        if (cmd === 'export') {
          this.exportSession();
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
    // Item 2: edit/resend actions for user bubbles
    this.addMessageActions(el);
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
    // Backfill turnPairs for retry (item 4)
    if (this.turnPairs.length > 0) {
      this.turnPairs[this.turnPairs.length - 1].assistantBubble = this.currentBubble;
    }
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

  // ── Slash auto-popup (item 14) ──

  private handleSlashInput(): void {
    const val = this.inputArea.value;
    const cursorPos = this.inputArea.selectionStart || 0;
    const textBefore = val.slice(0, cursorPos);

    // Show on / at line start or after space
    const showPopup = /(?:^|\s)\/$/.test(textBefore);

    if (showPopup && this._slashPopup) {
      this._slashPopup.classList.add('open');
      // Filter items by text after /
      const query = textBefore.slice(textBefore.lastIndexOf('/') + 1).toLowerCase();
      this._slashPopup.querySelectorAll('.sp-item').forEach((item) => {
        const el = item as HTMLElement;
        const cmd = el.dataset['cmd'] || '';
        const text = (el.textContent || '').toLowerCase();
        const match = !query || cmd.includes(query) || text.includes(query);
        el.style.display = match ? '' : 'none';
      });
    } else if (!showPopup && this._slashPopup && !textBefore.includes('/')) {
      this._slashPopup.classList.remove('open');
    }
  }

  // ── Sub-agent event handlers (item 10) ──

  private handleSubSpawn(data: { id: string; description: string; prompt: string; mode: string }): void {
    // Find the pending agent_spawn tool card and add sub-agent wrapper
    this.flushReasoning();
    this.flushText();
    this.ensureAssistantBubble();

    const subEl = document.createElement('div');
    subEl.className = 'msg-sub-agent';
    subEl.dataset['subId'] = data.id;
    subEl.innerHTML = `
      <div class="msg-sub-agent-header">
        ${iconHtml('puzzle', 12)} 子 Agent: ${escapeHtml(data.description)}
        <span style="font-size:8px;opacity:0.5">${data.mode === 'fork' ? '继承上下文' : '独立'}</span>
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
      oldStr = args['old_string'] || args['old_text'] || '';
      newStr = args['new_string'] || args['new_text'] || args['content'] || '';
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
