// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LSP 客户端 — 通过 Tauri IPC 将 Monaco 编辑器桥接到语言服务器。
// 阶段 A：Python（pyright）、Rust（rust-analyzer）、Go（gopls）、TS/JS（tsserver）。
//
// 响应流程：
//   lsp_request（非通知）→ Rust 等待 JSON-RPC 响应 →
//     提取 `result` 字段 → 返回给调用方。
//   通知（didOpen/didChange）→ 发后即忘。
//   服务端推送通知（publishDiagnostics）→ lsp-message 事件。

import type { editor, IDisposable, IRange, languages } from 'monaco-editor';
import { listen, rpc } from '../bridge';

const lspSessions = new Map<string, number>(); // 语言 → session_id
let completionProviders: IDisposable[] = [];
let hoverProviders: IDisposable[] = [];
let definitionProviders: IDisposable[] = [];
let referenceProviders: IDisposable[] = [];

// ── 诊断缓存 — 由 LSP 推送填充，供 agent 状态钩子查询 ──

export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  source?: string;
  code?: string | number;
}

const diagnosticsCache = new Map<string, LspDiagnostic[]>();

/** 获取文件的缓存 LSP 诊断（URI 或文件路径）。 */
export function getDiagnosticsForFile(fileUriOrPath: string): LspDiagnostic[] {
  // 先尝试精确匹配，再归一化
  if (diagnosticsCache.has(fileUriOrPath)) {
    return diagnosticsCache.get(fileUriOrPath)!;
  }
  const normalized = fileUriOrPath.replace(/\\/g, '/');
  for (const [key, val] of diagnosticsCache) {
    const keyNorm = key.replace(/\\/g, '/');
    if (keyNorm === normalized || keyNorm.endsWith('/' + normalized.split('/').pop()!)) {
      return val;
    }
  }
  return [];
}

// ── LSP → Monaco CompletionItemKind 映射 ──
// LSP 枚举值与 Monaco/VS Code 编号不同。
const LSP_TO_MONACO_KIND: Record<number, number> = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 27, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};

function mapCompletionItem(item: any, monaco: typeof import('monaco-editor')): languages.CompletionItem {
  const kind: languages.CompletionItemKind | undefined =
    item.kind != null ? (LSP_TO_MONACO_KIND[item.kind] ?? item.kind) : undefined;

  // 将 LSP textEdit 转换为 Monaco insertText + range
  let insertText: string | undefined;
  let range: IRange | { insert: IRange; replace: IRange } | undefined;
  if (item.textEdit) {
    const te = item.textEdit;
    insertText = te.newText;
    if (te.range) {
      const r = te.range;
      range = new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
    }
  }

  // 将 LSP documentation 转换为 Monaco markdown
  let documentation: string | undefined;
  if (typeof item.documentation === 'string') {
    documentation = item.documentation;
  } else if (item.documentation?.value) {
    documentation = item.documentation.value;
  }

  return {
    label: item.label || item.insertText || '',
    kind,
    detail: item.detail,
    documentation,
    sortText: item.sortText,
    filterText: item.filterText,
    insertText: insertText ?? item.insertText ?? item.label,
    range,
  } as languages.CompletionItem;
}

const lspWarned = new Set<string>();

export async function startLsp(language: string, rootUri: string): Promise<number | null> {
  if (lspSessions.has(language)) return lspSessions.get(language)!;
  try {
    const sid = await rpc<number>('lsp_start', { language, rootUri });
    lspSessions.set(language, sid);
    return sid;
  } catch {
    if (!lspWarned.has(language)) {
      lspWarned.add(language);
      console.warn(`[LSP] 未安装 ${language} language server（已静默后续同类提示）`);
    }
    return null;
  }
}

/** 通知 LSP 文档已打开。在 Monaco 中打开文件时调用。 */
export function didOpen(sessionId: number, uri: string, language: string, text: string): void {
  rpc('lsp_request', {
    sessionId,
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri, languageId: language, version: 1, text },
    },
  }).catch(() => {});
}

/** 通知 LSP 文档已变更。从 model.onDidChangeContent 调用。 */
export function didChange(sessionId: number, uri: string, text: string): void {
  rpc('lsp_request', {
    sessionId,
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: Date.now() },
      contentChanges: [{ text }],
    },
  }).catch(() => {});
}

/** 通知 LSP 文档已关闭。关闭标签页时调用。 */
export function didClose(sessionId: number, uri: string): void {
  rpc('lsp_request', {
    sessionId,
    method: 'textDocument/didClose',
    params: { textDocument: { uri } },
  }).catch(() => {});
}

/** 停止所有 LSP 会话并释放 provider。切换工作区时调用。 */
export async function stopAllLsp(): Promise<void> {
  for (const p of completionProviders) p.dispose();
  for (const p of hoverProviders) p.dispose();
  for (const p of definitionProviders) p.dispose();
  for (const p of referenceProviders) p.dispose();
  completionProviders = [];
  hoverProviders = [];
  definitionProviders = [];
  referenceProviders = [];
  for (const [_language, sid] of lspSessions) {
    await rpc('lsp_stop', { sessionId: sid }).catch(() => {});
  }
  lspSessions.clear();
}

/** 注册由 LSP 支持的 Monaco 补全 provider（同步响应）。 */
export function registerCompletionProvider(
  lang: string,
  sessionId: number,
  monaco: typeof import('monaco-editor'),
): void {
  const provider = monaco.languages.registerCompletionItemProvider(lang, {
    triggerCharacters: ['.', ':', '"', "'", '/', ' '],
    provideCompletionItems: async (model, position) => {
      try {
        const result = await rpc<any>('lsp_request', {
          sessionId,
          method: 'textDocument/completion',
          params: {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          },
        });
        // result 是 JSON-RPC 的 `result` 字段 — CompletionItem[] 或 CompletionList
        if (!result) return { suggestions: [] };

        const items: any[] = Array.isArray(result) ? result : result.items || [];
        const isIncomplete = !Array.isArray(result) ? result.isIncomplete : undefined;

        return {
          suggestions: items.map((item: any) => mapCompletionItem(item, monaco)),
          incomplete: isIncomplete,
        };
      } catch (e) {
        console.warn('[LSP] completion error:', e);
        return { suggestions: [] };
      }
    },
  });
  completionProviders.push(provider);
}

/** 注册由 LSP 支持的 Monaco hover provider。 */
export function registerHoverProvider(lang: string, sessionId: number, monaco: typeof import('monaco-editor')): void {
  const provider = monaco.languages.registerHoverProvider(lang, {
    provideHover: async (model, position) => {
      try {
        const result = await rpc<any>('lsp_request', {
          sessionId,
          method: 'textDocument/hover',
          params: {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          },
        });
        // result 是 LSP Hover 结果：{ contents: ..., range: ... }
        if (result?.contents) {
          let value: string;
          if (typeof result.contents === 'string') {
            value = result.contents;
          } else if (result.contents.value) {
            value = result.contents.value;
          } else if (Array.isArray(result.contents)) {
            // MarkupContent[]
            value = result.contents.map((c: any) => c.value || '').join('\n\n---\n\n');
          } else {
            value = JSON.stringify(result.contents);
          }
          const hoverRange = result.range
            ? new monaco.Range(
                result.range.start.line + 1,
                result.range.start.character + 1,
                result.range.end.line + 1,
                result.range.end.character + 1,
              )
            : undefined;
          return { contents: [{ value }], range: hoverRange };
        }
      } catch (e) {
        console.warn('[LSP] hover error:', e);
      }
      return null;
    },
  });
  hoverProviders.push(provider);
}

/** 注册由 LSP 支持的 Monaco 定义跳转 provider。 */
export function registerDefinitionProvider(
  lang: string,
  sessionId: number,
  monaco: typeof import('monaco-editor'),
): void {
  const provider = monaco.languages.registerDefinitionProvider(lang, {
    provideDefinition: async (model, position) => {
      try {
        const result = await rpc<any>('lsp_request', {
          sessionId,
          method: 'textDocument/definition',
          params: {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          },
        });
        // LSP 定义结果：Location | Location[] | null
        if (!result) return null;

        const locations: any[] = Array.isArray(result) ? result : [result];
        const links: languages.Location[] = [];
        for (const loc of locations) {
          if (!loc?.uri) continue;
          const range = loc.range;
          links.push({
            uri: monaco.Uri.parse(loc.uri),
            range: range
              ? new monaco.Range(
                  range.start.line + 1,
                  range.start.character + 1,
                  range.end.line + 1,
                  range.end.character + 1,
                )
              : new monaco.Range(1, 1, 1, 1),
          });
        }
        return links.length > 0 ? links : null;
      } catch (e) {
        console.warn('[LSP] definition error:', e);
      }
      return null;
    },
  });
  definitionProviders.push(provider);
}

/** 注册由 LSP 支持的 Monaco 引用查找 provider。 */
export function registerReferencesProvider(
  lang: string,
  sessionId: number,
  monaco: typeof import('monaco-editor'),
): void {
  const provider = monaco.languages.registerReferenceProvider(lang, {
    provideReferences: async (model, position, _context) => {
      try {
        const result = await rpc<any>('lsp_request', {
          sessionId,
          method: 'textDocument/references',
          params: {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            context: { includeDeclaration: true },
          },
        });
        if (!result || !Array.isArray(result)) return null;

        const locations: languages.Location[] = [];
        for (const loc of result) {
          if (!loc?.uri) continue;
          const range = loc.range;
          locations.push({
            uri: monaco.Uri.parse(loc.uri),
            range: range
              ? new monaco.Range(
                  range.start.line + 1,
                  range.start.character + 1,
                  range.end.line + 1,
                  range.end.character + 1,
                )
              : new monaco.Range(1, 1, 1, 1),
          });
        }
        return locations.length > 0 ? locations : null;
      } catch (e) {
        console.warn('[LSP] references error:', e);
      }
      return null;
    },
  });
  referenceProviders.push(provider);
}

/** 监听 LSP 诊断并应用到编辑器标记。 */
export function listenForDiagnostics(
  _monacoEditor: editor.IStandaloneCodeEditor,
  monaco: typeof import('monaco-editor'),
): void {
  listen<{ session_id: number; message: any }>('lsp-message', (event) => {
    const msg = (event as any).payload?.message;
    if (msg?.method !== 'textDocument/publishDiagnostics') return;
    const params = msg.params;
    if (!params?.uri || !params?.diagnostics) return;

    const markers: editor.IMarkerData[] = params.diagnostics.map((d: any) => ({
      severity:
        d.severity === 1
          ? monaco.MarkerSeverity.Error
          : d.severity === 2
            ? monaco.MarkerSeverity.Warning
            : d.severity === 3
              ? monaco.MarkerSeverity.Info
              : monaco.MarkerSeverity.Hint,
      message: d.message,
      startLineNumber: (d.range.start.line || 0) + 1,
      startColumn: (d.range.start.character || 0) + 1,
      endLineNumber: (d.range.end.line || 0) + 1,
      endColumn: (d.range.end.character || 0) + 1,
    }));

    // 填充诊断缓存供 agent 状态钩子使用（发后即忘）
    diagnosticsCache.set(
      params.uri,
      params.diagnostics.map((d: any) => ({
        severity: (d.severity === 1
          ? 'error'
          : d.severity === 2
            ? 'warning'
            : d.severity === 3
              ? 'info'
              : 'hint') as LspDiagnostic['severity'],
        message: d.message,
        startLine: d.range.start.line || 0,
        startColumn: d.range.start.character || 0,
        endLine: d.range.end.line || 0,
        endColumn: d.range.end.character || 0,
        source: d.source,
        code: d.code,
      })),
    );

    const uri = monaco.Uri.parse(params.uri);
    const model = monaco.editor.getModel(uri);
    if (model) {
      monaco.editor.setModelMarkers(model, 'lsp', markers);
    }
  }).catch(() => {});
}

/** 释放所有已注册的 provider。 */
export function disposeProviders(): void {
  for (const p of completionProviders) p.dispose();
  completionProviders = [];
}
