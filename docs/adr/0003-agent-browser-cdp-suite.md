# ADR 0003: Agent 浏览器控制套件 —— 目标形态与核心决策

## 背景

- 2026-08-12 `e6fa9d2` 落地 browser 领域工具初版：CDP 双通道（target=self 走 webview 内直读探针 / 外部页面走 Rust CDP），12 个动作。
- 评审（2026-08-13）结论：方向正确，但存在端口冲突、调用无超时、全局单例会话、探针代码分叉等结构问题。
- 本文档定调套件的**目标形态**，并记录每条决策的理由。落地分期见 `docs/plans/browser-cdp-suite-plan-2026-08-13.md`。

## 总纲

初版是「发命令的管道」：Agent 给一个 selector，后端执行，返回一行结果。
目标形态是「有状态的世界」：Agent 先**看**（快照），再**动**（引用快照里的元素），
每次动完**世界会告诉它发生了什么**（反馈 + 错误日志）。前者靠猜，后者靠看。

## 决策

### D1 会话按 agent 键控，废弃全局单例

现状：`CdpSession` 是进程级单例（port / target_id / chrome_child 全局共享）。
多 Agent 并发时 attach 互踩、kill 互相误杀。

**决定**：`SESSION` 改为 `HashMap<agent_id, CdpSession>`，CDP 命令路由到发起 Agent
自己的会话；主 Agent 与子 Agent 天然隔离。

**否决**：给单例加锁串行化——治标，多 Agent 是本项目常态架构。

### D2 快照 + ref 是默认交互范式，selector 降级为高级参数

现状：模型手写 CSS selector（click / inspect / type 都要）。selector 猜不准、
DOM 一改就失效，是最高频失败源。

**决定**：新增 `snapshot` 动作——返回可交互元素紧凑清单（tag / role / 文本 / ref）
并对元素打持久标记 `data-hg-ref`；click / type / scroll 引用 ref；ref 失效时
返回可恢复错误（「页面已变化，请重新 snapshot」）。selector 保留为深度检查参数。

**参照**：browser-use、Google Chrome DevTools MCP 均采用快照 + 引用范式。

**代价**：探针会在目标页面 DOM 上打标记（轻微污染，截图 / 快照需识别并接受）。

### D3 持久连接 + 事件缓冲，废弃短连接

现状：每条命令开一条 WS、用完即关。实现简单，但拿不到事件流。

**决定**：每会话一条持久 WS，后台任务订阅 `Runtime.consoleAPICalled` /
`Log.entryAdded` / `Network.*` / `Runtime.exceptionThrown`，缓冲到环形队列；
新增 `console` / `network` 查询动作。这是前端调试的刚需：Agent 改完 UI
能问「刚才这一下报了几个错、哪个请求挂了」，而不是只看 report 的数字。

**代价**：失去短连接的无状态简单性，要处理重连与心跳。

### D4 self 与 external 统一走 CDP，废弃双探针

现状：两份探针代码（Rust 内嵌 JS 字符串 + TS `dom-probe.ts`），声称同构、
实际已漂移（`8709738` 的语法 bug 只存在于 Rust 版）。

**决定**：target=self 即 attach 到 webview 自己的调试端口；探针代码单一来源
（独立 `.js` 文件，`include_str!` 嵌入）；TS 侧只留类型与工具定义。

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

## Consequences

- 短连接的「无状态简单性」失去，换来可观测性——browser 会话与 shell 后台任务
  同样需要生命周期管理（连接、租约、清理）。
- webview 调试端口（9222）从「调试后门」升格为正式接口；受控 Chrome 默认端口
  必须与其严格分离（9223 起，占用自动递增）。
- 探针打 `data-hg-ref` 会轻微污染页面 DOM；与 D5 的 actionability 判定同属
  「探针介入页面」的既定代价，参照 browser-use 接受。
