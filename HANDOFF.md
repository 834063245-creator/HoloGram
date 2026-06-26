# Handoff — HoloGram 引擎优化（2026-06-26）

## 当前状态

全量 Linux kernel 压测（64,466 文件，773K 节点，6.2M 边）：
**973s → 522s（−46%），峰值 RSS 13.5GB → 11GB，最终 RSS 61MB 平坦。**

## 本次完成的优化

### 1. mimalloc 全局分配器
- **文件**: `engine/Cargo.toml`（+ `mimalloc = "0.1"`），`engine/src/main.rs`（+ `#[global_allocator]`）
- **效果**: 整体 15-22%，多线程小分配场景（图构建、LSP）收益最大
- **⚠️ gitignored**: 这两个文件被 `.gitignore` 忽略，变更在磁盘但未提交

### 2. Vec-based Louvain 社区检测
- **文件**: `engine/src/community/louvain.rs`（`run_louvain` 函数完全重写）
- **改动**: 
  - `community_nodes`: `HashMap<usize, Vec<usize>>` → `Vec<Vec<usize>>`
  - `sigma_tot`: `HashMap<usize, f64>` → `Vec<f64>`
  - 每节点内循环 `comm_weights`: 每次新建 `HashMap` → 可复用 `Vec<f64>` + `touched` 列表
  - 重编号: `HashMap` 克隆 → O(n) Vec 压缩 + remap
- **效果**: Community L0 31s→20s（−35%），全量场景预计 −60%

### 3. 流式 LSP（parse_cache 不保留 CST）
- **文件**: `engine/src/engine.rs`（+ `language_for_lsp` / `reparse_for_lsp`），`engine/src/pipeline/runner.rs`（后台 tree drop）
- **改动**:
  - `runner.rs`: parse_cache 只存 source，不存 tree。Tree 收集到 `Vec`，后台线程 drop（避免 `ts_tree_delete` 阻塞 Core Parse 合并循环）
  - `engine.rs`: LSP 阶段从 source re-parse 获取 tree（`reparse_for_lsp`），用完即丢
  - `language_for_lsp`: 扩展名→tree-sitter Language 映射（注意：kotlin 因 tree-sitter 版本冲突被跳过——kotlin 0.3 依赖 tree-sitter 0.20，项目用 0.24）
  - parse_cache 在 dataflow 合成后 `clear()`
- **效果**: LSP 321s→216s（−33%），RSS 峰值 13.5GB→11GB
- **⚠️ gitignored**: `runner.rs` 被 `.gitignore` 忽略，变更在磁盘但未提交

### 4. 社区检测优化未覆盖的部分
- `detect_hierarchical_from_base` 的缩合循环仍然用 `HashMap`（`node_to_ci`、`edge_counts`）
- Community Hier 243s 占总时间 47%，是下一优先目标
- 方向：将缩合循环的 HashMap 也换成 Vec，或考虑 Leiden 算法

## 未提交的磁盘变更（gitignored）

以下文件被 `.gitignore` 规则忽略（"核心源码不公开"），变更仅在本地磁盘：

| 文件 | 变更 |
|------|------|
| `engine/Cargo.toml` | + `mimalloc = "0.1"` |
| `engine/src/main.rs` | + `#[global_allocator] static GLOBAL: mimalloc::MiMalloc` |
| `engine/src/pipeline/runner.rs` | 后台 tree drop（`trees_to_drop` Vec + `std::thread::spawn`） |

**恢复这些变更的方法**: 重新应用上述改动，或从本 handoff 的 diff 描述中手动恢复。

## 测试状态

| 测试套件 | 结果 |
|----------|------|
| `community::louvain` | 14/14 pass |
| `storage::memory` | 13/14 pass（1 fail: SQLite temporal roundtrip，预存 bug） |
| `storage::incremental` | 8/8 pass |
| `mcp::tests` | 11 fail（预存，依赖 test project setup） |

引擎二进制: `engine/target/release/hologram-engine.exe`

## 压测命令

```bash
cd D:\HoloGramHG\engine

# 小规模快速验证
./target/release/hologram-engine.exe --stress-real "D:/tmp/linux-stress/kernel" 1

# 中等规模
./target/release/hologram-engine.exe --stress-real "D:/tmp/linux-stress/fs" 1

# 全量
./target/release/hologram-engine.exe --stress-real "D:/tmp/linux-stress" 1
```

Linux kernel 源码位置: `D:\tmp\linux-stress`（shallow clone，64K 文件）

## 下一步优化（按优先级）

### P0: 确认全量基线（522s）可复现
重新跑全量压测确认 522s 不是 fluke。

### P1: Community Hier 缩合 HashMap→Vec
- **文件**: `engine/src/community/louvain.rs`，`detect_hierarchical_from_base` 函数
- **目标**: `node_to_ci` 和 `edge_counts` 从 HashMap 换成 Vec
- **预计收益**: Community Hier 243s→80-120s
- **难点**: 字符串 key（node ID → community index）需要先转成 dense index

### P2: tree-sitter Parser 线程局部缓存
- **当前问题**: LSP re-parse 每次创建新 `Parser::new()` + `set_language()`，64K 次
- **方向**: 参考 `adapter/tree_sitter.rs` 的 `TL_PARSER` thread-local 缓存
- **文件**: `engine/src/engine.rs`，`reparse_for_lsp` 函数

### P3: FileData Vec 内存峰值
- **当前**: `parse_files()` 返回全部 64K FileData 的 Vec，峰值 ~4.4 GB
- **方向**: 流式消费——用 channel 或 `par_iter().map().collect()` 直接进 merge loop
- **文件**: `engine/src/pipeline/runner.rs`，`analyze_project` 函数

### P4: 参考项目
- [codebase-memory-mcp](https://github.com/casualjim/codebase-memory-mcp): 同类项目，纯 C，Linux kernel 3 分钟
- 差距: 1) 一遍过 vs 两遍 2) mimalloc vs 默认（✅ 已做）3) XXH3 vs SipHash

## 完整阶段耗时对比

| 阶段 | 优化前 | 优化后 | Δ |
|------|--------|--------|-----|
| Core Parse | 140s | 115s | −18% |
| LSP | 321s | 216s | −33% |
| Cross-File | 22s | 24s | — |
| Community L0 | 31s | 20s | −35% |
| Community Hier | 219s | 243s | — |
| DB Save | 12s | 13s | — |
| **TOTAL** | **973s** | **522s** | **−46%** |
| **RSS 峰值** | **13.5 GB** | **11 GB** | **−19%** |
