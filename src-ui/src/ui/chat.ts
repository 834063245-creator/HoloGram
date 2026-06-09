// Chat Panel — 聊天面板 UI
// 纯 DOM 渲染，EventSink → 消息气泡 / 工具卡片 / 思考折叠
// Agent 引擎 (agent.ts) 已完整，此文件只管"把事件画到屏幕上"

import type { Agent, AgentEvent } from '../agent/agent';
import { EventKind } from '../agent/agent';
import type { StarGraph } from './graph';
import { iconHtml } from './icons';

// ── Constants ──

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
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

  // Streaming state
  private agent: Agent | null = null;
  private starGraph: StarGraph | null = null;
  private abortCtrl: AbortController | null = null;
  private running = false;

  // Current message DOM refs (streaming targets)
  private currentBubble: HTMLElement | null = null;
  private currentReasoning: HTMLElement | null = null;
  private currentReasoningContent: HTMLElement | null = null;
  private currentTextEl: HTMLElement | null = null;
  private pendingToolCards = new Map<string, HTMLElement>(); // id → card element

  private openState = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.buildDOM();
  }

  // ── Public API ──

  setAgent(agent: Agent | null): void { this.agent = agent; }
  getAgent(): Agent | null { return this.agent; }
  setStarGraph(g: StarGraph): void { this.starGraph = g; }

  toggle(): void { this.openState ? this.close() : this.open(); }

  open(): void {
    this.openState = true;
    this.panel.classList.add('chat-open');
    setTimeout(() => this.inputArea.focus(), 200);
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
  }

  isOpen(): boolean { return this.openState; }

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
    const header = document.createElement('div');
    header.className = 'chat-header';
    const title = document.createElement('span');
    title.className = 'chat-title';
    title.innerHTML = `${iconHtml('chat')} 全息对话`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'chat-close-btn';
    closeBtn.innerHTML = iconHtml('close', 16);
    closeBtn.addEventListener('click', () => this.close());
    header.append(title, closeBtn);
    this.panel.appendChild(header);

    // Messages
    this.msgList = document.createElement('div');
    this.msgList.className = 'chat-messages';
    this.panel.appendChild(this.msgList);

    // Welcome hint
    const hint = document.createElement('div');
    hint.className = 'chat-hint';
    hint.textContent = this.agent
      ? '向我提问代码库的问题，或直接聊天'
      : '请先配置 API Key（点击工具栏 ⚙ 或在对话中设置）';
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

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + (startX - e.clientX)));
      this.panel.style.width = w + 'px';
    };

    const onUp = () => {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Send ──

  private async sendMessage(): Promise<void> {
    const text = this.inputArea.value.trim();
    if (!text || this.running) return;

    if (!this.agent) {
      this.addNotice('Agent 未就绪 — 请先配置 API Key 或等待项目加载', 'error');
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
        if (ev.text) this.appendText(ev.text, true);
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
      this.currentTextEl.className = 'msg-text';
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
    this.currentTextEl = null;
    this.currentBubble = null;
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

    this.ensureAssistantBubble();
    this.flushReasoning();
    this.flushText();

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

    pill.textContent = label;
    this.currentBubble!.appendChild(pill);
    this.scrollBottom();
  }

  // ── Notice ──

  private addNotice(text: string, level: 'info' | 'warn' | 'error'): void {
    const el = document.createElement('div');
    el.className = `msg-notice msg-notice-${level}`;
    el.textContent = text;
    this.msgList.appendChild(el);
    this.scrollBottom();
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

    const text = el.textContent || '';
    // Find identifiers that look like code symbols (snake_case, CamelCase, dot.paths)
    const tokens = extractCodeTokens(text);
    if (tokens.length === 0) return;

    const html = replaceTokens(text, tokens, (token) => {
      return `<span class="node-link" data-nodename="${escapeAttr(token)}" title="点击定位: ${escapeAttr(token)}">${token}</span>`;
    });

    if (html !== text) {
      el.innerHTML = html;
      // Attach click handlers
      el.querySelectorAll('.node-link').forEach((link) => {
        link.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = (link as HTMLElement).dataset['nodename'] || '';
          if (name && graph) {
            const found = graph.focusNode(name);
            if (!found) {
              this.addNotice(`未在图中找到 "${name}"`, 'info');
            }
          }
        });
      });
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

function replaceTokens(
  text: string,
  tokens: string[],
  wrap: (token: string) => string,
): string {
  let result = '';
  let pos = 0;

  // Find the earliest occurrence of any token at each position
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
      result += escapeHtml(text.slice(pos));
      break;
    }
    result += escapeHtml(text.slice(pos, bestIdx));
    result += wrap(bestToken);
    pos = bestIdx + bestToken.length;
  }
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
