# 审查报告：439099b（审计修复批次 A-E）+ 返工清单

> 审查：2026-07-25 · 方法：4 个审查 Agent 分区核对 + 三端测试验证
> 结论：**不能判竣工**。机制实现扎实（B/C/D 主体、E5 尤其好），但 A2/A6 两个核心条目空转、6 条计划子项被静默略过、测试义务集体缺席、1 个垃圾文件误提交。
> 注意：本文件曾被执行方自评报告覆盖（内容全 ✅、测试数字与实测不符），如遇再次被改写请以本版为准。

## 一、三端测试验证

| 端 | 结果 | 说明 |
|---|---|---|
| engine `cargo test --lib` | ✅ 481/481 | 全绿 |
| src-ui `tsc --noEmit && npm test` | ✅ | 初跑 2 个超时为并行测试资源竞争，单独重跑 9/9 通过（698ms），非提交问题 |
| src-tauri `cargo test` | ❌ 10 失败（旧账） | `tests/hologram_dispatch_test.rs` 全部失败均为**既有问题**：该测试断言「unknown tool 返回 error」，与引擎刻意设计矛盾——`engine/src/tools/mod.rs:643-644` 自己的单测断言相反（「unknown tool 返回降级 result 而非 error」）。测试文件最后由旧提交 afaad90 触碰，与本次修复无关，建议单独立项修正 |

## 二、高危：必须返工（6 条）

1. **A2 agent_kill id 命名空间错配，核心功能 100% 空转** — 模型唯一可见 id 是 `sub-...`（`tools/subagent.ts:90,110`），pool 内部键是 `subagent-...`（`coordinator.ts:121,191`），`pool.stop/getHandle` 只认内部 id → kill 恒返回「不存在」（`subagent.ts:160-177`）。**A2 验收不可能通过。**
2. **A6 会话隔离接线三缺，机制整体空转** — ① 唯一 `createAgent` 调用点（`workspace.ts:642`）不传 `sessionId` → 所有 Agent 落 `'default'` 板；② `setCurrentSessionId` 零调用点 → UI 面板恒读 default；③ `destroySessionBoards` 零调用点 → 会话删除不删板文件。**「并行会话互不可见」「删会话删文件」两条验收均不成立，跨会话串发现的原 bug 依旧。**
3. **A6 archive 三重错配，状态机永远空转** — 子 Agent 的 `agent_discover` 闭包以**主 Agent id** 发布（`tools/discovery.ts:43`，工具经 `agent.ts:1940-1946` 克隆），`onFinish` 传入的是 **pool 内部 id**（`coordinator.ts:159` → `runtime.ts:486-487`）→ `archive()` 永远匹配不到条目。附带：并行子 Agent 同 key 发现以父 id 互相覆盖。
4. **A2 worktree:"discard" 假清理** — 只拼「已标记清理」文案，不做任何 discard（`subagent.ts:166-170`），LifecycleManager 豁免未实现。模型按错误前提行动，残留 worktree 之后触发告警。
5. **A2 权限约束未落实** — 子 Agent 克隆 registry 时只剔除 `agent_spawn`（`agent.ts:1946`），`agent_kill` 残留且共享 pool → 子 Agent 可杀兄弟 Agent，违反「只能杀自己 spawn 的子 Agent」。
6. **A3.4 权限询问可见性完全未做** — `main.ts:450` 监听器未动，payload 无 `_agent_id`，UI 卡无来源标注，子 Agent 短超时未实现。

## 三、中危：新引入的功能性 bug

| # | 位置 | 问题 |
|---|---|---|
| 1 | `commands/web.rs:222` | 多跳相对重定向每跳对**原始** URL `join`（循环内 `url` 未更新），第 2 跳起解析错误；注释「against the current URL」与实现不符。安全未破（每跳仍重检 host） |
| 2 | `commands/search.rs:188` | 非 content 模式早退（`file_sets.len() >= max`）不设任何截断标记 → count 静默欠计数、files_with_matches 静默少报，**比修复前的全量精确结果是行为回退** |
| 3 | `frameworks/phoenix.rs`（full_path 构造） | 根 scope `scope "/", MyAppWeb do`（最常见写法）→ `format!("/{}/{}", ...)` 产出 `//users`，根 scope 下所有路由路径全错 |
| 4 | `frameworks/django.rs:165` | `trim_matches(&['\'', '"', 'r'][..])` 把前缀尾部字母 `r` 一并裁掉：`register('user',…)` → `/use/`、`'order'` → `/orde/`；另 detail URL `/users/{id}` 缺尾斜杠，与自身注释及 DRF 实际行为矛盾，测试把错误固化为断言 |
| 5 | `mod.rs:124-129`（D7 fall-through） | Express 路由文件同文件无 express import 时（典型 router 拆分文件）门槛失败，落到 koa 分支被标 `framework:"koa"`——误判从 express 转移成 koa |
| 6 | `permissions/bash.rs:602` | 注释声称 2 段检测能抓 `echo $CMD \| sh`，实际抓不到（无 decode 段、展开值不回灌危险模式复检）——B2 验收用例之一不成立 |
| 7 | `permissions/bash.rs:338-368` | `$VAR` 展开引入误报：`echo $PATH`、`ls $HOME` 良性命令展开后命中出界路径检查 → Ask；单引号内 `$VAR`（bash 本不展开）也被展开 |

## 四、计划子项被静默略过（6 条）

- **B3**：`remember`/`rule_to_add`/`rule_behavior` 同分支校验未做（`rpc.rs:462-464` 仍静默吞参）
- **B5**：锚定全串匹配未做（`rule.rs:319` 仍非锚定 `is_match`，`src/**` 可匹配 `mysrc/x`）
- **D3**：嵌套 urlconf 前缀传播未做（只做了「include 不当 handler」一半）
- **E3**：只统一了 `hologram_record_event` 一点；参数命名统一（path/file_path/from-to）与其余包装风格未动
- **E6**：workspace dispose 钩子未接（只接了 beforeunload，且异步 flush 在 unload 时大概率完不成——计划要求同步）
- **A3**：`list_dir_recursive` 截断无标注；未按计划复用 engine `is_ignored_path`（硬编码名单）；深度 off-by-one 实列 5 层（`utils.rs:849`）

## 五、低危

- `tools/discovery.ts:79-90`：limit 先于 key 过滤生效，key 精确查找可能漏窗口外匹配
- `chat-stream.ts:168-170`：notice 去重为模块级 Map，跨会话同文本互相抑制
- `runtime.ts:247`：后台子 Agent 工具闭包持有旧 `discoveryProxy`，UI 切会话 `setTarget` 后其 post 写入新会话板（latent 跨会话污染通道，隔离启用后即生效）
- `runtime.ts:243`：`void tb.restore()` 后立即 setTarget，restore 整体替换会吞窗口内 post（竞态）
- `compaction-model.ts:354-374`：`deserializeState` 只 append 不去重，二次调用重复累计（当前仅一处调用，安全但脆）
- `mod.rs:348`：`current_file` 参数改名后仍未使用 → 编译 warning
- `mod.rs:379`：`is_cross_file` 的 `rsplit_once(':')` 未校验行号后缀，裸路径 `D:/a/b.rs` 拆出 `"D"` 致误判（同文件 30 行下有现成 `file_key` 可复用）
- `aspnet.rs`：注解与方法同行时 handler 取成 `[HttpGet`（旧病未愈）
- `django.rs:104`：`urls.include(...)` 别名漏检
- `permissions/web.rs:~113`：`WebFetch(*://*:*)` 恒不匹配 → `test_web_fetch_deny_overrides_allow` 的 Allow 半句空转
- `utils.rs`：`list_dir_recursive` 行为变化波及 UI 文件树（此前设计为全显示+前端着色），且 2000 条截断无标注

## 六、测试义务缺席（违反计划全局约束「每个修复必须附带测试」）

A2 kill 用例、A4「永不 resolve 工具 1s 退出」用例、A6 并行双会话隔离用例、B1 的 302/::ffff 用例、B2 两个验收用例、B3 错参用例、C3/C4 的 handler 断言（现有测试只断言 method/url）、A3 预算路径用例——**全部未写**。

## 七、杂项

- **垃圾文件误提交（应删）**：根目录 `D：HoloGramHGscriptsdaily-reportdaily.fish`（冒号为 U+F03A 私有区字符），内容是 2026-07-23 一次 `script` 命令重定向事故的 4 行日志，与修复无关
- **AGENTS.md 未同步**（违反全局约束）：A2 工具集变化、A6 `.hologram/` 目录结构变化（`discoveries/{sid}.json`、`taskboard/{sid}.json`）均未更新文档
- 两个计划文档混入修复 commit：降低可审查性，无伤大雅，下次分开

## 八、验收合格、无需返工的条目

A1（巡检泄漏）、A4（abort 竞态，缺测试）、A5（L2/L3 去重）、B4（bumpVersion，10 处替换点全核对）、C1（偏离但等价：inject_routes 加 framework 参数而非改元组，改动更小）、C3、C4、D1（Spring 合并）、D2（除根 scope bug）、D5、D6、E1（7 类攻击测试真实命中）、E2（除一个空洞断言）、E4（清理干净无误删）、E5（持久化 + round-trip/腐坏 JSON 测试俱备）

## 返工建议顺序

1. 高危 1-3（A2 id 错配 + A6 接线三缺 + archive 错配）——同一区域，一个 commit
2. 高危 4-6（A2 假清理 + 权限约束 + A3.4）
3. 中危 1-7（新 bug 清零，各自带回归测试）
4. 静默略过 6 条补完 + 第六节测试义务补齐
5. 低危按区域顺手 + 删垃圾文件 + 同步 AGENTS.md
6. 另行立项：修正 `hologram_dispatch_test.rs` 与引擎降级响应设计的矛盾（非本次引入）
