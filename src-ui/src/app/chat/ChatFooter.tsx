// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatFooter — React 重写聊天面板底部状态栏
// 替代 chat.ts 中 updateFooter() 的 innerHTML + querySelector 命令式操作。
// 纯声明式：订阅 Zustand stores → 自动渲染，零 DOM 操作。

import type React from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { useStore } from 'zustand';
import { typedRpc } from '../../rpc-contract';
import { type AppSettings, loadSettings, onSettingsSaved, saveSettings } from '../../settings';
import { notifyAgentConfigChanged } from '../../state/agent-config-store';
import type { CollaborationMode, PermissionMode } from '../../state/panel-store';
import { getChatStore } from '../../ui/chat-store';
import { iconHtml } from '../../ui/icons';
import { useShellStore } from '../shell-store';
import { ModelSwitcher } from './ModelSwitcher';

// ── 类型 ──

export interface FooterCallbacks {
  onOpenSettings: (() => void) | null;
  onTriggerSlash: () => void;
  onAttachFile: () => void;
}

// ── React 组件 ──

function ChatFooterLeft({ panelId, callbacks }: { panelId: string; callbacks: FooterCallbacks }) {
  const panelStore = getChatStore(panelId).panel;

  const totalTokensUsed = useStore(panelStore, (s) => s.totalTokensUsed);
  const lastUsageText = useStore(panelStore, (s) => s.lastUsageText);
  const _projectPath = useShellStore((s) => s.projectPath);

  // 设置经 onSettingsSaved 订阅响应式更新 — 不再依赖手动 refresh() 催更
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  useEffect(() => onSettingsSaved(() => setSettings(loadSettings())), []);
  const ctxWin = settings.agent?.contextWindow || 0;

  const usageStr = lastUsageText ? ` · ${lastUsageText}` : '';

  // Token 进度条
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

  return (
    <div className="chat-footer-left">
      <ModelSwitcher settings={settings} onOpenSettings={callbacks.onOpenSettings} />
      {tokenBar}
      <span className="chat-usage-badge">{usageStr}</span>
    </div>
  );
}

function ChatFooterRight({ callbacks }: { callbacks: FooterCallbacks }) {
  return (
    <div className="chat-footer-right">
      <button
        className="chat-shortcuts-btn"
        data-tooltip="Ctrl+L    打开/关闭面板&#10;Enter     发送 (输入框)&#10;Shift+Enter  换行&#10;Esc       关闭面板&#10;Ctrl+Y    始终允许 (权限)&#10;↑↓        历史导航 (输入框)"
      >
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

// ── 模式栏 ──

function ChatModebar({ panelId }: { panelId: string }) {
  const panelStore = getChatStore(panelId).panel;
  const collaborationMode = useStore(panelStore, (s) => s.collaborationMode);
  const permissionMode = useStore(panelStore, (s) => s.permissionMode);

  const setCollaboration = useCallback(
    (mode: CollaborationMode) => {
      panelStore.getState().setCollaborationMode(mode);
      const s = loadSettings();
      s.agent = { ...s.agent, collaborationMode: mode };
      saveSettings(s);
      // 模式切换只改 panel store + 发显式事件；
      // 由 Workspace.applyAgentConfig 统一热切换处理（不重建）。
      notifyAgentConfigChanged('collaboration-mode');
    },
    [panelStore],
  );
  const setPermission = useCallback(
    (mode: PermissionMode) => {
      panelStore.getState().setPermissionMode(mode);
      const s = loadSettings();
      s.agent = { ...s.agent, permissionMode: mode };
      saveSettings(s);
      // 模式镜像到后端 — 后台任务（同步权限路径）靠它决定是否旁路 Ask
      typedRpc('set_permission_mode', { mode }).catch(() => {});
    },
    [panelStore],
  );

  return (
    <div className="chat-modebar">
      <div className="chat-modebar-left">
        <button
          className={`chat-modebar__btn${collaborationMode === 'plan' ? ' chat-modebar__btn--active' : ''}`}
          onClick={() => setCollaboration(collaborationMode === 'plan' ? 'normal' : 'plan')}
          title={collaborationMode === 'plan' ? '退出规划模式' : '规划模式：只读分析，不执行修改'}
        >
          <span className="chat-modebar__icon" dangerouslySetInnerHTML={{ __html: iconHtml('plan', 11) }} />
          <span>规划</span>
        </button>
      </div>
      <div className="chat-modebar-right">
        <button
          className={`chat-modebar__seg${permissionMode === 'ask' ? ' chat-modebar__seg--active' : ''}`}
          onClick={() => setPermission('ask')}
          title="每个写操作都询问确认"
        >
          🛡 询问
        </button>
        <button
          className={`chat-modebar__seg${permissionMode === 'auto' ? ' chat-modebar__seg--active' : ''}`}
          onClick={() => setPermission('auto')}
          title="常规编辑自动批准，危险命令仍询问"
        >
          ✓ 自动
        </button>
        <button
          className={`chat-modebar__seg chat-modebar__seg--yolo${permissionMode === 'yolo' ? ' chat-modebar__seg--active' : ''}`}
          onClick={() => setPermission('yolo')}
          title="全部自动批准（危险！）"
        >
          ⚠ YOLO
        </button>
      </div>
    </div>
  );
}

// ── 完整底部组件（P2′-2b：直接挂 ChatBeacon 树，Controller 包装已删）──

export interface ChatFooterHandle {
  /** 手动催更（token 条等非 settings 内容）—— settings 变更已由
   *  onSettingsSaved 订阅自动响应，模型名不再依赖此路径。 */
  refresh(): void;
}

export const ChatFooter = forwardRef<ChatFooterHandle, { panelId: string; callbacks: FooterCallbacks }>(
  function ChatFooter({ panelId, callbacks }, ref) {
    // version 仅用于 refresh() 催更，不参与渲染
    const [version, setVersion] = useState(0);
    void version;
    useImperativeHandle(ref, () => ({ refresh: () => setVersion((v) => v + 1) }), []);
    return (
      <div className="chat-footer">
        <ChatModebar panelId={panelId} />
        <div className="chat-footer-row">
          <ChatFooterLeft panelId={panelId} callbacks={callbacks} />
          <ChatFooterRight callbacks={callbacks} />
        </div>
      </div>
    );
  },
);
