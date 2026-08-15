# HoloGram 引擎 vs 老牌图谱分析工具 —— 深度差距审计

> 审计日期：2026-08-15 · 方式：引擎源码逐文件通读 + 三组外部工具调研 + **对引擎跑真实项目与对抗性样本的一手实验**
> 本报告是主报告。支撑材料：
> - `docs/research/engine-capability-audit-2026-08.md`（引擎内部能力审计，全部 `文件:行号` 证据）
> - `docs/research/external-deep-analysis-tools-baseline-2026-08.md`（CodeQL / Semgrep / SonarQube / Snyk Code 基线）
> - `docs/code-graph-tools-gap-report.md`（dependency-cruiser / Sourcetrail / Understand / jQAssistant / Kythe / Glean / stack-graphs 基线）
> - 一手实验脚本与样本：`engine/fixtures/gap_probe/`（对抗性解析探针项目）

---

## 0. 结论先行（给不读正文的人）

1. **HoloGram 现在的真实水位 ≈「27 语言广度版 dependency-cruiser」，且在自己最引以为傲的多语言广度之外，连 dependency-cruiser 的主场都没打赢**：同一份 229 文件的 TypeScript 前端，dependency-cruiser 的模块 import 解析率 99.9%，HoloGram 约 80%。
2. **图是「欠抽样」的，而且用户不知道**：引擎分析自己的 TS 前端时，提取出的 23857 条边有 13425 条（56%）解析失败被静默丢弃，最终入库只剩 8730 条；分析自己的 Rust 引擎时更惨，40891 条边丢 31070 条（76%）。**每个工具的结果都建立在一张只剩 1/3~1/2 边的图上，但工具从不报告解析率。**
3. **差距的本质不是「算法没调好」，是缺一整层**：老牌图谱工具（Sourcetrail / Understand / Kythe / Glean）的共同底线是「**符号级解析 + 引用图**」——`import x` 能确定性地解析到 x 的定义、同名符号按作用域区分、调用解析到函数签名级。HoloGram 的「跨文件解析」是**短名/文件主干字符串匹配**，没有 import 图、没有作用域、没有别名、没有类型。tree-sitter 只给语法树，这层语义是必须自己补的。
4. **与 CodeQL/SonarQube/Snyk 的差距是「品类不同」，不必对标**：他们产出缺陷列表，HoloGram 产出可查询的图——这是 HoloGram 的产品差异化，不是短板。但**宣传里的「数据流」必须降级**：现在的 `trace_dataflow` 是「同名字符串统计」，不是数据流分析，与 CodeQL 的污点分析/符号执行是两回事。继续用「数据流」这个词宣传，是在给项目埋信任炸弹。
5. **有好消息**：图存储、图算法（Tarjan/Leiden）、查询接口（34 个 MCP 工具）、增量管线、向量索引、可视化——这一整层是**扎实的、别人没有的**。差的只有「解析层质量」一个维度，而这一层有两条现成路径可补（stack-graphs、SCIP/LSIF 桥接），**不需要也不可能靠手写 27 个语义解析器**。

---

## 1. 一手实验：引擎在自己代码上的真实表现

所有实验用 2026-08-15 当天重建的 release 引擎（`engine/target/release/hologram-engine`）完成。

### 1.1 对抗性探针（`engine/fixtures/gap_probe/`，5 个 Python 文件）

专为考验解析正确性构造：别名 import、同名模块碰撞、对象方法调用、污点路径。结果：

| 样本 | 期望 | 实际 |
|---|---|---|
| `from app.services.user_svc import UserService as US` + `US()` | 建立 user_ctl → UserService 类 的引用 | ❌ `US` 别名完全丢失，UserService 类节点入度为 0（没有任何边指向它） |
| `from vendor.pkg_a import utils as util_a` + `util_a.format_user(name)` | 解析到 pkg_a/utils.py 的 format_user | ❌ 两个同名 `utils` 模块的 import 边和调用边**全部被丢**（歧义即丢弃，不是保留待定） |
| `from db import Database`（user_svc.py 顶部） | 解析到 `db.py` 模块 | ❌ 解析成了 `create` 函数里的**局部变量 `db`**——imports 边指向了一个变量节点 |
| `svc.create(name)`（对象方法调用） | 按接收者类型解析到 UserService.create | ⚠️ 碰巧对了，但**只是因为全图只有这一个 `create`**；名字唯一是它解析成功的唯一原因，任何第二个 `create` 都会让它变成歧义被丢弃 |
| `request → raw → query(sql)` 污点链 | 数据流工具指出 request 数据到达 query | ❌ `trace_dataflow` 输出的是「作用域内标识符点名」：`<module>` 作用域的 reads 把 import 路径的每一段（`app`、`services`、`vendor`……）都算作「读取」，函数名自己也被算作读。没有任何 source→sink 传播概念 |

### 1.2 真实项目一：src-ui（229 个 TS/TSX 文件，引擎自己的前端）

```
[pipeline] core-parse:   2726 节点, 23857 边（220/220 文件）
[cross-file diag] unresolved=13425 (56%)   ← 解析失败
                  其中 usage=8018, calls=5229, imports=174
[engine] cross-file:     5975 边解析成功
[engine] db-save:        入库 2957 节点, 8730 边   ← 63% 的边被静默丢弃
```

- **import 边**：约 882 条原始 import 边，174 条解析失败，708 条入库 → **import 解析率 ≈ 80%**（这是引擎最好的一类边）。
- **calls / usage 边**：原始 calls ≈ 8700 条丢 5229 条（**60%**）；原始 usage ≈ 10055 条丢 8018 条（**80%**）。丢得最狠的正是「调用关系」本身。
- **继承边**：440 个 class + interface 节点，入库的 inherits 边只有 **7 条**（`implements`/`extends` 大面积漏抽）。
- **calls**：2066 个函数只有 3471 条调用边（1.68 条/函数），这是丢弃 + 漏抽后的结果，不是真实的调用密度。
- **所有依赖 node_modules 的边全部消失**：React/zustand/three 等外部依赖在图里没有节点——「依赖星图」不显示库依赖。
- **BUG：`cross_file` 标志落库后全为 0**。解析器在内存里确实置了 `cross_file=true`（`graph/resolver.rs:215`），但 SQLite 里 8730 条边全部为 0——凡依赖这个标志的下游工具（影响面、耦合统计）都在用错误输入。

### 1.3 真实项目二：engine/src（110 个 Rust 文件，引擎自己）

```
[cross-file diag] unresolved=31070 (76%)  ← 40891 条边丢 3/4
                  其中 usage=19660, calls=10773, imports=637
```

- 28483 条「裸外部名」（`Vec::new()`、`x.clone()`、`Ok()`……）全部无法解析且**不保留**——Rust 的方法调用 `a.b()` 只取字段名 `b`，全图按名字猜，基本必歧义。
- 637 条 `use` import 边解析失败（`use crate::graph::Graph` 与模块 id `…graph.rs.Graph` 的 `.rs` 后缀对不上）。

### 1.4 正面 PK：dependency-cruiser 分析同一份 src-ui

同一天、同一 `src/` 目录、同一台机器（depcruise 覆盖 229 个模块，引擎覆盖 220 个文件，纳入规则略有差异但结论不受影响）：

| | dependency-cruiser v16 | HoloGram |
|---|---|---|
| 模块 import 解析成功率 | **883/884（99.9%）** | ≈ 708/882（80%） |
| 解析技术 | enhanced-resolve + tsconfig `paths`/webpack `alias`，**确定性路径解析** | 短名/文件主干字符串匹配 |
| 解析失败的处理 | 标记 couldNotResolve 保留在结果里 | **静默丢弃** |
| 检测到的循环模块 | 19 个 | 未对比（环检测算法本身没问题，但输入边只有对方的零头） |

（公允说明：depcruise 在这个 bundler 模式的项目上也要显式配 `extensions: ['.ts','.tsx']` 才能到 99.9%，否则只有 21%。但差别在于：它有配置项、配对了就能满分；HoloGram 没有配置项，上限就是 80%。）

### 1.5 一个结构性事实：正确率从未被测量

- 全仓搜索：**没有任何 precision/recall/gold-standard 基准**。665 个引擎测试全是 smoke 断言（「图里有 N 个节点」「该有某条边」），没有一条对着人工标注的标准答案数「解析对了几条、错了几条」。
- 没有测量的能力等于没有能力：这解释了为什么 56%~76% 的边被丢弃却没人发现。

---

## 2. 老牌工具的真实水位（外部调研摘要）

### 2.1 结构图谱阵营的「共同底线」

| 档位 | 工具 | 提取深度 | 关键机制 |
|---|---|---|---|
| 文件级 import 图 | dependency-cruiser、madge | 谁 import 谁 | enhanced-resolve 确定性解析 |
| **符号级 + 引用图** | Sourcetrail、jQAssistant、stack-graphs | 定义/引用/调用解析到符号 | 全局符号命名 + 跨文件作用域解析 |
| 类型级 + 编译器级 | Understand、Kythe、Glean | 类型/泛型/重载/覆盖/签名级调用图 | 每语言一个真正的语义解析器（clang/javac/SCIP 桥接） |

**老牌工具的共识**：一个「能用」的代码图谱，底线不是「画文件连线」，而是**有一个全局符号命名空间，并能把每次 import/调用解析到具体符号**。文件级 import 图只是它的退化投影。

Sourcetrail 的教训尤其重要：**只有一个人维护的小团队做 4 门语言的语义解析都撑不住（2021 年停更）**。所以 27 语言全自研语义解析器是死路，广度路线必须借力现成 indexer——这是 Glean 的选择（深支持 5 门，其余经 SCIP/LSIF 接入）。

### 2.2 深度分析阵营（CodeQL/Semgrep/SonarQube/Snyk）—— 品类不同

四家产出「缺陷列表 + 规则命中」，**没有一家把图暴露给用户或 LLM**。CodeQL 最接近「代码数据库」（extractor → 关系库 → Datalog 家族 QL），但引擎闭源、编译型语言必须构建拦截。Snyk Code（DeepCode）证明了「语义图 + 符号执行 + 免构建」能到商业可用，但图是内部私产。

**结论：HoloGram 与这四家是两个正交坐标轴**——「浅解析 × 显式图 × 给人和 LLM 查询」vs「深语义 × 内部图 × 找缺陷」。不要在缺陷检测上对标它们；但它们的存在定义了一个红线：**只要宣传里出现「数据流」「污点」这类词，用户就会拿 CodeQL 的标准来验收**，而现在的实现会瞬间穿帮。

---

## 3. 逐维度差距总表

| 维度 | dependency-cruiser | Sourcetrail / Understand | CodeQL | **HoloGram 现状（实测）** | 差距性质 |
|---|---|---|---|---|---|
| 文件级 import 解析 | 99.9%（TS） | 高 | 高 | **~80%（TS）、Rust 637 条失败** | 🔴 在最低档的主场落后 |
| 别名 import | 高 | 高 | 高 | **完全没处理，别名全丢** | 🔴 缺一层 |
| 同名模块/符号区分 | 路径解析天然区分 | 作用域/类型区分 | 类型区分 | **歧义即丢弃** | 🔴 缺一层 |
| 对象方法调用 `a.b()` | 不做 | 按接收者类型解析 | 按类型解析 | **取 `b` 字段名全图猜，唯一才中** | 🔴 缺类型层 |
| 调用图完整性 | 无 | 签名级 | 高 | **calls 边丢 60%（TS）；整体丢 63%（TS）~76%（Rust）** | 🔴 输入欠抽样 |
| 数据流/污点 | 无 | Understand 部分 | 真过程间污点 | **同名字符串启发式，且不落图** | 🟡 品类不同，但宣传撞名 |
| 类型/泛型/重载 | 无 | 有 | 有 | 无 | 🟡 品类不同 |
| 查询语言 | 正则规则 | 度量+导航 | QL（Datalog） | 34 个固定工具 + NL explore | 🟢 是差异不是差距 |
| 图作为产品暴露 | 无 | GUI | 无（私产） | **MCP 直查 + 3D 星图 + Agent 集成** | 🟢 独有优势 |
| 多语言免构建覆盖 | 1 个生态 | 4~19 | ~11（编译型需构建） | **27 语言全免构建** | 🟢 独有优势 |
| 增量更新 | 无内置 | 有 | 有（2026 PR 级） | 文件级增量（但耦合/社区等全局分析不重算，自认 `incremental.rs:13-26`） | 🟡 半成品 |
| 正确性度量 | 社区有对比 | 商业 QA | 有内部基准 | **零测量** | 🔴 管理缺口 |

---

## 4. 必须补齐清单（按优先级）

### 🔴 P0 —— 生死级（不做这些，「代码图谱」四个字不成立，建议 4~8 周内）

**P0-1. 把 import 解析改成确定性的路径解析（最高优先级，收益最大）**

- 现状：import 边目标靠「文件主干字符串匹配」（`graph/resolver.rs:493-546`），歧义即丢弃。
- 要做：按语言建立 import 解析器——TS/JS 用 tsconfig `paths`/`baseUrl` + node_modules（可嵌入 enhanced-resolve 语义或自实现小解析器）；Python 按包路径 + 相对导入 + 文件系统探测（含 `__init__.py`）；Rust 按 `use` 路径 + `mod` 声明；Go 按 module 路径。
- 验收：src-ui 的 import 解析率从 80% 提到 ≥98%；Rust 637 条失败降为 ~0。
- 成本：中等。这是 dependency-cruiser 用几千行做到的事，引擎已有的 `resolve_import_path` 只是雏形。

**P0-2. import 符号绑定 + 别名传播**

- `from x import y` / `import { foo as bar }` 必须建立「别名 → 定义」映射，同文件内 usage 边经映射解析。没有它，所有别名 import 的调用永远进不了图（探针 1.1 已实证）。
- 验收：gap_probe 中 `US()` → UserService、`util_a.format_user` → pkg_a 的 format_user。

**P0-3. 停止静默丢边：未解析边保留 + 解析率上仪表盘**

- 现状：56%~76% 的边被静默清理，工具结果从不告知「本回答建立在 44% 的边上」。
- 要做：① 未解析的跨文件边保留为 `unresolved` 状态（带原始裸名），不再删除；② 外部依赖（react/std/…）建 External 节点，图里至少能看到库依赖；③ `graph_summary`/`engine_status` 报告 `resolution_rate`；④ 工具结果带置信度标记。
- 这是**信任问题**：宁可让用户看到「这条边没解析出来」，也不能让他以为全解析出来了。

**P0-4. 「数据流」叙事降级（一天就能做，但必须做）**

- README/ARCHITECTURE/工具描述中把 `trace_dataflow` 改名为或明确标注为「语法级变量使用统计（heuristic）」，写清「无跨函数传播、无污点源/汇」。继续沿用「数据流」三字会被拿 CodeQL 标准验收，一验就穿。
- 同步修复文档滞后：工具数（33/27 → 实际 34+1）、「10 阶段管线」（实际 1 核心 + 9 合成子阶段）。

### 🟡 P1 —— 核心能力级（决定「图谱」还是「星图」的分水岭，建议 1~2 个季度）

**P1-1. 补一层跨文件名称解析（二选一，推荐先 b 后 a）**

- a) **stack-graphs 路线**：GitHub 已证明 tree-sitter + stack-graphs（路径敏感名称解析）能给纯语法层补上符号级引用解析，且逐语言只需写名称解析规则、不需要完整类型系统。与现有技术栈同源，但 crate 官方已停更需自维护。
- b) **SCIP/LSIF 桥接（更现实）**：引擎已有 LSP 管理基建（9 语言服务器），升级为「索引一次、全图复用」——用 rust-analyzer/gopls/tsserver/pyright 的 SCIP 产出填充符号级引用边。这是 Glean 的路线：**用别人的解析质量换自己的广度**。

**P1-2. 激活 LSP 入库，消灭 `lsp_resolved` 死字段**

- 现状：`lsp_resolved` 全仓 0 处置 true（`edge.rs:128`），LSP 只服务 4 个按需工具，每次查询重新起进程。
- 要做：`resolve_call`/`find_references` 的结果回写图（lsp_resolved=true + 溯源 metadata），渐进式把热边升级为语义边。这是 P1-1b 的第一步。

**P1-3. 建 gold-standard 解析基准（治理能力，不是炫技）**

- 把 `engine/fixtures/gap_probe` 扩展成系统化的「对抗性 fixture 集」（每语言一组：别名、同名、重载、动态、继承、泛型），人工标注标准答案（edge list），CI 里报 precision/recall。
- 没有这个，P0-1/P0-2 做没做对都无法验证；以后每改一次解析器都能防止回退。

**P1-4. 修 cross_file 落库为 0 的 bug + 增量失效治理**

- cross_file 标志持久化丢失（实验 1.2 实锤），影响所有按跨文件过滤的下游工具。
- 增量更新后耦合/社区/合成阶段不重算（自认 `incremental.rs:13-26`）：改脏标记触发局部重算，或在 UI/MCP 结果上明确标 `stale`。

### 🟢 P2 —— 差异化护城河（P0/P1 完成后）

- **接收者类型追踪**：`a.b()` 按 `a` 的类型解析（依赖 P1 的类型层）。
- **图查询语言**：不建议自研。SQLite 已在手，暴露参数化视图 + 少量 Cypher 式图模式即可；真正的声明式查询可引 Datalog 系现成引擎。
- **规则知识库**：把 framework_routes 的「硬编码检测器」模式产品化成用户可写规则（YAML），对齐 Semgrep 规则生态的体验。

---

## 5. 不建议做的事（避免把项目做死）

1. **不要自研语义解析器对标 CodeQL/Sonar**——Sourcetrail 一个人做 4 门语言都放弃了；27 门语言自研语义层必死。语义只能借（SCIP/LSIF/stack-graphs）。
2. **不要在现有解析质量上加第 28 种语言**——广度已是独有优势，继续加语言是锦上添花；解析率 44% 的图加什么语言都是废图。先深度后广度。
3. **不要继续堆「名字唬人」的分析工具**——建立在坏边上的新工具只会放大错误。现有 34 个工具的输入质量（P0）优先级远高于第 35 个工具。
4. **不要把「缺陷检测」当 KPI 追**——那是 CodeQL/Sonar 的主场，是品类竞争，不是差异化。

---

## 6. 一句话总结

HoloGram 不是「差劲的代码图谱分析」，它是**「差一层解析的、产品形态独一无二的代码图谱平台」**：图存储/图算法/查询接口/MCP 集成/可视化这一整层是扎实且没有对手的；但解析层目前是「名字匹配 + 静默丢弃」，实测解析率 24%~44%，把依赖图做成了欠抽样的星图。补齐方向非常明确——**P0 先让 import 级依赖图可信（确定性路径解析 + 不静默），P1 借力 stack-graphs/SCIP 补上符号级解析层**。这两步做完，它就能在「可对话的代码图谱」这个无人占领的品类里立住；做不完，它就只能停留在「好看但不可信」的演示阶段。
