# HANDOFF — 2026-07-12

## 已完成的上帝文件拆分

### engine/src/engine/ — 五模块拆分 🆕
- **2079 → mod.rs(~870 core) + 4 子模块（grammar/pipeline/watcher/lsp）**
- `grammar.rs`（44行）：GRAMMAR_LOADER 26 语言静态注册
- `pipeline.rs`（347行）：run_pipeline 10 阶段编排
- `watcher.rs`（290行）：is_watching/start_watcher/stop_watcher/handle_watcher_changes
- `lsp.rs`（186行）：reparse_for_lsp/resolve_calls_lsp/TL_LSP_PARSER
- `mod.rs`（~870行核心 + ~600行测试）：Engine struct + 生命周期 + 全局函数 + 测试

### engine/src/analysis/framework_routes/（2445 → 920 + 18×~70）
- 18 个框架各一文件，调度器 + 共享工具在 mod.rs

### engine/src/analysis/di_reflection/（1971 → 700 + 1500）
- 语言级 detector 函数抽到 langs.rs

### engine/src/tools/（2120 → 660 + 1470）
- 30 个 handler 函数抽到 handlers.rs

### graph.ts 布局拆分 (ded0100)
- 5434 → 4911 行 (-523)
- 提取 `graph-layout.ts`：fibonacciSphere / simulateForces / spiralGalaxies / repelCommunityCentroids / layout3D

### graph.ts 五模块拆分 (898161e)
- 4911 → 4745 行 (-166)
- 新增：`graph-colors.ts` / `graph-textures.ts` / `graph-shaders.ts` / `graph-scene.ts` / `graph-ui.ts`
- **合计 5434 → 4745（-689 行，-12.7%）**

## 已完成的架构修复

### chat.ts ↔ agent.ts 编译期循环解耦 (51add3b)
- 新增 `chat-agent-handle.ts` 接口，chat.ts 不再 import Agent 类

### agent_spawn 事件关联修复 (3ce654c)
- streaming-executor 补齐 `_callId` 注入，新增 3 个测试

### chat.ts UI bug 修复 (a69a88e)
1. 错误卡片被 streaming DOM 同步清除 → msg-error-card 加入保留列表
2. 斜杠面板在折叠时残留 → collapseToInput/Pill 时 _hideSlashPanel
3. monitor/bash_output 输出未格式化 → 加入 shell 代码块渲染分支
4. 未知 AgentEvent 导致停止按钮异常消失 → renderEvent 加 default 日志

### 子 Agent 权限修复
- 折叠面板不再闷杀权限弹窗 (4948737) → cancelPendingApprovals 受 running 守卫
- showPermissionCard 串行化去重 (6b0db8f) → Promise 队列保证单卡

### 流式输出卡顿修复 (2137d5c)
- 重试期间 notice 插在 streaming assistant 前面，保持增量渲染路径

### 报错改为普通聊天消息 (e05c984)
- 删除 addErrorNotice DOM 卡片（42行），错误全部走 addNotice → 消息模型统一渲染

## 还没动

| 文件 | 行数 | 为什么 |
|------|------|--------|
| `src-ui/src/ui/graph.ts` | 4745 | StarGraph 渲染管线（_renderImpl/buildNodes/buildEdges/animate）深度绑定 THREE.js 实例 |
| `engine/src/engine/mod.rs` | ~870 core | ✅ **已拆分**（+grammar/pipeline/watcher/lsp） |
| `src-tauri/src/commands/tools.rs` | 1959 | Tauri 命令 + 后台 job 系统 |
| `src-tauri/src/os_sandbox.rs` | 1732 | 单一职责，不需要拆 |

## 已知 bug（未修）

（本次会话已修复以下两个 bug ✅）

| Bug | 说明 | 状态 |
|-----|------|------|
| `search_content` 间歇空结果 | 引擎 analyze_project 后索引窗口期竞态 | ✅ `swap_index` 加 has_aux_indexes 守卫 |
| `git_commit` 等每次弹 Ask | 系统规则 `Git(commit)` Ask + 用户点了"本次会话允许"但规则不匹配 | ✅ 添加回归测试 r10 + permission_ask_response 防御日志 |

## 构建

```powershell
cd engine; cargo build    # 零 warning
cargo test --lib          # 429 passed
cd ../src-ui; npx tsc --noEmit  # 零错误
npx vitest run            # 252 passed
npx vite build            # 零错误（~45s）
```

## 下一步建议

1. **engine.rs**：生命周期 + LSP + FTL + 增量全耦合，优先级最高
2. **graph.ts 渲染管线**：buildNodes/buildEdges/animate 需要接口抽象才能拆出
3. **search_content 竞态**：引擎 file_index 构建完成前加 guard
4. **git_commit Ask 不生效**：系统规则匹配 bug
