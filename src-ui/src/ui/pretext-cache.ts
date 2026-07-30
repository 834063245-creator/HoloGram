// Pretext cache — singleton measurement engine for chat virtualization.
//
// Pretext needs a Canvas 2D context for measureText. We lazily create an
// offscreen canvas on first use (browser/Tauri WebView only). Font constants
// mirror the CSS in chat.css so canvas measurements match DOM rendering.

import { prepare, layout, clearCache, type PreparedText } from '../lib/pretext/layout.js';

// ── Font constants (must match chat.css) ──

// .msg-bubble: font-size = calc(11px * var(--font-scale)), line-height: 1.6
// (assistant markdown text overrides to 1.7 via .msg-markdown).
// --font-scale defaults to 1 (tokens.css). We read it at measurement time
// in case the user changed it.
export function fontScale(): number {
  if (typeof document !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim();
    const n = Number.parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

// Body font for user + assistant text parts.
// NOTE: no Math.round — CSS keeps fractional px (e.g. 12.65px at scale 1.15)
// and canvas accepts fractional sizes; rounding skews every measured width.
export function bodyFont(): string {
  return `${11 * fontScale()}px "LXGW WenKai", "Noto Sans SC", system-ui, sans-serif`;
}

// Body line-height: .msg-bubble uses 1.6, .msg-markdown (assistant text) 1.7.
// Fractional too — Blink lays out at 17.6px, not 18px.
export function bodyLineHeight(mult = 1.6): number {
  return 11 * fontScale() * mult;
}

// Mono font for code blocks (streaming tail + tool output)
export function monoFont(): string {
  return `${9 * fontScale()}px "JetBrains Mono", "Cascadia Code", monospace`;
}

export function monoLineHeight(mult = 1.5): number {
  return 9 * fontScale() * mult;
}

// ── prepare() cache ──
// Key: `${font}::${text}` → PreparedText. prepare() is expensive (segmentation +
// canvas measurement); layout() is ~0.0002ms. We cache prepare() results so
// repeated layout() calls at different widths are cheap.

const prepareCache = new Map<string, PreparedText>();

export function getPrepared(text: string, font: string): PreparedText {
  const key = `${font}::${text}`;
  let p = prepareCache.get(key);
  if (p === undefined) {
    // whiteSpace must mirror the DOM: .msg-text is pre-wrap, so \n is a hard
    // line break — the library default 'normal' would collapse it to a space
    // and undercount lines for any multi-line message.
    p = prepare(text, font, { whiteSpace: 'pre-wrap' });
    prepareCache.set(key, p);
    // Cap cache size — evict oldest entries
    if (prepareCache.size > 500) {
      const firstKey = prepareCache.keys().next().value;
      if (firstKey !== undefined) prepareCache.delete(firstKey);
    }
  }
  return p;
}

// ── Convenience: measure text height at a given width ──

export function measureTextHeight(text: string, maxWidth: number, font?: string, lineHeight?: number): number {
  if (!text) return 0;
  const f = font ?? bodyFont();
  const lh = lineHeight ?? bodyLineHeight();
  const prepared = getPrepared(text, f);
  return layout(prepared, maxWidth, lh).height;
}

// ── Cache management ──

export function clearPretextCache(): void {
  prepareCache.clear();
  clearCache();
}