// ── Message renderer — pure DOM builders for ChatMessage objects
// Each function takes a message record and returns an HTMLElement.
// No mutable class state, no querySelectorAll across messages.
//
// Callbacks (onEdit, onResend, etc.) are injected by ChatPanel.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { gsap } from 'gsap';
import type {
  AssistantMessage,
  AssistantPart,
  ChatMessage,
  FileAttachment,
  MessageId,
  ReasonPart,
  TextPart,
  ToolCallPart,
  UserMessage,
} from './message-model';

// ── Re-export type for external use ──────────────────────
export type { MessageId, ChatMessage, UserMessage, AssistantMessage, AssistantPart };

// ── Icons (inline SVG, copied from icons.ts to keep renderer self-contained) ──

const SVG_ICONS: Record<string, string> = {
  'edit': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  'refresh': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>',
  'copy': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  'check-circle': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  'close': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  'dot': '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>',
  'code': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  'search': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  'chevron-right': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
};

function iconHtml(name: string, size: number = 12): string {
  const svg = SVG_ICONS[name];
  if (!svg) return '';
  return svg.replace(/width="\d+"/, `width="${size}"`).replace(/height="\d+"/, `height="${size}"`);
}

// ── Utilities ────────────────────────────────────────────

function truncateArgs(args: string): string {
  if (args.length <= 60) return args;
  return args.slice(0, 57) + '…';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format tool result for display inside a card. */
function formatToolResult(
  toolName: string,
  text: string,
  truncated: boolean,
): string {
  if (!text) return '(无输出)';
  const maxLen = 2000;
  let out = text.length > maxLen ? text.slice(0, maxLen) + '\n…(截断)' : text;
  if (truncated) out += '\n…(输出超长已截断)';
  // Detect JSON → pretty-print
  try {
    const obj = JSON.parse(text);
    out = JSON.stringify(obj, null, 2);
    if (out.length > maxLen) out = out.slice(0, maxLen) + '\n…(截断)';
    if (truncated) out += '\n…(输出超长已截断)';
  } catch {}
  // Try to detect code blocks and wrap
  if (out.includes('```')) {
    return out;
  }
  if (out.length > 80 && out.indexOf('\n') >= 0) {
    return '```\n' + out + '\n```';
  }
  return out;
}

// ── Callback types ───────────────────────────────────────

export interface RenderCallbacks {
  /** User clicked "edit" on their message. */
  onEditUserMessage?: (msg: UserMessage) => void;
  /** User clicked "resend" on their message. */
  onResendUserMessage?: (msg: UserMessage) => void;
  /** User clicked "retry" on an assistant message. */
  onRetryAssistant?: (msg: AssistantMessage, userText: string) => void;
  /** User clicked "copy" on an assistant message. */
  onCopyText?: (text: string, button: HTMLElement) => void;
  /** Node name was clicked in markdown text. */
  onNavigateToNode?: (nodeName: string) => void;
  /** Tool card header was clicked (expand/collapse). */
  onToggleToolCard?: (card: HTMLElement) => void;
  /** User clicked the tool summary to expand all cards. */
  onExpandToolSummary?: (wrapper: HTMLElement) => void;
  /** Whether the reasoning block at blockIndex is currently expanded. */
  isReasoningExpanded?: (blockIndex: number) => boolean;
  /** User toggled a reasoning block. blockIndex is 0-based among reasoning parts. */
  onToggleReasoning?: (blockIndex: number) => void;
}

// ── Streaming text renderer ──────────────────────────────
// ponytail: show raw text during streaming — marked.parse() on half-written
// markdown produces garbled/empty output. Full markdown render happens in
// finaliseMarkdown() when the turn completes.

/** Streaming text: raw display with typing cursor. Markdown rendered on finalise. */
function renderStreamingText(rawText: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-text msg-markdown streaming';
  wrapper.textContent = rawText;
  return wrapper;
}

/** Finalise a streaming text div — replace with full markdown + syntax highlight. */
function finaliseMarkdown(el: HTMLElement, rawText: string): void {
  el.classList.remove('streaming');
  const html = DOMPurify.sanitize(marked.parse(rawText) as string);
  el.innerHTML = html;
  el.dataset.rawMarkdown = rawText;
  el.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block as HTMLElement);
  });
}

// ── Tool card ────────────────────────────────────────────

function renderToolCard(
  tool: ToolCallPart,
  callbacks?: RenderCallbacks,
): HTMLElement {
  const card = document.createElement('div');
  card.className = `msg-tool-card${tool.status === 'done' || tool.status === 'error' ? ' tool-done' : ''}`;
  card.dataset.toolId = tool.toolId;

  // Header
  const header = document.createElement('div');
  header.className = 'msg-tool-header';
  if (tool.status === 'done' || tool.status === 'error') {
    header.style.padding = '2px 8px';
  }

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  const icon = tool.readOnly ? iconHtml('search', 12) : iconHtml('code', 12);
  nameEl.innerHTML = `${icon} ${tool.label || tool.name}`;

  // Status dot
  const status = document.createElement('span');
  if (tool.status === 'running') {
    status.className = 'tool-status tool-status-running';
    status.innerHTML = iconHtml('dot', 10);
  } else if (tool.status === 'error') {
    status.className = 'tool-status tool-err';
    status.innerHTML = iconHtml('close', 12);
  } else if (tool.status === 'done') {
    status.className = 'tool-status tool-ok';
    status.style.opacity = '0.6';
    status.innerHTML = iconHtml('check-circle', 12);
  } else {
    status.className = 'tool-status tool-status-pending';
    status.innerHTML = iconHtml('dot', 10);
  }

  header.append(nameEl, status);
  header.addEventListener('click', () => {
    if (callbacks?.onToggleToolCard) {
      callbacks.onToggleToolCard(card);
    } else {
      card.classList.toggle('tool-expanded');
    }
  });

  // Result area
  const resultEl = document.createElement('div');
  resultEl.className = 'msg-tool-result';
  if (tool.status === 'running' && tool.output) {
    resultEl.textContent = tool.output;
    card.classList.add('tool-expanded');
  } else if (tool.status === 'done' || tool.status === 'error') {
    const text = tool.err || tool.output || '';
    const formatted = formatToolResult(tool.name, text, !!tool.truncated);
    resultEl.innerHTML = formatted;
    resultEl.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
    if (tool.status === 'error') card.classList.add('tool-expanded');
  }

  card.append(header, resultEl);
  return card;
}

// ── Tool summary (compact folding) ───────────────────────

function renderToolSummary(
  tools: ToolCallPart[],
  onExpand?: () => void,
): HTMLElement {
  const doneTools = tools.filter((t) => t.status === 'done' || t.status === 'error');
  const names = doneTools.map((t) => t.label || t.name);
  const unique = [...new Set(names)];

  const el = document.createElement('div');
  el.className = 'msg-tool-summary';
  el.style.cursor = 'pointer';
  el.title = '点击展开所有工具';
  el.innerHTML = `${iconHtml('check-circle', 12)} 已执行 ${doneTools.length} 个工具：<span>${unique.slice(0, 3).join(', ')}${unique.length > 3 ? ` 等 ${unique.length} 个` : ''}</span>`;

  el.addEventListener('click', () => onExpand?.());
  return el;
}

// ── Reasoning block ──────────────────────────────────────

function renderReasoningBlock(text: string, blockIndex: number, callbacks?: RenderCallbacks): HTMLElement {
  const block = document.createElement('div');
  block.className = 'msg-reasoning';

  const toggle = document.createElement('button');
  toggle.className = 'msg-reasoning-toggle';

  const content = document.createElement('div');
  content.className = 'msg-reasoning-content';
  content.textContent = text;

  // Restore expanded state from model (survives DOM replacement across streaming frames)
  const startExpanded = callbacks?.isReasoningExpanded?.(blockIndex) ?? false;
  if (startExpanded) {
    content.classList.add('msg-reasoning-open');
    toggle.innerHTML = `${iconHtml('chevron-down')} 收起思考`;
  } else {
    toggle.innerHTML = `${iconHtml('chevron-right')} 思考过程`;
  }

  // Click handled by delegated listener on msgList (chat.ts) —
  // survives replaceWith during CoT streaming.

  block.append(toggle, content);
  return block;
}

// ── User message ─────────────────────────────────────────

function renderUserMessage(
  msg: UserMessage,
  callbacks?: RenderCallbacks,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'msg-user-row';
  row.dataset.messageId = msg._id;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble user';

  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = msg.text;
  textEl.dataset.rawMarkdown = msg.text;
  bubble.appendChild(textEl);

  // Attached file pills
  if (msg.files && msg.files.length > 0) {
    const pills = document.createElement('div');
    pills.className = 'msg-attach-pills';
    pills.innerHTML = msg.files
      .map((f) => {
        const sizeStr =
          f.size < 1024
            ? `${f.size} B`
            : f.size < 1024 * 1024
              ? `${(f.size / 1024).toFixed(1)} KB`
              : `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
        return `<span class="msg-attach-pill">📄 ${f.name} <span class="attach-pill-size">${sizeStr}</span></span>`;
      })
      .join('');
    bubble.appendChild(pills);
  }

  row.appendChild(bubble);

  // Action buttons (edit + resend)
  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  if (callbacks?.onEditUserMessage) {
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action-btn';
    editBtn.innerHTML = iconHtml('edit', 12);
    editBtn.title = '编辑消息';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onEditUserMessage?.(msg);
    });
    actions.append(editBtn);
  }

  if (callbacks?.onResendUserMessage) {
    const resendBtn = document.createElement('button');
    resendBtn.className = 'msg-action-btn';
    resendBtn.innerHTML = iconHtml('refresh', 12);
    resendBtn.title = '重新发送';
    resendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onResendUserMessage?.(msg);
    });
    actions.append(resendBtn);
  }

  if (actions.children.length > 0) {
    row.appendChild(actions);
  }

  return row;
}

// ── Assistant message ────────────────────────────────────

function renderAssistantMessage(
  msg: AssistantMessage,
  callbacks?: RenderCallbacks,
): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble assistant';
  bubble.dataset.messageId = msg._id;
  if (msg.status === 'streaming') bubble.dataset.streaming = 'true';

  if (msg.status === 'error' && msg.errorMessage) {
    const err = document.createElement('div');
    err.className = 'msg-notice msg-notice-error';
    err.textContent = msg.errorMessage;
    bubble.appendChild(err);
    return bubble;
  }

  // ── Render parts in order (interleaved reasoning / tools / text) ──
  // ponytail: parts are ordered by arrival time. Grouping by type breaks
  // the visual flow: second reasoning MUST appear after its preceding tools.
  const textParts: TextPart[] = [];
  let toolRun: ToolCallPart[] = [];

  const flushToolRun = () => {
    if (toolRun.length === 0) return;
    const toolWrapper = document.createElement('div');
    toolWrapper.className = 'msg-tool-wrapper';

    const doneCount = toolRun.filter(
      (t) => t.status === 'done' || t.status === 'error',
    ).length;
    const allDone = doneCount === toolRun.length && toolRun.length >= 3;

    if (allDone) {
      const summary = renderToolSummary(toolRun, () => {
        toolWrapper.querySelectorAll('.msg-tool-card').forEach((c) => {
          (c as HTMLElement).style.display = '';
        });
        const sumEl = toolWrapper.querySelector('.msg-tool-summary');
        if (sumEl) sumEl.remove();
      });
      toolWrapper.appendChild(summary);
      for (const tp of toolRun) {
        const card = renderToolCard(tp, callbacks);
        card.style.display = 'none';
        toolWrapper.appendChild(card);
      }
    } else {
      for (const tp of toolRun) {
        toolWrapper.appendChild(renderToolCard(tp, callbacks));
      }
    }
    bubble.appendChild(toolWrapper);
    toolRun = [];
  };

  const flushTextRun = () => {
    if (textParts.length === 0) return;
    const combinedText = textParts.map((p) => p.text).join('');
    const allDone = textParts.every((p) => p.finalised);
    if (combinedText) {
      if (!allDone || msg.status === 'streaming') {
        bubble.appendChild(renderStreamingText(combinedText));
      } else {
        const textEl = document.createElement('div');
        textEl.className = 'msg-text msg-markdown';
        finaliseMarkdown(textEl, combinedText);
        bubble.appendChild(textEl);
      }
    }
    // Clear for next run
    textParts.length = 0;
  };

  let reasoningIdx = 0;
  for (const part of msg.parts) {
    switch (part.type) {
      case 'reasoning':
        flushToolRun();
        flushTextRun();
        bubble.appendChild(renderReasoningBlock(part.text, reasoningIdx++, callbacks));
        break;
      case 'tool':
        flushTextRun();
        toolRun.push(part as ToolCallPart);
        break;
      case 'text':
        flushToolRun();
        textParts.push(part as TextPart);
        break;
    }
  }
  // Flush any trailing groups
  flushToolRun();
  flushTextRun();

  // Compute finalised flag for code-block buttons
  const allFinalised = msg.parts
    .filter((p): p is TextPart => p.type === 'text')
    .every((p) => p.finalised);

  // Code block buttons (view/copy) — injected after render
  if (allFinalised || msg.status === 'done') {
    injectCodeBlockButtons(bubble);
  }

  // Action buttons (copy + retry)
  if (msg.status === 'done') {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.innerHTML = iconHtml('copy', 12);
    copyBtn.title = '复制回复';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const raw = msg.parts
        .filter((p): p is TextPart => p.type === 'text')
        .map((p) => p.text)
        .join('');
      if (callbacks?.onCopyText) {
        callbacks.onCopyText(raw, copyBtn);
      } else {
        navigator.clipboard.writeText(raw).catch(() => {});
      }
    });
    actions.append(copyBtn);

    // Retry button — needs to find the user text that triggered this
    if (callbacks?.onRetryAssistant) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'msg-action-btn';
      retryBtn.innerHTML = iconHtml('refresh', 12);
      retryBtn.title = '重试此回复';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // The user text will be resolved by ChatPanel which has the full turnPairs
        callbacks.onRetryAssistant?.(msg, '');
      });
      actions.append(retryBtn);
    }

    if (actions.children.length > 0) {
      bubble.appendChild(actions);
    }
  }

  return bubble;
}

// ── Notice message ───────────────────────────────────────

function renderNoticeMessage(msg: ChatMessage & { role: 'notice' }): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg-notice msg-notice-${msg.level || 'info'}`;
  el.textContent = msg.text;
  return el;
}

// ── Top-level dispatcher ─────────────────────────────────

export function renderMessage(
  msg: ChatMessage,
  callbacks?: RenderCallbacks,
): HTMLElement {
  switch (msg.role) {
    case 'user':
      return renderUserMessage(msg as UserMessage, callbacks);
    case 'assistant':
      return renderAssistantMessage(msg as AssistantMessage, callbacks);
    case 'notice':
      return renderNoticeMessage(msg as any);
    default:
      return document.createElement('div');
  }
}

// ── Shared utilities ─────────────────────────────────────

/** Inject copy + view-file buttons into code blocks. */
export function injectCodeBlockButtons(bubble: HTMLElement): void {
  bubble.querySelectorAll('.msg-markdown pre').forEach((pre) => {
    if (pre.querySelector('.pre-code-actions')) return;
    const container = document.createElement('div');
    container.className = 'pre-code-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'pre-code-action-btn';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      if (code) {
        navigator.clipboard.writeText(code.textContent || '').catch(() => {});
      }
    });
    container.append(copyBtn);
    pre.appendChild(container);
  });
}

/** Show "copied" feedback on a button. */
export function showCopiedFeedback(btn: HTMLElement, iconSize: number): void {
  const orig = btn.innerHTML;
  btn.innerHTML = iconHtml('check-circle', iconSize);
  setTimeout(() => {
    btn.innerHTML = orig;
  }, 1200);
}

/** Toggle a tool card expanded/collapsed. */
export function toggleToolCard(card: HTMLElement): void {
  card.classList.toggle('tool-expanded');
}
