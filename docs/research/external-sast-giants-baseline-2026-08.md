# 商业 SAST 巨头与开源安全图谱/学术血统 —— 外部事实基线（第二轮）

> 检索时间：2026-08-15。GitHub 活跃度（stars/最近 push/最近 release/许可证）为 2026-08-15 实时抓取 `api.github.com` 所得；历史事实以 Wikipedia/官方文档/原始论文为准。查不到的标注「截至 2026-08 无公开口径」。
>
> 每节固定字段：一句话定性 / 分析深度 / 语言数 / 是否需构建 / **图是否暴露给用户** / 许可证与价格 / 活跃度 / 来源。

---

## 1. Coverity（Synopsys → Black Duck）

- **一句话定性**：商业 SAST 的「开山鼻祖」级工具，C/C++ 深语义分析标杆，几十年历史地位。
- **分析深度**：语言前端 + 语义分析，招牌是 **interprocedural path analysis（过程间路径分析）**——跨函数追踪缺陷路径（空指针解引用、内存/资源泄漏、并发缺陷、死代码等）。引擎闭源，公开材料只承诺「语义级 + 过程间」，无公开形式化说明（非 Datalog/非分离逻辑路线）。[AppSec Santa 评测](https://appsecsanta.com/coverity)
- **语言数**：约 20+（C、C++、C#、Java、JavaScript、Python、Ruby、PHP、Swift、Kotlin、Go、Objective-C 等；Wikipedia 明确列 Java/JavaScript/C# 并称「and other languages」）。截至 2026-08 无官方统一精确数字。[Wikipedia](https://en.m.wikipedia.org/wiki/Coverity)
- **是否需构建**：**是**——编译型语言需真实构建（编译器调用捕获），与 CodeQL/Sonar 的 C/C++ 路径一致。
- **图是否暴露给用户**：**否**。输出是缺陷列表 + 数据流 trace 报告，内部图（AST/CFG/调用图）完全私有。
- **许可证与价格**：完全闭源，企业级年度订阅（按 LOC/席位，价格巨头级，通常不公开）。Synopsys 2014-02 收购；2024 年 Synopsys 软件完整性集团更名 **Black Duck Software**。
- **历史/活跃度**：**2002 年**成立于斯坦福计算机系统实验室（Benjamin Chen、Andy Chou、David Park、Seth Hallem，与 Dawson Engler 教授）；2006 年与美国国土安全部合作「Coverity Scan」扫 150+ 开源项目、驱动修复 6000+ 缺陷。持续商业化运营中。[Wikipedia](https://en.m.wikipedia.org/wiki/Coverity)
- **来源**：[Wikipedia](https://en.m.wikipedia.org/wiki/Coverity) · [AppSec Santa 2026 评测](https://appsecsanta.com/coverity)

---

## 2. Fortify（OpenText，前 Micro Focus / HP）

- **一句话定性**：与 Coverity 齐名的老牌 SAST 巨头，核心是「安全规则库（Rulepacks）+ Dataflow Analyzer」。
- **分析深度**：语言前端 → AST/IR → **Dataflow Analyzer（过程间数据流/污点分析器）** + 语义分析 + 控制流分析；规则以 Fortify Rulepacks（覆盖 CWE/OWASP 的安全规则包）驱动。数据流是工程化的 interprocedural taint，非形式化声明式。[Micro Focus Fortify SCA 文档](https://www.microfocus.com/documentation/fortify-static-code-analyzer-and-tools/2530/sast-ugd-html-25.3.0/doc/2263_25.3/a4ad5abf950e_sca_supportedlangs.html)
- **语言数**：25+（Java、C/C++、C#、JavaScript/TypeScript、Python、PHP、Ruby、Swift、Kotlin、Go、VB.NET、COBOL、ABAP、Scala 等）。
- **是否需构建**：部分需要——编译型语言需构建或 build 集成（有 build integration 模式）；脚本/解释型语言免构建。
- **图是否暴露给用户**：**否**。报告 + 数据流 trace，图私有。
- **许可证与价格**：闭源，企业级订阅（OpenText Cybersecurity Cloud），贵。
- **历史/活跃度**：**2003 年**成立于加州 San Mateo；2010 被 HP 收购；2017 并入 Micro Focus；2023 年 Micro Focus 被 OpenText 收购。仍在售与迭代。[Wikipedia](https://en.wikipedia.org/wiki/Fortify_Software)
- **来源**：[Wikipedia](https://en.wikipedia.org/wiki/Fortify_Software) · [Micro Focus 支持语言（官方文档 25.3）](https://www.microfocus.com/documentation/fortify-static-code-analyzer-and-tools/2530/sast-ugd-html-25.3.0/doc/2263_25.3/a4ad5abf950e_sca_supportedlangs.html)

---

## 3. Checkmarx

- **一句话定性**：企业 SAST 平台，自有查询语言 **CxQL** 可直接查内部数据流图，2023 后整体 AI 化。
- **分析深度**：AST + 数据流/污点；**CxQL** 是类 SQL 的专用查询语言，官方「Query Structure」文档显示查询建立在数据流图的节点/边上（query 可遍历 source→sink 的数据流路径）。2023 起产品线并入 **Checkmarx One** 平台，2025 发布 AI-powered v3.0（LLM 辅助 + AI 修复）。[CxQL Query Structure](https://checkmarx.atlassian.net/wiki/spaces/KC/pages/5406747/Query%2bStructure) · [Checkmarx One 3.0 AI](https://itdigest.com/cloud-computing-mobility/checkmarx-releases-version-3-0-of-ai-powered-checkmarx-one-enterprise-appsec-platform/)
- **语言数**：约 25+ 主流语言与框架（官方按语言文档分列，如 Java/.NET/JS/Python/Go 等）。
- **是否需构建**：以**免构建源码解析**为主，部分编译型语言可选构建集成。
- **图是否暴露给用户**：**部分**——CxQL 让用户对内部数据流图做查询（这是四家当代巨头里最接近「图查询」的），但图本身**不导出、不可作为通用图谱**，仍是「规则引擎」而非「图谱产品」。
- **许可证与价格**：闭源 SaaS/企业订阅，贵。
- **历史/活跃度**：2006 年成立于以色列；2023 起 Checkmarx One 平台化 + AI 化，2025-2026 持续发布 AI 版本。[Global Security Mag](https://www.globalsecuritymag.fr/Checkmarx-Releases-Version-3-0-of-AI-Powered-Checkmarx-One-TM-Enterprise-AppSec.html)
- **来源**：[CxQL Query Structure](https://checkmarx.atlassian.net/wiki/spaces/KC/pages/5406747/Query%2bStructure) · [Checkmarx One 3.0（itdigest）](https://itdigest.com/cloud-computing-mobility/checkmarx-releases-version-3-0-of-ai-powered-checkmarx-one-enterprise-appsec-platform/)

---

## 4. Klocwork（Perforce）

- **一句话定性**：C/C++/Java/C# 老厂，绑定**使命关键**场景（航空/汽车/医疗/国防）的编码规范与构建深度集成。
- **分析深度**：深语义分析 + interprocedural 数据流 + **编码规范合规**（MISRA、AUTOSAR、CERT C/C++、DO-178C 等）；对 C/C++ 的构建集成是卖点（需捕获编译以做精确分析）。[Perforce Klocwork datasheet](https://www.perforce.com/sites/default/files/pdfs/datasheet-klocwork-sast.pdf)
- **语言数**：C、C++、C#、Java、JavaScript、Python（官方 datasheet 口径）。[Wikipedia](https://en.m.wikipedia.org/wiki/Klocwork)
- **是否需构建**：**是**——C/C++ 需构建捕获（compiler wrapper 式集成）。
- **图是否暴露给用户**：**否**。
- **许可证与价格**：闭源，Perforce 企业订阅（面向军工/汽车，价格高）。
- **历史/活跃度**：**2001 年**成立于渥太华，**Nortel Networks 分拆**（技术血统可上溯 1990s Nortel）；2014 被 Rogue Wave 收购，2019 年随 Rogue Wave 并入 Perforce。仍在售（Perforce 继续以 Klocwork 品牌开发）。[Wikipedia](https://en.m.wikipedia.org/wiki/Klocwork)
- **来源**：[Wikipedia](https://en.m.wikipedia.org/wiki/Klocwork) · [Perforce Klocwork SAST datasheet](https://www.perforce.com/sites/default/files/pdfs/datasheet-klocwork-sast.pdf)

---

## 5. PVS-Studio

- **一句话定性**：俄罗斯独立厂商，C/C++/C#/Java 深数据流分析，开放 CVE 数据库、价格亲民路线。
- **分析深度**：自研**数据流分析引擎** + 模式匹配 + 类型注解，支持**模块间（intermodular）分析**（跨翻译单元）；诊断以 Vxxx 编号体系组织。厂商维护开放的漏洞/缺陷案例库（含真实 CVE 案例）。[PVS-Studio 数据流术语](https://pvs-studio.com/en/blog/terms/7004/) · [Intermodular analysis（官方博客）](https://pvs-studio.com/en/blog/posts/cpp/0965/)
- **语言数**：C、C++、C#、Java（为主）。
- **是否需构建**：需**预处理/编译监控**（C/C++ 需预处理后的代码，通过监控编译命令获取）。
- **图是否暴露给用户**：**否**。
- **许可证与价格**：闭源，但**价格亲民**（单席位年费几百美元级，显著低于巨头；个人/团队可负担）。
- **活跃度**：持续活跃，博客、诊断文档、CVE 库长期更新。[PVS-Studio 技术博客](https://pvs-studio.com/en/blog/posts/cpp/0592/)
- **来源**：[数据流术语](https://pvs-studio.com/en/blog/terms/7004/) · [Intermodular 分析](https://pvs-studio.com/en/blog/posts/cpp/0965/) · [技术博客](https://pvs-studio.com/en/blog/posts/cpp/0592/)

---

## 6. Cppcheck

- **一句话定性**：开源 C/C++ 静态分析的事实标准之一，**valueflow（值流）**是其有限数据流能力的招牌。
- **分析深度**：语法/语义检查器为主，配**value flow analysis（值流分析）**——有限的数据流/常量传播，能跨若干表达式与函数边界追踪变量值（例如追踪 `x` 是否为 null/越界），但不是完整类型化数据流；内置大量内存/资源/未定义行为检查器。[DeepWiki：Value Flow Analysis](https://deepwiki.com/cppcheck-opensource/cppcheck/2.4-value-flow-analysis)
- **语言数**：C、C++（为主，有少量 C++/preprocessor 支持）。
- **是否需构建**：**免构建**（预处理即可，可选）。
- **图是否暴露给用户**：**否**。
- **许可证与价格**：免费开源 **GPL-3.0**；另有商业版 Cppcheck Premium。
- **活跃度**：持续活跃，社区广泛（Linux 发行版/IDE 默认集成）。
- **来源**：[DeepWiki Value Flow](https://deepwiki.com/cppcheck-opensource/cppcheck/2.4-value-flow-analysis) · [Cppcheck 官网](https://cppcheck.sourceforge.io/)

---

## 7. Frama-C（法国 CEA）

- **一句话定性**：法国 CEA 的**形式化验证框架**——ACSL 契约 + Eva 抽象解释 + WP 演绎验证，科研/工业最高严谨度梯队。
- **分析深度**：**形式化方法全家桶**：ACSL（ANSI/ISO C Specification Language，一阶逻辑契约语言）标注前后条件/不变量；**Eva = 抽象解释器**（sound over-approximation，自动推断程序性质）；**WP = 演绎验证**（把标注转成 verification conditions 交 SMT/定理证明器，需用户写循环不变量）；**E-ACSL = 运行时断言检查**。这是「能证明性质」的层级，远超「找 bug」。[frama-c.com](https://frama-c.com/)
- **语言数**：C（为主；Frama-Clang 可部分处理 C++）。
- **是否需构建**：**免构建**（源码级 + 预处理）。
- **图是否暴露给用户**：**部分**——通过 OCaml 插件 API 可编程访问 AST/CFG/结果，但无面向终端用户的交互式图。
- **许可证与价格**：核心开源 **LGPL**；部分能力依赖外部 SMT/证明器（Why3、Alt-Ergo、Z3 等）。
- **历史/活跃度**：**2000s 起 CEA-List（法国原子能与替代能源委员会）**持续开发；当前版本 **32.0 "Germanium"**（2026），仍活跃。[opam 包](https://opam.ocaml.org/packages/frama-c-base/)
- **来源**：[frama-c.com](https://frama-c.com/) · [opam frama-c-base](https://opam.ocaml.org/packages/frama-c-base/)

---

## 8. Infer（Meta）

- **一句话定性**：Meta（Facebook）开源的**分离逻辑（separation logic）+ 过程间分析**静态分析器，Java/C/C++/Obj-C 的移动/后端 bug 检测。
- **分析深度**：**分离逻辑 + bi-abduction** 驱动的过程间分析（forward/backward），检测 null deref、资源泄漏、竞态（RacerD）、Java 生命周期问题等；含抽象解释组件。这是「可扩展过程间分析」的学术级工程化。[HandWiki：Infer](https://handwiki.org/wiki/Infer_Static_Analyzer)
- **语言数**：Java、C、C++、Objective-C（官方描述「A static analyzer for Java, C, C++, and Objective-C」）。
- **是否需构建**：**是**（capture 编译命令）。
- **图是否暴露给用户**：**否**。
- **许可证与价格**：开源 **MIT**。
- **历史/活跃度（重点查证）**：**2015 年开源**。**「2024 后停更/移交社区」说法不成立**——截至 2026-08-15 实测：仓库未 archived，最新 release **v1.3.0 发布于 2026-05-12**，最近 push 2026-08-12，15674 stars，仍驻留在 `facebook/infer` 组织；PLDI 2024 有专门 Infer workshop，未发现移交基金会的正式证据。[GitHub facebook/infer](https://github.com/facebook/infer) · [Infer 2024 workshop（PLDI）](https://pldi24.sigplan.org/details/infer-2024-papers/4/Bridging-the-Gap-For-Security-Analysis-In-Infer)
- **来源**：[GitHub](https://github.com/facebook/infer) · [HandWiki](https://handwiki.org/wiki/Infer_Static_Analyzer) · [PLDI 2024 Infer workshop](https://pldi24.sigplan.org/details/infer-2024-papers/4/Bridging-the-Gap-For-Security-Analysis-In-Infer)

---

## 9. Joern（Qwiet AI，前 ShiftLeft）★ 与 HoloGram 结构最接近

- **一句话定性**：开源**代码属性图（Code Property Graph, CPG）**平台——把多语言源码/二进制统一成一张融合 AST+CFG+PDG 的图，用查询语言查图，是「图谱引擎」这条赛道上 HoloGram 的头号对标。
- **分析深度**：**CPG = AST + CFG + PDG（程序依赖图）+ 调用图 + 类型**的多层融合图，跨语言统一表示；查询用 **Scala DSL + Odin 查询语言**（交互式 shell），底层图存 **OverflowDB**（图数据库）；支持数据流/污点遍历（`reachableBy` 等图遍历原语）。[CPG 文档](https://docs.joern.io/code-property-graph/) · [joern.io](https://joern.io/impact/)
- **语言数**：**C/C++、Java、JavaScript、Python、Kotlin、二进制**（README 官方口径），另有 Go、Ruby、PHP、Swift、C# 等前端（含第三方）。二进制前端走 **Ghidra（`joernio/ghidra2cpg`）**。[GitHub joernio/joern](https://github.com/joernio/joern) · [ghidra2cpg](https://index.scala-lang.org/joernio/ghidra2cpg)
- **是否需构建**：**免构建**（源码级解析）；二进制经 Ghidra 反汇编。
- **图是否暴露给用户**：**是（完全暴露）**——CPG 本身就是给用户查询/遍历的对象，这是它与四家商业巨头、以及多数学术工具最本质的区别，也是与 HoloGram 定位重叠的根因。
- **许可证与价格**：**Apache-2.0**（不是 AGPL），免费开源；Qwiet AI（原 ShiftLeft）卖商业版（Ocular / preZero，CPG 之上的商业化查询与规则）。
- **历史/血统**：**Fabian Yamaguchi 等 2014 年 IEEE S&P 论文《Modeling and Discovering Vulnerabilities with Code Property Graphs》**确立 CPG 概念（该文获 IEEE S&P Test-of-Time Award）；ShiftLeft 将 Joern 开源，Ocular 是其商业 CPG 查询工具，Octopus 是内部二进制 CPG 前端，Ghidra 关系即 `ghidra2cpg`。[论文（Semantic Scholar）](https://www.semanticscholar.org/paper/Modeling-and-Discovering-Vulnerabilities-with-Code-Yamaguchi-Golde/07c4549be429a52274bc0ec083bf5598a3e5c365) · [Test-of-Time 报道](https://www.bifold.berlin/news-events/news/view/news-detail/ieee-test-of-time-award-for-konrad-rieck-173)
- **活跃度**：**极活跃**——截至 2026-08-15：v4.0.604 发布于 2026-08-14（几乎每日发版），3418 stars，未 archived。
- **来源**：[docs.joern.io](https://docs.joern.io/code-property-graph/) · [GitHub joernio/joern](https://github.com/joernio/joern) · [论文](https://www.semanticscholar.org/paper/Modeling-and-Discovering-Vulnerabilities-with-Code-Yamaguchi-Golde/07c4549be429a52274bc0ec083bf5598a3e5c365) · [ghidra2cpg](https://index.scala-lang.org/joernio/ghidra2cpg)

---

## 10. Mariana Trench（Meta）

- **一句话定性**：Meta 开源的 Android/Java 安全**污点分析**工具，用于大规模隐私/安全漏洞排查。
- **分析深度**：基于 **Soot** 的**污点分析（taint tracking）**——source→sink 传播，支持 shims（库模型）与隐式流建模；规则用 JSON/YAML 声明式配置。[GitHub facebook/mariana-trench](https://github.com/facebook/mariana-trench)
- **语言数**：Java / Android（Kotlin 部分）。
- **是否需构建**：**是**（Android/Java 构建，2021 年 InfoQ 报道其与 Facebook 内部构建集成）。
- **图是否暴露给用户**：**否**（输出污点 trace）。
- **许可证与价格**：开源 **MIT**。
- **历史/活跃度**：2021 年开源；仍活跃（截至 2026-08-15：最近 push 2026-08-13，1247 stars，未 archived）。[InfoQ 2021](https://www.infoq.com/news/2021/10/Facebook-mariana-trench/)
- **来源**：[GitHub](https://github.com/facebook/mariana-trench) · [InfoQ 2021](https://www.infoq.com/news/2021/10/Facebook-mariana-trench/)

---

## 11. WALA（IBM）

- **一句话定性**：IBM T.J. Watson 的静态分析**库**，Java/JavaScript/Android 的调用图 + points-to 学术框架。
- **分析深度**：**调用图构建（CHA / RTA / 0-CFA 等多档）+ points-to（指针/别名）分析** + WALA IR/SSA 中间表示；前端有 Java 字节码、JavaScript、Android。是「研究者/工具作者可编程的分析库」，不是终端产品。[GitHub wala/WALA](https://github.com/wala/wala)
- **语言数**：Java、JavaScript、Android（字节码/源码前端）。
- **是否需构建**：**免构建**（用字节码或源码）。
- **图是否暴露给用户**：**是（API 级）**——调用图/points-to 结果以编程 API 暴露，面向工具作者而非终端用户。
- **许可证与价格**：开源 **EPL-2.0**。
- **历史/活跃度**：**2003 起 IBM T.J. Watson 研究中心**（数十年血统），后转社区；仍活跃（截至 2026-08-15：最近 push 2026-08-14，865 stars，未 archived）。[JS frontend wiki](https://github.com/wala/WALA/wiki/JavaScript-frontend)
- **来源**：[GitHub](https://github.com/wala/WALA) · [JavaScript frontend](https://github.com/wala/WALA/wiki/JavaScript-frontend)

---

## 12. Soot

- **一句话定性**：McGill/Sable 的 Java 分析框架，**Jimple IR + SPARK points-to**，25+ 年、无数论文与工具的地基。
- **分析深度**：把 Java 字节码转 **Jimple（三地址码 IR）**，在 Jimple 上提供 **CFG/SSA、SPARK points-to（指针/别名分析）**、调用图、数据流框架；是 Mariana Trench、以及海量学术静态分析的基础设施。[GitHub soot-oss/soot](https://github.com/soot-oss/soot) · [Wikipedia](https://en.m.wikipedia.org/wiki/Soot_(computer_science))
- **语言数**：Java（字节码）。
- **是否需构建**：**免构建**（用 .class 字节码）。
- **图是否暴露给用户**：**是（API/框架级）**。
- **许可证与价格**：开源 **LGPL-2.1**。
- **历史/活跃度**：**1996 年起 McGill 大学 Sable 实验室**（Laurie Hendren 等），后移交 `soot-oss` 社区；仍活跃（截至 2026-08-15：最近 push 2026-08-10，3098 stars，未 archived）。[Sable PLDI 2003 教程](https://sable.mcgill.ca/soot/tutorial/pldi03/tutorial.pdf)
- **来源**：[GitHub](https://github.com/soot-oss/soot) · [Wikipedia](https://en.m.wikipedia.org/wiki/Soot_(computer_science)) · [Sable 教程](https://sable.mcgill.ca/soot/tutorial/pldi03/tutorial.pdf)

---

## 13. DOOP + Soufflé（声明式 points-to 学术标杆）

- **一句话定性**：用 **Datalog（逻辑规则）声明式表达 points-to/调用图分析**的学术标杆，说明「调用图/指向分析」能做到的精确度上限与表达力。
- **分析深度**：把 points-to/调用图分析写成**纯声明式 Datalog 规则**（context-insensitive / 1-CFA / context-sensitive / selective 等各档精确度可调），运行在 **Soufflé**（把 Datalog 规则合成原生并行 C++ 的逻辑引擎）上；代表作是「Strictly Declarative Specification of Sophisticated Points-to Analyses」（Bravenboer & Smaragdakis, OOPSLA 2009）与「Porting Doop to Soufflé」（2017）。[Declarative Static Program Analysis（AUEB）](http://cslab252.cs.aueb.gr/en/node/649) · [Porting Doop to Soufflé](https://dl.acm.org/doi/10.1145/3088515.3088522) · [Selective points-to（2017）](https://dl.acm.org/doi/10.1145/3088515.3088519)
- **语言数**：Java（字节码）。
- **是否需构建**：**免构建**（字节码）。
- **图是否暴露给用户**：**是（输出级）**——points-to/调用图关系以关系表输出，供学术研究。
- **许可证与价格**：开源研究框架（DOOP 具体许可条款需查证，GitHub 镜像标记 NOASSERTION；Soufflé 开源）。截至 2026-08 无统一公开许可证口径。
- **历史/活跃度**：**约 2013-2014 起**，雅典经济与商业大学（Yannis Smaragdakis、George Kastrinis，与 O. Lhoták 等）；Soufflé 为独立 Datalog 引擎，仍活跃（2026-07 push）。[Soufflé](https://souffle-lang.github.io/)
- **来源**：[AUEB Declarative Program Analysis](http://cslab252.cs.aueb.gr/en/node/649) · [Porting Doop to Soufflé](https://dl.acm.org/doi/10.1145/3088515.3088522) · [Soufflé](https://souffle-lang.github.io/)

---

## 14. Metabob

- **一句话定性**：AI + **图神经网络（GNN）**静态分析，2026 年有实体企业落地（NEC）。
- **分析深度**：把代码转**图表示**，用 **GNN** 学习缺陷模式，再叠加 **LLM** 生成解释与修复建议；属「图学习」而非传统数据流/符号执行。[metabob.com](https://metabob.com/)
- **语言数**：主流语言（Python 等），官方未公开统一完整清单。截至 2026-08 无公开精确语言数。
- **是否需构建**：**免构建**（源码）。
- **图是否暴露给用户**：**部分/否**——图是其引擎内部表示，不面向用户导出。
- **许可证与价格**：闭源 SaaS。
- **活跃度**：活跃；**2026-02 NEC 部署**，官方称技术验证时间最高降低 **66%**（「cutting maintenance by two-thirds」）；曾获 NSF SBIR。[NEC press 2026](https://www.nec.com/en/press/202602/global_20260225_01.html) · [SBIR award](https://sbir.org/awards/nsf-2318738-1)
- **来源**：[metabob.com](https://metabob.com/) · [NEC 2026-02 新闻稿](https://www.nec.com/en/press/202602/global_20260225_01.html)

---

## 15. 对 HoloGram 的战略含义

### 15.1 「图是否暴露给用户」是最大的分水岭（本轮最关键的发现）

| 类别 | 工具 | 图暴露 |
|---|---|---|
| 商业巨头 | Coverity / Fortify / Checkmarx / Klocwork / PVS-Studio / Snyk Code / Metabob | **否**（缺陷列表 + trace；Checkmarx 的 CxQL 仅限查询内部数据流，不导出图） |
| 学术框架 | WALA / Soot / DOOP | 是，但 **API/输出级**（给研究者写分析），语言窄（基本 Java），非终端产品 |
| 形式化 | Frama-C | 部分（OCaml 插件 API） |
| **开源图谱平台** | **Joern** | **是，完全暴露给用户**（CPG 就是查询对象） |

结论：**Joern 是唯一一个「开源 + 多语言 + 免构建 + 图完全暴露」的工具**，与 HoloGram 的产品定位重叠最高。上一轮把 CodeQL/SonarQube 当对标是「维度错位」——它们是「用图找缺陷」的黑箱；**HoloGram 真正的同赛道参照是 Joern**。建议把 Joern 列为头号对标与「差距基线」，而非四家当代 SAST。

### 15.2 语义深度天花板：tree-sitter 语法层够不到，但有清晰借鉴路径

- **DOOP + Soufflé / CodeQL QL** 证明「调用图 + points-to + 污点」的最高表达力在 **Datalog 声明式**路线（`Porting Doop to Soufflé` 是标杆工程）；这是 HoloGram 若要补语义层最值得抄的两条路。
- **Soot/WALA** 证明「Jimple 三地址码 IR + SPARK points-to」是 Java 生态 25 年的地基；**Infer 分离逻辑**是「可扩展过程间分析」的另一极端。这些都需要字节码/编译器集成或构建捕获，**不是 tree-sitter 能复制的**。
- 因此 HoloGram 的战略不是「在语义深度上追平它们」，而是**守住「27 语言统一 IR + 免构建 + 图可对话（MCP）」这条它们都没走的路**，同时用 Joern 的 CPG 分层（AST+CFG+PDG 融合）作为「IR 层」的升级方向。

### 15.3 活跃度修正（避免误判「老工具已死」）

- **Infer 未停更**：v1.3.0（2026-05-12）、未 archived、仍在 facebook 组织——「2024 后移交社区」不成立（截至 2026-08）。
- **Joern 几乎日更**（v4.0.604，2026-08-14）；WALA/Soot/Soufflé/Mariana Trench 均 2026 年活跃。
- 结论：这些「老厂/老框架」的**技术资产仍在流动**，HoloGram 持续对标时需要跟踪它们的版本而非一次性定论。

### 15.4 许可证格局（可自由借鉴的资产清单）

| 工具 | 许可证 | 对 HoloGram 的意义 |
|---|---|---|
| Joern | Apache-2.0 | **可放心借鉴 CPG/OverflowDB/Odin 设计**（无传染） |
| Infer / Mariana Trench | MIT | 可参考分离逻辑/污点工程实现 |
| WALA | EPL-2.0 | 可参考调用图/points-to API 设计 |
| Soot | LGPL-2.1 | 可参考 IR（Jimple）/SPARK 分层 |
| Cppcheck | GPL-3.0 | **注意传染性**，只参考思路、勿抄代码 |
| Frama-C | LGPL | 可参考 ACSL/Eva 的「规格化 + 抽象解释」分层 |

### 15.5 一句话战略结论

HoloGram 与这 14 家（以及上一轮四家）的竞争坐标系里，**唯一的结构性同赛道者 = Joern**；其余都是「图私有/图仅供研究/单语言」的错位选手。HoloGram 的护城河 = **多语言（27）+ 免构建 + 图显式可对话可导出（MCP）**，这是 Joern 之外无人同时具备的三角；而「语义深度（类型/调用图/points-to/污点）」是唯一真实短板，补法应从 **Joern 的 CPG 分层**与 **DOOP/Soufflé 的 Datalog 声明式分析**两条路取经，而非去追 Coverity/Fortify 的闭源工程堆料。
