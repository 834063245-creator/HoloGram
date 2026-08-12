// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Floating File Viewer — 浮动文件窗口（标签页式 + Monaco 编辑器）
// 可从简报/详情卡片/聊天/时间轴中点击文件名呼出
// 支持拖拽移动、调整大小、多标签页、Ctrl+S 保存

import * as monaco from 'monaco-editor';
import { typedRpc } from '../rpc-contract';
import { askAgent } from './agent-visualizer';
import { iconHtml, iconSvg } from './icons';

// ponytail: 初始化时读取一次 CSS 变量；用户修改需重新加载
function getFontScale(): number {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim();
    return parseFloat(v) || 1;
  } catch {
    return 1;
  }
}

import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { marked } from 'marked';
// Monaco workers — Vite ?worker 语法将其打包为独立 chunk
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { stripLineNumbers } from './chat-session';
import { FileTranslator } from './file-translator';
import {
  didChange,
  didClose,
  didOpen,
  listenForDiagnostics,
  registerCompletionProvider,
  registerDefinitionProvider,
  registerHoverProvider,
  registerReferencesProvider,
  startLsp,
  stopAllLsp,
} from './lsp-client';

// LSP 会话缓存：language -> session_id（所有 FileViewer 实例共享）
const lspSessions = new Map<string, number>();

// -- Monaco worker 配置 --
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
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
  /** 若设置，此标签页为只读 diff 视图。 */
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
  private translator!: FileTranslator;
  // ── 新界面 ──
  private breadcrumb!: HTMLElement;
  private toolbar!: HTMLElement;
  private statusBar!: HTMLElement;
  private statusLsp!: HTMLElement;
  private statusCursor!: HTMLElement;
  private toolbarBtns: Record<string, HTMLButtonElement> = {};
  private windowCloseBtn: HTMLButtonElement | null = null;

  private tabs: TabData[] = [];
  private activeIdx = -1;
  private state: WindowState;
  projectPath: string | null = null;
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
      x: 100,
      y: 80,
      width: 780,
      height: 500,
    };
    this.buildDOM();
    this.initEditor();
    this.translator = new FileTranslator(
      this.el,
      () => {
        this.editor.layout();
        if (this.diffEditor) this.diffEditor.layout();
      },
      () => this.editor,
    );
  }

  private buildDOM(): void {
    // ── 外壳 ──
    this.el = document.createElement('div');
    this.el.id = 'file-viewer';
    this.el.className = 'file-viewer';
    Object.assign(this.el.style, {
      position: 'absolute',
      zIndex: '30',
      width: `${this.state.width}px`,
      height: `${this.state.height}px`,
      left: `${this.state.x}px`,
      top: `${this.state.y}px`,
      background: 'var(--obs-glass-hi, rgba(6, 12, 24, 0.97))',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      border: '1px solid var(--obs-line, rgba(48, 60, 80, 0.5))',
      borderRadius: '12px',
      boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
      flexDirection: 'column',
      overflow: 'hidden',
      minWidth: '420px',
      minHeight: '320px',
    });

    // ═══════════════════════════════════════════════
    // LAYER 1: 标题栏 — 面包屑 + 窗口操作
    // ═══════════════════════════════════════════════
    this.header = document.createElement('div');
    this.header.className = 'fv-titlebar';
    Object.assign(this.header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      minHeight: 'calc(30px * var(--font-scale))',
      padding: '0 calc(6px * var(--font-scale))',
      flexShrink: '0',
      cursor: 'move',
      userSelect: 'none',
      background: 'none',
      borderBottom: '1px solid var(--obs-line-soft)',
    });

    // 面包屑
    this.breadcrumb = document.createElement('div');
    this.breadcrumb.className = 'fv-breadcrumb';
    Object.assign(this.breadcrumb.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      flex: '1',
      overflow: 'hidden',
      fontSize: 'calc(10px * var(--font-scale))',
      fontFamily: 'var(--obs-font-mono, monospace)',
      color: 'var(--obs-text-2)',
      minWidth: '0',
    });
    this.header.appendChild(this.breadcrumb);

    // 窗口操作按钮
    const winActions = document.createElement('div');
    winActions.className = 'fv-win-actions';
    Object.assign(winActions.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      flexShrink: '0',
    });
    for (const { id, icon, tip, colorVar, hoverBg } of [
      {
        id: 'agent',
        icon: 'agent',
        tip: '问 Agent 分析当前文件',
        colorVar: 'var(--obs-blue)',
        hoverBg: 'rgba(160,180,220,0.08)',
      },
      {
        id: 'translate',
        icon: 'translate',
        tip: '翻译当前文件',
        colorVar: '#a088e0',
        hoverBg: 'rgba(160,180,220,0.08)',
      },
      { id: 'close', icon: 'close', tip: '关闭', colorVar: '#ffd9d6', hoverBg: 'rgba(217,99,95,0.25)' },
    ]) {
      const btn = document.createElement('button');
      btn.className = `fv-title-btn`;
      btn.innerHTML = iconHtml(icon, 13);
      btn.title = tip;
      Object.assign(btn.style, {
        minWidth: 'calc(22px * var(--font-scale))',
        minHeight: 'calc(22px * var(--font-scale))',
        padding: '0',
        border: 'none',
        cursor: 'pointer',
        background: 'none',
        color: 'var(--obs-text-2)',
        borderRadius: '4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 'calc(13px * var(--font-scale))',
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.color = colorVar;
        btn.style.background = hoverBg;
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.color = 'var(--obs-text-2)';
        btn.style.background = 'none';
      });
      if (id === 'agent') {
        btn.addEventListener('click', () => {
          const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
          if (tab)
            askAgent(
              `分析文件 "${tab.filePath}" 的依赖关系和耦合状况。它和其他模块的关联是什么？如果修改它会影响哪些模块？`,
            );
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

    // 从标题栏拖拽（不从按钮上）
    this.header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.onDragStart(e);
    });

    // ═══════════════════════════════════════════════
    // LAYER 2: 工具栏 — 保存 / 撤销 / 重做 / 格式化
    // ═══════════════════════════════════════════════
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'fv-toolbar';
    Object.assign(this.toolbar.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '1px',
      height: '26px',
      padding: '0 4px',
      flexShrink: '0',
      background: 'none',
      borderBottom: '1px solid var(--obs-line-soft)',
    });

    const btnDefs: [string, string, string, () => void][] = [
      ['save', '保存 (Ctrl+S)', 'var(--obs-text)', () => this.saveActiveTab()],
      ['undo', '撤销 (Ctrl+Z)', 'var(--obs-text-2)', () => this.editor.trigger('', 'undo', null)],
      ['redo', '重做 (Ctrl+Y)', 'var(--obs-text-2)', () => this.editor.trigger('', 'redo', null)],
      ['search', '查找 (Ctrl+F)', 'var(--obs-text-2)', () => this.editor.getAction('actions.find')?.run()],
    ];

    for (const [icon, tip, _color, action] of btnDefs) {
      const btn = document.createElement('button');
      btn.innerHTML = iconHtml(icon, 12);
      btn.title = tip;
      Object.assign(btn.style, {
        width: '22px',
        height: '20px',
        padding: '0',
        border: 'none',
        cursor: 'pointer',
        background: 'none',
        color: 'var(--obs-text-2)',
        borderRadius: '3px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.color = 'var(--obs-text)';
        btn.style.background = 'rgba(160,180,220,0.08)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.color = 'var(--obs-text-2)';
        btn.style.background = 'none';
      });
      btn.addEventListener('click', action);
      this.toolbarBtns[icon] = btn;
      this.toolbar.appendChild(btn);
    }

    // 分隔符
    const sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:14px;background:var(--obs-line);margin:0 4px;';
    this.toolbar.appendChild(sep);

    // 格式化按钮
    const fmtBtn = document.createElement('button');
    fmtBtn.innerHTML = iconHtml('edit', 12);
    fmtBtn.title = '格式化文档';
    Object.assign(fmtBtn.style, {
      width: '22px',
      height: '20px',
      padding: '0',
      border: 'none',
      cursor: 'pointer',
      background: 'none',
      color: 'var(--obs-text-2)',
      borderRadius: '3px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
    fmtBtn.addEventListener('mouseenter', () => {
      fmtBtn.style.color = 'var(--obs-blue)';
      fmtBtn.style.background = 'rgba(160,180,220,0.08)';
    });
    fmtBtn.addEventListener('mouseleave', () => {
      fmtBtn.style.color = 'var(--obs-text-2)';
      fmtBtn.style.background = 'none';
    });
    fmtBtn.addEventListener('click', () => this.editor.getAction('editor.action.formatDocument')?.run());
    this.toolbarBtns.format = fmtBtn;
    this.toolbar.appendChild(fmtBtn);

    // 预览切换
    const prevSep = document.createElement('div');
    prevSep.style.cssText = 'width:1px;height:14px;background:var(--obs-line);margin:0 4px;';
    this.toolbar.appendChild(prevSep);

    const previewBtn = document.createElement('button');
    previewBtn.innerHTML = iconHtml('eye', 12);
    previewBtn.title = '切换预览 (Markdown / 图片)';
    Object.assign(previewBtn.style, {
      width: '22px',
      height: '20px',
      padding: '0',
      border: 'none',
      cursor: 'pointer',
      background: 'none',
      color: 'var(--obs-text-2)',
      borderRadius: '3px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
    previewBtn.addEventListener('mouseenter', () => {
      previewBtn.style.color = '#a088e0';
      previewBtn.style.background = 'rgba(160,180,220,0.08)';
    });
    previewBtn.addEventListener('mouseleave', () => {
      previewBtn.style.color = 'var(--obs-text-2)';
      previewBtn.style.background = 'none';
    });
    previewBtn.addEventListener('click', () => this.togglePreview());
    this.toolbarBtns.preview = previewBtn;
    this.toolbar.appendChild(previewBtn);

    // ═══════════════════════════════════════════════
    // LAYER 3: 标签栏 — 文件标签（整洁，独立行）
    // ═══════════════════════════════════════════════
    this.tabBar = document.createElement('div');
    this.tabBar.className = 'fv-tabbar';
    Object.assign(this.tabBar.style, {
      display: 'flex',
      alignItems: 'flex-end',
      gap: '0',
      height: '30px',
      padding: '0 4px',
      flexShrink: '0',
      overflowX: 'auto',
      overflowY: 'hidden',
      background: 'none',
      borderBottom: '1px solid var(--obs-line-soft)',
      minHeight: '30px',
    });

    // ═══════════════════════════════════════════════
    // LAYER 4: 编辑器区域
    // ═══════════════════════════════════════════════
    this.editorContainer = document.createElement('div');
    Object.assign(this.editorContainer.style, { flex: '1', overflow: 'hidden' });
    this.diffEditorContainer = document.createElement('div');
    Object.assign(this.diffEditorContainer.style, { flex: '1', overflow: 'hidden', display: 'none' });

    // 预览容器（markdown / 图片）
    this.previewContainer = document.createElement('div');
    this.previewContainer.className = 'fv-preview';
    Object.assign(this.previewContainer.style, {
      flex: '1',
      overflow: 'auto',
      display: 'none',
      padding: '24px 32px',
      color: 'var(--obs-text, #c8d6e5)',
      fontSize: 'calc(13px * var(--font-scale))',
      lineHeight: '1.7',
      fontFamily: 'var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif)',
    });

    // ═══════════════════════════════════════════════
    // LAYER 5: 状态栏 — LSP · 语言 · 光标
    // ═══════════════════════════════════════════════
    this.statusBar = document.createElement('div');
    this.statusBar.className = 'fv-statusbar';
    Object.assign(this.statusBar.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: '22px',
      padding: '0 8px',
      flexShrink: '0',
      background: 'none',
      borderTop: '1px solid var(--obs-line-soft)',
      fontSize: 'calc(10px * var(--font-scale))',
      fontFamily: 'var(--obs-font-mono, monospace)',
      color: 'var(--obs-text-2)',
    });

    // 左侧：LSP 状态 + 语言
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

    // 右侧：光标位置 + 编码
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
    // 组装
    // ═══════════════════════════════════════════════
    this.el.appendChild(this.header);
    this.el.appendChild(this.toolbar);
    this.el.appendChild(this.tabBar);
    this.el.appendChild(this.editorContainer);
    this.el.appendChild(this.diffEditorContainer);
    this.el.appendChild(this.previewContainer);
    this.el.appendChild(this.statusBar);

    // 调整大小手柄
    this.resizeHandle = document.createElement('div');
    this.resizeHandle.className = 'fv-grip';
    Object.assign(this.resizeHandle.style, {
      position: 'absolute',
      right: '0',
      bottom: '0',
      width: '14px',
      height: '14px',
      cursor: 'nwse-resize',
      zIndex: '2',
    });
    this.el.appendChild(this.resizeHandle);

    // 全局拖拽/调整大小监听器
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

    // Ctrl+S → 保存
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.saveActiveTab());

    // ── 光标位置 → 状态栏 ──
    this.editor.onDidChangeCursorPosition((e) => {
      this.statusCursor.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });

    // ── 编辑器聚焦 → 更新面包屑和状态 ──
    this.editor.onDidFocusEditorText(() => {
      const pos = this.editor.getPosition();
      if (pos) this.statusCursor.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
      this.updateBreadcrumb();
      this.updateStatusBar();
    });

    // LSP 诊断监听器
    listenForDiagnostics(this.editor, monaco);

    // 编辑器右键菜单操作
    this.editor.addAction({
      id: 'format-document',
      label: '格式化文档',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 2,
      run: () => this.editor.getAction('editor.action.formatDocument')?.run(),
    });
    this.editor.addAction({
      id: 'copy-file-path',
      label: '复制文件路径',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 3,
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
          this.translator.translateSelection(selectedText, selection.startLineNumber, selection.endLineNumber);
        }
      },
    });
  }

  // ── 标签页渲染 ──

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
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '26px',
        padding: '0 10px',
        cursor: 'pointer',
        fontSize: 'calc(11px * var(--font-scale))',
        fontFamily: 'var(--obs-font-mono, monospace)',
        whiteSpace: 'nowrap',
        flexShrink: '0',
        maxWidth: '170px',
        borderTop: isActive ? '2px solid var(--obs-brass)' : '2px solid transparent',
        background: isActive ? 'var(--obs-brass-dim)' : 'transparent',
        color: isActive ? 'var(--obs-text, #e6edf3)' : 'var(--obs-text-2)',
        borderRadius: '3px 3px 0 0',
      });

      // 文件图标
      const ficon = document.createElement('span');
      ficon.innerHTML = isDiff ? iconHtml('diff', 12) : fileIconSvg(tab.fileName, 12);
      ficon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;opacity:0.7;';
      tabEl.appendChild(ficon);

      // 未保存标记点
      if (tab.dirty) {
        const dot = document.createElement('span');
        dot.className = 'fv-tab-dirty';
        dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--obs-warn);flex-shrink:0;';
        tabEl.appendChild(dot);
      }

      // 标签
      const label = document.createElement('span');
      label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      label.textContent = tab.fileName;

      // 关闭按钮 — 悬停时显示
      const closeBtn = document.createElement('button');
      closeBtn.innerHTML = iconHtml('close', 10);
      Object.assign(closeBtn.style, {
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'inherit',
        padding: '0',
        fontSize: 'calc(10px * var(--font-scale))',
        display: 'flex',
        alignItems: 'center',
        flexShrink: '0',
        opacity: '0',
        borderRadius: '2px',
      });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(i);
      });
      tabEl.addEventListener('mouseenter', () => {
        closeBtn.style.opacity = '0.6';
      });
      tabEl.addEventListener('mouseleave', () => {
        closeBtn.style.opacity = '0';
      });

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

    // 图片自动预览；markdown 恢复预览
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
      this.editor.setModel(tab.model); // 确保 model 已挂载
      this.showPreview(); // 先显示容器以显示加载状态
      this.renderPreview(tab); // 异步加载，fire-and-forget
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

  // ── 面包屑：可点击的路径片段 ──

  private updateBreadcrumb(): void {
    const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
    this.breadcrumb.innerHTML = '';
    if (!tab?.filePath) {
      this.breadcrumb.textContent = '未打开文件';
      return;
    }
    const parts = tab.filePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) return;

    // 构建可点击片段
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
        span.style.color = 'var(--obs-blue)';
        span.style.background = 'rgba(160,180,220,0.08)';
      });
      span.addEventListener('mouseleave', () => {
        span.style.color = '';
        span.style.background = '';
      });
      span.addEventListener('click', () => {
        // ponytail: 文件树已移除 — 面包屑点击仍提供视觉反馈
      });
      this.breadcrumb.appendChild(span);
    });
  }

  // ── 状态栏：LSP 指示器 + 语言 + 光标 ──

  private updateStatusBar(): void {
    const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
    if (!tab) {
      this.statusLsp.innerHTML = `${iconHtml('dot', 8)} LSP`;
      this.statusLsp.style.opacity = '0.5';
      (this.statusBar.querySelector('.fv-lang-badge') as HTMLElement).textContent = '';
      this.statusCursor.textContent = 'Ln 1, Col 1';
      return;
    }

    // 语言标识
    const langSpan = this.statusBar.querySelector('.fv-lang-badge') as HTMLElement;
    if (langSpan) {
      langSpan.textContent = tab.model.getLanguageId();
    }

    // LSP 状态指示器
    const lang = tab.model.getLanguageId();
    const lspActive = lspSessions.has(lang);
    if (lspActive) {
      this.statusLsp.innerHTML = `${iconHtml('dot', 8)} LSP`;
      this.statusLsp.style.color = 'var(--obs-pass)';
      this.statusLsp.style.opacity = '1';
      this.statusLsp.title = `${lang} LSP 已连接`;
    } else if (lang === 'typescript' || lang === 'javascript' || lang === 'json' || lang === 'css' || lang === 'html') {
      // Monaco 内置支持
      this.statusLsp.innerHTML = `${iconHtml('dot', 8)} LSP`;
      this.statusLsp.style.color = 'var(--obs-text-2)';
      this.statusLsp.style.opacity = '1';
      this.statusLsp.title = `${lang} 使用 Monaco 内置支持`;
    } else {
      this.statusLsp.innerHTML = `${iconHtml('dot', 8)} LSP`;
      this.statusLsp.style.color = '';
      this.statusLsp.style.opacity = '0.5';
      this.statusLsp.title = 'LSP 未启动';
    }

    // 光标
    const pos = this.editor.getPosition();
    if (pos) {
      this.statusCursor.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
    }
  }

  private async closeTab(idx: number): Promise<void> {
    if (idx < 0 || idx >= this.tabs.length) return;
    const tab = this.tabs[idx];

    // 若关闭的标签页正在翻译，则销毁翻译器
    if (this.translator.isTranslatingFile(tab.filePath)) {
      this.translator.destroy();
    }

    // 检查未保存的修改
    if (tab.dirty) {
      const confirmed = confirm(`"${tab.fileName}" 有未保存的修改，确定关闭？`);
      if (!confirmed) return;
    }

    this._disposeTab(idx);

    if (this.tabs.length === 0) {
      this.closeAll();
      return;
    }
    if (this.activeIdx >= this.tabs.length) this.activeIdx = this.tabs.length - 1;
    else if (idx < this.activeIdx) this.activeIdx--;

    // 若活跃标签页被移除且新活跃标签页在同一索引位置
    if (idx === this.activeIdx) {
      this.editor.setModel(this.tabs[this.activeIdx].model);
    }
    this.switchTab(this.activeIdx);
  }

  /** 销毁标签页的编辑器资源，不弹确认框或更新 UI。 */
  private _disposeTab(idx: number): void {
    if (idx < 0 || idx >= this.tabs.length) return;
    const tab = this.tabs[idx];

    // LSP：通知服务器文档已关闭
    const lang = tab.model.getLanguageId();
    const sid = lspSessions.get(lang);
    if (sid) didClose(sid, tab.model.uri.toString());

    tab.model.dispose();
    if (tab.diffModels) {
      tab.diffModels.original.dispose();
      tab.diffModels.modified.dispose();
    }
    this.tabs.splice(idx, 1);
  }

  // ── 公共 API ──

  setProjectPath(path: string | null): void {
    if (this.projectPath && this.projectPath !== path) {
      stopAllLsp().catch(() => {});
      // 关闭旧工作区的所有标签页 — 它们引用的路径在新工作区中不存在
      for (let i = this.tabs.length - 1; i >= 0; i--) {
        this._disposeTab(i);
      }
      this.tabs = [];
      this.activeIdx = -1;
      this.tabBar.innerHTML = '';
      this.showNormalEditor();
      this.el.classList.remove('fv-open');
      this.state.open = false;
    }
    this.projectPath = path;
  }

  async open(filePath: string, opts?: { noAutoPreview?: boolean; line?: number }): Promise<void> {
    const targetLine = opts?.line;
    const existingIdx = this.tabs.findIndex((t) => t.filePath === filePath);
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
      if (targetLine) this.jumpToLine(targetLine);
      return;
    }

    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
    const uri = monaco.Uri.file(filePath);
    const language = detectLanguage(fileName);
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const imgExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

    // ── 图片文件：跳过文本读取，直接显示预览 ──
    if (imgExts.has(ext)) {
      this.state.open = true;
      this.centerOnScreen();
      this.el.classList.add('fv-open');
      this.el.style.zIndex = String(Math.max(30, Number(this.el.style.zIndex) + 1));

      const model = monaco.editor.createModel('', 'plaintext', uri);
      const newTab: TabData = {
        filePath,
        fileName,
        model,
        dirty: false,
        originalContent: '',
        loading: false,
        error: '',
        viewMode: 'preview',
      };
      this.tabs.push(newTab);
      this.activeIdx = this.tabs.length - 1;
      this.editor.setModel(model);
      this.showPreview();
      this.renderPreview(newTab); // 异步加载，无需等待
      this.renderTabs();
      this.updatePreviewButton();
      return;
    }

    // 在临时 model 中显示加载状态
    const loadingModel = monaco.editor.createModel('加载中...', 'plaintext');
    this.editor.setModel(loadingModel);
    this.showNormalEditor();

    this.state.open = true;
    this.centerOnScreen();
    this.el.classList.add('fv-open');
    this.el.style.zIndex = String(Math.max(30, Number(this.el.style.zIndex) + 1));

    try {
      const raw = await typedRpc('read_file_content', { file_path: filePath });
      // ponytail: read_file_content 返回 cat -n 格式。传递给 Monaco/LSP 前需去除行号。
      const content = stripLineNumbers(raw);

      // 销毁临时加载 model
      loadingModel.dispose();

      // 创建真实 model
      const model = monaco.editor.createModel(content, language, uri);

      const newTab: TabData = {
        filePath,
        fileName,
        model,
        dirty: false,
        originalContent: content,
        loading: false,
        error: '',
      };

      // 跟踪脏状态
      model.onDidChangeContent(() => {
        newTab.dirty = model.getValue() !== newTab.originalContent;
        this.renderTabs();
        // LSP：通知文档变更
        const sid = lspSessions.get(language);
        if (sid) didChange(sid, uri.toString(), model.getValue());
      });

      // LSP：仅对已配置服务器的语言尝试
      const LSP_LANGUAGES = new Set([
        'python',
        'rust',
        'go',
        'typescript',
        'javascript',
        'java',
        'c',
        'cpp',
        'csharp',
        'ruby',
        'lua',
        'php',
        'swift',
        'dart',
        'haskell',
        'elixir',
        'erlang',
        'zig',
        'shell',
        'html',
        'css',
        'scss',
        'less',
        'yaml',
        'yml',
        'scala',
        'kotlin',
        'r',
        'nix',
        'ocaml',
      ]);
      // ponytail: 使用项目根作为 rootUri，使 LSP 能找到 tsconfig/pyproject 等。
      const rootUri = this.projectPath ? `file:///${this.projectPath.replace(/\\/g, '/')}` : `file:///${filePath}`;
      if (!lspSessions.has(language) && LSP_LANGUAGES.has(language)) {
        startLsp(language, rootUri).then((sid) => {
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
        filePath,
        fileName,
        model: errModel,
        dirty: false,
        originalContent: '',
        loading: false,
        error: String(err),
      };
      this.tabs.push(newTab);
      this.activeIdx = this.tabs.length - 1;
      this.editor.setModel(errModel);
      this.renderTabs();
    }

    this.editor.layout();
    this.editor.focus();
    if (targetLine) this.jumpToLine(targetLine);
    this.updatePreviewButton();
  }

  /** 将编辑器光标跳转到 1-based 行号。 */
  private jumpToLine(line: number): void {
    const ln = Math.max(1, Math.round(line));
    this.editor.setPosition({ lineNumber: ln, column: 1 });
    this.editor.revealLineInCenter(ln);
  }

  private async saveActiveTab(): Promise<void> {
    if (this.activeIdx < 0 || this.activeIdx >= this.tabs.length) return;
    const tab = this.tabs[this.activeIdx];
    if (!tab.dirty) return;

    const content = tab.model.getValue();
    try {
      await typedRpc('write_file_content', { file_path: tab.filePath, content });
      // 记录时间线事件（异步触发）
      typedRpc('hologram_record_event', {
        event_type: 'file_changed',
        file: tab.filePath,
        summary: `保存: ${tab.fileName}`,
      }).catch(() => {
        /* 时间线记录为尽力而为 */
      });
      tab.originalContent = content;
      tab.dirty = false;
      tab.error = '';
      this.renderTabs();
    } catch (err: any) {
      alert(`保存失败: ${err}`);
    }
  }

  /** 打开并排 diff 视图（Monaco DiffEditor）— 由 GitPanel 使用。 */
  openInlineDiff(fileName: string, originalContent: string, modifiedContent: string): void {
    const label = `差异: ${fileName.replace(/\\/g, '/').split('/').pop() || fileName}`;

    // 延迟初始化 diff 编辑器
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
      model: modModel, // 占位符；diff 编辑器使用 diffModels
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

  /** 旧版包装器 — 原始 diff 文本作为普通 diff model。 */
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

  // ── 预览模式 ──

  private previewableExts = new Set(['md', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

  private canPreview(tab: TabData): boolean {
    if (tab.diffModels) return false;
    const ext = tab.fileName.split('.').pop()?.toLowerCase() || '';
    return this.previewableExts.has(ext);
  }

  private updatePreviewButton(): void {
    const btn = this.toolbarBtns.preview;
    if (!btn) return;
    const tab = this.activeIdx >= 0 ? this.tabs[this.activeIdx] : undefined;
    if (tab && this.canPreview(tab)) {
      btn.style.display = '';
      const isPreview = tab.viewMode === 'preview';
      btn.innerHTML = isPreview ? iconHtml('edit', 12) : iconHtml('eye', 12);
      btn.title = isPreview ? '返回编辑模式' : '切换预览';
      btn.style.color = isPreview ? '#a088e0' : 'var(--obs-text-2)';
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
      this.showPreview(); // 先显示容器使加载状态可见
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
    // 语法高亮代码块
    this.previewContainer.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
  }

  private async renderImagePreview(filePath: string): Promise<void> {
    this.previewContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--obs-text-2);">加载中...</div>`;
    try {
      const b64 = await typedRpc('read_file_base64', { file_path: filePath });
      const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        webp: 'image/webp',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
      };
      const mime = mimeMap[ext] || 'image/png';
      this.previewContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:200px;"><img src="data:${mime};base64,${b64}" alt="${filePath.replace(/\\/g, '/').split('/').pop()}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;box-shadow:0 4px 24px rgba(0,0,0,0.4);" /></div>`;
    } catch (err: any) {
      this.previewContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--obs-text-2);">⚠ 无法加载图片: ${String(err)}</div>`;
    }
  }

  closeAll(): void {
    // 销毁翻译器后再销毁 model（需要访问标签页信息）
    this.translator.destroy();
    this.state.open = false;
    // 销毁所有 model
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
    const w = parseInt(this.el.style.width, 10) || this.state.width;
    const h = parseInt(this.el.style.height, 10) || this.state.height;
    this.el.style.left = `${Math.max(0, (window.innerWidth - w) / 2)}px`;
    this.el.style.top = `${Math.max(36, (window.innerHeight - h) / 2)}px`;
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  // ── 拖拽 ──

  private onDragStart(e: PointerEvent): void {
    this.dragging = true;
    this.dragStart.x = e.clientX;
    this.dragStart.y = e.clientY;
    this.dragStart.elX = parseInt(this.el.style.left, 10) || this.state.x;
    this.dragStart.elY = parseInt(this.el.style.top, 10) || this.state.y;
    this.el.setPointerCapture(e.pointerId);
  }

  private onDragMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;
    const newX = this.dragStart.elX + dx;
    const newY = this.dragStart.elY + dy;
    const w = parseInt(this.el.style.width, 10) || this.state.width;
    const minVisible = 60;
    this.el.style.left = `${Math.max(-w + minVisible, Math.min(window.innerWidth - minVisible, newX))}px`;
    this.el.style.top = `${Math.max(0, Math.min(window.innerHeight - 36, newY))}px`;
  }

  private onDragEnd(): void {
    if (this.dragging) {
      this.state.x = parseInt(this.el.style.left, 10) || this.state.x;
      this.state.y = parseInt(this.el.style.top, 10) || this.state.y;
    }
    this.dragging = false;
  }

  // ── 调整大小 ──

  private onResizeStart(e: PointerEvent): void {
    e.stopPropagation();
    e.preventDefault();
    this.resizing = true;
    this.dragStart.x = e.clientX;
    this.dragStart.y = e.clientY;
    this.dragStart.w = parseInt(this.el.style.width, 10) || this.state.width;
    this.dragStart.h = parseInt(this.el.style.height, 10) || this.state.height;
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
      this.state.width = parseInt(this.el.style.width, 10) || this.state.width;
      this.state.height = parseInt(this.el.style.height, 10) || this.state.height;
    }
    this.resizing = false;
  }
}

// ── 按扩展名的文件图标 ──

function fileIconSvg(fileName: string, size: number): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'code',
    tsx: 'code',
    mts: 'code',
    cts: 'code',
    js: 'code',
    jsx: 'code',
    mjs: 'code',
    cjs: 'code',
    py: 'code-py',
    rs: 'code-rs',
    go: 'code-go',
    java: 'code',
    c: 'code',
    cpp: 'code',
    h: 'code',
    hpp: 'code',
    cs: 'code',
    rb: 'code',
    php: 'code',
    kt: 'code',
    kts: 'code',
    swift: 'code',
    lua: 'code',
    html: 'code',
    htm: 'code',
    css: 'code',
    scss: 'code',
    json: 'file',
    yaml: 'file',
    yml: 'file',
    toml: 'file',
    md: 'file',
    txt: 'file',
    log: 'file',
    svg: 'file',
    png: 'file',
    jpg: 'file',
    gif: 'file',
    ico: 'file',
  };
  return iconSvg(map[ext] || 'file', size);
}

// ── 语言检测 ──

function detectLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    lua: 'lua',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    toml: 'ini',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    dart: 'dart',
    hs: 'haskell',
    lhs: 'haskell',
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    hrl: 'erlang',
    zig: 'zig',
    scala: 'scala',
    r: 'r',
    nix: 'nix',
    ml: 'ocaml',
    mli: 'ocaml',
  };
  return map[ext] || 'plaintext';
}
