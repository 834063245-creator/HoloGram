# HANDOFF — 2026-07-12

## 已完成的上帝文件拆分

### engine/src/analysis/framework_routes/（2445 → 920 + 18×~70）
- 18 个框架各一文件，调度器 + 共享工具在 mod.rs，40 个测试

### engine/src/analysis/di_reflection/（1971 → 700 + 1500）
- 语言级 detector 函数抽到 langs.rs

### engine/src/tools/（2120 → 660 + 1470）
- 30 个 handler 函数抽到 handlers.rs

## 已完成的架构修复

### chat.ts ↔ agent.ts 编译期循环解耦 (51add3b)
- 新增 `chat-agent-handle.ts` 接口，9 个方法签名
- chat.ts 不再 import Agent 类，改为 `import type { ChatAgentHandle }`
- 31 节点环从编译期降级为纯运行时 sink 回调链

### agent_spawn 事件关联修复 (3ce654c)
- streaming-executor 补齐 `_callId` 注入，子 Agent 事件能正确关联到父工具卡片
- 新增 3 个测试 (agent-spawn-callid.test.ts)

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

## 还没动

| 文件 | 行数 | 为什么 |
|------|------|--------|
| `src-ui/src/ui/graph.ts` | ~4900 | 布局参数锁定，layout3D 不能动渲染逻辑 |
| `engine/src/engine.rs` | 2079 | 生命周期 + LSP + FTL + 增量全耦合 |
| `src-tauri/src/commands/tools.rs` | 1959 | Tauri 命令 + 后台 job 系统 |
| `src-tauri/src/os_sandbox.rs` | 1732 | 单一职责，不需要拆 |

## 已知 bug（未修）

| Bug | 说明 |
|-----|------|
| `search_content` 间歇空结果 | 引擎 analyze_project 后索引窗口期竞态 |
| `git_commit` 等每次弹 Ask | 系统规则 `Git(commit)` Ask + 用户点了"本次会话允许"但规则不匹配 |

## 构建

```powershell
cd engine; cargo build    # 零 warning
cargo test --lib          # 429 passed
cd ../src-ui; npx tsc --noEmit  # 零错误
npx vitest run            # 252 passed
npx vite build            # 零错误（~45s）
```

## 下一步建议

1. **graph.ts 拆分**：布局（layout3D/simulateForces）→ graph-layout.ts，渲染 → graph-renderer.ts
2. **engine.rs**：等 graph.ts 拆完再动
3. **search_content 竞态**：引擎 `file_index` 构建完成前加 guard
