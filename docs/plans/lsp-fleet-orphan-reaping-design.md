# LSP 舰队孤儿回收（设计件 · Proposed）

> **状态**：未开工（2026-09-26 立项，等另开窗口施工）。施工面 = `engine`（`lsp_manager.rs` + `Cargo.toml`）。
> **由来**：2026-09-24 实测孤儿 `rust-analyzer.exe` PID 7160（当日 18:07 起，跨日存活）；同一轮实测
> rust-analyzer 常驻 2.9GB。**前置阅读**：[`docs/archive/kernel-tooling-line/engine-lsp-runtime-hardening-plan.md`](../archive/kernel-tooling-line/engine-lsp-runtime-hardening-plan.md)。

## 一、裁定（先看这个）

1. **第 0 步不是改代码，是复现**（§3）：当前有**三条**独立的「谁杀谁」路径，不先钉死孤儿出自哪条，
   任何修法都是猜。**没跑完 §3 的矩阵不许动手**（否则改完无法证明改对了）。
2. **结构性修法 = Windows 补 Job Object（`KILL_ON_JOB_CLOSE`）**，与 unix 已有的
   `PR_SET_PDEATHSIG` 对齐（[lsp_manager.rs:1453-1470](../../engine/src/lsp_manager.rs)）——
   这是**同一个不变量的两端**，现在只有一端。
3. **不做「启动时按进程名清理陈旧舰队」**：按名字 + 命令行杀别人的进程，会误杀 IDE 自己的
   rust-analyzer / gopls。只有在 §3 证明 Job Object 覆盖不到时才回头评估这一层。
4. **lspd 的 600s 空闲退出与端口协议不动**（它是干净出口，见 §2）。
5. **lspd 不改成 die-with-parent**（它按设计要活过单个引擎进程）。

## 二、证据与现状（代码事实，逐条可核）

**干净的出口（都存在，别重复造）：**
- 引擎正常退出：`LspShutdownGuard` 的 `Drop` → `shutdown_all()`
  （[main.rs:62-72](../../engine/src/main.rs)）。
- unix 信号路径：SIGINT/SIGTERM handler → `shutdown_all()` → `exit(0)`
  （[main.rs:76-90](../../engine/src/main.rs)；**`#[cfg(unix)]`，Windows 没有对应物**）。
- lspd 优雅退出：空闲超时或 `op=shutdown` → `shutdown_all()` → 删端口文件 → 退出
  （[lsp_daemon.rs:156-174](../../engine/src/lsp_daemon.rs)；集成测试 `test_bind_serve_status_shutdown_roundtrip`）。

**⇒ 泄漏只可能来自「进程没机会跑 shutdown_all」**，即硬杀 / 异常死亡。而三条路径的子进程关系是：

| 进程 | 谁拉起 | die-with-parent？ |
|---|---|---|
| `hologram-lspd` | 引擎 `spawn_daemon`（stdio 全 null + CREATE_NO_WINDOW，[lsp_manager.rs:1009-1020](../../engine/src/lsp_manager.rs)） | **故意不设**——同根共享舰队，设计上要活过单个引擎（见 `docs/archive/kernel-tooling-line/lsp-fleet-daemon-plan.md`） |
| 舰队（r-a / gopls / …） | lspd，或引擎的**本地池回退**路径（`spawn_server`） | **unix：有**（PDEATHSIG + ppid 复查）；**Windows：什么都没有** |

**Windows 是唯一缺口**——`spawn_server` 的 `#[cfg(windows)]` 分支只设了 `CREATE_NO_WINDOW`
（隐藏控制台），没有任何父子生命绑定。

**两条待验证的泄漏假说（第 0 步要判的就是它们）：**
- **H1｜父进程非树杀路径死亡**：`Stop-Process -Force` / 任务管理器结束 / panic abort ——
  Drop 与信号 handler 都不跑；Windows 又无 PDEATHSIG ⇒ 本地池舰队残留。
- **H2｜`taskkill /T` 追不到被「重新挂靠」的孙进程**：宿主硬杀受治进程走
  `taskkill /PID <pid> /T /F`（[protocol_bridge.rs](../../src-tauri/src/commands/protocol_bridge.rs)），
  而 `/T` 是**按 ParentProcessId 走链**的；npm 全局工具是 `cmd.exe /c <shim>.cmd` → 再拉 node
  （[lsp_manager.rs:1404-1422](../../engine/src/lsp_manager.rs)），**中间那层 cmd.exe 一退，
  孙进程的父 PID 就指向死进程**，`/T` 断链 ⇒ 残留。rust-analyzer 是直接 exe，不受 H2 影响——
  所以 9/24 那个 r-a 孤儿更可能是 H1（或 C 行：lspd 先死）。

## 三、第 0 步：复现矩阵（先跑这个，再把结论写回本件）

| # | 场景 | 制造方式 | 观察点 |
|---|---|---|---|
| A | 宿主树杀 | 应用内让引擎空闲回收（或对引擎 `taskkill /T /F`） | 引擎 + lspd + 舰队全无残留？ |
| B | 引擎异常死亡（H1） | 对**测试引擎**（`--project-root <临时根>`）`Stop-Process -Force` | 本地池舰队应死；现状大概率残留 |
| C | lspd 异常死亡 | 同上对 `hologram-lspd` | 舰队应死；现状大概率残留 |
| D | `/T` 断链竞态（H2） | 反复「分析中途杀引擎」（舰队正在被拉起） | 是否漏下标 |

**判据**：每次前后各取一次快照，**必须按命令行含项目根过滤**
（`Get-CimInstance Win32_Process` 读 `CommandLine`）——否则会把 IDE 自己的语言服务器算成孤儿。

> ⚠ **不许拿正在运行的应用开刀**：`hologram-engine.exe` 是用户 DSH 应用的子进程，杀了会自动重启并
> 误导排障（CONVENTIONS §3 实测纪律）。B/C/D 一律用**自己 spawn 的临时根引擎/lspd**。

## 四、结构性修法（Windows Job Object）

### 4.1 语义
拉舰队的那个进程建一个 Job：
```
CreateJobObjectW(NULL, NULL)
SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                        { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE })
AssignProcessToJobObject(job, <每个 LSP 子进程>)
```
持有 job 句柄的进程一死（`/F` 杀、panic abort、任务管理器结束、正常退出都一样），
内核关闭最后一个句柄 ⇒ **job 内全部进程被终结**。这正是 unix `PDEATHSIG` 的等价物，
且**不依赖 ParentProcessId**，因此天然覆盖 H2 的断链问题。

**job 的持有者 = 拉舰队的那个进程**：lspd 拉舰队 ⇒ job 归 lspd；引擎走本地池回退 ⇒ job 归引擎。
**`spawn_daemon` 不得进 job**（lspd 要独立于引擎存活——进了 job 就毁掉共享舰队设计）。

### 4.2 落点

| 文件 | 改动 |
|---|---|
| `engine/Cargo.toml` | `[target.'cfg(windows)'.dependencies] windows-sys = { version = "0.6", features = ["Win32_Foundation", "Win32_System_JobObjects", "Win32_System_Threading"] }`——与既有 `[target.'cfg(unix)'.dependencies] libc` 对称。**备选**：照 `src-tauri/src/pty_manager.rs` / `os_sandbox.rs` 的裸 `extern "system"` 先例手写三个符号（不加依赖，但少一层维护） |
| `engine/src/lsp_manager.rs` | 新私有模块（如 `child_job.rs`）：`struct ChildJob`（持 `HANDLE`，`Drop` 时 `CloseHandle`）+ `assign(&Child) -> Result<(),String>`（失败 **warn 不 fail**——绑不上不该挡查询）；`spawn_server` 在 `spawn()` 后立即 assign |
| 同上 | unix 侧 `pre_exec` **一行不动**；把两端语义写进同一段注释（防下一轮只删一端） |

### 4.3 实现注记（写代码时必须处理）
- **嵌套 job**：Win8+ 允许把已在 job 里的进程再 Assign 到新 job（引擎自己若被外层 job 收编也能绑）。
  仍要**冒烟验证一次**；失败时降级为 warn + 保留 `taskkill /T` 现状。
- **`Drop` 语义**：`ChildJob` 必须在**整个进程生命周期**持有（进程级 `static` / `LazyLock`），
  不能是局部变量——句柄一关就等于立刻杀舰队。
- **不要给子进程设 `CREATE_BREAKAWAY_FROM_JOB`**（那会把自己踢出 job，等于没做）。

## 五、验收

1. **§3 矩阵四行全部「无残留」**；B / C 两行是本次的**回归判据**（修前应残留 → 修后清零，
   两次快照都留档）。若 B/C 修前就不残留，**本件可以判定「无需修」并结案**——如实记录，不硬做。
2. **unix 行为零变化**：PDEATHSIG 路径不动，`cd engine && cargo test` 绿。
3. **新增冒烟测试**（真起进程，repo 先例：`protocol_bridge::tests::kill_process_tree_reaps_grandchildren`）：
   起一个持 job 的父进程 → 父进程内 spawn 一个长睡子进程 → **`/F` 杀父进程** → 轮询断言子进程消失。
   ⚠ 测试里杀的是**测试自己 spawn 的**父进程，绝不能碰应用的引擎/lspd。
4. `cd src-tauri && cargo test`（若顺带动了 Rust 桥的树杀逻辑才需要）。
5. **不改引擎契约面** ⇒ 无需升 `ENGINE_CONTRACT_VERSION`（除非动了 `engine/src/tools/**`）。

## 六、非目标
- 不做「事后按名字清理孤儿」（§一.3）。
- 不动 lspd 的空闲退出（600s）与端口文件协议。
- 不做跨 root 的舰队复用（属 `lsp-fleet-daemon-plan` 的既有边界）。
- 不解决「舰队反复重索引吃 3GB」——那条已由 `#1`（不再硬杀）缓解；彻底解决要持久化
  rust-analyzer 自身的索引缓存，属另一条线。
