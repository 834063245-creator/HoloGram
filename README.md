<p align="center">
  <img src="assets/banner.png" alt="HoloGram" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/HoloGram?color=orange" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-287%20passed-brightgreen" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/badge/platform-Windows-blue" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" /></a>
</p>

<br/>

<table align="center" style="border-collapse: collapse; border: none;">
<tr>
<td align="center" valign="middle" style="padding: 18px 40px; background: #000000; color: #ffffff; border: none;">
  <h1 style="margin:0;font-size:28px;font-weight:900;color:#ffffff;">▍MCP 服务 · 不是桌面应用</h1>
  <p style="margin:6px 0 0 0;font-size:15px;color:#cccccc;">单文件引擎 &nbsp;·&nbsp; 零依赖 &nbsp;·&nbsp; 配进 Claude Code / Cursor 直接用 &nbsp;·&nbsp; 省 token = 省钱<br/>桌面端只是可选的可视化壳，<strong style="color:#ffffff;">不开桌面应用完全不影响使用</strong></p>
	  <p style="margin:10px 0 0 0;font-size:16px;"><a href="#install" style="color:#ffcc00;font-weight:bold;">👇 点这里直接跳到"一句话安装"</a><span style="color:#ffcc00;">，复制粘贴发给 Agent，自动装好。</span></p>
</td>
</tr>
</table>

<br/>

> **代码依赖可视化与影响分析。** 18 门语言统一 IR，全库依赖一张图。改前查波及范围，改后验架构边界。MCP 模式下，原本要读 N 个源文件才能理清的依赖链，一次工具调用几十行 JSON 返回——**省 token，就是省钱。**

---

## 核心能力

| 能力 | 说白了就是 |
|---|---|
| **改前查影响** | 改一个文件 → 立刻看到会波及哪些文件、哪些模块。不用搜、不用一层层翻代码。 |
| **自动抓越界** | 模块之间乱 import？自动标红。你定规则，它替你盯着。 |
| **给 Agent 省 token** | Claude Code / Cursor 里直接用。Agent 不用读源文件猜依赖，一次调用拿答案，省 **70%** token。 |
| **3D 代码地图** | 代码库变星图，谁依赖谁、谁在调用谁，一眼看穿。5000 个文件不卡。 |
| **保存即刷新** | 代码改了保存 → 图自动更新。什么都不用点。 |
| **18 门语言，零配置** | Python · TS · Go · Rust · Java · C · C++ · Ruby · Lua · C# · Swift · Dart · Scala · Haskell · JSON · HTML · CSS。打开项目直接出图。 |

---

## 为什么不同

| **🌍 跨语言统一 IR** | **🤖 图为 Agent 而生** | **🔬 自举验证** |
|---|---|---|
| 18 门语言全部映射到同一张图——不是分别解析再拼接，而是一个统一中间表示。TypeScript 调 Python、Rust 调 Go，跨语言依赖链照样追踪。引擎内置 tree-sitter 适配器，每种语言的 import / call / 符号定义统一建模。 | 不是"把源文件丢给 LLM 让它自己看"。全库依赖提前算好，存进 MemoryIndex（邻接表 + 倒排索引）+ SQLite FTS5。Agent 调工具拿的是**结构化依赖数据**，不是源文件。一次调用几十行 JSON = 原本要读十几个文件才能拼出的依赖全景。 | HoloGram 用自己的引擎分析自己的代码库。项目根目录下的依赖图随时可查——既是质量保障，也是活样本。287 个 Rust 测试，每次提交前引擎自检。 |

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
  <br/><sub>🔄 代码翻译器 — 选中源文件，LLM 逐行翻译，三栏并排审计</sub>
</p>

---

## Agent 详解

HoloGram 的 Agent 不是"接了个聊天框"——图和 Agent 是同一系统的两层，天然联动。

| 能力 | 说明 |
|---|---|
| **25 个 MCP 工具** | explore / neighbors / impact / path / coupling-report / blindspots / cycle / fragile / community / history / search / check / preflight / health / diff / timeline / policy-check / rename / gate-check / hotspots 等。全部走图数据库查询，不读源文件。 |
| **Agent ↔ 星图双向实时联动** | Agent 调工具 → 3D 视图实时响应。path → 路径高亮，fragile → 脆弱节点标琥珀，cycle → 循环节点标红，impact → 聚焦飞行，diff → 绿增红删。 |
| **图作为输入设备** | Shift+双节点 → BFS 最短路径 → Agent 自动分析依赖链风险。Alt+框选区域 → Agent 自动总结模块关系。单击任意节点 → 详情卡 + "问 Agent"入口。 |
| **全面板覆盖** | 星图详情卡 · 简报违规行 · 文件查看器 · 文件树 · 时间轴事件 · 约束面板——6 个面板全部有"问 Agent"按钮，点一下自动带上下文。 |
| **Agent 透镜** | 图上只亮 Agent 访问过的节点（其余降至 1% 透明度），渐变虚线串联最近推理步骤。一键切换，看清 Agent "看过哪里"。 |
| **会话持久化** | 对话历史自动保存 `.hologram/chat_sessions.json`，重启或切换项目后恢复。 |
| **NL 自然语言探索** | `hologram_explore` 接受自然语言查询——"DataRequest 怎么 validate"——引擎自动切词消歧，BFS 路径搜索，一次返回调用链 + 波及范围 + 源码 + 架构告警。 |

---

## 引擎与性能

| 🧠 **四层耦合诊断** | ⚡ **Rust 全量引擎** | 🛡️ **约束门禁** |
|---|---|---|
| L1 公开 API → L2 内部调用 → L3 数据流环 → L4 封装穿透 → L5 不可逆变更。每一层给出风险等级，不是笼统的"有依赖"。动态调度合成：callback / observer 边自动检测。 | 存储引擎 v2.5：MemoryIndex（邻接表 + 倒排索引，O(degree) 查询）+ SqliteDb（持久化 + FTS5 全文搜索）+ 增量更新（watcher → 防抖 → 重解析变更文件 → 修复跨文件边 → 原子 swap）。Django 3,031 文件全量分析 4.1s。 | YAML 自定义规则：模块隔离、import 白名单、表访问限制、黑名单关键词强制路由。违规结果编码在 JSON 中，可入 CI 流水线。 |

| 📦 **三格式序列化** | 🔌 **MCP 长驻服务** | ✅ **287 测试** |
|---|---|---|
| JSON 通用交换 · MessagePack 二进制（冷启动秒开）· SQLite + FTS5 全文模糊搜索。缓存优先策略：已有缓存即显上次图，引擎后台静默更新。 | Rust 引擎长驻，JSON-RPC over stdio + TCP :9777 双模。崩溃 3 次/60s 自动降级。引擎自启动——Tauri 启动时自动 spawn，IDE 集成走 `serve` 模式。 | Rust `#[test]` 全覆盖：图数据模型、适配器、管线、耦合分析、社区发现、路由、存储引擎、MCP 协议。 |

---

<a id="token-save"></a>
## 💸 Token 节省实测

**场景：改 `auth.py` 里的 `validate_token()` 函数，要查波及哪些文件、会不会越界。**

---

### 不用 HoloGram：Agent 逐层翻文件

Agent 没有全局依赖图，只能像人一样一层层读源码推依赖链。

| 步骤 | Agent 在干什么 | 实际消耗 |
|---|---|---|
| 1 | 读 `auth.py`，找到 `validate_token` 的定义和它 import 了谁 | 约 800 token（源文件 + 推理） |
| 2 | 发现 import 了 `models.py` → 读 `models.py`，确认哪些被 `validate_token` 用到 | 约 700 token |
| 3 | 发现 import 了 `utils.py` → 读 `utils.py` | 约 600 token |
| 4 | 全局搜索谁调了 `validate_token`（grep/读引用列表） | 约 400 token |
| 5 | 搜到 `middleware/auth_mw.py` 调了 → 读它 | 约 800 token |
| 6 | 搜到 `api/users.py` 调了 → 读它 | 约 700 token |
| 7 | 搜到 `api/admin.py` 调了 → 读它 | 约 600 token |
| 8 | Agent 综合推理、判断哪些是真正会被波及的、输出结论 | 约 1,200 token |
| 9 | 漏了：`scheduler/tasks.py` 通过 `call_capability` 间接调用 — Agent 没翻到 | **漏报** |

> **单次查询消耗：约 5,800 token。** 这还只是 7 层深、3 个直接调用者的简单情况。依赖链更深、调用者更多时，轻松破万。
>
> **更大的问题：弱模型容易翻漏。** 第 9 步那种间接调用，Agent 没全局索引根本发现不了——漏一个，后面改了就炸。

---

### 用 HoloGram：一次工具调用

全库依赖提前算好，Agent 不读源文件，不推理依赖链。

| 步骤 | Agent 在干什么 | 实际消耗 |
|---|---|---|
| 1 | 调 `hologram_impact("auth.py", "validate_token")` → 引擎 BFS 遍历全库依赖图，返回：正向（它依赖谁）+ 反向（谁依赖它）传递闭包、波及模块清单、跨模块能力调用、风险等级 | 约 500 token（入参） |
| 2 | 引擎返回结构化 JSON：4 个直接调用者 + 1 个间接调用者 + 2 个被依赖文件 + 0 条越界违规 + 风险等级 LOW | 约 1,200 token（结果） |
| — | Agent 直接输出结论，不需要推理依赖链 | 0 token |
| — | `scheduler/tasks.py` 的间接调用 → 图里有 `capability_call` 边，**没有漏** | **零漏报** |

> **单次查询消耗：约 1,700 token。**
>
> 省 **4,100 token / 次**（<strong style="color:#ff3333;font-size:18px;">70%</strong>），且不会漏。

---

### 拉长了算

| | 不用 HoloGram | 用 HoloGram | 省 |
|---|---|---|---|
| **单次依赖查询** | ~5,800 token | ~1,700 token | **4,100 token（<strong style="color:#ff3333;font-size:18px;">70%</strong>）** |
| **一次编码会话（5 次查询）** | ~29,000 token | ~8,500 token | **~20,000 token** |
| **重度用户月均（30 次会话）** | ~870,000 token | ~255,000 token | **~600,000 token** |
| **十人团队月均** | ~8,700,000 token | ~2,550,000 token | **~6,000,000 token** |

按 Claude 均价 $20/MTok 估算：**单人月省 ~$12，十人团队月省 ~$120。**

> 上面是保守场景。实际使用中，依赖链更深（10-20 层常见）、调用者更多（几十个不稀奇）、模块边界合规要扫全库（Agent 传统做法根本不可行）——**省 80% 是常态。**
>
> **Token 省的是小头。大头是：弱模型推依赖不可靠，漏一个修一天。HoloGram 给的是确定答案。**

---

## 怎么用

<a id="install"></a>
### 🧩 MCP 模式（推荐，零界面）

**不需要桌面应用。** 引擎是单文件二进制，18 种语法全静态链接，零依赖。配进 Claude Code / Cursor 直接用。具体省多少 token 见上方 <a href="#token-save">💸 Token 节省实测</a>。

<h3 style="font-size:22px;font-weight:900;">🤙 一句话安装：复制下面这段话，发给 Claude Code / Cursor，Agent 自己搞定——</h3>

```
请帮我安装 HoloGram MCP 服务。步骤：

1. 从 https://github.com/834063245-creator/HoloGram/releases 下载最新版引擎：
   - Windows: hologram-engine.exe
   - macOS: hologram-engine（下载后 chmod +x）
2. 把引擎放到用户主目录下的 .hologram 文件夹里
3. 在当前 AI 编程工具的 MCP 配置中注册：
   - Windows: 启动命令 ~/.hologram/hologram-engine.exe，参数 serve
   - macOS: 启动命令 ~/.hologram/hologram-engine，参数 serve
4. 把 HoloGram 工具使用规则写入全局和项目规则文件
5. 完成后告诉我怎么验证
```

**不用懂技术。复制、粘贴、回车。**

> 从源码编译：`cd engine && cargo build --release`，复制 `hologram-engine.exe` 到 `~/.hologram/`

### 桌面应用（可选）

从 [Releases](https://github.com/834063245-creator/HoloGram/releases) 下载 `.msi`，双击安装。

打开 → 选项目目录 → 自动分析 → 3D 星图渲染。单击节点看详情，聊天面板问 Agent。引擎同款，加了可视化。

---

## 从源码构建

需要 [Rust](https://rustup.rs/) · [Node.js](https://nodejs.org/) ≥ 18 · [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)（Win10+ 已预装）

```bash
git clone https://github.com/834063245-creator/HoloGram.git && cd HoloGram
cd engine && cargo build --release && cd ..
cd src-ui && npm install && npm run build && cd ..
cargo tauri build
# → src-tauri/target/release/bundle/msi/*.msi
```

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

> 18 门语言。Grammar 编译时静态链接，无需下载。

### 框架路由自动检测

| Django | Express | FastAPI | Flask | Rails | Spring | Gin | NestJS |
|---|---|---|---|---|---|---|---|

8 种框架的 URL → 处理函数映射自动识别，图里可见。

---

## 架构

```
┌─ 桌面壳 (Tauri 2) ───────────────────────────────────┐
│  ┌─ 前端 (TS) ─────┐  IPC  ┌─ Rust 后端 ──────────┐  │
│  │ Three.js · Agent │◄────►│ 路由 · Git · Shell    │  │
│  │ Monaco · xterm   │      │ McpManager           │  │
│  └──────────────────┘      └──────────┬───────────┘  │
└───────────────────────────────────────┼──────────────┘
                                        │ TCP :9777 / MCP
              ┌─────────────────────────▼──────────────┐
              │ Rust 引擎 (engine/)                     │
              │ MemoryIndex + SqliteDb + FTS5           │
              │ 25 MCP 工具 · 287 tests                  │
              └────────────────────────────────────────┘
```

> 引擎自启动，Tauri 启动时自动 spawn。**自举验证：HoloGram 用自己的图 debug 自己。**

---

## 开发

```bash
cd engine && cargo test              # 287 tests
cd engine && cargo build
cargo tauri dev                      # 开发模式
cd src-ui && npx tsc --noEmit        # 类型检查
```

```
engine/          Rust 引擎（存储引擎 v2.5 + 25 MCP 工具）
src-tauri/       Rust / Tauri 壳
src-ui/          TypeScript 前端（Three.js + Agent + Monaco + xterm.js）
assets/          图标
```

---

## 许可证

[MIT](LICENSE) · © 2026 Wenbing Jing
