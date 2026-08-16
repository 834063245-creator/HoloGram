# ADR 0003: Agent 浏览器控制套件 —— 目标形态与核心决策

## 背景

- 2026-08-12 `e6fa9d2` 落地 browser 领域工具初版：CDP 双通道（target=self 走 webview 内直读探针 / 外部页面走 Rust CDP），12 个动作。
- 评审（2026-08-13）结论：方向正确，但存在端口冲突、调用无超时、全局单例会话、探针代码分叉等结构问题。
- 本文档定调套件的**目标形态**，并记录每条决策的理由。落地分期史见 `docs/archive/browser-cdp-suite-plan-2026-08-13.md`；后续批次与剩余 Windows 真机 E2E 见 `docs/plans/browser-cdp-suite-review-round2.md`。

## 落地状态（2026-08-13 同日完成，08-14 二批收尾）

- P0 套件加固：`3027a7c` —— D1 最小形态（会话键控）、D7（探针独立文件 + node --check 测试）、端口分离、全链路超时。
- P1+P2 完整形态：`b4dd1f5` —— D2（snapshot+ref）、D3（事件通道持久 WS + 缓冲）、D4（self 统一走 CDP，双探针删除）、D5（actionability + 世界变化反馈）、D6（敏感目标每次单独 Ask）、截图、租约、审计。
- 后续收尾：profile 按端口隔离随会话清理、租约 env 可调（`182ecbe`）；connect 动作——连接用户已启动的调试端口实例（`b988f87d`，见 D8）；星图空闲按需渲染根治 CPU 空转（`64051fb`，与本套件无关但同期修复）。
- 第二批次（2026-08-14）：世界快照静默失效根因修复（`e1679a0`，D5 数据通道自落地起从未工作，端到端实测暴露）；probe 返回值契约锁死（`e581ae7c`）；观察任务竞态修复（`b7dd2d08`）；desktop_probe / desktop_screenshot 桌面快照工具（`6b2bf906`/`fffd554f`）；browser_wait 显式等待 + snapshot 分页（`14aea446`）。全部经端到端实测，详见路线图 §8。
- 与计划的差异与遗留项见路线图文档各节「落地注记」与 §6。
- 二轮评审第一批（2026-08-15）：补上 P0 日常任务缺口 —— `navigate` / `back` / `forward` / `reload`（Page.navigate + 导航历史）、`content`（正文提取探针 `cdp/probes/content.js`，text / markdown-lite + 字符分页）、`select`（value/option 文本匹配 + 原生 setter 派发事件）、`type(replace)`（先清空再输入）；`check_sensitive` 高危文本补英文词（Pay now / Delete / Confirm / Unsubscribe 等，Rust 与页面 JS 共用同一正则源并加单测）；rpc 层所有 `browser_*` 分支统一经过 `check_browser_permission`，`Browser=deny` 对只读/self 通道同样生效，L2 普通动作由 `BrowserTool` 统一裁决为 Passthrough。详见 `docs/plans/browser-cdp-suite-review-round2.md` §4.1。
- 二轮评审第二批（2026-08-15）：日常任务断点补齐 —— `dialog`（观察 `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog`）、`upload`（拦截 `Page.fileChooserOpened` 或 selector + `DOM.setFileInputFiles`）、`hover`、组合键 modifiers、截图 `fullPage`/`inline`、tab 管理（`/json/new` PUT 新开并自动 attach、`/json/close` 关闭；切换复用 attach）。新增对应单测、真实 Chrome e2e（本机无 Chrome 自动跳过）与 `/json/new`、`/json/close` 协议级测试。剩余批次见计划文档 §4.2。
- 二轮评审第四批第一批（2026-08-15，工作树）：跨平台 `find_chrome`（macOS/Linux 固定路径 + PATH 兜底）与 `cdp_discover`（非 Windows `ps -ax -o pid=,comm=,args=`，PowerShell/ps 输出统一解析）；审计 jsonl 按日轮转，审计/截图/HAR 目录按保留天数清理；新增 `browser_network_har`（HAR 1.2 文件导出，timing 因观察通道未采样记 -1）；`cdp.rs` 拆出 `transport.rs`（HTTP `/json` + 命令 WS/批量 WS）与 `probes.rs`（探针单一来源），又补 `browser_viewport` 落地 `Emulation.setDeviceMetricsOverride`；eval 隔离 world 为可选剩余项。
- 二轮评审第三批（2026-08-15，工作树）：观察与调试补齐 —— network 事件按 `requestId` 配对为单条 `NetworkEntry`（response 回填 status/headers，loadingFailed 回填 error 且不再污染 url）+ `browser_network_detail`；snapshot 优先 `Accessibility.getFullAXTree`（批量 resolve backendNodeId 回写 `data-hg-ref`，ref 语义不变），失败回退增强 `snapshot.js`（accessible name、aria-labelledby、same-origin iframe 递归、shadow DOM 穿透）；`browser_launch` 增加 `headless`/`windowSize` 且复用会话校验启动形态。新增 network 配对/launch 参数单测、AX 解析单测、jsdom 探针行为测试（可访问名称/iframe/shadow/ref 回写）与 E2E-4（headless + 本地 HTTP network 配对/详情 + AX snapshot）。无 Chrome 环境时 E2E-4 自动跳过，由 jsdom 测试覆盖回退探针行为。HAR 导出与 `Emulation.setDeviceMetricsOverride` 已在第四批落地。
- 二轮评审第五批（2026-08-15，工作树）：身份与多账号 —— session key 从 agent 扩展为 `agent + slot`（`ACTIVE_SLOTS` 记录每 agent 的活跃账号）；`browser_launch(profile)` 创建具名持久 profile（目录保留、cookie/登录态跨 kill/重启复用）并支持 `proxy`/`proxyBypass` 启动参数；`browser_sessions` 列出内存 slot + 磁盘上已存在的具名 profile，`browser_switch_session` 在同时存活的多个账号实例间切换（被切走的 Chrome 不立即关闭，租约独立计时）；`browser_cookies(op: list|set|delete)` 落地 `Network.getCookies`/`setCookie`/`deleteCookies`，list 只读、set/delete 走 L3 Ask。新增 E2E-5（账号 A/B cookie 隔离 + switch + set/list/delete，无 Chrome 跳过）与 slot 名校验/session key 隔离/proxy 参数单测。

## 总纲

初版是「发命令的管道」：Agent 给一个 selector，后端执行，返回一行结果。
目标形态是「有状态的世界」：Agent 先**看**（快照），再**动**（引用快照里的元素），
每次动完**世界会告诉它发生了什么**（反馈 + 错误日志）。前者靠猜，后者靠看。

## 决策

### D1 会话按 agent 键控，废弃全局单例

现状：`CdpSession` 是进程级单例（port / target_id / chrome_child 全局共享）。
多 Agent 并发时 attach 互踩、kill 互相误杀。

**决定**：`SESSION` 改为 `HashMap<agent_id, CdpSession>`，CDP 命令路由到发起 Agent
自己的会话；主 Agent 与子 Agent 天然隔离。第五批进一步把 key 扩展为
`agent + slot`：同一 Agent 可同时持有多个账号 profile（cookie/登录态互相隔离），
通过活跃 slot 路由后续动作。

**否决**：给单例加锁串行化——治标，多 Agent 是本项目常态架构。

### D2 快照 + ref 是默认交互范式，selector 降级为高级参数

现状：模型手写 CSS selector（click / inspect / type 都要）。selector 猜不准、
DOM 一改就失效，是最高频失败源。

**决定**：新增 `snapshot` 动作——返回可交互元素紧凑清单（tag / role / 文本 / ref）
并对元素打持久标记 `data-hg-ref`；click / type / scroll 引用 ref；ref 失效时
返回可恢复错误（「页面已变化，请重新 snapshot」）。selector 保留为深度检查参数。

**参照**：browser-use、Google Chrome DevTools MCP 均采用快照 + 引用范式。

**代价**：探针会在目标页面 DOM 上打标记（轻微污染，截图 / 快照需识别并接受）。

### D3 命令/事件双轨：命令通道短连接，事件通道持久 WS + 缓冲

现状：每条命令开一条 WS、用完即关。实现简单，但拿不到事件流。

**决定**（落地形态）：命令通道保持短连接（有全链路超时兜底，无状态简单性保留）；
事件通道在 attach 后起一条持久 WS 后台 task，订阅 `Runtime.consoleAPICalled` /
`Log.entryAdded` / `Network.*` / `Runtime.exceptionThrown`，缓冲到环形队列；
新增 `console` / `network` 查询动作。这是前端调试的刚需：Agent 改完 UI
能问「刚才这一下报了几个错、哪个请求挂了」，而不是只看 report 的数字。

**代价**：事件通道有状态——用 alive 标志 + 惰性重启处理（观察 task 随 target
消失退出，下次命令发现 alive=false 且 target 还在时重启），不引入心跳协议。

### D4 self 与 external 统一走 CDP，废弃双探针

现状：两份探针代码（Rust 内嵌 JS 字符串 + TS `dom-probe.ts`），声称同构、
实际已漂移（`8709738` 的语法 bug 只存在于 Rust 版）。

**决定**：target=self 即 attach 到 webview 自己的调试端口（惰性 attach 的只读会话，
操作类动作在 rpc 层被拒）；探针代码单一来源（独立 `.js` 文件，`include_str!` 嵌入）；
TS 侧只留工具定义（`browser.ts`），DomProbe 接口与 `dom-probe.ts` 已删除。

**代价**：self 从「零 RPC」变成「本地 WS 往返」（<10ms，对 Agent 无感），
换来一份代码、一套行为，快照 / console 等高级能力 self 同样可用。

**否决**：继续双探针 + 同步测试——两份代码的漂移只能靠纪律防，不如从结构上消灭。

### D5 操作自带等待与反馈

现状：click = 算坐标 + 打事件，返回 `"clicked"`。模型要自己 sleep、自己猜效果。

**决定**：操作前做 actionability 检查（可见 / 位置稳定 / 可交互，默认 5s 超时）；
操作后返回世界变化（URL 是否变化、DOM 突变数、新 console 错误摘要）。

**参照**：Playwright 的 actionability 判定。

### D6 安全三级分层 + 审计

现状：attach 批准一次 = 页面内任意操作，Ask 文案未告知后果。

**决定**：
- L1 只读（snapshot / inspect / console / network / status）：直接放行；
- L2 普通操作（click / scroll / press / type 非敏感目标）：attach 时批一次，
  Ask 文案写实——「批准后 Agent 可在该页面上执行点击 / 输入等任意操作」；
- L3 敏感操作（向已填值输入框打字、submit 按钮、触发下载、eval）：每次单独 Ask。
- 全部操作写审计日志（agent / 时间 / 动作 / 目标 / 结果摘要），`audit` 动作可查。

### D7 探针 JS 独立成文件，构建期强制语法验证

现状：探针是 Rust raw string，语法错误要运行时注入页面才发现（`8709738` 教训）。

**决定**：探针拆到独立 `.js` 文件（`cdp/probes/*.js`），`include_str!` 嵌入；
`cargo test` 内置用例提取全部探针跑 `node --check`，改探针必过语法。

### D8 connect：连接用户已启动的调试端口实例（2026-08-13 增补）

现状：launch 只能操作「自己生的孩子」；用户手动开了调试端口的浏览器
（Chrome/Edge/Electron 等）Agent 无路可连——外部浏览器能力名存实亡。

**决定**：新增 `connect(port)` 动作。端口由用户提供，不做本机端口扫描发现
（扫到的无法确认归属，还可能碰到用户日常浏览器，安全边界不清）。
会话无 `chrome_child`：kill 只断开不杀进程、租约到期只断连、profile 不涉及。

**增补（同日）**：端口"由用户提供"对普通用户不成立——用户不会知道调试端口。
补 `discover` 动作：查系统进程表（命令行中的 `--remote-debugging-port` 参数），
列出本机所有开了调试口的实例及页面清单，用户从清单里选，`connect(port)` 跟进。
进程表查询是唯一可靠特征（Electron 应用进程名各异，不限定进程名）；
只读放行（工具级 Deny 仍生效），自家 webview（9222）过滤。

**代价**：连接的是用户真实登录态——rpc 层 Ask 文案比 attach 更重
（明示 Cookie/登录态风险）；9222 硬拒（自家 webview 走 self 只读通道）。

## Consequences

- 命令通道保留短连接的无状态简单性；事件通道新增的持久 WS 与会话
  同样需要生命周期管理（alive 标志、惰性重启、租约清理）。
- webview 调试端口（9222）从「调试后门」升格为正式接口（self 只读会话的通道）；
  受控 Chrome 默认端口必须与其严格分离（9223 起，占用自动递增，显式 9222 硬拒）；
  外部实例 connect 同样拒 9222。
- 探针打 `data-hg-ref` 会轻微污染页面 DOM；与 D5 的 actionability 判定同属
  「探针介入页面」的既定代价，参照 browser-use 接受。
