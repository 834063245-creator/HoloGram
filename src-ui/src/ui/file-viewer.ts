// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Floating File Viewer — 浮动文件窗口（标签页式 + Monaco 编辑器）
// 可从简报/详情卡片/聊天/时间轴中点击文件名呼出
// 支持拖拽移动、调整大小、多标签页、Ctrl+S 保存

import { invoke } from '../bridge';
import { iconHtml, iconSvg } from './icons';
import { askAgent } from './agent-visualizer';
import * as monaco from 'monaco-editor';

// ponytail: read CSS var once at init; user changes require reload
function getFontScale(): number {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim();
    return parseFloat(v) || 1;
  } catch { return 1; }
}
import { startLsp, didOpen, didChange, registerCompletionProvider, registerHoverProvider, registerDefinitionProvider, registerReferencesProvider, listenForDiagnostics } from './lsp-client';
import { FileTranslator } from './file-translator';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';

// Monaco workers — Vite ?worker syntax bundles them as separate chunks
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';

// LSP session cache: language -> session_id (shared across all FileViewer instances)
const lspSessions = new Map<string, number>();

// -- Monaco worker config --
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json': return new jsonWorker();
      case 'css': case 'scss': case 'less': return new cssWorker();
      case 'html': case 'handlebars': case 'razor': return new htmlWorker();
      case 'typescript': case 'javascript': return new tsWorker();
      default: return new editorWorker();
    }
  },
};

interface TabData {
  filePath: string;
  fileName: string;
  model: monaco.editor.ITextModel;
  dirty: boolean;
  originalContent: string;
  loading: boolean;
  error: string;
  /** If set, this tab is a read-only diff view. */
  diffModels?: { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel };
  viewMode?: 'edit' | 'preview';
}

interface WindowState {
  open: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class FileViewer {
  private el!: HTMLElement;
  private header!: HTMLElement;
  private tabBar!: HTMLElement;
  private editorContainer!: HTMLElement;
  private editor!: monaco.editor.IStandaloneCodeEditor;
  private diffEditorContainer!: HTMLElement;
  private previewContainer!: HTMLElement;
  private diffEditor!: monaco.editor.IStandaloneDiffEditor;
  private resizeHandle!: HTMLElement;
  private windowCloseBtn!: HTMLElement;
  private translator!: FileTranslator;
  // ── New chrome ──
  private breadcrumb!: HTMLElement;
  private toolbar!: HTMLElement;
  private statusBar!: HTMLElement;
  private statusLsp!: HTMLElement;
  private statusCursor!: HTMLElement;
  private toolbarBtns: Record<string, HTMLButtonElement> = {};

  private tabs: TabData[] = [];
  private activeIdx = -1;
  private state: WindowState;
  private dragging = false;
  private resizing = false;
  private dragStart = { x: 0, y: 0, elX: 0, elY: 0, w: 0, h: 0 };

  private static instance: FileViewer | null = null;

  static get(): FileViewer {
    if (!FileViewer.instance) {
      FileViewer.instance = new FileViewer();
    }
    return FileViewer.instance;
  }

  private constructor() {
    this.state = {
      open: false,
      x: 100, y: 80,
      width: 780, height: 500,
    };
    this.buildDOM();
    this.initEditor();
    this.translator = new FileTranslator(this.el, () => {
      this.editor.layout();
      if (this.diffEditor) this.diffEditor.layout();
    }, () => this.editor);
  }

  private buildDOM(): void {
    // ── Outer shell ──
    this.el = document.createElement('div');
    this.el.id = 'file-viewer';
    this.el.className = 'file-viewer';
    Object.assign(this.el.style, {
      position: 'absolute', zIndex: '30',
      width: `${this.state.width}px`, height: `${this.state.height}px`,
      left: `${this.state.x}px`, top: `${this.state.y}px`,
      background: 'var(--panel-bg, rgba(6, 12, 24, 0.97))',
      backdropFilter: 'var(--blur, blur(14px))',
      WebkitBackdropFilter: 'var(--blur, blur(14px))',
      border: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.5))',
      borderRadius: '8px',
      boxShadow: '0 12px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(88,120,180,0.08) inset',
      flexDirection: 'column', overflow: 'hidden',
      minWidth: '420px', minHeight: '320px',
    });

    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.el.appendChild(brackets);

    // ═══════════════════════════════════════════════
    // LAYER 1: Titlebar — breadcrumb + window actions
    // ═══════════════════════════════════════════════
    this.header = document.createElement('div');
    this.header.className = 'fv-titlebar';
    Object.assign(this.header.style, {
      display: 'flex', alignItems: 'center', gap: '6px',
      minHeight: 'calc(30px * var(--font-scale))', padding: '0 calc(6px * var(--font-scale))', flexShrink: '0',
      cursor: 'move', userSelect: 'none',
      background: 'rgba(14, 22, 38, 0.7)',
      borderBottom: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.25))',
    });

    // Breadcrumb
    this.breadcrumb = document.createElement('div');
    this.breadcrumb.className = 'fv-breadcrumb';
    Object.assign(this.breadcrumb.style, {
      display: 'flex', alignItems: 'center', gap: '2px', flex: '1',
      overflow: 'hidden', fontSize: 'calc(10px * var(--font-scale))', fontFamily: 'var(--font-mono, monospace)',
      color: 'var(--text-muted)', minWidth: '0',
    });
    this.header.appendChild(this.breadcrumb);

    // Window action buttons
    const winActions = document.createElement('div');
    winActions.className = 'fv-win-actions';
    Object.assign(winActions.style, {
      display: 'flex', alignItems: 'center', gap: '2px', flexShrink: '0',
    });
    for (const { id, icon, tip, colorVar } of [
      { id: 'agent', icon: 'agent', tip: '问 Agent 分析当前文件', colorVar: 'var(--signal, #7eb8ff)' },
      { id: 'translate', icon: 'translate', tip: '翻译当前文件', colorVar: 'var(--nebula, #a088e0)' },
      { id: 'close', icon: 'close', tip: '关闭', colorVar: 'var(--text-muted)' },
    ]) {
      const btn = document.createElement('button');
      btn.className = `fv-title-btn`;
      btn.innerHTML = iconHtml(icon, 13);
      btn.title = tip;
      Object.assign(btn.style, {
        minWidth: 'calc(22px * var(--font-scale))', minHeight: 'calc(22px * var(--font-scale))', padding: '0', border: 'none', cursor: 'pointer',
        background: 'none', color: 'var(--text-muted)', borderRadius: '4px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(13px * var(--font-scale))',
      });
      btn.addEventListener('mouseenter', () => { btn.style.color = colorVar; btn.style.background = 'rgba(255,255,255,0.05)'; });
      btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--text-muted)'; btn.style.background = 'none'; });
      if (id === 'agent') {
        btn.addEventListener('click', () => {
          const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
          if (tab) askAgent(`分析文件 "${tab.filePath}" 的依赖关系和耦合状况。它和其他模块的关联是什么？如果修改它会影响哪些模块？`);
        });
      } else if (id === 'translate') {
        btn.addEventListener('click', () => {
          const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
          if (tab && !tab.diffModels) this.translator.translateFile(tab.filePath);
        });
      } else if (id === 'close') {
        this.windowCloseBtn = btn;
        btn.addEventListener('click', () => this.closeAll());
      }
      winActions.appendChild(btn);
    }
    this.header.appendChild(winActions);

    // Drag from titlebar (not from buttons)
    this.header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.onDragStart(e);
    });

    // ═══════════════════════════════════════════════
    // LAYER 2: Toolbar — save / undo / redo / format
    // ═══════════════════════════════════════════════
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'fv-toolbar';
    Object.assign(this.toolbar.style, {
      display: 'flex', alignItems: 'center', gap: '1px',
      height: '26px', padding: '0 4px', flexShrink: '0',
      background: 'rgba(10, 18, 32, 0.5)',
      borderBottom: '1px solid rgba(48, 60, 80, 0.2)',
    });

    const btnDefs: [string, string, string, () => void][] = [
      ['save', '保存 (Ctrl+S)', 'var(--starlight-dim)', () => this.saveActiveTab()],
      ['undo', '撤销 (Ctrl+Z)', 'var(--text-muted)', () => this.editor.trigger('', 'undo', null)],
      ['redo', '重做 (Ctrl+Y)', 'var(--text-muted)', () => this.editor.trigger('', 'redo', null)],
      ['search', '查找 (Ctrl+F)', 'var(--text-muted)', () => this.editor.getAction('actions.find')?.run()],
    ];

    for (const [icon, tip, _color, action] of btnDefs) {
      const btn = document.createElement('button');
      btn.innerHTML = iconHtml(icon, 12);
      btn.title = tip;
      Object.assign(btn.style, {
        width: '22px', height: '20px', padding: '0', border: 'none', cursor: 'pointer',
        background: 'none', color: 'var(--text-muted)', borderRadius: '3px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      });
      btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--starlight-dim)'; btn.style.background = 'rgba(255,255,255,0.04)'; });
      btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--text-muted)'; btn.style.background = 'none'; });
      btn.addEventListener('click', action);
      this.toolbarBtns[icon] = btn;
      this.toolbar.appendChild(btn);
    }

    // Separator
    const sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:14px;background:rgba(48,60,80,0.35);margin:0 4px;';
    this.toolbar.appendChild(sep);

    // Format button
    const fmtBtn = document.createElement('button');
    fmtBtn.innerHTML = iconHtml('edit', 12);
    fmtBtn.title = '格式化文档';
    Object.assign(fmtBtn.style, {
      width: '22px', height: '20px', padding: '0', border: 'none', cursor: 'pointer',
      background: 'none', color: 'var(--text-muted)', borderRadius: '3px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    fmtBtn.addEventListener('mouseenter', () => { fmtBtn.style.color = 'var(--signal, #7eb8ff)'; fmtBtn.style.background = 'rgba(255,255,255,0.04)'; });
    fmtBtn.addEventListener('mouseleave', () => { fmtBtn.style.color = 'var(--text-muted)'; fmtBtn.style.background = 'none'; });
    fmtBtn.addEventListener('click', () => this.editor.getAction('editor.action.formatDocument')?.run());
    this.toolbarBtns['format'] = fmtBtn;
    this.toolbar.appendChild(fmtBtn);

    // Preview toggle
    const prevSep = document.createElement('div');
    prevSep.style.cssText = 'width:1px;height:14px;background:rgba(48,60,80,0.35);margin:0 4px;';
    this.toolbar.appendChild(prevSep);

    const previewBtn = document.createElement('button');
    previewBtn.innerHTML = iconHtml('eye', 12);
    previewBtn.title = '切换预览 (Markdown / 图片)';
    Object.assign(previewBtn.style, {
      width: '22px', height: '20px', padding: '0', border: 'none', cursor: 'pointer',
      background: 'none', color: 'var(--text-muted)', borderRadius: '3px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    previewBtn.addEventListener('mouseenter', () => { previewBtn.style.color = 'var(--nebula, #a088e0)'; previewBtn.style.background = 'rgba(255,255,255,0.04)'; });
    previewBtn.addEventListener('mouseleave', () => { previewBtn.style.color = 'var(--text-muted)'; previewBtn.style.background = 'none'; });
    previewBtn.addEventListener('click', () => this.togglePreview());
    this.toolbarBtns['preview'] = previewBtn;
    this.toolbar.appendChild(previewBtn);

    // ═══════════════════════════════════════════════
    // LAYER 3: Tab bar — file tabs (clean, separate row)
    // ═══════════════════════════════════════════════
    this.tabBar = document.createElement('div');
    this.tabBar.className = 'fv-tabbar';
    Object.assign(this.tabBar.style, {
      display: 'flex', alignItems: 'flex-end', gap: '0',
      height: '30px', padding: '0 4px', flexShrink: '0', overflowX: 'auto', overflowY: 'hidden',
      background: 'rgba(8, 14, 26, 0.6)',
      borderBottom: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.3))',
      minHeight: '30px',
    });

    // ═══════════════════════════════════════════════
    // LAYER 4: Editor area
    // ═══════════════════════════════════════════════
    this.editorContainer = document.createElement('div');
    Object.assign(this.editorContainer.style, { flex: '1', overflow: 'hidden' });
    this.diffEditorContainer = document.createElement('div');
    Object.assign(this.diffEditorContainer.style, { flex: '1', overflow: 'hidden', display: 'none' });

    // Preview container (markdown / image)
    this.previewContainer = document.createElement('div');
    this.previewContainer.className = 'fv-preview';
    Object.assign(this.previewContainer.style, {
      flex: '1', overflow: 'auto', display: 'none',
      padding: '24px 32px',
      color: 'var(--starlight-dim, #c8d6e5)',
      fontSize: 'calc(13px * var(--font-scale))', lineHeight: '1.7',
      fontFamily: 'var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif)',
    });

    // ═══════════════════════════════════════════════
    // LAYER 5: Status bar — LSP · language · cursor
    // ═══════════════════════════════════════════════
    this.statusBar = document.createElement('div');
    this.statusBar.className = 'fv-statusbar';
    Object.assign(this.statusBar.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      height: '22px', padding: '0 8px', flexShrink: '0',
      background: 'rgba(8, 14, 26, 0.8)',
      borderTop: '1px solid rgba(48, 60, 80, 0.3)',
      fontSize: 'calc(10px * var(--font-scale))', fontFamily: 'var(--font-mono, monospace)',
      color: 'var(--text-muted)',
    });

    // Left: LSP status + language
    const statusLeft = document.createElement('div');
    statusLeft.style.cssText = 'display:flex;align-items:center;gap:8px;';

    this.statusLsp = document.createElement('span');
    this.statusLsp.className = 'fv-lsp-status';
    this.statusLsp.title = 'LSP 状态';
    this.statusLsp.innerHTML = `${iconHtml('dot', 8)} LSP`;
    this.statusLsp.style.cssText = 'display:flex;align-items:center;gap:3px;opacity:0.5;';
    statusLeft.appendChild(this.statusLsp);

    const statusLang = document.createElement('span');
    statusLang.className = 'fv-lang-badge';
    statusLang.style.cssText = 'text-transform:uppercase;letter-spacing:0.5px;';
    statusLeft.appendChild(statusLang);

    // Right: cursor position + encoding
    const statusRight = document.createElement('div');
    statusRight.style.cssText = 'display:flex;align-items:center;gap:10px;';

    this.statusCursor = document.createElement('span');
    this.statusCursor.className = 'fv-cursor';
    this.statusCursor.textContent = 'Ln 1, Col 1';
    statusRight.appendChild(this.statusCursor);

    const statusEnc = document.createElement('span');
    statusEnc.textContent = 'UTF-8';
    statusEnc.style.opacity = '0.5';
    statusRight.appendChild(statusEnc);

    this.statusBar.appendChild(statusLeft);
    this.statusBar.appendChild(statusRight);

    // ═══════════════════════════════════════════════
    // Assemble
    // ═══════════════════════════════════════════════
    this.el.appendChild(this.header);
    this.el.appendChild(this.toolbar);
    this.el.appendChild(this.tabBar);
    this.el.appendChild(this.editorContainer);
    this.el.appendChild(this.diffEditorContainer);
    this.el.appendChild(this.previewContainer);
    this.el.appendChild(this.statusBar);

    // Resize handle
    this.resizeHandle = document.createElement('div');
    this.resizeHandle.className = 'fv-grip';
    Object.assign(this.resizeHandle.style, {
      position: 'absolute', right: '0', bottom: '0',
      width: '14px', height: '14px', cursor: 'nwse-resize', zIndex: '2',
    });
    this.el.appendChild(this.resizeHandle);

    // Global drag/resize listeners
    window.addEventListener('pointermove', (e) => this.onDragMove(e));
    window.addEventListener('pointerup', () => this.onDragEnd());
    this.resizeHandle.addEventListener('pointerdown', (e) => this.onResizeStart(e));
    window.addEventListener('pointermove', (e) => this.onResizeMove(e));
    window.addEventListener('pointerup', () => this.onResizeEnd());

    document.body.appendChild(this.el);
  }

  private initEditor(): void {
    this.editor = monaco.editor.create(this.editorContainer, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: Math.round(13 * getFontScale()),
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      tabSize: 4,
      automaticLayout: false,
      wordWrap: 'off',
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      bracketPairColorization: { enabled: true },
      cursorSmoothCaretAnimation: 'on',
      linkedEditing: true,
      stickyScroll: { enabled: true },
      formatOnPaste: true,
      matchBrackets: 'always',
    });

    // Ctrl+S → save
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.saveActiveTab());

    // ── Cursor position → status bar ──
    this.editor.onDidChangeCursorPosition((e) => {
      this.statusCursor.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });

    // ── Editor focus → update breadcrumb & status ──
    this.editor.onDidFocusEditorText(() => {
      const pos = this.editor.getPosition();
      if (pos) this.statusCursor.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
      this.updateBreadcrumb();
      this.updateStatusBar();
    });

    // LSP diagnostics listener
    listenForDiagnostics(this.editor, monaco);

    // Editor context menu actions
    this.editor.addAction({
      id: 'format-document', label: '格式化文档',
      contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 2,
      run: () => this.editor.getAction('editor.action.formatDocument')?.run(),
    });
    this.editor.addAction({
      id: 'copy-file-path', label: '复制文件路径',
      contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 3,
      run: () => {
        const tab = this.tabs[this.activeIdx];
        if (tab?.filePath) navigator.clipboard.writeText(tab.filePath);
      },
    });
    this.editor.addAction({
      id: 'translate-selection',
      label: '✦ 翻译选中',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 4,
      run: () => {
        const selection = this.editor.getSelection();
        if (!selection || selection.isEmpty()) return;
        const selectedText = this.editor.getModel()?.getValueInRange(selection);
        if (selectedText?.trim()) {
          this.translator.translateSelection(
            selectedText,
            selection.startLineNumber,
            selection.endLineNumber,
          );
        }
      },
    });
  }

  // ── Tab rendering ──

  private renderTabs(): void {
    this.tabBar.innerHTML = '';
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i];
      const isActive = i === this.activeIdx;
      const isDiff = !!tab.diffModels;

      const tabEl = document.createElement('div');
      tabEl.className = 'fv-tab';
      tabEl.title = tab.filePath;
      Object.assign(tabEl.style, {
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        height: '26px', padding: '0 10px', cursor: 'pointer',
        fontSize: 'calc(11px * var(--font-scale))', fontFamily: 'var(--font-mono, monospace)',
        whiteSpace: 'nowrap', flexShrink: '0', maxWidth: '170px',
        borderTop: isActive ? '2px solid rgba(80, 140, 220, 0.7)' : '2px solid transparent',
        background: isActive ? 'rgba(22, 40, 70, 0.55)' : 'transparent',
        color: isActive ? 'var(--starlight, #e6edf3)' : 'var(--text-muted)',
        borderRadius: '3px 3px 0 0',
      });

      // File icon
      const ficon = document.createElement('span');
      ficon.innerHTML = isDiff ? iconHtml('diff', 12) : fileIconSvg(tab.fileName, 12);
      ficon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;opacity:0.7;';
      tabEl.appendChild(ficon);

      // Dirty dot
      if (tab.dirty) {
        const dot = document.createElement('span');
        dot.className = 'fv-tab-dirty';
        dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:rgba(235,180,80,0.9);flex-shrink:0;';
        tabEl.appendChild(dot);
      }

      // Label
      const label = document.createElement('span');
      label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      label.textContent = tab.fileName;

      // Close button — hidden until hover
      const closeBtn = document.createElement('button');
      closeBtn.innerHTML = iconHtml('close', 10);
      Object.assign(closeBtn.style, {
        background: 'none', border: 'none', cursor: 'pointer',
        color: 'inherit', padding: '0', fontSize: 'calc(10px * var(--font-scale))',
        display: 'flex', alignItems: 'center', flexShrink: '0',
        opacity: '0', borderRadius: '2px',
      });
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(i); });
      tabEl.addEventListener('mouseenter', () => { closeBtn.style.opacity = '0.6'; });
      tabEl.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0'; });

      tabEl.appendChild(label);
      tabEl.appendChild(closeBtn);
      tabEl.addEventListener('click', () => this.switchTab(i));
      this.tabBar.appendChild(tabEl);
    }
  }

  private switchTab(idx: number): void {
    if (idx < 0 || idx >= this.tabs.length) return;
    this.translator.detach();
    this.activeIdx = idx;
    const tab = this.tabs[idx];

    // Auto-preview images; restore preview for markdown
    const ext = tab.fileName.split('.').pop()?.toLowerCase() || '';
    const imgExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
    if (imgExts.has(ext)) {
      tab.viewMode = 'preview';
    }

    if (tab.diffModels) {
      if (this.diffEditor) this.diffEditor.setModel(tab.diffModels);
      this.showDiffEditor();
      if (this.diffEditor) this.diffEditor.layout();
    } else if (tab.viewMode === 'preview' && this.canPreview(tab)) {
      this.editor.setModel(tab.model); // ensure model is attached
      this.showPreview(); // show container first for loading state
      this.renderPreview(tab); // fire-and-forget, async load
    } else {
      tab.viewMode = 'edit';
      this.editor.setModel(tab.model);
      this.showNormalEditor();
      this.editor.layout();
      this.editor.focus();
    }
    this.renderTabs();
    this.updateBreadcrumb();
    this.updateStatusBar();
    this.updatePreviewButton();
  }

  // ── Breadcrumb: clickable path segments ──

  private updateBreadcrumb(): void {
    const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
    this.breadcrumb.innerHTML = '';
    if (!tab || !tab.filePath) {
      this.breadcrumb.textContent = '未打开文件';
      return;
    }
    const parts = tab.filePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) return;

    // Build clickable segments
    parts.forEach((seg, i) => {
      if (i > 0) {
        const arrow = document.createElement('span');
        arrow.innerHTML = iconHtml('chevron-right', 10);
        arrow.style.opacity = '0.4';
        this.breadcrumb.appendChild(arrow);
      }
      const span = document.createElement('span');
      span.textContent = seg;
      span.style.cssText = 'cursor:pointer;padding:0 2px;border-radius:2px;';
      span.title = parts.slice(0, i + 1).join('/');
      span.addEventListener('mouseenter', () => {
        span.style.color = 'var(--signal, #7eb8ff)';
        span.style.background = 'rgba(80,140,220,0.12)';
      });
      span.addEventListener('mouseleave', () => {
        span.style.color = '';
        span.style.background = '';
      });
      span.addEventListener('click', () => {
        // ponytail: file tree removed — breadcrumb clicks still work for visual feedback
      });
      this.breadcrumb.appendChild(span);
    });
  }

  // ── Status bar: LSP indicator + language + cursor ──

  private updateStatusBar(): void {
    const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
    if (!tab) {
      this.statusLsp.innerHTML = `${iconHtml('dot', 8)} LSP`;
      this.statusLsp.style.opacity = '0.5';
      (this.statusBar.querySelector('.fv-lang-badge') as HTMLElement).textContent = '';
      this.statusCursor.textContent = 'Ln 1, Col 1';
      return;
    }

    // Language badge
    const langSpan = this.statusBar.querySelector('.fv-lang-badge') as HTMLElement;
    if (langSpan) {
      langSpan.textContent = tab.model.getLanguageId();
    }

    // LSP status indicator
    const lang = tab.model.getLanguageId();
    const lspActive = lspSessions.has(lang);
    if (lspActive) {
      this.statusLsp.innerHTML = `${iconHtml('dot', 8)} LSP`;
      this.statusLsp.style.color = '#6ebf70';
      this.statusLsp.style.opacity = '1';
      this.statusLsp.title = `${lang} LSP 已连接`;
    } else if (lang === 'typescript' || lang === 'javascript' || lang === 'json' || lang === 'css' || lang === 'html') {
      // Monaco native support
      this.statusLsp.innerHTML = `${iconHtml('dot', 8)} LSP`;
      this.statusLsp.style.color = '#80a4c0';
      this.statusLsp.style.opacity = '1';
      this.statusLsp.title = `${lang} 使用 Monaco 内置支持`;
    } else {
      this.statusLsp.innerHTML = `${iconHtml('dot', 8)} LSP`;
      this.statusLsp.style.color = '';
      this.statusLsp.style.opacity = '0.5';
      this.statusLsp.title = 'LSP 未启动';
    }

    // Cursor
    const pos = this.editor.getPosition();
    if (pos) {
      this.statusCursor.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
    }
  }

  private async closeTab(idx: number): Promise<void> {
    if (idx < 0 || idx >= this.tabs.length) return;
    const tab = this.tabs[idx];

    // If closing the tab that's currently being translated, destroy the translator
    if (this.translator.isTranslatingFile(tab.filePath)) {
      this.translator.destroy();
    }

    // Check unsaved changes
    if (tab.dirty) {
      const confirmed = confirm(`"${tab.fileName}" 有未保存的修改，确定关闭？`);
      if (!confirmed) return;
    }

    tab.model.dispose();
    if (tab.diffModels) {
      tab.diffModels.original.dispose();
      tab.diffModels.modified.dispose();
    }
    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      this.closeAll();
      return;
    }
    if (this.activeIdx >= this.tabs.length) this.activeIdx = this.tabs.length - 1;
    else if (idx < this.activeIdx) this.activeIdx--;

    // If active tab was removed and new active tab is the same index position
    if (idx === this.activeIdx) {
      this.editor.setModel(this.tabs[this.activeIdx].model);
    }
    this.switchTab(this.activeIdx);
  }

  // ── Public API ──

  async open(filePath: string, opts?: { noAutoPreview?: boolean }): Promise<void> {
    const existingIdx = this.tabs.findIndex(t => t.filePath === filePath);
    if (existingIdx >= 0) {
      this.activeIdx = existingIdx;
      this.renderTabs();
      const tab = this.tabs[existingIdx];
      if (tab.viewMode === 'preview' && this.canPreview(tab)) {
        this.editor.setModel(tab.model);
        this.renderPreview(tab);
        this.showPreview();
      } else {
        this.editor.setModel(tab.model);
        this.showNormalEditor();
        this.editor.layout();
        this.editor.focus();
      }
      this.el.classList.add('fv-open');
      this.el.style.zIndex = String(Math.max(30, Number(this.el.style.zIndex) + 1));
      this.centerOnScreen();
      this.updatePreviewButton();
      return;
    }

    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
    const uri = monaco.Uri.file(filePath);
    const language = detectLanguage(fileName);
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const imgExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

    // ── Image files: skip text read, show preview directly ──
    if (imgExts.has(ext)) {
      this.state.open = true;
      this.centerOnScreen();
      this.el.classList.add('fv-open');
      this.el.style.zIndex = String(Math.max(30, Number(this.el.style.zIndex) + 1));

      const model = monaco.editor.createModel('', 'plaintext', uri);
      const newTab: TabData = {
        filePath, fileName, model,
        dirty: false, originalContent: '',
        loading: false, error: '',
        viewMode: 'preview',
      };
      this.tabs.push(newTab);
      this.activeIdx = this.tabs.length - 1;
      this.editor.setModel(model);
      this.showPreview();
      this.renderPreview(newTab); // fire-and-forget, async load
      this.renderTabs();
      this.updatePreviewButton();
      return;
    }

    // Show loading state in a temp model
    const loadingModel = monaco.editor.createModel('加载中...', 'plaintext');
    this.editor.setModel(loadingModel);
    this.showNormalEditor();

    this.state.open = true;
    this.centerOnScreen();
    this.el.classList.add('fv-open');
    this.el.style.zIndex = String(Math.max(30, Number(this.el.style.zIndex) + 1));

    try {
      const content = await invoke<string>('read_file_content', { filePath: filePath });

      // Dispose temp loading model
      loadingModel.dispose();

      // Create real model
      const model = monaco.editor.createModel(content, language, uri);

      const newTab: TabData = {
        filePath, fileName, model,
        dirty: false, originalContent: content,
        loading: false, error: '',
      };

      // Track dirty state
      model.onDidChangeContent(() => {
        newTab.dirty = model.getValue() !== newTab.originalContent;
        this.renderTabs();
        // LSP: notify document change
        const sid = lspSessions.get(language);
        if (sid) didChange(sid, uri.toString(), model.getValue());
      });

      // LSP: only attempt for languages with configured servers
      const LSP_LANGUAGES = new Set([
        'python', 'rust', 'go', 'typescript', 'javascript',
        'java', 'c', 'cpp', 'csharp', 'ruby', 'lua', 'php',
        'swift', 'dart', 'haskell', 'elixir', 'erlang', 'zig',
        'shell', 'html', 'css', 'scss', 'less', 'yaml', 'yml',
        'scala', 'r', 'nix', 'ocaml',
      ]);
      if (!lspSessions.has(language) && LSP_LANGUAGES.has(language)) {
        startLsp(language, `file:///${filePath}`).then(sid => {
          if (sid !== null) {
            lspSessions.set(language, sid);
            registerCompletionProvider(language, sid, monaco);
            registerHoverProvider(language, sid, monaco);
            registerDefinitionProvider(language, sid, monaco);
            registerReferencesProvider(language, sid, monaco);
            didOpen(sid, uri.toString(), language, content);
            this.updateStatusBar();
          }
        });
      } else {
        const sid = lspSessions.get(language)!;
        didOpen(sid, uri.toString(), language, content);
      }

      this.tabs.push(newTab);
      this.activeIdx = this.tabs.length - 1;
      this.editor.setModel(model);
      this.renderTabs();
    } catch (err: any) {
      console.error('[FileViewer] read failed:', err);
      loadingModel.dispose();
      const errMsg = `❌ 读取失败: ${err}`;
      const errModel = monaco.editor.createModel(errMsg, 'plaintext');
      const newTab: TabData = {
        filePath, fileName, model: errModel,
        dirty: false, originalContent: '',
        loading: false, error: String(err),
      };
      this.tabs.push(newTab);
      this.activeIdx = this.tabs.length - 1;
      this.editor.setModel(errModel);
      this.renderTabs();
    }

    this.editor.layout();
    this.editor.focus();
    this.updatePreviewButton();
  }

  private async saveActiveTab(): Promise<void> {
    if (this.activeIdx < 0 || this.activeIdx >= this.tabs.length) return;
    const tab = this.tabs[this.activeIdx];
    if (!tab.dirty) return;

    const content = tab.model.getValue();
    try {
      await invoke('write_file_content', { filePath: tab.filePath, content });
      // Record timeline event (fire-and-forget)
      invoke('hologram_record_event', {
        eventType: 'file_changed',
        file: tab.filePath,
        summary: `保存: ${tab.fileName}`,
      }).catch(() => { /* timeline recording is best-effort */ });
      tab.originalContent = content;
      tab.dirty = false;
      tab.error = '';
      this.renderTabs();
    } catch (err: any) {
      alert(`保存失败: ${err}`);
    }
  }

  /** Open a side-by-side diff view (Monaco DiffEditor) — used by GitPanel. */
  openInlineDiff(fileName: string, originalContent: string, modifiedContent: string): void {
    const label = `差异: ${fileName.replace(/\\/g, '/').split('/').pop() || fileName}`;

    // Lazy-init diff editor
    if (!this.diffEditor) {
      this.diffEditor = monaco.editor.createDiffEditor(this.diffEditorContainer, {
        theme: 'vs-dark',
        fontSize: Math.round(13 * getFontScale()),
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
        readOnly: true,
        automaticLayout: false,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        renderSideBySide: true,
        originalEditable: false,
      });
    }

    const originalUri = monaco.Uri.parse(`diff-original:///${label}`);
    const modifiedUri = monaco.Uri.parse(`diff-modified:///${label}`);
    const origModel = monaco.editor.createModel(originalContent, undefined, originalUri);
    const modModel = monaco.editor.createModel(modifiedContent, undefined, modifiedUri);
    this.diffEditor.setModel({ original: origModel, modified: modModel });

    const tab: TabData = {
      filePath: `[diff] ${fileName}`,
      fileName: label,
      model: modModel, // placeholder; diff editors use diffModels
      dirty: false,
      originalContent: '',
      loading: false,
      error: '',
      diffModels: { original: origModel, modified: modModel },
    };
    this.tabs.push(tab);
    this.activeIdx = this.tabs.length - 1;
    this.renderTabs();
    this.showDiffEditor();
    this.el.classList.add('fv-open');
    this.el.style.zIndex = String(Math.max(30, Number(this.el.style.zIndex) + 1));
    this.centerOnScreen();
    this.diffEditor.layout();
  }

  /** Legacy wrapper — raw diff text as plain diff model. */
  openDiff(fileName: string, diffContent: string): void {
    const label = `差异: ${fileName.replace(/\\/g, '/').split('/').pop() || fileName}`;
    const uri = monaco.Uri.parse(`diff:///${label}`);
    const model = monaco.editor.createModel(diffContent, 'diff', uri);

    const tab: TabData = {
      filePath: `[diff] ${fileName}`,
      fileName: label,
      model,
      dirty: false,
      originalContent: diffContent,
      loading: false,
      error: '',
    };
    this.tabs.push(tab);
    this.activeIdx = this.tabs.length - 1;
    this.editor.setModel(model);
    this.renderTabs();
    this.el.classList.add('fv-open');
    this.el.style.zIndex = String(Math.max(30, Number(this.el.style.zIndex) + 1));
    this.centerOnScreen();
    this.editor.layout();
    this.editor.focus();
  }

  private showDiffEditor(): void {
    this.editorContainer.style.display = 'none';
    this.previewContainer.style.display = 'none';
    this.diffEditorContainer.style.display = '';
  }

  private showNormalEditor(): void {
    this.diffEditorContainer.style.display = 'none';
    this.previewContainer.style.display = 'none';
    this.editorContainer.style.display = '';
  }

  private showPreview(): void {
    this.editorContainer.style.display = 'none';
    this.diffEditorContainer.style.display = 'none';
    this.previewContainer.style.display = '';
  }

  // ── Preview mode ──

  private previewableExts = new Set(['md', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

  private canPreview(tab: TabData): boolean {
    if (tab.diffModels) return false;
    const ext = tab.fileName.split('.').pop()?.toLowerCase() || '';
    return this.previewableExts.has(ext);
  }

  private updatePreviewButton(): void {
    const btn = this.toolbarBtns['preview'];
    if (!btn) return;
    const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
    if (tab && this.canPreview(tab)) {
      btn.style.display = '';
      const isPreview = tab.viewMode === 'preview';
      btn.innerHTML = isPreview ? iconHtml('edit', 12) : iconHtml('eye', 12);
      btn.title = isPreview ? '返回编辑模式' : '切换预览';
      btn.style.color = isPreview ? 'var(--nebula, #a088e0)' : 'var(--text-muted)';
    } else {
      btn.style.display = 'none';
    }
  }

  private async togglePreview(): Promise<void> {
    const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
    if (!tab || !this.canPreview(tab)) return;

    if (tab.viewMode === 'preview') {
      tab.viewMode = 'edit';
      this.showNormalEditor();
      this.editor.layout();
      this.editor.focus();
      this.updatePreviewButton();
    } else {
      tab.viewMode = 'preview';
      this.showPreview(); // show container first so loading state is visible
      await this.renderPreview(tab);
      this.updatePreviewButton();
    }
  }

  private async renderPreview(tab: TabData): Promise<void> {
    const ext = tab.fileName.split('.').pop()?.toLowerCase() || '';
    const imgExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

    if (imgExts.has(ext)) {
      await this.renderImagePreview(tab.filePath);
    } else if (ext === 'md') {
      this.renderMarkdownPreview(tab.model.getValue());
    }
  }

  private renderMarkdownPreview(content: string): void {
    const rawHtml = marked.parse(content) as string;
    const safeHtml = DOMPurify.sanitize(rawHtml);
    this.previewContainer.innerHTML = safeHtml;
    // Syntax highlight code blocks
    this.previewContainer.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block as HTMLElement);
    });
  }

  private async renderImagePreview(filePath: string): Promise<void> {
    this.previewContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">加载中...</div>`;
    try {
      const b64 = await invoke<string>('read_file_base64', { filePath });
      const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
        bmp: 'image/bmp', ico: 'image/x-icon',
      };
      const mime = mimeMap[ext] || 'image/png';
      this.previewContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:200px;"><img src="data:${mime};base64,${b64}" alt="${filePath.replace(/\\/g, '/').split('/').pop()}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;box-shadow:0 4px 24px rgba(0,0,0,0.4);" /></div>`;
    } catch (err: any) {
      this.previewContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">⚠ 无法加载图片: ${String(err)}</div>`;
    }
  }

  closeAll(): void {
    // Destroy translator before disposing models (needs access to tab info)
    this.translator.destroy();
    this.state.open = false;
    // Dispose all models
    for (const tab of this.tabs) {
      if (tab.diffModels) {
        tab.diffModels.original.dispose();
        tab.diffModels.modified.dispose();
      }
      tab.model.dispose();
    }
    this.tabs = [];
    this.activeIdx = -1;
    this.tabBar.innerHTML = '';
    this.showNormalEditor();
    this.el.classList.remove('fv-open');
  }

  close(): void {
    if (this.activeIdx >= 0) {
      this.closeTab(this.activeIdx);
    } else {
      this.closeAll();
    }
  }

  toggle(): void {
    if (this.state.open) this.closeAll();
  }

  centerOnScreen(): void {
    const w = parseInt(this.el.style.width) || this.state.width;
    const h = parseInt(this.el.style.height) || this.state.height;
    this.el.style.left = `${Math.max(0, (window.innerWidth - w) / 2)}px`;
    this.el.style.top = `${Math.max(36, (window.innerHeight - h) / 2)}px`;
  }

  get isOpen(): boolean { return this.state.open; }

  // ── Drag ──

  private onDragStart(e: PointerEvent): void {
    this.dragging = true;
    this.dragStart.x = e.clientX;
    this.dragStart.y = e.clientY;
    this.dragStart.elX = parseInt(this.el.style.left) || this.state.x;
    this.dragStart.elY = parseInt(this.el.style.top) || this.state.y;
    this.el.setPointerCapture(e.pointerId);
  }

  private onDragMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;
    const newX = this.dragStart.elX + dx;
    const newY = this.dragStart.elY + dy;
    const w = parseInt(this.el.style.width) || this.state.width;
    const minVisible = 60;
    this.el.style.left = `${Math.max(-w + minVisible, Math.min(window.innerWidth - minVisible, newX))}px`;
    this.el.style.top = `${Math.max(0, Math.min(window.innerHeight - 36, newY))}px`;
  }

  private onDragEnd(): void {
    if (this.dragging) {
      this.state.x = parseInt(this.el.style.left) || this.state.x;
      this.state.y = parseInt(this.el.style.top) || this.state.y;
    }
    this.dragging = false;
  }

  // ── Resize ──

  private onResizeStart(e: PointerEvent): void {
    e.stopPropagation(); e.preventDefault();
    this.resizing = true;
    this.dragStart.x = e.clientX;
    this.dragStart.y = e.clientY;
    this.dragStart.w = parseInt(this.el.style.width) || this.state.width;
    this.dragStart.h = parseInt(this.el.style.height) || this.state.height;
    this.el.setPointerCapture(e.pointerId);
  }

  private onResizeMove(e: PointerEvent): void {
    if (!this.resizing) return;
    const dw = e.clientX - this.dragStart.x;
    const dh = e.clientY - this.dragStart.y;
    this.el.style.width = `${Math.max(360, this.dragStart.w + dw)}px`;
    this.el.style.height = `${Math.max(240, this.dragStart.h + dh)}px`;
    this.editor.layout();
    if (this.diffEditor) this.diffEditor.layout();
  }

  private onResizeEnd(): void {
    if (this.resizing) {
      this.state.width = parseInt(this.el.style.width) || this.state.width;
      this.state.height = parseInt(this.el.style.height) || this.state.height;
    }
    this.resizing = false;
  }
}

// ── File icon by extension ──

function fileIconSvg(fileName: string, size: number): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'code', tsx: 'code', mts: 'code', cts: 'code',
    js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
    py: 'code-py', rs: 'code-rs', go: 'code-go', java: 'code',
    c: 'code', cpp: 'code', h: 'code', hpp: 'code',
    cs: 'code', rb: 'code', php: 'code',
    kt: 'code', kts: 'code', swift: 'code', lua: 'code',
    html: 'code', htm: 'code', css: 'code', scss: 'code',
    json: 'file', yaml: 'file', yml: 'file', toml: 'file',
    md: 'file', txt: 'file', log: 'file',
    svg: 'file', png: 'file', jpg: 'file', gif: 'file', ico: 'file',
  };
  return iconSvg(map[ext] || 'file', size);
}

// ── Language detection ──

function detectLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
    h: 'c', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
    kt: 'kotlin', kts: 'kotlin', swift: 'swift', lua: 'lua',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell',
    toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  };
  return map[ext] || 'plaintext';
}
