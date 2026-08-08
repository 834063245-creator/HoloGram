// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSelector — 可搜索的下拉组合框，用于从目录中选择模型。
// 支持自由输入目录中不存在的自定义模型名称。
// 从 API 动态获取的模型会标记 "live" 徽章。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDynamicModelCount, getModel, searchModels } from '../../provider/catalog';
import type { ModelDescriptor, Protocol } from '../../provider/types';
import { iconHtml } from '../icons';

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string, desc?: ModelDescriptor) => void;
  /** 当前 provider 名称 — 来自该 provider 的模型优先排序。 */
  providerName: string;
  /** Provider 类型 — 按匹配的 API 协议过滤目录。 */
  kind: Protocol;
  /** 可选：从 provider 的 API 获取模型并合并到目录中。 */
  onRefreshModels?: () => Promise<number>;
}

function hasMetadata(m: ModelDescriptor): boolean {
  return m.cost.input > 0 || m.contextWindow > 0;
}

export function ModelSelector({ value, onChange, providerName, kind, onRefreshModels }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');
  const [dynamicCount, setDynamicCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!open) return [];
    const q = query.toLowerCase().trim();
    const all = q ? searchModels(q) : searchModels('');
    return all
      .filter((m) => m.kind === kind)
      .sort((a, b) => {
        const aMatch = a.vendor === providerName ? 0 : 1;
        const bMatch = b.vendor === providerName ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return a.id.localeCompare(b.id);
      })
      .slice(0, 30);
  }, [open, query, kind, providerName]);

  const selectedDesc = useMemo(() => getModel(value), [value]);

  const handleRefresh = useCallback(async () => {
    if (!onRefreshModels || refreshing) return;
    setRefreshing(true);
    setRefreshMsg('');
    try {
      const count = await onRefreshModels();
      setDynamicCount(getDynamicModelCount(providerName));
      setRefreshMsg(count > 0 ? `已发现 ${count} 个模型` : '未获取到新模型');
    } catch (e: any) {
      // 无 Key / 网络失败等真实原因透出，避免「未获取到新模型」误导
      setRefreshMsg(e?.message || String(e) || '获取失败');
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(''), 3000);
    }
  }, [onRefreshModels, refreshing, providerName]);

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
    <div className={`ms-container${open ? ' ms-open' : ''}`} ref={containerRef}>
      <div className="ms-input-row">
        <div className="ms-input-wrap">
          <span className="ms-input-icon" dangerouslySetInnerHTML={{ __html: iconHtml('search', 12) }} />
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
              onChange(e.target.value);
            }}
            onKeyDown={handleKeyDown}
          />
          {value && !open && (
            <span
              className="ms-input-clear"
              title="清除"
              onClick={() => onChange('')}
              dangerouslySetInnerHTML={{ __html: iconHtml('close', 10) }}
            />
          )}
        </div>
        {onRefreshModels && (
          <button
            type="button"
            className={`ms-refresh-btn${refreshing ? ' spinning' : ''}`}
            title="从 API 获取模型列表"
            onClick={handleRefresh}
            dangerouslySetInnerHTML={{
              __html: iconHtml(refreshing ? 'loading' : 'refresh', 13),
            }}
          />
        )}
      </div>
      {refreshMsg && <div className="ms-refresh-msg">{refreshMsg}</div>}
      {open && results.length > 0 && (
        <div className="ms-dropdown" ref={listRef}>
          {results.map((m, i) => {
            const isDynamic = !hasMetadata(m);
            return (
              <button
                type="button"
                key={m.id}
                className={`ms-item${i === activeIdx ? ' active' : ''}${m.id === value ? ' selected' : ''}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => handleSelect(m)}
              >
                <div className="ms-item-main">
                  <div className="ms-item-id-row">
                    <span className="ms-item-id">{m.id}</span>
                    {isDynamic && <span className="ms-badge-live">LIVE</span>}
                    {m.id === value && (
                      <span className="ms-item-check" dangerouslySetInnerHTML={{ __html: iconHtml('check', 11) }} />
                    )}
                  </div>
                  {m.name !== m.id && <span className="ms-item-name">{m.name}</span>}
                </div>
                <div className="ms-item-badges">
                  {m.reasoning && (
                    <span className="ms-badge ms-badge-reason" title="支持推理/思考">
                      🧠
                    </span>
                  )}
                  {m.contextWindow > 0 && (
                    <span className="ms-badge ms-badge-ctx" title="上下文窗口">
                      {(m.contextWindow / 1000).toFixed(0)}k
                    </span>
                  )}
                  {m.cost.input > 0 && (
                    <span className="ms-badge ms-badge-cost" title="每 1M token 价格">
                      ${m.cost.input}/${m.cost.output}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {open && results.length === 0 && (
        <div className="ms-dropdown ms-empty">
          <span className="ms-empty-text">{query ? `无匹配模型「${query}」` : '目录为空，点击刷新从 API 获取'}</span>
        </div>
      )}
      {selectedDesc && !open && (
        <div className="ms-meta">
          {selectedDesc.reasoning && <span className="ms-meta-tag ms-meta-reason">推理</span>}
          {selectedDesc.contextWindow > 0 && (
            <span className="ms-meta-tag">{(selectedDesc.contextWindow / 1000).toFixed(0)}k 上下文</span>
          )}
          {selectedDesc.cost.input > 0 && (
            <>
              <span className="ms-meta-tag">输入 ${selectedDesc.cost.input}/M</span>
              <span className="ms-meta-tag">输出 ${selectedDesc.cost.output}/M</span>
              {selectedDesc.cost.cacheRead > 0 && (
                <span className="ms-meta-tag">缓存 ${selectedDesc.cost.cacheRead}/M</span>
              )}
            </>
          )}
          {!hasMetadata(selectedDesc) && <span className="ms-meta-tag ms-meta-live">来自 API</span>}
        </div>
      )}
    </div>
  );
}
