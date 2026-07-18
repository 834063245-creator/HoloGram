// State Injection — project state hooks for the agent loop.
//
// Pattern: async refresh, sync read. Data is gathered asynchronously
// (fire-and-forget from workspace lifecycle callbacks) and cached in memory.
// Hooks read the cache synchronously — no async in the hot path.
//
// Injection points:
//   TurnStart  — onSessionPersisted → refresh caches → next turn sees fresh data
//   PreRead    — read_file_content hook → sync read from diag + blame caches
//   PostEdit   — write-tool hook → sync read from check cache
//
// All calls degrade gracefully — if data is unavailable, nothing is injected.

import { rpc } from '../bridge';
import {
  cacheStore,
  getBlameCache,
  getBuildResultCache,
  getCheckCache,
  getGitCache,
  getGitCacheTs,
  getTimelineCache,
  getTimelineCacheTs,
  hasBlameEntry,
  setBlameEntry,
  setBuildResultCache,
  setCheckCache,
  setGitCache,
  setTimelineCache,
} from './cache-store';

export type { BuildResult, CheckStatusSummary, GitStatusSummary, TimelineEvent } from './cache-store';

/** LSP 诊断的结构类型 — 与 ui/lsp-client 的 LspDiagnostic 结构一致，
 *  在 agent 层本地定义以保持单向边界（诊断数据由调用方注入）。 */
export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  source?: string;
  code?: string | number;
}

/** Diagnostics source — injected by the workspace (UI owns the LSP client). */
export type DiagnosticsSource = (filePath: string) => LspDiagnostic[];

// ── Git status cache ──

const GIT_CACHE_MS = 5000;

/** Fire-and-forget refresh. Call from onSessionPersisted or turn-start. */
export async function refreshGitStatus(projectPath: string): Promise<void> {
  const now = Date.now();
  const cached = getGitCache();
  if (cached && now - getGitCacheTs() < GIT_CACHE_MS) return;
  try {
    const json = await rpc<string>('git_status', { path: projectPath });
    const raw = JSON.parse(json);
    setGitCache(
      {
        branch: raw.branch || '',
        ahead: raw.ahead || 0,
        behind: raw.behind || 0,
        dirtyCount: (raw.files || []).length,
        dirtyFiles: (raw.files || []).slice(0, 15),
      },
      now,
    );
  } catch {
    /* silent */
  }
}

/** Sync read for hooks. */
export function getGitStatusCached() {
  return getGitCache();
}

// ── Git blame cache ──

/** Fire-and-forget refresh for a specific file. Call before agent reads it. */
export async function refreshGitBlame(projectPath: string, filePath: string): Promise<void> {
  if (hasBlameEntry(filePath)) return;
  if (!filePath.match(/\.(ts|tsx|js|jsx|rs|py|go|java|rb|cs|kt|swift|php|lua|css|html)$/)) return;
  try {
    const raw = await rpc<string>('git_blame', { path: projectPath, file: filePath });
    const lines = raw.split('\n');
    const authors = new Set<string>();
    let latestAuthor = '';
    let latestTime = '';
    for (const line of lines) {
      if (line.startsWith('author ')) {
        const a = line.slice(7).trim();
        if (a) {
          authors.add(a);
          latestAuthor = a;
        }
      }
      if (line.startsWith('author-time ')) latestTime = line.slice(12).trim();
    }
    if (latestAuthor) {
      const ago = latestTime ? timeAgo(parseInt(latestTime) * 1000) : '';
      setBlameEntry(
        filePath,
        `${latestAuthor}${ago ? ', ' + ago : ''}${authors.size > 1 ? ` (+${authors.size - 1} others)` : ''}`,
      );
    }
  } catch {
    /* silent */
  }
}

/** Sync read for hooks. */
export function getGitBlameCached(filePath: string): string | null {
  return getBlameCache()[filePath] ?? null;
}

// ── Check status cache ──

/** Called by CheckPanel.update() when a new check result arrives. */
export function cacheCheckResult(result: ReturnType<typeof getCheckCache> & {}): void {
  setCheckCache(result as any);
}

/** Sync read for hooks. */
export function getCheckStatusCached() {
  return getCheckCache();
}

// ── Build/test result cache ──

/** Called by run_shell hook when a test/build command finishes. */
export function cacheBuildResult(result: ReturnType<typeof getBuildResultCache> & {}): void {
  setBuildResultCache(result as any);
}

/** Format cached build/test result for turn-start. Consumed on read. */
export function formatBuildResult(): string | null {
  const r = getBuildResultCache();
  if (!r) return null;
  setBuildResultCache(null); // consume — only inject once
  const icon = r.outcome === 'pass' ? '✅' : '❌';
  return `[构建] ${icon} ${r.command}: ${r.summary}`;
}

// ── Timeline cache ──

const TIMELINE_CACHE_MS = 10000;

/** Fire-and-forget refresh. */
export async function refreshTimeline(projectPath: string): Promise<void> {
  const now = Date.now();
  const cached = getTimelineCache();
  if (cached.length > 0 && now - getTimelineCacheTs() < TIMELINE_CACHE_MS) return;
  try {
    const json = await rpc<string>('hologram_call', {
      tool: 'project_timeline',
      args: { path: projectPath, limit: 8 },
    });
    const raw = JSON.parse(json);
    setTimelineCache((raw.events || []).slice(0, 8), now);
  } catch {
    /* silent */
  }
}

/** Format recent timeline events for turn-start. Only show user-facing events. */
export function formatTimeline(): string | null {
  const cached = getTimelineCache();
  if (cached.length === 0) return null;
  const recent = cached.slice(0, 5);
  const labels = recent.map((e) => {
    const fname = e.file ? e.file.replace(/\\/g, '/').split('/').pop() : '';
    const label = eventLabel(e.event_type);
    return fname ? `${label} ${fname}` : label;
  });
  return `[时间轴] ${labels.join(' → ')}`;
}

function eventLabel(type: string): string {
  switch (type) {
    case 'agent_write':
      return '写入';
    case 'agent_edit':
      return '编辑';
    case 'agent_delete':
      return '删除';
    case 'agent_rename':
      return '重命名';
    case 'agent_move':
      return '移动';
    case 'commit_clean':
      return '✅';
    case 'commit_violation':
      return '⚠️';
    case 'file_changed':
      return '外部变更';
    case 'incremental_update':
      return '图更新';
    default:
      return type;
  }
}

// ── Formatters — build injectable strings from cached data ──

/** Format git status for turn-start injection. */
export function formatGitStatus(): string | null {
  const git = getGitCache();
  if (!git || git.dirtyCount === 0) return null;
  const fileList = git.dirtyFiles
    .map((f) => `${f.file.replace(/\\/g, '/').split('/').pop()}(${f.status[0].toUpperCase()})`)
    .join(', ');
  return `[Git] ${git.branch}${git.ahead > 0 ? ` ↑${git.ahead}` : ''}${git.behind > 0 ? ` ↓${git.behind}` : ''} | ${git.dirtyCount} 脏: ${fileList}`;
}

/** Format check status for turn-start injection. */
export function formatCheckStatus(): string | null {
  const r = getCheckCache();
  if (!r) return null;
  const parts: string[] = [];
  if (r.passed) {
    parts.push('✅ 通过');
  } else {
    parts.push(`⚠️ ${r.violationCount} 违规`);
  }
  if (r.newCount > 0) parts.push(`+${r.newCount} 新增`);
  if (r.resolvedCount > 0) parts.push(`-${r.resolvedCount} 已解决`);
  if (r.persistentCount > 0) parts.push(`↻${r.persistentCount} 持续`);
  return `[简报] ${parts.join(' | ')}`;
}

/** Format diagnostics for pre-read injection. */
export function formatDiagnostics(filePath: string, getDiags: DiagnosticsSource): string | null {
  const diags = getDiags(filePath);
  if (diags.length === 0) return null;
  const errors = diags.filter((d) => d.severity === 'error');
  const warnings = diags.filter((d) => d.severity === 'warning');
  const parts: string[] = [];
  if (errors.length > 0) parts.push(`${errors.length} errors`);
  if (warnings.length > 0) parts.push(`${warnings.length} warnings`);
  if (parts.length === 0) return null;
  const top3 = diags
    .slice(0, 3)
    .map((d) => `L${d.startLine + 1}: ${d.message.slice(0, 80)}`)
    .join('; ');
  const fname = filePath.replace(/\\/g, '/').split('/').pop();
  return `[LSP] ${fname}: ${parts.join(', ')}${top3 ? ' — ' + top3 : ''}`;
}

/** Format git blame for pre-read injection. */
export function formatBlame(filePath: string): string | null {
  const blame = getGitBlameCached(filePath);
  if (!blame) return null;
  const fname = filePath.replace(/\\/g, '/').split('/').pop();
  return `[Git] ${fname}: ${blame}`;
}

// ── Turn-start snapshot — full state block for system-reminder injection ──

/** Build the full turn-start injection block from all cached sources. */
export function buildTurnStartBlock(): string {
  const lines: string[] = [];
  const git = formatGitStatus();
  if (git) lines.push(git);
  const check = formatCheckStatus();
  if (check) lines.push(check);
  const timeline = formatTimeline();
  if (timeline) lines.push(timeline);
  const build = formatBuildResult();
  if (build) lines.push(build);
  return lines.length > 0 ? lines.join('\n') : '';
}

/** Build pre-read injection block for a specific file. */
export function buildPreReadBlock(filePath: string, getDiags: DiagnosticsSource): string {
  const lines: string[] = [];
  const diag = formatDiagnostics(filePath, getDiags);
  if (diag) lines.push(diag);
  const blame = formatBlame(filePath);
  if (blame) lines.push(blame);
  return lines.join('\n');
}

// ── Helpers ──

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
