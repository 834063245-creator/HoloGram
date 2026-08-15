# 代码智能平台、索引器生态与现代标准格式 —— 差距报告第三块拼图

> 调研日期：2026-08-15 · 方式：web_search + GitHub/PyPI/Wikipedia 一手抓取核实
> 定位：本报告是《HoloGram 引擎 vs 老牌图谱分析工具》系列差距报告的**第三块拼图**，聚焦「代码智能平台、索引器生态与现代标准格式」。
> 前两块拼图：
> - `docs/research/engine-capability-audit-2026-08.md`（引擎内部能力审计）
> - `docs/research/external-deep-analysis-tools-baseline-2026-08.md`（CodeQL / Semgrep / SonarQube / Snyk 基线）
> - 关联：`docs/code-graph-tools-gap-report.md`（Kythe / Glean / stack-graphs / OpenGrok 等已覆盖）
> 每条结论对齐主报告的核心命题：**HoloGram 缺的不是图算法，是「符号级解析 + 引用图」这一整层语义**。本报告回答的问题是：这层语义，行业里几十年是怎么做的、现在用什么标准交换、对 27 语言 breadth-first 的 HoloGram 意味着什么。

---

## 0. 结论先行（给不读正文的人）

1. **「符号级索引」这件事，行业答案不是自写解析器，而是「编译器/语言服务器当索引器 + 标准格式交换」**。从 1985 年的 cscope（编译器前端 + 倒排索引）到 2022 年的 SCIP（编译器 API + protobuf 交换格式），这条线四十年来没变过：**真正能确定性解析 `import x` / `a.b()` 到定义的工具，背后一定挂着一个真正的语言前端**，而不是正则、不是 tree-sitter、不是字符串匹配。
2. **广度 vs 深度的 tradeoff 是四十年的老问题**：ctags/cscope 用「纯正则/轻解析 + 一百种语言」换广度，代价是零作用域、零别名、零跨文件语义；clangd/rust-analyzer/gopls/Roslyn/IntelliJ 用「一种语言 + 完整编译器」换深度，代价是每语言都要一套前端。**没有第三个选项**——这是本报告最重要的行业事实。
3. **SCIP 已经把「索引器的产出」标准化了**：2022 年 Sourcegraph 发布的 SCIP 用 protobuf 定义了 `Occurrence`（符号出现在哪、是什么角色）/ `SymbolInformation`（符号的元数据、关系、种类），且已有一排现成的 indexer（scip-java / scip-typescript / scip-python / scip-clang / rust-analyzer 原生 scip/lsif 等）。**HoloGram 借力 SCIP 是补语义层最现实的路线**——不需要也不可能手写 27 个语义解析器（主报告 §0.5 的判断，本报告给出证据）。
4. **「一门语言做到什么程度算合格调用图」有公开标尺**：PyCG（ICSE 2021）在 Python 上做到 micro-benchmarks **precision ~99.2% / recall ~69.9%**，就已经是「实用」天花板，而它直接承认 recall 只有七成——**连最认真的单语言静态调用图都只能召回七成**。这给 HoloGram 一个残酷的对照系：27 语言广度下，指望字符串匹配达到任何「语义正确」都不现实，正确目标是「能接 SCIP 接 SCIP，接不到才降级」。
5. **HoloGram 的技术底座（tree-sitter）本身已被行业验证，但它只是「语法树」标准，不是「语义」标准**：GitHub、Semgrep、Neovim、Zed 都用 tree-sitter，但**没有一个拿它做「符号级引用图」**——他们拿它做高亮、做解析、做结构化编辑，语义导航要么走编译器（rust-analyzer）、要么走 stack-graphs + SCIP。tree-sitter-graph 是「在 query 里做图构建」的官方补丁，正是 HoloGram `.scm` 查询层的现成对标物。

---

## 1. Sourcegraph —— 代码智能平台（2013 起）

**一句话定性**：把「Google 代码搜索」商业化的头号玩家，2013 年成立，precise code intelligence 的先驱，也是「开源→闭源」战略转向的当代活标本。

**技术机制（怎么解析、怎么存、怎么查）**

- 两条导航路径，精确度天差地别：
  - **Search-based code navigation（模糊）**：后端是 Zoekt（trigram 全文/正则搜索，见 §6），配 ctags 符号排名；「Go to definition」靠「搜这个名字」近似命中，会歧义、会错。这是它覆盖 30+ 语言、但语义不可靠的那一半。
  - **Precise code navigation（精确）**：由**各语言的 indexer 在编译期产出 SCIP/LSIF 索引**（见 §2），上传到后端；跳转/找引用/找实现读索引，确定性解析到符号。2021 年后主推 **auto-indexing**——在 CI 里自动跑 indexer、自动上传，用户无需手配。
- 存储与查询：索引存 Postgres + 对象存储，查询走 GraphQL API；Web 前端在浏览器里按行/列渲染跳转目标。
- 后端格式演变：2019 起支持 LSIF（`lsif-*` indexer），2022 起迁移到 SCIP（LSIF→SCIP 迁移发生在 Sourcegraph 4.5→4.6）。
- 它同时是 **SCIP 生态的策源地**：scip-java / scip-typescript / scip-python / scip-clang 等 indexer 全是 Sourcegraph 维护（见 §2）。

**语言覆盖**：Code Search 本身语言无关（30+ 语言展示）；precise 层靠 indexer 覆盖 Java/Scala/Kotlin、TypeScript/JavaScript、Python、C/C++/CUDA、Ruby、C#/VB、Rust（rust-analyzer）、Go（第三方）等。

**许可证与商业状态（重点核对）**

- 融资/估值：累计融资 **$223M**；2021-07 **$125M Series D，估值 $2.625B**（a16z 领投）；2021 年约 80 万开发者、索引 540 亿行代码。
- **开源→闭源三部曲**：2016 年 Fair Source License → 2018 年 Apache 2.0 → **2023-06-13 起大部分代码改授非开源的「Sourcegraph Enterprise」许可证** → **2024-08-22 主仓库整体转私有**（source-available 也不复存在）。
- 产品线演变：Sourcegraph（2013，2023 更名为 **Code Search**）→ **Cody**（2023-12 上线的 AI 编程助手）→ **Amp**（2025 年上线的 AI coding agent）。
- 战略转向（2024-2026）：**重心从 code search 全面转向 AI**。2025-06-25 宣布停掉 Cody Free/Pro/Enterprise Starter 计划（2025-07-23 生效），仅保留 Cody Enterprise；2025-07 起 Cody 新账户停售；**2025-12 Amp 被拆分为独立公司**（Sourcegraph 与 Amp 各自独立）。
- **Code Search 命运（已查证）**：开源代码搜索**实质上已关闭**。2024-08 转私有并大砍公有索引（砍掉非 GitHub、低 star 仓库，保留约 100 万 GitHub 仓库），HN 因此出现「Sourcegraph went dark」的讨论（2024-08-20）。企业版 Code Search 仍以自托管/云形式销售（约 $49/人/月、高起订座位），但社区自托管开源路线已死。
- 裁员：**截至 2026-08 无公开权威口径**（layoffs.fyi 无 Sourcegraph 记录）；可确证的是 2024-2025 多次战略收缩（私有化、砍免费层、砍产品线、拆 Amp），不排除伴随裁员，但具体人数无公开数据。

**活跃度**：公司仍在运营（转向 AI 代理），SCIP indexer 系列仍活跃维护（scip-typescript/java/python/clang 在 2026-08 均有 push）。

**来源**：
- https://en.wikipedia.org/wiki/Sourcegraph （成立/融资/产品/许可证时间线）
- https://sourcegraph.com/docs/code-navigation/precise-code-navigation （precise code navigation 机制）
- https://sourcegraph.com/docs/admin/how-to/lsif-scip-migration （LSIF→SCIP 迁移）
- https://news.ycombinator.com/item?id=41296481 （"Sourcegraph went dark"，2024-08）
- https://sourcegraph.com/blog/why-sourcegraph-and-amp-are-becoming-independent-companies （Amp 拆分，2025-12）
- https://webflow.sourcegraph.com/blog/changes-to-cody-free-pro-and-enterprise-starter-plans （Cody 计划停售）

---

## 2. SCIP —— 符号级索引数据交换标准（2022 发布）

**一句话定性**：2022 年 Sourcegraph 发布的**语言无关的「符号级索引」交换格式**，LSIF 的官方继任者；是把「编译器产出的引用图」从各语言 indexer 搬运到消费端（Sourcegraph、Codex、各类代码图谱工具）的**行业标准协议**。

**技术机制（怎么解析、怎么存、怎么查）**

- **protobuf schema**（`scip.proto`），核心三元素：
  - `Index{ metadata, documents[], external_symbols[] }` —— 一个工作区一份索引，可**流式读写**（`metadata` 必须最先出现）；`external_symbols` 存「引用了但定义在别的包」的外部符号文档。
  - `Document{ relative_path, language, occurrences[], symbols[], position_encoding }` —— 每个源文件一段；`position_encoding` 显式声明字符偏移是 UTF-8/UTF-16/UTF-32（避免 LSIF 时代各语言偏移语义打架）。
  - `Occurrence{ range, symbol, symbol_roles, syntax_kind, … }` —— 符号在文件里的一次出现 + 角色（定义/引用/读/写/……）+ 语法种类。
  - `SymbolInformation{ symbol, documentation, relationships[], kind }` —— 符号元数据：文档、关系（`is_implementation`/`is_definition`/`is_type_definition` 等）、细粒度 kind（`Function`/`Method`/`Class`/`Struct`/`Interface`……80+ 种）。
  - `Symbol` 是 **URI 式字符串**：`scheme manager package version descriptor+`，descriptor 后缀区分 `Namespace`（`/`）/ `Type`（`#`）/ `Term`（`.`）/ `Method`（`(…)`）/ `TypeParameter`（`[…]`）/ `Parameter`（`(…)`）等；局部符号用 `local <id>`。**这套符号命名规范是跨语言统一的**，是 SCIP 能跨语言合并索引的关键。
- 怎么「解析」：SCIP 不解析，它是**产出格式**；解析工作全在 indexer 侧（用各自语言的编译器前端，见下方清单）。
- 怎么「存」：单文件二进制（protobuf），支持 gzip 压缩；一个仓库一个 index。
- 怎么「查」：消费端加载 `Index`，按 `Occurrence.symbol` 聚合做 go-to-def / find-references / find-implementations；`scip` CLI 提供 `snapshot`/`lint`/`print` 等工具。官方提供 Go/Rust 绑定 + TypeScript/Haskell 自动生成绑定。

**indexer 清单与成熟度（挖到 indexer 级）**

| Indexer | 维护方 | 语言 | 底层前端 | 成熟度 |
|---|---|---|---|---|
| scip-java | Sourcegraph | Java / Scala / Kotlin | javac 编译器 API | 最成熟之一（badge: development，功能完整，跨仓导航） |
| scip-typescript | **Sourcegraph 维护（已核实：仍在活跃 push）** | TypeScript / JavaScript | TypeScript Compiler API | 成熟（npm `@sourcegraph/scip-typescript`，支持 workspace/monorepo） |
| scip-python | Sourcegraph | Python（3.10+） | **Pyright fork** | development（npm `@sourcegraph/scip-python`） |
| scip-clang | Sourcegraph | C / C++ / CUDA | Clang 21 前端 | Beta（需 compile_commands；2022 起长期开发，近年才标 Beta） |
| scip-ruby / scip-dotnet | Sourcegraph | Ruby / C#·VB | Sorbet / Roslyn | development |
| rust-analyzer | rust-lang | Rust | 自带 parser + hir | **原生 `rust-analyzer scip` 子命令**（2022-08 合并，见 §8） |
| scip-dart | Workiva | Dart | analyzer | 第三方 |
| scip-php | davidrjenni | PHP | php-parser | 第三方 |
| lsif-rust → scip-rust | jac（第三方） | Rust | rustc | 早期，后被 rust-analyzer 取代 |
| debian-lsp | jelmer | Debian packaging | — | 小众 |

（注：`lsif-java` 已重命名为 `scip-java`——这是 LSIF→SCIP 迁移的直接证据之一。）

**LSIF vs SCIP 的差别（重点）**

- **LSIF**（Language Server Index Format，2018-2019，微软主导、用于 LSP 生态）：JSON-lines 的**图格式**，节点/边用**单调递增整数 ID** 表示，本质是「把 LSP 的增量通知流序列化」；必须按拓扑顺序增量追加，**难合并、难流式、体积大、无明确 schema**，且符号命名无统一规范。
- **SCIP**：protobuf **二进制**（体积约为 LSIF 的 1/5），**schema 明确定义**（不是图，是「文档 → 符号出现」的表），支持**流式读写、跨文件/跨仓库合并、压缩**，符号名有统一 URI 式语法，还有 `SymbolInformation.kind` 的细粒度分类。
- **官方表述（已核实）**：Sourcegraph 公告标题即《**SCIP — a better code indexing format than LSIF**》，并在 Sourcegraph 4.5→4.6 提供 LSIF→SCIP 迁移路径；2022 年后新 indexer 全部只产 SCIP，LSIF 进入弃用。

**发布年份与作者（重点核对）**：SCIP 仓库（`sourcegraph/scip`，后迁 `scip-code/scip`）**创建于 2022-05-10，首个 release v0.2.0 于 2022-08-08**，公告博客《Announcing SCIP》同期发布 → **2022 年发布，由 Sourcegraph 主导**（核心设计者含 Ólafur Páll Geirsson、Varun Gandhi 等，均为 Sourcegraph 工程师）。

**许可证与活跃度**：Apache 2.0；`scip` 仓库 ~730 stars，最新 tag v0.3.2；各官方 indexer 2026-08 仍活跃。

**来源**：
- https://github.com/sourcegraph/scip （README + `scip.proto`，schema 一手来源）
- https://about.sourcegraph.com/blog/announcing-scip （发布公告）
- https://sourcegraph.com/docs/code-navigation/writing-an-indexer （indexer 清单）
- https://sourcegraph.com/docs/admin/how-to/lsif-scip-migration （LSIF→SCIP 官方迁移表述）
- https://github.com/sourcegraph/scip-typescript 、/scip-java 、/scip-python 、/scip-clang

---

## 3. ctags / universal-ctags —— 广度 vs 深度的最老 tradeoff

**一句话定性**：最老、覆盖最广的「符号索引器」，用**纯正则/轻词法**换语言广度，是「广度 vs 深度」这个 tradeoff 的四十年前原型——也是 HoloGram「27 语言广度」思路的精神祖先与反面教材。

**技术机制**：每个语言一个 C 写的 parser（`parsers/*.c`），绝大多数用**正则 + 词法扫描**提取 tag（符号名、种类、行号，少数语言有基本作用域）；`optlib` 允许用户**在命令行用正则定义新语言**；输出 vi 兼容的 `tags` 文件或 emacs `TAGS` 文件。**不做跨文件语义、不做作用域解析、不做别名/类型**——「广度换深度」的代价就是跳转会错、同名符号不区分。

**语言覆盖**：145 个 parser（约 140+ 种语言），从 abaqus 到 zephir 全覆盖。

**许可证与商业状态**：GPL-2.0，社区项目；前身 Exuberant Ctags（Darren Hiebert）已停滞，universal-ctags 是它的续作。

**活跃度**：活跃（`universal-ctags/ctags` 持续维护，nightly build 不断）。

**来源**：https://github.com/universal-ctags/ctags · https://ctags.io

---

## 4. cscope —— 贝尔实验室 1985 的 C 专用 xref 交互查询器

**一句话定性**：C 专用、交互式 xref 查询器，贝尔实验室 1985 年诞生，是「符号级引用图」的**祖父级**工具——也是本报告一个关键证据：**能确定性解析 `a.b()` 的老工具，从第一天起就挂在真正的编译器前端上**。

**技术机制**：两阶段——① 用 `find` 收集文件列表 `cscope.files`，`cscope -b -q -k` 建**倒排索引数据库**（词法/轻解析符号）；② `cscope -d` 交互查询：找符号定义、找调用者/被调用者、regex、egrep、找文件。**核心亮点是「find callers」**——这是 1985 年就有的「谁调用了我」查询。索引需在源码变更后手动重建。

**语言覆盖**：C 为主，官方口径「fuzzy parser 支持 C，灵活到能勉强用于 C++ 和 Java」。在贝尔实验室用于**百万行级**项目。

**许可证与商业状态**：BSD（2000-04 由 SCO 贡献开源，Petr Sorfa 接手维护）；完全免费。

**活跃度**：基本停滞——最新 release 15.9（**2018-07-24**），此后几乎无更新。

**来源**：https://en.wikipedia.org/wiki/Cscope · https://cscope.sourceforge.net

---

## 5. OpenGrok —— Oracle 的代码搜索 + xrefs 平台（一句话带过）

Oracle（原 Sun）维护的 Java Web 代码搜索 + 交叉引用引擎，`oracle/opengrok`，Lucene 做全文索引、ctags 做 xrefs，CDDL-1.0 许可证。**已在 `docs/code-graph-tools-gap-report.md` 覆盖，此处不展开**（重点放下一节的 Zoekt）。截至 2026-08 仍活跃（push 2026-08-10）。

---

## 6. Zoekt + livegrep —— trigram 代码搜索引擎，Google Code Search 血统

**一句话定性**：「搜索式代码导航」的工程标杆——不做语义、只做**快到极致的内容/正则搜索**，用 trigram 倒排索引在几十亿行代码上亚秒级返回，是 Sourcegraph 的实际后端。

**Zoekt 技术机制**：把源码按行/块切分，对每块提取 **trigram**（三字符序列）建倒排索引（posting lists）；查询时 trigram 交集 + 正则验证，支持布尔、`file:`/`lang:` 过滤、符号匹配；**用 universal-ctags 的符号信息做排名信号**（匹配到符号名加分）。名字即荷兰语「zoekt」= "seek"。**2017 年从 `google/zoekt` fork**（原作者 Han-Wen Nienhuys，与 Google Code Search 同源的 trigram 思路；Google Code Search 本身是 Russ Cox 2006-2011 的作品）。

**livegrep 技术机制**：由 Nelson Elhage 写的 Google Code Search 风格工具，C++ 后端 `codesearch`（protobuf 配置 + 自定义索引文件，可 `-dump_index`/`-load_index`），`livegrep` 前端无状态，gRPC/TCP 通信；面向 ~GB 级仓库的**交互式正则**搜索。比 Zoekt 轻，但思路同源（「部分受 Google Code Search 启发」是其 README 原话）。

**语言覆盖**：语言无关（token 化 + ctags 符号信号）。

**许可证与商业状态**：Zoekt **Apache 2.0**（Sourcegraph 主力维护）；livegrep **MIT**（维护模式，最后 push 2026-02）。

**活跃度**：Zoekt 活跃（Sourcegraph 后端，持续迭代）；livegrep 低活跃。

**来源**：
- https://github.com/sourcegraph/zoekt （README，trigram 设计、google/zoekt fork 说明）
- https://github.com/livegrep/livegrep （README，Google Code Search 血统）

---

## 7. DXR（Mozilla）—— 编译器插桩 + Elasticsearch，已停更

**一句话定性**：Mozilla 用**编译器插桩**做符号索引、Elasticsearch 做查询的代码交叉引用平台，2020 年底退役，是「编译器级索引」在浏览器公司内部的早期实践与一个完整的失败样本。

**技术机制**：用 **clang 插件在编译期插桩**产出符号/引用数据，存入 **Elasticsearch**，Python web 前端查询 xrefs（「谁定义了这个符号 / 谁引用了它」）。这与 cscope/clangd 一脉相承——**编译器当索引器**。

**语言覆盖**：主 C/C++（clang 插桩），Mozilla 的 Firefox 源码为主战场。

**许可证与商业状态**：MIT（Copyright 2009 David Humphrey）；Mozilla 内部工具，非商业。

**活跃度（停更年份已查证）**：**已停更**。Mozilla 于 **2020-10-22 邮件宣布退役 DXR，2020-12-29 关闭 dxr.mozilla.org**，由 **Searchfox** 取代；GitHub 仓库 `mozilla/dxr` 标记 **DEPRECATED 且 archived**，最后 push **2021-10-13**。

**来源**：
- https://github.com/mozilla/dxr （DEPRECATED + archived 状态）
- https://www.mail-archive.com/dev-platform@lists.mozilla.org/msg29436.html （Decommission DXR 邮件，2020-10-22）

---

## 8. clangd / rust-analyzer / gopls / IntelliJ / Roslyn —— 现代「编译器级索引」标准范式

**一句话定性**：这五个是**「每语言编译器语义输出」的行业标准范式**——IDE 的符号解析/引用/调用层级，无一例外由「完整语言前端 + 项目模型 + 增量 + 持久化缓存」构成。这是本报告对 HoloGram 最直接的一条对标线。

**共同范式（怎么解析/存/查）**

1. **解析 = 真编译器前端**：拿 AST 全语义（类型、作用域、重载解析、宏展开），不是正则不是 tree-sitter。
2. **项目模型（project model）**：索引前必须知道「每个文件是怎么被编译的」——clangd 要 `compile_commands.json`（compilation database）；rust-analyzer 要 Cargo workspace；gopls 要 go module workspace；Roslyn/IntelliJ 要工程文件（csproj / .iml）。
3. **增量索引（incremental indexing）**：只重解析变更文件；依赖图按文件/模块粒度缓存。
4. **持久化缓存**：索引落盘、跨会话复用，冷启动不重算。

**逐个要点**

- **clangd**（LLVM 官方 C/C++ LSP）：用 Clang 完整前端（AST + Sema）；`compile_commands.json` 提供每文件编译参数；**index-while-build**（`clangd-indexer` 在构建时顺带产索引）+ 后台 indexing；索引持久化到 `~/.cache/clangd/index`，跨会话共享。go-to-def / find-refs / call hierarchy 全语义。语言：C/C++。许可：Apache 2.0。
- **rust-analyzer**（开源，Rust 全语义——本报告重点）：**自带 rustc 无关的 parser（rowan 无损语法树）+ salsa 增量计算框架**，产 hir/mir/def-map，按需（on-demand）计算；静态索引缓存到磁盘；**原生输出 LSIF/SCIP**——`rust-analyzer lsif`（2021 起）与 `rust-analyzer scip`（**PR #12976 于 2022-08-23 合并**，由 TJ DeVries 贡献，`crates/rust-analyzer/src/cli/scip.rs`）。**SCIP 产出成熟度：原生可用但属于「较新、较基础」一档**——能产符号/引用/文档，但跨仓、external symbols、kind 细粒度不如 scip-java/typescript 打磨得久；LSIF 路径更早也更稳定。语言：Rust。许可：MIT/Apache 2.0 双许可。
- **gopls**（Go 官方 LSP）：`go/packages`（调 `go list` 加载包图）+ `go/types` 类型检查；module workspace 项目模型；snapshot 缓存增量重算；2023 后加了**持久化磁盘缓存**（persistent cache）加速冷启动。语言：Go。许可：BSD-3-Clause。
- **Roslyn**（微软 .NET 编译器平台）：C#/VB 编译器开放 API——`SyntaxTree`（无损语法树）→ `Compilation` → `SemanticModel`（符号/类型/引用全解析）；`ISymbol` + `FindReferences` 做引用与调用层级；**Workspace 层**（`MSBuildWorkspace`/`AdhocWorkspace`）统一项目模型，跨 Visual Studio / OmniSharp / Rider **复用同一套符号引擎**。语言：C#/VB。许可：MIT。
- **IntelliJ 平台**（JetBrains 全家桶统一索引架构）：**PSI**（Program Structure Interface，抽象语法树）+ **Stub index**（二进制 stub 树，用于跨文件符号索引）+ **持久化 caches**（name index、word index、VFS hash，存 `system/index`）；incremental——只重解析变更文件；**所有 IDE（PyCharm/GoLand/CLion/Rider…）共享这一层，每语言只写一个插件提供 PSI + stub**。这是「一个索引引擎吃 27 语言」的**商业化范例**——但代价是每语言仍有 JetBrains 工程师写插件 + 平台本身闭源。

**对 HoloGram 的含义**：IntelliJ 证明「一个索引引擎 + 每语言插件」可以规模化吃几十种语言，但它每个语言的「插件」里藏着一个真正的语言前端，且平台闭源、几十人维护。**HoloGram 的 27 语言广度想复刻这条路的自建成本是天文数字；借力 SCIP indexer（每语言一个现成编译器级索引器）是唯一现实解。**

**来源**：
- https://clangd.llvm.org/ （compile_commands、index-while-build、持久化索引）
- https://github.com/rust-lang/rust-analyzer （salsa/rowan、`cli/scip.rs`、`cli/lsif.rs`；SCIP 合并 PR #12976）
- https://github.com/golang/tools （gopls cache/design）
- https://github.com/dotnet/roslyn （SyntaxTree/SemanticModel/Workspace）
- https://plugins.jetbrains.com/docs/intellij/indexing-and-psi-stubs.html （PSI + Stub index + 持久化 caches）

---

## 9. importlab（Google）—— Python 静态 import 解析库（pytype 血统）

**一句话定性**：Google 的 Python **静态 import 解析库**，pytype 的依赖解析内核，**直接对标 HoloGram 的 Python import 短板**——它展示了「只做 import 解析、不做全类型」这一层的正确做法。

**技术机制**：用自己的轻量 parser（`importlab.parsepy`，手写的 Python 子集解析器）把每条 import 解析成 `(module, name)` 二元组，构建 **import graph**（模块依赖 + 符号归属），做依赖排序、环检测、`--unresolved` 报告。**不执行代码**（静态），比纯 AST 强在「能算出每个名字从哪个文件来」（binding 级），但仍弱于 pytype 的完整类型推断。核心价值：**确定性 import 解析**，而不是「短名字符串匹配」。

**语言覆盖**：Python 3。

**许可证与商业状态**：Apache 2.0，README 明写「This is not an official Google product」。

**活跃度**：**已归档**（`google/importlab` archived，最后 push 2024-05-03），随 pytype 集成继续被使用。

**来源**：https://github.com/google/importlab

---

## 10. PyCG —— 实用 Python 调用图生成器（ICSE 2021）

**一句话定性**：「一门语言做到什么程度算合格调用图」的公开基准线——用过程间静态分析在 Python 上做到 precision ~99.2%，并诚实地承认 recall 只有 ~69.9%。

**技术机制**：过程间静态分析：先算所有 identifier（函数/变量/类/模块）之间的 **assignment relation**，再用它解析调用点，支持高阶函数、多继承、闭包、生成器；迭代到 fixpoint。论文《Practical Call Graph Construction in the Presence of Function Pointers》来自函数指针场景的方法论（「给每个函数指针可能指向的所有函数都连边，再剪枝」）。

**精度数字（已查证）**：micro-benchmarks **precision ~99.2%，recall ~69.9%**；平均 0.38 秒处理 1k LoC。论文原文：*"PyCG achieves high rates of precision ~99.2%, and adequate recall ~69.9%"*。

**语言覆盖**：Python 3.4+（零依赖）。

**许可证与商业状态**：Apache 2.0；学术项目。

**活跃度**：**已归档**（README 明写 *"PyCG is archived. Due to limited availability, no further development improvements are planned."*），最后 push 2023-11。

**来源**：
- https://github.com/vitsalis/PyCG
- https://arxiv.org/abs/2103.00587 （ICSE 2021 论文）

---

## 11. pyan3 / pydeps / code2flow / staticfg —— Python 调用图/CFG 小工具生态

**一句话定性**：一堆「近似」单语言小工具，无一做符号级跨文件语义——正好印证「广度换深度」在 Python 侧同样没有捷径。

| 工具 | 定性 | 机制 | 许可/作者 |
|---|---|---|---|
| **pyan3** | 近似调用图生成器 | 静态 AST 分析，输出 dot/graphml/JSON；README 自称 "**approximate** call graphs" | MIT（pyan 的维护 fork） |
| **pydeps** | 模块依赖可视化 | 解析 import 图，SVG 渲染（matplotlib/networkx） | BSD-2-Clause，bjorn |
| **code2flow** | 源码转 DOT 流程图 | 静态把控制流/调用转 DOT | MIT，Scott Rogowski |
| **staticfg** | Python 控制流图（CFG） | 基于 AST + 字节码生成 CFG | Apache 2.0，Aurelien Coet |

**共性**：全部是「文件/模块级近似」，`pyan3` 连官方描述都自带 "approximate"——与 PyCG 的 99.2% precision 隔着几个数量级的差距，与 SCIP indexer（编译器语义）更是两个物种。

**来源**：PyPI 各包页（https://pypi.org/project/pyan3/ 等，见各自许可证字段）

---

## 12. tree-sitter 生态 —— HoloGram 技术底座被谁在怎么用

**一句话定性**：tree-sitter 是「语法树」的行业标准、但不是「语义」标准；HoloGram 用它对——但**只用它拿到的只是语法层**，行业里没有任何人拿它单独做符号级引用图。

**tree-sitter-graph**（关键对标）：tree-sitter 官方组织的 Rust 库，定义了一套 **DSL**（`tree-sitter-graph` 查询配置）用于「**从 tree-sitter 语法树构建任意图结构**」——即在 query 里直接产定义/引用边，配 VS Code 扩展。**这正是 HoloGram `.scm` 查询 + 图构建层的现成对标物**：HoloGram 若想把 20 种 `.scm` 查询升级成「图构建」，tree-sitter-graph 是比手写更成熟的参考实现。

**lsif-tree-sitter**：Sourcegraph 曾有一个实验性仓库 `sourcegraph/lsif-tree-sitter`，用 tree-sitter + 图规则产出 LSIF/SCIP——**该仓库现已从 GitHub 移除（404）**，路线被 stack-graphs + 各语言专用 SCIP indexer 取代。结论：**「tree-sitter 直接产符号索引」这条路 Sourcegraph 试过并放弃了**，因为它拿不到作用域/类型，产出的符号不可靠。

**ts_query 的行业采用**：
- **GitHub**：code navigation 用 tree-sitter 解析 + **stack-graphs** 做跨语言精确导航（已在别的报告覆盖）。
- **Semgrep**：用 tree-sitter 语法做解析（安全扫描的语法层）。
- **Neovim / Helix**：tree-sitter 增量解析做语法高亮 + 结构化编辑。
- **Zed**：tree-sitter 高亮 + rust-analyzer 语义（两者分工）。
- **rust-analyzer**：**本身不用 tree-sitter**（自带 rowan parser）——这是需要纠正的一个常见误读：rust-analyzer 的语义分析是自研前端，tree-sitter 只出现在「编辑器高亮」那一层。

**对 HoloGram 的含义**：HoloGram 拿 tree-sitter 当底座是「行业主流且正确」的选择，但行业共识是**tree-sitter 之上必须再叠一层语义**（编译器/LSP 的 SCIP indexer，或 stack-graphs）才能做引用图。tree-sitter-graph + SCIP 桥接，就是 HoloGram 从「语法图」迈向「语义图」的两块现成跳板。

**来源**：
- https://github.com/tree-sitter/tree-sitter-graph （DSL 图构建）
- https://tree-sitter.github.io （生态与采用）
- https://github.com/rust-lang/rust-analyzer （自研 parser，非 tree-sitter）

---

## 13. GitHub Code Navigation / stack graphs —— 已覆盖，跳过

（见 `docs/code-graph-tools-gap-report.md` 中 stack-graphs 基线。）

---

## 附：重点事实核对清单（对用户逐条答复）

| 核对项 | 结论 |
|---|---|
| SCIP 发布年份与作者 | **2022 年发布**（仓库 2022-05-10 创建，首个 release v0.2.0 2022-08-08）；由 **Sourcegraph 主导**（Ólafur Páll Geirsson、Varun Gandhi 等） |
| scip-typescript 是否仍由 Sourcegraph 维护 | **是**，`sourcegraph/scip-typescript` 未归档，2026-08-14 仍有 push |
| LSIF 2022 后被 SCIP 取代的官方表述 | 公告标题《SCIP — a better code indexing format than LSIF》+ Sourcegraph 4.5→4.6 提供 LSIF→SCIP 迁移；`lsif-java` 已改名 `scip-java` |
| PyCG 论文 precision 数字 | **~99.2% precision，~69.9% recall**（0.38s/1k LoC），arXiv:2103.00587 |
| DXR 停更年份 | 服务 **2020-12-29 关闭**（2020-10-22 宣布）；GitHub 仓库 archived，最后 push 2021-10-13 |
| Sourcegraph 2024-2026 战略 | 开源 code search **已实质关闭**：2023-06 relicense 非开源 → 2024-08 仓库转私有 → 2025 Cody 砍免费层 → 2025 Amp 上线 → 2025-12 Amp 拆分独立 |
| rust-analyzer SCIP 产出成熟度 | **原生可用但偏基础**：`rust-analyzer scip` 于 2022-08-23 合并（PR #12976，TJ DeVries 贡献）；LSIF 路径更早更稳；跨仓/external symbols/kind 细粒度不如 scip-java/typescript |

---

## 结论：这一生态对自研引擎的结论

四十年的工具史 + 2022 年的 SCIP 标准，合起来对 HoloGram 这个「27 语言 breadth-first 引擎」给出四个结论：

### 1. 「能用」的符号解析，行业答案是「编译器/语言服务器做索引 + SCIP 交换」，不是自写解析器

从 cscope（1985，编译器前端）到 DXR（clang 插桩）到 clangd/rust-analyzer/gopls/Roslyn/IntelliJ，**凡是能确定性解析 `import x` 和 `a.b()` 到定义的，背后都是真正的语言前端**。反例同样清晰：ctags/cscope 的「广度换深度」用正则换来了零作用域、零别名；Sourcegraph 的 search-based navigation 也承认自己是「近似」。**HoloGram 现在走的「tree-sitter 语法树 + 短名字符串匹配」正落在反例那一侧**——主报告的实验（TS 前端 import 解析 80%、Rust 76% 边被丢）就是这条路的必然结果，不是没调好。

### 2. 广度 vs 深度没有第三种解法，但「借力」能打破这个 tradeoff

IntelliJ 是「一个索引引擎吃几十种语言」的唯一规模化范例，代价是每语言一个真前端插件 + 平台闭源 + 几十人维护——**HoloGram 复刻不起**。但 **SCIP 把 tradeoff 打穿了**：每个语言的「编译器级索引器」已经由各家（Sourcegraph、rust-lang、Google、微软）写好了、并以统一 protobuf 格式产出。**HoloGram 不需要自己写 27 个语义解析器，只需要做「SCIP 消费者 + 图注入器」**：跑现成 SCIP indexer → 解析 `Index` 里的 `Occurrence`/`SymbolInformation` → 灌进自己的 GraphStore。这是「27 语言语义层」唯一成本现实的路。

### 3. 现实路线是「分档」：能接 SCIP 的语言接 SCIP，接不到才退回 tree-sitter

- **第一档（有成熟 SCIP indexer）**：Java/Scala/Kotlin、TS/JS、Python、C/C++、Ruby、C#、Rust、Go、PHP、Dart——直接借力。这些恰好覆盖了 HoloGram 用户量最大的语言，能一次性把主报告的「import 边 80%」「calls 丢 60%」问题打到接近编译器级（PyCG 都只敢标 99.2% precision，SCIP indexer 是更高的语义正确性）。
- **第二档（无 SCIP indexer 的冷门语言）**：保留现有 tree-sitter 管线，但**诚实降级标注**「这是语法近似，非符号级」，并考虑用 **tree-sitter-graph** 把 `.scm` 查询升级成「图构建规则」，至少把定义/引用边做得比纯字符串匹配更结构化。
- **Python 这条短板有两条具体可抄的作业**：import 解析抄 **importlab**（确定性 binding 级 import graph），调用图对标 **PyCG**（99.2% precision 是「合格」及格线）——而不是现在的「歧义即丢弃」。

### 4. 标准格式带来的架构红利：SCIP 是「解析层」与「图存储层」的解耦点

HoloGram 最强的一层（GraphStore、Tarjan/Leiden、33 个 MCP 查询、可视化）**完全不需要重写**——SCIP 恰好提供了「语义解析」和「图存储」之间的干净接口。**做 SCIP 消费者不是推倒重来，而是给现有引擎换一个更可靠的「上游数据源」**：同样的 `Index` 既喂 Sourcegraph，也喂 HoloGram 的 GraphStore，还能借 `external_symbols` 把 node_modules 那类「外部依赖节点」补回图里（主报告 §1.2 的「依赖星图不显示库依赖」问题直接可解）。

**一句话收束**：这个生态证明的不是「自研引擎没希望」，而是「**自研引擎该自研的部分从来不是解析器**」。HoloGram 的差异化在「把代码库变成可对话的 3D 依赖星图」这一层，而语义解析这一层，行业的、标准的、现成的答案叫 **SCIP + 编译器 indexer**——把它接进来，是 27 语言 breadth-first 引擎补上「符号级解析 + 引用图」最现实、也是唯一可规模化的路线。
