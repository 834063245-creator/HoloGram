// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Debug diagnostics — controlled by localStorage.debugHologram = '1' or URL ?debug
// Totally silent in normal use. Open browser console and type:
//   localStorage.debugHologram = '1'
// then refresh to see all interaction chain data flow.

const isBrowser = typeof window !== 'undefined' && typeof window.location !== 'undefined';
const isNode = !isBrowser;

const searchParams = isBrowser && typeof URLSearchParams !== 'undefined'
  ? new URLSearchParams(window.location.search) : null;
const urlDebug = searchParams?.has('debug');

const localDebug = typeof localStorage !== 'undefined' && localStorage.getItem('debugHologram') === '1';

export const DEBUG = isNode ? false : (localDebug || !!urlDebug);

export function dbg(tag: string, ...args: unknown[]): void {
  if (DEBUG) console.debug(`%c[${tag}]`, 'color:#88aacc', ...args);
}
