# P0 拆弹交接 — 雷区地图第一批十二颗全拆（2026-08-08）

> 读者：下一个接手会话 / Agent。事实来源 = `docs/landmine-map.md`（每颗雷的护栏列已标 ✅）+ 本文。
> 最高纪律：`docs/adr/project-constitution.md` 四条架构约定——新代码违反即打回。

## 现状一句话

P0 十二颗雷全部拆除并各自配回归测试；测试基线 **cargo 211 绿 · tsc 0 错 · vitest 782 绿**。
**尚未做发布级人工验证**（`npm run build` + `cargo tauri dev` 实测）——用户下一步。

## 本批 commit（main 分支，按序）

| commit | 内容 |
|---|---|
| `a9464ea` | docs(adr): 项目宪法——四条架构约定（类型边界/单一权威源/异步纪律/错误不静默）+ AGENTS.md 置顶引用 |
| `46a744c` | P0-1 `hologram_call` 转 async + spawn_blocking（同步核心抽 `dispatch_engine`） |
| `d18033e` | P0-2 大响应护栏：`truncate_output` 提为 utils 共享（git×3/isolation）、base64 8MiB 上限、`guard_ipc_size` 128MB 硬护栏（图 3 处） |
| `cddb79c` | P0-3/4/5 落盘原子性：write_atomic 先删残留 .bak；graph.json 换 write_atomic+告警；permissions.json write_atomic + fail-open 告警 + 损坏拒追加 |
| `89f2bfa` | P0-6 message-store 仅「不存在」才删 inbox，读/解析失败保留+warn |
| `281d3c6` | P0-7 persistSecrets 返回失败列表+handleSave 据实 alert；P0-8 TimelineHUD 退避重试封顶 4 次；P0-9 saveSettings setItem 补 try + 会话备份 >1MB 跳过 localStorage |
| `095d3e7` | P0-10 setupAgent 覆盖旧 runtime 前 flushAllBoards + disposeAll |
| `416b15f` | P0-11 PTY 三修（见下方计划外发现） |
| `801a0b1` | P0-12 `lock_or_recover`/`read_or_recover`/`write_or_recover` 三 helper；codemod 替换 57 处 Mutex + 6 处 RwLock（14 文件），grep 清零 |

## 计划外发现（比地图更深的雷，已根治）

1. **P0-5**：`append_project_rule` 原逻辑在 permissions.json 损坏时静默清空用户全部规则重写 → 改为拒绝追加 + 告警。
2. **P0-11 挖出潜伏 bug**：Windows 上 portable-pty 的 `ChildKiller` **没有 Drop impl**——`kill_all` 注释声称「drop 时终止进程」是错的，所有被 kill 的 shell 都成孤儿。已改 `reap()` 显式 `kill()`。另探针实测：ConPTY 客户端死后管道不必然 EOF，`ClosePseudoConsole` 可能长阻塞 → drop 放分离线程吸收。
3. **PTY 前端早已不存在**：src-ui 无任何 pty 调用——后端是孤悬 RPC 面。**待用户决策：整块删（pty_manager.rs + rpc.rs 四分支 + portable-pty 依赖）还是保留。**

## 人工验证清单（用户执行）

1. 设置面板改 key 保存 → 正常报已保存；凭据写失败时应 alert 而非假成功
2. 无 timeline 事件的项目 → 左缘 HUD 不再空转（原无限 IPC 热循环）
3. 常规聊天 / 子 Agent / git 面板 diff 查看 → 确认 P0-1/2 的行为变化无感
4. ~~集成终端~~（UI 已不存在，无需验证）

## 下一批入口

- **P1 十二颗**：见 `docs/landmine-map.md` P1 表。注意第 24 条可提前——`FileTranslatorPanel.tsx:352` 翻译缓存因漏 `stripLineNumbers` 静默失效，用户一直在为重翻译白付 API 费（参照 `chat-session.ts:363` 正确用法）。
- **根治级专项目（L，需用户拍板）**：① RPC `Value` 化 + 边界 schema（病根一：String 当合约）；② settings 单一权威源（病根二：四地状态副本）。
- **图分页**：P0-2 只给了 128MB 硬护栏，kernel 级仓库会撞上限报错——真解是图分页/流式（M~L）。

## 拆弹纪律（沿用）

一次一颗（同类可合批）、每颗配回归测试、小步 commit；只拆接缝雷不碰风格债；拆完留护栏。
基线命令：`cd src-tauri && cargo test --bin hologram` · `cd src-ui && npx tsc --noEmit && npx vitest run`。
vitest 曾出现 1 次单测 flaky（两轮复跑全绿，未定位，如遇再现再查）。
