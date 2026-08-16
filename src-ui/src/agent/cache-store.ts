// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// CacheStore — 从 state-inject.ts 模块级 let 迁移而来的 agent 注入缓存。
// 所有数据均可序列化；不含 Map/Set/Promise/AbortController。

import { createStore } from 'zustand/vanilla';

// ── 类型 ──

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

export interface BuildResult {
  command: string;
  outcome: 'pass' | 'fail';
  summary: string;
  ts: number;
  /** 产生该结果的 Agent（executor 注入的 _agent_id）。
   *  turn-start 只消费同 Agent 的条目，避免跨会话张冠李戴。 */
  ownerId?: string | null;
}

export interface TimelineEvent {
  event_type: string;
  file?: string;
  summary?: string;
  timestamp: string;
}

// ── Store ──

interface CacheState {
  gitCache: GitStatusSummary | null;
  gitCacheTs: number;
  blameCache: Record<string, string>;
  checkCache: CheckStatusSummary | null;
  buildResultCache: BuildResult | null;
  timelineCache: TimelineEvent[];
  timelineCacheTs: number;
  /** 代际计数 — resetAgentCaches 递增；异步刷新 resolve 时比对，
   *  代际不同说明工作区已切换，在途的旧项目数据直接丢弃。 */
  epoch: number;
}

export const cacheStore = createStore<CacheState>(() => ({
  gitCache: null,
  gitCacheTs: 0,
  blameCache: {},
  checkCache: null,
  buildResultCache: null,
  timelineCache: [],
  timelineCacheTs: 0,
  epoch: 0,
}));

// ── 访问器（镜像 state-inject.ts 导出接口）──

export function getGitCache(): GitStatusSummary | null {
  return cacheStore.getState().gitCache;
}
export function setGitCache(cache: GitStatusSummary, ts: number): void {
  cacheStore.setState({ gitCache: cache, gitCacheTs: ts });
}
export function getGitCacheTs(): number {
  return cacheStore.getState().gitCacheTs;
}

export function getBlameCache(): Record<string, string> {
  return cacheStore.getState().blameCache;
}
export function setBlameEntry(file: string, value: string): void {
  cacheStore.setState((s) => ({ blameCache: { ...s.blameCache, [file]: value } }));
}
export function hasBlameEntry(file: string): boolean {
  return file in cacheStore.getState().blameCache;
}

export function getCheckCache(): CheckStatusSummary | null {
  return cacheStore.getState().checkCache;
}
export function setCheckCache(result: CheckStatusSummary): void {
  cacheStore.setState({ checkCache: result });
}

export function getBuildResultCache(): BuildResult | null {
  return cacheStore.getState().buildResultCache;
}
export function setBuildResultCache(result: BuildResult | null): void {
  cacheStore.setState({ buildResultCache: result });
}

export function getTimelineCache(): TimelineEvent[] {
  return cacheStore.getState().timelineCache;
}
export function setTimelineCache(events: TimelineEvent[], ts: number): void {
  cacheStore.setState({ timelineCache: events, timelineCacheTs: ts });
}
export function getTimelineCacheTs(): number {
  return cacheStore.getState().timelineCacheTs;
}

// ── 生命周期 ──

export function getCacheEpoch(): number {
  return cacheStore.getState().epoch;
}

/** 工作区停用/切换时清空全部注入缓存并推进代际。
 *  清空防止旧项目状态注入新项目；推进代际让在途的
 *  fire-and-forget 刷新 resolve 后自动放弃写入。 */
export function resetAgentCaches(): void {
  cacheStore.setState((s) => ({
    gitCache: null,
    gitCacheTs: 0,
    blameCache: {},
    checkCache: null,
    buildResultCache: null,
    timelineCache: [],
    timelineCacheTs: 0,
    epoch: s.epoch + 1,
  }));
}

/** 编辑/写入前调用 — 使该文件的 blame 条目失效，下次 pre-read 重新拉取。 */
export function invalidateBlameEntry(file: string): void {
  const s = cacheStore.getState();
  if (!(file in s.blameCache)) return;
  const next = { ...s.blameCache };
  delete next[file];
  cacheStore.setState({ blameCache: next });
}
