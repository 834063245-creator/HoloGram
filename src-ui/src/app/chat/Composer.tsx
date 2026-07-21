// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P2′：输入框（Composer）— 替代 chat-dom 的 textarea 接线。
// 输入文本唯一数据源是 input-store.inputText；textarea 只是它的受控投影。
// 键盘协议与旧版一致：@/slash 弹层优先 → Enter 发送 → ↑↓ 输入历史 → Esc 逐层关闭。

import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { getChatStore } from '../../ui/chat-store';
import { showContextMenu } from '../../ui/context-menu';
import { Icon } from '../Icon';
import type { ChatCore } from './chat-core';

export function Composer({ core }: { core: ChatCore }) {
  const { input, panel } = getChatStore(core.panelId);
  const value = useStore(input, (s) => s.inputText);
  const running = useStore(panel, (s) => s.lastAgentState) === 'thinking';
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(core.execBusy);

  // exec 状态（运行/权限卡）→ stop 按钮显隐
  useEffect(() => core.onExecChange(() => setBusy(core.execBusy)), [core]);

  // 自动高度（≤120px），与旧版一致
  useEffect(() => {
    void value; // 文本变化即触发重算
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [value]);

  // 注册命令式接口（core 在 idle/ask/fill 时聚焦）
  useEffect(() => {
    core.registerComposer({
      focus: () => taRef.current?.focus(),
      selectEnd: () => {
        const ta = taRef.current;
        if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length;
      },
    });
  }, [core]);

  const fireChange = (v: string) => {
    input.getState().setInputText(v);
    const ta = taRef.current;
    const pos = ta?.selectionStart ?? v.length;
    core.handleAtInput(v.slice(0, pos), pos);
    core.handleSlashInput(v.slice(0, pos));
  };

  const onContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const ta = taRef.current;
    showContextMenu(e.nativeEvent, [
      {
        label: '剪切',
        disabled: ta?.selectionStart === ta?.selectionEnd,
        action: () => document.execCommand('cut'),
      },
      {
        label: '复制',
        disabled: ta?.selectionStart === ta?.selectionEnd,
        action: () => document.execCommand('copy'),
      },
      {
        label: '粘贴',
        action: () => document.execCommand('paste'),
      },
      { separator: true, label: '', action: () => {} },
      {
        label: '全选',
        action: () => document.execCommand('selectAll'),
      },
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ── @ popup keyboard nav ──
    if (core.atOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        core.atNavigate(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        core.atNavigate(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        core.atSelect();
        return;
      }
    }
    // ── / slash panel keyboard nav ──
    if (core.slashVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        core.slashNavigate(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        core.slashNavigate(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        core.slashSelect();
        return;
      }
      if (e.key === 'Escape') {
        core.dismissSlash();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      core.sendMessage();
      return;
    }
    // ── Input history navigation ──
    const s = input.getState();
    const ta = taRef.current;
    if (!ta) return;
    if (e.key === 'ArrowUp' && s.inputHistory.length > 0) {
      const cursorAtStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
      if (cursorAtStart) {
        e.preventDefault();
        if (s.inputHistoryIdx === s.inputHistory.length) {
          s.setDraftText(ta.value);
        }
        if (s.inputHistoryIdx > 0) {
          s.setInputHistoryIdx(s.inputHistoryIdx - 1);
          s.setInputText(s.inputHistory[s.inputHistoryIdx]);
        }
        return;
      }
    }
    if (e.key === 'ArrowDown' && s.inputHistory.length > 0) {
      const cursorAtEnd = ta.selectionStart === ta.value.length;
      if (cursorAtEnd) {
        e.preventDefault();
        if (s.inputHistoryIdx < s.inputHistory.length - 1) {
          s.setInputHistoryIdx(s.inputHistoryIdx + 1);
          s.setInputText(s.inputHistory[s.inputHistoryIdx]);
        } else {
          s.setInputHistoryIdx(s.inputHistory.length);
          s.setInputText(s.draftText);
        }
        return;
      }
    }
    if (e.key === 'Escape') {
      if (core.slashVisible) {
        core.hideSlash();
        return;
      }
      core.close();
    }
  };

  return (
    <>
      <textarea
        ref={taRef}
        className="chat-input"
        placeholder={running ? 'Agent 思考中… 可直接输入消息插入对话' : '输入消息… (Enter 发送, Shift+Enter 换行)'}
        rows={2}
        value={value}
        onChange={(e) => fireChange(e.target.value)}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
      />
      <button
        type="button"
        className={`chat-send-btn${busy ? ' hidden' : ''}`}
        title="发送"
        onClick={() => core.sendMessage()}
      >
        <Icon name="send" />
      </button>
      <button
        type="button"
        className={`chat-stop-btn${busy ? '' : ' hidden'}`}
        title="停止"
        onClick={() => core.abort()}
      >
        <Icon name="stop" />
      </button>
    </>
  );
}
