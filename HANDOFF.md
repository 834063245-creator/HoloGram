# Handoff — HoloGram 引擎优化（2026-06-26）

## 当前状态

全量 Linux kernel 压测（64,466 文件，773K 节点，6.2M 边）：
**原版跑不通 → 1320s → 973s → 522s → 419s（−68%），RSS 峰值 13.5GB → 11GB，最终 RSS 61MB。**

⚠️ **Leiden 压测未完成**：session 中断时跑到 dataflow 阶段。需要重跑 `--stress-real "D:/tmp/linux-stress" 1`。

## 完成的优化（按时间线）

### 1. mimalloc + Vec Louvain + 流式 LSP（commit `f8fe292`, `94b1759`）
- mimalloc 全局分配器：15-22%
- `run_louvain` Vec 化：Community L0 31s→20s
- parse_cache 不存 CST：LSP 321s→216s，RSS 峰值 −2.5GB
- 基线: **973s→522s（−46%）**

### 2. Community Hier Vec 缩合 + LSP Parser 缓存 + FileData 流式（commit `54b39de`）
- **P1**: `detect_hierarchical_from_base` 的 `node_to_ci`（HashMap→Vec）+ `edge_counts`（HashMap→Vec sort-merge）
- **P2**: `reparse_for_lsp` thread_local parser 缓存，省 64K 次 `Parser::new()`
- **P3**: `analyze_project` 流式 merge（`par_iter().for_each()` + Mutex），不再分配 64K FileData Vec
- 基线: **522s→419s（−20%）**，Community Hier 243s→173s（−29%）

### 3. Louvain → Leiden（commit `32d77e8`）
- **替换**: `leiden-rs` crate（v0.8.1）替代手写 Louvain
- **删掉**: `run_louvain`（~120 行）+ `detect_hierarchical_from_base`（~150 行）
- **新增**: `detect_communities_and_hierarchy` — 一次 Leiden `run_hierarchical()` 同时返回 flat + hierarchical
- **引擎**: Community L0 + Community Hier 合并为一个 `Community (Leiden)` 阶段
- ⚠️ **全量压测未完成**，预计 Community 阶段 188s（15s+173s）→ 60-90s

## 文件变动总览

| 文件 | 变更 |
|------|------|
| `engine/Cargo.toml` | + `leiden-rs`, `mimalloc` |
| `engine/src/main.rs` | + `#[global_allocator]` mimalloc |
| `engine/src/community/louvain.rs` | 完全重写：Louvain → Leiden，删 ~520 行 |
| `engine/src/community/mod.rs` | + `detect_communities_and_hierarchy` export |
| `engine/src/engine.rs` | LSP parser 缓存, 社区检测合并为一个阶段 |
| `engine/src/pipeline/runner.rs` | 流式 merge（`par_iter().for_each()`） |
| `engine/src/pipeline/parser.rs` | `parse_one` → `pub` |
| `engine/src/stress.rs` | stage name: "Community L0" → "Community (Leiden)" |

## 测试状态

| 测试套件 | 结果 |
|----------|------|
| `community::louvain` | 14/14 pass |
| `storage::memory` | 13/14 pass（1 fail: SQLite roundtrip，预存） |
| `storage::incremental` | 8/8 pass |
| `engine::tests` | 9/9 pass |
| `pipeline::runner` | 6/6 pass |
| `stress` | 3/3 pass |
| `mcp::tests` | 11 fail（预存，PoisonError） |

**总计: 329 pass / 12 fail（全预存，零回归）**

## 压测命令

```bash
cd D:\HoloGramHG\engine

# 小规模快速验证
./target/release/hologram-engine.exe --stress-real "D:/tmp/linux-stress/kernel" 1

# 全量
./target/release/hologram-engine.exe --stress-real "D:/tmp/linux-stress" 1
```

## 最近一次完整压测（419s 基线）

| 阶段 | 522s 基线 | 419s 基线 | Δ |
|------|-----------|-----------|-----|
| Core Parse | 115s | 102.6s | −11% |
| LSP（含 Core Parse 起计） | 216s | 193.2s | −11% |
| Cross-File | 24s | 21.7s | −10% |
| Community L0 | 20s | 15.0s | −25% |
| Community Hier | 243s | 173.4s | −29% |
| DB Save | 13s | 11.7s | −10% |
| **TOTAL** | **522s** | **419.2s** | **−20%** |

## 下一步

1. **重跑 Leiden 压测** — CPU 不忙时跑 `--stress-real "D:/tmp/linux-stress" 1`，看 Community (Leiden) 一个阶段多久
2. LSP ~90s 还有空间，但目前不是瓶颈
3. 余下 ≤5s 的阶段不值得碰
