// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Shared right-click context menu — used by FileTree, GitPanel, etc.
// Styled to match the HUD dark-space aesthetic.

export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  separator?: boolean; // render a divider before this item
}

let _activeMenu: HTMLElement | null = null;
let _activeCleanup: (() => void) | null = null;

function dismiss(): void {
  if (_activeCleanup) { _activeCleanup(); _activeCleanup = null; }
  if (_activeMenu) {
    _activeMenu.remove();
    _activeMenu = null;
  }
}

export function showContextMenu(e: MouseEvent, items: ContextMenuItem[]): void {
  dismiss();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  Object.assign(menu.style, {
    position: 'fixed', zIndex: '200',
    background: 'var(--panel-bg, rgba(4,12,28,0.96))',
    backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(60,100,180,0.3)',
    borderRadius: '6px',
    padding: '4px',
    minWidth: '160px',
    boxShadow: '0 0 0 1px rgba(60,100,180,0.05), 0 12px 36px rgba(0,0,0,0.5)',
    fontFamily: 'var(--font-mono)', fontSize: 'calc(11px * var(--font-scale))',
    display: 'flex', flexDirection: 'column',
  });

  // Position: ensure menu stays within viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = e.clientX, y = e.clientY;
  if (x + 180 > vw) x = vw - 185;
  if (y + items.length * 28 + 20 > vh) y = vh - items.length * 28 - 25;
  menu.style.left = `${Math.max(2, x)}px`;
  menu.style.top = `${Math.max(2, y)}px`;

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:rgba(60,100,180,0.15);margin:3px 6px;';
      menu.appendChild(sep);
    }
    const row = document.createElement('div');
    row.textContent = item.label;
    Object.assign(row.style, {
      padding: '5px 10px', borderRadius: '3px',
      cursor: item.disabled ? 'default' : 'pointer',
      color: item.disabled ? 'var(--text-muted, rgba(120,145,170,0.35))' : 'var(--starlight-dim, #c3daf8)',
      whiteSpace: 'nowrap', userSelect: 'none',
    });
    row.addEventListener('mouseenter', () => {
      if (!item.disabled) {
        row.style.background = 'rgba(22,36,54,0.7)';
        row.style.color = 'var(--starlight, #e2edff)';
      }
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = '';
      row.style.color = item.disabled ? 'var(--text-muted, rgba(120,145,170,0.35))' : 'var(--starlight-dim, #c3daf8)';
    });
    if (!item.disabled) {
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismiss();
        item.action();
      });
    }
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  _activeMenu = menu;

  // Dismiss on outside click / Escape
  const onDown = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) { dismiss(); }
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { dismiss(); }
  };
  const cleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
  };
  _activeCleanup = cleanup;
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
  }, 0);
}
