# 架构治理老厂、可视化/度量工具与学术血统 — 基线调研

> 用途：补齐「代码图谱工具差距报告」第二轮——覆盖这个领域四十年的「另一半」：架构治理商业老厂、可视化/度量工具、以及学术源头。
> 采集方式：web_search + 直接抓取 Wikipedia / 官方文档 / ACM 论文 / 厂商页。采集日期 2026-08。
> 每个工具一节，字段固定为：一句话定性 / 分析深度 / 查询或规则语言 / 语言数 / 许可证与价格 / 活跃度 / 来源 URL。
> 历史事实若查不到一手口径，统一标「截至 2026-08 无公开口径」。

**先给三处历史修正（写报告前必看）：**

1. **ctags 主作者是 Ken Arnold，不是 Bill Joy。** 原版 ctags 随 BSD Unix 2.0 引入，由 Ken Arnold 编写；Jim Kleckner 贡献 Fortran 支持、**Bill Joy 只贡献 Pascal 支持**（[Wikipedia: ctags](https://en.wikipedia.org/wiki/Ctags)）。「1979 Bill Joy 写 ctags」不准确。
2. **cscope 是「1980 年代初」而非精确的「1985」。** Joe Steffen 在 PDP-11 上于 1980 年代初开始写 cscope，后进入 AT&T Unix 发行，2000-04 由 SCO 以 BSD 开源（[Wikipedia: cscope](https://en.wikipedia.org/wiki/Cscope)）。
3. **Bauhaus 项目始于 1996（斯图加特大学），Axivion 公司 2005 分拆，2022-08-11 被 Qt Group 收购**（[Wikipedia: Bauhaus Project](https://en.wikipedia.org/wiki/Bauhaus_Project_(computing))）。

---

## 1. NDepend

- **一句话定性**：.NET 生态的依赖图 + 度量 + 规则工具，核心卖点是 **CQLinq**——「把代码模型当数据库用 LINQ 查」——与 HoloGram「图查询」产品形态最接近的商业工具。
- **分析深度**：**符号级 + 类型级 + 调用级**。模型覆盖程序集/命名空间/类型/方法/字段/属性，以及它们的依赖关系；度量含 LOC、圈复杂度、耦合、嵌套深度、Rank 等。**不是纯文件级 import 图**，而是面向 .NET 类型系统的关系图。
- **查询或规则语言（关键）**：**CQLinq = Code Query over LINQ**。在抽象代码模型上跑 C# LINQ，例如 `from m in Methods where m.NbLinesOfCode > 30 select m`——「像查数据库表一样查代码」（[CQLinq 特性页](https://www.ndepend.com/features/cqlinq)、[CQLinq 语法文档](https://www.ndepend.com/docs/cqlinq-syntax)）。配套：**数百条默认规则**、**依赖图 + 依赖矩阵**、**质量门（PASS/WARN/FAIL，卡 CI）**、**NDepend.API.dll**（供二次开发建自己的分析工具）、可导入 Roslyn/ReSharper 检查项；v2026 起还发布了 **MCP Server**（让 LLM/Agent 直接查代码质量数据）——这一步与 HoloGram 的 MCP 工具路线同构。
- **语言数**：1 个平台（.NET，C# 为主；VB.NET/F# 有限支持）。
- **许可证与价格**：**商业闭源**，14 天试用；分 Developer / Build-Machine / Azure DevOps / GitHub Action 版本（[NDepend 特性页](https://www.ndepend.com/features/)）。
- **活跃度**：活跃（官网当前版本 v2026.1.6）。
- **来源 URL**：[ndepend.com/features/cqlinq](https://www.ndepend.com/features/cqlinq) · [ndepend.com/docs/cqlinq-syntax](https://www.ndepend.com/docs/cqlinq-syntax) · [OCTO 深入文章（确认 2004 创立、CQLinq 细节）](https://blog.octo.com/static-analysis-tooling-for-c-and-.net-ndepend-in-depth-1)

> 历史核对：**2004 年由 Patrick Smacchia 创立**——OCTO 文章原文「Patrick Smacchia created NDepend in 2004」，有源可引。

---

## 2. CAST（CAST Imaging / Highlight / AIP）

- **一句话定性**：企业「软件智能」巨头，把整个应用反向工程成架构蓝图 + 事务流图，卖给银行/政府/大型机客户。
- **分析深度**：**系统级（最深）**——不只解析符号，而是**反向工程全部数据库结构、代码组件与相互依赖**，产出**交互式架构蓝图、data-call graph（数据-调用图）、端到端事务流（transaction flow）**，即「事务级 + 数据库对象级」的分析深度（[Wikipedia: CAST](https://en.wikipedia.org/wiki/CAST_(company))）。
- **查询或规则语言**：以**可视化蓝图 + 规则/度量看板**为主（非开放查询语言）；CAST 有自己的语义分析引擎（跨语言 unified model），但查询面主要面向规则违反与质量度量，不像 CQLinq/Cypher 那样开放声明式查询。
- **语言数**：**大量**（涵盖 COBOL、Java、.NET/C#、C/C++、大型机、SQL 等；具体清单见 CAST「Covered Technologies」文档，[doc.castsoftware.com](https://doc.castsoftware.com/export/TECHNOS/Covered+Technologies)）。
- **许可证与价格**：**闭源商业、企业级**。价格非公开；**「数十万美元级部署」是行业传闻，截至 2026-08 无公开一手定价来源**（仅知按应用规模/语言数报价）。
- **活跃度**：活跃（2022-07 Bridgepoint 收购多数股权，持续运营）。
- **来源 URL**：[Wikipedia: CAST（1990 巴黎创立 / AIP 2004 / Imaging 2019 / Bridgepoint 2022）](https://en.wikipedia.org/wiki/CAST_(company)) · [Covered Technologies](https://doc.castsoftware.com/export/TECHNOS/Covered+Technologies)

> 历史核对：**1990 年巴黎由 Vincent Delaroche 创立**（Wikipedia 有源）；1996 首个语义分析产品；2004 CAST AIP 首发；2019 AIP 更名 CAST Imaging。领导层含 CMM 模型作者 Bill Curtis（SEI/CISQ）。

---

## 3. Axivion（原 Bauhaus 项目，斯图加特大学）

- **一句话定性**：从斯图加特大学 Bauhaus 研究项目（1996）分拆的架构验证 + 静态分析套件，定位功能安全/合规（ISO 26262、MISRA），现属 Qt Group。
- **分析深度**：**符号级 + 架构级**。Bauhaus Toolkit / Axivion Suite 含静态分析（C/C++/C#/Java/Ada）、**架构检查（architecture checking/verification）**、**接口分析**、**克隆检测**、MISRA C 检查（[Wikipedia: Bauhaus Project](https://en.wikipedia.org/wiki/Bauhaus_Project_(computing))）。
- **查询或规则语言**：**架构验证用 DSL + 规则**——把「期望架构」声明出来（分层/允许依赖/禁止依赖），工具校验代码是否违反；辅以 MISRA/编码规则集。
- **语言数**：5（C/C++、C#、Java、Ada）。
- **许可证与价格**：**闭源商业**（Qt Group QA 业务线）。
- **活跃度**：活跃（2022-08-11 被 Qt Group 收购后持续开发）。
- **来源 URL**：[Wikipedia: Bauhaus Project（1996 斯图加特、2005 分拆 Axivion、2022 Qt 收购）](https://en.wikipedia.org/wiki/Bauhaus_Project_(computing))

> 历史核对：**1996 年由斯图加特大学 Erhard Plödereeder 与 Rainer Koschke 发起**（早期与不来梅大学、Fraunhofer IESE 合作；早期版本集成 Rigi 做可视化）。「1990s 斯图加特」✅（精确到 1996）。

---

## 4. Lattix

- **一句话定性**：**DSM（依赖结构矩阵）架构治理**的开创性商业工具，核心概念是 **LDM（Lightweight Dependency Model / Dependency Model）**。
- **分析深度**：**符号/文件/架构级依赖**，但核心表达是 **DSM 矩阵**——把依赖压成方阵，用 **Partition/分区算法**自动重排行列，暴露分层、循环与架构边界（Sangal 等的 LDM 论文是理论源头）。
- **查询或规则语言**：以**DSM 矩阵 + 架构规则（定义允许/禁止的依赖层）**为主，非通用查询语言；卖点是「依赖模型 + 分区算法」而非声明式查询。
- **语言数**：多语言（C/C++、Java、.NET、Ada 等，靠各语言解析器）。
- **许可证与价格**：**闭源商业**。
- **活跃度**：低-中（成熟老产品，迭代缓慢）。
- **来源 URL**：[ACM: "Using Dependency Models to Manage Complex Software Architecture"（Sangal/Jordan/Sinha/Jackson, OOPSLA 2005）](https://dl.acm.org/doi/10.1145/1094811.1094824) · [docs.lattix.com](https://docs.lattix.com/lattix/releaseNotes/Release_1.html)

> 历史核对：公司技术源头是 **OOPSLA 2005 的 LDM 论文**；公司创立年份常被写为 2004/2005，「2004」与论文年份存在 ±1 出入，**截至 2026-08 无统一一手口径**（论文 2005 有源，公司注册年份未从官方页直接取得）。

---

## 5. Structure101

- **一句话定性**：2004 年前后由爱尔兰 Headway Software 创立的老牌「架构 + 复杂度」治理工具（fat 结构、循环、层级、复杂度预算），**已被 SonarSource 收购**。
- **分析深度**：**文件/包/架构级**（架构分层、循环、依赖、复杂度超标「fat」检测），不做类型级。
- **查询或规则语言**：规则式（架构约束 + 复杂度阈值），Studio/Workspace 可视化 + 报告。
- **语言数**：多语言（Java/C/C++/.NET 等）。
- **许可证与价格**：原闭源商业；**收购后技术并入 Sonar 生态**。
- **活跃度**：**被收购（产品线状态并入 Sonar）**。
- **来源 URL**：[SonarSource 官方新闻稿：Sonar Acquires Structure101](https://www.sonarsource.com/company/press-releases/sonar-acquires-structure101-to-strengthen-code-quality-offering/) · [dbta（收购报道，2024-10-15）](https://www.dbta.com/Editorial/News-Flashes/Sonar-Boosts-Code-Reliability-Maintainability-and-Security-with-Latest-Acquisition-166360.aspx) · [PitchBook: Structure101 (now Sonar)](https://pitchbook.com/profiles/company/652356-37#overview)

> 历史核对：**2024 年 10 月被 SonarSource 收购**（mergerlinks 交易日期 2024-10-15；dbta 同日简报）。「2004 Headway 创立」：Headway Software（爱尔兰）确为创立方，**精确注册年份截至 2026-08 无公开一手口径**，2004 为业界通行说法。

---

## 6. Sonargraph（hello2morrow）

- **一句话定性**：hello2morrow 的架构治理工具，核心是**架构 DSL + 质量门（quality gates）**，把「期望架构」写成模型再卡 CI。
- **分析深度**：**符号级 + 架构级**（Java/C++ 的包/类/层依赖、循环、架构违规）。
- **查询或规则语言（关键）**：**Architect DSL**——用 DSL 声明期望架构（分层/子系统/允许依赖），工具自动校验；再配 **Quality Gate** 在构建中卡 P(ASS)/F(AIL) 门（[hello2morrow 产品页](https://www.hello2morrow.com/products/sonargraph/architect)、[Quality Gates 文档](https://eclipse.hello2morrow.com/doc/standalone/content/defining_qualitygates.html)）。
- **语言数**：Java、C++（另有 .NET/TypeScript 等子产品）。
- **许可证与价格**：**闭源商业**。
- **活跃度**：活跃（blog 更新至 2025-07）。
- **来源 URL**：[hello2morrow.com Sonargraph](https://www.hello2morrow.com/products/sonargraph/architect) · [Quality Gates 文档](https://eclipse.hello2morrow.com/doc/standalone/content/defining_qualitygates.html)

---

## 7. Teamscale（CQSE）

- **一句话定性**：慕尼黑工大分拆的「软件智能」平台，特色是**把各类分析结果统一为 Findings 模型 + 增量分析**。
- **分析深度**：**符号级 + 架构级 + 增量**。架构分析（依赖/循环/违规）、代码质量、测试覆盖，且**只对变更做增量分析**（增量质量门）——学术血统来自 TUM 软件与系统工程讲席。
- **查询或规则语言**：**Findings 模型**（把不同工具/不同版本的分析结果统一成可追踪的 Findings，支持架构规则 + 度量阈值）；以规则/看板为主，非通用图查询语言。
- **语言数**：多语言（Java、C/C++、C#、JavaScript、Python、ABAP 等）。
- **许可证与价格**：**闭源商业**。
- **活跃度**：活跃（CQSE 2009 创立，63 名正式员工、23 名博士的研发团队）。
- **来源 URL**：[teamscale.com/about-us（2009 TUM 分拆、研发规模）](https://teamscale.com/about-us)

> 历史核对：**CQSE 2009 年成立，为 TUM「软件与系统工程」讲席（软件质量与维护能力中心）分拆**（官网原文有源）。「2010s 慕尼黑工大分拆」✅（精确到 2009）。

---

## 8. CodeScene

- **一句话定性**：Adam Tornhill 的**行为代码分析（behavioral code analysis）**工具——不靠静态解析，而靠**挖掘 Git 版本历史**算出「代码热点 + 组织耦合」。
- **分析深度**：**文件级 + 变更历史/社会技术级**（非符号级）。核心指标：**hotspots（代码热点）**、**temporal coupling（时间耦合，总是同时改动的文件）**、**Code Health（代码健康度）**、作者知识/关键人风险（bus factor）。它把「图」建在「谁改了什么、和什么一起改」上，而不是符号引用上。
- **查询或规则语言**：以**行为指标看板 + 规则/热点导航**为主，无通用图查询语言；部分组件（CodeScene CLI / code-maat）开源。
- **语言数**：**语言无关**（基于版本控制历史 + 语言结构启发式，覆盖所有语言）。
- **许可证与价格**：**商业 SaaS/自托管**（含免费社区层）；Adam Tornhill 的《Your Code as a Crime Scene》是其方法论文本。
- **活跃度**：活跃。
- **来源 URL**：[Wikipedia: CodeScene](https://en.wikipedia.org/wiki/CodeScene) · [codescene.com](https://codescene.com)

---

## 9. Rigi（维多利亚大学，Müller）

- **一句话定性**：**1992 年的逆向工程可视化学术源头**，证明「解析 + 可视化」这条线的起点。
- **分析深度**：符号/结构级（当时 C 语言为主），重点在**空间与可视化互连模型**——把源码实体和关系建模成可探索的图。
- **查询或规则语言**：早期无正式查询语言，核心贡献是**可视化交互模型**；后成为 Bauhaus 的可视化底座。
- **语言数**：1（C，后扩展）。
- **许可证与价格**：学术/研究工具（非商业产品）。
- **活跃度**：**历史项目**（已并入/演化为 Bauhaus 等后续系统）。
- **来源 URL**：[dblp: "A reverse engineering environment based on spatial and visual software interconnection models"（Müller, Tilley, et al., SIGSOFT SDE 1992）](https://dblp.org/rec/conf/sde/MullerTOCM92.html) · [Semantic Scholar 图](https://www.semanticscholar.org/paper/43ba97c8ea0a20c5facd2c06658ac4e78cc85bc6)

> 历史核对：**1992 论文有源**（Müller 等，维多利亚大学 Chisel/Rigi 组）。

---

## 10. FAMIX + Moose（伯尔尼大学）

- **一句话定性**：**语言无关元模型（FAMIX）+ 可扩展分析平台（Moose）**，二十年学术生态，是「统一 IR」概念的历史渊源——与 HoloGram 的 27 语言统一 IR 直接可比。
- **分析深度**：**元模型级（语言无关）**。FAMIX 核心是「类似 UML 但面向分析」的**语言无关元模型**（类/方法/属性/继承/调用/引用等通用实体），任何语言解析结果都映射进 FAMIX，再统一查询/度量/挖掘。
- **查询或规则语言（关键）**：Moose 提供**富查询接口（rich query interface）+ MSE 文件格式交换 + 通用浏览器/可视化引擎**——即「元模型 + 查询 + 可视化」一体，与 HoloGram「IR + 查询 + 3D 星图」架构同构。
- **语言数**：**语言无关**（靠各语言 importer 进 FAMIX；Java/C++/Smalltalk/JS 等都有）。
- **许可证与价格**：**开源（Moose 构建于 Pharo 上，MIT/自由软件生态）**，学术驱动。
- **活跃度**：活跃（Moose v7 已发布，多研究组维护）。
- **来源 URL**：[Wikipedia: Moose（1996–1999 FAMOOS 欧盟项目起源、FAMIX 元模型、MSE、Pharo）](https://en.wikipedia.org/wiki/Moose_(analysis)) · [modularmoose.org](https://modularmoose.org/about/)

> 历史核对：**1996–1999 欧盟 FAMOOS 项目**（伯尔尼大学 SCG，Nierstrasz/Ducasse/Gîrba 等）起源有源。FAMIX 元模型、MSE 交换格式、Pharo 平台均为一手文档可查。

---

## 11. Imagix 4D

- **一句话定性**：C/C++/Java 的经典逆向工程与可视化工具（控制流、依赖、调用图）。
- **分析深度**：**符号级 + 调用级 + 控制流级**（函数控制流图、依赖分析、调用层级），无类型系统级重构能力。
- **查询或规则语言**：以**图形化浏览/查询**为主（交互式图 + 报告），非声明式查询语言。
- **语言数**：3（C、C++、Java）。
- **许可证与价格**：**闭源商业**（现经 VerifySoft 分销）。
- **活跃度**：低（成熟老工具，迭代慢）。
- **来源 URL**：[imagix.com/products](https://www.imagix.com/products/) · [verifysoft.com 分销页](https://www.verifysoft.com/en_imagix4d.html)

---

## 12. Source Insight

- **一句话定性**：经典桌面**代码浏览/索引器**，靠「符号索引 + 快速跳转」而非常驻图，商用仍在卖。
- **分析深度**：**符号级索引**（定义/引用跳转、调用关系、文件/符号浏览），以编辑器内快速导航为核心，不做全量图分析。
- **查询或规则语言**：无查询语言；核心是**符号索引数据库 + 引用跳转 + 搜索**。
- **语言数**：多语言（C/C++、Java、C# 等，主打 C 系）。
- **许可证与价格**：**闭源商业**（Source Dynamics；当前为 Source Insight 4.0，按许可售卖）。
- **活跃度**：中（仍在售卖，但版本迭代慢）。
- **来源 URL**：[sourceinsight.com/product（Source Insight 4.0 许可包）](https://www.sourceinsight.com/product/source-insight-4-0-5-license-pack/)

---

## 13. Softagram

- **一句话定性**：基于图的**代码变更可视化**工具（PR 影响报告、变更热图、架构模型 diff），**公司已转型，产品事实性停更**。
- **分析深度**：**文件/架构级 + 变更维度**（把「代码图」与「变更」叠加：PR 影响、热图、模型比较）。
- **查询或规则语言**：可视化报告为主（Impact Report、Heat Map、Visual Model Comparison），无通用查询语言。
- **语言数**：多语言（依解析器覆盖）。
- **许可证与价格**：原商业（GitHub Marketplace 曾上架）。
- **活跃度**：**事实性停更**——公司（Softagram Oy，芬兰）仍在，但已转向 ERP(Odoo)/AI/网络安全三大业务，代码可视化产品（Softagram Analyzer）已非主业。
- **来源 URL**：[softagram.com 公司信息页（2013 Mingraph → 2015 Selkosoft → 2017 Softagram；现转向 ERP/AI/网络安全）](https://softagram.com/en/yhtiotiedot) · [GitHub Marketplace: Softagram](https://github.com/marketplace/softagram)

> 历史核对：创始人 Ville Laitila（前 Nokia 首席架构师），2013 年以 Mingraph Oy 创立。**无官方「关闭」公告，但公司官网自述业务已转向 ERP/AI/网络安全，代码可视化产品事实性停更**（截至 2026-08）。

---

## 14. OpenGrok

- **一句话定性**：Oracle 维护的**开源代码搜索 + xrefs 平台**，代表「搜索引擎式代码导航」这条线（部署在私有仓库上跑）。
- **分析深度**：**符号级索引 + 交叉引用（xrefs）**——全文搜索（Lucene）+ 定义/引用/调用跳转，多语言。
- **查询或规则语言**：**搜索式**（全文检索 + xrefs 导航），非声明式图查询。
- **语言数**：**多语言**（Java + 各种 ctags 解析器，C/C++/Java/JS/Python 等）。
- **许可证与价格**：**开源（CDDL 等，Oracle 维护）**，免费自部署。
- **活跃度**：活跃（github.com/oracle/opengrok 持续维护，demo.opengrok.org 在线）。
- **来源 URL**：[github.com/oracle/opengrok](https://github.com/oracle/opengrok)

---

## 15. ctags / cscope（一段讲完）

这是「符号索引器」这一机制的**贝尔实验室血统起点**，四十年里几乎每一个代码导航工具都继承了它们的核心思想：

- **ctags**：原版随 **BSD Unix 2.0** 引入，**主作者 Ken Arnold**（Jim Kleckner 贡献 Fortran、Bill Joy 贡献 Pascal 支持）。生成 `tags` 索引文件（标识符 → 文件 + 位置），供编辑器「跳到定义」。现由 **universal-ctags** 接棒（Exuberant Ctags 的后继，活跃维护，支持几十种语言）（[Wikipedia: ctags](https://en.wikipedia.org/wiki/Ctags) · [github.com/universal-ctags/ctags](https://github.com/universal-ctags/ctags)）。
- **cscope**：**1980 年代初** Joe Steffen 在 Bell Labs 的 PDP-11 上编写，能搜函数/定义/调用/正则，用在百万行级项目；2000-04 由 SCO 以 **BSD** 开源，深度集成 vim/Emacs（[Wikipedia: cscope](https://en.wikipedia.org/wiki/Cscope)）。

**意义**：ctags/cscope 确立了「**先建符号索引，再做定义/引用/调用跳转**」这一被反复验证的最小可用形态——现代 Kythe xrefs、Source Insight、LSP 的 go-to-definition 都是它的直系后代。

---

# 小结：四十年架构分析工具史——什么机制被反复证明有效

把 15 个工具（叠加上一轮的 dependency-cruiser/Sourcetrail/Understand/jQAssistant/Kythe/Glean/stack-graphs）放进四十年时间轴，可以抽出**八条被反复证明有效的机制**：

1. **统一中间表示/元模型（unified IR）是一切的前提。** FAMIX（1996 起，语言无关元模型）→ Kythe VName（全局符号命名）→ Glean facts → 今天的 LSP/SCIP。凡是「多语言 + 可查询」的工具，都先造一个语言无关的图模型。HoloGram 的 27 语言统一 IR 走的就是这条被验证最彻底的路——这是它结构上最正确的一步。

2. **声明式查询语言挂图，是「看图」升级到「可编程分析」的分水岭。** CQLinq（NDepend，`from m in Methods where ...`）、Cypher（jQAssistant，`MATCH ... RETURN`）、Angle（Glean，Datalog 派生谓词）三代同构：**把代码图当数据库查**。这是 HoloGram「图查询」最该对标的形态——NDepend/CQLinq 是单语言最成熟的商业样本，jQAssistant/Cypher 是开源样本。

3. **DSM/依赖矩阵 + 分区/层级算法，是架构治理的通用手法。** Lattix 的 LDM + Partition、Structure101 的分层/循环、Understand 的依赖矩阵、NDepend 的 dependency matrix。把图压成矩阵、重排揭示层级，四十年不变。HoloGram 的社区发现/BFS 应朝「架构分层 + 违规」这个方向补。

4. **架构 DSL/规则 + 质量门，是治理闭环的最后一公里。** Sonargraph 的 Architect DSL、Axivion/Bauhaus 的架构验证、NDepend quality gates、Teamscale findings、Structure101 约束。共同点：**把「期望架构」声明成规则，卡进 CI**。HoloGram 目前缺「声明式架构规则 + 违规 → 门禁」这一层。

5. **符号级解析（定义/引用/调用）是「代码导航」不可替代的门槛。** 从 ctags（1979/BSD 2.0）→ cscope（1980s）→ Source Insight/Imagix → Sourcetrail/Understand/Kythe，四十年唯一反复被验证的导航机制就是「符号索引 + xrefs」。文件级 import 图（dependency-cruiser/madge）永远替代不了它。这是 HoloGram 树-sitter 方案最薄的一环（见上一轮结论）。

6. **可视化是结果，不是机制。** Rigi（1992）证明可视化能帮人理解，但四十年教训是：**可视化必须建立在可查询的图模型之上**，否则只是画图。Sourcetrail 的图好用，是因为底下有类型级解析；Rigi 本身没变成产品，正是因为它只有可视化、缺语义底座。

7. **「图 × 时间」是 2010s 后的有效增量。** CodeScene 的变更历史挖掘（热点/时间耦合）、Softagram 的变更可视化、Teamscale 的增量分析：把静态图和变更历史叠加，回答「哪里危险、改动影响谁」。这是 HoloGram 的「变更简报/破坏信号」方向的同类机制。

8. **广度 vs 深度是四十年反复出现的核心张力。** Sourcetrail 证明「深而窄」的维护成本高到作者放弃；Kythe/Glean 证明「编译器级解析」需要大厂持续投入；FAMIX/HoloGram 的统一 IR 证明「只有语言无关的图模型才能摊薄多语言广度成本」。**结论与上一轮一致**：HoloGram 赢在广度（27 语言统一 IR），输在单语言语义深度；补差靠 stack-graphs（给 tree-sitter 补名称解析）或 SCIP/LSIF（借力现成 indexer），而不是逐语言重写编译器级解析器。

**一句话总评**：这四十年证明，一个「能用的代码图谱」= **统一 IR + 声明式图查询 + 符号级 xrefs + 架构规则/质量门 + 可视化 + 时间维度**。HoloGram 已具备「统一 IR、图查询、可视化、时间维度」四项，缺「符号级 xrefs」与「声明式架构规则/质量门」两项——而这两项恰恰是老牌商业工具（NDepend/Sonargraph/Axivion/Understand）与学术血统（FAMIX/Kythe）反复验证过的护城河。
