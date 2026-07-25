// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool output truncation — caps tool results sent to the LLM.
//
// Dual limit: 50KB or 2000 lines, whichever is hit first.
// - truncateHead: keep the beginning (file reads, search results)
// - truncateTail: keep the end (shell output — errors are at the bottom)
//
// Runtime-agnostic: uses manual UTF-8 byte counting, no Node Buffer dependency.
// Adapted from pi's harness/utils/truncate.ts (agent package version).

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
  /** The truncated content */
  content: string;
  /** Whether truncation occurred */
  truncated: boolean;
  /** Which limit was hit: "lines", "bytes", or null if not truncated */
  truncatedBy: 'lines' | 'bytes' | null;
  /** Total number of lines in the original content */
  totalLines: number;
  /** Total number of bytes in the original content */
  totalBytes: number;
  /** Number of complete lines in the truncated output */
  outputLines: number;
  /** Number of bytes in the truncated output */
  outputBytes: number;
  /** Whether the last line was partially truncated (tail truncation edge case) */
  lastLinePartial: boolean;
  /** Whether the first line exceeded the byte limit (head truncation edge case) */
  firstLineExceedsLimit: boolean;
  /** The max lines limit that was applied */
  maxLines: number;
  /** The max bytes limit that was applied */
  maxBytes: number;
}

export interface TruncationOptions {
  /** Maximum number of lines (default: 2000) */
  maxLines?: number;
  /** Maximum number of bytes (default: 50KB) */
  maxBytes?: number;
}

// ── UTF-8 byte length without Node Buffer ──

const nonAsciiPattern = /[^\x00-\x7f]/;

function utf8ByteLength(content: string): number {
  // Browser/WebView: no Buffer.byteLength — compute manually
  const firstNonAscii = content.search(nonAsciiPattern);
  if (firstNonAscii === -1) return content.length;

  let bytes = firstNonAscii;
  for (let i = firstNonAscii; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
      const next = content.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function replaceUnpairedSurrogates(content: string): string {
  let output = '';
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < content.length) {
        const next = content.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          output += content[i] + content[i + 1];
          i++;
          continue;
        }
      }
      output += '\uFFFD';
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += '\uFFFD';
    } else {
      output += content[i];
    }
  }
  return output;
}

// ── formatSize ──

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

// ── truncateHead — keep beginning (for file reads, search results) ──

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = utf8ByteLength(content);
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  // First line alone exceeds byte limit
  const firstLineBytes = utf8ByteLength(lines[0]);
  if (firstLineBytes > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i];
    const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }

    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines';
  }

  const outputContent = outputLinesArr.join('\n');
  const finalOutputBytes = utf8ByteLength(outputContent);

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

// ── truncateTail — keep end (for shell output, where errors are) ──

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = utf8ByteLength(content);
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  let lastLinePartial = false;

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      // Edge case: single line exceeds maxBytes — take the end (partial)
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLinesArr.unshift(truncatedLine);
        outputBytesCount = utf8ByteLength(truncatedLine);
        lastLinePartial = true;
      }
      break;
    }

    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines';
  }

  const outputContent = outputLinesArr.join('\n');
  const finalOutputBytes = utf8ByteLength(outputContent);

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

// ── truncateStringToBytesFromEnd ──

function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';

  let outputBytes = 0;
  let start = str.length;
  let needsReplacement = false;

  for (let i = str.length; i > 0; ) {
    let characterStart = i - 1;
    const code = str.charCodeAt(characterStart);
    let characterBytes: number;
    let unpairedSurrogate = false;

    if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
      const previous = str.charCodeAt(characterStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) {
        characterStart--;
        characterBytes = 4;
      } else {
        characterBytes = 3;
        unpairedSurrogate = true;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      characterBytes = 3;
      unpairedSurrogate = true;
    } else {
      characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }

    if (outputBytes + characterBytes > maxBytes) break;
    outputBytes += characterBytes;
    start = characterStart;
    needsReplacement ||= unpairedSurrogate;
    i = characterStart;
  }

  const output = str.slice(start);
  return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}

// ── Tool-specific truncation ──

/** Tools whose output should be truncated from the tail (keep end).
 *  Shell commands produce errors/results at the end. */
const TAIL_TOOLS = new Set(['run_shell', 'bash_output']);

/** Truncate tool output, choosing head or tail based on the tool name.
 *  Returns the (possibly truncated) content and whether truncation occurred.
 *  When truncated, a notice line is appended explaining what was cut. */
export function truncateToolOutput(
  toolName: string,
  content: string,
  options?: TruncationOptions,
): { content: string; truncated: boolean } {
  const useTail = TAIL_TOOLS.has(toolName);
  const result = useTail ? truncateTail(content, options) : truncateHead(content, options);

  if (!result.truncated) {
    return { content, truncated: false };
  }

  // Build truncation notice
  const direction = useTail ? 'last' : 'first';
  let notice: string;

  if (result.firstLineExceedsLimit) {
    notice = `[Output truncated: first line exceeds ${formatSize(result.maxBytes)} limit.]`;
  } else {
    const limitInfo =
      result.truncatedBy === 'lines'
        ? `${result.maxLines} line limit`
        : `${formatSize(result.maxBytes)} limit`;
    notice = `[Output truncated: showing ${direction} ${result.outputLines} of ${result.totalLines} lines (${limitInfo}).]`;
  }

  return {
    content: useTail ? result.content + '\n' + notice : result.content + '\n' + notice,
    truncated: true,
  };
}
