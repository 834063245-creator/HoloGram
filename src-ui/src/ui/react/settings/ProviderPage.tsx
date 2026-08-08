// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 标签页（信号源控制台）：
// 左侧 ProviderList 选信号源，右侧 ProviderDetail 编辑；
// 添加/删除/清除 Key 均为「暂存」，保存时统一落盘 + 写/删凭据 + 重建 Agent。

import { useCallback, useEffect, useRef, useState } from 'react';
import { createProvider } from '../../../provider';
import { mergeDynamicModels } from '../../../provider/catalog';
import { ChunkType, type ModelDescriptor } from '../../../provider/types';
import {
  addProvider,
  defaultBaseUrl,
  getActiveProvider,
  isFactoryBaseUrl,
  removeProvider,
  type AppSettings,
  type ProviderSettings,
  type ProviderTestResult,
  updateProvider,
} from '../../../settings';
import { AddProviderSheet, type AddProviderEntry } from './AddProviderSheet';
import { ConfirmDialog } from './ConfirmDialog';
import { ProviderDetail, type ProviderField, type TestUiState } from './ProviderDetail';
import { ProviderList } from './ProviderList';
import { formatLatency } from './status';

interface ProviderPageProps {
  settings: AppSettings;
  /** Provider 变更只进 state 并标 providerDirty（与全局保存互不牵连） */
  onCommitProvider: (next: AppSettings) => void;
  /** 立即落盘但不标 dirty（如测试结果，非配置变更） */
  onPersistSettings: (next: AppSettings) => void;
  /** 暂存「删除 Provider」——保存时才删系统凭据，取消不丢 Key */
  onStageDelete: (name: string) => void;
  /** 暂存「清除 Key」——保存时才删系统凭据 */
  onStageClear: (name: string) => void;
  onUnstageClear: (name: string) => void;
  pendingClears: string[];
  /** 保存成功后自增——用于把「未保存 Key」标记复位为「已保存」 */
  saveVersion: number;
  providerDirty: boolean;
  /** Provider 页独立保存（落盘 + 凭据 + 重建 Agent） */
  onSaveProviders: () => void;
}

export function ProviderPage({
  settings,
  onCommitProvider,
  onPersistSettings,
  onStageDelete,
  onStageClear,
  onUnstageClear,
  pendingClears,
  saveVersion,
  providerDirty,
  onSaveProviders,
}: ProviderPageProps) {
  const [selected, setSelected] = useState(() => getActiveProvider(settings).name);
  const [keyDirtyMap, setKeyDirtyMap] = useState<Record<string, boolean>>({});
  const [keyVisibleMap, setKeyVisibleMap] = useState<Record<string, boolean>>({});
  const [tests, setTests] = useState<Record<string, TestUiState>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<string | null>(null);
  const [clearTarget, setClearTarget] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const keyInputRef = useRef<HTMLInputElement | null>(null);

  // 异步回调（测试连接）完成时读取最新 settings，避免覆盖并发编辑
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const activeProvider = getActiveProvider(settings);
  const selectedProvider = settings.providers.find((p) => p.name === selected) ?? activeProvider;

  const requestFocusKey = useCallback(() => setFocusNonce((n) => n + 1), []);

  // 选中项失效（被删除/切换）时回落到当前 Provider
  useEffect(() => {
    if (!settings.providers.some((p) => p.name === selected)) {
      setSelected(settings.activeProvider);
    }
  }, [settings, selected]);

  useEffect(() => {
    if (focusNonce > 0) keyInputRef.current?.focus();
  }, [focusNonce]);

  // 保存成功后：所有 Key 均视为已落凭据库
  useEffect(() => {
    setKeyDirtyMap({});
  }, [saveVersion]);

  const handleFieldChange = useCallback(
    (name: string, field: ProviderField, value: string) => {
      if (field === 'apiKey') {
        if (value.trim()) {
          onUnstageClear(name); // 输入新 Key = 替换，不再是清除
        } else {
          onStageClear(name); // 手动清空输入框 = 也要真正删除凭据，否则保存后 Key 会「复活」
        }
        setKeyDirtyMap((m) => ({ ...m, [name]: true }));
      }
      const patch = { [field]: value } as Partial<ProviderSettings>;
      onCommitProvider(updateProvider(settings, name, patch));
    },
    [settings, onCommitProvider, onStageClear, onUnstageClear],
  );

  const handleModelChange = useCallback(
    (name: string, modelId: string, desc?: ModelDescriptor) => {
      let next = updateProvider(settings, name, { model: modelId });
      if (desc) {
        const p = next.providers.find((x) => x.name === name);
        if (p && (!p.baseUrl?.trim() || isFactoryBaseUrl(p.baseUrl))) {
          next = updateProvider(next, name, { baseUrl: desc.baseUrl });
        }
      }
      onCommitProvider(next);
    },
    [settings, onCommitProvider],
  );

  const handleRefreshModels = useCallback(async (): Promise<number> => {
    const p = selectedProvider;
    if (!p.apiKey?.trim()) throw new Error('请先填写 API Key');
    const prov = createProvider(p);
    const models = (await prov.fetchModels?.()) ?? [];
    if (models.length > 0) mergeDynamicModels(p.name, models);
    return models.length;
  }, [selectedProvider]);

  const handleTest = useCallback(async () => {
    const name = selectedProvider.name;
    if (!selectedProvider.apiKey?.trim()) {
      setTests((t) => ({ ...t, [name]: { phase: 'fail', msg: '请先填写 API Key' } }));
      return;
    }
    if (!selectedProvider.model?.trim()) {
      setTests((t) => ({ ...t, [name]: { phase: 'fail', msg: '请先填写模型名称' } }));
      return;
    }
    setTests((t) => ({ ...t, [name]: { phase: 'testing', msg: '' } }));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const started = performance.now();
    try {
      const prov = createProvider(selectedProvider, { disableThinking: true });
      const gen = prov.stream(ctrl.signal, {
        messages: [{ role: 'user', content: 'ping' }],
        tools: [],
        temperature: 0,
        max_tokens: 1,
      });
      let received = false;
      for await (const chunk of gen) {
        if (chunk.type === ChunkType.Error) throw chunk.err ?? new Error('流错误');
        if (chunk.type === ChunkType.Text && chunk.text) {
          received = true;
          break;
        }
      }
      const latencyMs = Math.round(performance.now() - started);
      const msg = received ? formatLatency(latencyMs) : '连接成功（无文本返回，请检查模型行为）';
      const result: ProviderTestResult = { status: 'ok', latencyMs, at: Date.now(), message: msg };
      onPersistSettings(updateProvider(settingsRef.current, name, { lastTest: result }));
      setTests((t) => ({ ...t, [name]: { phase: 'ok', msg } }));
    } catch (e: any) {
      const latencyMs = Math.round(performance.now() - started);
      const msg = e?.message || String(e);
      const result: ProviderTestResult = { status: 'fail', latencyMs, at: Date.now(), message: msg };
      onPersistSettings(updateProvider(settingsRef.current, name, { lastTest: result }));
      setTests((t) => ({ ...t, [name]: { phase: 'fail', msg } }));
    } finally {
      clearTimeout(timer);
    }
  }, [selectedProvider, onPersistSettings]);

  const handleSetCurrent = useCallback(() => {
    onCommitProvider({ ...settings, activeProvider: selectedProvider.name });
  }, [settings, selectedProvider.name, onCommitProvider]);

  const handleAdd = useCallback(
    (entry: AddProviderEntry) => {
      try {
        const next = addProvider(settings, entry.name, entry.kind);
        const added = next.providers.find((p) => p.name === entry.name);
        if (added) {
          if (entry.apiKey?.trim()) added.apiKey = entry.apiKey.trim();
          if (entry.baseUrl?.trim()) added.baseUrl = entry.baseUrl.trim();
          if (entry.model?.trim()) added.model = entry.model.trim();
        }
        if (added?.apiKey?.trim()) {
          setKeyDirtyMap((m) => ({ ...m, [added.name]: true }));
        }
        onCommitProvider(next);
        setSelected(entry.name);
        setAddOpen(false);
        requestFocusKey();
      } catch (e: any) {
        // 弹层已做重复名校验；此处仅兜底
        console.warn('[provider] 添加失败:', e);
      }
    },
    [settings, onCommitProvider, requestFocusKey],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!delTarget) return;
    try {
      const next = removeProvider(settings, delTarget);
      onStageDelete(delTarget);
      onUnstageClear(delTarget);
      onCommitProvider(next);
      setSelected(next.activeProvider);
      setDelTarget(null);
      setTests((t) => {
        const { [delTarget]: _drop, ...rest } = t;
        return rest;
      });
      setKeyDirtyMap((m) => {
        const { [delTarget]: _drop, ...rest } = m;
        return rest;
      });
      setKeyVisibleMap((m) => {
        const { [delTarget]: _drop, ...rest } = m;
        return rest;
      });
    } catch (e: any) {
      console.warn('[provider] 删除失败:', e);
      setDelTarget(null);
    }
  }, [settings, delTarget, onCommitProvider, onStageDelete, onUnstageClear]);

  const handleClearKeyConfirm = useCallback(() => {
    if (!clearTarget) return;
    onCommitProvider(updateProvider(settings, clearTarget, { apiKey: '' }));
    onStageClear(clearTarget);
    setKeyDirtyMap((m) => ({ ...m, [clearTarget]: true }));
    setClearTarget(null);
  }, [settings, clearTarget, onCommitProvider, onStageClear]);

  return (
    <>
      {!selectedProvider.apiKey?.trim() && (
        <div className="pp-onboard">
          <span className="pp-ob-icon">◈</span>
          <div className="pp-ob-text">
            <b>{selectedProvider.name}</b> 还没有可用的 Key。粘贴 API Key 后即可开始对话。
          </div>
          <button type="button" className="pp-ob-btn" onClick={requestFocusKey}>
            去填 Key →
          </button>
        </div>
      )}

      <div className="pp-split">
        <ProviderList
          providers={settings.providers}
          selected={selected}
          current={settings.activeProvider}
          onSelect={setSelected}
          onAdd={() => setAddOpen(true)}
        />
        <ProviderDetail
          provider={selectedProvider}
          isCurrent={selectedProvider.name === settings.activeProvider}
          canDelete={settings.providers.length > 1}
          test={tests[selectedProvider.name] ?? { phase: 'idle', msg: '' }}
          keySaved={!keyDirtyMap[selectedProvider.name] && !!selectedProvider.apiKey?.trim()}
          pendingClear={pendingClears.includes(selectedProvider.name)}
          keyVisible={!!keyVisibleMap[selectedProvider.name]}
          keyInputRef={keyInputRef}
          onFieldChange={(field, value) => handleFieldChange(selectedProvider.name, field, value)}
          onModelChange={(modelId, desc) => handleModelChange(selectedProvider.name, modelId, desc)}
          onRefreshModels={handleRefreshModels}
          onTest={handleTest}
          onSetCurrent={handleSetCurrent}
          onClearKey={() => setClearTarget(selectedProvider.name)}
          onResetBaseUrl={() =>
            onCommitProvider(
              updateProvider(settings, selectedProvider.name, {
                baseUrl: defaultBaseUrl(selectedProvider.name, selectedProvider.kind),
              }),
            )
          }
          onToggleKeyVisible={() =>
            setKeyVisibleMap((m) => ({ ...m, [selectedProvider.name]: !m[selectedProvider.name] }))
          }
          onDelete={() => setDelTarget(selectedProvider.name)}
        />
      </div>

      {providerDirty && (
        <div className="pp-save-bar">
          <span className="pp-save-bar-dot" />
          <span className="pp-save-bar-text">有未保存的信号源更改</span>
          <button type="button" className="pp-save-btn" onClick={onSaveProviders}>
            保存 Provider
          </button>
        </div>
      )}

      <AddProviderSheet
        open={addOpen}
        existingNames={settings.providers.map((p) => p.name)}
        onClose={() => setAddOpen(false)}
        onAdd={handleAdd}
      />

      <ConfirmDialog
        open={delTarget !== null}
        title="删除信号源"
        message={
          <>
            确定删除 <b>{delTarget}</b>？其<strong>系统凭据 Key 将一并删除</strong>（保存后生效），此操作不可撤销。
          </>
        }
        confirmLabel="确认删除"
        tone="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDelTarget(null)}
      />

      <ConfirmDialog
        open={clearTarget !== null}
        title="清除已保存 Key"
        message={
          <>
            将从系统凭据中删除 <b>{clearTarget}</b> 的 API Key（保存后生效）。删除后该信号源将处于未配置状态。
          </>
        }
        confirmLabel="清除"
        tone="danger"
        onConfirm={handleClearKeyConfirm}
        onCancel={() => setClearTarget(null)}
      />
    </>
  );
}
