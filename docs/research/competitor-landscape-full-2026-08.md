# 代码图谱领域全量竞品地图：四十年技术史 + 巨头威胁模型

> 生成：2026-08-15 · 第二波扩展调研（第一波 12 工具见 `engine-gap-analysis-vs-established-tools-2026-08.md`）
> 四份基线报告（本报告的全部细节来源）：
> - `external-deep-analysis-tools-baseline-2026-08.md`（CodeQL/Semgrep/SonarQube/Snyk Code）
> - `external-sast-giants-baseline-2026-08.md`（Coverity/Fortify/Checkmarx/Klocwork/PVS-Studio/Joern/WALA/Soot/DOOP/Infer 等）
> - `architecture-governance-tools-baseline-2026-08.md`（NDepend/CAST/Axivion/Lattix/Teamscale/FAMIX/Moose/ctags 等）
> - `code-intelligence-indexer-ecosystem-2026-08.md`（Sourcegraph/SCIP/ctags/Zoekt/clangd/importlab/PyCG/tree-sitter 生态）
> 本文把竞品池扩展到 **35+**，并回答两个战略问题：
> ① 这个领域四十年的发展沉淀出了什么「定律」？
> ② 巨头挡在前面，到底挡住了什么、没挡住什么？
> 历史日期由并行调研子代理核对；未核实的以「~」标记。

---

## 一、四十年技术史：五代工具（时间线）

### 第一代：符号索引器时代（1979–1990s）——「广度用正则换来的」

| 年份 | 事件 | 意义 |
|---|---|---|
| ~1979 | **ctags**（主作者 Ken Arnold，Bill Joy 写 Pascal 支持；BSD） | 符号索引的起点：几十种语言、正则/轻解析、无作用域、无类型。**广度换深度的最早 tradeoff。** |
| ~1980s 初 | **cscope**（贝尔实验室） | C 专用 xrefs：定义/引用/调用者交互查询。「代码图谱」的用户心智从此建立：**对着符号问「谁调用、谁定义」**。 |

这一代奠定了「符号索引 + 交叉引用查询」的产品形态，但也埋下伏笔：**纯正则索引在同名/作用域上必然出错**，这个问题四十年后依然是 HoloGram 的 P0。

### 第二代：逆向工程与软件可视化时代（1990s）——「把架构画出来」

| 年份 | 事件 | 意义 |
|---|---|---|
| ~1992 | **Rigi**（Müller，维多利亚大学） | 逆向工程 + 架构可视化 + 图聚类（子系统识别）的学术源头。 |
| ~1996 | **Bauhaus**（斯图加特大学）→ 2005 分拆 **Axivion**（2022-08 被 Qt 收购） | 架构恢复 + 架构一致性验证（architecture conformance），后商业化做 ISO 26262 合规。**「图 + 规则门禁」模式的最早玩家之一。** |
| ~1990 | **CAST**（巴黎创立） | 从逆向工程起家，最终做成企业「应用智能」平台（数十万美元级）。 |
| 1990s | **Imagix 4D** 等 | C/C++ 代码可视化商业工具。 |

沉淀出的定律：**可视化只有建立在可靠的解析之上才有价值**；Rigi 的图聚类想法被后来的社区检测继承。

### 第三代：架构治理与度量时代（2000s）——「图 + 度量 + 规则 + CI 门禁」

| 年份 | 事件 | 意义 |
|---|---|---|
| ~1996 | **SciTools Understand** | 逐语言手写解析器 + 关系库 + 20+ 度量（圈复杂度/Halstead/耦合），活到今天。 |
| ~2004 | **NDepend** | .NET 依赖图 + **CQLinq**（对依赖图的 SQL 式查询语言）+ 规则库。**「依赖图上的可编程查询」这个产品形态四十年前就有人卖了。** |
| ~2004 | **Lattix** | DSM 依赖结构矩阵 + 分区算法做架构治理。 |
| ~2004 | **Structure101** | 架构/复杂度治理；**2024-10 被 SonarSource 收购**，技术并入 Sonar 生态。 |
| 2000s | **Sonargraph（hello2morrow）** | 架构 DSL + 质量门。 |
| ~2009 | **Teamscale（CQSE，慕尼黑工大分拆）** | 架构分析 + **增量分析学术血统**（Findings 模型），证明「增量正确性」是可用性硬门槛。 |
| ~2008 | **SonarQube** | 把质量门做进 CI，40+ 语言规则，百万行级部署。 |

沉淀出的定律：
1. **用户要的不是图，是规则和图上的门禁**（allowed/forbidden/架构一致性/环禁令）——dependency-cruiser、jQAssistant、Axivion、NDepend 殊途同归。
2. **度量是图的增值层**：扇入扇出/圈复杂度/耦合/内聚必须可编程、可门禁。
3. **查询语言是刚需**：NDepend 的 CQLinq 证明「固定菜单工具不够，用户要写查询」。

### 第四代：语义分析时代（2000s–2020s）——「编译器和格理论进场」

| 年份 | 事件 | 意义 |
|---|---|---|
| ~1996 | **Soot**（McGill/Sable） | Java 三地址 IR（Jimple）+ SPARK points-to，25+ 年学术框架。 |
| ~2002 | **Coverity**（斯坦福分拆） | 商业 SAST 巨头：过程间路径分析 + 卫星 SAT 求解，语言多、闭源、企业级定价。 |
| ~2003 | **Fortify** | 商业 SAST 巨头，Dataflow Analyzer，几十语言。 |
| ~2003 | **WALA**（IBM） | Java/JS 调用图 + points-to 学术框架，几十年血统。 |
| ~2006 | **Semmle → CodeQL** | Datalog 家族 QL：extractor 建关系库，声明式递归查询——「代码数据库」概念成立。 |
| ~2014 | **DOOP + Soufflé** | 声明式 points-to（Datalog 求解），证明**指向分析可以做到高精度且引擎通用**。 |
| ~2014 | **Sourcetrail** | Clang/Java/Python 深度 indexer + 最好的交互依赖图；**2021 停更**——单团队做多语言语义解析撑不住。 |
| ~2015 | **Infer（Meta 开源）** | 分离逻辑过程间分析，大规模落地（10 亿行级扫描）；2026 仍活跃（v1.3.0，2026-05），「停更」传闻不实。 |
| ~2019 | **Joern 开源（Apache-2.0，血统：Yamaguchi 2014 IEEE S&P CPG 论文）** | **代码属性图（CPG）**：AST+CFG+PDG 统一成图 + 可编程查询（Scala DSL/Cypher），C/C++/Java/二进制/JS/Python/Kotlin；**免构建、图完全暴露、几乎日更（2026-08-14 仍在发版）**。与 HoloGram 结构最接近的活跃开源图谱。 |
| ~2016 | **Kythe** | VName 全局符号命名 + xrefs 引用图；2024 美团队被裁、降维护——**证明「编译器级图谱」的维护成本连 Google 都想收手**。 |
| 2020 | **Snyk 收购 DeepCode** | 「语义图 + 符号执行 + ML」商业化，免构建跨文件，~17 语言。 |

沉淀出的定律（本领域四十年最重要的三条）：
1. **提取定律：严肃工具的解析层最终都走向「编译器级」**——Coverity/Fortify 自研语义引擎，CodeQL 用编译器前端，Sourcetrail 用 Clang，Kythe 用编译器钩子，Glean/SCIP 用语言服务器。**没有一家靠纯语法解析活到「可信」这档。**
2. **图存储定律：图必须落在可查询存储里**（CodeQL 关系库 / Joern overflowdb / Glean RocksDB / Understand .und / jQAssistant Neo4j）。图不是画出来的，是查出来的。
3. **广度-深度定律：四十年没人同时赢下两维。** ctags 广度赢了、深度为零；Sourcetrail 深度赢了、4 语言且停更；CodeQL 11 语言但编译型需构建；Sonar 40+ 语言但规则化、不暴露图。**每一家都在广度×深度×免构建×可查询四象限里选了自己的一个角。**

### 第五代：平台化 + LLM 时代（2018–2026）——「索引一次、查询万次」与「LLM 当查询接口」

| 年份 | 事件 | 意义 |
|---|---|---|
| ~2018 | **LSIF**（语言服务器索引格式） | 编译器语义输出标准化第一次尝试。 |
| 2019– | **tree-sitter 全面普及**（GitHub/Neovim/Semgrep/Zed 采用） | 语法解析层商品化：免费、增量、容错、几百语言。**语法解析不再是壁垒。** |
| 2021 | **Glean 开源（Meta）** | Datalog 风格 Angle + 数十亿 facts monorepo 索引。 |
| 2021–22 | **stack-graphs（GitHub）** | 路径敏感名称解析，给 tree-sitter 补「语法层之上的符号解析」；官方 2024 后停更。 |
| 2022 | **SCIP**（Sourcegraph 发布） | 符号级索引交换标准：scip-typescript/scip-java/scip-python/rust-analyzer 等 indexer 生态。**「借力编译器语义输出」从此有标准格式。** 注意：Sourcegraph 平台本身 2024 后陷入商业收缩（裁员、2026 停售独立 Cody），但 SCIP 格式与 indexer 生态是独立于其商业命运的持久资产——**借格式，不抄商业模式**。 |
| 2023– | **LLM Agent + MCP（2024-11）** | 代码图谱的新消费者出现：Agent 需要「图查询接口」而非「人看的图」。 |

第五代的意义对 HoloGram 最关键：**语法层商品化（tree-sitter）+ 语义层标准化（SCIP）+ 消费层新生（MCP/LLM）**——HoloGram 站在第五代，却只用了第一代的解析深度（纯语法），这是差距的准确表述。

---

## 二、巨头威胁模型：到底挡住了什么、没挡住什么

### 2.1 巨头按「车道」排布（而不是按工具排）

| 车道 | 玩家 | 它们挡住什么 | 挡不住什么 |
|---|---|---|---|
| **安全缺陷检测** | Synopsys(Coverity)、OpenText(Fortify)、Checkmarx、Snyk、GitHub(CodeQL)、Qwiet(Joern) | 任何「找 bug/漏洞」的市场 | 它们的图**全部闭源/内部**，用户拿不到图；且大多需要构建或服务端上传 |
| **架构治理与合规** | CAST、Axivion、Lattix、NDepend、Sonargraph、Understand、Teamscale | 企业架构一致性、ISO 26262 级合规、大型遗留系统现代化 | 单价高（Understand $100+/月/人，CAST 数十万美元级）、桌面/服务端封闭形态、无 LLM 接口 |
| **IDE 符号导航** | JetBrains、Microsoft(Roslyn)、clangd、rust-analyzer、gopls | 单语言「跳转定义/找引用/调用层级」——**已被编译器级索引做到免费且接近完美** | 跨语言、免构建、批量仓库级；且不面向 Agent |
| **代码搜索** | Sourcegraph、Zoekt/OpenGrok、livegrep | 全仓库正则/符号搜索 | 搜索 ≠ 图推理：不给依赖路径、环、影响面、社区 |
| **（本项目的车道）LLM 可查询的多语言依赖图** | **无巨头。** | —— | 这就是 HoloGram 声称的品类 |

### 2.2 所以「巨头挡在前面」的真实含义

1. **巨头不在这条车道上**：安全巨头在图内部用图但不卖图；架构治理巨头在卖图但形态是封闭桌面/服务端且价格高；IDE 索引器免费但锁死在单语言+编辑器上下文。**「把 27 语言免构建的依赖图通过 MCP 交给 LLM Agent」这个组合，四十年历史里没有任何巨头在做。** 这是真话，不是安慰。

2. **但巨头定义了验收标准**：这条车道空着，是因为历史已经证明「语法级图不可信」（第一代 ctags 教训 + 第四代定律）。LLM 用户第一次问「trace_impact 给的答案准吗」时，会拿 IDE 的 go-to-definition 和 SCIP 的精度当标尺。**HoloGram 当前的解析率（import 80%/calls 40%）撑不过这种验收**——这就是第一波报告里 P0 的由来。

3. **真正的威胁不是巨头，是「组装替代品」——而且已经发生了**：第五代把这条路线的所有零件都开源了——tree-sitter（语法）+ scip-typescript/scip-python/rust-analyzer（语义）+ SQLite/Neo4j（存储）+ MCP server（接口）。这不是理论推演：GitHub 上已经出现多款「code graph MCP server」项目（[CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext)、[codegraph-ai/CodeGraph](https://github.com/codegraph-ai/CodeGraph)、近期爆火的 [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)），用 TypeScript 把代码索引成图数据库再喂给 AI 助手——**与 HoloGram 的品类完全重合，且其中不少项目起步就是「解析质量优先」**（codegraph 的 changelog 正在修「同名类方法调用解析」这类 HoloGram 的 P0 问题）。同时**老牌商业工具也在进场：NDepend v2026 已发布 MCP Server**（把它的 CQLinq 代码模型开放给 LLM），说明「LLM 可查询代码图谱」正在成为共识赛道，时间窗不是无限的。巨头不会来抢这个市场，但拼装者与老厂两头挤压。护城河只有三样：零配置的多语言广度体验、Agent 深度集成（桌面端 goal/计划模式/工作台）、以及解析信任度——其中前两样是已有的，第三样是当前最弱的。

### 2.3 结论：战略修正

- 原报告「与巨头是品类差异，不必对标」**方向对但分量不够**。更准确的表述：**巨头占据的是「深语义 × 封闭消费」的角，HoloGram 的角是「广覆盖 × 开放查询 × LLM 消费」，角与角之间无正面竞争；但历史定律（提取必须可信）与开源零件（SCIP/tree-sitter）共同决定了——这个角只有在「解析层可信」之后才守得住。**
- 因此战略优先级不变，且更加聚焦：**P0（确定性 import 解析 + 不静默丢边）不是「改进」，是「存亡前提」；P1 的语义层路线应从「stack-graphs 或 SCIP」二选一，明确收敛为「SCIP 桥接为主、stack-graphs 为辅」**——SCIP 有活的 indexer 生态和标准格式，stack-graphs 官方已停更。
- 新增一项战略动作：**把「与组装替代品赛跑」写进路线图**——在每个主打语言上，以「不差于 scip-* indexer 的解析质量」为验收线，否则就该直接内嵌/桥接那个 indexer，而不是自己写。

### 2.4 附：同一车道内的直接竞争者（2025-2026 已出现）

「把代码索引成图、通过 MCP 喂给 AI 助手」这个品类在 2025-2026 已经起量，且全部基于开源零件拼装（tree-sitter + SQLite/Neo4j + MCP）：

| 项目 | 形态 | 与 HoloGram 的对比信号 |
|---|---|---|
| [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | npm 包 + MCP，多语言（含 C/C++/ObjC/Rust），100% 本地，自动同步变更，支持 Claude Code/Codex/Gemini/Cursor 等 | 近期爆火；**changelog 显示它正在修 HoloGram 的 P0 级问题**（「同名类的方法调用现在能解析到正确定义」）；有第三方架构解析文章（[martianlee, 2026-06](https://martianlee.github.io/posts/2026-06-04-codegraph-architecture)） |
| [CodeGraphContext/CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | MCP server + CLI，索引本地代码进图数据库 | 同一品类的另一实现 |
| [codegraph-ai/CodeGraph](https://github.com/codegraph-ai/CodeGraph) | 开源代码图谱 | 同上 |
| code-graph-mcp、@iflow-mcp 等 npm 包 | 轻量 MCP 图服务 | 长尾跟进者 |

**威胁含义**：这些项目没有 27 语言和桌面端的包袱，在主流语言上可以快速把解析质量做到 HoloGram 之上；HoloGram 的应对不是拦它们，而是**在它们未覆盖的长尾语言上保持广度优势，在主流语言上把解析质量追到不输给它们**（这正是 P0/P1 的验收线）。

---

## 三、全量竞品矩阵（30+，四代同堂）

> 第一波 12 工具（CodeQL/Semgrep/SonarQube/Snyk/depcruise/madge/Sourcetrail/Understand/jQAssistant/Kythe/Glean/stack-graphs）的细节见前两份基线报告，此处并入矩阵。

| 工具（代） | 车道 | 提取深度 | 语言 | 图暴露给用户? | 查询/规则语言 | 许可证/价格 | 活跃度 | 对 HoloGram 的启示 |
|---|---|---|---|---|---|---|---|---|
| ctags/cscope（一） | 索引器 | 正则符号 | 几十/1 | 是（命令行） | 无 | MIT/GPL | 低（universal-ctags 维护中） | 广度换深度的最老先例 |
| Rigi（二） | 学术可视化 | 符号+图聚类 | 多 | 是（GUI） | 无 | 学术 | 停 | 图聚类的源头 |
| Bauhaus/Axivion（二→三） | 架构治理 | 类型级（C/C++） | 少而深 | 部分 | 架构一致性 DSL | 商业 | 高 | 图+规则门禁的模板 |
| CAST（二→三） | 企业架构 | 系统级+事务级+DB 对象级 | 40+ | 部分（产品内） | 内置 | 商业（数十万美元级，待核） | 高 | 巨头形态：重、贵、封闭 |
| Understand（三） | 架构/度量 | 符号/类型/调用级 | ~19 族 | 是（GUI） | 度量+架构图 | $100–120/月 | 高 | 度量是图的标准增值层 |
| NDepend（三） | 架构/度量 | 符号级（.NET） | 1 生态 | 是（桌面） | **CQLinq 查询语言** | 商业 | 高 | 「图上的可编程查询」有长期付费需求；**v2026 已发布 MCP Server——老牌商业工具也在涌向 LLM 车道** |
| Lattix / Structure101 / Sonargraph（三） | 架构治理 | 符号级 | 各 5–10 | 是（桌面） | 规则 DSL | 商业 | 中（Structure101 2024-10 被 SonarSource 收购） | DSM/门禁是成熟品类 |
| Teamscale（三） | 架构/质量 | 符号级+增量 | 多 | 部分 | Findings 模型 | 商业 | 高 | 增量正确性是硬门槛 |
| CodeScene（三） | 行为分析 | 版本历史+热点 | 多 | 是（SaaS） | 内置 | 商业 | 高 | 「耦合」可以来自 git 历史 |
| FAMIX/Moose（二→三） | 学术元模型 | 语言无关 IR | 多（学术适配器） | 是（平台） | Moose 脚本 | 学术开源 | 低 | 「统一 IR」概念的老祖宗，HoloGram 的历史对位物 |
| Coverity（四） | 安全 | 过程间+SAT | 20+ | 否 | 内置规则 | 商业巨头价 | 高 | 深语义+封闭消费=巨头形态 |
| Fortify / Checkmarx / Klocwork / PVS-Studio（四） | 安全 | 数据流/污点/符号执行 | 各 10–40 | 否 | 内置规则 | 商业 | 高 | 同上；PVS-Studio 证明「深数据流」可低价化 |
| Cppcheck / Frama-C / Infer（四） | 安全/验证 | 数据流/抽象解释/分离逻辑 | 1–4 | 部分 | 标注/契约 | 开源 | 中 | 单语言深度分析的开放实现 |
| Soot / WALA / DOOP（四） | 学术 | 调用图+points-to | 1–2 | 是（API） | 编程 API/Datalog | 开源 | 中 | 「精确调用图」的学术标尺 |
| **Joern**（四） | 安全图谱 | **CPG：AST+CFG+PDG** | 6 大语言族 | **是（开源图+查询）** | Scala DSL / Cypher | **Apache-2.0** | **高（几乎日更，2026-08 活跃）** | **与 HoloGram 结构最接近的开源物**：证明「属性图+可编程查询」可行且开源；与 HoloGram 的分工是「安全查询」vs「架构可视化+Agent 集成」 |
| Kythe（四） | 索引平台 | 编译器级引用图 | 3 深 | 是（API） | serving table/xrefs | Apache-2.0 | 低 | 编译器级图谱维护成本连 Google 都收手 |
| Glean（五） | 索引平台 | 编译器/SCIP 级 | 5 原生+桥接 | 是（Angle） | **Angle（Datalog）** | BSD | 高 | 借力 SCIP/LSIF 的官方示范 |
| Sourcegraph+SCIP（五） | 代码智能 | 符号级（indexer 生态） | 主流语言 | 平台内 | 搜索+graphQL | 开源部分+商业 | 平台商业动荡（2024 后裁员收缩、2026 停售独立 Cody），**SCIP 格式本身健康** | **SCIP 是语义层借力的标准格式——借格式、不抄平台商业模式** |
| stack-graphs（五） | 名称解析 | 路径敏感符号 | 多（tree-sitter） | 是（库） | API | Apache/MIT | 停更 | tree-sitter 补语义层的学术路线 |
| PyCG（五） | Python 调用图 | 赋值图+类型传播 | 1（Python） | 是（输出） | 编程 API | Apache-2.0 | 已归档（2023-11） | **「单语言合格调用图」的量化标尺：precision ≈99.2%、recall ≈69.9%（[ICSE 2021](https://arxiv.org/abs/2103.00587)）**——连最认真的单语言调用图都只召回七成，HoloGram 的 Python 调用边目前连零头都不到 |
| importlab（Google/pytype） | import 解析库 | 静态 import 解析（binding 级 import graph） | 1（Python） | 是（库） | API | Apache-2.0 | 已归档（2024-05，随 pytype 继续使用） | HoloGram P0-1（Python import 路径解析）的现成参考实现 |
| dependency-cruiser（五） | 依赖校验 | 文件级 import | JS 生态 | 是 | 正则规则 | MIT | 高 | HoloGram 当前真实水位对照物 |
| **HoloGram（五）** | **LLM 可查询图谱** | **语法级（当前）** | **27** | **是（MCP+3D+Agent）** | **34 工具+NL explore** | MIT | 高 | —— |

---

## 四、给主报告的增量结论

1. **差距的准确表述**：不是「落后于某个工具」，而是**「站在第五代，用第一代的解析深度」**——语法层已商品化（tree-sitter 人人可用）、语义层已标准化（SCIP 有活生态）、消费层已新生（MCP/LLM），HoloGram 的产品形态属于第五代，解析深度还停在第一代。
2. **四十年定律没有一条支持「纯语法 + 名字匹配」能做出可信图谱**；每一条都指向同一件事：**提取层必须借力编译器/语言服务器语义输出**。架构治理报告的「八条被反复证明有效的机制」（统一 IR / 声明式图查询 / DSM 矩阵 / 架构规则+质量门 / 符号级 xrefs / 可视化依托图模型 / 图×时间 / 广度深度张力）里，HoloGram 已有统一 IR、图查询、可视化、时间维度四项，**缺「符号级 xrefs」与「声明式架构规则+质量门」两项**——这正是 NDepend/Sonargraph/Axivion/Understand 四十年反复验证的护城河。
3. **巨头威胁的正确答案**：本车道无巨头；威胁是两头挤压——拼装替代品（tree-sitter + scip-* + SQLite + MCP，已在 GitHub 起量）与老厂进场（NDepend v2026 已发 MCP Server）。护城河 = 零配置广度 + Agent 集成 + 解析信任度，前两项已有，第三项是当前短板。
4. **头号对标修正：不是 CodeQL，是 Joern**。Joern 是唯一「开源 + 多语言 + 免构建 + 图完全暴露给用户」的活跃工具（Apache-2.0，几乎日更），CPG 分层（AST+CFG+PDG 融合）与 HoloGram 的「统一 IR」是同一哲学；CodeQL 的图是闭源私产。差距基线应设在 Joern，借鉴清单也来自它（OverflowDB/Odin 设计，无许可传染）。
5. **P1 路线收敛**：SCIP 桥接为主（活生态、标准格式、逐语言现成 indexer），stack-graphs 为辅（官方停更）；验收线 = 主打语言解析质量不低于对应 scip-* indexer。官方 [SCIP README v0.3.2](https://raw.githubusercontent.com/scip-code/scip/refs/tags/v0.3.2/Readme.md) 已列 9 个 indexer：scip-typescript(TS/JS)、scip-python、rust-analyzer(Rust)、scip-java(Java/Scala/Kotlin)、scip-clang(C/C++)、scip-ruby、scip-dotnet(C#/VB)、scip-dart、scip-php——覆盖 HoloGram 主力语言。若追求更深语义，唯一值得抄的两条学术路是 **Joern 的 CPG 分层**与 **DOOP/Soufflé 的 Datalog 声明式分析**（调用图+points-to 的表达力标杆），而非 Coverity/Fortify 的闭源堆料。
6. **新增战略项**：把「查询层」从「34 个固定工具」演进为「固定工具 + 用户可写规则（YAML 约束，对标 dependency-cruiser/jQAssistant 规则形态）」；CQLinq/Cypher/Angle 的历史证明「可编程查询」是图谱产品的标配，但可后置——先让 34 个工具可信，再谈查询语言。
7. **SCIP 是「解析层」与「图存储层」的解耦点，不是推倒重来**：HoloGram 最强的图存储/图算法/查询层完全不用重写，SCIP 消费器只是给 GraphStore 换一个更可靠的上游数据源；且 `external_symbols` 能直接补回「依赖星图不显示 node_modules 库依赖」的缺口。落地分档：**第一档**（有 SCIP indexer 的 Java/TS/JS/Python/C/C++/Ruby/C#/Rust/Go/PHP/Dart）直接借力，**第二档**（冷门语言）保留 tree-sitter 管线但诚实标注「语法近似」。注意两点已核实的事实：rust-analyzer 的 SCIP 产出**原生可用但偏基础**（2022-08 合并，细粒度不如 scip-java/typescript）；Sourcegraph 自己试过「tree-sitter 直接产符号索引」（lsif-tree-sitter）**并放弃了**（仓库已 404）——所以「继续打磨 .scm 查询」不是替代路线，只能是第二档的降级选项。
