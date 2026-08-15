# Handoff：引擎 P0 解析信任度工程（2026-08-15 完成，已归档）

> 已归档于 2026-08-15；对应提交 `2954ecd`。本文件自足，供后续窗口回溯。先读根目录 `AGENTS.md` / `CLAUDE.md`（构建纪律：改 Rust 跑 `cd engine && cargo test --lib`；零裸 unwrap；错误不静默）。

## 一、这个任务是什么

用户的项目生死判断：引擎解析层不可信（import 80% / calls 丢 60% / 63%~76% 边被静默丢弃），
必须把「LLM 可查询依赖图」这条车道的 L2 腿（可信）接上。完整背景与验收线见：

- `docs/research/engine-gap-analysis-vs-established-tools-2026-08.md`（主报告，差距+清单）
- `docs/research/survival-position-verification-2026-08.md`（**生存验证：每条代办对应的竞品验收线，干活前必读**）
- `docs/research/competitor-landscape-full-2026-08.md`（35+ 竞品地图、四十年时间线、威胁模型）
- `docs/research/benchmarks/PROGRESS-2026-08-15.md`（**本窗口的工程进度 + 验收表**）
- `docs/research/benchmarks/*.json`（baseline → final 四阶段基准数据）

## 二、本窗口已完成（P0 全部 + P1-3 基准 + P0-4 叙事降级）

**结果一句话**：gold 基准 p0 recall 46.2% → **100%**、p03（外部依赖）0% → **100%**、precision 100%；
src-ui 真实项目 import 解析率 80% → **99.9%**（与 dependency-cruiser 打平）；不静默丢边 + 解析率诚实报告（79.7%）。

**代码改动（全部未提交）**：

| 文件 | 内容 |
|---|---|
| `engine/src/graph/import_resolver.rs`（新增 ~950 行 + 10 单测） | 核心新模块：P0-1 确定性 import 路径解析（TS 相对/tsconfig paths/node_modules/CSS/自带扩展名、Python 包路径+namespace 包、Rust use 路径+同目录模块、Go）+ P0-2 别名绑定传播（import_bindings → usage/calls 确定性改写；Rust use 别名 + `mod::fn` 限定调用）+ External 节点（`ext:<pkg>`） |
| `engine/src/adapter/query_adapter.rs` | import 处理器存 metadata（import_raw/import_bindings/import_path/import_alias）；TS/Python import 绑定收集；Rust use 解析；require()/动态 import() 补 import_raw；**修复 TS/TSX `const` 声明从不生成 Variable 节点**（lexical_declaration 多 declarator） |
| `engine/src/engine/pipeline.rs` | 新阶段 1.7 import-path + 1.8 import-binding（在 CrossFileResolver 名字猜测之前） |
| `engine/src/graph/resolver.rs` | P0-3：孤儿清理 → 「保留 + 改写 `unresolved:<裸名>` 占位节点」（3 个旧测试断言已同步更新） |
| `engine/src/analysis/graph_stats.rs` | graph_summary 新增 `resolution` 字段（rate/resolved/unresolved）+ `external_nodes` |
| `engine/src/analysis/dynamic_dispatch.rs` ×2、`framework_routes/mod.rs` ×1、`di_reflection/langs.rs` ×33 | P0-5：合成边 `is_synthesized=true` + synthesizedBy provenance（修误标） |
| `engine/src/tools/mod.rs` + `handlers/graph.rs` | `trace_dataflow` 描述降级为「语法级启发式，非语义数据流」；get_neighbors 新增 `excludeSynthesized` 参数 + 边级 `synthesized` 标志 |
| `engine/fixtures/gap_probe{,ts,rs}/` + `gold_expected.json` | P1-3 gold 基准（对抗样本：别名/同名碰撞/namespace 包/tsconfig paths/node_modules/mod 调用） |
| `scripts/bench_resolution.py` | 基准脚本：跑分析 → 读 hologram.db → 对 gold 算 p0/p03 recall + precision（含 count 校验与负例 FP） |

**验证命令**：
```bash
cd engine && cargo build --release && cargo test --lib
cd /home/jingjianhua/HoloGram && python3 scripts/bench_resolution.py --all --out /tmp/bench.json
```

**测试状态**：643 通过。全量并行跑时 4 个失败但**全部为改前已存在的 flaky/环境项**（单独跑全过）：resolver 计时测试、flows 计时测试、lsp_manager（缺 `python` 可执行文件）、stress（全局态并行冲突）。本批改动零确定性回归。

## 三、未完成（按优先级，下一个窗口从这里接）

1. **Rust 多级 mod 树解析**（把真实项目 85.4% → 95%+）：现在只支持单层 `crate::a::b` 直查 + 同目录模块；缺 `super::super::` 多级、`mod x;` 声明图的模块归属、`use a::b::{c, d}` 花括号多符号。位置：`import_resolver.rs::resolve_rust` + 绑定阶段。
2. **cross_file / metadata 落库丢失**（P1-4 一半）：`storage/memory.rs::from_existing_graph` 的 CSR 只存 (tgt, kind_u8, coupling, delay)，`cross_file` 与 `metadata` 在入库时丢失（SQLite INSERT 语句也没写这两列，`storage/sqlite.rs:467`）。影响：`resolved_by`/`unresolved_import` 溯源、`ambiguous` 标记、跨文件过滤。改法：CSR 元组加 cross_file u8 + metadata 句柄（StringArena），同步改 `collect_outgoing`/`flatten_buckets`/SQLite 两处 INSERT/读取。
3. **P1 SCIP 桥接**（符号级引用层，验收线 = 不差于对应 scip-* indexer）：官方 9 个 indexer 清单在 `docs/research/code-intelligence-indexer-ecosystem-2026-08.md` §2；设计 = SCIP 消费器给 GraphStore 换上游数据源，图存储/查询层零重写，`external_symbols` 可补库依赖节点。
4. 小尾巴：`docs/research/benchmarks/PROGRESS-2026-08-15.md` 里列的 TS 唯一未解析 import（bidi.js → 虚拟 .js，正确行为，别修）；graph_summary 的 O(E) 解析率统计在超大图（17M 边）上约秒级，如嫌慢改管线期计算入 meta。

## 四、陷阱与纪律

- **LSP 孤儿进程缺陷（已实测复现，下个窗口建议修）**：`run analyze_project` 和 `cargo test --lib`（`test_native_lsp_resolve_call_e2e`）都会触发 `LspManager::warm()`（`engine/pipeline.rs:497`），它**无条件 spawn 全部 9 个 LSP 服务器**（`lsp_manager.rs:601-645`）且**进程退出时无人 kill** → 每次运行留孤儿子进程（实测累计 33 jdtls + 128 omnisharp）。修复方向：warm 改用已存在的 `warm_blocking_filtered`（按项目语言过滤），或给 LspManager 加 shutdown/kill-on-exit。**本窗口自己跑引擎时注意 `pkill -f jdtls; pkill -f omnisharp` 收尾。**
- **不要恢复孤儿清理**：`resolver.rs` 里 P0-3 的 `unresolved:` 占位节点是有意设计（MemoryIndex 是节点锚定的，`from_existing_graph` 会丢弃端点缺失的边——占位节点是让它保留的唯一办法）。
- **不要改 benchmark gold 来迁就失败**：gold 是验收线；改解析器后必须 `python3 scripts/bench_resolution.py --all` 保持 100%。
- **工作区有别人的未提交改动，commit 时排除**：`src-tauri/src/main.rs`、`src-tauri/src/os_sandbox.rs`（Browser CDP 套件第五批）、`docs/plans/agent-core-convergence*`（删除+新增）、根目录 `hologram_graph*.json`。本任务的 commit 范围 = 第二节表格里的文件 + `docs/research/benchmarks/` + `scripts/bench_resolution.py` + 三个 fixture 目录。
- `.hologram/` 运行时目录已 gitignore；`docs/plans/browser-cdp-suite-review-round2.md` §8 是别的任务。
- 引擎二进制在 `engine/target/release/hologram-engine`（已是最新）。

## 五、给下个窗口的启动语（直接复制）

```
接上个窗口的引擎 P0 解析信任度工程。先读 docs/archive/engine-p0-resolution-handoff-2026-08-15.md 和
docs/research/survival-position-verification-2026-08.md。上个窗口已把 P0 全部落地
（gold 基准 100%、src-ui import 99.9%，全部未提交）。接下来按 handoff 第三节顺序：
先做 Rust 多级 mod 树解析（85.4%→95%+），再做 cross_file/metadata 落库修复。
改完验证：cd engine && cargo test --lib 零确定性回归，python3 scripts/bench_resolution.py --all 保持 100%。
```
