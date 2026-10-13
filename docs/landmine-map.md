# 兰台雷区地图（技术债清单）

> 生成：2026-08-08 · 三路只读审计（前端接缝 / Rust 后端接缝 / 横切面）汇总
> 收录标准：有真实引爆路径。风格问题不收录。
> 拆除成本：S = 1 小时内 · M = 1 天内 · L = 更大

## 背景：雷的家族谱

2026-08-08 凭据毒化事故（256MB IPC 响应击毁 WebView2）教会我们识别雷的指纹：
**接缝处靠人肉纪律维持正确性 + 失败被静默吞掉 + 单测全绿**。以下条目按此指纹排查得出。

---

## P0 — 爆炸半径大且拆除便宜（建议第一批）

| # | 位置 | 雷 | 触发 → 后果 | 护栏 | 成本 |
|---|------|----|------------|------|------|
| 1 | `src-tauri/src/commands/engine_dispatch.rs:9-46` | `hologram_call` 同步内联调度占 tokio worker | Agent 每次引擎工具调用（大图上秒级）直接占住 async worker；并发调用 + UI 轮询叠加 → 线程池耗尽，**全部 IPC 挂起（含权限弹窗）**。main.rs:198 的测试注释明知的病，此入口漏网 | ✅ 已拆（spawn_blocking + 饥饿回归测试） | S（包 spawn_blocking） |
| 2 | `commands/graph.rs:16`、`hologram.rs:16`、`filesystem.rs:80`（read_file_base64）、`git_cmds.rs:65/78/265`、`isolation.rs:60` | **大响应无尺寸上限**——与 256MB 事故同一物理通道 | 大仓库图 JSON / 99MiB 文件 base64（~200MB 转义后）/ minified 文件 diff → 复刻 WebView2 击毁。注：git 系列没有 exec_command 那样的 32KB 截断 | ✅ 已拆（truncate_output 提为共享 + git×3/isolation 截断 + base64 8MiB 上限 + 图 128MB 硬护栏 + 图分页落地：纯传输分页、边按 max(端点页) 增量下发、全量到齐原子换入后一次渲染） | S~M（截断/上限/分页） |
| 3 | `src-tauri/src/utils.rs:1361-1392` | `write_atomic` 的 .bak 残留死锁 | Windows rename 不覆盖：上次崩溃残留 .bak → 对该文件的**所有后续写入永久失败**，直到手工删 .bak | ✅ 已拆（rename 前先删旧 .bak + 回归测试） | S（rename 前先删旧 .bak） |
| 4 | `src-tauri/src/utils.rs:845` | `hologram_graph.json` 非原子写入 + `let _ =` 吞错 | 大图落盘（数百 MB 窗口长）中途崩溃 → 截断 JSON 被冷启动原样读回 → 解析失败，且无声 | ✅ 已拆（write_atomic + 失败 eprintln 告警） | S（换用现成 write_atomic） |
| 5 | `src-tauri/src/permissions/rule.rs:204` | `permissions.json` 非原子读-改-写 | 落盘时崩溃 → 加载端静默返回空规则 → **用户自定义 deny 规则全部丢失，安全 fail-open 无告警** | ✅ 已拆（write_atomic + 读/解析失败告警 + 损坏拒绝追加以免清空规则 + 测试×3） | S |
| 6 | `src-ui/src/agent/message-store.ts:80-83` | **读失败即删数据** | 启动 restore 时 `read_file_content` 因任何瞬时错误失败 → catch 里 delete inbox.json → 跨 Agent 未投递消息静默丢失 | ✅ 已拆（仅「不存在」才清理，读/解析失败保留 + warn；测试×3） | S（区分「不存在」与「读错误」） |
| 7 | `src-ui/src/settings.ts:164-168` × `SettingsPanel.tsx:296` | 凭据写失败 UI 报「已保存」 | DPAPI 写失败被两层 catch 吞掉 + 无条件 setSaved(true) → 重启后 key 消失，用户坚信已保存 | ✅ 已拆（persistSecrets 返回失败列表 + handleSave await 并据实 alert；测试×2） | S（失败列表上抛 + UI 据实提示） |
| 8 | `src-ui/src/ui/react/TimelineHUD.tsx:84-92` | **空时间轴无限 IPC 热循环**（唯一确定性风暴源） | 项目无 timeline 事件 → effect 依赖翻转 → 无退避无上限的 hologram_call 循环，速度=IPC 往返速度，永久轰击引擎 | ✅ 已拆（首次立即 + 2/4/6s 退避 ×3 后停止；组件级 fake-timers 回归测试） | S（尝试计数/退避） |
| 9 | `src-ui/src/settings.ts:134` × `ui/chat-session.ts:429` | localStorage 配额跨存储干扰 | 会话全量备份无界增长 → 配额耗尽 → saveSettings 的 setItem **无 try** 同步抛 → handleSave 在 persistSecrets 之前崩 → key 从未落凭据库 | ✅ 已拆（saveSettings try+warn 不中断；会话备份 >1MB 跳过 localStorage；配额回归测试） | S（上限 + try + 报错） |
| 10 | `src-ui/src/workspace.ts:622-626` | setupAgent 覆盖 runtime 不 dispose | 每次设置保存新建 AgentRuntime 直接覆盖，旧 runtime 的订阅/防抖 flush 定时器仍活着 → 泄漏 + **旧快照可能回写覆盖新看板** | ✅ 已拆（覆盖前 flushAllBoards + disposeAll，复用销毁路径同一顺序） | S（覆盖前 disposeAll） |
| 11 | `src-tauri/src/pty_manager.rs:85-99` | PTY 读取线程持全局锁阻塞 read | 终端无输出时 pty_kill/resize/write 全部拿不到锁 → PTY 子系统假死 | ✅ 已拆（reader 归读取线程独有 + 顺带根治潜伏 bug：ChildKiller drop 在 Windows 不杀进程，reap 显式 kill + 分离线程 drop；测试×2） | S（read 移出锁） |
| 12 | `graph.rs:24`、`filesystem.rs:103` 等 10 处 `state.lock().unwrap()` + `BG_JOBS.lock().unwrap()` 集群 | 锁中毒连锁 | 任一持锁点 panic → 整个 IPC 面 / 后台任务系统全部 panic 变砖。项目里已有 map_err 正确范式但未统一 | ✅ 已拆（lock_or_recover/read_or_recover/write_or_recover 三 helper：中毒恢复 + eprintln 告警；57 处 Mutex + 6 处 RwLock 全量替换；中毒回归测试） | S（统一 lock_or_err helper） |

## P1 — 第二批（中等半径或 M 成本）

| # | 位置 | 雷 | 成本 | 护栏 |
|---|------|----|------|------|
| 13 | `agent-store.ts:168-184` | index.json 读-改-写跨异步无锁，多 Agent 并发 saveState 互相覆盖；state/session/index 三文件可留下矛盾现场 | M（写链串行化，参照 BoardPersistence._writeChain） | ✅ 已拆（_indexChain 串行链：_upsertIndex/delete 的读-改-写包进链内，并发后写者在最新值上追加；测试×4） |
| 14 | `chat-session.ts:519-537` | localStorage 回退使已删会话「复活」——与 null 复活同构（删除只删了一个存储） | M（复活前要求磁盘文件存在） | ✅ 已拆（三处 localStorage 采纳前验磁盘文件存在且非 deleted；残留顺手清理；测试×3+1 既有改规格） |
| 15 | `agent.ts:792` + `agent-store.ts:93` | 每轮对话全量重写会话（O(全量) 写放大；聊天侧已有增量 NDJSON，agent 侧没有） | M | ✅ 已拆（agent_session_append NDJSON 增量 + 增量游标；撤回/替换时 rewrite 重建；load 兼容 NDJSON+旧 JSON；测试×6） |
| 16 | `commands/shell.rs:258-318` | exec_command 非流式路径 `try_wait`+sleep 忙等，最长占 worker 300s | S~M | ✅ 已拆（等待段抽 wait_child_blocking 移入 spawn_blocking；测试×3） |
| 17 | `utils.rs:305-325` | bash_wait 非 shared 分支**持 BG_JOBS 锁做阻塞管道读**；非 Windows 可继承管道 → 孙进程持写端 → 永久阻塞 → bash_* 全瘫（Windows 靠不可继承管道幸免） | M | ✅ 已拆（BgJob.shared 改必填字段，阻塞读分支从类型上删除；read_bg_output/wait_bg/kill_bg 三处只读 Arc；测试×2） |
| 18 | `commands/isolation.rs:8-164` | worktree 生命周期操作全部是阻塞进程等待内联在 worker 上 | S | ✅ 已拆（六命令改 &WorkspaceState 签名 + rpc.rs 全部 spawn_blocking；测试×2） |
| 19 | `external.rs:25-43` + `mcp_manager.rs:120` | MCP start 持锁最长 600s；此时 stop_mcp try_lock **静默跳过** → 旧 serve 进程残留 + 新 start 卡死 =「切换项目卡死」 | M | ✅ 已拆（start 拆 begin/finish 两阶段 + 纪元戳，长等待不持锁不占 worker；stop_mcp 改阻塞取锁；测试×3） |
| 20 | `lsp_manager.rs:87-92` | LSP 初始化失败/超时返回 Err 前不杀子进程，每次重试泄漏一个语言服务器 | S | ✅ 已拆（reap_failed_child kill+wait，含 stdout/stdin take 失败路径；测试×1） |
| 21 | `shell.rs:73` | 前台 exec_command 子进程不进 ledger；非 Windows 无 Job Object → 孤儿进程（平台盲区） | M | ✅ 已拆（register_fg_child 前台注册进 BG_JOBS，流式/非流式皆注册，完成/超时/被杀后移除；kill_all_bg 可终止前台命令；测试×2。⚠️ 平台盲区保留：非 Windows kill_tree 只杀直接子进程，进程组孤儿根治需 setsid） |
| 22 | `agent/board-persistence.ts:57-81` | _ensureDir 失败后照样 `_dirReady=true` → board 永不落盘且永不再试，重启全丢，零信号 | S | ✅ 已拆（后端 create_dir_all 幂等故任何抛错都是真实失败：不置位+下次重试+warn 信号；测试×2） |
| 23 | `src-tauri/src/audit.rs:34-45` | 审计日志写失败静默 → deny/审批不留痕，安全功能失效无法取证 | S（eprintln + 计数） | ✅ 已拆（eprintln 告警含丢失记录摘要 + AtomicU64 计数；测试×2） |
| 24 | `ui/FileTranslatorPanel.tsx:352` | read_file_content 缓存路径漏 stripLineNumbers → 翻译缓存 100% 不命中（已在坏，无声烧钱） | S | ✅ 已拆（stripLineNumbers + 顺带拆 computeStats 身份导致的 IPC 热循环；测试×1） |
| 25 | `ui/react/ChatFooter.tsx` × `settings.ts:saveSettings` × `events.ts:agent:config-changed` | **持久化函数兼职控制总线**：模式按钮靠 saveSettings 生效，但 Agent 重建链挂在独立槽 getOnSettingsSave——两条订阅通道并存，任何新增 saveSettings 调用点都可能漏重建链 | 规划按钮高亮但 Agent 不变只读（已真实引爆）；同类调用点会静默失效，单测全绿拦不住 | ✅ 已根治：`saveSettings` 回归纯持久化；设置面板/模型切换/模式按钮统一发 `agent:config-changed`，main.ts 单一监听 → `Workspace.applyAgentConfig` 决定是否重建（重建前先存会话）；权限模式不发事件 | S~M |
| 26 | `paper/canvas-math.ts` `layoutFlow` × `state/canvas-store.ts` `loadCanvas` × `PaperPanel.tsx` `adaptBlocks` | **NaN 布局级联**：流区宽脏（磁盘恢复透传无校验 / 运行态异常）→ 块宽 NaN → 测高 NaN → 布局游标被污染 → **坏块及其上方所有块 y 全 NaN** → 虚拟化二分失效、块消失、排版打碎（症状：「追加输入后来文消失 + 从坏点起全乱」，合卷重摊开自愈） | 偶发，触发源未 100% 锁定（运行态 NaN 来源存疑；磁盘侧已封） | ✅ 已拆（三层兜底：loadCanvas 恢复校验 width∈[720,2160]/anchor 有限数；adaptBlocks 宽兜底；layoutFlow h/w 兜底宁可压扁单块不级联全卷）。排查全档见 `docs/paper-stream-region-cascade-bug.md`（含取证手册——再复现先抓证据） | S |
| 27 | `plugins/builtin/paper-shell/use-paper-regions.ts`（regions memo 的 regionTop 段；拆解前 `PaperPanel.tsx`） | **哨兵值冒充数据**：`let top = 0; for (…) top = Math.min(top, g.y)`——0 是「无块」的初值，零块卷却把它当 regionTop 用 → **空卷纸面钉在世界原点**（`top = regionTop - folioH`），与锚点无关：新建卷摊开时纸画在别处，首句落墨才跳回锚点（用户症状「新建卷第一句话之前位置不对」）。同族：`let ex0 = Infinity` 那组靠 `!Number.isFinite` 兜底才没炸，而 `Math.min(0, …)` 恒有限数——**兜底检查查不出「合法但语义错」的哨兵** | 每个新建卷必现（200px 量级的视觉错位，不崩不报错，测试全绿） | ✅ 已拆（无 flow 块 → regionTop = anchorY − `EMPTY_REGION_CONTENT_H`（paper/space 单一真源），空卷也是一张贴在锚点上的纸；空卷 extent 兜底同源，测试钉 `top`/`height` 绝对值） | S |
| 28 | `composition/space-service.ts:expand` × `ui/chat-session.ts:loadSessionFromDisk`（原 `Promise<void>`） | **失败路径照样发后续请求**：`loadSessionFromDisk` 用 `Promise<void>` 抹掉了成败——卷已删/墓碑/坏档时它 toast 后 return，`expand` 却照旧 `requestFocus` → 失败卷永远不进摊开集，**定位请求永不兑现也永不自清**（只能靠用户平移/滚轮顺手清掉）；调用侧还各自再无条件补一次（同病灶三份） | 点已删卷（案头签条架「续写」签条来自磁盘列表；侧边栏合卷行）→ 视角不动且挂着一个永不兑现的请求；`Promise<void>` 的 void 是根因载体 | ✅ 已拆（`loadSessionFromDisk` → `Promise<boolean>`（true = 已在案头）；`expand` = 摊开+定位单一权威入口，成功才 requestFocus；调用侧三处无条件 requestFocus 删除；`onNew` 建卷失败不再飞上一个活跃卷）。同族纪律：**返回 void 的异步命令若下游还有依赖其成败的动作，void 就是在埋这个雷** | S |

## P2 — 存疑/低危（记录在案，暂不拆）

- `agent/goal-manager.ts:123,206`：parse 有 try 但无形状校验（:143 有正确示范没跟上）
- `message-bus.ts:158`：unregister 删 inbox 失败 → 死 agent 的 request 消息重启复活（消费路径未证实，存疑）
- `DataflowPanel.tsx:313-322`：typeof==='string'?parse:原样 的双重编码启发式残留
- 87 个死 `#[tauri::command]` 属性（未注册进 invoke_handler——实测 87，非原记 ~30；invoke_handler 只注册 `rpc::rpc` + `get_active_project`）——谁误注册谁把重活带上 UI 主线程；**留待专项核签**：函数可能用 `tauri::State`/`Window` 参数，删注解需逐个验签名（30+ 文件）
- `agent-identity.test.ts:62` 把「saveState 吞错不抛」**当规格断言固化**——拆 ① 类吞错时需先松绑测试

## 已确认健康（不要再动）

- 凭据/设置接缝：读写单一入口 + parseRpcString 集中 + 长度/null 四护栏（三轮事故修复后最健康的区域）
- 前端 95 处 JSON.parse 的 try 覆盖率很高——**解析层已吸取教训，写入层还没有**
- `write_atomic` 范式、`confined_fs` 100MiB/超时/spawn_blocking 三件套、shell 输出 32KB 截断——正确范式已建立，问题是覆盖不全

## 根治级（L，另立项目）

**rpc 返回值 Value 化**：`rpc` 命令返回 `serde_json::Value` 替代预序列化 String，删除前端全部启发式解析。一次拆掉整个「双重编码」bug 家族。
✅ **已拍板立项（2026-08-08）**——用户确认必须做，不再等「下次大动 IPC 层」的自然触发（该前提可能永不出现：新功能都是往 rpc 加 match 分支，不会大动通道）。
✅ **第一步已落地（2026-08-22，commit be8bba85）**：① Rust 出口 Value 化——rpc 命令返回 `Result<Value, String>`，commands 层零改动，出口 `str_to_value` **纯包装 Value::String、故意不 parse**；② 前端 `typedJsonRpc<T>`——typedRpc+parseJson 的组合收敛单函数，20 处调用点双重编码消灭；agentInvoke 直通 string，agent 工具链零改动。真机验证：CDP 实测 invoke 返回 string 形态字节精确。
🔶 **第二步已落地（2026-08-22，B 路线出口分派）**：Rust 出口建「命令→形态」分派表（rpc.rs `rpc_result_shape`，基于前端同源答案卷逐命令核对 Ok 路径）：**JsonValue 命令**（21 个：hologram_tools_list/analyze_and_load/get_graph_meta/engine_impact/git_status/git_log/list_directory/list_directory_flat/user_sessions_list/search_content/glob/web_search/shell_env/background_activity/credential_get/agent_isolation_create/status/diff/sandbox_status/plugin_install/lsp_request/desktop_status/desktop_audit）Ok 路径 parse 成真结构化 Value（parse 失败=违反「Ok 恒为合法 JSON」契约，转 Err 可见）；
   - **其余全部 Text** 字节精确直通（保守铁律：Text 误标 JsonValue 才是字节级破坏，反向只是慢路径）。动态形态命令一律 Text（hologram_call 元命令/get_graph_page 体积/dataflow_query 磁盘直通/drain_bg_notifications 空串/exec_command 双形态）。
   - 前端两入口配套：`typedJsonRpc` 双形态 shim（结构化透传 / 字符串 parse 慢路径——浏览器 mock 兼容）；`agentInvoke` 对结构化返回回卷 JSON 字符串（agent 工具链 string 世界零改动）。
   - 回归钉死：Rust `dispatch_result_to_value_shapes`（4 形态×Ok/Err）+ 前端 `tests/rpc-value-shapes.test.ts`（双形态 shim + 回卷链）。
   - 附带收益：契约注释漂移校正（git_diff 系实际是 git stdout 文本、sandbox_status/read_memory_batch 实际是 JSON）；gen 脚本 singleRe 起点限制在 match 之后（shape 表单行分支同形，曾被误列进契约表）。
   - **真机验证通过（2026-08-22 双轮）**：① CDP 直 invoke——JsonValue 命令（shell_env/get_graph_meta/list_directory/sandbox_status）返结构化 VALUE、Text 命令（read_file_content 带行号原文/llm_proxy_port）返字节精确 STRING、Err 路径人话报错照常 reject；② 用户填 key 真实会话——Agent 全工具链（文件/搜索/git 等）实测通过，回卷链无 [object Object]/双重编码症状。
✅ **第三步已竣工（2026-09-01 设计当日施工，commit ea1606b6 合入 main）**：边界 schema——`typedJsonRpc` 的 `JSON.parse(raw) as T` 盲转收进运行时形状校验（UI 全面审计批唯一挂起项，taste-ledger 2026-09-01；设计件 [`design/rpc-runtime-validation-design.md`](design/rpc-runtime-validation-design.md)——zod 同址表定案，初版「重载并存渐进收编」经用户质疑判死改一刀切）。落地：`rpcResultSchemas` 与 `RpcContract` 同址共治（`satisfies` 钉键拼写）+ 签名收紧 `M extends keyof typeof rpcResultSchemas`（未登记命令 = 编译错；泛型盲转 `typedJsonRpc<` 全库零残留，终态守卫钉死不回潮）+ parse 后 safeParse 违形即 throw（错误带方法名 + zod issue 摘要，宪法四）+ 三重守护 `tests/rpc-result-schemas.test.ts`（mock 同源自检 / schema 四态 / `typedJsonRpc<` 残留守卫）；§8 CDP 真机验收降维组件测试 `sessions-home-fault.test.tsx`（违形 → 首页显式报错态，绝不静默落「还没有工作区」空态）。批二长尾按设计无施工日——未来首个调用者被签名强制入表。R 批次演化（2026-09-05）：收编面 12→6 命令——list_directory/list_directory_flat/read_memory_batch 随 fs 域收口迁 fs_cap 助手内联 zod（dirEntryArraySchema）、shell_env/git_status 随 shell/git 域收口迁 process_cap/git_cap 文本路径（aura_init 更早已随 AURA 记忆系统拆除退役），校验面随命令迁移不消失。
📌 **前置已就位（2026-08-12，第二批）**：前端 138 处裸 `rpc` 调用已全量收敛到 `typedRpc`（rpc-contract.ts 单一入口，契约 result 一律 string，biome 禁令防新增）——届时 Value 化只需改 `typedRpc`/`rpc-contract.ts` 单点 + 收敛各调用点的 JSON.parse，不需要再全库扫调用面。

## 建议拆弹顺序

1. **第一批（P0 全部，~1 天）**：12 颗全是 S 级，每颗配回归测试，一次一颗小 commit ✅ 已完成
2. **第二批（P1 的 16/17/19/22/23，~1 天）**：阻塞持锁与吞错类 ✅ 已完成
3. **第三批（P1 剩余，按需）**：写放大与竞态类（13/14/15/21），需要设计，别赶工 ✅ 已完成（2026-08-08，cargo 226 · tsc 0 · vitest 798）
4. **第四批（已立项，待排期）**：rpc 返回值 Value 化（L 级，独立项目，见根治级段）——开工前先清 P2 双重编码残留热身

---

## 第二批审计（2026-08-17）— 工作区生命周期/状态管理家族

> 来源：四路并行只读审计（workspace 对称性 / 模块级状态 / 异步竞态 / 单例与会话资源），
> 触发点是 state-inject 缓存修复（commit `176f4873`）暴露的同族病。
> 家族指纹：**全局单例 + fire-and-forget 在途 + 工作区切换无代际/无清理**——
> 「工作区存活期」没有结构体，deactivate 靠人肉枚举清理对象，枚举必然漂移。

### P0 — 高危（有真实引爆路径）

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| H1 | `ui/lsp-client.ts:36` + `:47` | `diagnosticsCache` 永不清、无界、`stopAllLsp()` 不清；`getDiagnosticsForFile` 有 basename 尾匹配 | 旧项目诊断注入新项目 Agent 上下文（经 setDiagnosticsSource → state hooks）；同项目同名不同目录文件互串 | ✅ 已拆（Commit `f0f38731`：stopAllLsp 清 cache+warned、全路径精确比较、listen 幂等化） |
| H2 | `ui/file-viewer.tsx:47` + `lsp-client.ts:167` | 第二份私有 `lspSessions`（stopAllLsp 清不到）+ `startLsp` 在途 resolve 无代际 | 切换后 LSP 永久假死且状态栏显示已连接；在途 resolve 把 B 项目文件内容发进 A 的 tsserver | ✅ 已拆（Commit `ede255d1`：会话表单一事实源 `getLspSession` + startLsp epoch 防护） |
| H3 | `workspace.ts` `forceClearState()` | deactivate 超时走紧急路径时恰恰不调 `disposeAll()` | 60s 巡检 timer 永久存活，`_enforceTTL` 继续发 `agent_isolation_discard`（真实删 worktree）；saveState 不落盘留 'running' 死账 | ✅ 已拆（Commit `d4a800e6`：forceClearState 补 disposeAll+auraShutdown+resetAgentCaches） |
| H4 | `workspace.ts:898` `runCheck` | 在途 RPC resolve 后无 `_active` 守卫；finally 在清理后重新武装 checkTimer | 旧项目检查结果写进新项目 dock store + 自动弹面板；与新项目自身 runCheck 竞争 | ✅ 已拆（Commit `1926cf73`：runCheck/scheduleCheck/finally 三处 `_active` 守卫） |
| H5 | `ui/chat-session.ts:549`（冻结文件） | `autoRestoreLastSession` fire-and-forget 跨 await 不校验项目；`_autoSaveTimers` 捕获旧 projectPath | A 的会话列表覆盖 B 的面板（拿 B 的 factory 灌 A 的消息）；新会话可被写进旧项目目录 | ✅ 已拆（Commit `462b2ea1`：最小外科手术 — 三处 epoch 校验） |

### P1 — 中危

| # | 位置 | 雷 | 状态 |
|---|------|----|------|
| M1 | `ui/agent-panel-store.ts` + `workspace.ts:492` | `runtimeRef`/`currentSessionId`/`messageFlow`/`alerts` 切换不重置 → 2s 轮询拿旧会话 id 在新 runtime 建错位 board | ✅ 已拆（Commit `e4abde23`：bag 登记 setRuntime(null)+currentSessionId+清看板） |
| M2 | `agent/agent-session-state.ts:233` | 清理挂在下一个 setupAgent 而非 deactivate；setupAgent 失败路径死引用残留 | ✅ 已拆（Commit `e4abde23`：deactivate bag 内 clearPanelState(storeId)） |
| M3 | `agent/memory.ts:91` | `initAura` 在途晚于 deactivate 的 `auraShutdown` 落地 → 新项目语义召回静默禁用 | ✅ 已消解（先 Commit `e4abde23` epoch 校验；2026-09-02 AURA SDK 语义记忆系统整体拆除，initAura/auraShutdown 载体不复存在） |
| M4 | `ui/chat-store.ts:91` | `disposePanelStores` 零调用 → 每会话 messages store 只增不减，无界内存 | ✅ 已拆（2026-08-24：三死亡路径接线——合卷 closeSession 拆单卷（disposeSessionMessagesStore）；resetSessionState 全量重置与 setAgent(null) 拆整批（disposeMessagesStores 前缀清除，同时根治跨工作区撞号卷读到旧消息）；换卷不拆（摊开集内即时切换依赖内存态）；4 回归用例钉死 in tests/chat-session.test.ts M4 describe） |
| M5 | `app/chat/chat-core.ts:282` | 无 API key 时切换工作区，旧项目会话列表/消息面板原样残留 | ✅ 已拆（Commit `462b2ea1`：setAgent(null) 清会话列表+activeIdx） |
| M6 | `main.ts:250` `resetCheckPanelState` | deactivate 清完缓存后又回填人造「✅ 通过」进 checkCache → 未检过的项目注入假简报 | ✅ 已消解（2026-08-24 核实：`resetCheckPanelState` 随 V5 拆除 + C14 check 面退役全库零匹配；现行 `resetAgentCaches` 清空 checkCache、`setCheckResult` 仅喂真结果——人造✅注入点不存在） |

### P2 — 低危（记录在案，暂不拆）

- ~~`agent/runtime/agent-builder.ts:561`：`_snapshotRefreshTimer` 模块级单槽，切换后白打一轮引擎查询（写孤儿 ctx，无污染）~~ ✅ 已拆（Commit `e4abde23`：`cancelEngineSnapshotRefresh()` 导出并登记进 Workspace bag）
- `agent/logger.ts:23`：`initLogger` 未 await，交错时漏一个 2s interval
- `main.ts:302` vs `shell-store`：`_diffActive` 双份标志切换不重置，首次 toggleDiff 语义反转
- `lib/pretext/measurement.js:3,13`：测量缓存无界缓增（清理函数零调用）
- `agent/coordinator.ts:87`：SubAgentPool `_aliasToInternal` 只增不减（限单工作区寿命）
- `agent/agent.ts:2526`：FileOwnership 按会话主 Agent 各一份，并行会话子 Agent 互不知晓（Rust 临界区兜底，设计缝隙记录）
- `lsp-client.ts:165`：`lspWarned` 无清理（有界，仅告警提示）

### 本家族已确认健康（审计覆盖，不要再动）

- workspace 监听器/总线订阅全进 `_unlisteners` 双路径消费；后端 watcher 三段防护（deactivate 停 + Drop 兜底 + 先停旧线程）
- runtime 重建先 flushAllBoards + disposeAll（P0-10 已拆）；SubAgentPool stopAll 双路径；agentSessionState 工厂注销链完整
- `loadGraphPages` 逐页 `ws.active` + `source_root` 对拍（epoch 防护教科书）；graph-scene-lifecycle 代际 + safety timer
- cache-store 全量（epoch + resetAgentCaches 双路径 + buildResult 归属，commit `176f4873`）
- scoped-store 分区机制、runtime per-session board 注册表、MessageBus inbox、子 Agent finally 链、board-persistence `_destroyed` 标志

---

## 第三批审计（2026-09-10）— 打包资源残留家族

> 来源：实机事故（进入工作区报「会话核心未初始化，无法绑定目录」）+ CDP 实机取证。
> 家族指纹：**构建工具的合并不清空 + 装载通道照单全收 + boot-gate fail-loud 一票否决**——
> 三层接缝叠加，任何「源里删除、目标目录残留」的产物退役都会复刻。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| B1 | `target/<profile>/_up_/src-ui/dist-plugins/`（cargo tauri build/dev 的资源拷贝落点） | Tauri 资源拷贝**合并不清空**——源侧 `src-ui/dist-plugins`（build-builtin-plugins 每次 `rmSync` 全量重建、永远干净）删除/改名的产品目录，在 exe 侧资源目录永久残留成僵尸 | 图谱退役（51047f99 删 engine-domain/graph-builtin）后 17:02 重新打包 → 两僵尸残留 → 产物通道照常装载（装配断层对账只查「缺」不查「多」）→ graph-builtin inject 的服务已删 → fiber 永停 PENDING → **boot-gate fail-loud 杀掉 bootShell** → chatPanel 永空 → 进任何工作区报「会话核心未初始化，无法绑定目录」；首页其余一切正常（工作区列表走独立 RPC，症状极具迷惑性） | ✅ 已拆僵尸（2026-09-10 实机删除 `target\release\_up_` 与 `target\debug\_up_` 两侧残留，CDP 验证 boot 全绿 43 fiber 全 ACTIVE + 端到端进工作区「✨ 工作区已就绪」）。复发防线 = **拍板 A：纪律**——退役/改名产品时顺手删两侧 `_up_\src-ui\dist-plugins\builtin\hologram\<产品>` 对应目录（2026-09-10 用户拍板；b = build.cmd 前置清理、c = 装载器拒载非第一方 `hologram/*` 通道产物，两案备而未拍） |

**取证备忘**：boot 期错误不落 ui.log——`initLogger` 挂在 `Workspace.open`（workspace.ts），boot 被杀 → 永远进不了工作区 → logPath 恒空 → 错误只进 WebView console。唯一取证面 = CDP：`tauri.conf.json` `additionalBrowserArgs: "--remote-debugging-port=9222"` 已开，`http://127.0.0.1:9222/json/list` 取 webview target，WebSocket + `Runtime.enable` 即可收 console——且 Runtime.enable 会**重放上一轮 boot 的全部 console 历史**（含旧故障现场），区分「历史重放」与「本次 boot」勿误判。

### B2（2026-09-16 补记）— 退役删接线、不删打包 =「没人管的随包资产」

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| B2 | `src-tauri/tauri.conf.json` 的 `bundle.resources` / `beforeBuildCommand` | **退役只删消费侧接线，没回头清分发侧打包**——资产继续随包（体积白烧），但已无任何代码知道它在哪、更不会启动它；用户拿到一个「神秘 196MB」 | 2026-09-09 同日两刀：凌晨 `30fd7bd8` 为修「首页点不进工作区」把引擎塞进包（**当时正确**，壳还在消费）；下午 `51047f99` 图谱全量退役删 `engine_transport.rs`（682 行，含 `engine_exe_path()` 定位 + 每工作区 spawn），**而 `git show 51047f99 -- tauri.conf.json` 为空** ⇒ 分发包留着、自动接线删了。此后一周无人察觉（`grep Command::new \| grep engine` 零命中，UI 从不提及引擎，文档那句「或安装目录下的同名文件」成化石）。危害是**隐性**的：不炸（无僵尸产物，与 B1 不同），但 (a) 安装包白涨 196MB、(b) 每次构建白编译引擎、(c) 用户/Agent 排查时被过期注释带偏（`app/mod.rs` 头部仍在描述已删的「每工作区持一个引擎传输」） | ✅ 已收口（engine-bundled-mcp-distribution，2026-09-16）：接线补回（前端 `plugins/builtin/bundled-engine/` 走既有 MCP 受治进程通道，按工作区注册——2026-09-26 批 10 产物化，经 `ctx.workspaces` 贡献；探测/开关留 `plugins/bundled-engine-prefs.ts`）+ 定位面（`engine_assets.rs` 只读探测 + `engine_bundled_info` RPC）+ 设置面板可见可开关（**默认关**，尊重 09-09 退役决策）+ 过期注释/文档同批真相化。打包清单**有意保留**（引擎确实要随包——这正是该计划的前提） |

### B3（2026-09-16 补记）— 退役删了资产、没删打包引用 =「发布通道断链」

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| B3 | `.github/workflows/release.yml` 的 5 处 `cp release-bin/...`（L54/55/63/64/65） | B2 的**反向形态**：这次是「资产删了、引用没删」。`release-bin/`（`hologram` wrapper + `install.sh` + `install.cmd`）已在 `5741e457`（engine-plugin-extraction §8 旧时代残留清理）物理删除，而 release 工作流仍在从它拷贝 | release 的 staging 步骤按现状会失败（`cp` 源不存在）⇒ 发布在打包前就断；同时 README 旧文还在教用户「双击 `install.cmd` / `./install.sh --user`」（已随本次文档面重构删除） | ✅ **已收口（2026-09-16，用户拍板「不要」）**：删掉那 5 行——引擎包只发裸二进制（`hologram-engine` / `.exe`），wrapper 与安装脚本不再重建（它们发的是已退役的 `hologram` 旧 CLI 名，且与 dsh-bundle 的 `install.mjs` 职责重叠）。发布说明与 README「引擎 CLI」一致 |

**家族纪律（B1 + B2 合并）**：**退役一个随包资产 = 三面一起过**——
① 消费侧接线（删/改代码）；② 分发侧打包（`tauri.conf.json` resources + 构建链）；
③ 产物侧残留（`_up_` 清僵尸，见 B1）。
只做 ① 就是 B2（资产变孤儿），只忘 ③ 就是 B1（僵尸炸 boot）。判定问句：
「这个资产退役后，还有谁需要它在包里？」答「没人」→ 三面全清；答「用户/外部消费者」→
②要留，但**必须留得可见**（设置面板/文档写明它在、怎么用），否则就是 B2 的隐性形态。

### B5（2026-09-26 补记）— 更新链路唯一源押在境外 = 国内用户「永远已是最新」

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| B5 | `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints`（单条 GitHub `releases/latest/download/latest.json`） | **分发面单点依赖境外**：release 资产在国内常年超时/被重置 ⇒ 应用内自动更新**静默失效**（`update-store` 是 best-effort：失败只 `console.warn` + error 态）——用户侧表现是「检查更新永远说已是最新」 | ⏸ **主动搁置（2026-09-26 用户拍板停手）**。当日实测（复现时直接引用，别再从头查）：① 本机直连 GitHub release 资产域 **HTTP 000 / SSL 失败**（仓库 push 正常，资产域不通）；② 美国 runner → 国内 GitCode 上传 161MB 只有 **29KB/s**，四次重试完全一致（同类项目 7 月还能传 458MB ⇒ 平台行为已变）；③ Gitee raw 可作**地址恒定**的清单源（任意路径 200 + `max-age=60`，Tauri 真实 UA 验过）；④ GitCode 附件容得下 458MB，Gitee 免费版附件上限 100MB。当日产出的中间物（CI 镜像工作流 / S3 出口 / 本机发版脚本 / CLAUDE.md 与 dev-workflow 的流程章节）已按要求全部删除，git 史 `ae0edc7a`..`c859dfd6` 可查。**签名密钥同日轮换**（旧 `AE4D460123A2D553` → 新 `2DF02C823A4DE227`，私钥归开发者本机）⇒ **存量客户端必须手动重装一次**——这条与搁置无关，是已发生的事实 |
### B4（2026-09-16 · 用户实机报）— 「随包了但找不到开关，拨了也没回执」= 能力的**可发现性/可验证性**断层

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| B4 | `McpPage.tsx` 的 `BundledEngineSection`（设置 → MCP）+ `workspace.ts` 的接线回执 | B2 的第三形态：资产在包里、接线也补齐了，但**入口排在页面最底部**（用户级 server 列表 + 新建表单之后），且**接线结果只进 console**——用户侧既找不到开关、也无从判断"挂上没有" | 用户打包后实机跑：「好像图谱 engine 根本没挂上，说是默认关，但开关在哪呢？」。CDP 只读取证（2026-09-16）定性：① `engine_bundled_info` → `available: true`（引擎就在 `lantai.exe` 同级，**探测链路本来就是通的**）；② `lantai.bundledEngine.enabled` = `null`（其余 `lantai.*` 偏好都在）⇒ **开关从未被拨过**；③ 接线 `wired/reason` 只进 `console.log/warn`，UI 无回执。「引擎没接上」因此既无法证实也无法证伪 | ✅ **已修（2026-09-16）**：① 区块**置顶**（宿主自有能力排本页首位）；② 三态同屏——探测（实路径 / 未检测到时写明「须与 `lantai.exe` 同目录」并**保留置灰开关**，不让开关凭空消失）+ 开关 + **接线回执**（新建 `state/bundled-engine-store.ts`，`workspace.ts` 写入，设置面板读；wired/failed/off/idle 四态各有具名文案，「开关已拨但本工作区未重开」单独成句）；③ 失败同时进状态栏（`pushStatus`，错误不静默）。**2026-09-26 批 10**：回执写入者由 `workspace.ts` 改为 `bundled-engine` 产物（经 `ctx.workspaces` 贡献），载体仍是 `state/bundled-engine-store.ts`。**端到端仍欠**：拨开关→引擎真拉起→工具面出图工具，见 `docs/plans/README.md` 真机欠账表 |

**教训（B4 一句话）**：**「默认关」是一种产品承诺，不是免责声明**——默认关的能力必须同时交付
「开关在哪」与「拨了之后发生了什么」；否则用户看到的现象与「功能没做」完全一样。

---

## 第四批审计（2026-09-14）— 回复链路活性家族

> 来源：用户报「发出消息到收到回复的 pipeline 有断点、模型经常不响应，模型通讯是通的」。
> 定性结论（重要，别记错）：**本次症状的真凶是链路挂起**（HTTP 通了但一个字节不回）——
> 09-12 的 `7dac038b`（挂起走时间预算）就修好了，只是当时在跑的是 09-11 02:19 的旧
> exe，修复没编进二进制；换上新二进制后症状消失。下面是同族病灶（不是本次症状）。
> 家族指纹：**活性保障只有一层、且只认一种失败形态**——`idle-stream` 的 30s 守卫只会
> `ctrl.abort()` 一个 fetch，掐不断不理会 signal 的 await；而"是不是用户主动停止"
> 全靠错误文本猜。两者叠加的后果统一为：**用户看见「发出去没回应」，案卷里留下悬空
> 来文，日志里连一行都没有**。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| L1 | `agent/retry.ts:52` + `app/chat/chat-core.ts:1042/1370` | 「用户停止」靠 `msg.includes('aborted')` 猜（三处同款） | 非用户的中止（`BodyStreamBuffer was aborted` 这类传输被切断）被当成用户意图 → 不重试 + 不落墓碑 → 案卷留下悬空来文，只闪一条 6.4s toast；且任何含 `aborted` 子串的失败（上游 "request aborted by upstream"）都会被静默吞掉 = 宪法四「错误不静默」违规 | ✅ 已拆（Commit `02b90400`）：① 用户中止判据改为一桩**事实**——本轮 signal 是否被中止（chat-core 两处 catch + streamOnce 全改 `signal.aborted`，不读任何错误文本）；② 非用户中止的「中止族」失败在 streamOnce 织入 `[传输中断]` 分类标记 → 计数预算重试 3 次 → 重试耗尽落可见墓碑（`isRetryable` 拆掉 `msg.includes('aborted')`）；③ `markTurnError` 补齐「第一个 token 之前就失败」形态——流式助手缺席时**补建墓碑消息**（旧行为只弹 toast）。验收环 `tests/chat-send-liveness.test.ts` 4 例（含守门：用户主动停止仍静默）。**验证方法备忘**：当时工作区有并行窗口的 token-meter 在途改动压在同两个函数上，故按「HEAD + 本 commit 的 10 个 hunk」在独立 worktree 做隔离验证（tsc + 45 测试 + convergence 全绿），并行改动全程未被触碰、未被提交 |
| L2 | `provider/transport.ts` / `provider/credentials.ts` | 上路本机 IPC 无超时 + 失败结果永久缓存（含负缓存） | 一次瞬态故障被伪装成「配置事实」且不可恢复：`getProxyPort` 钉在 0 → 此后恒走直连（CORS 不放行的厂商全废）；`resolveApiKey` 把 IPC 抛错记成「没有 Key」→ 恒报 MISSING_CREDENTIAL 而设置里 Key 明明在；`resolveOauthToken` 同款（瞬态故障记成「未登录」）。三条都只能重启自愈、日志无痕 | ✅ 已拆（Commit `4c4a8206`：三处改 `typedRpcWithTimeout`（5s/10s/30s）+ 失败不落缓存，真负结果（确实无 Key / 真是 OAUTH_NO_GRANT）仍缓存；同批修 `proxyFetch` 吞掉 abort 后回退重发。钉子 `tests/provider-cap-liveness.test.ts` 8 例） |
| L3 | `provider/idle-stream.ts` + `agent/agent.ts:stream()` | 无「请求硬截止」：全链路唯一的活性守卫只会 abort fetch | 卡在非 fetch 的 await（本机 IPC / 凭据解析 / 任何不理会 signal 的等待）时，30s 守卫是**空操作** → 回合永久挂起：无错误、无重试、无日志、无 UI 反馈，UI 永卡运行态直到重启 | ✅ 已拆（2026-09-20 运行看门狗批；契约 v43 → v44）：新模块 `agent/run-watchdog.ts` = **无进展硬截止**（不是绝对截止）——脉搏三处：① `Agent.streamOnce` 收到 chunk ② 工具结果落盘（`tool/call`／`tool/result` 入投影）③ loop 步骤边界（`default-loop` 每步入场调 `host.stepBoundary`）；`NO_PROGRESS_WARN_MS` 5min 只 `log.warn` 一次 + 一条 UI 提示（行为零变更）、`RUN_ABANDON_MS` 20min 硬截止 = 作废该轮，**绝对上限刻意不设**（只会误杀长任务）；阈值走模块常量 + `setRunWatchdogThresholds()` 注入面，**不扩 `AgentConfig`**（23 字段冻结）；巡检固定 30s `setInterval`（不自重排 `setTimeout`——自排会被它看守的那个 await 一起停摆）。`Agent.run()` 把 `runLoop` 与「硬截止」「signal 中止」竞速——到期顺序：① 打栅栏（`RunPulse.abandoned`）② abort（经运行账 `discardRuns`——谁铸的 signal 谁有权中止）③ 具名 `RunDeadlineExceededError` settle；**用户停止走同一竞速** ⇒ 停止钮真解旋（`_loopDepth` 归零，不再幽灵轮）。**遗弃语义**：迟到 chunk／迟到工具结果**只留审计、不进 session 投影**（栅栏落在 `Agent._appendMessage` 唯一投影入口；`StreamingToolExecutor.addTool` 拒绝再开新副作用）；作废轮**不补唤醒**（inbox 留待下次）。契约面 v44：`agent-loop/types.ts` 的 `AgentLoopHost` 增 `stepBoundary`／`abandonedError`／`isAbandoned` 三成员 + `agent/events.ts` 增 emit 域事件 `run/abandoned`（载荷 `RunAbandonedPayload`）——事件面只增不改既有序列 ⇒ convergence 双轨**零漂移，故未重录基线**。同批逐缝超时（S5）：`agent/mcp/client.ts` 每请求加硬截止（`MCP_REQUEST_TIMEOUT_MS` 120s／握手 30s，复用既有 `lifecycle/timeout.ts` 的 `withTimeout`，超时摘 pending 条目）；SSE 读（`provider/shared.ts` 的 `sseEvents` → openai／anthropic／responses）**判定为有界，不改**（它认 `signal.aborted`，链路 = idle 30s abort → ctrl.signal → fetch → reader，后面还有 20min 看门狗兜底）。测试面：`tests/landmine-l3-hang.test.ts` 原两条复现钉（`it.fails`）**按原文件交代改写为正向断言**并扩到 10 例（阈值口径／硬截止 settle+finally／慢而不死每 4min 1 token 不被误杀／warn 只报一次／迟到 chunk 不进投影且不再发下一发／投影入口的栅栏本身——第三方 loop 的迟到 append 也被拒／迟到工具结果只留审计／作废轮不补唤醒／与 v43 记账交互／停止后 `_loopDepth === 0`）+ `tests/chat-send-liveness.test.ts` 新增 ChatCore 面一例（到期落墓碑「本轮超硬截止已作废，结果未知，勿当成功继续」+ runId + 不悬空来文 + 账空闲可重发）。**⚠️ 仍然存在的代价／残留**（哪一半拆了、哪一半留）：① **取消不掉的那一半**——上游那条不认 signal 的 await **仍然挂着**（JS 取消不了第三方 await），只是「没人再等它」、迟到产物被栅栏拦下；**孤儿 await 的资源回收仍未做**；② 工具本体的**孤儿副作用**照旧可能发生，30min `AWAIT_BACKSTOP_MS` 保留为第二层（20min 硬截止更小 ⇒ 基本不再触发）；③ **真机复现证据仍未采集**——待临时把阈值压到 60s（`setRunWatchdogThresholds`）+ 假 provider／拔网线实跑，取 `ui.log` 两条 `log.warn('agent', …)`（ctx 固定为 `runId`／`run`／`no_progress_ms`／`no_progress`／`last_pulse`／`last_pulse_label`）；欠账已记 `docs/plans/README.md` 真机表 |
| L4 | `workspace.ts:840` (`onSessionPersisted`) + `:778` (`subAgentSpawner`) | 注释声称「已改用本工厂闭包捕获的 agent，不再经共享 `agentRef.current`」，代码里仍是 `agentRef.current?.insertMessage(...)` | 多会话并发时 turn-start 块 / 子 Agent 派生落进「最后创建的卷」= 注入错卷（与 2026-08-13 多会话错位事故同族）。半径小（只影响提醒注入与 spawn 归属），但注释与代码不符，下次读代码的人会被误导 | ⏳ 未拆（低危，记录在案） |
| L5 | `agent/agent-session-state.ts` 运行态账本 × `agent/tools/subagent.ts:142`（async 派发）× `shell` 域后台任务 | 「本卷在跑」的判据 = 运行账上的活记录（v43 起唯一事实），而 async 子 Agent 的生命周期**刻意独立于父轮**（`subagent-spawn.ts:119` 注释：async 模式合并中止源时排除父轮 signal），后台 shell 任务同理 | 父轮已收尾、活体子 Agent / 后台任务仍在推进：卷里 SubAgentPart 卡在「执行中」、任务输出还在长，用户眼里这个会话在跑；而创作坞无停钮、呼吸线不亮、书眉无「行卷中」，退出守卫（`shell/rows/persistence.ts` 的 `countRunningSessions`——同一把尺子）也不拦 ⇒ 关窗即丢在途工作 | ✅ **已收口——用户裁定「后台活体不计入在跑」**。**拍板日 2026-09-20**（留痕：`tests/async-return-delivery.test.ts` 头注「用户裁定（2026-09-20）：async 子 Agent 与后台任务在父轮收尾后仍活着时不算「在跑」」，commit `7015fac9`）；**本条状态格当时漏记**，一直挂着 ⏳ 待拍板——**2026-09-22 用户复述同一裁定**（原话「后台活体在跑的时候这一卷不算在跑，本质上如果任务在后台跑的话，当前卷 Agent 就是空闲的，可以继续和用户交互，没问题」）后补记，两条互证，非新拍板。<br>⇒ 派发点**不**寄 `kind:'subagent'` / `kind:'bg'` 记录，运行账保持现状，五个读面（呼吸线 / 停钮 / 侧栏状态点 / 行卷中 / 退出守卫）一律不改——「Agent 忙不忙」与「还有什么在跑」是**两个信号两个面**。<br>可见性半边由 2026-09-22 落地的**创作坞·役册**承担（设计规格书 §9.4）：按会话的在役/已了清单 + 逐条停后台命令 + 他卷段。<br>**接受的代价（写入判据注释）**：在役后台任务不升起退出确认，关窗即被 lifecycle 终止（`shell/rows/persistence.ts` 的 `countRunningSessions` 注释已同批改写为该裁定）。核对过的前置事实：交互面本就通（`chat-core.ts:1391`「后台卷闸门拆除——本卷不在跑即可发起新轮次」，2026-08-26） |

---

## 第五批审计（2026-09-15）— 域工具 × shell 命令串家族

> 来源：用户报「Agent 用 office cli 时行为很不可控，连问题都描述不出来」→ 翻会话 23 实测复盘
> （`docs/archive/kernel-tooling-line/office-cli-integration-plan.md` §11）。
> 家族指纹：**能力被包装成 shell 命令串过 Bash 家族闸**——闸的路径检查按「token 含 `/` 就当
> 文件系统路径」的启发式，凡 argv 里有非路径的「/ 开头」内容（DOM 寻址 / JSON 载荷 / `BIN=${…}`
> 赋值段）全部解析失败 ⇒ 判「项目外路径」⇒ Ask，而该判定**先于** allow 规则匹配 ⇒ 规则写进去
> 也无效。后果不是"报错"而是**静默降级**：默认模式下工具每次调用都弹卡（只有 yolo 能跑），
> 于是模型改走 shell / code_execution 绕路，人在界面上只看到"Agent 不听话"。
> 已立规：`INVARIANTS.md` #15。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| O1 | `permissions/bash.rs::check`（步骤 3 路径提取）× `agent/tools/office.ts`（旧 `BIN_RESOLVE`）+ `process_cap::exec_command` | 命令串里三处 token 各自独立触发「项目外路径 → Ask」：`BIN=${OFFICECLI_PATH:-$HOME/…}` 赋值段、DOM 路径 `/body/p[1]`、batch 的 JSON 载荷（内含 `/Sheet1/A1`）；且精确 allow 与裸 `Bash` allow 两条规则**都压不住**（路径判定提前返回） | 默认（ask）/ auto 模式下 office 域工具**每次调用都弹权限卡**（含只读 `view`），「始终允许」点了也白点 ⇒ 用户那次测试恰是 yolo，事故被完全遮住；模型实测 76 次调用只有 5 次用该工具，其余全在绕路（shell / code_execution），最后用 Node 脚本直驱 CLI 收场 | ✅ 已拆（Commit `f207e5f4`，强制层改动 + 宪法审查）：`process_cap::office_exec` 专用动作（命令由 Rust 拼装 + 动词白名单 + 口只收 argv 不收命令行串）+ `tools::OfficeTool`（只审声明的目标文件，走 fs 家族同一套策略）。**否定论证也记在案**：放宽 bash::check（跳过含 `$` 的 token / Windows 跳过 `/` 开头 token）会直接开洞，见 INVARIANTS #15 |
| O2 | `agent/tools/office.ts::cleanShellOutput`（旧 `/command not found\|No such file or directory/i`） | 判定过宽：任何"文件找不到"（目标文件不存在、路径写错）都被当成"officecli 没装"，并追加安装指引 | 把模型推去装二进制 / 找二进制，制造与 O1 叠加的绕路；实测会话里模型为找二进制跑了全盘 `find /` 并被用户中断 | ✅ 已拆（`4412ce87`）：收窄为 `officecli(.exe)` 与错误文案相邻；负例入测试 |
| O3 | `agent/tools/office.ts::execute`（旧无条件落盘脚注）+ batch 无 argv 上限 | ① 写动作结果**失败也**追加「改动已落盘（resident 立即 flush）」；② 一次塞 2174 项（>100KB argv，超 Windows 命令行 32767 字符上限被**静默截断**） | 实测：`[exit 1]` + `Batch complete: 0 succeeded` 后面紧跟"已落盘"，模型据此当成功继续；2174 项回执"零失败"而磁盘只落 19/180 行，全程零报错 | ⚠️ **曾复发，2026-09-16 再拆**：`4412ce87` 的"退出码三态"是在 office 还走流式 shell seam（`[exit N]`）时做的；同日 R3 把 office 改直呼 `process_cap::office_exec`（成功**无前缀** / 失败 `[exit code: N]`）⇒ `parseShellExit` 只认 `[exit N]` ⇒ 三态退化成"恒判未知"：每个写动作都回「结果未知，不要当成功继续」、多批 batch 第 1 批假失败。TS 测试喂的是**手写 `[exit 0]` 假回执**，18 例全绿掩盖了契约错位。现修：`office_exec` 结果归一（成功补 `[exit code: 0]`，`process_cap.rs::office_result_with_exit_code`）+ TS 双形态解析（含负数）+ 测试夹具换真形 + 批量分支把"未知"与"失败"分开报。batch 分块/停在原地语义不变 |
| O4 | 出厂技能 `officecli` 正文（原 `examples/office-cli/SKILL.md`，2026-10-13 整编入 `builtin-skills.ts`） + officecli 自带 playbook（`office(action:'playbook')` 返回的正文） | 交付给模型的权威指引要求**在 shell 里跑 officecli**（playbook 488 行里 101 条命令 + 开头强制的 Help-First Rule），而产品环境 PATH 里没有该二进制、域工具也刻意不暴露 CLI | 模型照指引下 shell → `command not found` → 转去找二进制 → 另起 resident 与域工具抢同一文件 ⇒ 写入静默丢失（报零失败、磁盘丢行）。**这是那场测试的第一块多米诺** | ✅ 已拆（`4412ce87`）：playbook 返回时前置护栏头（翻译成域工具动作 + 禁止下 shell + 最小 batch 替代 help）；SKILL.md 删掉五处"走 shell 域调 officecli"的逃生舱指引。**根已收口（2026-10-13）**：动作面手册整编为出厂技能 `officecli`（`builtin-skills.ts`，随应用分发——shell 里没有后端的模型在装配期就拿到它）；examples 侧 SKILL.md 退役；上游 playbook 正文继续由护栏头兜底 |
| O5 | `agent/tools/office.ts` schema：`items: z.array(z.unknown())` | `batch` 是动作面里最复杂的参数，而模型可见 schema **零形状提示**（真实要求是 `{command,parent,path,selector,type,props,to,path2}` 那一套；`items` 还是全部参数里**唯一既无形状描述、也不指向技能章节**的那个——兄弟参数都有）；形状只存在于 playbook 正文与一条运行时缺参报错里 | 模型只能猜——实测会话里 2174 项 batch 就是这么拼出来的；猜错时拿到的是 officecli 的原始报错而非字段级提示 | ⚠️ **部分拆（2026-09-16）**：① `validateOfficeBatchItems()` 预检——派发**前**给字段级带窗报错（项序号 / 收到哪些键 / 缺什么 / 正确形状与示例 / 点名技能 §5.1），只查 command 形态（缺键、塞成命令行串）+ 已知动词必需字段（set/remove→path、add→type；`props` 不列必需，宁窄勿宽，未知裸动词放行）；② **尺寸闸扩容**——原护栏只在 `chunks.length > 1` 时生效，单块超限与**所有非 batch 写动作**（长 `props`、大 `data`）仍会撞 Windows 命令行 32767 **静默截断**；现 `officeArgvOversize()` 在每次派发前体检（上限 24 000，余量覆盖 Rust 侧 env 钉扎 + 单引号开销）。**剩**：形状提示进模型可见 schema（描述或逐动词联合类型）仍需 `baseline-change-request` 审批 + 两轨 record——当下由预检的字段级报错兜住自纠 |
| O6 | officecli 的**常驻进程模型** × 本产品「从不 close」 | 缺省**每个被碰过的文件**留一个 `__resident-serve__` 常驻进程：实测 **42 MB / 16 线程**，只在**闲置 12 分钟**后退出、而**每次调用都重置该计时器**；产品侧没有任何 close 路径（域工具动作面与 R3 动词白名单都不含 `close`） | ① 用户报的「**线程泄露**」即此——文档密集会话堆十几个进程、几百线程、数百 MB；② 真正的「**互踩**」是**文件锁**：resident 持有路径时 `create` 被硬拒（`--force` 也无效，上游 help 明文），且外部程序（Excel/WPS/媒体回读）在持有期间读该文件会被锁住 ⇒ 会话 23 里 Agent 的「重新生成」卡死 | ✅ 已拆（R3.1 同批）：Rust `build_office_command` 钉 **`OFFICECLI_NO_AUTO_RESIDENT=1`**（不养常驻，每次调用自成 open/save）+ **只有 `create` 前置 `close`**（`pre_close_target`：放掉外部锁，又不无差别掐掉用户的活预览窗）。**同批更正一条错判**：上一轮"外来 resident ⇒ 回执成功而磁盘无字节"**未能复现**（三组对照读回全命中、过 idle 窗口也不被覆盖）——那是字节扫描（xlsx 是压缩包）+ 文件锁造成的误判，已在代码注释/技能/计划 §11.4 就地改正 |

---

## 第六批审计（2026-09-15）— 会话存盘家族

> 来源：用户报「会话内容的存盘有问题，各种意外退出甚至正常退出会导致会话丢内容」
> → 全链审计 + 本机运行时物证，见 `docs/session-persistence-audit.md`（含复核命令）。
> 家族指纹：**「会话什么时候算已持久化」从未被定义**——全部落盘触发点都是偶然时机
> （轮次结束回调 / 500ms 防抖 / 合卷 / 失活 / 退出钩子），而唯一的设计件
> `docs/session-checkpoint-design.md` 自述「定稿未实施」；退出路径的纸面保证
> （beforeunload 全卷保存 + localStorage 同步兜底）在 2026-08-25 拆 localStorage 后就不成立了。
> 实测代价：2026-09-15 一轮 1h47m 的工作（2333 次工具调用）在磁盘上**零痕迹**，
> 随后用户正常关机 → 全部消失。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| S1 | `src-ui/src/shell/rows/persistence.ts`（旧 beforeunload 块）+ `src-tauri/src/main.rs:72-92` | 退出收尾只有 `beforeunload`（WebView2/Tauri 关窗**不触发**，上游 #3217/#2996），块内 `scheduleAutoSave` 只是「clear 再 setTimeout(500ms)」= 把待落盘推迟到窗口消失之后，`saveAllSessions().catch(()=>{})` 是未 await 的 fire-and-forget 且静默吞错；Rust 侧 `Destroyed` → `drain` → `std::process::exit(0)` 直接腰斩在途写 | 正常关窗 = 未落盘内容随进程消失；系统关机 = 强杀（实测应用活到关机那一刻）。注释还留着「localStorage 同步写兜底」化石（该链 2026-08-25 已拆） | ✅ 已拆（本批）：一条 flush 三入口（`watchWindowClose` preventDefault→flush→destroy / `pagehide`+`visibilitychange(hidden)` 兜底 / `beforeunload` 保留）+ 2500ms 硬预算 + 逐卷异常可见（不再静默吞）；能力位 `core:window:allow-destroy` 已入 capabilities |
| S2 | 落盘时机全表（`ui/chat-stream.ts:500` finishTurn、turn-done 订阅壳行、合卷、改名、失活） | 全部在**轮次结束之后**——一轮从用户输入到流收尾之间磁盘上零痕迹；`docs/session-checkpoint-design.md` §3.1/§3.2 的两个语义时刻检查点从未接线（会话事件 NDJSON 第二写面也已随 agent-store 内存化退役） | 崩溃/退出/关机丢**整轮**（用户消息 + 助手输出 + 全部工具结果） | ✅ 触发点 A 已接线（loop 监听面 `request/start`——不改 agent-loop 契约文件、在途合并、fail-open 可见）；✅ 触发点 B 的**执行前屏障**已接线（`SessionLog.flushPersistence` + 执行器第 7 参钩子，fail-open 可见）；✅ `tool/call` 已前移到分发时落（宣布落盘 → 排空 → 才执行；phase-5 事件序列基线两轨重录，用户已批准） |
| S3 | `ui/chat-session.ts::writeSessionSnapshot` + `src-tauri/src/confined_fs.rs::write_atomic` | 同卷多写者（防抖/后台卷/改名/合卷/失活/退出 `Promise.all`）**无串行化**，而 `write_atomic` 不是临界区（对照 `editor_cap.rs:72` 有进程级锁） | 迟到的旧快照覆盖新快照 = 静默回滚；撤掉写链实测复现「v1 覆盖 v2」（`src-ui/tests/session-exit-flush.test.ts` 真变红） | ✅ 已拆（本批）：每卷写链（键 = 目标路径）+ `drainVolumeWrites()` 退出前 drain |
| S4 | `src-tauri/src/confined_fs.rs:129-142` + `plugins/builtin/sessions-builtin/index.ts:36-43` | `write_atomic` = `target→.bak` → `tmp→target` → 删 `.bak`：两次 rename 之间进程死 ⇒ 卷文件**整体消失**（内容只在 `.bak`/`.tmp.N`）；读面只认 `{id}.json`（无回退）、`list_volumes` 只列 `.json`，`restoreCanvasSpread` 还会把它从 `canvas.json` 剪掉；无 fsync | 崩溃/强杀撞上写窗口 = 卷「消失」，用户视角像永久删除（本机 22 卷暂无 `.bak`/`.tmp` 残留 ⇒ 目前是风险不是已发生事故） | ⏳ 未拆（P1，用户已批「`.bak` 只读回退」）：先决 = 把该决策写回 `session-checkpoint-design.md` §6.6/§9.3（原文裁定「不做卷版本化/.bak 多副本」） |
| S5 | `ui/chat-session.ts::saveActiveSession` / `saveSessionById`（旧 `if (!agent) return`） | 句柄缺席（未水合卷 / 工厂失败 / 切 preset 拆句柄）时**静默跳过**落盘：无日志无提示；`saveAllSessions` 又只遍历案头摊开的卷 | 「卷还在、内容旧」——退出即丢该卷内存里的全部内容，用户零信号 | ✅ 已拆（本批）：`SessionSaveOutcome` 五态 + 一次性 warn + `flushSessionsForExit` 逐卷汇总（退出路径可见报异常卷） |
| S6 | `ui/chat-session.ts::workspaceSessionsDir` + `listSavedSessions` | `projectPath=''` 时拼出 `/.lantai/sessions`（相对进程 CWD 解析，`ui.log` 实证落到 `D:\.lantai\sessions` 被安全闸拒绝）；读面单卷失败/10s 总超时**静默少一卷**（只 console） | 启动早期读写全废；侧栏「卷不见了」（同族已在画布面修过 `51758e94`，卷列表面未修） | 路径守卫 ✅ 已拆（P0 批：空路径响亮报错，消费方降级为空集）；**读面可见化 ✅ 已拆（2026-09-18 侧栏载入批）**：目录枚举失败与 10s 超时一律**上抛**（不再 `resolve([])` 伪装成「本工作区暂无案卷」），消费面保留上次结果 + 侧栏明示；单卷读失败仍跳过但逐卷 console。守护 `tests/chat-session.test.ts`（三态）+ `tests/session-sidebar-load.test.tsx`（失败不清空） |
| S8 | `ui/chat-session.ts::listSavedSessions` × 消费面订阅（`canvas-nav` 侧栏/书脊 · `paper-shell` 案头签条） | 一次清点 = 读**全部卷体**（每卷日志逐行 parse + 重放 + 重建消息 + 整份投影缓存），而消费面把它挂在**每条 store 事件**上——消息流式追加逐块触发（实测 50 块消息 = 51 次全量重扫）；且成本正比于**历史总体量**（本机 32 MB 会话目录 → 单次读 21.22 MB / 14 次文件读 / 240 ms），几百卷 = 几百 MB，并发重扫再把 10s 超时压爆 → 超时即空清单 | 侧栏「半天加载不出来东西」/ 流式期间整机发滞；同族病灶 `51758e94`（画布面列表超时）。**触发条件 = 卷数 × 卷体大小**，卷越多越必现 | ✅ 已拆（2026-09-18 侧栏载入批，两批）：① 刷新分频——消息/运行态/空间事件只同步内存源，磁盘清单只在摊开集·工作区路径·行操作·卷落定信号时拉 + 单飞 + 尾随补拉；② 读面失败不伪装成空集（目录枚举失败上抛，消费面保留上次结果 + 明示）；③ **清单投影持久化** `{root}/_index.json`（走既有 seam 动作，零契约变更）——清点 = 目录枚举 + 一份小 JSON，**不读任何卷体**（实测：补建 330 ms 一次 → 稳态 1 ms / 0 读；300 卷规模用例见 `tests/chat-session.test.ts`）；④ 缺失行补建（首扫阻塞至 2.5 s 预算，其余后台并发 4 分批 + 每批广播，列表渐进成形；半途退出不丢已建部分）。守护 `tests/chat-session.test.ts`（目录/对账/自愈/规模 8 例）+ `tests/session-sidebar-load.test.tsx`。**残留（未拆，独立批次）**：目录条目不带 size/mtime，**外部**改写已知卷（换机拷回 / 另开实例并发写同一工作区）不被察觉——本目录与每卷写链同款前提：由本进程独占写入；真门禁需 Rust `DirEntry` 补 size/mtime + seam 新动作 |
| S7 | 测试面（`src-ui/tests/`） | 六项保证零覆盖：退出 flush / 同卷并发写顺序 / 在途轮次 / 原子写崩溃窗口 / 无句柄卷语义 / 退出时防抖 | 改这块代码没有任何测试会变红（既有 108 用例只钉「落盘目标路径 + 快照字段 + 空卷跳过 + 墓碑形状 + seam 四动作 + 防抖 per-panel」） | 四项已补（本批 `tests/session-exit-flush.test.ts` 8 例，含撤掉修复即真变红的负向验证）；⏳ 真实崩溃注入（kill 在两次 rename 之间）与大卷写放大实测仍缺 |



**第六批补记（2026-09-15 · DSH 参照换轨三期竣工）**：上面这批 S 项已按参照架构整体处置，
后续读者请以本补记为准——

- **S1/S2（退出与在途）**：退出路径保留 P0 的三入口，但动作从「写 N 卷 MB 级快照」降为
  「排空事件日志队列」（KB 级）；**触发点 A（模型请求前）已接线**（`request/start` loop 监听面）。
  **触发点 B 已收官**：执行前屏障 + `tool/call` 前移到分发时落（`2026-09-15`，phase-5 事件序列基线两轨重录，用户批准）
  （兰台的执行器在流期间就跑工具），落点在 `agent/streaming-executor.ts`，属另立项。
- **S3（写面无串行化）**：每卷写链（P0）+ 写后队列单写者（Phase 1）双保险。
- **S4（原子写崩溃窗口）**：⚪ **随架构消失**——卷本体改为 append-only 事件日志，
  没有 `target→.bak→tmp` 的 rename 窗口；半截记录由「断尾截断修复」处理。
  **`.bak` 只读回退需求作废**（`session-checkpoint-design.md` §6.6/§9.3 的「不做多副本」
  与之一致，无需再改写）。
- **S5（无句柄静默）**：P0 已做可见化；换轨后「句柄在场」不再是落盘前提（内容真源 = 日志）。
- **S6（路径与读面）**：路径守卫已拆（P0）；**卷集改按 `.ndjson` 认卷**（列表/发号/剪枝/删除），
  墓碑语义退役（新增 seam 动作 `delete_log`，`delete_volume` 下架——契约 v33）。
  读面可见化**已于 2026-09-18 接线**（目录枚举失败/整体超时上抛，消费面保留上次结果）——
  该遗留项转移到新立的 **S8**（成本与频率）同批处置，见上表。
- **S7（测试面）**：六项空洞里「退出 flush / 并发写顺序 / 在途轮次 / 无句柄语义」已补；
  新增日志写面（含断尾修复与悬空工具调用配平）与采用原语的专项测试；
  **仍缺**：真实崩溃注入（kill 在写盘瞬间）、日志压实与大卷写放大实测。

换轨终态一句话：**`.ndjson` 事件日志 = 卷本体与内容真源；`.json` = 带 `{seq, ver}` 的
UI 投影缓存（陈旧即重建）**。计划与施工记录见 `docs/plans/session-persistence-dsh-port-plan.md`。

---

## 第七批审计（2026-09-16）— 零消费者 / 死态家族

起因：接手清单列了一批「化石」（零生产读者 / 零消费者）。本轮**逐项对代码取证**后
**已切 5 项、驳回 4 项**——驳回的几项是**清单本身的误分类**，写在这里免得下一个人重走一遍
（或按清单误删）。取证纪律照旧：先 grep 全仓读者，再看测试面，最后看生成物/基线耦合。

### 已切（本批落地）

| # | 位置 | 病灶（实测） | commit |
|---|---|---|---|
| 1 | `src/state/panel-store.ts` + `chat-core.ts:326` + `workspace.ts:472` | `toolSchemas` **只写不读**，且 `workspace.ts:472` **每次装配**都把全量 schema 数组灌进这个无人读的 store = 每次装配白做功。不在插件面（`host-surface.baseline.json` 无它）⇒ 纯内部死态 | `675173f3`（7 处 + 2 个测试桩同批） |
| 2 | `src/workspace.ts:165` `_chatPanel` | 死字段：写于 `setupAgent:756`、零读者——**切掉 #1 唯一那处读之后由 biome `noUnusedPrivateClassMembers` 当场抓出**（基线 0/0 不许留 warning，故必须同批处置） | `675173f3` |
| 3 | `tests/ui/__snapshots__/layout-golden.test.ts.snap` | 孤儿快照：源测试随 `35db9ef8`（Three.js 渲染面退役）删除，全仓对 `layout-golden` **零引用** | `994927a1`（573 行） |
| 4 | `src/workspace.ts:213` `open()` 的 `_chatPanel` 形参 | 死参数，且它**牵出一处真缺陷**：`51047f99` 从签名删 `_starGraph`（4 参 → 3 参）后**生产调用点改了、4 处测试调用位没改** ⇒ `callbacks` 实际收到 `panel`、**测试明确想传的回调被静默丢弃**（今日无可见影响，但是地雷） | `3177c22c`（签名 + 5 处调用位 + 连带清一处未用变量） |
| 5 | `src/plugins/boot-gate.ts` 的 `BootGateService` + `assertBootOk` | 空转的预留机制：全仓**零** `inject: ['bootGate']` 生产消费者；「不进病态会话」的真闸是 `main.ts:73-77` 的抛错（`bootShell()` 在其后一行）⇒ 服务与它功能重叠。`assertBootOk` 零消费者（main.ts 内联同款） | `578e640a`（测试面 6 → 5 例同批退役） |

### 驳回（**清单误分类，不要按化石删**）

| 项 | 清单原话 | 实测 | 裁定 |
|---|---|---|---|
| `composition/contribution-channel.ts` 的 `timing` 四档 | 「零消费者」 | **它是被护栏管着的声明式元数据**：`tests/contribution-channel-single-source.test.ts:122-124` 遍历全部贡献点断言 `s.timing` 合法（`TIMINGS` 白名单）；15 个通道各自声明（fs/shell/subagents/sessionPersistence/agentLoop=`request`、hooks/prompts/capabilities/tools=`next-assembly`、overlays/panels/commands=`immediate`、renderers=`frame`）；语义由**消费方**实现（通道自身不实现生效逻辑——文件头注即此意） | ❌ **不删**。删它 = 拆掉那条自洽护栏 + 丢掉机器可读的生效时机声明。**清单此项误分类** |
| `composition/roster.ts:239-240` `diagnostics.overridden/.inserted` | 「零消费者」 | 生产面确零读者，但**测试面有 9 条断言主动断言这套 prompt 覆盖/插入账**（`composition-patch-loader.test.ts:70-72`、`composition-roster.test.ts:178/236/247/265/335`、`composition-wiring.test.ts:303-305`），另有 3 个测试构造完整 `diagnostics` 对象 | ⏸ **暂不删**。零功能收益却要动 5 个测试文件的既有断言。**并且**：源码 `roster.ts:232` 那句「（历史栏，零消费者）」**本身是假陈述**——但 `roster.ts` 在契约清单里，改注释要升版 ⇒ 登记待与下一次合法升版合并 |
| `composition/roster.ts` 的 `ResolvedComposition.seams` | 「零生产读者」 | **半真**：`FactoryComposition.seams` 是**活的**（`roster.ts:390-395` 逐域读 `factory.seams.*` 建 seam 工作行；`seam-composition.test.ts:130-164` 也读）；只有**解析产物**上那份额外声明（`:204` 声明 / `:504` 写入）无读者 | ⏸ **暂不删**。单字段收益不抵一次契约升版（`roster.ts` 在契约清单里） |
| `PanelDef`/`PanelContribution` 的 `side`/`title`/`icon`/`askAgent` | 「无人读」 | **成立**：`panelDefs()` 的唯一消费者 `app/panels/DockPanel.tsx:18-27` 只读 `def.id` / `def.unmountOnClose` / `def.component`；而 4 个贡献点在写（`canvas-nav/index.ts:43-45,55-57`、`paper-shell/index.ts:48-50`、`settings-domain/index.ts:37-39`） | ⏸ **暂不删**。剩余项里收益最大的一个，但跨 `PanelDef`（非契约）+ `PanelContribution`（契约，`services.ts:59-72`）两侧，**拆一半会留不一致的中间态** ⇒ 须与一次合法契约升版合并 |

### 本家族结论（写给自己与下一个人）

**已无「拆掉就净赚」的项。** 清单一共 9 项，能净赚的 5 项已切；剩下的要么**根本不是死码**
（`timing`），要么**收益不抵一次契约升版**（其余三项）。
⇒ **别再为了清单好看去动它们**；下次谁合法升版（契约 v40）时，把上表 ⏸ 的几项
+ `roster.ts:232` 那句假注释**一并带上**（一次升版解决全部）。

### 顺带发现（另立一笔，本批未修）

生成物 `docs/agents/service-catalog.md` 收录 **18** 个 ctx 键，却**漏了 `ctx.agentLoop`**——
该服务确实存在（`plugins/builtin/agent-loop-service/index.ts:21` 的 `super(ctx, 'agentLoop')`
+ `agent/agent-loop/agent-loop-active.ts:44` 的 `declare module` 增广），但**两者不在同一文件**；
而生成器头注自述规则是「同文件 `declare module` 增广」（`scripts/gen-service-catalog.ts:9/:92`），
已收录的 18 键恰好全是同文件形态。**`doc-sync` 抓不到**（生成器自洽）⇒ ✅ **已修**（本批：**键改取类体 `super(ctx, '<键>')`**——机械可推导且每类唯一（19 类 ↔ 19 处一一对应），与增广的类型名解耦；增广此后只供**描述**，同文件找不到时按 ctx 键全仓找。修完 `ctx.agentLoop` 进目录，**其余 18 条逐字节未动**）。
根因值得记牢：旧规则「同文件按**类名**找增广」本身就是错的——原来那 18 个命中是「增广的类型名恰好等于 Service 类名」的**巧合**；`ctx.agentLoop` 声明为结构面 `AgentLoopServiceFace`，故整个服务从目录里消失。

## 第八批审计（2026-09-16）— 文档面重构顺带发现家族

起因：文档面大重构（施工单 `docs/plans/doc-surface-refactor-plan.md`）在按真源逐文件校准时，
顺带撞见三件**不在文档面、但由文档面暴露出来**的事。取证纪律同第七批。

### 已修（本批落地）

| # | 位置 | 病灶（实测） | 处置 |
|---|---|---|---|
| 1 | `src-ui/src/ui/README.md` | 自称「现 16 文件」（实测 **14**：13 ts + README）；且三处引用**已删模块**——「星图类型变更走 `src/scene/graph-types.ts`」、文件簇表里「位置兼容 shim `graph.ts`」、依赖方向图里的 `scene/`。`src/scene/` 目录与 `graph-types.ts`、`ui/graph.ts` 均已随图谱多轮 sweep 整删 | ✅ 本批改：计数改实测值、删 shim 行、依赖方向去掉 `scene/`，并加一条硬约束「不要再新增星图类型或 shim」 |

### 已裁定（2026-09-16 · 用户拍板 A「拆掉」）

**`dsh-bundle/viewer` 的构建链已断**——它是 HoloGram 的 DSH 侧 3D 视图，**不维护内核副本**而是直接构建 src-ui 的 graph 模块：

- `viewer/main.ts:9-10` 导入 `@hologram-kernel/graph`（StarGraph）与 `@hologram-kernel/graph-types`（GraphJSON）；
- `viewer/vite.config.ts:19` 把 `@hologram-kernel/*` alias 到 `../../src-ui/src/ui`；
- 而 `src-ui/src/ui/` 现仅 14 个文件（chat 编排 + 旧层基础设施），**无 `graph.ts` / `graph-types.ts` / 任何渲染子模块**（C13 sweep 删渲染面、`51047f99` 图谱全量退役删 `scene/`）；
- ⇒ 该 viewer **构建必失败**；而 CI 的 `dsh-bundle` job 里有 `Build viewer (src-ui graph kernel, no vendored copy)` 步骤（`.github/workflows/ci.yml`），release 工作流也带 `dsh-bundle`。

**裁定与收口（2026-09-16）**：DSH 插件留在产品面，**3D 视图整量拆除**——
删 `dsh-bundle/viewer/`（vite 应用 + stubs + fixture）、`src/client/index.tsx`（侧栏入口半）、`tsdown.client.config.ts`、
`scripts/dump-graph.mjs`（viewer fixture 导出）；host 半（`src/index.ts`）去掉 `/hologram` 静态托管 + `/hologram/api/graph`
+ 9777 TCP 数据面（`serve` 只留 stdio MCP）；`package.json` 去掉 `./client` 导出、viewer 产物与 `three`/`vite` 依赖；
CI / release 去掉 viewer 与 client 两步（**顺带解堵 npm 发布链**——原先 viewer 构建排在 `npm publish` 之前，任务必红）；
两份阶段 2 施工记录归档到 `docs/archive/dsh-viewer-phase2-*.md`。
本包自此只发「引擎 + MCP 工具面」；将来要 3D 星图 = 新立项（自包含渲染，不 alias 已删模块）。
同批修复：`cordis.patch.yml` 的服务名错配（`ctx.lantaiEngine.*` → `ctx.hologramEngine.*`，`3e18cce3` 改名时机械替换引入；
该错配使 MCP 行拿不到二进制路径、引擎静默不拉起），并给 `scripts/ci-verify.mjs` 加一条对拍断言防复发。

### 待核实（证据不足，勿按化石删）

根 `.lantai/` 下有 `aura-brain/`、`specs/`、`docs/` 等目录，在 TS/Rust 真源里找不到消费者（疑似历史残留）。
第七批的教训在先（清单误分类已有先例）⇒ **需一次「零消费者」取证**（grep 全仓读者 + 看测试面 + 看打包资源），
取证前不动。同一批可带上「`.lantai/` 与 `~/.lantai/` 目录清单是否与代码写的路径集合一致」这个对账动作。

### 教训（记给下一轮文档校准）

**最危险的文档漂移是「机制级事实」的漂移，因为没人会去读代码验证它。** 本批实测两例：
① 文档（ARCHITECTURE / CLAUDE / AGENTS）一致写着「壳经 `engine_transport` 每工作区 spawn 一个 `engine serve` 子进程」，而 `src-tauri/src/engine_transport.rs` **2026-09-09 已随图谱退役删除**、壳内零 spawn 引擎代码（现状：壳只做二进制位置只读探测 `engine_assets.rs`，拉起由前端 `plugins/builtin/bundled-engine/`（2026-09-26 批 10 起随包）→ MCP 受治进程通道 `plugins/mcp-bridge.ts` → Rust `commands/protocol_bridge.rs` stdio）；
② `AgentConfig` 字段数 28 在 AGENTS/CLAUDE 已更正、ARCHITECTURE 两处与根 README 仍写 31。
⇒ 这正是 `npm run doc-check`（事实对拍 + 静态结构查）与 `docs/facts.generated.md`（单一真源）要解决的问题：
**规则写在文档里靠自觉会漂，必须由门禁兜底。**

## 第九批审计（2026-09-17）— 产物热更交付面（用户「热重载根本没生效」当场取证）

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| H1 | **两个产物根**：构建产物 `src-ui/dist-plugins/builtin/hologram/`（`build-builtin-plugins.mjs` 写）vs **exe 侧资源根** `target/<profile>/_up_/src-ui/dist-plugins/builtin/hologram/`（`cargo tauri build/dev` 的资源拷贝落点，`plugin_assets.rs::init_builtin_plugins_dir` 探测并锁它） | 运行中的 exe **只认资源根**；只跑 `npm run build:builtin-plugins` 而**不拷**，应用内「重新加载」重载的是旧文件——静默、无报错、无回执 | 2026-09-17 实机：交付一个批次后用户报「热重载根本没生效」；通道取回 `entry.js` 仍是旧 hash（含 `pp-topbar`），拷入资源根后才变新 hash（含 `pp-chrome`）。**`docs/dev-workflow.md` 的「生产包热重载」三步漏了拷贝这一步**——本轮已补文档。**2026-09-20 复发取证 + 根治**：本检出当场漂移（`canvas-nav/entry.js` 构建根 66,584B@13:56 vs release 资源根 52,017B@11:57，逐文件 SHA256 对拍 2 处；debug 根 13 处）——手工拷贝步存在一天就复发一天 | ✅ 文档已补（2026-09-17 拷贝步 + hash 对拍口径）→ **2026-09-20 根治**：构建脚本**自动镜像**进 target 下每个已存在的资源根（逐文件 SHA256，产物侧多余文件一并清除），并加 `--check`（不写盘对拍，漂移即 exit 1）与 `--watch`（保存即重建+镜像）。见 H4 行 |
| H2 | `src-ui/src/plugins/builtin/face-css.ts:18`（`if (flags.__LANTAI_FACE_ARTIFACT__ !== '1') return;`）+ `scripts/build-builtin-plugins.mjs` 的 `define['globalThis.__LANTAI_FACE_ARTIFACT__'] = '"1"'` | **产物 CSS 从未被注入过一次**：esbuild 的 define 按**表达式字面形态**匹配，源码写成局部别名 `flags.X`（`flags = globalThis`）⇒ define 永不命中 ⇒ 产物域里那句判定读到的是 `undefined` ⇒ 直接 return。于是「面组件 + CSS 在产物里」只兑现了 JS 那一半：**所有插件 CSS 实际只经 vite 打进壳 bundle（嵌在 exe 里）** | 2026-09-17 实机取证：`document.styleSheets` 只有壳的两张（`assets/index-*.css` 含旧 `.pp-topbar`），`link[id^="lantai-plugin-css"]` **计数 0**；页面 `__lantai_plugin_host__.loadCss` 是 function（宿主面在，是标记没置上）。后果：**任何 CSS 变更（tokens/壳 CSS/插件 .css）都必须重建 exe**，「改插件 = 换产物秒级生效」对 CSS 从未成立——历次只改 TS 的批次看不出来，本批（CSS 大改）当场撞上 | ✅ **已修（2026-09-19）**：源码改回**裸标识符 + `typeof` 守卫**（`face-css.ts`）、构建脚本 define 同名**裸键**（`build-builtin-plugins.mjs`）、bundle 域由 `vite.config.ts` 显式 define `undefined`——三处形态由 `tests/plugin-css-channel` 钉住（**变异验证**：退回别名形态即红）。新增**构建期自检**：产物里若仍残留该标识符 ⇒ `process.exit(1)`（不再静默交付一份 CSS 永不生效的产物）。**取证**：五个面产物里那句已折叠为 `if (false) return;`（= 注入路径通）。**本条原本要求的前置对拍（逐产品归属与顺序）**：五个面产品（paper-shell 739 / settings-domain 126 / canvas-nav 120 / compose-dock 48 / paper-minimap 9 个选择器）两两重复 **0 条**（源码目录口径与产物口径逐字一致）⇒ 到达序从「壳 import 序」变成「产物装载序」没有任何可翻盘的胜者；该不变量已成常驻守卫（同测试文件的「顺序审计」用例）。**残留边界**：壳 bundle 里那份插件 CSS 拷贝仍在 ⇒ 改值/加规则可热更，**删规则**仍要重建 exe（见 H3 行） |
| H3 | `src-ui/src/plugins/loader.ts::injectPluginCss`（幂等 link：`id = 'lantai-plugin-css:' + url`，**URL 无版本号**，卸载路径无人移除该 link） | **即便**把 H2 修好，产物 CSS 也**不进 reload 通道**：同文档内点「重新加载」→ JS 换新、CSS 还是旧的（channel 的 `cache-control: no-store` 只救 JS 的 `import`，救不了「同一 href 不重新请求的 `<link>`」） | 触发形态：批次同时改 JS + CSS，只点「重新加载」⇒ 「新 DOM + 旧 CSS」的偏斜（本例：浮件成了无样式通栏块、目次带仍下移 56px）。**当前正确姿势 = 重启应用（文档重载即重新请求）** | ✅ **已修（2026-09-19）**：修法两案**都做**——① **URL 带版本号**（会话戳 `Date.now().toString(36)` + 注入序号，同文档内 href 恒新 ⇒ 必重新请求；本地产物，放弃跨会话缓存复用是划算的）；② **link 记账**（键 = CSS URL 的产物路径——生产 origin 自带 `/plugins` 路由前缀，故键形如 `plugins/hologram/compose-dock`；按名摘除靠尾段容错匹配）：同产品重注先摘旧 link、`deactivateExternalPlugin` 停用即摘（幂等，未活跃也摘）、`resetPluginRuntimeForTests` 清账。钉值 `tests/plugin-css-channel`（版本号在场 / 重注不累积且 href 变 / 两产品各一 link 且停用只摘本产品；**变异验证**：去掉版本号 ⇒ 2 例当场红）。**残留边界**：首帧那份壳 bundle 拷贝仍在 ⇒ **删规则仍要重建 exe**（artifact link 只能覆盖不能抹除；绕法 = 改成中性声明而非删）；tokens/壳 CSS 仍属壳域照旧重建。**落地口径**：`loader.ts` 属壳域 ⇒ 修它的这一批必须重建一次 exe，此后插件 CSS 迭代 = 三步热更 + 「重新加载」 |
| H4 | `src-ui/src/plugins/loader.ts::moduleStage`（入口 import URL = `origin + '/' + manifest.name + '/' + manifest.entry`，**零版本号**）——与 H3 同因、只修了 CSS 那一半 | **ES module 的模块图（module map）按 URL 缓存已求值的模块**：同文档内 `import(同一 URL)` **连请求都不发、也不重新求值**（`asset_response` 的 `cache-control: no-store` 只覆盖 HTTP 缓存与跨重启复用，**管不到模块图**）⇒ 点「重新加载」= 拆掉旧贡献、再把**旧模块**原样装回去：面板 component 引用不变 ⇒ React 视为同型不重挂 ⇒ 界面纹丝不动。TS 改动只有页面重载/重启应用才可见 | 2026-09-20 实机同族探针（Chromium/WebView2）当场取证：产物换文件后同 URL 第二次 `import` 的**模块请求数 = 0**、返回值仍是旧内容（`1st=A1 2nd=A1 httpNow=A2`）；同批带 `?v=` 的对照组取回新内容（`2nd=C2`，模块请求数 2）。**症状学**：CSS 侧 H3 带版本号 ⇒ 改 CSS 像生效、改 TS 不生效 = 用户读作「**经常**不自动生效」而非「从来不生效」 | ✅ **已修（2026-09-20）**：① 入口 URL 带恒新版本号（`withArtifactVersion`——会话戳 + 取用序号，与 H3 的 CSS 共用同一把戳），钉值 `tests/plugin-loader.test.ts` ⑥（同产品两次装载 URL 必不同；**变异验证**：退回无版本号形态即红）；② **H1 一并根治**：构建脚本 `--check`（逐文件 SHA256 对拍，红/绿回路）+ 自动镜像进 target 下每个已存在的资源根 + `--watch`（`npm run watch:builtin-plugins` 保存即重建+镜像）；③ **应用侧自动重载**：构建期写产物根 `_rev.json`（内容指纹表），`plugins/product-watch.ts` 盯它（2s，窗口隐藏不轮询）→ 变更即 `activateExternalPlugin`，用户禁用的插件跳过——钉值 `tests/plugin-product-watch.test.ts`（5 例）。**残留边界**：`loader.ts` 属壳域 ⇒ 修它的这一批必须重建一次 exe；入口 URL 恒新 = 每次重载都重新求值模块（放弃模块复用，与 H3 同口径）。文档同步：`docs/dev-workflow.md`「生产包热更」段 |
| H5 | **产物 CSS 引用「比运行中壳层新」的 token**——本例把板面纹理提成 `tokens.css` 的 `--panel-tex-*`，而三个消费面（`.pp-desk` / `.ss-sidebar::before` / `.sr-rack::before`）**全在插件产物里** | 产物**走磁盘热更**（H1/H3/H4 修好后 CSS 确实秒级换），壳层 CSS 却**烧在 exe 里**——产物依赖壳层新 token ⇒ 热更产物上了旧壳，变量解析不出 ⇒ `background-image: none`，**静默**（无报错、无回执）：桌垫纸纹整片消失、只剩流区有纹（流区内联 `paper-sheet.jpg` 故不受牵连） | 2026-09-21 实机：用户报「只有会话流区有纸纹了」。取证 = **时间戳对拍**：`target/release/lantai.exe` 构建于 **11:53:50**，`tokens.css` 加 token 于 **12:06:39**（晚 13 分钟），产物镜像 12:33 已跟上 ⇒ 运行中的壳里没有该 token。**通则**：插件产物 CSS 只许依赖**已发布壳层**里已存在的 token；新增 token 要么等一次 exe 重建，要么**跟着产物内联**（产品自包含是硬约束——图 base64 内联进 `entry.css`）。守卫 = `tests/paper-visual-decisions` 的「板面纹理同配方」用例（三处配方逐字相等 + `tokens.css` 与三处都不许再出现 `--panel-tex-`） |
| H6 | `src-ui/src/plugins/product-watch.ts`（H1/H3/H4 收口的第三环=自动重载本体） | **基线之后的静默死亡**（两条路都一声不响）：① `readRev()` 返回 null（通道读不到/坏形状）只在 `baseline == null` 时计数与停轮询 ⇒ **基线一经建立，后续 N 次失败既不报也不停**；② `inFlight` 被一个**不 settle 的 await**（`activateExternalPlugin` 卡住）永久占住 ⇒ 之后每次 `pollOnce` 首行就 return。两条合起来的症状 = **改完一批产物，应用里「什么都没变」，日志里也没有任何线索** | 2026-09-21 实机：一个下午改了四批产物，用户报「实机验证感觉什么都没变」。取证 = `.lantai/logs/ui.log` 全量扫 `product-watch` **只有两行**（09-20 一行 + 09-21 **12:33:48** 一行）——即当天唯一一次重载发生在中午，之后 12:40 / 15:07 / 15:36 三次产物重建全部没进过运行中的应用；`禁用`/`deactivate`/`自动重载未生效`/`读不到` 关键字**各 0 次**（排除被 prefs 跳过与失败告警）。**已修（2026-09-21）**：失败可见化——基线之后连缺 15 次（≈15s）即 `warn`（此后每 300 次再报一次，不刷屏），连缺 60 次推一条**状态栏**提示「改产物请重启应用」（通道恢复即复位）；`inFlight` 加 30s 看门狗（超时释放 + warn）。钉值 `tests/plugin-product-watch.test.ts` ⑥（断流报恰一次 / 恢复后复位 / 再断流再报）。**残留边界**：本文件属**壳域** ⇒ 该守卫要等一次 exe 重建才生效；在那之前，改产物没生效时的第一动作仍是**重启应用**（boot 必读产物根） |



## 第十批审计（2026-09-17）— 视口落点与失控滚屏家族（用户报「偶尔画布纸面不加载，啥也不渲染」）

**用户口径**（关键，决定主凶）：「**进了工作区 / 按了回锚就空白，没做任何动作**」——不是滚飞、不是拖拽失控，是**落点**本身落在没有内容的地方。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| V1 | `src-ui/src/paper/canvas-math.ts::viewForAnchor`（旧签名只收视口宽高）+ `use-paper-viewport.ts` 的**回锚**（Home 键）与**首屏落位**（守恒 effect 首测分支） | **拿「世界原点」当锚**：`viewForAnchor(w,h)` 返回的 pan 把世界 (0,0) 对到屏幕锚位；而**卷锚 = 该卷最新块底边（`RegionAnchor`，流向上长）会随内容往上漂**——用户三卷实测锚点都在 **-28,700** 上下（内容带 ≤ -28,630） | 按 Home（或首屏落位）⇒ 视口停在卷外 **28,700px** 的空白桌面上：界面完好、卷/块全在，只是**一块都看不见**（CDP 实测 Home 之后视口世界区间 `[-2045, 151]`，`blocksInView: 0`）。这与「新卷落位/空卷几何」（本表 27 条）同族：**锚点语义漂了，落点就漂**。用户读作「画布纸面不加载，啥也不渲染」 | ✅ 已修（**算式落产地域**：`plugins/builtin/paper-shell/landing.ts::panForAnchor`——`canvas-math` 属壳域、改它必须重建 exe，而当时另一窗口正在同树改 `src/agent/**` + `src-tauri/src/cdp*`（重建会把他在途代码编进 exe）⇒ 本批**只换产物**即生效；两处同式由 `tests/paper-landing.test.ts` **跨域对拍**（锚在原点那一档与 `canvas-math.viewForAnchor` 逐值比对，漂了就红）。回锚/首屏一律传活跃卷锚（裁决序 = 活跃卷 → 首个摊开卷 → 世界原点），且回锚与滚轮/缩放同纪律：先取消在途定位飞行 + 清挂起定位。**实机终验**：Home 之后活跃卷最新块底边距视口下缘 **97px**（设计 96）、可见块 3 个）。**已整并（同日技术债批）**：壳域那份 `viewForAnchor` 随即**作为死抽象删除**（唯一生产调用者就是刚改掉的落位；留着＝同一套语义两份实现），连带删 `host.ts`/`host.aliased.ts`/`host-modules.ts` 三处镜像与 `host-surface.baseline.json` 的键（指纹 592c75f8 → dcf4060e）——落位语义此后只在 `landing.ts` 一处；`tests/paper-landing.test.ts` 改为按字面期望钉住（不再跨域对拍） |
| V2 | 四个手势族（拖块 `use-paper-drag` / 拖纸条与抽纸条 `use-paper-strips` / 拖选 `use-paper-viewport`）的帧循环**只认 `mouseup`** 收手（`edge-scroll.ts` 的 `useEdgeAutoScroll` 当时无任何失联兜底） | 窗口失焦、在窗口外松手、切走应用 ⇒ `mouseup` **永远不来** ⇒ 帧循环带着最后一个指针位置**无限滚**（CDP 实测该速率线性无衰减：屏顶带内 **1,444 px/s**，10 秒 14,443px；把视口送出十万 px 量级的内容只需 ~50–70 秒）。而失焦之后用户并不在看——回来就是一片空白 | 悬停档本来就有 `blur` / `document.mouseleave` 收手，**拖拽族没有**：这就是「没人动它自己滚」的那条路。反证：`tests/paper-viewport-ux.test.tsx` ⑩ 用例（拖块到带内 → 只发 `blur`、不发 mouseup）修复前红（`expected 392.0 to be 553.8`，即 blur 之后仍在滚） | ✅ 已修（提到**四族共用的那一层**：`useEdgeAutoScroll` 加 `blur` / `visibilitychange(hidden)` / `document.mouseleave` ⇒ 立刻停帧循环；手势态不在此清理——各自 mouseup 仍会正常收尾，只是不再滚）。**未修的一半**：失联后手势本身仍挂着（拖块停在拖拽态，需下一次点击才复位）——另立一笔 |
| V3 | **野视口会被持久化**：`scheduleCanvasSave` 把 view 原样写进 `{workspace}/.lantai/canvas.json`，读回时 `restoreView` 直接用 | 任何一次跑飞（V2 的失控滚、手动滚远、拖块远钉）都把「卷外」的位置存进盘：下次进工作区**直接落在空白**（实测该文件里出现过 `panY=84010`、`224011`，而内容在 `-28630` 以远）；恢复优先于落位（有 `restoredView` 就不落锚）⇒「偶发」表现为**反复空白** | 用户「偶尔不加载」的第二个来源。**未做**：没有「恢复的视角若不含任何卷则视为无效、回落到回锚」这类校验 | **🛑 用户裁定不做（2026-09-17）**——原话「这两个遗留不管了，没必要」。**残留行为如实记**（日后要改别再从头查）：恢复优先于落位，跑飞过的位置会被原样恢复 ⇒ 极端情况下「进工作面即空白」，靠 Home（已改为回活跃卷）一键脱困。候选修法仍在档：读回时判「视口内无任何流区」→ 回到活跃卷锚；或存盘时夹到内容范围 |
| V4 | `edge-scroll` 的悬停档**没有尽头**：滚到该方向再无内容也不停（`autoPanVector` 只按带深给速度，不认内容边界） | 指针停在屏顶/屏底带内 = 视口以 ~1,444 px/s 一路滚到卷外 ⇒ 屏幕空白（V2 的「正常形态」版：即使 mouseup 没丢，光是把鼠标搁在边上也会这样） | 2026-09-17 实测（探针 28）。**未做**：内容边界夹紧（RTS 相机滚到地图边即停）——**要不要加属手感取舍**，留档待裁定 | **🛑 用户裁定不做（2026-09-17）**——原话「这两个遗留不管了，没必要」。**残留行为如实记**：指针停在屏顶/屏底带内会一路滚出卷外（1,444 px/s，无内容边界）；脱困靠移动指针（即停）或 Home。候选修法仍在档：帧循环里按「内容范围 ∪ 一屏呼吸」夹紧，保住「拖块远钉」这个被设计过的能力 |

## 第十一批审计（2026-09-22）— 附图发送面家族（用户报「读图还是有问题，Agent 怎么直接挂起了」当场取证）

**用户口径**（关键，决定主凶）：读图**读到了**（`fs(read)` 把 6.4MB 的 PNG 挂进上下文），随后 **Agent「直接挂起」**、两次手动停止；且触发路径是「**创作坞粘贴/拖放失灵**，我才给的目录路径让 agent 自己读」。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| I1 | **两条规整律**：`app/chat/image-intake.ts` 的准入规整（≤2048 长边 / ≤2048² 像素 / ≤4MiB，只在创作坞粘贴/拖放/夹选三入口跑）vs 工具附图通道 `src-tauri/src/confined_fs.rs::read_cap`（`MAX_IMAGE_ATTACH_BYTES = 20MiB`，**原样落盘、零规整**）+ 请求期只有许可式预算 `request-images.MAX_REQUEST_IMAGE_BYTES = 24MiB` | 任何**新产图通道**（工具读图 / 浏览器截图）都绕过准入律：实测一张 2560×1400 / 6,456,848 B 的 PNG 内联成 **8.61MB** data URI 直接上线，整包 ~9MB。护栏形同不存在——24MiB 的许可式预算只挡「总量」，不挡「单张多大」 | 2026-09-22 实机：服务商对 9MB 包 **30 秒零字节** ×2（`.lantai/logs/ui.log` 的 `elapsed_ms:30331` / `62416`），用户读成「挂了」。历史可用图 ≤396KB（同网关 09-20 那张 43KB 图 6.0 秒读出 OCR 级细节）⇒ 差距 16 倍；带宽已排除（本机 curl 实测 9.4MB 包 `total=8.41s`、上传 1.12MB/s，网关正常回 401） | ✅ **已拆（2026-09-22）**：加**单图 wire 发送带**（`agent/request-images.ts` 的 `WIRE_IMAGE_CAPS`：2MiB / 长边 2048）——任何来源的图上线前一律过 `image-intake.ts::readAttachmentForWire`（越界降采样 → 换 WebP → 再降尺寸，最多 4 轮；**合规图逐字节原样，不重复重编码**；压不进带即抛错，调用方 fail-open 回原字节）；`agent.ts::streamOnce` 加**最后一道闸**（`overWireBudgetIds` → 摘图换占位 + 日志 + 卷内通知，绝不发注定挂起的包）。读取器产物随之从裸 base64 改为 `{mediaType, data}`（换编码后媒型必须由读取器回报）。钉值 `tests/image-wire-budget.test.ts`（16 例：常量/零漂移/逐轮收紧次序/四轮失败/fail-open/摘图占位/分账判据/粘贴判据） |
| I2 | `agent/retry.ts::withinRetryBudget`（`[响应超时]` → `STALL_RETRY_BUDGET_MS = 15 分钟` 时间预算）+ `ui/chat-stream.ts::handleAgentNotice`（`warn` → **6.4 秒** toast，卷面零痕迹） | 时间预算是为 2026-09-12「出网链路瞬断」设计的——**与载荷无关**的故障，等链路恢复有意义；而「载荷刚长到 9MB」的挂起重发 28 次只是把同一份包重传 28 次。叠上「提示只活 6.4s 且不入卷」⇒ 用户看到的是**转圈 + 无任何解释的 15 分钟**（真实观感 = Agent 挂了） | 2026-09-22：用户 21:16:57 与 21:17:34 两次手动停止（`chat 用户停止：本卷 1 条运行已中止`）。**同一份日志的对照**：21:15:11/16/22 三个纯文本请求各 ~5 秒正常返回——故障与载荷绑定，不是链路抖动 | ✅ **已拆（2026-09-22）**：① **预算分账**——本轮带 MB 级附图（`SUSPECT_PAYLOAD_MIN_WIRE_CHARS`）时的挂起回到**计数预算**（`SUSPECT_PAYLOAD_MAX_ATTEMPTS = 2`），墓碑点名载荷与「重发同一张图不会变好」；无载荷线索的挂起**维持 15 分钟时间预算**（09-12 自愈行为零回归）。② **卷内留痕**——挂起类 warn 通知按 `STALL_NOTICE_MARK` 判据在卷内落一条**贴黄**（持久、插在正文之前、同回合只一条；非挂起 warn 仍只走 toast）。钉值 `tests/stall-visibility-and-drag-drop.test.ts`（6 例）+ `tests/agent-stream-stall-retry.test.ts`（既有 7 例零改动全绿） |
| I3 | `chat-core.ts::handleFileDrop`（自旧 Composer 迁入起就是 no-op：「T2 WebView 默认接管 dragDrop，网页层收不到 HTML5 drop 事件……纸壳不接（要做须走 Tauri onDragDropEvent 原生通道，**另立任务**）」）+ `image-intake.ts::extractImageFiles` 只认 `file.type.startsWith('image/')` + `ComposerDock.attachPaths`/`openFilePicker` 按 `imageCapable` 分流 | 拖放**从未在真机生效**；粘贴在资源管理器复制来的图上失手（CF_HDROP 交上来的 `type` 可能是空串 ⇒ 被 `type` 判据挡掉，且**零提示**）；夹选/拖放的图在声明缺失时被静默分流成「路径附件」（看着就是「图没进来」） | 2026-09-22 用户原话：「创作坞的粘贴/拖放操作刚才失灵了，所以我才给的目录路径让 agent 自己读」——**这正是 I1 的触发路径**（手打路径 → `fs(read)` → 工具附图通道 → 无规整） | ✅ **已拆（2026-09-22）**：① 新增壳行 `shell/rows/drag-drop.ts`（Tauri `onDragDropEvent` → `attachIntakePaths`，非 drop 阶段不触发；声明缺失只提示不拦截），`handleFileDrop` no-op 删除；② `extractImageFiles` 判据放宽为「type 是图 **或** 名字是图」（真守门人 = 下游 magic-byte 嗅探，非图在准入处换可见 toast）；③ 拆掉 `attachIntakePaths(…, allowImages)` 能力闸（与 2026-09-19「先发、被拒再降级」对齐——声明面只作 UI 提示）。钉值 `tests/stall-visibility-and-drag-drop.test.ts`（拖放三例）+ `tests/image-wire-budget.test.ts`（粘贴判据三例） |

**家族结论（写给自己与下一个人）**：I1 与 I3 是**同一个病的两端**——「能力/规整的判据散在多处，且每处都以为自己那半边是对的」。I3 让用户的图走不进正门（创作坞），I1 让图从侧门（工具通道）进来时没人量它的体积。**新增任何产图/收图通道时，先回答两句**：它过不过 wire 发送带？它的失败会不会在卷里留痕？（`readAttachmentForWire` 是发送带的唯一入口，别再开 base64 直通口。）

### I4（同日追查补记，2026-09-22）——附图**不计 token**：账本对图是瞎的

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| I4 | `agent/token-meter/estimate.ts`（构成测量只走文本分词器）+ `agent.ts::tokenCountWithEstimation()`（压力与压缩预检同一口径）+ `estimatePayloadTokens`（坞底墨量线的轻量口径） | **图是对话内容，却一颗 token 都不进账**：`measureEnvelope` 逐消息只 `countMessage`（文本），`m.images` 完全不看。于是有图时本地估算系统性小于提供方回报——实测会话 20 那轮「读图链路终于通了」：三桶估算 **20,457** vs `api_reported.prompt` **22,404**（差 ≈1.9k，其中含图 + 估算噪声）。后果两条：① 占用读数（墨量册/坞底墨线）有图时偏小；② **压缩压力判定少算**（step 前 pre-flight、响应式压缩的 `errAt > contextWindow * 0.6`、投影占用基准全走这条）⇒ 多图会话该压缩时不压 | 发现路径（值得记）：用户问「一张 9MB 的图发过去，上下文不爆吗」——顺着去对账才发现**四桶加总与提供方 `prompt_tokens` 在有图时不相等**，而这件事**没有任何检查会报**：两个数字并排躺在 `token breakdown` 日志里，没人对拍。当前路由窗口 1M 咬不到人；换成 128K/200K 的路由 + 多图，就会以「莫名 prompt too long」的形态冒出来 | ✅ **已拆（2026-09-22）**：口径改用提供方**发布**的视觉网格——`agent/token-meter/image-tokens.ts` 逐字移植 DSH `packages/llm/llm-deepseek/src/common/image-tokens.ts`（14px patch / 每轴 3:1 降采样 / 544² 像素下限 / 保比投影 / **单图封顶 1024 token**），图价并入**对话段**（不新开第四段：纸墨只有三阶墨、占用条三段几何不动）；`countImageTokens` 在 `measureEnvelope` / `tokenCountWithEstimation` / `estimatePayloadTokens` **三处同源**求和（口径纪律④的「同一把尺子」= 文本分词器 + 图网格**加起来**那一处）；诊断行加 `images: {tokens, count}` 与 **`api_delta`**（本地估算 − 提供方 `prompt_tokens`，正 = 估高）——差额持续非零就是「该换口径了」的探针（换非 DeepSeek 血统的视觉路由时网格系数不再成立）。**量级纠正**：事故那张 2560×1400 / 6.46MB 的图 = **991 token**（封顶内），不是按像素/字节外推的万级——**字节是传输面，token 才是上下文面**，两者在这一案里差了三个数量级的直觉。钉值 `tests/image-token-pricing.test.ts`（14 例；其中五例逐值锚 DSH 发布算法测试 422/968/832/1024/992 = 移植不漂的机器化判据） |

## 第十二批审计（2026-09-22）— 坞内视口级浮层家族（用户报「点开图整个创作坞被图片覆盖，图片预览也没办法收回」）

**用户口径**（关键，决定主凶）：贴图进创作坞 → **点缩略图** → 坞被图糊住、**收不回**（鼠标键盘都不行）。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| M1 | 坞槽 `.pp-composer-slot`（`transform: translateX(-50%)` = 版心居中的实现手段）× 坞内两处**视口级**浮层：`.pp-image-lightbox`（附图预览）与 `.pp-mode-dialog-backdrop`（全放二次确认），两者都是就地渲染的 `position: fixed; inset: 0` | **transform 祖先是 `position: fixed` 后代的包含块**：`inset: 0` 量的是**坞的盒子**而不是视口 ⇒ 浮层只有坞那么大。预览更甚：图 `max-width: min(86vw,1200px)` 远大于坞、几乎盖满遮罩，而关闭判据是 `e.target === e.currentTarget`（点哪儿都落在图上）；坞槽同时是 `z-index: 6` 的层叠上下文（坞内 `z-index: 95` 出不去）；Escape 又挂在**不可聚焦**的 div 上（焦点在缩略图按钮上，事件不经过它）⇒ **开图即死锁**（唯一出路 = 移除附图或重载页面） | 只在**默认坞位**上炸：坞被拖动后浮动化会写内联 `transform: none`，陷阱自消——而默认坞位正是绝大多数时候的坞位 | ✅ **已拆（2026-09-22）**：两处浮层归位成它们本来的身份 = **全局模态**——`createPortal(…, document.body)`（同 media 渲染器大图预览 `.pp-media-preview-overlay`），Escape 改走 `useDialogEscape`（document capture，与焦点无关）；`.pp-image-lightbox` 的层级随之换轨 `z-index: 95` → `var(--z-dialog)`（挂到 body 后要与 `.pp-root` 的 280 同台比，留坞内小档 = 点开一片黑）。**未动宿主面**（`useDialogEscape` 本就在 faceDeps 在册）⇒ 指纹不变、**只换产物即生效，无需重建 exe**。钉值 `tests/composer-dock-image-preview.test.tsx`（浮层在坞子树外 + Esc/点遮罩收回）+ `tests/paper-visual-decisions.test.ts` B4「点击放大浮层取全局模态档」（含 `--z-dialog > .pp-root` 数值对拍） |

**家族结论（写给自己与下一个人）**：坞槽是**带 transform 的定位容器**，于是一身两职——它同时是包含块与层叠上下文。坞内浮层因此只有两种合法形态：① **铺满视口**（`fixed; inset: 0`）⇒ 必须 portal 到 body 并取高阶全局模态档 `--z-dialog`；② **锚在坞上**（跟着坞走的菜单/面板：`.pp-slash` / `.pp-yin-panel` / `.pp-help-sheet`）⇒ 就地 `position: absolute`（本族不受影响，它们本来就该被坞框住）。**别再往坞里塞第三种。**

顺带一条**产物域约束**（本批撞过、构建期才现形）：插件目录之外的 JSX 文件进不了产物——构建用 `--jsx-import-source=./host`，`app/overlay.tsx` 里的 JSX 会被 esbuild 按**它自己的相对路径**解析 `./host/jsx-runtime`（该处无此文件，`Could not resolve` 直接红）。所以「坞内直接用 `Overlay` 原语」这条路要么改产物域写法，要么把 `Overlay` 加进 `host.ts` ⇒ 撞 host-modules 的 FaceBridgeSeal ⇒ 宿主面指纹变 ⇒ **须重建 exe**（本批工作树里另有在途改动，重建会把它们编进 exe——正是 V1 那条「算式落产地域」要避的代价）。故本批只取**无 JSX 的两件**：portal 走 `react-dom`、Escape 走既有的 `useDialogEscape`。

## 第十三批审计（2026-09-23）— LLM 代理 CORS 头叠加家族（用户报「provider 刷新目录永远失败」）

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| N1 | `src-tauri/src/llm_proxy.rs::handle_inner`（上游响应头逐条透传 → 再追加本代理那套 CORS 头） | **CORS 头叠加**：上游自带 `Access-Control-Allow-Origin` 时，"透传 + 追加" 产出两条 ACAO；浏览器按 CORS 规范判 `'*, *'` 并**拒收整条响应**（请求 200 到过，前端只看到 `Failed to fetch`）。实测两端点都自带 ACAO（`api.commandcode.ai/provider/v1`、`opencode.ai/zen/go/v1`）⇒ 凡经代理的调用必失败；回退直连又被上游预检拦下（该行配了自定义头 `x-opencode-session`）⇒ 设置页「刷新目录」永远失败。指纹正合本图收录标准：**接缝靠人肉纪律**（"透传上游头"看起来天经地义）+ **真因被静默吞掉**（`fetchJsonWithTimeout` 任何失败一律折成 `null` → UI 只报「网络错误或端点无响应」）+ 单测全绿 | ✅ 已拆（上游 `access-control-*` 一律不透传，CORS 策略归代理独占；回归 `llm_proxy::tests::upstream_cors_headers_are_not_duplicated`——假上游自带 ACAO + credentials + expose，断言成品响应 ACAO 恰一条、凭据头不外泄；**先证红**（`left: 2`）再转绿）。**端到端已验**（2026-09-23，真机页面 + 真实凭据 + 真实上游）：以行为等同修复后代理的本地替身（转发时丢弃上游 `access-control-*`）代跑「刷新目录」，两端点均读到目录——opencode 33 个模型 / commandcodegoat 80 个，上游皆 200 且**各自自带 ACAO**（叠加来源当场坐实） |

**取证路径（CDP attach 运行中的壳——值得复用）**：WebView 是只读可观测面，壳已带 `--remote-debugging-port=9222`；`GET /json/list` 取页面 target → WebSocket 上 `Runtime.evaluate` 在**页面真实上下文**里复现请求（本次：经 `127.0.0.1:14570/proxy` 拉目录）+ `Log.enable` 收 CORS 原文 + `Network.responseReceived` 收成品响应头。两条绕路都不通：PowerShell/curl 不执行 CORS（同一响应 curl 200、浏览器拒收），WebView 里 `headers.get('access-control-allow-origin')` 看不见（未 expose）——**"只有浏览器看得见的那一层"必须问浏览器**。

**家族结论**：反代是 CORS 策略的**唯一作者**——上游响应里属于"浏览器协议面"的头（`access-control-*`）一律不得透传；也别再把"透传上游头"当默认正确。**同批欠账（2026-09-28 已拆，见第十五批 A3）**：`provider/shared.ts::fetchJsonWithTimeout` 把任何失败折成 `null`，CORS／401／DNS 在 UI 上是同一句话——现已回传 `status`，三方言按「有没有发凭据 + 状态码」分流文案（其余形态沿用原句，零回归）。

## 第十四批审计（2026-09-26）— provider 配置面家族（用户报「文件建不出来」→「设置页莫名其妙丢 key」）

**用户口径**：问 provider 配置文件在哪 → 紧接着补一句「我怀疑这个文件建不出来呢…我感觉这个东西有问题呢」。**用户的怀疑是对的，而且它已经这样静默了两天**——全盘搜不到 `providers.yml`，而设置页写着「写配置文件失败：未打开工作区，请先打开项目」。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| Q1 | `rpc.rs` 的 `providers_dir` 分支（`ok_json(r)`，`r: Result<String, _>`） | **String 被序列化成带引号的 JSON 文本**（`"C:\\Users\\…"`），而契约声明 `result: string`、前端按裸串直读（`typedRpc`）⇒ `looksLikePath()` 见首字符是 `"` 判「不是路径」 | 2026-09-23→09-24 之间 provider 文件通道整体降级成内置存储：既不建文件也不迁移。同族 `composition_dir` 先修并**在注释里点名了 `providers_dir`**，却漏改本体 | ✅ 已拆（`3c25f976`，2026-09-24）：裸文本返回。取证 = ui.log 里 14 条 `provider-doc / providers_dir 返回的不是路径`，最后一条 `2026-09-24T10:56:39Z`，与修复 commit（`19:06:25 +0800`）时间严丝合缝 |
| Q2 | `utils/path_resolve.rs::resolve_path_user_read/write` 的 `get_ctx(state)?` × `sandbox.rs` 的用户级白名单豁免 | **「豁免项目沙箱」被实现成必须先有一个项目**：白名单（`~/.lantai/**`）的裁决只看 home、与 `project_root` 无关，但拿到 `Sandbox` 实例必须先 `get_ctx`，而工作区打开前它**恒失败**（`main.rs` 启动即 `Mutex::new(None)`，唯一写入点是 `workspace_activate`） | 壳启动早期两处用户级配置读写全被「未打开工作区，请先打开项目」挡死：① provider 配方**存量迁移写盘**（bootShell 第 0 步；工作区要到**第 3 步壳行**才打开）⇒ `~/.lantai/providers.yml` **永远建不出来**；② `~/.lantai/mcp.json` 读取（main.ts 装载用户级 MCP）⇒ 被 `isUserMcpMissingError` 判成「非缺失」，静默降级成 0 个 server。指纹正合收录标准：**接缝靠人肉纪律**（「boot 第 0 步会读写用户级文件」这条隐式时序没人守）+ **真因被静默吞掉**（迁移失败只写内存 `fatal`，ui.log 一个字都没有）+ **单测全绿**（`providers-store.test.ts` 的 mock 把 `providers_dir`/`fs_cap` 全接管，`get_ctx` 那一环永远走不到） | ✅ 已拆（2026-09-26）：`sandbox.rs` 抽 `Sandbox::user_data_read/write`（**工作区无关**入口；放行体与 `resolve_read/write` 共用 `allow_user_data` 一处实现，**边界不放宽**——非白名单仍返回 `None`）+ `resolve_path_user_read/write` 先问豁免、再 `get_ctx`；迁移失败补 `log.error`（三处一起：设置页 fatal + console + ui.log）。回归 `sandbox::tests::user_data_paths_resolve_without_any_workspace`（含**前端真实送来的混合分隔符**形态 + 非白名单必须 `None` 的边界钉值）。壳全量 **513 + 集成 1 全绿** |
| Q3 | `provider/providers-store.ts::providersFileReady()` = `available && loaded && !fatal` | **空文档被当成了权威**——与设计件原文「磁盘上已有内容 ⇒ 文件就是权威」相悖。文件还空着时该判据也报「权威」，投影当场返回**空行表**，此后任何一次 `saveSettings` 都把 localStorage 里的意图剥掉 | 用户 2026-09-23 报「之前配好的供应商也没了」即此形态。此前唯一挡住它的是「迁移失败 ⇒ `state.fatal` 置位」这条**巧合**，而 `retryProvidersPath()`（设置页「重试路径」）与 watcher 重读都会 `state.fatal = doc.fatal` 把它清成 undefined ⇒ 巧合一破就丢配置 | ✅ 已拆（2026-09-26）：判据补 `&& !state.empty`；回归 `tests/providers-store.test.ts`「迁移失败 + 重读清掉 fatal：空文件仍不得算权威」——**先证红**（撤掉该条件即 `expected undefined to be 'https://opencode.ai/zen/go/v1'`，意图真被剥掉）再转绿 |

| Q4 | `settings-domain/SettingsPanel.tsx` 的两条 doc 重读路径（`onReload` / `onRetryPath`）用 `setSettings((s) => ({ ...s, providers: loadSettings().providers }))` | **`loadSettings()` 永远不含 `apiKey`**（唯一权威在系统凭据库，localStorage 无明文）⇒「把整个 providers 域换成它」= 把面板内存里刚回填的 Key 全清空 | 用户报「设置页有时候莫名其妙丢 key」，**关掉重开面板又恢复**（mount 的 `loadSettingsWithSecrets` 再回填一次）——所以 Key 从来没真丢，是面板内存态被冲掉。触发面正是 2026-09-24 配方改文件批新增的三条重读：外部手改文件 → watcher 广播 / **保存后 watcher 广播**（保存把 `providerDirty` 复位 ⇒ 下一次广播不再被 dirty 守卫拦住 ⇒ 刚保存完就可能「丢 key」）/ 「重试路径」。指纹合收录标准：**接缝靠人肉纪律**（“重读行表”看起来与密钥无关）+ **单测全绿**（既有面板测试的 mock 不返回 `credential_get`，Key 本来就是空的，被冲掉也看不出来） | ✅ 已拆（2026-09-26）：抽 `withCarriedKeys(s, disk)`（只补空位、不冲内存里已有的 Key），两条路径都改道它；回归 `tests/providers-store.test.ts`「外部改文件触发面板重读：已回填的 Key 不得被清空」——**先证红**（`expected '' to be 'sk-real-key'`）再转绿。`persistSecrets` 早有「空 key 不写凭据」护栏（2026-08-07），所以**从未真丢过**——本批拆的是显示面 |

**家族结论**：豁免的判据决定了它**能依赖什么**。`~/.lantai/**` 的放行判据只有 home ⇒ 这条路上任何 `get_ctx`（工作区句柄 / 权限 ctx / forward-map）都是**伪依赖**；启动早期调用它 = 自己造一个「工作区还没开就必然失败」的雷。同理，**用户级文件的读写不该排在「打开工作区」之后**——真需要工作区时，该改的是判据，不是调用点。

**第二族结论（Q4）**：**「重读磁盘」≠「重读全部状态」**。`loadSettings()` 是个**投影**（文件行表 + localStorage 运行态），**密钥不在其中**——凡是要用它的产物替换 UI 内存态的地方，都得显式把「不在这份投影里」的字段带过去（本处 = `apiKey`）。同一个文件里既有正确范式（mount 的 `loadSettingsWithSecrets` + 只填空位、不冲用户已输入的），也有反例（两条整体替换）——**范式写对了，不等于每个后来者都抄得到**。

## 第十五批审计（2026-09-28）— 无 Key 面家族（用户报「provider 是不是只能在工作区配」→「本地模型填了占位符也连不上」）

**用户口径**：先问「provider 是不是只能在工作区里配置，首页似乎配不了」，再问「provider 是不是严格要求必须填 KEY——调用本地模型时即使填占位符也连不上，或者 key 没被保存下来」。**两句都是真 bug**：第一句 = 第十四批 Q2/Q3 在**已发布 v1.0.4** 上的合流形态（见上「发布缺口」）；第二句拆开是两个独立病灶（A1 缓存打错实例、A2 本地端点被硬闸排除）。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| A1 | `settings-domain/provider-data.ts`（+ `ProviderPage.tsx`）的 `await import('../../../provider/credentials')` / `('../../../rpc-contract')` × 产物构建 `build-builtin-plugins.mjs` | **相对动态 import 绕过了宿主桥重定向**——onResolve 只认静态 `./host`，于是 esbuild 把内核模块**整份内联成产物私有副本**（自带模块级状态 `_keyCache`） | `persistSecrets` 的写穿失效打在**副本**上，内核那份（`provider/live.ts` 每请求现读的）纹丝不动 ⇒ 该 provider 名此前解析出的空值被负缓存钉住，**整个进程生命周期**读不回新 Key：设置页显示已保存、凭据库确有值、请求却恒报「未配置 API Key」，**重启才恢复**——用户读作「key 好像没保存下来」。触发面天然命中本地模型：先无 Key 建行 → 首次对话把空值写进负缓存 → 之后补 Key 也不生效。同族：`rpc-contract` 副本没有内核的 rpc 插桩，收到的 ui.log 因此答不出「Key 写没写」（第十四批诊断面的半截）。指纹合收录标准：**接缝靠人肉纪律**（「产物里也能 import 内核模块」看着无害）+ **单测全绿**（`settings-secrets.test.ts` 跑在**开发域**，同一动态 import 解析到内核真身 ⇒ 两域形状一致、语义不一致） | ✅ 已拆（2026-09-28）：两处改走 `./host`（宿主桥 = 内核同一实例）；构建脚本加**第一道**自包含检查 `scanArtifactSources`（判据真源 `scripts/lib/artifact-dynamic-imports.mjs`：值位置的相对动态 import 一律拒建，注释与 `typeof import()` 类型位豁免）+ 回归 `tests/artifact-self-contained.test.ts`（名册逐目零命中 + 构建脚本仍挂该检查）。取证 = 产物 `settings-domain/entry.js` 内**两份实现并存**（私有 `_keyCache` / `init_credentials` vs 桥面 `impl.invalidateCredentialCache`），而 `persistSecrets` / `removeSecret` 调的是前者 |
| A2 | `provider/live.ts` 的空 Key 请求前闸（抛 `MISSING_CREDENTIAL`）+ `settings-domain/ProviderPage.tsx` 两处「请先填写 API Key」（测试 / 刷新目录）+ 三方言无条件发凭据头（`openai.ts` 的 `Bearer ${apiKey}` / `anthropic.ts` 的 `x-api-key`） | **本地端点被结构性排除**：`AddProviderSheet` 写着「API Key（可选——本地端点无需）」、拉取注释也「无 Key 也尝试」，但对话 / 连接测试 / 刷新目录三条路全被空 Key 拦死 ⇒ 本地模型（Ollama / LM Studio / llama.cpp）永远用不了，唯一出路是填个假占位符（而占位符又常被 A1 吃掉） | 用户报「本地模型调不动」即此形态——事故 log 里 `8080` / `127.0.0.1` / `localhost` 出现 **0 次** = 请求根本没发出去（[log-observability-plan.md](plans/log-observability-plan.md) §8） | ✅ 已拆（2026-09-28，用户裁定「空 Key 一律放行，但不许变成静默 401/403」）：撤请求前闸（`prewarm` / `fetchModels` 的空 Key 短路同批删除）；三方言空 Key 时**整条凭据头缺席**（不发空 `Bearer `——空头会被部分网关判成「提供了无效凭据」）；401/403 文案分岔（`classifyError` 的 `keyless` 支：本行没有 API Key / 本地端点核对地址端口、云端去设置填 Key）；状态列「探针通过优先于有没有 Key」。判据 = `llm-adapters/shared.ts::sentCredential(headers)` 读**实际发出的头表**（不靠方言另传标志，改头不会漏同步）。契约升版 v54 |
| A3 | `llm-adapters/shared.ts::fetchJsonWithTimeout` 把任何失败折成 `null`（第十三批登记的「同批欠账」） | 401／DNS／超时在 UI 上是同一句话 | 空 Key 的云端行点「刷新目录 / 从 API 拉取模型」得到「网络错误或端点无响应」——把人指向查网线而不是去填 Key | ✅ 已拆（2026-09-28）：返回值改 `{ json, status }`，三方言经 `modelsFetchFailure` 分流（无凭据 + 401/403 → 同一句 keyless 文案；其余形态沿用原句，零回归） |
| A4 | **产物模块图的既有内联面**（A1 同族）：`renderers` / `paper-shell` / `settings-domain` / `compose-dock` / `paper-renderers` 五个面产物各自内联了一批插件目录外的内核模块 | 面产物「直引内核路径」= 那些模块在产物里长第二份（副本）；其中**带模块级状态**的七个是真雷：`paper/block-model.ts`（`let blockSeq` 发号器——产物的 createBlock 与内核各发各的号，块 id `pb{n}` 可能撞）、`bridge.ts` / `rpc-contract.ts`（计数与插桩）、`agent/logger.ts`（`logPath`+buffer——副本未 initLogger ⇒ 面产物这几条日志**丢条**）、`agent/obs.ts`（去重表）、`state/toast-store.ts`（zustand store——**这条最狠**：`ToastHost` 是 toast 通道的**唯一渲染器**而生产者（chat-core/chat-session/workspace…）全在内核侧，两份 store = 生产者写 A、渲染器读 B ⇒ **打包态 toast 一条都不显示**；开发/测试域单实例，单测全绿也照不出来）、`settings.ts`（投影 + 订阅表） | ✅ **已全销（2026-09-28）**：① 门禁落地 = **账本合一**（施工单 `docs/archive/kernel-tooling-line/artifact-inlining-payoff-plan.md` W0）——**唯一声明面 = 名册 `builtin-roster.json` 各条目的 `shared`**（回读 `spec.shared` + 三个构建全局件 `react-bridge.cjs`/`face-css.ts`/`contribution-helpers.ts`），原先另一本平行快照账 `scripts/lib/artifact-input-baseline.json` **已删**（属负债）；带状态的欠账清单挪进 `scripts/lib/stateful-kernel-modules.json`。② **toast 通道**（`b7a73a3c`）：`ToastHost.tsx` 改走 `./host`——paper-shell 输入 **168 → 73**，连带清掉 `bridge` / `rpc-contract` / `logger` / `obs` 四个副本。③ **W1 块发号器**：`createBlock` 挂进 renderers 桥（`rendererCreateBlock`）+ `paper/translate`（值面就是 createBlock）整体改走 paper-renderers 桥（`isDiffLang`）——`renderers` 767→766、`paper-renderers` 65→63 输入，两产物 `let blockSeq` / `function createBlock` 命中 **0**。④ **W2/W3 = 一条传递闭包**：`settings.ts` 与 `rpc-contract.ts` 各只被**一处**值引用（`ProviderPage.tsx` / `ComposerDock.tsx`），改走各包 `./host` 后 `bridge → rpc-contract → logger` 整串消失——settings-domain **121 → 31**、compose-dock **455 → 365** 输入。⑤ 顺带校准：名册 `shared` 改按**实际输入集**写（删掉一批「实现早已归家、声明还留着」的化石条目——`paper/group.ts`/`virtualize.ts`/`selection.ts` 三件连内核文件都不在了）。宿主面指纹 `04374de9` → `251cbd2a`（新增 `createBlock` / `isDiffLang` / `getActiveProvider` / `updateProvider` 四键）⇒ **须重建 exe**。**余欠账：本批清零**（39 产物构建零 ⚠ 行） |

**家族结论**：**「产物域」不是隔离带，是同一进程里的第二份模块图**。同一个 import 说明符在 bundle 域与产物域会落到**两个不同实例**——凡是被内联者带模块级状态（缓存 / 账本 / 注册表 / 计数 / store），跨域调用就是「打在自己的影子上」。宿主桥（`./host` → `faceDeps`）是唯一合法通道，而它**只认静态 import**：动态 import 正是绕过它的后门 ⇒ 这条判据值得做**构建门禁**（已落），不能靠人记。
**A4 的三种形态（都已见过实物）**：① **动态 import 绕桥**（A1：凭据缓存失效打错实例）；② **静态直引内核路径**（toast store：唯一渲染器读副本 ⇒ 通道整条死）；③ **传递闭包**（一个直引拖进整串内核模块——toast store 一条边就带进 `obs` → `logger` → `rpc-contract` → `bridge`）。三者共同的可观测特征：**开发/测试域全绿**（单实例），只在打包态现形。

**第二族结论（A2）**：**「可选」的字段配一条硬闸门 = 产品自相矛盾**。添加弹层说 Key 可选、详情页说本地端点无需，而真值只在 `provider/live.ts` 的请求前闸里——用户读到的每一句都在撒谎；且失败面（`MISSING_CREDENTIAL`）只在**请求根本没发**时出现，正好落进「log 什么都答不出来」的盲区（与日志可观测性批的触发事故同源）。**修法纪律**：放行之后，鉴权失败的**归属**必须由「到底发没发凭据」判定，而不是由「有没有配 Key」判定——前者是事实，后者是猜测。

**同族仍未拆（诊断面）**：Q2 的失败此前完全静默，是本批藏了两天的主因；此处已补日志，但「内存态 fatal 不落日志」这种写法在别处是否还有，未逐处清查。

**⚠️ 发布缺口（2026-09-28 核对）**：本批四颗雷里只有 Q1（`3c25f976`）进了发布线——Q2/Q3/Q4 的修复 commit（`0b75e5d6` / `2730e5bd`）**晚于 `v1.0.4` tag**（`git merge-base --is-ancestor 0b75e5d6 v1.0.4` = 否）。所以用户报「provider 只能在工作区里配置」（= Q2 的沙箱工作区闸 + Q3 的空文档夺权威在**首页**同时发作：读被挡 ⇒ 空文档算权威 ⇒ 行表空；写被挡 ⇒ 保存管道首步失败即中止，Key 也不落凭据库）**在 v1.0.4 上是真实存在的**，用户侧要等下一个发布才消失。取证与判据见本表 Q2/Q3 行。


