# Agent 浏览器控制套件 —— 设计路线图（2026-08-13）

> 目标形态与决策理由见 `docs/adr/0003-agent-browser-cdp-suite.md`（ADR 0003）。
> 本文档给出落地分期。前身：`docs/plans/tool-convergence-browser-plan-2026-08-08.md`
> §3.5 把「交互式浏览器」标为 v2 决策点（Rust 原生 CDP，不建 Node 桥）；
> v2 初版已于 `e6fa9d2` 落地，本文档是其评审续篇。

## 0. 现状盘点（对照 ADR 决策）

| ADR 决策 | 现状 | 差距 |
|---|---|---|
| D1 会话键控 | 全局单例（cdp.rs `SESSION`） | 重构为 `HashMap<agent_id, …>` |
| D2 快照 + ref | 无 snapshot，全靠手写 selector | 新增 snapshot 动作 + 探针打标 |
| D3 持久连接 | 短连接（`ws_command`） | 重写客户端 + 事件缓冲 |
| D4 统一后端 | 双探针（cdp.rs 内嵌 + dom-probe.ts） | 探针抽 .js 文件；self 改走 CDP |
| D5 等待反馈 | 裸派发 + 返回 `"clicked"` | actionability 等待 + 世界变化反馈 |
| D6 安全三级 | attach 一次批准全权 | 敏感目标判定 + 分级 Ask |
| D7 探针验证 | 无（8709738 教训） | 独立文件 + 测试跑 node --check |

## 1. P0 —— 不炸（评审 bug 修复清单）

只碰 `src-tauri/src/cdp.rs`、`rpc.rs`、`tools/mod.rs`、新增 `cdp/probes/`。
不碰 TS 工具面（P0-6 选方案 B 时除外，见下）。

| # | 问题 | 修法 | 验收 |
|---|---|---|---|
| P0-1 | 受控 Chrome 默认端口 9222 与 webview 调试端口冲突 | 默认 9223 起，检测占用自动 +1 | 起 HoloGram 后 launch 默认端口，targets 不含 webview 页面 |
| P0-2 | CDP 调用无超时，页面死循环挂死 Agent | `Runtime.evaluate` 加 `timeout: 5000`；`ws_command` 整体 `tokio::time::timeout` 10s | `browser(eval, "while(true){}")` 5s 内返回超时错误，Agent 不挂 |
| P0-3 | `CdpSession` 全局单例 | 按 agent_id 键控（D1 最小形态） | 两个 Agent 各自 attach、各自 kill，互不影响 |
| P0-4 | 探针语法无回归防线 | 探针抽 `cdp/probes/*.js` + `include_str!`；cargo test 内置用例提取全部探针跑 `node --check` | 探针改出语法错，cargo test 必红 |
| P0-5 | attach Ask 文案未告知后果 | 文案写实（D6）：批准后可在该页面执行点击/输入等任意操作 | 弹窗文案含「点击/输入等任意操作」 |
| P0-6 | press 单字符在输入框不生效 | 方案 A：单字符分支补 `text` 参数；方案 B：描述删单字符承诺。**选 A**（删能力比修能力差） | 受控 React 输入框内 press "a" 出现字符 |
| P0-7 | find_chrome 候选重复；attach 允许 URL 当 id 匹配 | 候选去重；attach 只收 target id，URL 传入返回明确错误 | 代码无重复常量；URL 当 id 报「target 不存在」 |
| P0-8 | browser_kill 在 rpc 层无权限检查 | 补 `check_permission`，与 launch 对称 | kill 走权限引擎，工具级 Deny 生效 |

**验收总则**：`cd src-tauri && cargo test` 全绿（含新增探针语法用例）、
`cd src-ui && npx tsc --noEmit` 干净、browser-tools vitest 不回归；
真实启动一次 launch → targets → attach → inspect 冒烟。

## 2. P1 —— 好用

1. **snapshot + ref（D2）**：探针收集可交互元素 → 紧凑清单（tag / role / 文本 / ref）→
   打 `data-hg-ref` 标记；click / type / scroll 收 ref 参数；ref 失效错误带恢复指引
   （「页面已变化，请重新 snapshot」）。
2. **操作反馈（D5）**：actionability 等待（可见 / 位置稳定 / 可交互，默认 5s 超时）；
   操作后返回 {url 是否变化, DOM 突变数, 新 console 错误摘要}。
3. **console / network（D3）**：持久 WS + 环形缓冲；`browser(console)` / `browser(network)`
   查询最近 N 条；错误摘要并入操作反馈。
4. **验收**：Agent 在真实任务里用 snapshot → click(ref) → console 完成一次
   「改 UI → 自查渲染 → 看报错」闭环，全程不手写 selector。

## 3. P2 —— 完整

1. **截图**：`Page.captureScreenshot` 落盘 + 回传 base64。vision 模型可看直接闭环；
   纯文本模型下截图给用户人工确认。
2. **敏感操作分级（D6 完整形态）**：向已填值输入框 type、submit 按钮 click、
   触发下载 → 每次单独 Ask。
3. **会话生命周期（D1 完整形态）**：空闲租约 10 分钟自动 kill；Chrome 崩溃检测
   与自动重启；profile 目录定期清理。
4. **审计日志**：全部操作落盘（agent / 时间 / 动作 / 目标 / 结果摘要），
   `browser(audit)` 查询；UI 侧可选展示「Agent 刚才在浏览器干了什么」。
5. **验收**：审计日志可回放一次完整会话；租约触发实测。

## 4. 范围纪律

- 每期只动自己声称的位置；P0 不碰 TS 工具面（P0-6 方案 A 在 Rust 侧，无例外）。
- 不恢复 Node 桥方案（`tool-convergence-browser-plan` §3.4 已否决，理由不变）。
- 不改 CI；文档数字以实测为准；工具集清单变化时同步 AGENTS.md 与对应 docs。

## 5. 开放决策

| 决策 | 推荐 | 备选 |
|---|---|---|
| snapshot 打标方式 | 持久标记 `data-hg-ref`（快照时重打） | 数组索引（每步重算，DOM 一变就漂） |
| 截图通道 | base64 回传工具结果 | 只落盘给路径（模型看不到内容） |
| self 迁移节奏 | P1 与 snapshot 同批（D4 一次到位） | P2 再做（期间继续维护双探针） |
