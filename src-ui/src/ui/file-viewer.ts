// Floating File Viewer — 浮动文件窗口（标签页式 + Monaco 编辑器）
// 可从简报/详情卡片/聊天/时间轴中点击文件名呼出
// 支持拖拽移动、调整大小、多标签页、Ctrl+S 保存

import { invoke } from '../bridge';
import { iconHtml } from './icons';
import { askAgent } from './agent-visualizer';
import * as monaco from 'monaco-editor';
import { startLsp, didOpen, didChange, registerCompletionProvider, registerHoverProvider, registerDefinitionProvider, registerReferencesProvider, listenForDiagnostics } from './lsp-client';
import { FileTranslator } from './file-translator';

// LSP session cache: language -> session_id (shared across all FileViewer instances)
const lspSessions = new Map<string, number>();

// -- Monaco worker config for Vite ESM --
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    const getWorkerUrl = (path: string) => new URL(path, import.meta.url).href;
    switch (label) {
      case 'json': return new Worker(getWorkerUrl('monaco-editor/esm/vs/language/json/json.worker.js'), { type: 'module' });
      case 'css': case 'scss': case 'less': return new Worker(getWorkerUrl('monaco-editor/esm/vs/language/css/css.worker.js'), { type: 'module' });
      case 'html': case 'handlebars': case 'razor': return new Worker(getWorkerUrl('monaco-editor/esm/vs/language/html/html.worker.js'), { type: 'module' });
      case 'typescript': case 'javascript': return new Worker(getWorkerUrl('monaco-editor/esm/vs/language/typescript/ts.worker.js'), { type: 'module' });
      default: return new Worker(getWorkerUrl('monaco-editor/esm/vs/editor/editor.worker.js'), { type: 'module' });
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
  private diffEditor!: monaco.editor.IStandaloneDiffEditor;
  private resizeHandle!: HTMLElement;
  private windowCloseBtn!: HTMLElement;
  private translator!: FileTranslator;

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
      minWidth: '360px', minHeight: '240px',
    });

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.el.appendChild(brackets);

    // Header — tab bar + window close
    this.header = document.createElement('div');
    this.header.className = 'fv-header';
    Object.assign(this.header.style, {
      display: 'flex', alignItems: 'center', gap: '4px',
      padding: '4px 6px',
      borderBottom: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.4))',
      cursor: 'move', userSelect: 'none', flexShrink: '0',
      background: 'var(--panel-bg, rgba(14, 22, 38, 0.9))',
      minHeight: '34px', overflow: 'hidden',
    });

    this.tabBar = document.createElement('div');
    Object.assign(this.tabBar.style, {
      display: 'flex', flex: '1', gap: '2px', overflow: 'auto', minWidth: '0',
    });

    this.windowCloseBtn = document.createElement('button');
    this.windowCloseBtn.className = 'fv-close';
    this.windowCloseBtn.innerHTML = iconHtml('close', 14);
    Object.assign(this.windowCloseBtn.style, {
      width: '22px', height: '22px', padding: '0', flexShrink: '0',
      background: 'none', border: 'none', color: 'var(--text-muted, #4a5568)',
      cursor: 'pointer', fontSize: '14px', borderRadius: '4px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    this.windowCloseBtn.addEventListener('mouseenter', () => {
      this.windowCloseBtn.style.color = 'var(--starlight-dim)';
      this.windowCloseBtn.style.background = 'rgba(255,255,255,0.05)';
    });
    this.windowCloseBtn.addEventListener('mouseleave', () => {
      this.windowCloseBtn.style.color = 'var(--text-muted)';
      this.windowCloseBtn.style.background = 'none';
    });
    this.windowCloseBtn.addEventListener('click', () => this.closeAll());

    // "Ask Agent" button — analyze the current file
    const askBtn = document.createElement('button');
    askBtn.className = 'fv-ask-btn';
    askBtn.innerHTML = iconHtml('agent', 13);
    askBtn.title = '问 Agent 分析当前文件';
    Object.assign(askBtn.style, {
      width: '22px', height: '22px', padding: '0', flexShrink: '0',
      background: 'none', border: 'none', color: 'var(--text-muted, #4a5568)',
      cursor: 'pointer', fontSize: '14px', borderRadius: '4px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'color var(--snap, 0.12s)',
    });
    askBtn.addEventListener('mouseenter', () => { askBtn.style.color = 'var(--signal, #7eb8ff)'; });
    askBtn.addEventListener('mouseleave', () => { askBtn.style.color = 'var(--text-muted, #4a5568)'; });
    askBtn.addEventListener('click', () => {
      const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
      if (tab) {
        askAgent(`分析文件 "${tab.filePath}" 的依赖关系和耦合状况。它和其他模块的关联是什么？如果修改它会影响哪些模块？`);
      }
    });

    // "Translate" button — translate current file
    const translateBtn = document.createElement('button');
    translateBtn.className = 'fv-translate-btn';
    translateBtn.innerHTML = '🔮';
    translateBtn.title = '翻译当前文件';
    Object.assign(translateBtn.style, {
      width: '22px', height: '22px', padding: '0', flexShrink: '0',
      background: 'none', border: 'none', color: 'var(--text-muted, #4a5568)',
      cursor: 'pointer', fontSize: '14px', borderRadius: '4px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'color var(--snap, 0.12s)',
    });
    translateBtn.addEventListener('mouseenter', () => { translateBtn.style.color = 'var(--nebula, #a088e0)'; });
    translateBtn.addEventListener('mouseleave', () => { translateBtn.style.color = 'var(--text-muted, #4a5568)'; });
    translateBtn.addEventListener('click', () => {
      const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
      if (tab && !tab.diffModels) {
        this.translator.translateFile(tab.filePath);
      }
    });

    this.header.appendChild(this.tabBar);
    this.header.appendChild(askBtn);
    this.header.appendChild(translateBtn);
    this.header.appendChild(this.windowCloseBtn);

    // Editor container
    this.editorContainer = document.createElement('div');
    Object.assign(this.editorContainer.style, { flex: '1', overflow: 'hidden' });

    // Diff editor container (hidden by default)
    this.diffEditorContainer = document.createElement('div');
    Object.assign(this.diffEditorContainer.style, { flex: '1', overflow: 'hidden', display: 'none' });

    // Resize handle
    this.resizeHandle = document.createElement('div');
    this.resizeHandle.className = 'fv-grip';
    Object.assign(this.resizeHandle.style, {
      position: 'absolute', right: '0', bottom: '0',
      width: '14px', height: '14px', cursor: 'nwse-resize', zIndex: '2',
    });

    this.el.appendChild(this.header);
    this.el.appendChild(this.editorContainer);
    this.el.appendChild(this.diffEditorContainer);
    this.el.appendChild(this.resizeHandle);

    // Drag — only on empty header area
    this.header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('.fv-tab')) return;
      this.onDragStart(e);
    });
    window.addEventListener('pointermove', (e) => this.onDragMove(e));
    window.addEventListener('pointerup', () => this.onDragEnd());

    // Resize
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
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      tabSize: 4,
      automaticLayout: false, // we handle resize manually
      wordWrap: 'off',
      // Match our deep-space theme
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      // ── Enabled Monaco IDE features ──
      bracketPairColorization: { enabled: true },
      cursorSmoothCaretAnimation: 'on',
      linkedEditing: true,
      stickyScroll: { enabled: true },
      formatOnPaste: true,
      matchBrackets: 'always',
    });

    // Ctrl+S → save
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.saveActiveTab());

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
      label: '🔮 翻译选中',
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
      const tabEl = document.createElement('div');
      tabEl.className = 'fv-tab';
      const isActive = i === this.activeIdx;
      Object.assign(tabEl.style, {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '3px 8px', borderRadius: '4px', cursor: 'pointer',
        fontSize: '11px', fontFamily: 'var(--font-mono, monospace)',
        whiteSpace: 'nowrap', flexShrink: '0', maxWidth: '160px',
        background: isActive ? 'rgba(30, 55, 100, 0.45)' : 'transparent',
        color: isActive ? 'var(--starlight, #e6edf3)' : 'var(--text-muted)',
        border: isActive ? '1px solid rgba(60, 100, 170, 0.3)' : '1px solid transparent',
      });
      tabEl.title = tab.filePath;

      // Dirty indicator
      const label = document.createElement('span');
      label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      label.textContent = tab.dirty ? `● ${tab.fileName}` : tab.fileName;

      const closeBtn = document.createElement('button');
      closeBtn.innerHTML = iconHtml('close', 10);
      Object.assign(closeBtn.style, {
        background: 'none', border: 'none', cursor: 'pointer',
        color: 'inherit', padding: '0', fontSize: '10px',
        display: 'flex', alignItems: 'center', flexShrink: '0',
        opacity: '0.5',
      });
      closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
      closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.5'; });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(i);
      });

      tabEl.appendChild(label);
      tabEl.appendChild(closeBtn);
      tabEl.addEventListener('click', () => this.switchTab(i));
      this.tabBar.appendChild(tabEl);
    }
  }

  private switchTab(idx: number): void {
    if (idx < 0 || idx >= this.tabs.length) return;
    // Detach translator panel from old tab (keep API running, hide panel)
    this.translator.detach();
    this.activeIdx = idx;
    const tab = this.tabs[idx];
    if (tab.diffModels) {
      if (this.diffEditor) this.diffEditor.setModel(tab.diffModels);
      this.showDiffEditor();
      if (this.diffEditor) this.diffEditor.layout();
    } else {
      this.editor.setModel(tab.model);
      this.showNormalEditor();
      this.editor.layout();
      this.editor.focus();
    }
    this.renderTabs();
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

  async open(filePath: string): Promise<void> {
    const existingIdx = this.tabs.findIndex(t => t.filePath === filePath);
    if (existingIdx >= 0) {
      this.activeIdx = existingIdx;
      this.renderTabs();
      this.editor.setModel(this.tabs[existingIdx].model);
      this.el.classList.add('fv-open');
      this.el.style.zIndex = String(Math.max(30, Number(this.el.style.zIndex) + 1));
      this.centerOnScreen();
      this.editor.layout();
      return;
    }

    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
    const uri = monaco.Uri.parse(`file:///${filePath.replace(/\\/g, '/')}`);
    const language = detectLanguage(fileName);

    // Show loading state in a temp model
    const loadingModel = monaco.editor.createModel('加载中...', 'plaintext');
    this.editor.setModel(loadingModel);

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

      // LSP: start server and register providers for this language
      if (!lspSessions.has(language)) {
        startLsp(language, `file:///${filePath}`).then(sid => {
          if (sid !== null) {
            lspSessions.set(language, sid);
            registerCompletionProvider(language, sid, monaco);
            registerHoverProvider(language, sid, monaco);
            registerDefinitionProvider(language, sid, monaco);
            registerReferencesProvider(language, sid, monaco);
            didOpen(sid, uri.toString(), language, content);
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
  }

  private async saveActiveTab(): Promise<void> {
    if (this.activeIdx < 0 || this.activeIdx >= this.tabs.length) return;
    const tab = this.tabs[this.activeIdx];
    if (!tab.dirty) return;

    const content = tab.model.getValue();
    try {
      await invoke('write_file_content', { filePath: tab.filePath, content });
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
        fontSize: 13,
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
    this.diffEditorContainer.style.display = '';
  }

  private showNormalEditor(): void {
    this.diffEditorContainer.style.display = 'none';
    this.editorContainer.style.display = '';
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
