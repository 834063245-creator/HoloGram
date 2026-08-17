// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// provider 实现的共享工具函数 — 从 anthropic.ts 和 openai.ts 中提取

import { proxyFetch } from './transport';

/** 从流式 JSON 参数中提取 write/edit 工具的部分内容。
 *  处理不完整的 JSON — content 字符串可能尚未闭合。
 *  工具收敛后模型调用领域工具 fs(action=write/edit)：从部分参数中正则提取 action。 */
export function extractWritePreview(toolName: string, args: string): string | null {
  let isWrite = toolName === 'write_file' || toolName === 'write_file_content';
  let isEdit = toolName === 'edit_file';
  if (toolName === 'fs' && !isWrite && !isEdit) {
    const m = args.match(/"action"\s*:\s*"(write|edit)"/);
    if (m) {
      isWrite = m[1] === 'write';
      isEdit = m[1] === 'edit';
    }
  }
  if (!isWrite && !isEdit) return null;

  const key = isEdit ? 'newString' : 'content';
  // 正则从部分 JSON 中提取 "key": "..."。
  // 处理字符串值中的转义字符（\"、\\、\n 等）。
  const re = new RegExp(`"${key}"\\s*:\\s*"(.*)`, 's');
  const m = args.match(re);
  if (!m) return null;

  // 反转义 JSON 转义字符，使预览可读
  return (
    m[1]
      .replace(
        /\\(["\\/bfnrt])/g,
        (_, c: string) => ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[c] || c,
      )
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      // 去除尾部垃圾（部分 JSON 可能以 " 或 "} 结尾，也可能没有尾部内容）
      .replace(/"\s*\}?\s*$/, '')
  );
}

/** 通过短生命周期的请求预热 HTTP 连接池。尽力而为 — 失败静默处理。 */
export function prewarmEndpoint(url: string, headers: Record<string, string>): void {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 3000);
  proxyFetch(url, { headers, signal: ctrl.signal }).catch(() => {});
}

/** 带超时的 JSON 获取。任何失败均返回 null（非 ok、网络错误、超时）。 */
export async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown | null> {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await proxyFetch(url, { headers, signal: ctrl.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** SSE 事件基类型 — 各 provider 方言按 type 判别，其余字段由调用方接口细化。 */
export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/** 解析 SSE 流并 yield 解码后的 JSON 事件。处理 reader/decoder/buffer
 *  管理和尾部数据刷新。调用方按各 provider 格式处理每个事件。
 *
 *  边界（P0 定稿）：只解析单行 `data:` 事件——所有目标服务商
 *  （Anthropic/DeepSeek/Moonshot/Minimax/Qwen/OpenAI 兼容）均以单行
 *  data 发送 JSON，`[DONE]` 为流结束标记。不支持 `event:` 字段与
 *  多行 data（SSE 规范特性），无需求不做。 */
export async function* sseEvents<T extends SseEvent = SseEvent>(
  body: ReadableStream<Uint8Array>,
  name: string,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) throw new Error(`${name}: aborted`);
      const { done, value } = await reader.read();
      if (done) {
        // 刷新 decoder 内部状态并处理 buffer 中的尾部数据
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留不完整的最后一行

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          yield JSON.parse(data);
        } catch {}
      }
    }

    // 流结束后处理 buffer 中剩余的完整行
    if (buffer.trim()) {
      const remaining = buffer.split('\n').filter((l) => l.trim());
      for (const raw of remaining) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          yield JSON.parse(data);
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}
