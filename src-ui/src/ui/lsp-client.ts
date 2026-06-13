// LSP Client — bridges Monaco editor to language servers via Tauri IPC.
// Phase A: Python (pyright) only. Phase B: rust-analyzer, gopls, tsserver.

import { invoke, listen } from '../bridge';
import type { editor, languages, IDisposable } from 'monaco-editor';

let lspSessions = new Map<string, number>(); // language -> session_id
let completionProviders: IDisposable[] = [];

export async function startLsp(language: string, rootUri: string): Promise<number | null> {
  if (lspSessions.has(language)) return lspSessions.get(language)!;
  try {
    const sid = await invoke<number>('lsp_start', { language, rootUri });
    lspSessions.set(language, sid);
    return sid;
  } catch {
    console.warn(`[LSP] 未安装 ${language} language server`);
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

/** Register Monaco completion provider backed by LSP. */
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
        // LSP completion response may come asynchronously via lsp-message event
        // For now, return empty and rely on async delivery
        return { suggestions: [] };
      } catch { return { suggestions: [] }; }
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
        if (result?.contents) {
          const contents = typeof result.contents === 'string'
            ? result.contents
            : result.contents.value || JSON.stringify(result.contents);
          return { contents: [{ value: contents }] };
        }
      } catch {}
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
        if (result?.uri) {
          const loc: languages.Location = {
            uri: monaco.Uri.parse(result.uri),
            range: result.range ? new monaco.Range(
              result.range.start.line + 1, result.range.start.character + 1,
              result.range.end.line + 1, result.range.end.character + 1,
            ) : new monaco.Range(1, 1, 1, 1),
          };
          return [loc];
        }
      } catch {}
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
