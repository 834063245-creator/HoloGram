// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PromptShelf — unified prompt area between messages and input
// Handles both ask_user cards and permission approvals.
// Does NOT live inside the messages array — independent React root.

import type React from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import './prompt-shelf.css';

// ── Types ──

export interface AskPrompt {
  type: 'ask';
  id: string;
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface PermissionPrompt {
  type: 'permission';
  id: string;
  toolName: string;
  reason: string;
  subject: string;
  /** 高危操作标签，如 "ForceRecursiveRoot"。有值时显示红色警告卡片 */
  danger?: string;
}

export type PromptData = AskPrompt | PermissionPrompt;

// ── Icons (inline SVG, matching HoloGram HUD) ──

function svgIcon(name: string, size: number = 12): string {
  const icons: Record<string, string> = {
    'check-circle': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    close: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    lock: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    shield: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  };
  return icons[name] || '';
}

// ── Ask card (Reasonix-inspired: keyboard nav, hover preview, multi-select) ──

const AskCard: React.FC<{
  prompt: AskPrompt;
  onResolve: (answer: string[] | null) => void;
}> = ({ prompt, onResolve }) => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const advanceTimer = useRef<number | null>(null);

  const toggle = useCallback(
    (idx: number) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (prompt.multiSelect) {
          next.has(idx) ? next.delete(idx) : next.add(idx);
        } else {
          next.clear();
          next.add(idx);
        }
        return next;
      });

      // Single-select: auto-resolve after short delay
      if (!prompt.multiSelect) {
        if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
        advanceTimer.current = window.setTimeout(() => {
          const labels = prompt.options.filter((_, i) => i === idx).map((o) => o.label);
          onResolve(labels);
        }, 140);
      }
    },
    [prompt, onResolve],
  );

  const confirm = useCallback(() => {
    const labels = prompt.options.filter((_, i) => selected.has(i)).map((o) => o.label);
    onResolve(labels);
  }, [prompt.options, selected, onResolve]);

  const cancel = useCallback(() => onResolve(null), [onResolve]);

  // Keyboard
  useEffect(() => {
    if (advanceTimer.current !== null) {
      const id = advanceTimer.current;
      return () => window.clearTimeout(id);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < prompt.options.length) {
        e.preventDefault();
        toggle(idx);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [prompt.options.length, toggle, cancel]);

  const hoveredOption = hoverIdx !== null ? prompt.options[hoverIdx] : null;

  return (
    <div className="prompt-shelf__card" role="dialog" aria-modal="false">
      {/* Header */}
      <div className="prompt-shelf__head">
        <span className="prompt-shelf__tag">{prompt.header.slice(0, 12)}</span>
        <span className="prompt-shelf__question">{prompt.question}</span>
        <button className="prompt-shelf__dismiss" onClick={cancel} title="取消 (Esc)" type="button">
          <span dangerouslySetInnerHTML={{ __html: svgIcon('close', 14) }} />
        </button>
      </div>

      {/* Options */}
      <div className="prompt-shelf__options">
        {prompt.options.map((opt, i) => {
          const on = selected.has(i);
          const num = i + 1;
          return (
            <button
              key={i}
              className={`prompt-shelf__option${on ? ' prompt-shelf__option--on' : ''}`}
              onClick={() => toggle(i)}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx((h) => (h === i ? null : h))}
              type="button"
            >
              <span className="prompt-shelf__num">{num <= 9 ? num : ''}</span>
              <div className="prompt-shelf__opt-body">
                <span className="prompt-shelf__opt-label">{opt.label}</span>
                {opt.description && <span className="prompt-shelf__opt-desc">{opt.description}</span>}
              </div>
              {on && (
                <span
                  className="prompt-shelf__check"
                  dangerouslySetInnerHTML={{ __html: svgIcon('check-circle', 14) }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Detail preview — always rendered at fixed height to prevent jitter */}
      <div className="prompt-shelf__detail">
        {hoveredOption?.description ? (
          <>
            <span className="prompt-shelf__detail-label">{hoveredOption.label}</span>
            <span className="prompt-shelf__detail-text">{hoveredOption.description}</span>
          </>
        ) : (
          <span className="prompt-shelf__detail-text" style={{ opacity: 0 }}>
            &nbsp;
          </span>
        )}
      </div>

      {/* Free-form input for custom answers beyond predefined options */}
      <div className="prompt-shelf__custom">
        <input
          className="prompt-shelf__custom-input"
          type="text"
          placeholder="或者直接输入自定义回答…"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
              e.preventDefault();
              onResolve([(e.target as HTMLInputElement).value.trim()]);
            }
          }}
        />
      </div>

      {/* Multi-select confirm */}
      {prompt.multiSelect && selected.size > 0 && (
        <div className="prompt-shelf__actions">
          <button className="prompt-shelf__confirm" onClick={confirm} type="button">
            确认选择 ({selected.size})
          </button>
        </div>
      )}
    </div>
  );
};

// ── Permission card ──

const PermCard: React.FC<{
  prompt: PermissionPrompt;
  onResolve: (result: { allow: boolean; remember: boolean }) => void;
}> = ({ prompt, onResolve }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onResolve({ allow: false, remember: false });
        return;
      }
      if (e.key === 'Enter') {
        onResolve({ allow: true, remember: false });
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onResolve]);

  return (
    <div
      className={`prompt-shelf__card${prompt.danger ? ' prompt-shelf__card--danger' : ''}`}
      role="dialog"
      aria-modal="false"
    >
      <div className="prompt-shelf__head">
        <span className={`prompt-shelf__tag${prompt.danger ? ' prompt-shelf__tag--danger' : ''}`}>
          <span dangerouslySetInnerHTML={{ __html: svgIcon('lock', 10) }} />
          {prompt.danger ? ` 危险操作 · ${prompt.danger}` : ' 权限'}
        </span>
        <span className="prompt-shelf__question">{prompt.toolName}</span>
      </div>
      {prompt.subject && <div className="prompt-shelf__perm-subject">{prompt.subject}</div>}
      <div className="prompt-shelf__perm-reason">{prompt.reason}</div>
      <div className="prompt-shelf__perm-btns">
        <button
          className="prompt-shelf__perm-btn prompt-shelf__perm-btn--session"
          onClick={() => onResolve({ allow: true, remember: true })}
          type="button"
        >
          <span dangerouslySetInnerHTML={{ __html: svgIcon('shield', 12) }} /> 本次会话允许
        </button>
        <button
          className="prompt-shelf__perm-btn prompt-shelf__perm-btn--once"
          onClick={() => onResolve({ allow: true, remember: false })}
          type="button"
        >
          <span dangerouslySetInnerHTML={{ __html: svgIcon('check-circle', 12) }} /> 允许 Enter
        </button>
        <button
          className="prompt-shelf__perm-btn prompt-shelf__perm-btn--deny"
          onClick={() => onResolve({ allow: false, remember: false })}
          type="button"
        >
          <span dangerouslySetInnerHTML={{ __html: svgIcon('close', 12) }} /> 拒绝 Esc
        </button>
      </div>
    </div>
  );
};

// ── Exposed imperative API（core 注册接口签名不变）──

export interface PromptShelfHandle {
  readonly active: PromptData | null;
  /** Show an ask prompt. Returns a Promise that resolves with selected labels or null if cancelled. */
  showAsk(prompt: AskPrompt): Promise<string[] | null>;
  /** Show a permission prompt. Returns a Promise that resolves with allow/remember. */
  showPermission(prompt: PermissionPrompt): Promise<{ allow: boolean; remember: boolean }>;
  /** Dismiss current prompt (cancels pending Promise). */
  dismiss(): void;
}

// ── Shelf component（P2′-2b：直接挂 ChatBeacon 树，Controller 包装已删）──
// 句柄只创建一次（core 挂载时注册）；命令式读取一律走 ref 镜像，避免陈旧闭包。

export const PromptShelf = forwardRef<PromptShelfHandle>(function PromptShelf(_props, ref) {
  const [active, setActive] = useState<PromptData | null>(null);
  const activeRef = useRef<PromptData | null>(null);
  const resolverRef = useRef<((v: unknown) => void) | null>(null);

  /** Clear current prompt and resolve the pending Promise with null (cancelled).
   *  This prevents silent Promise leaks when a second prompt supersedes the first. */
  const dismissCurrent = useCallback(() => {
    const prev = resolverRef.current;
    activeRef.current = null;
    resolverRef.current = null;
    setActive(null);
    prev?.(null);
  }, []);

  const showAsk = useCallback(
    (prompt: AskPrompt) =>
      new Promise<string[] | null>((resolve) => {
        dismissCurrent();
        activeRef.current = prompt;
        resolverRef.current = (v) => resolve(v as string[] | null);
        setActive(prompt);
      }),
    [dismissCurrent],
  );

  const showPermission = useCallback(
    (prompt: PermissionPrompt) =>
      new Promise<{ allow: boolean; remember: boolean }>((resolve) => {
        dismissCurrent();
        activeRef.current = prompt;
        resolverRef.current = (v) => resolve(v as { allow: boolean; remember: boolean });
        setActive(prompt);
      }),
    [dismissCurrent],
  );

  const resolve = useCallback((v: unknown) => {
    const r = resolverRef.current;
    activeRef.current = null;
    resolverRef.current = null;
    setActive(null);
    r?.(v);
  }, []);

  // 卸载时取消挂起的 Promise，防泄漏（旧 Controller.destroy 语义）
  useEffect(() => dismissCurrent, [dismissCurrent]);

  useImperativeHandle(
    ref,
    () => ({
      get active() {
        return activeRef.current;
      },
      showAsk,
      showPermission,
      dismiss: dismissCurrent,
    }),
    [showAsk, showPermission, dismissCurrent],
  );

  return (
    <div className="prompt-shelf">
      {active?.type === 'ask' ? (
        <AskCard prompt={active} onResolve={resolve} />
      ) : active?.type === 'permission' ? (
        <PermCard prompt={active} onResolve={resolve} />
      ) : null}
    </div>
  );
});
