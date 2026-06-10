// Chat Panel — 聊天面板 UI
// 纯 DOM 渲染，EventSink → 消息气泡 / 工具卡片 / 思考折叠
// Agent 引擎 (agent.ts) 已完整，此文件只管"把事件画到屏幕上"

import type { Agent, AgentEvent } from '../agent/agent';
import { EventKind } from '../agent/agent';
import type { StarGraph } from './graph';
import { iconHtml } from './icons';
import { visualizeAgentTool } from './agent-visualizer';
import { bus } from './events';
import { loadSettings } from '../settings';
import { invoke } from '../bridge';
import type { Message } from '../provider/types';
import { marked } from 'marked';
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

  setOnOpenSettings(fn: () => void): void { this.onOpenSettings = fn; }
  setAgentFactory(fn: () => Promise<Agent | null>): void { this.agentFactory = fn; }

  constructor(container: HTMLElement) {
    this.container = container;
    this.buildDOM();
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
    // Remove session
    const s = this.sessions[idx];
    this.sessionMessages.delete(s.id);
    this.sessions.splice(idx, 1);
    // Adjust active index
    if (this.activeIdx >= this.sessions.length) this.activeIdx = this.sessions.length - 1;
    if (this.activeIdx < 0) this.activeIdx = 0;
    this.renderSessionTabs();
    this.restoreMessages();
    this.updateFooter();
  }

  private async createNewSession(): Promise<void> {
    if (!this.agentFactory) {
      this.addNotice('请先配置 API Key（设置 → Provider）', 'info');
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
  }

  // ── Session persistence ──

  /** Save all sessions to project's .hologram/chat_sessions.json */
  async saveAllSessions(projectPath: string): Promise<void> {
    if (!projectPath || this.sessions.length === 0) return;
    const data = {
      version: 1,
      sessions: this.sessions.map((s) => ({
        id: s.id,
        label: s.label,
        messages: s.agent.getSession(),
      })),
      activeIdx: this.activeIdx,
      nextId: nextSessionId,
    };
    const json = JSON.stringify(data);
    try {
      await invoke('write_file_content', {
        file_path: `${projectPath.replace(/\\/g, '/')}/.hologram/chat_sessions.json`,
        content: json,
      });
    } catch (e) {
      console.error('[chat] 保存会话失败:', e);
    }
  }

  /** Load sessions from project's .hologram/chat_sessions.json */
  async loadAllSessions(projectPath: string): Promise<void> {
    if (!this.agentFactory || !projectPath) return;

    let json: string;
    try {
      json = await invoke<string>('read_file_content', {
        file_path: `${projectPath.replace(/\\/g, '/')}/.hologram/chat_sessions.json`,
      });
    } catch {
      return; // No saved sessions, first time
    }

    let data: any;
    try { data = JSON.parse(json); } catch { return; }
    if (!data.sessions || data.sessions.length === 0) return;

    // Rebuild sessions
    const restored: ChatSession[] = [];
    for (const saved of data.sessions) {
      const agent = await this.agentFactory();
      if (!agent) continue;
      // Keep fresh system prompt, restore conversation
      const freshSystem = agent.getSession().filter((m) => m.role === 'system');
      const savedConv = (saved.messages as Message[]).filter((m) => m.role !== 'system');
      agent.setSession([...freshSystem, ...savedConv]);

      restored.push({
        id: saved.id,
        label: saved.label || `会话 ${restored.length + 1}`,
        agent,
      });
    }
    if (restored.length === 0) return;

    // Save current messages before replacing
    if (this.activeIdx >= 0) this.saveCurrentMessages();
    this.flushReasoning();
    this.flushText();
    this.pendingToolCards.clear();

    this.sessions = restored;
    nextSessionId = Math.max(nextSessionId, data.nextId || 0);
    this.activeIdx = Math.min(
      Math.max(0, data.activeIdx ?? 0),
      restored.length - 1,
    );
    this.renderSessionTabs();
    this.msgList.innerHTML = '';
    this.lastUsageText = '';
    this.updateFooter();
    this.addNotice(`已恢复 ${restored.length} 个会话`, 'info');
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
    this.headerEl.appendChild(closeBtn);
    this.panel.appendChild(this.headerEl);

    // Messages
    this.msgList = document.createElement('div');
    this.msgList.className = 'chat-messages';
    this.panel.appendChild(this.msgList);

    // Welcome hint
    const hint = document.createElement('div');
    hint.className = 'chat-hint';
    hint.textContent = this.agent
      ? '向我提问代码库的问题，或直接聊天'
      : '请先配置 API Key（点击工具栏 设置 或在对话中设置）';
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
    // Save current messages before clearing
    if (this.activeIdx >= 0) this.saveCurrentMessages();
    this.agent.newSession();
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
    });
    bus.emit('chat:turn-done', {});
  }

  private async sendMessage(): Promise<void> {
    const text = this.inputArea.value.trim();
    if (!text || this.running) return;

    if (!this.agent) {
      this.addNotice('Agent 未就绪 — 请先配置 API Key 或等待项目加载', 'error');
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

    this.inputArea.value = '';
    this.inputArea.style.height = 'auto';
    this.setRunning(true);

    // Remove hint if present
    const hint = this.msgList.querySelector('.chat-hint');
    if (hint) hint.remove();

    // User bubble
    this.appendUserBubble(text);
    this.scrollBottom();

    // Start turn separator
    this.addTurnSep();

    // Run agent
    this.abortCtrl = new AbortController();
    try {
      await this.agent.run(this.abortCtrl.signal, text);
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

  private appendText(text: string, isFinal: boolean): void {
    this.ensureAssistantBubble();
    if (!this.currentTextEl) {
      this.currentTextEl = document.createElement('div');
      this.currentTextEl.className = 'msg-text streaming';
      this.currentBubble!.appendChild(this.currentTextEl);
    }
    this.currentTextEl.textContent += text;
    if (isFinal) {
      // make links clickable
      this.autoLink(this.currentTextEl);
    }
    this.scrollBottom();
  }

  private flushText(): void {
    // 移除流式光标
    if (this.currentTextEl) {
      this.currentTextEl.classList.remove('streaming');
    }
    // 添加消息操作按钮（复制等）
    if (this.currentBubble) {
      this.addMessageActions(this.currentBubble);
    }
    this.currentTextEl = null;
    this.currentBubble = null;
  }

  // ── Markdown rendering (final only, not during streaming) ──

  private renderMarkdownText(text: string): void {
    this.ensureAssistantBubble();
    // Replace streaming text element with markdown-rendered content
    if (this.currentTextEl) {
      this.currentTextEl.remove();
    }
    const el = document.createElement('div');
    el.className = 'msg-text msg-markdown';
    // Render markdown
    const html = marked.parse(text) as string;
    el.innerHTML = html;
    // Syntax-highlight code blocks
    el.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
    this.currentBubble!.appendChild(el);
    this.currentTextEl = el;
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
      resultEl.textContent = tool.truncated ? text + '\n…[截断]…' : text;
    }

    // Auto-expand on error
    if (tool.err) {
      card.classList.add('tool-expanded');
    }

    // Trigger star graph visualization from tool result
    if (!tool.err && tool.output && this.starGraph) {
      try {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tool.args || '{}'); } catch { /* ignore */ }
        visualizeAgentTool(tool.name, args, tool.output, this.starGraph);
      } catch { /* visualization failure is silent */ }
    }
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

    this.footerEl.innerHTML = `
      <div class="chat-footer-left">
        <button class="chat-model-badge chat-model-clickable" title="点击切换模型 · ${active?.name} / ${active?.model}">
          ${iconHtml('agent', 10)} ${modelLabel}${thinking}
        </button>
        <span class="chat-usage-badge">${usageStr}</span>
      </div>
      <div class="chat-footer-right">
        <button class="chat-slash-trigger" title="命令菜单">
          ${iconHtml('code', 12)}<span class="chat-slash-label">/</span>
        </button>
        <button class="chat-session-add" title="新建会话">${iconHtml('plus', 12)}</button>
      </div>`;

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

    // Close popup on outside click
    document.addEventListener('click', (e) => {
      if (!popup.contains(e.target as Node) && e.target !== trigger) {
        popup.classList.remove('open');
      }
    }, { once: true });

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
            const found = graph.focusNode(token);
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

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
