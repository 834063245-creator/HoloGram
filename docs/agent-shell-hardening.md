# HoloGram Agent Shell 层加固方案

> 依据：精读 DeepSeek-Reasonix / kimi-code / hermes-agent 三家源码 + Claude Code 官方工具规范  
> 日期：2026-08-06 · 状态：待痞老板确认后实施  
> 目标：让 HoloGram 的 Agent「无论如何都不会反复遭遇 shell 语法错误」，语法类错误归零、语义类错误最小化



---

## 一、现状诊断（为什么你的 Agent 被反复折磨）

HoloGram 当前 shell 层（`src-tauri/src/commands/shell.rs` + `src-ui/src/agent/runtime/shell-queue.ts` + `cmd-class.ts`）：

| 维度     | HoloGram 现状                                                       | 问题                             |
| ------ | ----------------------------------------------------------------- | ------------------------------ |
| 解释器选择  | `os_sandbox.rs:190-205` bash 优先，**失败静默回退 `cmd`**                  | 模型无法预知命令跑在 bash 还是 cmd 上，语法必踩坑 |
| 输出治理   | 非流式路径 `shell.rs:246-260` **全文返回**，无截断                             | 几千行编译日志全进上下文，滚雪球烧 token        |
| 环境声明   | 无（system prompt 无 OS/shell 块）                                     | 模型第一轮就得猜语法                     |
| 语法预检   | 无                                                                 | 语法错直接执行，报错才被发现                 |
| 结构化工具  | Agent 直接敲 `ls/cat/grep/find`（cmd-class.ts READ_TOOLS 全是 shell 命令） | 文件操作走裸 shell，无封装保护             |
| 已有的好东西 | 队列调度、超时转后台、权限层、命令分类                                               | ✅ 保留                           |

结论：HoloGram 是「裸 shell 暴露 + 无治理」型，与三家成熟框架的「结构化封装 + 固定方言 + 输出治理 + 环境声明」完全相反。

---

## 二、三家框架的共性证据（第一手源码）

| 机制    | DeepSeek-Reasonix (Go)                                                                     | kimi-code (TS)                                                                                            | hermes-agent (Python)                                                                                                 |                                |                          |
| ----- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------ |
| 工具名   | `bash`（internal/tool/builtin/bash.go:105）                                                  | `Bash`（packages/agent-core/src/tools/builtin/shell/bash.ts:199）                                           | `terminal`（tools/terminal_tool.py:2877）                                                                               |                                |                          |
| 解释器策略 | 动态：优先 Git bash，无则 PowerShell 且**工具描述动态切换为 PowerShell 语法**（bash.go:107-126）                 | **强制 Git Bash**，不用 PowerShell/cmd（kaos/environment.ts:80-83）；路径转 POSIX、NUL→/dev/null 改写（bash.ts:610-629）  | **强制 Git Bash**，不用 shell=True（local.py:238-288,648）                                                                   |                                |                          |
| 超时    | 默认 120s，超时杀进程树                                                                             | 前台 60s/上限 300s，超时**转后台**                                                                                  | 默认 180s，硬顶 600s                                                                                                       |                                |                          |
| 输出截断  | **32KB**，首尾各半 + `…[truncated X of Y bytes]…`（agent.go:2887）；历史 prune：bash 两端各 40 行/8000 字符 | **50,000 字符** + 单行 2000 上限，截断后给 `output_path` 引导用 Read 分页（result-builder.ts:6-9）                          | **50,000 字符**，head 40% + tail 60%，超 100K 落盘只回 1500 字符预览（terminal_tool.py:2641-2652）                                   |                                |                          |
| 错误回传  | 摘要 + 原文（agent.go:2513）                                                                     | exit code + 原文（bash.ts:478-481）                                                                           | exit code 解释（grep=1 不算错）+ 原文（\_interpret_exit_code）                                                                   |                                |                          |
| 结构化工具 | read_file/write_file/edit_file/grep/glob/ls 全内置；bash 描述驱逐 shell 文件操作（bash.go:131）          | Read/Write/Edit/Glob/Grep 内置；bash.md 强制「cat→Read、sed→Edit、find→Glob、grep→Grep」                            | read_file/write_file/patch/search_files 内置；terminal 描述同样驱逐（terminal_tool.py:937-941）                                  |                                |                          |
| 环境声明  | system prompt `## Environment` 块：OS + Shell 路径 + 工具链清单（boot.go:276-298）                    | `You are running on {{KIMI_OS}}` + Windows 专段「Git Bash 用 Unix 语法，/dev/null 不是 NUL，路径正斜杠」（system.md:79-83） | `build_environment_hints()`：「跑在 bash (git-bash/MSYS)，不是 PowerShell；Get-ChildItem 不能用，用 ls」（prompt_builder.py:892-900） |                                |                          |
| 额外亮点  | PowerShell 5.1 下预检拦截 `&&`/\`                                                               |                                                                                                           | \`（bash.go:171-175）                                                                                                   | 自带 tree-sitter-bash 语法解析器做权限匹配 | stderr 合并 stdout；ANSI 脱敏 |

**三家共识（这就是"真正好的方案"的骨架）：**

1. 能封装的都封装成结构化工具，shell 只留给"真的需要命令"的场景
2. Windows 上要么强制 Git Bash 单一方言，要么动态声明并切换描述——**绝不静默回退**
3. 输出必须截断（32K~50K 字符），错误=摘要+原文
4. OS/shell 类型写进 system prompt，第一轮就告诉模型

---

## 三、HoloGram 定制方案（三层防线）

### 第 1 层 · 环境固定与声明（先做，零成本高收益）

**改动点：`src-tauri/src/os_sandbox.rs`**

- `spawn_shell`（190-205 行）：Windows 分支去掉静默回退 `cmd`。改为：
  - 启动时探测 Git Bash（参考 kimi-code 逻辑：从 `git.exe` 路径推断 `<root>\bin\bash.exe`，兜底 `C:\Program Files\Git\bin\bash.exe`，支持环境变量覆盖）
  - 探测结果**缓存并暴露**给前端（新增 `shell_env` 查询命令：`{ os, shell: "bash", shellPath, shellVersion }`）
  - 探测失败才回退 PowerShell，且回退必须**显式上报**（返回给 Agent 的环境块里注明），不允许静默
- 顺带修 `shell.rs:195` 的 `bash -c` 拼装：命令走 `quote_cmd` 已有，保持

**改动点：Agent system prompt 注入（`src-ui/src/agent/` 里找 system prompt 组装处）**

- 新增环境块（对齐三家做法）：
  ```
  ## Environment
  - OS: Windows (amd64)
  - Shell: bash (Git Bash) — 所有命令跑在 bash 上，用 Unix 语法
  - 规则: 用 /dev/null 而不是 NUL；路径用正斜杠；用 ls 而不是 dir
  - 工具链: git / node / cargo ...（探测后列出）
  ```
- 工具描述层：shell 工具 description 开头加「优先使用专用工具（read_file/grep/glob/edit），不要用 cat/ls/grep/find/sed/awk」

### 第 2 层 · 输出治理（核心，直接治 token 滚雪球）

**改动点：`src-tauri/src/commands/shell.rs`**

- 非流式路径（211-292 行）：`full_output` 拼好后做**截断**：
  - 阈值 32,000 字符（对齐 Reasonix；后续可配 `max_output_chars`）
  - head 50% + tail 50%，中间插 `\n…[output truncated: X chars omitted — 可拆小命令或加窄参数]…\n`
- 流式路径：前端订阅侧已有逐块展示，**在上下文里同样截断**（agent 侧拿到完整输出后截断再注入，避免长输出进 context）
- 错误格式保持 `[exit code: N]\n<截断后原文>`（已达标，仅加截断）

### 第 3 层 · 语法预检 + 结构化工具（进阶，工作量最大）

**改动点：`src-tauri/src/commands/shell.rs`**

- 执行前语法预检（`exec_command` 入口，is_agent=true 时启用）：
  - 解析 wrapper（复用前端 cmd-class.ts 的 wrapper 逻辑或 Rust 侧 `split_cmdline`）：`bash -c X` → 用 `bash -n` 校验 X；`powershell -Command X` → 用 `[scriptblock]::Create('X')` 校验
  - 预检失败直接返回「命令未执行：语法错误」+ 错误位置，不执行、不烧 token
- 幂等检查：预检通过才 spawn

**结构化文件工具（可选，涉及前端工具注册）**

- 在 Agent 工具注册表（`src-ui/src/agent/runtime/agent-builder.ts` 的 buildToolRegistry）补：`read_file` / `write_file` / `grep` / `glob` 四个工具（前端实现，走现有 Tauri 命令或直接 fs），并在 shell 工具描述里驱逐对应 shell 用法

---

## 四、实施优先级（建议分三步提交）

| 步骤         | 内容                                       | 改动量             | 风险                        | 收益             |
| ---------- | ---------------------------------------- | --------------- | ------------------------- | -------------- |
| **P0（先做）** | 第 1 层：固定 Git Bash + 环境块注入 + shell 工具描述引导 | ~2 文件，<100 行    | 低（探测失败有显式回退）              | 消灭「猜语法」类错误的大头  |
| **P1（核心）** | 第 2 层：输出截断（32K head+tail）                | ~1 文件，<50 行     | 低（纯加法）                    | 直接止住 token 滚雪球 |
| **P2（进阶）** | 第 3 层：bash -n 语法预检 + 结构化文件工具             | ~3 文件，200-400 行 | 中（预检可能误伤合法但复杂命令，需白名单/逃生口） | 语法错误归零         |

P0+P1 合计 3 个文件 150 行内，即可覆盖 80% 的收益。P2 的预检需要关注误伤（比如 `bash -c "echo a > b"` 这种带重定向的合法命令，`bash -n` 是能过的，真正要防的是 `]]` 拼错、`fi` 缺失这类）。

## 五、风险与回滚

- **探测失败回退链**：Git Bash 缺失 → 显式回退 PowerShell 并在环境块声明「当前命令跑在 PowerShell，用 PowerShell 语法」→ Agent 依然能工作（Reasonix 同款策略）
- **截断影响**：长输出被截断后模型可能缺上下文 → 错误信息带截断标记，提示可拆小命令；如需要完整日志可加 `bash_output` 后台任务查询（已有）
- **预检误伤**：白名单机制（`bash -n` 报错但命令明显合法时，允许带 `allow_unsafe` 参数重试）
- **回滚**：三步各自独立提交，P0/P1 回滚即 revert 对应 commit

## 附：关键参考实现位置

| 机制          | 参考项目         | 文件                                                   |   |   |
| ----------- | ------------ | ---------------------------------------------------- | - | - |
| Git Bash 探测 | kimi-code    | packages/kaos/src/environment.ts:80-156              |   |   |
| 环境块注入       | hermes-agent | agent/prompt_builder.py:892-900,1013-1039            |   |   |
| 输出截断        | Reasonix     | internal/agent/agent.go:2887（32K 首尾各半）               |   |   |
| 工具描述驱逐      | Reasonix     | internal/tool/builtin/bash.go:131                    |   |   |
| 语法预检        | Reasonix     | internal/tool/builtin/bash.go:171-175（PS 拦 &&/       |   | ） |
| 输出落盘+预览     | hermes-agent | tools/budget_config.py:17-19, tool_result_storage.py |   |   |
