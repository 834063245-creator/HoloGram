// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 页右侧「调谐控制台」：编辑选中信号源的连接配置 / 诊断 / 危险区。
// 状态展示与测试结果均按 provider 独立，切换信号源不会串台。

import type React from 'react';
import { isFactoryBaseUrl, type ConnectionProbe, type ProbeOutcome } from '../../../settings';
import { effortVendor, thinkingModesFor, type StoredThinking } from '../../../provider/thinking';
import type { ModelDescriptor, Protocol } from '../../../provider/types';
import { ModelSelector } from '../ModelSelector';
import { formatLatency, formatTestAt, providerStatus, STATUS_LABEL } from './status';
import { protocolLabel } from './protocol';

export type ProviderField = 'apiKey' | 'baseUrl' | 'model' | 'thinking';

/** 连接探针的 UI 阶段（瞬时态，不持久化）；结果本体见 ConnectionProbe。 */
export type ProbeUiPhase = 'idle' | 'testing' | ProbeOutcome;

export interface ProbeUiState {
  phase: ProbeUiPhase;
  msg: string;
}

interface ProviderDetailProps {
  provider: {
    name: string;
    kind: Protocol;
    apiKey: string;
    baseUrl: string;
    model: string;
    thinking?: StoredThinking;
    lastTest?: ConnectionProbe;
  };
  isCurrent: boolean;
  canDelete: boolean;
  test: ProbeUiState;
  /** Key 栏 UI 状态簇：已保存 / 清除暂存 / 明文可见 / 输入框引用 */
  keyState: KeyUiState;
  /** 控制台全部回调簇 */
  actions: ProviderDetailActions;
}

/** Key 栏 UI 状态簇（本地暂存，非持久化配置） */
export interface KeyUiState {
  /** 当前 Key 是否已保存在系统凭据（未在本会话内改动） */
  saved: boolean;
  /** 该 provider 是否有「清除 Key」暂存（保存时才删凭据） */
  pendingClear: boolean;
  /** Key 是否明文显示 */
  visible: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

/** 控制台回调簇：所有动作统一经此 seam 注入，便于测试与复用 */
export interface ProviderDetailActions {
  onFieldChange: (field: ProviderField, value: string) => void;
  onModelChange: (modelId: string, desc?: ModelDescriptor) => void;
  onRefreshModels: () => Promise<number>;
  onTest: () => void;
  onSetCurrent: () => void;
  onClearKey: () => void;
  onResetBaseUrl: () => void;
  onToggleKeyVisible: () => void;
  onDelete: () => void;
}

export function ProviderDetail({
  provider,
  isCurrent,
  canDelete,
  test,
  keyState,
  actions,
}: ProviderDetailProps) {
  const {
    saved: keySaved,
    pendingClear,
    visible: keyVisible,
    inputRef: keyInputRef,
  } = keyState;
  const {
    onFieldChange,
    onModelChange,
    onRefreshModels,
    onTest,
    onSetCurrent,
    onClearKey,
    onResetBaseUrl,
    onToggleKeyVisible,
    onDelete,
  } = actions;
  const st = providerStatus(provider);
  const statusCls = test.phase === 'testing' ? 'testing' : st;
  const statusLabel = test.phase === 'testing' ? '测试中…' : STATUS_LABEL[st];
  const thinkingModes = thinkingModesFor(provider.kind, provider.name, provider.baseUrl, provider.model);
  const effortProfile = effortVendor(provider.name, provider.kind, provider.baseUrl, provider.model);
  const thinkingHint =
    effortProfile === 'deepseek'
      ? 'DeepSeek V4 支持 高/极限 两档；低/中 服务端会按高处理，故不提供。'
      : effortProfile === 'openai'
        ? 'OpenAI 官方支持 低/中/高；「极限」将按 高 发送。'
        : '等级越高思考越深，也更费 token。与 Agent 页的「深度思考」开关互为补充。';
  const isFactoryUrl = isFactoryBaseUrl(provider.baseUrl);

  const keyChip = provider.apiKey?.trim()
    ? keySaved
      ? '已保存到系统凭据'
      : '未保存 · 保存后写入'
    : pendingClear
      ? '清除待保存生效'
      : '未设置';
  const keyChipCls = provider.apiKey?.trim() ? (keySaved ? '' : ' unsaved') : ' clear';

  const testBlock =
    test.phase === 'ok' ? (
      <div className="pp-test-result ok">✓ 连接成功{test.msg && <span className="pp-tr-sub"> · {test.msg}</span>}</div>
    ) : test.phase === 'fail' ? (
      <div className="pp-test-result fail">
        ✕ 连接失败
        {test.msg && (
          <>
            <br />
            <span className="pp-tr-sub">{test.msg}</span>
          </>
        )}
      </div>
    ) : null;

  return (
    <section className="pp-console">
      <div className="pp-console-head">
        <span className="pp-name">{provider.name}</span>
        <span className={`pp-badge pp-badge-${provider.kind}`}>{protocolLabel(provider.kind)}</span>
        <span className={`pp-status-pill pp-pill-${statusCls}`}>
          <i className="pp-pdot" />
          {statusLabel}
        </span>
        {isCurrent && <span className="pp-badge pp-badge-current">当前使用</span>}
        <span className="pp-spacer" />
        <button
          type="button"
          className="pp-btn-set-current"
          disabled={isCurrent}
          title={isCurrent ? '该信号源正在被 Agent 使用' : '切换为当前使用中的 Provider'}
          onClick={onSetCurrent}
        >
          {isCurrent ? '已在用' : '设为当前'}
        </button>
      </div>

      <div className="pp-card">
        <div className="pp-card-hd">
          <span className="pp-card-title">连接配置</span>
          <span className="pp-rule" />
        </div>

        <div className="pp-field">
          <div className="pp-f-label-row">
            <label className="pp-f-label">API Key</label>
            <span className={`pp-chip${keyChipCls}`}>{keyChip}</span>
          </div>
          <div className="pp-key-row">
            <input
              ref={keyInputRef}
              type={keyVisible ? 'text' : 'password'}
              className="sp-input"
              value={provider.apiKey || ''}
              onChange={(e) => onFieldChange('apiKey', e.target.value)}
              onBlur={(e) => {
                e.target.value = e.target.value.replace(/[^\x00-\x7F]/g, '');
              }}
              placeholder="sk-… 粘贴后保存写入系统凭据"
              autoComplete="off"
            />
            <button type="button" className="sp-btn-sm" title={keyVisible ? '隐藏' : '显示'} onClick={onToggleKeyVisible}>
              {keyVisible ? '隐藏' : '显示'}
            </button>
            {provider.apiKey?.trim() && keySaved && (
              <button type="button" className="sp-btn-sm pp-btn-danger" title="从系统凭据中删除该 Key" onClick={onClearKey}>
                清除
              </button>
            )}
          </div>
          <div className="pp-f-hint">Key 只保存在本机系统加密凭据中，不会写入 localStorage。</div>
        </div>

        <div className="pp-field">
          <div className="pp-f-label-row">
            <label className="pp-f-label">模型</label>
          </div>
          <ModelSelector
            value={provider.model}
            providerName={provider.name}
            kind={provider.kind}
            onRefreshModels={onRefreshModels}
            onChange={onModelChange}
          />
        </div>

        <div className="pp-field">
          <div className="pp-f-label-row">
            <label className="pp-f-label">Base URL</label>
            <button
              type="button"
              className="sp-btn-sm"
              title={isFactoryUrl ? '当前已是默认地址' : '恢复出厂默认地址'}
              disabled={isFactoryUrl}
              onClick={onResetBaseUrl}
            >
              ↺ 默认
            </button>
          </div>
          <input
            className="sp-input"
            value={provider.baseUrl}
            onChange={(e) => onFieldChange('baseUrl', e.target.value)}
            onBlur={(e) => {
              e.target.value = e.target.value.replace(/[^\x00-\x7F]/g, '');
            }}
            placeholder="https://…/v1"
            autoComplete="off"
          />
        </div>

        {thinkingModes.length > 0 && (
          <div className="pp-field">
            <div className="pp-f-label-row">
              <label className="pp-f-label">思考努力等级</label>
            </div>
            <select
              className="sp-select"
              value={
                thinkingModes.some((o) => o.value === (provider.thinking || ''))
                  ? provider.thinking || ''
                  : ''
              }
              onChange={(e) => onFieldChange('thinking', e.target.value)}
            >
              {thinkingModes.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="pp-f-hint">{thinkingHint}</div>
          </div>
        )}
      </div>

      <div className="pp-card">
        <div className="pp-card-hd">
          <span className="pp-card-title">诊断</span>
          <span className="pp-rule" />
        </div>
        <div className="pp-test-row">
          <button
            type="button"
            className={`pp-btn-test${test.phase === 'testing' ? ' testing' : ''}`}
            disabled={test.phase === 'testing'}
            onClick={onTest}
          >
            {test.phase === 'testing' ? <span className="pp-spin" /> : '⟳ '}测试连接
          </button>
          {testBlock}
        </div>
        <div className="pp-f-hint">发送一次最小请求（1 token），验证 Key / Base URL / 模型三者可用。结果按信号源保存。</div>
        {provider.lastTest && (
          <div className="pp-test-last">
            上次测试：
            {provider.lastTest.status === 'ok'
              ? `成功 · ${formatLatency(provider.lastTest.latencyMs)}`
              : `失败${provider.lastTest.message ? ` · ${provider.lastTest.message}` : ''}`}
            {' '}
            · {formatTestAt(provider.lastTest.at)}
          </div>
        )}
      </div>

      {canDelete && (
        <div className="pp-card pp-danger-card">
          <div className="pp-card-hd">
            <span className="pp-card-title">危险区</span>
            <span className="pp-rule" />
          </div>
          <button type="button" className="sp-btn-sm pp-btn-danger" onClick={onDelete}>
            删除信号源 {provider.name}…
          </button>
          <div className="pp-f-hint">删除后系统凭据一并移除（保存后生效），不可恢复。</div>
        </div>
      )}
    </section>
  );
}
