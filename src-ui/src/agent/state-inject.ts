// 状态注入 — Agent 循环的项目状态钩子。
//
// 模式：异步刷新，同步读取。数据通过异步方式收集
// （从 workspace 生命周期回调中 fire-and-forget）并缓存在内存中。
// 钩子同步读取缓存 — 热路径中无异步操作。
//
// 注入点：
//   TurnStart  — onSessionPersisted → 刷新缓存 → 下一轮看到新数据
//   PreRead    — read_file_content 钩子 → 同步读取 diag + blame 缓存
//   PostEdit   — write-tool 钩子 → 同步读取 check 缓存
//
// 所有调用都能优雅降级 — 数据不可用时不注入任何内容。

import { typedRpc } from '../rpc-contract';
import {
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
import type { BuildResult, CheckStatusSummary } from './cache-store';

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

/** 诊断数据源 — 由 workspace 注入（UI 拥有 LSP 客户端）。 */
export type DiagnosticsSource = (filePath: string) => LspDiagnostic[];

// ── Git 状态缓存 ──

const GIT_CACHE_MS = 5000;

/** Fire-and-forget 刷新。从 onSessionPersisted 或 turn-start 调用。 */
export async function refreshGitStatus(projectPath: string): Promise<void> {
  const now = Date.now();
  const cached = getGitCache();
  if (cached && now - getGitCacheTs() < GIT_CACHE_MS) return;
  try {
    const json = await typedRpc('git_status', { path: projectPath });
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

/** 钩子同步读取。 */
export function getGitStatusCached() {
  return getGitCache();
}

// ── Git blame 缓存 ──

/** 对特定文件进行 fire-and-forget 刷新。在 agent 读取文件前调用。 */
export async function refreshGitBlame(projectPath: string, filePath: string): Promise<void> {
  if (hasBlameEntry(filePath)) return;
  if (!filePath.match(/\.(ts|tsx|js|jsx|rs|py|go|java|rb|cs|kt|swift|php|lua|css|html)$/)) return;
  try {
    const raw = await typedRpc('git_blame', { path: projectPath, file: filePath });
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
      const ago = latestTime ? timeAgo(parseInt(latestTime, 10) * 1000) : '';
      setBlameEntry(
        filePath,
        `${latestAuthor}${ago ? ', ' + ago : ''}${authors.size > 1 ? ` (+${authors.size - 1} others)` : ''}`,
      );
    }
  } catch {
    /* silent */
  }
}

/** 钩子同步读取。 */
export function getGitBlameCached(filePath: string): string | null {
  return getBlameCache()[filePath] ?? null;
}

// ── Check 状态缓存 ──

/** 由 CheckPanel.update() 在新检查结果到达时调用。 */
export function cacheCheckResult(result: ReturnType<typeof getCheckCache> & {}): void {
  setCheckCache(result as CheckStatusSummary);
}

/** 钩子同步读取。 */
export function getCheckStatusCached() {
  return getCheckCache();
}

// ── 构建/测试结果缓存 ──

/** 由 run_shell 钩子在测试/构建命令完成时调用。 */
export function cacheBuildResult(result: ReturnType<typeof getBuildResultCache> & {}): void {
  setBuildResultCache(result as BuildResult);
}

/** 格式化缓存的构建/测试结果用于 turn-start。读取时消费。 */
export function formatBuildResult(): string | null {
  const r = getBuildResultCache();
  if (!r) return null;
  setBuildResultCache(null); // 消费 — 只注入一次
  const icon = r.outcome === 'pass' ? '✅' : '❌';
  return `[构建] ${icon} ${r.command}: ${r.summary}`;
}

// ── 时间轴缓存 ──

const TIMELINE_CACHE_MS = 10000;

/** Fire-and-forget 刷新。 */
export async function refreshTimeline(projectPath: string): Promise<void> {
  const now = Date.now();
  const cached = getTimelineCache();
  if (cached.length > 0 && now - getTimelineCacheTs() < TIMELINE_CACHE_MS) return;
  try {
    const json = await typedRpc('hologram_call', {
      tool: 'project_timeline',
      args: { path: projectPath, limit: 8 },
    });
    const raw = JSON.parse(json);
    setTimelineCache((raw.events || []).slice(0, 8), now);
  } catch {
    /* silent */
  }
}

/** 格式化最近的时间轴事件用于 turn-start。仅显示面向用户的事件。 */
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

// ── 格式化器 — 从缓存数据构建可注入字符串 ──

/** 格式化 git 状态用于 turn-start 注入。 */
export function formatGitStatus(): string | null {
  const git = getGitCache();
  if (!git || git.dirtyCount === 0) return null;
  const fileList = git.dirtyFiles
    .map((f) => `${f.file.replace(/\\/g, '/').split('/').pop()}(${f.status[0].toUpperCase()})`)
    .join(', ');
  return `[Git] ${git.branch}${git.ahead > 0 ? ` ↑${git.ahead}` : ''}${git.behind > 0 ? ` ↓${git.behind}` : ''} | ${git.dirtyCount} 脏: ${fileList}`;
}

/** 格式化 check 状态用于 turn-start 注入。 */
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

/** 格式化诊断信息用于 pre-read 注入。 */
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

/** 格式化 git blame 用于 pre-read 注入。 */
export function formatBlame(filePath: string): string | null {
  const blame = getGitBlameCached(filePath);
  if (!blame) return null;
  const fname = filePath.replace(/\\/g, '/').split('/').pop();
  return `[Git] ${fname}: ${blame}`;
}

// ── Turn-start 快照 — 用于 system-reminder 注入的完整状态块 ──

/** 从所有缓存数据源构建完整的 turn-start 注入块。 */
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

/** 为指定文件构建 pre-read 注入块。 */
export function buildPreReadBlock(filePath: string, getDiags: DiagnosticsSource): string {
  const lines: string[] = [];
  const diag = formatDiagnostics(filePath, getDiags);
  if (diag) lines.push(diag);
  const blame = formatBlame(filePath);
  if (blame) lines.push(blame);
  return lines.join('\n');
}

// ── 辅助函数 ──

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
