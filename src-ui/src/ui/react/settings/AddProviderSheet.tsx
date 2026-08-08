// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 添加信号源弹层：目录 chips 一键添加（name/kind/baseUrl/model 全带出），
// 或展开自定义表单手动配置。校验在本地完成，父组件只负责落 state。

import { useEffect, useState } from 'react';
import { getCatalogProviders, getDefaultModel } from '../../../provider/catalog';
import type { Protocol } from '../../../provider/types';
import { protocolLabel } from './protocol';

export interface AddProviderEntry {
  name: string;
  kind: Protocol;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface AddProviderSheetProps {
  open: boolean;
  existingNames: string[];
  onClose: () => void;
  onAdd: (entry: AddProviderEntry) => void;
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function AddProviderSheet({ open, existingNames, onClose, onAdd }: AddProviderSheetProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Protocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      setKind('openai');
      setBaseUrl('');
      setModel('');
      setKey('');
      setError('');
    }
  }, [open]);

  if (!open) return null;

  const handleCustomAdd = () => {
    const n = name.trim();
    if (!n) {
      setError('名称不能为空');
      return;
    }
    if (!NAME_RE.test(n)) {
      setError('名称只能包含字母、数字、下划线和连字符');
      return;
    }
    if (existingNames.includes(n)) {
      setError(`Provider「${n}」已存在`);
      return;
    }
    onAdd({
      name: n,
      kind,
      apiKey: key.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      model: model.trim() || undefined,
    });
  };

  return (
    <div
      className="cd-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cd-sheet pp-add-sheet" role="dialog" aria-modal="true">
        <div className="cd-hd">
          <span className="cd-title">添加信号源</span>
          <button type="button" className="cd-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <div className="pp-sheet-note">
          从目录一键添加，或手动配置自定义端点。添加后成为「已配置待测试」状态，保存后生效。
        </div>

        <div className="pp-cat-grid">
          {getCatalogProviders().map((provName) => {
            const defaultModel = getDefaultModel(provName);
            if (!defaultModel) return null;
            const used = existingNames.includes(provName);
            return (
              <button
                type="button"
                key={provName}
                className={`pp-cat-chip${used ? ' used' : ''}`}
                title={
                  used
                    ? `${provName} 已存在`
                    : `${defaultModel.name} · ${defaultModel.baseUrl}`
                }
                disabled={used}
                onClick={() =>
                  onAdd({
                    name: provName,
                    kind: defaultModel.kind,
                    baseUrl: defaultModel.baseUrl,
                    model: defaultModel.id,
                  })
                }
              >
                <div className="pp-cat-name">{provName}</div>
                <div className="pp-cat-model">{defaultModel.id}</div>
                <div className="pp-cat-kind">{protocolLabel(defaultModel.kind)}</div>
              </button>
            );
          })}
        </div>

        <div className="pp-sheet-divider">
          <span>或自定义</span>
        </div>

        <div className="pp-form-grid">
          <div className="pp-fg">
            <label>名称（唯一标识，创建后不可修改）</label>
            <input
              className="sp-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 my-gateway"
              autoComplete="off"
            />
          </div>
          <div className="pp-fg">
            <label>协议</label>
            <select className="sp-select" value={kind} onChange={(e) => setKind(e.target.value as any)}>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <div className="pp-fg">
            <label>Base URL</label>
            <input
              className="sp-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…/v1"
              autoComplete="off"
            />
          </div>
          <div className="pp-fg">
            <label>默认模型（可选）</label>
            <input
              className="sp-input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="留空则稍后选择"
              autoComplete="off"
            />
          </div>
          <div className="pp-fg">
            <label>API Key（可选）</label>
            <input
              type="password"
              className="sp-input"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
            />
          </div>
        </div>

        {error && <div className="pp-form-error">{error}</div>}

        <div className="cd-actions">
          <button type="button" className="sp-btn sp-btn-cancel" onClick={onClose}>
            取消
          </button>
          <button type="button" className="sp-btn sp-btn-save" onClick={handleCustomAdd}>
            确认添加
          </button>
        </div>
      </div>
    </div>
  );
}
