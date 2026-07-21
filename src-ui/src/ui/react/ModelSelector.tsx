// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSelector — searchable combobox for picking models from the catalog.
// Supports free text input for custom models not in the catalog.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getModel, searchModels } from '../../provider/catalog';
import type { ModelDescriptor } from '../../provider/types';

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string, desc?: ModelDescriptor) => void;
  /** Current provider name — models from this provider are sorted first. */
  providerName: string;
  /** Provider kind — filters catalog to matching API protocol. */
  kind: 'anthropic' | 'openai';
}

export function ModelSelector({ value, onChange, providerName, kind }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!open) return [];
    const q = query.toLowerCase().trim();
    // Search all models, then sort: current provider first, then by id
    const all = q ? searchModels(q) : searchModels('');
    return all
      .filter((m) => m.kind === kind)
      .sort((a, b) => {
        const aMatch = a.provider === providerName ? 0 : 1;
        const bMatch = b.provider === providerName ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return a.id.localeCompare(b.id);
      })
      .slice(0, 30);
  }, [open, query, kind, providerName]);

  const selectedDesc = useMemo(() => getModel(value), [value]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIdx(0);
  }, []);

  const handleSelect = useCallback(
    (desc: ModelDescriptor) => {
      onChange(desc.id, desc);
      close();
    },
    [onChange, close],
  );

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector('.ms-item.active') as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && open && results[activeIdx]) {
      e.preventDefault();
      handleSelect(results[activeIdx]);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  return (
    <div className="ms-container" ref={containerRef}>
      <input
        type="text"
        className="sp-input ms-input"
        value={open ? query : value}
        placeholder="搜索模型或输入名称…"
        onFocus={() => {
          setOpen(true);
          setQuery(value);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
          setActiveIdx(0);
          // Live-update the value as user types
          onChange(e.target.value);
        }}
        onKeyDown={handleKeyDown}
      />
      {open && results.length > 0 && (
        <div className="ms-dropdown" ref={listRef}>
          {results.map((m, i) => (
            <button
              type="button"
              key={m.id}
              className={`ms-item${i === activeIdx ? ' active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => handleSelect(m)}
            >
              <div className="ms-item-main">
                <span className="ms-item-id">{m.id}</span>
                <span className="ms-item-name">{m.name}</span>
              </div>
              <div className="ms-item-badges">
                {m.reasoning && (
                  <span className="ms-badge ms-badge-reason" title="支持推理/思考">
                    🧠
                  </span>
                )}
                <span className="ms-badge ms-badge-ctx" title="上下文窗口">
                  {(m.contextWindow / 1000).toFixed(0)}k
                </span>
                <span className="ms-badge ms-badge-cost" title="每 1M token 价格">
                  ${m.cost.input}/${m.cost.output}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
      {selectedDesc && (
        <div className="ms-meta">
          {selectedDesc.reasoning && <span className="ms-meta-tag ms-meta-reason">推理</span>}
          <span className="ms-meta-tag">{(selectedDesc.contextWindow / 1000).toFixed(0)}k 上下文</span>
          <span className="ms-meta-tag">输入 ${selectedDesc.cost.input}/M</span>
          <span className="ms-meta-tag">输出 ${selectedDesc.cost.output}/M</span>
          {selectedDesc.cost.cacheRead > 0 && (
            <span className="ms-meta-tag">缓存 ${selectedDesc.cost.cacheRead}/M</span>
          )}
        </div>
      )}
    </div>
  );
}
