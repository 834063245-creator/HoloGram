# Handoff — HoloGram（2026-06-28 session 8）

## 当前状态

- **引擎**：27+3 门语言；合并管线 v3/v4；363 lib tests 全过
- **前端**：节点核心球视觉效果修复（session 4）
- **已验证**：`codebase-memory-mcp` 分析正常；`cargo tauri build` 成功
- **MCP 工具**：25 → **27**（新增 `hologram_node` + `hologram_unused`）
- **README**：全量更新（语言数、管线、过滤策略、测试数）

---

## 过滤策略（完整）

| 层级 | 位置 | 机制 |
|------|------|------|
| L0 — 硬编码 | `discovery.rs` | 28 个通用目录黑名单 |
| L1 — `.gitignore` | `discovery.rs` | 项目树中所有 `.gitignore` 解析 |
| L2 — 扩展名 | `discovery.rs` | 仅收录 27+3 门已注册语言 |
| L3 — 文件大小 | `parser.rs` | > 1 MB 跳过（`metadata()` 预检） |

---

## 本次变更（session 8 — MCP 工具扩展）

### 新增工具

| 工具 | 功能 | 输入 |
|------|------|------|
| `hologram_node` | 单节点深潜：身份 + 度 + 社区 + 所有入/出边（按 kind 分组） | `node_id` |
| `hologram_unused` | 死代码检测：in_degree=0 的 Function/Class，按 out_degree 降序 | `limit`（默认 20）、`kind_filter`（默认 "function,class"） |

### 改动文件

| 文件 | 改动 |
|------|------|
| `engine/src/mcp.rs` | tool_defs 注册 + dispatch + `tool_node()` + `tool_unused()` 实现 |
| `README.md` | 全量更新（27+3 语言、v3/v4 管线、四级过滤、361→27 工具） |

### 历史变更

- **session 7**：`.gitignore` 解析 + 四级过滤体系
- **session 6**：discovery 排除目录扩展 + parser 1 MB 上限
- **session 5**：全局边去重（8.5M→13.6K）+ 逐批后台 Tree 释放
- **session 3-4**：GrammarLoader + Node 核心球视觉修复
- **session 1-2**：合并管线 v3 分批架构 + 静默吞错修复

---

## 测试

- **363 lib tests passed，0 failed**
- `cargo check` / `cargo build --release` 零错误零警告
- `cargo tauri build` 成功产出 `.msi` + `.exe`
- **已知问题**：
  - `main.rs` bin tests：2 个测试隔离失败（与 lib tests 共用 engine 实例，数据污染），非本次引入
  - `mcp::tests` 18 个 PoisonError（测试间共享锁污染），非本次引入

---

## 下一步

1. `hologram_unused` 目前只看 in_degree=0；可扩展为"低使用率"（in_degree=1 且仅被 tests 调用）
2. 工具描述差异化：内置 Agent 已可看到详细描述；MCP 通道对外部 AI 工具用精简版
3. 修复 main.rs 测试隔离 → 每个测试用唯一 temp dir
