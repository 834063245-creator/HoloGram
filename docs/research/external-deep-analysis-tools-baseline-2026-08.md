# 四大老牌代码分析工具 vs 自研图谱引擎 —— 外部事实差距报告

> 检索时间：2026-08-15。以下所有论断附来源；查不到最新口径的地方单独标注「截至」。四个工具都**不做**「把代码库变成 27 语言统一 IR + 依赖星图 + 33 个 MCP 图查询工具」这件事，它们做的是「安全/质量缺陷检测」。

---

## 1. CodeQL（GitHub，前身 Semmle）

**架构（extractor → 关系数据库 → QL）**：CodeQL 分三阶段——先由语言专属 *extractor*（编译器前端/语法+语义解析器）把源码+构建产物抽成事实，写入一张**关系型数据库**（CodeQL database，本质是关系表集合）；然后用户用声明式查询语言 **QL** 在这张「查询化数据库」上找模式。官方教程和 GitHub 博客都把这一步称为「turning source code into a queryable database」。[Microsoft Learn 教程](https://learn.microsoft.com/training/modules/code-scanning-with-github-codeql/3-how-does-codeql-analyze-code)、[GitHub 博客（Ruby extractor 示例）](https://github.blog/security/web-application-security/code-scanning-and-ruby-turning-source-code-into-a-queryable-database/)。

在数据库之上，每种语言的标准库都暴露 **AST、控制流图（CFG）、SSA 形式、调用图、数据流图**；C/C++ 等编译型语言还有一层统一 **IR（intermediate representation）**，IR 之上再做 IR 数据流。[IR 文档](https://deepwiki.com/github/codeql/3-intermediate-representation-(ir))、[Go 标准库文档（AST/SSA/dataflow）](https://raw.githubusercontent.com/github/codeql/c4b6f44dff5c3ed2584c78ca8974389597aa6752/docs/codeql/codeql-language-guides/codeql-library-for-go.rst)。

**数据流/污点分析的形式化程度**：很高。QL 标准库提供一整套 *data flow / taint tracking* 配置类，用户声明 `source`（污点源）、`sink`（敏感汇点）、`sanitizer`/`isSanitizer`（消毒器）与 barrier，引擎自动做**过程间（interprocedural）+ 上下文敏感（context-sensitive）**传播，并支持 `flow state`（流标签）表达路径敏感的状态（如「字符串是否被拼接了若干次」）。这是正儿八经的格（lattice）上的程序分析，不是正则/模式匹配。[官方「Using flow labels for precise data flow analysis」](https://codeql.github.com/docs/codeql-language-guides/using-flow-labels-for-precise-data-flow-analysis/)。

**语言支持**：约 11 个语言标识——C/C++、C#、Go、Java、Kotlin、JavaScript、TypeScript、Python、Ruby、Rust、Swift。Rust 是较新的（相对后期加入）。[官方 Supported languages](https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/)。「质量」按语言分层：Java/C#/JS/Python/C/C++ 的库最成熟，Rust/Swift 相对浅。

**编译型语言需要构建拦截**：JS/TS、Python 免构建（直接从源码建库）；C/C++、C#、Java/Kotlin、Swift 需要真实构建（compiler invocation）被 extractor 捕获，没有构建脚本就建不了库。[关于编译型语言（官方）](https://githubdocs.cn/en/code-security/concepts/code-scanning/codeql/about-codeql-code-scanning-for-compiled-languages)、[自定义构建步骤](https://learn.microsoft.com/training/modules/code-scanning-with-github-codeql/10-custom-build-steps-for-code-scanning)。

**QL 的声明式级别**：QL 是 **Datalog 家族**的声明式逻辑查询语言（带面向对象包装、聚合、递归谓词），Semmle 学术渊源即 Datalog；查询编译为关系代数/递归求值，**有增量/缓存式求值**（评估器缓存中间关系，改查询不重建库）。[QL 语言概述](https://codeql.github.com/docs/ql-language-reference/about-the-ql-language/)、[QL 求值](https://codeql.github.com/docs/ql-language-reference/evaluation-of-ql-programs/)。2026-03 GitHub 还上线了 PR 级**增量分析**（复用上次数据库结果，缩短 PR 扫描）。[GitHub Changelog 2026-03-24](https://github.blog/changelog/2026-03-24-faster-incremental-analysis-with-codeql-in-pull-requests/)。

**开源/免费与成本**：`github/codeql` 仓库只开源 **QL 标准库与查询（MIT）**；**引擎（extractor/compiler/evaluator）闭源**，CLI 按 CodeQL 许可分发，对研究/开源项目免费，商用（尤其 GitHub Advanced Security）收费。[github/codeql README](https://raw.githubusercontent.com/github/codeql/d1a2c0fbe4f6a03bd6e53b1b13e3e78818c9028f/README.md)。成本核心在**建库**（冷启动）——大型编译仓库建库数分钟到几十分钟不等；建完库后单条查询通常秒级。查不到官方统一「冷启动/延迟」数字，量级为上述经验值（截至 2026-08）。

**「免配置扫大仓库」支持度**：弱。JS/Python 免构建，但 C/C++/Java 等必须能构建，跨平台/无构建环境的 27 语言混合仓库基本扫不动。这正是与题设图谱引擎最大的分水岭。

**CodeQL 能力基线表**

| 维度 | CodeQL |
|---|---|
| 分析深度 | AST + 类型 + 调用图 + 数据流 + **taint（上下文/流敏感）** + CFG/SSA + IR；**无显式符号执行引擎**（靠 QL 谓词表达） |
| 语言数 | ~11（C/C++、C#、Go、Java、Kotlin、JS、TS、Python、Ruby、Rust、Swift） |
| 是否需要构建 | **编译型语言需要**（C/C++/C#/Java/Kotlin/Swift）；JS/TS/Python 免构建 |
| 查询语言/规则 | QL（Datalog 家族，声明式+递归+增量求值）；查询库开源（MIT） |
| 增量 | 有（DB 复用 + 2026 起 PR 级增量分析） |
| 许可证 | 库/查询 MIT；**引擎+CLI 闭源**，商用收费 |
| 单仓库规模上限 | 与能构建的体量挂钩；大型编译仓库建库分钟~数十分钟级，无明确公开上限 |

---

## 2. Semgrep（Semgrep, Inc.，前 r2c）

**本质是模式匹配，不是图谱**：Semgrep 核心引擎做的是**把规则写成「像源代码一样」的模式，在 AST 上做语法树匹配**，不是建调用图/依赖图。[Semgrep DeepWiki「Pattern Matching Engine」](https://deepwiki.com/semgrep/semgrep/2.1-ast-and-pattern-matching)。官方一句话自述即「Find bug variants with patterns that look like source code」[GitHub README](https://github.com/semgrep/semgrep)。

**Metavariable / taint mode 原理与局限**：`$X` 这类 **metavariable** 捕获模式中匹配到的子表达式，再配合 `metavariable-regex`、`metavariable-pattern`、comparison 等约束。**Taint mode** 是「伪跨函数数据流」——用 `pattern-sources`/`pattern-sinks`/`pattern-sanitizers` 三组模式声明 source/sink/sanitizer，引擎在这些**单文件内的函数间**做污点传播；原理是启发式+部分常量传播/流敏感，**不是完整过程间类型化数据流**，局限在跨文件边界即失效（OSS 版单文件）。[官方 Taint mode 文档](https://semgrep.dev/docs/writing-rules/data-flow/taint-mode)、[「Demystifying Taint Mode」博客](https://semgrep.dev/blog/2022/demystifying-taint-mode/)。

**规则库规模**：官方 Semgrep Registry + `semgrep/semgrep-rules` 社区仓库，规模为**数千条社区规则**（官方口径 thousands，且持续增长；无法给稳定精确数，截至 2026-08）。[semgrep-rules 仓库](https://github.com/semgrep/semgrep-rules)。

**语言支持**：OSS 支持**约 30 种语言**（含树解析器 tree-sitter 系 + 泛型解析，成熟度分 Beta/GA 分层）。[官方 Supported languages](https://semgrep.dev/docs/supported-languages/)。

**Pro engine 比 OSS 多了什么**：**跨文件（interfile）+ 跨过程（interprocedural）+ 类型化（typed metavariable/类型推断）**的深层数据流；OSS 基本单文件模式匹配。Pro 定位「30+ 企业级语言的 SAST」，是付费商业能力。[Semgrep Pro Engine](https://semgrep.dev/products/pro-engine/)、[Semgrep vs CE 对比](https://semgrep.dev/products/semgrep-vs-ce/)。

**性能与增量**：OSS 单文件、并行、极快（本地毫秒~秒级单文件）；增量天然是「只扫 diff 文件」。跨文件 Pro 分析更慢。无独立「图谱」可言。

**确认「不是图谱」的证据**：其数据模型只有「AST + 匹配结果」，官方文档与架构说明中不存在 CFG/调用图/依赖图/属性图等结构；dataflow 是「taint 模式」这一受约束的匹配扩展，而非可达性图查询。[DeepWiki Pattern Matching Engine](https://deepwiki.com/semgrep/semgrep/2.1-ast-and-pattern-matching)、[Taint mode 文档](https://semgrep.dev/docs/writing-rules/data-flow/taint-mode)。

**Semgrep 能力基线表**

| 维度 | Semgrep |
|---|---|
| 分析深度 | **AST 模式匹配**为主；类型（Pro/typed）；taint 为受限跨函数数据流；**无调用图/依赖图** |
| 语言数 | OSS ~30（分层成熟度）；Pro 面向 30+ 企业语言做跨文件 |
| 是否需要构建 | **免构建**（直接解析源码） |
| 查询语言/规则 | YAML 规则 + 类源码模式 + metavariable；Registry 数千条 |
| 增量 | 好（按文件/diff，单文件天然可增量化） |
| 许可证 | OSS 引擎 LGPL；Pro/AppSec 平台闭源付费 |
| 单仓库规模上限 | 大（并行扫文件），但分析深度随跨文件能力（Pro）才延伸 |

---

## 3. SonarQube（SonarSource）

**架构（Scanner → 服务端分析 → 数据库）**：Scanner 在构建机/CI 上采集源码与构建信息，上传到 SonarQube Server；**分析计算在服务端**完成，结果入库（PostgreSQL），前端 Web 展示。官方把分析拆成「scanner → compute engine（分析）→ 存储」。[官方 Concepts](https://docs.sonarsource.com/sonarqube-server/10.2/user-guide/concepts.md)、[架构概述（第三方）](https://www.c-sharpcorner.com/blogs/how-sonarqube-works-architecture-overview-and-workflow)。

**前端/后端分析器 + 符号执行**：每语言有专属 analyzer；安全规则依赖自研**符号执行引擎（symbolic execution / SE engine）**做路径探索与污点传播（社区可见「Running symbolic analysis for JS」等运行态证据；C# 侧有 SE 相关规则迁移 issue）。[符号分析运行态（社区）](https://community.sonarsource.com/t/sonarqube-enterprise-stuck-at-running-symbolic-analysis-for-js/120930)、[SE 规则迁移 issue](https://github.com/SonarSource/sonar-dotnet/issues/7301)。

**规则数量级**：官方口径「公开规则集含 **thousands of rules**（数千条），覆盖 **40+ 语言与框架**」——语言专用规则而非单一通用规则。[SonarSource Languages 页](https://www.sonarsource.com/knowledge/languages/)。

**类型解析/调用图程度**：依赖编译产物/字节码做类型解析，能建**符号表+调用关系**（如 Java 用字节码、.NET 用 Roslyn），但对跨模块/动态语言的调用图深度弱于 CodeQL 的全数据库级可达性分析。官方未承诺「全调用图」，属「够定位缺陷」级别。

**四象限（clean code taxonomy）**：Sonar 把 issue 归入 **Bug / Vulnerability / Code Smell / Security Hotspot** 四类（外加 Reliability/Security/Maintainability 三种属性评级 + Quality Gate）。这是其「代码质量」而非纯「安全」的定位核心。[官方 Concepts（Issue types）](https://docs.sonarsource.com/sonarqube-server/10.2/user-guide/concepts.md)。

**构建要求**：多数语言靠 scanner 直接解析（Java 需 .class/字节码）；**C/C++/Objective-C 必须用 build-wrapper 包裹真实编译**才能分析。[C/C++ build wrapper（官方）](https://docs.sonarsource.com/sonarqube-server/9.8/analyzing-source-code/languages/c-family)、[Cloud 版 C 家族先决条件](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/languages/c-family/prerequisites)。

**规模与增量**：面向**百万行级（millions of LOC）**单仓库与大型企业部署（Server/Data Center 支持多节点）；**PR 分析/增量**（只分析变更代码 + 与主分支对比）是商业版卖点。

**闭源/社区版差异**：Community Build（免费开源，原 Community Edition，LGPL/SSAL 系）只含少量核心语言/规则与基本质量门；**Developer/Enterprise/Data Center 商业版**才含全部语言、安全规则（SE 引擎深度规则）、PR 增量分析、分支管理等。[官方 Editions 对比](https://docs.sonarsource.com/sonarqube-server/discovering/sonarqube-server-editions.md)、[Why upgrade from Community Build](https://www.sonarsource.com/products/sonarqube/why-upgrade/community-build/)。

**SonarQube 能力基线表**

| 维度 | SonarQube |
|---|---|
| 分析深度 | AST + 类型解析（依赖字节码）+ 符号表/调用关系 + **符号执行（SE）**做污点/路径分析 |
| 语言数 | **40+ 语言与框架**（官方口径） |
| 是否需要构建 | 多数免构建；**C/C++/Obj-C 需 build-wrapper**；Java 需字节码 |
| 查询语言/规则 | 无用户查询语言；**内置规则（数千条，语言专用）**，可自定义（XML/Java 插件） |
| 增量 | 有（PR 分析/增量，商业版） |
| 许可证 | Community Build 开源（免费）；Developer/Enterprise/Datacenter **闭源付费** |
| 单仓库规模上限 | 官方定位**百万行级**，Enterprise/Datacenter 支持多节点扩展 |

---

## 4. Snyk Code（DeepCode 内核）

**DeepCode AI 架构：符号执行 + 语义图 + ML**：Snyk 2020 年收购的 DeepCode（ETH Zürich 分拆，Martin Vechev 实验室）把代码转成**语义表示图（程序依赖图/属性图一类）+ 符号执行**，再叠加在**海量真实开源提交（fix commit）上训练的机器学习**做缺陷识别与排序，号称「符号执行 + 语义图 + ML 三合一」。[ETH 收购新闻](https://ethz.ch/en/news-and-events/eth-news/news/2020/09/deepcode.html)、[DeepCode AI 训练方式（OSS commits）](https://safeguard.sh/resources/blog/inside-deepcode-ai-how-snyk-codes-ml-models-are-trained-on-open-source-commit-history)、[语义图 vs 模式匹配](https://safeguard.sh/resources/blog/why-snyk-codes-semantic-approach-produces-fewer-false-positives-than-pattern-matching-sast)。

**声称的准确率**：Snyk 官方口径强调「语义分析比纯模式匹配**误报更少**」，DeepCode 学术/营销早期曾宣称在 OWASP Benchmark 上高精度（低误报、高真阳性）；但**具体 Benchmark 数字（如 96% precision）在 2025-2026 官方文档中已无稳定可复现口径，属早期营销材料**——此处不引用具体百分比，避免失实（截至 2026-08）。第三方 2025-2026 独立评测（如 15 款扫描器实测、AppSec Santa 对比、SCITEPRESS 2025 论文）可作参照。[独立评测 15 扫描器](https://www.kolega.dev/blog/we-ran-15-security-scanners-against-real-vulnerabilities-the-results-arent/)、[SAST 对比 2026](https://appsecsanta.com/sast-tools)、[SCITEPRESS 2025 论文](https://www.scitepress.org/Papers/2025/135241/135241.pdf)。

**语言支持 + 免构建 + 跨文件**：Snyk Code 支持 ~17 组语言——Apex、C/C++、COBOL、Dart/Flutter、Elixir、Go、Groovy、Java/Kotlin、JavaScript、.NET(C#/VB.NET)、PHP、Python、Ruby、Rust（limited）、Scala、Swift/Objective-C、TypeScript；**完全免构建**，且官方明确「**Interfile（跨文件）分析对所有支持语言可用**」——即它确实在语义图层面做了跨文件。[Snyk 官方 Supported languages](https://docs.snyk.io/supported-languages/supported-languages-package-managers-and-frameworks)。（注：C/C++ 非托管扫描与 Go 需仓库有官方 release/tag 供定位。）

**商业水平证明**：Snyk Code 证明了一条「**静态语义图 + 符号执行 + 启发式/ML**」路线可以做到商业可用的低误报 SAST，但它的图是**内部引擎私产、不可查询、不导出、无用户可见图结构**，只为「找缺陷 + 排序 + AI 修复」服务——与「把依赖图交给用户/LLM 查询」是两回事。

**Snyk Code 能力基线表**

| 维度 | Snyk Code（DeepCode） |
|---|---|
| 分析深度 | AST + 类型 + **语义图（程序依赖/属性图）+ 符号执行** + ML 排序 |
| 语言数 | ~17 组（含 COBOL/Apex/Scala 等企业语言）；Rust limited |
| 是否需要构建 | **免构建**；跨文件分析对所有支持语言可用 |
| 查询语言/规则 | 无用户查询语言；规则为**闭源引擎内置**（AI 生成+维护） |
| 增量 | 有（增量扫描/PR 集成） |
| 许可证 | **完全闭源**，SaaS/订阅（`snyk code test` 需账号） |
| 单仓库规模上限 | 面向仓库级/平台级 SaaS，具体上限不公开 |

---

## 5. 总结：27 语言、免构建、tree-sitter 图谱引擎，与这四家的关系

**根本不在一个赛道的维度（差异是「品类」不是「差距」）**：

1. **产出物不同**：四家产出「缺陷列表 + 规则命中 + 优先级」，题设引擎产出「**可查询、可导出的依赖/耦合图 + 33 个图查询工具**」。这是**图数据库/图谱引擎 vs 规则扫描器**的区别——CodeQL 最接近「数据库」，但它只给 GitHub 的闭源引擎自己用，用户拿不到图；Snyk 的语义图更是纯内部私产。四家没有一个把图暴露给用户或 LLM。

2. **查询范式不同**：只有 CodeQL 有真正的用户可写查询语言（QL/Datalog，声明式+递归+增量）；Semgrep 是「类源码模式」，SonarQube/Snyk 是「写死的内置规则」。题设引擎把「查询」泛化到 NL explore + 图算法（社区/BFS/环/耦合），是另一套抽象。

3. **语言广度 vs 深度**：四家的语言数（CodeQL ~11 / Semgrep ~30 / Sonar 40+ / Snyk ~17）都不如 27 语言×tree-sitter 的「覆盖广度」，但反过来，CodeQL/SonarQube/Snyk 在**少数主流语言上的语义深度（类型、调用图、污点、符号执行）远深于 tree-sitter 语法层**。tree-sitter 是**语法树**，不是**语义/类型/数据流**层——27 语言广度是「解析覆盖」，不是「语义分析深度」。

**不是同一类产品的维度（直接对不上的）**：

- **免构建 vs 需构建**：CodeQL（编译型）、SonarQube（C/C++）都需要真实构建；Semgrep、Snyk Code 免构建。题设引擎免构建，在这一维度与 Semgrep/Snyk 对齐、与 CodeQL/Sonar 的 C/C++ 路径不对齐。
- **污点/符号执行**：题设引擎（tree-sitter 语法层）**没有** CodeQL 的上下文敏感污点、SonarQube/Snyk 的符号执行。这是四家在「安全缺陷检测」上仍领先的维度，也是自研引擎最不该直接去「对标」的维度——除非它把 tree-sitter 换成语义前端。
- **规则/知识沉淀**：四家各有数千条高质量语言专用规则 + 长期 CVE/框架模型积累；自研引擎没有这套「缺陷知识库」，但它也**不声称做缺陷检测**，而是做依赖可见性/架构分析（耦合环、数据流环、路由、盲点）。

**一句话结论**：题设引擎与这四家是**两个正交坐标轴**——四家是「浅图（内部用）→ 深规则 → 找缺陷」，题设是「浅解析（27 语言）→ 显式图 → 给人和 LLM 查询」。真正的差距不在「图谱」能力（四家大多没有用户可用的图谱），而在**语义深度（类型/污点/符号执行）与规则知识库**；真正的优势在**多语言免构建覆盖 + 图可查询可对话 + 架构级分析**，这是四家都没有的产品形态。若要在安全缺陷维度追平，必须补语义层；若守住「依赖星图/架构可视化/MCP 直查图」的定位，则与四家不存在正面竞争。
