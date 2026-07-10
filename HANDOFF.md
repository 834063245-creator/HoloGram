# HANDOFF — 2026-07-13

## 本次会话完成

### graph.ts Community Fold 拆分 (4744 → 3937 行)
- **StarGraph 中的 ~800 行社区/星系折叠逻辑全部抽到 `graph-fold.ts`（895 行）**

### graph.ts Blast + Path 拆分 (3937 → 3631 行)
- **波及半径 + 路径查找 ~300 行抽到 `graph-analysis.ts`（366 行）**
- `GraphAnalysis` 类通过 `AnalysisHost` 接口访问 StarGraph 状态
- StarGraph 保留 `clearAgentHighlight` 等公共方法，内部委托到 `_analysis`
- `GraphFold` 类通过 `FoldHost` 接口访问 StarGraph 的状态（GPU 缓冲、节点数据、相机等）
- StarGraph 保留 5 个委托方法：`isFolded`、`isInsideGalaxy`、`communityCount`、`setFoldMode`、`toggleFold`
- 内部所有 `this.foldMode` / `this.enteredGalaxyId` / `this.galaxyMeta` 等 ~40 处引用全部改为 `this._fold.xxx`
- **tsc 零错误，vitest 252 全过**

### engine.rs 五模块拆分 (22b3548)
- **2079 → mod.rs(~870 core) + 4 子模块**
- `grammar.rs`（44行）：GRAMMAR_LOADER 26 语言静态注册
- `pipeline.rs`（347行）：run_pipeline 10 阶段编排
- `watcher.rs`（290行）：文件监听 + 增量更新 + 回退全量
- `lsp.rs`（186行）：LSP 调用解析 + parser 线程缓存

### Bug 修复 ×4

| Bug | 修复 |
|-----|------|
| `search_content` 间歇空结果 | `swap_index` 入站前守卫 `has_aux_indexes`，缺失时自动 `ensure_aux_indexes` |
| `git_commit` Ask 不生效 | 回归测试 r10 + `permission_ask_response` 防御日志 |
| `move_file` 参数不匹配 | 前端 `{from,to}` → Tauri 改用 `from/to` + `rename()` |
| `rename_file` 参数不匹配 | 前端 `{filePath,newName}` → Tauri 改用 `file_path/new_name` + 自动拼接父目录 |

## 以前的上帝文件拆分

- `engine/src/analysis/framework_routes/`（2445 → 920 + 18×~70）
- `engine/src/analysis/di_reflection/`（1971 → 700 + 1500）
- `engine/src/tools/`（2120 → 660 + 1470）
- `graph.ts`（5434 → 4745 → 3937 → 3631，累计 -33%）：graph-layout/graph-colors/graph-textures/graph-shaders/graph-scene/graph-ui/graph-fold/graph-analysis

## 以前的架构修复

chat↔agent 循环解耦、agent_spawn 事件关联、chat.ts UI bug ×4、子 Agent 权限 ×2、流式卡顿修复、报错统一

## 还没动

| 文件 | 行数 | 为什么 |
|------|------|--------|
| `src-ui/src/ui/graph.ts` | 3631 | Community Fold + Blast/Path 已拆出（-1113行）。Hover/Detail/Click深度绑定 DOM+GPU+相机，提取ROI为负，保持不动 |
| `src-ui/src/ui/graph-fold.ts` | 895 | Galaxy Fold 全流程（新建） |
| `src-ui/src/ui/graph-analysis.ts` | 366 | Blast波及 + Path路径查找（新建） |
| `src-tauri/src/commands/tools.rs` | 1935 | Tauri 命令 + 后台 job 系统 |
| `src-tauri/src/os_sandbox.rs` | 1732 | 单一职责，不需要拆 |

## 构建

```powershell
cd engine; cargo build      # 零 error 零 warning
cargo test --lib            # 429 passed
cd ../src-tauri; cargo test # 14 passed（dispatch）+ 8 passed（regression）
cd ../src-ui; npx tsc --noEmit   # 零错误
npx vitest run              # 252 passed
```

## 下一步建议

1. **graph.ts 渲染管线**：buildNodes/buildEdges/animate 需要接口抽象
2. **tools.rs**：Tauri 命令 + job 系统，可考虑按功能域拆分
