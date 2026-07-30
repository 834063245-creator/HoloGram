// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 调试诊断 — 由 localStorage.debugHologram = '1' 或 URL ?debug 控制
// 正常使用时完全静默。打开浏览器控制台输入：
//   localStorage.debugHologram = '1'
// 然后刷新即可查看所有交互链数据流。

const isBrowser = typeof window !== 'undefined' && typeof window.location !== 'undefined';
const isNode = !isBrowser;

const searchParams =
  isBrowser && typeof URLSearchParams !== 'undefined' ? new URLSearchParams(window.location.search) : null;
const urlDebug = searchParams?.has('debug');

const localDebug = typeof localStorage !== 'undefined' && localStorage.getItem('debugHologram') === '1';

export const DEBUG = isNode ? false : localDebug || !!urlDebug;

export function dbg(tag: string, ...args: unknown[]): void {
  if (DEBUG) console.debug(`%c[${tag}]`, 'color:#88aacc', ...args);
}
