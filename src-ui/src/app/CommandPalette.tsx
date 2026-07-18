// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：命令面板（Ctrl+K）— 动作注册表的统一入口。
// 过滤 = 标签子串匹配；↑↓ 选择，↵ 执行，esc 关闭。

import { useEffect, useMemo, useRef, useState } from 'react';
import { type AppAction, listActions } from './actions';
import { Icon } from './Icon';
import { useShellStore } from './shell-store';

export function CommandPalette() {
  const open = useShellStore((s) => s.paletteOpen);
  const setOpen = useShellStore((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0); // 动作在 init 期间注入 — 打开时重取列表
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setTick((t) => t + 1);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // 点击面板外关闭（document 级监听，静态元素上不挂交互处理器）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, setOpen]);

  const rows = useMemo(() => {
    void tick;
    const q = query.trim().toLowerCase();
    return listActions().filter((a) => !q || a.label.toLowerCase().includes(q));
  }, [query, tick]);

  if (!open) return null;

  const run = (a: AppAction | undefined) => {
    setOpen(false);
    a?.run();
  };

  const groups: Array<{ g: string; items: Array<{ a: AppAction; idx: number }> }> = [];
  rows.forEach((a, idx) => {
    let g = groups[groups.length - 1];
    if (!g || g.g !== a.group) {
      g = { g: a.group, items: [] };
      groups.push(g);
    }
    g.items.push({ a, idx });
  });

  return (
    <div className="pal-veil" role="presentation">
      <div className="pal-box" role="dialog" aria-label="命令面板" ref={boxRef}>
        <div className="pal-input">
          <span className="pal-prompt">❯</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="输入命令、面板或符号名…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((v) => Math.min(v + 1, rows.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((v) => Math.max(v - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(rows[active]);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
        </div>
        <div className="pal-list">
          {rows.length === 0 ? <div className="pal-group">无匹配命令</div> : null}
          {groups.map((g) => (
            <div key={g.g}>
              <div className="pal-group">{g.g}</div>
              {g.items.map(({ a, idx }) => (
                <button
                  key={a.id}
                  type="button"
                  className={`pal-row${idx === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => run(a)}
                >
                  {a.icon ? <Icon name={a.icon} /> : null}
                  <span className="pal-label">{a.label}</span>
                  {a.kbd ? <kbd>{a.kbd}</kbd> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span>↑↓ 选择</span>
          <span>↵ 执行</span>
          <span>esc 关闭</span>
          <span className="pal-foot-right">HOLOGRAM COMMAND</span>
        </div>
      </div>
    </div>
  );
}
