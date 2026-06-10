// Git Panel — 轻量源代码管理
// 深空 HUD 风格，和文件树/时间轴统一的左边缘面板
// 直接调 Tauri git_* 命令

import { invoke } from '../bridge';
import { iconSvg } from './icons';
import { bus } from './events';
import { FileViewer } from './file-viewer';

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

  private static instance: GitPanel | null = null;

  static get(): GitPanel {
    if (!GitPanel.instance) GitPanel.instance = new GitPanel();
    return GitPanel.instance;
  }

  constructor() {
    this.buildDOM();
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
    html += `<span class="git-branch-name">${iconSvg('git-branch', 12)} ${escHtml(branch)}</span>`;
    if (ahead > 0 || behind > 0) {
      html += '<span class="git-sync">';
      if (ahead > 0) html += `<span class="git-ahead">↑${ahead}</span>`;
      if (behind > 0) html += `<span class="git-behind">↓${behind}</span>`;
      html += '</span>';
    }
    html += '<span class="git-spacer"></span>';
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
        html += `<div class="git-commit-item" title="${escHtml(c.hash)}">
          <span class="git-commit-short">${escHtml(c.short)}</span>
          <span class="git-commit-msg-text">${escHtml(c.message)}</span>
          <span class="git-commit-meta">${escHtml(c.author)} · ${escHtml(relativeTime(c.date))}</span>
        </div>`;
      }
      html += '</div></div>';
    }

    this.content.innerHTML = html;

    // ── Wire events ──
    // File rows — click to view diff, stage/unstage buttons
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
    const cmd = staged ? 'git_diff_staged' : 'git_diff_unstaged';
    try {
      const diff = await invoke<string>(cmd, { path: this.projectPath, file: filePath });
      FileViewer.get().openDiff(filePath, diff);
    } catch (err: any) {
      console.error('[git] 获取差异失败:', err);
    }
  }

  private async toggleStage(filePath: string, currentlyStaged: boolean): Promise<void> {
    const cmd = currentlyStaged ? 'git_unstage' : 'git_stage';
    try {
      await invoke(cmd, { path: this.projectPath, files: [filePath] });
      await this.refresh();
    } catch (err: any) {
      console.error('[git] 暂存操作失败:', err);
    }
  }

  private async stageAll(): Promise<void> {
    try {
      await invoke('git_stage_all', { path: this.projectPath });
      await this.refresh();
    } catch (err: any) {
      console.error('[git] 暂存全部失败:', err);
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
      console.error('[git] 提交失败:', err);
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
      console.error('[git] 推送失败:', err);
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
      console.error('[git] 拉取失败:', err);
      this.loading = false;
      this.render();
    }
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
