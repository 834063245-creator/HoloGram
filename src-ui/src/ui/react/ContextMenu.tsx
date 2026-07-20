// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ContextMenu — React portal-based right-click context menu.
// Renders at mouse position, auto-dismisses on outside click / Escape.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  separator?: boolean; // render a divider before this item
}

interface Props {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onDismiss: () => void;
}

const ContextMenuApp: React.FC<Props> = ({ items, x: rawX, y: rawY, onDismiss }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: rawX, y: rawY });

  // Adjust position to stay within viewport
  useEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = rawX;
    let y = rawY;
    if (x + 180 > vw) x = vw - 185;
    if (y + items.length * 28 + 20 > vh) y = vh - items.length * 28 - 25;
    setPos({ x: Math.max(2, x), y: Math.max(2, y) });
  }, [rawX, rawY, items.length]);

  // Dismiss on outside click / Escape
  useEffect(() => {
    const onDown = (ev: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) {
        onDismiss();
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onDismiss();
    };
    // Defer listener registration so the triggering right-click doesn't immediately dismiss
    const id = setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{
        position: 'fixed',
        zIndex: 200,
        left: pos.x,
        top: pos.y,
        background: 'var(--obs-glass-hi, rgba(4,12,28,0.96))',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid var(--obs-line)',
        borderRadius: 10,
        padding: 4,
        minWidth: 160,
        boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
        fontFamily: 'var(--obs-font-mono)',
        fontSize: 'calc(11px * var(--font-scale))',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {item.separator && <div style={{ height: 1, background: 'var(--obs-line-soft)', margin: '3px 6px' }} />}
          <div
            className="ctx-menu-item"
            style={{
              padding: '5px 10px',
              borderRadius: 7,
              cursor: item.disabled ? 'default' : 'pointer',
              color: item.disabled ? 'var(--obs-text-3)' : 'var(--obs-text, #c3daf8)',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
            onMouseEnter={(e) => {
              if (!item.disabled) {
                (e.currentTarget as HTMLDivElement).style.background = 'rgba(160,180,220,0.08)';
                (e.currentTarget as HTMLDivElement).style.color = 'var(--obs-text)';
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = '';
              (e.currentTarget as HTMLDivElement).style.color = item.disabled
                ? 'var(--obs-text-3)'
                : 'var(--obs-text, #c3daf8)';
            }}
            onClick={
              item.disabled
                ? undefined
                : (ev) => {
                    ev.stopPropagation();
                    onDismiss();
                    item.action();
                  }
            }
          >
            {item.label}
          </div>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
};

// ── Module-level API（P3：懒 root 已删 — 请求写入 overlay-store，由单树 ContextMenuHost 渲染）──

import { useOverlayStore } from '../overlay-store';

export function showContextMenu(e: MouseEvent, items: ContextMenuItem[]): void {
  useOverlayStore.getState().showContextMenu({ x: e.clientX, y: e.clientY, items });
}

/** 单 React 树内的宿主（App 挂载）。 */
export function ContextMenuHost() {
  const req = useOverlayStore((s) => s.contextMenu);
  const dismiss = useOverlayStore((s) => s.dismissContextMenu);
  if (!req) return null;
  return <ContextMenuApp items={req.items} x={req.x} y={req.y} onDismiss={dismiss} />;
}
