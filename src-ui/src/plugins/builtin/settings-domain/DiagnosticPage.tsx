// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置面板「诊断」签（日志可观测性批 4）——排障动作收拢页。
//
// 为什么单起一页：这里放的都是「出问题时才用」的动作（当前：日志级别开关；
// 随后：诊断包导出），与提供方/显示那些「平时配置」的页签气质不同——
// 收拢到一页，用户找起来只有一条路（设置 → 诊断）。
//
// 产物域纪律：级别读写经宿主桥（`./host` 的 `logLevel` / `setLogLevelPreference`），
// 不裸 import 内核 logger（`tests/host-surface-seal.test.ts` 封印）。
//
// 文案纪律（用户视角，2026-10-12 拍板）：**这个开关不是「出问题请先打开」**——
// 默认档 + 前情缓冲已经覆盖日常排障（失败时自动连现场落盘）。开关的语义只有
// 一个：「我要一份全程逐条的详细记录」。UI 不许写成「必须打开才能排障」。

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { type LogLevel, type LogLevelSource, logLevel, setLogLevelPreference, typedJsonRpc, typedRpc } from './host';

/** 字节 → 人读（与诊断包内摘要同风格）。 */
function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export const DiagnosticPage: React.FC = () => {
  const [level, setLevel] = useState<{ level: LogLevel; source: LogLevelSource } | null>(null);
  const [busy, setBusy] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ path: string; size: number } | null>(null);
  const [exportError, setExportError] = useState('');

  useEffect(() => {
    setLevel(logLevel());
  }, []);

  const onToggle = useCallback(async (detailed: boolean) => {
    setBusy(true);
    try {
      const applied = await setLogLevelPreference(detailed ? 'debug' : 'info');
      setLevel(applied);
    } finally {
      setBusy(false);
    }
  }, []);

  const onExport = useCallback(async () => {
    setExporting(true);
    setExportError('');
    try {
      const r = await typedJsonRpc('diag_export');
      setExported({ path: r.path, size: r.size });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, []);

  const onOpenFolder = useCallback(async () => {
    if (!exported) return;
    // 交给系统文件管理器打开导出目录（fs_cap open_with_system，用户通道）。
    const dir = exported.path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
    try {
      await typedRpc('fs_cap', { action: 'open_with_system', file_path: dir, is_agent: false });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  }, [exported]);

  const detailed = level?.level === 'debug';

  return (
    <>
      <div className="sp-section" style={{ marginTop: 18 }}>
        <div className="sp-section-title">诊断包 / Diagnostics Bundle</div>
        <div className="sp-field">
          <div className="sp-hint-sub">
            出问题时点一下这里：生成一个文件（包含最近的日志，以及一份「怎么读它」的摘要）。 把这个文件发给你的 Agent
            就行——不用挑文件、不用理解格式。
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="sp-btn sp-btn-sm" disabled={exporting} onClick={() => void onExport()}>
              {exporting ? '正在导出…' : '导出诊断包'}
            </button>
            {exported && (
              <button type="button" className="sp-btn sp-btn-sm" onClick={() => void onOpenFolder()}>
                打开所在文件夹
              </button>
            )}
          </div>
          {exported && (
            <div className="sp-hint-sub">
              已导出：{exported.path}（{fmtSize(exported.size)}）
            </div>
          )}
          {exportError && (
            <div className="sp-hint-sub" style={{ color: 'var(--obs-fail)' }}>
              导出失败：{exportError}
            </div>
          )}
        </div>
      </div>

      <div className="sp-section" style={{ marginTop: 18 }}>
        <div className="sp-section-title">日志级别 / Log Level</div>
        <div className="sp-field">
          <label className="sp-label sp-checkbox-label">
            <input
              type="checkbox"
              checked={detailed}
              disabled={busy || level === null}
              onChange={(e) => void onToggle(e.target.checked)}
            />
            记录详细日志（全程 debug）
          </label>
          <div className="sp-hint-sub">
            平时不用打开：默认档已经覆盖日常排障——出现问题时，最近一段的关键现场（含调试细节）
            会自动随日志保留下来。打开这里只为一件事：我要一份全程逐条的详细记录（日志会变得更
            啰嗦、更大）。改动立即生效。
          </div>
          {level?.source === 'env' && (
            <div className="sp-hint-sub">当前级别由启动环境变量指定（{level.level}），此开关暂不生效。</div>
          )}
        </div>
      </div>
    </>
  );
};
