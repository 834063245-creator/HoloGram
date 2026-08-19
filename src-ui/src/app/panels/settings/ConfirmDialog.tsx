// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 面板内确认弹窗 — 替换原生 alert/confirm，与玻璃面板视觉统一。
// tone="danger" 用于删除/放弃未保存更改等不可逆操作。

import type React from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div
      className="cd-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className={`cd-sheet${tone === 'danger' ? ' cd-danger' : ''}`} role="dialog" aria-modal="true">
        <div className="cd-hd">
          <span className="cd-title">{title}</span>
          <button type="button" className="cd-close" onClick={onCancel} title="关闭">
            ✕
          </button>
        </div>
        <div className="cd-body">{message}</div>
        <div className="cd-actions">
          <button type="button" className="sp-btn sp-btn-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'cd-btn-danger' : 'sp-btn sp-btn-save'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
