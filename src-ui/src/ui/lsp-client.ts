// LSP Client — bridges Monaco editor to language servers via Tauri IPC.
// Phase A: Python (pyright), Rust (rust-analyzer), Go (gopls), TS/JS (tsserver).
//
// Response flow:
//   lsp_request (non-notification) → Rust waits for JSON-RPC response →
//     extracts `result` field → returns to caller.
//   Notifications (didOpen/didChange) → fire-and-forget.
//   Server-push notifications (publishDiagnostics) → lsp-message event.

import { invoke, listen } from '../bridge';
import type { editor, languages, IRange, IDisposable } from 'monaco-editor';

let lspSessions = new Map<string, number>(); // language -> session_id
let completionProviders: IDisposable[] = [];

// ── LSP → Monaco CompletionItemKind mapping ──
// LSP enum values differ from Monaco/VS Code numbering.
const LSP_TO_MONACO_KIND: Record<number, number> = {
  1: 18,  // Text
  2: 0,   // Method
  3: 1,   // Function
  4: 2,   // Constructor
  5: 3,   // Field
  6: 4,   // Variable
  7: 5,   // Class
  8: 7,   // Interface
  9: 8,   // Module
  10: 9,  // Property
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
  22: 6,  // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};

function mapCompletionItem(item: any, monaco: typeof import('monaco-editor')): languages.CompletionItem {
  const kind: languages.CompletionItemKind | undefined =
    item.kind != null ? (LSP_TO_MONACO_KIND[item.kind] ?? item.kind) : undefined;

  // Convert LSP textEdit to Monaco insertText + range
  let insertText: string | undefined;
  let range: IRange | { insert: IRange; replace: IRange } | undefined;
  if (item.textEdit) {
    const te = item.textEdit;
    insertText = te.newText;
    if (te.range) {
      const r = te.range;
      range = new monaco.Range(
        r.start.line + 1, r.start.character + 1,
        r.end.line + 1, r.end.character + 1,
      );
    }
  }

  // Convert LSP documentation to Monaco markdown
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
    ...(item.additionalTextEdits || item.command ? {} : {}),
  } as languages.CompletionItem;
}

const lspWarned = new Set<string>();

export async function startLsp(language: string, rootUri: string): Promise<number | null> {
  if (lspSessions.has(language)) return lspSessions.get(language)!;
  try {
    const sid = await invoke<number>('lsp_start', { language, rootUri });
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

/** Notify LSP that a document is open. Call when opening a file in Monaco. */
export function didOpen(sessionId: number, uri: string, language: string, text: string): void {
  invoke('lsp_request', {
    sessionId,
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri, languageId: language, version: 1, text },
    },
  }).catch(() => {});
}

/** Notify LSP that a document changed. Call from model.onDidChangeContent. */
export function didChange(sessionId: number, uri: string, text: string): void {
  invoke('lsp_request', {
    sessionId,
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: Date.now() },
      contentChanges: [{ text }],
    },
  }).catch(() => {});
}

/** Register Monaco completion provider backed by LSP (synchronous response). */
export function registerCompletionProvider(
  lang: string,
  sessionId: number,
  monaco: typeof import('monaco-editor'),
): void {
  const provider = monaco.languages.registerCompletionItemProvider(lang, {
    provideCompletionItems: async (model, position) => {
      try {
        const result = await invoke<any>('lsp_request', {
          sessionId,
          method: 'textDocument/completion',
          params: {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          },
        });
        // result is the JSON-RPC `result` field — either CompletionItem[] or CompletionList
        if (!result) return { suggestions: [] };

        const items: any[] = Array.isArray(result) ? result : (result.items || []);
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

/** Register Monaco hover provider backed by LSP. */
export function registerHoverProvider(
  lang: string,
  sessionId: number,
  monaco: typeof import('monaco-editor'),
): void {
  monaco.languages.registerHoverProvider(lang, {
    provideHover: async (model, position) => {
      try {
        const result = await invoke<any>('lsp_request', {
          sessionId,
          method: 'textDocument/hover',
          params: {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          },
        });
        // result is the LSP Hover result: { contents: ..., range: ... }
        if (result?.contents) {
          let value: string;
          if (typeof result.contents === 'string') {
            value = result.contents;
          } else if (result.contents.value) {
            value = result.contents.value;
          } else if (Array.isArray(result.contents)) {
            // MarkupContent[]
            value = result.contents
              .map((c: any) => c.value || '')
              .join('\n\n---\n\n');
          } else {
            value = JSON.stringify(result.contents);
          }
          const hoverRange = result.range ? new monaco.Range(
            result.range.start.line + 1, result.range.start.character + 1,
            result.range.end.line + 1, result.range.end.character + 1,
          ) : undefined;
          return { contents: [{ value }], range: hoverRange };
        }
      } catch (e) {
        console.warn('[LSP] hover error:', e);
      }
      return null;
    },
  });
}

/** Register Monaco definition provider backed by LSP. */
export function registerDefinitionProvider(
  lang: string,
  sessionId: number,
  monaco: typeof import('monaco-editor'),
): void {
  monaco.languages.registerDefinitionProvider(lang, {
    provideDefinition: async (model, position) => {
      try {
        const result = await invoke<any>('lsp_request', {
          sessionId,
          method: 'textDocument/definition',
          params: {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          },
        });
        // LSP definition result: Location | Location[] | null
        if (!result) return null;

        const locations: any[] = Array.isArray(result) ? result : [result];
        const links: languages.Location[] = [];
        for (const loc of locations) {
          if (!loc?.uri) continue;
          const range = loc.range;
          links.push({
            uri: monaco.Uri.parse(loc.uri),
            range: range ? new monaco.Range(
              range.start.line + 1, range.start.character + 1,
              range.end.line + 1, range.end.character + 1,
            ) : new monaco.Range(1, 1, 1, 1),
          });
        }
        return links.length > 0 ? links : null;
      } catch (e) {
        console.warn('[LSP] definition error:', e);
      }
      return null;
    },
  });
}

/** Register Monaco references provider backed by LSP. */
export function registerReferencesProvider(
  lang: string,
  sessionId: number,
  monaco: typeof import('monaco-editor'),
): void {
  monaco.languages.registerReferenceProvider(lang, {
    provideReferences: async (model, position, _context) => {
      try {
        const result = await invoke<any>('lsp_request', {
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
            range: range ? new monaco.Range(
              range.start.line + 1, range.start.character + 1,
              range.end.line + 1, range.end.character + 1,
            ) : new monaco.Range(1, 1, 1, 1),
          });
        }
        return locations.length > 0 ? locations : null;
      } catch (e) {
        console.warn('[LSP] references error:', e);
      }
      return null;
    },
  });
}

/** Listen for LSP diagnostics and apply markers to the editor. */
export function listenForDiagnostics(
  monacoEditor: editor.IStandaloneCodeEditor,
  monaco: typeof import('monaco-editor'),
): void {
  listen<{ session_id: number; message: any }>('lsp-message', (event) => {
    const msg = (event as any).payload?.message;
    if (!msg || msg.method !== 'textDocument/publishDiagnostics') return;
    const params = msg.params;
    if (!params?.uri || !params?.diagnostics) return;

    const markers: editor.IMarkerData[] = params.diagnostics.map((d: any) => ({
      severity: d.severity === 1 ? monaco.MarkerSeverity.Error
        : d.severity === 2 ? monaco.MarkerSeverity.Warning
        : d.severity === 3 ? monaco.MarkerSeverity.Info
        : monaco.MarkerSeverity.Hint,
      message: d.message,
      startLineNumber: (d.range.start.line || 0) + 1,
      startColumn: (d.range.start.character || 0) + 1,
      endLineNumber: (d.range.end.line || 0) + 1,
      endColumn: (d.range.end.character || 0) + 1,
    }));

    const uri = monaco.Uri.parse(params.uri);
    const model = monaco.editor.getModel(uri);
    if (model) {
      monaco.editor.setModelMarkers(model, 'lsp', markers);
    }
  }).catch(() => {});
}

/** Dispose all registered providers. */
export function disposeProviders(): void {
  for (const p of completionProviders) p.dispose();
  completionProviders = [];
}
