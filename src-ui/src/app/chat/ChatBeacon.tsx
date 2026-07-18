// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P2′：观测信标 — 聊天视图根（替代 chat-dom 的 buildDOM + ChatPanel 的 DOM 面）。
// 交互模型原样保留：底部居中浮标（pill 48px 圆球 → input 输入条 → panel 完整面板 → hud 幽灵态）。
// DOM 结构与 chat.css 的类契约一致（.chat-panel/.chat-pill/.chat-open/…），旧样式无缝套用。
// 数据全部来自 store；命令全部经 ChatCore；本文件只做渲染与事件转发。

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { loadSettings } from '../../settings';
import * as Session from '../../ui/chat-session';
import { getChatStore } from '../../ui/chat-store';
import { CommandRegistry } from '../../ui/command-registry';
import { AtAutocompleteController } from '../../ui/react/AtAutocomplete';
import { FooterController } from '../../ui/react/ChatFooter';
import { ChatHintController } from '../../ui/react/ChatHint';
import { ChatMessagesPanel } from '../../ui/react/ChatMessages';
import { PromptShelfController } from '../../ui/react/PromptShelf';
import { SlashPanelController } from '../../ui/react/SlashPanel';
import { Icon } from '../Icon';
import { Composer } from './Composer';
import { ChatCore } from './chat-core';
import { HistoryPanel } from './HistoryPanel';

const MODE_CLASS: Record<string, string> = {
  pill: 'chat-pill',
  input: 'chat-input-mode',
  panel: 'chat-open',
  hud: 'chat-hud',
};

// ── 会话标签行（>1 会话时显示）──
function SessionTabs({ core }: { core: ChatCore }) {
  const { sess } = getChatStore(core.panelId);
  const sessions = useStore(sess, (s) => s.sessions);
  const activeIdx = useStore(sess, (s) => s.activeIdx);
  if (sessions.length <= 1) return null;
  return (
    <div className="chat-session-bar">
      <div className="chat-session-tabs">
        {sessions.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`chat-session-tab${i === activeIdx ? ' active' : ''}`}
            onClick={() => core.switchSession(i)}
          >
            <span>{s.label}</span>
            <button
              type="button"
              className="chat-session-x"
              title="关闭会话"
              onClick={(e) => {
                e.stopPropagation();
                core.closeSession(i);
              }}
            >
              ×
            </button>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Agent 状态条 ──
function StatusStrip({ core }: { core: ChatCore }) {
  const { panel } = getChatStore(core.panelId);
  const state = useStore(panel, (s) => s.lastAgentState);
  const detail = useStore(panel, (s) => s.lastAgentDetail);
  const tokens = useStore(panel, (s) => s.totalTokensUsed);
  const settings = loadSettings();
  const active = settings.providers.find((p) => p.name === settings.activeProvider) || settings.providers[0];
  let model = '';
  if (active) {
    const ml = active.model || '';
    model = active.name ? `${active.name}/${ml.length > 20 ? `${ml.slice(0, 19)}…` : ml}` : ml;
  }
  const label =
    detail ||
    (state === 'idle' ? '就绪' : state === 'thinking' ? '思考中…' : state === 'running' ? '执行工具' : '错误');
  return (
    <div className="chat-status-bar">
      <span className={`chat-status-dot ${state}`} />
      <span className="chat-status-text">{label}</span>
      {tokens > 0 ? <span className="chat-status-tokens">{(tokens / 1000).toFixed(1)}k tok</span> : null}
      <span className="chat-status-model">{model}</span>
    </div>
  );
}

// ── Goal 状态条 ──
function GoalStrip({ core }: { core: ChatCore }) {
  const { panel } = getChatStore(core.panelId);
  const rec = useStore(panel, (s) => s.goalRecord);
  if (!rec) return null;
  return (
    <div className="goal-strip" style={{ display: 'flex' }}>
      <span className="goal-strip-icon">🎯</span>
      <span className="goal-strip-text">{rec.text.length > 40 ? `${rec.text.slice(0, 40)}…` : rec.text}</span>
      <span className="goal-strip-meta">
        {rec.status === 'paused' ? '已暂停' : '进行中'} · 第 {rec.iteration + 1} 轮
      </span>
      {rec.status === 'active' ? (
        <button type="button" className="goal-strip-btn" onClick={() => core.abort()}>
          暂停
        </button>
      ) : null}
      {rec.status === 'paused' ? (
        <button type="button" className="goal-strip-btn" onClick={() => core.runGoalResume()}>
          恢复
        </button>
      ) : null}
      <button type="button" className="goal-strip-btn goal-strip-btn-danger" onClick={() => core.cancelGoal()}>
        取消
      </button>
    </div>
  );
}

// ── 工具视图（renderToolsView 的 React 版）──
function ToolsView({ core }: { core: ChatCore }) {
  const { panel } = getChatStore(core.panelId);
  const schemas = useStore(panel, (s) => s.toolSchemas) || [];
  const usage = useStore(panel, (s) => s.toolUsage) || {};
  const history = useStore(panel, (s) => s.toolHistory) || [];
  const maxUsage = Math.max(1, ...Object.values(usage));
  return (
    <div className="chat-tools-view">
      <div className="chat-tools-section-title">工具清单</div>
      <div className="chat-tools-grid">
        {schemas.map((t) => {
          const count = usage[t.name] || 0;
          const cat = ChatCore.toolCategory(t.name);
          const desc = (t.description || '').split('\n')[0].slice(0, 60);
          return (
            <div key={t.name} className={`chat-tool-card tool-cat-${cat}`} title={`${t.name} — ${desc}`}>
              <div className="chat-tool-card-name">{t.name}</div>
              <div className="chat-tool-card-desc">{desc}</div>
              {count > 0 ? (
                <>
                  <div className="chat-tool-card-meta">
                    <span>{count} 次调用</span>
                  </div>
                  <div className="tool-usage-bar">
                    <div className="tool-usage-fill" style={{ width: `${(count / maxUsage) * 100}%` }} />
                  </div>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      {history.length > 0 ? (
        <>
          <div className="chat-tools-section-title" style={{ marginTop: 4 }}>
            最近调用
          </div>
          <div className="chat-tools-recent">
            {history.slice(0, 10).map((h) => (
              <div key={`${h.name}:${h.ts}`} className="chat-tool-recent-item">
                <span className="chat-tool-recent-name">{h.name}</span>
                <span className="chat-tool-recent-args">
                  {h.args ? (h.args.length > 40 ? `${h.args.slice(0, 39)}…` : h.args) : ''}
                </span>
                <span className="chat-tool-recent-count">
                  {new Date(h.ts).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── 上下文视图（renderContextView 的 React 版）──
function ContextView({ core }: { core: ChatCore }) {
  const { panel } = getChatStore(core.panelId);
  const tokensUsed = useStore(panel, (s) => s.totalTokensUsed);
  const toolUsage = useStore(panel, (s) => s.toolUsage);
  const settings = loadSettings();
  const active = settings.providers.find((p) => p.name === settings.activeProvider) || settings.providers[0];
  const ctxWin = settings.agent?.contextWindow || 0;
  const pct = ctxWin > 0 ? Math.min((tokensUsed / ctxWin) * 100, 100) : 0;
  const meterClass = pct >= 90 ? 'danger' : pct >= 80 ? 'warn' : 'safe';
  const agent = core.getAgent();
  const sysMsg = agent?.getSession()?.find((m) => m.role === 'system');
  const msgCount = agent?.getSession()?.filter((m) => m.role !== 'system').length || 0;
  const turnCount = Session.getTurnPairs(core.panelId).length;
  const toolTotal = Object.values(toolUsage || {}).reduce((a, b) => a + b, 0);
  return (
    <div className="chat-context-view">
      <div className="chat-context-section">
        <div className="chat-context-section-label">上下文窗口</div>
        <div className="chat-context-meter">
          <div className="chat-context-meter-bar">
            <div className={`chat-context-meter-fill ${meterClass}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="chat-context-meter-val">
            {ctxWin > 0 ? `${(tokensUsed / 1000).toFixed(1)}k / ${(ctxWin / 1000).toFixed(0)}k` : '未配置'}
          </span>
        </div>
      </div>
      <div className="chat-context-section">
        <div className="chat-context-section-label">当前模型</div>
        <div
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--signal)' }}
        >
          {active?.name || '未知'} / {active?.model || '未配置'}
          {active?.thinking ? ' · 思考模式' : ''}
        </div>
      </div>
      <div className="chat-context-section">
        <div className="chat-context-section-label">系统提示词</div>
        {sysMsg?.content ? (
          <pre className="chat-context-system-prompt">{sysMsg.content}</pre>
        ) : (
          <div className="chat-context-empty">Agent 未就绪</div>
        )}
      </div>
      <div className="chat-context-section">
        <div className="chat-context-section-label">会话统计</div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'calc(11px * var(--font-scale))',
            color: 'rgba(145,180,225,0.55)',
            display: 'flex',
            gap: 16,
          }}
        >
          <span>{msgCount} 条消息</span>
          <span>{turnCount} 轮对话</span>
          <span>{toolTotal} 次工具调用</span>
        </div>
      </div>
    </div>
  );
}

// ── 附件 pills ──
function AttachPills({ core }: { core: ChatCore }) {
  const { input } = getChatStore(core.panelId);
  const files = useStore(input, (s) => s.attachedFiles);
  if (files.length === 0) return null;
  return (
    <div className="attach-pills" style={{ display: 'flex' }}>
      {files.map((f, i) => {
        const sizeStr =
          f.size < 1024
            ? `${f.size} B`
            : f.size < 1024 * 1024
              ? `${(f.size / 1024).toFixed(1)} KB`
              : `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
        return (
          <span key={f.path} className="attach-pill" title={f.path}>
            <span className="attach-pill-icon">
              <Icon name="file" size={10} />
            </span>
            <span className="attach-pill-name">{f.name}</span>
            <span className="attach-pill-size">{sizeStr}</span>
            <button
              type="button"
              className="attach-pill-remove"
              title="移除附件"
              onClick={(e) => {
                e.stopPropagation();
                core.removeAttachedFile(i);
              }}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ChatBeacon 主体
// ═══════════════════════════════════════════════════════════════

export function ChatBeacon({ core }: { core: ChatCore }) {
  const panelStore = getChatStore(core.panelId).panel;
  const mode = useStore(panelStore, (s) => s.panelMode);
  const activeTab = useStore(panelStore, (s) => s.activeTab);
  const pillCount = useStore(panelStore, (s) => s.pillEventCount);
  const toolUsage = useStore(panelStore, (s) => s.toolUsage);
  const [busy, setBusy] = useState(core.execBusy);
  const panelRef = useRef<HTMLDivElement>(null);
  const chatTabRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);

  useEffect(() => core.onExecChange(() => setBusy(core.execBusy)), [core]);

  // ── 六个 React 控制器挂载（2b 再内联为组件，本阶段复用）──
  useEffect(() => {
    const panelEl = panelRef.current;
    const chatTabEl = chatTabRef.current;
    if (!panelEl || !chatTabEl) return;

    // 消息列表
    const msgRoot = document.createElement('div');
    msgRoot.className = 'chat-messages';
    chatTabEl.appendChild(msgRoot);
    const messages = new ChatMessagesPanel(msgRoot, core.panelId);
    messages.setCallbacks({
      onCopyText: (t) => core.copyText(t),
      onNavigateToNode: (n) => core.navigateToNode(n),
      onEditUserMessage: (m) => core.editUserMessage(m),
      onResendUserMessage: (m) => core.resendUserMessage(m),
      onRetryAssistant: (m) => core.retryAssistant(m),
    });
    core.registerMessages(messages);

    // 空态提示
    const hint = new ChatHintController(chatTabEl, core.panelId);

    // 权限 / ask_user 卡（插入 .chat-input-area 之前）
    const shelf = new PromptShelfController(panelEl);
    core.registerPromptShelf(shelf);

    // @ 补全
    const at = new AtAutocompleteController(panelEl, core.panelId);
    at.setOnSelect((atIdx, token) => core.applyAtSelect(atIdx, token));
    core.registerAt(at);

    // 斜杠面板
    const slash = new SlashPanelController(panelEl, CommandRegistry.instance.getAll(), (cmd) =>
      core.executeCommand(cmd),
    );
    core.registerSlash(slash);

    // Footer（token/模型/模式选择）
    const footer = new FooterController(panelEl, core.panelId, {
      onOpenSettings: () => core.fireOpenSettings(),
      onTriggerSlash: () => {
        const input = getChatStore(core.panelId).input.getState();
        const v = input.inputText;
        if (!v?.includes('/')) input.setInputText(`${v}/`);
        core.handleSlashInput(`${v}/`);
      },
      onAttachFile: () => core.openFilePicker(),
    });
    core.registerFooter(footer);

    return () => {
      messages.destroy();
      hint.destroy();
      shelf.destroy();
      at.destroy();
      slash.destroy();
      footer.destroy();
      msgRoot.remove();
    };
  }, [core]);

  // ── 图点击自动退避：panel→hud，hud/input→pill ──
  useEffect(() => {
    const graphEl = document.getElementById('graph');
    if (!graphEl) return;
    const handler = () => {
      const m = getChatStore(core.panelId).panel.getState().panelMode;
      if (m === 'panel') core.fadeToHud();
      else if (m === 'hud' || m === 'input') core.collapseToPill();
    };
    graphEl.addEventListener('click', handler);
    return () => graphEl.removeEventListener('click', handler);
  }, [core]);

  // ── 拖拽调整高度（≤70vh）──
  useEffect(() => {
    const handle = resizeRef.current;
    const panelEl = panelRef.current;
    if (!handle || !panelEl) return;
    let dragging = false;
    let startY = 0;
    let startH = 0;
    const onDown = (e: MouseEvent) => {
      dragging = true;
      startY = e.clientY;
      startH = panelEl.offsetHeight;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const maxH = Math.floor(window.innerHeight * 0.7);
      const h = Math.max(180, Math.min(maxH, startH + (startY - e.clientY)));
      panelEl.style.maxHeight = `${h}px`;
      panelEl.style.minHeight = `${h}px`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    handle.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      handle.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  const toolTotal = Object.values(toolUsage || {}).reduce((a, b) => a + b, 0);
  const switchTab = (tab: 'chat' | 'tools' | 'context') => panelStore.getState().setActiveTab(tab);

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖放目标是整个面板容器，无原生等价物；点击交互已拆到独立按钮 */}
      <div
        ref={panelRef}
        className={`chat-panel ${MODE_CLASS[mode] || 'chat-pill'}${busy ? ' chat-pill-running' : ''}`}
        id={`chat-panel-${core.panelId}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          core.handleFileDrop(e.nativeEvent);
        }}
      >
        {mode === 'pill' ? (
          <button
            type="button"
            className="chat-hit-area"
            aria-label="展开对话"
            onClick={(e) => {
              e.stopPropagation();
              core.expandToInput();
            }}
          />
        ) : null}
        {mode === 'hud' ? (
          <button
            type="button"
            className="chat-hit-area"
            aria-label="恢复对话面板"
            onClick={(e) => {
              e.stopPropagation();
              core.restoreFromHud();
            }}
          />
        ) : null}
        <div className="corner-brackets">
          <span className="cb-bottom left" />
          <span className="cb-bottom right" />
        </div>
        <div ref={resizeRef} className="chat-resize" />

        <div className="chat-header">
          <div className="chat-header-row">
            <span className="chat-title">
              <Icon name="chat" /> 全息对话
            </span>
            <div className="chat-panel-tabs">
              {(
                [
                  { id: 'chat', label: '对话' },
                  { id: 'tools', label: '工具' },
                  { id: 'context', label: '上下文' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`chat-panel-tab${activeTab === t.id ? ' active' : ''}`}
                  data-tab={t.id}
                  onClick={() => switchTab(t.id)}
                >
                  {t.label}
                  {t.id === 'tools' && toolTotal > 0 ? <span className="tab-badge">{toolTotal}</span> : null}
                </button>
              ))}
            </div>
            <div className="chat-header-right">
              <button
                type="button"
                className="chat-session-add"
                title="新建会话"
                onClick={() => core.createNewSession()}
              >
                <Icon name="plus" size={12} />
              </button>
              <button type="button" className="chat-session-add" title="历史记录" onClick={() => core.toggleHistory()}>
                <Icon name="bookmark" size={12} />
              </button>
              <button type="button" className="chat-close-btn" title="关闭" onClick={() => core.close()}>
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>
          <SessionTabs core={core} />
        </div>

        <StatusStrip core={core} />

        <div className="chat-tab-content">
          <div ref={chatTabRef} className={`chat-tab-panel${activeTab === 'chat' ? ' active' : ''}`} data-panel="chat">
            <GoalStrip core={core} />
            {/* 消息列表由 ChatMessagesPanel 控制器挂载于此 */}
          </div>
          <div className={`chat-tab-panel${activeTab === 'tools' ? ' active' : ''}`} data-panel="tools">
            {activeTab === 'tools' ? <ToolsView core={core} /> : null}
          </div>
          <div className={`chat-tab-panel${activeTab === 'context' ? ' active' : ''}`} data-panel="context">
            {activeTab === 'context' ? <ContextView core={core} /> : null}
          </div>
        </div>

        <button
          type="button"
          className="chat-expand-handle"
          title="展开对话面板"
          onClick={(e) => {
            e.stopPropagation();
            if (mode === 'input') core.summonPanel();
            else if (mode === 'panel') core.collapseToInput();
          }}
        >
          <div className="chat-expand-handle-inner" />
        </button>

        <AttachPills core={core} />

        <div className="chat-input-area">
          <Composer core={core} />
        </div>

        {/* Pill 球体装饰（chat.css 绘制） */}
        <div className="chat-pill-star">
          <svg viewBox="0 0 32 32" width="22" height="22">
            <title>观测信标</title>
            <circle cx="16" cy="16" r="3" fill="currentColor" opacity="0.9" />
            <polygon
              points="16,4 28,16 16,28 4,16"
              fill="none"
              stroke="currentColor"
              strokeWidth="0.7"
              opacity="0.45"
            />
          </svg>
        </div>
        <div className="chat-pill-inner-ring">
          <div className="chat-pill-orbit-dot" />
        </div>
        <div className={`chat-pill-badge${pillCount > 0 ? ' show' : ''}`}>
          {pillCount > 99 ? '99+' : pillCount || ''}
        </div>
      </div>

      <HistoryPortal core={core} />
    </>
  );
}

/** 历史面板经 portal 挂到 body（脱离面板 transform 上下文，与旧版一致） */
function HistoryPortal({ core }: { core: ChatCore }) {
  const { panel } = getChatStore(core.panelId);
  const open = useStore(panel, (s) => s.historyOpen);
  if (!open) return null;
  return createPortal(<HistoryPanel core={core} />, document.body);
}
