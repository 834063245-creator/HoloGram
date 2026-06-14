# HoloGram

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/834063245-creator/HoloGram?color=orange)](https://github.com/834063245-creator/HoloGram/releases)
[![Stars](https://img.shields.io/github/stars/834063245-creator/HoloGram?style=flat&color=yellow)](https://github.com/834063245-creator/HoloGram/stargazers)
[![CI](https://img.shields.io/badge/tests-911%20passed-brightgreen)](https://github.com/834063245-creator/HoloGram/actions)
[![Coverage](https://img.shields.io/badge/coverage-92%25-44cc11)](https://github.com/834063245-creator/HoloGram/actions)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/834063245-creator/HoloGram/releases)
[![Python](https://img.shields.io/badge/python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Rust](https://img.shields.io/badge/rust-1.80%2B-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Node.js](https://img.shields.io/badge/node-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tauri](https://img.shields.io/badge/tauri-2-67D6B9?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![Three.js](https://img.shields.io/badge/three.js-r184-black?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Monaco](https://img.shields.io/badge/monaco-0.55-1E8BCB?logo=visualstudiocode&logoColor=white)](https://microsoft.github.io/monaco-editor/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/834063245-creator/HoloGram/pulls)

<p align="center">
  <img src="assets/banner.png" alt="HoloGram" />
</p>

**语言无关的交互式代码依赖拓扑图生成器。**

HoloGram 不是又一个静态依赖图工具。三件事让它不同：

- **跨语言统一 IR** — 14 门语言的符号、数据、时序全部映射到同一张图。TypeScript 调用 Python？照样追踪。
- **原生 Agent** — Agent 和图是同一个系统的两层，不是外挂聊天框。Agent 的 30+ 工具直接查预分析好的图数据库，不是喂源文件让 LLM 猜。详见下方。
- **自举** — HoloGram 分析自己的代码库，用自己的图 debug 自己。

也支持纯 CLI 模式，可接入 CI 流水线。

### 原生 Agent

HoloGram 不是"在 IDE 里嵌个聊天框"。Agent 和图是同一个系统的两层——**图是 Agent 的眼睛，Agent 是图的嘴**。

- **30+ 原生工具** — 不是靠喂代码让 LLM 猜。每个工具直接查图数据库：`neighbors` 查邻居、`impact` 追踪波及范围、`coupling-report` 出耦合报告、`blindspots` 标记边界盲点、`cycle` 检测数据流环、`fragile` 列出脆弱依赖、`community` 看社区归属、`history` 追踪节点变更记录。还有代码搜索、文件读写、Shell 执行、Git 全套操作。
- **图即上下文** — Agent 不读源文件，读的是预分析好的图。耦合深度（L1–L4）提前算好，SQLite FTS5 毫秒级检索。一次工具调用返回几十行 JSON 就把上千行源码的依赖关系查清。同样的分析任务，token 消耗远低于全量喂代码。
- **双向实时联动** — 单击节点问 Agent 这个模块；Shift+点击两个节点让 Agent 分析最短依赖路径；Alt+拖框圈选区域批量分析。反过来，Agent 每调用一个工具，3D 视图中受影响的节点实时高亮，路径粒子沿边流动。**不是看图，是和代码库对话。**
- **权限分级** — Shell 执行、Git push、文件写入等危险操作需人工确认。支持 Anthropic 和 OpenAI 兼容接口，API key 本地存储，不上传任何分析数据。

---

## 截图

| | | |
|---|---|---|
| ![](assets/screenshots/01-star-graph.png) | ![](assets/screenshots/02-galaxy-fold.png) | ![](assets/screenshots/03-agent-chat.png) |
| ![](assets/screenshots/04-impact-analysis.png) | ![](assets/screenshots/05-constraint-check.png) | ![](assets/screenshots/06-file-tree.png) |
| ![](assets/screenshots/07-terminal.png) | ![](assets/screenshots/08-detail-card.png) | ![](assets/screenshots/09-git-panel.png) |

---

## 功能

**🪐 3D 交互式星图**

力导向布局 + UnrealBloomPass 发光渲染 + 社区星系折叠 + 边粒子流动。自写 GLSL 全息网格 Shader、扫描线叠加、深空 HUD 美学。支持标准视图、全节点视图、文件级聚合视图三种渲染模式。大项目自动降级到轻量文件图。Tab 一键切换宇宙/星座折叠，双击进入星系内部。

**🌍 14 门语言统一分析**

Python 走标准库 `ast` 精确解析，JavaScript / TypeScript / Go / Rust / Java / C / C++ / Ruby / C# / Kotlin / Swift / PHP / Lua 共 13 门语言通过 tree-sitter。**所有语言输出统一的中间表示（IR）**——跨语言依赖分析天然支持，TypeScript 调用 Python 照样追踪。Grammar 首次使用时自动从 GitHub 下载编译，零配置。

**🧠 三层分析体系（V1 → V2 → V3）**

- **V1 基础拓扑** — 三类节点（SYMBOL 符号 / MEDIUM 介质 / TEMPORAL 时序）× 三类边（STRUCTURAL 结构 / DATA 数据 / TEMPORAL 时序），完整的代码库骨架。
- **V2 深层诊断** — 耦合深度四级分类（L1 公开 API → L4 封装穿透）、数据流环检测（Johnson 算法，区分纯代码/数据持久/LLM 涉入三类环）、线程冲突矩阵（N×M 线程×资源，R/W/RW 访问模式）、边界盲点标记（L4 穿透 + 无锁并发 + LLM 反馈环）。
- **V3 变更路由** — 五级破坏信号（L5 不可逆数据库迁移/API 契约断裂 → L1 仅可见文档变更），可配置 YAML 阈值 + 白名单/黑名单，自动生成人类可读的变更影响摘要。

**🤖 原生 Agent**
30+ 工具直接查图数据库，双向实时联动 3D 视图。详见上方"原生 Agent"段落。


**⚡ 增量实时更新**

文件监听器后台轮询，变更时**仅重分析被修改的文件**，原子替换图中对应节点和边，失败自动回滚。图始终保持最新状态，不需要每次手动重新分析。

**🛡️ 约束门禁（Pre-commit / CI）**

YAML 规则文件，配置变更影响阈值——爆炸半径上限、跨社区容忍度、API 签名变更路由等。L5 不可逆变更**始终报警、不可静默**。关键词黑名单（`password` / `secret` / `token` / `api_key`）强制路由。校验结果（pass / fail）直接编码在 JSON 输出中，可接入 CI。内置约束规则编辑器面板，无需手写 YAML。

**🔬 自举验证**

HoloGram **分析自身代码库**，项目根目录下的 `hologram_graph.json` 是其对自己的依赖分析结果。耦合分布和社区结构可直接查看。这既是功能验证，也是一个活着的样本。

**🎯 更多**

- **内置 IDE 工具** — Monaco 浮动代码编辑器、xterm.js 多标签终端、Git 面板（图形化 stage / unstage / commit / push / pull）。
- **三格式序列化** — JSON 通用交换，MessagePack 二进制格式加速加载，SQLite + FTS5 全文索引毫秒级模糊搜索节点。
- **MCP 持久化服务** — Python 引擎可长驻进程，JSON-RPC 通信，避免重复冷启动。崩溃自动跟踪，3 次/60s 触发降级保护。
- **911 测试覆盖** — pytest 全量覆盖 V1/V2/V3 + 适配器 + CLI + MCP + 集成 + 序列化往返 + 边界条件。
- **Tauri 2 桌面应用** — Windows 提供 `.msi` 安装包，macOS / Linux 可从源码构建。

---

## 安装

### Windows 预编译安装包

从 [Releases](https://github.com/834063245-creator/HoloGram/releases) 下载 `.msi` 安装程序。

### 从源码构建

**环境要求：**
- [Rust](https://rustup.rs/)（stable）
- [Node.js](https://nodejs.org/) ≥ 18
- [Python](https://www.python.org/) ≥ 3.10
- Git，以及 `gcc`（Windows 需 MSYS2/MinGW）用于 tree-sitter grammar 编译
- （Windows）[WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) — Windows 10+ 已预装

```bash
# 1. 克隆仓库
git clone https://github.com/834063245-creator/HoloGram.git
cd HoloGram

# 2. Python 引擎
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[full,dev]"

# 3. 前端
cd src-ui
npm install
npm run build
cd ..

# 4. 桌面应用
cargo tauri build
# 输出: src-tauri/target/release/bundle/msi/*.msi
```

### 仅安装 CLI（Python 引擎）

```bash
pip install -e ".[full]"
hologram analyze ./my-project --json --output graph.json
```

---

## 快速上手

### 桌面应用

1. 启动 HoloGram。
2. 通过文件夹选择器打开一个项目目录。自动分析并渲染 3D 图。
3. **浏览操作：**
   - 单击节点 → 弹出详情卡片（含耦合统计）。
   - Shift+单击两个节点 → 最短依赖路径。
   - Alt+拖框 → 矩形区域选择。
   - 滚轮缩放，右键拖拽旋转。
   - Tab → 切换星系/星座折叠视图。
4. **向 Agent 提问：** 打开聊天面板（右侧停靠栏），输入问题。例如："auth 模块被哪些模块依赖，其中哪些耦合比较脆弱？"
5. **运行校验：** 在项目根目录配置 `hologram.constraints.yaml`，然后在检查面板中验证约束。

### 命令行

```bash
# 分析项目
hologram analyze ./my-project --json --output graph.json

# 查询相邻节点
hologram neighbors auth --json

# 影响范围分析（BFS 深度 3）
hologram impact auth --depth 3 --json

# 最短依赖路径
hologram path auth database --json

# 耦合深度报告
hologram coupling-report auth --json

# 约束校验
hologram check --json
```

---

## 支持语言

| 语言 | 扩展名 | 适配器 |
|---|---|---|
| Python | `.py` | AST（标准库） |
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | tree-sitter |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | tree-sitter |
| Go | `.go` | tree-sitter |
| Rust | `.rs` | tree-sitter |
| Java | `.java` | tree-sitter |
| C | `.c`, `.h` | tree-sitter |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` | tree-sitter |
| Ruby | `.rb` | tree-sitter |
| C# | `.cs` | tree-sitter |
| Kotlin | `.kt`, `.kts` | tree-sitter |
| Swift | `.swift` | tree-sitter |
| PHP | `.php` | tree-sitter |
| Lua | `.lua` | tree-sitter |

Tree-sitter grammar 在首次使用时自动从 GitHub 下载编译，需要系统 PATH 中有 `git` 和 `gcc`。

---

## 架构

```
┌──────────────────────────────────────────────────────┐
│  桌面壳 (Tauri 2)                                     │
│                                                      │
│  ┌──────────────┐  IPC   ┌────────────────────────┐  │
│  │ 前端           │◄─────►│ Rust 后端               │  │
│  │ (TypeScript)  │       │ (main.rs · 50 个命令)    │  │
│  │               │       │                         │  │
│  │ Three.js 3D   │       │ Python 子进程管理        │  │
│  │ Agent 聊天    │       │ 文件系统 / Git           │  │
│  │ Monaco 编辑器 │       │ Shell / 终端             │  │
│  │ xterm.js      │       │ MCP 服务生命周期         │  │
│  └──────────────┘       └───────────┬─────────────┘  │
│                                     │                 │
└─────────────────────────────────────┼─────────────────┘
                                      │ spawn / JSON-RPC
                          ┌───────────▼─────────────┐
                          │ Python 引擎               │
                          │ (src_python/)            │
                          │                          │
                          │ 管线: 发现 → 分析 →       │
                          │ 跨文件 → 社区 → 序列化    │
                          │                          │
                          │ 三条适配路径:             │
                          │  · Python AST            │
                          │  · TypeScript 适配器     │
                          │  · Tree-sitter (15+ 语言)│
                          │                          │
                          │ 输出: JSON / MsgPack     │
                          │ / SQLite / file-graph    │
                          └──────────────────────────┘
```

Rust 层**不做任何分析**。它只负责管理 Python 子进程、路由 IPC、提供系统集成。所有代码分析逻辑在 Python 引擎中，前端渲染与 Agent 完全在 WebView 内运行。

---

## 依赖图数据模型

每次分析产出一张包含三类节点和三类边的图：

| 节点类型 | 示例 |
|---|---|
| `SYMBOL` | 函数、类、模块、接口、变量、常量 |
| `MEDIUM` | 文件、数据库、队列、缓存、网络、共享内存 |
| `TEMPORAL` | 线程、定时器、事件循环、触发器 |

| 边类型 | 示例 |
|---|---|
| `STRUCTURAL` | 调用、继承、实现、导入、引用、实例化 |
| `DATA` | 读、写、订阅 |
| `TEMPORAL` | 执行于、触发、阻塞 |

每条结构边进一步按**耦合深度**分为四级（L1–L4）：

- **L1** — 公开 API 调用（蓝色实线）
- **L2** — 模块内部导入（浅蓝实线）
- **L3** — 共享数据文件（橙色虚线）
- **L4** — 封装穿透（红色虚线）

---

## 约束校验

在项目根目录放置 `hologram.constraints.yaml`：

```yaml
routing:
  L5:
    enabled: true                 # 始终开启，不可关闭
  L4:
    enabled: true
    blast_radius_threshold: 20
    cross_community_tolerance: 0
  L3:
    enabled: true
  L2:
    enabled: true
  L1:
    enabled: false                # 仅可见；LLM 可自行修复

allowlist:                        # 豁免 L4/L3 检查的模块
  L4: ["tests/"]
denylist:                         # 强制路由，无视级别
  keywords: ["password", "secret", "token", "api_key"]
```

执行校验：

```bash
hologram check --json
# pass/fail 信息编码在 JSON 输出中，可接入 CI 流水线
```

---

## 开发

```bash
# Python 测试 (911 用例)
pytest tests/ -x -q

# Rust 类型检查
cargo check --manifest-path src-tauri/Cargo.toml

# 前端开发服务器（使用 mock 数据，无需 Rust）
cd src-ui && npm run dev

# 完整生产构建
cd src-ui && npm run build && cd .. && cargo tauri build
```

**项目结构：**

```
src_python/     Python 分析引擎
src-ui/         TypeScript 前端（Vite + Three.js）
src-tauri/      Rust / Tauri 桌面壳
tests/          Python 测试集（pytest）
assets/         应用图标及 UI 原型
```

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
