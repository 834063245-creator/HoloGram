# HoloGram Browser CDP 套件 — 代码考古研究笔记

> 生成对象：HEAD `1593973` + 工作树第五批改动（未提交）。逐文件通读产出，供主代理横向对比 BrowserAct / Playwright MCP / Chrome DevTools MCP。
> 阅读范围：`docs/adr/0003`、3 份 plans、`src-tauri/src/cdp.rs` 及其 `cdp/` 子模块（transport/session/actions/probes/e2e）、`src-ui/src/agent/tools/browser.ts`、两份 vitest、`domains.ts` 的 browser 域、`main.rs`/`rpc.rs`/`tools/mod.rs` 的 cdp 相关片段。

---

## 1. 架构分层

三层：**TS 工具层 → Tauri RPC 桥 → Rust CDP 栈**。

```
LLM → browser.ts (领域工具 browser + 37 个隐藏 browser_* 子工具)
       │ agentInvoke(cmd, args)          browser.ts:40-88
       ▼
     Tauri RPC (rpc.rs)  -- self_or_agent 路由 + check_browser_permission 权限门禁
       │ 每个 "browser_*" 分支 → crate::cdp::cdp_xxx
       ▼
     Rust cdp 模块 (src-tauri/src/cdp.rs facade → 4 个子模块)
       transport.rs / session.rs / actions.rs / probes.rs / e2e.rs(测试)
```

- **cdp.rs 已退化为 facade**：`mod probes/transport/session/actions`（cdp.rs:27-30），生产代码全部拆出，仅保留 `pub(crate) use` 再导出（cdp.rs:32-42）与 `#[cfg(test)] mod tests`（cdp.rs:79-700）+ `mod e2e`（cdp.rs:703-704）。注意 session.rs:5-6 的头部注释仍写「actions 仍留在 cdp.rs」，与现状不符（actions.rs 已拆出，是过时注释）。
- **关键类型/结构体名**：
  - `CdpSession`（session.rs:623-675）——会话状态机核心。
  - `EventBuffers`（session.rs:312-326）+ `Observer`（session.rs:331-335）——事件缓冲与观察句柄。
  - `NetworkEntry`（session.rs:163-179）——requestId 配对的网络条目。
  - `AxNode`（actions.rs:301-306）——AX 树精简节点。
  - 静态全局：`SESSIONS`（session.rs:677）、`ACTIVE_SLOTS`（session.rs:690）、`AUDIT`（session.rs:817）。
  - TS 侧：`createBrowserTools()`（browser.ts:90）产 37 个 `browser_*` 工具；`createDesktopTools()`（browser.ts:605）产 2 个 `desktop_*` 工具；`DOMAIN_SPECS` 里的 browser/desktop 域（domains.ts:216-278）。
  - 权限类型：`BrowserTool`（tools/mod.rs:176-179）、`DesktopTool`（tools/mod.rs:264）。

---

## 2. 传输层

- **WebSocket 库**：`tokio-tungstenite`（transport.rs:13、session.rs:15），异步 `connect_async`。HTTP `/json` 端点用 **ureq** 同步客户端（transport.rs:24、43、61）。
- **连什么**：两条通道——
  1. **受控 Chrome**（`cdp_launch` 自己 spawn，独立 profile，session.rs:1207-1235）；
  2. **外部实例**（`cdp_connect` 连用户已开调试端口的浏览器/Electron，session.rs:1318-1382）；
  3. **自家 webview**（端口 9222，self 只读会话，`tauri.conf.json:22` 的 `additionalBrowserArgs: "--remote-debugging-port=9222"`）。
- **启动方式**：`find_chrome()`（session.rs:1032-1040）——`HOLOGRAM_CHROME` env 优先，否则按平台固定路径（Windows C 盘 Chrome/Edge、macOS .app、Linux `/usr/bin/*`）+ `PATH` 兜底（session.rs:967-1029）。spawn 参数：`--remote-debugging-port`、`--user-data-dir`、`--no-first-run`、`--no-default-browser-check`、`--disable-features=TranslateUI`，可选 `--headless`/`--window-size`/`--proxy-server`/`--proxy-bypass-list`（session.rs:1207-1229）；Windows 用 `NO_WINDOW` 隐藏控制台（session.rs:1230-1234）。
- **debug port**：默认 9223 起，占用自动 +1，探测上限 16（`DEFAULT_PORT_BASE=9223`、`PORT_PROBE_LIMIT=16`，session.rs:28-29；`probe_free_port` session.rs:1058-1075）。**9222 硬拒**（launch/connect 都拒，session.rs:1157-1162、1326-1331）。端口就绪轮询 `wait_for_port`（session.rs:1043-1054，10s）。
- **connect/disconnect**：命令通道**短连接**——每次调用 `list_targets_raw` 拿 `webSocketDebuggerUrl` → `connect_async` → 发一条 id=1 命令 → 循环读到匹配 id 的响应 → `ws.close`（`ws_command`，transport.rs:78-134）。批量版 `ws_command_batch` 一次建连顺序发、按 id 收集（transport.rs:140-194，为 AX 的 resolveNode 压到单次往返）。断开：命令通道用完即关；`cdp_kill` 对受控实例 kill 进程、对外部实例只清会话不杀进程（session.rs:1267-1312）。
- **消息收发模型**：同步请求/响应（id 匹配）；事件通道是独立持久 WS 后台 task（见下）。
- **事件订阅机制（Domain.enable）**：`start_observer`（session.rs:459-603）attach 后起持久 WS，订阅 `Runtime.enable`/`Log.enable`/`Network.enable`/`Page.enable`（命令 id 1000-1003，session.rs:485-490），非 self 会话额外 `Page.setInterceptFileChooserDialog`（id 1004，session.rs:498-508，self 不开拦截以免改自家 UI 文件框）。事件入环形缓冲（console/network/errors/dialogs/file_choosers，各上限 session.rs:132-136）。事件 task 随 target 消失退出，`alive` 标志 + 惰性重启（`ensure_observer_started` session.rs:610-617，带 `observer_starting` 在途闸防孤儿 task）。

---

## 3. 会话模型

- **状态机（CdpSession 字段即状态）**（session.rs:623-675）：`port`(0=未启动)、`target_id`(None=未 attach)、`chrome_child`(受控子进程句柄，None=外部连接)、`profile_dir`+`profile_ephemeral`、`slot`、`headless`/`window_size`/`proxy`/`proxy_bypass`（复用校验用）、`observer`、`observer_starting`、`last_active`/`created_at`。没有显式 enum 状态机，状态由这些 Option/值派生（`cdp_status` 输出，actions.rs:1919-1949）。
- **生命周期**：launch（session.rs:1093-1262，含复用校验：port/headless/windowSize/profile/proxy 全一致才复用，否则回收重启）→ attach（actions.rs:52-85）→ 操作 → kill（session.rs:1267-1312）→ 租约回收 `enforce_lease`（session.rs:747-784）。
- **tab 管理**：`cdp_new_tab`（HTTP PUT `/json/new`，自动 attach，session.rs:1563-1586）、`cdp_close_tab`（HTTP GET `/json/close/{id}`，关当前 attach 则回到未 attach，session.rs:1590-1615）；切换 tab = `targets` + `attach`。
- **多账号 slot 切换**：session key 从 `agent` 扩展为 `agent + slot`，分隔符 `\u{1f}`（`SLOT_SEPARATOR`，session.rs:693）。`ACTIVE_SLOTS` 存每 agent 的活跃 slot（session.rs:690-691），`active_session_key`（session.rs:705-715）解析当前活跃 key。`cdp_switch_session`（session.rs:1521-1559）切活跃 slot，被切走的 Chrome **不关**（租约独立计时），cookie/登录态隔离。`cdp_sessions`（session.rs:1387-1472）列全部 slot + 磁盘上已持久化的具名 profile。锁序约定：先 `SESSIONS` 后 `ACTIVE_SLOTS`（session.rs:687-689）。
- **profile 目录与 cookies 持久化**：
  - 默认临时 profile：`temp_dir/hologram-browser-profile-<port>`（session.rs:56、63-65），随 kill/租约删除。
  - 具名持久 profile：`temp_dir/hologram-browser-profiles-<slot>`（session.rs:60、69-71），kill/租约只停 Chrome 不删目录，可反复 launch/switch 恢复登录态。
  - **cookies 无自定义格式**：直接落在 Chrome 自己的 `--user-data-dir` 存储（Cookies SQLite 等）里，套件不直接读写 cookie 文件，而是走 CDP `Network.getCookies/setCookie/deleteCookies`（actions.rs:811、882、920）。slot 名校验 `normalize_slot_name`（session.rs:75-93）：允许 Unicode、拒绝路径分隔符/`\.:?*"<>|`/控制字符/`.`/`..`、≤48 字符。
- **并发限制**：无显式会话数上限；端口探测范围 16（9223-9238）是隐性上限。多 Agent 天然隔离（每 agent+slot 一个 key）；`sweep_stale_profiles`（session.rs:103-129）清扫遗留目录但跳过存活会话引用与 test 进程。

---

## 4. 动作面（全部动作 × CDP method 对应）

会话级动作在 session.rs，页面级在 actions.rs。**37 个动作**：

| 动作 | 实现位置 | CDP domain+method | 返回值结构 |
|---|---|---|---|
| launch | session.rs:1093 | spawn Chrome（非 CDP） | `{status, port, chrome, slot, profile, headless, windowSize, proxy, proxyBypass}` |
| connect | session.rs:1318 | HTTP `/json` 探测 | `{status, port, pages, slot, profile}` |
| discover | session.rs:1621 | 进程表(ps/PowerShell)+HTTP `/json` | `{instances:[{browser,port,pages:[{id,title,url}]}]}` |
| kill | session.rs:1267 | 进程 kill | 文本（已终止 / 已断开） |
| sessions | session.rs:1387 | 内存+磁盘枚举 | `{agent, active, count, sessions:[...]}` |
| switch_session | session.rs:1521 | 纯状态切换 | `{status, from, active, port, attached}` |
| new_tab | session.rs:1563 | HTTP PUT `/json/new` | `{created, targetId, url}` |
| close_tab | session.rs:1590 | HTTP GET `/json/close/{id}` | `{closed, targetId, note}` |
| targets | actions.rs:29 | HTTP `/json` | `{port, targets:[{id,title,url}]}` |
| attach | actions.rs:52 | HTTP `/json` 匹配 target | `{attached, targetId, title, url}` |
| navigate | actions.rs:1148 | `Page.navigate` | `{navigated, url, change}` |
| back/forward | actions.rs:1202/1207 | `Page.getNavigationHistory` + `Page.navigateToHistoryEntry` | `{navigated, url, change}` |
| reload | actions.rs:1212 | `Page.reload` | `{reloaded, url, change}` |
| snapshot | actions.rs:525 | `Accessibility.getFullAXTree`(优先)+`DOM.resolveNode`+`Runtime.callFunctionOn` / 回退探针 | `{source, refs:[{ref,tag,role,name,text,id?,type?}], count, total, offset, truncated}` |
| content | actions.rs:272 | 探针(Runtime.evaluate) | `{title, url, format, offset, maxChars, total, truncated, text\|markdown}` |
| inspect | actions.rs:230 | 探针 | JSON 数组 `{tag,id,rect,visible,scrollable,style,text,contrast}` |
| report | actions.rs:256 | 探针 | `{issues:[{rule,severity,detail,selector}], ok}` |
| console | actions.rs:612 | 读 EventBuffers | `{entries:[{type,text}]}` |
| network | actions.rs:622 | 读 EventBuffers | `{entries:[{requestId,method,url,status,mimeType,resourceType,error}], paired}` |
| network_detail | actions.rs:648 | 读 network_index | `{entry:{...全字段}}` |
| network_har | actions.rs:675 | 读 EventBuffers→写文件 | `{path, bytes, entries, note}` |
| screenshot | actions.rs:1797 | `Page.captureScreenshot` | `{path, bytes, fullPage, inline, dataUrl?}` |
| audit | session.rs:939 | 读 AUDIT 环形 | `{count, entries:[...]}` |
| cookies | actions.rs:790 | `Network.getCookies`/`setCookie`/`deleteCookies` | list:`{cookies,count,total}`；set/delete:`{set/deleted,name,...}` |
| click | actions.rs:1271 | `Page.bringToFront`+`Input.dispatchMouseEvent`(pressed/released) | `{clicked, x, y, change}` |
| hover | actions.rs:1302 | `Page.bringToFront`+`Input.dispatchMouseEvent`(mouseMoved) | `{hovered, x, y}` |
| type | actions.rs:1334 | 探针 focus + `Input.insertText` | `{typed, replace, change}` |
| select | actions.rs:1372 | 探针原生 setter | `{selected, value, change}` |
| upload | actions.rs:1415 | `DOM.setFileInputFiles`(+`DOM.getDocument`/`querySelector`) | `{uploaded, via}` |
| dialog | actions.rs:952/940 | `Page.handleJavaScriptDialog` / 读缓冲 | `{handled, accept}` / `{pending, entries}` |
| press | actions.rs:1521 | `Input.dispatchKeyEvent`(keyDown/keyUp+modifiers) | `{pressed}` |
| scroll | actions.rs:1621 | 探针 scrollIntoView 或 `Input.dispatchMouseEvent`(mouseWheel) | `{scrolled, selector\|direction}` |
| viewport | actions.rs:1754 | `Emulation.setDeviceMetricsOverride` | `{viewport:{width,height,deviceScaleFactor,mobile}}` |
| eval | actions.rs:1895 | `Runtime.evaluate` | JSON 值（截断 4000） |
| status | actions.rs:1919 | 纯状态 | `{port, slot, attached, chromeRunning, external, observerAlive, dialogPending, fileChooserPending, ...}` |
| wait | actions.rs:1665 | 休眠或探针轮询 | `{waited_ms}` / `{found, selector, waited_ms}` |

- **通用执行原语**：`runtime_evaluate`（actions.rs:193-228）统一包 `Runtime.evaluate` + `returnByValue`+`awaitPromise`+`timeout:5000`；`ws_command` 短连接封装。
- **世界反馈**：所有页面操作前后采样 `world_snapshot`（URL/DOM 长度/错误数，actions.rs:1019-1030）+ `world_diff`（actions.rs:1033-1059）→ `change` 字段。

---

## 5. 快照与语义提取

- **probes.rs 干什么**：纯「探针单一来源」层（probes.rs:14-17 `include_str!` 嵌入 4 个探针）+ 返回值契约 `probe_result_str`（probes.rs:24-30）——探针必须返回 stringify 字符串，违反（对象/二次序列化）报「形态异常」而非静默空结果。
- **snapshot 生成（双路径）**：
  1. **AX 优先**：无 scope 时走 `Accessibility.getFullAXTree`（`try_ax_snapshot`，actions.rs:366-520）。过滤 `ignored`/无 backendNodeId 节点（`ax_node_from_value` actions.rs:308-331），按可交互 role 白名单过滤（`ax_role_is_interactive` actions.rs:333-357，link/button/textbox/checkbox/…）。再批量 `DOM.resolveNode` + `Runtime.callFunctionOn` 把 `data-hg-ref` 回写 DOM（ref 语义与 DOM 探针一致）。任一步失败整体回退。
  2. **DOM 回退**：`snapshot.js`（147 行）——`INTERACTIVE` 选择器清单（snapshot.js:20-21），遍历 same-origin iframe + open shadow root（snapshot.js:24-40），可访问名称简化算法（aria-labelledby > aria-label > label[for] > 包裹 label > alt > title/placeholder > value > 可见文本，snapshot.js:53-94），DOM 可推导 role（snapshot.js:97-115），打 `data-hg-ref`（snapshot.js:130-139）。
  - `ref_to_selector`（actions.rs:571-580）：纯数字/`ref:N` → `[data-hg-ref="N"]`；`find_el_expr`（actions.rs:585-590）把定位逻辑收口到跨 iframe/shadow 的统一 JS 表达式，所有 selector 动作共用。
- **对 LLM 的 token 优化（截断/压缩策略）**：
  - ref 条目 name/text 各截 80 字符（actions.rs:488-489）。
  - snapshot/inspect 结果整体 8000 字符截断（actions.rs:545-549、562-567、249-253）；TS 层再截 8000（browser.ts:32-37）。
  - snapshot 分页：`offset`/`maxResults`（默认 80，上限 500）+ `total`/`truncated`（actions.rs:531、snapshot.js:5-7）。
  - content 字符分页：`maxChars` 默认 8000、上限 20000 + `offset`（actions.rs:283、content.js:17）。
  - console/error 文本截 300（session.rs:536、547）；network 列表 URL 截 200（session.rs:202）；cookie value 截 300（actions.rs:768）；eval 结果截 4000（actions.rs:1905）；审计 target/summary 截 120/200（session.rs:908-909）。
  - 事件缓冲环形上限：console 200 / network 200 / error 100 / dialog 20 / file_chooser 20 / audit 500（session.rs:132-139）。

---

## 6. 安全模型

- **权限三级分层（D6）**：全部 browser 动作统一走 `check_browser_permission`（rpc.rs:64-84）→ `BrowserTool::check_permissions`（tools/mod.rs:205-258）：
  1. **工具级 Deny 最高优先级**（tools/mod.rs:209-213）——`Browser=deny` 对**含只读与 self 通道**的所有动作生效；
  2. 工具级 Allow（tools/mod.rs:215-217）；
  3. **只读动作 Passthrough**（`is_read_only` 清单 tools/mod.rs:190-195：targets/discover/inspect/report/status/snapshot/console/network/network_detail/network_har/screenshot/audit/content/wait/dialog_query/sessions/cookies_list）；
  4. **L2 普通操作 Passthrough**（tools/mod.rs:224-227：navigate/back/forward/reload/click/type/press/scroll/select/hover/dialog/upload/viewport/new_tab/close_tab/switch_session）；
  5. **Ask**：launch/kill/connect/attach/eval + `click_sensitive`/`type_sensitive`（L3）+ `cookies_set`/`cookies_delete`，文案写实（tools/mod.rs:234-249）。attach 文案明示「批准后可在该页面点击/输入任意操作」。
- **self 只读门禁**：rpc.rs 每个写动作分支先 `is_self` 检查直接拒（如 browser_click rpc.rs:617-618、browser_viewport rpc.rs:595-597、browser_cookies rpc.rs:454-455）。self 走 `SELF_AGENT_ID="__self__"`（session.rs:149）。
- **URL 过滤**：无独立 URL 白名单——导航无域名限制；eval 用**静态字符串白名单** `check_eval_expr`（actions.rs:1868-1892，禁 fetch/XHR/WebSocket/localStorage/document.cookie/window.open/location.* 等），代码注释明确承认「纵深防御而非安全边界，动态方法名可绕过」（actions.rs:1865-1867），真正的边界是权限 Ask。
- **敏感目标检测**：`check_sensitive`（actions.rs:1722-1745）——type 到已填值/password 框、click submit/下载/高危文本（`SENSITIVE_CLICK_RE_SOURCE` actions.rs:1707，中文子串+英文单词边界，Rust 与页面 JS 共用同一正则源）；rpc 层触发二次 Ask（rpc.rs:623-624、638-639）。
- **文件系统边界**：profile/截图/HAR/审计全落 `temp_dir`，按前缀清理 + 保留天数 env 可调（默认 7 天，`HOLOGRAM_BROWSER_*_RETAIN_DAYS`，session.rs:831-853；`cleanup_old_files_by_age` session.rs:866-892）。审计 jsonl 按日轮转 `hologram-browser-audit-YYYYMMDD.jsonl`（session.rs:894-935）。slot 名清洗防路径穿越（normalize_slot_name）。
- **网络代理配置**：`proxy`/`proxyBypass` 直传 Chrome `--proxy-server`/`--proxy-bypass-list`（session.rs:1219-1224），`validate_proxy_arg` 只拒空值与换行（session.rs:1078-1086，防参数注入伪影）。
- **危险动作（eval）**：受限（白名单 + 权限 Ask），隔离 world 为可选未落地项。
- **审计**：全部写操作落盘 jsonl（agent/ts/action/target/summary，session.rs:899-935），`browser(audit)` 查，`browser(discover)` 过滤自家 9222（session.rs:1634、1728）。

---

## 7. 错误处理与恢复

- **超时层级**：WS 命令全链路 10s（`WS_TIMEOUT` transport.rs:16、131-133）；`Runtime.evaluate` CDP 层 5s（`EVAL_TIMEOUT_MS` session.rs:32，actions.rs:206，页面死循环不挂 Agent）；actionability 5s（`ACTIONABILITY_TIMEOUT` session.rs:35，actions.rs:1260-1263）；端口就绪 10s（session.rs:1241）；导航轮询 2s / reload 5s（`NAV_POLL_TIMEOUT`/`RELOAD_POLL_TIMEOUT` actions.rs:1062-1064）；wait 固定 ms 上限 30s（actions.rs:1672）；HTTP `/json` 2-5s（transport.rs:26、45、63）。
- **浏览器崩溃**：`enforce_lease` 用 `try_wait` 检测 Chrome 已退出→清句柄、删临时 profile（session.rs:751-760）；自动重启改为惰性（下次 launch 复用逻辑自动起新的）。
- **transport 断开重连**：命令通道无状态，重发即重连。事件通道 `alive` 标志 + 惰性重启（`ensure_observer_started` session.rs:610-617、`ensure_observer` actions.rs:158-173）；A4 修复——重启**复用同一 buffers Arc**，历史跨重启保留（session.rs:459-463、cdp.rs:324-338 测试），`observer_starting` 在途闸防孤儿 task（cdp.rs:343-355 测试）。
- **错误传播到 TS**：Rust `Result<String,String>` 错误经 rpc 透传，`runBrowserAction` catch 后包 `[browser] {action} 失败: {message}`（browser.ts:82-87），再整体 8000 截断。
- **契约锁定**（防静默失效回归）：`probe_result_str`（probes.rs:24-30）、`parse_world_value`（actions.rs:1012-1016，对象形态 vs 旧 JSON.stringify bug）、`world_diff`（actions.rs:1033）。ref 失效返回带恢复指引错误「请重新 browser(snapshot)」（actions.rs:1243-1245）。

---

## 8. 测试体系

- **e2e.rs 结构**（926 行）：全部真实 Chrome，**无 mock transport**（权限 Ask 只在 rpc 层，cdp 核心函数可直接驱动，e2e.rs:7-8）。`E2E_LOCK` 共享互斥串行（e2e.rs:28）；`skip_if_no_chrome` 无 Chrome 自动跳过（e2e.rs:39-45）；固定端口 9444-9449 避开 9222/9223-9238（e2e.rs:30-35）；`ExternalChrome` 模拟用户实例（e2e.rs:48-77）；`spawn_local_http_server` 提供真实网络事件（e2e.rs:93-138）。
  - **E2E-1**（e2e.rs:144-251）：connect 外部实例全链路——connect→targets→attach→snapshot→click 世界反馈→kill 只断开不杀（回归 e1679a0/bfbcd95/b988f87d）。
  - **E2E-2**（e2e.rs:254-312）：launch 受控 + kill 终止 + profile 定向回收。
  - **E2E-3**（e2e.rs:353-633）：二轮第一批——content(text/markdown/分页)、type(replace)、select(value/文本)、hover、组合键、upload(selector 回退)、dialog、screenshot(fullPage+inline)、navigate/back/forward/reload 真刷新、new_tab/close_tab。
  - **E2E-4**（e2e.rs:639-809）：headless/windowSize + discover + network 配对/详情 + HAR 导出 + AX snapshot + viewport(Emulation)。
  - **E2E-5**（e2e.rs:814-926）：具名 profile A/B 多账号隔离 + cookie set/list/delete + switch。
- **单元测试（cdp.rs tests mod，79-700）**：探针 `node --check` 语法（101-107）；敏感文本中英（242-271）；网络 requestId 配对（383-429）；AX 节点解析/role 过滤（434-463）；HAR entry 形状（468-502）；租约 kill+profile 清理（602-653）；过期文件清理（658-687）；审计回写（692-699）；observer 缓冲复用/在途闸（324-355）；`/json/new`/`/json/close` 协议级（本地 TcpListener，536-578）；slot 名校验/session key 隔离/proxy 校验（136-178）等。动作参数校验在触真 CDP 前拒绝（360-377、506-522）。
- **TS 单测**：`browser-tools.test.ts`（197 行）——mock `agentInvoke` 捕获路由，验证领域工具 browser 可见、browser_* 隐藏、action→RPC 名映射与参数透传；`browser-snapshot-probe.test.ts`（138 行）——jsdom 实测回退探针的可访问名称/iframe/shadow 遍历/ref 回写/scope 错误（Linux 无 Chrome 时的行为保障）。
- 基线：`cargo test cdp::` 32/32（5 个 e2e 本机跳过）；vitest 55/55；全量 `cargo test` 275 passed / 8 failed（8 个历史环境失败：bwrap/tasklist/%USERPROFILE%/worktree 路径，非本套件）。

---

## 9. 模型工具集成

- **browser.ts 暴露 37 个 `browser_*` 工具 schema**（launch…wait，browser.ts:93-578），每个 zod schema + 英文描述；再加 2 个 `desktop_*`（probe/screenshot，browser.ts:605-631）。参数 camelCase。
- **nameMap 动作→RPC 名**：browser.ts:41-79（37 项，如 `snapshot→browser_snapshot`）。
- **tool convergence（browser 域映射）**：domains.ts:216-266 的 `DOMAIN_SPECS.browser`——37 个 action→旧工具名映射；`collectHiddenToolNames`（domains.ts:328-368）把全部 37 个 `browser_*` + 2 个 `desktop_*` 隐藏，**模型只看到 `browser` 一个领域工具**（`browser-tools.test.ts:24-32` 断言）。`buildDomainTool` 聚合 action/参数/readOnly（domains.ts:281+）。
- **参数归一**：领域工具顶层 `action` 被 domains.ts 剥掉；子命令参数不能叫 `action`（第五批 `browser_cookies` 因此用 `op`，review-round2 §8.5）。camelCase→snake_case 转换在 `bridge.rpc` 层（browser-tools.test.ts:84 注释）。
- **结果格式化回模型**：`agentInvoke<string>` 返回字符串，`truncate` 8000（browser.ts:32-37）；错误包 `[browser] ... 失败:` 前缀。领域工具单入口 `browser` 的动作语义全在 description 里（domains.ts:217-226，含 self/外部判别、snapshot→ref 范式、多账号说明）。
- **self 判别**：`self_or_agent`（rpc.rs:49-57）认 `target="self"` 字符串或 `self=true` 布尔（修复 D4 落地时 self 路由静默失效的 bug）。

---

## 10. 已知限制 / 未落地项（已落地 vs 计划中 vs 明确不做）

**已落地（五个批次全绿，代码在库中）**：
- 第一批：navigate/back/forward/reload、content、select、type(replace)、权限统一收口 `check_browser_permission`、英文敏感词（review-round2 §4.1）。
- 第二批：dialog、upload、hover、press modifiers、screenshot fullPage/inline(≤3MB data URL)、new_tab/close_tab、Page.enable+file chooser 拦截（review-round2 §4.1 第二批）。
- 第三批：network requestId 配对 + network_detail、AX snapshot（失败回退增强探针）、launch headless/windowSize（review-round2 §4.1 第三批）。
- 第四批：跨平台 find_chrome/discover、审计/截图/HAR 轮转清理、HAR 1.2 导出、browser_viewport（Emulation.setDeviceMetricsOverride）、cdp.rs 四模块拆分（transport/session/actions/probes，现已完成，cdp.rs 只剩 facade+测试）（review-round2 §4.1 第四批、§4.2）。
- 第五批（工作树未提交）：cookies list/set/delete、launch profile(具名持久)/proxy/proxyBypass、多账号 slot 隔离/切换（SESSIONS 键 agent+slot、ACTIVE_SLOTS）、E2E-5（review-round2 §4.1 第五批、§8.4）。
- 另已落地：connect/discover（ADR D8）、desktop_probe/desktop_screenshot（plan §8 第二验证批次）、UI 审计展示 v1（BrowserActivityPanel，plan §6）、后台活动状态栏（review-round2 §4.1 第五批补）。

**计划中 / 可选未落地**：
- **eval 隔离 world**（Runtime 隔离 world 或 CSP 收紧）——唯一明确「可选未做」项（ADR 0003:18、review-round2 §4.2/§8.4）。当前 eval 仍是静态白名单 + Ask。

**明确不做 / 既定限制**：
- **不做 Node 桥**（tool-convergence §3.4 否决，理由不变：常驻进程/端口/五跳协议链/绕过权限）。
- **不做本机端口扫描**——connect 端口由用户提供，discover 只查进程表命令行（ADR D8）。
- **截图默认只回路径不回 base64**（plan §5 决策）；inline 为 3MB 上限的可选开关。
- **HAR timing 全为 -1**（观察通道不采样 timing，session.rs:229-230、actions.rs:724）。
- **network_detail 只能查 200 条窗口内**（actions.rs:664-669）。
- **AX snapshot 不支持 CSS scope**（带 scope 直接走 DOM 探针，actions.rs:538-539）。
- **self 通道只读**，操作类动作在 rpc 层硬拒。
- **未验证项**：Windows 真机 E2E-1/2/3/4/5 未实跑（Linux 无 Chrome 自动跳过，review-round2 §8.2）；全量 `cargo test` 8 个历史环境失败未清。
- **eval 白名单**是字符串匹配「纵深防御」非边界（actions.rs:1865-1867 自认）。
- 已知小债：session.rs:5-6 头部注释「actions 仍留在 cdp.rs」已过时（actions.rs 已拆出）。

---

## 11. 规模统计

| 文件 | 行数 |
|---|---|
| docs/adr/0003-agent-browser-cdp-suite.md | 135 |
| docs/plans/browser-cdp-suite-plan-2026-08-13.md | 135 |
| docs/plans/browser-cdp-suite-review-round2.md | 263 |
| docs/plans/tool-convergence-browser-plan-2026-08-08.md | 208 |
| src-tauri/src/cdp.rs（facade + 单测） | 704 |
| src-tauri/src/cdp/transport.rs | 194 |
| src-tauri/src/cdp/session.rs | 1751 |
| src-tauri/src/cdp/actions.rs | 1955 |
| src-tauri/src/cdp/probes.rs | 31 |
| src-tauri/src/cdp/e2e.rs | 926 |
| src-tauri/src/cdp/probes/*.js（content 112 + inspect 57 + report 119 + snapshot 147） | 435 |
| src-ui/src/agent/tools/browser.ts | 631 |
| src-ui/tests/browser-tools.test.ts | 197 |
| src-ui/tests/browser-snapshot-probe.test.ts | 138 |

- **Rust（cdp 套件）**：704 + 194 + 1751 + 1955 + 31 + 926 = **5,561 行**（生产 ~3,976：transport 194 + session 1751 + actions 1955 + probes 31 + cdp.rs facade ~45；测试/e2e ~1,585：cdp.rs tests ~659 + e2e 926）。
- **TS**：631 + 197 + 138 = **966 行**（生产 631，测试 335）。
- **探针 JS**：435 行；**文档**：741 行。
- **Rust : TS ≈ 5.75 : 1**（Rust ≈ 85%，TS ≈ 15%，按生产+测试口径）。核心逻辑几乎全在 Rust（传输/会话/动作共 3,900 行），TS 只是 631 行薄工具定义层。
- 拆分成果印证 review-round2 §6 的 god-module 债：`cdp.rs` 从 1,857 行降到 704（且 704 里 ~659 是测试），业务逻辑按传输/会话/动作/探针四模块 + 4 个独立探针 .js 文件重组。
