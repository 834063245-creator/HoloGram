# HANDOFF — 2026-07-13

## 本次会话完成

### Bug 修复 ×4

| Bug | 修复 |
|-----|------|
| `search_content` 间歇空结果 | `swap_index` 入站前守卫 `has_aux_indexes`，缺失时自动 `ensure_aux_indexes` |
| `git_commit` Ask 不生效 | 回归测试 r10 + `permission_ask_response` 防御日志 |
| `move_file` 参数不匹配 | 前端 `{from,to}` → Tauri 改用 `from/to` + `rename()` |
| `rename_file` 参数不匹配 | 前端 `{filePath,newName}` → Tauri 改用 `file_path/new_name` + 自动拼接父目录 |

## 上帝文件拆分 — 累计进展

| 上帝文件 | 原始 | 现在 | -% | 拆出 |
|----------|------|------|-----|------|
| `engine.rs` | 2079 | mod(~870) + 4子模块 | -58% | grammar/pipeline/watcher/lsp |
| `framework_routes.rs` | 2445 | 920 + 18×~70 | -62% | 按职责域拆分 |
| `di_reflection.rs` | 1971 | 700 + 1500 | -64% | 接口抽象 |
| `tools.rs` (engine) | 2120 | 660 + 1470 | -69% | 按工具拆分 |
| `graph.ts` | 5434 | **3631** | **-33%** | 3轮拆分 ↓ |

### graph.ts 拆分明细

| 轮次 | 拆出 | 行数 | 模式 |
|------|------|------|------|
| 第一轮 | `graph-layout.ts` / `graph-colors.ts` / `graph-textures.ts` / `graph-shaders.ts` / `graph-scene.ts` / `graph-ui.ts` | 1144 | 纯函数抽离 |
| 第二轮 | `graph-fold.ts` — 星系折叠全流程 | 895 | `FoldHost` 接口解耦 |
| 第三轮 | `graph-analysis.ts` — 波及半径 + 路径查找 | 366 | `AnalysisHost` 接口解耦 |

### engine.rs 五模块拆分

- **2079 → mod.rs(~870 core) + 4 子模块**
- `grammar.rs`（44行）：GRAMMAR_LOADER 26 语言静态注册
- `pipeline.rs`（347行）：run_pipeline 10 阶段编排
- `watcher.rs`（290行）：文件监听 + 增量更新 + 回退全量
- `lsp.rs`（186行）：LSP 调用解析 + parser 线程缓存

## 以前的架构修复

chat↔agent 循环解耦、agent_spawn 事件关联、chat.ts UI bug ×4、子 Agent 权限 ×2、流式卡顿修复、报错统一

## 还没动

| 文件 | 行数 | 为什么 |
|------|------|--------|
| `src-ui/src/ui/graph.ts` | 3631 | Fold/Blast已拆（-33%）。Hover/Detail/Click 深度绑定 DOM+GPU+相机，提取ROI为负 |
| `src-tauri/src/commands/tools.rs` | 1935 | Tauri 命令 + 后台 job 系统。下一块目标 |

## 构建

```powershell
cd engine; cargo build      # 零 error 零 warning
cargo test --lib            # 429 passed
cd ../src-tauri; cargo test # 14 passed（dispatch）+ 8 passed（regression）
cd ../src-ui; npx tsc --noEmit   # 零错误
npx vitest run              # 252 passed
```

## 下一步建议

1. **tools.rs**（1935行）：Tauri 命令 + job 系统，按功能域拆分最优先
2. **graph.ts 渲染管线**：buildNodes/buildEdges/animate，接口抽象后可继续
