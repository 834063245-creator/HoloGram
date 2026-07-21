// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings Panel — React rewrite of settings-panel.ts.
// Provider | Agent | Display | Languages 四个标签页。
// 读写 settings.ts 的 localStorage，保存后触发 Agent 重新初始化。

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '../../bridge';
import type { Lang } from '../../i18n';
import { setLang } from '../../i18n';
import type { AppSettings } from '../../settings';
import { addProvider, loadSettings, persistSecrets, removeProvider, removeSecret, saveSettings } from '../../settings';
import { getOnSettingsSave } from '../dock-config';
import { useDockStore } from '../dock-store';
import { bus } from '../events';
import { iconHtml } from '../icons';

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

// ── Helpers ──

const _escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const _escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Main Component ──

const SettingsPanelApp: React.FC<{
  onClose: () => void;
  onSave: (() => void) | null;
}> = ({ onClose, onSave }) => {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [activeTab, setActiveTab] = useState<Tab>('provider');
  const [appVersion, setAppVersion] = useState('…');
  useEffect(() => { getVersion().then(setAppVersion).catch(() => setAppVersion('9.0.1')); }, []);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'done' | 'error'>('idle');
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
      if (!update) { setUpdateStatus('error'); setUpdateMsg('更新信息已过期'); return; }
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
  const [dirty, setDirty] = useState(false);

  // Provider add form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState('');
  const [addKind, setAddKind] = useState<'openai' | 'anthropic'>('openai');
  const [addKey, setAddKey] = useState('');
  const [addError, setAddError] = useState('');

  // API key visibility
  const [keyVisible, setKeyVisible] = useState(false);

  // LSP status
  const [lspStatus, setLspStatus] = useState<LspData | null>(null);
  const [lspLoading, setLspLoading] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  // Tool search
  const [toolFilter, setToolFilter] = useState('');

  // Save feedback
  const [saved, setSaved] = useState(false);

  const active = settings.providers.find((p) => p.name === settings.activeProvider) || settings.providers[0];
  const isAnthropic = active?.kind === 'anthropic';

  // ── Load LSP status when Languages tab opens ──
  // Poll until at least one server is running (backend warm is async).
  const lspLoaded = useRef(false);
  const lspPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
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
            // Stop polling once at least one server is running
            const hasRunning = parsed.lsp.servers.some((s: any) => s.available);
            if (hasRunning && lspPollTimer.current) {
              clearInterval(lspPollTimer.current);
              lspPollTimer.current = null;
            }
          }
        })
        .catch(() => {})
        .finally(() => setLspLoading(false));
    };

    fetchStatus();
    // Poll every 2s until servers come up (max ~30s = 15 attempts)
    lspPollTimer.current = setInterval(fetchStatus, 2000);
    return () => {
      if (lspPollTimer.current) clearInterval(lspPollTimer.current);
    };
  }, [activeTab]);

  // ── Handlers ──

  const markDirty = useCallback(() => setDirty(true), []);

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
      if (addKey.trim()) {
        const added = next.providers.find((p) => p.name === name);
        if (added) added.apiKey = addKey.trim();
      }
      setSettings(next);
      setShowAddForm(false);
      setAddName('');
      setAddKey('');
      setAddError('');
      setDirty(true);
    } catch (e: any) {
      setAddError(e.message || '添加失败');
    }
  }, [addName, addKind, addKey, settings]);

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
    setSettings(next);
    setDirty(true);
  }, [settings, active]);

  const handleClose = useCallback(() => {
    if (dirty && !confirm('有未保存的修改，确定关闭？')) return;
    onClose();
  }, [dirty, onClose]);

  const handleSave = useCallback(() => {
    const s = structuredClone(settings);
    const a = s.providers.find((p) => p.name === s.activeProvider);
    if (!a) {
      alert(`找不到 Provider "${s.activeProvider}"`);
      return;
    }
    if (!a.apiKey?.trim() && !confirm(`Provider "${a.name}" 的 API Key 为空，仍要保存？`)) return;
    if (!a.model?.trim() && !confirm(`Provider "${a.name}" 的模型名称为空，仍要保存？`)) return;

    saveSettings(s);
    persistSecrets(s).catch(() => {});
    setLang(s.display.language);
    bus.emit('lang:changed', { lang: s.display.language });
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    if (onSave) onSave();
  }, [settings, onSave]);

  // ── Render ──

  return (
    <>
      <div id="settings-panel-overlay" className="sp-open" onClick={handleClose} />
      <div id="settings-panel" className="sp-open">
        {/* Header */}
        <div className="sp-header">
          <span className="sp-title" dangerouslySetInnerHTML={{ __html: iconHtml('settings', 13) + ' <span class="zh">设置</span>SETTINGS' }} />
          <button
            className="sp-close-btn"
            onClick={handleClose}
            dangerouslySetInnerHTML={{ __html: iconHtml('close', 14) }}
          />
        </div>

        {/* Tabs */}
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

        {/* Content */}
        <div className="sp-content">
          {/* ═══ Provider Tab ═══ */}
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
                      setSettings((s) => ({ ...s, activeProvider: e.target.value }));
                      markDirty();
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
                <input
                  type="text"
                  className="sp-input"
                  value={active?.model || ''}
                  onChange={(e) => updateProvider('model', e.target.value)}
                  placeholder="deepseek-chat"
                />
              </div>
              <div className="sp-field">
                <label className="sp-label">
                  Max Tokens <span className="sp-hint-sub">（0 = 默认 32000）</span>
                </label>
                <input
                  type="number"
                  className="sp-input sp-input-num"
                  value={active?.maxTokens || 0}
                  min={0}
                  step={1000}
                  onChange={(e) => updateProvider('maxTokens', parseInt(e.target.value, 10) || 0)}
                  placeholder="0"
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
                  placeholder="https://api.deepseek.com/v1"
                />
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

          {/* ═══ Agent Tab ═══ */}
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
                      setSettings((s) => ({ ...s, agent: { ...s.agent, temperature: v } }));
                      markDirty();
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
                      setSettings((s) => ({ ...s, agent: { ...s.agent, disableThinking: !e.target.checked } }));
                      markDirty();
                    }}
                  />
                  深度思考 (DeepSeek Think 模式)
                </label>
                <div className="sp-hint-sub">启用后模型先思考再回答。仅 DeepSeek v4/v3 有效，关掉直接输出。</div>
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
                    setSettings((s) => ({
                      ...s,
                      agent: { ...s.agent, contextWindow: parseInt(e.target.value, 10) || 0 },
                    }));
                    markDirty();
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

          {/* ═══ Display Tab ═══ */}
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
                        setSettings((s) => ({ ...s, display: { ...s.display, language: l.id as Lang } }));
                        markDirty();
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
                    setSettings((s) => ({ ...s, display: { ...s.display, fontScale: v } }));
                    markDirty();
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

          {/* ═══ Languages Tab ═══ */}
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

          {/* ═══ About Tab ═══ */}
          <div
            className="sp-tab-content"
            data-tab="about"
            style={{ display: activeTab === 'about' ? '' : 'none' }}
          >
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
                {updateStatus === 'checking' && (
                  <span className="sp-hint">检查中…</span>
                )}
                {updateStatus === 'available' && (
                  <div>
                    <div className="sp-hint" style={{ marginBottom: 8 }}>{updateMsg}</div>
                    <button className="sp-btn sp-btn-save" onClick={doUpdate}>
                      下载并安装
                    </button>
                  </div>
                )}
                {updateStatus === 'downloading' && (
                  <span className="sp-hint">{updateMsg}</span>
                )}
                {updateStatus === 'done' && (
                  <span className="sp-hint" style={{ color: 'var(--obs-pass)' }}>{updateMsg}</span>
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

        {/* Footer */}
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

        {/* Corner brackets */}
        <div className="corner-brackets">
          <span className="cb-bottom left" />
          <span className="cb-bottom right" />
        </div>
      </div>
    </>
  );
};

// ── Panel root（P3：DockPanel 条件挂载 — 关闭即卸载，重开从 localStorage 重读）──
// 旧 Controller 外层 overlay/panel 与组件内层同 id 重复嵌套，收编后只保留组件内这一层。

export function SettingsPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  return <SettingsPanelApp onClose={() => closePanel('settings')} onSave={getOnSettingsSave()} />;
}
