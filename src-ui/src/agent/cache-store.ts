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
}

export const cacheStore = createStore<CacheState>(() => ({
  gitCache: null,
  gitCacheTs: 0,
  blameCache: {},
  checkCache: null,
  buildResultCache: null,
  timelineCache: [],
  timelineCacheTs: 0,
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
