<p align="center">
  <img src="assets/banner.png" alt="HoloGram" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/HoloGram?color=orange" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-194%20passed-brightgreen" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" /></a>
</p>

> **语言无关的交互式代码依赖拓扑图生成器。**
>
> 不是又一个静态分析工具。HoloGram 把代码库变成一张可对话的 3D 星图——10 门语言统一 IR、原生 LLM Agent 双向联动、从 L1 公开 API 到 L4 封装穿透四层耦合诊断。纯 Rust 引擎，桌面应用。

---

## 三件事让它不同

| **🌍 跨语言统一 IR** | **🤖 图即 Agent 的眼睛** | **🔬 自举验证** |
|---|---|---|
| 10 门语言全部映射到同一张图。TypeScript 调 Python、Rust 调 Go——照样追踪。 | 94 个 Tauri 命令 + 21 个 MCP 工具直查图数据库，不是喂源文件让 LLM 猜。耦合深度 L1–L4 提前算好，SQLite FTS5 毫秒检索。Agent 和图是同一系统的两层——图是眼睛，Agent 是嘴。 | 用自己的图 debug 自己。项目根目录下的依赖分析结果随时可查——既是验证，也是活样本。 |

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

| | | |
|---|---|---|
| **🔄 代码翻译器** | **👁️ Agent 透镜 & 推理轨迹** | **📋 简报 → 星图一键跳转** |
| 选中源文件 → LLM 逐行翻译 → 三栏并排审计（原文 ‖ 译文 ‖ Diff）。跨语言移植，缓存自动落盘。Ctrl+T 一键触发。 | Agent 调过的节点持续高亮，其余降到 1% 透明度——一眼看清它"看过哪里"。渐变虚线串联最近 20 步访问序列，星图上的推理足迹。 | 保存文件 → 引擎自动跑约束校验 → 违规项实时出现。点击任意违规行 → 星图平滑飞行到对应节点。从"哪里违规"到"违规在哪"——零步。 |

| **🥧 右键 Pie Menu** | **🔭 三层折叠视图** | **⏳ 决策时间轴** |
| 节点上右键 → 环形菜单弹出：波及范围 / 聚焦飞行 / 最短路径 / 节点详情。Blender 式的肌肉记忆交互，无需工具栏。 | Tab 循环切换。宇宙层：每个社区一团螺旋星云。星座层：星云展开为节点群。Galaxy 内部：双击进入，Esc 退出。粒子在星系间沿边流动。 | 每次分析、check、文件变更自动记录时间轴。左侧面板滑入，按时间倒序。谁改了什么、引发了什么——一条线看透项目演化。 |

| **🎯 图作为输入设备** | **🔥 感知升级三件套** | **⚡ InstancedMesh 规模化** |
| Shift+点击两个节点 → BFS 最短路径 → 路径高亮 → Agent 自动分析依赖链风险。Alt+拖拽框选 → 收集框内节点 → Agent 总结区域模块关系。图不再只是输出——它是输入端。 | **复发热点：** 同一文件多次触发 L4 警报 → 星图着色升级。**冲突预演：** 双分支 diff 叠加耦合分析，合并前预知冲突。**门禁模式：** 新模块自动评估 fan-in/fan-out。 | N 个 `THREE.Mesh` → 1 个 `THREE.InstancedMesh`。5000 节点 1 draw call，60 FPS。hover/click/高亮/波及/折叠全部走 `setColorAt` API。 |

---

## 功能规格

| 🪐 **3D 星图** | 🌍 **10 语言** | 🧠 **三层分析** |
|---|---|---|
| 力导向 + BloomPass 发光 + 全息网格 Shader + 粒子流动。三种渲染模式。大项目自动降级轻量文件图。 | Rust 引擎 tree-sitter 统一分析。Python/TS/JS 走专用适配器，其余 7 门走通用适配器。Grammar 静态链接，零配置。 | V1 基础拓扑 → V2 深层诊断（L1–L4 耦合/数据流环/线程冲突/盲点）→ V3 变更路由（五级破坏信号 + YAML 阈值）。 |

| ⚡ **Rust 全量引擎** | 🛡️ **约束门禁** | 🎯 **内置 IDE 工具** |
|---|---|---|
| 全量分析（Django 3,031 文件 4.1s），无需增量。文件监听 + 自动重分析。图始终最新。 | YAML 规则。L5 不可逆变更永报警。黑名单关键词强制路由。结果编码在 JSON 中，可入 CI。 | Monaco 浮动编辑器 · xterm.js 多标签终端 · Git 面板（stage / diff / commit / push / pull）。 |

| 📦 **三格式序列化** | 🔌 **MCP 长驻服务** | ✅ **194 测试** |
|---|---|---|
| JSON 通用交换 · MessagePack 二进制加载 · SQLite + FTS5 全文模糊搜索。 | Rust 引擎长驻，JSON-RPC over stdio + TCP :9777 双模。崩溃 3 次/60s 自动降级。 | Rust `#[test]` 全覆盖 19 模块：图数据模型、适配器、管线、耦合分析、社区发现、路由、MCP 协议。 |

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

| Python | TypeScript | JavaScript | Go | Rust |
|---|---|---|---|---|
| 专用适配器 | 专用适配器 | 专用适配器 | tree-sitter | tree-sitter |

| Java | C | C++ | Ruby | Lua |
|---|---|---|---|---|
| tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

> Python 走 AST 级专用适配器，TypeScript/JS/JSX/TSX 走 TypeScript 适配器，其余 7 门走通用 tree-sitter 适配器。Grammar 编译时静态链接，无需运行时下载。

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
                      │ 10 tree-sitter 语法 · 3 适配器       │
                      │ JSON / MsgPack / SQLite            │
                      │ 21 MCP 工具 · 194 tests · 19 模块   │
                      └───────────────────────────────────┘
```

> **引擎自启动：** Tauri 启动时自动 spawn `engine.exe`（TCP :9777）。IDE 集成走 MCP serve 模式（`engine.exe serve --project-root`）。

---

## 开发

```bash
# Rust 引擎
cd engine && cargo test                                # 194 tests
cd engine && cargo build

# 桌面应用
cargo check --manifest-path src-tauri/Cargo.toml
cargo tauri dev                          # 开发模式（自动 spawn engine.exe）

# 前端
cd src-ui && npx tsc --noEmit            # TypeScript
cd src-ui && npm run dev                 # 前端 dev server
```

```
engine/          Rust 分析引擎（19 模块，194 tests）
src-tauri/       Rust / Tauri 壳（94 个 Tauri 命令）
src-ui/          TypeScript 前端（Three.js + Agent + Monaco + xterm.js）
assets/          图标及 UI 原型
```

| 🦀 Rust 1.80+ | 💙 TS 5.6 | 🟢 Node 18+ | ⚡ Vite 6 | 🖥️ Tauri 2 | 🎮 Three.js | 📝 Monaco |

---

## 许可证

[MIT](LICENSE) · © 2026 Wenbing Jing
