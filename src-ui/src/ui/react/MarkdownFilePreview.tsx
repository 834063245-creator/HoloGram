// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MarkdownFilePreview — 文件查看器 .md 预览的 react-markdown 渲染（收敛 marked+DOMPurify 旧路径）。

import hljs from 'highlight.js';
import type React from 'react';
import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function FileMarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  const text = String(children ?? '').replace(/\n$/, '');
  const match = /language-([\w-]+)/.exec(className ?? '');
  const isBlock = match !== null || text.includes('\n');

  useEffect(() => {
    if (!ref.current) return;
    ref.current.querySelectorAll('pre code:not([data-highlighted])').forEach((block) => {
      try {
        hljs.highlightElement(block as HTMLElement);
        block.setAttribute('data-highlighted', 'true');
      } catch {
        /* 无操作 */
      }
    });
  });

  if (isBlock) {
    return (
      <div ref={ref}>
        <pre>
          <code className={className}>{text}</code>
        </pre>
      </div>
    );
  }
  return <code className="md-code">{children}</code>;
}

export const MarkdownFilePreview: React.FC<{ content: string }> = ({ content }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      code: FileMarkdownCode,
      pre: ({ children }) => <>{children}</>,
    }}
  >
    {content}
  </ReactMarkdown>
);
