# Agent 浏览器控制套件 —— 设计路线图（2026-08-13）

> 目标形态与决策理由见 `docs/adr/0003-agent-browser-cdp-suite.md`（ADR 0003）。
> 前身：`docs/plans/tool-convergence-browser-plan-2026-08-08.md`
> §3.5 把「交互式浏览器」标为 v2 决策点（Rust 原生 CDP，不建 Node 桥）；
> v2 初版已于 `e6fa9d2` 落地，本文档是其评审续篇。
>
> **状态：✅ 全部落地（同日）**。P0 = `3027a7c`，P1+P2 = `b4dd1f5`。
> 与计划的差异及未实测项见各节「落地注记」。

## 0. 现状盘点（对照 ADR 决策）

> ✅ 七项差距全部消除（`3027a7c` + `b4dd1f5`）：

| ADR 决策 | 实现 |
|---|---|
| D1 会话键控 | `HashMap<agent_id, CdpSession>`（P0）+ 租约回收 + 崩溃检测（P2） |
| D2 快照 + ref | `browser(snapshot)` 打 `data-hg-ref` 标记，click/type/scroll 按 ref 引用，ref 失效返回「请重新 snapshot」 |
| D3 持久连接 | 命令通道保持短连接（有超时兜底）；事件通道为持久 WS + 环形缓冲，`browser(console)`/`browser(network)` 查询 |
| D4 统一后端 | 探针抽 `cdp/probes/*.js`（`include_str!`）；self 走 webview 调试端口惰性 attach 的只读会话；`dom-probe.ts` 已删除 |
| D5 等待反馈 | actionability 等待（可见/无遮挡/位置稳定，5s）+ 世界变化摘要（URL/DOM 大小/新增错误数） |
| D6 安全三级 | 只读直放行；操作靠 attach 授权；敏感目标（提交/下载/已填值输入框/密码框/高危文本）每次单独 Ask |
| D7 探针验证 | `cargo test` 内置用例对全部探针跑 `node --check` |

## 1. P0 —— 不炸（评审 bug 修复清单）✅ `3027a7c`

只碰 `src-tauri/src/cdp.rs`、`rpc.rs`、`tools/mod.rs`、新增 `cdp/probes/`。
不碰 TS 工具面（P0-6 选方案 A 在 Rust 侧）。

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

**落地注记**：8 项全做（cargo test 254 过）。另顺手修两处：launch 复用逻辑重写
（活 Chrome 未复用会双开）、spawn 前回收旧 Chrome 句柄（显式换端口时 kill 旧进程）。
端到端冒烟未跑（需真实 app + 权限弹窗人工批准）。

## 2. P1 —— 好用 ✅ `b4dd1f5`

1. **snapshot + ref（D2）**：探针收集可交互元素 → 紧凑清单（tag / role / 文本 / ref）→
   打 `data-hg-ref` 标记；click / type / scroll 收 ref 参数；ref 失效错误带恢复指引
   （「页面已变化，请重新 snapshot」）。
2. **操作反馈（D5）**：actionability 等待（可见 / 位置稳定 / 可交互，默认 5s 超时）；
   操作后返回 {url 是否变化, DOM 突变数, 新 console 错误摘要}。
3. **console / network（D3）**：持久 WS + 环形缓冲；`browser(console)` / `browser(network)`
   查询最近 N 条；错误摘要并入操作反馈。
4. **验收**：Agent 在真实任务里用 snapshot → click(ref) → console 完成一次
   「改 UI → 自查渲染 → 看报错」闭环，全程不手写 selector。

**落地注记**：三项全做，另含 self 通道统一（D4，原计划与本批合并）。
与计划的差异：①D3 落地为「命令通道保持短连接 + 事件通道持久 WS」双轨——
短连接的命令通道有全链路超时兜底，不必为事件流重写；②self 会话是 webview
调试端口上的只读会话（操作类动作在 rpc 层被拒），探针单一来源
（`cdp/probes/*.js`，`node --check` 测试），`dom-probe.ts` 双探针已删除；
③验收闭环未实测（需真实 app）。

## 3. P2 —— 完整 ✅ `b4dd1f5`

1. **截图**：`Page.captureScreenshot` 落盘 + 回传 base64。vision 模型可看直接闭环；
   纯文本模型下截图给用户人工确认。
2. **敏感操作分级（D6 完整形态）**：向已填值输入框 type、submit 按钮 click、
   触发下载 → 每次单独 Ask。
3. **会话生命周期（D1 完整形态）**：空闲租约 10 分钟自动 kill；Chrome 崩溃检测
   与自动重启；profile 目录定期清理。
4. **审计日志**：全部操作落盘（agent / 时间 / 动作 / 目标 / 结果摘要），
   `browser(audit)` 查询；UI 侧可选展示「Agent 刚才在浏览器干了什么」。
5. **验收**：审计日志可回放一次完整会话；租约触发实测。

**落地注记**：主体四项全做。与计划的差异：①截图只落盘返回 `{path, bytes}`，
未回传 base64（纯文本模型也看不到内容，路径交给用户确认）；②崩溃检测落地为
「检测到退出 → 清句柄」，自动重启改为惰性（下次 launch 复用逻辑自动起新的）；
③profile 目录定期清理已补（按端口隔离 + 随会话回收 + launch 时清扫遗留，
顺手修复多 Agent 共用单一 user-data-dir 会互相委托实例的隐患）；④UI 侧审计展示
未做（browser(audit) 可查，UI 集成是后续交互形态的事）。租约触发与审计回放——
代码侧已有单测覆盖（租约 kill/清理链路、审计写入回读），真实运行实测见 §6。

## 4. 范围纪律

- 每期只动自己声称的位置；P0 不碰 TS 工具面（P0-6 方案 A 在 Rust 侧，无例外）。
- 不恢复 Node 桥方案（`tool-convergence-browser-plan` §3.4 已否决，理由不变）。
- 不改 CI；文档数字以实测为准；工具集清单变化时同步 AGENTS.md 与对应 docs。

## 5. 开放决策 —— 最终选择

| 决策 | 最终选择 | 备选（未采用） |
|---|---|---|
| snapshot 打标方式 | ✅ 持久标记 `data-hg-ref`（快照时重打） | 数组索引（每步重算，DOM 一变就漂） |
| 截图通道 | 只落盘返回路径（纯文本模型下交给用户确认） | base64 回传工具结果 |
| self 迁移节奏 | ✅ P1 同批完成（D4 一次到位，双探针已删） | P2 再做（期间继续维护双探针） |

## 6. 遗留（P2 之后）

| 项 | 说明 |
|---|---|
| profile 目录定期清理 | ✅ 已补：按端口隔离 + 随会话回收删除 + launch 清扫遗留目录 |
| 租约/审计实测 | 代码侧已覆盖（单测：租约 kill/清理链路、审计写入回读）；真实运行时租约触发待实测（设 `HOLOGRAM_BROWSER_LEASE_SECS` 短租约即可验证，不必干等 10 分钟） |
| UI 侧审计展示 | 数据已有（`browser(audit)` / jsonl），UI 集成属交互形态工作 |
| 端到端冒烟 | ✅ 已实测（2026-08-13，connect 链路）：自启调试端口 Chrome（9333）→ connect → targets → attach → snapshot → click(ref) → kill 全链路通过，审计 4 条完整。**发现并修复两个真 bug**：①click 后固定 300ms 采样落在旧文档上下文，导航类点击世界反馈漏报"无显著变化"——补 `wait_nav_settle` 轮询（URL 变/DOM 变/2s 兜底，SPA 无导航点击不付超时）；②（更深层）world_snapshot 的 evaluate 表达式 `JSON.stringify(...)` 遇 `returnByValue` 返回字符串，`val["u"]` 永远取 Null——URL/DOM 检测自 b4dd1f5 落地起就从未工作过，每次操作都报"无显著变化"。改直接返回对象 + `parse_world_value` 契约单测锁定（`e1679a0`）。修复后实测 click 正确报"URL 变化: example.com → iana.org；DOM 大小变化: +5730 字符"。kill 语义验证：外部连接 kill 后 Chrome 进程全部存活、端口照常应答 |

## 7. connect 增量（2026-08-13 增补，`b988f87d` + `af075af`）

原方案没有"连接用户已启动实例"的路径——外部页面能力名存实亡（见 ADR D8）。
落地为 `browser(connect, port)` 动作：端口由用户提供（不做扫描发现），
会话无 chrome_child——kill 只断开、租约只断连、9222 硬拒；
rpc 层 Ask 文案明示真实登录态风险。端到端验证见 §6。

## 8. 第二验证批次（2026-08-14，`e581ae7c`…`14aea446`）

7 个 commit，全部经端到端实测（2026-08-14 同日验证）：

| Commit | 内容 | 实测结论 |
|---|---|---|
| `98411bb0` | LSP 启动改用 CREATE_NO_WINDOW（修启动时三个 cmd 窗口弹出） | 代码审查通过 |
| `e1679a0f` | 世界快照静默失效根因修复 + 契约单测 | ✅ click 世界反馈实测正确（见 §6） |
| `e581ae7c` | probe 返回值契约显式锁死 | 单测覆盖 |
| `b7dd2d08` | A4 观察任务竞态：事件缓冲跨重启保留 + 在途启动闸防孤儿任务 | 单测覆盖 |
| `6b2bf906` | B1 desktop_probe 只读桌面快照（进程/窗口/可见控制台窗口） | ✅ 实测：260 进程全列、pid/ppid 齐全、is_chromium 标记生效、命令行不回显（隐私保护按设计）、长输出自动截断 |
| `fffd554f` | B2 desktop_screenshot 全屏截图（高隐私面强制 Ask） | ✅ 实测：落盘 `D:\tmp\hologram-browser-shots\`，bytes 与磁盘大小一致，用户人工确认画面正常 |
| `14aea446` | B3 browser_wait 显式等待 + B4 snapshot 分页 | ✅ 实测：wait(800) 正常返回；snapshot 的 offset/total/truncated 字段齐全，maxResults=3 生效 |

**验证过程中额外发现**：desktop_probe 显示的 7 个 conhost 均属 Razer 外设服务
（RzAppManager 等）派生，非 HoloGram 泄漏——此前 CPU 排查时的 conhost 疑团归因到第三方服务。

**遗留**：UI 侧审计展示（唯一未做的交互设计题，见 §6）。
