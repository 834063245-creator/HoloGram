# Handoff — HoloGram 引擎优化（2026-06-27）

## 当前状态

全量 Linux kernel 压测（64,466 文件，773K 节点，6.2M 边 → 2.6M 最终边）：
**419s（老 Louvain 基线）→ 853s（leiden-rs）→ 492s（手写，rayon N-2 上限）。**

⚠️ 492s vs 419s 的 +17% 全部来自 rayon N-2 上限对并行阶段（Core Parse + LSP）的影响。去掉上限可回到 ~420s。
Community 自身 171s，比老 Louvain 188s 快 9%。

## 手写社区检测

- **删了** `leiden-rs` crate（556s 社区阶段，3x 慢）
- **保留** 老 Louvain 的快骨架：Vec 基数据结构、复用 weight buffer、sort-merge 边去重
- **可选** `run_leiden()` 含 refinement 阶段（仅 0.2s），但会产出 2.5x 更多社区 → hierarchical 炸到 658s。目前 L0 用 `run_louvain()`（不 refine）
- **总社区时间**: 171.2s（L0: 15.3s + Hier: 155.0s），比老 Louvain 188s 快 9%
- Refinement 代码保留在 `louvain.rs`，需启用时改 `detect_communities` 调用 `run_leiden` 即可

## 对比

| 阶段 | 老 Louvain (419s) | leiden-rs (853s) | **手写 (492s)** | vs 老 Louvain |
|------|-------------------|-------------------|-----------------|--------------|
| Core Parse | 102.6s | 151.8s | 144.4s | +41% |
| LSP | 193.2s | 256.9s | 283.7s | +47% |
| Cross-File | 21.7s | 20.9s | 21.3s | −2% |
| Community | 188.4s | 556.3s | **171.2s** | **−9%** |
| DB Save | 11.7s | 15.1s | 12.0s | +3% |
| **TOTAL** | **419s** | **853s** | **492s** | **+17%** |

## 文件变动

| 文件 | 变更 |
|------|------|
| `engine/Cargo.toml` | − `leiden-rs` |
| `engine/src/community/louvain.rs` | 完全重写：手写 Louvain + 可选 Leiden refinement（~650 行） |
| `engine/src/community/mod.rs` | 不变（导出相同） |
| `engine/src/main.rs` | + rayon 全局线程池 N-2 上限 |

## 测试

- `community::louvain`: 14/14 pass
- 零回归

## 下一步

1. **rayon 上限调优**：N-2 对并行阶段影响大（+41% Core Parse, +47% LSP）。改成 N-1 或去掉上限可回到 ~420s。机器扛得住就不需要上限。
2. **refinement 调优**：如果想要 Leiden 的 well-connected 保证，调高 γ（减少分裂）或只在最终层 refine。当前 L0 refine 产出 2.5x 社区 → 层次凝聚负担重。
3. LSP ~140s 还有空间，但目前不是主要瓶颈。
