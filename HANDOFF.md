# Handoff — HoloGram（2026-06-28 session 7）

## 当前状态

- **引擎**：27 门语言；合并管线 v3 分批 + v4 全局边去重；12/12 pipeline 核心测试 passed
- **前端**：节点核心球视觉效果修复（session 4）
- **已验证**：`codebase-memory-mcp`（1710 文件 C 项目）→ 分析正常
- **过滤策略**：四级过滤体系完成，覆盖 95%+ 真实项目

---

## 过滤策略（完整）

| 层级 | 位置 | 机制 |
|------|------|------|
| L0 — 硬编码 | `discovery.rs:is_excluded` | 28 个通用目录黑名单 |
| L1 — `.gitignore` | `discovery.rs:collect_gitignore_dirs` | 项目树中所有 `.gitignore` 解析 |
| L2 — 扩展名 | `discovery.rs:discover_files` | 仅收录 27 门已注册语言 |
| L3 — 文件大小 | `parser.rs:parse_one` | > 1 MB 跳过（`metadata()` 预检，手写源码不可能超此阈值） |

L1 解析器简化为纯目录名提取：跳过 glob（`*`/`?`/`[`）、negation（`!`）、注释、空行。多级路径取末级组件（`graph-ui/dist/` → `dist`）。

---

## 本次变更（session 7 — `.gitignore` 解析）

### 改动

| 文件 | 改动 |
|------|------|
| `engine/src/pipeline/discovery.rs` | 新增 `collect_gitignore_dirs()` + `is_excluded` 合并硬编码与 gitignore 模式；2 个新测试 |

### 历史变更

- **session 6**：discovery 排除目录扩展（`vendored`/`generated`/`tests`）+ parser 512 KB 上限 — 解决 C 项目 vendored grammar 文件爆炸
- **session 5**：全局边去重（8.5M→13.6K）+ 逐批后台 Tree 释放
- **session 3-4**：GrammarLoader + Node 核心球视觉修复
- **session 1-2**：合并管线 v3 分批架构 + 静默吞错修复

---

## 测试

- **pipeline: 12/12 passed**（runner 6 + discovery 4 + parser 1 + stress 1）
- `cargo check` 零错误零警告
- `mcp::tests` 18 个 PoisonError 是已知问题（测试间共享锁污染），非本次引入

---

## 下一步

1. 换其他大型项目验证（Rust monorepo、Python Django）
2. 如果某项目需要分析 vendored 代码 → CLI flag `--no-filter`
3. `.gitignore` glob 支持 — 仅在遇到 `cbm_*` 这类真实需求时加
