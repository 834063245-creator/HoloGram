// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
  truncateToolOutput,
} from '../src/agent/truncate';

// ── Helpers ──

function makeLines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

function makeLargeContent(bytes: number): string {
  const chunk = 'x'.repeat(1000);
  let result = '';
  while (result.length < bytes) {
    result += chunk + '\n';
  }
  return result;
}

// ── formatSize ──

describe('formatSize', () => {
  it('formats bytes', () => {
    expect(formatSize(0)).toBe('0B');
    expect(formatSize(512)).toBe('512B');
    expect(formatSize(1023)).toBe('1023B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0KB');
    expect(formatSize(5120)).toBe('5.0KB');
    expect(formatSize(50 * 1024)).toBe('50.0KB');
  });

  it('formats megabytes', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0MB');
    expect(formatSize(2.5 * 1024 * 1024)).toBe('2.5MB');
  });
});

// ── truncateHead ──

describe('truncateHead', () => {
  it('returns content unchanged when within limits', () => {
    const content = makeLines(100);
    const result = truncateHead(content);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
    expect(result.totalLines).toBe(100);
  });

  it('truncates by line limit', () => {
    const content = makeLines(3000);
    const result = truncateHead(content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('lines');
    expect(result.outputLines).toBe(500);
    expect(result.totalLines).toBe(3000);
    expect(result.content).toContain('line 1');
    expect(result.content).toContain('line 500');
    expect(result.content).not.toContain('line 501');
  });

  it('truncates by byte limit', () => {
    const content = makeLargeContent(100 * 1024); // 100KB
    const result = truncateHead(content, { maxBytes: 10 * 1024 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.outputBytes).toBeLessThanOrEqual(10 * 1024);
    expect(result.totalBytes).toBeGreaterThan(10 * 1024);
  });

  it('returns empty when first line exceeds byte limit', () => {
    const hugeLine = 'x'.repeat(10000);
    const result = truncateHead(hugeLine, { maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.firstLineExceedsLimit).toBe(true);
    expect(result.content).toBe('');
    expect(result.outputLines).toBe(0);
  });

  it('handles empty content', () => {
    const result = truncateHead('');
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('');
    expect(result.totalLines).toBe(1); // ''.split('\n') === ['']
  });

  it('handles single line within limits', () => {
    const result = truncateHead('hello world');
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('hello world');
  });

  it('handles unicode content correctly', () => {
    // CJK characters are 3 bytes each in UTF-8
    const line = '你好世界'.repeat(100); // 600 chars, ~1800 bytes
    const content = line + '\n' + line + '\n' + line; // ~5400 bytes
    const result = truncateHead(content, { maxBytes: 2000 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.outputBytes).toBeLessThanOrEqual(2000);
  });

  it('respects both limits simultaneously (lines first)', () => {
    const content = makeLines(100);
    const result = truncateHead(content, { maxLines: 50, maxBytes: 50 * 1024 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('lines');
    expect(result.outputLines).toBe(50);
  });

  it('uses default limits when no options given', () => {
    expect(DEFAULT_MAX_LINES).toBe(2000);
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
    const content = makeLines(2001);
    const result = truncateHead(content);
    expect(result.truncated).toBe(true);
    expect(result.maxLines).toBe(2000);
    expect(result.maxBytes).toBe(50 * 1024);
  });
});

// ── truncateTail ──

describe('truncateTail', () => {
  it('returns content unchanged when within limits', () => {
    const content = makeLines(100);
    const result = truncateTail(content);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it('truncates by line limit, keeping the END', () => {
    const content = makeLines(3000);
    const result = truncateTail(content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.outputLines).toBe(500);
    expect(result.content).toContain('line 3000');
    expect(result.content).toContain('line 2501');
    expect(result.content).not.toContain('line 2500');
  });

  it('truncates by byte limit, keeping the END', () => {
    const content = makeLargeContent(100 * 1024);
    const result = truncateTail(content, { maxBytes: 10 * 1024 });
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(10 * 1024);
    // Tail should contain the last part of the content
    expect(result.content.endsWith('x')).toBe(true);
  });

  it('handles empty content', () => {
    const result = truncateTail('');
    expect(result.truncated).toBe(false);
  });

  it('handles single huge line (partial)', () => {
    const hugeLine = 'x'.repeat(10000);
    const result = truncateTail(hugeLine, { maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.lastLinePartial).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(1000);
  });

  it('keeps the last line when truncating', () => {
    const content = makeLines(3000);
    const result = truncateTail(content, { maxLines: 10 });
    expect(result.outputLines).toBe(10);
    expect(result.content).toContain('line 3000');
  });

  it('preserves correct line count without trailing newline', () => {
    const content = 'a\nb\nc\nd\ne';
    const result = truncateTail(content, { maxLines: 2 });
    expect(result.truncated).toBe(true);
    expect(result.content).toBe('d\ne');
    expect(result.outputLines).toBe(2);
  });
});

// ── truncateToolOutput ──

describe('truncateToolOutput', () => {
  it('returns content unchanged when within limits', () => {
    const content = makeLines(100);
    const result = truncateToolOutput('read_file_content', content);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it('uses head truncation for read_file_content', () => {
    const content = makeLines(3000);
    const result = truncateToolOutput('read_file_content', content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('line 1');
    expect(result.content).toContain('line 500');
    expect(result.content).not.toContain('line 501');
  });

  it('uses tail truncation for run_shell', () => {
    const content = makeLines(3000);
    const result = truncateToolOutput('run_shell', content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('line 3000');
    expect(result.content).toContain('line 2501');
    expect(result.content).not.toContain('line 2500');
  });

  it('uses tail truncation for bash_output', () => {
    const content = makeLines(3000);
    const result = truncateToolOutput('bash_output', content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('line 3000');
  });

  it('uses head truncation for search_content', () => {
    const content = makeLines(3000);
    const result = truncateToolOutput('search_content', content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('line 1');
    expect(result.content).not.toContain('line 501');
  });

  it('uses head truncation for glob', () => {
    const content = makeLines(3000);
    const result = truncateToolOutput('glob', content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('line 1');
  });

  it('uses head truncation for unknown tools', () => {
    const content = makeLines(3000);
    const result = truncateToolOutput('some_custom_tool', content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('line 1');
    expect(result.content).not.toContain('line 501');
  });

  it('appends truncation notice', () => {
    const content = makeLines(3000);
    const result = truncateToolOutput('read_file_content', content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[Output truncated:');
    expect(result.content).toContain('first 500 of 3000 lines');
  });

  it('appends notice for tail truncation', () => {
    const content = makeLines(3000);
    const result = truncateToolOutput('run_shell', content, { maxLines: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[Output truncated:');
    expect(result.content).toContain('last 500 of 3000 lines');
  });

  it('handles first line exceeds limit', () => {
    const hugeLine = 'x'.repeat(10000);
    const result = truncateToolOutput('read_file_content', hugeLine, { maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('first line exceeds');
  });

  it('respects custom byte limit', () => {
    const content = makeLargeContent(100 * 1024);
    const result = truncateToolOutput('read_file_content', content, { maxBytes: 5 * 1024 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('5.0KB limit');
  });

  it('does not truncate small outputs', () => {
    const content = 'short output';
    const result = truncateToolOutput('run_shell', content);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('short output');
    expect(result.content).not.toContain('[Output truncated');
  });
});
