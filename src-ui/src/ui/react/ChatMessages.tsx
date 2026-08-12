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
import { displayToolName, resolveSemanticToolName } from '../tool-semantics';
import { estimateMessageHeight, getMessageGap } from '../message-height';
import type {
  AssistantMessage,
  AssistantPart,
  NoticeMessage,
  PlanPart,
  SubAgentPart,
  TextPart,
  ToolCallPart,
  UserMessage,
} from '../message-model';
import { getMessagesStore } from '../messages-store';
import { getSessionStore } from '../session-store';

// ── 常量 ──

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

// ── 回调 ──

export interface ChatMessagesCallbacks {
  onEditUserMessage?: (msg: UserMessage) => void;
  onResendUserMessage?: (msg: UserMessage) => void;
  onRetryAssistant?: (msg: AssistantMessage) => void;
  onCopyText?: (text: string) => void;
  onNavigateToNode?: (nodeName: string) => void;
}

// ── 图标 ──

function svgIcon(name: string, size: number = 12): string {
  return iconSvg(name, size);
}

// ── 节点名链接化 ──
// ReactMarkdown 将 `code` 渲染为 <code> 元素。我们遍历行内
// <code> 元素（非块级 <pre><code>），将其包装为可点击链接。

function linkifyNodeNames(container: HTMLElement, onNavigate?: (name: string) => void): void {
  if (!onNavigate) return;
  const codeEls = container.querySelectorAll('code:not(pre code)');
  codeEls.forEach((el) => {
    if (el.querySelector('.node-link')) return; // 已链接化
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

// ── react-markdown 代码组件（hljs 高亮） ──

function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  const text = String(children ?? '').replace(/\n$/, '');
  const match = /language-([\w-]+)/.exec(className ?? '');
  const _lang = match?.[1];
  const isBlock = match !== null || text.includes('\n');

  // 高亮代码块 — 通过 data 属性跳过已高亮的元素。
  // 流式时，已完成部分在每次段落边界跨越时重新渲染 react-markdown。
  // 如果不加此保护，hljs 会在每次重新渲染时重扫每个 <pre code>，
  // 即使内容未变。
  useEffect(() => {
    if (!ref.current) return;
    ref.current.querySelectorAll('pre code:not([data-highlighted])').forEach((block) => {
      try {
        hljs.highlightElement(block as HTMLElement);
        block.setAttribute('data-highlighted', 'true');
      } catch {
        /* 无操作 */
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

// ── Markdown 内容（流式感知） ──

// ── 增量流式分块器 ──
// 在最后一个安全段落边界（代码块外的双换行）处分割流式文本。
// 已完成部分渲染为 markdown；尾部未完成部分以纯文本渲染并带呼吸光标。
// 同时检测未闭合的 ``` 代码围栏，用于编辑器风格渲染。

function splitStreamingBlocks(text: string): { completed: string; tail: string } {
  if (!text) return { completed: '', tail: '' };

  // 规范化 Windows 换行符，将 \r\n\r\n 视为 \n\n
  text = text.replace(/\r\n/g, '\n');

  // 查找所有 ``` 位置（粗略但在实际中 ``` 很少出现在普通文本中）
  const fences: number[] = [];
  let fi = 0;
  while (fi < text.length) {
    const idx = text.indexOf('\n```', fi);
    if (idx === -1) break;
    fences.push(idx + 1); // \n 后反引号的位置
    fi = idx + 4;
  }
  // 同时检查文本是否以 ``` 开头
  if (text.startsWith('```')) fences.unshift(0);

  // 向后搜索最后一个安全的 \n\n
  let lastSafe = -1;
  for (let pos = text.length - 2; pos >= 0; pos--) {
    if (text.slice(pos, pos + 2) === '\n\n') {
      // 统计此位置之前的围栏数
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
  // 检测未闭合的代码围栏：以 ``` 开头但尚未闭合的行
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

// ── Markdown 内容（流式感知，增量渲染） ──

const MarkdownContent: React.FC<{
  text: string;
  streaming: boolean;
  onNavigateToNode?: (name: string) => void;
}> = React.memo(({ text, streaming, onNavigateToNode }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // 渲染后链接化节点名（在已完成内容上）
  useEffect(() => {
    if (streaming || !onNavigateToNode) return;
    const el = containerRef.current;
    if (el) linkifyNodeNames(el, onNavigateToNode);
  }, [streaming, onNavigateToNode]);

  // ── 始终无条件调用 hooks ──
  const { completed, tail } = useMemo(
    () => (streaming ? splitStreamingBlocks(text) : { completed: '', tail: '' }),
    [text, streaming],
  );

  // 已完成 — 完整 markdown 渲染
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

  // ── 流式：增量渲染 ──
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

// ── 推理块 ──
// 流式时自动展开；完成后自动折叠（尊重用户手动切换）。

const ReasoningBlock: React.FC<{
  text: string;
  streaming: boolean;
  reasoningComplete: boolean;
}> = React.memo(({ text, streaming, reasoningComplete }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const userOverridden = useRef(false);
  const [open, setOpen] = useState(streaming);

  // 流式状态转换时自动开/关
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
  // 工具收敛后模型调用领域工具（fs）— 归一化回旧语义名匹配写入预览
  const name = resolveSemanticToolName(part.name, part.args);

  // write_file_content — 显示正在写入的文件内容
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

  // edit_file — 使用 LCS 显示真实差异（旧 → 新）
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

// ── 工具卡片 ──

/**
 * 委托处理工具结果内「展开全部」(.diff-collapsed) 按钮。
 * 结果 HTML 经 dangerouslySetInnerHTML 注入，inline onclick 不可靠
 * （CSP 可禁用），因此在 React 层统一揭示隐藏行并移除按钮。
 */
function handleToolResultClick(e: React.MouseEvent<HTMLDivElement>): void {
  const btn = (e.target as HTMLElement).closest?.('.diff-collapsed');
  if (!btn) return;
  e.stopPropagation();
  btn.parentElement?.querySelectorAll<HTMLElement>('.diff-line').forEach((el) => {
    el.style.display = '';
  });
  btn.remove();
}

// ponytail: 未用 React.memo 包装 — part-mutator 就地修改 ToolCallPart
// (tr.status = 'error')，因此对象引用不变。React.memo
// 会在工具状态转换时阻止重新渲染（如 pending→running→done/error）。

// ── 工具结果视图 ──
// 特殊渲染（JSON 美化 / diff / dataflow 卡片等）产出结构化 HTML，
// 经 dangerouslySetInnerHTML 注入；默认分支为 markdown 文本，
// 走 react-markdown 新路径（渲染收敛后不再经 marked+DOMPurify）。
const ToolResultView: React.FC<{
  toolName: string;
  output: string;
  truncated: boolean;
  args?: string;
  onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
}> = ({ toolName, output, truncated, args, onClick }) => {
  const rendered = formatToolResult(toolName, output, truncated, args);
  if (rendered.kind === 'html') {
    return <div className="msg-tool-result" onClick={onClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
  }
  return (
    <div className="msg-tool-result" onClick={onClick}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: MarkdownCode,
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {rendered.text}
      </ReactMarkdown>
    </div>
  );
};

const ToolCard: React.FC<{ part: ToolCallPart; expanded: boolean; onToggle: () => void }> = ({
  part,
  expanded,
  onToggle,
}) => {
  // 立即展开运行中的工具（无 useState+useEffect 延迟）
  // 使流式 shell 输出从第一个数据块即可见。
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
        <span className="tool-name">{displayToolName(part.name, part.args)}</span>
        <span className="tool-args">
          {part.args && part.args.length > 60 ? part.args.slice(0, 57) + '…' : part.args || ''}
        </span>
        <span className={`msg-tool-badge ${badgeCls}`}>{badgeLabel}</span>
      </div>
      {isExpanded && part.output && (
        <ToolResultView
          toolName={part.name}
          output={part.output}
          truncated={part.truncated ?? false}
          args={part.args}
          onClick={handleToolResultClick}
        />
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

// ── 工具摘要 ──

const ToolSummary: React.FC<{
  tools: ToolCallPart[];
  expandedTools: Set<string>;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}> = ({ tools, expandedTools, onExpandAll, onCollapseAll }) => {
  const doneTools = tools.filter((t) => t.status === 'done' || t.status === 'error');
  const names = doneTools.map((t) => displayToolName(t.name, t.args));
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

// ── 子 Agent 推理（除最后一个外折叠） ──

const SubReasoningBlock: React.FC<{
  part: { type: 'reasoning'; text: string };
  parts: AssistantPart[];
  index: number;
}> = ({ part, parts, index }) => {
  // 查找最后一个推理部分的索引 — 只有该部分展开渲染
  let lastIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'reasoning') {
      lastIdx = i;
      break;
    }
  }
  const isLast = index === lastIdx;
  const [open, setOpen] = useState(isLast);

  // 当新部分成为最后一个时同步展开状态（流式进度）
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

// ── 计划审批卡片 — 全宽 markdown 内容 + 批准/修改/拒绝 ──
// 样式：chat.css 的 .msg-plan-card 系列（--obs-* 变量，与权限卡同一视觉体系）

const PLAN_STATUS_META: Record<PlanPart['status'], { icon: string; label: string }> = {
  pending: { icon: 'plan', label: '待审批' },
  approved: { icon: 'check', label: '已批准' },
  revise: { icon: 'edit', label: '要求修改' },
  rejected: { icon: 'close', label: '已拒绝' },
};

const PlanCard: React.FC<{ part: PlanPart; storeId?: string }> = ({ part, storeId }) => {
  const [feedbackText, setFeedbackText] = React.useState('');
  const [showFeedback, setShowFeedback] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);

  const respond = (decision: 'approved' | 'revise' | 'rejected', selectedLabel?: string) => {
    if (decision === 'revise') {
      setShowFeedback(true);
      if (!feedbackText.trim()) return; // 等用户输入反馈
    }
    part.status = decision === 'approved' ? 'approved' : decision === 'revise' ? 'revise' : 'rejected';
    part.selectedLabel = selectedLabel;
    part.feedback = decision === 'revise' ? feedbackText : undefined;
    // 提交变更到消息存储 — 触发重渲染
    if (storeId) {
      getMessagesStore(storeId).getState().bump();
    }
    // 回调通知 Agent 工具 — 按判别联合类型构造响应
    if (decision === 'approved') {
      part._callback?.({ decision: 'approved', selectedLabel });
    } else if (decision === 'revise') {
      part._callback?.({ decision: 'revise', feedback: feedbackText });
    } else {
      part._callback?.({ decision: 'rejected' });
    }
  };

  const meta = PLAN_STATUS_META[part.status] ?? PLAN_STATUS_META.pending;
  const isPending = part.status === 'pending';

  return (
    <div className={`msg-plan-card msg-plan-card--${part.status}`}>
      {/* 头部 */}
      <div className="msg-plan-card__head">
        <span className="msg-plan-card__icon" dangerouslySetInnerHTML={{ __html: iconSvg(meta.icon, 13) }} />
        <span className="msg-plan-card__title">计划审批</span>
        {part.options && part.options.length >= 2 && (
          <span className="msg-plan-card__count">{part.options.length} 个方案</span>
        )}
        <span className={`msg-plan-card__status msg-plan-card__status--${part.status}`}>{meta.label}</span>
        <button className="msg-plan-card__fold" onClick={() => setCollapsed(!collapsed)} type="button">
          {collapsed ? '展开' : '折叠'}
        </button>
      </div>

      {/* 计划内容 — 完整 markdown */}
      {!collapsed && (
        <div className="plan-card__content msg-plan-card__content">
          <MarkdownContent text={part.content} streaming={false} />
        </div>
      )}

      {/* 选项（多方案时显示） */}
      {!collapsed && part.options && part.options.length >= 2 && (
        <div className="msg-plan-card__options">
          <div className="msg-plan-card__options-label">选择方案</div>
          {part.options.map((opt) => (
            <button
              key={opt.label}
              className="msg-plan-card__option"
              disabled={!isPending}
              onClick={() => respond('approved', opt.label)}
              type="button"
            >
              <span className="msg-plan-card__option-label">{opt.label}</span>
              {opt.description && <span className="msg-plan-card__option-desc">{opt.description}</span>}
            </button>
          ))}
        </div>
      )}

      {/* 反馈输入（用于修改） */}
      {showFeedback && isPending && (
        <div className="msg-plan-card__feedback">
          <textarea
            className="msg-plan-card__textarea"
            placeholder="输入修改意见…"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            rows={3}
          />
          <button
            className="msg-plan-card__btn msg-plan-card__btn--approve"
            onClick={() => respond('revise')}
            disabled={!feedbackText.trim()}
            type="button"
          >
            提交修改意见
          </button>
        </div>
      )}

      {/* 操作按钮 */}
      {isPending && !showFeedback && (
        <div className="msg-plan-card__actions">
          {!part.options || part.options.length < 2 ? (
            <button className="msg-plan-card__btn msg-plan-card__btn--approve" onClick={() => respond('approved')} type="button">
              <span dangerouslySetInnerHTML={{ __html: iconSvg('check', 12) }} />
              批准
            </button>
          ) : null}
          <button className="msg-plan-card__btn" onClick={() => setShowFeedback(true)} type="button">
            <span dangerouslySetInnerHTML={{ __html: iconSvg('edit', 12) }} />
            修改
          </button>
          <button className="msg-plan-card__btn msg-plan-card__btn--reject" onClick={() => respond('rejected')} type="button">
            <span dangerouslySetInnerHTML={{ __html: iconSvg('close', 12) }} />
            拒绝
          </button>
        </div>
      )}

      {/* 已决定状态 */}
      {!isPending && (
        <div className="msg-plan-card__verdict">
          {part.status === 'approved' && (part.selectedLabel ? `已批准：${part.selectedLabel}` : '已批准')}
          {part.status === 'revise' && `已要求修改${part.feedback ? `：${part.feedback.slice(0, 100)}` : ''}`}
          {part.status === 'rejected' && '已拒绝'}
        </div>
      )}
    </div>
  );
};

// ── 子 Agent 块 ──
// 在助手消息内渲染嵌套的可折叠组，用于子 Agent 输出。
// 运行时自动展开；完成时自动折叠（尊重用户手动切换）。

// ponytail: 未用 React.memo 包装 — subagent-sink 就地修改 SubAgentPart
// (push 到 parts[], version++)，因此对象引用不变。React.memo
// 在同一引用上用任何比较器都会跳过，完全阻止
// 流式重新渲染。性能由 renderedParts 上的 useMemo 处理；
// 自动滚动在组件内的 MutationObserver effect 中实现。
const SubAgentBlock: React.FC<{ part: SubAgentPart; onNavigateToNode?: (name: string) => void }> = ({ part, onNavigateToNode }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const userOverridden = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (part.status !== 'running' && !userOverridden.current) setExpanded(false);
  }, [part.status]);

  // 新内容流入时自动滚动 body div 到底部。
  // 使用 rAF 节流，避免 MutationObserver 在快速流式时
  // 每次 DOM 变化都触发同步布局抖动。
  // 仅当用户已接近底部时才贴底 — 在卡片内向上滚动
  // 不应被新流入的内容拉回底部。
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

  // 记忆化部分列表 — 仅在子 Agent 内容变化时重建，
  // 不在每次父组件重新渲染时重建（大型聊天记录的性能优化）。
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

// ── 用户消息 ──

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

// ── 助手消息 ──
// React.memo 使用纯引用比较。这仅因 store 的单一写入路径规则
// (messages-store.ts) 而正确：消息或其部分的每次就地修改
// 都通过 touchMessage / touchMessageContaining 提交，
// 后者会替换为新的消息对象。无新引用 ⇒ 不重新渲染 —
// 因此任何跳过 store 提交的未来修改路径都会静默冻结气泡。先修改，再 touch。

const AssistantBubble: React.FC<{
  msg: AssistantMessage;
  expandedTools: Set<string>;
  onToggleTool: (id: string) => void;
  onExpandAllTools: (ids: string[]) => void;
  onCollapseAllTools: (ids: string[]) => void;
  onCopy?: () => void;
  onRetry?: () => void;
  onNavigateToNode?: (name: string) => void;
  panelId?: string;
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
    panelId,
  }) => {
  const streaming = msg.status === 'streaming';

  // 统计推理块数量，以确定哪个是"最后一个"（仍在流式）
  let reasoningTotal = 0;
  for (const p of msg.parts) {
    if (p.type === 'reasoning') reasoningTotal++;
  }
  let reasoningSeen = 0;

  // 构建扁平渲染组 — 推理块不被提取到顶部；
  // 它们内联渲染，穿插在工具组和文本之间。
  const groups: Array<
    | { kind: 'tool'; tools: ToolCallPart[] }
    | { kind: 'reasoning'; text: string; idx: number }
    | { kind: 'text'; text: string; finalised: boolean; idx: number }
    | { kind: 'subagent'; part: SubAgentPart }
    | { kind: 'plan'; part: PlanPart }
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
    } else if (p.type === 'plan') {
      groups.push({ kind: 'plan', part: p as PlanPart });
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
            // ponytail: 折叠时仅显示摘要；展开时显示卡片 + 摘要作为切换
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

          if (g.kind === 'plan') {
            return <PlanCard key={gi} part={g.part} storeId={panelId} />;
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
  // 纯引用比较 — 安全，因为每次修改都通过 store 的 touch 方法提交，
  // 后者总是产生新的消息对象（见 messages-store.ts 单一写入路径规则）。
  prev.msg === next.msg && prev.expandedTools === next.expandedTools,
);

// ── 通知 ──

const NoticeBubble: React.FC<{ msg: NoticeMessage }> = ({ msg }) => (
  <div className={`msg-notice msg-notice-${msg.level}`}>{msg.text}</div>
);

// ── 权限卡片 ──

// ── 主组件 ──
// P2′-2b：直接挂在 ChatBeacon 树里（Controller 包装已删）。
// React.memo 隔离 ChatBeacon 重渲染（模式/角标变化不触碰消息树）；
// 消息更新走 store 订阅，与旧独立 root 语义一致。

export const ChatMessagesApp: React.FC<{
  callbacks: ChatMessagesCallbacks;
  scrollContainer?: HTMLElement;
  panelId: string;
}> = React.memo(({ callbacks, scrollContainer, panelId }) => {
  // ponytail: 消息存储在每会话 store 中 — 订阅活动会话的 store。
  // 会话切换时 React 自动重新渲染，因为 activeSessionId 变化。
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
  // 初始挂载/会话切换后的「贴底待落地」标记。
  // 为什么需要：冷启动时面板是 display:none（pill/input 模式），
  // scrollToIndex 被 0 高度容器钳位成无效操作；且虚拟列表首轮用
  // 估算高度，measureElement 修正后实际底部会移位。挂起期间在
  // totalSize/可见性变化时反复断言贴底，直到真正抵达底部
  // （或用户主动上滚取消）。
  const pendingBottomRef = useRef(true);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  // 解析实际可滚动元素（外部指定或自身）
  const scrollEl = scrollContainer ?? listEl;

  // ── 虚拟列表设置 ──
  // pretext 提供估算高度；measureElement 在渲染后修正。
  const containerWidthRef = useRef(300);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const estimateSize = useCallback((i: number) => {
    const msgs = messagesRef.current;
    return msgs[i] ? estimateMessageHeight(msgs[i], containerWidthRef.current) : 60;
  }, []);

  // 按消息 id 而非索引做关键测量 — 否则会话切换和
  // 历史截断（编辑/重发）会将过期高度错误地关联到其他消息。
  const getItemKey = useCallback((i: number) => messagesRef.current[i]?._id ?? i, []);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollEl,
    estimateSize,
    getItemKey,
    overscan: 4,
    gap: getMessageGap(),
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  // 跟踪容器宽度用于文本换行估算，并在实际变化时强制虚拟列表
  // 重新估算 — 估算值依赖于宽度。
  // 同时监听容器从 display:none 变为可见（冷启动面板从
  // pill/input 展开）：可见且贴底挂起时立即断言滚到底部。
  useEffect(() => {
    if (!scrollEl) return;
    let lastWidth = scrollEl.clientWidth;
    containerWidthRef.current = lastWidth;
    const ro = new ResizeObserver(() => {
      const w = scrollEl.clientWidth;
      if (w !== lastWidth) {
        lastWidth = w;
        containerWidthRef.current = w;
        virtualizerRef.current.measure();
      }
      if (pendingBottomRef.current && scrollEl.clientHeight > 0 && messagesRef.current.length > 0) {
        virtualizerRef.current.scrollToIndex(messagesRef.current.length - 1, { align: 'end' });
      }
    });
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollEl]);

  // 切换会话时重置贴底状态 — 不继承上一会话的
  // 滚动位置（和 stickRef 状态）。
  // 同时重置 lastMsgCount，使消息长度 effect 不会将
  // 会话切换误认为新用户消息到达，并同步滚动
  // 以避免上一会话流式时的延迟 rAF "跳跃"。
  useEffect(() => {
    stickRef.current = true;
    pendingBottomRef.current = true;
    lastMsgCount.current = messages.length;
    if (scrollEl) {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'auto' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, scrollEl]);

  // 自动滚动：合并为单个挂起的 rAF
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

  // 流式时自动滚动 — 由 messages 引用变化驱动。
  // 以前使用 MutationObserver，但虚拟化后 DOM 节点
  // 数量约 10 个，且 messages 数组在每次流式 bump 时
  // 已变化（通过 _streamingBump 的引用交换）。上面的 effect 已
  // 处理 messages.length 变化时的滚动；此处处理不改变长度的
  // 就地文本修改（同一消息，文本增长）。
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

  // 贴底挂起的收敛 effect — totalSize 随 measureElement 的测量修正
  // 而变化，每次变化都重新断言滚到底部；真正落地（nearBottom）后
  // 才解除挂起。覆盖两类失效场景：
  //   1. 冷启动面板 display:none 时的 scrollToIndex 被 0 高度钳位；
  //   2. 首轮估算高度与实测不符，scrollToIndex 落点偏离真实底部。
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (!pendingBottomRef.current) return;
    const el = scrollEl;
    if (!el || messages.length === 0) return;
    if (el.clientHeight === 0) return; // display:none — 等 ResizeObserver 唤醒
    virtualizerRef.current.scrollToIndex(messages.length - 1, { align: 'end' });
    // 双 rAF 校验：等 measureElement 的测量修正完成一轮提交后再判 —
    // 真到底就解除挂起；否则保持挂起，后续 totalSize 变化会再次
    // 触发本 effect 拉回底部（每次重跑也会取消上一轮的校验帧）。
    let inner: number | null = null;
    const raf = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        if (isNearBottom(el)) pendingBottomRef.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      if (inner !== null) cancelAnimationFrame(inner);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalSize, messages.length, scrollEl]);

  useEffect(() => {
    return () => {
      if (autoScrollRaf.current !== null) cancelAnimationFrame(autoScrollRaf.current);
    };
  }, []);

  // 滚动跟踪：capture 阶段 wheel + scroll 事件
  // ponytail: 方向感知 — 仅当用户主动向下滚动到底部时
  // 才重新启用自动滚动。底部附近的向上滚动不会重新启用。
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;

    let lastScrollTop = el.scrollTop;

    const onWheelCapture = (e: WheelEvent) => {
      // 忽略 ctrl+wheel（缩放）、水平滚动、向下滚动
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY >= 0) return;
      stickRef.current = false;
      pendingBottomRef.current = false; // 用户主动上滚 — 取消贴底断言
    };

    const onScroll = () => {
      const currentTop = el.scrollTop;
      const scrollingDown = currentTop > lastScrollTop;
      lastScrollTop = currentTop;

      if (scrollingDown && isNearBottom(el)) {
        stickRef.current = true;
      } else if (!scrollingDown && !isNearBottom(el)) {
        // 向上滚动离开底部 → 脱钩（覆盖滚动条拖动等不产生 wheel 的用户操作）。
        // 贴底挂起期间豁免 — 测量修正产生的补偿性上滚是程序性的，不算用户意图。
        if (!pendingBottomRef.current) stickRef.current = false;
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
                  panelId={panelId}
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