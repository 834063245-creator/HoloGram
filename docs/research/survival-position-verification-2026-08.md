# 生存验证：P0/P1 清单凭什么让引擎在竞品格局里站住一块地

> 生成：2026-08-15 · 更新：2026-08-15（P0/P1-3 合入 `2954ecd`；P1-4 增量 stale 治理合入 `86f65d3`；P1-2 LSP 回写合入 `9c58150`）
> 用途：把「必须补齐清单」从意见变成**可验收的防守方案**。
> 问题：做完这些代办，HoloGram 到底守住了哪块地？每一条对应哪条竞品验收线？什么情况下这份清单还不够？

---

## 1. 「那块地」的精确定义（不是愿景，是可被替代品验证的空位）

**HoloGram 要占的地：AI 编程 Agent 的「改代码前问一句依赖」工作流里的默认答案。**

具体场景 = 三个动作的交叉：
- 改文件前：`trace_impact` / `preflight_check` ——「改 A 会炸什么」
- 读代码时：`search_symbols` / `get_neighbors` / `find_dep_path` ——「这个符号在哪、连着谁」
- 审架构时：`detect_cycles` / `coupling_report` / `check_boundaries` ——「这个仓的架构是不是烂的」

这块地能站住的**三条腿**（缺一不可，全部有竞品验收线）：

| 腿 | 含义 | 若断掉，谁抢走这块地 |
|---|---|---|
| **L1 空位** | 27 语言 × 免构建 × 零配置，MCP 直查 | 无巨头做这个组合（已核：安全巨头卖规则不卖图、架构老厂封闭高价、IDE 索引器锁单语言）。断掉 = 被人拆穿「广度是虚的」（语言适配坏掉/构建失败） |
| **L2 可信** | 图与工具答案的解析质量不低于同赛道标尺，且失败不静默 | codegraph/CodeGraphContext 等拼装品 + depcruise/SCIP 的解析率标尺。断掉 = Agent 用三次弃用 |
| **L3 集成** | 桌面端 + Agent 运行时 + 3D 星图 + goal/计划模式的一体化体验 | 拼装品只有 CLI/库，产品化是它们的真实工作量。断掉 = 沦为「又一个 MCP 插件」，跟长尾项目比下载量 |

**现状（2026-08-15 更新）**：L1 ✅（27 语言管线真实工作）、L3 ✅（已建成）、**L2 🟡（P0 已闭环，P1-4 增量 stale 治理已落地、P1-2 LSP 回写已落地，剩 SCIP 桥接）**。
P0 落地后，文件级依赖图在 TS 上与 dependency-cruiser 打平、Python/Rust 越过 95% 验收线，失败也不再静默；L2 的「文件级底线」已经站住，下一段风险从「不可信」转为「符号级质量仍落后 SCIP indexer」。

---

## 2. 每条代办 → 它守住什么 → 验收线 → 失败后果

| # | 代办 | 守哪条腿 | 竞品验收线（做完必须达到的数字/行为） | 不做/做砸的后果 |
|---|---|---|---|---|
| P0-1 | import 确定性路径解析（TS tsconfig paths + node_modules；Python 包路径/相对导入；Rust use/mod；Go module） | L2 | **TS import 解析率 ≥98%（对标 depcruise 99.9%，同一份 src-ui 实测）；Python/Rust import 解析率 ≥95%** | 文件级依赖图继续被 depcruise 单点碾压——这块地的最低档都守不住 |
| P0-2 | import 符号绑定 + 别名传播（`from x import y` / `import {a as b}` → 别名→定义映射，usage 经映射解析） | L2 | gap_probe 全绿：`US()`→UserService、`util_a.format_user`→pkg_a.format_user（现在全丢） | 所有别名调用永久消失，calls 边解析率上不去 |
| P0-3 | 停止静默丢边：未解析边保留标 unresolved + 外部依赖建 External 节点 + graph_summary 报解析率 | L2 | **任何工具结果可回答「建立在解析率 X% 的图上」；node_modules/std 库依赖在图里可见** | 信任崩塌的主因——用户发现「图上没有这条边」时已失去全部信任 |
| **P0-5（新增）** | **合成边/启发式边诚实标记与可过滤**：动态调度/框架路由/DI 反射的合成边全部 `is_synthesized=true` + provenance 元数据（现在 `dynamic_dispatch.rs:141` 误标 false），所有工具支持 `exclude_synthesized` | L2 | **合成边与解析边可区分、可过滤；合成边不再冒充真实边** | 解析修好后，合成边成为「假数据」的最大来源——React/DI 启发式污染影响面，Trust 换个位置继续崩 |
| P0-4 | 「数据流」叙事降级（改称「语法级变量使用统计」，写明无跨函数传播/无污点） | L2 | 文档与工具描述不再出现未经限定的「数据流/污点」 | 被拿 CodeQL 标准验收，一验穿帮，连带其他真能力被质疑 |
| P1-1 | SCIP 桥接（9 个官方 indexer 分档接入：Java/TS/Python/C++/Rust/C#/Ruby 等接 SCIP，冷门语言保留 tree-sitter 并标注语法近似） | L2 | **主打语言符号级引用边质量 ≥ 对应 scip-* indexer；`external_symbols` 补回库依赖节点** | 拼装品在主流语言上永远压你一头，L2 只能算「半条腿」 |
| P1-2 | LSP 结果入库（`lsp_resolved` 从死字段变活字段，resolve_call 结果回写图） | L2 | lsp_resolved=true 的边占比可统计、可追溯 | 每次查询重新起 LSP，慢到 Agent 不用 |
| P1-3 | gold-standard 解析基准（gap_probe 扩展成多语言标准答案集，CI 报 precision/recall） | **L2 的保险丝** | **每语言 precision/recall 在 CI 可见；任何解析改动不得回退** | 没有它，P0/P1 做没做对无法验证——「确保站住」变成空话 |
| P1-4 | cross_file 落库丢失 bug + 增量全局分析失效治理 | L2 | cross_file 标志落库正确；增量后耦合/社区结果带 stale 标记或重算 | 保存即刷新后图与库不一致，信任二次崩塌 |

**读表结论**：L1/L3 不需要任何新代办（已站稳）；L2 的 9 条里 6 条是 P0、3 条是 P1，**每条都直接对应一个可实测的竞品数字或可观察行为**。这份清单不是「努力方向」，是「L2 腿的修复施工图」。

### 2.1 执行状态（2026-08-15，`main` @ `9c58150`）

| # | 状态 | 实测证据 |
|---|---|---|
| P0-1 | ✅ 已落地 | gold 三语言 p0 recall 100%；src-ui import 99.9%（889/890，仅剩的虚拟 `.js` 属正确未解析）；engine/src Rust import **642/642**（本地模块 393 + 外部 crate 249，0 unresolved；续窗口补齐多级 `super` / `mod` 树 / 花括号 `use` / 裸路径后从 85.4% 到 100%） |
| P0-2 | ✅ 已落地 | gold p0 100%，`US()`→UserService、别名调用全命中；engine/src 197 bindings / 584 条引用边确定性改写（续窗口前 55/228） |
| P0-3 | ✅ 已落地 | 未解析边保留为 `unresolved:*` 占位节点；External 节点可见；`graph_summary.resolution` 诚实报解析率 |
| P0-5 | ✅ 已落地 | 33+3 处合成边 `is_synthesized=true` + provenance；`get_neighbors` 支持 `excludeSynthesized` |
| P0-4 | ✅ 已落地 | `trace_dataflow` 描述降级为「语法级启发式，非语义数据流」 |
| P1-1 | ⬜ 未开始 | 仍是 L2 最大剩余缺口：符号级引用质量对标 scip-* indexer |
| P1-2 | ✅ 已落地 | `lsp_resolved` 变活字段：resolve_call 的 LSP 解析命中回写图——图中已存在的 calls 边标记 `lsp_resolved=true`（内存覆盖层 + SQLite 单边 UPDATE + 快照持久化，重启保留）；`graph_summary.lsp_resolution` 报占比（calls 边总数 / lsp_resolved 数 / 占比），边输出带 `lsp_resolved` 逐边可追溯；只标记真实存在的边，不凭空造边 |
| P1-3 | 🟡 基准已落地，CI 门禁未接 | `scripts/bench_resolution.py --all` 三 fixture p0 100% / p03 100% / precision 100%；尚未接入 CI |
| P1-4 | ✅ 已落地 | `cross_file`/`metadata` 已贯通 CSR→SQLite→快照→增量并落库可读回（imports 边 100% 落库）；增量后耦合深度全量重算，社区结果带 stale 标注——漂移计数持久化 meta 键 `incr_since_full`（重启保留），`get_community`/`cluster_report` 结果带 `staleness` 结构化标记 + MCP `_stalenessBanner`，全量重分析后归零 |

---

## 3. 什么情况下这份清单还不够（诚实风险清单）

以下情况发生时，做完 P0/P1 也守不住地——需在对应触发条件出现时升级为 P0：

| 风险 | 触发条件 | 应对（预置，不临场想） |
|---|---|---|
| **拼装品突然补上广度** | codegraph 类项目语言数过 15 | 它们在广度上无历史包袱但每语言都要修解析——HoloGram 的应对是 SCIP 桥接让主流语言质量持平、tree-sitter 兜底守住长尾；若被超越，差异化只剩 L3 集成，需立刻评估被并购/换定位 |
| **巨头下场**（GitHub/JetBrains 官方 MCP 图谱） | 出现官方「repo 图谱 MCP」产品 | 不可正面对抗：把 L3（桌面端工作台 + goal 体系）作为主卖点，L1 广度作为兼容层，考虑与 SCIP 生态结盟而非竞争 |
| **Agent 工作流不成立**（LLM 习惯直接 grep/读文件，图谱查询未成为刚需） | 用户留存数据显示图工具调用率持续低 | 这不是工程能救的：需要产品验证（landing 场景、模板化工作流）。P0 完成后第一优先级是找 5 个真实用户跑「改前问影响面」闭环，而非继续加工具 |
| **解析修好后质量仍被 diss** | 基准达标但用户仍报告错误边 | 回到 P0-3：把「错误边可报告」做成产品能力（点边看 why + 反馈回写），信任从「零错误」转为「可解释」 |

**最重要的一条诚实结论**：这份清单能保证的是「**工程上不再输在起跑线**」——做完后 HoloGram 在 L2 腿上的表现与任何同赛道者相比，有可辩护的持平或优势证据。它**不能**保证市场成立（Agent 图查询是否成为刚需），那是产品验证的事，不是静态分析的事。

---

## 4. 验收闭环：把「确保」变成机器可执行的判据

「确保站住」不能靠再读一遍报告，靠 CI 里的数字。截至 2026-08-15 的执行进度与剩余 exit criteria：

1. ✅ **P1-3 先行（基准先于修复）**：gap_probe 已扩展到 TS/Rust/Python 三语言，`scripts/bench_resolution.py --all` 可复现实测。
2. ✅ **P0-1 → P0-2 → P0-3 → P0-5**：已合入 `main`；gold p0 100% / p03 100% / precision 100%，TS 99.9%、Rust 100%，均越过目标线。
3. 🟡 **真实项目回归**：src-ui（TS）与 engine/src（Rust）已实测达标；**剩余 = 把 `bench_resolution.py` 接进 CI 门禁**。
4. ⬜ **P1-1**：接入 scip-* indexer，用同一份标准答案集对比「SCIP 桥接边」vs「tree-sitter 边」的精度差，写进决策记录（为什么分档）。
5. ✅ **P1-2**：`lsp_resolved` 从死字段变活字段，resolve_call 结果回写图——calls 边标记 + 落库 + 快照持久化，`graph_summary.lsp_resolution` 占比可统计、逐边可追溯。
6. ✅ **P1-4**：`cross_file`/`metadata` 落库已修复；增量 stale 治理已落地——增量后耦合深度全量重算、社区结果带持久化 stale 标注（meta `incr_since_full`，重启保留；全量重分析归零）。
7. ⬜ **产品验证（非工程）**：P0 完成后，用 5 个真实用户 ×「改前问影响面」场景测留存——这一步的结果决定 P1 的投资节奏。

---

## 5. 一句话

你要的不是「做到最好」的清单，是「**L2 腿不断**」的清单。上面的表已经把每条代办钉在了具体的竞品数字上：**P0 已交付——文件级依赖图在 TS 上与 depcruise 打平、Python/Rust 达标、失败不静默，工程底线已站住**。剩下的 P1 决定符号级引用能不能与拼装品打平；在此之上，「能不能把地守住」剩下的是执行与产品验证，而不是还有没有漏掉的关键工程项。
