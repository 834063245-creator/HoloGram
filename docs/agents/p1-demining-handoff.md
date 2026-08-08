# P1 拆弹交接 — 第三批四颗已拆（2026-08-08）

> 读者：下一个接手会话 / Agent。事实来源 = `docs/landmine-map.md`（P1 表护栏列）+ 本文。
> 上一批：`docs/agents/p0-demining-handoff.md`（P0 十二颗全拆）· `docs/agents/p1-demining-handoff.md`（第二批八颗）。

## 现状一句话

**P1 十二颗已全拆（16 颗批次全清）**。本批四颗全是 M 级设计题（13/14/15/21），
设计参照物齐全，各自配回归测试；测试基线 **cargo 226 绿 · tsc 0 错 · vitest 798 绿**。

## 本批 commit（main 分支，按序）

| commit | 内容 |
|---|---|
| `d251c13` | P1-13/14：index.json 写链串行化 + localStorage 回退复活守卫 |
| `ae5a888` | P1-15：agent 会话增量写（agent_session_append NDJSON + 增量游标） |
| `b160fca` | P1-21：前台 exec_command 子进程进 ledger |
| `2024b67` | test：goal-persistence mockLiveFs 适配 agent_session_append（P1-15 收尾） |

## 各雷设计要点（写给复盘的）

### P1-13 index.json 读-改-写无锁（agent-store.ts）
- 旧：`_upsertIndex`/`delete` 是「list() 读 → 改内存 → write 写回」，中间多个 await 让出事件循环，
  并发 saveState 时后写者用旧快照覆盖前者的记录 → 丢 agent 索引。
- 新：`_mutateIndex(fn)` 把读-改-写包进 `_indexChain`（参照 BoardPersistence._writeChain）。
  fn 在链内执行，读到的永远是最新落盘值。`_upsertIndex`/`delete` 都走它。
- 回归测试：并发 save 两 agent 不丢；同 id 后写者赢；save+delete 交错不复活；多轮形状稳定。

### P1-14 localStorage 回退复活（chat-session.ts）
- 旧引爆路径：`deleteSessionFile` 写磁盘 `{deleted:true, savedAt:''}` + localStorage removeItem；
  若 removeItem 失败残留，`autoRestoreLastSession` 的 localStorage 扫描/回退因 `!data?.savedAt`
  采纳残留 → 已删会话「复活」（与 null 复活同构）。
- 新：**磁盘是权威，localStorage 只是加速器**。三处采纳前验磁盘文件存在且非 deleted：
  ① 扫描段（tracker 缺失）② 加载回退段 ③ ponytail 有对话会话扫描块。残留顺手 removeItem。
- 回归测试 ×3：deleted 标记不复活+清理、文件缺失不复活+清理、文件有效+ls 更新→采纳。
- ⚠️ 既有测试 `falls back to localStorage when tracked session has only system messages`
  固化了旧行为，按新规格补了磁盘背书（71.json mock）。

### P1-15 agent 会话写放大（agent.ts + agent-store.ts + rpc.rs）
- 旧：每轮 `saveState` 全量重写 session.json，O(全量)，对话越长每轮越贵。
- 新：
  - rpc.rs 新增 `agent_session_append`：写 `.hologram/agents/{id}/session.ndjson`（NDJSON），
    `rewrite=true` 时 truncate 重建，否则 append-only。
  - agent-store.ts：`save()` 不再写会话；新增 `appendMessages(id, msgs, rewrite)`；
    `load()` 优先读 NDJSON（逐行 parse），回退旧 JSON 数组 session.json。
  - agent.ts：`_persistedMsgCount` 增量游标；saveState 只 append 游标之后的新段；
    会话长度收缩（撤回）→ rewrite 全量重建；`setSession`（恢复/替换）重置游标。
- 回归测试 ×6：多轮增量、撤回 rewrite、setSession 重建、NDJSON 读取三态。
- ⚠️ 兼容：旧 session.json 仍可读（一次性迁移读取），不破坏既有持久化数据。

### P1-21 前台 exec_command 子进程不进 ledger（shell.rs + utils.rs）
- 旧：前台命令 spawn 后不进 BG_JOBS，切换工作区 `kill_all_bg` 杀不到 → 跨工作区残留
  （如占用 target 锁的 cargo）。
- 新：`register_fg_child`（不 spawn monitor — 前台路径自己等待并负责移除）；
  流式/非流式路径 spawn 后都注册；等待循环从 ledger 取 child 轮询；
  完成/超时/被杀后移除。流式超时转后台时 job 保留（共享 Arc 输出已排空）。
- 回归测试 ×2：ledger 注册可见 + job 移除后 wait 感知；完成后无残留。
- **平台盲区如实保留**：非 Windows `kill_tree` 只杀直接子进程，进程组孤儿根治需 setsid——
  不在本雷范围，记入地图护栏列。

## 计划外发现（本批）

1. **P1-15 测试适配遗漏**：goal-persistence.test.ts 的 in-memory FS mock 不认识
   `agent_session_append` → appendMessages 静默失败 → 会话未落盘 → load 读空。
   全量测试兜住，补 mock 分支（rewrite/append 语义与后端一致）。
2. **容错编辑模式缩进污染**：edit_file 容错模式对含 `/** */` 注释块+方法体的替换，
   偶发把注释缩进多打 4 空格。本批 4 个文件都中招，已逐一读文件修正。
   教训：替换大块代码后必须 read 回来核对缩进。

## 遗留观察（非雷，记录在案）

- agent-store 的 `load()` 目前无外部调用者（agent 恢复走 goal-manager 独立槽）——
  NDJSON 兼容读取是防御性实现，未走全链路测试。
- P1-14 顺手清理残留仅覆盖「扫描段」路径；用户主动删除仍走 deleteSessionFile 的 removeItem。
- P0 批的人工验证清单（设置保存 / TimelineHUD / 聊天+子Agent+git diff）仍未执行；
  本批改动面（agent 会话增量、前台 ledger）建议一并实测。
- ✅ **切换项目日常使用未卡**（用户 2026-08-08 确认）→ P1-19（MCP 启停）实机已验证基本稳；
  用户明确不愿做系统性实机验证，其余项以日常使用 + 单测为准，遇到异常再报。

## 下一站：rpc 返回值 Value 化（已立项，非本批）

P1 十二颗全拆后，地图仅剩根治级 L 项：**rpc 返回 serde_json::Value 替代预序列化 String**，
删除前端全部启发式解析，一次拆掉「双重编码」bug 家族。
- 用户 2026-08-08 拍板必须做，**不等「下次大动 IPC 层」的自然触发**（前提可能永不出现）。
- 未开工、未排期；开工前先清 P2 双重编码残留（DataflowPanel.tsx:313-322 等）热身 + 勘定范围。
- 规模参考：Rust rpc.rs 100+ match 分支返回类型 + 前端 141 个 rpc 调用点 / 95 处 JSON.parse 启发式。
- 需要新会话时读本段 + 地图根治级段即可接续，无需本批上下文。

## 拆弹纪律（沿用）

一次一颗（同类可合批）、每颗配回归测试、小步 commit；只拆接缝雷不碰风格债；拆完留护栏。
基线命令：`cd src-tauri && cargo test --bin hologram` · `cd src-ui && npx tsc --noEmit && npx vitest run`。
