// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：快捷键浮层 — 替代旧 #shortcuts-overlay 静态标记。
// 行为对齐旧版：? 开关，12 秒无操作自动隐藏，悬停暂停计时。

import { useEffect, useRef } from 'react';
import { useShellStore } from './shell-store';

const GROUPS: Array<{ title: string; rows: Array<{ keys: string[]; desc: string }> }> = [
  {
    title: '全局',
    rows: [
      { keys: ['Ctrl', 'K'], desc: '命令面板' },
      { keys: ['Ctrl', 'L'], desc: '对话面板' },
      { keys: ['Ctrl', 'D'], desc: '变更着色' },
      { keys: ['Ctrl', ','], desc: '设置' },
      { keys: ['?'], desc: '快捷键面板' },
      { keys: ['Esc'], desc: '逐层关闭：星系 → 面板 → 高亮' },
    ],
  },
  {
    title: '星图',
    rows: [
      { keys: ['R'], desc: '复位视角' },
      { keys: ['F'], desc: '折叠 / 展开星系' },
      { keys: ['B'], desc: '波及分析（选中节点后）' },
      { keys: ['点击节点'], desc: '详情卡片 · 打开 / Agent / 波及 / 聚焦' },
    ],
  },
  {
    title: '对话',
    rows: [
      { keys: ['Enter'], desc: '发送' },
      { keys: ['Shift', '↵'], desc: '换行' },
      { keys: ['/new'], desc: '重置当前会话' },
      { keys: ['/compact'], desc: '压缩上下文' },
      { keys: ['/memory'], desc: '查看记忆' },
      { keys: ['/remember'], desc: '记住一件事' },
      { keys: ['/export'], desc: '导出对话' },
      { keys: ['@文件名'], desc: '引用文件（自动补全）' },
    ],
  },
  {
    title: '权限卡片',
    rows: [
      { keys: ['Enter'], desc: '允许本次' },
      { keys: ['Esc'], desc: '拒绝' },
      { keys: ['Ctrl', 'Y'], desc: '始终允许' },
    ],
  },
];

export function ShortcutsOverlay() {
  const open = useShellStore((s) => s.shortcutsOpen);
  const setOpen = useShellStore((s) => s.setShortcutsOpen);
  const boxRef = useRef<HTMLDivElement>(null);

  // 12s 自动隐藏；悬停（:hover）时跳过本轮
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      if (!boxRef.current?.matches(':hover')) setOpen(false);
    }, 12000);
    return () => clearInterval(t);
  }, [open, setOpen]);

  // 点击浮层外关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="sx-veil" role="presentation">
      <div className="sx-box" ref={boxRef}>
        {GROUPS.map((g, gi) => (
          <div key={g.title} className="sx-group">
            {gi > 0 ? <span className="sx-sep" /> : null}
            <div className="sx-group-title">{g.title}</div>
            {g.rows.map((r) => (
              <div key={r.desc} className="sx-row">
                <span className="sx-keys">
                  {r.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
                <span className="sx-desc">{r.desc}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
