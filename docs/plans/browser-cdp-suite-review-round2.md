# Browser CDP 套件二轮评审 + 改进计划

> 状态：第一批（`e0b9086`）+ 第二批（`fec19fe`）+ 第三批（`2c8376a`）+ 第四批（`9a9d810`/`54cea67`/`2d25279`/`60aaac2`/`1593973`）+ 交接文档（`5ec03b8`/`cb87eaf`）已提交，均未 push；**第四批完成**（跨平台 + 轮转清理 + HAR + viewport + cdp.rs 四模块拆分 + 可行 e2e 补齐）；**第五批代码已完成待提交**（cookie 管理 + profile/proxy 配置 + 多账号 slot 隔离/切换 + E2E-5），eval 隔离 world 保持可选不做
> 下一接手窗口任务：有 Windows 环境则补跑 E2E-1/2/3/4/5（重点 E2E-5 多账号 cookie 隔离）；随后 review 本批 diff、commit；eval 隔离 world 仍为可选项
> 关联实验：[`v4-pro-minimal-ab-test-plan.md`](./v4-pro-minimal-ab-test-plan.md)（同目录）
> 评审范围：`src-tauri/src/cdp.rs`、`src-tauri/src/rpc.rs`、`src-tauri/src/tools/mod.rs`、
> `src-ui/src/agent/tools/browser.ts`、`src-tauri/src/cdp/probes/*.js`、`src-tauri/src/cdp/e2e.rs`
> 参照系：BrowserAct（`D:\useful\browser-act-skills`）、Playwright MCP / Chrome DevTools MCP 的能力面

## 0. 结论先行

这套东西**不是做得差，而是定位太窄**。工程质量和安全模型在自己写的 CDP 套件里属于上乘，
但功能面只有通用浏览器自动化平台的 4/10，所以「拿起来好用」的体感明显输给 BrowserAct / Playwright MCP。

| 维度 | 分数 | 说明 |
|---|---|---|
| 底层工程质量 | 8.5/10 | 超时、会话隔离、契约测试、真实 Chrome e2e |
| 安全模型 | 9/10 | L1-L3 权限 + 审计 + 外部连接 kill 只断开 |
| 核心交互闭环 | 7.5/10 | snapshot→ref→click→世界反馈方向正确 |
| 功能覆盖 | 4/10 | 缺导航、内容提取、表单全动作、对话框等 |
| 跨平台 | 3/10 | 基本 Windows-only |
| 好用体感 | 5.5/10 | 模型经常卡在「没有这个动作」 |

## 1. 做得好的地方（不要删，后续改动不得回退这些性质）

1. 每 Agent 独立会话 + 空闲租约回收 + Chrome 崩溃检测（`cdp.rs` D1 / `enforce_lease`）
2. snapshot + ref 交互范式（`snapshot.js`，与 browser-use / Chrome DevTools MCP 同思路）
3. actionability 等待 + 世界变化反馈（`wait_actionable` / `wait_nav_settle` / `world_diff`）
4. 全链路超时：WS 10s + `Runtime.evaluate` 5s
5. 事件通道：持久 WS + 环形缓冲 + 惰性重启 + 历史跨重启保留
6. self webview 只读通道 + `browser_report` 视觉 lint（对比度/间距/对齐/溢出，独有能力）
7. L1-L3 安全分级 + 敏感目标单独 Ask + 审计日志 + `browser(audit)` / UI 审计面板
8. 外部连接 kill 只断开不杀进程；受控浏览器独立 profile 且随会话回收
9. 探针独立 `.js` + `node --check` 契约测试；真实 Chrome e2e（connect/launch 全链路）
10. 全仓库线程冲突扫描：0 个未加锁并发写

## 2. 功能矩阵（你 vs 参照系）

| 能力 | HoloGram CDP | BrowserAct | Playwright MCP |
|---|---|---|---|
| launch/connect/discover | 有（仅 Windows） | 有 | 有 |
| navigate/back/forward/reload/tab | **缺** | 有 | 有 |
| snapshot + ref 交互 | 有 | 有（state 索引 + 变更标记） | 有（AX tree） |
| 正文提取 / markdown | **缺** | 有 | 部分 |
| click/type/press/scroll/wait | 有 | 有 | 有 |
| select/upload/hover/dialog | **缺** | 有 | 有 |
| 截图 | 只回路径 | 只回路径 | 直接给图 |
| 网络观察 | 粗事件，请求/响应未配对 | 请求详情 + HAR | 有 |
| console 观察 | 有 | 部分 | 有 |
| cookie/profile/proxy/多账号 | **缺** | 有（核心卖点） | 部分 |
| 视觉 lint | 有（独有） | 无 | 无 |
| 安全分级 + 审计 | 强 | confirm gate | 无 |

## 3. 具体差距清单（按优先级）

### P0：日常任务直接做不了

1. **没有 navigate / back / forward / reload，也没有 tab 管理**
   - `browser_launch` 只能启动时带 URL（`cdp.rs:513`）；attach 后无导航路径。
   - 修法：新增 `Page.navigate` / `Page.getNavigationHistory` + `Page.navigateToHistoryEntry` / `Page.reload`
     对应 `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload`。
2. **读不了页面正文**
   - snapshot 只返回可交互元素；`browser_eval(document.body.innerText)` 被 4000 字符截断。
   - 修法：新增 `content.js` 探针 + `browser_content`，支持 title/url/text/markdown-lite、
     selector scope、分页（offset/maxChars），复用 `probe_result_str` 契约。
3. **截图只回路径，不回图片内容**（`cdp.rs:1532-1557`）
   - 纯文本模型看不到图；vision 模型要多走 `read_file_base64`。
   - 修法：`browser_screenshot` 增加 `fullPage`；增加 `inline`（上限保护，返回 data URL）。
     工具结果直接带图的形态取决于 HoloGram 的 image part 支持，先做开关。
4. **表单动作缺一半**
   - 无 `select` / `upload` / hover / drag；`browser_type` 只 focus + `Input.insertText`，
     不清空已有内容；`browser_press` 不支持组合键。
   - 修法（本批）：`browser_select`（value 或 option 文本）+ `browser_type` 增加 `replace`
     参数（replace 时先清空并派发 input/change 事件）。
   - 修法（下批）：`browser_upload`（Page.setInterceptFileChooserDialog + DOM.setFileInputFiles）、
     hover、组合键。
5. **没有 dialog / file chooser 处理**
   - `alert/confirm/prompt`、`<input type=file>` 会卡死流程。
   - 修法（下批）：observer 增订 `Page.javascriptDialogOpening` / `Page.fileChooserOpened`，
     新增 `browser_dialog accept|dismiss` 和 `browser_upload`。

### P1：观察与调试能力偏粗

6. **network 缓冲太粗**（`cdp.rs:252-276`）
   - request 和 response 未按 requestId 配对；`loadingFailed` 把 requestId 填进 url 字段。
   - 修法：observer 维护 `requestId -> entry` 映射，追加响应时回填 status；
     `browser_network` 输出成对记录；后续再加单请求详情/HAR。
7. **snapshot 缺可访问性信息**
   - 无 role / aria-labelledby / iframe / shadow DOM 遍历；纯图标按钮 text 为空。
   - 修法：优先试 `Accessibility.getFullAXTree`（Chrome DevTools MCP 同款），
     不行则增强探针（accessible name 计算 + iframe 递归 + shadow DOM 穿透）。
8. **没有 viewport / device emulation / headed/headless 选择**
   - 修法：`browser_launch` 增加 `headless` / `windowSize` 参数；后续接 `Emulation.setDeviceMetricsOverride`。
9. **`browser_connect` 描述过时**
   - 描述写「there is no port discovery」，但 `browser_discover` 已存在。改描述即可。

### P2：平台与工程债

10. **基本 Windows-only**
    - `find_chrome` 只列 C 盘 Chrome/Edge（`cdp.rs:464-469`）；
      `cdp_discover` 硬编码 PowerShell（`cdp.rs:676-692`）。
    - 修法：补 macOS/Linux 候选路径；discover 在非 Windows 用 `ps -axo pid=,comm=,args=` 扫描。
11. **敏感点击检测只有中文动词**（`cdp.rs:1517`）
    - 英文 "Pay now / Delete / Confirm / Unsubscribe" 不会触发单独 Ask。
    - 修法（本批）：正则补英文高危词，并加单测锁定。
12. **权限入口不统一（较严重）**
    - 只读 browser 动作和普通 click/type/press/scroll 在 `rpc.rs` 里没有经过
      `BrowserTool::check_permissions`，与 `tools/mod.rs:209`「Deny 最高优先级」不一致，
      `Browser=deny` 对这些动作可能不生效。
    - 修法（本批）：`rpc.rs` 新增 `check_browser_permission(action, agent_id, ...)` 辅助，
      所有 browser_* 分支统一过权限引擎；只读动作 Passthrough 与 Deny 语义由
      `BrowserTool::check_permissions` 统一裁决。
13. **`cdp.rs` 是 1857 行 god module**
    - 传输、会话、探针、动作、测试全在一起；耦合报告 2463 条边。
    - 修法（功能稳定后）：拆 `transport.rs` / `session.rs` / `actions.rs` / `probes.rs`。
14. 小问题
    - 审计 jsonl 和截图目录无上限增长：加按日期轮转 + 保留 N 天清理。
    - `eval` 白名单是字符串匹配（代码注释已承认只算纵深防御）：维持 Ask 边界，
      后续可考虑 Runtime 隔离 world 或 CSP 收紧。

## 4. 本批（第一批）改动范围

主题：导航 + 正文提取 + select + type replace + 权限收口 + 英文敏感词。

| 文件 | 改动 |
|---|---|
| `src-tauri/src/cdp/probes/content.js` | 新增：正文提取探针（title/url/text/markdown-lite + 分页） |
| `src-tauri/src/cdp.rs` | `cdp_navigate` / `cdp_back` / `cdp_forward` / `cdp_reload` / `cdp_content` / `cdp_select`；`cdp_type` 增加 `replace`；`check_sensitive` 补英文词；`probes_are_valid_javascript` 加 content.js；新增对应单测 |
| `src-tauri/src/rpc.rs` | 新增 6 个 browser_* 分支；统一 browser 权限检查入口 |
| `src-tauri/src/tools/mod.rs` | `BrowserTool::is_read_only` 补新动作；`check_permissions` 文案补新动作 |
| `src-ui/src/agent/tools/browser.ts` | nameMap + 工具定义（navigate/back/forward/reload/content/select）+ type 的 replace 参数 + connect 描述修正 |
| `src-ui/src/agent/tools/domains.ts` | browser 领域工具同步新动作 + 隐藏名清单（AGENTS.md 工具层收敛纪律） |
| `src-ui/tests/browser-tools.test.ts` | 领域 action 覆盖清单补新动作；新增 navigate/content/select 路由守护 |
| `src-tauri/src/cdp/e2e.rs` | 新增真实 Chrome e2e：本地 file:// 页面覆盖 navigate/back/forward/reload/content 分页/type replace/select |
| 文档 | 本文件 + ADR 0003 落地状态追加一节 |

### 4.1 落地注记

**第一批（2026-08-15）**

- 已完成上述第一批全部代码与文档改动；`cargo check` 通过，`cargo test cdp::tests` 14/14 通过（含新增 content.js 语法检查与英文敏感词单测）；`cargo test cdp::e2e --no-run` 编译通过。本 Linux 机器无 Chrome，3 个真实 Chrome e2e 自动跳过；Windows 机器有 Chrome 时会实跑新增 E2E-3 全链路。
- `src-ui`：`npx tsc --noEmit` 与 `npm run build` 通过；`vitest run tests/browser-tools.test.ts tests/domains-convergence.test.ts tests/define-tool.test.ts` 48/48 通过。
- 全量 `cargo test` 在本 Linux 机器上仍为 260 passed / 8 failed，失败项均为 Windows/bwrap 环境依赖的历史基线失败（agent_isolation worktree 路径、bwrap 沙箱、%USERPROFILE% 展开、tasklist 查找），与本批改动无关。

**第二批（2026-08-15）**

- 新增 `browser_dialog`（查询 pending + accept/dismiss/promptText）、`browser_upload`（file chooser backendNodeId 优先 + selector 回退）、`browser_hover`、`browser_press` modifiers（ctrl/alt/shift/meta）、`browser_screenshot` fullPage + inline data URL（3MB 上限）、`browser_new_tab` / `browser_close_tab`（Chrome HTTP `/json/new` PUT、`/json/close` GET；切换复用 attach）。
- observer 增订 `Page.enable`、`Page.javascriptDialogOpening/Closed`、`Page.fileChooserOpened`，并 `Page.setInterceptFileChooserDialog`；`browser_status` 增加 `dialogPending` / `fileChooserPending`。
- 测试：`cargo test cdp::tests` 16/16；`cargo test cdp::` 19/19（含 3 个真实 Chrome e2e，本机无 Chrome 自动跳过）；新增 `/json/new` 与 `/json/close` 的本地 TCP 协议级单测。全量 `cargo test` 262 passed / 8 failed（仍是同批历史环境失败）。`npx tsc --noEmit`、`npm run build` 通过；vitest 49/49。

**第三批（2026-08-15，已提交 `2c8376a`）**

- network 配对：`NetworkEntry` 单条记录 + `network_index`（requestId→entry），`responseReceived` 回填 status/statusText/mimeType/responseHeaders，`loadingFailed` 回填 error 且不再把 requestId 塞进 url；`browser_network` 输出 `{entries, paired:true}`。
- 新增 `browser_network_detail(requestId)`：完整 URL/method/status/请求响应头/postData(2000 字符上限)/error；仅可查仍在 200 条窗口内的请求，HAR 导出仍为后续项。
- AX snapshot：`cdp_snapshot` 无 scope 时优先 `Accessibility.getFullAXTree`，批量 `DOM.resolveNode` + `Runtime.callFunctionOn` 把 AX 节点回写 `data-hg-ref`，ref 语义与 DOM 探针一致；任一步失败回退增强 `snapshot.js`（accessible name / aria-labelledby / label[for] / same-origin iframe + shadow DOM 遍历）。selector 定位收口到 `find_el_expr`（iframe/shadow 内的 ref 现在可 click/type/select/hover/scroll）。
- `browser_launch` 新增 `headless` / `windowSize`（width/height 1-16384）；复用会话时校验启动形态一致性，不一致则回收重启。self/connect/kill 路径同步清理这两个字段。
- 测试：`cargo test cdp::` 22/22（新增 network 配对单测、launch windowSize 参数单测；4 个真实 Chrome e2e 本机无 Chrome 自动跳过，新增 E2E-4 覆盖 headless/windowSize + 本地 HTTP network 配对/详情 + HAR 导出 + AX snapshot）；全量 `cargo test` 265 passed / 8 failed（8 个为历史环境失败）。随后补的 AX 解析单测与 `find_el_expr` 路径已通过 `cargo check --tests`（本机内存不足未能再次完成链接）。
- 无 Chrome 环境的行为保障：新增 `src-ui/tests/browser-snapshot-probe.test.ts`（jsdom）实测回退探针的可访问名称、label[for]/aria-labelledby、iframe + shadow DOM 遍历、ref 回写与 scope 错误；`npx tsc --noEmit` 通过；vitest（browser-tools/domains-convergence/define-tool/browser-snapshot-probe）53/53。
- 未做（按计划留到第四批/后续）：HAR 导出、`Emulation.setDeviceMetricsOverride`、跨平台 find_chrome/discover、cdp.rs 拆分、审计/截图轮转清理。

**第四批第一批（2026-08-15）**

- 跨平台：`find_chrome` 补 macOS/Linux 固定路径 + `PATH` 兜底（Windows 路径保留）；`cdp_discover` 非 Windows 走 `ps -ax -o pid=,comm=,args=`，PowerShell 与 ps 两种输出统一进 `parse_discover_process_lines`。
- 轮转清理：审计 jsonl 改为按日文件（`hologram-browser-audit-YYYYMMDD.jsonl`），截图目录与 HAR 目录按前缀 + mtime 清理，保留天数可经 `HOLOGRAM_BROWSER_*_RETAIN_DAYS` 覆盖（默认 7 天）。
- HAR 导出：新增 `browser_network_har(limit)` —— 观察缓冲导出 HAR 1.2 文件（URL/queryString/请求响应头/postData/status/mimeType；timing 因观察通道未采样记 -1）。第三批遗留的「HAR 导出」至此关闭。
- 模块拆分（部分）：新增 `src-tauri/src/cdp/transport.rs`（HTTP `/json` + 命令 WS/批量 WS）与 `src-tauri/src/cdp/probes.rs`（探针常量 + 返回值契约）；`cdp.rs` 仍承担 session/actions，下一窗口继续拆。
- 测试：新增跨平台路径候选、discover 解析、过期文件清理、HAR entry 形状单测；`cargo check --tests` 通过。前端 `npx tsc --noEmit` 通过，vitest 53/53。
- 又补：`browser_viewport(width,height,deviceScaleFactor,mobile)` 落地 `Emulation.setDeviceMetricsOverride`（width/height 1-16384，DPR 0.5-3）；E2E-4 增补视口覆盖断言。
- 未做：`cdp.rs` session/actions 拆分、eval 隔离 world（可选）。

**第五批补（2026-08-15，UI 后台活动观测）**

- 新增底部状态栏「后台活动」胶囊：有 shell 后台任务 / 浏览器会话 / 运行中子 Agent 时显示，无后台活动完全不渲染；点开是玻璃质感 popover，按三类分组显示 label / slot / 端口 / 运行时长 / 停滞标记。
- Rust 侧新增只读聚合命令 `background_activity`：`bg_jobs_snapshot()`（仅返回仍在运行的 BG_JOBS）+ `cdp_browser_activity()`（跨 agent 汇总 port!=0 的浏览器会话，self webview 不进入列表）；`CdpSession` 增加 `created_at` 用于展示运行时长。
- 刷新策略：`agent:tool-done` / `agent:status` 事件后 250ms 立即刷新；有活动时 3s 轮询，无活动时 15s 低频兜底。`BrowserActivityPanel` 展开期间改为 5s 刷新 + 工具完成后即时刷新，并补全新增动作的中文标签。
- 验证：`npx tsc --noEmit`、`npm run build` 通过；`cargo test cdp::` 33/33（新增 `browser_activity_snapshots_running_sessions_only`）；全量 `cargo test` 276 passed / 8 failed（仍是 8 个历史环境失败）。

**第五批（2026-08-15，代码完成待提交）**

- `browser_launch` 新增 `profile`（具名持久 profile/slot）、`proxy`（`--proxy-server`）、`proxyBypass`（`--proxy-bypass-list`）；默认 profile 仍按端口隔离且随 kill/租约删除，具名 profile 目录 `hologram-browser-profiles-<slot>` 保留并可反复 launch 复用登录态。复用会话时 profile/proxy 与端口/headless/windowSize 一并做形状校验。
- 多账号隔离/切换：`SESSIONS` 键从 agent 扩展为 `agent + slot`，`ACTIVE_SLOTS` 维护每 agent 的活跃账号；`browser_sessions` 只读列出全部 slot 与活跃项，`browser_switch_session` 切换活跃 slot，被切走的 Chrome 不关闭（租约独立计时），cookie/登录态互相隔离。connect 可用 `session` 把外部实例登记进指定 slot。
- cookie 管理：`browser_cookies(op: list|set|delete)` 走 `Network.getCookies` / `Network.setCookie` / `Network.deleteCookies`；list 支持 `urls` 过滤、value 截断 300 字符并返回 total；set 支持 url/domain/path/httpOnly/secure/sameSite/expires；delete 需 name + url/domain。尚未 attach 时自动选第一个 page target 且不改变 attach 状态。set/delete 每次 Ask，list 只读。
- 权限收口：`BrowserTool` 只读清单补 `sessions` / `cookies_list`，L2 清单补 `switch_session`，`cookies_set` / `cookies_delete` 走 Ask（改写登录态）。
- 测试：新增 slot 名校验/session key 隔离/proxy 参数校验单测；`parse_discover_process_lines` 在解析层过滤 9222（与 discover 契约一致，原单测预期与实现不符的基线债一并修掉）。`cargo test cdp::tests` 27/27，`cargo test cdp::` 32/32（5 个真实 Chrome e2e 本机跳过，新增 E2E-5 覆盖 profile A/B cookie 隔离 + switch + set/list/delete）；全量 `cargo test` 275 passed / 8 failed（仍是 8 个历史环境失败）。前端 `npx tsc --noEmit`、`npm run build` 通过；vitest（browser-tools/domains-convergence/define-tool/browser-snapshot-probe）55/55。
- 踩坑已记入 §8.5：cookie 领域动作的参数名用 `op`（领域工具顶层 `action` 会被 domains.ts 剥掉，不能复用）。

### 4.2 后续批次（含本轮补入的原“未排批次”项）

- **第二批（日常任务断点）**：✅ 已落地 —— dialog + upload + hover + 组合键 + 截图 inline/fullPage + tab 管理（new/close；切换复用 attach）。
- **第三批（观察与调试）**：✅ 已落地（`2c8376a`）—— network requestId 配对 + `browser_network_detail` + AX snapshot（失败回退增强探针）+ launch headless/windowSize。HAR 导出已在第四批第一批关闭；`Emulation.setDeviceMetricsOverride` 仍在第四批剩余项。
- **第四批（平台与工程债）**：✅ 基本完成 —— 跨平台 + 审计/截图/HAR 轮转 + HAR 导出 + `browser_viewport`（`Emulation.setDeviceMetricsOverride`）+ `cdp.rs` 四模块拆分（transport/session/actions/probes）已完成；剩余 eval 隔离 world（可选）。
- **第五批（身份与多账号）**：✅ 已落地（代码待提交）—— cookie list/set/delete + launch profile/proxy/proxyBypass + 多账号 slot 隔离/切换 + E2E-5。

## 5. 基线命令（新窗口改代码前跑，留底）

```powershell
cd D:\HoloGramHG\src-tauri
cargo test
cargo test cdp:: -- --nocapture

cd D:\HoloGramHG\src-ui
npx tsc --noEmit
npm run build
```

Linux 环境已知 8 个历史失败（bwrap / tasklist / %USERPROFILE% / worktree 路径），不是本套件回归；只需确认失败数没有从 8 变多。

## 6. Preflight 风险数据（Hologram，改前快照）

- 计划改动文件全部为 **high** blast radius：
  - `cdp.rs`：blast_radius 127,134，direct_nodes 108
  - `rpc.rs`：blast_radius 27,126，direct_nodes 14
  - `tools/mod.rs`：blast_radius 10,522，direct_nodes 14
  - `browser.ts`：blast_radius 5,573，direct_nodes 9
- `cdp.rs` 耦合报告：L1 321 / L3 1258 / L4 884 / total 2463，fragility 3.0
- 全仓库 unlocked concurrent writes：**0**
- 结论：每批改动必须小步、可编译、可单测；禁止一批同时改传输层和工具面。

## 7. 工作协议（新窗口接手）

1. 新窗口先读 §8「新窗口接手」，不要从 §0 重新做已完成的第一/二批。
2. 每批改动小步推进：先 Rust 后前端，`cargo check` / `cargo test cdp::` / `npx tsc --noEmit` 过一关再进下一关；全部绿了才 commit。
3. 新增 browser 动作必须同步五处：`cdp.rs`（核心函数）、`rpc.rs`（分支 + `check_browser_permission`）、`tools/mod.rs`（`BrowserTool::is_read_only` 与 L2 清单）、`browser.ts`（nameMap + defineTool）、`domains.ts`（DOMAIN_SPECS + `collectHiddenToolNames`），并补 `browser-tools.test.ts` 路由守护。
4. 真实 Chrome e2e 在本 Linux 机器会跳过；Windows 机器需实跑并回贴失败输出。


## 8. 新窗口接手（2026-08-15）

### 8.1 当前事实

- HEAD：`1593973`（第四批 e2e 补齐）+ 本窗口第五批改动未提交；`e0b9086` 起至 `1593973` 的 9 个提交均未 push，工作树含第五批 diff。
- 已实现能力：launch/connect/discover/targets/attach、navigate/back/forward/reload、snapshot(AX 优先 + iframe/shadow/accessible-name 回退)/content/inspect/report/console/network(按 requestId 配对)/network_detail/network_har(HAR 1.2 文件导出)/screenshot(fullPage,inline)/audit/status/wait、click/hover/type(replace)/select/upload/dialog/press(modifiers)/scroll/viewport/eval、new_tab/close_tab；launch 支持 headless/windowSize/profile(具名持久 profile)/proxy/proxyBypass；新增 cookies(list/set/delete)、sessions、switch_session 多账号 slot 隔离/切换。`find_chrome` 与 `cdp_discover` 跨平台。
- 本机验证（Linux）：`cargo check --tests` 通过；`npx tsc --noEmit`、`npm run build` 通过；vitest（browser-tools/domains-convergence/define-tool/browser-snapshot-probe）55/55；`cargo test cdp::` 32/32（5 个真实 Chrome e2e 本机无 Chrome 跳过）；全量 `cargo test` 275 passed / 8 failed（8 个历史环境失败，数量未增加）。

### 8.2 开局清单

1. `git fetch` / `git pull` 到 `fec19fe`（或让用户 push 后拉取）。
2. 当前条件：无 Windows 真机。可跑保障 = `cargo check --tests`、`npx tsc --noEmit`、vitest（browser-tools/domains-convergence/define-tool/browser-snapshot-probe）；内存充足时补 `cargo test cdp::` 与全量 `cargo test`（确认仍是 8 个历史失败）。E2E-1/2/3/4 自动跳过是已知未验证项，不是失败。
3. 将来有 Windows 环境时：`cd src-tauri && cargo test cdp:: -- --nocapture` 实跑 E2E-1/2/3/4/5；重点看 E2E-5 的具名 profile A/B cookie 隔离、switch、set/list/delete，以及 E2E-4 的 headless/windowSize、discover、network 配对/详情、HAR 导出、AX snapshot、viewport，失败输出贴回。
4. 第四批已完成；第五批代码已在工作树，review 后 commit。若继续做 eval 隔离 world（可选），先跑第 2 条。

### 8.3 第三批任务（✅ 已落地，`2c8376a`）

1. ✅ network 配对：observer 内 `requestId -> entry` 映射，`Network.responseReceived` 回填同条记录 status，`loadingFailed` 不再把 requestId 塞进 url；`browser_network` 输出成对记录。
2. ✅ `browser_network_detail(requestId)` 已做；HAR 作为后续导出项。
3. ✅ AX snapshot：优先 `Accessibility.getFullAXTree`，失败回退增强 `snapshot.js`（accessible name、aria-labelledby、iframe 递归、shadow DOM 穿透）。
4. ✅ `browser_launch` 增加 `headless` / `windowSize`；`Emulation.setDeviceMetricsOverride` 留后续。

### 8.4 后续批次

- 第四批：✅ 已落地（跨平台、轮转清理、HAR、viewport、`cdp.rs` 四模块拆分）。
- 第五批：✅ 已落地（cookie list/set/delete、launch profile/proxy/proxyBypass、多账号 slot 隔离/切换、E2E-5）。
- 剩余可选：eval 隔离 world。

### 8.5 踩坑速记（务必读）

- **不要跑 `cargo fmt --all`**：会把全仓库历史未格式化文件一起刷掉，diff 爆炸；只对当前改动文件做 `rustfmt --check` 或保持现有风格。
- `cargo check/test` 可能把 `src-tauri/Cargo.lock` 的 hologram 版本从 10.0.1 改成 10.1.0；提交前 `git checkout -- src-tauri/Cargo.lock`。
- `find_chrome` 现在有各平台固定路径 + PATH 兜底；Linux 没有 Chrome 时 e2e 设计为跳过，不是测试挂了。
- e2e 端口：9444 外部实例、9445 launch、9446 round2、9447 round3（headless/network/AX）、9448/9449 round5（多账号 A/B）；新增 e2e 端口避开 9222/9223-9238 和这六个。
- `Page.setInterceptFileChooserDialog` 只在非 self 会话开启，self（9222）是只读通道，不要把文件选择框拦截加回 self。
- 新增工具 schema 的 key 用 camelCase，Rust 参数用 snake_case；`bridge.rpc` 是唯一转换枢纽，不要手写 schema 绕过 `defineTool`。
- 领域工具顶层 `action` 会被 domains.ts 剥掉；领域动作内部的子命令参数不要叫 `action`（第五批 `browser_cookies` 因此用 `op`）。
