// Git Panel — 轻量源代码管理
// 深空 HUD 风格，和文件树/时间轴统一的左边缘面板
// 直接调 Tauri git_* 命令

import { invoke } from '../bridge';
import { iconSvg } from './icons';
import { bus } from './events';
import { FileViewer } from './file-viewer';
import { showContextMenu, type ContextMenuItem } from './context-menu';

// ── Types ──

interface GitFile {
  path: string;
  status: string;   // "modified" | "added" | "deleted" | "untracked" | "renamed"
  staged: boolean;
  old_path?: string;
}

interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}

interface GitCommit {
  hash: string;
  short: string;
  message: string;
  author: string;
  date: string;
}

// ── Panel ──

export class GitPanel {
  private el!: HTMLElement;
  private content!: HTMLElement;
  private openState = false;
  private projectPath = '';
  private status: GitStatus | null = null;
  private commits: GitCommit[] = [];
  private loading = false;
  private expandedCommits = new Set<string>();
  private commitFiles = new Map<string, string[]>();

  private static instance: GitPanel | null = null;

  static get(): GitPanel {
    if (!GitPanel.instance) GitPanel.instance = new GitPanel();
    return GitPanel.instance;
  }

  constructor() {
    this.buildDOM();
    bus.on('workspace:files-changed', () => {
      if (this.openState && this.projectPath) this.refresh();
    });
  }

  // ── DOM ────────────────────────────────────────────────

  private buildDOM(): void {
    this.el = document.createElement('div');
    this.el.id = 'git-panel';
    this.el.innerHTML = `
      <div class="corner-brackets">
        <span class="cb-bottom left"></span><span class="cb-bottom right"></span>
      </div>
    `;

    // Header
    const header = document.createElement('div');
    header.className = 'git-header';
    const title = document.createElement('span');
    title.className = 'git-title';
    title.innerHTML = `${iconSvg('git-branch', 14)} 源代码管理`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'git-close-btn';
    closeBtn.innerHTML = iconSvg('close', 14);
    closeBtn.addEventListener('click', () => this.close());
    header.append(title, closeBtn);
    this.el.appendChild(header);

    // Content
    this.content = document.createElement('div');
    this.content.className = 'git-content';
    this.el.appendChild(this.content);

    document.body.appendChild(this.el);
  }

  // ── Render ─────────────────────────────────────────────

  private render(): void {
    if (!this.status) {
      this.content.innerHTML = '<div class="git-empty">未加载项目或不是 git 仓库</div>';
      return;
    }

    const { branch, ahead, behind, files } = this.status;

    let html = '';

    // ── Branch bar ──
    html += '<div class="git-branch-bar">';
    html += `<button class="git-branch-btn" ${this.loading ? 'disabled' : ''}>${iconSvg('git-branch', 12)} ${escHtml(branch)} ▾</button>`;
    if (ahead > 0 || behind > 0) {
      html += '<span class="git-sync">';
      if (ahead > 0) html += `<span class="git-ahead">↑${ahead}</span>`;
      if (behind > 0) html += `<span class="git-behind">↓${behind}</span>`;
      html += '</span>';
    }
    html += '<span class="git-spacer"></span>';
    html += `<button class="git-btn git-stash-btn" ${this.loading ? 'disabled' : ''} title="暂存工作区">${iconSvg('save', 10)}</button>`;
    html += `<button class="git-btn git-unstash-btn" ${this.loading ? 'disabled' : ''} title="恢复暂存">${iconSvg('download', 10)}</button>`;
    html += `<button class="git-btn git-pull-btn" ${this.loading ? 'disabled' : ''}>${iconSvg('download', 10)} 拉取</button>`;
    html += `<button class="git-btn git-push-btn" ${this.loading ? 'disabled' : ''}>${iconSvg('upload', 10)} 推送</button>`;
    html += '</div>';

    // ── Changes ──
    const stagedFiles = files.filter(f => f.staged);
    const unstagedFiles = files.filter(f => !f.staged);

    html += '<div class="git-section">';
    html += '<div class="git-section-head">';
    html += `<span>变更 (${files.length})</span>`;
    if (files.length > 0) {
      html += `<button class="git-link-btn stage-all-btn">全部暂存</button>`;
    }
    html += '</div>';

    if (stagedFiles.length > 0) {
      html += '<div class="git-group-label">已暂存</div>';
      html += '<div class="git-file-list">';
      for (const f of stagedFiles) {
        html += this.renderFileRow(f, true);
      }
      html += '</div>';
    }

    if (unstagedFiles.length > 0) {
      if (stagedFiles.length > 0) {
        html += '<div class="git-group-label">未暂存</div>';
      }
      html += '<div class="git-file-list">';
      for (const f of unstagedFiles) {
        html += this.renderFileRow(f, false);
      }
      html += '</div>';
    }

    html += '</div>';

    // ── Commit area ──
    if (stagedFiles.length > 0) {
      html += '<div class="git-commit-area">';
      html += `<textarea class="git-commit-msg" placeholder="提交信息… (Ctrl+Enter 提交)" rows="2"></textarea>`;
      html += `<button class="git-btn git-commit-btn">${iconSvg('check-circle', 10)} 提交</button>`;
      html += '</div>';
    }

    // ── Recent commits ──
    if (this.commits.length > 0) {
      html += '<div class="git-section">';
      html += '<div class="git-section-head">最近提交</div>';
      html += '<div class="git-commit-list">';
      for (const c of this.commits.slice(0, 10)) {
        const isExpanded = this.expandedCommits.has(c.hash);
        const cachedFiles = this.commitFiles.get(c.hash);
        html += `<div class="git-commit-item${isExpanded ? ' expanded' : ''}" data-commit="${escAttr(c.hash)}" title="${escHtml(c.hash)}">
          <span class="git-commit-chevron">▸</span>
          <span class="git-commit-short">${escHtml(c.short)}</span>
          <span class="git-commit-msg-text">${escHtml(c.message)}</span>
          <span class="git-commit-meta">${escHtml(c.author)} · ${escHtml(relativeTime(c.date))}</span>
          <div class="git-commit-files">${cachedFiles ? cachedFiles.map(f => `<div class="git-commit-file">${escHtml(f)}</div>`).join('') : ''}</div>
        </div>`;
      }
      html += '</div></div>';
    }

    this.content.innerHTML = html;

    // ── Wire events ──

    // Branch dropdown
    const branchBtn = this.content.querySelector('.git-branch-btn');
    if (branchBtn) {
      branchBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.showBranchMenu(branchBtn as HTMLElement);
      });
    }

    // Stash buttons
    const stashBtn = this.content.querySelector('.git-stash-btn');
    const unstashBtn = this.content.querySelector('.git-unstash-btn');
    if (stashBtn) stashBtn.addEventListener('click', async () => { await invoke('git_stash_push', { path: this.projectPath }); this.refresh(); });
    if (unstashBtn) unstashBtn.addEventListener('click', async () => { await invoke('git_stash_pop', { path: this.projectPath }); this.refresh(); });

    // File rows — click to view diff, stage/unstage buttons, context menu
    this.content.querySelectorAll('.git-file-row').forEach((row) => {
      const el = row as HTMLElement;
      const path = el.dataset['filepath'] || '';
      const staged = el.dataset['staged'] === 'true';
      const diffBtn = el.querySelector('.git-file-diff');
      const stageBtn = el.querySelector('.git-file-stage');

      if (diffBtn) {
        diffBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.viewDiff(path, staged);
        });
      }
      if (stageBtn) {
        stageBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.toggleStage(path, staged);
        });
      }
      // Right-click context menu
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        showContextMenu(e, [
          { label: '打开文件', action: () => FileViewer.get().open(path) },
          { label: '放弃更改', action: async () => { await invoke('git_discard', { path: this.projectPath, file: path }); this.refresh(); } },
          { label: 'Git Blame', action: async () => {
            const blame = await invoke<string>('git_blame', { path: this.projectPath, file: path });
            FileViewer.get().openDiff(path, blame);
          }},
        ]);
      });
    });

    // Stage all
    const stageAllBtn = this.content.querySelector('.stage-all-btn');
    if (stageAllBtn) {
      stageAllBtn.addEventListener('click', () => this.stageAll());
    }

    // Commit
    const commitBtn = this.content.querySelector('.git-commit-btn');
    const commitMsg = this.content.querySelector('.git-commit-msg') as HTMLTextAreaElement;
    if (commitBtn && commitMsg) {
      commitBtn.addEventListener('click', () => this.doCommit(commitMsg.value));
      commitMsg.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.doCommit(commitMsg.value);
        }
      });
    }

    // Push / Pull
    const pullBtn = this.content.querySelector('.git-pull-btn');
    const pushBtn = this.content.querySelector('.git-push-btn');
    if (pullBtn) pullBtn.addEventListener('click', () => this.doPull());
    if (pushBtn) pushBtn.addEventListener('click', () => this.doPush());

    // Commit items — expand/collapse to show changed files
    this.content.querySelectorAll('.git-commit-item').forEach((item) => {
      const el = item as HTMLElement;
      const hash = el.dataset['commit'] || '';
      if (!hash) return;
      el.addEventListener('click', () => this.toggleCommit(hash));
    });
  }

  private renderFileRow(f: GitFile, isStaged: boolean): string {
    const statusIcon = f.status === 'added' ? 'A'
      : f.status === 'deleted' ? 'D'
      : f.status === 'untracked' ? '?'
      : f.status === 'renamed' ? 'R'
      : 'M';
    const statusClass = f.status === 'untracked' ? 'untracked'
      : f.status === 'added' ? 'added'
      : f.status === 'deleted' ? 'deleted'
      : 'modified';
    const oldPath = f.old_path ? `<span class="git-old-path">← ${escHtml(f.old_path)}</span>` : '';

    return `<div class="git-file-row" data-filepath="${escAttr(f.path)}" data-staged="${isStaged}">
      <span class="git-file-status git-status-${statusClass}">${statusIcon}</span>
      <button class="git-file-diff" title="查看差异">${escHtml(shortPath(f.path))}${oldPath}</button>
      <button class="git-file-stage" title="${isStaged ? '取消暂存' : '暂存'}">
        ${isStaged ? '─' : '+'}
      </button>
    </div>`;
  }

  // ── Public API ─────────────────────────────────────────

  async load(path: string): Promise<void> {
    this.projectPath = path;
    await this.refresh();
    this.open();
  }

  async refresh(): Promise<void> {
    if (!this.projectPath) return;
    this.loading = true;
    try {
      const [statusJson, logJson] = await Promise.all([
        invoke<string>('git_status', { path: this.projectPath }).catch(() => '{"branch":"","files":[]}'),
        invoke<string>('git_log', { path: this.projectPath, limit: 10 }).catch(() => '[]'),
      ]);
      this.status = JSON.parse(statusJson);
      this.commits = JSON.parse(logJson);
    } catch {
      this.status = null;
      this.commits = [];
    } finally {
      this.loading = false;
      this.render();
    }
  }

  open(): void {
    this.openState = true;
    this.el.classList.add('git-open');
    if (this.projectPath) this.refresh();
    else this.render(); // show empty state
    bus.emit('panel:toggle');
  }

  close(): void {
    this.openState = false;
    this.el.classList.remove('git-open');
    bus.emit('panel:toggle');
  }

  toggle(): void {
    this.openState ? this.close() : this.open();
  }

  isOpen(): boolean { return this.openState; }

  // ── Actions ────────────────────────────────────────────

  private async viewDiff(filePath: string, staged: boolean): Promise<void> {
    try {
      // Use side-by-side diff: HEAD content vs current/staged content
      const headContent = await invoke<string>('git_file_at_head', { path: this.projectPath, file: filePath }).catch(() => '');
      if (staged) {
        // Staged diff: HEAD vs staged (git show :file)
        const stagedContent = await invoke<string>('exec_command', {
          command: `git show :${filePath}`,
          cwd: this.projectPath,
        }).catch(() => '');
        FileViewer.get().openInlineDiff(filePath, headContent, stagedContent);
      } else {
        // Unstaged diff: HEAD vs working tree
        const currentContent = await invoke<string>('read_file_content', { filePath: `${this.projectPath}/${filePath}` }).catch(() => '');
        FileViewer.get().openInlineDiff(filePath, headContent, currentContent);
      }
    } catch (err: any) {
      this.showError(`获取差异失败: ${err}`);
    }
  }

  private async showBranchMenu(anchor: HTMLElement): Promise<void> {
    try {
      const data = await invoke<string>('git_list_branches', { path: this.projectPath });
      const { branches, current } = JSON.parse(data) as { branches: string[]; current: string };
      const items: ContextMenuItem[] = branches.map(b => ({
        label: b === current ? `● ${b}` : `  ${b}`,
        action: b === current ? () => {} : async () => {
          await invoke('git_checkout', { path: this.projectPath, branch: b });
          this.refresh();
        },
      }));
      // Add "New Branch" at the bottom
      items.push(
        { label: '──────────────', action: () => {}, disabled: true },
        { label: '+ 新建分支…', action: async () => {
          const name = prompt('新分支名:');
          if (name) {
            await invoke('git_create_branch', { path: this.projectPath, name });
            this.refresh();
          }
        }},
      );
      const rect = anchor.getBoundingClientRect();
      showContextMenu(new MouseEvent('contextmenu', { clientX: rect.left, clientY: rect.bottom + 4 }), items);
    } catch (err: any) {
      this.showError(`获取分支列表失败: ${err}`);
    }
  }

  private async toggleStage(filePath: string, currentlyStaged: boolean): Promise<void> {
    const cmd = currentlyStaged ? 'git_unstage' : 'git_stage';
    try {
      await invoke(cmd, { path: this.projectPath, files: [filePath] });
      await this.refresh();
    } catch (err: any) {
      this.showError(`暂存操作失败: ${err}`);
    }
  }

  private async stageAll(): Promise<void> {
    try {
      await invoke('git_stage_all', { path: this.projectPath });
      await this.refresh();
    } catch (err: any) {
      this.showError(`暂存全部失败: ${err}`);
    }
  }

  private async doCommit(message: string): Promise<void> {
    if (!message.trim()) return;
    this.loading = true;
    this.render();
    try {
      const output = await invoke<string>('git_commit', { path: this.projectPath, message: message.trim() });
      // Clear commit message
      const ta = this.content.querySelector('.git-commit-msg') as HTMLTextAreaElement;
      if (ta) ta.value = '';
      await this.refresh();
      // Also refresh timeline
      bus.emit('git:committed', { message: message.trim(), output });
    } catch (err: any) {
      this.showError(`提交失败: ${err}`);
      this.loading = false;
      this.render();
    }
  }

  private async doPush(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const output = await invoke<string>('git_push', { path: this.projectPath });
      await this.refresh();
      bus.emit('git:pushed', { output });
    } catch (err: any) {
      this.showError(`推送失败: ${err}`);
      this.loading = false;
      this.render();
    }
  }

  private async doPull(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const output = await invoke<string>('git_pull', { path: this.projectPath });
      await this.refresh();
      bus.emit('git:pulled', { output });
    } catch (err: any) {
      this.showError(`拉取失败: ${err}`);
      this.loading = false;
      this.render();
    }
  }

  private async toggleCommit(hash: string): Promise<void> {
    if (this.expandedCommits.has(hash)) {
      // Collapse
      this.expandedCommits.delete(hash);
      this.render();
      return;
    }
    // Expand — fetch files if not cached
    if (!this.commitFiles.has(hash)) {
      try {
        const json = await invoke<string>('git_show', { path: this.projectPath, commit: hash });
        this.commitFiles.set(hash, JSON.parse(json));
      } catch {
        this.commitFiles.set(hash, ['(获取失败)']);
      }
    }
    this.expandedCommits.add(hash);
    this.render();
  }

  private showError(message: string): void {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute', bottom: '8px', left: '12px', right: '12px', zIndex: '5',
      padding: '8px 12px', borderRadius: '4px',
      background: 'rgba(200, 40, 40, 0.15)',
      border: '1px solid rgba(200, 40, 40, 0.3)',
      color: 'var(--fail)', fontSize: '10px', fontFamily: 'var(--font-mono)',
    });
    el.textContent = message;
    this.el.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}

// ── Helpers ──────────────────────────────────────────────

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return p;
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  return `.../${parent}/${last}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function relativeTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return dateStr.slice(0, 10);
  } catch {
    return dateStr;
  }
}
