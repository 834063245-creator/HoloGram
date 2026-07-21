// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：顶部命令栏 — 替代旧 #toolbar 静态标记。
// 数据全部来自 shell-store；动作全部经 actions 注册表分发（main.ts 注入实现）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { runAction } from './actions';
import { Icon } from './Icon';
import { useShellStore } from './shell-store';

function BarBtn({
  action,
  icon,
  label,
  title,
  disabled,
  badge,
}: {
  action: string;
  icon: string;
  label?: string;
  title?: string;
  disabled?: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      className="cb-btn"
      title={title || label}
      disabled={disabled}
      onClick={() => runAction(action)}
    >
      <Icon name={icon} />
      {label ? <span className="cb-label">{label}</span> : null}
      {badge !== undefined && badge > 0 ? <span className="cb-badge">{badge}</span> : null}
    </button>
  );
}

/** 窗口控制（decorations:false 自定义标题栏）— 沿用 __TAURI_INTERNALS__ 直调 IPC */
interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } };
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}
function tauri(): TauriInternals | undefined {
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}
function winLabel(): string {
  return tauri()?.metadata?.currentWindow?.label || 'main';
}
function winCmd(c: string): void {
  const p = tauri()?.invoke(`plugin:window|${c}`, { label: winLabel() });
  if (p && typeof p.catch === 'function') p.catch((e: unknown) => console.error(`[win] ${c}:`, e));
}
function WinControls() {
  const [maximized, setMaximized] = useState(false);
  const sync = useCallback(async () => {
    try {
      const ok = await tauri()?.invoke('plugin:window|is_maximized', { label: winLabel() });
      setMaximized(!!ok);
    } catch {
      /* best-effort */
    }
  }, []);
  useEffect(() => {
    let timer = 0;
    const onResize = () => {
      clearTimeout(timer);
      timer = window.setTimeout(sync, 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(timer);
    };
  }, [sync]);
  return (
    <span className="cb-win">
      <button type="button" className="cb-win-btn" title="最小化" onClick={() => winCmd('minimize')}>
        ─
      </button>
      <button
        type="button"
        className="cb-win-btn"
        title={maximized ? '还原' : '最大化'}
        onClick={() => {
          winCmd('toggle_maximize');
          setTimeout(sync, 200); // 等窗口动画完成
        }}
      >
        {maximized ? '❐' : '□'}
      </button>
      <button type="button" className="cb-win-btn cb-win-close" title="关闭" onClick={() => winCmd('close')}>
        ✕
      </button>
    </span>
  );
}

export function CommandBar() {
  const violations = useShellStore((s) => s.violations);
  const analyzing = useShellStore((s) => s.analyzing);
  const diffActive = useShellStore((s) => s.diffActive);
  const folded = useShellStore((s) => s.folded);
  const projectPath = useShellStore((s) => s.projectPath);
  const setPaletteOpen = useShellStore((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const doSearch = () => {
    if (!query.trim()) return;
    runAction('search', query);
    inputRef.current?.blur(); // 搜完释放焦点，恢复键盘快捷键
  };

  // 标题栏双击最大化（仅当点击区域不是按钮/输入框时触发）
  const handleBarDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, kbd, .cb-win-btn, .cb-palette-trigger')) return;
    winCmd('toggle_maximize');
  }, []);

  // 标题栏拖拽 — 优先用 CSS -webkit-app-region: drag；Linux 部分 WM 不认时，用 Tauri API 兜底
  const barRef = useRef<HTMLElement>(null);
  const handleBarPointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, kbd, .cb-win-btn, .cb-palette-trigger')) return;
    // 只在 CSS drag 无效时启用（Linux 检测）
    if (document.documentElement.getAttribute('data-platform') !== 'linux') return;
    // 用 Tauri 原生拖拽
    const ta = tauri();
    if (ta?.invoke) {
      ta.invoke('plugin:window|start_dragging', { label: winLabel() }).catch(() => {});
    }
  }, []);

  return (
    <header
      className="cb-bar"
      ref={barRef}
      onDoubleClick={handleBarDoubleClick}
      onPointerDown={handleBarPointerDown}
    >
      <span className="cb-brand">
        <span className="cb-brand-mark">◈</span>
        <span className="cb-brand-name">HOLOGRAM</span>
        <span className="cb-brand-sub">OBSERVATORY</span>
      </span>
      <span className="cb-sep" />
      <BarBtn
        action="open"
        icon={analyzing === 'open' ? 'dot' : 'folder-open'}
        label={analyzing === 'open' ? '分析中...' : '打开文件夹'}
        disabled={analyzing !== null}
      />
      <BarBtn
        action="reanalyze"
        icon="refresh"
        label={analyzing === 'reanalyze' ? '分析中…' : '重分析'}
        title="重新分析当前项目（重新生成布局坐标）"
        disabled={analyzing !== null}
      />
      <BarBtn action="panel.check" icon="check" label="简报" title="简报面板" badge={violations} />
      <span className="cb-sep" />
      <BarBtn action="toggle-fold" icon="fold" label={folded ? '展开' : '折叠'} title="折叠/展开社区星系 (F)" />
      <BarBtn action="reset-cam" icon="reset-cam" label="复位" title="重置摄像机视角 (R)" />
      <BarBtn action="toggle-diff" icon="diff" label={diffActive ? '清除' : '变更'} title="变更回看着色 (Ctrl+D)" />
      <span className="cb-sep" />
      <BarBtn action="panel.constraints" icon="constraints" label="约束" title="约束配置" />
      <BarBtn action="panel.dataflow" icon="dataflow" label="数据流" title="数据流追踪面板" />
      <span className="cb-sep" />
      <BarBtn action="toggle-settings" icon="settings" label="设置" title="设置 (Ctrl+,)" />
      <span className="cb-spacer" />
      <button
        type="button"
        className="cb-palette-trigger"
        title="命令面板 (Ctrl+K)"
        onClick={() => setPaletteOpen(true)}
      >
        <Icon name="search" />
        <span className="cb-palette-hint">命令</span>
        <kbd>ctrl K</kbd>
      </button>
      <span className="cb-search">
        <input
          ref={inputRef}
          value={query}
          placeholder="SEARCH SYMBOL…"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search symbols"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doSearch();
          }}
        />
        <button type="button" className="cb-btn" title="搜索符号" onClick={doSearch}>
          <Icon name="search" />
        </button>
      </span>
      <span className="cb-sep" />
      <BarBtn action="toggle-shortcuts" icon="info" label="快捷键" title="快捷键 (?)" />
      {projectPath ? (
        <span className="cb-path" title={projectPath}>
          {projectPath}
        </span>
      ) : null}
      <span className="cb-sep" />
      <WinControls />
    </header>
  );
}
