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
// 默认实现 defaultDomProbe 在 UI 层（src/ui/dom-probe.ts）—
// agent 层禁止浏览器 API（agent-boundary 测试强制），
// 由 runtime-adapter 的 createBuilderDeps 注入。
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
        'Execute a JS expression in the attached page (read-oriented; network/storage/new-window calls blocked by whitelist). ' +
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
