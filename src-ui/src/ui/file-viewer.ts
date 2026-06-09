// Floating File Viewer — 浮动文件窗口
// 可从简报/详情卡片/聊天中点击文件名呼出，显示代码内容
// 支持拖拽移动、调整大小、关闭

import { invoke } from '../bridge';

interface ViewerState {
  open: boolean;
  filePath: string;
  content: string;
  loading: boolean;
  error: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class FileViewer {
  private el!: HTMLElement;
  private header!: HTMLElement;
  private title!: HTMLElement;
  private contentEl!: HTMLElement;
  private pre!: HTMLElement;
  private resizeHandle!: HTMLElement;
  private state: ViewerState;
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
      filePath: '',
      content: '',
      loading: false,
      error: '',
      x: 100,
      y: 80,
      width: 600,
      height: 420,
    };
    this.buildDOM();
  }

  private buildDOM(): void {
    this.el = document.createElement('div');
    this.el.id = 'file-viewer';
    this.el.className = 'file-viewer';
    Object.assign(this.el.style, {
      position: 'absolute',
      zIndex: '30',
      display: 'none',
      width: `${this.state.width}px`,
      height: `${this.state.height}px`,
      left: `${this.state.x}px`,
      top: `${this.state.y}px`,
      background: 'var(--panel-bg, rgba(6, 12, 24, 0.97))',
      backdropFilter: 'var(--blur, blur(14px))',
      WebkitBackdropFilter: 'var(--blur, blur(14px))',
      border: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.5))',
      borderRadius: '8px',
      boxShadow: '0 12px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(88,120,180,0.08) inset',
      flexDirection: 'column',
      overflow: 'hidden',
      minWidth: '280px',
      minHeight: '180px',
    });

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.el.appendChild(brackets);

    // Header (draggable)
    this.header = document.createElement('div');
    this.header.className = 'fv-header';
    Object.assign(this.header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 10px',
      borderBottom: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.4))',
      cursor: 'move',
      userSelect: 'none',
      flexShrink: '0',
      background: 'var(--panel-bg, rgba(14, 22, 38, 0.9))',
    });

    this.title = document.createElement('span');
    this.title.className = 'fv-title';
    Object.assign(this.title.style, {
      fontSize: '12px',
      fontWeight: '600',
      color: 'var(--signal, #7eb8ff)',
      flex: '1',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontFamily: 'var(--font-mono, Cascadia Code, Fira Code, Consolas, monospace)',
    });
    this.title.textContent = '文件查看器';

    const pathLabel = document.createElement('span');
    pathLabel.className = 'fv-path';
    Object.assign(pathLabel.style, {
      fontSize: '10px',
      color: 'var(--text-muted, #4a5568)',
      fontFamily: 'var(--font-mono, Cascadia Code, Fira Code, Consolas, monospace)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      maxWidth: '300px',
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'fv-close';
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      width: '22px', height: '22px', padding: '0',
      background: 'none', border: 'none', color: 'var(--text-muted, #4a5568)',
      cursor: 'pointer', fontSize: '14px', borderRadius: '4px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'color var(--snap, 0.12s), background var(--snap, 0.12s)',
    });
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.color = 'var(--starlight-dim, #c9d1d9)';
      closeBtn.style.background = 'rgba(255,255,255,0.05)';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.color = 'var(--text-muted, #4a5568)';
      closeBtn.style.background = 'none';
    });
    closeBtn.addEventListener('click', () => this.close());

    this.header.appendChild(this.title);
    this.header.appendChild(pathLabel);
    this.header.appendChild(closeBtn);

    // Content area
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'fv-body';
    Object.assign(this.contentEl.style, {
      flex: '1',
      overflow: 'auto',
      padding: '0',
    });

    this.pre = document.createElement('pre');
    Object.assign(this.pre.style, {
      margin: '0',
      padding: '12px 14px',
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      fontSize: '12px',
      lineHeight: '1.6',
      color: '#c9d1d9',
      whiteSpace: 'pre',
      tabSize: '4',
      MozTabSize: '4',
    });

    const scrollStyles = document.createElement('style');
    scrollStyles.textContent = `
      #file-viewer ::-webkit-scrollbar { width: 5px; height: 5px; }
      #file-viewer ::-webkit-scrollbar-track { background: transparent; }
      #file-viewer ::-webkit-scrollbar-thumb { background: rgba(48, 60, 80, 0.5); border-radius: 3px; }
      #file-viewer ::-webkit-scrollbar-thumb:hover { background: rgba(68, 80, 100, 0.6); }
      #file-viewer .fv-syntax-keyword { color: #c678dd; }
      #file-viewer .fv-syntax-string { color: #98c379; }
      #file-viewer .fv-syntax-comment { color: #5c6370; font-style: italic; }
      #file-viewer .fv-syntax-number { color: #d19a66; }
      #file-viewer .fv-syntax-func { color: #61afef; }
      #file-viewer .fv-syntax-type { color: #e5c07b; }
    `;
    this.contentEl.appendChild(scrollStyles);
    this.contentEl.appendChild(this.pre);

    // Resize handle
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

    this.el.appendChild(this.header);
    this.el.appendChild(this.contentEl);
    this.el.appendChild(this.resizeHandle);

    // Drag handling
    this.header.addEventListener('pointerdown', (e) => this.onDragStart(e));
    window.addEventListener('pointermove', (e) => this.onDragMove(e));
    window.addEventListener('pointerup', () => this.onDragEnd());

    // Resize handling
    this.resizeHandle.addEventListener('pointerdown', (e) => this.onResizeStart(e));
    window.addEventListener('pointermove', (e) => this.onResizeMove(e));
    window.addEventListener('pointerup', () => this.onResizeEnd());

    document.body.appendChild(this.el);
  }

  // ── Public API ──

  async open(filePath: string): Promise<void> {
    if (this.state.open && this.state.filePath === filePath) {
      this.el.style.display = 'flex';
      // Bring to front
      this.el.style.zIndex = String(Number(this.el.style.zIndex) + 1);
      return;
    }

    this.state.open = true;
    this.state.filePath = filePath;
    this.state.loading = true;
    this.state.error = '';
    this.state.content = '';

    // Extract just the filename for display
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
    this.title.textContent = fileName;
    const pathLabel = this.header.querySelector('.fv-path') as HTMLElement;
    if (pathLabel) pathLabel.textContent = filePath;

    this.pre.textContent = '⏳ 加载中...';
    this.pre.style.color = 'var(--text-muted, #4a5568)';
    this.el.style.display = 'flex';

    try {
      const content = await invoke<string>('read_file_content', { filePath });
      this.state.content = content;
      this.state.loading = false;
      this.pre.textContent = content;
      this.pre.style.color = 'var(--starlight-dim, #c9d1d9)';
    } catch (err: any) {
      this.state.error = String(err);
      this.state.loading = false;
      this.pre.textContent = `❌ 读取失败: ${err}`;
      this.pre.style.color = 'var(--fail, #e05555)';
    }
  }

  close(): void {
    this.state.open = false;
    this.el.style.display = 'none';
  }

  toggle(): void {
    if (this.state.open) this.close();
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  // ── Drag ──

  private onDragStart(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('button')) return; // don't drag on buttons
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
    this.el.style.left = `${this.dragStart.elX + dx}px`;
    this.el.style.top = `${this.dragStart.elY + dy}px`;
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
    e.stopPropagation();
    e.preventDefault();
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
    const newW = Math.max(280, this.dragStart.w + dw);
    const newH = Math.max(180, this.dragStart.h + dh);
    this.el.style.width = `${newW}px`;
    this.el.style.height = `${newH}px`;
  }

  private onResizeEnd(): void {
    if (this.resizing) {
      this.state.width = parseInt(this.el.style.width) || this.state.width;
      this.state.height = parseInt(this.el.style.height) || this.state.height;
    }
    this.resizing = false;
  }
}
