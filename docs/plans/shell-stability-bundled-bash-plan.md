# Shell 稳定性收口：捆绑 MSYS2 bash + dsh 式执行纪律

> 状态：2026-08-15 **P0-P5 全部落地**（`0f843f0` / `03468b0` / `1a16ea1` / `e9e62bb` / P5 提交见 shell 系列 commit）；P5 形态 = `shell(run, interpreter:"pwsh")` 参数而非新动作
> **待办：Windows 真机实跑验证（§4 基线命令）——本批代码的 cfg(windows) 路径未在 Windows 编译/实跑过**
> 动机：shell 能力不稳定（解释器探测分叉 / PATH 继承随机 / 编码无契约 / taskkill 杀树不可靠）
> 参照：deepseek-harness `packages/shell/`（pwsh 钉死 + 编码前置 + 单 argv + env 归一 + spill）与现有 `os_sandbox.rs`
> 决策：**捆绑钉死版 MSYS2 bash 为主解释器**（用户无商用顾虑，GPL 聚合可接受），照抄 dsh 四条执行纪律，Job Object 杀树升级为每命令独立 Job + `TerminateJobObject`（超过 dsh 与现状双方）

## 0. 目标形态

```
Agent shell(run) ──> Rust spawn_shell ──> 捆绑的 bash.exe -c <cmd>（单 argv，无引号层）
                                            │ env: LC_ALL=C.UTF-8, NO_COLOR=1, PAGER=cat, GIT_PAGER=cat,
                                            │      MSYS2_ARG_CONV_EXCL=*, PATH=归一化 PATH
                                            └─ 每命令独立 Job Object（DIE_ON_JOB_CLOSE | KILL_ON_JOB_CLOSE）
                                                kill_tree = TerminateJobObject（同步、确定性、零漏杀）
输出：内存 cap 64KB + spill 落盘 64MB + truncated/lossy 标志（对齐 dsh 数字）
解释器健康自检注入 system prompt（shell_env 扩展）
```

## 1. 批次划分（每批绿了才 commit）

| 批 | 内容 | 验证 |
|---|---|---|
| P0 | 下载 MSYS2 包（bash/coreutils/sed/grep/gawk/findutils/diffutils/tar/gzip/which + 依赖 DLL），objdump 解析依赖闭环，vendor 进 `src-tauri/vendor/msys2/`，tauri resources + `THIRD_PARTY_NOTICES.md` GPL 声明 | 目录完整 + 依赖闭包脚本自检 |
| P1 | 钉死解释器：`os_sandbox::init(app)` 解析 resource_dir 缓存捆绑 bash 路径；`spawn_shell` 主路径用捆绑 bash；Git Bash/探测降级为仅当资源缺失时的回退（大声告警）；`shell_env()` 上报捆绑版本+解释器健康自检 | Linux `cargo check` 通过；Windows 由用户实跑 `cargo test os_sandbox` |
| P2 | 每命令独立 Job Object（`CreateJobObjectW` 每 spawn 一次，`DIE_ON_JOB_CLOSE|KILL_ON_JOB_CLOSE`，无 BREAKAWAY）+ `TerminateJobObject` FFI 替换 `kill_tree` 的 taskkill；`SandboxedChild` 持 job 句柄，Drop 时 CloseHandle（= die-with-parent）；保留 `assign_to_job` 全局 Job 给 LSP/MCP 不动 | Windows 实跑杀树测试（spawn cargo 树 → kill_tree → 无残留） |
| P3 | PATH 归一化：init 时 `reg query` 读用户/机器 PATH + 探测 `~/.cargo/bin`、`%APPDATA%\npm`、scoop shims、choco bin，合并缓存注入每个子进程；编码/env 纪律（上表） | 纯函数（合并/去重/优先级）单测 Linux 可跑 |
| P4 | 输出纪律：`utils` 新增 CollectOutput（内存 cap 64KB + spill 64MB + truncated/lossy），接入非流式路径与 bg 读取，TS 结果渲染带截断标记 | utils 纯逻辑单测 Linux 可跑；Windows 大输出实跑 |
| P5（后续窗口，可选） | `shell(ps)` 副动作：pwsh `-NoProfile -NonInteractive -Command`（dsh 式）给注册表/ACL 等 Windows 原生任务 | 下窗口 |

## 2. P0 细节：MSYS2 包清单与依赖闭包

- 源：`https://mirror.msys2.org/msys/x86_64/`（当前版本以 `*pkg.tar.zst` 元数据为准，版本号写死进 NOTICE）
- 功能包：`bash`、`coreutils`、`sed`、`grep`、`gawk`、`findutils`、`diffutils`、`tar`、`gzip`、`which`
- 依赖闭包：每包解包后用 `objdump -p *.exe/*.dll` 抓 `DLL Name`，缺哪个补哪个包（预期：`msys2-runtime`(msys-2.0.dll)、`libintl`、`libiconv`、`libpcre2_8`、`libreadline`、`zlib`、`libbz2`、`liblzma`、`libzstd`、`libgmp`、`libmpfr`、`libncursesw`）
- 目录形态：`vendor/msys2/{bin,share/doc-notice}/`，bin 只放 exe+dll；NOTICE 列版本与许可（bash=GPLv3、coreutils=GPLv3、其余各自 GPL/LGPL/BSD）
- tauri.conf.json `bundle.resources` 加 `"vendor/msys2/**"`（dev 模式 resource_dir 同样解析）

## 3. 关键设计决策

1. **单 argv 传命令**（保持现状）：`bash -c <整条命令>` 一个参数——dsh 的 pwsh 同款理由：无中间 shell 即无引号转义层。
2. **每命令独立 Job**：全局 Job 一旦 `TerminateJobObject` 会误杀其他 Agent 的在跑命令——必须 per-spawn；`BREAKAWAY_OK` 不设（子进程逃不掉杀树，构建工具一般不自建 Job）。
3. **回退阶梯**：捆绑 bash（主）→ 探测 Git Bash（资源缺失时，告警）→ cmd 脚本（最后）。阶梯顺序固定，不再"探测失败静默降级"。
4. **PATH 归一化优先级**：捆绑 bash 自带 `PATH=/usr/bin:<归一化用户 PATH>`——bash 内建和 coreutils 用 MSYS 的，`cargo`/`node`/`python` 从用户 PATH 解析。
5. **许可**：捆绑二进制 = 单纯聚合（MIT 应用 + GPL 独立可执行），`THIRD_PARTY_NOTICES.md` 声明版本与许可链接；不修改 MSYS2 二进制本身。

## 4. 基线命令（Windows 机器实跑）

```powershell
cd D:\HoloGramHG\src-tauri
cargo test os_sandbox:: -- --nocapture   # P1/P2 杀树与钉死解释器实跑
cargo test commands::shell               # 现有 shell 套件回归
cd D:\HoloGramHG\src-ui
npx tsc --noEmit
```

Linux 本机：`cargo check` + `cargo test utils::`（纯函数）+ 确认 `commands::shell` 仍只有 4 个历史 bwrap 失败。

## 5. 踩坑速记

- `zstd -d` 解包 MSYS2 tar.zst；包内 `usr/bin` 与 `etc/` 结构——只拷 bin 层的 exe+dll，bash 需要 `/etc/nsswitch.conf`? 不需要（MSYS 默认行为够用）。
- Git 仓库 +15MB 二进制：可接受（用户明确无商用问题）；提交时单列一个 commit。
- 别动 `assign_to_job`（LSP/MCP/Unity 用全局 Job 的 die-with-parent）；别把 per-command Job 加内存上限（构建命令内存需求不可预测，dsh 也没加）。
- Windows 侧不可在本 Linux 机器验证——代码必须 cfg(windows) 零触及 Linux 路径，Linux 回归必须仍绿。
