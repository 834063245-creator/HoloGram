// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// 文件树面板 — VS Code 级文件浏览器
// 特性: 键盘导航 · 多选 (Ctrl/Shift) · 剪贴板 · 拖拽 · 筛选 · 排序
// ═══════════════════════════════════════════════════════════════

import gsap from 'gsap';
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

interface Clipboard {
  paths: string[];
  cut: boolean;
}

export class FileTreePanel {
  el: HTMLElement;
  private treeEl: HTMLElement;
  private headerEl: HTMLElement;
  private open = false;
  private rootPath = '';
  private workspaceRoot = ''; // for relative path computation
  private _transitioning = false;
  private _closeTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Selection & focus ──
  private selectedPaths = new Set<string>();
  private focusedPath = '';
  private clipboard: Clipboard | null = null;
  private sortByName = false;
  private loading = false;

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
    });

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.el.appendChild(brackets);

    // ── Inline stylesheet ──
    const treeCSS = document.createElement('style');
    treeCSS.textContent = `
      .ft-row { position: relative; border-left: 2px solid transparent; cursor: pointer;
        transition: background 0.15s ease, border-left-color 0.15s ease, opacity 0.2s ease; }
      .ft-row.ft-open {
        background: rgba(50, 90, 150, 0.25) !important;
        border-left-color: rgba(80, 140, 220, 0.55);
      }
      .ft-row.ft-open .ft-name-file { color: var(--starlight, #e6edf3); }
      .ft-row.ft-selected {
        background: rgba(60, 100, 170, 0.3) !important;
        border-left-color: rgba(90, 150, 230, 0.6);
      }
      .ft-row.ft-selected.ft-open {
        background: rgba(50, 100, 180, 0.4) !important;
      }
      .ft-row.ft-focused {
        outline: 1px solid rgba(80, 140, 220, 0.3);
        outline-offset: -1px;
      }
      .ft-row.ft-cut { opacity: 0.45; }
      .ft-row.ft-drop-target { background: rgba(60, 100, 170, 0.35) !important; }
      .ft-guide { pointer-events: none; z-index: 0; }
      .ft-connector { pointer-events: none; z-index: 1; }
      .ft-arrow, .ft-icon, .ft-name, .ft-ask-btn { position: relative; z-index: 2; }
      .ft-empty { padding: 24px 12px; color: var(--text-muted); font-size: calc(11px * var(--font-scale)); text-align: center; user-select: none; }
      .ft-loading { padding: 24px 12px; color: var(--text-muted); font-size: calc(11px * var(--font-scale)); text-align: center; }
      .ft-header-btn { color: var(--text-muted); }
      .ft-header-btn:hover { color: var(--starlight-dim); background: rgba(255,255,255,0.04); }
      .ft-header-btn.ft-active { color: var(--signal, #7eb8ff) !important; }
      .ft-header-btn.ft-active:hover { color: var(--starlight, #c3daf8) !important; }
    `;
    this.el.appendChild(treeCSS);

    // ── Header ──
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'ft-header';
    Object.assign(this.headerEl.style, {
      display: 'flex', alignItems: 'center', gap: '2px',
      padding: '3px 6px', flexShrink: '0',
      borderBottom: '1px solid rgba(48, 60, 80, 0.25)',
    });

    const pathLabel = document.createElement('span');
    pathLabel.className = 'ft-path-label';
    Object.assign(pathLabel.style, {
      flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      fontSize: 'calc(10px * var(--font-scale))', color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)',
    });
    this.headerEl.appendChild(pathLabel);

    // Sort button
    const sortBtn = this.makeHeaderBtn('sort-toggle', '切换排序 (名称 ↔ 原始)');
    sortBtn.addEventListener('click', () => {
      this.sortByName = !this.sortByName;
      sortBtn.classList.toggle('ft-active', this.sortByName);
      this.refresh();
    });
    this.headerEl.appendChild(sortBtn);

    // Expand-all button
    const expandBtn = this.makeHeaderBtn('expand-all', '展开全部');
    expandBtn.addEventListener('click', () => this.expandAll());
    this.headerEl.appendChild(expandBtn);

    // Collapse-all button
    const collapseBtn = this.makeHeaderBtn('collapse-all', '折叠全部');
    collapseBtn.addEventListener('click', () => this.collapseAll());
    this.headerEl.appendChild(collapseBtn);

    // Refresh button
    const refreshBtn = this.makeHeaderBtn('refresh', '刷新');
    refreshBtn.addEventListener('click', () => {
      refreshBtn.style.transform = 'rotate(180deg)';
      setTimeout(() => { refreshBtn.style.transform = ''; }, 300);
      this.refresh();
    });

    // Close button
    const closeBtn = this.makeHeaderBtn('close', '关闭');
    closeBtn.addEventListener('click', () => this.close());

    this.el.appendChild(this.headerEl);

    // ── Tree container (receives keyboard events) ──
    this.treeEl = document.createElement('div');
    this.treeEl.className = 'ft-tree';
    this.treeEl.tabIndex = 0;
    Object.assign(this.treeEl.style, {
      flex: '1', overflowY: 'auto', overflowX: 'hidden', outline: 'none',
      padding: '2px 0',
    });
    this.treeEl.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.treeEl.addEventListener('focus', () => {
      // When tree gets focus, ensure a row is focused
      if (!this.focusedPath && this.treeEl.children.length > 0) {
        const firstRow = this.treeEl.querySelector('.ft-row') as HTMLElement;
        if (firstRow) this.focusRow(firstRow.dataset['filePath'] || '');
      }
    });

    // Empty-area context menu
    this.treeEl.addEventListener('contextmenu', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.ft-row')) return;
      e.preventDefault();
      showContextMenu(e, [
        { label: '新建文件…', action: () => this.promptNewFile(this.rootPath) },
        { label: '新建文件夹…', action: () => this.promptNewFolder(this.rootPath) },
        { label: '粘贴', action: () => this.pasteTo(this.rootPath), disabled: !this.clipboard },
        { label: '展开全部', action: () => this.expandAll() },
        { label: '在资源管理器中显示', action: () => invoke('open_in_explorer', { path: this.rootPath }) },
        { label: '刷新', action: () => this.refresh() },
      ]);
    });

    this.el.appendChild(this.treeEl);
    this.setupFilter();

    document.body.appendChild(this.el);
  }

  private makeHeaderBtn(icon: string, tip: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'ft-header-btn';
    btn.innerHTML = iconSvg(icon, 12);
    btn.title = tip;
    Object.assign(btn.style, {
      width: '20px', height: '20px', padding: '0', border: 'none', cursor: 'pointer',
      background: 'none', borderRadius: '3px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: '0',
    });
    return btn;
  }

  // ═══════════════════════════════════════════════════════════════
  // Load / Refresh
  // ═══════════════════════════════════════════════════════════════

  async load(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    if (!this.workspaceRoot) this.workspaceRoot = rootPath;
    this.selectedPaths.clear();
    this.focusedPath = '';
    const pathLabel = this.headerEl.querySelector('.ft-path-label');
    if (pathLabel) pathLabel.textContent = rootPath;
    this.loading = true;
    this.showLoading();
    try {
      const entries: DirEntry[] = await invoke('list_directory', { path: rootPath });
      if (this.sortByName) this.sortEntries(entries);
      this.renderTree(entries, this.treeEl, rootPath);
      this.maybeShowEmpty(entries);
    } catch (e) {
      this.treeEl.innerHTML = `<div class="ft-empty" style="color:var(--danger)">读取目录失败</div>`;
    } finally {
      this.loading = false;
    }
  }

  refresh(): void {
    if (this.rootPath) this.load(this.rootPath);
  }

  // ═══════════════════════════════════════════════════════════════
  // Show / Close
  // ═══════════════════════════════════════════════════════════════

  toggle(): void {
    if (this._transitioning) return;
    this.open ? this.close() : this.show();
  }

  show(): void {
    if (this._transitioning) return;
    this._transitioning = true;
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
    this.open = true;
    this.el.style.display = 'flex';
    gsap.killTweensOf(this.el);
    gsap.fromTo(this.el, { x: -280 }, { x: 0, duration: 0.18, ease: 'power2.out',
      onComplete: () => { this._transitioning = false; },
    });
    shell.notifyPanelChanged();
  }

  close(): void {
    if (this._transitioning) return;
    this._transitioning = true;
    this.open = false;
    gsap.killTweensOf(this.el);
    gsap.to(this.el, { x: -280, duration: 0.14, ease: 'power2.in',
      onComplete: () => {
        if (!this.open) this.el.style.display = 'none';
        this._transitioning = false;
        this._closeTimer = null;
      },
    });
    shell.notifyPanelChanged();
  }

  isOpen(): boolean { return this.open; }

  // ═══════════════════════════════════════════════════════════════
  // File operations
  // ═══════════════════════════════════════════════════════════════

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

  private async confirmDelete(paths: string[]): Promise<void> {
    const label = paths.length === 1 ? `"${paths[0]}"` : `${paths.length} 个项目`;
    if (!confirm(`确认删除 ${label}？\n此操作不可撤销。`)) return;
    for (const p of paths) {
      await invoke('delete_file_or_dir', { path: p });
    }
    this.refresh();
  }

  // ═══════════════════════════════════════════════════════════════
  // Clipboard (copy / cut / paste)
  // ═══════════════════════════════════════════════════════════════

  private cutSelection(): void {
    if (this.selectedPaths.size === 0) return;
    this.clipboard = { paths: [...this.selectedPaths], cut: true };
    this.reapplyRowStates();
  }

  private copySelection(): void {
    if (this.selectedPaths.size === 0) return;
    this.clipboard = { paths: [...this.selectedPaths], cut: false };
    this.reapplyRowStates();
  }

  private async pasteTo(destDir: string): Promise<void> {
    if (!this.clipboard || this.clipboard.paths.length === 0) return;
    const { paths, cut } = this.clipboard;
    for (const src of paths) {
      const name = src.replace(/\\/g, '/').split('/').pop() || src;
      const dest = `${destDir.replace(/\\/g, '/')}/${name}`;
      if (cut) {
        await invoke('rename_file_or_dir', { from: src, to: dest }).catch(() => {});
      } else {
        await this.copyRecursive(src, dest);
      }
    }
    if (cut) this.clipboard = null;
    this.refresh();
  }

  /** Recursively copy a file or directory. ponytail: no progress, no overwrite prompt. */
  private async copyRecursive(src: string, dest: string): Promise<void> {
    try {
      const entries: DirEntry[] = await invoke('list_directory', { path: src });
      // src is a directory
      await invoke('create_directory', { path: dest }).catch(() => {});
      for (const entry of entries) {
        const childSrc = `${src.replace(/\\/g, '/')}/${entry.name}`;
        const childDest = `${dest.replace(/\\/g, '/')}/${entry.name}`;
        if (entry.is_dir) {
          await this.copyRecursive(childSrc, childDest);
        } else {
          const content = await invoke<string>('read_file_content', { filePath: childSrc }).catch(() => null);
          if (content !== null) {
            await invoke('write_file_content', { filePath: childDest, content }).catch(() => {});
          }
        }
      }
    } catch {
      // Not a directory — treat as file
      const content = await invoke<string>('read_file_content', { filePath: src }).catch(() => null);
      if (content !== null) {
        await invoke('write_file_content', { filePath: dest, content }).catch(() => {});
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Selection & focus helpers
  // ═══════════════════════════════════════════════════════════════

  private focusRow(path: string): void {
    this.focusedPath = path;
    this.reapplyRowStates();
    // Scroll into view + subtle pulse
    const row = this.treeEl.querySelector(`[data-file-path="${this.cssEscape(path)}"]`) as HTMLElement;
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      gsap.killTweensOf(row);
      gsap.fromTo(row,
        { boxShadow: 'inset 0 0 0 0 rgba(80, 140, 220, 0)' },
        { boxShadow: 'inset 0 0 12px 2px rgba(80, 140, 220, 0.12)', duration: 0.1, ease: 'power2.out',
          onComplete: () => {
            gsap.to(row, { boxShadow: 'inset 0 0 0 0 rgba(80, 140, 220, 0)', duration: 0.2, ease: 'power2.out' });
          },
        },
      );
    }
  }

  private selectSingle(path: string): void {
    this.selectedPaths.clear();
    this.selectedPaths.add(path);
    this.focusedPath = path;
    this.reapplyRowStates();
  }

  private toggleSelect(path: string): void {
    if (this.selectedPaths.has(path)) {
      this.selectedPaths.delete(path);
    } else {
      this.selectedPaths.add(path);
    }
    this.focusedPath = path;
    this.reapplyRowStates();
  }

  private rangeSelect(to: string): void {
    const rows = this.getVisibleRows();
    const fromIdx = rows.findIndex(r => r.dataset['filePath'] === this.focusedPath);
    const toIdx = rows.findIndex(r => r.dataset['filePath'] === to);
    if (fromIdx < 0 || toIdx < 0) { this.selectSingle(to); return; }
    const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    // Don't clear existing selection — extend it (Shift behavior)
    for (let i = lo; i <= hi; i++) {
      this.selectedPaths.add(rows[i].dataset['filePath'] || '');
    }
    this.focusedPath = to;
    this.reapplyRowStates();
  }

  private selectAll(): void {
    const rows = this.getVisibleRows();
    for (const row of rows) this.selectedPaths.add(row.dataset['filePath'] || '');
    if (rows.length > 0) this.focusedPath = rows[rows.length - 1].dataset['filePath'] || '';
    this.reapplyRowStates();
  }

  /** Re-sync CSS classes on every visible row to match selection/focus/clipboard state. */
  private reapplyRowStates(): void {
    const rows = this.treeEl.querySelectorAll<HTMLElement>('.ft-row');
    for (const row of rows) {
      const fp = row.dataset['filePath'] || '';
      row.classList.toggle('ft-selected', this.selectedPaths.has(fp));
      row.classList.toggle('ft-focused', this.focusedPath === fp);
      const isCut = this.clipboard?.cut && this.clipboard.paths.includes(fp);
      row.classList.toggle('ft-cut', !!isCut);
    }
  }

  private getVisibleRows(): HTMLElement[] {
    return [...this.treeEl.querySelectorAll<HTMLElement>('.ft-row')]
      .filter(r => (r.style as any).display !== 'none');
  }

  private cssEscape(path: string): string {
    return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // ═══════════════════════════════════════════════════════════════
  // Keyboard navigation
  // ═══════════════════════════════════════════════════════════════

  private onKeyDown(e: KeyboardEvent): void {
    const rows = this.getVisibleRows();
    if (rows.length === 0) return;

    const currentIdx = rows.findIndex(r => r.dataset['filePath'] === this.focusedPath);

    // ── Navigation ──
    if (e.key === 'ArrowDown' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const next = currentIdx < rows.length - 1 ? currentIdx + 1 : 0;
      if (!e.shiftKey) { this.selectedPaths.clear(); }
      this.selectedPaths.add(rows[next].dataset['filePath'] || '');
      this.focusRow(rows[next].dataset['filePath'] || '');
      return;
    }
    if (e.key === 'ArrowUp' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const next = currentIdx > 0 ? currentIdx - 1 : rows.length - 1;
      if (!e.shiftKey) { this.selectedPaths.clear(); }
      this.selectedPaths.add(rows[next].dataset['filePath'] || '');
      this.focusRow(rows[next].dataset['filePath'] || '');
      return;
    }
    if (e.key === 'Home' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey && currentIdx >= 0) {
        for (let i = 0; i <= currentIdx; i++) this.selectedPaths.add(rows[i].dataset['filePath'] || '');
      } else { this.selectedPaths.clear(); this.selectedPaths.add(rows[0].dataset['filePath'] || ''); }
      this.focusRow(rows[0].dataset['filePath'] || '');
      return;
    }
    if (e.key === 'End' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey && currentIdx >= 0) {
        for (let i = currentIdx; i < rows.length; i++) this.selectedPaths.add(rows[i].dataset['filePath'] || '');
      } else { this.selectedPaths.clear(); this.selectedPaths.add(rows[rows.length - 1].dataset['filePath'] || ''); }
      this.focusRow(rows[rows.length - 1].dataset['filePath'] || '');
      return;
    }

    // ── Actions ──
    const focusedRow = currentIdx >= 0 ? rows[currentIdx] : null;
    const focusedPath = focusedRow?.dataset['filePath'] || '';
    const entry = focusedRow ? this.findEntry(focusedPath) : null;

    if (e.key === 'Enter') {
      e.preventDefault();
      if (entry?.is_dir) {
        this.toggleExpand(focusedPath, focusedRow!);
      } else if (entry) {
        FileViewer.get().open(focusedPath);
        this.setOpenFilePath(focusedPath);
        dbg('FileTree.clickFile', focusedPath);
        shell.highlightFile(focusedPath);
      }
      return;
    }
    if (e.key === 'ArrowLeft' && entry?.is_dir) {
      e.preventDefault();
      const container = (focusedRow?.nextElementSibling) as HTMLElement;
      if (container && container.style.display !== 'none' && container.tagName === 'DIV') {
        this.collapseRow(focusedRow!, container);
      }
      return;
    }
    if (e.key === 'ArrowRight' && entry?.is_dir) {
      e.preventDefault();
      const container = (focusedRow?.nextElementSibling) as HTMLElement;
      if (container && container.style.display === 'none' && container.tagName === 'DIV') {
        this.expandRow(focusedRow!, container);
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      if (entry?.is_dir) {
        this.toggleExpand(focusedPath, focusedRow!);
      } else {
        this.toggleSelect(focusedPath);
      }
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      if (entry) this.promptRename(focusedPath, entry.name);
      return;
    }
    if (e.key === 'Delete' && !e.shiftKey) {
      e.preventDefault();
      const targets = this.selectedPaths.size > 0 ? [...this.selectedPaths] : (focusedPath ? [focusedPath] : []);
      if (targets.length > 0) this.confirmDelete(targets);
      return;
    }

    // ── Modifier combos ──
    if (e.ctrlKey && e.key === 'a') {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      this.copySelection();
      return;
    }
    if (e.ctrlKey && e.key === 'x') {
      e.preventDefault();
      this.cutSelection();
      return;
    }
    if (e.ctrlKey && e.key === 'v') {
      e.preventDefault();
      const dest = entry?.is_dir ? focusedPath : this.rootPath;
      this.pasteTo(dest);
      return;
    }
    if (e.key === 'Escape') {
      if (this.selectedPaths.size > 0) {
        this.selectedPaths.clear();
        this.reapplyRowStates();
      }
      if (this.filterInput.value) {
        this.filterInput.value = '';
        this.applyFilter('');
        this.filterInput.focus();
      }
      return;
    }
  }

  private findEntry(path: string): DirEntry | null {
    // ponytail: brute-force scan of visible rows to find entry metadata
    // Upgrade to a Map<string, DirEntry> cache if directories exceed 5000 files
    const row = this.treeEl.querySelector(`[data-file-path="${this.cssEscape(path)}"]`) as HTMLElement;
    if (!row) return null;
    const name = row.querySelector('.ft-name')?.textContent || '';
    const isDir = !!row.querySelector('.ft-arrow')?.textContent || row.querySelector('.ft-name-dir') !== null;
    return { name, path, is_dir: isDir, children: null };
  }

  private toggleExpand(path: string, row: HTMLElement): void {
    const container = row.nextElementSibling as HTMLElement;
    if (!container || container.tagName !== 'DIV') return;
    if (container.style.display !== 'none') {
      this.collapseRow(row, container);
    } else {
      this.expandRow(row, container);
    }
  }

  private collapseRow(row: HTMLElement, container: HTMLElement): void {
    const arrow = row.querySelector('.ft-arrow') as HTMLElement;
    if (arrow) arrow.textContent = '▸';
    // ponytail: instant hide — avoids GSAP onComplete/expand race condition
    // The expand stagger animation provides sufficient visual feedback
    const childRows = container.querySelectorAll<HTMLElement>('.ft-row');
    gsap.killTweensOf(childRows);
    container.style.display = 'none';
    shell.clearHighlight();
  }

  private expandRow(row: HTMLElement, container: HTMLElement): void {
    // Set invisible BEFORE showing container to avoid flash
    const childRows = container.querySelectorAll<HTMLElement>('.ft-row');
    gsap.killTweensOf(childRows);
    gsap.set(childRows, { opacity: 0, x: -6 });

    container.style.display = 'block';
    const arrow = row.querySelector('.ft-arrow') as HTMLElement;
    if (arrow) arrow.textContent = '▾';

    gsap.to(childRows,
      { opacity: 1, x: 0, duration: 0.04, stagger: { each: 0.0015, from: 'start' }, ease: 'power2.out' },
    );
    const fp = row.dataset['filePath'] || '';
    shell.highlightFolder(fp);
  }

  private expandAll(): void {
    const topRows = this.treeEl.querySelectorAll<HTMLElement>(':scope > .ft-row');
    for (const row of topRows) {
      const fp = row.dataset['filePath'] || '';
      const arrow = row.querySelector('.ft-arrow') as HTMLElement;
      if (arrow?.textContent) this.expandAllChildren(fp);
    }
  }

  private collapseAll(): void {
    const containers = [...this.treeEl.querySelectorAll<HTMLElement>('.ft-row + div')];
    for (const c of containers) {
      const row = c.previousElementSibling as HTMLElement;
      const arrow = row?.querySelector('.ft-arrow') as HTMLElement;
      if (arrow) arrow.textContent = '▸';
      const childRows = c.querySelectorAll<HTMLElement>('.ft-row');
      gsap.killTweensOf(childRows);
      c.style.display = 'none';
    }
    shell.clearHighlight();
  }

  /** Expand all descendants of a given folder row with cascading animation. */
  private expandAllChildren(folderPath: string): void {
    const row = this.treeEl.querySelector(`[data-file-path="${this.cssEscape(folderPath)}"]`) as HTMLElement;
    if (!row) return;
    const container = row.nextElementSibling as HTMLElement;
    if (!container || container.tagName !== 'DIV') return;
    // Set all rows invisible BEFORE showing any containers
    const allRows = container.querySelectorAll<HTMLElement>('.ft-row');
    gsap.killTweensOf(allRows);
    gsap.set(allRows, { opacity: 0, x: -6 });

    // Unhide all nested child containers
    const allContainers = container.querySelectorAll<HTMLElement>('.ft-row + div');
    for (const c of allContainers) {
      c.style.display = 'block';
      const prev = c.previousElementSibling as HTMLElement;
      const arr = prev?.querySelector('.ft-arrow') as HTMLElement;
      if (arr) arr.textContent = '▾';
    }
    // Expand this level
    container.style.display = 'block';
    const arrow = row.querySelector('.ft-arrow') as HTMLElement;
    if (arrow) arrow.textContent = '▾';

    // Cascade in
    gsap.to(allRows,
      { opacity: 1, x: 0, duration: 0.04, stagger: { each: 0.001, from: 'start' }, ease: 'power2.out' },
    );
    shell.highlightFolder(folderPath);
  }

  /** Relative path from workspace root. */
  private relativePath(fullPath: string): string {
    const root = this.workspaceRoot.replace(/\\/g, '/');
    const fp = fullPath.replace(/\\/g, '/');
    if (fp.startsWith(root + '/')) return fp.slice(root.length + 1);
    if (fp.startsWith(root)) return fp.slice(root.length);
    return fp;
  }

  // ═══════════════════════════════════════════════════════════════
  // Filter
  // ═══════════════════════════════════════════════════════════════

  private filterInput!: HTMLInputElement;

  private setupFilter(): void {
    this.filterInput = document.createElement('input');
    this.filterInput.placeholder = '过滤文件…';
    Object.assign(this.filterInput.style, {
      width: '100%', padding: '3px 8px', margin: '0',
      background: 'rgba(8,16,28,0.6)', border: '1px solid var(--panel-edge, rgba(48,60,80,0.3))',
      borderRadius: '3px', fontFamily: 'var(--font-mono)', fontSize: 'calc(10px * var(--font-scale))',
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
    let visibleCount = 0;
    for (const row of rows) {
      const name = (row.querySelector('.ft-name')?.textContent || '').toLowerCase();
      const match = !q || name.includes(q);
      (row.style as any).display = match ? '' : 'none';
      if (match) {
        visibleCount++;
        if (q) {
          // Expand parent containers
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
    // Show/hide empty state
    const existing = this.treeEl.querySelector('.ft-empty');
    if (!q) {
      existing?.remove();
    } else if (visibleCount === 0) {
      if (!existing) {
        const empty = document.createElement('div');
        empty.className = 'ft-empty';
        empty.textContent = '没有匹配的文件';
        this.treeEl.appendChild(empty);
      }
    } else {
      existing?.remove();
    }
    this.reapplyRowStates();
  }

  private showLoading(): void {
    this.treeEl.innerHTML = '<div class="ft-loading">加载中…</div>';
  }

  private maybeShowEmpty(entries: DirEntry[]): void {
    if (entries.length === 0 && this.treeEl.querySelector('.ft-row') === null) {
      const existing = this.treeEl.querySelector('.ft-empty');
      if (!existing) {
        const empty = document.createElement('div');
        empty.className = 'ft-empty';
        empty.textContent = '目录为空';
        this.treeEl.appendChild(empty);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Highlight (graph → tree reverse link)
  // ═══════════════════════════════════════════════════════════════

  private _hlTimer: ReturnType<typeof setTimeout> | null = null;

  highlightPath(filePath: string): void {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const rows = this.treeEl.querySelectorAll<HTMLElement>('div[data-file-path]');
    for (const row of rows) {
      const rowPath = (row.dataset['filePath'] || '').replace(/\\/g, '/').toLowerCase();
      if (rowPath !== normalized) continue;
      // Expand parents
      let parent = row.parentElement;
      while (parent && parent !== this.treeEl) {
        if (parent.style.display === 'none') {
          parent.style.display = 'block';
          const parentRow = parent.previousElementSibling as HTMLElement;
          const arrow = parentRow?.querySelector('.ft-arrow') as HTMLElement;
          if (arrow) arrow.textContent = '▾';
        }
        parent = parent.parentElement;
      }
      const doScroll = () => {
        const rowTop = row.offsetTop;
        const view = this.treeEl;
        view.scrollTop = rowTop - view.clientHeight / 2 + row.clientHeight / 2;
        row.style.background = 'rgba(60, 100, 170, 0.45)';
        row.style.borderLeftColor = 'rgba(100, 160, 240, 0.8)';
        if (this._hlTimer) clearTimeout(this._hlTimer);
        this._hlTimer = setTimeout(() => {
          row.style.background = '';
          row.style.borderLeftColor = 'transparent';
        }, 2000);
      };
      if (!this.open) {
        this.show();
        requestAnimationFrame(doScroll);
      } else {
        doScroll();
      }
      break;
    }
  }

  private openFilePath = '';

  setOpenFilePath(path: string): void {
    if (this.openFilePath === path) return;
    const old = this.treeEl.querySelector('.ft-row.ft-open');
    if (old) old.classList.remove('ft-open');
    this.openFilePath = path;
    const rows = this.treeEl.querySelectorAll<HTMLElement>('.ft-row');
    for (const row of rows) {
      const fp = (row.dataset['filePath'] || '').replace(/\\/g, '/');
      if (fp === path.replace(/\\/g, '/')) {
        row.classList.add('ft-open');
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════

  private renderTree(entries: DirEntry[], parent: HTMLElement, basePath: string, depth = 0, lastFlags: boolean[] = []): void {
    parent.innerHTML = '';
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const row = this.buildRow(entry, basePath, depth, lastFlags, isLast);
      parent.appendChild(row);

      if (entry.children && entry.children.length > 0) {
        if (this.sortByName) this.sortEntries(entry.children);
        const childContainer = document.createElement('div');
        childContainer.style.display = 'none';
        const childFlags = [...lastFlags, isLast];
        this.renderTree(entry.children, childContainer, basePath, depth + 1, childFlags);
        parent.appendChild(childContainer);

        row.addEventListener('click', (e) => this.onRowClick(e, entry, row, childContainer));
      } else if (entry.is_dir) {
        row.addEventListener('click', (e) => this.onRowClick(e, entry, row, null));
      } else {
        row.addEventListener('click', (e) => this.onRowClick(e, entry, row, null));
      }
    }
  }

  private onRowClick(e: MouseEvent, entry: DirEntry, row: HTMLElement, childContainer: HTMLElement | null): void {
    e.stopPropagation();
    const path = row.dataset['filePath'] || '';

    if (e.ctrlKey) {
      this.toggleSelect(path);
      return;
    }
    if (e.shiftKey) {
      this.rangeSelect(path);
      return;
    }

    // Regular click
    if (childContainer) {
      // Folder with children — delegate to animated expand/collapse
      if (childContainer.style.display !== 'none') {
        this.collapseRow(row, childContainer);
      } else {
        this.expandRow(row, childContainer);
      }
    } else if (entry.is_dir) {
      // Empty folder
      row.style.background = 'rgba(48, 60, 80, 0.35)';
      setTimeout(() => { row.style.background = ''; }, 300);
    } else {
      FileViewer.get().open(entry.path);
      this.setOpenFilePath(entry.path);
      dbg('FileTree.clickFile', entry.path);
      shell.highlightFile(entry.path);
    }
    this.selectSingle(path);
  }

  private buildRow(entry: DirEntry, _basePath: string, depth: number, lastFlags: boolean[], isLast: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ft-row';
    row.style.setProperty('--indent', `${12 + depth * 16}px`);
    row.dataset['filePath'] = entry.path;
    row.title = entry.path;

    // Open-file highlight
    const normalizedEntryPath = entry.path.replace(/\\/g, '/');
    if (this.openFilePath.replace(/\\/g, '/') === normalizedEntryPath) {
      row.classList.add('ft-open');
    }
    // Selection & focus
    if (this.selectedPaths.has(entry.path)) row.classList.add('ft-selected');
    if (this.focusedPath === entry.path) row.classList.add('ft-focused');
    if (this.clipboard?.cut && this.clipboard.paths.includes(entry.path)) row.classList.add('ft-cut');

    // ── Indent guides ──
    for (let lvl = 0; lvl < depth; lvl++) {
      const guide = document.createElement('span');
      guide.className = 'ft-guide';
      const left = 12 + lvl * 16 + 7;
      if (lastFlags[lvl]) {
        guide.style.cssText = `position:absolute;left:${left}px;top:0;width:0;height:100%;`;
      } else {
        guide.style.cssText = `position:absolute;left:${left}px;top:0;bottom:0;width:1px;background:rgba(48,60,80,0.35);`;
      }
      row.appendChild(guide);
    }

    // ── Branch connector ──
    if (depth > 0) {
      const conn = document.createElement('span');
      conn.className = 'ft-connector';
      const left = 12 + depth * 16 + 7;
      const svg = isLast
        ? `<svg width="12" height="20" style="position:absolute;left:${left - 6}px;top:-4px;pointer-events:none;"><line x1="6" y1="10" x2="6" y2="14" stroke="rgba(48,60,80,0.4)" stroke-width="1"/><line x1="6" y1="14" x2="11" y2="14" stroke="rgba(48,60,80,0.4)" stroke-width="1"/></svg>`
        : `<svg width="12" height="20" style="position:absolute;left:${left - 6}px;top:-4px;pointer-events:none;"><line x1="6" y1="0" x2="6" y2="14" stroke="rgba(48,60,80,0.4)" stroke-width="1"/><line x1="6" y1="14" x2="11" y2="14" stroke="rgba(48,60,80,0.4)" stroke-width="1"/></svg>`;
      conn.innerHTML = svg;
      row.appendChild(conn);
    }

    // ── Arrow / spacer ──
    const arrow = document.createElement('span');
    arrow.className = 'ft-arrow';
    arrow.textContent = entry.is_dir ? '▸' : '';
    row.appendChild(arrow);

    // ── Icon ──
    const icon = document.createElement('span');
    icon.className = 'ft-icon';
    icon.innerHTML = entry.is_dir ? iconSvg('folder-closed', 12) : fileIcon(entry.name);
    row.appendChild(icon);

    // ── Name ──
    const name = document.createElement('span');
    name.className = entry.is_dir ? 'ft-name ft-name-dir' : 'ft-name ft-name-file';
    name.textContent = entry.name;
    row.appendChild(name);

    // ── "Ask Agent" button ──
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

    // ── Drag-and-drop ──
    if (!entry.is_dir) {
      row.draggable = true;
      row.addEventListener('dragstart', (ev) => {
        // If dragging a selected file, drag all selected files
        const files = this.selectedPaths.has(entry.path)
          ? [...this.selectedPaths].filter(p => p !== entry.path)
          : [];
        ev.dataTransfer!.setData('text/plain', entry.path);
        if (files.length > 0) {
          ev.dataTransfer!.setData('application/x-file-list', JSON.stringify(files));
        }
        ev.dataTransfer!.effectAllowed = 'move';
        row.style.opacity = '0.5';
      });
      row.addEventListener('dragend', () => { row.style.opacity = ''; });
    } else {
      row.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer!.dropEffect = 'move';
        row.classList.add('ft-drop-target');
      });
      row.addEventListener('dragleave', () => { row.classList.remove('ft-drop-target'); });
      row.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        row.classList.remove('ft-drop-target');
        const srcPath = ev.dataTransfer!.getData('text/plain');
        const extraJson = ev.dataTransfer!.getData('application/x-file-list');
        const extraFiles: string[] = extraJson ? JSON.parse(extraJson) : [];
        const allFiles = [srcPath, ...extraFiles].filter(Boolean);
        for (const f of allFiles) {
          if (f !== entry.path) {
            await invoke('move_file', { source: f, destDir: entry.path });
          }
        }
        this.refresh();
      });
    }

    // ── Context menu ──
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      // If right-clicking on a non-selected item, select only it
      if (!this.selectedPaths.has(entry.path)) {
        this.selectSingle(entry.path);
      }
      const count = this.selectedPaths.size;
      const title = count > 1 ? `${count} 个项目` : entry.name;

      if (entry.is_dir) {
        showContextMenu(e, [
          { label: `新建文件…`, action: () => this.promptNewFile(entry.path) },
          { label: `新建文件夹…`, action: () => this.promptNewFolder(entry.path) },
          { label: '粘贴', action: () => this.pasteTo(entry.path), disabled: !this.clipboard },
          { label: `展开全部子项`, action: () => this.expandAllChildren(entry.path) },
          { label: '复制路径', action: () => navigator.clipboard.writeText(entry.path) },
          { label: '复制相对路径', action: () => navigator.clipboard.writeText(this.relativePath(entry.path)) },
          { label: '在资源管理器中显示', action: () => invoke('open_in_explorer', { path: entry.path }) },
          { label: count > 1 ? `重命名…` : `重命名 "${entry.name}"…`, action: () => {
            if (count === 1) this.promptRename(entry.path, entry.name);
          }},
          { label: count > 1 ? `删除 ${title}` : '删除', action: () => this.confirmDelete([...this.selectedPaths]) },
        ]);
      } else {
        const singleActions = count === 1 ? [
          { label: '打开', action: () => { FileViewer.get().open(entry.path); this.setOpenFilePath(entry.path); } },
          { label: `重命名 "${entry.name}"…`, action: () => this.promptRename(entry.path, entry.name) },
        ] : [];
        showContextMenu(e, [
          ...singleActions,
          { label: '复制', action: () => this.copySelection() },
          { label: '剪切', action: () => this.cutSelection() },
          { label: count > 1 ? `删除 ${title}` : '删除', action: () => this.confirmDelete([...this.selectedPaths]) },
          { label: '复制路径', action: () => navigator.clipboard.writeText([...this.selectedPaths].join('\n')) },
          { label: '复制相对路径', action: () => navigator.clipboard.writeText([...this.selectedPaths].map(p => this.relativePath(p)).join('\n')) },
          { label: '复制文件名', action: () => navigator.clipboard.writeText([...this.selectedPaths].map(p => p.replace(/\\/g, '/').split('/').pop() || p).join('\n')) },
          { label: '在资源管理器中显示', action: () => invoke('open_in_explorer', { path: entry.path }) },
        ]);
      }
    });

    return row;
  }

  // ── Sort ──

  private sortEntries(entries: DirEntry[]): void {
    entries.sort((a, b) => {
      // Directories first, then alphabetical
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// File icon by extension
// ═══════════════════════════════════════════════════════════════

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
