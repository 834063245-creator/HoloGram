// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// browser 领域工具的 self 探针默认实现 — webview 内直接读 DOM。
// 放在 UI 层而非 agent 层：agent 层禁止浏览器 API（agent-boundary 测试强制），
// 由 runtime-adapter 的 createBuilderDeps 注入给 buildToolRegistry。

import type { DomElementSnapshot, DomProbe } from '../agent/tools/browser';

function px(v: string | null | undefined): number | null {
  const m = String(v ?? '').match(/^([\d.]+)px$/);
  return m ? parseFloat(m[1]) : null;
}

function parseColor(c: string | null | undefined): [number, number, number] | null {
  const m = String(c ?? '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
  if (a < 0.5) return null;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

function lum(rgb: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = lum(a);
  const lb = lum(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 默认探针 — 在 webview 内直接读 DOM（无 RPC、零延迟） */
export const defaultDomProbe: DomProbe = {
  async inspect(selector, props = [], maxResults = 20): Promise<DomElementSnapshot[]> {
    const els = Array.from(document.querySelectorAll(selector)).slice(0, maxResults);
    const want = (k: string) => props.length === 0 || props.includes(k);
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const out: DomElementSnapshot = { tag: el.tagName.toLowerCase(), selector };
      if (el.id) out.id = el.id;
      if (want('geometry')) {
        out.rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        out.visible = r.width > 0 && r.height > 0;
        out.scrollable = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
      }
      if (want('style')) {
        out.style = {
          color: cs.color,
          background: cs.backgroundColor,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          padding: cs.padding,
          margin: cs.margin,
          borderRadius: cs.borderRadius,
          boxShadow: cs.boxShadow,
          gap: cs.gap,
        };
      }
      if (want('text')) {
        out.text = (el.textContent || '').trim().slice(0, 200);
      }
      if (want('contrast')) {
        const fg = parseColor(cs.color);
        const bg = parseColor(cs.backgroundColor) || parseColor(getComputedStyle(el.parentElement || el).backgroundColor);
        if (fg && bg) out.contrast = Math.round(contrast(fg, bg) * 100) / 100;
      }
      return out;
    });
  },

  async report(scope?: string) {
    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) return { issues: [{ rule: 'scope', severity: 'error', detail: 'scope 选择器无匹配' }], ok: false };
    const issues: Array<{ rule: string; severity: string; detail: string; selector: string }> = [];
    const SPACING_SCALE = [4, 8, 12, 16, 24, 32, 48];
    const onScale = (v: string) => {
      const n = px(v);
      if (n === null) return true;
      return SPACING_SCALE.some((s) => Math.abs(s - n) <= 1);
    };
    const shortPath = (el: Element) => {
      if (el.id) return '#' + el.id;
      const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : '';
      let s = el.tagName.toLowerCase();
      if (cls) s += '.' + cls;
      return s + ' <' + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) + '>';
    };
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    // 收集可见文本元素（限 500 防卡死）
    const all: Element[] = [];
    const walk = (el: Element) => {
      if (all.length >= 500) return;
      if (el.children.length === 0 && (el.textContent || '').trim()) all.push(el);
      for (const c of Array.from(el.children)) walk(c);
    };
    walk(root);
    // 1. 对比度
    let contrastCount = 0;
    for (const el of all) {
      if (!vis(el)) continue;
      const cs = getComputedStyle(el);
      const fg = parseColor(cs.color);
      const bg = parseColor(cs.backgroundColor) || parseColor(getComputedStyle(el.parentElement || el).backgroundColor);
      if (fg && bg) {
        const r = contrast(fg, bg);
        if (r < 4.5 && contrastCount < 8) {
          contrastCount++;
          issues.push({ rule: 'contrast', severity: 'warn', detail: `对比度 ${r.toFixed(2)}:1 < 4.5:1`, selector: shortPath(el) });
        }
      }
    }
    // 2. 间距纪律（块元素）
    const blocks = Array.from(root.querySelectorAll('div, section, article, header, footer, main, aside')).filter(vis).slice(0, 200);
    let spacingCount = 0;
    for (const el of blocks) {
      const cs = getComputedStyle(el);
      const spacingProps: Array<keyof CSSStyleDeclaration> = [
        'paddingTop',
        'paddingBottom',
        'paddingLeft',
        'paddingRight',
        'marginTop',
        'marginBottom',
      ];
      for (const p of spacingProps) {
        const v = String(cs[p] ?? '');
        if (!onScale(v)) {
          if (spacingCount < 6) {
            spacingCount++;
            issues.push({ rule: 'spacing', severity: 'info', detail: `${String(p)} = ${v}（不在 4/8/12/16/24/32 刻度上）`, selector: shortPath(el) });
          }
          break;
        }
      }
    }
    // 3. 对齐：同行元素左缘偏差
    const rows = new Map<number, Array<{ x: number; el: Element }>>();
    for (const el of blocks.slice(0, 100)) {
      const r = el.getBoundingClientRect();
      const key = Math.round(r.y / 20);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key)!.push({ x: Math.round(r.x), el });
    }
    let alignCount = 0;
    for (const [, group] of rows) {
      if (group.length >= 2) {
        const xs = [...new Set(group.map((g) => g.x))];
        if (xs.length >= 2 && Math.max(...xs) - Math.min(...xs) > 2 && alignCount < 5) {
          alignCount++;
          issues.push({
            rule: 'alignment',
            severity: 'warn',
            detail: `同行元素左缘偏差 ${Math.max(...xs) - Math.min(...xs)}px`,
            selector: group.map((g) => shortPath(g.el)).join(', '),
          });
        }
      }
    }
    // 4. 层级：过多同级阴影
    const shadowCounts = new Map<string, number>();
    for (const el of blocks.slice(0, 150)) {
      const cs = getComputedStyle(el);
      const sh = cs.boxShadow;
      if (sh && sh !== 'none') shadowCounts.set(sh, (shadowCounts.get(sh) || 0) + 1);
    }
    for (const [sh, c] of shadowCounts) {
      if (c >= 5) {
        issues.push({ rule: 'hierarchy', severity: 'info', detail: `${c} 个元素使用相同阴影 ${sh.slice(0, 60)} — 视觉上无焦点`, selector: '—' });
      }
    }
    // 5. 溢出
    let overflowCount = 0;
    for (const el of blocks.slice(0, 100)) {
      if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
        const cs = getComputedStyle(el);
        if (cs.overflow === 'visible' && overflowCount < 5) {
          overflowCount++;
          issues.push({
            rule: 'overflow',
            severity: 'warn',
            detail: `内容溢出 ${el.scrollWidth - el.clientWidth}px 宽 / ${el.scrollHeight - el.clientHeight}px 高`,
            selector: shortPath(el),
          });
        }
      }
    }
    return { issues: issues.slice(0, 30), ok: issues.length === 0 };
  },
};
