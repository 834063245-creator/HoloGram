# Browser CDP 套件二轮评审 + 改进计划

> 状态：评审完成，待开工（第一批代码改动未开始）
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
| 文档 | 本文件 + ADR 0003 落地状态追加一节 |

第二批候选（暂不动）：dialog + upload + hover + 组合键 + 截图 inline/fullPage。
第三批候选：network 配对 + AX snapshot + 跨平台 + cdp.rs 拆分。

## 5. 基线命令（改代码前请先跑，留底）

```powershell
cd D:\HoloGramHG\src-tauri
cargo test

cd D:\HoloGramHG\src-ui
npx tsc --noEmit
```

若基线本来有失败项，把输出贴回，避免把历史失败和新改动混淆。

## 6. Preflight 风险数据（Hologram，改前快照）

- 计划改动文件全部为 **high** blast radius：
  - `cdp.rs`：blast_radius 127,134，direct_nodes 108
  - `rpc.rs`：blast_radius 27,126，direct_nodes 14
  - `tools/mod.rs`：blast_radius 10,522，direct_nodes 14
  - `browser.ts`：blast_radius 5,573，direct_nodes 9
- `cdp.rs` 耦合报告：L1 321 / L3 1258 / L4 884 / total 2463，fragility 3.0
- 全仓库 unlocked concurrent writes：**0**
- 结论：每批改动必须小步、可编译、可单测；禁止一批同时改传输层和工具面。

## 7. 工作协议（针对当前 bash 工具不可用）

1. 由 Claude（我）用 `str_replace_editor` 改代码；
2. 每批改完，由用户（你）在机器上跑：
   - `cd src-tauri && cargo test`
   - `cd src-ui && npx tsc --noEmit`
3. 把失败输出贴回来，我修到全绿；
4. 全绿后再进下一批，不进则 rollback（git 留档）。
