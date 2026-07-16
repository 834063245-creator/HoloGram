// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatHint — React empty-state hint shown when no messages and no agent configured.
// Auto-subscribes to panel store and active session messages store.
// Disappears automatically when messages arrive or agent is configured.

import React, { useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from 'zustand';
import { getChatStore, msgStoreFor } from '../chat-store';

// ponytail: stable reference so the selector below never returns a fresh []
// which would trigger an infinite loop via useSyncExternalStore.
const EMPTY_MSGS: never[] = [];

function ChatHint({ panelId }: { panelId: string }) {
  const panelStore = getChatStore(panelId).panel;
  const sessStore = getChatStore(panelId).sess;
  const lastAgentDiag = useStore(panelStore, (s) => s.lastAgentDiag);

  // Subscribe to session store — re-renders when sessions change (new/load/switch/close).
  const activeSid = useStore(sessStore, (s) => s.sessions[s.activeIdx]?.id ?? null);

  const msgStore = useMemo(
    () => (activeSid != null ? msgStoreFor(panelId, activeSid) : null),
    [panelId, activeSid],
  );
  const messages = useStore(msgStore ?? panelStore, (s) =>
    'messages' in s ? (s as any).messages : EMPTY_MSGS,
  );

  // Only show when messages list is empty
  if (!Array.isArray(messages) || messages.length > 0) return null;

  // Agent status: check if diag starts with successful agent init pattern
  const agentReady = typeof lastAgentDiag === 'string' && lastAgentDiag.startsWith('[Agent] provider=');
  const text = agentReady
    ? '向我提问代码库的问题，或直接聊天'
    : `请先配置 API Key（点击工具栏 设置 或在对话中设置）${lastAgentDiag ? `\n\n诊断: ${lastAgentDiag}` : ''}`;

  return <div className="chat-hint">{text}</div>;
}

export class ChatHintController {
  private _root: Root;
  private _mount: HTMLElement;

  constructor(container: HTMLElement, panelId: string) {
    this._mount = document.createElement('div');
    container.appendChild(this._mount);
    this._root = createRoot(this._mount);
    this._root.render(React.createElement(ChatHint, { panelId }));
  }

  destroy(): void {
    this._root.unmount();
    this._mount.remove();
  }
}
