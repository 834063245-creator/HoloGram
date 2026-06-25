// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// 文件树面板 — 左侧滑入，项目目录树形浏览
// ═══════════════════════════════════════════════════════════════

import { invoke } from '../bridge';
import { iconSvg } from './icons';
import { FileViewer } from './file-viewer';
import { shell } from './app-shell';
import { askAgent } from './agent-visualizer';
import { dbg } from './debug';
import { showContextMenu } from './context-menu';

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: DirEntry[] | null;
}

export class FileTreePanel {
  el: HTMLElement;
  private treeEl: HTMLElement;
  private headerEl: HTMLElement;
  private open = false;
  private rootPath = '';
  private _transitioning = false;
  private _closeTimer: ReturnType<typeof setTimeout> | null = null;

  private static instance: FileTreePanel | null = null;
  static get(): FileTreePanel {
    if (!FileTreePanel.instance) FileTreePanel.instance = new FileTreePanel();
    return FileTreePanel.instance;
  }

  private constructor() {
    this.el = document.createElement('div');
    this.el.id = 'file-tree-panel';
    Object.assign(this.el.style, {
      position: 'absolute', left: '0', top: 'var(--toolbar-h)', bottom: 'var(--status-h)', zIndex: '25',
      width: '280px',
      background: 'var(--panel-bg, rgba(4, 10, 20, 0.97))',
      borderRight: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.45))',
      display: 'none', flexDirection: 'column',
      backdropFilter: 'var(--blur, blur(12px))',
      WebkitBackdropFilter: 'var(--blur, blur(12px))',
      transform: 'translateX(-100%)',
      transition: 'transform var(--glide, 0.28s cubic-bezier(0.23, 1, 0.32, 1))',
    });

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.el.appendChild(brackets);

    // ── Inline stylesheet for tree guides & open-file highlight ──
    const treeCSS = document.createElement('style');
    treeCSS.textContent = `
      .ft-row { position: relative; border-left: 2px solid transparent; }
      .ft-row.ft-open {
        background: rgba(50, 90, 150, 0.25) !important;
        border-left-color: rgba(80, 140, 220, 0.55);
      }
      .ft-row.ft-open .ft-name-file {
        color: var(--starlight, #e6edf3);
      }
      .ft-guide { pointer-events: none; z-index: 0; }
      .ft-connector { pointer-events: none; z-index: 1; }
      .ft-arrow, .ft-icon, .ft-name, .ft-ask-btn { position: relative; z-index: 2; }
    `;
    this.el.appendChild(treeCSS);

    // Header
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'ft-header';

    // Path label (root path display)
    const pathLabel = document.createElement('span');
    pathLabel.className = 'ft-path-label';
    Object.assign(pathLabel.style, {
      flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)',
    });
    this.headerEl.appendChild(pathLabel);

    // Refresh button
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'ft-header-btn';
    refreshBtn.innerHTML = iconSvg('refresh', 12);
    refreshBtn.title = '刷新';
    refreshBtn.addEventListener('click', () => {
      refreshBtn.style.transform = 'rotate(180deg)';
      setTimeout(() => { refreshBtn.style.transform = ''; }, 300);
      this.refresh();
    });

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ft-header-btn';
    closeBtn.innerHTML = iconSvg('close', 12);
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', () => this.close());

    this.headerEl.appendChild(refreshBtn);
    this.headerEl.appendChild(closeBtn);
    this.el.appendChild(this.headerEl);

    // Tree container
    this.treeEl = document.createElement('div');
    this.treeEl.className = 'ft-tree';

    // Empty-area context menu
    this.treeEl.addEventListener('contextmenu', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.ft-row')) return; // handled by row handler
      e.preventDefault();
      showContextMenu(e, [
        { label: '新建文件…', action: () => this.promptNewFile(this.rootPath) },
        { label: '新建文件夹…', action: () => this.promptNewFolder(this.rootPath) },
        { label: '刷新', action: () => this.refresh() },
      ]);
    });

    this.el.appendChild(this.treeEl);
    this.setupFilter();

    // ── Auto-refresh debounce timer ──
    let refreshTimer: ReturnType<typeof setTimeout>;

    document.body.appendChild(this.el);
  }

  async load(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    const pathLabel = this.headerEl.querySelector('.ft-path-label');
    if (pathLabel) pathLabel.textContent = rootPath;
    try {
      const entries: DirEntry[] = await invoke('list_directory', { path: rootPath });
      this.renderTree(entries, this.treeEl, rootPath);
    } catch (e) {
      this.treeEl.innerHTML = `<div style="padding:12px;color:var(--danger)">读取目录失败</div>`;
    }
  }

  refresh(): void {
    if (this.rootPath) this.load(this.rootPath);
  }

  toggle(): void {
    if (this._transitioning) return;
    this.open ? this.close() : this.show();
  }

  show(): void {
    if (this._transitioning) return;
    this._transitioning = true;
    // Cancel any pending close timer
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
    this.open = true;
    this.el.style.display = 'flex';
    requestAnimationFrame(() => {
      this.el.style.transform = 'translateX(0)';
    });
    // Unlock after transition completes
    setTimeout(() => { this._transitioning = false; }, 300);
    shell.notifyPanelChanged();
  }

  close(): void {
    if (this._transitioning) return;
    this._transitioning = true;
    this.open = false;
    this.el.style.transform = 'translateX(-100%)';
    this._closeTimer = setTimeout(() => {
      if (!this.open) this.el.style.display = 'none';
      this._transitioning = false;
      this._closeTimer = null;
    }, 300);
    shell.notifyPanelChanged();
  }

  isOpen(): boolean { return this.open; }

  // ── File operations (context menu) ──

  private async promptNewFile(parentPath: string): Promise<void> {
    const name = prompt('文件名:');
    if (!name) return;
    const fullPath = `${parentPath.replace(/\\/g, '/')}/${name}`;
    await invoke('write_file_content', { filePath: fullPath, content: '' });
    this.refresh();
  }

  private async promptNewFolder(parentPath: string): Promise<void> {
    const name = prompt('文件夹名:');
    if (!name) return;
    const fullPath = `${parentPath.replace(/\\/g, '/')}/${name}`;
    await invoke('create_directory', { path: fullPath });
    this.refresh();
  }

  private async promptRename(oldPath: string, oldName: string): Promise<void> {
    const newName = prompt('新名称:', oldName);
    if (!newName || newName === oldName) return;
    const parts = oldPath.replace(/\\/g, '/').split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');
    await invoke('rename_file_or_dir', { from: oldPath, to: newPath });
    this.refresh();
  }

  private async confirmDelete(targetPath: string, isDir: boolean): Promise<void> {
    const label = isDir ? `文件夹 "${targetPath}"` : `文件 "${targetPath}"`;
    if (!confirm(`确认删除 ${label}？\n此操作不可撤销。`)) return;
    await invoke('delete_file_or_dir', { path: targetPath });
    this.refresh();
  }

  // ── Filter ──

  private filterInput!: HTMLInputElement;

  private setupFilter(): void {
    this.filterInput = document.createElement('input');
    this.filterInput.placeholder = '过滤文件…';
    Object.assign(this.filterInput.style, {
      width: '100%', padding: '3px 8px', margin: '0',
      background: 'rgba(8,16,28,0.6)', border: '1px solid var(--panel-edge, rgba(48,60,80,0.3))',
      borderRadius: '3px', fontFamily: 'var(--font-mono)', fontSize: '10px',
      color: 'var(--starlight-dim)', outline: 'none', flexShrink: '0',
    });
    let timer: ReturnType<typeof setTimeout>;
    this.filterInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.applyFilter(this.filterInput.value), 200);
    });
    this.el.insertBefore(this.filterInput, this.treeEl);
  }

  private applyFilter(query: string): void {
    const q = query.toLowerCase();
    const rows = this.treeEl.querySelectorAll<HTMLElement>('.ft-row');
    // Track which parent containers have visible descendants
    const visibleParents = new Set<HTMLElement>();
    for (const row of rows) {
      const name = (row.querySelector('.ft-name')?.textContent || '').toLowerCase();
      const match = !q || name.includes(q);
      (row.style as any).display = match ? '' : 'none';
      if (match && q) {
        // Mark all ancestor containers as visible
        let p = row.nextElementSibling as HTMLElement;
        while (p) {
          if (p.tagName === 'DIV' && !p.classList.contains('ft-row')) {
            p.style.display = 'block';
          }
          p = p.nextElementSibling as HTMLElement;
        }
        // Also expand parent containers upward
        let parent = row.parentElement;
        while (parent && parent !== this.treeEl) {
          parent.style.display = 'block';
          const parentRow = parent.previousElementSibling as HTMLElement;
          const arrow = parentRow?.querySelector('.ft-arrow') as HTMLElement;
          if (arrow) arrow.textContent = '▾';
          parent = parent.parentElement;
        }
      }
    }
  }

  /** Highlight and scroll to a file path in the tree. Used by graph→tree reverse linking. */
  highlightPath(filePath: string): void {
    const normalized = filePath.replace(/\\/g, '/');
    // Find all row elements and look for matching file path
    const rows = this.treeEl.querySelectorAll<HTMLElement>('div[data-file-path]');
    for (const row of rows) {
      const rowPath = (row.dataset['filePath'] || '').replace(/\\/g, '/');
      if (rowPath === normalized || rowPath.endsWith('/' + normalized) || normalized.endsWith('/' + rowPath)) {
        // Expand parent containers
        let parent = row.parentElement;
        while (parent && parent !== this.treeEl) {
          if (parent.style.display === 'none') {
            parent.style.display = 'block';
            // Update parent arrow icon
            const parentRow = parent.previousElementSibling as HTMLElement;
            const arrow = parentRow?.querySelector('.ft-arrow') as HTMLElement;
            if (arrow) arrow.textContent = '▾';
          }
          parent = parent.parentElement;
        }
        // Scroll into view and highlight
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.style.background = 'rgba(60, 100, 170, 0.45)';
        row.style.borderLeftColor = 'rgba(100, 160, 240, 0.8)';
        setTimeout(() => {
          row.style.background = '';
          row.style.borderLeftColor = 'transparent';
        }, 2000);
        break;
      }
    }
  }

  // Track currently open file for highlight in tree
  private openFilePath = '';

  setOpenFilePath(path: string): void {
    if (this.openFilePath === path) return;
    // Remove old highlight
    const old = this.treeEl.querySelector('.ft-row.ft-open');
    if (old) old.classList.remove('ft-open');
    this.openFilePath = path;
    // Add new highlight
    const rows = this.treeEl.querySelectorAll<HTMLElement>('.ft-row');
    for (const row of rows) {
      const fp = (row.dataset['filePath'] || '').replace(/\\/g, '/');
      if (fp === path.replace(/\\/g, '/')) {
        row.classList.add('ft-open');
        break;
      }
    }
  }

  // ── Tree rendering ──

  // lastFlags[d] = the ancestor entry at depth d was the last child in its parent
  private renderTree(entries: DirEntry[], parent: HTMLElement, basePath: string, depth: number = 0, lastFlags: boolean[] = []): void {
    parent.innerHTML = '';
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const row = this.buildRow(entry, basePath, depth, lastFlags, isLast);
      parent.appendChild(row);

      if (entry.children && entry.children.length > 0) {
        const childContainer = document.createElement('div');
        childContainer.style.display = 'none';
        const childFlags = [...lastFlags, isLast];
        this.renderTree(entry.children, childContainer, basePath, depth + 1, childFlags);
        parent.appendChild(childContainer);

        row.addEventListener('click', (e) => {
          e.stopPropagation();
          const icon = row.querySelector('.ft-arrow') as HTMLElement;
          const expanded = childContainer.style.display !== 'none';
          if (expanded) {
            childContainer.style.display = 'none';
            if (icon) icon.textContent = '▸';
            dbg('FileTree.collapse', entry.path);
            shell.clearHighlight();
          } else {
            childContainer.style.display = 'block';
            if (icon) icon.textContent = '▾';
            dbg('FileTree.expand', entry.path);
            shell.highlightFolder(entry.path);
          }
        });
      } else if (entry.is_dir) {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          row.style.background = 'rgba(48, 60, 80, 0.35)';
          setTimeout(() => { row.style.background = ''; }, 300);
        });
      } else {
        row.addEventListener('click', () => {
          FileViewer.get().open(entry.path);
          this.setOpenFilePath(entry.path);
          dbg('FileTree.clickFile', entry.path);
          shell.highlightFile(entry.path);
        });
      }
    }
  }

  private buildRow(entry: DirEntry, _basePath: string, depth: number, lastFlags: boolean[], isLast: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ft-row';
    row.style.setProperty('--indent', `${12 + depth * 16}px`);
    row.dataset['filePath'] = entry.path;

    // Check if this file is currently open
    const normalizedEntryPath = entry.path.replace(/\\/g, '/');
    if (this.openFilePath.replace(/\\/g, '/') === normalizedEntryPath) {
      row.classList.add('ft-open');
    }

    // ── Indent guide lines ──
    // For each ancestor level (0..depth-1): draw a vertical continuation line
    // unless that ancestor was the last child (its branch ended).
    for (let lvl = 0; lvl < depth; lvl++) {
      const guide = document.createElement('span');
      guide.className = 'ft-guide';
      const left = 12 + lvl * 16 + 7; // center of parent arrow
      if (lastFlags[lvl]) {
        // Ancestor was last child → no line, just empty spacer
        guide.style.cssText = `position:absolute;left:${left}px;top:0;width:0;height:100%;`;
      } else {
        // Vertical continuation line │
        guide.style.cssText = `position:absolute;left:${left}px;top:0;bottom:0;width:1px;background:rgba(48,60,80,0.35);`;
      }
      row.appendChild(guide);
    }

    // Branch connector at current depth (├ or └)
    if (depth > 0) {
      const conn = document.createElement('span');
      conn.className = 'ft-connector';
      const left = 12 + depth * 16 + 7;
      if (isLast) {
        // └─ last child
        conn.innerHTML = `<svg width="12" height="20" style="position:absolute;left:${left-6}px;top:-4px;pointer-events:none;"><line x1="6" y1="10" x2="6" y2="14" stroke="rgba(48,60,80,0.4)" stroke-width="1"/><line x1="6" y1="14" x2="11" y2="14" stroke="rgba(48,60,80,0.4)" stroke-width="1"/></svg>`;
      } else {
        // ├─ non-last child
        conn.innerHTML = `<svg width="12" height="20" style="position:absolute;left:${left-6}px;top:-4px;pointer-events:none;"><line x1="6" y1="0" x2="6" y2="14" stroke="rgba(48,60,80,0.4)" stroke-width="1"/><line x1="6" y1="14" x2="11" y2="14" stroke="rgba(48,60,80,0.4)" stroke-width="1"/></svg>`;
      }
      row.appendChild(conn);
    }

    // ── Row content ──

    // Arrow / spacer
    const arrow = document.createElement('span');
    arrow.className = 'ft-arrow';
    arrow.textContent = entry.is_dir ? '▸' : '';
    row.appendChild(arrow);

    // Icon
    const icon = document.createElement('span');
    icon.className = 'ft-icon';
    icon.innerHTML = entry.is_dir ? iconSvg('folder-closed', 12) : fileIcon(entry.name);
    row.appendChild(icon);

    // Name
    const name = document.createElement('span');
    name.className = entry.is_dir ? 'ft-name ft-name-dir' : 'ft-name ft-name-file';
    name.textContent = entry.name;
    row.appendChild(name);

    // "Ask Agent" icon — appears on hover for files
    if (!entry.is_dir) {
      const askIcon = document.createElement('span');
      askIcon.innerHTML = iconSvg('agent', 11);
      askIcon.title = '问 Agent 分析这个文件';
      askIcon.className = 'ft-ask-btn';
      askIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        askAgent(`分析文件 "${entry.path}"。它在依赖图中的位置是什么？和其他模块的耦合关系如何？修改它会影响什么？`);
      });
      row.appendChild(askIcon);
    }

    // Drag-and-drop: files/folders are draggable; folders are drop targets
    if (!entry.is_dir) {
      row.draggable = true;
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer!.setData('text/plain', entry.path);
        ev.dataTransfer!.effectAllowed = 'move';
        row.style.opacity = '0.5';
      });
      row.addEventListener('dragend', () => { row.style.opacity = ''; });
    } else {
      row.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer!.dropEffect = 'move';
        row.style.background = 'rgba(60,100,170,0.25)';
      });
      row.addEventListener('dragleave', () => { row.style.background = ''; });
      row.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        row.style.background = '';
        const srcPath = ev.dataTransfer!.getData('text/plain');
        if (srcPath && srcPath !== entry.path) {
          await invoke('move_file', { source: srcPath, destDir: entry.path });
          this.refresh();
        }
      });
    }

    // Right-click context menu
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const items = entry.is_dir
        ? [
            { label: '新建文件…', action: () => this.promptNewFile(entry.path) },
            { label: '新建文件夹…', action: () => this.promptNewFolder(entry.path) },
            { label: '重命名…', action: () => this.promptRename(entry.path, entry.name) },
            { label: '删除', action: () => this.confirmDelete(entry.path, entry.is_dir) },
          ]
        : [
            { label: '打开', action: () => FileViewer.get().open(entry.path) },
            { label: '重命名…', action: () => this.promptRename(entry.path, entry.name) },
            { label: '删除', action: () => this.confirmDelete(entry.path, false) },
            { label: '复制路径', action: () => navigator.clipboard.writeText(entry.path) },
          ];
      showContextMenu(e, items);
    });

    return row;
  }
}

// ── File icon by extension ──

function fileIcon(fileName: string): string {
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
  return iconSvg(map[ext] || 'file', 12);
}
