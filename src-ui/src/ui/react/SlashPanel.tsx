// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SlashPanel — React 重写斜杠命令面板
// 替代 chat.ts 中 _showSlashPanel / _hideSlashPanel / _selectSlashItem / _navigateSlashPanel
// 修复 R7：不再混用 CSS class 和内联 style.display。React 条件渲染天然无残留。

import React, { useState, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandRegistry } from '../command-registry';
import type { CommandDef } from '../command-registry';

// ── Exposed imperative API ──

export interface SlashPanelHandle {
  show(query?: string): void;
  hide(): void;
  navigate(delta: number): boolean;
  select(): CommandDef | null;
  readonly visible: boolean;
}

// ── React Component ──

const SlashPanel = forwardRef<SlashPanelHandle, { commands: CommandDef[]; onCommit: (cmd: CommandDef) => void }>(
  function SlashPanel({ commands, onCommit }, ref) {
    const [visible, setVisible] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIdx, setActiveIdx] = useState(0);

    const filtered = useMemo(
      () => query ? CommandRegistry.instance.filter(query) : commands,
      [query, commands],
    );

    const show = useCallback((q?: string) => { setQuery(q ?? ''); setActiveIdx(0); setVisible(true); }, []);
    const hide = useCallback(() => setVisible(false), []);

    const navigate = useCallback((delta: number): boolean => {
      if (!visible || filtered.length === 0) return false;
      setActiveIdx(idx => {
        let next = idx + delta;
        if (next < 0) next = filtered.length - 1;
        if (next >= filtered.length) next = 0;
        return next;
      });
      return true;
    }, [visible, filtered.length]);

    useImperativeHandle(ref, () => ({
      show, hide, navigate,
      select: () => {
        if (!visible || filtered.length === 0) return null;
        const cmd = filtered[activeIdx];
        hide();
        onCommit(cmd);
        return cmd;
      },
      get visible() { return visible; },
    }));

    if (!visible) return null;

    const groups = new Map<string, CommandDef[]>();
    for (const cmd of filtered) {
      const arr = groups.get(cmd.group) || [];
      arr.push(cmd);
      groups.set(cmd.group, arr);
    }

    let flatIdx = 0;
    return (
      <div className="chat-slash-panel open">
        {Array.from(groups.entries()).map(([group, items]) => (
          <div className="sp-group" key={group}>
            <div className="sp-group-title">{group}</div>
            {items.map(item => {
              const idx = flatIdx++;
              return (
                <div key={item.id} className={`sp-item${idx === activeIdx ? ' sp-active' : ''}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => { hide(); onCommit(item); }}>
                  <span className="sp-label">{item.label}</span>
                  <span className="sp-desc">{item.description}</span>
                  <span className="sp-sk">{item.shortcut ? item.shortcut.split('/').pop() : ''}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  },
);

// ── Thin class wrapper — ChatPanel can use this instead of manual DOM ──

export class SlashPanelController {
  private _root: Root;
  private _mount: HTMLElement;
  private _handle: SlashPanelHandle | null = null;
  private _commands: CommandDef[];

  constructor(container: HTMLElement, commands: CommandDef[], onCommit: (cmd: CommandDef) => void) {
    this._commands = commands;
    this._mount = document.createElement('div');
    container.appendChild(this._mount);
    this._root = createRoot(this._mount);
    this._render(onCommit);
  }

  private _render(onCommit: (cmd: CommandDef) => void): void {
    const ref = (h: SlashPanelHandle | null) => { this._handle = h; };
    this._root.render(React.createElement(SlashPanel, { commands: this._commands, onCommit, ref }));
  }

  setOnCommit(onCommit: (cmd: CommandDef) => void): void { this._render(onCommit); }

  show(query?: string): void { this._handle?.show(query); }
  hide(): void { this._handle?.hide(); }
  navigate(delta: number): boolean { return this._handle?.navigate(delta) ?? false; }
  select(): CommandDef | null { return this._handle?.select() ?? null; }
  get visible(): boolean { return this._handle?.visible ?? false; }

  destroy(): void { this._root.unmount(); this._mount.remove(); }
}
