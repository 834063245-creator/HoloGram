// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════
// Browser 工具 — Agent「观察/操作前端页面」能力
// ═══════════════════════════════════════════════════════════
// 目标：不止自家 webview，更主要是用户日常使用的其他软件前端
// （Chrome / Edge / Electron / 其他 WebView2 应用）。
//
// 双通道（ADR 0003 D4 统一后端后，全部走 Rust CDP）：
//   - target=self → Rust cdp 模块惰性 attach 自家 webview 调试端口（只读）
//   - target 省略  → 各 Agent 自己的 CDP 会话（已 attach 的外部页面）
//
// 交互范式（ADR 0003 D2/D5）：
//   - snapshot 拿可交互元素清单（含 ref 编号），click/type/scroll 按 ref 引用；
//     不要手写 CSS selector（ref 失效会报错并提示重新 snapshot）。
//   - 操作自带 actionability 等待与反馈（URL 变化 / DOM 变化 / 新增错误）。
//   - console/network 查询页面事件（改 UI 后自查报错和请求状态）。
//
// 借鉴 HanaAgent computer-use 设计：能力声明（描述里写清能做什么）、
// 结果截断（防上下文爆炸）、语义化（不给裸坐标）。

import { z } from 'zod';
import type { Tool } from '../tool';
import { agentInvoke } from '../tool';
import { defineTool } from './define-tool';

// ═══════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════

const MAX_RESULT_CHARS = 8000;

function truncate(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_RESULT_CHARS)}...[已截断，共 ${s.length} 字符]`;
}

/** 执行 browser 动作。self → webview 只读通道；外部 → 各 Agent CDP 会话。 */
async function runBrowserAction(action: string, args: Record<string, unknown>): Promise<string> {
  const nameMap: Record<string, string> = {
    launch: 'browser_launch',
    connect: 'browser_connect',
    discover: 'browser_discover',
    kill: 'browser_kill',
    targets: 'browser_targets',
    attach: 'browser_attach',
    new_tab: 'browser_new_tab',
    close_tab: 'browser_close_tab',
    navigate: 'browser_navigate',
    back: 'browser_back',
    forward: 'browser_forward',
    reload: 'browser_reload',
    inspect: 'browser_inspect',
    report: 'browser_report',
    snapshot: 'browser_snapshot',
    content: 'browser_content',
    console: 'browser_console',
    network: 'browser_network',
    screenshot: 'browser_screenshot',
    audit: 'browser_audit',
    click: 'browser_click',
    hover: 'browser_hover',
    type: 'browser_type',
    select: 'browser_select',
    upload: 'browser_upload',
    dialog: 'browser_dialog',
    press: 'browser_press',
    scroll: 'browser_scroll',
    eval: 'browser_eval',
    status: 'browser_status',
    wait: 'browser_wait',
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

export function createBrowserTools(): Tool[] {
  const run = (action: string, args: Record<string, unknown>) => runBrowserAction(action, args);

  return [
    defineTool({
      name: 'browser_launch',
      description:
        'Launch a controlled Chrome/Edge instance (isolated profile, never touches the user\'s daily browser data). ' +
        'Use before inspecting/operating external pages. Returns the debug port. ' +
        'If already running, reuses it. Pass url to open a specific page.',
      schema: z.object({
        url: z.string().optional().describe('Optional URL to open in the controlled browser'),
        port: z.number().int().optional().describe('Debug port (default: auto-probe from 9223; 9222 is reserved for HoloGram webview)'),
      }),
      execute: (args) => run('launch', args),
    }),
    defineTool({
      name: 'browser_connect',
      description:
        'Connect to a browser instance the USER has already started with a remote debugging port ' +
        '(Chrome/Edge launched with --remote-debugging-port=NNNN, or a Chromium-based app exposing one). ' +
        'If the user did not provide a port, call browser_discover first to list instances and let the user pick one. ' +
        'Takes over that live instance with its real logins and data — requires user approval. ' +
        'After connect: targets → attach → snapshot/click as usual. ' +
        'kill only disconnects (never kills a browser this agent did not launch). 9222 is refused (HoloGram webview, read-only self channel).',
      schema: z.object({
        port: z.number().int().describe('Debug port of the running browser instance (e.g. 9223)'),
      }),
      execute: (args) => run('connect', args),
    }),
    defineTool({
      name: 'browser_discover',
      description:
        'Discover Chromium-based instances on this machine that have a debug port open — ' +
        'queries the process table, so the USER does not need to know or report any port. ' +
        'Returns {instances:[{browser, port, pages:[{id,title,url}]}]}. ' +
        'Use BEFORE browser_connect when the user says "operate my browser" without a port: ' +
        'list the instances to the user, let them pick, then connect(port). ' +
        'HoloGram webview (9222) is filtered out.',
      schema: z.object({}),
      readOnly: true,
      execute: () => run('discover', {}),
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
      name: 'browser_kill',
      description:
        'Terminate the controlled Chrome instance launched by this agent (isolated profile). ' +
        'Only kills the Chrome this agent launched.',
      schema: z.object({}),
      execute: () => run('kill', {}),
    }),
    defineTool({
      name: 'browser_attach',
      description:
        'Attach to a specific page target (by id from browser_targets) so subsequent inspect/click/type/press/scroll/eval act on it. ' +
        'This is also how you switch between open tabs: pick another targetId from browser_targets and attach. ' +
        'This takes control of an external page — requires user approval. ' +
        'Note: targetId is the CDP target id; the "target" parameter (self vs external) is separate.',
      schema: z.object({
        targetId: z.string().describe('CDP target id from browser(targets) — not "self"'),
      }),
      execute: (args) => run('attach', args),
    }),
    defineTool({
      name: 'browser_new_tab',
      description:
        'Open a new tab in the current browser session and auto-attach to it. ' +
        'Pass url to open a page (default about:blank). Use browser_targets + browser_attach to switch tabs later.',
      schema: z.object({
        url: z.string().optional().describe('URL to open in the new tab (default about:blank)'),
      }),
      execute: (args) => run('new_tab', args),
    }),
    defineTool({
      name: 'browser_close_tab',
      description:
        'Close a browser tab by targetId (from browser_targets). If it is the currently attached tab, ' +
        'the session becomes unattached — list targets and attach another.',
      schema: z.object({
        targetId: z.string().describe('CDP target id of the tab to close'),
      }),
      execute: (args) => run('close_tab', args),
    }),
    defineTool({
      name: 'browser_navigate',
      description:
        'Navigate the attached page to a URL (Page.navigate). Returns world-change feedback after the navigation settles. ' +
        'Use for normal page navigation after attach.',
      schema: z.object({
        url: z.string().describe('URL to navigate to'),
      }),
      execute: (args) => run('navigate', args),
    }),
    defineTool({
      name: 'browser_back',
      description: 'Go back one entry in the attached page navigation history. Returns {navigated:"back", url, change}.',
      schema: z.object({}),
      execute: () => run('back', {}),
    }),
    defineTool({
      name: 'browser_forward',
      description: 'Go forward one entry in the attached page navigation history. Returns {navigated:"forward", url, change}.',
      schema: z.object({}),
      execute: () => run('forward', {}),
    }),
    defineTool({
      name: 'browser_reload',
      description: 'Reload the attached page (Page.reload). Returns {reloaded:true, url, change}.',
      schema: z.object({}),
      execute: () => run('reload', {}),
    }),
    defineTool({
      name: 'browser_snapshot',
      description:
        'Snapshot interactive elements on the attached page — returns {refs:[{ref,tag,type,text,id}], count, total, offset, truncated}. ' +
        'Marks elements with ref numbers; use these ref numbers in click/type/scroll (e.g. selector: "37"). ' +
        'Refs are valid until the DOM changes — if an operation fails with "target gone", re-snapshot. ' +
        'If truncated is true there are more elements below — call again with offset to page (e.g. offset: 80 for page 2, 160 for page 3). ' +
        'PREFERRED over hand-written CSS selectors.',
      schema: z.object({
        scope: z.string().optional().describe('Optional CSS selector to limit the snapshot (default: whole page)'),
        maxResults: z.number().int().optional().describe('Max elements per page (default 80)'),
        offset: z.number().int().optional().describe('Skip this many interactive elements (for paging; default 0)'),
        target: z
          .string()
          .optional()
          .describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('snapshot', args),
    }),
    defineTool({
      name: 'browser_content',
      description:
        'Extract page text content from the attached page — always returns {title, url, format}. ' +
        'format "text" (default) returns cleaned innerText; "markdown" returns a lightweight markdown conversion ' +
        '(headings/lists/links/images/tables). scope limits extraction to a CSS selector. ' +
        'Pagination is character-based: maxChars (default 8000, max 20000) + offset read the next window. ' +
        'Use instead of browser_eval(document.body.innerText) for readable page body.',
      schema: z.object({
        scope: z.string().optional().describe('Optional CSS selector to limit extraction (default: whole page)'),
        format: z.enum(['text', 'markdown']).optional().describe('Output format: text (default) or markdown'),
        maxChars: z.number().int().min(1).max(20000).optional().describe('Max content characters per page (default 8000)'),
        offset: z.number().int().min(0).optional().describe('Skip this many content characters (for paging; default 0)'),
        target: z
          .string()
          .optional()
          .describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('content', args),
    }),
    defineTool({
      name: 'browser_inspect',
      description:
        'Read element geometry/style/text/contrast from the attached page using a CSS selector (or snapshot ref number). ' +
        'Returns JSON array: {tag, id, rect{x,y,width,height}, visible, scrollable, style{color,background,fontSize,...}, text, contrast}. ' +
        'props: optional subset of ["geometry","style","text","contrast"]. maxResults caps elements (default 20). ' +
        'Use to verify visual details after UI changes.',
      schema: z.object({
        selector: z.string().describe('CSS selector (or ref number from snapshot) of element(s) to inspect'),
        props: z.array(z.string()).optional().describe('Optional subset: geometry/style/text/contrast'),
        maxResults: z.number().int().optional().describe('Max elements (default 20)'),
        target: z
          .string()
          .optional()
          .describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
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
          .describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('report', args),
    }),
    defineTool({
      name: 'browser_console',
      description:
        'Read recent page console events (console.log/error, exceptions, Log.entryAdded) from the attached page. ' +
        'Use after UI changes or operations to check for new errors. Returns {entries:[{type,text}]}.',
      schema: z.object({
        limit: z.number().int().optional().describe('Max entries (default 30)'),
        target: z
          .string()
          .optional()
          .describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('console', args),
    }),
    defineTool({
      name: 'browser_network',
      description:
        'Read recent network events (requests/responses/failures) from the attached page. ' +
        'Use to check whether a request failed or which endpoint returned an error. Returns {entries:[{method,url,status}]}.',
      schema: z.object({
        limit: z.number().int().optional().describe('Max entries (default 30)'),
        target: z
          .string()
          .optional()
          .describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('network', args),
    }),
    defineTool({
      name: 'browser_click',
      description:
        'Click an element in the attached page by snapshot ref number (e.g. selector: "37") or CSS selector. ' +
        'Waits for the element to be actionable (visible/unobscured/stable) before clicking. ' +
        'Returns world-change feedback (URL/DOM changes, new errors). ' +
        'Sensitive targets (submit buttons, download links, confirm/pay/delete text) trigger a separate approval.',
      schema: z.object({
        selector: z.string().describe('Ref number from snapshot or CSS selector of element to click'),
      }),
      execute: (args) => run('click', args),
    }),
    defineTool({
      name: 'browser_hover',
      description:
        'Hover the mouse over an element in the attached page by ref number or CSS selector. ' +
        'Waits for the element to be actionable, then moves the mouse to its center (for hover menus/tooltips/:hover styles).',
      schema: z.object({
        selector: z.string().describe('Ref number from snapshot or CSS selector of element to hover'),
      }),
      execute: (args) => run('hover', args),
    }),
    defineTool({
      name: 'browser_type',
      description:
        'Type text into an input in the attached page by snapshot ref number (e.g. selector: "37") or CSS selector. ' +
        'Focuses the element then inserts text (Chinese/IME friendly). ' +
        'Set replace:true to clear the existing value first (dispatches input/change events). ' +
        'Typing into a pre-filled input or password field triggers a separate approval.',
      schema: z.object({
        selector: z.string().describe('Ref number from snapshot or CSS selector of input/textarea/contenteditable to focus'),
        text: z.string().describe('Text to type'),
        replace: z.boolean().optional().describe('Replace existing value before typing (clears then dispatches input/change events)'),
      }),
      execute: (args) => run('type', args),
    }),
    defineTool({
      name: 'browser_select',
      description:
        'Select an <option> in a <select> element on the attached page by ref number or CSS selector. ' +
        'value matches option value first, then visible option text. Dispatches input/change events. ' +
        'Returns {selected, value, change}.',
      schema: z.object({
        selector: z.string().describe('Ref number from snapshot or CSS selector of the <select> element'),
        value: z.string().describe('Option value (preferred) or visible option text'),
      }),
      execute: (args) => run('select', args),
    }),
    defineTool({
      name: 'browser_upload',
      description:
        'Set files on an <input type=file> in the attached page. ' +
        'If a file chooser was recently opened, its intercepted backend node is used; otherwise pass a CSS selector (or ref) to the input. ' +
        'files are local absolute paths.',
      schema: z.object({
        files: z.array(z.string()).describe('Absolute local file paths to set'),
        selector: z.string().optional().describe('CSS selector (or ref) of the file input, required if no recent file chooser event'),
      }),
      execute: (args) => run('upload', args),
    }),
    defineTool({
      name: 'browser_dialog',
      description:
        'Inspect or handle a JavaScript dialog (alert/confirm/prompt) on the attached page. ' +
        'Call without accept to query recent dialogs and whether one is pending. ' +
        'Call with accept:true to accept, accept:false to dismiss; promptText answers a prompt.',
      schema: z.object({
        accept: z.boolean().optional().describe('Omit to query pending dialogs; true = accept, false = dismiss'),
        promptText: z.string().optional().describe('Text to enter for a prompt dialog'),
        limit: z.number().int().optional().describe('Max dialog entries when querying (default 10)'),
      }),
      execute: (args) => run('dialog', args),
    }),
    defineTool({
      name: 'browser_press',
      description:
        'Press a key in the attached page: Enter / Tab / Escape / Backspace / Arrow keys / single characters.',
      schema: z.object({
        key: z.string().describe('Key name (Enter/Tab/Escape/ArrowUp/ArrowDown/... or single char)'),
        modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Modifier keys held during the press (e.g. ["ctrl"] + key "a" = Ctrl+A)'),
      }),
      execute: (args) => run('press', args),
    }),
    defineTool({
      name: 'browser_scroll',
      description:
        'Scroll the attached page: pass selector (ref number or CSS selector) to scroll element into view, or direction (down/up/top) for page scroll.',
      schema: z.object({
        selector: z.string().optional().describe('Ref number or CSS selector to scroll into view'),
        direction: z.string().optional().describe('Page scroll direction: down/up/top'),
      }),
      execute: (args) => run('scroll', args),
    }),
    defineTool({
      name: 'browser_wait',
      description:
        'Wait — either wait a fixed number of ms, or wait until a CSS selector appears and is visible (default 10s timeout). ' +
        'Use after clicking an async-triggering button when the result takes a moment to load. ' +
        'Pass ms for a fixed sleep; pass selector to poll for it to become visible. ' +
        'Returns {found, selector?, waited_ms}. Does not change state.',
      schema: z.object({
        selector: z.string().optional().describe('CSS selector to wait for (appears + visible)'),
        ms: z.number().int().optional().describe('Fixed sleep in milliseconds (capped at 30000)'),
      }),
      readOnly: true,
      execute: (args) => run('wait', args),
    }),
    defineTool({
      name: 'browser_eval',
      description:
        'Execute a JS expression in the attached page (read-oriented; network/storage/new-window calls blocked by whitelist). ' +
        'Returns the value as JSON. Prefer browser_inspect for DOM reading.',
      schema: z.object({
        expr: z.string().describe('JS expression to evaluate'),
      }),
      execute: (args) => run('eval', args),
    }),
    defineTool({
      name: 'browser_screenshot',
      description:
        'Capture a screenshot of the attached page — saved to a temp file, returns {path, bytes}. ' +
        'With a text-only model the image content is not visible; hand the path to the user for confirmation.',
      schema: z.object({
        fullPage: z.boolean().optional().describe('Capture beyond the viewport (full scrollable page, default false)'),
        inline: z.boolean().optional().describe('Return a base64 data URL directly when <= 3MB (default false)'),
        target: z
          .string()
          .optional()
          .describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('screenshot', args),
    }),
    defineTool({
      name: 'browser_audit',
      description:
        'Read the browser operation audit log — which agent did what (click/type/launch/attach), when, and the outcome. ' +
        'Use to review what the Agent has done in the browser.',
      schema: z.object({
        limit: z.number().int().optional().describe('Max entries (default 50)'),
      }),
      readOnly: true,
      execute: (args) => run('audit', args),
    }),
    defineTool({
      name: 'browser_status',
      description: 'Current browser session status — port, attached target, controlled Chrome running, observer alive, pending dialog/file chooser.',
      schema: z.object({}),
      readOnly: true,
      execute: () => run('status', {}),
    }),
  ];
}

// ═══════════════════════════════════════════════════════════
// Desktop 领域（只读进程/窗口/控制台可见性快照）
// ═══════════════════════════════════════════════════════════
// 与 CDP 刻意不同：不连浏览器、不做持续 observer、不订阅事件。
// 按需取一帧快照，用于定位「某进程带了可见控制台窗口」这类问题
// （如语言服务器启动弹 cmd 窗口）。probe 只读放行；screenshot 高隐私面，
// 需单独权限确认（Rust rpc 层 DesktopTool 强制 Ask）。

const DESKTOP_ACTION_MAP: Record<string, string> = {
  probe: 'desktop_probe',
  screenshot: 'desktop_screenshot',
};

async function runDesktopAction(action: string, args: Record<string, unknown>): Promise<string> {
  const cmd = DESKTOP_ACTION_MAP[action];
  if (!cmd) return '[desktop] unsupported action "' + action + '"';
  try {
    const result = await agentInvoke<string>(cmd, { ...args, isAgent: true });
    return truncate(result ?? '');
  } catch (e: any) {
    return '[desktop] ' + action + ' 失败: ' + (e?.message || String(e));
  }
}

export function createDesktopTools(): Tool[] {
  const run = (action: string, args: Record<string, unknown>) => runDesktopAction(action, args);
  return [
    defineTool({
      name: 'desktop_probe',
      description:
        'Snapshot current machine process tree + top-level windows + visible console windows (read-only, one-shot). ' +
        'Returns {processes:[{pid,ppid,name,is_chromium}], windows:[{pid,name,title,visible}], visible_console_windows, process_count, window_count}. ' +
        'Use to detect whether a process has a visible console window (e.g. a language server spawning a cmd window), ' +
        'or to see what desktop windows are currently open. No persistent monitoring; purely a point-in-time query. ' +
        'Privacy: only process names are returned (not full command lines); no cross-session/RDP probing.',
      schema: z.object({}),
      readOnly: true,
      execute: () => run('probe', {}),
    }),
    defineTool({
      name: 'desktop_screenshot',
      description:
        'Capture a full-screen screenshot of the current desktop (requires an interactive desktop session). ' +
        'Saved to a temp file; returns {path, bytes, note}. High-privacy: may contain arbitrary on-screen content, ' +
        'so this requires a separate approval. With a text-only model the image is not visible; hand the path to the user for confirmation.',
      schema: z.object({}),
      readOnly: true,
      execute: () => run('screenshot', {}),
    }),
  ];
}
