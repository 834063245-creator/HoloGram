// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P3：FileTranslator 的 portal 宿主 — wrapper（ui/file-translator.ts）把渲染会话
// 写进 overlay-store，这里在单 React 树内 createPortal 到 FileViewer 的面板元素。
// 挂载点不变（FileViewer 内、.fv-grip 之前），独立 React root 由此移除。

import { createPortal } from 'react-dom';
import { useOverlayStore } from '../../state/overlay-store';
import { FileTranslatorApp } from './FileTranslatorPanel';

export function FileTranslatorPortal() {
  const session = useOverlayStore((s) => s.translator);
  if (!session) return null;
  return createPortal(
    <FileTranslatorApp
      key={session.key}
      filePath={session.filePath}
      onClose={session.onClose}
      onLayoutChange={session.onLayoutChange}
      getEditorContent={session.getEditorContent}
    />,
    session.el,
  );
}
