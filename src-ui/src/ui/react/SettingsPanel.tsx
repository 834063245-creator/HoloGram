// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings 面板 — settings-panel.ts 的 React 重写。
// Provider | Agent | Display | Languages 四个标签页。
// 读写 settings.ts 的 localStorage，保存后触发 Agent 重新初始化。

import { getVersion } from '@tauri-apps/api/app';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../bridge';
import type { Lang } from '../../i18n';
import { setLang } from '../../i18n';
import { getCatalogProviders, getDefaultModel, mergeDynamicModels } from '../../provider/catalog';
import { ChunkType, type ModelDescriptor } from '../../provider/types';
import type { AppSettings } from '../../settings';
import { addProvider, defaultBaseUrl, isFactoryBaseUrl, loadSettings, loadSettingsWithSecrets, persistSecrets, removeProvider, removeSecret, saveSettings } from '../../settings';
import { createProvider } from '../../provider';
import { getActiveProvider } from '../../settings';
import { getOnSettingsSave } from '../dock-config';
import { useDockStore } from '../dock-store';
import { bus } from '../events';
import { iconHtml } from '../icons';
import { ModelSelector } from './ModelSelector';

type Tab = 'provider' | 'agent' | 'display' | 'languages' | 'about';

interface LspServer {
  command: string;
  language_id: string;
  extensions: string[];
  available: boolean;
  installed?: boolean;
  error?: string;
}
interface LspData {
  available: string[];
  missing: string[];
  servers: LspServer[];
}

// ── 辅助函数 ──

const _escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const _escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── 主组件 ──

const SettingsPanelApp: React.FC<{
  onClose: () => void;
  onSave: (() => void) | null;
}> = ({ onClose, onSave }) => {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [activeTab, setActiveTab] = useState<Tab>('provider');
  const [appVersion, setAppVersion] = useState('…');
  // ⚡ 2026-08-04 状态治理：apiKey 权威在系统加密凭据 —
  // localStorage 无明文，打开面板时异步回填密钥供表单展示。
  // ⚡ 2026-08-07 竞态修复：回填用函数式合并、只填充仍为空的 key——
  // 旧实现 restoreSecrets(loadSettings()) 的快照在用户已输入后到达，
  // 会整体覆盖 state，把刚填的 key 冲掉（「key 填进去没被保存」根因之一）。
  useEffect(() => {
    let alive = true;
    loadSettingsWithSecrets()
      .then((filled) => {
        if (!alive) return;
        setSettings((s) => {
          const next = structuredClone(s);
          for (const p of next.providers) {
            if (!p.apiKey || p.apiKey.trim() === '') {
              const f = filled.providers.find((x) => x.name === p.name);
              if (f?.apiKey?.trim()) p.apiKey = f.apiKey.trim();
            }
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion('9.0.1'));
  }, []);
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'available' | 'downloading' | 'done' | 'error'
  >('idle');
  const [updateMsg, setUpdateMsg] = useState('');
  const [updateVersion, setUpdateVersion] = useState('');
  const checkUpdate = useCallback(async () => {
    setUpdateStatus('checking');
    setUpdateMsg('');
    try {
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const update = await checkUpdate();
      if (update) {
        setUpdateVersion(update.version);
        setUpdateStatus('available');
        setUpdateMsg(`新版本 ${update.version} 可用`);
      } else {
        setUpdateStatus('done');
        setUpdateMsg('已是最新版本');
      }
    } catch (e: any) {
      setUpdateStatus('error');
      setUpdateMsg(e?.message || String(e));
    }
  }, []);
  const doUpdate = useCallback(async () => {
    setUpdateStatus('downloading');
    try {
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const update = await checkUpdate();
      if (!update) {
        setUpdateStatus('error');
        setUpdateMsg('更新信息已过期');
        return;
      }
      setUpdateMsg('下载中…');
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Finished') setUpdateMsg('下载完成，重启生效');
      });
      setUpdateStatus('done');
      setUpdateMsg('下载完成，下次启动生效');
    } catch (e: any) {
      setUpdateStatus('error');
      setUpdateMsg(e?.message || String(e));
    }
  }, []);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState('');
  const [addKind, setAddKind] = useState<'openai' | 'anthropic'>('openai');
  const [addKey, setAddKey] = useState('');
  const [addError, setAddError] = useState('');

  // API Key 可见性
  const [keyVisible, setKeyVisible] = useState(false);

  // 测试连接
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  // LSP 状态
  const [lspStatus, setLspStatus] = useState<LspData | null>(null);
  const [lspLoading, setLspLoading] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  // 工具搜索
  const [toolFilter, setToolFilter] = useState('');

  // 添加表单（方案 A：一步到位 — name/kind/key/baseUrl/model 全部在此确认）
  const [addBaseUrl, setAddBaseUrl] = useState('');
  const [addModel, setAddModel] = useState('');

  const active = getActiveProvider(settings);
  const isAnthropic = active?.kind === 'anthropic';

  // ── 语言依赖标签页打开时加载 LSP 状态 ──
  const lspLoaded = useRef(false);
  const lspPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lspPollCount = useRef(0);
  const MAX_LSP_POLLS = 15; // 最多 30 秒
  useEffect(() => {
    if (activeTab !== 'languages' || lspLoaded.current) return;
    lspLoaded.current = true;
    setLspLoading(true);

    const fetchStatus = () => {
      invoke<string>('rpc', { method: 'hologram_call', params: { tool: 'engine_status', args: {} } })
        .then((raw) => {
          const parsed = JSON.parse(raw);
          if (parsed?.lsp?.servers) {
            setLspStatus(parsed.lsp);
            // 当所有已安装服务器都已确定状态（运行或错误）时停止，
            // 或轮询次数足够时停止。
            lspPollCount.current += 1;
            const allResolved = parsed.lsp.servers.every(
              (s: any) => s.available || s.error || !s.installed,
            );
            if ((allResolved || lspPollCount.current >= MAX_LSP_POLLS) && lspPollTimer.current) {
              clearInterval(lspPollTimer.current);
              lspPollTimer.current = null;
            }
          }
        })
        .catch(() => {})
        .finally(() => setLspLoading(false));
    };

    fetchStatus();
    // 每 2 秒轮询一次，直到所有已安装服务器报告最终状态。
    lspPollTimer.current = setInterval(fetchStatus, 2000);
    return () => {
      if (lspPollTimer.current) clearInterval(lspPollTimer.current);
    };
  }, [activeTab]);

  // ── 处理函数 ──
  // 手动落盘（2026-08-07 回退）：任何改动只进 state 并标 dirty，
  // 点「保存」才落盘 + 写系统凭据 + 重建 Agent。自动落盘曾导致设置页
  // 卡死整个软件（每次击键 saveSettings → 通知订阅者 → credential IPC 风暴），已废弃。

  const markDirty = useCallback(() => setDirty(true), []);

  /** 更新 state（函数式——连续多次调用安全累积，如 ModelSelector 的 model+baseUrl 两连改），
   *  落盘由「保存」按钮统一负责。 */
  const updateProvider = useCallback(
    (field: string, value: string | number) => {
      setSettings((s) => {
        const next = structuredClone(s);
        const p = next.providers.find((x) => x.name === next.activeProvider);
        if (p) (p as any)[field] = value;
        return next;
      });
      markDirty();
    },
    [markDirty],
  );

  /** 整体替换（添加/删除/切换等单次操作），落盘由「保存」按钮统一负责。 */
  const commit = useCallback(
    (next: AppSettings): void => {
      setSettings(next);
      markDirty();
    },
    [markDirty],
  );

  const handleAddProvider = useCallback(() => {
    const name = addName.trim();
    if (!name) {
      setAddError('名称不能为空');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setAddError('名称只能包含字母、数字、下划线和连字符');
      return;
    }
    try {
      const next = addProvider(settings, name, addKind);
      const added = next.providers.find((p) => p.name === name);
      if (added) {
        if (addKey.trim()) added.apiKey = addKey.trim();
        if (addBaseUrl.trim()) added.baseUrl = addBaseUrl.trim();
        if (addModel.trim()) added.model = addModel.trim();
      }
      // 手动落盘：确认只进 state（dirty），凭据与 localStorage 在「保存」时统一写入
      commit(next);
      setShowAddForm(false);
      setAddName('');
      setAddKey('');
      setAddBaseUrl('');
      setAddModel('');
      setAddError('');
    } catch (e: any) {
      setAddError(e.message || '添加失败');
    }
  }, [addName, addKind, addKey, addBaseUrl, addModel, settings, commit]);

  const handleRemoveProvider = useCallback(() => {
    if (settings.providers.length <= 1) {
      alert('至少保留一个 Provider');
      return;
    }
    if (!confirm(`确定删除 Provider "${active?.name}"？此操作不可撤销。`)) return;
    const name = active?.name;
    if (!name) return;
    const next = removeProvider(settings, name);
    removeSecret(name).catch(() => {});
    commit(next);
  }, [settings, active, commit]);

  const handleClose = useCallback(() => {
    if (dirty && !confirm('有未保存的修改，确定关闭？')) return;
    onClose();
  }, [dirty, onClose]);

  /** 保存 = 落盘 + 写系统凭据 + 重建 Agent。改动已即时进 state（dirty），
   *  保存后才影响磁盘与运行中 Agent——手动落盘的唯一落盘点。 */
  const handleSave = useCallback(() => {
    const a = settings.providers.find((p) => p.name === settings.activeProvider);
    if (!a) {
      alert(`找不到 Provider "${settings.activeProvider}"`);
      return;
    }
    if (!a.apiKey?.trim() && !confirm(`Provider "${a.name}" 的 API Key 为空，仍要保存？`)) return;
    if (!a.model?.trim() && !confirm(`Provider "${a.name}" 的模型名称为空，仍要保存？`)) return;

    saveSettings(settings);
    persistSecrets(settings).catch(() => {});
    setLang(settings.display.language);
    bus.emit('lang:changed', { lang: settings.display.language });
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    if (onSave) onSave();
  }, [settings, onSave]);

  /** 刷新模型列表 — 用组件 state 快照（改动已进 state + 密钥已回填/在输），
   *  与 handleTestConnection 同一数据源；不再从磁盘重读（快照不一致根因）。 */
  const handleRefreshModels = useCallback(async (): Promise<number> => {
    const activeProvider = getActiveProvider(settings);
    if (!activeProvider.apiKey?.trim()) return 0;
    const prov = createProvider(activeProvider);
    const models = (await prov.fetchModels?.()) ?? [];
    if (models.length > 0) {
      mergeDynamicModels(activeProvider.name, models);
    }
    return models.length;
  }, [settings]);

  /** 测试连接：真实发一次最小流式请求（1 token），验证 key/baseUrl/model 三者。
   *  错误消息已由 classifyError 分类（sendWithRetry 内应用）。 */
  const handleTestConnection = useCallback(async () => {
    const a = settings.providers.find((p) => p.name === settings.activeProvider);
    if (!a) return;
    if (!a.apiKey?.trim()) {
      setTestStatus('fail');
      setTestMsg('请先填写 API Key');
      return;
    }
    if (!a.model?.trim()) {
      setTestStatus('fail');
      setTestMsg('请先填写模型名称');
      return;
    }
    setTestStatus('testing');
    setTestMsg('');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const prov = createProvider(a, { disableThinking: true });
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
      setTestStatus('ok');
      setTestMsg(received ? '连接成功' : '连接成功（无文本返回，请检查模型行为）');
    } catch (e: any) {
      setTestStatus('fail');
      setTestMsg(e?.message || String(e));
    } finally {
      clearTimeout(timer);
    }
  }, [settings]);

  // ── 渲染 ──

  return (
    <>
      <div id="settings-panel-overlay" className="sp-open" onClick={handleClose} />
      <div id="settings-panel" className="sp-open">
        {/* 头部 */}
        <div className="sp-header">
          <span
            className="sp-title"
            dangerouslySetInnerHTML={{ __html: iconHtml('settings', 13) + ' <span class="zh">设置</span>SETTINGS' }}
          />
          <button
            className="sp-close-btn"
            onClick={handleClose}
            dangerouslySetInnerHTML={{ __html: iconHtml('close', 14) }}
          />
        </div>

        {/* 标签页 */}
        <div className="sp-tabs">
          {(
            [
              ['provider', 'agent', 'Provider'],
              ['agent', 'code', 'Agent'],
              ['display', 'mode-standard', '显示'],
              ['languages', 'code', '语言依赖'],
              ['about', 'info', '关于'],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              key={id}
              className={`sp-tab${activeTab === id ? ' active' : ''}`}
              onClick={() => setActiveTab(id)}
              dangerouslySetInnerHTML={{ __html: iconHtml(icon, 11) + ' ' + label }}
            />
          ))}
        </div>

        {/* 内容 */}
        <div className="sp-content">
          {/* ═══ Provider 标签页 ═══ */}
          <div
            className="sp-tab-content"
            data-tab="provider"
            style={{ display: activeTab === 'provider' ? '' : 'none' }}
          >
            <div className="sp-section">
              <div className="sp-section-title">当前 Provider</div>
              <div className="sp-field">
                <label className="sp-label">Provider</label>
                <div className="sp-provider-row">
                  <select
                    className="sp-select"
                    style={{ flex: 1 }}
                    value={settings.activeProvider}
                    onChange={(e) => {
                      commit({ ...settings, activeProvider: e.target.value });
                    }}
                  >
                    {settings.providers.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name} ({p.kind})
                      </option>
                    ))}
                  </select>
                  <button
                    className="sp-btn-sm sp-btn-add-provider"
                    title="添加 Provider"
                    onClick={() => {
                      setShowAddForm(true);
                      setAddError('');
                    }}
                  >
                    + 添加
                  </button>
                  <button
                    className="sp-btn-sm sp-btn-rm-provider"
                    title="删除当前 Provider"
                    onClick={handleRemoveProvider}
                  >
                    删除
                  </button>
                </div>
              </div>
              {showAddForm && (
                <div className="sp-add-form">
                  <input
                    className="sp-input sp-add-name"
                    placeholder="Provider 名称（如 glm）"
                    style={{ marginBottom: 6 }}
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddProvider()}
                  />
                  <input
                    type="password"
                    className="sp-input sp-add-key"
                    placeholder="API Key（可选，稍后也能填）"
                    style={{ marginBottom: 6 }}
                    value={addKey}
                    onChange={(e) => setAddKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddProvider()}
                  />
                  <input
                    type="text"
                    className="sp-input sp-add-baseurl"
                    placeholder={`Base URL（如 ${defaultBaseUrl('deepseek', 'openai')}）`}
                    style={{ marginBottom: 6 }}
                    value={addBaseUrl}
                    onChange={(e) => setAddBaseUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddProvider()}
                  />
                  <input
                    type="text"
                    className="sp-input sp-add-model"
                    placeholder="模型名称（如 deepseek-v4-pro）"
                    style={{ marginBottom: 6 }}
                    value={addModel}
                    onChange={(e) => setAddModel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddProvider()}
                  />
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      className="sp-input sp-add-kind"
                      style={{ flex: 1 }}
                      value={addKind}
                      onChange={(e) => setAddKind(e.target.value as any)}
                    >
                      <option value="openai">OpenAI 兼容</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                    <button className="sp-btn-sm sp-btn-confirm-add" onClick={handleAddProvider}>
                      确认添加
                    </button>
                    <button className="sp-btn-sm sp-btn-cancel-add" onClick={() => setShowAddForm(false)}>
                      取消
                    </button>
                  </div>
                  <div className="ms-catalog-pick">
                    <span className="sp-hint-sub" style={{ width: '100%', marginBottom: 2 }}>
                      从目录快速添加：
                    </span>
                    {getCatalogProviders().map((provName) => {
                      const defaultModel = getDefaultModel(provName);
                      if (!defaultModel) return null;
                      return (
                        <button
                          type="button"
                          key={provName}
                          className="ms-catalog-chip"
                          title={`${defaultModel.name} · ${defaultModel.baseUrl}`}
                          onClick={() => {
                            setAddName(provName);
                            setAddKind(defaultModel.kind);
                            // 方案 A：chips 一步带出 baseUrl + 默认模型，确认即完成
                            setAddBaseUrl(defaultModel.baseUrl);
                            setAddModel(defaultModel.id);
                          }}
                        >
                          {provName}
                        </button>
                      );
                    })}
                  </div>
                  {addError && <div style={{ color: '#f66', fontSize: 11, marginTop: 4 }}>{addError}</div>}
                </div>
              )}
            </div>

            <div className="sp-section">
              <div className="sp-section-title">连接配置</div>
              <div className="sp-field">
                <label className="sp-label">API Key</label>
                <div className="sp-key-row">
                  <input
                    type={keyVisible ? 'text' : 'password'}
                    className="sp-input sp-key-input"
                    value={active?.apiKey || ''}
                    onChange={(e) => updateProvider('apiKey', e.target.value)}
                    onBlur={(e) => {
                      e.target.value = e.target.value.replace(/[^\x00-\x7F]/g, '');
                    }}
                    placeholder="sk-…"
                  />
                  <button
                    className="sp-key-toggle"
                    title="显示/隐藏"
                    onClick={() => setKeyVisible((v) => !v)}
                    dangerouslySetInnerHTML={{ __html: iconHtml('eye', 14) }}
                  />
                </div>
              </div>
              <div className="sp-field">
                <label className="sp-label">模型</label>
                <ModelSelector
                  value={active?.model || ''}
                  providerName={active?.name || ''}
                  kind={active?.kind || 'openai'}
                  onRefreshModels={handleRefreshModels}
                  onChange={(modelId, desc) => {
                    updateProvider('model', modelId);
                    // 如果为空或仍是出厂默认 URL（用户未自定义过），自动填充 baseUrl
                    if (desc) {
                      const currentBase = active?.baseUrl || '';
                      if (!currentBase || isFactoryBaseUrl(currentBase)) {
                        updateProvider('baseUrl', desc.baseUrl);
                      }
                    }
                  }}
                />
              </div>
              <div className="sp-field">
                <label className="sp-label">Base URL</label>
                <input
                  type="text"
                  className="sp-input"
                  value={active?.baseUrl || ''}
                  onChange={(e) => updateProvider('baseUrl', e.target.value)}
                  onBlur={(e) => {
                    e.target.value = e.target.value.replace(/[^\x00-\x7F]/g, '');
                  }}
                  placeholder={defaultBaseUrl('deepseek', 'openai')}
                />
              </div>
              <div className="sp-field">
                <div className="sp-test-row">
                  <button
                    type="button"
                    className={`sp-btn-sm sp-btn-test${testStatus === 'testing' ? ' disabled' : ''}`}
                    disabled={testStatus === 'testing'}
                    onClick={handleTestConnection}
                    dangerouslySetInnerHTML={{
                      __html: iconHtml(testStatus === 'testing' ? 'loading' : 'refresh', 11) + ' 测试连接',
                    }}
                  />
                  {testStatus !== 'idle' && (
                    <span
                      className={`sp-test-msg ${testStatus}`}
                      style={{ color: testStatus === 'ok' ? 'var(--obs-pass)' : testStatus === 'fail' ? 'var(--obs-warn)' : undefined }}
                    >
                      {testMsg}
                    </span>
                  )}
                </div>
                <div className="sp-hint-sub">发送最小请求验证 Key / Base URL / 模型三者可用。错误会自动分类提示。</div>
              </div>
              {isAnthropic && (
                <div className="sp-field">
                  <label className="sp-label">思考努力等级</label>
                  <select
                    className="sp-input"
                    value={active?.thinking || ''}
                    onChange={(e) => updateProvider('thinking', e.target.value)}
                  >
                    <option value="">自动（模型自定）</option>
                    <option value="low">低 (low)</option>
                    <option value="medium">中 (medium)</option>
                    <option value="high">高 (high)</option>
                    <option value="max">极限 (max)</option>
                    <option value="off">关闭</option>
                  </select>
                  <div className="sp-hint-sub">
                    Anthropic extended thinking 努力等级。等级越高思考越深（越费 token）。
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ═══ Agent 标签页 ═══ */}
          <div className="sp-tab-content" data-tab="agent" style={{ display: activeTab === 'agent' ? '' : 'none' }}>
            <div className="sp-section">
              <div className="sp-section-title">模型参数</div>
              <div className="sp-field">
                <label className="sp-label">
                  输出随机性 <span className="sp-val">{(settings.agent.temperature || 0.7).toFixed(1)}</span>
                </label>
                <div className="sp-slider-row">
                  <span className="sp-slider-end">0</span>
                  <input
                    type="range"
                    className="sp-range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={settings.agent.temperature || 0.7}
                    style={{ '--pct': `${Math.round(((settings.agent.temperature || 0.7) / 2) * 100)}%` } as any}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      const pct = Math.round((v / 2) * 100);
                      (e.target as any).style.setProperty('--pct', `${pct}%`);
                      commit({ ...settings, agent: { ...settings.agent, temperature: v } });
                    }}
                  />
                  <span className="sp-slider-end">2</span>
                </div>
                <div className="sp-hint-sub">低 = 稳定可预测，适合代码/事实 · 高 = 有创意，适合写作/头脑风暴</div>
              </div>
              <div className="sp-field">
                <label className="sp-label sp-checkbox-label">
                  <input
                    type="checkbox"
                    checked={!settings.agent.disableThinking}
                    onChange={(e) => {
                      commit({ ...settings, agent: { ...settings.agent, disableThinking: !e.target.checked } });
                    }}
                  />
                  深度思考 (DeepSeek Think 模式)
                </label>
                <div className="sp-hint-sub">
                  关闭 = 强制直出（Anthropic / OpenAI 兼容两种协议都生效）。Anthropic 思考强度在
                  Provider 页设置；DeepSeek 当前仅支持开关（effort 待 API 支持后开放）。
                </div>
              </div>
              <div className="sp-field">
                <label className="sp-label">上下文窗口（0=不限制）</label>
                <input
                  type="number"
                  className="sp-input sp-input-num"
                  value={settings.agent.contextWindow || 0}
                  min={0}
                  step={1000}
                  onChange={(e) => {
                    commit({
                      ...settings,
                      agent: { ...settings.agent, contextWindow: parseInt(e.target.value, 10) || 0 },
                    });
                  }}
                  placeholder="0 = 不限制"
                />
              </div>
            </div>
            <div className="sp-section">
              <div className="sp-section-title">工具管理</div>
              <div className="sp-field">
                <input
                  className="sp-input"
                  placeholder="搜索工具…"
                  autoComplete="off"
                  value={toolFilter}
                  onChange={(e) => setToolFilter(e.target.value)}
                />
              </div>
              <div className="sp-tool-list">
                <div className="sp-hint" style={{ padding: 8 }}>
                  工具列表在 Agent 初始化后可用
                </div>
              </div>
            </div>
            <div className="sp-hint">输出随机性越低越稳定 · 越高越有创意但可能胡说。小窗口意味着旧消息会被压缩。</div>
          </div>

          {/* ═══ 显示标签页 ═══ */}
          <div className="sp-tab-content" data-tab="display" style={{ display: activeTab === 'display' ? '' : 'none' }}>
            <div className="sp-section">
              <div className="sp-section-title">语言 / Language</div>
              <div className="sp-radio-group">
                {[
                  { id: 'zh', label: '中文' },
                  { id: 'en', label: 'English' },
                ].map((l) => (
                  <label key={l.id} className="sp-radio">
                    <input
                      type="radio"
                      name="language"
                      value={l.id}
                      checked={settings.display.language === l.id}
                      onChange={() => {
                        commit({ ...settings, display: { ...settings.display, language: l.id as Lang } });
                      }}
                    />
                    <span className="sp-radio-label">{l.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="sp-hint">图例、聚焦横幅、工具栏提示的语言。其他界面不受影响。</div>
            <div className="sp-section" style={{ marginTop: 18 }}>
              <div className="sp-section-title">字体缩放 / Font Scale</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="range"
                  name="fontScale"
                  min={0.8}
                  max={2.0}
                  step={0.05}
                  value={settings.display.fontScale}
                  style={{ flex: 1, height: 4, accentColor: 'var(--obs-blue)' }}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    commit({ ...settings, display: { ...settings.display, fontScale: v } });
                  }}
                />
                <span
                  className="sp-fs-value"
                  style={{
                    fontFamily: 'var(--obs-font-mono)',
                    fontSize: 'calc(11px * var(--font-scale))',
                    color: 'var(--obs-blue)',
                    minWidth: 40,
                    textAlign: 'right',
                  }}
                >
                  {settings.display.fontScale.toFixed(2)}x
                </span>
              </div>
            </div>
            <div className="sp-hint">缩放所有界面文字。更改后保存即生效（Terminal / 编辑器需重新打开文件）。</div>
          </div>

          {/* ═══ 语言依赖标签页 ═══ */}
          <div
            className="sp-tab-content"
            data-tab="languages"
            style={{ display: activeTab === 'languages' ? '' : 'none' }}
          >
            {lspLoading ? (
              <div className="sp-hint" style={{ padding: 24, textAlign: 'center' }}>
                检测中...
              </div>
            ) : !lspStatus ? (
              <div className="sp-hint" style={{ padding: 24, textAlign: 'center' }}>
                无法获取语言依赖状态
                <br />
                <small>引擎未响应，请重试</small>
              </div>
            ) : (
              <>
                <div className="sp-section">
                  <div className="sp-section-title">语言服务器状态</div>
                  <div className="sp-hint" style={{ marginBottom: 10 }}>
                    {[
                      lspStatus.available.length > 0 && `${lspStatus.available.length} 运行中`,
                      lspStatus.servers.filter((s) => !s.available && (s as any).installed).length > 0 &&
                        `${lspStatus.servers.filter((s) => !s.available && (s as any).installed).length} 待启动`,
                      lspStatus.servers.filter((s) => !s.available && !(s as any).installed).length > 0 &&
                        `${lspStatus.servers.filter((s) => !s.available && !(s as any).installed).length} 未安装`,
                    ]
                      .filter(Boolean)
                      .join('  ·  ') || '没有检测到已安装的语言服务器'}
                  </div>
                  {lspStatus.servers.map((srv) => {
                    const installed = (srv as any).installed === true;
                    let icon: string, statusText: string, color: string, rowClass: string;
                    if (srv.available) {
                      icon = 'check-circle';
                      statusText = '运行中';
                      color = 'var(--obs-pass)';
                      rowClass = 'running';
                    } else if (installed) {
                      icon = 'alert-circle';
                      statusText = '已安装';
                      color = 'var(--obs-warn)';
                      rowClass = 'installed';
                    } else {
                      icon = 'close';
                      statusText = '未安装';
                      color = 'var(--obs-text-2)';
                      rowClass = '';
                    }
                    return (
                      <div key={srv.language_id} className={`sp-lsp-card ${rowClass}`}>
                        <span
                          className="sp-lsp-card-icon"
                          style={{ color }}
                          dangerouslySetInnerHTML={{ __html: iconHtml(icon, 13) }}
                        />
                        <div className="sp-lsp-card-body">
                          <div className="sp-lsp-card-header">
                            <span className="lang-name">{srv.language_id}</span>
                            <span className="lang-status" style={{ color }}>
                              {statusText}
                            </span>
                          </div>
                          <div className="sp-lsp-card-meta">
                            <code>{srv.command}</code>
                            &nbsp;·&nbsp; .{srv.extensions.join(', .')}
                          </div>
                          {!srv.available && srv.error && <div className="sp-lsp-card-err">{srv.error}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="sp-section">
                  <button
                    className="sp-install-toggle"
                    onClick={() => setShowInstallGuide((v) => !v)}
                    dangerouslySetInnerHTML={{
                      __html: iconHtml(showInstallGuide ? 'chevron-down' : 'chevron-right', 9) + ' 安装指南',
                    }}
                  />
                  {showInstallGuide && (
                    <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.8 }}>
                      {[
                        ['Python', 'npm install -g pyright'],
                        ['TypeScript', 'npm install -g typescript-language-server typescript'],
                        ['Rust', 'rustup component add rust-analyzer'],
                        ['Go', 'go install golang.org/x/tools/gopls@latest'],
                        ['C/C++', 'scoop install clangd'],
                        ['Java', 'scoop install jdtls'],
                        ['C#', 'dotnet tool install --global OmniSharp'],
                        ['PHP', 'npm install -g intelephense'],
                        ['Kotlin', 'scoop install kotlin-language-server'],
                      ].map(([lang, cmd]) => (
                        <div key={lang} className="sp-install-row">
                          <span className="lang-label">{lang}</span>
                          <code>{cmd}</code>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ═══ 关于标签页 ═══ */}
          <div className="sp-tab-content" data-tab="about" style={{ display: activeTab === 'about' ? '' : 'none' }}>
            <div className="sp-section">
              <div className="sp-section-title">HoloGram 全息观测站</div>
              <div className="sp-hint" style={{ marginBottom: 16 }}>
                深空代码拓扑 · AI 辅助分析
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '6px 12px', fontSize: 12 }}>
                <span style={{ color: 'var(--obs-text-2)' }}>版本</span>
                <span style={{ fontFamily: 'var(--obs-font-mono)' }}>{appVersion}</span>
                <span style={{ color: 'var(--obs-text-2)' }}>许可</span>
                <span>MIT</span>
                <span style={{ color: 'var(--obs-text-2)' }}>作者</span>
                <span>Wenbing Jing</span>
              </div>
            </div>
            <div className="sp-section">
              <div className="sp-section-title">更新</div>
              <div style={{ marginTop: 8 }}>
                {updateStatus === 'idle' && (
                  <button className="sp-btn sp-btn-save" onClick={checkUpdate}>
                    检查更新
                  </button>
                )}
                {updateStatus === 'checking' && <span className="sp-hint">检查中…</span>}
                {updateStatus === 'available' && (
                  <div>
                    <div className="sp-hint" style={{ marginBottom: 8 }}>
                      {updateMsg}
                    </div>
                    <button className="sp-btn sp-btn-save" onClick={doUpdate}>
                      下载并安装
                    </button>
                  </div>
                )}
                {updateStatus === 'downloading' && <span className="sp-hint">{updateMsg}</span>}
                {updateStatus === 'done' && (
                  <span className="sp-hint" style={{ color: 'var(--obs-pass)' }}>
                    {updateMsg}
                  </span>
                )}
                {updateStatus === 'error' && (
                  <div>
                    <span className="sp-hint" style={{ color: 'var(--obs-warn)' }}>
                      检查失败: {updateMsg}
                    </span>
                    <br />
                    <button className="sp-btn sp-btn-cancel" style={{ marginTop: 8 }} onClick={checkUpdate}>
                      重试
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 底部 */}
        <div className="sp-footer">
          <button className="sp-btn sp-btn-cancel" onClick={handleClose}>
            取消
          </button>
          <button
            className={`sp-btn sp-btn-save${saved ? ' sp-btn-ok' : ''}`}
            onClick={handleSave}
            dangerouslySetInnerHTML={{
              __html: saved ? iconHtml('check-circle', 11) + ' 已保存' : iconHtml('save', 11) + ' 保存',
            }}
          />
        </div>

        {/* 角标 */}
        <div className="corner-brackets">
          <span className="cb-bottom left" />
          <span className="cb-bottom right" />
        </div>
      </div>
    </>
  );
};

// ── 面板根（P3：DockPanel 条件挂载 — 关闭即卸载，重开从 localStorage 重读）──
// 旧 Controller 外层 overlay/panel 与组件内层同 id 重复嵌套，收编后只保留组件内这一层。

export function SettingsPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  return <SettingsPanelApp onClose={() => closePanel('settings')} onSave={getOnSettingsSave()} />;
}
