// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Shared utilities for provider implementations — extracted from anthropic.ts and openai.ts

/** Extract partial content from streaming JSON args for write/edit tools.
 *  Handles incomplete JSON — the content string may not be closed yet. */
export function extractWritePreview(toolName: string, args: string): string | null {
  const isWrite = toolName === 'write_file' || toolName === 'write_file_content';
  const isEdit = toolName === 'edit_file';
  if (!isWrite && !isEdit) return null;

  const key = isEdit ? 'newString' : 'content';
  // regex extracts "key": "..." from partial JSON.
  // Handles escaped chars (\", \\, \n, etc.) inside the string value.
  const re = new RegExp(`"${key}"\\s*:\\s*"(.*)`, 's');
  const m = args.match(re);
  if (!m) return null;

  // Unescape JSON escapes so the preview is readable
  return (
    m[1]
      .replace(
        /\\(["\\/bfnrt])/g,
        (_, c: string) => ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[c] || c,
      )
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      // Strip trailing garbage (partial JSON may have " or "} or nothing trailing)
      .replace(/"\s*\}?\s*$/, '')
  );
}

/** Pre-warm HTTP connection pool with a short-lived request. Best-effort — failures are silent. */
export function prewarmEndpoint(url: string, headers: Record<string, string>): void {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 3000);
  fetch(url, { headers, signal: ctrl.signal }).catch(() => {});
}

/** Fetch JSON with a timeout. Returns null on any failure (non-ok, network error, timeout). */
export async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown | null> {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** Parse SSE stream and yield decoded JSON events. Handles reader/decoder/buffer
 *  management and trailing data flush. Caller processes each event per provider format. */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  name: string,
  signal?: AbortSignal,
): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) throw new Error(`${name}: aborted`);
      const { done, value } = await reader.read();
      if (done) {
        // Flush decoder internal state and process any trailing data in buffer
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete last line

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

    // Process any remaining complete lines in buffer after stream ends
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
