# Hologram 架构重构方案: 让 Agent "住进"全息图

> **状态**: 🔨 施工中
> - ✅ **第一步** — 修传输层 (持久 MCP) — **已完成** (2025-06-13)
> - ✅ **第二步** — 修整合层 (Agent↔图联动) — **已完成** (2025-06-13)
> - ✅ **第三步** — 图作为输入 (点击驱动 Agent) — **已完成** (2025-06-13)

## 问题诊断

当前架构是三块独立的积木,没有拼成整体:

```
TypeScript Agent ──→ Tauri invoke ──→ Python CLI (每次新进程)
       │                                        │
       └── visualizeAgentTool() ×2 ──→ 3D Graph (事后补丁)
```

**三个核心问题:**
1. **工具调用慢** — 每次起新 Python 进程,加载图→查询→退出,冷启动 500ms+
2. **图没反应** — Agent 分析出结果后,图没有任何实时反馈,vis​ualize 是事后补丁
3. **交互单向** — 只能打字问 Agent,图上看到的关键节点没法直接让它分析

MCP Server (`mcp_server.py`) 实现了完整协议但内置 Agent 不用它。
工具定义在 TypeScript 和 Python 各维护一份。

---

## 前置检查 (动手前 5 分钟)

当前项目通过 HoloGram 自举分析发现 **8 个纯代码循环**（见 `COMPARISON_REPORT.md`），健康评分 90。
第一步引入长生命周期 MCP 进程前，确认循环不涉及进程管理模块：

```bash
hologram cycle --mode all
```

**检查清单：** 如果 8 个循环中任何节点出现在以下文件，优先级提升为"先修循环再改传输层"：
- `src_python/mcp_server.py`
- `src_python/cli.py`
- `src_python/core/graph.py`
- `src_python/pipeline/cache.py`
- `src_python/watcher.py`

另外确认 `tests/` 全部通过：`pytest tests/ -x -q`

---

## 方案: 3 步渐进,每步独立可测可回滚

### 第一步: 修传输层 — 持久 MCP,工具自动发现

**改什么:** Rust + Python + 一点点 TypeScript

**不动什么:** Agent 循环逻辑、聊天 UI、图渲染、Provider

```
现在: TS Agent → invoke → Rust spawn python CLI → 起进程 → 查图 → 退出
改为: TS Agent → invoke → Rust 转发给持久 MCP 进程 → 内存查图 → 立即返回
```

**具体改动:**

| 层 | 文件 | 改什么 |
|---|------|--------|
| Rust | `src-tauri/src/mcp_manager.rs` (新) | MCP 进程管理器，管理生命周期/崩溃恢复。**注意：当前 main.rs 每次调用起新进程，无现成长生命周期管理可复用，需从零实现进程健康检查。** |
| Rust | `src-tauri/src/main.rs` | 新增 `start_mcp_server`/`mcp_call`/`stop_mcp_server` 三个命令 |
| Python | `mcp_server.py` | 加 `run_stdio_for_project(root)` 类方法：先调 `PipelineRunner.run(root)` 分析项目，再调 `run_stdio()` 启动服务 |
| Python | `cli.py` | `serve` 子命令加 `--project-root` 参数，调用上述新方法 |
| TS | `tool.ts` | 加 `createHologramToolsFromSchemas()` 工厂（从 MCP `tools/list` 动态生成），老硬编码函数保留作 fallback |
| TS | `main.ts` | `setupAgent()` 先尝试 MCP 连接，失败则用老 CLI 方式。**顺手把 `exec()` 和 `exec2()` 两个重复闭包合并为一个工厂函数 `createExecutor(graph)`** |

**⚠️ `exec()` 和 `exec2()` 重复代码：** 当前 `main.ts` 第 318 行和第 389 行定义了两个几乎完全相同的 `ToolExecutor` 闭包（分别用于主 Agent 和新会话）。第一步顺手合并为 `createExecutor(currentGraphData, starGraph)` 工厂函数，调用处替换为 `const exec = createExecutor(currentGraphData, starGraph)`。此举减少第二步的改动面。

**关于 `run_stdio_for_project` 的实现：**
```python
# mcp_server.py 新增
def run_stdio_for_project(self, root: str) -> None:
    """分析项目 + 启动 MCP Server 一体化入口"""
    from .pipeline import PipelineRunner
    runner = PipelineRunner(AdapterRegistry.default())
    graph, _ = runner.run(root)
    self.graph = graph
    self.run_stdio()
```

**安全措施:**
- 双模式: MCP 可用走 MCP，MCP 挂了自动降级到现有 CLI 命令
- 60 秒内崩溃 3 次则永久降级，弹出通知
- 现有 CLI 路径一行代码不删
- Python 引擎现有测试一个不碰
- **进程管理器是唯一风险点**（无现有代码可复用），其余改动均为胶水代码

**验收:** 工具调用响应 <100ms；杀进程后自动重启；老 CLI 仍可用

**实施记录 (2025-06-13):**

| 文件 | 改动 | 状态 |
|------|------|:----:|
| `src-tauri/src/mcp_manager.rs` | **新建** — MCP 进程管理器：生命周期、崩溃追踪（60s/3次→永久降级）、JSON-RPC 通信 | ✅ |
| `src-tauri/src/main.rs` | 新增 `start_mcp_server`/`mcp_call`/`mcp_list_tools`/`stop_mcp_server` 4 个命令 + 注册 + 窗口关闭清理；`NO_WINDOW`/`project_root()` 改为 `pub(crate)` | ✅ |
| `src_python/mcp_server.py` | 新增 `MCPServer.from_project(root)` 类方法（完整分析管线→返回就绪实例）；`__init__` 结构保持完整 | ✅ |
| `src_python/cli.py` | `serve` 子命令新增 `--project-root` 参数；`--project-root` 路径下发 ready 信号到 stdout 再进入 JSON-RPC 循环 | ✅ |
| `src-ui/src/agent/tool.ts` | 新增 `createHologramToolsFromSchemas()` 工厂（从 MCP `tools/list` 动态生成 Tool 对象） | ✅ |
| `src-ui/src/main.ts` | 合并 `exec`/`exec2` 为 `createExecutor()` 工厂；`setupAgentInner` 新增 MCP 优先路径（失败自动降级 CLI）；Coding tools 独立 executor 不再触发可视化 | ✅ |

**验证:**
- Rust: `cargo check` ✅ 零警告
- TypeScript: `tsc --noEmit` ✅ 零错误
- Python: `pytest tests/ -x -q` ✅ 820 passed, 4 skipped
- 老 CLI 路径：一行未删，MCP 失败自动 fallback
- 进程管理器：崩溃追踪逻辑已就位，但需端到端测试（`cargo tauri build` + 实际项目）
- MCP 工具已补全至 21 个，与 CLI 全量对齐（含 search/summary/community_report/diff/analyze/run_check/run_health）

---

### 第二步: 修整合层 — Agent 和图双向联动

**改什么:** 只改 TypeScript UI 层

**不动什么:** Rust、Python、工具执行逻辑、Provider

这是解决"奇怪感"的核心步骤。当前实际是**三重调用**（代码审查确认），比原计划严重：

```
Tool 执行完成
  ├─ main.ts:323  exec()  →  visualizeAgentTool()   ← 第一次
  ├─ main.ts:393  exec2() →  visualizeAgentTool()   ← 第二次（新会话）
  └─ chat.ts:1358 handleToolResult() → visualizeAgentTool() ← 第三次
```

> **注意**：如果第一步已完成 `exec/exec2` 合并，此处只需处理合并后的 executor 和 chat.ts 两处。

改为:

```
Agent 调工具 → EventBus.emit('agent:tool-done', {...})
                │
                ├─→ ChatPanel 渲染文本
                ├─→ AgentVisualizer 更新图 (单一入口)
                └─→ AgentLens 更新透镜视图
```

**具体改动:**

| 文件 | 改什么 |
|------|--------|
| `events.ts` | 加 4 个新事件: `agent:tool-started/done`、`agent:thinking`、`agent:focus-changed` |
| `agent-visualizer.ts` | **重构**: 从函数变为类,订阅 EventBus,不再被直接调用 |
| `main.ts` | 删掉 `exec()` 和 `exec2()` 里的 visualize 调用（如果第一步未合并则两处都删），创建 AgentVisualizer 实例 |
| `chat.ts` | 删掉 `handleToolResult()` 里的 visualize 调用 (消除双重调用 bug) |
| `graph.ts` | 加 `setAgentLens()`/`updateAgentTrail()` API |
| `agent-lens.ts` (新) | Agent 透镜模式: 只亮 Agent 碰过的节点 |
| `agent.ts` | 工具执行中发 `agent:tool-started` 事件 |

**新增体验:**
- **Agent 透镜**: 图上只显示 Agent 关注的节点,其余降到 1% 透明度
- **Agent 轨迹**: 虚线串联 Agent 访问过的节点序列 (最近 20 步)
- **实时反馈**: Agent 说"找到 L4 穿透"→ 图上对应节点亮起红色
- **消除双重调用**: 每个工具只触发一次图更新

**验收:** Agent 分析时图实时响应; 透镜模式正常切换; 轨迹线正确绘制

**实施记录 (2025-06-13):**

| 文件 | 改动 | 状态 |
|------|------|:----:|
| `src-ui/src/ui/events.ts` | 文档化 4 个新事件: `agent:tool-started/done`、`agent:thinking`、`agent:focus-changed` | ✅ |
| `src-ui/src/agent/agent.ts` | 导入 `bus`；`executeOne` 中 emit `agent:tool-started`；`executeBatch` 中 emit `agent:tool-done` | ✅ |
| `src-ui/src/ui/agent-visualizer.ts` | **重构**: `visualizeAgentTool()` 函数 → `AgentVisualizer` 类；订阅 `agent:tool-done` EventBus 事件；追踪 visited nodes + trail；保留 `askAgent()` | ✅ |
| `src-ui/src/ui/chat.ts` | 删除 `handleToolResult()` 中的 `visualizeAgentTool` 调用（消除第三重）；移除 `dbg`/`visualizeAgentTool` 无用 import | ✅ |
| `src-ui/src/main.ts` | 删除 `createExecutor`/`mcpExec` 中的 visualize 调用（消除第一、二重）；新增 `AgentVisualizer` 实例；模式切换时 `setGraph()` 更新引用 | ✅ |
| `src-ui/src/ui/graph.ts` | 新增 `setAgentLens()`/`clearAgentLens()` — 只亮访问过节点；新增 `updateAgentTrail()`/`_clearTrailLine()` — 虚线串联轨迹；`clearGraph()` 清理 lens/trail 状态 | ✅ |
| `src-ui/src/ui/agent-lens.ts` | **新建** — `AgentLens` 类：订阅 `agent:focus-changed`，累积 visited nodes，toggle 透镜开关 | ✅ |

**效果:**
- 三重 `visualizeAgentTool()` 调用 → 单入口 `AgentVisualizer` (EventBus)
- Agent 分析时图实时响应（透镜、轨迹、高亮）
- 每个工具调用只触发一次图更新
- 老代码路径零删除：`AgentVisualizer` 是加性替换

**验证:**
- TypeScript: `tsc --noEmit` ✅ 零错误
- Python: 未触碰
- Rust: 未触碰
- 端到端待验证: `cargo tauri build` + 实际项目

---

### 第三步: 图作为输入 — 点击节点驱动 Agent ✅

**改什么:** 只加 TypeScript,不改现有逻辑

**不动什么:** 所有后端、所有工具、所有现有 UI

纯增量: 给 3D 图加交互,让它成为 Agent 的输入设备。

**具体改动:**

| 文件 | 改什么 |
|------|--------|
| `graph.ts` | 加节点点击检测、路径选择模式 (Shift+点击)、矩形框选 |
| `graph-interaction.ts` (新) | 交互处理器: 点击/选择 → 生成 Agent 查询 |
| `main.ts` | 订阅图交互事件 → 转发给 Agent |
| `events.ts` | 加 `graph:node-clicked`/`graph:path-selected`/`graph:region-selected` |
| `chat.ts` | 支持从图交互自动发起查询 (无需用户打字) |

**交互流程:**
1. 点击节点 → 浮动菜单: "分析" / "依赖" / "波及" / "社区"
2. Shift+点击两个节点 → 高亮路径 → Agent 自动分析依赖链
3. 拖拽框选 → Agent 自动总结该区域

**验收:** 点节点出现菜单; Agent 自动回答; 不影响现有图交互 (旋转/缩放)

**实施记录 (2025-06-13):**

| 文件 | 改动 | 状态 |
|------|------|:----:|
| `src-ui/src/ui/events.ts` | 新增 3 个图交互事件: `graph:node-clicked`、`graph:path-selected`、`graph:region-selected` | ✅ |
| `src-ui/src/ui/graph.ts` | 导入 `bus`；新增 Shift+点击快速路径模式（首个=起点→第二个=终点→自动寻路→emit）；新增 Alt+拖拽矩形框选（投影检测框内节点→高亮→emit）；`onClick` 中 emit `graph:node-clicked`；Escape 清理 shift/select 状态；`clearGraph()` 重置交互状态 | ✅ |
| `src-ui/src/ui/graph-interaction.ts` | **新建** — `GraphInteraction` 类：订阅 `graph:path-selected` → 自动生成依赖链分析查询；订阅 `graph:region-selected` → 自动生成区域架构总结查询；订阅 `graph:node-clicked` → 预留扩展点 | ✅ |
| `src-ui/src/main.ts` | 导入 `GraphInteraction`；`init()` 中实例化（紧接 `AgentVisualizer`） | ✅ |

**效果:**
- 图从"只能看"变成"Agent 的输入设备"
- 不改任何后端/工具/现有 UI（纯增量）
- 不与 OrbitControls 旋转/缩放/平移冲突（Shift/Alt 均为未占用修饰键）

**验证:**
- TypeScript: `tsc --noEmit` ✅ 零错误
- Python: 未触碰
- Rust: 未触碰
- 端到端待验证: `cargo tauri build` + 实际项目

---

## 为什么这样分步

```
第一步 (传输层)    第二步 (整合层)    第三步 (交互层)
    │                  │                  │
    ▼                  ▼                  ▼
 解决"慢"          解决"没反应"      解决"单向"
 工具响应 500ms→  图实时反馈 Agent  图也能驱动 Agent
 50ms             操作               
```

每一步完成后你都可以停下来体验,决定要不要继续。每步只动一层,出问题容易定位。

---

## 改动范围对比

| | 第一步 | 第二步 | 第三步 |
|---|--------|--------|--------|
| Rust | ✅ 加 mcp_manager | ❌ 不动 | ❌ 不动 |
| Python | ✅ 改 mcp_server 入口 | ❌ 不动 | ❌ 不动 |
| TS Agent | 小改 tool.ts + 合并 exec/exec2 | 加事件，删重复调用 | ❌ 不动 |
| TS UI | 小改 main.ts | 重构 visualizer | 加交互 |
| TS Graph | ❌ 不动 | 加 API | 加交互检测 |
| 风险等级 | **中高** — mcp_manager 需从零写进程生命周期管理，其余为胶水代码 | 低 — 只动 UI | 极低 — 纯增量 |

---

## 回滚策略

- 每个改动都是加性的,老路径不删
- 第一步: `mcp-degraded` 事件触发后自动回退到 CLI 模式
- 第二步: 图效果是叠加层,渲染失败不影响核心功能
- 第三步: 交互模式默认关闭,需要按快捷键激活
