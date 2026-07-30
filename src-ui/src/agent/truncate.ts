// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具输出截断 — 限制发送给 LLM 的工具结果大小。
//
// 双重限制：50KB 或 2000 行，先到先截。
// - truncateHead: 保留开头（文件读取、搜索结果）
// - truncateTail: 保留末尾（shell 输出 — 错误通常在底部）
//
// 不依赖运行时环境：使用手动 UTF-8 字节计数，无 Node Buffer 依赖。
// 改编自 pi 的 harness/utils/truncate.ts（agent 包版本）。

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
  /** 截断后的内容 */
  content: string;
  /** 是否发生了截断 */
  truncated: boolean;
  /** 命中的限制类型："lines"、"bytes"，未截断则为 null */
  truncatedBy: 'lines' | 'bytes' | null;
  /** 原始内容的总行数 */
  totalLines: number;
  /** 原始内容的总字节数 */
  totalBytes: number;
  /** 截断输出中的完整行数 */
  outputLines: number;
  /** 截断输出的字节数 */
  outputBytes: number;
  /** 最后一行是否被部分截断（尾部截断的边界情况） */
  lastLinePartial: boolean;
  /** 第一行是否超出字节限制（头部截断的边界情况） */
  firstLineExceedsLimit: boolean;
  /** 应用的最大行数限制 */
  maxLines: number;
  /** 应用的最大字节数限制 */
  maxBytes: number;
}

export interface TruncationOptions {
  /** 最大行数（默认: 2000） */
  maxLines?: number;
  /** 最大字节数（默认: 50KB） */
  maxBytes?: number;
}

// ── 不使用 Node Buffer 的 UTF-8 字节长度计算 ──

const nonAsciiPattern = /[^\x00-\x7f]/;

function utf8ByteLength(content: string): number {
  // Browser/WebView: 无 Buffer.byteLength — 手动计算
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

// ── formatSize ── 格式化字节大小

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

// ── truncateHead — 保留开头（用于文件读取、搜索结果） ──

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

  // 第一行单独就超出字节限制
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

// ── truncateTail — 保留末尾（用于 shell 输出，错误通常在底部） ──

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
      // 边界情况：单行超出 maxBytes — 取末尾（部分截断）
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

// ── truncateStringToBytesFromEnd 从末尾截断字符串到指定字节数 ──

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

// ── 工具专用截断 ──

/** 输出应从尾部截断（保留末尾）的工具。
 *  Shell 命令的错误/结果在末尾产生。 */
const TAIL_TOOLS = new Set(['run_shell', 'bash_output', 'bash_wait']);

/** 截断工具输出，根据工具名选择头部或尾部截断。
 *  返回（可能已截断的）内容及是否发生了截断。
 *  截断时追加一行提示说明被裁剪的内容。 */
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

  // 构建截断提示
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
