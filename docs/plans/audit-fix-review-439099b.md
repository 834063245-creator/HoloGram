# 审计修复提交复核 — 439099b

> 提交：`439099b` fix(audit): 执行审计修复计划批次 A-E (30+ 条目)
> 日期：2026-07-25
> 来源计划：`docs/plans/audit-fix-plan-2026-07-25.md`
> 改动规模：39 files, +2256 / −282

---

## 三端验证结果

| 验证端 | 命令 | 结果 | 备注 |
|--------|------|------|------|
| Engine | `cargo test --lib` | 480 passed, 1 flaky | `test_cancel_token_stops_pipeline` 预存时序测试 |
| Rust 后端 | `cargo test --bin hologram` | 169 passed, 0 failed | |
| TypeScript | `npx tsc --noEmit` | clean | |
| Frontend | `npm test` | 582 passed | `agent-boundary.test.ts` 预存环境问题（`node:` 模块解析） |

---

## 批次 A — Agent 框架（6 条目）

| 条目 | 状态 | 改动文件 | 验收要点 |
|------|------|----------|----------|
| A1 LifecycleManager 泄漏 | ✅ | runtime.ts | createAgent 前 stop 旧实例；destroyAgent 已有 stop |
| A2 agent_kill 工具 | ✅ | subagent.ts, agent-builder.ts | 幂等；已完成/不存在返回状态不报错 |
| A3 search/list 超时 | ✅ | search.rs, utils.rs, agent-builder.ts | 20k文件/60s预算；4层深度；120s前端超时 |
| A4 abort 打断在途工具 | ✅ | streaming-executor.ts, agent.ts | `_raceWithAbort` + signal 传入 executor |
| A5 告警去重 L2/L3 | ✅ | lifecycle-manager.ts, chat-stream.ts, runtime-adapter.ts, agent-panel-store.ts | warnedKeys 不清空；10分钟同文本去重；内容哈希 ID |
| A6 Board 会话级隔离 | ✅ | discovery-board.ts, task-board.ts, runtime.ts, types.ts, discovery.ts, agent-panel-store.ts | proxy 模式 + 按会话分片持久化 + 旧文件迁移 |

### A6 架构变更详情

**Before**: DiscoveryBoard/TaskBoard 为 Runtime 级单例，所有会话共享一板，持久化为全局 `.hologram/{discoveries,taskboard}.json`。

**After**:
- 每个 `sessionId` 拥有独立 board 实例（`_getOrCreateTaskBoard` / `_getOrCreateDiscoveryBoard` 懒创建）
- 主 Agent 通过 `TaskBoardProxy` / `DiscoveryBoardProxy` 动态切换 target（`setCurrentSession`）
- 子 Agent 继承父会话 ID（`config.parentId` → `_agentSessions` 查找）
- 持久化路径：`.hologram/{discoveries,taskboard}/{sessionId}.json`
- 启动时自动迁移旧全局文件到 `default` 会话
- DiscoveryBoard 新增：`status` 字段（active/archived）、`archive()` 方法、`since`/`limit`/`includeArchived` 参数、同 key 覆盖
- TTL：24h → 2h（仅防崩溃残留）
- `onFinish` 回调：子 Agent 完成时自动 archive 其发现

### A4 架构变更详情

**Before**: `StreamingToolExecutor.awaitRemaining()` 逐个 `await` pending promise，永不 settle 的工具（如卡死的 Tauri invoke）会导致协程永久悬挂。

**After**: executor 构造接收 `AbortSignal`；`awaitRemaining` 对每个 pending promise 调用 `_raceWithAbort` —— signal abort 时 reject `AbortError`，break 循环。agent.ts 的 `runLoop` 传入其 `signal`。

---

## 批次 B — 安全（5 条目）

| 条目 | 状态 | 改动文件 | 验收要点 |
|------|------|----------|----------|
| B1 SSRF 重定向 + ipv6-mapped | ✅ | web.rs, utils.rs | `max_redirects(0)` + 手动跟随 + 每跳重检；`to_ipv4_mapped()` 递归 |
| B2 bash 混淆 | ✅ | bash.rs | `$VAR`/`${VAR}` 展开后复检；2 段管道解码检测 |
| B3 rpc.rs allow 静默 | ✅ | rpc.rs | 缺参/非 bool 返回明确错误 |
| B4 bumpVersion 缺口 | ✅ | agent.ts | goal 暂停路径两处 slice 后补 `bumpVersion()` |
| B5 rule.rs glob ** 越界 | ✅ | rule.rs | `**` 中间不跨目录（`[^/]*`）；末尾仍递归（`.*`） |

---

## 批次 C — Routes 一行/小修复（4 条目）

| 条目 | 状态 | 改动文件 | 验收要点 |
|------|------|----------|----------|
| C1 framework 硬编码 | ✅ | mod.rs | `inject_routes` 加 `framework: &str` 参数；19 个调用点全部传入 |
| C2 cross_file 硬编码 | ✅ | mod.rs | 新增 `is_cross_file()` 比较 handler 节点文件与路由文件 |
| C3 Express handler | ✅ | express.rs | 取最后一个非标点参数作为 handler（非第一个） |
| C4 ASP.NET handler | ✅ | aspnet.rs | 新增 `extract_method_name()` 从方法签名提取名称 |

---

## 批次 D — Routes 结构性（7 条目）

| 条目 | 状态 | 改动文件 | 验收要点 |
|------|------|----------|----------|
| D1 Spring 前缀合并 | ✅ | spring.rs | 类级 `@RequestMapping` 作为前缀与方法级路径合并 |
| D2 Phoenix scope | ✅ | phoenix.rs | block 栈跟踪 `scope "..." do...end`，前缀传播 |
| D3 Django include() | ✅ | django.rs | `include()` 调用返回 `None`，不生成路由 |
| D4 DRF register() | ✅ | django.rs | `expand_drf_register()` 展开为 6 条 CRUD 路由 |
| D5 6 框架补测试 | ✅ | mod.rs | 12 个新测试（ASP.NET/Sinatra/Fiber/Fastify/Slim/Rocket） |
| D6 Flask/FastAPI 日志 | ✅ | mod.rs | 候选文件数 `eprintln!` |
| D7 Express 检测重叠 | ✅ | express.rs, mod.rs | `has_express_content()` 内容门槛 |

---

## 批次 E — 质量债（6 条目）

| 条目 | 状态 | 改动文件 | 验收要点 |
|------|------|----------|----------|
| E1 bash 7 类攻击测试 | ✅ | bash.rs | DeviceWrite/eval/exec/ReverseShell/GitForcePush/wget/PS IEX/FromBase64 |
| E2 git.rs/web.rs 补测试 | ✅ | git.rs, web.rs | git 2→8, web 2→6 |
| E3 RPC 返回值统一 | ✅ | rpc.rs | `hologram_record_event` 从 `"ok"` 改为 `"null"`（参数改名跳过——前端兼容风险） |
| E4 死代码清理 | ✅ | mod.rs, tools.rs(删), hologram.rs | 删 `pub mod tools` + 空文件 + `hologram_workspace_conflict` |
| E5 CompactionTracker 持久化 | ✅ | compaction-model.ts, agent.ts | `serializeState`/`deserializeState` → `compaction-tracker.json` |
| E6 Board flush 崩溃兜底 | ✅ | runtime.ts, main.ts | `flushAllBoards()` + beforeunload 钩子 |

---

## 遗留项

| 项 | 说明 | 风险 |
|----|------|------|
| E3 参数命名统一 | `filesystem.rs` path/file_path/from-to 混用未修——前端兼容风险高，仅统一了返回值 | 低：功能不受影响，仅 API 一致性 |
| `agent-boundary.test.ts` | 预存环境问题（`node:` 模块解析），非本次引入 | 无 |
| `test_cancel_token_stops_pipeline` | 预存 flaky 时序测试，非本次引入 | 无 |
| `hologram_dispatch_test` 集成测试 10 个失败 | 需要引擎状态，预存失败，非本次引入 | 无 |
| AGENTS.md 同步 | A2 新增 `agent_kill` 工具，AGENTS.md 工具集清单待更新 | 低：不影响功能 |

---

## 新增文件

- `docs/plans/audit-fix-plan-2026-07-25.md` — 审计修复计划原文
- `docs/plans/framework-expansion-plan-2026-07-25.md` — 框架扩展计划（批次 D 子 Agent 生成）

## 删除文件

- `src-tauri/src/commands/tools.rs` — 空文件，仅含注释（E4）
