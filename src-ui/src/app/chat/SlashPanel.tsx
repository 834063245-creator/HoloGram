// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SlashPanel — React 重写斜杠命令面板
// 替代 chat.ts 中 _showSlashPanel / _hideSlashPanel / _selectSlashItem / _navigateSlashPanel
// 修复 R7：不再混用 CSS class 和内联 style.display。React 条件渲染天然无残留。

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { CommandDef } from '../../ui/command-registry';
import { CommandRegistry } from '../../ui/command-registry';

// ── Exposed imperative API ──

export interface SlashPanelHandle {
  show(query?: string): void;
  hide(): void;
  navigate(delta: number): boolean;
  select(): CommandDef | null;
  readonly visible: boolean;
}

// ── React Component（P2′-2b：直接挂 ChatBeacon 树，Controller 包装已删）──
// 句柄只创建一次（core 挂载时注册）；命令式读取一律走 ref 镜像，避免陈旧闭包。

export const SlashPanel = forwardRef<SlashPanelHandle, { commands: CommandDef[]; onCommit: (cmd: CommandDef) => void }>(
  function SlashPanel({ commands, onCommit }, ref) {
    const [visible, setVisible] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIdx, setActiveIdx] = useState(0);

    const filtered = useMemo(() => (query ? CommandRegistry.instance.filter(query) : commands), [query, commands]);

    // 命令式句柄的实时数据镜像（每次渲染后同步）
    const visibleRef = useRef(visible);
    const filteredRef = useRef(filtered);
    const activeIdxRef = useRef(activeIdx);
    const onCommitRef = useRef(onCommit);
    useEffect(() => {
      visibleRef.current = visible;
      filteredRef.current = filtered;
      activeIdxRef.current = activeIdx;
      onCommitRef.current = onCommit;
    });

    const show = useCallback((q?: string) => {
      setQuery(q ?? '');
      setActiveIdx(0);
      setVisible(true);
    }, []);
    const hide = useCallback(() => setVisible(false), []);

    // 点击面板外部时收起
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (!visible) return;
      const handler = (e: MouseEvent) => {
        const el = rootRef.current;
        if (el && !el.contains(e.target as Node)) {
          hide();
        }
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, [visible, hide]);

    const navigate = useCallback((delta: number): boolean => {
      const list = filteredRef.current;
      if (!visibleRef.current || list.length === 0) return false;
      setActiveIdx((idx) => {
        let next = idx + delta;
        if (next < 0) next = list.length - 1;
        if (next >= list.length) next = 0;
        return next;
      });
      return true;
    }, []);

    const select = useCallback((): CommandDef | null => {
      if (!visibleRef.current || filteredRef.current.length === 0) return null;
      const cmd = filteredRef.current[activeIdxRef.current];
      hide();
      onCommitRef.current(cmd);
      return cmd;
    }, [hide]);

    useImperativeHandle(
      ref,
      () => ({
        show,
        hide,
        navigate,
        select,
        get visible() {
          return visibleRef.current;
        },
      }),
      [show, hide, navigate, select],
    );

    if (!visible || filtered.length === 0) return null;

    const groups = new Map<string, CommandDef[]>();
    for (const cmd of filtered) {
      const arr = groups.get(cmd.group) || [];
      arr.push(cmd);
      groups.set(cmd.group, arr);
    }

    let flatIdx = 0;
    return (
      <div ref={rootRef} className="chat-slash-panel open">
        {Array.from(groups.entries()).map(([group, items]) => (
          <div className="sp-group" key={group}>
            <div className="sp-group-title">{group}</div>
            {items.map((item) => {
              const idx = flatIdx++;
              return (
                <div
                  key={item.id}
                  className={`sp-item${idx === activeIdx ? ' sp-active' : ''}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => {
                    hide();
                    onCommit(item);
                  }}
                >
                  <span className="sp-label">{item.label}</span>
                  <span className="sp-desc">{item.description}</span>
                  <span className="sp-key">{item.shortcut ? item.shortcut.split('/').pop() : ''}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  },
);
