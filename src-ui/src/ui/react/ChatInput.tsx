// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatInput — React textarea + attachments + send/stop for ChatPanel.
// Replaces the input section of chat-dom.ts buildDOM().
//
// State lives in chat-store.ts (inputText, attachedFiles, inputHistory, etc.)
// so the legacy vanilla path and React both read/write the same data.

import React, { useRef, useEffect, useCallback } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useChatStore, bumpChat } from '../chat-store';
import { iconHtml } from '../icons';
import type { PanelMode } from '../chat-store';

// ── Callbacks (provided by ChatPanel) ──

export interface ChatInputCallbacks {
  onSend: () => void;
  onStop: () => void;
  onModeChange: (mode: PanelMode) => void;
  /** Called when @ or / triggers need to be checked */
  onInputChange: (text: string, cursorPos: number) => void;
}

// ── React Component ──

const ChatInputApp: React.FC<{ callbacks: ChatInputCallbacks }> = ({ callbacks }) => {
  const inputText = useChatStore((s) => s.inputText);
  const attachedFiles = useChatStore((s) => s.attachedFiles);
  const panelMode = useChatStore((s) => s.panelMode);
  const agentState = useChatStore((s) => s.lastAgentState);
  const inputHistory = useChatStore((s) => s.inputHistory);
  const inputHistoryIdx = useChatStore((s) => s.inputHistoryIdx);
  const draftText = useChatStore((s) => s.draftText);

  const setInputText = useChatStore((s) => s.setInputText);
  const removeAttachedFile = useChatStore((s) => s.removeAttachedFile);
  const pushInputHistory = useChatStore((s) => s.pushInputHistory);
  const setInputHistoryIdx = useChatStore((s) => s.setInputHistoryIdx);
  const setDraftText = useChatStore((s) => s.setDraftText);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const historyIdxRef = useRef(inputHistoryIdx);
  historyIdxRef.current = inputHistoryIdx;
  const inputHistoryRef = useRef(inputHistory);
  inputHistoryRef.current = inputHistory;

  // Auto-resize textarea when content changes
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, [inputText]);

  // ── Keyboard handler ──

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = taRef.current;
      if (!ta) return;

      // ── Input history: ArrowUp at start of text ──
      if (e.key === 'ArrowUp' && !e.shiftKey) {
        const hist = inputHistoryRef.current;
        if (hist.length === 0) return;
        const cursorAtStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
        if (!cursorAtStart) return;
        e.preventDefault();
        const idx = historyIdxRef.current;
        if (idx === hist.length) {
          setDraftText(ta.value);
        }
        if (idx > 0) {
          setInputHistoryIdx(idx - 1);
          setInputText(hist[idx - 1]);
        }
        return;
      }

      // ── Input history: ArrowDown at end of text ──
      if (e.key === 'ArrowDown' && !e.shiftKey) {
        const hist = inputHistoryRef.current;
        if (hist.length === 0) return;
        const cursorAtEnd = ta.selectionStart === ta.value.length;
        if (!cursorAtEnd) return;
        e.preventDefault();
        const idx = historyIdxRef.current;
        if (idx < hist.length - 1) {
          setInputHistoryIdx(idx + 1);
          setInputText(hist[idx + 1]);
        } else {
          setInputHistoryIdx(hist.length);
          setInputText(draftText);
        }
        return;
      }

      // ── Enter = send (Shift+Enter = newline) ──
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        callbacks.onSend();
        return;
      }

      // ── Escape = dismiss ──
      if (e.key === 'Escape') {
        callbacks.onModeChange('pill');
      }
    },
    [callbacks, setInputText, setInputHistoryIdx, setDraftText, draftText],
  );

  // ── Input change — update store + trigger @/slash detection ──
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      setInputText(text);
      callbacks.onInputChange(text, e.target.selectionStart);
    },
    [callbacks, setInputText],
  );

  const isRunning = agentState === 'running' || agentState === 'thinking';
  const isPill = panelMode === 'pill';

  return (
    <div className="chat-input-wrap">
      {/* Attachment pills */}
      {attachedFiles.length > 0 && (
        <div className="attach-pills" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 8px 0' }}>
          {attachedFiles.map((f, i) => (
            <span
              key={i}
              className="attach-pill"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '1px 6px', borderRadius: 3,
                background: 'rgba(80,140,240,0.12)', border: '1px solid rgba(80,140,240,0.2)',
                fontSize: 11, fontFamily: 'var(--font-mono)',
              }}
            >
              {f.name}
              <button
                onClick={() => removeAttachedFile(i)}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-muted)',
                  cursor: 'pointer', padding: 0, fontSize: 11, lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="chat-input-area" style={isPill ? { display: 'none' } : undefined}>
        <textarea
          ref={taRef}
          className="chat-input"
          value={inputText}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="输入消息… (Enter 发送, Shift+Enter 换行)"
          rows={2}
        />
        {!isRunning ? (
          <button className="chat-send-btn" onClick={callbacks.onSend} dangerouslySetInnerHTML={{ __html: iconHtml('send') }} />
        ) : (
          <button className="chat-stop-btn" onClick={callbacks.onStop} dangerouslySetInnerHTML={{ __html: iconHtml('stop') }} />
        )}
      </div>
    </div>
  );
};

// ── Controller class (same pattern as ChatMessagesPanel) ──

export class ChatInputPanel {
  private _root: Root;
  private _mount: HTMLElement;
  private _callbacks: ChatInputCallbacks = {
    onSend: () => {},
    onStop: () => {},
    onModeChange: () => {},
    onInputChange: () => {},
  };

  setCallbacks(cbs: Partial<ChatInputCallbacks>): void {
    Object.assign(this._callbacks, cbs);
    this._render();
  }

  constructor(container: HTMLElement) {
    this._mount = document.createElement('div');
    container.appendChild(this._mount);
    this._root = createRoot(this._mount);
    this._render();
  }

  /** Focus the textarea (called by ChatPanel when summoning panel). */
  focus(): void {
    const ta = this._mount.querySelector('textarea');
    ta?.focus();
  }

  private _render(): void {
    this._root.render(React.createElement(ChatInputApp, { callbacks: this._callbacks }));
  }

  destroy(): void {
    this._root.unmount();
    this._mount.remove();
  }
}
