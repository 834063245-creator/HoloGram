// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatMessages — React 消息列表渲染
//
// 渲染引擎：react-markdown（替代 marked + dangerouslySetInnerHTML）
// 滚动管理：wheel capture phase rAF 合并（参考 Reasonix useScrollManager）
// 推理块：流式时展开，流结束自动折叠（用户手动 toggle 后尊重用户选择）
// 流式截断：推理文本只保留末尾 12,000 字符 / 240 行

import { useVirtualizer } from '@tanstack/react-virtual';
import hljs from 'highlight.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from 'zustand';
import { iconSvg } from '../icons';
import { computeSimpleDiff, formatToolResult } from '../chat-utils';
import { estimateMessageHeight, getMessageGap } from '../message-height';
import type {
  AssistantMessage,
  AssistantPart,
  NoticeMessage,
  SubAgentPart,
  TextPart,
  ToolCallPart,
  UserMessage,
} from '../message-model';
import { getMessagesStore } from '../messages-store';
import { getSessionStore } from '../session-store';

// ── Constants ──

const BOTTOM_THRESHOLD = 80;
const REASONING_TAIL_CHARS = 12_000;
const REASONING_TAIL_LINES = 240;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
}

function truncateReasoning(text: string): string {
  let out = text;
  let truncated = false;
  if (REASONING_TAIL_CHARS > 0 && out.length > REASONING_TAIL_CHARS) {
    out = out.slice(-REASONING_TAIL_CHARS);
    truncated = true;
  }
  if (REASONING_TAIL_LINES > 0) {
    const lines = out.split('\n');
    if (lines.length > REASONING_TAIL_LINES) {
      out = lines.slice(-REASONING_TAIL_LINES).join('\n');
      truncated = true;
    }
  }
  return truncated ? '…\n' + out : out;
}

// ── Callbacks ──

export interface ChatMessagesCallbacks {
  onEditUserMessage?: (msg: UserMessage) => void;
  onResendUserMessage?: (msg: UserMessage) => void;
  onRetryAssistant?: (msg: AssistantMessage) => void;
  onCopyText?: (text: string) => void;
  onNavigateToNode?: (nodeName: string) => void;
}

// ── Icons ──

function svgIcon(name: string, size: number = 12): string {
  return iconSvg(name, size);
}

// ── Node name linkification ──
// ReactMarkdown renders `code` as <code> elements. We iterate over inline
// <code> elements (not block <pre><code>) and wrap them as clickable links.

function linkifyNodeNames(container: HTMLElement, onNavigate?: (name: string) => void): void {
  if (!onNavigate) return;
  const codeEls = container.querySelectorAll('code:not(pre code)');
  codeEls.forEach((el) => {
    if (el.querySelector('.node-link')) return; // already linkified
    const name = el.textContent || '';
    if (!name) return;
    const span = document.createElement('span');
    span.className = 'node-link';
    span.textContent = name;
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      onNavigate(name);
    });
    el.replaceWith(span);
  });
}

// ── react-markdown code component (hljs highlighting) ──

function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  const text = String(children ?? '').replace(/\n$/, '');
  const match = /language-([\w-]+)/.exec(className ?? '');
  const _lang = match?.[1];
  const isBlock = match !== null || text.includes('\n');

  // Highlight code blocks — skip already-highlighted elements via data attribute.
  // During streaming, the completed portion re-renders react-markdown on every
  // paragraph boundary crossing. Without this guard, hljs rescans every <pre code>
  // on each re-render even if the content hasn't changed.
  useEffect(() => {
    if (!ref.current) return;
    ref.current.querySelectorAll('pre code:not([data-highlighted])').forEach((block) => {
      try {
        hljs.highlightElement(block as HTMLElement);
        block.setAttribute('data-highlighted', 'true');
      } catch {
        /* noop */
      }
    });
  }, [text]);

  if (isBlock) {
    return (
      <div ref={ref}>
        <pre>
          <code className={className}>{text}</code>
        </pre>
      </div>
    );
  }
  return <code className="md-code">{children}</code>;
}

// ── Markdown content (streaming-aware) ──

// ── Incremental streaming block splitter ──
// Splits streaming text at the last safe paragraph boundary (double newline
// outside code blocks). Completed portion renders as markdown; trailing
// incomplete portion renders as plain text with breathing cursor.
// Also detects open ``` code fences for editor-style rendering.

function splitStreamingBlocks(text: string): { completed: string; tail: string } {
  if (!text) return { completed: '', tail: '' };

  // Normalize Windows-style line endings so \r\n\r\n is treated as \n\n
  text = text.replace(/\r\n/g, '\n');

  // Find all ``` positions (crude but in practice ``` rarely appears in prose)
  const fences: number[] = [];
  let fi = 0;
  while (fi < text.length) {
    const idx = text.indexOf('\n```', fi);
    if (idx === -1) break;
    fences.push(idx + 1); // position of the backtick after \n
    fi = idx + 4;
  }
  // Also check if text starts with ```
  if (text.startsWith('```')) fences.unshift(0);

  // Search backwards for the last safe \n\n
  let lastSafe = -1;
  for (let pos = text.length - 2; pos >= 0; pos--) {
    if (text.slice(pos, pos + 2) === '\n\n') {
      // Count fences before this position
      let open = 0;
      for (const f of fences) if (f < pos) open++;
      if (open % 2 === 0) {
        lastSafe = pos + 2;
        break;
      }
    }
  }

  if (lastSafe <= 0) return { completed: '', tail: text };
  return { completed: text.slice(0, lastSafe), tail: text.slice(lastSafe) };
}

function RenderStreamingTail({ text }: { text: string }) {
  // Detect open code fence: line starting with ``` not yet closed
  const fenceMatch = text.match(/^```(\S*)\n([\s\S]*)/);
  if (fenceMatch) {
    const lang = fenceMatch[1] || '';
    const code = fenceMatch[2];
    return (
      <div className="streaming-code-block">
        {lang && <div className="streaming-code-lang">{lang}</div>}
        <pre><code>{code}</code></pre>
      </div>
    );
  }
  return <div className="msg-streaming-text">{text}</div>;
}

// ── Markdown content (streaming-aware, incremental rendering) ──

const MarkdownContent: React.FC<{
  text: string;
  streaming: boolean;
  onNavigateToNode?: (name: string) => void;
}> = React.memo(({ text, streaming, onNavigateToNode }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Linkify node names after render (on finalised content)
  useEffect(() => {
    if (streaming || !onNavigateToNode) return;
    const el = containerRef.current;
    if (el) linkifyNodeNames(el, onNavigateToNode);
  }, [streaming, onNavigateToNode]);

  // ── Always call hooks unconditionally ──
  const { completed, tail } = useMemo(
    () => (streaming ? splitStreamingBlocks(text) : { completed: '', tail: '' }),
    [text, streaming],
  );

  // Finalised — full markdown render
  if (!streaming) {
    return (
      <div ref={containerRef} className="msg-text msg-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code: MarkdownCode,
            pre: ({ children }) => <>{children}</>,
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    );
  }

  // ── Streaming: incremental rendering ──
  return (
    <div ref={containerRef} className="msg-text msg-markdown streaming">
      {completed ? (
        <div className="msg-streaming-completed">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: MarkdownCode,
              pre: ({ children }) => <>{children}</>,
            }}
          >
            {completed}
          </ReactMarkdown>
        </div>
      ) : null}
      {tail ? <RenderStreamingTail text={tail} /> : null}
      <span className="streaming-cursor" />
    </div>
  );
});

// ── Reasoning block ──
// Auto-expand while streaming; auto-collapse when done (respects user manual toggle).

const ReasoningBlock: React.FC<{
  text: string;
  streaming: boolean;
  reasoningComplete: boolean;
}> = React.memo(({ text, streaming, reasoningComplete }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const userOverridden = useRef(false);
  const [open, setOpen] = useState(streaming);

  // Auto open/close on streaming state transitions
  useEffect(() => {
    if (streaming) {
      if (!userOverridden.current) setOpen(true);
    } else if (reasoningComplete && !userOverridden.current) {
      setOpen(false);
    }
  }, [streaming, reasoningComplete]);

  const toggle = () => {
    userOverridden.current = true;
    setOpen((v) => !v);
  };

  const displayText = streaming ? truncateReasoning(text) : text;

  return (
    <div className={`msg-reasoning${open ? ' msg-reasoning-open' : ''}`}>
      <div className="msg-reasoning-toggle" onClick={toggle}>
        <span
          dangerouslySetInnerHTML={{
            __html: open ? svgIcon('chevron-down') : svgIcon('chevron-right'),
          }}
        />
        {open ? '收起思考' : '查看思考'}
      </div>
      <div ref={bodyRef} className={`msg-reasoning-content${open ? ' msg-reasoning-open' : ''}`}>
        <pre>{displayText}</pre>
      </div>
    </div>
  );
});

function renderToolContentPreview(part: ToolCallPart): React.ReactNode | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(part.args || '{}');
  } catch {
    return null;
  }
  const name = part.name;

  // write_file_content — show the file content being written
  if ((name === 'write_file' || name === 'write_file_content') && typeof args.content === 'string') {
    const content = args.content as string;
    const filePath = (args.filePath as string) || (args.file_path as string) || '';
    const header = filePath ? `// ${filePath}\n` : '';
    return (
      <div className="msg-tool-result">
        <pre><code>{header + content}</code></pre>
      </div>
    );
  }

  // edit_file — show the real diff (old → new) using LCS
  if (name === 'edit_file' && (typeof args.oldString === 'string' || typeof args.newString === 'string')) {
    const oldStr = (args.oldString as string) || '';
    const newStr = (args.newString as string) || '';
    const filePath = (args.filePath as string) || '';
    const maxLen = 400;
    const oldPreview = oldStr.length > maxLen ? oldStr.slice(0, maxLen) + '…' : oldStr;
    const newPreview = newStr.length > maxLen ? newStr.slice(0, maxLen) + '…' : newStr;
    const diffLines = computeSimpleDiff(oldPreview.split('\n'), newPreview.split('\n'));
    const lines: string[] = [];
    if (filePath) lines.push(`// ${filePath}`);
    for (const d of diffLines) lines.push(`${d.prefix} ${d.text}`);
    return (
      <div className="msg-tool-result">
        <pre><code>{lines.join('\n')}</code></pre>
      </div>
    );
  }

  return null;
}

// ── Tool card ──

// ponytail: NOT wrapped in React.memo — part-mutator mutates ToolCallPart in-place
// (tr.status = 'error'), so the object reference never changes. React.memo
// would block re-renders when tool status transitions (e.g. pending→running→done/error).
const ToolCard: React.FC<{ part: ToolCallPart; expanded: boolean; onToggle: () => void }> = ({
  part,
  expanded,
  onToggle,
}) => {
  // Auto-expand running tools immediately (no useState+useEffect delay)
  // so streaming shell output is visible from the first chunk.
  const isExpanded = expanded || part.status === 'running';
  const icon =
    part.status === 'running'
      ? svgIcon('dot')
      : part.status === 'done'
        ? svgIcon('check-circle')
        : part.status === 'error'
          ? svgIcon('close')
          : svgIcon('dot');
  const toolDone = part.status === 'done' || part.status === 'error';
  const badgeLabel =
    part.status === 'pending'
      ? '等待中'
      : part.status === 'running'
        ? '执行中'
        : part.status === 'done'
          ? '完成'
          : part.status === 'error'
            ? '失败'
            : '等待中';
  const badgeCls = part.status === 'done' ? 'badge-ok' : part.status === 'error' ? 'badge-fail' : 'badge-running';

  return (
    <div className={`msg-tool-card${toolDone ? ' tool-done' : ''}${isExpanded ? ' tool-expanded' : ''}`}>
      <div className="msg-tool-header" onClick={onToggle}>
        <span className="msg-tool-icon" dangerouslySetInnerHTML={{ __html: icon }} />
        <span className="tool-name">{part.name}</span>
        <span className="tool-args">
          {part.args && part.args.length > 60 ? part.args.slice(0, 57) + '…' : part.args || ''}
        </span>
        <span className={`msg-tool-badge ${badgeCls}`}>{badgeLabel}</span>
      </div>
      {isExpanded && part.output && (
        <div className="msg-tool-result" dangerouslySetInnerHTML={{ __html: formatToolResult(part.name, part.output, part.truncated ?? false, part.args) }} />
      )}
      {isExpanded && !part.output && part.status === 'running' && (
        renderToolContentPreview(part) || (
          <div className="msg-tool-result msg-tool-running">
            <div className="msg-text" style={{ color: 'var(--obs-text-3)' }}>执行中，等待输出…</div>
          </div>
        )
      )}
      {isExpanded && part.err && (
        <div className="msg-tool-result msg-tool-err">
          <pre>
            <code>{part.err}</code>
          </pre>
        </div>
      )}
    </div>
  );
};

// ── Tool summary ──

const ToolSummary: React.FC<{
  tools: ToolCallPart[];
  expandedTools: Set<string>;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}> = ({ tools, expandedTools, onExpandAll, onCollapseAll }) => {
  const doneTools = tools.filter((t) => t.status === 'done' || t.status === 'error');
  const names = doneTools.map((t) => t.label || t.name);
  const unique = [...new Set(names)];
  const allExpanded = doneTools.every((t) => expandedTools.has(t.toolId));
  return (
    <div
      className="msg-tool-summary"
      onClick={allExpanded ? onCollapseAll : onExpandAll}
      title={allExpanded ? '点击折叠所有工具' : '点击展开所有工具'}
    >
      <span dangerouslySetInnerHTML={{ __html: svgIcon('check-circle', 12) }} /> 已执行 {doneTools.length} 个工具：
      <span>
        {unique.slice(0, 3).join(', ')}
        {unique.length > 3 ? ` 等 ${unique.length} 个` : ''}
      </span>
    </div>
  );
};

// ── Sub-agent reasoning (collapsed except last) ──

const SubReasoningBlock: React.FC<{
  part: { type: 'reasoning'; text: string };
  parts: AssistantPart[];
  index: number;
}> = ({ part, parts, index }) => {
  // Find index of the LAST reasoning part — only that one renders expanded
  let lastIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'reasoning') {
      lastIdx = i;
      break;
    }
  }
  const isLast = index === lastIdx;
  const [open, setOpen] = useState(isLast);

  // Sync open state when a NEW part becomes the last (streaming progress)
  useEffect(() => {
    setOpen(isLast);
  }, [isLast]);

  const displayText = open ? (isLast ? truncateReasoning(part.text) : part.text) : '';

  return (
    <div className="msg-reasoning">
      <div className="msg-reasoning-toggle" onClick={() => setOpen((v) => !v)}>
        <span
          dangerouslySetInnerHTML={{
            __html: open ? svgIcon('chevron-down') : svgIcon('chevron-right'),
          }}
        />
        {open ? '收起思考' : `思考 (${(part.text.length / 1000).toFixed(0)}k)`}
      </div>
      {open && (
        <div className="msg-reasoning-content msg-reasoning-open">
          <pre>{displayText}</pre>
        </div>
      )}
    </div>
  );
};

// ── Sub-agent block ──
// Renders a nested collapsible group for sub-agent output inside an assistant message.
// Auto-expands while running; auto-collapses on done (respects user manual toggle).

// ponytail: NOT wrapped in React.memo — subagent-sink mutates SubAgentPart in-place
// (push to parts[], version++), so the object reference never changes. React.memo
// with any comparator on the same reference would always bail out, blocking
// streaming re-renders entirely. Performance is handled by useMemo on renderedParts;
// auto-scroll lives in the MutationObserver effect inside the component.
const SubAgentBlock: React.FC<{ part: SubAgentPart; onNavigateToNode?: (name: string) => void }> = ({ part, onNavigateToNode }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const userOverridden = useRef(false);
  const [expanded, setExpanded] = useState(part.status === 'running');
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (part.status === 'running' && !userOverridden.current) setExpanded(true);
    else if (part.status !== 'running' && !userOverridden.current) setExpanded(false);
  }, [part.status]);

  // Auto-scroll body div to bottom as new content streams in.
  // rAF-throttled to avoid synchronous layout thrashing from MutationObserver
  // firing on every DOM mutation during rapid streaming.
  // Sticks to bottom only when the user is already near it — scrolling up
  // inside the card must not be yanked back down by incoming chunks.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !expanded) return;
    let raf: number | null = null;
    const observer = new MutationObserver(() => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        if (nearBottom) el.scrollTop = el.scrollHeight;
      });
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [expanded]);

  const toggle = () => {
    userOverridden.current = true;
    setExpanded((v) => !v);
  };
  const toggleTool = useCallback((id: string) => {
    setExpandedTools((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }, []);

  const statusIcon =
    part.status === 'running' ? svgIcon('dot') : part.status === 'done' ? svgIcon('check-circle') : svgIcon('close');
  const statusLabel = part.status === 'running' ? '执行中' : part.status === 'done' ? '完成' : '失败';
  const statusCls = part.status === 'done' ? 'badge-ok' : part.status === 'error' ? 'badge-fail' : 'badge-running';

  const streaming = part.status === 'running';

  // Memoized parts list — re-builds only when sub-agent content changes,
  // not on every parent re-render (performance fix for large chat histories).
  const renderedParts = useMemo(() => {
    const items: React.ReactNode[] = [];
    let i = 0;
    while (i < part.parts.length) {
      const p = part.parts[i];
      if (p.type === 'tool') {
        const run: ToolCallPart[] = [];
        while (i < part.parts.length && part.parts[i].type === 'tool') {
          run.push(part.parts[i] as ToolCallPart);
          i++;
        }
        const tools = run;
        const doneTools = tools.filter((t) => t.status === 'done' || t.status === 'error');
        const allDone = doneTools.length === tools.length && tools.length >= 3;
        const groupExpanded = tools.some((t) => expandedTools.has(t.toolId));
        const collapsed = allDone && !groupExpanded;
        items.push(
          <div key={`tool-group-${i}`} className="msg-tool-wrapper">
            {collapsed ? (
              <ToolSummary
                tools={doneTools}
                expandedTools={expandedTools}
                onExpandAll={() => {
                  setExpandedTools((prev) => {
                    const n = new Set(prev);
                    for (const t of tools) n.add(t.toolId);
                    return n;
                  });
                }}
                onCollapseAll={() => {}}
              />
            ) : (
              <>
                {allDone && (
                  <ToolSummary
                    tools={doneTools}
                    expandedTools={expandedTools}
                    onExpandAll={() => {
                      setExpandedTools((prev) => {
                        const n = new Set(prev);
                        for (const t of tools) n.add(t.toolId);
                        return n;
                      });
                    }}
                    onCollapseAll={() => {
                      setExpandedTools((prev) => {
                        const n = new Set(prev);
                        for (const t of tools) n.delete(t.toolId);
                        return n;
                      });
                    }}
                  />
                )}
                {tools.map((t) => (
                  <ToolCard
                    key={t.toolId}
                    part={t}
                    expanded={expandedTools.has(t.toolId)}
                    onToggle={() => toggleTool(t.toolId)}
                  />
                ))}
              </>
            )}
          </div>,
        );
      } else if (p.type === 'reasoning') {
        items.push(<SubReasoningBlock key={i} part={p} parts={part.parts} index={i} />);
        i++;
      } else if (p.type === 'text') {
        const tp = p as TextPart;
        items.push(<MarkdownContent key={i} text={tp.text} streaming={streaming && !tp.finalised} onNavigateToNode={onNavigateToNode} />);
        i++;
      } else {
        i++;
      }
    }
    return items;
  }, [expandedTools, toggleTool, part.parts.length, streaming, part.parts, part.version, onNavigateToNode]);

  return (
    <div className={`msg-sub-agent${expanded ? ' open' : ''}`}>
      <div className="msg-sub-agent-header" onClick={toggle}>
        <span
          dangerouslySetInnerHTML={{
            __html: expanded ? svgIcon('chevron-down') : svgIcon('chevron-right'),
          }}
        />
        <span className="msg-sub-agent-icon" dangerouslySetInnerHTML={{ __html: statusIcon }} />
        <span className="msg-sub-agent-desc">{part.description}</span>
        <span className={`msg-tool-badge ${statusCls}`}>{statusLabel}</span>
      </div>
      <div ref={bodyRef} className={`msg-sub-agent-body${expanded ? ' open' : ''}`}>
        {renderedParts}
        {part.parts.length === 0 && part.status === 'running' && (
          <div className="msg-text" style={{ color: 'var(--obs-text-3)', padding: '8px 0' }}>
            分析中…
          </div>
        )}
        {part.parts.length === 0 && part.status === 'error' && (
          <div className="msg-text" style={{ color: 'var(--obs-fail)', padding: '8px 0' }}>
            执行失败
          </div>
        )}
      </div>
    </div>
  );
};

// ── User message ──

const UserBubble: React.FC<{
  msg: UserMessage;
  onEdit?: (m: UserMessage) => void;
  onResend?: (m: UserMessage) => void;
}> = React.memo(({ msg, onEdit, onResend }) => (
  <div className="msg-user-row" data-message-id={msg._id}>
    <div className="msg-bubble user">
      <div className="msg-text">{msg.text}</div>
      {msg.files && msg.files.length > 0 && (
        <div className="msg-attach-pills">
          {msg.files.map((f, i) => (
            <span key={i} className="msg-attach-pill">
              {f.name}{' '}
              <span className="attach-pill-size">
                ({f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`})
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
    <span className="msg-actions">
      {onEdit && (
        <span
          className="msg-action-btn"
          onClick={() => onEdit(msg)}
          title="编辑"
          dangerouslySetInnerHTML={{ __html: svgIcon('edit') }}
        />
      )}
      {onResend && (
        <span
          className="msg-action-btn"
          onClick={() => onResend(msg)}
          title="重发"
          dangerouslySetInnerHTML={{ __html: svgIcon('refresh') }}
        />
      )}
    </span>
  </div>
));

// ── Assistant message ──
// React.memo with pure reference comparison. This is ONLY correct because of
// the store's single write path rule (messages-store.ts): every in-place
// mutation of a message or its parts is committed via touchMessage /
// touchMessageContaining, which swaps in a new message object. No new
// reference ⇒ no re-render — so any future mutation path that skips the
// store commit will silently freeze the bubble. Mutate, then touch.

const AssistantBubble: React.FC<{
  msg: AssistantMessage;
  expandedTools: Set<string>;
  onToggleTool: (id: string) => void;
  onExpandAllTools: (ids: string[]) => void;
  onCollapseAllTools: (ids: string[]) => void;
  onCopy?: () => void;
  onRetry?: () => void;
  onNavigateToNode?: (name: string) => void;
}> = React.memo(
  ({
    msg,
    expandedTools,
    onToggleTool,
    onExpandAllTools,
    onCollapseAllTools,
    onCopy,
    onRetry,
    onNavigateToNode,
  }) => {
  const streaming = msg.status === 'streaming';

  // Count reasoning blocks so we know which one is "last" (still streaming)
  let reasoningTotal = 0;
  for (const p of msg.parts) {
    if (p.type === 'reasoning') reasoningTotal++;
  }
  let reasoningSeen = 0;

  // Build flat render groups — reasoning blocks are NOT pulled out to top;
  // they render inline, interspersed with tool groups and text.
  const groups: Array<
    | { kind: 'tool'; tools: ToolCallPart[] }
    | { kind: 'reasoning'; text: string; idx: number }
    | { kind: 'text'; text: string; finalised: boolean; idx: number }
    | { kind: 'subagent'; part: SubAgentPart }
  > = [];
  let i = 0;
  while (i < msg.parts.length) {
    const p = msg.parts[i];
    if (p.type === 'tool') {
      const run: ToolCallPart[] = [p as ToolCallPart];
      i++;
      while (i < msg.parts.length && msg.parts[i].type === 'tool') {
        run.push(msg.parts[i] as ToolCallPart);
        i++;
      }
      groups.push({ kind: 'tool', tools: run });
    } else if (p.type === 'reasoning') {
      reasoningSeen++;
      groups.push({ kind: 'reasoning', text: p.text, idx: reasoningSeen });
      i++;
    } else if (p.type === 'text') {
      const tp = p as TextPart;
      groups.push({ kind: 'text', text: tp.text, finalised: tp.finalised, idx: i });
      i++;
    } else if (p.type === 'subagent') {
      groups.push({ kind: 'subagent', part: p as SubAgentPart });
      i++;
    } else {
      i++;
    }
  }

  return (
                <div className="msg-assistant-row" data-message-id={msg._id}>
      <div className="msg-bubble assistant">
        {groups.map((g, gi) => {
          if (g.kind === 'tool') {
            const tools = g.tools;
            const doneCount = tools.filter((t) => t.status === 'done' || t.status === 'error').length;
            const allDone = doneCount === tools.length && tools.length >= 3;
            const doneTools = tools.filter((t) => t.status === 'done' || t.status === 'error');
            const groupExpanded = tools.some((t) => expandedTools.has(t.toolId));
            // ponytail: when collapsed, show summary ONLY; when expanded, show cards + summary as toggle
            const collapsed = allDone && !groupExpanded;
            return (
              <div key={gi} className="msg-tool-wrapper">
                {collapsed ? (
                  <ToolSummary
                    tools={doneTools}
                    expandedTools={expandedTools}
                    onExpandAll={() => onExpandAllTools(tools.map((t) => t.toolId))}
                    onCollapseAll={() => {}}
                  />
                ) : (
                  <>
                    {allDone && (
                      <ToolSummary
                        tools={doneTools}
                        expandedTools={expandedTools}
                        onExpandAll={() => onExpandAllTools(tools.map((t) => t.toolId))}
                        onCollapseAll={() => onCollapseAllTools(tools.map((t) => t.toolId))}
                      />
                    )}
                    {tools.map((t) => (
                      <ToolCard
                        key={t.toolId}
                        part={t}
                        expanded={expandedTools.has(t.toolId)}
                        onToggle={() => onToggleTool(t.toolId)}
                      />
                    ))}
                  </>
                )}
              </div>
            );
          }

          if (g.kind === 'reasoning') {
            const isLast = g.idx === reasoningTotal;
            return (
              <ReasoningBlock
                key={gi}
                text={g.text}
                streaming={streaming && isLast}
                reasoningComplete={!streaming || !isLast}
              />
            );
          }

          if (g.kind === 'text') {
            return (
              <MarkdownContent
                key={gi}
                text={g.text}
                streaming={streaming && !g.finalised}
                onNavigateToNode={onNavigateToNode}
              />
            );
          }

          if (g.kind === 'subagent') {
            return <SubAgentBlock key={gi} part={g.part} onNavigateToNode={onNavigateToNode} />;
          }

          return null;
        })}
      </div>
      <span className="msg-actions">
        {onCopy && (
          <span
            className="msg-action-btn"
            onClick={onCopy}
            title="复制"
            dangerouslySetInnerHTML={{ __html: svgIcon('copy') }}
          />
        )}
        {onRetry && msg.status === 'done' && (
          <span
            className="msg-action-btn"
            onClick={onRetry}
            title="重试"
            dangerouslySetInnerHTML={{ __html: svgIcon('refresh') }}
          />
        )}
      </span>
    </div>
  );
}, (prev, next) =>
  // Pure reference comparison — safe because every mutation is committed
  // through the store's touch methods, which always produce a new message
  // object (see messages-store.ts SINGLE WRITE PATH RULE).
  prev.msg === next.msg && prev.expandedTools === next.expandedTools,
);

// ── Notice ──

const NoticeBubble: React.FC<{ msg: NoticeMessage }> = ({ msg }) => (
  <div className={`msg-notice msg-notice-${msg.level}`}>{msg.text}</div>
);

// ── Permission card ──

// ── Main component ──
// P2′-2b：直接挂在 ChatBeacon 树里（Controller 包装已删）。
// React.memo 隔离 ChatBeacon 重渲染（模式/角标变化不触碰消息树）；
// 消息更新走 store 订阅，与旧独立 root 语义一致。

export const ChatMessagesApp: React.FC<{
  callbacks: ChatMessagesCallbacks;
  scrollContainer?: HTMLElement;
  panelId: string;
}> = React.memo(({ callbacks, scrollContainer, panelId }) => {
  // ponytail: messages live in per-session stores — subscribe to the active session's store.
  // React re-renders automatically on session switch because activeSessionId changes.
  const sessStore = useMemo(() => getSessionStore(panelId), [panelId]);
  const activeSessionId = useStore(sessStore, (s) => {
    const active = s.sessions[s.activeIdx];
    return active?.id ?? null;
  });
  const msgStore = useMemo(
    () =>
      activeSessionId != null
        ? getMessagesStore(`${panelId}:${activeSessionId}`)
        : getMessagesStore(`${panelId}:__empty__`),
    [panelId, activeSessionId],
  );
  const messages = useStore(msgStore, (s) => s.messages);
  const _version = useStore(msgStore, (s) => s.version);

  // ponytail: callback-ref state 而非 useRef —— 元素挂载后触发一次重渲染，
  // 让依赖 scrollEl 的 effect 拿到真实节点（内联后本组件自带滚动容器）。
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const autoScrollRaf = useRef<number | null>(null);
  const lastMsgCount = useRef(0);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  // Resolve the actual scrollable element (外部指定或自身)
  const scrollEl = scrollContainer ?? listEl;

  // ── Virtual list setup ──
  // Pretext provides estimated heights; measureElement corrects after render.
  const containerWidthRef = useRef(300);
  useEffect(() => {
    if (!scrollEl) return;
    const update = () => { containerWidthRef.current = scrollEl.clientWidth; };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollEl]);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const estimateSize = useCallback((i: number) => {
    const msgs = messagesRef.current;
    return msgs[i] ? estimateMessageHeight(msgs[i], containerWidthRef.current) : 60;
  }, []);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollEl,
    estimateSize,
    overscan: 4,
    gap: getMessageGap(),
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  // Reset stick-to-bottom when switching sessions — don't inherit the
  // scroll position (and stickRef state) from the previous session.
  // Also reset lastMsgCount so the messages-length effect doesn't mistake
  // a session switch for a new-user-message arrival, and scroll synchronously
  // to avoid the delayed rAF "jump" when the previous session was streaming.
  useEffect(() => {
    stickRef.current = true;
    lastMsgCount.current = messages.length;
    if (scrollEl) {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'auto' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, scrollEl]);

  // Auto-scroll: coalesce into single pending rAF
  useEffect(
    () => {
      if (messages.length === 0) return;
      if (autoScrollRaf.current !== null) return;

      if (messages.length > lastMsgCount.current && messages[messages.length - 1]?.role === 'user') {
        stickRef.current = true;
      }
      lastMsgCount.current = messages.length;

      if (!stickRef.current) return;

      autoScrollRaf.current = requestAnimationFrame(() => {
        autoScrollRaf.current = null;
        if (!stickRef.current) return;
        virtualizerRef.current.scrollToIndex(messages.length - 1, { align: 'end' });
      });
    },
    [scrollEl?.style, messages.length, messages] as const,
  ); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll during streaming — driven by messages reference change.
  // Previously used MutationObserver, but with virtualization the DOM node
  // count is ~10, and the messages array already changes on every streaming
  // bump (via _streamingBump's reference swap). The effect above already
  // handles scroll on messages.length change; this covers in-place text
  // mutations that don't change length (same message, growing text).
  useEffect(() => {
    if (!stickRef.current) return;
    if (autoScrollRaf.current !== null) return;
    autoScrollRaf.current = requestAnimationFrame(() => {
      autoScrollRaf.current = null;
      if (!stickRef.current) return;
      const lastIdx = messagesRef.current.length - 1;
      if (lastIdx >= 0) {
        virtualizerRef.current.scrollToIndex(lastIdx, { align: 'end' });
      }
    });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (autoScrollRaf.current !== null) cancelAnimationFrame(autoScrollRaf.current);
    };
  }, []);

  // Scroll tracking: capture phase wheel + scroll event
  // ponytail: direction-aware — only re-enable auto-scroll when user actively
  // scrolls DOWN to the bottom. A scroll-up near the bottom won't re-engage it.
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;

    let lastScrollTop = el.scrollTop;

    const onWheelCapture = (e: WheelEvent) => {
      // Ignore ctrl+wheel (zoom), horizontal scroll, scroll-down
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY >= 0) return;
      stickRef.current = false;
    };

    const onScroll = () => {
      const currentTop = el.scrollTop;
      const scrollingDown = currentTop > lastScrollTop;
      lastScrollTop = currentTop;

      if (scrollingDown && isNearBottom(el)) {
        stickRef.current = true;
      } else if (!scrollingDown && !isNearBottom(el)) {
        // 向上滚动离开底部 → 脱钩（覆盖滚动条拖动等不产生 wheel 的用户操作）
        stickRef.current = false;
      }
    };

    el.addEventListener('wheel', onWheelCapture, true);
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('wheel', onWheelCapture, true);
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollEl]);

  const toggleTool = useCallback((id: string) => {
    setExpandedTools((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }, []);
  const expandAllTools = useCallback((ids: string[]) => {
    setExpandedTools((prev) => {
      const n = new Set(prev);
      for (const id of ids) n.add(id);
      return n;
    });
  }, []);
  const collapseAllTools = useCallback((ids: string[]) => {
    setExpandedTools((prev) => {
      const n = new Set(prev);
      for (const id of ids) n.delete(id);
      return n;
    });
  }, []);

  return (
    <div className="chat-messages" ref={setListEl}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((vItem) => {
          const msg = messages[vItem.index];
          if (!msg) return null;
          return (
            <div
              key={msg._id}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vItem.start}px)`,
              }}
            >
              {msg.role === 'user' && (
                <UserBubble
                  msg={msg}
                  onEdit={callbacks.onEditUserMessage}
                  onResend={callbacks.onResendUserMessage}
                />
              )}
              {msg.role === 'assistant' && (
                <AssistantBubble
                  msg={msg}
                  expandedTools={expandedTools}
                  onToggleTool={toggleTool}
                  onExpandAllTools={expandAllTools}
                  onCollapseAllTools={collapseAllTools}
                  onCopy={
                    callbacks.onCopyText
                      ? () => {
                          const text = msg.parts
                            .filter((p): p is TextPart => p.type === 'text')
                            .map((p) => p.text)
                            .join('\n');
                          callbacks.onCopyText?.(text);
                        }
                      : undefined
                  }
                  onRetry={callbacks.onRetryAssistant ? () => callbacks.onRetryAssistant?.(msg) : undefined}
                  onNavigateToNode={callbacks.onNavigateToNode}
                />
              )}
              {msg.role === 'notice' && <NoticeBubble msg={msg} />}
            </div>
          );
        })}
      </div>
    </div>
  );
});