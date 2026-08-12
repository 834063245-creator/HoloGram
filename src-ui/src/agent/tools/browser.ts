// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// Browser 工具 — Agent「观察/操作前端页面」能力
// ═══════════════════════════════════════════════════════════════
// 目标：不止自家 webview，更主要是用户日常使用的其他软件前端
// （Chrome / Edge / Electron / 其他 WebView2 应用）。
//
// 双通道：
//   - target=self   → webview 内直读探针（Agent 与 DOM 同上下文，零 RPC）
//   - target=外部   → rpc → Rust cdp 模块 → WebSocket → CDP
//
// 语义化操作：模型只给 CSS selector，坐标/聚焦由探针内部处理。
// 借鉴 HanaAgent computer-use 设计：能力声明（描述里写清能做什么）、
// 结果截断（防上下文爆炸）、语义化（不给裸坐标）。

import { z } from 'zod';
import type { Tool } from '../tool';
import { agentInvoke } from '../tool';
import { defineTool } from './define-tool';

// ═══════════════════════════════════════════════════════════════
// self 探针 — webview 内直读（Agent 与页面同上下文）
// ═══════════════════════════════════════════════════════════════

/** 元素快照（几何/样式/文本/对比度） */
export interface DomElementSnapshot {
  tag: string;
  selector: string;
  id?: string;
  rect?: { x: number; y: number; width: number; height: number };
  visible?: boolean;
  scrollable?: boolean;
  style?: Record<string, string>;
  text?: string;
  contrast?: number;
}

export interface DomProbe {
  /** 读取元素（CSS selector） */
  inspect: (selector: string, props?: string[], maxResults?: number) => Promise<DomElementSnapshot[]>;
  /** 视觉 lint 检查 */
  report: (scope?: string) => Promise<{ issues: unknown[]; ok: boolean }>;
}

// ═══════════════════════════════════════════════════════════════
// self 探针实现 — 在 webview 内直接执行（与 cdp.rs 的 INSPECT_PROBE 同构）
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════════

export interface BrowserToolsOptions {
  /** self 探针 — webview 内直读（Agent 装配层注入；mock/测试可注入假探针） */
  domProbe?: DomProbe;
}

const MAX_RESULT_CHARS = 8000;

function truncate(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_RESULT_CHARS)}...[已截断，共 ${s.length} 字符]`;
}

/** 执行 browser 动作。self 走探针，外部走 Rust CDP。 */
async function runBrowserAction(
  action: string,
  args: Record<string, unknown>,
  domProbe?: DomProbe,
): Promise<string> {
  const target = (args.target as string) || 'external';

  // self → webview 内直读（零 RPC）
  if (target === 'self') {
    if (!domProbe) return '[browser] self 模式需要注入 domProbe（当前环境未提供）';
    try {
      switch (action) {
        case 'inspect': {
          const selector = String(args.selector ?? '');
          if (!selector) return '[browser] inspect: selector 不能为空';
          const snaps = await domProbe.inspect(
            selector,
            Array.isArray(args.props) ? (args.props as string[]) : undefined,
            typeof args.maxResults === 'number' ? args.maxResults : undefined,
          );
          return truncate(JSON.stringify(snaps));
        }
        case 'report': {
          const scope = typeof args.scope === 'string' ? args.scope : undefined;
          return truncate(JSON.stringify(await domProbe.report(scope)));
        }
        case 'status':
          return JSON.stringify({ target: 'self', supported: true });
        default:
          return `[browser] self 模式暂不支持动作 ${action}（self 仅支持 inspect/report/status）`;
      }
    } catch (e: any) {
      return `[browser] self 探针错误: ${e?.message || String(e)}`;
    }
  }

  // external → Rust CDP
  const nameMap: Record<string, string> = {
    launch: 'browser_launch',
    kill: 'browser_kill',
    targets: 'browser_targets',
    attach: 'browser_attach',
    inspect: 'browser_inspect',
    report: 'browser_report',
    click: 'browser_click',
    type: 'browser_type',
    press: 'browser_press',
    scroll: 'browser_scroll',
    eval: 'browser_eval',
    status: 'browser_status',
  };
  const cmd = nameMap[action];
  if (!cmd) return `[browser] unsupported action "${action}"`;
  try {
    const result = await agentInvoke<string>(cmd, args);
    return truncate(result ?? '');
  } catch (e: any) {
    return `[browser] ${action} 失败: ${e?.message || String(e)}`;
  }
}

export function createBrowserTools(opts: BrowserToolsOptions = {}): Tool[] {
  const { domProbe } = opts;
  const run = (action: string, args: Record<string, unknown>) => runBrowserAction(action, args, domProbe);

  return [
    defineTool({
      name: 'browser_launch',
      description:
        'Launch a controlled Chrome/Edge instance (isolated profile, never touches the user\'s daily browser data). ' +
        'Use before inspecting/operating external pages. Returns the debug port. ' +
        'If already running, reuses it. Pass url to open a specific page.',
      schema: z.object({
        url: z.string().optional().describe('Optional URL to open in the controlled browser'),
        port: z.number().int().optional().describe('Debug port (default 9222)'),
      }),
      execute: (args) => run('launch', args),
    }),
    defineTool({
      name: 'browser_targets',
      description:
        'List all page targets available on the CDP port — [{id, title, url}]. ' +
        'Use after launch to see what pages exist, then attach to one.',
      schema: z.object({}),
      readOnly: true,
      execute: () => run('targets', {}),
    }),
    defineTool({
      name: 'browser_attach',
      description:
        'Attach to a specific page target (by id from browser_targets) so subsequent inspect/click/type/press/scroll/eval act on it. ' +
        'This takes control of an external page — requires user approval. ' +
        'Note: targetId is the CDP target id; the "target" parameter (self vs external) is separate.',
      schema: z.object({
        targetId: z.string().describe('CDP target id from browser(targets) — not "self"'),
      }),
      execute: (args) => run('attach', args),
    }),
    defineTool({
      name: 'browser_inspect',
      description:
        'Read element geometry/style/text/contrast from the attached page using a CSS selector. ' +
        'Returns JSON array: {tag, id, rect{x,y,width,height}, visible, scrollable, style{color,background,fontSize,...}, text, contrast}. ' +
        'props: optional subset of ["geometry","style","text","contrast"]. maxResults caps elements (default 20). ' +
        'Use to verify visual details after UI changes.',
      schema: z.object({
        selector: z.string().describe('CSS selector of element(s) to inspect'),
        props: z.array(z.string()).optional().describe('Optional subset: geometry/style/text/contrast'),
        maxResults: z.number().int().optional().describe('Max elements (default 20)'),
        target: z
          .string()
          .optional()
          .describe('"self" = HoloGram webview 内直读（零 RPC）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('inspect', args),
    }),
    defineTool({
      name: 'browser_report',
      description:
        'Visual lint report on the attached page (or scope selector) — checks contrast (WCAG 4.5:1), spacing scale (4/8/12/16/24/32), ' +
        'alignment, hierarchy (overused shadows), overflow. Returns {issues:[{rule,severity,detail,selector}], ok}. ' +
        'Use AFTER modifying UI code to self-review the rendered result.',
      schema: z.object({
        scope: z.string().optional().describe('Optional CSS selector to limit the scan (default: whole page)'),
        target: z
          .string()
          .optional()
          .describe('"self" = HoloGram webview 内直读（零 RPC）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('report', args),
    }),
    defineTool({
      name: 'browser_click',
      description:
        'Click an element in the attached page by CSS selector (clicks center of element via CDP Input). ' +
        'Coordinates are computed internally — never pass raw coordinates.',
      schema: z.object({
        selector: z.string().describe('CSS selector of element to click'),
      }),
      execute: (args) => run('click', args),
    }),
    defineTool({
      name: 'browser_type',
      description:
        'Type text into a focused element in the attached page (focuses selector, then Input.insertText). ' +
        'Chinese/IME friendly.',
      schema: z.object({
        selector: z.string().describe('CSS selector of input/textarea/contenteditable to focus'),
        text: z.string().describe('Text to type'),
      }),
      execute: (args) => run('type', args),
    }),
    defineTool({
      name: 'browser_press',
      description:
        'Press a key in the attached page: Enter / Tab / Escape / Backspace / Arrow keys / single characters.',
      schema: z.object({
        key: z.string().describe('Key name (Enter/Tab/Escape/ArrowUp/ArrowDown/... or single char)'),
      }),
      execute: (args) => runBrowserAction('press', args),
    }),
    defineTool({
      name: 'browser_scroll',
      description:
        'Scroll the attached page: pass selector to scroll element into view, or direction (down/up/top) for page scroll.',
      schema: z.object({
        selector: z.string().optional().describe('Scroll this element into view'),
        direction: z.string().optional().describe('Page scroll direction: down/up/top'),
      }),
      execute: (args) => run('scroll', args),
    }),
    defineTool({
      name: 'browser_eval',
      description:
        'Execute a JS expression in the attached page (read-oriented; network/storage/window.open blocked by whitelist). ' +
        'Returns the value as JSON. Prefer browser_inspect for DOM reading.',
      schema: z.object({
        expr: z.string().describe('JS expression to evaluate'),
      }),
      execute: (args) => runBrowserAction('eval', args),
    }),
    defineTool({
      name: 'browser_status',
      description: 'Current browser session status — port, attached target, whether controlled Chrome is running.',
      schema: z.object({}),
      readOnly: true,
      execute: () => run('status', {}),
    }),
  ];
}
