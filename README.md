<p align="center">
  <img src="assets/banner.png" alt="HoloGram" />
</p>

<p align="center">
  <strong>© 2026 Wenbing Jing. Licensed under MIT.</strong><br/>
  <em>This software is free for any use. Attribution required.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/HoloGram?color=orange" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-400%2B%20total-brightgreen" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/badge/platform-Windows-blue" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" /></a>
</p>

<br/>

> **给你的 AI 编程助手装一双"眼睛"。** HoloGram 把你的代码库变成一张依赖拓扑图——Agent 不用逐层翻源文件，一次工具调用就知道"改这里会不会炸"、"哪些地方会被波及"。26 门语言零配置，省 ~70% token。

---

## 目录

- [什么人需要这个](#什么人需要这个)
- [5 分钟上手](#5-分钟上手)
- [它能做什么](#它能做什么)
- [真实案例：改一个函数会炸多少](#真实案例改一个函数会炸多少)
- [桌面应用（可选）](#桌面应用可选)
- [支持的语言](#支持的语言)
- [工具地图](#工具地图)
- [架构总览](#架构总览)
- [从源码构建](#从源码构建)
- [已知局限](#已知局限)
- [常见问题 (FAQ)](#常见问题-faq)
- [故障排查](#故障排查)
- [开发](#开发)
- [许可证](#许可证)

---

## 什么人需要这个

| 你是 | 你遇到的问题 | HoloGram 怎么帮你 |
|------|-------------|-------------------|
| **AI 编码工具用户**（Claude Code / Cursor / Copilot） | Agent 读源文件猜依赖，一层层翻代码，又慢又容易漏。token 烧得快，弱模型还经常翻漏 | 全库依赖提前算好，Agent 调工具拿结构化依赖数据，一次调用代替逐层翻文件。改前自动告诉你波及范围 |
| **接手老项目的开发者** | 代码库没文档、不知道模块之间的真实关系、不敢随便改 | 打开项目 → 3D 星图直接看依赖关系。谁调了谁、改了谁会炸，一目了然 |
| **技术负责人 / 架构师** | 需要盯模块边界、防止循环依赖、管控架构腐化 | 自定义约束规则 → 越界自动标红。循环依赖检测、脆弱模块排名、架构盲区扫描，随时跑 |

> **简单说：如果你在用 AI 写代码，HoloGram 让 AI 更聪明。如果你是人在维护代码，HoloGram 让你更快看懂。**

---

## 5 分钟上手

### 方式一：MCP 模式（推荐，零界面，1 分钟搞定）

**不需要桌面应用。** 引擎是单文件二进制，26 种语法静态链接，零依赖。配进 Claude Code / Cursor 直接用。

#### 🤙 一句话安装

复制下面这段话，发给 Claude Code / Cursor，Agent 自己搞定：

```
请帮我安装 HoloGram MCP 服务。步骤：

1. 从 https://github.com/834063245-creator/HoloGram/releases 下载最新版 hologram-engine.exe
2. 放到用户主目录下的 .hologram 文件夹（没有就新建）
3. 在当前 AI 编程工具的 MCP 配置中注册：
   - Windows: ~/.hologram/hologram-engine.exe
   - macOS/Linux: ~/.hologram/hologram-engine（下载后 chmod +x）
   - 参数：serve
4. 重启 AI 编程工具，调 engine_status 验证
```

**不用懂技术。复制、粘贴、回车。**

安装成功后，在你的 AI 编码工具里直接问：「分析这个项目」「改 auth.py 会炸吗」「有没有循环依赖」——Agent 会自动调用 HoloGram 工具。

#### 手动配置（如果你更习惯自己来）

**Claude Code：** 在 `~/.claude/mcp.json` 中添加：
```json
{
  "mcpServers": {
    "hologram": {
      "command": "~/.hologram/hologram-engine.exe",
      "args": ["serve"]
    }
  }
}
```

**Cursor：** 在 Cursor Settings → MCP → Add new MCP server 中添加，command 填 `~/.hologram/hologram-engine.exe`，args 填 `serve`。

> 引擎单文件零依赖，下载即用。想自己编译？见[从源码构建](#从源码构建)。

### 方式二：桌面应用

从 [Releases](https://github.com/834063245-creator/HoloGram/releases) 下载 `.msi`，双击安装。

打开 → 选项目目录 → 自动分析 → 3D 星图渲染。单击节点看详情，聊天面板问 Agent。

> ⚠️ 桌面应用目前仅支持 Windows。macOS/Linux 用户请用 MCP 模式。

---

## 它能做什么

| 能力 | 说白了就是 |
|------|-----------|
| **改前查影响** | 改一个文件 → 立刻看到会波及哪些文件、哪些模块。不用搜、不用一层层翻代码。Agent 的 preflight hook 在 `edit_file` / `write_file` 执行前**自动注入 ⚠️ 影响分析** |
| **自动抓越界** | 模块之间乱 import？自动标红。你定规则，它替你盯着。支持 glob/regex 模式匹配 |
| **给 Agent 省 token** | Claude Code / Cursor 里直接用。Agent 不用读源文件猜依赖，一次调用拿结构化依赖数据，典型场景省 ~70% token |
| **3D 代码地图** | 代码库变星图，谁依赖谁、谁在调用谁，一眼看穿。5000 个文件不卡。支持 GPU 加速布局 |
| **保存即刷新** | 代码改了保存 → 图自动更新。缓存过期检测——源文件更新时自动重分析 |
| **26 门语言，零配置** | Python · TS/JS · Go · Rust · Java · C/C++ · Ruby · Lua · C# · Swift · Dart · Scala · Haskell · HTML · CSS · PHP · OCaml · R · Nix · Bash · YAML · Zig · Elixir · Erlang · Kotlin · TOML · Markdown。打开项目直接出图 |

---

## 真实案例：改一个函数会炸多少

### 场景：改 `auth.py` 里的 `validate_token()` 函数

#### 不用 HoloGram：Agent 逐层翻文件

| 步骤 | Agent 在干什么 | 实际消耗 |
|------|---------------|---------|
| 1 | 读 `auth.py`，找到 `validate_token` 的定义和它 import 了谁 | ~800 token |
| 2 | 发现 import 了 `models.py` → 读 `models.py` | ~700 token |
| 3 | 发现 import 了 `utils.py` → 读 `utils.py` | ~600 token |
| 4 | 全局搜索谁调了 `validate_token` | ~400 token |
| 5-7 | 搜到 3 个调用者 → 逐个读文件 | ~2,100 token |
| 8 | Agent 综合推理、输出结论 | ~1,200 token |
| 9 | `scheduler/tasks.py` 通过 `call_capability` 间接调用 — **漏了** | **漏报** |

> 单次查询消耗 ~5,800 token。更大的问题：间接调用 Agent 没全局索引根本发现不了。

#### 用 HoloGram：一次工具调用

| 步骤 | Agent 在干什么 | 实际消耗 |
|------|---------------|---------|
| 1 | 调 `explore_deps("validate_token auth")` | ~500 token |
| 2 | 引擎返回结构化 JSON：4 个直接调用者 + 1 个间接调用者 + 风险等级 | ~1,200 token |

> 单次查询消耗 ~1,700 token。省 ~70%。间接调用图里有 `capability_call` 边——**零静态漏报**。

### 拉长了算

| | 不用 HoloGram | 用 HoloGram | 省 |
|------|------|------|------|
| 单次依赖查询 | ~5,800 token | ~1,700 token | **~4,100 token (~70%)** |
| 一次编码会话（5 次查询） | ~29,000 token | ~8,500 token | **~20,000 token** |
| 重度用户月均（30 次会话） | ~870,000 token | ~255,000 token | **~600,000 token** |
| 十人团队月均 | ~8,700,000 token | ~2,550,000 token | **~6,000,000 token** |

> **Token 省的是小头。大头是：弱模型推依赖容易漏，HoloGram 给的图是确定性静态分析——比靠读源文件猜依赖可靠得多。**

### 🧪 真实案例：FirstBeat Ultimate 项目体检

2026-06-21，一次完整的项目健康检查。项目规模：218 个符号、322 条边、~4,400 行 Python。

| 你想知道的 | HoloGram 1 次调用 | 不用 HoloGram 要怎么做 | 省多少 |
|------|------|------|------|
| 有没有循环依赖？ | `detect_cycles` → 200 token | 读完全仓 21 个 .py，人工追踪所有 import + 调用关系，画图找环 | **~500x** |
| 哪些模块最脆弱？ | `fragile_modules` → 300 token | 对 218 个符号逐个 grep 所有引用位置，按 fan-in 排序 | **~150x** |
| 整体结构（社区聚类） | `graph_summary` + `cluster_report` → 2,500 token | 读完所有文件后人工分 32 个社区——**基本不可行** | **~40x** |
| 改 engine.close 会炸多少？ | `trace_impact` → 800 token 返回 63 节点 BFS 树 | 手动追踪 3 层调用链，涉及 8-10 个文件 | **~37x** |

**单点查询省 70%，全局分析省 95%（20 倍以上）。** 项目越大，差距越悬殊。

---

## 桌面应用（可选）

如果你更喜欢可视化界面，HoloGram 也提供桌面应用：

<p align="center">
  <img src="assets/screenshots/01.png" width="24%" />&nbsp;
  <img src="assets/screenshots/02.png" width="24%" />&nbsp;
  <img src="assets/screenshots/03.png" width="24%" />&nbsp;
  <img src="assets/screenshots/04.png" width="24%" />
</p>
<p align="center">
  <img src="assets/screenshots/05.png" width="24%" />&nbsp;
  <img src="assets/screenshots/06.png" width="24%" />&nbsp;
  <img src="assets/screenshots/07.png" width="24%" />&nbsp;
  <img src="assets/screenshots/08.png" width="24%" />
</p>

**桌面应用特色：**
- **3D 代码星图：** Three.js + WebGPU 渲染，支持缩放、旋转、拖拽。颜色按社区聚类
- **内置 Agent 聊天面板：** 直接在应用里对话，支持文件操作、Git、Shell、Web 搜索
- **Monaco 编辑器：** 点击图中节点 → 右侧直接打开源码
- **数据流面板：** 追踪变量读写路径，可视化数据流向
- **时间轴面板：** 查看项目变更历史和分析记录
- **子 Agent 并行：** git worktree 隔离，多个 Agent 同时工作不冲突
- **记忆系统：** Markdown + AuraSDK 语义召回，Agent 跨会话记住上下文

> 桌面应用的引擎和 MCP 模式是同一个——所有图分析能力完全一致。

---

## 支持的语言

26 门语言静态链接（tree-sitter）+ 3 门动态加载（DLL）：

```
Python · TypeScript/JavaScript · Go · Rust · Java · C/C++ · Ruby · Lua · C#
Swift · Dart · Scala · Haskell · HTML · CSS · PHP · OCaml · R · Nix · Bash
YAML · Zig · Elixir · Erlang · Kotlin · TOML · Markdown
```

> 引擎内置扩展名映射。零配置——打开项目目录，自动识别语言。

---

## 工具地图

HoloGram 引擎暴露 30 个图查询工具，配合 Agent 内置的 50+ 操作工具（文件、Git、Shell、搜索、Web、记忆、任务、隔离），覆盖从"查依赖"到"改代码"的完整链路。

### 图查询工具（30 个）

| 类别 | 工具 | 用途 |
|------|------|------|
| **日常查询** | `explore_deps` `search_symbols` `get_neighbors` `inspect_symbol` | "这个函数连了哪些东西？" "谁在调它？" |
| **风险评估** | `trace_impact` `preflight_check` `fragile_modules` `detect_cycles` | "改这里会炸吗？" "有没有循环依赖？" |
| **架构诊断** | `arch_blindspots` `thread_conflicts` `coupling_report` `check_boundaries` | "有没有隐藏的架构问题？" "模块边界有没有被偷越？" |
| **数据流** | `trace_dataflow` `async_edges` `find_dep_path` | "这个变量在哪被改了？" "A 是怎么依赖到 B 的？" |
| **全局视野** | `graph_summary` `cluster_report` `project_health` `project_timeline` | "项目整体怎么样？" "有哪些子系统？" |
| **LSP 精确** | `resolve_call` `infer_type` `find_implementations` `find_references` | "这个调用到底调的是哪个实现？" "谁实现了这个接口？" |
| **工程** | `analyze_project` `validate_project` `graph_diff` `find_unused` `rename_symbol` | 全量分析、约束校验、对比变更、找死代码、安全重命名 |

> **所有工具对 Agent 透明——Agent 不区分来源，统一调用。** 工具返回的是结构化依赖数据（JSON），不是源文件——省 token。

### 编码操作工具（Agent 内置）

文件读写 · Git 全套（commit/push/pull/branch/stash）· Shell 命令 · 文本搜索 · 文件查找 · Web 搜索/抓取 · 记忆系统 · 任务追踪 · 子 Agent 分叉

---

## 架构总览

```
┌─ 桌面壳 (Tauri 2) ───────────────────────────────────────────────────────────┐
│  ┌─ 前端 (TypeScript) ──────────────────────┐  IPC  ┌─ Rust 后端 ──────────┐ │
│  │ 3D 星图 (Three.js)  ·  Agent 面板        │◄────►│ 权限裁决 (6 步级联)   │ │
│  │ Monaco 编辑器 · 数据流面板 · 时间轴       │      │ OS 沙箱 · Agent 隔离  │ │
│  │ WebGPU 布局 · React UI · LSP 客户端       │      │ PTY 终端 · 审计日志   │ │
│  └───────────────────────────────────────────┘      └───────┬──────────────┘ │
└─────────────────────────────────────────────────────────────┼────────────────┘
                                                              │ MCP stdio
            ┌─────────────────────────────────────────────────▼──────────────┐
            │ Rust 引擎 (engine/)                                             │
            │ 合并管线 · 全局边去重 (625×) · 30 图工具 · 四级过滤            │
            │ MemoryIndex + SQLite FTS5 · 增量更新 · 社区发现 (Leiden)       │
            │ 数据流引擎 (17 语言) · 18 框架路由 · LSP 按需 · AuraSDK 记忆    │
            └────────────────────────────────────────────────────────────────┘
```

**三层职责：**

| 层 | 目录 | 技术栈 |
|------|------|------|
| 引擎 | `engine/` | Rust — tree-sitter 解析、图构建、分析、存储、MCP 服务 |
| 壳 | `src-tauri/` | Rust/Tauri 2 — 权限系统、OS 沙箱、Agent 隔离、凭据加密 |
| 前端 | `src-ui/` | TypeScript — Three.js 星图、React UI、Agent 循环、WebGPU |

> 引擎以 Rust 库直接链接进 Tauri 进程，不走子进程。MCP 用户通过 `engine.exe serve` stdio 通信。**HoloGram 用自己的引擎分析自己的代码库——自举验证。**

---

## 从源码构建

**系统要求：** Rust 1.80+ · Node.js 20+ · Windows 10+（桌面应用）

```bash
git clone https://github.com/834063245-creator/HoloGram.git
cd HoloGram

# 仅引擎（MCP 模式只需要这个）
cd engine && cargo build --release    # → engine/target/release/hologram-engine.exe

# 桌面应用
cd src-tauri && cargo tauri build     # → src-tauri/target/release/bundle/
```

---

## 已知局限

静态分析不是万能。以下是 tree-sitter 方案的天花板——这些不是 bug，是物理上限。诚实列出：

| 盲区 | 说明 | 状态 |
|------|------|------|
| 字符串路由 | Express/Django 等路由字符串 → handler 的映射 | ✅ 18 种框架已覆盖 |
| 动态 import / require | `import(variable)`/`require(expr)` | ✅ 动态导入站点已标记 |
| 反射 / 依赖注入 | getattr/@Autowired/@Injectable 等 | ✅ 10 语言已处理 |
| 跨语言调用 | 子进程/FFI/HTTP client → 运行时桥接点已标记 | ✅ 8 语言已覆盖 |
| eval / 动态代码生成 | eval/exec/new Function | ✅ 已诚实标记为不可达 |

> 五项盲区已全部通过合成边和标记节点给出了诚实的答案。静态分析有天花板——我们选择诚实面对，一项一项解决。

---

## 常见问题 (FAQ)

### 安装与使用

<details>
<summary><strong>MCP 模式和桌面应用有什么区别？</strong></summary>

引擎完全一样——同一套图分析能力。MCP 模式没有界面，通过 Claude Code / Cursor 等 AI 工具的 MCP 协议调用。桌面应用多了 3D 可视化、编辑器、聊天面板等 UI。选 MCP 如果你只需要 Agent 增强；选桌面应用如果你想要可视化浏览代码库。
</details>

<details>
<summary><strong>支持 macOS / Linux 吗？</strong></summary>

**MCP 模式：** 理论上支持（需要从源码编译引擎，`cargo build --release`）。tree-sitter 语法和 Rust 代码是跨平台的。

**桌面应用：** 目前仅 Windows。Tauri 2 框架本身跨平台，但桌面应用部分有 Windows 特定代码（JobObject 沙箱、DPAPI 凭据加密、WebView2）。macOS/Linux 移植需要改沙箱和凭据层。
</details>

<details>
<summary><strong>需要联网吗？引擎会发送代码到外部吗？</strong></summary>

**不会。** 引擎在本地运行，所有分析在本地完成。代码永远不会离开你的机器。唯一的网络请求是：1) 桌面应用内的 Agent 调用 LLM API（你配置的 API key）；2) Web 搜索工具（Agent 手动触发时）。
</details>

<details>
<summary><strong>大项目会卡吗？</strong></summary>

不会。引擎用 rayon 并行解析（200 文件/批），全局边去重 625× 削减。Django 3031 文件 ~4.1 秒完成全量分析。3D 星图用 GPU 加速布局，5000 节点流畅渲染。增量更新模式下，保存文件秒级反映到图。
</details>

<details>
<summary><strong>能分析多大规模的项目？</strong></summary>

实测无上限。四级过滤自动排除 node_modules/vendor/target 等三方目录。文件 > 1 MB 自动跳过（如 sqlite3.c 9.3 MB）。引擎自身 3965 节点 / 5328 边，毫秒级查询。
</details>

### 功能与限制

<details>
<summary><strong>能跨语言追踪依赖吗？</strong></summary>

能。多语言项目（如 Python 后端 + TypeScript 前端）统一建模进一张图。跨语言调用（子进程、HTTP client、FFI）通过合成边标记为运行时桥接点。
</details>

<details>
<summary><strong>反射和动态调用能检测吗？</strong></summary>

部分能。反射/DI 注入（getattr、@Autowired、@Injectable）通过类型级解析补充。纯字符串反射（`getattr(obj, some_string_var)`）标记为动态站点。都是诚实标记——不假装知道运行时才知道的事情。
</details>

<details>
<summary><strong>和 SonarQube / CodeClimate 有什么区别？</strong></summary>

HoloGram 不替代它们——互补。SonarQube 做代码质量（bug、漏洞、坏味道），HoloGram 做依赖拓扑和 Agent 增强。你用 SonarQube 发现代码问题，用 HoloGram 让 AI 更聪明地改代码。
</details>

### 价格与许可

<details>
<summary><strong>收费吗？</strong></summary>

**完全免费。** MIT 开源协议。引擎、桌面应用、MCP 服务全部免费。你可以商用、修改、再发布——只需保留版权声明。
</details>

<details>
<summary><strong>LLM API 费用呢？</strong></summary>

Agent 功能需要你自己配置 LLM API key（支持 Anthropic / OpenAI 兼容接口）。HoloGram 不提供 API key，不收取任何费用。API 费用由 LLM 提供商收取。
</details>

---

## 故障排查

### MCP 模式

| 问题 | 可能原因 | 解决 |
|------|---------|------|
| `engine_status` 没反应 | MCP 服务没注册 | 检查 MCP 配置文件路径和 command 是否正确 |
| 工具返回空结果 | 引擎还没分析项目 | 先调 `analyze_project` 对项目目录做全量分析 |
| "engine not found" | 引擎文件不在预期位置 | 确认 `~/.hologram/hologram-engine.exe` 存在且有执行权限 |
| 引擎启动失败 | 缺少运行时依赖 | Windows 需要 VC++ Redistributable。macOS/Linux 从源码编译时确保 Rust toolchain 完整 |

### 桌面应用

| 问题 | 可能原因 | 解决 |
|------|---------|------|
| 打开白屏 / 加载失败 | WebView2 未安装 | 下载安装 [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) |
| 分析一直转圈 | 项目太大 / 有巨型文件 | 耐心等待（首次分析需要时间）。检查日志：`.hologram/logs/engine.log` |
| 3D 图卡顿 | GPU 驱动问题 | 尝试更新显卡驱动。WebGPU 需要较新驱动 |
| Agent 对话无响应 | API key 未配置或无效 | 检查设置面板中的 API 配置。确认 API endpoint 和 key 正确 |

### 通用

| 问题 | 解决 |
|------|------|
| 分析结果和预期不符 | 检查是否跳过了关键文件——看 `.hologram/logs/engine.log` 中的过滤日志 |
| 增量更新不生效 | 尝试手动触发全量分析：`analyze_project` 或重启桌面应用 |
| 怎么报 bug？ | [GitHub Issues](https://github.com/834063245-creator/HoloGram/issues) — 附上 `.hologram/logs/` 下的日志 |

---

## 开发

```bash
cd engine && cargo test              # 363+ Rust tests
cd engine && cargo build --release   # 编译引擎
cargo tauri build                    # 打包桌面应用
cd src-ui && npm run build           # 类型检查 + 打包前端
```

```
engine/          Rust 引擎 — 合并管线 · 四级过滤 · 数据流引擎 · 框架路由 · LSP · 30 图工具
src-tauri/       Rust / Tauri 壳 — 权限系统 · OS 沙箱 · Agent 隔离 · PTY · 凭证 · 审计
src-ui/          TypeScript 前端 — Three.js · React · Monaco · Agent 循环 · WebGPU
assets/          图标 · 截图
grammars/        动态语法 DLL (Kotlin / TOML / Markdown)
build/           构建脚本
```

### 分析管道

| 阶段 | 说明 |
|------|------|
| 1. 文件发现 | 四级过滤 — 硬编码黑名单（30 目录名）+ `.gitignore` 解析 + 扩展名匹配 + 1 MB 上限 |
| 2. 并行解析 + 合并 | 200 文件/批，rayon 并行 parse，串行 merge。全局节点/边去重（625× 削减） |
| 3. 类型感知调用解析 | 8 门语言手写 tree-sitter 类型级调用解析，30s 超时熔断 |
| 4. 跨文件解析 | import → 调用链连接，跨文件符号引用 |
| 5. 耦合分析 | 所有边赋值 L1-L4 耦合深度 |
| 6. 框架路由 | 18 种框架 URL→handler 映射注入 |
| 7. 动态调度合成 | addEventListener / .on() / .then() / .subscribe() 回调边 |
| 8. 社区发现 + 持久化 | Leiden 层次社区发现，MemoryIndex + SQLite |

### 存储引擎

| 组件 | 特点 |
|------|------|
| MemoryIndex | 邻接表 + 倒排索引，O(degree) 查询 |
| SqliteDb | hologram.db 持久化 + FTS5 全文搜索 |
| GraphStore | MemoryIndex + SqliteDb，`parking_lot::RwLock` N 路并发读 |
| 增量更新 | watcher → 防抖 → 增量重解析 → diff → 边修复 → 原子 swap |

### 图数据模型

**节点（8 种）：** Symbol · Function · Class · Module · File · Interface · Medium（存储/IO）· Temporal（异步任务）。每个节点携带 `location`（文件:行号）、`out_degree`/`in_degree`、`community_id`、`position`（3D 坐标）。

**边（10 种）：** 
- 结构边：`imports` `calls` `inherits` `defines`（管道预计算）
- 数据边：`reads` `writes` `shares`（数据流引擎按需查询）
- 时序边：`triggers` `awaits` `sequences`（数据流引擎按需查询，带 `temporal_delay_sec`）

每条边附加 `coupling_depth`（L1-L4）、`cross_file`、`direction`、`lsp_resolved`。

---

## 许可证

HoloGram © 2026 Wenbing Jing — [MIT](LICENSE)

本项目使用了多个第三方开源组件（AuraSDK、tree-sitter 语法库、SQLite、mimalloc、USearch 等）。完整版权声明和许可证文本见 **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)**。
