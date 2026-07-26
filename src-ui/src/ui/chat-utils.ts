// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Utilities — pure static helper functions extracted from chat.ts
// No dependency on ChatPanel state. Safe to import from anywhere.

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { iconHtml } from './icons';

// ═══════════════════════════════════════════════════════════════════
// escapeHtml
// ═══════════════════════════════════════════════════════════════════

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════════
// formatDiffResult
// ═══════════════════════════════════════════════════════════════════

/** Simple line-based diff for edit_file results (item 7). */
export function formatDiffResult(body: string, argsJson?: string): string {
  // Extract file path from args if available
  let filePath = '';
  if (argsJson) {
    try {
      const args = JSON.parse(argsJson);
      filePath = args.file_path || args.path || '';
    } catch {}
  }

  // Try to extract old/new from args for real diff
  let oldStr = '';
  let newStr = '';
  if (argsJson) {
    try {
      const args = JSON.parse(argsJson);
      // Agent sends camelCase (tool.ts), but also handle snake_case from any legacy paths
      oldStr = args.oldString || args.old_string || args.old_text || args.oldText || '';
      newStr = args.newString || args.new_string || args.new_text || args.newText || args.content || '';
    } catch {}
  }

  const headerHtml = filePath ? `<div class="diff-header">📄 ${escapeHtml(filePath)}</div>` : '';
  const MAX_LINES = 40;

  if (oldStr && newStr) {
    // Real diff: compare old vs new
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const diffLines = computeSimpleDiff(oldLines, newLines);
    const totalLines = diffLines.length;
    const collapsed = totalLines > MAX_LINES;

    let html = headerHtml;
    const linesToShow = collapsed ? diffLines.slice(0, MAX_LINES) : diffLines;
    const visibleLines = collapsed
      ? linesToShow.map((d) => `<div class="diff-line ${d.kind}">${d.prefix}${escapeHtml(d.text)}</div>`).join('')
      : diffLines.map((d) => `<div class="diff-line ${d.kind}">${d.prefix}${escapeHtml(d.text)}</div>`).join('');

    html += `<div class="diff-lines${collapsed ? ' diff-folded' : ''}">${visibleLines}</div>`;
    if (collapsed) {
      html += `<button class="diff-collapsed" onclick="this.previousElementSibling.classList.remove('diff-folded');this.previousElementSibling.querySelectorAll('.diff-line').forEach(d=>d.style.display='');this.remove();">展开全部 (${totalLines} 行)</button>`;
    }
    return html;
  }

  // Fallback: show full body with + / - line detection
  const lines = body.split('\n');
  if (lines.length > MAX_LINES) {
    const visible = lines
      .slice(0, MAX_LINES)
      .map((l) => {
        if (l.startsWith('+')) return `<div class="diff-line diff-added">${escapeHtml(l)}</div>`;
        if (l.startsWith('-')) return `<div class="diff-line diff-removed">${escapeHtml(l)}</div>`;
        return `<div class="diff-line">${escapeHtml(l)}</div>`;
      })
      .join('');
    return (
      headerHtml +
      visible +
      `<button class="diff-collapsed" onclick="this.previousElementSibling.querySelectorAll('.diff-line').forEach(d=>d.style.display='');const next=this.nextElementSibling;if(next)next.style.display='';this.remove();">展开全部 (${lines.length} 行)</button>`
    );
  }
  return headerHtml + `<pre><code>${escapeHtml(body)}</code></pre>`;
}

// ═══════════════════════════════════════════════════════════════════
// computeSimpleDiff
// ═══════════════════════════════════════════════════════════════════

/** Compute simple line-by-line diff — marks added/removed lines. ponytail: O(n*m), fine for <100 lines. */
export function computeSimpleDiff(
  oldLines: string[],
  newLines: string[],
): Array<{ kind: string; prefix: string; text: string }> {
  // LCS-based diff
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
  // Backtrack
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
// Dataflow inline card interfaces
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

      // Two-column layout: reads (in) | writes (out)
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

      // Call chain
      if (s.sequence_calls && s.sequence_calls.length > 0) {
        html += '<div class="df-flow">';
        html += `<span class="df-label">${ico('arrow-right', 11)} 调用链</span>`;
        for (let i = 0; i < s.sequence_calls.length; i++) {
          if (i > 0) html += '<span class="df-flow-arrow">→</span>';
          html += `<span class="df-flow-item">${escapeHtml(s.sequence_calls[i])}</span>`;
        }
        html += '</div>';
      }

      // Triggers & awaits
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

    // Shared state — mini table
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

/** Format tool output for display — JSON gets pretty-printed, code gets highlighted. */
export function formatToolResult(toolName: string, text: string, truncated: boolean, args?: string): string {
  let body = text;
  if (truncated) body += '\n…[截断]…';

  // ── trace_dataflow — inline flow card ──
  if (toolName === 'trace_dataflow') {
    const card = formatDataflowCard(text);
    if (card) return card;
  }

  // ── JSON: pretty-print in code block ──
  try {
    const parsed = JSON.parse(body);
    const formatted = JSON.stringify(parsed, null, 2);
    return `<pre><code class="language-json">${escapeHtml(formatted)}</code></pre>`;
  } catch {}

  // ── Empty / very short ──
  if (!body.trim()) return escapeHtml('(无输出)');
  if (body.length < 60 && !body.includes('\n')) return escapeHtml(body);

  // ── Diff view for edit_file / write_file / read_file_content (item 7) ──
  if (
    toolName === 'edit_file' ||
    toolName === 'write_file' ||
    toolName === 'write_file_content' ||
    toolName === 'read_file_content'
  ) {
    return formatDiffResult(body, args);
  }

  // ── Code: run_shell, bash_output → code block ──
  if (toolName === 'run_shell' || toolName === 'bash_output') {
    return `<pre><code class="language-bash">${escapeHtml(body)}</code></pre>`;
  }
  if (toolName === 'search_content') {
    return `<pre><code>${escapeHtml(body)}</code></pre>`;
  }

  // ── Glob / list_directory — compact list ──
  if (toolName === 'glob') {
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

  // ── Hologram tools: try parsing as JSON (already handled above), fall through ──
  // ── Default: render as markdown (supports tables, lists, etc.) ──
  try {
    const html = DOMPurify.sanitize(marked.parse(body) as string);
    if (html && html !== body) return html;
  } catch {}
  return escapeHtml(body);
}
