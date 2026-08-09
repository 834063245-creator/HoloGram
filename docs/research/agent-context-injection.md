# 顶尖 Agent CLI 的上下文注入机制调查报告

> 调研日期：2026-08-09 · 性质：纯调研（未改动任何代码）
> 方法：仅使用一手来源（官方文档 / 官方工程博客 / 官方开源源码）；无法访问的页面已明确标注【未证实】
> 网络说明：`code.claude.com`（Anthropic 新版文档域名）、`developers.openai.com`、`codex.openai.com` 在本机网络不可达（连接超时 / 403），相关细节改以官方开源仓库 `openai/codex` 与官方 Changelog（`anthropics/claude-code`）核实，其余标注【未证实】。

---

## 速览结论（可直接转述的 5 行）

1. **"一上来就懂文档"不是错觉，但也不是"扫描了代码库"**——三家 CLI 都只在启动时静态注入**极少量**文件（CLAUDE.md / AGENTS.md / GEMINI.md 层级记忆文件，Codex 上限 32 KiB），代码本体一律懒加载（read/grep/glob 工具），没有任何一家启动时扫描整个仓库（Anthropic 官方博客明确说 CLAUDE.md 是"naive drop-in"、其余靠 glob/grep 即时检索）。
2. **"懂文档"的真正来源是"记忆文件层级 + 开局主动探索"**：根目录记忆文件静态进上下文，子目录记忆文件在**读该目录文件时才注入**（Claude Code 的嵌套 CLAUDE.md 按需加载、Gemini CLI 官方文档直接命名为 "just-in-time context files"），加上 Agent 开局会用 glob/grep/ls 主动逛目录树。
3. **Codex 与 Claude Code 记忆机制相反**：Codex 把 AGENTS.md 全层级（项目根→cwd）**一次性静态注入**（总额度 32 KiB），Claude Code 只把当前目录链的记忆文件静态注入、深层子目录按需加载。
4. **会话连续性靠的是 resume/auto-compact 而非记忆**：两边都有自动压缩（Claude Code 把 1M 窗口压回 200K；Codex 压缩时保留最近 ≤2 万 token 的用户消息），Claude Code 压缩后保留最近访问的 5 个文件；Codex 另有启动时后台异步的记忆提取管线（Memories）。
5. **结论：注入策略都在刻意"少注入"**——Anthropic 的 context engineering 论文式结论是：上下文是有限"注意力预算"，塞太多静态内容会引发 context rot（上下文越长回忆越差），好 agent 用"最小高信号 token + 按需检索"。

---

## 一、总体结论：是"真注入"还是"错觉"？

**半真半假，机制如下：**

- **真**的部分：每个 CLI 在新会话启动时都会把若干**文档记忆文件**（CLAUDE.md / AGENTS.md / GEMINI.md）静态拼进系统提示词——这是被官方源码与官方博客直接证实的（见下）。
- **假**的部分：没有任何一家在启动时扫描/注入整个代码库。全部采用"文件系统即索引"的**懒加载**：模型通过 Read/Grep/Glob/Exec 工具按需拉取代码。
- **"懂文档"的真实链条**：(a) 记忆文件静态注入；(b) Agent 开局主动探索（用 glob/ls/grep 构建目录图景）；(c) 子目录记忆文件在被读到该目录时自动注入；(d) 长会话靠 auto-compact / resume 维持连续性；(e) Codex 额外有 Memories（启动时后台把历史会话提炼成摘要注入）。

Anthropic 官方工程博客的原话（对 Claude Code 的设计描述）：

> "Claude Code is an agent that employs this hybrid model: CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep allow it to navigate its environment and retrieve files just-in-time, effectively bypassing the issues of stale indexing and complex syntax trees."
>
> —— https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

---

## 二、Claude Code（Anthropic）

### 2.1 启动时静态注入什么

| 内容 | 说明 | 来源 |
|---|---|---|
| 系统提示词（内置） | 由 CLI 维护，包含工具定义、行为规范；用户的 CLAUDE.md 指令也拼入其中（官方 changelog 在反馈上报说明中直接称 "the system prompt (which includes your CLAUDE.md instructions)"） | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md（2.1.224 条目） |
| CLAUDE.md 记忆文件 | 启动时"naive drop-in"进上下文（官方博客原文）；层级包括用户级 `~/.claude/CLAUDE.md`、项目级 `.claude/CLAUDE.md`、子目录嵌套 CLAUDE.md、`.claude/rules/*.md` 条件规则 | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents；https://code.claude.com/docs/en/memory【未证实：文档页本机无法访问，层级细节以 changelog 佐证】 |
| CLAUDE.md 支持 `@path` 导入 | `@path/to/file.md` 可在启动时拉入附加文件 | CHANGELOG.md（2.1.20x 条目："CLAUDE.md files can now import other files"） |
| 条件规则 `.claude/rules/*.md` | 带 `paths:` frontmatter，按路径条件注入；触发 `InstructionsLoaded` hook | CHANGELOG.md（"Added support for .claude/rules/…"、2.1.21x 条目 "Added InstructionsLoaded hook event that fires when CLAUDE.md or .claude/rules/*.md files are loaded into context"） |
| 工具 schema | 全部工具定义随系统提示词注入（每轮都会带上） | 官方文档 https://code.claude.com/docs/en/context【未证实：页面不可访问，属公开已知行为】 |
| settings / hooks / skills | settings（`~/.claude/settings.json` 与项目级）、hooks 配置不直接进模型上下文（hook 只影响执行流，个别 hook 可向上下文注入内容）；skills 的**描述列表**会注入，完整 SKILL.md 按需加载 | https://code.claude.com/docs/en/settings、/skills、/hooks【未证实：页面不可访问】；changelog 佐证："Fixed skills invoked before auto-compaction…"、skill 描述截断提示 |

### 2.2 懒加载（按需）

- **代码本体**：Read/Grep/Glob/Bash 工具按需拉取，官方博客称为 "just-in-time" 检索（progressive disclosure）——来源同上。
- **嵌套子目录 CLAUDE.md**：**读该目录内文件时自动注入**。changelog 两条铁证：①"Fixed nested CLAUDE.md files being re-injected dozens of times in long sessions that read many files"（说明嵌套 CLAUDE.md 随文件读取注入，且历史上会重复注入）；②"Fixed collapsed search/read summary badge … when a CLAUDE.md file auto-loads during a tool call"（读文件时 CLAUDE.md auto-load）。来源：https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- **skills**：模型侧先看到技能描述列表，完整 SKILL.md 在被调用/命中时才读入（changelog 有技能描述截断、`disable-model-invocation` 等条目佐证技能是两段式加载）。
- **@ 提及文件 / 附件**：用户 @file 时作为额外上下文附带（changelog：@-mention 行为、附件）。

### 2.3 记忆、压缩、上下文管理

- **Memory（auto-memory）**：Claude 会自动把有用的上下文存进记忆；`MEMORY.md` 索引有**硬上限：25 KB 或 200 行，超出即截断**；`/memory` 命令可查看/编辑全部导入的记忆文件；记忆文件带 frontmatter（含 ISO 修改时间）；写入超出读取上限时报错而非静默截断。来源：https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md（"MEMORY.md index now truncates at 25KB as well as 200 lines"；"Memory writes that leave a MEMORY.md index over its read limit now produce an explicit error…"；"Claude automatically saves useful context to auto-memory. Manage with /memory"；"/memory command now allows direct editing of all imported memory files"）
- **auto-compact**：接近上下文上限时自动把对话历史交给模型做摘要压缩，然后**保留压缩摘要 + 最近访问的 5 个文件**继续（官方博客原文："The agent can then continue with this compressed context plus the five most recently accessed files"）。来源：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **1M 上下文模型的处理**：默认把原生 1M 窗口的会话**压回 200K**（`CLAUDE_CODE_DISABLE_1M_CONTEXT` 控制），状态栏/`/context` 显示 200K 基准；对未识别模型也按假设窗口强制。来源：CHANGELOG.md（"Changed CLAUDE_CODE_DISABLE_1M_CONTEXT to hold every Claude model with a native 1M window to 200K via auto-compaction…"；"the context window (and auto-compact indicator) briefly resetting to 200k…"）
- **/context 命令**：显示当前 token 用量、上下文窗口占用，超限时给出显式警告（changelog："/context now shows an explicit warning when the conversation exceeds the context window"）。
- **PreCompact / PostCompact hooks**：可拦截或放行压缩。
- **CLAUDE.md 过大警告**：阈值随模型上下文窗口缩放（changelog："The 'CLAUDE.md is too long' warning threshold now scales with the model's context window"）——没有固定字节数上限【未证实：官方文档不可访问，未能核实文档中记载的固定上限；changelog 证实的是"警告阈值随窗口缩放"】。

### 2.4 会话连续性机制

- **resume / --continue**：恢复历史对话；**subagent（Task 工具）**：把深度探索隔离在子 agent 的独立上下文里，只回传压缩摘要（Anthropic 研究系统博客给出量级：子 agent 返回约 **1,000–2,000 token** 的提炼结果；研究系统上下文超 200K 会被截断，因此靠外部记忆持久化计划）。来源：https://www.anthropic.com/engineering/multi-agent-research-system（"How we built our multi-agent research system" 正文与图注）
- 子 agent 数量级：默认并发上限 20、每会话 spawn 上限 200、嵌套深度默认 3（CHANGELOG 2.1.217 / 2.1.219 条目）。

---

## 三、Codex CLI（OpenAI，源码级核实）

> 以下全部来自开源仓库 `openai/codex` main 分支（2026-08 抓取），行内附具体文件路径。

### 3.1 AGENTS.md 层级与注入规则（源码：`codex-rs/core/src/agents_md.rs`）

模块文档注释原文明确了完整规则：

> "We include the concatenation of all files found along the path from the project root to the current working directory… Collect every AGENTS.md found from the project root down to the current working directory (inclusive) and concatenate their contents in that order. We do **not** walk past the project root."

具体事实：

1. **项目根判定**：从 cwd 向上找 `project_root_markers`（默认 `[".git"]`），找不到则只看 cwd 自身。
2. **收集范围**：项目根 → cwd 路径上的**每一层** AGENTS.md（含根与 cwd 本身），按顺序拼接；**不越过项目根**（即不读仓库外、也不读 cwd 以下子目录——子目录 AGENTS.md 要到 cd 进该目录后才会进入收集范围）。
3. **本地覆盖文件**：`AGENTS.override.md` 优先于 `AGENTS.md`（`LOCAL_AGENTS_MD_FILENAME`）。
4. **大小上限**：`project_doc_max_bytes` 默认 **32 KiB（32 * 1024 字节）**，超出的文件被截断并记录 warning（源码常量 `DEFAULT_PROJECT_DOC_MAX_BYTES: usize = 32 * 1024`，见 `codex-rs/config/src/config_toml.rs`；截断逻辑见 `agents_md.rs` 的 `read_agents_md`）。
5. **fallback 文件名**：`project_doc_fallback_filenames` 可追加候选名（默认空）。
6. **用户级指令**：`~/.codex/AGENTS.md` 作为 user instructions 与项目 AGENTS.md 拼接，中间用 `\n\n--- project-doc ---\n\n` 分隔。
7. **注入时机**：每轮 turn 构造 step context 时重新加载（`load_project_instructions` 接收 `TurnEnvironmentSnapshot`；`session/world_state.rs` 的 `AgentsMdState` 每轮重建）——即**每次 turn / cd 都会刷新**，并非只在启动读一次。

### 3.2 启动时静态注入的完整清单（源码：`codex-rs/core/src/session/world_state.rs`）

每轮构建的 world state 包括：模型内置指令（system prompt）、AGENTS.md 拼接结果、权限/沙箱说明、协作模式说明、环境上下文（cwd、日期、环境列表）、token budget 上下文、personality、realtime 指令、apps/plugins 指令、多 agent 模式说明等。**不含任何代码文件**。

**关键反证**：`codex-rs/core/src/session_startup_prewarm.rs` 的"启动预热"只做两件事——auth 预热与 websocket 连接预热（把 base_instructions 发给服务端暖连接），**没有任何代码库索引或扫描**。这直接证明 Codex CLI 启动时不读代码。

### 3.3 懒加载

- 代码文件：通过工具（`codex-rs/core/src/tools/`）按需读取；工具输出可存入 context manager 并以 token 预算截断（config 项 `tool_output_token_limit`，`codex-rs/config/src/config_toml.rs`）。
- 会话历史以外的所有知识：文件系统即索引，模型自己用工具找。

### 3.4 压缩（源码：`codex-rs/core/src/compact.rs`、`compact_token_budget.rs`）

- 自动压缩触发阈值：`model_auto_compact_token_limit`（config 可配，默认值未见常量声明【未证实】）。
- 压缩方式：把历史交给模型用 `SUMMARIZATION_PROMPT` 生成摘要；**保留最近的用户消息最多 20,000 token**（`COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000`），摘要以用户消息形式追加；压缩后**重新注入初始上下文**（AGENTS.md 等，`build_compaction_initial_context`）。
- 另有 token-budget 模式：不做摘要、直接换新窗口（`compact_token_budget.rs` 的 `run_inline_auto_compact_task`）。
- PreCompact/PostCompact hooks 可拦截。

### 3.5 Memories（自动记忆，源码：`codex-rs/memories/README.md` + 模板）

- **触发时机**：根会话（root session）启动时，异步后台执行，条件：非临时会话、记忆功能开启、非子 agent 会话、状态库可用。
- **Phase 1**：从 state DB 认领最近的可选 rollout（有年龄窗口、空闲时间、数量上限），并行让模型提炼出 `raw_memory` + `rollout_summary`。
- **Phase 2**：全局串行合并，产出落盘工件（`~/.codex/memories/`，git 基线目录）：`raw_memories.md`、`rollout_summaries/`、以及合并结果 **`MEMORY.md`、`memory_summary.md`、`skills/`**。
- **读取注入（模板 `codex-rs/ext/memories/templates/memories/read_path.md`）**：`memory_summary.md` 的内容以 `MEMORY_SUMMARY` 块**静态注入系统提示词**；而 MEMORY.md、rollout_summaries/、skills/ 通过工具**按需查询**（模板要求"quick memory pass"≤4-6 次搜索步骤，并以 `<oai-mem-citation>` 块回引）。即：**摘要静态注入，细节懒加载**。
- **写入纪律**：仅在用户明确要求时，通过 `extensions/ad_hoc/notes/` 写增量笔记，不允许模型直接改记忆文件。

### 3.6 Skills / Habits / Codex cloud

- Skills：仓库有 `codex-rs/core/src/skills.rs`、`codex-rs/config/src/skills_config.rs`、`codex-rs/ext/memories/templates/…/skills/` 结构；官方文档指向 https://developers.openai.com/codex/skills 【未证实：页面 403】。仓库自带技能位于 `.codex/skills/*/SKILL.md`（如 code-review 等）。
- Habits：**在开源仓库中不存在**（对 main 分支完整文件树做了 grep，无任何 habit 相关文件）。官方文档 https://developers.openai.com/codex/habits 描述 habits（`.codex/habits/` 按条件注入）【未证实：文档不可访问，且开源代码中无实现，无法从一手来源核实注入规则】。
- **Codex cloud（codex.openai.com）**：【未证实】FAQ 页 https://codex.openai.com/faq 本机不可达。开源仓库是 CLI 的实现；cloud 端是否有额外的索引/语义检索机制，无一手来源可查。已知事实仅为 README 明确区分 "Codex Web（cloud-based agent）" 与 CLI（https://github.com/openai/codex）。

---

## 四、Gemini CLI（顺带核实）

官方文档 https://www.geminicli.com/docs/cli/gemini-md（GEMINI.md 页面）明确写出**三级层级 + JIT**：

1. **全局**：`~/.gemini/GEMINI.md`（所有项目默认指令）。
2. **工作区**：在配置的 workspace 目录及其**父目录**中搜索 GEMINI.md，拼接后随每个 prompt 发送。
3. **Just-in-time（JIT）上下文文件**：当工具访问某个文件/目录时，自动在该目录及其祖先（直到 trusted root）扫描 GEMINI.md——这是三家 CLI 中对"子目录记忆文件按需注入"最明确的官方表述。

其他事实：`/memory show`（查看拼接后的完整层级）、`/memory reload`（强制重扫）；`@file.md` 导入语法；`context.fileName` 可配置（例如改为 `["AGENTS.md", "CONTEXT.md", "GEMINI.md"]`，即与 Codex/Claude 的格式互通）；README 声明 1M token 上下文窗口（https://github.com/google-gemini/gemini-cli）。量化上限【未证实：文档未给字节上限】。

---

## 五、对比表

| 维度 | Claude Code | Codex CLI | Codex cloud | Gemini CLI |
|---|---|---|---|---|
| 启动静态注入 | 系统提示词（含工具 schema）+ CLAUDE.md 层级（用户级 `~/.claude/CLAUDE.md`、项目 `.claude/CLAUDE.md`、当前链嵌套、`.claude/rules/*.md` 条件规则）+ 技能描述列表 | 内置系统提示词 + AGENTS.md 全层级（项目根→cwd 逐层拼接）+ user 级 `~/.codex/AGENTS.md` + 权限/环境/personality 等 world state + memory_summary（若记忆启用） | 【未证实】FAQ 不可访问；CLI 开源部分无索引逻辑 | 系统提示词 + GEMINI.md 三级（全局 `~/.gemini/GEMINI.md`、工作区+父目录、JIT）+ 拼接后随每个 prompt 发送 |
| 懒加载 | 代码本体（Read/Grep/Glob/Bash）；**嵌套 CLAUDE.md 在读该目录文件时 auto-load**；完整 SKILL.md 按需 | 代码本体（工具读取）；cwd 以下子目录 AGENTS.md 需 cd 进入后下轮刷新；MEMORY.md/rollout_summaries/skills 按需工具查询 | 同 CLI（猜测，未证实） | 代码本体；**JIT：工具访问目录时自动扫该目录及其祖先的 GEMINI.md** |
| 记忆机制 | auto-memory + `/memory`；MEMORY.md 索引上限 **25 KB 或 200 行**；带 frontmatter | Memories 双阶段管线：启动后台异步提炼 → 合并出 MEMORY.md/memory_summary.md/skills/；摘要静态注入、细节工具查询 | 【未证实】 | `/memory show/reload`；Auto Memory（实验性，另有页面）【未证实：未抓取】 |
| 量化上限 | CLAUDE.md 无固定字节上限（警告阈值随窗口缩放）；MEMORY.md 25KB/200 行；auto-compact 把 1M 窗口压回 **200K**；压缩后保留摘要+最近 5 个文件；子 agent 回传 1–2K token 摘要 | **AGENTS.md 总额度 32 KiB**（超则截断+warning）；压缩保留最近用户消息 ≤**20,000 token**；auto-compact 阈值可配 | 未证实 | 未证实（文档无数字；1M 上下文窗口） |
| 启动扫描代码库？ | **否**（官方博客：CLAUDE.md 直塞、代码靠 glob/grep 即时检索） | **否**（startup prewarm 仅做 auth+websocket 预热，源码可证） | 未证实 | **否**（JIT 机制即证明按需加载） |

---

## 六、Anthropic 的核心结论：为什么"少注入"是对的

官方博客《Effective context engineering for AI agents》的论点（全部可引）：

1. **context rot**：随上下文 token 数增加，模型对早期信息的回忆准确率下降（针堆实验），上下文是"注意力预算"，边际收益递减。来源：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
2. **好的 context engineering = 找"最小的高信号 token 集合"**：系统提示词要精简（够用即可），工具要 token 高效，示例要"典范而非穷举"。
3. **just-in-time 优于预检索**：维护轻量标识（文件路径等），用工具在运行时动态加载数据，实现 progressive disclosure——"人类也不背下整个语料库，而是靠文件系统这类外部索引按需检索"。
4. **长程任务三板斧**：压缩（compaction）、结构化笔记（structured note-taking / 外部记忆）、多 agent 架构（子 agent 用独立上下文窗口探索，只回传 1,000–2,000 token 提炼结果）。
5. 代价平衡：运行时探索比预计算慢，所以 Claude Code 用"混合策略"——少量记忆文件前置 + 自主探索，这正是本报告主题的最权威官方解释。

---

## 七、未能核实清单（【未证实】汇总）

1. `code.claude.com/docs/en/{memory,context,settings,skills,hooks}` 的具体文档文字（本机网络不可达；行为事实改由官方 CHANGELOG 佐证）。
2. CLAUDE.md 的**固定字节数上限**（文档曾记载过大文件处理规则，但本机无法访问；changelog 只证实"警告阈值随上下文窗口缩放"）。
3. Codex Habits（`.codex/habits/` 条件注入）的实现细节——开源仓库无此实现，文档页 403。
4. Codex cloud（codex.openai.com）是否在 CLI 之外有额外的索引/知识注入机制（FAQ 不可访问）。
5. 各 CLI **系统提示词本身的 token 数**（无官方一手数字）。
6. Gemini CLI 的上下文量化上限。
7. developers.openai.com 全套文档（403），包括 AGENTS.md 指南页（仓库内 `docs/agents_md.md` 仅一行跳转链接，未含细节）。

---

## 附：一手来源清单

- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents （CLAUDE.md 直塞 + 懒加载、压缩保留 5 文件、context rot、JIT 检索）
- https://www.anthropic.com/engineering/multi-agent-research-system （子 agent 摘要 1–2K token、200K 截断、token 用量 4×/15×）
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md （CLAUDE.md 嵌套注入/导入/条件规则、MEMORY.md 25KB/200 行、auto-compact 200K、/context、hooks、subagent 上限、/doctor）
- https://github.com/openai/codex （源码：`codex-rs/core/src/agents_md.rs`、`codex-rs/config/src/config_toml.rs`、`codex-rs/core/src/session/world_state.rs`、`codex-rs/core/src/session_startup_prewarm.rs`、`codex-rs/core/src/compact.rs`、`codex-rs/memories/README.md`、`codex-rs/ext/memories/templates/memories/read_path.md`）
- https://www.geminicli.com/docs/cli/gemini-md （GEMINI.md 三级层级 + JIT 上下文文件）
- https://github.com/google-gemini/gemini-cli （README：1M 上下文等）
- 不可访问（列此备查）：https://code.claude.com/docs/en/memory · https://developers.openai.com/codex/guides/agents-md · https://codex.openai.com/faq
