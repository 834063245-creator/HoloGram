# 结构图谱/依赖图工具外部事实调研报告

> 用途：为「业余自研代码图谱引擎 vs 老牌代码图谱工具」差距报告提供可引用的公开事实。
> 采集方式：web_search + 直接抓取官方文档 / README / Wikipedia / npm 与 GitHub API / 官方博客归档。
> 采集日期：2026-08。

**先声明两处事实修正（供写报告时注意）：**

1. **Glean 是 Meta（Facebook）的项目，不是 Google 的。** 你任务书里「Google 放弃 Kythe 转向内部 Glean」这一句把两家公司混为一谈：Kythe 是 Google 开源（Apache-2.0），Glean 是 Meta 开源（BSD，2021）。两者是「大厂代码图谱」的平行样本，不是继承关系。Google 内部继续用其自有代码搜索/索引栈，开源 Kythe 的投入在 2024 年明显收缩（见下文 Kythe 一节）。
2. **「Sourcetrail 2.0 订阅制」没有公开一手证据。** 官方博客《Discontinue Sourcetrail》（2021-09-23）明确说作者「逐渐对语言分析与软件可视化领域失去兴趣，转向新领域」，终版 2021.4 发布后归档仓库、下线官网。检索不到任何官方的「Sourcetrail 2.0 订阅制」产品页。建议报告中把「后继商业版」表述为「社区有传闻/讨论，但无官方一手来源可引」。

---

## 1. dependency-cruiser

**是什么**：JS/TS 生态的「依赖校验 + 依赖图」CLI 工具，口号是 *Validate and visualise dependencies. With your rules.*（[README](https://github.com/sverweij/dependency-cruiser)）。

- **提取什么**：**模块级 import/require/export 依赖**，不是调用关系，不是类型关系。它跑的是「某个文件 import 了哪个模块/文件」这一层，得到的是文件→文件的依赖边。支持 CommonJS `require`、ES6 `import`、AMD、动态 `import()`、以及 JSDoc 里的引用（`detectJSDocImports` 选项）。**不做函数调用、不做类型/泛型、不做符号级解析。**
- **如何解析（resolution 策略）**：
  - 底层用 webpack 的解析器 [`enhanced-resolve`](https://raw.githubusercontent.com/sverweij/dependency-cruiser/main/doc/options-reference.md) 把模块说明符解析到磁盘文件。
  - **tsconfig**：`--ts-config` / `tsConfig` 选项读取 `compilerOptions`，重点是 `baseUrl`/`paths`（TypeScript 路径映射）与 `extends` 继承链（[options-reference](https://raw.githubusercontent.com/sverweij/dependency-cruiser/main/doc/options-reference.md)）。
  - **webpack alias**：`--webpack-config` 读取 webpack 配置的 `resolve` 段（含 `alias`、`modules`）（[FAQ](https://raw.githubusercontent.com/sverweij/dependency-cruiser/main/doc/faq.md)）。
  - **babel 配置**：`babelConfig` 选项。
  - 也支持 yarn PnP（`externalModuleResolutionStrategy`）。
- **解析器**：JS 用 [acorn](https://github.com/ternjs/acorn)（含 acorn-jsx，解析不了时回退 acorn-loose 宽松解析）；**TypeScript 用项目里现成的 tsc 或 swc 转译**（不随包捆绑转译器，而是复用环境里的 typescript/swc）；Vue/Svelte/CoffeeScript/LiveScript 用项目里已有的对应转译器（[FAQ](https://raw.githubusercontent.com/sverweij/dependency-cruiser/main/doc/faq.md)）。即：**它不是用 tsc/swc 做类型系统，只是用它们把 TS 转成 JS 再提取 import**。
- **输出/规则能力**：
  - 规则引擎：`forbidden`（禁）、`allowed`（仅允许）、`required`（必须）三类规则，`from`/`to` 用**正则**匹配路径（`path`/`pathNot`）、依赖类型（`dependencyTypes`，如 `npm`/`core`/`local`/`aliased`）、`moreThanOneDependencyType` 等（[rules-reference](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)）。
  - **循环检测**：`--init` 默认生成检测循环依赖（circular）的规则，另有 `reaches`（可达性）、孤儿（orphans）、缺失依赖等内置规则。
  - 输出格式：`err`（eslint 风格）、`dot`/`ddot`/`archi`（GraphViz）、`mermaid`、`json`、`csv`、`html`、`teamcity` 等。
- **语言支持**：JS、TypeScript、JSX/TSX、Vue、Svelte、CoffeeScript、LiveScript（+CSX/CJSX）。**一个生态（JS 家族），不是多语言通用工具。**
- **社区规模**：GitHub stars ≈ **7.1k**；npm 月下载量 ≈ **1200 万**（`npm` registry API，2026-07-11→08-09 窗口为 12,084,692）。
- **局限**：**完全不做类型级/调用级解析**——它看到的是「文件 A 依赖文件 B」，不是「函数 f 调用了函数 g」或「变量 v 的类型是 T」。因此它适合做**架构/模块边界约束**（layering、禁环、禁止跨层引用），**做不了代码导航**（跳转定义/找引用/调用层级）。
- **许可证**：**MIT**（[README](https://github.com/sverweij/dependency-cruiser)）。
- **活跃度**：活跃（最新 push 2026-08-10）。

**能力基线**：提取深度=**文件级**（模块依赖图）；语言数=~7（单一 JS 生态）；解析质量=**模块解析级**（不碰类型/调用）；查询=正则规则 + 可达性/环检测；可视化=GraphViz/mermaid/archi；规模=大项目可用；许可证=MIT 免费；活跃度=高。

---

## 2. madge（一句话带过）

JS-only 的模块依赖图 + 循环检测工具，基于 Joel Kemp 的 [`dependency-tree`](https://github.com/mrjoelkemp/node-dependency-tree)（其底层是 precinct/filing-cabinet，CommonJS 走 module-deps 血统）提取依赖，支持 AMD/CommonJS/ES6，外加 Sass/Less/Stylus 等 CSS 预处理器；输出 `.circular()` 环形依赖列表和 GraphViz 图。**仅文件级、无类型/调用解析**。MIT 许可，stars ≈ 10.2k。**维护迹象**：单一维护者、README 自述「业余时间维护、靠捐赠」、提交稀疏（[README](https://github.com/pahen/madge)）。

---

## 3. Sourcetrail

- **开源关闭时间与后继**：2019-11-18 转为 GPLv3 开源（[Wikipedia](https://en.wikipedia.org/wiki/Sourcetrail)）；**2021-09-23 官方宣布停止维护**，终版 Sourcetrail 2021.4，随后归档仓库、下线官网（[Discontinue Sourcetrail 博客归档](https://web.archive.org/web/20211115131149/https://www.sourcetrail.com/blog/discontinue_sourcetrail/)；[archived README](https://github.com/CoatiSoftware/Sourcetrail)）。「后继商业版 Sourcetrail 2.0 订阅制」**无公开一手证据**（见开头声明）。
- **架构**：源码 → 解析 → **SQLite 数据库**（`.srctrldb`）→ 交互式依赖图。核心是一个**语言无关的图存储 + 图 UI**，外加「语言包」indexer 插件，通过 **SourcetrailDB** SDK 读写数据库，第三方可自写 indexer（[SourcetrailDB](https://github.com/CoatiSoftware/SourcetrailDB)）。
  - C/C++ 解析基于 **LLVM/Clang 11**（跑预处理器、构建并遍历 AST）（[README build 说明](https://github.com/CoatiSoftware/Sourcetrail)）。
  - Java 解析器：自带 Java indexer（JNI 调用，JDK 1.8/Maven）。
  - Python 解析器：独立的 [SourcetrailPythonIndexer](https://github.com/CoatiSoftware/SourcetrailPythonIndexer)。
- **符号解析质量**：这是它区别于 import-图工具的关键——**真正的类型感知**：解析到定义/声明/引用/覆盖/继承，**模板/泛型**、**调用图解析到函数签名级别**（谁能调用谁、参数、重载）。UI 上能「点一个符号看到它的定义、全部引用、调用者/被调用者」。
- **语言支持**：**C、C++、Java、Python**（4 种，深层支持；社区有 Go/TS/.NET/Perl 等原型 indexer，但质量不等）。
- **论点**：它证明了**「即便小团队（作者 Eberhard Gräther 一人为主），也只有做到类型级/符号级解析，才能做出真正『能导航』的代码工具」**——Sourcetrail 的价值不在广度（4 语言），而在每一门语言都挖到符号/类型/调用深度。反过来说，它的停更也说明：**为每门语言单独做语义级解析的维护成本极高**（作者在停更博客里点名「多平台、多语言、多构建系统 + 第三方集成，很难维护」）。
- **许可证**：GPLv3（原开源后）。

**能力基线**：提取深度=**符号级/类型级/调用级**（真类型感知 + 调用图到签名级）；语言数=4（C/C++/Java/Python）；解析质量=**高**（clang/自研）；查询=交互式符号导航（定义/引用/调用者）；可视化=**开源里最好的交互依赖图**（单机桌面 GUI）；规模=单机桌面、中型代码库；许可证=GPLv3；活跃度=**停更（2021 归档）**。

---

## 4. Understand（SciTools）

- **架构**：**逐语言自研解析器**（非外包给编译器），分析结果落进一个**关系型数据库**（`.und` 文件）。C/C++ 区分「Strict（严格，基于 compile_commands.json 精确 include 解析）」与「Fuzzy（模糊）」两种模式（[Supported languages & OSes](https://support.scitools.com/support/solutions/articles/70000582794)）。
- **数据模型（实体/依赖数量级）**：实体=一切有信息的东西（文件、类、函数、变量、宏、命名空间……），几十种实体 kind；**引用（Reference）** 连接两个实体，且成对存在（Call/CallBy、Define/DefineIn、Set/SetBy、Base 继承、Include、Use、Typed、Overrides、Modify 等），**依赖（Dependency）= 在 File/Class/Architecture 三层聚合后的引用**（[How Dependencies are Determined](https://scitools.freshdesk.com/support/solutions/articles/70000583144)、[Understanding Dependencies](https://scitools.freshdesk.com/support/solutions/articles/70000582792)）。即：依赖种类是「十几种引用 kind × 3 个层级」的组合，数量级在**十几种核心依赖种类**。
- **度量能力**：**20+ 内置度量**，分类为 Lines & Statement / Complexity / OO / Project & Architecture，代表项：圈复杂度（Cyclomatic，含 Strict/Modified 变体）、**Halstead** 系列、**耦合**（CBO、fan-in/out）、**内聚**、WMC、RFC、NOC/DIT、LOC 系列等（[What Metrics Does Understand Have?](https://scitools.freshdesk.com/support/solutions/articles/70000582223)）。
- **语言支持数量**：**约 19 个语言族**——Ada、Assembly、C/C++（至 C++23）、C#（至 11）、FORTRAN、Java（至 21）、JOVIAL、Delphi/Pascal、Python、VHDL、Visual Basic .NET、Web 语言（PHP/HTML/CSS/JS/TS/XML）、Rust（beta）等（[Supported Languages](https://scitools.freshdesk.com/support/solutions/articles/70000582794)）。支持多语言混合分析。
- **规模与价格**：定位**百万行以上**大型/老旧/嵌入式代码库（营销口径「大 codebase」）；**闭源商业**，按席位年订阅，官方 FAQ 报价 **$100–$120/月/许可**（教育免费）（[Pricing](https://scitools.com/pricing)）。
- **图表/架构分析**：架构图（Directory Structure 等）、**依赖矩阵 DSM**、调用树/调用图、信息浏览器、图表变体、CodeCheck、自定义架构等。

**能力基线**：提取深度=**符号级/类型级/调用级/引用级**（全谱）；语言数=**~19 族**（闭源里最广之一）；解析质量=高（逐语言手写解析器 + 严格/模糊 C/C++）；查询=信息浏览器 + 20+ 度量 + 架构/DSM/调用树；可视化=强（桌面 GUI 图/矩阵/树）；规模=**百万行+**；许可证=闭源商业（$100–120/月，教育免费）；活跃度=活跃。

---

## 5. jQAssistant

- **架构**：**Neo4j 图数据库 + Cypher 查询 + scanner 插件**。生命周期三段式：**Scan**（把源码/字节码/配置文件/Maven 信息扫成 Neo4j 图）→ **Analyze**（跑 concepts 富化 + constraints 校验，生成报告）→ **Server**（内置 Neo4j，浏览器访问 `localhost:7474` 直接写 Cypher）（[org README](https://github.com/jqassistant)、[User Manual](https://jqassistant.github.io/jqassistant/current/)）。
- **查询语言 Cypher 声明式到什么程度**：规则本身就是 **Cypher 图模式匹配**，例如 `MATCH (t:Test:Method) WHERE NOT (t)-[:INVOKES]->(:Assert:Method) RETURN t` 即可声明「没有断言的测试方法」约束——**声明式到「图模式 + WHERE」即完成一个架构/质量校验**，无需写遍历代码（[manual](https://jqassistant.github.io/jqassistant/current/)）。
- **语言支持**：Java 一等公民（字节码 class 扫描 + 源码 + Manifest + Maven POM），通用格式扫描器（XML/JSON/YAML/JUnit）；插件生态补 TypeScript、Dart、Spring、C4 等。**核心深度在 JVM 生态，广度靠插件。**
- **规则能力**：`concepts`（富化图）与 `constraints`（校验）两大类，带严重级别（severity）、报告（HTML/AsciiDoc/JUnit/CSV）、**baseline 基线管理**（先基线再卡增量违例）。**增量扫描**：`jqassistant.scan.reset` 标志控制是否先清空 store——`reset=false` 即在已有图上增量追加（[manual §5.8 reset](https://jqassistant.github.io/jqassistant/current/)）。
- **许可**：**GPLv3 社区版**（GitHub repo license 确认 gpl-3.0），厂商 buschmais 提供商业支持/企业许可。生态规模：主 repo stars ≈ **288**（组织下多插件 repo）。
- **生态状态**：活跃（2.x 系列，Maven Central 常更新，GSoC 曾参与）。

**能力基线**：提取深度=**符号级**（结构图：类/方法/包/模块 + 字节码依赖，非完整类型流）；语言数=Java 为主 + 格式扫描 + 插件（TS/Dart/Spring/C4）；解析质量=中（字节码 + 源码 AST，结构化而非全语义）；查询=**Cypher 声明式 + 约束校验**（强项）；可视化=Neo4j Browser；规模=中（构建内嵌图库）；许可证=GPLv3 + 商业；活跃度=活跃。

---

## 6. Kythe（Google）

- **架构**：核心是**语言无关的协议与数据格式**，把「源码信息」当数据表示/存取/查询。
  - **VName 全局符号命名**：每个节点用 5 元组 `(signature, corpus, root, path, language)` 唯一命名——这是**全局符号名解析**的基石，跨语言/跨编译单元都指向同一符号（[schema](https://kythe.io/docs/schema/)、[storage model](https://kythe.io/docs/kythe-storage.html)）。
  - **compilation unit + entries + serving table**：indexer 产出的是**CompilationUnit**（protobuf，打包成 `.kzip`，记录一次编译的源码/头文件/编译参数，[kzip 规范](https://kythe.io/docs/kythe-kzip.html)）→ 提取成一条条 **entries**（1NF 表格式 fact，如 `<source, edge, target>` 三元组）→ 再生成**serving table**（`write_tables` 产出 xrefs/filetree/search 三类服务表，供 UI 高效查询）。
  - **引用图（xrefs）语义**：edge 种类丰富——`defines`/`defines/binding`、`ref`/`ref/call`/`ref/imports`/`ref/includes`、`typed`、`childof`、`param`、`extends`、`overrides` 等；node 种类含 `file/function/variable/record/package/tapp/tvar` 等（[schema reference](https://kythe.io/docs/schema/)）。**xrefs 服务**就是「定义/引用/调用」查询的后端（[serving pipeline](https://pkg.go.dev/kythe.io/kythe@v0.0.63)）。
- **为什么开源 Kythe 转入低维护（2023–2024 证据）**：据 Wikipedia，**2024 年 4 月 Google 裁掉了整个美国的 Kythe 开发团队，改由印度维护团队接手**（作为岗位外迁的一部分）（[Wikipedia: Google Kythe](https://en.wikipedia.org/wiki/Google_Kythe)）。仓库长期低提交、围绕外部依赖适配打转。⚠️ 注意：**这并不等于「Google 转用 Glean」**——Glean 是 Meta 的；Google 内部继续用其自有（源自 Grok）的代码索引栈，开源 Kythe 只是被降级。
- **支持语言与 extractor 生态**：曾内置 C++（clang 插件）、Java（javac 插件）、Go（go_indexer）等 extractor；靠「instrumented build + 编译器钩子」取索引信息，故**解析质量=编译器级**。
- **论点**：Kythe 是「**专业代码图谱 = 全局符号名解析（VName）+ 引用图（xrefs）**」的原型样本——它把「定义/引用/调用/类型」抽象成统一图 schema，让 IDE/代码浏览器只吃图、不碰语言。

**能力基线**：提取深度=**引用级**（全局 VName + 定义/引用/调用/类型边）；语言数=C++/Java/Go 内置 extractor + 生态（窄而深）；解析质量=**编译器级**；查询=GraphStore + serving table + xrefs API（无内置 GUI）；可视化=无内置 UI（服务端）；规模=Google 级；许可证=Apache-2.0；活跃度=**低（2024 美国团队被裁，转印度维护）**。

---

## 7. Glean（Meta，2021 开源）

- **架构**：**facts 存储 + Angle 查询语言 + indexer 生态**。facts 是**不可变、按 schema 定义、自动去重**的项（构成 DAG），底层存 **RocksDB**；查询语言 **Angle** 是 **Datalog 风格**的逻辑语言，可定义**派生谓词（derived facts）**——像 Datalog 一样写规则自动推导新事实（当前限制：**非递归**查询）（[Introduction](https://glean.software/docs/introduction)）。
- **语言支持（indexer 生态）**：原生完整支持 **C++/C、Hack、Haskell、JavaScript/Flow、Python**；另经 **SCIP/LSIF** 格式接入 **Go、Java、Rust（rust-analyzer）、TypeScript、.NET**（[README](https://github.com/facebookincubator/Glean)）。即：深支持少数语言，其余靠「编译器的语义输出（SCIP/LSIF）」桥接。
- **内部规模证据**：官方主页称「为索引**数十亿 facts** 的 monorepo 设计」（*Compact, incremental storage designed to index monorepos with billions of facts*）（[glean.software](https://glean.software/)）。
- **为什么 Datalog 查询是标杆**：Datalog 的「关系事实 + 声明式规则推导」天然匹配代码图谱的可组合查询（找定义、找调用者、找实现、跨语言链接），且**可增量、可物化、可大规模并行**；Angle 在其上加类型、聚合等扩展，使「死代码扫描、迁移工具、linter」都能用查询而非编译器 API 写。上层还有 **Glass**（语言无关符号服务器）与 **LSP 服务器**（给 VS Code 提供 go-to-def/find-references）。
- **许可证**：**BSD**（[README](https://github.com/facebookincubator/Glean)）；2021 年由 Meta 开源（[Indexing code at scale with Glean](https://www.engineering.fyi/article/indexing-code-at-scale-with-glean)）。

**能力基线**：提取深度=**引用级/类型级**（defs/refs/types/calls/inheritance/imports 全覆盖）；语言数=C++/Hack/Haskell/Flow/Python 原生 + SCIP/LSIF 接 Go/Java/Rust/TS/.NET；解析质量=**编译器级/语义级**；查询=**Angle（Datalog 风格 + 派生谓词）**；可视化=无内置（LSP/Glass 服务化）；规模=**数十亿 facts / monorepo**；许可证=BSD；活跃度=活跃。

---

## 8. Stack Graphs / Semantics（GitHub）

- **概念**：stack graphs 是**面向路径敏感的跨文件符号解析**的框架——它把「作用域解析」建模成带栈的图遍历，能正确处理同名符号在不同文件/作用域下的不同绑定，**无需接入构建系统或编译器**即可做精确名称解析。理论基础是 TU Delft Eelco Visser 组的 **scope graphs**（[README](https://github.com/github/stack-graphs)、[论文 arXiv:2211.01224](https://arxiv.org/abs/2211.01224)）。
- **用在哪**：GitHub 的**精确代码导航（precise code navigation / go-to-definition / find-references）**——官方博客明确将其用于 Python 精确导航与 PR 内导航（[github.blog](https://github.blog/news-insights/product-news/precise-code-navigation-python-code-navigation-pull-requests/)）；实现上配 **tree-sitter**（`tree-sitter-stack-graphs`）为各语言 grammar 定义解析规则，**这正是「tree-sitter + 语义层」的组合范式**（[tree-sitter-stack-graphs](https://github.com/github/stack-graphs/tree/main/tree-sitter-stack-graphs)）。rust-analyzer 生态也复用相关思路（增量、路径敏感解析）。
- **开源状态**：`github/stack-graphs` 是 **Rust crates**，**Apache-2.0 / MIT 双许可**；⚠️ 但 README 顶部注明「**本仓库已不再由 GitHub 支持或更新**」，建议 fork 自维护（[README](https://github.com/github/stack-graphs)）——即：**概念已成行业范式，但官方开源维护也已降温**。

**能力基线**：提取深度=**符号级/引用级**（路径敏感名称解析，非完整类型系统）；语言数=多语言（tree-sitter grammar 生态，逐语言写规则）；解析质量=**名称解析精确**（不要求完整编译器，但类型推理有限）；查询=API/库（增量解析）；可视化=无（库）；规模=GitHub 级增量；许可证=Apache-2.0/MIT；活跃度=**低（官方停止更新）**。

---

## 综合能力基线表

| 工具 | 提取深度 | 语言数 | 解析质量 | 查询能力 | 可视化 | 规模 | 许可证/价格 | 活跃度 |
|---|---|---|---|---|---|---|---|---|
| **dependency-cruiser** | 文件级（import/require） | ~7（JS 生态） | 模块解析（不碰类型/调用） | 正则规则 + 环/可达 | GraphViz/mermaid | 大项目 | MIT 免费 | 高 |
| **madge** | 文件级 | 1（JS）+CSS 预处理 | 模块解析 | 环检测 | GraphViz | 中小 | MIT 免费 | 低（维护模式） |
| **Sourcetrail** | 符号/类型/调用级 | 4（C/C++/Java/Python） | 高（clang/自研，类型感知） | 交互符号导航 | 开源最佳交互图 | 单机中型 | GPLv3 | **停更 2021** |
| **Understand** | 符号/类型/调用/引用级 | ~19 族 | 高（逐语言手写解析器） | 20+ 度量 + 架构/DSM/调用树 | 强（图/矩阵/树） | 百万行+ | 闭源 $100–120/月 | 高 |
| **jQAssistant** | 符号级（结构图） | Java 主 + 插件 | 中（字节码+AST） | **Cypher 声明式 + 约束** | Neo4j Browser | 中型 | GPLv3 + 商业 | 高 |
| **Kythe** | 引用级（VName + xrefs） | C++/Java/Go 深 | 编译器级 | GraphStore/xrefs API | 无内置 UI | Google 级 | Apache-2.0 | 低（2024 裁员） |
| **Glean** | 引用/类型级 | 5 原生 + SCIP/LSIF | 编译器级 | **Angle（Datalog + 派生）** | 无内置（LSP/Glass） | 数十亿 facts | BSD | 高 |
| **Stack graphs** | 符号/引用级（路径敏感） | 多语言（tree-sitter） | 名称解析精确（类型有限） | API（增量） | 无（库） | GitHub 级 | Apache-2.0/MIT | 低（官方停更） |

---

## 总结：共同底线 vs 自研 27 语言方案

**一、这些工具的共同底线——「能用的代码图谱」至少要有什么。**

把上面八者分成三档就一目了然：

1. **文件级 import 图**（dependency-cruiser、madge）：只有「谁 import 谁」。**够做架构约束/禁环/分层校验，但做不了任何代码导航**。它们是「依赖图」不是「代码图谱」。
2. **符号级 + 跨文件引用解析**（jQAssistant、stack graphs）：能回答「这个符号在哪定义、谁引用、谁调用」。**这是「代码图谱」的门槛线**——核心是**全局符号命名 + 跨文件名称/作用域解析 + 引用边**。
3. **类型级 + 编译器级**（Sourcetrail、Understand、Kythe、Glean）：在符号之上再加**类型、泛型、重载、覆盖、调用图到签名级**。这是「能导航 + 能做重构/迁移/度量」的完整版，全部依赖「每语言一个真正的语义解析器」（编译器钩子 clang/javac，或手写解析器，或 SCIP/LSIF 接现成 indexer）。

**共同底线可以归纳成一句**：*一个「能用」的代码图谱，底线不是「能画出文件依赖连线」，而是**有一个全局符号命名空间（VName/qualified name）**，并且能把一次 `import`/调用**解析到具体符号（definition/reference）**——即「符号级解析 + 引用图」。文件级 import 图只是它的一个退化投影。*

**二、自研 27 语言 breadth-first tree-sitter 方案与它们的差距。**

- **优势（别人没有的）**：**广度 27 语言**——超过上表几乎全部工具（Understand ~19 族但闭源收费；Sourcetrail 只 4 门；Kythe/Glean 深而窄）。用 tree-sitter + `.scm` 查询统一 IR，边际成本低、覆盖快，这是 breadth-first 的合理打法。
- **本质差距（也是最关键的）**：tree-sitter 是**纯语法解析器（syntax-only）**，产出的是**语法树 + 本地 query 匹配**，它**不提供**：
  1. **全局符号命名**（没有 VName/qualified-name 概念）；
  2. **跨文件名称/作用域解析**（`import x` 里 x 到底指向哪个定义？同名符号怎么区分？）；
  3. **类型/泛型/重载/覆盖解析**（这些是语义，不是语法）；
  4. **调用图到函数签名级**（tree-sitter 给不出「这行调用解析到哪个函数的哪个重载」）。

  所以自研方案目前的真实水位 ≈ **「27 语言广度版的 dependency-cruiser/madge」**（文件级/语法级依赖图 + 结构图 + 社区发现/BFS 等图算法），而不是 Kythe/Glean/Understand/Sourcetrail 那档（符号级/类型级/引用级）。差距不在「图引擎/查询/可视化」，而在**每一门语言的语义解析层缺失**。
- **补差的最现实路径**（对齐行业范式）：
  1. **stack-graphs 路线**：GitHub 已证明「tree-sitter + stack-graphs（路径敏感名称解析）」能给纯语法解析补上符号级/引用级——这正是自研方案当前技术栈（tree-sitter）的最短升级路径，且逐语言只需写名称解析规则而非完整类型系统（代价：官方已停更，需自行维护）。
  2. **SCIP/LSIF 桥接**：像 Glean 那样，深支持少数语言，其余 20+ 语言接入现成编译器/语言服务器的语义输出（rust-analyzer、gopls、tsserver 等产出的 SCIP/LSIF），用「别人的解析质量」换「自己的广度」。这也印证了 Sourcetrail 的教训：**逐语言手写语义解析的维护成本高到连原作者都放弃**，广度路线必须借力现成 indexer。

**一句话结论**：老牌工具的共同底线是「**符号级解析 + 引用图**」（最好到类型级）；自研 27 语言 tree-sitter 方案赢在**语言广度**，输在**单语言解析深度**——当前是「语法级/文件级」，要成为真正的「代码图谱」，必须给 tree-sitter 补一层**跨文件名称解析 + 全局符号命名**（stack-graphs 或 SCIP/LSIF 是两条现成路线），否则它只是一张「27 语言的漂亮依赖星图」，回答不了「这个符号定义在哪、谁在调用它」。
