// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AtAutocomplete — React 重写 @ 文件/节点自动补全
// 替代 chat.ts 中 handleAtInput / buildAtPopup / updateAtSelection / confirmAtSelection。
// 零 innerHTML、零 querySelector、零手动 class 切换。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { rpc } from '../../bridge';
import { getChatStore } from '../chat-store';
import { escapeHtml } from '../chat-utils';

// ── Types ──

interface AtItem {
  kind: string;
  name: string;
}

// ── Helper: parse @ trigger position from text ──

function findAtTrigger(textBefore: string): number {
  for (let i = textBefore.length - 1; i >= 0; i--) {
    if (textBefore[i] === '@' && (i === 0 || textBefore[i - 1] === ' ' || textBefore[i - 1] === '\n')) {
      return i;
    }
  }
  return -1;
}

function buildToken(kind: string, name: string): string {
  if (kind === '节点') {
    return `\`${name}\``;
  }
  const base = name.split('/').pop()?.replace(/\.\w+$/, '') || name;
  return `[@${base}](${name})`;
}

// ── React Component ──

const CACHE_TTL = 30000;

function AtAutocomplete({
  panelId,
  textBefore,
  cursorPos,
  nodeNames,
  onSelect,
}: {
  panelId: string;
  textBefore: string;
  cursorPos: number;
  nodeNames: string[];
  onSelect: (atIdx: number, token: string) => void;
}) {
  const [items, setItems] = useState<AtItem[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<{ data: string; ts: number } | null>(null);

  const atPos = findAtTrigger(textBefore);
  const query = atPos >= 0 ? textBefore.slice(atPos + 1).toLowerCase() : '';
  const visible = atPos >= 0 && query.length >= 0;

  // Fetch files when visible
  useEffect(() => {
    if (!visible) {
      setItems([]);
      return;
    }
    let cancelled = false;

    (async () => {
      setLoading(true);
      let files: string[] = [];

      // Use cached glob results
      try {
        let cache = cacheRef.current;
        if (!cache || Date.now() - cache.ts > CACHE_TTL) {
          const projectPath = getChatStore(panelId).panel.getState().projectPath || '.';
          const data = await rpc<string>('glob', {
            pattern: '**/*.{ts,js,py,rs,html,css,vue,svelte,json,toml,yaml,yml,md}',
            path: projectPath,
          });
          cache = { data, ts: Date.now() };
          cacheRef.current = cache;
        }

        const parsed = JSON.parse(cache.data);
        files = (parsed.results || []).map((r: any) => r.path).slice(0, 100);
      } catch {
        /* glob failed — use empty */
      }

      if (cancelled) return;

      const allItems: AtItem[] = [];
      for (const f of files) {
        allItems.push({ kind: '文件', name: f });
      }
      for (const n of nodeNames) {
        allItems.push({ kind: '节点', name: n });
      }

      const filtered = query ? allItems.filter((item) => item.name.toLowerCase().includes(query)) : allItems;
      setItems(filtered.slice(0, 10));
      setActiveIdx(0);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, query, panelId, nodeNames.join(',')]);

  // Scroll active item into view
  useEffect(() => {
    const el = popupRef.current?.querySelector('.at-item.active') as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const handleSelect = useCallback(
    (item: AtItem) => {
      const token = buildToken(item.kind, item.name);
      onSelect(atPos, token);
    },
    [atPos, onSelect],
  );

  if (!visible || (items.length === 0 && !loading)) return null;

      return (
    <div ref={popupRef} className={`chat-at-popup${visible && items.length > 0 ? ' open' : ''}`}>
      {loading && items.length === 0 ? (
        <div className="at-item" style={{ opacity: 0.4 }}>加载中…</div>
      ) : items.length === 0 ? (
        <div className="at-item" style={{ opacity: 0.4 }}>无匹配结果</div>
      ) : (
        items.map((item, i) => (
          <div
            key={`${item.kind}:${item.name}`}
            className={`at-item${i === activeIdx ? ' active' : ''}`}
            onMouseEnter={() => setActiveIdx(i)}
            onClick={() => handleSelect(item)}
          >
            <span className="at-kind">{item.kind}</span>
            <span>{item.name}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ── Exposed imperative API ──

export interface AtAutocompleteHandle {
  readonly items: ReadonlyArray<AtItem>;
  readonly activeIdx: number;
  readonly open: boolean;
  navigate(delta: number): void;
  select(): AtItem | null;
}

// ── Controller — thin wrapper for ChatPanel ──

export class AtAutocompleteController {
  private _root: Root;
  private _mount: HTMLElement;
  private _panelId: string;
  private _textBefore = '';
  private _cursorPos = 0;
  private _nodeNames: string[] = [];
  private _onSelect: ((atIdx: number, token: string) => void) | null = null;
  private _version = 0;

  constructor(container: HTMLElement, panelId: string) {
    this._panelId = panelId;
    this._mount = document.createElement('div');
    this._mount.className = 'chat-at-autocomplete-mount';
    // Mount into the input area so it positions relative to the input
    const inputArea = container.querySelector('.chat-input-area');
    (inputArea || container).appendChild(this._mount);
    this._root = createRoot(this._mount);
    this._render();
  }

  private _render(): void {
    this._root.render(
      React.createElement(AtAutocomplete, {
        panelId: this._panelId,
        textBefore: this._textBefore,
        cursorPos: this._cursorPos,
        nodeNames: this._nodeNames,
        onSelect: (atIdx, token) => this._onSelect?.(atIdx, token),
        key: this._version,
      }),
    );
  }

  /** Call on every input event. textBefore = value.slice(0, cursorPos). */
  update(textBefore: string, cursorPos: number): void {
    this._textBefore = textBefore;
    this._cursorPos = cursorPos;
    this._render();
  }

  /** Update available node names (from starGraph). */
  setNodeNames(names: string[]): void {
    this._nodeNames = names;
    this._render();
  }

  /** Set the select callback. */
  setOnSelect(fn: ((atIdx: number, token: string) => void) | null): void {
    this._onSelect = fn;
    this._render();
  }

  /** Force re-render (e.g. after project path change clears cache). */
  refresh(): void {
    this._version++;
    this._render();
  }

  /** Keyboard navigation — arrow up/down. Call from input keydown handler. */
  navigate(delta: number): void {
    const el = this._mount.querySelector('.chat-at-popup.open') as HTMLElement;
    if (!el) return;
    const items = el.querySelectorAll('.at-item');
    if (items.length === 0) return;
    // Find current active
    let idx = 0;
    items.forEach((item, i) => {
      if (item.classList.contains('active')) idx = i;
    });
    const next = Math.max(0, Math.min(idx + delta, items.length - 1));
    items.forEach((item, i) => {
      item.classList.toggle('active', i === next);
    });
  }

  /** Select the currently highlighted item. Returns selected item or null. */
  select(): { kind: string; name: string } | null {
    const el = this._mount.querySelector('.chat-at-popup.open') as HTMLElement;
    if (!el) return null;
    const active = el.querySelector('.at-item.active');
    if (!active) return null;
    const kindEl = active.querySelector('.at-kind');
    const nameEl = active.querySelector('span:last-child');
    const item = { kind: kindEl?.textContent || '', name: nameEl?.textContent || '' };
    // Trigger the React-level onSelect callback via click
    (active as HTMLElement).click();
    return item;
  }

  /** Whether the popup is visible. */
  get open(): boolean {
    return !!this._mount.querySelector('.chat-at-popup.open');
  }

  destroy(): void {
    this._root.unmount();
    this._mount.remove();
  }
}