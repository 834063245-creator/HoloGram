// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings 面板 — Provider | Agent | Display | Languages | About 五个标签页。
// Provider 页已拆为 settings/ProviderPage（信号源控制台），本文件只保留
// 外壳：tab 切换、dirty 状态、保存/取消、凭据暂存（删除/清除）统一落盘。

import { getVersion } from '@tauri-apps/api/app';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { typedRpc } from '../../rpc-contract';
import type { Lang } from '../../i18n';
import { setLang } from '../../i18n';
import type { AppSettings, ProviderId } from '../../settings';
import { loadSettings, loadSettingsWithSecrets, persistSecrets, removeSecret, saveSettings } from '../../settings';
import { useDockStore } from '../dock-store';
import { bus } from '../events';
import { iconHtml } from '../icons';
import { ConfirmDialog } from './settings/ConfirmDialog';
import { ProviderPage } from './settings/ProviderPage';
import { DEEP_THINK_LABEL } from '../../provider/thinking';

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
  // 会整体覆盖 state，把刚填的 key 冲掉。
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
  // Provider 页独立 dirty：与其他 tab 的全局保存互不牵连
  const [providerDirty, setProviderDirty] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [closeConfirm, setCloseConfirm] = useState(false);
  // 凭据暂存：删除 Provider / 清除 Key 只进 state，保存时才删系统凭据——
  // 用户取消/关闭面板不会丢 Key（P0 修复）。
  const [pendingDeletes, setPendingDeletes] = useState<ProviderId[]>([]);
  const [pendingClears, setPendingClears] = useState<ProviderId[]>([]);
  const [saveVersion, setSaveVersion] = useState(0);

  // LSP 状态
  const [lspStatus, setLspStatus] = useState<LspData | null>(null);
  const [lspLoading, setLspLoading] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  // 工具搜索
  const [toolFilter, setToolFilter] = useState('');

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
      typedRpc('hologram_call', { tool: 'engine_status', args: {} })
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

  /** 整体替换（添加/删除/切换等单次操作），落盘由「保存」按钮统一负责。 */
  const commit = useCallback(
    (next: AppSettings): void => {
      setSettings(next);
      markDirty();
    },
    [markDirty],
  );

  /** Provider 页专用提交：只标 providerDirty，不污染其他 tab 的全局 dirty。 */
  const commitProvider = useCallback((next: AppSettings): void => {
    setSettings(next);
    setProviderDirty(true);
  }, []);

  /** 立即落盘但不标 dirty——用于非配置类状态（如测试结果）。 */
  const persistSettings = useCallback((next: AppSettings): void => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const stageDelete = useCallback(
    (name: ProviderId) => setPendingDeletes((d) => (d.includes(name) ? d : [...d, name])),
    [],
  );
  const stageClear = useCallback(
    (name: ProviderId) => setPendingClears((c) => (c.includes(name) ? c : [...c, name])),
    [],
  );
  const unstageClear = useCallback(
    (name: ProviderId) => setPendingClears((c) => c.filter((x) => x !== name)),
    [],
  );

  const handleClose = useCallback(() => {
    if (dirty || providerDirty) {
      setCloseConfirm(true);
      return;
    }
    onClose();
  }, [dirty, providerDirty, onClose]);

  /** 保存管道：落盘 + 删暂存凭据 + 写新 Key + 重建 Agent。返回是否成功。 */
  const runSavePipeline = useCallback(async (): Promise<boolean> => {
    saveSettings(settings);
    // 1) 先删「清除 Key / 删除 Provider」暂存的系统凭据（removeSecret 幂等、失败静默）
    for (const name of [...new Set([...pendingClears, ...pendingDeletes])]) {
      await removeSecret(name);
    }
    // 2) 再写新 Key（P0-7：写失败必须据实提示）
    const failed = await persistSecrets(settings);
    if (failed.length > 0) {
      setSaveError(
        `API Key 写入系统凭据失败：${failed.join('、')}。\n设置本身已保存，但重启后这些 Key 会丢失，请重试或检查系统加密服务。`,
      );
      return false;
    }
    setPendingClears([]);
    setPendingDeletes([]);
    setLang(settings.display.language);
    bus.emit('lang:changed', { lang: settings.display.language });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    if (onSave) onSave();
    return true;
  }, [settings, pendingClears, pendingDeletes, onSave]);

  /** 全局保存（Agent / 显示等 tab） */
  const handleSave = useCallback(async () => {
    const ok = await runSavePipeline();
    if (ok) {
      setDirty(false);
      // runSavePipeline 是全量落盘：Provider 页的暂存改动也会一并持久化，
      // 因此两个 dirty 标志必须同时复位，避免保存条/保存按钮残留假状态。
      setProviderDirty(false);
      setSaveVersion((v) => v + 1);
    }
  }, [runSavePipeline]);

  /** Provider 页独立保存 */
  const handleSaveProviders = useCallback(async () => {
    const ok = await runSavePipeline();
    if (ok) {
      setProviderDirty(false);
      setDirty(false); // 同上：全量落盘，其他 tab 的 dirty 一并复位
      setSaveVersion((v) => v + 1);
    }
  }, [runSavePipeline]);

  const closeMsg =
    dirty && providerDirty
      ? '有未保存的设置与信号源更改，关闭后将全部丢失。确定关闭？'
      : dirty
        ? '有未保存的设置更改，关闭后将丢失。确定关闭？'
        : '有未保存的信号源更改，关闭后将丢失。确定关闭？';

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
          {/* ═══ Provider 标签页（信号源控制台）═══ */}
          <div
            className="sp-tab-content"
            data-tab="provider"
            style={{ display: activeTab === 'provider' ? '' : 'none' }}
          >
            <ProviderPage
              settings={settings}
              onCommitProvider={commitProvider}
              onPersistSettings={persistSettings}
              onStageDelete={stageDelete}
              onStageClear={stageClear}
              onUnstageClear={unstageClear}
              pendingClears={pendingClears}
              saveVersion={saveVersion}
              providerDirty={providerDirty}
              onSaveProviders={handleSaveProviders}
            />
          </div>

          {/* ═══ Agent 标签页 ═══ */}
          <div className="sp-tab-content" data-tab="agent" style={{ display: activeTab === 'agent' ? '' : 'none' }}>
            <div className="sp-section">
              <div className="sp-section-title">模型参数</div>
              <div className="sp-field">
                <label className="sp-label sp-checkbox-label">
                  <input
                    type="checkbox"
                    checked={!settings.agent.disableThinking}
                    onChange={(e) => {
                      commit({ ...settings, agent: { ...settings.agent, disableThinking: !e.target.checked } });
                    }}
                  />
                  {DEEP_THINK_LABEL}
                </label>
                <div className="sp-hint-sub">
                  关闭 = 强制直出（Anthropic / OpenAI 兼容两种协议都生效）。思考强度档位在
                  Provider 页或聊天面板模型切换器设置（DeepSeek：高/极限；OpenAI 官方：低/中/高）。
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
            <div className="sp-hint">小窗口意味着旧消息会被压缩。</div>
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

        {saveError && (
          <div className="pp-error-banner">
            <span className="pp-error-text">{saveError}</span>
            <button type="button" className="pp-error-close" onClick={() => setSaveError('')} title="关闭">
              ✕
            </button>
          </div>
        )}

        {/* 底部 */}
        <div className="sp-footer">
          <button className="sp-btn sp-btn-cancel" onClick={handleClose}>
            取消
          </button>
          {/* Provider tab 用页内「保存 Provider」按钮，全局保存只负责其他 tab */}
          {activeTab !== 'provider' && (
            <button
              className={`sp-btn sp-btn-save${saved ? ' sp-btn-ok' : ''}`}
              disabled={!dirty}
              onClick={handleSave}
              dangerouslySetInnerHTML={{
                __html: saved ? iconHtml('check-circle', 11) + ' 已保存' : iconHtml('save', 11) + ' 保存',
              }}
            />
          )}
        </div>

        {/* 面板内确认（替换原生 alert/confirm） */}
        <ConfirmDialog
          open={closeConfirm}
          title="放弃未保存更改"
          message={closeMsg}
          confirmLabel="放弃并关闭"
          tone="danger"
          onConfirm={onClose}
          onCancel={() => setCloseConfirm(false)}
        />

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

export function SettingsPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  // 保存成功后只发显式事件；热切换由 main.ts → Workspace.applyAgentConfig 统一处理。
  return (
    <SettingsPanelApp
      onClose={() => closePanel('settings')}
      onSave={() => bus.emit('agent:config-changed', { reason: 'settings-saved' })}
    />
  );
}
