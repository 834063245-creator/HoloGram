# HoloGram 审计修复计划（执行版）

> 来源：2026-07-08 审计报告 + 2026-07-25 逐条代码复核（8 个探索 Agent + 主 Agent 亲查）
> 复核结论：40 条断言中 25 条确认、7 条部分属实、8 条驳回。本计划只收录确认/部分属实且值得修的条目。
> 执行方式：每个条目独立可交付，按批次顺序执行；每条附验收标准与回归测试点。

## 全局约束（执行 Agent 必读）

- 遵守根目录 `AGENTS.md`：不恢复 Python 引擎路径；不改 `graph-layout.ts`/`gpu-layout.ts` 布局参数；打包用 `cargo tauri build` 而非 `cargo build --release`。
- 最小改动原则：每个修复只动它声称的位置，不顺手重构。
- 每个安全/行为修复必须附带或更新测试；改动后同步更新过时注释。
- 改动若涉及 `AGENTS.md` 已描述的机制（工具集清单、`.hologram/` 目录结构、目标模式等），同步更新 `AGENTS.md` 与对应 docs（A2、A6 会触发）。
- 每批次完成后跑验证：`cd engine && cargo test --lib`、`cd src-tauri && cargo test`、`cd src-ui && npx tsc --noEmit && npm test`。
- 路径注意：审计报告中的 `engine/src/framework_routes/` 实为 `engine/src/analysis/framework_routes/`；`src-tauri/src/git.rs` 等实为 `src-tauri/src/permissions/*.rs`。

---

## 批次 A：Agent 框架（本次会话直接暴露，最高优先）

### A1. LifecycleManager 实例泄漏 —— 告警刷屏的根治

- **位置**：`src-ui/src/agent/runtime.ts:352-360`
- **根因**：`createAgent` 每次调用都 `new AgentLifecycleManager(...)` 并覆盖 `_lifecycleManagers` map（:360），旧实例的 60s `setInterval`（`lifecycle-manager.ts:70`）永久存活且再无法 stop。factory 调用点：`workspace.ts:702`、`ui/chat-session.ts:274`（新建会话）/`:564`（恢复会话）/`:697`（磁盘加载）。N 次会话操作 = N 个并发巡检，每个新实例 `warnedKeys` 为空、首轮必报，UI 侧 `_addNoticeMessage`（`chat-stream.ts:170-188`）无条件追加消息 —— 叠加成刷屏。
- **修复**：
  1. `runtime.ts:352` 之前插入 `this._lifecycleManagers.get(agentId)?.stop()`，保证一个 agentId 同时只有一个巡检实例。
  2. 检查 `destroyAgent`（`runtime.ts:420`）确认 dispose 路径能 stop 当前实例。
- **验收**：连续新建/切换/恢复会话 5 次后，同一未合并 worktree 的告警 60s 内只出现一次。
- **回归**：`src-ui` lifecycle 相关测试；`npx tsc --noEmit`。

### A2. agent_kill 工具

- **位置**：`src-ui/src/agent/tools/subagent.ts`（工具注册）、`src-ui/src/agent/coordinator.ts:237`（`stop(id)` 已实现：abort + finish，池位立即释放）
- **现状**：池级单体停止能力已存在，只是没暴露成工具；`subagent.ts:14-16` 注释自述「没有 agent_status / agent_stop 工具」。超时兜底（`coordinator.ts:161-167`，默认 30 分钟）只做账务结算（先 abort 再 finish），无法取消在途 invoke（见 A4），但池位确实会释放。
- **修复**：
  1. 新增工具 `agent_kill(agentId: string, reason?: string, worktree?: "keep" | "discard")`，默认 `keep`。
  2. 实现调用 `pool.stop(id)`；幂等：目标已完成/不存在时返回当前状态，不报错。
  3. `worktree: "discard"` 时清理对应 worktree，并通知 LifecycleManager 该 agent 不按泄漏上报（需在 lifecycle-manager 加豁免 API 或经 coordinator 回调）。
  4. 约束：只能杀自己 spawn 的子 Agent（main Agent 可杀任意 sub）。
  5. 更新 `subagent.ts:14-16` 的过时注释。
- **验收**：主 Agent 用工具杀掉运行中的子 Agent，状态变 `Stopped`、池位释放、UI 收到终止事件；杀已完成者返回现状。
- **回归**：`tests/subagent-sink.test.ts`、`tests/agent-spawn-sync.test.ts` + 新增 kill 用例。

### A3. search_content / list_directory 超时与输出上限

- **位置**：`src-tauri/src/commands/search.rs:101-173`、`src-tauri/src/utils.rs:840-877`（`list_dir_recursive`）、`src-ui/src/agent/runtime/agent-builder.ts:332`（codingExec 直通）
- **根因（亲查确认）**：
  - `search.rs` walkdir 全树遍历 + 每文件 `read_to_string` 全量读入；早退 `results.len() >= max`（:168,:172）只在 content 模式且匹配够多时触发；`files_with_matches`/`count` 模式 `results` 恒空 → **永远扫完全树**；content 模式零匹配同理。无时间预算、无扫描文件数上限。目录排除依赖 engine 的 `is_ignored_path`（`engine/src/pipeline/discovery.rs:96-104`，node_modules/target/.git 已排除），项目内有界，但子 Agent 传项目外绝对路径时扫描量无边界 → 表现为永久卡死。
  - `list_dir_recursive` **无任何深度/条目限制**，只排除 `.git/.hg/.svn`（不排除 node_modules/target）——工具 description 宣称的「最多 4 层」（`tools/coding.ts:195`）后端并未实现。
  - 前端 `agentInvoke` 无超时包装，Tauri invoke promise 不可取消。
- **修复**：
  1. `search.rs`：加扫描预算（扫描文件数上限，如 20k，或 60s 时间预算），触顶返回部分结果 + `truncated: true` + 文本说明；`files_with_matches`/`count` 模式加匹配文件数早退。
  2. `list_dir_recursive`：落实 4 层深度上限 + 条目上限（如 2000）+ 复用 `is_ignored_path` 排除 node_modules/target 等；截断时在输出中标注。
  3. `agent-builder.ts` codingExec：给 `search_content`/`search_code`/`glob`/`list_directory` 包 120s 超时（参照 `SHELL_TIMEOUT` 模式），超时返回错误文本给模型而非死等。
  4. 子 Agent 权限询问可见性：`permission-ask` 监听器（`main.ts:450`）绑死在启动时的 chatPanel 上，子 Agent 触发的 Ask 卡与来源子 Agent 无关联，用户 120s 不答即自动拒（`main.ts:472-479`），模型拿到拒绝后可能盲目重试 → 每轮白等 120s。修复：`permission-ask` 事件载荷带 `_agent_id`（后端 `search.rs:47-49` 已有 `set_active_agent_id` 可串联），UI 卡片标注来源子 Agent；子 Agent 的只读工具 Ask 超时可短于 120s。
- **验收**：项目根跑零匹配的 `files_with_matches` 搜索在预算内返回并标注截断；`list_directory` 项目根输出被截断且不含 node_modules 内容；超时路径有测试；子 Agent 触发的权限卡在 UI 可辨认来源。
- **回归**：`src-tauri` cargo test；`src-ui` tsc + 相关工具测试。

### A4. abort 无法打断在途工具 promise

- **位置**：子 Agent runFn 的工具等待点（`streaming-executor.ts:113` `awaitRemaining`）+ abort 检查点
- **根因**：Tauri invoke promise 不可被 AbortController 取消；abort 只在循环迭代间隙检查，等在永不 settle 的 promise 上的协程永久悬挂。A3 修了「promise 永不 settle」的来源后，本条保证 abort 语义完备。
- **修复**：子 Agent 循环中将工具等待与 abort signal 竞态（`Promise.race` + reject-on-abort helper）；abort 胜出时 `executor.discard()` 并以 stopped 结束。
- **验收**：mock 一个永不 resolve 的工具，kill/timeout 后子 Agent 循环 1s 内退出，无悬挂协程（新增测试）。
- **依赖**：与 A2 同批交付（kill 的语义依赖本条才完整）。

### A5. 告警去重 L2/L3（防御纵深）

- **依赖**：必须先完成 A1（否则 L2/L3 掩盖症状）。
- **L2 告警语义**：`lifecycle-manager.ts:116-127` 告警文本只含新增 id（`trulyLeaked.filter(id => !warnedKeys.has(id))`），不再整组重报；`:112` 泄漏集合短暂清空时不要重置 `warnedKeys`（保留或带 TTL 记忆），避免「消失又出现」全量重报。
- **L3 渲染兜底**：`chat-stream.ts:170-188` `_addNoticeMessage` 加同文本时间窗去重（如 10 分钟内同文本不重复追加）；`runtime-adapter.ts:137-143` `pushAlert` 的 id 从 `Date.now()` 改为内容哈希，让 store 替换而非追加。
- **验收**：泄漏集合 {A,B}→{B,C} 只报 C；同文本 notice 时间窗内不刷屏。

### A6. DiscoveryBoard 会话级硬隔离 + 事件驱动清理

- **位置**：`src-ui/src/agent/runtime/runtime.ts:146,159-166`（板为 Runtime 级单例，`:312` 注入每个新建 Agent，`:192` 暴露给 UI 面板 `agent-panel-store.ts:96`）、`src-ui/src/agent/discovery-board.ts`、`src-ui/src/agent/tools/discovery.ts:42-85`；联动点 `coordinator.ts:140-159`（finish 回调）、`ui/chat-session.ts:274`（新建会话）
- **根因（两层）**：
  1. **跨会话零隔离（更严重）**：板是 Runtime 级单例 + 全局持久化（`.hologram/discoveries.json`），一个工作区所有会话、所有子 Agent 共享一板——并行会话互相串发现**今天就在发生**。条目不带来源凭证，模型无法分辨外来发现，会按错误前提（不同任务、不同文件状态、不同 worktree）行动。
  2. **会话内无生命周期**：同 key 重复 publish 不覆盖，24h TTL 按墙钟清理两头都错（会话内累积挡不住、跨会话垃圾照收），`restore()` 全量恢复 → 40+ 条、同主题 3 版本并存。
- **设计**：
  1. **会话级硬隔离**：板实例按 sessionId 划分（每会话一板）；子 Agent 继承父会话的板（会话内共享是板的本职）；`agent_discover`/`agent_lookup` 只路由到当前会话的板；**不提供任何跨会话查询 API**——包括 `includeArchived` 也不可越会话。UI 面板（`agent-panel-store.ts:96`）改为读当前会话的板。
  2. **TaskBoard 同病同治**：同为 Runtime 级单例（`runtime.ts:159`），同一架构病，一并按 sessionId 隔离。
  3. **会话内状态机**：active（生产者在跑）→ archived（coordinator `finish` 回调标记；默认 lookup 不返回、不再注入；会话内 `includeArchived` 可查）→ deleted（会话结束时物理删除）。同 agentId + 同 key 覆盖，从源头消灭重复版本。
  4. **持久化按会话分片**：`.hologram/discoveries/{sessionId}.json`，仅用于对应会话的崩溃恢复；会话删除时删文件；废弃全局 `discoveries.json`（启动时一次性清理/迁移）。
  5. **跨会话长期知识走 memory 系统**，不走发现板。
  6. **TTL 降为兜底**：24h → 2h，只防崩溃残留/orphan。`agent_lookup` 加 `since`、`limit`（默认 20）参数，均只在会话内生效。
- **验收**：并行两会话各发发现，互相 lookup 不可见（无任何 API 可达）；会话删除后其板文件被删除；同会话崩溃恢复数据完整；同 key 不累积；子 Agent 完成后其发现默认不出现在 lookup。
- **回归**：discovery/task 相关测试 + 新增会话隔离用例（并行双会话交叉查询必须为空）。

---

## 批次 B：安全（全部经代码确认）

### B1. SSRF 重定向不重检 + ipv6-mapped-ipv4 绕过

- **位置**：`src-tauri/src/commands/web.rs:166-177`（只对初始 host 查一次 `is_private_ip`，ureq 默认跟随 30x）、`src-tauri/src/utils.rs:936-940`（V6 分支未调 `to_ipv4_mapped()`）
- **修复**：ureq 禁用自动重定向、每次 30x 对新 Location 重跑 `is_private_ip`；`is_private_ip` V6 分支对 ipv6-mapped 地址转换后递归检查。
- **验收**：302 跳转 `127.0.0.1` 被拒；`::ffff:127.0.0.1` / `::ffff:10.x` 被拒；均有测试。
- **回归**：`src-tauri` cargo test web。

### B2. bash 混淆绕过

- **位置**：`src-tauri/src/permissions/bash.rs:336-348`（`expand_cmd_vars` 只展开 `%VAR%`）、`:583-608`（管道解码检测要求 `segments.len() >= 3`）
- **修复**：支持 `$VAR`/`${VAR}` 展开后复检；评估把解码+执行检测放宽到 2 段管道（如 `base64 -d f | sh`），注意控制误报。
- **验收**：`echo $CMD | sh`、`base64 -d f | sh` 触发 Ask/Deny；新增测试。

### B3. rpc.rs:464 `allow` 静默默认 false

- **位置**：`src-tauri/src/rpc.rs:464`（及同分支 `remember`/`rule_to_add`/`rule_behavior` 的静默吞参）
- **修复**：`allow` 缺失或非 bool 时返回明确错误并记日志，不静默默认；同分支其他参数同样校验。
- **验收**：缺参/错参调用返回可读错误；前端拼写错误立即可见（配合 `main.ts:463/474/487/501` 四处调用点核对参数名）。

### B4. 压缩时序 bumpVersion 缺口

- **位置**：`src-ui/src/agent/agent.ts:824` 与 `:829`（goal 暂停路径 `this.session = this.session.slice(...)` 未 `bumpVersion`）
- **根因**：在途自动压缩的版本检查（`agent.ts:1695`）因此失效，会用压缩结果覆盖已裁剪的会话。
- **修复**：两处替换后补 `bumpVersion()`；全文件排查其他 session 替换点是否同样遗漏。
- **验收**：goal 暂停 + 在途压缩竞态的测试通过。

### B5. rule.rs glob `**` 越界

- **位置**：`src-tauri/src/permissions/rule.rs:344-345`（`**` 后无 `/` 输出 `.*` 跨分隔符）、`:318-319`（未锚定 `is_match`）
- **修复**：按标准 glob 语义处理 `**`；匹配改锚定全串匹配。
- **验收**：`foo**bar` 不跨目录匹配；权限规则测试全绿。

---

## 批次 C：Routes 一行/小修复（性价比最高）

> 全部位于 `engine/src/analysis/framework_routes/`。改完跑 `cd engine && cargo test --lib`。

### C1. framework 属性硬编码

- **位置**：`mod.rs:297`（`if file.ends_with(".py") { "django" } else { "express" }`）
- **修复**：`DetectedRoute` 元组增加 framework 字段，各检测器填自己的名字，`inject_routes` 用该字段。**注意**：动结构体影响全部 19 个检测器调用点与测试，务必一个 commit 完成。

### C2. cross_file 硬编码

- **位置**：`mod.rs:312`；`find_handler_node`（`:328`）的 `_current_file` 参数未使用
- **修复**：比较匹配到的 handler 节点文件与路由所在文件，如实填写 `cross_file`。

### C3. Express handler 取中间件

- **位置**：`frameworks/express.rs:93-96`（取路由字符串后第一个非标点参数）
- **修复**：取最后一个参数作为 handler；同步更新文件头注释（`:19` 自称支持 middleware 模式但实现不符）。

### C4. ASP.NET handler 提取

- **位置**：`frameworks/aspnet.rs:34`（`split_whitespace().nth(1)` 取到的是返回类型）
- **修复**：正确解析方法签名取方法名。

---

## 批次 D：Routes 结构性（可后延，与 E 并行）

- **D1. Spring 类级前缀合并**：`spring.rs:41,105-111` —— 类级 `@RequestMapping` 前缀与方法级路径合并为一条路由。
- **D2. Phoenix scope 前缀**：`phoenix.rs:23` —— 维护 scope 前缀状态；同步加强测试断言（现测试只查 `len >= 2`，`mod.rs:840-856`）。
- **D3. Django include()**：`django.rs:35,127-130` —— 识别 `include()`，不把它当 handler；嵌套 urlconf 前缀传播（可限定单级）。
- **D4. DRF register() CRUD 展开**：`django.rs:92-93` —— 展开为 list/create/retrieve/update/partial_update/destroy。
- **D5. 6 框架补测试**：ASP.NET、Sinatra、Fiber、Fastify、Slim、Rocket（`mod.rs:373-908` 测试模块只覆盖 12 个）。
- **D6. Flask/FastAPI 过滤器**（低优先）：`flask.rs:9`、`fastapi.rs:10` 对所有 .py 返回 true；`mod.rs:111/116` 的内容门槛已挡住 AST 解析开销，仅加文件数日志即可。
- **D7. Express/Koa/Fastify 检测重叠**：`mod.rs:107` 的 if-else 链中 Express 分支排在 koa（`:144`）、fastify（`:188`）之前，且 `express.rs:8-14` 无源码内容门槛 → Koa/Fastify 文件被误判为 Express。修复：给 Express 分支加内容门槛（如 require/import express 特征），或按内容特征强度重排分支顺序。

---

## 批次 E：质量债

- **E1. bash.rs 补 7 类攻击测试**：DeviceWrite、bash eval/exec、ReverseShell、GitForcePushDefault、wget 下载执行、PS `IWR|iex` 管道、PS `FromBase64String`（对照 `bash.rs:100-130`、`:296-309`；现有 33 个测试）。
- **E2. permissions/git.rs、permissions/web.rs 补测试**（现各 2 个）。
- **E3. RPC 一致性**：参数命名统一（`filesystem.rs:12/56/245` path/file_path/from-to 混用）；返回值包装统一（`rpc.rs` 现混 ok_json/ok_unit/裸 Result/手写 4 种）。注意兼容前端调用点，改名需同步 `src-ui`。
- **E4. 死代码清理**：删 `commands/mod.rs:19` 的 `pub mod tools;` 与空文件 `commands/tools.rs`（其注释提到的 MCP_MANAGER/UNITY_MANAGER 已迁至 `commands/external.rs:13,105`）；顺手删唯一真死函数 `hologram_workspace_conflict`（`commands/hologram.rs:144-145`，自带 `#[allow(dead_code)]` 且未接线）。
- **E5. CompactionTracker 持久化**：`compaction-model.ts:241-248` 全部字段为内存 Set/数组，重启即丢；现仅调优产物经 `compaction-config.json` 持久化（`agent.ts:373-375`）。把关键 events/filesRead 一并落盘（可复用 compaction-config.json 或独立文件），避免重启后压缩调优从零开始。
- **E6. Board flush 崩溃兜底**：DiscoveryBoard/TaskBoard 为 2s debounce flush（`discovery-board.ts:89-96`、`task-board.ts:110-117`），崩溃时窗口内数据丢失；`main.ts:790` 的 beforeunload 只备 chat session。修复：beforeunload（及 workspace dispose）钩子里对两个 Board 做同步 flush。注意与 A6 的按会话分片持久化协同（flush 写各自会话文件）。

---

## 明确不修（复核驳回 / 有意设计）

| 审计断言 | 复核结论 |
|---|---|
| credential.rs 零测试 | 实际 9 个测试（`credential.rs:492-671`），审计基于旧版 447 行文件 |
| macOS clear_credentials 硬编码 | 主路径 dump-keychain 动态枚举（`:88,124`），硬编码仅 fallback |
| Linux silent null | 实际返回 `Err`（`:443-446`） |
| safety 大小写绕过 | 已 `eq_ignore_ascii_case`（`safety.rs:168` + 测试） |
| /proc 泄露 5 路径 | 已阻止 8 个（`safety.rs:284-318`） |
| PhysicalDrive 裸设备 | 已阻止（`safety.rs:214-230`） |
| 缺 .aws/.npmrc/.docker | 已覆盖（`safety.rs:137,149-155`） |
| main.ts suggestions[0] 无检查 | 已有 `length > 0` + 可选链（`main.ts:491-492`） |
| worktree 警告「每次 runLoop 注入」 | 机制描述不准；真实根因已列 A1/A5 |
| 4 个只读 Git 命令缺 is_agent | 有意设计（`git_cmds.rs:392/422/437/452` 走 `require_read` 只读路径） |
| 4 个框架行解析（实为 5 个，含 Phoenix） | 事实属实但非缺陷：行解析对这些框架的路由语法已够用，迁 tree-sitter 是增强不是修复，可随新框架支持另行立项 |
| 缺失框架（Next.js/Hono/Axum/Echo/Chi/SvelteKit） | 新功能需求，不属于本次修复范围，另行立项 |
| 103 个未注册的 `#[tauri::command]` | 刻意设计：函数被 `rpc.rs` match 分发直接调用（ponytail 单命令模式，`rpc.rs:8-10`），冗余的只是宏 glue；唯一真死函数已列 E4 |

---

## 执行顺序与依赖

```
批次 A（框架） → 批次 B（安全） → 批次 C（Routes 小修） → 批次 D/E（并行，按需）
A1 → A5（A5 依赖 A1）   A2 ↔ A4（同批交付）   C1 单 commit
```

每批次完成的定义：该批次所有条目验收标准通过 + 三端测试命令全绿 + 过时注释已同步。
