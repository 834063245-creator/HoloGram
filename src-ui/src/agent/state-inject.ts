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

import { invoke } from '../bridge';
import { getDiagnosticsForFile } from '../ui/lsp-client';
import type { LspDiagnostic } from '../ui/lsp-client';

// Re-export for consumers
export type { LspDiagnostic };

// ── Types ──

export interface GitStatusSummary {
  branch: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  dirtyFiles: Array<{ file: string; status: string }>;
}

export interface CheckStatusSummary {
  passed: boolean;
  violationCount: number;
  newCount: number;
  resolvedCount: number;
  persistentCount: number;
}

// ── Git status cache ──

let gitCache: GitStatusSummary | null = null;
let gitCacheTs = 0;
const GIT_CACHE_MS = 5000;

/** Fire-and-forget refresh. Call from onSessionPersisted or turn-start. */
export async function refreshGitStatus(projectPath: string): Promise<void> {
  const now = Date.now();
  if (gitCache && (now - gitCacheTs) < GIT_CACHE_MS) return;
  try {
    const json = await invoke<string>('git_status', { path: projectPath });
    const raw = JSON.parse(json);
    gitCache = {
      branch: raw.branch || '',
      ahead: raw.ahead || 0,
      behind: raw.behind || 0,
      dirtyCount: (raw.files || []).length,
      dirtyFiles: (raw.files || []).slice(0, 15),
    };
    gitCacheTs = now;
  } catch { /* silent */ }
}

/** Sync read for hooks. */
export function getGitStatusCached(): GitStatusSummary | null {
  return gitCache;
}

// ── Git blame cache ──

const blameCache = new Map<string, string>();

/** Fire-and-forget refresh for a specific file. Call before agent reads it. */
export async function refreshGitBlame(projectPath: string, filePath: string): Promise<void> {
  if (blameCache.has(filePath)) return;
  // Only source files
  if (!filePath.match(/\.(ts|tsx|js|jsx|rs|py|go|java|rb|cs|kt|swift|php|lua|css|html)$/)) return;
  try {
    const raw = await invoke<string>('git_blame', { path: projectPath, file: filePath });
    const lines = raw.split('\n');
    const authors = new Set<string>();
    let latestAuthor = '';
    let latestTime = '';
    for (const line of lines) {
      if (line.startsWith('author ')) { const a = line.slice(7).trim(); if (a) { authors.add(a); latestAuthor = a; } }
      if (line.startsWith('author-time ')) latestTime = line.slice(12).trim();
    }
    if (latestAuthor) {
      const ago = latestTime ? timeAgo(parseInt(latestTime) * 1000) : '';
      blameCache.set(filePath, `${latestAuthor}${ago ? ', ' + ago : ''}${authors.size > 1 ? ` (+${authors.size - 1} others)` : ''}`);
    }
  } catch { /* silent */ }
}

/** Sync read for hooks. */
export function getGitBlameCached(filePath: string): string | null {
  return blameCache.get(filePath) ?? null;
}

// ── Check status cache ──

let checkCache: CheckStatusSummary | null = null;

/** Called by CheckPanel.update() when a new check result arrives. */
export function cacheCheckResult(result: CheckStatusSummary): void {
  checkCache = result;
}

/** Sync read for hooks. */
export function getCheckStatusCached(): CheckStatusSummary | null {
  return checkCache;
}

// ── Timeline cache ──

interface TimelineEvent {
  event_type: string;
  file?: string;
  summary?: string;
  timestamp: string;
}

let timelineCache: TimelineEvent[] = [];
let timelineCacheTs = 0;
const TIMELINE_CACHE_MS = 10000;

/** Fire-and-forget refresh. */
export async function refreshTimeline(projectPath: string): Promise<void> {
  const now = Date.now();
  if (timelineCache.length > 0 && (now - timelineCacheTs) < TIMELINE_CACHE_MS) return;
  try {
    const json = await invoke<string>('hologram_call', { tool: 'project_timeline', args: { path: projectPath, limit: 8 } });
    const raw = JSON.parse(json);
    timelineCache = (raw.events || []).slice(0, 8);
    timelineCacheTs = now;
  } catch { /* silent */ }
}

/** Format recent timeline events for turn-start. Only show user-facing events. */
export function formatTimeline(): string | null {
  if (timelineCache.length === 0) return null;
  const recent = timelineCache.slice(0, 5);
  const labels = recent.map(e => {
    const fname = e.file ? e.file.replace(/\\/g, '/').split('/').pop() : '';
    const label = eventLabel(e.event_type);
    return fname ? `${label} ${fname}` : label;
  });
  return `[时间轴] ${labels.join(' → ')}`;
}

function eventLabel(type: string): string {
  switch (type) {
    case 'agent_write': return '写入';
    case 'agent_edit': return '编辑';
    case 'agent_delete': return '删除';
    case 'agent_rename': return '重命名';
    case 'agent_move': return '移动';
    case 'commit_clean': return '✅';
    case 'commit_violation': return '⚠️';
    case 'file_changed': return '外部变更';
    case 'incremental_update': return '图更新';
    default: return type;
  }
}

// ── Formatters — build injectable strings from cached data ──

/** Format git status for turn-start injection. */
export function formatGitStatus(): string | null {
  const git = gitCache;
  if (!git || git.dirtyCount === 0) return null;
  const fileList = git.dirtyFiles.map(f => `${f.file.replace(/\\/g, '/').split('/').pop()}(${f.status[0].toUpperCase()})`).join(', ');
  return `[Git] ${git.branch}${git.ahead > 0 ? ` ↑${git.ahead}` : ''}${git.behind > 0 ? ` ↓${git.behind}` : ''} | ${git.dirtyCount} 脏: ${fileList}`;
}

/** Format check status for turn-start injection. */
export function formatCheckStatus(): string | null {
  const r = checkCache;
  if (!r) return null;
  const parts: string[] = [];
  if (r.passed) { parts.push('✅ 通过'); }
  else { parts.push(`⚠️ ${r.violationCount} 违规`); }
  if (r.newCount > 0) parts.push(`+${r.newCount} 新增`);
  if (r.resolvedCount > 0) parts.push(`-${r.resolvedCount} 已解决`);
  if (r.persistentCount > 0) parts.push(`↻${r.persistentCount} 持续`);
  return `[简报] ${parts.join(' | ')}`;
}

/** Format diagnostics for pre-read injection. */
export function formatDiagnostics(filePath: string): string | null {
  const diags = getDiagnosticsForFile(filePath);
  if (diags.length === 0) return null;
  const errors = diags.filter(d => d.severity === 'error');
  const warnings = diags.filter(d => d.severity === 'warning');
  const parts: string[] = [];
  if (errors.length > 0) parts.push(`${errors.length} errors`);
  if (warnings.length > 0) parts.push(`${warnings.length} warnings`);
  if (parts.length === 0) return null;
  const top3 = diags.slice(0, 3).map(d => `L${d.startLine + 1}: ${d.message.slice(0, 80)}`).join('; ');
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
  return lines.length > 0 ? lines.join('\n') : '';
}

/** Build pre-read injection block for a specific file. */
export function buildPreReadBlock(filePath: string): string {
  const lines: string[] = [];
  const diag = formatDiagnostics(filePath);
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
