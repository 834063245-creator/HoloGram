// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatFooter — React 重写聊天面板底部状态栏
// 替代 chat.ts 中 updateFooter() 的 innerHTML + querySelector 命令式操作。
// 纯声明式：订阅 Zustand stores → 自动渲染，零 DOM 操作。

import React, { useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from 'zustand';
import { iconHtml } from '../icons';
import { loadSettings } from '../../settings';
import { getChatStore } from '../chat-store';

// ── Types ──

export interface FooterCallbacks {
  onOpenSettings: (() => void) | null;
  onTriggerSlash: () => void;
  onAttachFile: () => void;
}

// ── React Component ──

function ChatFooter({ panelId, callbacks }: { panelId: string; callbacks: FooterCallbacks }) {
  const panelStore = getChatStore(panelId).panel;

  const totalTokensUsed = useStore(panelStore, (s) => s.totalTokensUsed);
  const lastUsageText = useStore(panelStore, (s) => s.lastUsageText);
  const projectPath = useStore(panelStore, (s) => s.projectPath);

  // settings are non-reactive — read once and re-render when stores tick
  const settings = loadSettings();
  const active = settings.providers.find((p) => p.name === settings.activeProvider) || settings.providers[0];
  const ctxWin = settings.agent?.contextWindow || 0;

  let modelLabel = active?.model || 'unknown';
  if (modelLabel.length > 18) modelLabel = modelLabel.slice(0, 17) + '\u2026';

  const thinking = active?.thinking ? ' · 思考' : '';
  const usageStr = lastUsageText ? ` · ${lastUsageText}` : '';

  // Token bar
  let tokenBar: React.ReactNode = null;
  if (ctxWin > 0 && totalTokensUsed > 0) {
    const pct = Math.min((totalTokensUsed / ctxWin) * 100, 100);
    let cls = '';
    if (pct >= 90) cls = 'danger';
    else if (pct >= 80) cls = 'warn';
    const labelK = `${(totalTokensUsed / 1000).toFixed(1)}k / ${(ctxWin / 1000).toFixed(0)}k`;
    tokenBar = (
      <div className="chat-token-bar-wrap" title="上下文窗口用量">
        <span>{labelK}</span>
        <div className="chat-token-bar">
          <div className={`chat-token-bar-fill ${cls}`} style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
      </div>
    );
  }

  const handleModelClick = useCallback(() => {
    callbacks.onOpenSettings?.();
  }, [callbacks.onOpenSettings]);

  return (
    <div className="chat-footer-left">
      <button className="chat-model-badge chat-model-clickable" title={`点击切换模型 · ${active?.name} / ${active?.model}`} onClick={handleModelClick}>
        <span dangerouslySetInnerHTML={{ __html: iconHtml('agent', 10) }} /> {modelLabel}{thinking}
      </button>
      {tokenBar}
      <span className="chat-usage-badge">{usageStr}</span>
    </div>
  );
}

function ChatFooterRight({ callbacks }: { callbacks: FooterCallbacks }) {
  return (
    <div className="chat-footer-right">
      <button className="chat-shortcuts-btn" data-tooltip="Ctrl+L    打开/关闭面板&#10;Enter     发送 (输入框)&#10;Shift+Enter  换行&#10;Esc       关闭面板&#10;Ctrl+Y    始终允许 (权限)&#10;↑↓        历史导航 (输入框)">
        <span dangerouslySetInnerHTML={{ __html: iconHtml('keyboard', 13) }} />
      </button>
      <button className="chat-slash-trigger" title="命令菜单" onClick={callbacks.onTriggerSlash}>
        <span dangerouslySetInnerHTML={{ __html: iconHtml('code', 12) }} />
        <span className="chat-slash-label">/</span>
      </button>
      <button className="chat-session-add chat-attach-btn" title="附加文件" onClick={callbacks.onAttachFile}>
        <span dangerouslySetInnerHTML={{ __html: iconHtml('file-plus', 13) }} />
      </button>
    </div>
  );
}

// ── Full footer component ──

function ChatFooterInner({ panelId, callbacks, _forceVersion }: {
  panelId: string;
  callbacks: FooterCallbacks;
  _forceVersion?: number;
}) {
  // _forceVersion bumps when settings change — triggers re-render to pick up new model name
  void _forceVersion;
  return (
    <>
      <ChatFooter panelId={panelId} callbacks={callbacks} />
      <ChatFooterRight callbacks={callbacks} />
    </>
  );
}

// ── Controller — thin wrapper for ChatPanel ──

export class FooterController {
  private _root: Root;
  private _mount: HTMLElement;
  private _panelId: string;
  private _callbacks: FooterCallbacks;
  private _version = 0;

  constructor(container: HTMLElement, panelId: string, callbacks: FooterCallbacks) {
    this._panelId = panelId;
    this._callbacks = callbacks;
    this._mount = document.createElement('div');
    this._mount.className = 'chat-footer';
    container.appendChild(this._mount);
    this._root = createRoot(this._mount);
    this._render();
  }

  private _render(): void {
    this._root.render(
      React.createElement(ChatFooterInner, {
        panelId: this._panelId,
        callbacks: this._callbacks,
        _forceVersion: this._version,
      }),
    );
  }

  /** Call after settings change to re-read model badge. */
  refresh(): void {
    this._version++;
    this._render();
  }

  /** Update callbacks (e.g. onOpenSettings may change after construction). */
  setCallbacks(callbacks: FooterCallbacks): void {
    this._callbacks = callbacks;
    this._render();
  }

  destroy(): void {
    this._root.unmount();
    this._mount.remove();
  }
}
