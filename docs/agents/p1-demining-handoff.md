# P1 拆弹交接 — 第二批八颗已拆（2026-08-08）

> 读者：下一个接手会话 / Agent。事实来源 = `docs/landmine-map.md`（P1 表护栏列）+ 本文。
> 上一批：`docs/agents/p0-demining-handoff.md`（P0 十二颗全拆）。

## 现状一句话

P1 十二颗已拆 **8 颗**（16/17/18/19/20/22/23/24），各自配回归测试；
测试基线 **cargo 224 绿 · tsc 0 错 · vitest 785 绿**。
剩余 4 颗（13/14/15/21）全是 M 级设计题（写放大与竞态类），地图明示「别赶工」，未动。

## 本批 commit（main 分支，按序）

| commit | 内容 |
|---|---|
| `77ab230` | P1-24 翻译缓存读路径补 stripLineNumbers（缓存 100% 不命中，无声烧 API 费） |
| `90f989c` | P1-22 BoardPersistence._ensureDir 失败不再假成功锁存（不置位+重试+warn） |
| `1429c64` | P1-23 审计日志写失败 eprintln 告警 + AtomicU64 计数 |
| `2582ff0` | chore：P1-23 补 dead_code allow |
| `5f54c05` | P1-16 exec_command 非流式 try_wait 忙等 → wait_child_blocking + spawn_blocking |
| `6775b86` | P1-17 BgJob.shared 改必填字段，持锁阻塞管道读分支从类型上删除 |
| `a4a34d5` | P1-19 MCP start 拆 begin/finish 两阶段 + 纪元戳；stop_mcp 去 try_lock 静默跳过 |
| `a31dd9f` | P1-20 LSP 初始化失败/超时 reap_failed_child 回收子进程 |
| `759637b` | P1-18 isolation 六命令改 &WorkspaceState + rpc.rs 全 spawn_blocking |
| `8e0d181` | docs：P1 表护栏列标已拆 |

## 计划外发现（已顺带根治）

1. **P1-24 附带热循环（P0-8 同族）**：`FileTranslatorPanel` 的 `computeStats` 是组件内普通函数，
   每次渲染换身份 → `startTranslation` useCallback 失效 → `useEffect([filePath, startTranslation])`
   每次 setState 后重触发 → **打开翻译面板即形成无限 read_file_content IPC 循环**。
   改 `useCallback([])` 根治，回归测试锁「read 恰好一次」。
2. **P1-17 真相**：`BgJob.shared` 的两个构造路径本就恒为 `Some`，阻塞读管道分支是纯负债——
   直接把字段改成非 Option，用类型系统删除分支，比修分支更彻底。

## 遗留观察（非雷，记录在案）

- `lsp_start` 的 30s init 等待仍内联在 async worker（`lsp_manager.rs` recv_timeout）——
  LSP 启动低频，未入地图，本次未动；如下次动 LSP 可顺手 spawn_blocking。
- P0-11 决策已落地：**PTY 后端保留**（用户拍板 2026-08-08），孤悬 RPC 面维持现状。

## 剩余 P1（第三批，需设计，别赶工）

| # | 雷 | 设计要点（地图建议） |
|---|---|---|
| 13 | agent-store index.json 读-改-写跨异步无锁 | 写链串行化，参照 BoardPersistence._writeChain |
| 14 | chat-session localStorage 回退使已删会话复活 | 复活前要求磁盘文件存在 |
| 15 | agent 侧会话全量重写（写放大） | 参照聊天侧增量 NDJSON |
| 21 | 前台 exec_command 子进程不进 ledger（非 Windows 孤儿） | 平台盲区，M |

## 拆弹纪律（沿用）

一次一颗（同类可合批）、每颗配回归测试、小步 commit；只拆接缝雷不碰风格债；拆完留护栏。
基线命令：`cd src-tauri && cargo test --bin hologram` · `cd src-ui && npx tsc --noEmit && npx vitest run`。
P0 批的人工验证清单（设置保存 / TimelineHUD / 聊天+子Agent+git diff）截至本批仍未执行，
本批改动面（MCP 启停、isolation、LSP、shell）建议一并实测：**切换项目（P1-19）、子 Agent
隔离合并（P1-18）、exec_command 长命令（P1-16）**。
