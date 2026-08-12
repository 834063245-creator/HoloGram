// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat 工具函数 — 从 chat.ts 提取的纯静态辅助函数
// 不依赖 ChatPanel 状态。可从任何位置安全导入。

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { iconHtml } from './icons';
import { resolveSemanticToolName } from './tool-semantics';

// ═══════════════════════════════════════════════════════════════════
// escapeHtml
// ═══════════════════════════════════════════════════════════════════

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════════
// formatDiffResult
// ═══════════════════════════════════════════════════════════════════

/** edit_file 结果的简单行级 diff（第 7 项）。 */
export function formatDiffResult(body: string, argsJson?: string): string {
  // 若可用，从参数中提取文件路径
  let filePath = '';
  if (argsJson) {
    try {
      const args = JSON.parse(argsJson);
      // 旧工具用 file_path/path；领域工具 fs(write/edit) 用 camelCase filePath
      filePath = args.file_path || args.path || args.filePath || '';
    } catch {}
  }

  // 尝试从参数中提取 old/new 进行真实 diff
  let oldStr = '';
  let newStr = '';
  if (argsJson) {
    try {
      const args = JSON.parse(argsJson);
      // Agent 发送 camelCase（tool.ts），但也处理来自旧路径的 snake_case
      oldStr = args.oldString || args.old_string || args.old_text || args.oldText || '';
      newStr = args.newString || args.new_string || args.new_text || args.newText || args.content || '';
    } catch {}
  }

  const headerHtml = filePath ? `<div class="diff-header">📄 ${escapeHtml(filePath)}</div>` : '';
  const MAX_LINES = 40;

  if (oldStr && newStr) {
    // 真实 diff：比较 old vs new
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const diffLines = computeSimpleDiff(oldLines, newLines);
    const totalLines = diffLines.length;
    const collapsed = totalLines > MAX_LINES;

    // 渲染全部行；折叠时超出 MAX_LINES 的行以 inline style 隐藏。
    // 「展开全部」按钮由 ChatMessages 的委托点击处理器揭示 —
    // 不能依赖 inline onclick（CSP 可禁用；旧实现引用的 DOM 节点也不存在）。
    const linesHtml = diffLines
      .map((d, i) => {
        const hidden = collapsed && i >= MAX_LINES ? ' style="display:none"' : '';
        return `<div class="diff-line ${d.kind}"${hidden}>${d.prefix}${escapeHtml(d.text)}</div>`;
      })
      .join('');

    let html = headerHtml;
    html += `<div class="diff-lines">${linesHtml}</div>`;
    if (collapsed) {
      html += `<button class="diff-collapsed">展开全部 (${totalLines} 行)</button>`;
    }
    return html;
  }

  // 兜底：显示完整 body，检测 + / - 行
  const lines = body.split('\n');
  if (lines.length > MAX_LINES) {
    const linesHtml = lines
      .map((l, i) => {
        const hidden = i >= MAX_LINES ? ' style="display:none"' : '';
        if (l.startsWith('+')) return `<div class="diff-line diff-added"${hidden}>${escapeHtml(l)}</div>`;
        if (l.startsWith('-')) return `<div class="diff-line diff-removed"${hidden}>${escapeHtml(l)}</div>`;
        return `<div class="diff-line"${hidden}>${escapeHtml(l)}</div>`;
      })
      .join('');
    return (
      headerHtml +
      `<div class="diff-lines">${linesHtml}</div>` +
      `<button class="diff-collapsed">展开全部 (${lines.length} 行)</button>`
    );
  }
  return headerHtml + `<pre><code>${escapeHtml(body)}</code></pre>`;
}

// ═══════════════════════════════════════════════════════════════════
// computeSimpleDiff
// ═══════════════════════════════════════════════════════════════════

/** 计算简单的逐行 diff — 标记新增/删除行。ponytail: O(n*m)，适用于 <100 行。 */
export function computeSimpleDiff(
  oldLines: string[],
  newLines: string[],
): Array<{ kind: string; prefix: string; text: string }> {
  // 基于 LCS 的 diff
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // 回溯
  const result: Array<{ kind: string; prefix: string; text: string }> = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ kind: '', prefix: ' ', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ kind: 'diff-added', prefix: '+', text: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ kind: 'diff-removed', prefix: '-', text: oldLines[i - 1] });
      i--;
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// 数据流内联卡片接口
// ═══════════════════════════════════════════════════════════════════

interface DfScope {
  name: string;
  reads: string[];
  writes: string[];
  triggers: string[];
  awaits_callbacks: string[];
  sequence_calls: string[];
}

interface DfShared {
  var: string;
  readers: string[];
  writers: string[];
}

interface DfFileResult {
  file: string;
  error?: string;
  scopes?: DfScope[];
  shared?: DfShared[];
}

// ═══════════════════════════════════════════════════════════════════
// formatDataflowCard
// ═══════════════════════════════════════════════════════════════════

function formatDataflowCard(text: string): string | null {
  let data: { results: DfFileResult[] };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data?.results?.length) return null;

  const ico = (n: string, s?: number) => iconHtml(n, s ?? 13);
  let html = '<div class="df-card">';
  for (const fr of data.results) {
    html += '<div class="df-file">';
    html += `<div class="df-file-hdr">${ico('file')} ${escapeHtml(fr.file)}</div>`;

    if (fr.error) {
      html += `<div class="df-empty">${ico('alert-circle')} ${escapeHtml(fr.error)}</div>`;
      html += '</div>';
      continue;
    }

    const scopes = fr.scopes || [];
    for (const s of scopes) {
      html += '<div class="df-scope">';
      html += `<div class="df-scope-name">${ico('code', 14)} ${escapeHtml(s.name)}</div>`;

      // 双列布局：读取（入）| 写入（出）
      const hasReads = s.reads && s.reads.length > 0;
      const hasWrites = s.writes && s.writes.length > 0;
      if (hasReads || hasWrites) {
        html += '<div class="df-rw-row">';
        html += '<div class="df-rw-col df-rw-in">';
        html += `<span class="df-label">${ico('arrow-down', 11)} 读取</span>`;
        if (hasReads) {
          for (const v of s.reads) {
            html += `<span class="df-tag df-tag-read">${escapeHtml(v)}</span>`;
          }
        } else {
          html += '<span class="df-tag-none">—</span>';
        }
        html += '</div>';
        html += '<div class="df-rw-col df-rw-out">';
        html += `<span class="df-label">${ico('arrow-up', 11)} 写入</span>`;
        if (hasWrites) {
          for (const v of s.writes) {
            html += `<span class="df-tag df-tag-write">${escapeHtml(v)}</span>`;
          }
        } else {
          html += '<span class="df-tag-none">—</span>';
        }
        html += '</div>';
        html += '</div>';
      }

      // 调用链
      if (s.sequence_calls && s.sequence_calls.length > 0) {
        html += '<div class="df-flow">';
        html += `<span class="df-label">${ico('arrow-right', 11)} 调用链</span>`;
        for (let i = 0; i < s.sequence_calls.length; i++) {
          if (i > 0) html += '<span class="df-flow-arrow">→</span>';
          html += `<span class="df-flow-item">${escapeHtml(s.sequence_calls[i])}</span>`;
        }
        html += '</div>';
      }

      // 触发与等待
      const hasTriggers = s.triggers && s.triggers.length > 0;
      const hasAwaits = s.awaits_callbacks && s.awaits_callbacks.length > 0;
      if (hasTriggers || hasAwaits) {
        html += '<div class="df-async-row">';
        html += '<div class="df-async-col">';
        html += `<span class="df-label">${ico('zap', 11)} 触发</span>`;
        if (hasTriggers) {
          for (const t of s.triggers) {
            html += `<span class="df-tag df-tag-trigger">${escapeHtml(t)}</span>`;
          }
        } else {
          html += '<span class="df-tag-none">—</span>';
        }
        html += '</div>';
        html += '<div class="df-async-col">';
        html += `<span class="df-label">${ico('hourglass', 11)} 等待</span>`;
        if (hasAwaits) {
          for (const cb of s.awaits_callbacks) {
            html += `<span class="df-tag df-tag-await">${escapeHtml(cb)}</span>`;
          }
        } else {
          html += '<span class="df-tag-none">—</span>';
        }
        html += '</div>';
        html += '</div>';
      }

      html += '</div>'; // .df-scope
    }

    // 共享状态 — 迷你表格
    const shared = fr.shared || [];
    if (shared.length > 0) {
      html += '<div class="df-shared">';
      html += `<div class="df-shared-title">${ico('layers')} 跨函数共享状态</div>`;
      html += '<div class="df-shared-table">';
      html += '<div class="df-shared-th"><span>变量</span><span>读取方</span><span>写入方</span></div>';
      for (const sh of shared) {
        html += '<div class="df-shared-tr">';
        html += `<span class="df-shared-var">${escapeHtml(sh.var)}</span>`;
        html += `<span>${(sh.readers || []).map(escapeHtml).join(', ') || '—'}</span>`;
        html += `<span>${(sh.writers || []).map(escapeHtml).join(', ') || '—'}</span>`;
        html += '</div>';
      }
      html += '</div></div>';
    }

    if (!scopes.length && !shared.length) {
      html += '<div class="df-empty">未检测到数据流（无函数作用域或跨函数共享变量）</div>';
    }

    html += '</div>'; // .df-file
  }
  html += '</div>';
  return html;
}

// ═══════════════════════════════════════════════════════════════════
// formatToolResult
// ═══════════════════════════════════════════════════════════════════

/** 格式化工具输出用于显示 — JSON 美化打印，代码高亮。 */
export function formatToolResult(toolName: string, text: string, truncated: boolean, args?: string): string {
  let body = text;
  if (truncated) body += '\n…[截断]…';

  // 工具收敛后模型调用领域工具（fs/shell/search/...）— 归一化回旧语义名匹配特殊渲染
  const name = resolveSemanticToolName(toolName, args);

  // ── trace_dataflow — 内联流程卡片 ──
  if (name === 'trace_dataflow') {
    const card = formatDataflowCard(text);
    if (card) return card;
  }

  // ── Glob / list_directory — 紧凑列表 ──
  // 注意：必须在 JSON 美化分支之前 — glob 输出本身是合法 JSON，
  // 否则会被美化分支截胡（收敛前即死代码）。
  if (name === 'glob') {
    try {
      const data = JSON.parse(text);
      const lines = (data.results || []).map((r: any) => `<span class="glob-entry">📄 ${escapeHtml(r.path)}</span>`);
      const header = `<div class="glob-summary">${data.count} 个文件${data.truncated ? ' (结果已截断)' : ''}</div>`;
      return (
        header +
        (lines.length > 30
          ? lines.slice(0, 30).join('\n') + `\n<div class="glob-truncated">… 及其他 ${lines.length - 30} 个结果</div>`
          : lines.join('\n'))
      );
    } catch {
      return escapeHtml(body);
    }
  }

  // ── JSON：美化打印到代码块 ──
  try {
    const parsed = JSON.parse(body);
    const formatted = JSON.stringify(parsed, null, 2);
    return `<pre><code class="language-json">${escapeHtml(formatted)}</code></pre>`;
  } catch {}

  // ── 空或极短 ──
  if (!body.trim()) return escapeHtml('(无输出)');
  if (body.length < 60 && !body.includes('\n')) return escapeHtml(body);

  // ── edit_file / write_file / read_file_content 的 diff 视图（第 7 项）──
  if (
    name === 'edit_file' ||
    name === 'write_file' ||
    name === 'write_file_content' ||
    name === 'read_file_content'
  ) {
    return formatDiffResult(body, args);
  }

    // ── 代码：run_shell、bash_output、bash_wait → 代码块 ──
  if (name === 'run_shell' || name === 'bash_output' || name === 'bash_wait') {
    return `<pre><code class="language-bash">${escapeHtml(body)}</code></pre>`;
  }
  if (name === 'search_content') {
    return `<pre><code>${escapeHtml(body)}</code></pre>`;
  }

  // ── 默认：渲染为 markdown（支持表格、列表等）──
  try {
    const html = DOMPurify.sanitize(marked.parse(body) as string);
    if (html && html !== body) return html;
  } catch {}
  return escapeHtml(body);
}