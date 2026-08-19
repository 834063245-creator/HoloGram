// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatHint — 无消息且未配置 Agent 时显示的空状态提示。
// 自动订阅面板 store 和活动会话消息 store。
// 消息到达或 Agent 配置完成后自动消失。

import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { type AppSettings, getActiveProvider, loadSettingsWithSecrets, onSettingsSaved } from '../../settings';
import { getChatStore, msgStoreFor } from '../../ui/chat-store';

// ponytail: 稳定引用，使下方 selector 不会返回新的 []
// 否则会通过 useSyncExternalStore 触发无限循环。
const EMPTY_MSGS: never[] = [];

export function ChatHint({ panelId }: { panelId: string }) {
  const panelStore = getChatStore(panelId).panel;
  const sessStore = getChatStore(panelId).sess;
  const lastAgentDiag = useStore(panelStore, (s) => s.lastAgentDiag);

  // 是否已配置 provider + key — 从设置（含加密凭据回填）判定，
  // 不解析 [Agent] 诊断日志字符串（日志仅作展示，非契约）。
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      loadSettingsWithSecrets()
        .then((s) => {
          if (alive) setSettings(s);
        })
        .catch(() => {});
    };
    refresh();
    const off = onSettingsSaved(refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  // 订阅会话 store — 会话变化时（新建/加载/切换/关闭）重新渲染。
  const activeSid = useStore(sessStore, (s) => s.sessions[s.activeIdx]?.id ?? null);

  const msgStore = useMemo(() => (activeSid != null ? msgStoreFor(panelId, activeSid) : null), [panelId, activeSid]);
  const messages = useStore(msgStore ?? panelStore, (s) => ('messages' in s ? s.messages : EMPTY_MSGS));

  // 仅在消息列表为空时显示
  if (!Array.isArray(messages) || messages.length > 0) return null;

  const active = settings ? getActiveProvider(settings) : null;
  const agentReady = !!active?.apiKey?.trim();
  const text = agentReady
    ? '向我提问代码库的问题，或直接聊天'
    : `请先配置 API Key（点击工具栏 设置 或在对话中设置）${lastAgentDiag ? `\n\n诊断: ${lastAgentDiag}` : ''}`;

  return <div className="chat-hint">{text}</div>;
}
