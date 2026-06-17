<p align="center">
  <img src="assets/banner.png" alt="HoloGram" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/HoloGram?color=orange" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-293%20passed-brightgreen" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/badge/platform-Windows-blue" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" /></a>
</p>

> **语言无关的交互式代码依赖拓扑图生成器。**
>
> 不是又一个静态分析工具。HoloGram 把代码库变成一张可对话的 3D 星图——18 门语言统一 IR、原生 LLM Agent 双向联动、从 L1 公开 API 到 L4 封装穿透四层耦合诊断。纯 Rust 引擎，桌面应用。

---

## 三件事让它不同

| **🌍 跨语言统一 IR** | **🤖 图即 Agent 的眼睛** | **🔬 自举验证** |
|---|---|---|
| 18 门语言全部映射到同一张图。TypeScript 调 Python、Rust 调 Go——照样追踪。 | 46 个原生工具直查图数据库，不是喂源文件让 LLM 猜。耦合深度 L1–L4 提前算好，SQLite FTS5 毫秒检索。Agent 和图是同一系统的两层——图是眼睛，Agent 是嘴。 | 用自己的图 debug 自己。项目根目录下的依赖分析结果随时可查——既是验证，也是活样本。 |

---

## 截图

<p align="center">
  <img src="assets/screenshots/01-star-graph.png" width="32%" />&nbsp;
  <img src="assets/screenshots/02-galaxy-fold.png" width="32%" />&nbsp;
  <img src="assets/screenshots/03-agent-chat.png" width="32%" />
</p>
<p align="center">
  <img src="assets/screenshots/04-impact-analysis.png" width="32%" />&nbsp;
  <img src="assets/screenshots/05-constraint-check.png" width="32%" />&nbsp;
  <img src="assets/screenshots/06-file-tree.png" width="32%" />
</p>
<p align="center">
  <img src="assets/screenshots/07-terminal.png" width="32%" />&nbsp;
  <img src="assets/screenshots/08-detail-card.png" width="32%" />&nbsp;
  <img src="assets/screenshots/09-git-panel.png" width="32%" />
</p>
<p align="center">
  <img src="assets/screenshots/10-translator.png" width="65%" />
  <br/><sub>🔄 代码翻译器 — LLM 逐行翻译 · 三栏审计</sub>
</p>

---

## 🪐 特色体验

<table>
<tr>
<td width="50%" valign="top">

### 🔄 代码翻译器
选中源文件 → LLM 逐行翻译 → 三栏并排审计（原文 ‖ 译文 ‖ Diff）。跨语言移植，缓存自动落盘 `.hologram/translations/`。FileViewer 内集成，Ctrl+T 一键触发。

</td>
<td width="50%" valign="top">

### ⚡ 保存即刷新
文件保存 → watcher 秒级检测 → 引擎增量更新 → 星图静默刷新。全程无需手动触发，图始终与代码同步。

</td>
</tr>
<tr>
<td valign="top">

### 📋 简报 → 星图一键跳转
保存文件 → 引擎自动跑约束校验 → 违规项实时出现在简报面板。点击任意违规行 → 星图平滑飞行到对应节点。从"哪里违规"到"违规在哪"——零步操作。

</td>
<td valign="top">

### 🥧 右键 Pie Menu
节点上右键 → 环形菜单弹出：波及范围 / 聚焦飞行 / 最短路径 / 节点详情。Blender 式的肌肉记忆交互，无需工具栏，手指不离鼠标。

</td>
</tr>
<tr>
<td valign="top">

### 🔭 三层折叠视图
Tab 循环切换。**宇宙层** — 每个社区一团螺旋星云（golden ratio 色调）。**星座层** — 星云展开为节点群，跨星系边可见。**Galaxy 内部** — 双击星系进入单社区全连接图，Esc 退出。粒子在星系间沿边流动。

</td>
<td valign="top">

### ⏳ 决策时间轴
每次分析、check、文件变更自动记录时间轴。左侧面板滑入，按时间倒序排列。谁改了什么、什么时候改的、引发了什么——一条线看透项目演化历史。

</td>
</tr>
<tr>
<td valign="top">

### 📦 冷启动秒开
MessagePack 二进制直读，缓存优先策略。打开项目 → 已有缓存即秒显上次图，引擎后台静默更新。大项目不再等——先看到图，再等最新。

</td>
<td valign="top">

### ⚡ InstancedMesh 规模化
N 个 `THREE.Mesh` → 1 个 `THREE.InstancedMesh`。5000 节点场景 **1 draw call，60 FPS**。hover / click / 高亮 / 波及 / 折叠——全部走 `setColorAt` + `_setCoreScale` API，零性能损耗。

</td>
</tr>
<tr>
<td colspan="2" valign="top">

### 🔥 感知升级三件套
**复发热点：** 同一文件多次触发 L4 警报 → 星图着色自动升级，越危险越红。&nbsp;&nbsp;|&nbsp;&nbsp;
**冲突预演：** 双分支 diff 叠加耦合分析，合并前预知冲突。&nbsp;&nbsp;|&nbsp;&nbsp;
**门禁模式：** 新模块加入自动评估 fan-in / fan-out / 耦合深度分布。

</td>
</tr>
</table>

---

## 🤖 原生 Agent

**图是眼睛，Agent 是嘴——同一个系统的两层，天然共生。**

| 能力 | 说明 |
|---|---|
| **48 个原生工具直查图数据库** | 24 个图查询（explore / neighbors / impact / path / coupling-report / blindspots / cycle / fragile / community / history / search / check / preflight / health / diff / timeline …）+ 19 个编码（文件读写 / Shell / Git / WebFetch）+ 4 个记忆（memory list/read/save/delete）+ 子 Agent spawn。Agent 不喂源文件——一次工具调用几十行 JSON 查清上千行源码的依赖，Token 消耗远低于全量读代码。 |
| **Agent ↔ 星图双向实时联动** | Agent 调工具 → 3D 视图实时高亮受影响节点，粒子沿边流动。path → 路径高亮，fragile → 脆弱节点标琥珀，cycle → 循环节点标红，impact → 聚焦飞行，diff → 绿增红删。 |
| **图作为输入设备** | **Shift+双节点** → BFS 最短路径 → Agent 自动分析依赖链风险。**Alt+框选区域** → Agent 自动总结模块关系。**单击节点** → 详情卡 + "问 Agent"入口。 |
| **全面板覆盖** | 星图详情卡 · 简报违规行 · 文件查看器 · 文件树 · 时间轴事件 · 约束面板——6 个面板全部有"问 Agent"按钮，点一下打开聊天窗自动发送上下文。 |
| **Agent 透镜 & 轨迹** | 图上只亮 Agent 访问过的节点（其余 1% 透明度）+ 渐变虚线串联最近 20 步推理序列。一键切换透镜开关，看清 Agent "看过哪里"。 |
| **NL 自然语言探索** | `hologram_explore` 接受自然语言查询——"DataRequest 怎么 validate"——引擎自动切词消歧，BFS 路径搜索，一次返回 Flow + Blast Radius + Relationships + Source Code + Architecture Alerts。 |
| **会话持久化** | 对话历史自动保存到 `.hologram/chat_sessions.json`，重启/切换项目后恢复——换个项目回来接着聊。 |
| **权限分级** | Shell、Git push、文件写入等危险操作人工确认。API key 本地存储，数据不上传。支持 Anthropic / OpenAI 兼容接口。 |

---

## 功能规格

| 🪐 **3D 星图** | 🌍 **18 语言** | 🧠 **四层分析** |
|---|---|---|
| 力导向 + BloomPass 发光 + 全息网格 Shader + 粒子流动。三种渲染模式。大项目自动降级轻量文件图。 | Rust 引擎 tree-sitter 统一分析。18 种 grammar 静态链接，零配置。 | V1 基础拓扑 → V2 深层诊断（L1–L4 耦合/数据流环/线程冲突/盲点）→ V3 变更路由（五级破坏信号 + YAML 阈值）→ 动态调度合成（callback/observer 边检测）。 |

| ⚡ **Rust 全量引擎** | 🛡️ **约束门禁** | 🎯 **内置 IDE 工具** |
|---|---|---|
| 存储引擎 v2.5：MemoryIndex（邻接表 + 倒排索引）+ SqliteDb（持久化 + FTS5 全文搜索）+ 增量更新。Django 3,031 文件 4.1s。 | YAML 规则。L5 不可逆变更永报警。黑名单关键词强制路由。结果编码在 JSON 中，可入 CI。 | Monaco 浮动编辑器 · xterm.js 多标签终端 · Git 面板（stage / diff / commit / push / pull）。 |

| 📦 **三格式序列化** | 🔌 **MCP 长驻服务** | ✅ **293 测试** |
|---|---|---|
| JSON 通用交换 · MessagePack 二进制加载 · SQLite + FTS5 全文模糊搜索。 | Rust 引擎长驻，JSON-RPC over stdio + TCP :9777 双模。崩溃 3 次/60s 自动降级。 | Rust `#[test]` 全覆盖：图数据模型、适配器、管线、耦合分析、社区发现、路由、存储引擎、MCP 协议。 |

---

## 安装

### Windows 预编译包

从 [Releases](https://github.com/834063245-creator/HoloGram/releases) 下载 `.msi`。

### 从源码构建

**依赖：** [Rust](https://rustup.rs/) · [Node.js](https://nodejs.org/) ≥ 18 · [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)（Win10+ 已预装）

```bash
git clone https://github.com/834063245-creator/HoloGram.git && cd HoloGram

# 编译 Rust 引擎
cd engine && cargo build --release && cd ..

# 前端
cd src-ui && npm install && npm run build && cd ..

# 桌面应用
cargo tauri build
# → src-tauri/target/release/bundle/msi/*.msi
```

---

## 快速上手

启动 → 打开项目目录（自动分析渲染）→ 单击节点看详情 → Shift+双节点查路径 → Alt+框选区选 → 聊天面板向 Agent 提问。

---

## 支持语言

| Python | TypeScript | JavaScript | Go | Rust | Java |
|---|---|---|---|---|---|
| tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

| C | C++ | Ruby | Lua | C# | Swift |
|---|---|---|---|---|---|
| tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

| Dart | Scala | Haskell | JSON | HTML | CSS |
|---|---|---|---|---|---|
| tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

> 全部 18 门语言走 tree-sitter 适配器。Grammar 编译时静态链接，无需运行时下载。另 12 种语法依赖已就绪，上游 tree-sitter 升级后一行启用。

### 框架路由覆盖

8 种主流框架的 URL→处理函数映射自动检测，在图里可见：

| Django | Express | FastAPI | Flask | Rails | Spring | Gin | NestJS |
|---|---|---|---|---|---|---|---|

---

## 架构

```
┌─ 桌面壳 (Tauri 2) ─────────────────────────────────────┐
│  ┌─ 前端 (TypeScript) ──┐  IPC   ┌─ Rust 后端 ────────┐ │
│  │ Three.js 3D · Agent  │◄─────►│ 路由 · Git · Shell  │ │
│  │ Monaco · xterm.js    │       │ McpManager          │ │
│  └──────────────────────┘       └─────────┬───────────┘ │
└───────────────────────────────────────────┼─────────────┘
                                            │ TCP :9777 / MCP serve
                      ┌─────────────────────▼─────────────┐
                      │ Rust 引擎 (engine/)                │
                      │ 发现 → 分析 → 跨文件 → 社区 → 序列化 │
                      │ 18 tree-sitter 语法                 │
                      │ MemoryIndex + SqliteDb + FTS5      │
                      │ 24 MCP 工具 · 293 tests               │
                      └───────────────────────────────────┘
```

> **引擎自启动：** Tauri 启动时自动 spawn `engine.exe`（TCP :9777）。IDE 集成走 MCP serve 模式（`engine.exe serve --project-root`）。

---

## 🧩 只用 MCP（不开桌面应用）

HoloGram 的 Rust 引擎可以独立作为 MCP 服务器运行，在任何 Claude Code / Cursor 会话中使用——不需要安装桌面应用。

引擎是单文件二进制，tree-sitter 语法全静态链接，零依赖。丢哪都能跑。

### 🤙 一句话安装

**复制下面这段话，发给 Claude Code / Cursor / 任意 AI 编程助手：**

```
请帮我安装 HoloGram MCP 服务。步骤：

1. 从 https://github.com/834063245-creator/HoloGram/releases 下载最新版 hologram-engine.exe
2. 把 hologram-engine.exe 放到用户主目录下的 .hologram 文件夹里（全局安装，所有项目共用）
3. 在当前 AI 编程工具的 MCP 配置中注册这个服务：启动命令是 ~/.hologram/hologram-engine.exe，参数是 serve
4. 找到当前工具的全局和项目规则文件，写入 HoloGram 全部工具的使用规则（全局 + 项目两层都写，确保所有项目自动生效）
5. 在所有项目的全局规则文件中，追加一条强制前置检查规则：每次接到新任务，动手前先扫一眼可用的 MCP 工具列表，问自己"有工具能帮我缩小范围或直接给答案吗？"——哪怕结论是没用，也比跳过这步强。这条规则不限 HoloGram，适用所有已安装的 MCP 服务
6. 完成后告诉我怎么验证装好了
```

**不用懂技术。复制、粘贴、回车。Agent 会自己搞定。**

### 从源码编译（想自己改引擎的人）

```bash
git clone https://github.com/834063245-creator/HoloGram.git
cd HoloGram/engine
cargo build --release
mkdir -p ~/.hologram
cp target/release/hologram-engine.exe ~/.hologram/
```

然后同上，让 Agent 配 `mcp.json`。

重启 Claude Code / Cursor。第一个项目用 `hologram_analyze(path="/你的项目路径")` 载入，之后引擎自动增量更新。

### 项目级 vs 全局

| 方式 | 文件位置 | 效果 |
|---|---|---|
| **全局** | `~/.claude/mcp.json` | 所有项目都能用，启动不分析（懒加载） |
| **项目级** | 项目根目录 `.mcp.json` | 优先级更高，可加 `--project-root` 自动分析 |

HoloGram 自己的 `.mcp.json` 是项目级配置的参考模板。

---

## 开发

```bash
# Rust 引擎
cd engine && cargo test                                # 293 tests
cd engine && cargo build

# 桌面应用
cargo check --manifest-path src-tauri/Cargo.toml
cargo tauri dev                          # 开发模式（自动 spawn engine.exe）

# 前端
cd src-ui && npx tsc --noEmit            # TypeScript
cd src-ui && npm run dev                 # 前端 dev server
```

```
engine/          Rust 分析引擎（存储引擎 v2.5 + 24 MCP 工具，293 tests）
src-tauri/       Rust / Tauri 壳
src-ui/          TypeScript 前端（Three.js + Agent + Monaco + xterm.js）
assets/          图标及 UI 原型
```

| 🦀 Rust 1.80+ | 💙 TS 5.6 | 🟢 Node 18+ | ⚡ Vite 6 | 🖥️ Tauri 2 | 🎮 Three.js | 📝 Monaco |

---

## 许可证

[MIT](LICENSE) · © 2026 Wenbing Jing
