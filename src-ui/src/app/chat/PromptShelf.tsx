// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PromptShelf — 消息和输入框之间的统一提示区
// 同时处理 ask_user 卡片和权限审批。
// 不在消息数组内 — 独立的 React root。

import type React from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { iconSvg } from '../../ui/icons';
import './prompt-shelf.css';

// ── 类型 ──

export interface AskPrompt {
  type: 'ask';
  id: string;
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
  /** 批量多问（questions 数组）时当前问题序号，1-based；单问时缺省 */
  batchIndex?: number;
  /** 批量多问总题数；单问时缺省 */
  batchTotal?: number;
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

// ── 图标 ──

function svgIcon(name: string, size: number = 12): string {
  return iconSvg(name, size);
}

// ── 询问卡片（受 Reasonix 启发：键盘导航、悬停预览、多选） ──

const AskCard: React.FC<{
  prompt: AskPrompt;
  onResolve: (answer: string[] | null) => void;
}> = ({ prompt, onResolve }) => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const advanceTimer = useRef<number | null>(null);

  /** 无 options = 开放式问题（用户输入自由文本回答）。 */
  const hasOptions = prompt.options.length > 0;

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

      // 单选：短暂延迟后自动确认
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

  const submitCustom = useCallback(() => {
    const v = inputRef.current?.value.trim();
    if (v) onResolve([v]);
  }, [onResolve]);

  const cancel = useCallback(() => {
    // 清掉待触发的自动确认，防取消后定时器泄漏到下一张卡
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    onResolve(null);
  }, [onResolve]);

  // 卸载时清掉未触发的自动确认定时器（挂载即注册清理，兜底所有后续 set 的 timer）
  useEffect(() => {
    return () => {
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      // 焦点在输入框（自定义回答 / 聊天输入）时不触发数字快选，防误答
      const target = e.target as HTMLElement | null;
      if (target && target.closest('input, textarea, [contenteditable="true"]')) return;
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
  const batchTag =
    prompt.batchTotal && prompt.batchTotal > 1 ? `问题 ${prompt.batchIndex ?? 1}/${prompt.batchTotal} · ` : '';

  return (
    <div className="prompt-shelf__card" role="dialog" aria-modal="false">
      {/* 头部 */}
      <div className="prompt-shelf__head">
        <span className="prompt-shelf__tag">
          {batchTag}
          {prompt.header.slice(0, 12)}
        </span>
        <span className="prompt-shelf__question">{prompt.question}</span>
        <button className="prompt-shelf__dismiss" onClick={cancel} title="取消 (Esc)" type="button">
          <span dangerouslySetInnerHTML={{ __html: svgIcon('close', 14) }} />
        </button>
      </div>

      {/* 选项（开放式问题无 options 时隐藏） */}
      {hasOptions && (
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
      )}

      {/* 详情预览 — 始终以固定高度渲染以防抖动 */}
      {hasOptions && (
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
      )}

      {/* 用于输入预定义选项之外的自定义回答；开放式问题为主输入 */}
      <div className="prompt-shelf__custom">
        <input
          ref={inputRef}
          className="prompt-shelf__custom-input"
          type="text"
          autoFocus={!hasOptions}
          placeholder={hasOptions ? '或者直接输入自定义回答…' : '输入回答后回车提交…'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
              e.preventDefault();
              onResolve([(e.target as HTMLInputElement).value.trim()]);
            }
          }}
        />
        {!hasOptions && (
          <button className="prompt-shelf__submit" onClick={submitCustom} type="button">
            提交回答
          </button>
        )}
      </div>

      {/* 多选确认 */}
      {prompt.multiSelect && hasOptions && selected.size > 0 && (
        <div className="prompt-shelf__actions">
          <button className="prompt-shelf__confirm" onClick={confirm} type="button">
            确认选择 ({selected.size})
          </button>
        </div>
      )}
    </div>
  );
};

// ── 权限卡片 ──

const PermCard: React.FC<{
  prompt: PermissionPrompt;
  onResolve: (result: { allow: boolean; remember: boolean }) => void;
}> = ({ prompt, onResolve }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在输入框（聊天输入等）时不触发快捷键，防打字误批准/误拒绝
      const target = e.target as HTMLElement | null;
      if (target && target.closest('input, textarea, [contenteditable="true"]')) return;
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

// ── 暴露的命令式 API（core 注册接口签名不变）──

export interface PromptShelfHandle {
  readonly active: PromptData | null;
  /** 显示询问提示。返回 Promise，解析为选中的标签或 null（取消时）。 */
  showAsk(prompt: AskPrompt): Promise<string[] | null>;
  /** 显示权限提示。返回 Promise，解析为 allow/remember。 */
  showPermission(prompt: PermissionPrompt): Promise<{ allow: boolean; remember: boolean }>;
  /** 关闭当前提示（取消挂起的 Promise）。 */
  dismiss(): void;
}

// ── Shelf 组件（P2′-2b：直接挂 ChatBeacon 树，Controller 包装已删）──
// FIFO 队列：同轮多个 ask_user / 权限请求排队展示，不再互相顶掉
// （旧实现第二个提示会以 null 静默取消第一个 → 模型收到"用户取消"并重复追问，
//   观感即"点击后卡死"）。每张卡激活时起 5 分钟超时兜底 —
//   无操作自动按取消解析，从根上防工具 promise 永久挂起。

/** 卡片激活后无操作的最长等待时间 — 超时按取消解析 */
const CARD_TIMEOUT_MS = 5 * 60 * 1000;

interface QueuedPrompt {
  prompt: PromptData;
  resolve: (v: unknown) => void;
  /** 激活时启动的超时定时器；未激活的队列项为 null */
  timer: number | null;
}

/** 超时默认值 — ask 取消（null），权限按拒绝。 */
function timeoutValue(prompt: PromptData): unknown {
  return prompt.type === 'permission' ? { allow: false, remember: false } : null;
}

export const PromptShelf = forwardRef<PromptShelfHandle>(function PromptShelf(_props, ref) {
  const [active, setActive] = useState<PromptData | null>(null);
  const queueRef = useRef<QueuedPrompt[]>([]);

  /** 解析队头并激活下一张。稳定引用 — 超时定时器与卡片点击共用。 */
  const resolveHead = useCallback((v: unknown) => {
    const head = queueRef.current.shift();
    if (head) {
      if (head.timer !== null) window.clearTimeout(head.timer);
      head.resolve(v);
    }
    const next = queueRef.current[0];
    setActive(next?.prompt ?? null);
    if (next) {
      next.timer = window.setTimeout(() => resolveHead(timeoutValue(next.prompt)), CARD_TIMEOUT_MS);
    }
  }, []);

  /** 入队；队列原本为空时立即激活队头。 */
  const enqueue = useCallback(
    (prompt: PromptData): Promise<unknown> =>
      new Promise((resolve) => {
        queueRef.current.push({ prompt, resolve, timer: null });
        if (queueRef.current.length === 1) {
          const head = queueRef.current[0];
          head.timer = window.setTimeout(() => resolveHead(timeoutValue(head.prompt)), CARD_TIMEOUT_MS);
          setActive(head.prompt);
        }
      }),
    [resolveHead],
  );

  const showAsk = useCallback(
    (prompt: AskPrompt) => enqueue({ ...prompt, type: 'ask' }) as Promise<string[] | null>,
    [enqueue],
  );

  const showPermission = useCallback(
    (prompt: PermissionPrompt) =>
      enqueue({ ...prompt, type: 'permission' }) as Promise<{ allow: boolean; remember: boolean }>,
    [enqueue],
  );

  /** 清空队列，全部按取消解析（ask → null，权限 → 拒绝）。运行停止或卸载时调用。 */
  const dismissAll = useCallback(() => {
    const q = queueRef.current;
    queueRef.current = [];
    setActive(null);
    for (const item of q) {
      if (item.timer !== null) window.clearTimeout(item.timer);
      item.resolve(timeoutValue(item.prompt));
    }
  }, []);

  // 卸载时取消所有挂起的 Promise，防泄漏（旧 Controller.destroy 语义）
  useEffect(() => dismissAll, [dismissAll]);

  useImperativeHandle(
    ref,
    () => ({
      get active() {
        return queueRef.current[0]?.prompt ?? null;
      },
      showAsk,
      showPermission,
      dismiss: dismissAll,
    }),
    [showAsk, showPermission, dismissAll],
  );

  return (
    <div className="prompt-shelf">
      {active?.type === 'ask' ? (
        <AskCard prompt={active} onResolve={resolveHead} />
      ) : active?.type === 'permission' ? (
        <PermCard prompt={active} onResolve={resolveHead} />
      ) : null}
    </div>
  );
});
