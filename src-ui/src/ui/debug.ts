// Debug diagnostics — controlled by localStorage.debugHologram = '1' or URL ?debug
// Totally silent in normal use. Open browser console and type:
//   localStorage.debugHologram = '1'
// then refresh to see all interaction chain data flow.

const searchParams = typeof URLSearchParams !== 'undefined'
  ? new URLSearchParams(window.location.search) : null;
const urlDebug = searchParams?.has('debug');

export const DEBUG = (typeof localStorage !== 'undefined' && localStorage.getItem('debugHologram') === '1')
  || !!urlDebug;

export function dbg(tag: string, ...args: unknown[]): void {
  if (DEBUG) console.debug(`%c[${tag}]`, 'color:#88aacc', ...args);
}
