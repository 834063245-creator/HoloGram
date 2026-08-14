<p align="center">
  <img src="assets/banner.png" alt="HoloGram" />
</p>

<p align="center">
  <strong>HoloGram</strong> — 代码库依赖图引擎，为 AI Agent 提供确定性的静态分析
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="https://whyihaveyou.github.io/dsh-suite/"><img src="https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/HoloGram?color=orange&style=flat-square" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-1600%2B-brightgreen?style=flat-square" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20Linux-blue?style=flat-square" /></a>
</p>

---

## 定位

HoloGram 把代码库编译成一张统一 IR 依赖图（节点=符号/函数/类/模块，边=调用/继承/读写/时序），并通过 MCP 协议向 AI Agent 暴露 34 个图查询工具。

**核心主张：依赖推理应当是确定性的，而不是猜的。**

LLM 分析"改 A 会炸什么"时，靠逐文件读源码推测依赖——弱模型会漏，大项目会翻不动。HoloGram 用 tree-sitter 静态分析预先算好整张依赖图：Agent 一次工具调用拿到结构化事实（影响面、循环、脆弱模块、数据流路径），而不是源文件文本。单点查询省 ~70% token，全局分析省 90%+；省 token 是次要的，**可靠性**是主要的。

引擎是单文件二进制，本地运行、零配置、代码不出机器。

## 快速开始

### MCP 模式（推荐，1 分钟）

引擎随 [Releases](https://github.com/834063245-creator/HoloGram/releases) 发布（Windows / Linux），安装脚本一键完成。也可以把下面这段话直接发给你的 AI 编程工具，让它自己装：

```
请帮我安装 HoloGram MCP 服务。步骤：

1. 从 https://github.com/834063245-creator/HoloGram/releases 下载：
   - Windows: hologram-engine-windows-x64.zip
   - Linux:   hologram-engine-linux-x64.tar.gz
2. 解压后运行安装脚本：
   - Windows: 双击 install.cmd
   - Linux:   ./install.sh --user
3. 在当前 AI 编程工具的 MCP 配置中注册：
   - command: hologram-engine
   - args: serve
4. 重启 AI 编程工具，调 engine_status 验证
```

<details>
<summary>手动配置</summary>

**Claude Code** — `~/.claude/mcp.json`：
```json
{
  "mcpServers": {
    "hologram": {
      "command": "hologram-engine",
      "args": ["serve"]
    }
  }
}
```

**Cursor** — Settings → MCP → Add new MCP server：command `hologram-engine`，args `serve`。
</details>

### CLI

```bash
hologram run --list                        # 所有工具
hologram run graph_summary .               # 项目概览
hologram run trace_impact . --node_id src/main.rs:main   # 影响面
hologram run preflight_check . --files a.rs,b.rs         # 改前检查（exit code 表达结果）
hologram run detect_cycles .               # 循环依赖
hologram run list_flows .                  # 执行流（按安全敏感度排序）
```

### 桌面应用

[Releases](https://github.com/834063245-creator/HoloGram/releases) → 下载 `.msi`（Windows）→ 选项目 → 自动出图。桌面端与 MCP 模式共用同一个引擎。

### DeepSeek Harness 集成（hologram-dsh）

引擎 + 3D 星图打包为 DSH bundle 插件 [`@a834063245/hologram-dsh`](https://www.npmjs.com/package/@a834063245/hologram-dsh)：

```sh
dsh plugin --profile web add @a834063245/hologram-dsh
dsh web
# 重启后：34 个 mcp__hologram__* 工具进工具箱 + 侧边栏「3D 星图」入口
```

- **34 个 MCP 图分析工具**直接注入 DSH agent（与桌面/MCP 模式同一引擎、同一份数据）
- **3D 星图**：DSH web 侧边栏入口，全屏渲染项目依赖图（同源自托管，无独立端口）
- **单一数据生命周期**：引擎单进程双入口（MCP stdio + TCP），存量秒开 + watcher 增量更新
- 安装说明与数据模型见 [`dsh-bundle/README.md`](dsh-bundle/README.md)

## 能力

### 图查询（34 个 MCP 工具）

| 域 | 工具 |
|:--|:--|
| 依赖查询 | `explore_deps` `search_symbols` `get_neighbors` `inspect_symbol` `find_dep_path` |
| 风险分析 | `trace_impact` `preflight_check` `fragile_modules` `detect_cycles` `thread_conflicts` |
| 架构诊断 | `coupling_report` `arch_blindspots` `check_boundaries` `find_unused` |
| 执行流 | `list_flows` `get_flow` `get_affected_flows` |
| 数据流 | `trace_dataflow` `async_edges` |
| 框架路由 | 24 种框架 URL → handler 映射（Express / Django / Rails / Spring …），动态 import / 反射 / DI 合成边 |
| LSP 精确 | `resolve_call` `infer_type` `find_implementations` `find_references`（按需启动） |
| 工程 | `analyze_project` `validate_project` `graph_diff` `rename_symbol` `project_health` `graph_summary` `cluster_report` `project_timeline` `get_community` |
| 系统 | `engine_status` |

每个工具返回结构化 JSON（不是源文件），并附带推荐的下一步工具。

### Agent 运行时（桌面应用内置）

- **领域工具收敛**：`fs` `shell` `git` `search` `web` `agent` `task` `memory` 八个领域动作，旧工具名在模型调用路径直接淘汰
- **每轮 schema 注入全量**：tools 段逐字节稳定，DeepSeek 前缀缓存跨消息命中（可选 `visibleToolsLimit > 0` 回退打分子集）
- **计划模式**：探索 → 计划 → 审批 → 执行，图引擎自动注入影响面
- **Goal 模式**：持久化目标状态，跨会话恢复，普通对话与目标现场完全隔离
- **多 Agent**：spawn / kill / status / merge，git worktree 隔离，TaskBoard / DiscoveryBoard 共享状态，有界 inbox 防背压
- **token 治理**：工具结果滚动折叠、auto-compact、缓存计价下的折叠开关

### 桌面端

<p align="center">
  <img src="assets/screenshots/01.png" width="32%" />&nbsp;
  <img src="assets/screenshots/02.png" width="32%" />&nbsp;
  <img src="assets/screenshots/03.png" width="32%" />
</p>

3D 星图（Three.js + WebGPU）· Monaco 编辑器（点节点即开源码）· 数据流面板 · 时间轴面板 · 虚拟列表聊天（万条消息流畅）· 多厂商 LLM（Anthropic / OpenAI 兼容 / DeepSeek / GLM，含 reasoning_effort 适配）

## 架构

```
┌─────────────── src-ui (TypeScript) ───────────────┐
│  Three.js 星图 · React · Monaco · Agent 运行时    │
└───────────────────────┬───────────────────────────┘
                        │ Tauri IPC
┌─────────────── src-tauri (Rust) ─────────────────┐
│  权限裁决 · OS 沙箱 · 文件所有权 · 审计日志       │
└───────────────────────┬───────────────────────────┘
                        │ TCP :9777
┌───────────────────────▼───────────────────────────┐
│  engine (Rust，单二进制)                          │
│  tree-sitter AST → 并行合并管线 → GraphStore      │
│  MemoryIndex (CSR) + SQLite + FTS5 + 语义向量     │
│  33 MCP 工具 · stdio / CLI 双入口                  │
└───────────────────────────────────────────────────┘
```

| 层 | 目录 | 职责 |
|:--|:--|:--|
| 引擎 | `engine/` | 解析 · 图构建 · 耦合/数据流/脆弱性分析 · 存储 · MCP/CLI |
| 壳 | `src-tauri/` | Tauri 2 · 权限 · 沙箱 · 隔离 · 凭据加密 |
| 前端 | `src-ui/` | 星图渲染 · Agent 运行时 · 多 Agent 编排 |

引擎自举验证：HoloGram 用自己的引擎分析自己的代码库（3965 节点 / 5328 边）。

## 语言支持

18 种语言经手工调校的查询式结构抽取（深度建模）：Python · TypeScript/JavaScript · Rust · Go · Java · C/C++ · C# · Ruby · PHP · Swift · Dart · Scala · Zig · Elixir · Lua · Bash · R

其余语言（OCaml · Haskell · Nix · JSON · HTML · CSS · YAML · Erlang 等）经 tree-sitter grammar 兜底；Kotlin · Markdown · TOML 动态加载。跨语言调用（子进程 / HTTP / FFI）以合成边标记为运行时桥接点。

## 工程事实

- 测试：1640+（engine 643 · 壳 240 · 前端 757），三端独立验证
- 实测（Linux kernel，R10 后）：全量分析 1,770s 全程跑完，RSS 646MB；快照写入 2.44GB / 56.3s
- 并行解析 200 文件/批，边去重 625×，增量更新由 watcher 驱动（保存即刷新）
- 已知盲区以"诚实标记"处理：eval / 动态代码标记为不可达，动态 import 标记动态站点，不假装知道运行时才知道的事

## 从源码构建

```bash
# 引擎（MCP / CLI 只需要这个；Linux / Windows 均可）
cd engine && cargo build --release

# 桌面应用（Windows）
cd src-tauri && cargo tauri build
```

## 开发

```bash
cd engine && cargo test        # 643 引擎测试
cd src-tauri && cargo test     # 240 壳测试
cd src-ui && npx vitest run    # 757 前端测试
```

项目理解与工作纪律见 [`AGENTS.md`](AGENTS.md)；架构与交接文档见 [`docs/`](docs/)（`docs/archive/` 为已竣工施工稿，勿作现状依据）。

## 许可

HoloGram © 2026 Wenbing Jing — [MIT](LICENSE)。第三方组件（tree-sitter 语法库、SQLite、USearch、mimalloc 等）版权声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
