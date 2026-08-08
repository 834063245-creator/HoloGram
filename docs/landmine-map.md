# HoloGram 雷区地图（技术债清单）

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
| 2 | `commands/graph.rs:16`、`hologram.rs:16`、`filesystem.rs:80`（read_file_base64）、`git_cmds.rs:65/78/265`、`isolation.rs:60` | **大响应无尺寸上限**——与 256MB 事故同一物理通道 | 大仓库图 JSON / 99MiB 文件 base64（~200MB 转义后）/ minified 文件 diff → 复刻 WebView2 击毁。注：git 系列没有 exec_command 那样的 32KB 截断 | ✅ 已拆（truncate_output 提为共享 + git×3/isolation 截断 + base64 8MiB 上限 + 图 128MB 硬护栏；图分页仍是 L 级欠账） | S~M（截断/上限；图分页是 M） |
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

| # | 位置 | 雷 | 成本 |
|---|------|----|------|
| 13 | `agent-store.ts:168-184` | index.json 读-改-写跨异步无锁，多 Agent 并发 saveState 互相覆盖；state/session/index 三文件可留下矛盾现场 | M（写链串行化，参照 BoardPersistence._writeChain） |
| 14 | `chat-session.ts:519-537` | localStorage 回退使已删会话「复活」——与 null 复活同构（删除只删了一个存储） | M（复活前要求磁盘文件存在） |
| 15 | `agent.ts:792` + `agent-store.ts:93` | 每轮对话全量重写会话（O(全量) 写放大；聊天侧已有增量 NDJSON，agent 侧没有） | M |
| 16 | `commands/shell.rs:258-318` | exec_command 非流式路径 `try_wait`+sleep 忙等，最长占 worker 300s | S~M |
| 17 | `utils.rs:305-325` | bash_wait 非 shared 分支**持 BG_JOBS 锁做阻塞管道读**；非 Windows 可继承管道 → 孙进程持写端 → 永久阻塞 → bash_* 全瘫（Windows 靠不可继承管道幸免） | M |
| 18 | `commands/isolation.rs:8-164` | worktree 生命周期操作全部是阻塞进程等待内联在 worker 上 | S |
| 19 | `external.rs:25-43` + `mcp_manager.rs:120` | MCP start 持锁最长 600s；此时 stop_mcp try_lock **静默跳过** → 旧 serve 进程残留 + 新 start 卡死 =「切换项目卡死」 | M |
| 20 | `lsp_manager.rs:87-92` | LSP 初始化失败/超时返回 Err 前不杀子进程，每次重试泄漏一个语言服务器 | S |
| 21 | `shell.rs:73` | 前台 exec_command 子进程不进 ledger；非 Windows 无 Job Object → 孤儿进程（平台盲区） | M |
| 22 | `agent/board-persistence.ts:57-81` | _ensureDir 失败后照样 `_dirReady=true` → board 永不落盘且永不再试，重启全丢，零信号 | S |
| 23 | `src-tauri/src/audit.rs:34-45` | 审计日志写失败静默 → deny/审批不留痕，安全功能失效无法取证 | S（eprintln + 计数） |
| 24 | `ui/FileTranslatorPanel.tsx:352` | read_file_content 缓存路径漏 stripLineNumbers → 翻译缓存 100% 不命中（已在坏，无声烧钱） | S |

## P2 — 存疑/低危（记录在案，暂不拆）

- `agent/aura-memory.ts:27,33`：裸 JSON.parse 靠调用方包 try（目前唯一调用方恰好有）——接缝纪律型
- `agent/goal-manager.ts:123,206`：parse 有 try 但无形状校验（:143 有正确示范没跟上）
- `message-bus.ts:158`：unregister 删 inbox 失败 → 死 agent 的 request 消息重启复活（消费路径未证实，存疑）
- `DataflowPanel.tsx:313-322`：typeof==='string'?parse:原样 的双重编码启发式残留
- ~30 个死 `#[tauri::command]` 属性（未注册进 invoke_handler）——谁误注册谁把重活带上 UI 主线程，建议清理
- `agent-identity.test.ts:62` 把「saveState 吞错不抛」**当规格断言固化**——拆 ① 类吞错时需先松绑测试

## 已确认健康（不要再动）

- 凭据/设置接缝：读写单一入口 + parseRpcString 集中 + 长度/null 四护栏（三轮事故修复后最健康的区域）
- 前端 95 处 JSON.parse 的 try 覆盖率很高——**解析层已吸取教训，写入层还没有**
- `write_atomic` 范式、`confined_fs` 100MiB/超时/spawn_blocking 三件套、shell 输出 32KB 截断——正确范式已建立，问题是覆盖不全

## 根治级（L，另立项目）

**rpc 返回值 Value 化**：`rpc` 命令返回 `serde_json::Value` 替代预序列化 String，删除前端全部启发式解析。一次拆掉整个「双重编码」bug 家族。建议在下次大动 IPC 层时做，不单独启动。

## 建议拆弹顺序

1. **第一批（P0 全部，~1 天）**：12 颗全是 S 级，每颗配回归测试，一次一颗小 commit
2. **第二批（P1 的 16/17/19/22/23，~1 天）**：阻塞持锁与吞错类
3. **第三批（P1 剩余，按需）**：写放大与竞态类，需要设计，别赶工
