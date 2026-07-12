// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatMessages — React 重写消息列表渲染
// 替代 chat-stream.ts 的 _doSyncMessagesToDOM + renderMessage 全量 DOM 替换。
// 修复：流式输出时自由滚动（不再被 replaceChildren 强制拉回底部）

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { marked } from 'marked';
import {
  type ChatMessage,
  type UserMessage,
  type AssistantMessage,
  type ToolCallPart,
  type TextPart,
  type NoticeMessage,
  type PermissionMessage,
} from '../message-model';

// ── Callbacks ──

export interface ChatMessagesCallbacks {
  onEditUserMessage?: (msg: UserMessage) => void;
  onResendUserMessage?: (msg: UserMessage) => void;
  onRetryAssistant?: (msg: AssistantMessage) => void;
  onCopyText?: (text: string) => void;
  onToggleToolCard?: (toolId: string) => void;
  onToggleReasoning?: (blockIndex: number) => void;
  isReasoningExpanded?: Set<number>;
  expandedTools?: Set<string>;
  onResolvePermission?: (msg: PermissionMessage, result: { allow: boolean; remember: boolean }) => void;
  onScrollUserAction?: () => void;
}

// ── Icons ──

function svgIcon(name: string, size: number = 12): string {
  const icons: Record<string, string> = {
    edit: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    refresh: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`,
    copy: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    'check-circle': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    close: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    dot: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>`,
    code: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
    'chevron-right': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`,
    'chevron-down': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`,
  };
  return icons[name] || '';
}

// ── Streaming text ──

const StreamingText: React.FC<{ text: string; finalised: boolean }> = ({ text, finalised }) => {
  if (finalised) {
    const html = marked.parse(text, { async: false }) as string;
    return <div className="msg-text msg-markdown stable" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div className="msg-text msg-markdown streaming">{text}<span className="streaming-typing">▊</span></div>;
};

// ── Reasoning block ──

const ReasoningBlock: React.FC<{
  text: string; blockIndex: number; expanded: boolean; onToggle: (idx: number) => void;
}> = ({ text, blockIndex, expanded, onToggle }) => (
  <div className={`msg-reasoning${expanded ? ' msg-reasoning-open' : ''}`}>
    <div className="msg-reasoning-toggle" onClick={() => onToggle(blockIndex)}>
      <span dangerouslySetInnerHTML={{ __html: expanded ? svgIcon('chevron-down') : svgIcon('chevron-right') }} />
      {expanded ? '收起思考' : '查看思考'}
    </div>
    <div className={`msg-reasoning-content${expanded ? ' msg-reasoning-open' : ''}`}>
      <pre>{text}</pre>
    </div>
  </div>
);

// ── Tool card ──

const ToolCard: React.FC<{
  part: ToolCallPart; expanded: boolean; onToggle: () => void;
}> = ({ part, expanded, onToggle }) => {
  const icon = svgIcon(part.status === 'running' ? 'dot' : part.status === 'done' ? 'check-circle' : 'close');
  return (
    <div className={`msg-tool-card msg-tool-wrapper${expanded ? ' tool-expanded' : ''}`}>
      <div className="msg-tool-header" onClick={onToggle}>
        <span className="msg-tool-icon" dangerouslySetInnerHTML={{ __html: icon }} />
        <span className="msg-tool-name">{part.name}</span>
        <span className="msg-tool-args">{part.args.length > 60 ? part.args.slice(0, 57) + '…' : part.args}</span>
        <span className={`msg-tool-badge ${part.status === 'done' ? 'badge-ok' : part.status === 'error' ? 'badge-fail' : 'badge-running'}`}>
          {part.status === 'running' ? '执行中' : part.status === 'done' ? '完成' : part.status === 'error' ? '失败' : '等待中'}
        </span>
      </div>
      {expanded && part.output && (
        <div className="msg-tool-result">
          <pre><code>{part.output.slice(0, 2000)}{part.output.length > 2000 ? '\n…(截断)' : ''}</code></pre>
        </div>
      )}
      {expanded && part.err && (
        <div className="msg-tool-result msg-tool-err"><pre><code>{part.err}</code></pre></div>
      )}
    </div>
  );
};

// ── User message ──

const UserBubble: React.FC<{
  msg: UserMessage; onEdit?: (m: UserMessage) => void; onResend?: (m: UserMessage) => void;
}> = ({ msg, onEdit, onResend }) => (
  <div className="msg-bubble user" data-message-id={msg._id}>
    <div className="msg-user-row">
      <span className="msg-user-text">{msg.text}</span>
      <span className="msg-actions">
        {onEdit && <span className="msg-action-btn" onClick={() => onEdit(msg)} title="编辑" dangerouslySetInnerHTML={{ __html: svgIcon('edit') }} />}
        {onResend && <span className="msg-action-btn" onClick={() => onResend(msg)} title="重发" dangerouslySetInnerHTML={{ __html: svgIcon('refresh') }} />}
      </span>
    </div>
    {msg.files && msg.files.length > 0 && (
      <div className="msg-attach-pills">
        {msg.files.map((f, i) => (
          <span key={i} className="attach-pill">{f.name} <span className="attach-pill-size">({f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`})</span></span>
        ))}
      </div>
    )}
  </div>
);

// ── Tool summary line ──

const ToolSummary: React.FC<{ count: number }> = ({ count }) => (
  <div className="msg-tool-summary">已执行 {count} 个工具</div>
);

// ── Assistant message ──

const AssistantBubble: React.FC<{
  msg: AssistantMessage;
  expandedTools: Set<string>;
  expandedReasoning: Set<number>;
  onToggleTool: (id: string) => void;
  onToggleReasoning: (idx: number) => void;
  onCopy?: () => void;
  onRetry?: () => void;
}> = ({ msg, expandedTools, expandedReasoning, onToggleTool, onToggleReasoning, onCopy, onRetry }) => {
  const toolParts = msg.parts.filter((p): p is ToolCallPart => p.type === 'tool');
  const toolCount = toolParts.length;
  let reasonIdx = -1;

  return (
    <div className="msg-bubble assistant" data-message-id={msg._id}>
      {msg.parts.map((part, i) => {
        if (part.type === 'reasoning') {
          reasonIdx++;
          return <ReasoningBlock key={i} text={part.text} blockIndex={reasonIdx} expanded={expandedReasoning.has(reasonIdx)} onToggle={onToggleReasoning} />;
        }
        if (part.type === 'text') {
          return <StreamingText key={i} text={part.text} finalised={part.finalised} />;
        }
        if (part.type === 'tool') {
          return <ToolCard key={i} part={part} expanded={expandedTools.has(part.toolId)} onToggle={() => onToggleTool(part.toolId)} />;
        }
        return null;
      })}
      {toolCount > 0 && <ToolSummary count={toolCount} />}
      <span className="msg-actions">
        {onCopy && <span className="msg-action-btn" onClick={onCopy} title="复制" dangerouslySetInnerHTML={{ __html: svgIcon('copy') }} />}
        {onRetry && msg.status === 'done' && <span className="msg-action-btn" onClick={onRetry} title="重试" dangerouslySetInnerHTML={{ __html: svgIcon('refresh') }} />}
      </span>
    </div>
  );
};

// ── Notice ──

const NoticeBubble: React.FC<{ msg: NoticeMessage }> = ({ msg }) => (
  <div className={`msg-notice msg-notice-${msg.level}`}>{msg.text}</div>
);

// ── Permission card ──

const PermissionCard: React.FC<{
  msg: PermissionMessage; onResolve: (result: { allow: boolean; remember: boolean }) => void;
}> = ({ msg, onResolve }) => (
  <div className="perm-inline-card">
    <div className="perm-inline-header">
      <span className="perm-inline-tool">🔐 {msg.toolName}</span>
    </div>
    <div className="perm-inline-subject">{msg.subject}</div>
    <div className="msg-perm-btns">
      <button className="perm-inline-allow" onClick={() => onResolve({ allow: true, remember: false })}>允许</button>
      <button className="perm-inline-allow-session" onClick={() => onResolve({ allow: true, remember: true })}>本次会话允许</button>
      <button className="perm-inline-deny" onClick={() => onResolve({ allow: false, remember: false })}>拒绝</button>
    </div>
  </div>
);

// ── Main component ──

const ChatMessagesApp: React.FC<{
  messages: ChatMessage[];
  version: number;
  callbacks: ChatMessagesCallbacks;
}> = ({ messages, version, callbacks }) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedReasoning, setExpandedReasoning] = useState<Set<number>>(new Set());
  const lastMessageCount = useRef(messages.length);
  const lastScrollHeight = useRef(0);

  // Auto-scroll: scroll to bottom when new messages arrive, unless user scrolled up
  useEffect(() => {
    const list = listRef.current;
    if (!list || messages.length === 0) return;

    if (userScrolledUp) {
      // Preserve scroll position - adjust for new content above
      if (lastScrollHeight.current > 0) {
        const offset = list.scrollHeight - lastScrollHeight.current;
        list.scrollTop += offset;
      }
    } else {
      list.scrollTop = list.scrollHeight;
    }
    lastScrollHeight.current = list.scrollHeight;
  }, [version]);

  // Reset userScrolledUp when a new turn starts (new user message)
  useEffect(() => {
    if (messages.length > lastMessageCount.current && messages[messages.length - 1]?.role === 'user') {
      setUserScrolledUp(false);
    }
    lastMessageCount.current = messages.length;
  }, [messages.length]);

  // Scroll tracking
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) setUserScrolledUp(true);
    };
    const onScroll = () => {
      const dist = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (dist <= 40) setUserScrolledUp(false);
    };

    list.addEventListener('wheel', onWheel);
    list.addEventListener('scroll', onScroll);
    return () => {
      list.removeEventListener('wheel', onWheel);
      list.removeEventListener('scroll', onScroll);
    };
  }, []);

  const toggleTool = useCallback((toolId: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  }, []);

  const toggleReasoning = useCallback((idx: number) => {
    setExpandedReasoning(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  return (
    <div className="chat-messages" ref={listRef}>
      {messages.map(msg => {
        switch (msg.role) {
          case 'user':
            return <UserBubble key={msg._id} msg={msg} onEdit={callbacks.onEditUserMessage} onResend={callbacks.onResendUserMessage} />;
          case 'assistant':
            return (
              <AssistantBubble key={msg._id} msg={msg}
                expandedTools={expandedTools} expandedReasoning={expandedReasoning}
                onToggleTool={toggleTool} onToggleReasoning={toggleReasoning}
                onCopy={callbacks.onCopyText ? () => callbacks.onCopyText!(msg.parts.filter(p => p.type === 'text').map(p => (p as TextPart).text).join('\n')) : undefined}
                onRetry={callbacks.onRetryAssistant ? () => callbacks.onRetryAssistant!(msg) : undefined}
              />
            );
          case 'notice':
            return <NoticeBubble key={msg._id} msg={msg} />;
          case 'perm':
            return <PermissionCard key={msg._id} msg={msg} onResolve={(r) => callbacks.onResolvePermission?.(msg, r)} />;
        }
      })}
    </div>
  );
};

// ── Thin class wrapper ──

export class ChatMessagesPanel {
  private _root: Root;
  private _mount: HTMLElement;
  private _version = 0;
  private _callbacks: ChatMessagesCallbacks = {};
  private _getMessages: () => ChatMessage[];

  /** Notify React that messages have changed (call after mutations) */
  bump(): void { this._version++; this._render(); }

  get version(): number { return this._version; }

  setCallbacks(cbs: ChatMessagesCallbacks): void { this._callbacks = cbs; }

  constructor(container: HTMLElement, getMessages: () => ChatMessage[]) {
    this._getMessages = getMessages;
    this._mount = document.createElement('div');
    container.appendChild(this._mount);
    this._root = createRoot(this._mount);
    this._render();
  }

  private _render(): void {
    this._root.render(
      React.createElement(ChatMessagesApp, {
        messages: this._getMessages(),
        version: this._version,
        callbacks: this._callbacks,
      }),
    );
  }

  destroy(): void { this._root.unmount(); this._mount.remove(); }
}
