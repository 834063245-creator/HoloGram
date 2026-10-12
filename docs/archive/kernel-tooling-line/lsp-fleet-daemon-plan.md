# LSP 舰队宿主共享化 Plan：每根目录一套 LSP（hologram-lspd）

> **已归档（2026-10-08 竣工）**——每根目录一套 LSP 舰队（`hologram-lspd`）已落；§7 欠账的唯一一项（`tauri.conf.json` 补 `hologram-lspd.exe` 映射）于同日补上，**余重建 exe 验证**——判据见 [`plans/README.md`](../../plans/README.md) 欠账表「随包 LSP 守护（打包补件）」。

> 状态：开工（2026-09-09）
> 拍板：用户 2026-09-09「多个窗口各带一个引擎、各自拉一套 LSP 服务器？这肯定不行」
> 触发事故：2026-09-09 凌晨 6 个引擎进程并行（多窗口各带一引擎）× 各自全量
> 分析 + 各拉一套 LSP 舰队，16GB 机器提交内存耗尽（gopls VirtualAlloc
> errno=1455，agent 图谱工具全线报错）。当日已落三闸止血（commit 016061ef：
> 内存门禁 + 超时不杀 + 重生退避）；本 plan 是结构性根治。

---

## 0. 问题账本

| 事实 | 出处 |
|---|---|
| 引擎进程外消费后，每窗口/CLI 会话各带一个 `hologram-engine serve`（stdio MCP 1:1） | engine-plugin-extraction Phase 2/3 拍板 |
| 当时只拍了「N×EXE 页可接受，典型 1-3 工作区」 | `docs/archive/engine-plugin-extraction.md` L78 |
| 漏算项：LSP 舰队不是共享 EXE 页——每引擎另拉 4 个重子进程（rust-analyzer 单套 1-3GB） | 2026-09-09 事故日志 |
| LspManager 是进程内静态单例（pool/project_root 都是进程级） | lsp_manager.rs `LspManager::global()` |
| 事故时 6 引擎 = 至少 4 套车队并存 + 6 份 ONNX + 6 份全量分析 | .hologram/logs/engine.log 2026-09-08T20:59-22:01Z |

三闸（016061ef）已把「打爆机器」变成「有序降级」，但 N 套舰队仍然
各查各的、各冷启动各的——重复内存 + 重复索引时间在单机上没有正当性。

## 1. 目标与非目标

**目标**
- 同一根目录 → 全机只有一套 LSP 舰队，N 个引擎进程共享
- daemon 不可用时引擎自动回退本地池（全部现有行为保留为降级链）
- 舰队懒生长：只有真实查询过的语言才占内存（比今天的 eager warm 更省）

**非目标（明确不做，防漂移）**
- 引擎单实例化（多客户端 MCP 服务）——更大重工程，另行立项；
  本 plan 只共享 LSP 舰队，不动引擎进程模型
- 图分析/工具面/ONNX/SQLite 的多进程重复——同上，不在本 plan

## 2. 架构

```
窗口A引擎 ──┐
窗口B引擎 ──┼── TCP 127.0.0.1:port ──▶ hologram-lspd（每 root 一个）
CLI会话引擎 ─┘                            │  内嵌 LspManager（唯一舰队持有者）
                                          └─ rust-analyzer / ts-server / pyright / gopls
端口发现：{root}/.hologram/lspd.port（create_new 原子仲裁）
日志落点：{root}/.hologram/logs/lspd.log
```

- **lspd 内嵌 LspManager**：三闸（内存门禁/重生退避/迟到回收/冷窗口）
  全部在宿主侧继续生效——它成了唯一 spawner，门禁只需在它身上成立
- **协议**：行式 JSON（一行请求 → 一行响应），op ∈
  `definition | implementation | hover | references | status | shutdown`，
  payload 即 LspManager 现有入参（file/source/line/column/ext）——
  LspManager 本来就是现成 seam，协议只是它的远程化
- **传输选 TCP 而非命名管道**：std 即有、跨平台零依赖；仅绑 127.0.0.1

## 3. 生命周期

- **懒拉**：引擎首次 LSP op 时按根目录发现——读端口文件 → connect；
  connect 失败 → spawn 同目录 `hologram-lspd --root <root>`（Windows 加
  CREATE_NO_WINDOW）→ 短轮询 → 仍失败 → 本地池降级（本 op 起 60s 内不重试拉起）
- **舰队懒生长**：daemon 启动不预 warm；首次某语言的查询才拉该语言的
  server（get_or_warm_server 惰性路径），内存面天然最小化
- **双拉仲裁**：daemon 绑 127.0.0.1:0 → 用
  `OpenOptions::new().create_new(true)` 抢写端口文件；败者读端口 →
  connect 验活 → 活着则安静退出
- **陈旧自愈**：引擎 connect 失败 → 删端口文件 → 重拉新 daemon
- **空闲退出**：无活跃连接且无请求持续 10 分钟 → shutdown_all 舰队 +
  删端口文件 + 退出（替代孤儿治理；被强杀时端口文件残留，靠下一轮自愈清理）
- **引擎退出不杀 daemon**：共享舰队跨引擎存活是特性不是泄漏；
  空闲超时负责最终回收

## 4. 引擎侧改动

| 位置 | 改动 |
|---|---|
| `lsp_manager.rs` | 新增 daemon 客户端：`connect_daemon/ensure_daemon/daemon_call`；四个公开 op（resolve_definition/resolve_type/find_implementations/find_references）**先 daemon 后本地池**；传输层失败（连不上/断流）→ 本地池；op 级错误（含 busy/门禁）→ 原样透传（busy 分类沿用 → retry_hint 生效）；进程级 `DAEMON_MODE` 标志防 daemon 自连 |
| `audit.rs` handler_status | daemon 在线 → `mark_initialized` + 本地不 warm + status 合并 daemon 的 lsp_status（标 `shared_fleet: true`） |
| `pipeline.rs` 分析后 warm | daemon 在线 → 跳过本地 warm_filtered（防双舰队） |
| `main.rs` 退出清理 | 不动——shutdown_all 只杀本地池，daemon 靠空闲超时 |

**busy 语义透传链**：daemon 侧 LspManager 的 "LSP busy: ..." 错误经
协议原样回引擎 → 引擎 err_is_busy 命中 → 工具 Degraded 给 retry_hint。
门禁拒绝同理（error 字符串进 engine_status 的 missing_lsp 面可见）。

## 5. 客户端细节

- 每 op 短连接（localhost connect 微秒级；连接态零维护，自愈天然成立）
- 读超时 15s（> 服务端 5s 超时 + 排队余量）；超时归类 busy
- 相对路径在客户端先转绝对（daemon 只收绝对路径）
- daemon 二进制定位顺序：`HOLOGRAM_LSPD_EXE` 环境变量（测试注入用）→
  current_exe 同目录；找不到 → 本地池降级（老环境/未打包不炸）

## 6. 测试面

- **协议往返**（lsp_daemon.rs 单测）：bind → connect → definition（未装
  server 的扩展名 → ok:false）→ status → shutdown → 端口文件清理
- **仲裁败者**：活 daemon 在位时第二次 bind 安静退出（Ok(None)）
- **陈旧端口**：写死端口文件（无监听）→ 引擎 ensure 失败回退本地池
- **daemon 自连防护**：DAEMON_MODE=true 时 op 不走客户端（防递归）
- **真二进制集成**（engine/tests/lspd_integration.rs，用
  CARGO_BIN_EXE 注入）：ensure_daemon 拉起真 lspd → status 往返 →
  shutdown op → 进程退出 + 端口文件删除
- **回归**：引擎全量 lib + hologram-vector；lsp_manager 既有 13 测试不红

## 7. 欠账（明确记录，不静默）

- 生产打包面：tauri.conf.json 的 externalBin 未列 hologram-lspd
  （该文件正被并行窗口占用，本批不碰；dev/CLI 面 target/release 同目录
  天然生效）。并行窗口收口后补一行 + 打包验证。
- 图分析/ONNX/存储的多进程重复：另行立项（见 §1 非目标）。
