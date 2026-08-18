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
import { parseStructuredError } from './structured-error';

// ═══════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════

const MAX_RESULT_CHARS = 8000;

/** 截断提示的可选定制：只对支持分页/收窄参数的动作提示对应参数，避免误导。 */
function truncate(s: string, pageHint?: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  const hint = pageHint ?? '用 offset/maxResults/limit 参数翻页或收窄目标获取更多';
  return `${s.slice(0, MAX_RESULT_CHARS)}\n...[已截断，共 ${s.length} 字符；${hint}]`;
}

/**
 * 解析 Rust 侧结构化错误：`[CODE] message` → `{ code, message }`。
 * 无前缀（旧错误/权限引擎错误）返回 null，调用方回退原文。
 * （2026-08 泛化到 structured-error.ts，browser/desktop 共用；此别名防破坏既有导入。）
 */
export const parseBrowserError = parseStructuredError;

/** 执行 browser 动作。self → webview 只读通道；外部 → 各 Agent CDP 会话。 */
async function runBrowserAction(action: string, args: Record<string, unknown>): Promise<string> {
  const nameMap: Record<string, string> = {
    launch: 'browser_launch',
    connect: 'browser_connect',
    discover: 'browser_discover',
    kill: 'browser_kill',
    sessions: 'browser_sessions',
    switch_session: 'browser_switch_session',
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
    network_detail: 'browser_network_detail',
    network_har: 'browser_network_har',
    screenshot: 'browser_screenshot',
    audit: 'browser_audit',
    cookies: 'browser_cookies',
    click: 'browser_click',
    hover: 'browser_hover',
    type: 'browser_type',
    select: 'browser_select',
    upload: 'browser_upload',
    dialog: 'browser_dialog',
    press: 'browser_press',
    scroll: 'browser_scroll',
    viewport: 'browser_viewport',
    eval: 'browser_eval',
    status: 'browser_status',
    wait: 'browser_wait',
  };
  const cmd = nameMap[action];
  if (!cmd) return `[browser] unsupported action "${action}"`;
  const pageHint =
    action === 'snapshot'
      ? '用 snapshot 的 offset/maxResults 翻页，或 scope 收窄范围'
      : action === 'content'
        ? '用 content 的 offset/maxChars 翻页'
        : undefined;
  try {
    const result = await agentInvoke<string>(cmd, args);
    return truncate(result ?? '', pageHint);
  } catch (e: any) {
    const raw = e?.message || String(e);
    const parsed = parseBrowserError(raw);
    // 结构化错误：模型读人话 message，code 保留在方括号内供测试/路由。
    return parsed ? `[browser] ${action} 失败 [${parsed.code}]: ${parsed.message}` : `[browser] ${action} 失败: ${raw}`;
  }
}

export function createBrowserTools(): Tool[] {
  const run = (action: string, args: Record<string, unknown>) => runBrowserAction(action, args);

  return [
    defineTool({
      name: 'browser_launch',
      description:
        "Launch a controlled Chrome/Edge instance (isolated profile, never touches the user's daily browser data). " +
        'Use before inspecting/operating external pages. Returns the debug port. ' +
        'If already running with the same launch shape, reuses it; changing port/headless/windowSize/profile/proxy restarts with the new shape. ' +
        'Pass url to open a specific page. headless mode runs with no visible UI. ' +
        'profile is a NAMED persistent profile (e.g. "work" or "personal"): each name is an isolated account session with its own cookies/logins, ' +
        'kept across kill/relaunch, and switchable with browser_switch_session. Omit profile for the default temporary profile that is deleted on kill. ' +
        'proxy uses Chrome --proxy-server (e.g. "socks5://127.0.0.1:1080"); proxyBypass sets --proxy-bypass-list.',
      schema: z.object({
        url: z.string().optional().describe('Optional URL to open in the controlled browser'),
        port: z
          .number()
          .int()
          .optional()
          .describe('Debug port (default: auto-probe from 9223; 9222 is reserved for HoloGram webview)'),
        headless: z.boolean().optional().describe('Run Chrome without a visible window (default false)'),
        windowSize: z
          .object({
            width: z.number().int().min(1).max(16384).describe('Window width in pixels'),
            height: z.number().int().min(1).max(16384).describe('Window height in pixels'),
          })
          .optional()
          .describe('Launch window size (--window-size=width,height)'),
        profile: z
          .string()
          .max(48)
          .optional()
          .describe('Named persistent account profile/session slot (e.g. "work"); omit for temporary default profile'),
        proxy: z.string().optional().describe('Chrome --proxy-server value (e.g. "socks5://127.0.0.1:1080")'),
        proxyBypass: z.string().optional().describe('Chrome --proxy-bypass-list value (e.g. "localhost;127.0.0.1")'),
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
        'session optionally registers the external instance as a named account slot for browser_switch_session. ' +
        'kill only disconnects (never kills a browser this agent did not launch). 9222 is refused (HoloGram webview, read-only self channel).',
      schema: z.object({
        port: z.number().int().describe('Debug port of the running browser instance (e.g. 9223)'),
        session: z
          .string()
          .max(48)
          .optional()
          .describe('Optional account slot name to register this instance under (default: default)'),
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
        'Terminate the controlled Chrome instance launched by this agent in the ACTIVE account session. ' +
        'Only kills the Chrome this agent launched. Named profile directories are kept so the login state can be relaunched/restored.',
      schema: z.object({}),
      execute: () => run('kill', {}),
    }),
    defineTool({
      name: 'browser_sessions',
      description:
        "List this agent's browser account sessions (slots) and which one is active. " +
        'Each named profile launched with browser_launch(profile:...) is an isolated account session with its own cookies/logins. ' +
        'Returns {active, sessions:[{slot,active,port,chromeRunning,external,attached,headless,windowSize,proxy}]}.',
      schema: z.object({}),
      readOnly: true,
      execute: () => run('sessions', {}),
    }),
    defineTool({
      name: 'browser_switch_session',
      description:
        'Switch the active browser account session by slot name (the profile name passed to browser_launch, or session passed to browser_connect). ' +
        'The previous session keeps running with its own cookies/logins; switch back to resume it. ' +
        'Use browser_sessions to see available slots first. To create a new account session use browser_launch(profile: "name").',
      schema: z.object({
        session: z.string().max(48).describe('Account session slot name to activate'),
      }),
      execute: (args) => run('switch_session', args),
    }),
    defineTool({
      name: 'browser_cookies',
      description:
        'Inspect or modify cookies in the active browser session. ' +
        'list: read cookies (all, or filtered by urls). set: write one cookie (url or domain required). ' +
        'delete: remove one cookie (name + url/domain required). ' +
        'Cookie values are truncated to 300 chars in list output; writing/deleting cookies changes login state and requires approval.',
      schema: z.object({
        op: z.enum(['list', 'set', 'delete']).describe('Cookie operation'),
        urls: z
          .array(z.string())
          .optional()
          .describe('list: only return cookies for these URLs (default all cookies in this browser context)'),
        url: z.string().optional().describe('set/delete: cookie URL (either url or domain is required)'),
        name: z.string().optional().describe('set/delete: cookie name'),
        value: z.string().optional().describe('set: cookie value'),
        domain: z.string().optional().describe('set/delete: cookie domain (either url or domain is required)'),
        path: z.string().optional().describe('set/delete: cookie path (default /)'),
        httpOnly: z.boolean().optional().describe('set: HttpOnly flag'),
        secure: z.boolean().optional().describe('set: Secure flag'),
        sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('set: SameSite restriction'),
        expires: z.number().optional().describe('set: expiration time in Unix seconds (default session cookie)'),
      }),
      execute: (args) => run('cookies', args),
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
      description:
        'Go back one entry in the attached page navigation history. Returns {navigated:"back", url, change}.',
      schema: z.object({}),
      execute: () => run('back', {}),
    }),
    defineTool({
      name: 'browser_forward',
      description:
        'Go forward one entry in the attached page navigation history. Returns {navigated:"forward", url, change}.',
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
        'Snapshot interactive elements on the attached page — returns {source, refs:[{ref,tag,role,name,text,type?,id?}], count, total, offset, truncated}. ' +
        'Prefers Chrome Accessibility.getFullAXTree (source:"ax"); falls back to an enhanced DOM probe that traverses same-origin iframes and shadow DOM ' +
        'and computes accessible names (aria-label/labelledby/label/alt/title/placeholder). ' +
        'Marks elements with ref numbers; use these ref numbers in click/type/select/hover/scroll (e.g. selector: "37"). ' +
        'Refs are valid until the DOM changes — if an operation fails with "target gone", re-snapshot. ' +
        'If truncated is true there are more elements below — call again with offset to page (e.g. offset: 80 for page 2, 160 for page 3). ' +
        'PREFERRED over hand-written CSS selectors.',
      schema: z.object({
        scope: z.string().optional().describe('Optional CSS selector to limit the snapshot (default: whole page)'),
        maxResults: z.number().int().optional().describe('Max elements per page (default 80)'),
        offset: z.number().int().optional().describe('Skip this many interactive elements (for paging; default 0)'),
        target: z.string().optional().describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
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
        'Pagination is character-based: maxChars (default 8000, max 20000) + offset reads the next chunk. ' +
        'Use instead of browser_eval for readable page body.',
      schema: z.object({
        scope: z.string().optional().describe('Optional CSS selector to limit extraction (default: whole page)'),
        format: z.enum(['text', 'markdown']).optional().describe('Output format: text (default) or markdown'),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(20000)
          .optional()
          .describe('Max content characters per page (default 8000)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Skip this many content characters (for paging; default 0)'),
        target: z.string().optional().describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
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
        target: z.string().optional().describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
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
        target: z.string().optional().describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
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
        target: z.string().optional().describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('console', args),
    }),
    defineTool({
      name: 'browser_network',
      description:
        'Read recent network events (requests/responses/failures) from the attached page. ' +
        'Requests and responses are paired by requestId: one entry has method/url/status/mimeType/error, ' +
        'with status null while pending and error set on load failure. ' +
        'Returns {entries:[{requestId,method,url,status,mimeType,resourceType,error}], paired:true}.',
      schema: z.object({
        limit: z.number().int().optional().describe('Max entries (default 30)'),
        target: z.string().optional().describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('network', args),
    }),
    defineTool({
      name: 'browser_network_detail',
      description:
        'Read full detail for one observed network request by requestId (from browser_network): ' +
        'complete URL, method, status/statusText/mimeType, request+response headers, postData (capped), error. ' +
        'Only requests still inside the 200-entry event buffer are available. HAR export is not implemented yet.',
      schema: z.object({
        requestId: z.string().describe('requestId from browser(network) entries'),
        target: z.string().optional().describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('network_detail', args),
    }),
    defineTool({
      name: 'browser_network_har',
      description:
        'Export recently observed network events from the attached page to a HAR 1.2 file in the temp directory. ' +
        'Returns {path, bytes, entries}. Includes URL, request/response headers, queryString, postData, status and mimeType; ' +
        'timing fields are -1 because the event observer does not sample timings. ' +
        'Use fs(read) or hand the path to the user when a full request archive is needed.',
      schema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max entries to export (default 100; max 200)'),
        target: z.string().optional().describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
      }),
      readOnly: true,
      execute: (args) => run('network_har', args),
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
        selector: z
          .string()
          .describe('Ref number from snapshot or CSS selector of input/textarea/contenteditable to focus'),
        text: z.string().describe('Text to type'),
        replace: z
          .boolean()
          .optional()
          .describe('Replace existing value before typing (clears then dispatches input/change events)'),
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
        selector: z
          .string()
          .optional()
          .describe('CSS selector (or ref) of the file input, required if no recent file chooser event'),
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
        modifiers: z
          .array(z.enum(['ctrl', 'alt', 'shift', 'meta']))
          .optional()
          .describe('Modifier keys held during the press (e.g. ["ctrl"] + key "a" = Ctrl+A)'),
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
      name: 'browser_viewport',
      description:
        'Set viewport metrics on the attached page via Emulation.setDeviceMetricsOverride: width/height in CSS px, ' +
        'deviceScaleFactor (0.5-3, default 1) and mobile emulation flag (default false). ' +
        'This is the CDP viewport override, separate from browser_launch windowSize (the physical window).',
      schema: z.object({
        width: z.number().int().min(1).max(16384).describe('Viewport width in CSS pixels'),
        height: z.number().int().min(1).max(16384).describe('Viewport height in CSS pixels'),
        deviceScaleFactor: z.number().min(0.5).max(3).optional().describe('Device pixel ratio (default 1)'),
        mobile: z.boolean().optional().describe('Emulate a mobile viewport (default false)'),
      }),
      execute: (args) => run('viewport', args),
    }),
    defineTool({
      name: 'browser_fill',
      description:
        'Fill MULTIPLE inputs in one round on the attached page — fields: [{selector, text, replace?}]. ' +
        'Each field follows browser_type semantics (ref number or CSS selector; replace clears first). ' +
        'Returns per-field outcome. Use for forms/logins to save round-trips; ' +
        'each field still honors sensitive-input approval (pre-filled/password fields ask separately).',
      schema: z.object({
        fields: z
          .array(
            z.object({
              selector: z.string().describe('Ref number from snapshot or CSS selector of the input'),
              text: z.string().describe('Text to type'),
              replace: z.boolean().optional().describe('Replace existing value first (default false)'),
            }),
          )
          .min(1)
          .max(20)
          .describe('Fields to fill, in order'),
      }),
      execute: async (a) => {
        const results: string[] = [];
        for (const f of a.fields) {
          const r = await runBrowserAction('type', { selector: f.selector, text: f.text, replace: f.replace });
          results.push(`[${f.selector}] ${r}`);
        }
        return `browser_fill 完成 ${a.fields.length} 个字段：\n${results.join('\n')}\n提示：用 browser_snapshot 复核表单状态。`;
      },
    }),
    defineTool({
      name: 'browser_navigate_snapshot',
      description:
        'Navigate the attached page to a URL and return the interactive-element snapshot of the resulting page in ONE round ' +
        '(navigate settles → snapshot). Equivalent to browser_navigate followed by browser_snapshot, saving a turn. ' +
        'Returns navigation feedback (URL/DOM changes) plus the ref list to act on.',
      schema: z.object({
        url: z.string().describe('URL to navigate to'),
        maxResults: z.number().int().optional().describe('Max elements in the snapshot (default 80)'),
      }),
      execute: async (a) => {
        const nav = await runBrowserAction('navigate', { url: a.url });
        const snap = await runBrowserAction('snapshot', { maxResults: a.maxResults });
        return `== navigation ==\n${nav}\n\n== snapshot ==\n${snap}`;
      },
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
        target: z.string().optional().describe('"self" = HoloGram webview（只读）；省略 = 已 attach 的外部页面'),
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
      description:
        'Current browser session status — port, attached target, controlled Chrome running, observer alive, pending dialog/file chooser.',
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
  uia_tree: 'desktop_uia_tree',
  uia_find: 'desktop_uia_find',
  uia_read: 'desktop_uia_read',
  uia_wait: 'desktop_uia_wait',
  uia_click: 'desktop_uia_click',
  uia_right_click: 'desktop_uia_right_click',
  uia_type: 'desktop_uia_type',
  uia_select: 'desktop_uia_select',
  uia_expand: 'desktop_uia_expand',
  uia_scroll: 'desktop_uia_scroll',
  uia_keys: 'desktop_uia_keys',
  uia_activate: 'desktop_uia_activate',
  uia_window_shot: 'desktop_uia_window_shot',
  audit: 'desktop_audit',
  status: 'desktop_status',
};

async function runDesktopAction(action: string, args: Record<string, unknown>): Promise<string> {
  const cmd = DESKTOP_ACTION_MAP[action];
  if (!cmd) return '[desktop] unsupported action "' + action + '"';
  const pageHint =
    action === 'uia_tree' ? '用 uia_tree 的 offset/max_results 翻页、depth 限层或 name 查找收窄' : undefined;
  try {
    const result = await agentInvoke<string>(cmd, { ...args, isAgent: true });
    return truncate(result ?? '', pageHint);
  } catch (e: any) {
    const raw = e?.message || String(e);
    const parsed = parseBrowserError(raw);
    return parsed
      ? `[desktop] ${action} 失败 [${parsed.code}]: ${parsed.message}`
      : '[desktop] ' + action + ' 失败: ' + raw;
  }
}

export function createDesktopTools(): Tool[] {
  const run = (action: string, args: Record<string, unknown>) => runDesktopAction(action, args);
  return [
    defineTool({
      name: 'desktop_probe',
      description:
        'Snapshot current machine process tree + top-level windows + visible console windows, WITH per-window channel routing advice ' +
        '(route.channel: "cdp" for Chromium windows → browser tools; "uia" for standard-control windows → desktop_uia_*; "vision" for self-drawn apps → uia_window_shot + multimodal). ' +
        'Returns {processes:[{pid,ppid,name,is_chromium}], windows:[{pid,name,title,visible,hwnd,route}], visible_console_windows}. ' +
        'route:false param skips UIA probing for a faster bare snapshot. ' +
        'Use to find which window to operate and HOW to operate it. Read-only; no persistent monitoring. ' +
        'Privacy: only process names (not full command lines); no cross-session/RDP probing.',
      schema: z.object({
        route: z
          .boolean()
          .optional()
          .describe('Attach per-window channel routing advice (default true); false = bare snapshot, faster'),
      }),
      readOnly: true,
      execute: (a) => run('probe', a),
    }),
    defineTool({
      name: 'desktop_screenshot',
      description:
        'Capture a full-screen screenshot of the current desktop (requires an interactive desktop session). ' +
        'Saved to a temp file; returns {path, bytes, note}. High-privacy: may contain arbitrary on-screen content, ' +
        'so this asks for approval EVERY time. With a text-only model the image is not visible; hand the path to the user for confirmation.',
      schema: z.object({}),
      readOnly: true,
      execute: () => run('screenshot', {}),
    }),
    defineTool({
      name: 'desktop_uia_tree',
      description:
        'Read the Windows UI Automation control tree of a desktop window — interactive controls only by default (buttons, inputs, lists, menus...), paginated. ' +
        'Returns {window:{pid,title,hwnd}, refs, generation, total, offset, count, truncated, tree:"[ref] Type \\"Name\\"", controls:[{ref,name,type,automation_id,enabled,rect,depth}]}. ' +
        'Locate the window by ONE of: hwnd (exact, from desktop_probe), pid, title (fuzzy), or omit all for the foreground window. ' +
        'all:true includes non-interactive layout elements; depth:N limits tree levels; offset/max_results paginate (default 80/page). ' +
        'refs index the FULL tree and stay reusable across actions and pages; if the window changed and a ref went stale, the action auto-refreshes once — ' +
        'only re-read the tree when that fails. Reading never touches focus or cursor. ' +
        'Self-drawn controls (WeChat/QQ/DingTalk etc.) expose an empty tree — use desktop_uia_window_shot + a vision model instead.',
      schema: z.object({
        hwnd: z.number().int().optional().describe('Window handle from desktop_probe (hwnd field)'),
        pid: z.number().int().optional().describe('Process id - resolves to its main window'),
        title: z.string().optional().describe('Window title substring (fuzzy, first match)'),
        depth: z.number().int().optional().describe('Limit tree to N levels (real hierarchy with indentation)'),
        all: z
          .boolean()
          .optional()
          .describe('Include non-interactive layout elements (default false = interactive only)'),
        offset: z.number().int().optional().describe('Skip this many listed controls (for paging; default 0)'),
        max_results: z.number().int().optional().describe('Max controls per page (default 80)'),
      }),
      readOnly: true,
      execute: (a) => run('uia_tree', a),
    }),
    defineTool({
      name: 'desktop_uia_find',
      description:
        'Find controls inside a desktop window by criteria (name fuzzy / control_type / automation_id / enabled). ' +
        'Interactive controls only by default (all:true for everything). Returns matching controls with their refs for later actions. ' +
        'Use instead of a full tree when you already know what kind of control you need — cheaper than uia_tree.',
      schema: z.object({
        hwnd: z.number().int().optional().describe('Window handle from desktop_probe'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
        name: z.string().optional().describe('Control name substring (case-insensitive)'),
        control_type: z.string().optional().describe('e.g. Button, Edit, ListItem, MenuItem, CheckBox'),
        automation_id: z.string().optional().describe('Exact automation id'),
        enabled: z.boolean().optional().describe('Filter by enabled state'),
        all: z.boolean().optional().describe('Include non-interactive elements (default false)'),
      }),
      readOnly: true,
      execute: (a) => run('uia_find', a),
    }),
    defineTool({
      name: 'desktop_uia_read',
      description:
        'Read full detail of ONE control: value (password-masked), toggle state, expand state, scroll percents, rect, and the list of patterns it supports. ' +
        'Use after an action to verify the result (feedback loop), or before acting to see which patterns are available. ' +
        'Locate by ref or selector, same as the action tools. Read-only.',
      schema: z.object({
        ref: z.number().int().optional().describe('Control ref from desktop_uia_tree/find'),
        name: z.string().optional().describe('Control name, exact match case-insensitive'),
        automation_id: z.string().optional().describe('Exact automation id'),
        control_type: z.string().optional().describe('ControlType, e.g. Button, Edit'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      readOnly: true,
      execute: async (a) => {
        if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
          return '[desktop_uia_read] 至少要给一个定位条件: ref / name / automation_id / control_type';
        }
        return run('uia_read', a);
      },
    }),
    defineTool({
      name: 'desktop_uia_wait',
      description:
        'Wait until a control satisfies a condition: until "exists" (appears), "enabled", or "value" (equals the given value). ' +
        'Polls every 150ms up to timeout_ms (default 10000, max 30000). Returns {found, until, waited_ms} — found:false on timeout is NOT an error. ' +
        'Use after clicking async-triggering buttons (e.g. dialogs that take a moment).',
      schema: z.object({
        until: z.enum(['exists', 'enabled', 'value']).describe('Condition to wait for'),
        value: z.string().optional().describe('Expected value (required when until=value)'),
        timeout_ms: z.number().int().optional().describe('Max wait in ms (default 10000, max 30000)'),
        ref: z.number().int().optional().describe('Control ref from desktop_uia_tree/find'),
        name: z.string().optional().describe('Control name, exact match case-insensitive'),
        automation_id: z.string().optional().describe('Exact automation id'),
        control_type: z.string().optional().describe('ControlType'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      readOnly: true,
      execute: async (a) => {
        if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
          return '[desktop_uia_wait] 至少要给一个定位条件: ref / name / automation_id / control_type';
        }
        return run('uia_wait', a);
      },
    }),
    defineTool({
      name: 'desktop_uia_click',
      description:
        'Click a control in a desktop window. Locate by EITHER ref (from desktop_uia_tree/find) OR selector: name/automation_id/control_type - any combination. ' +
        'Triggers via InvokePattern/TogglePattern/SelectionItemPattern when available (no focus stealing), else real coordinate click (physical input). ' +
        'Returns world-change feedback: {done, method, target, changed:{window_title/focused/value/toggle before→after}, hint}. ' +
        'Permissions: first write into a window asks once (window takeover); sensitive targets (submit/pay/delete/confirm text) and coordinate clicks ask separately every time. ' +
        'Check "changed" to verify the click did what you expected; use desktop_uia_read/wait to double-check.',
      schema: z.object({
        ref: z
          .number()
          .int()
          .optional()
          .describe('Control ref from desktop_uia_tree/find (use instead of name/automation_id/control_type)'),
        name: z.string().optional().describe('Control name, exact match case-insensitive (e.g. "Equals", "Seven")'),
        automation_id: z.string().optional().describe('Exact automation id (e.g. "equalButton", "num7Button")'),
        control_type: z.string().optional().describe('ControlType, e.g. Button, Edit, ListItem, MenuItem, CheckBox'),
        hwnd: z.number().int().optional().describe('Window handle (re-locate if tree changed)'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: async (a) => {
        if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
          return '[desktop_uia_click] 至少要给一个定位条件: ref / name / automation_id / control_type';
        }
        return run('uia_click', a);
      },
    }),
    defineTool({
      name: 'desktop_uia_right_click',
      description:
        'Right-click a control — opens the context menu at the control center. Pure physical input (no UIA pattern for right-click), always asks. ' +
        'Locate by ref or selector (see desktop_uia_click). After the menu opens, read it with desktop_uia_tree and click items by ref.',
      schema: z.object({
        ref: z.number().int().optional().describe('Control ref from desktop_uia_tree/find'),
        name: z.string().optional().describe('Control name, exact match case-insensitive'),
        automation_id: z.string().optional().describe('Exact automation id'),
        control_type: z.string().optional().describe('ControlType, e.g. Button, Edit, ListItem'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: async (a) => {
        if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
          return '[desktop_uia_right_click] 至少要给一个定位条件: ref / name / automation_id / control_type';
        }
        return run('uia_right_click', a);
      },
    }),
    defineTool({
      name: 'desktop_uia_type',
      description:
        'Type text into a control. ValuePattern.SetValue when supported (instant, no focus), else focus + clipboard paste (physical input, asks separately). ' +
        'Returns world-change feedback incl. value before→after (password fields masked). ' +
        'Typing into a pre-filled input or a password field is classified sensitive and asks separately.',
      schema: z.object({
        ref: z.number().int().optional().describe('Control ref (usually an Edit/ComboBox)'),
        text: z.string().describe('Text to type'),
        name: z.string().optional().describe('Control name, exact match case-insensitive'),
        automation_id: z.string().optional().describe('Exact automation id'),
        control_type: z.string().optional().describe('ControlType, e.g. Edit, ComboBox'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: async (a) => {
        if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
          return '[desktop_uia_type] 至少要给一个定位条件: ref / name / automation_id / control_type';
        }
        return run('uia_type', a);
      },
    }),
    defineTool({
      name: 'desktop_uia_select',
      description:
        'Explicitly select a list item / tree item / tab (SelectionItemPattern.Select). Cleaner than clicking list entries — ' +
        'use for ListItems, TreeItems, TabItems, radio-like items. Returns world-change feedback.',
      schema: z.object({
        ref: z.number().int().optional().describe('Control ref (the ListItem/TreeItem/TabItem to select)'),
        name: z.string().optional().describe('Item name, exact match case-insensitive'),
        automation_id: z.string().optional().describe('Exact automation id'),
        control_type: z.string().optional().describe('ControlType: ListItem, TreeItem, TabItem...'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: async (a) => {
        if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
          return '[desktop_uia_select] 至少要给一个定位条件: ref / name / automation_id / control_type';
        }
        return run('uia_select', a);
      },
    }),
    defineTool({
      name: 'desktop_uia_expand',
      description:
        'Expand/collapse a ComboBox dropdown or tree node (ExpandCollapsePattern, idempotent toggle: expanded→collapse, collapsed→expand). ' +
        'After expanding a combo, read the item list with desktop_uia_tree/find and select with desktop_uia_select. ' +
        'Returns world-change feedback incl. expand state before→after.',
      schema: z.object({
        ref: z.number().int().optional().describe('Control ref (the ComboBox/TreeItem to toggle)'),
        name: z.string().optional().describe('Control name, exact match case-insensitive'),
        automation_id: z.string().optional().describe('Exact automation id'),
        control_type: z.string().optional().describe('ControlType: ComboBox, TreeItem...'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: async (a) => {
        if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
          return '[desktop_uia_expand] 至少要给一个定位条件: ref / name / automation_id / control_type';
        }
        return run('uia_expand', a);
      },
    }),
    defineTool({
      name: 'desktop_uia_scroll',
      description:
        'Scroll a scrollable control (ScrollPattern when available, else mouse wheel — wheel is physical input and asks separately). ' +
        'Returns world-change feedback incl. scroll percents before→after. Scroll itself is non-destructive; with window takeover granted it flows without asking.',
      schema: z.object({
        ref: z.number().int().optional().describe('Control ref (scrollable pane/list)'),
        direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
        amount: z.number().optional().describe('Scroll amount (>=1 large step, <1 small step; wheel ticks); default 1'),
        name: z.string().optional().describe('Control name, exact match case-insensitive'),
        automation_id: z.string().optional().describe('Exact automation id'),
        control_type: z.string().optional().describe('ControlType, e.g. Pane, List, ScrollBar'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: async (a) => {
        if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
          return '[desktop_uia_scroll] 至少要给一个定位条件: ref / name / automation_id / control_type';
        }
        return run('uia_scroll', a);
      },
    }),
    defineTool({
      name: 'desktop_uia_keys',
      description:
        'Send a hotkey to a window (SendInput, real keyboard injection): key + modifiers (ctrl/alt/shift/meta). ' +
        'Examples: Ctrl+A, Delete, Enter, F5. Physical input — asks every time and is serialized globally (input lease) so concurrent agents cannot interleave keystrokes. ' +
        'Prefer pattern actions (click/type/select) whenever possible; use keys only for shortcuts UIA cannot reach.',
      schema: z.object({
        key: z.string().describe('Key name (Enter/Tab/Escape/Backspace/Delete/ArrowUp/F1-F12/single char)'),
        modifiers: z
          .array(z.enum(['ctrl', 'alt', 'shift', 'meta']))
          .optional()
          .describe('Modifier keys held (e.g. ["ctrl"] + key "a" = Ctrl+A)'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: (a) => run('uia_keys', a),
    }),
    defineTool({
      name: 'desktop_uia_activate',
      description:
        'Bring a window to the foreground (restore if minimized + SetForegroundWindow). Physical input — asks every time. ' +
        'Needed before coordinate clicks / clipboard paste into apps that require focus; pattern actions (Invoke/SetValue/Select) work without activation.',
      schema: z.object({
        hwnd: z.number().int().optional().describe('Window handle from desktop_probe'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: (a) => run('uia_activate', a),
    }),
    defineTool({
      name: 'desktop_uia_fill',
      description:
        'Fill MULTIPLE desktop controls in one round — fields: [{ref/name/automation_id/control_type, text}]. ' +
        'Each field follows desktop_uia_type semantics (ValuePattern.SetValue preferred, world-diff per field). ' +
        'Window takeover asks once for the batch; pre-filled/password fields still ask separately. ' +
        'Returns per-field outcome (value before→after, password-masked).',
      schema: z.object({
        fields: z
          .array(
            z.object({
              ref: z.number().int().optional().describe('Control ref from desktop_uia_tree/find'),
              name: z.string().optional().describe('Control name, exact match case-insensitive'),
              automation_id: z.string().optional().describe('Exact automation id'),
              control_type: z.string().optional().describe('ControlType, e.g. Edit'),
              text: z.string().describe('Text to type'),
            }),
          )
          .min(1)
          .max(20)
          .describe('Fields to fill, in order'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: async (a) => {
        const windowArgs = { hwnd: a.hwnd, pid: a.pid, title: a.title };
        const results: string[] = [];
        for (const f of a.fields) {
          if (f.ref === undefined && !f.name && !f.automation_id && !f.control_type) {
            results.push('[skip] 字段缺少定位条件 (ref/name/automation_id/control_type)');
            continue;
          }
          const r = await runDesktopAction('uia_type', {
            ...windowArgs,
            ref: f.ref,
            name: f.name,
            automation_id: f.automation_id,
            control_type: f.control_type,
            text: f.text,
          });
          results.push(`[${f.ref ?? f.name ?? f.automation_id ?? f.control_type}] ${r}`);
        }
        return `desktop_uia_fill 完成 ${results.length} 个字段：\n${results.join('\n')}`;
      },
    }),
    defineTool({
      name: 'desktop_uia_window_shot',
      description:
        'Capture a screenshot of a single window rect (not the full screen) - smaller privacy surface than desktop_screenshot, read-only. ' +
        'Locate window as in desktop_uia_tree (hwnd/pid/title/foreground). ' +
        'Returns {path, bytes, rect, window}. With a text-only model hand the path to the user; with a vision model read the image to see self-drawn controls that UIA cannot see.',
      schema: z.object({
        hwnd: z.number().int().optional().describe('Window handle from desktop_probe'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      readOnly: true,
      execute: (a) => run('uia_window_shot', a),
    }),
    defineTool({
      name: 'desktop_audit',
      description:
        'Read the desktop operation audit log — which agent did what (click/type/keys/activate), when, against which control/window, and the outcome. ' +
        'Mirrors browser_audit. Use to review what the Agent has done on the desktop.',
      schema: z.object({
        limit: z.number().int().optional().describe('Max entries (default 50)'),
      }),
      readOnly: true,
      execute: (a) => run('audit', a),
    }),
    defineTool({
      name: 'desktop_status',
      description:
        'Current desktop control state: active window-takeover grants per agent (with TTL) and the global input lease holder. ' +
        'Use to check who is currently allowed to operate which windows, or who holds the physical input lease.',
      schema: z.object({}),
      readOnly: true,
      execute: () => run('status', {}),
    }),
  ];
}
