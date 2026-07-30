// Pretext 缓存 — 聊天虚拟化的单例测量引擎。
//
// Pretext 需要 Canvas 2D context 来执行 measureText。我们在首次使用时
// 惰性创建离屏 canvas（仅浏览器/Tauri WebView）。字体常量
// 镜像 chat.css 中的 CSS，使 canvas 测量与 DOM 渲染一致。

import { prepare, layout, clearCache, type PreparedText } from '../lib/pretext/layout.js';

// ── 字体常量（必须与 chat.css 匹配）──

// .msg-bubble: font-size = calc(11px * var(--font-scale))，line-height: 1.6
// （助手 markdown 文本通过 .msg-markdown 覆盖为 1.7）。
// --font-scale 默认 1（tokens.css）。我们在测量时读取，
// 以防用户已更改。
export function fontScale(): number {
  if (typeof document !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim();
    const n = Number.parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

// 用户 + 助手文本部分的正文字体。
// 注意：无 Math.round — CSS 保留小数 px（如 scale 1.15 时 12.65px），
// canvas 接受小数大小；取整会使每个测量宽度产生偏差。
export function bodyFont(): string {
  return `${11 * fontScale()}px "LXGW WenKai", "Noto Sans SC", system-ui, sans-serif`;
}

// 正文行高：.msg-bubble 用 1.6，.msg-markdown（助手文本）用 1.7。
// 同样保留小数 — Blink 以 17.6px 而非 18px 布局。
export function bodyLineHeight(mult = 1.6): number {
  return 11 * fontScale() * mult;
}

// 代码块的等宽字体（流式尾部 + 工具输出）
export function monoFont(): string {
  return `${9 * fontScale()}px "JetBrains Mono", "Cascadia Code", monospace`;
}

export function monoLineHeight(mult = 1.5): number {
  return 9 * fontScale() * mult;
}

// ── prepare() 缓存 ──
// Key: `${font}::${text}` → PreparedText。prepare() 开销大（分段 + canvas 测量）；
// layout() 约 0.0002ms。我们缓存 prepare() 结果，
// 使不同宽度的重复 layout() 调用成本很低。

const prepareCache = new Map<string, PreparedText>();

export function getPrepared(text: string, font: string): PreparedText {
  const key = `${font}::${text}`;
  let p = prepareCache.get(key);
  if (p === undefined) {
    // whiteSpace 必须镜像 DOM：.msg-text 是 pre-wrap，所以 \n 是硬换行 —
    // 库默认的 'normal' 会将其折叠为空格，
    // 导致多行消息行数计算不足。
    p = prepare(text, font, { whiteSpace: 'pre-wrap' });
    prepareCache.set(key, p);
    // 限制缓存大小 — 淘汰最早的条目
    if (prepareCache.size > 500) {
      const firstKey = prepareCache.keys().next().value;
      if (firstKey !== undefined) prepareCache.delete(firstKey);
    }
  }
  return p;
}

// ── 便捷方法：在给定宽度下测量文本高度 ──

export function measureTextHeight(text: string, maxWidth: number, font?: string, lineHeight?: number): number {
  if (!text) return 0;
  const f = font ?? bodyFont();
  const lh = lineHeight ?? bodyLineHeight();
  const prepared = getPrepared(text, f);
  return layout(prepared, maxWidth, lh).height;
}

// ── 缓存管理 ──

export function clearPretextCache(): void {
  prepareCache.clear();
  clearCache();
}