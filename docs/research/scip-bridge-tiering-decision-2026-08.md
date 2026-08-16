# SCIP 桥接分档决策（2026-08）

> 生成：2026-08-15 · 依据：`docs/research/code-intelligence-indexer-ecosystem-2026-08.md`（indexer 生态一手调研）
> 目的：P1-1 的「9 个官方 indexer 分档接入」不再是一句话，而是可执行的档位表 + 复核周期。

---

## 1. 分档原则（三条，缺一不可）

1. **档位 = 官方 indexer 成熟度 × 项目主打语言**。成熟度看 indexer 仓库活跃度与功能完整度（调研文档 §2 已核实），主打语言看 HoloGram 用户分布——当前以 TS/Python/Rust 为第一梯队。
2. **SCIP 边与 tree-sitter 边共存，不互相覆盖**。SCIP 边带 `metadata.provenance = "scip"`，tree-sitter 边保持原样；同一符号节点优先复用（按 file:line 命中，实测 scip-typescript 索引 12 个定义中 11 个复用 tree-sitter 节点），引用边精确到编译器语义。
3. **档位决定默认行为，不决定上限**。任何语言只要用户提供了 index.scip，`import_scip` 与自动桥接都会工作；档位只决定「文档承诺的符号级质量」与「是否主动提示生成索引」。

## 2. 档位表

### T1 —— SCIP 主力（符号级引用质量对标对应 scip-* indexer）

| 语言 | indexer | 成熟度依据 | 运维要求 |
|---|---|---|---|
| TypeScript / JavaScript | `@sourcegraph/scip-typescript` | 官方维护、活跃（2026-08 有 push），npm 一行安装 | `npx scip-typescript index --output index.scip`，需 tsconfig |
| Python | `@sourcegraph/scip-python` | Pyright fork，development 档 | 同 npm 安装；Python 3.10+ |
| Java / Kotlin / Scala | `scip-java` | 最成熟之一，javac 编译器 API，跨仓导航 | 需 JVM 与构建配置（Maven/Gradle） |
| Rust | `rust-analyzer scip` | rust-lang 原生子命令（2022 合入） | rust-analyzer 已随 LSP 工具链存在 |
| C# / VB | `scip-dotnet` | Roslyn 底层，development 档 | 需 .NET SDK |
| Ruby | `scip-ruby` | Sorbet 底层，development 档 | 需 Ruby 工具链 |

### T2 —— tree-sitter 兜底 + 语法近似标注（无成熟官方 indexer 或接入成本过高）

Go、C/C++（`scip-clang` 需 compile_commands，作为**条件档**：用户提供编译数据库则升 T1）、Lua、PHP、Swift、Dart、Haskell、OCaml、Erlang、Elixir、Zig、Nix、Bash、JSON、HTML、CSS、YAML、R 等。

T2 行为：tree-sitter 解析照旧 + `lsp_resolved` 按需回写（P1-2）+ 文档明确标注「语法级近似，非语义解析」（P0-4 的降级叙事）。

### 边界情况

- **无定义的纯引用文档**：归到文档级 File 节点（`scip:doc:<path>`），边不丢、源诚实。
- **外部库符号**：`ext:` 节点，补回 tree-sitter 管线看不到的依赖节点（P1-1 验收线之一）。
- **index.scip 过期**：自动桥接无条件执行 —— 下一步给 SCIP 边加索引生成时间元数据，与文件 mtime 对比后标 stale（挂到 P1-4 的漂移治理）。

## 3. 验收路径（把「质量 ≥ scip-* indexer」变成数字）

1. 把 gap_probe 标准答案集（TS/Rust/Python，P1-3 已建）扩一份「引用边」答案：每个 fixture 标出全部调用/引用对的真值。
2. 同一 fixture 上两条管线各跑一遍：tree-sitter 边 vs SCIP 桥接边，报 precision/recall。
3. 目标：T1 语言 SCIP 边 precision/recall ≥ tree-sitter 边；对比结果进 CI（P1-3 的 CI 门禁决策落地时一并接入）。
4. 分档表半年复核一次（indexer 生态变动风险：scip-clang 长期 Beta、新官方 indexer 出现）。

## 4. 现状快照（2026-08-15）

- ✅ 桥接落地：解析（scip 官方 protobuf 绑定）→ 合并（节点复用 + 精确边 + ext: 节点）→ 持久化（to_sqlite）→ 入口（`import_scip` 工具 + 分析后自动桥接 + `engine run import_scip <project> --path index.scip` 脚本化）。
- ✅ E2E：真实 scip-typescript 产出实测（2 文档 / 24 occurrences → 12 边，11/12 定义复用 tree-sitter 节点，零跳过）。
- ✅ 首份精度对比（gap_probe_ts gold，2026-08-15 实测）：
  - tree-sitter 单独：33 边，gold recall **11/11**（imports 5/5、calls 4/4、usage 2/2），0 误报；
  - SCIP 桥接叠加：+24 条编译器级 usage 边（scip-typescript 0.4.0），usage gold 2/2 全中，**合并后 11/11 保持、0 误报、0 负数边命中**；
  - 已知 kind 映射差异：scip-typescript 把 import 语句的引用标为 Reference 角色（→usage 边挂文档节点），不以 Imports 出现——信息在场，kind 不同；gold 按 kind 计数故 SCIP 侧 imports 记 0/5。
  - 顺带修复：`MemoryIndex::rebuild_csr` 旧边复制守卫在节点增删后失效导致旧 CSR 边整批丢失（SCIP 导入首个踩中）——已按句柄对重新入桶，tree-sitter 边与 SCIP 边共存。
  - 对比流程已固化：`scripts/bench_scip_bridge.py --fixture engine/fixtures/gap_probe_ts --gold …`（scip-typescript index → analyze 基线 → import → 分管道 recall/负数边检查，自动选较新的引擎二进制）。
- ✅ SCIP 边 stale 治理（2026-08-15）：导入时落 `scip_import_drift_base`（meta，漂移基）；任何导入后的增量更新 → `graph_summary.scip_staleness` 结构化字段 + 图导航工具 `_stalenessBanner` 提示重生成 index.scip。
- ✅ 增量漂移重算臂（P1-4 补全）：漂移达阈值（默认 10 次增量，`HOLOGRAM_INCR_FULL_REANALYZE` 可调，0 禁用）自动触发全量重分析，社区/合成边/框架路由整体刷新、漂移归零。
- ⬜ 精度对比基准扩围（§3 第 1–2 步：引用边真值集 + CI 对比）——P1-1 的收尾工程。
