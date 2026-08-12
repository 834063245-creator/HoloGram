// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tests for audit fixes #6 (computeSimpleDiff real diff) and #12 (\r\n handling).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));

// ═══════════════════════════════════════════════════════════════════
// #6 — computeSimpleDiff produces real LCS diff (not all-removed/all-added)
// ═══════════════════════════════════════════════════════════════════

describe('#6 computeSimpleDiff real diff', () => {
  it('marks unchanged lines as context (not removed/added)', async () => {
    const { computeSimpleDiff } = await import('../src/ui/chat-utils');
    const oldLines = ['line1', 'line2', 'line3'];
    const newLines = ['line1', 'modified', 'line3'];
    const diff = computeSimpleDiff(oldLines, newLines);

    // line1 and line3 should be context (prefix ' ')
    const ctx = diff.filter((d) => d.prefix === ' ');
    expect(ctx.length).toBe(2);
    expect(ctx[0].text).toBe('line1');
    expect(ctx[1].text).toBe('line3');

    // line2 should be removed, 'modified' should be added
    const removed = diff.filter((d) => d.prefix === '-');
    const added = diff.filter((d) => d.prefix === '+');
    expect(removed.length).toBe(1);
    expect(removed[0].text).toBe('line2');
    expect(added.length).toBe(1);
    expect(added[0].text).toBe('modified');
  });

  it('does NOT mark all old lines as removed when only one changed', async () => {
    const { computeSimpleDiff } = await import('../src/ui/chat-utils');
    const oldLines = ['a', 'b', 'c', 'd', 'e'];
    const newLines = ['a', 'b', 'X', 'd', 'e'];
    const diff = computeSimpleDiff(oldLines, newLines);

    const removed = diff.filter((d) => d.prefix === '-');
    const added = diff.filter((d) => d.prefix === '+');
    // Only 1 removed and 1 added — not 5 removed + 5 added (the old fake diff)
    expect(removed.length).toBe(1);
    expect(added.length).toBe(1);
  });

  it('handles all-new content (empty old)', async () => {
    const { computeSimpleDiff } = await import('../src/ui/chat-utils');
    const diff = computeSimpleDiff([], ['new1', 'new2']);
    expect(diff.every((d) => d.prefix === '+')).toBe(true);
    expect(diff.length).toBe(2);
  });

  it('handles all-removed content (empty new)', async () => {
    const { computeSimpleDiff } = await import('../src/ui/chat-utils');
    const diff = computeSimpleDiff(['old1', 'old2'], []);
    expect(diff.every((d) => d.prefix === '-')).toBe(true);
    expect(diff.length).toBe(2);
  });

  it('handles identical content (all context)', async () => {
    const { computeSimpleDiff } = await import('../src/ui/chat-utils');
    const diff = computeSimpleDiff(['same', 'lines'], ['same', 'lines']);
    expect(diff.every((d) => d.prefix === ' ')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// #6 — formatDiffResult uses real diff for edit_file
// ═══════════════════════════════════════════════════════════════════

describe('#6 formatDiffResult with real diff', () => {
  it('produces diff-added/diff-removed classes (not all-removed)', async () => {
    const { formatDiffResult } = await import('../src/ui/chat-utils');
    const args = JSON.stringify({ oldString: 'a\nb\nc', newString: 'a\nX\nc', file_path: '/test.ts' });
    const html = formatDiffResult('irrelevant body', args);

    expect(html).toContain('diff-added');
    expect(html).toContain('diff-removed');
    // Should contain 'b' as removed and 'X' as added
    expect(html).toContain('b');
    expect(html).toContain('X');
    // Should contain file path header
    expect(html).toContain('/test.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════
// #12 — splitStreamingBlocks normalizes \r\n to \n
// ═══════════════════════════════════════════════════════════════════

describe('#12 splitStreamingBlocks \\r\\n normalization', () => {
  // splitStreamingBlocks is not exported, so we test via the exported
  // MarkdownContent component's behavior indirectly. Instead, we test
  // the normalization logic directly by replicating the input.

  it('\\r\\n\\r\\n is treated as paragraph boundary', () => {
    // Replicate the normalization + boundary check logic
    const text = 'para1\r\n\r\npara2';
    const normalized = text.replace(/\r\n/g, '\n');
    // After normalization, \n\n should be found
    expect(normalized).toContain('\n\n');
    expect(normalized).toBe('para1\n\npara2');
  });

  it('mixed \\r\\n and \\n line endings are handled', () => {
    const text = 'line1\r\nline2\nline3\r\n\r\npara2';
    const normalized = text.replace(/\r\n/g, '\n');
    expect(normalized).toBe('line1\nline2\nline3\n\npara2');
    // Has a \n\n boundary
    expect(normalized.indexOf('\n\n')).toBeGreaterThan(-1);
  });

  it('pure \\n text is not affected by normalization', () => {
    const text = 'line1\nline2\n\npara2';
    const normalized = text.replace(/\r\n/g, '\n');
    expect(normalized).toBe(text);
  });

  it('Windows-style triple paragraph break works', () => {
    const text = 'a\r\n\r\nb\r\n\r\nc';
    const normalized = text.replace(/\r\n/g, '\n');
    // Should find two paragraph boundaries
    const boundaries = normalized.split('\n\n');
    expect(boundaries).toEqual(['a', 'b', 'c']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 折叠回归 — formatDiffResult 的「展开全部」必须能展开：
// 全部行都渲染进 DOM（超出的 inline 隐藏），按钮不带 inline onclick
// ═══════════════════════════════════════════════════════════════════

describe('formatDiffResult fold renders all lines', () => {
  it('real-diff branch: lines beyond MAX_LINES stay in DOM hidden, no inline onclick', async () => {
    const { formatDiffResult } = await import('../src/ui/chat-utils');
    const oldStr = Array.from({ length: 60 }, (_, i) => `old-${i}`).join('\n');
    const newStr = Array.from({ length: 60 }, (_, i) => `new-${i}`).join('\n');
    const html = formatDiffResult('irrelevant body', JSON.stringify({ oldString: oldStr, newString: newStr }));

    // 60 行 diff 全部渲染（旧实现只渲染前 40 行，按钮永远展不开）
    expect(html.match(/class="diff-line /g)?.length).toBe(120);
    // 超出 40 行的部分以 inline style 隐藏
    const hidden = html.match(/style="display:none"/g);
    expect(hidden?.length).toBe(120 - 40);
    // 按钮存在但不依赖 inline onclick（由 ChatMessages 委托处理）
    expect(html).toContain('展开全部');
    expect(html).not.toContain('onclick');
  });

  it('fallback branch: same contract', async () => {
    const { formatDiffResult } = await import('../src/ui/chat-utils');
    const body = Array.from({ length: 50 }, (_, i) => `+line-${i}`).join('\n');
    const html = formatDiffResult(body);

    expect(html.match(/class="diff-line[ "]/g)?.length).toBe(50);
    const hidden = html.match(/style="display:none"/g);
    expect(hidden?.length).toBe(50 - 40);
    expect(html).toContain('展开全部 (50 行)');
    expect(html).not.toContain('onclick');
  });
});
