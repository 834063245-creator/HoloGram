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
import { listen } from '../bridge';
import { typedRpc } from '../rpc-contract';
import { getWorkspaceEpoch, isCurrentEpoch } from '../workspace-scope';

const lspSessions = new Map<string, number>(); // 语言 → session_id
let completionProviders: IDisposable[] = [];
let hoverProviders: IDisposable[] = [];
let definitionProviders: IDisposable[] = [];
let referenceProviders: IDisposable[] = [];
let unlistenDiagnostics: (() => void) | null = null; // 诊断监听器 — 重复注册先注销（H1 幂等化）

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

/** 将 URI 或文件路径归一到全路径形式（去掉 file:// 前缀 + 统一斜杠）用于精确比较。 */
function normalizeDiagnosticPath(p: string): string {
  return p
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

/** 获取文件的缓存 LSP 诊断（URI 或文件路径）。 */
export function getDiagnosticsForFile(fileUriOrPath: string): LspDiagnostic[] {
  // 先尝试精确匹配，再全路径归一比较。不做 basename 尾匹配 ——
  // 同名不同目录文件会跨项目串味（landmine-map H1）。
  if (diagnosticsCache.has(fileUriOrPath)) {
    return diagnosticsCache.get(fileUriOrPath)!;
  }
  const normalized = normalizeDiagnosticPath(fileUriOrPath);
  for (const [key, val] of diagnosticsCache) {
    if (normalizeDiagnosticPath(key) === normalized) {
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

// ── LSP 响应形状（Tauri invoke 自动解析 JSON，运行时为对象）──

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspCompletionItem {
  label?: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  textEdit?: { newText: string; range?: LspRange };
}
interface LspCompletionList {
  items: LspCompletionItem[];
  isIncomplete?: boolean;
}
interface LspMarkupContent {
  value?: string;
}
interface LspLocation {
  uri?: string;
  range?: LspRange;
}
interface LspDiagnosticPayload {
  severity?: number;
  message: string;
  range: LspRange;
  source?: string;
  code?: string | number;
}

/** 契约层 lsp_request 声明 result 为 string，但 Tauri invoke 自动解析 JSON —
 *  运行时实际是对象。此函数仅做类型边界标注（运行时直通），不改变既有行为。 */
function lspPayload<T>(raw: string): T {
  return raw as unknown as T;
}

function mapCompletionItem(item: LspCompletionItem, monaco: typeof import('monaco-editor')): languages.CompletionItem {
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

/** 查询某语言的 LSP 会话 ID（单一事实源 — file-viewer 不再自建第二张会话表，H2）。
 *  返回 undefined 表示该语言当前无会话（未启动 / 已被 stopAllLsp 清掉）。 */
export function getLspSession(language: string): number | undefined {
  return lspSessions.get(language);
}

export async function startLsp(language: string, rootUri: string): Promise<number | null> {
  if (lspSessions.has(language)) return lspSessions.get(language)!;
  // 代际防护（H2）：startLsp 在途期间可能切换工作区 —
  // 过期 resolve 的 sid 属于旧项目，直接 lsp_stop 丢弃，防把 A 项目文件发进 B 的 tsserver。
  const epoch = getWorkspaceEpoch();
  try {
    const sid = Number(await typedRpc('lsp_start', { language, root_uri: rootUri }));
    if (!isCurrentEpoch(epoch)) {
      await typedRpc('lsp_stop', { session_id: sid }).catch(() => {});
      return null;
    }
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
  typedRpc('lsp_request', {
    session_id: sessionId,
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri, languageId: language, version: 1, text },
    },
  }).catch(() => {});
}

/** 通知 LSP 文档已变更。从 model.onDidChangeContent 调用。 */
export function didChange(sessionId: number, uri: string, text: string): void {
  typedRpc('lsp_request', {
    session_id: sessionId,
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: Date.now() },
      contentChanges: [{ text }],
    },
  }).catch(() => {});
}

/** 通知 LSP 文档已关闭。关闭标签页时调用。 */
export function didClose(sessionId: number, uri: string): void {
  typedRpc('lsp_request', {
    session_id: sessionId,
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
    await typedRpc('lsp_stop', { session_id: sid }).catch(() => {});
  }
  lspSessions.clear();
  // 切换工作区后旧项目的诊断缓存/静默提示不得带入新项目（landmine-map H1）
  diagnosticsCache.clear();
  lspWarned.clear();
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
        // 注：Rust 侧 lsp_request 经 ok_json 返回 JSON 字符串，此处按对象消费是既有行为
        // （潜在 parse 缺失属 LSP 功能专项，不在本批次行为改动范围）
        const result = lspPayload<LspCompletionItem[] | LspCompletionList>(
          await typedRpc('lsp_request', {
            session_id: sessionId,
            method: 'textDocument/completion',
            params: {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            },
          }),
        );
        // result 是 JSON-RPC 的 `result` 字段 — CompletionItem[] 或 CompletionList
        if (!result) return { suggestions: [] };

        const items: LspCompletionItem[] = Array.isArray(result) ? result : result.items || [];
        const isIncomplete = !Array.isArray(result) ? result.isIncomplete : undefined;

        return {
          suggestions: items.map((item) => mapCompletionItem(item, monaco)),
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
        const result = lspPayload<{
          contents?: string | LspMarkupContent | LspMarkupContent[];
          range?: LspRange;
        }>(
          await typedRpc('lsp_request', {
            session_id: sessionId,
            method: 'textDocument/hover',
            params: {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            },
          }),
        );
        // result 是 LSP Hover 结果：{ contents: ..., range: ... }
        if (result?.contents) {
          let value: string;
          if (typeof result.contents === 'string') {
            value = result.contents;
          } else if (!Array.isArray(result.contents) && result.contents.value) {
            value = result.contents.value;
          } else if (Array.isArray(result.contents)) {
            // MarkupContent[]
            value = result.contents.map((c) => c.value || '').join('\n\n---\n\n');
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
        const result = lspPayload<LspLocation | LspLocation[] | null>(
          await typedRpc('lsp_request', {
            session_id: sessionId,
            method: 'textDocument/definition',
            params: {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            },
          }),
        );
        // LSP 定义结果：Location | Location[] | null
        if (!result) return null;

        const locations: LspLocation[] = Array.isArray(result) ? result : [result];
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
        const result = lspPayload<LspLocation[] | null>(
          await typedRpc('lsp_request', {
            session_id: sessionId,
            method: 'textDocument/references',
            params: {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              context: { includeDeclaration: true },
            },
          }),
        );
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
  // 幂等化：编辑器随面板重建会重复调用本函数，重复注册会让监听器叠加（H1）。
  // 重新注册前先注销旧监听器。
  unlistenDiagnostics?.();
  unlistenDiagnostics = null;
  void listen<{
    session_id: number;
    message: { method?: string; params?: { uri: string; diagnostics: LspDiagnosticPayload[] } };
  }>('lsp-message', (event) => {
    const msg = event.payload.message;
    if (msg?.method !== 'textDocument/publishDiagnostics') return;
    const params = msg.params;
    if (!params?.uri || !params?.diagnostics) return;

    const markers: editor.IMarkerData[] = params.diagnostics.map((d) => ({
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
      params.diagnostics.map((d) => ({
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
  })
    .then((unlisten) => {
      unlistenDiagnostics = unlisten;
    })
    .catch(() => {});
}

/** 释放所有已注册的 provider。 */
export function disposeProviders(): void {
  for (const p of completionProviders) p.dispose();
  completionProviders = [];
}
