// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 聊天面板左下角模型切换器：不弹设置面板，直接在当前信号源内切模型、
// 切换其他信号源、调整思考强度。任何操作立即保存并触发 Agent 重建。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAllModels, getDefaultModel } from '../../provider/catalog';
import type { ModelDescriptor } from '../../provider/types';
import { DEEP_THINK_LABEL, THINKING_MODES, type StoredThinking } from '../../provider/thinking';
import {
  getActiveProvider,
  isFactoryBaseUrl,
  saveSettings,
  updateProvider,
  type AppSettings,
  type ProviderId,
} from '../../settings';
import { getOnSettingsSave } from '../dock-config';
import { iconHtml } from '../icons';
import { isAnthropic, protocolLabel } from './settings/protocol';

interface ModelSwitcherProps {
  settings: AppSettings;
  onOpenSettings: (() => void) | null;
}

export function ModelSwitcher({ settings, onOpenSettings }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const active = getActiveProvider(settings);
  const isAnthropicKind = isAnthropic(active.kind);
  const others = settings.providers.filter((p) => p.name !== settings.activeProvider);

  const currentModels = useMemo(
    () => getAllModels().filter((m) => m.provider === active.name).sort((a, b) => a.id.localeCompare(b.id)),
    [active.name],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** 立即落盘 + 触发 Agent 重建（与设置面板保存同一链路） */
  const apply = useCallback((next: AppSettings, keepOpen = false) => {
    saveSettings(next);
    getOnSettingsSave()?.();
    if (!keepOpen) setOpen(false);
  }, []);

  const selectModel = useCallback(
    (modelId: string, desc?: ModelDescriptor) => {
      let next = updateProvider(settings, active.name, { model: modelId });
      if (desc) {
        const p = next.providers.find((x) => x.name === active.name);
        if (p && (!p.baseUrl?.trim() || isFactoryBaseUrl(p.baseUrl))) {
          next = updateProvider(next, active.name, { baseUrl: desc.baseUrl });
        }
      }
      apply(next);
    },
    [settings, active.name, apply],
  );

  const switchProvider = useCallback(
    (name: ProviderId) => {
      let next: AppSettings = { ...settings, activeProvider: name };
      const p = next.providers.find((x) => x.name === name);
      if (p && !p.model?.trim()) {
        const def = getDefaultModel(name);
        if (def) next = updateProvider(next, name, { model: def.id, baseUrl: def.baseUrl });
      }
      apply(next);
    },
    [settings, apply],
  );

  const setThinking = useCallback(
    (v: StoredThinking) => apply(updateProvider(settings, active.name, { thinking: v }), true),
    [settings, active.name, apply],
  );

  const toggleDeepThink = useCallback(() => {
    apply(
      { ...settings, agent: { ...settings.agent, disableThinking: !settings.agent.disableThinking } },
      true,
    );
  }, [settings, apply]);

  let modelLabel = active?.model || 'unknown';
  if (modelLabel.length > 18) modelLabel = modelLabel.slice(0, 17) + '\u2026';
  const thinkingLabel = active?.thinking ? ' · 思考' : '';

  return (
    <div className="ms-wrap" ref={wrapRef}>
      <button
        className="chat-model-badge chat-model-clickable"
        title={`切换模型 · ${active?.name} / ${active?.model}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span dangerouslySetInnerHTML={{ __html: iconHtml('agent', 10) }} /> {modelLabel}
        {thinkingLabel}
      </button>

      {open && (
        <div className="ms-pop" role="menu">
          <div className="ms-pop-hd">
            <span className="ms-pop-src">{active.name}</span>
            <span className={`ms-pop-kind ms-pop-kind-${active.kind}`}>{protocolLabel(active.kind)}</span>
          </div>

          <div className="ms-pop-label">模型</div>
          {currentModels.length > 0 ? (
            <div className="ms-pop-list">
              {currentModels.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className={`ms-pop-item${m.id === active.model ? ' selected' : ''}`}
                  onClick={() => selectModel(m.id, m)}
                >
                  <span className="ms-pop-item-main">
                    <span className="ms-pop-item-id">{m.id}</span>
                    {m.name !== m.id && <span className="ms-pop-item-name">{m.name}</span>}
                  </span>
                  <span className="ms-pop-item-badges">
                    {m.reasoning && <span className="ms-pop-tag reason">推理</span>}
                    {m.contextWindow > 0 && (
                      <span className="ms-pop-tag ctx">{(m.contextWindow / 1000).toFixed(0)}k</span>
                    )}
                    {m.cost.input > 0 && (
                      <span className="ms-pop-tag">${m.cost.input}/${m.cost.output}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="ms-pop-empty">目录中暂无该信号源的模型，可在设置中手动填写</div>
          )}

          {others.length > 0 && (
            <>
              <div className="ms-pop-label">其他信号源</div>
              <div className="ms-pop-list">
                {others.map((p) => (
                  <button type="button" key={p.name} className="ms-pop-item" onClick={() => switchProvider(p.name)}>
                    <span className="ms-pop-item-main">
                      <span className="ms-pop-item-id">{p.name}</span>
                      <span className="ms-pop-item-name">
                        {protocolLabel(p.kind)}
                        {p.model ? ` · ${p.model}` : ''}
                      </span>
                    </span>
                    <span className="ms-pop-item-badges">
                      <span className="ms-pop-tag switch">切换</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="ms-pop-label">思考强度</div>
          <div className="ms-pop-thinking">
            {isAnthropicKind ? (
              <select
                className="ms-pop-select"
                value={active.thinking || ''}
                onChange={(e) => setThinking(e.target.value as StoredThinking)}
              >
                {THINKING_MODES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <label className="ms-pop-check">
                <input type="checkbox" checked={!settings.agent.disableThinking} onChange={toggleDeepThink} />
                {DEEP_THINK_LABEL}
              </label>
            )}
          </div>

          <div className="ms-pop-foot">
            <button
              type="button"
              className="ms-pop-manage"
              onClick={() => {
                setOpen(false);
                onOpenSettings?.();
              }}
            >
              ⚙ 管理 Provider…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
