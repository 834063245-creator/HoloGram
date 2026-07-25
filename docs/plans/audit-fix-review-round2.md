# 审查报告 R2：返工提交 1768d4b / 639049e / dc7ea6b / 8a6ee32

> 审查：2026-07-25 · 方法：3 个审查 Agent 逐项核对 + 三端测试复跑
> 结论：**主路径修复基本到位，但仍不能判竣工**。返工引入 1 个真实功能回归（跨 Agent 消息恢复）、3 个边界新 bug，测试义务继续零履行，垃圾文件删除被两次虚报。
> 防伪：本文件为审查方命名空间，执行方自评请写别的文件。

## 一、三端测试复跑

| 端 | 结果 | 说明 |
|---|---|---|
| engine `cargo test --lib` | ✅ 481/481 | 全绿 |
| src-ui `tsc + npm test` | ✅ 625/625 | 全绿 |
| src-tauri `cargo test` | ✅ 169/169（单元） | 10 个失败仍为初审已确认的 stale 集成测试（`hologram_dispatch_test.rs`，与引擎降级响应设计矛盾，非本次引入，另行立项） |

## 二、高危验证（1768d4b）

| # | 判定 | 说明 |
|---|---|---|
| 高危1 A2 id 错配 | ⚠️ 主路径✅ 排队路径❌ | 池未满时 `sub-...` → alias → `pool.stop` 走通（`subagent.ts:106`、`coordinator.ts:268`）。但池满排队路径：alias 映射到占位 id（`coordinator.ts:196`），`_drainQueue` 后真实 Agent 以新内部 id 运行（`:229`）→ 排队后启动的子 Agent **kill 报不存在、发现永不归档**（连累高危3）。另 `_aliasToInternal` 只增不减（轻微泄漏） |
| 高危2 A6 接线 | ⚠️ 三钩子✅ 两缺口 | switchSession/createNewSession/closeSession 真实接入（`chat-session.ts:240-268`），删会话真删板文件。缺口：① `createAgent` 仍不传 sessionId（`workspace.ts:646`），初始会话落 `'default'` 板，历史成孤儿；② **关闭当前活跃会话不 retarget proxy**（`chat-session.ts:264-277`）→ 主 Agent 写僵尸板，下次 flush 会把刚删的板文件复活（`task-board.ts:76-89`） |
| 高危3 archive 错配 | ✅（排队路径除外） | 子 Agent 用自己的 `sub-...` id 发布与归档（`agent.ts:1954-1960`、`discovery-board.ts:140-149`），同 key 互覆盖消失 |
| 高危4 discard 假清理 | ⚠️ 净结果对，新代码空转 | 新加的 `isolationExec('agent_isolation_discard')` 传 `sub-...`，但 worktree 注册键是 `agent-...`（`agent.ts:1929`）→ **必返 Err，是 no-op，还向模型谎报「清理失败」**。实际清理由 kill 触发的 abort 收尾路径完成（`agent.ts:2173-2179`），LifecycleManager 豁免成立（stopped 不触发告警） |
| 高危5 权限约束 | ✅ | 子 Agent 注销 `agent_kill`（`agent.ts:1949`），allowlist 也救不回；无其他杀兄弟途径 |

## 三、中危 + 静默略过验证（1768d4b + 639049e）

| # | 判定 | 说明 |
|---|---|---|
| web.rs 重定向 | ✅ | `current_url` 跟踪正确（`web.rs:209-236`），SSRF 每跳重检保留。无测试 |
| search.rs 截断 | ✅ | 早退设 `truncated_by_budget`（`search.rs:188-191`），三模式输出均带标记。无测试 |
| phoenix 根 scope | ✅ | `scope "/"` 不再产 `//users`（`phoenix.rs:95-104`）。无根 scope 回归测试 |
| django 前缀 | ⚠️ | `strip_py_string_prefix` 修复 ✅；**detail URL 尾斜杠仍未修**（`django.rs:190` 无尾斜杠，错误断言 `mod.rs:1061` 原样保留） |
| koa 门槛 | ✅ | Express 拆分文件不再误标 koa；边缘变体（`require( 'koa' )` 带空格）漏报不碍事 |
| bash `$CMD` | ⚠️ | `echo $CMD\|sh` 抓得住 ✅；**新误报**：`sh build.sh \| tail` 等良性管道被 Ask（`bash.rs:654-674` 检测任意段而非末尾段）；**单引号跳过空转**：tokenizer 已剥引号（`:165-166`），掩码段是死代码（`:371-386`），`echo '$HOME/x'` 仍被展开 |
| rpc.rs 校验 | ✅ | remember/rule_to_add/rule_behavior 校验 + behavior 白名单落实，前端 4 调用点兼容 |
| rule.rs 边界 | ⚠️ | `src/**` 挡 `mysrc/x` ✅；**新漏报**：`find` 只验最左匹配，`mysrc/src/x` 被误拒（`rule.rs:322-324`） |
| utils.rs 三件套 | ⚠️❌ | 4 层深度 ✅；截断标注❌（`truncated` 置位后无人读取，`utils.rs:899-903`）；**is_ignored_path 复用引入功能回归**——见下节 R1 |

## 四、返工引入的新问题（按严重度）

- **R1【高】跨 Agent 消息恢复被打断**：`list_dir_recursive` 切到 engine `is_ignored_path` 后，`IGNORED_DIRS` 含 `.hologram`/`tests` 等 → `JsonMessageStore.restore()`（`message-store.ts:67-73`）列 `.hologram/agents` 恢复各 Agent inbox 时子目录全被过滤 → **重启后跨 Agent 消息静默丢失**（`message-bus.ts:479` 是活代码）；附带 Agent 的 `list_directory` 工具看不到任何 `tests/` 目录。修法：inbox 恢复走不过滤的 list 路径，或过滤只对 Agent 工具入口生效。
- **R2【中】bash 任意段 shell 误报**：`sh xxx | 任意命令` 良性管道触发 Ask（`bash.rs:654-674`），文案谎称「管道末尾为 shell 执行」。应只检测末尾段。
- **R3【中】rule.rs 只验最左匹配**：`mysrc/src/x` 被 `src/**` 误拒。应对每个候选匹配位置做边界检查而非首个。
- **R4【中】kill 的 discard 谎报**：`subagent.ts:169-176` 用错 id 命名空间必空转且报「清理失败」。建议从 board 条目取 isolationId 或删除该调用（实际清理已由 abort 路径兜底）。
- **R5【中】排队路径 alias 失效**：见高危1。
- **R6【中】关活跃会话留僵尸板**：见高危2缺口②。
- **R7【中】A3.4 归因基本不生效**：注入的是 `_isolationId`（`agent.ts:1071`），仅「fork 模式 + 隔离创建成功」的子 Agent 才带 id；主 Agent 从不 set thread_local 且 set 与读跨 `.await` → 主 Agent 的 Ask 可能读到陈旧子 id 被误标 + 错吃 60s；`web.rs` 命令未接；标注的 `agent-<ts>` 与 UI 的 `sub-...` 不同名。
- **R8【低】A3.4/E6 均为「UI 层对、底层只对最优路径生效」**：E6 调用点正确但 flush 仍 fire-and-forget（`runtime.ts:577-588`），`forceClearState` 兜底路径（`workspace.ts:458-472`）不 flush 仍丢数据。

## 五、遗留项（初审清单中四个 commit 未认领部分——全部仍欠，无一被顺手做掉）

- D3 嵌套 urlconf 前缀传播（`django.rs:104` 仅 return None）
- E3 RPC 参数命名统一（`filesystem.rs` path/file_path/from-to 仍混用）
- **测试义务全部仍欠**：A2 kill、A4 abort、A6 双会话隔离、B1 302/::ffff、B2 两验收用例、B3 错参、C3/C4 handler 断言、A3 预算路径——四个返工 commit **零新增测试**
- AGENTS.md 未同步（A2 工具集 + `.hologram/` 新目录结构）
- 低危 11 项全部仍在（discovery limit 先于 key 过滤、notice 跨会话抑制、proxy 跨会话污染、restore 竞态、deserializeState 重复加载、current_file unused、is_cross_file drive-letter、aspnet 同行边缘、django include 别名、WebFetch 空洞断言、initial 会话 default 板孤儿）
- **垃圾文件仍在**（git index + 磁盘），且 1768d4b 与 639049e 的 commit message **两次虚报已删除**——执行方 commit message 不可信，后续验收只认 diff 不认 message

## 六、返工 R3 建议顺序

1. R1（inbox 恢复回归）——功能回退，最优先
2. R5 + R6（排队路径 id、关活跃会话僵尸板）——A2/A6 的最后一块
3. R2 + R3（bash 误报、rule 漏报）+ django 尾斜杠及错误断言
4. R4（discard 谎报）+ R7/R8（A3.4 归因改传真 sub id、E6 同步化或如实降级文案）
5. 测试义务补齐（本次必须真写，验收以 tests 目录 diff 为准）
6. 低危 11 项 + AGENTS.md + 真删垃圾文件（`git rm` 后 `git ls-files` 验证）
7. 另行立项：stale 集成测试 `hologram_dispatch_test.rs` 与引擎降级响应设计的矛盾
