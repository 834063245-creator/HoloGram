// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatHint — 无消息且未配置 Agent 时显示的空状态提示。
// 自动订阅面板 store 和活动会话消息 store。
// 消息到达或 Agent 配置完成后自动消失。

import { useMemo } from 'react';
import { useStore } from 'zustand';
import { getChatStore, msgStoreFor } from '../chat-store';

// ponytail: 稳定引用，使下方 selector 不会返回新的 []
// 否则会通过 useSyncExternalStore 触发无限循环。
const EMPTY_MSGS: never[] = [];

export function ChatHint({ panelId }: { panelId: string }) {
  const panelStore = getChatStore(panelId).panel;
  const sessStore = getChatStore(panelId).sess;
  const lastAgentDiag = useStore(panelStore, (s) => s.lastAgentDiag);

  // 订阅会话 store — 会话变化时（新建/加载/切换/关闭）重新渲染。
  const activeSid = useStore(sessStore, (s) => s.sessions[s.activeIdx]?.id ?? null);

  const msgStore = useMemo(() => (activeSid != null ? msgStoreFor(panelId, activeSid) : null), [panelId, activeSid]);
  const messages = useStore(msgStore ?? panelStore, (s) => ('messages' in s ? (s as any).messages : EMPTY_MSGS));

  // 仅在消息列表为空时显示
  if (!Array.isArray(messages) || messages.length > 0) return null;

  // Agent 状态：检查 diag 是否以成功的 Agent 初始化模式开头
  const agentReady = typeof lastAgentDiag === 'string' && lastAgentDiag.startsWith('[Agent] provider=');
  const text = agentReady
    ? '向我提问代码库的问题，或直接聊天'
    : `请先配置 API Key（点击工具栏 设置 或在对话中设置）${lastAgentDiag ? `\n\n诊断: ${lastAgentDiag}` : ''}`;

  return <div className="chat-hint">{text}</div>;
}
