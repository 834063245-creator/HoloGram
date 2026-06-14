<p align="center">
  <img src="assets/banner.png" alt="HoloGram" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/HoloGram?color=orange" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-911%20passed-brightgreen" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" /></a>
</p>

> **语言无关的交互式代码依赖拓扑图生成器。**
>
> 不是又一个静态分析工具。HoloGram 把代码库变成一张可对话的 3D 星图——14 门语言统一 IR、原生 LLM Agent 双向联动、从 L1 公开 API 到 L4 封装穿透四层耦合诊断。自举验证，CLI / 桌面应用双模。

---

## 三件事让它不同

| | | |
|---|---|---|
| **🌍 跨语言统一 IR** | **🤖 原生 Agent** | **🔬 自举** |
| 14 门语言全部映射到同一张图。TypeScript 调 Python、Rust 调 Go——照样追踪。 | Agent 和图是同一个系统的两层。30+ 工具直接查图数据库，不是喂源文件让 LLM 猜。 | 用自己的图 debug 自己。项目根目录下的依赖分析结果随时可查——既是验证，也是活样本。 |

---

## 🤖 原生 Agent

**图是 Agent 的眼睛，Agent 是图的嘴。**

| 能力 | 说明 |
|---|---|
| **30+ 原生工具** | 每个工具直查图数据库，不是靠喂代码猜。`neighbors` 查邻居、`impact` 波及范围、`coupling-report` 耦合报告、`blindspots` 盲点、`cycle` 数据流环、`fragile` 脆弱依赖、`community` 社区归属、`history` 节点历史。另有代码搜索、文件读写、Shell、Git 全套。 |
| **图即上下文** | Agent 不读源文件。耦合深度 L1–L4 提前算好，SQLite FTS5 毫秒检索。一次工具调用几十行 JSON 查清上千行源码的依赖。Token 消耗远低于全量喂代码。 |
| **双向实时联动** | 单击节点 → Agent 分析；Shift+双节点 → 寻最短路径；Alt+框选 → 批量分析。Agent 调用工具 → 3D 视图实时高亮受影响节点，粒子沿边流动。 |
| **权限分级** | Shell、Git push、文件写入等危险操作人工确认。API key 本地存储，数据不上传。支持 Anthropic / OpenAI 兼容接口。 |

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

---

## 功能

| 🪐 **3D 星图** | 🌍 **14 语言** | 🧠 **三层分析** |
|---|---|---|
| 力导向 + BloomPass 发光 + 全息网格 Shader + 边粒子流动。三种渲染模式。大项目自动降级轻量文件图。Tab 切宇宙/星座折叠，双击进入星系。 | Python 走标准库 `ast`，其余 13 门走 tree-sitter。统一 IR——跨语言依赖天然支持。Grammar 首次自动下载编译，零配置。 | V1 基础拓扑 → V2 深层诊断（L1–L4 耦合/数据流环/线程冲突/盲点）→ V3 变更路由（五级破坏信号 + YAML 阈值）。 |

| ⚡ **增量更新** | 🛡️ **约束门禁** | 🎯 **内置 IDE 工具** |
|---|---|---|
| 文件监听 + 仅重分析变更部分 + 原子替换 + 失败回滚。图始终最新。 | YAML 规则。L5 不可逆变更永报警。黑名单关键词（password/token/api_key）强制路由。结果编码在 JSON 中，可入 CI。 | Monaco 浮动编辑器 · xterm.js 多标签终端 · Git 面板（stage / diff / commit / push / pull 图形化操作）。 |

| 📦 **三格式序列化** | 🔌 **MCP 长驻服务** | ✅ **911 测试** |
|---|---|---|
| JSON 通用交换 · MessagePack 二进制加载 · SQLite + FTS5 全文模糊搜索。 | Python 引擎长驻，JSON-RPC 通信。崩溃 3 次/60s 自动降级。 | pytest 全覆盖 V1/V2/V3 + CLI + MCP + 序列化往返 + 边界条件。Tauri 2 桌面应用，Windows `.msi`。 |

---

## 安装

### Windows 预编译包

从 [Releases](https://github.com/834063245-creator/HoloGram/releases) 下载 `.msi`。

### 从源码构建

**依赖：** [Rust](https://rustup.rs/) · [Node.js](https://nodejs.org/) ≥ 18 · [Python](https://www.python.org/) ≥ 3.10 · Git + gcc（tree-sitter grammar 编译）· [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)（Win10+ 已预装）

```bash
git clone https://github.com/834063245-creator/HoloGram.git && cd HoloGram

# Python 引擎
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[full,dev]"

# 前端
cd src-ui && npm install && npm run build && cd ..

# 桌面应用
cargo tauri build
# → src-tauri/target/release/bundle/msi/*.msi
```

### 仅 CLI

```bash
pip install -e ".[full]"
hologram analyze ./my-project --json --output graph.json
```

---

## 快速上手

**桌面：** 启动 → 打开项目目录（自动分析渲染）→ 单击节点看详情 → Shift+双节点查路径 → Alt+框选区选 → 聊天面板向 Agent 提问。

**CLI：**

```bash
hologram analyze ./my-project --json --output graph.json   # 分析
hologram neighbors auth --json                              # 查邻居
hologram impact auth --depth 3 --json                       # 波及范围
hologram path auth database --json                          # 最短路径
hologram coupling-report auth --json                        # 耦合报告
hologram check --json                                       # 约束校验
```

---

## 支持语言

| Python | TypeScript | JavaScript | Go | Rust | Java | C |
|---|---|---|---|---|---|---|
| AST | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

| C++ | Ruby | C# | Kotlin | Swift | PHP | Lua |
|---|---|---|---|---|---|---|
| tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

> Grammar 首次使用时自动从 GitHub 下载编译（需 Git + gcc）。

---

## 架构

```
┌─ 桌面壳 (Tauri 2) ─────────────────────────────────────┐
│  ┌─ 前端 (TypeScript) ──┐  IPC   ┌─ Rust 后端 ────────┐ │
│  │ Three.js 3D · Agent  │◄─────►│ 子进程管理 · Git    │ │
│  │ Monaco · xterm.js    │       │ Shell · MCP 生命周期 │ │
│  └──────────────────────┘       └─────────┬───────────┘ │
└───────────────────────────────────────────┼─────────────┘
                                            │ spawn / JSON-RPC
                      ┌─────────────────────▼─────────────┐
                      │ Python 引擎 (src_python/)          │
                      │ 发现 → 分析 → 跨文件 → 社区 → 序列化 │
                      │ Python AST · TS 适配器 · tree-sitter │
                      │ → JSON / MsgPack / SQLite          │
                      └───────────────────────────────────┘
```

> Rust 层**不做分析**。它管理子进程、路由 IPC、提供系统集成。代码分析全在 Python 引擎，渲染与 Agent 在 WebView。

---

## 数据模型

| 节点 | `SYMBOL` 函数/类/模块/变量 | `MEDIUM` 文件/数据库/队列/缓存 | `TEMPORAL` 线程/定时器/事件循环 |
|---|---|---|---|
| **边** | `STRUCTURAL` 调用/继承/导入 | `DATA` 读/写/订阅 | `TEMPORAL` 执行于/触发/阻塞 |
| **深度** | **L1** 公开 API ▸ **L2** 内部导入 ▸ **L3** 共享数据 ▸ **L4** 封装穿透 | | |

---

## 约束校验

`hologram.constraints.yaml`：

```yaml
routing:
  L5:  { enabled: true }                            # 永远路由
  L4:  { enabled: true, blast_radius_threshold: 20 }
  L3:  { enabled: true }
  L2:  { enabled: true }
  L1:  { enabled: false }                           # 仅可见
allowlist:
  L4: ["tests/"]
denylist:
  keywords: ["password", "secret", "token", "api_key"]
```

```bash
hologram check --json   # pass/fail 编码在输出中，直入 CI
```

---

## 开发

```bash
pytest tests/ -x -q                                   # 911 测试
cargo check --manifest-path src-tauri/Cargo.toml       # Rust
cd src-ui && npx tsc --noEmit                          # TypeScript
cd src-ui && npm run dev                               # 前端 dev server
```

```
src_python/      Python 分析引擎        src-tauri/      Rust / Tauri 壳
src-ui/          TypeScript 前端        tests/          pytest 测试集
assets/          图标及 UI 原型
```

| 🐍 Python 3.10+ | 🦀 Rust 1.80+ | 🟢 Node 18+ | 💙 TS 5.6 | ⚡ Vite 6 | 🖥️ Tauri 2 | 🎮 Three.js | 📝 Monaco |

---

## 许可证

[MIT](LICENSE) · © 2026 Wenbing Jing
