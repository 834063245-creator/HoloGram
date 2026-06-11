# PROJECT.md — 全息观测站 · 唯一真相源

> 这个文件替代 SPEC.md / SPEC_V2.md / SPEC_V3.md / SPEC_V4.md / TODO.md / CLAUDE.md 的角色。
> 它不描述"愿景"。它描述**代码里实际有什么、实际缺什么**。
> 每次落地一个功能后更新此文件。这应该是项目里唯一需要维护的规划文档。
>
> 生成日期：2026-06-10 · 代码审计完成 · 全部修复落地
> **最后更新：2026-06-11 · 星图规模化升级 阶段 A 全部完成 (A1+A2+A3)**

---

## 2026-06-11 星图规模化升级 — 阶段 A1 InstancedMesh ✅

**目标**: 5000 节点场景 draw calls 从 ~10000 降到 <10，帧率 60 FPS。

| 改动 | 说明 |
|---|---|
| `graph.ts` 核心球体 | N 个 `THREE.Mesh` → 1 个 `THREE.InstancedMesh` — 1 draw call |
| 回退路径 | `?instanced=0` URL param → 用旧 `buildNodesLegacy()` |
| hover/click | Three.js 原生 `instanceId` 替代 `mesh.indexOf()` |
| 文件高亮 | `setColorAt` 近黑色替代 opacity |
| Agent 高亮/路径/波及/折叠/焦点 | `_setCoreScale()` + `setColorAt()` 统一 IM API |
| hover 缩放修正 | full mode 0.4x 一致性修复 + 放大系数 1.2→0.7 |

**变更范围**: `graph.ts` ~30 处修改点，覆盖全部交互路径。Glow Sprites 不变。  
**回滚点**: commit `2e94468`  
**升级方案**: [STARGRAPH_SPEC.md](STARGRAPH_SPEC.md) — 四阶段规模化路线 (A/B/C/D)

---

## 2026-06-11 星图规模化升级 — 阶段 A2 布局预计算 ✅

**目标**: 布局计算从 JS 搬到 Python igraph，专业算法一次算完存磁盘，前端不再跑力导向。

| 改动 | 文件 | 说明 |
|---|---|---|
| Node.position 字段 | `graph.py` | `Optional[List[float]]` 预计算坐标 |
| 布局引擎 | `pipeline/layout.py` (新) | igraph FR/DrL + Z 轴社区层级编码 |
| CLI 接入 | `cli.py` | `cmd_analyze` 社区检测后自动调用布局 |
| 前端适配 | `graph.ts` | `render()` 优先读预计算坐标，无则 fallback `layout3D()` |
| 球壳缩放 | `graph.ts` | `sqrt(n)*5` — 表面积∝节点数，密度恒定 |

**关键设计**:
- 2D 布局由 igraph 产生（≤10K: FR, >10K: DrL），行业标准质量
- Z 轴 = `hash(community_id)` 映射到层 → 同社区节点在同一"星盘层"
- 确定性：同一项目每次重跑布局一致（Python Random(42) 作为 igraph RNG）
- 向后兼容：旧项目 JSON 无 `position` 字段 → 前端自动 fallback `layout3D()`

---

## 2026-06-11 星图规模化升级 — 阶段 A3 MessagePack ✅

**目标**: 大项目（>10K 节点）数据传输从 JSON 切换到 MessagePack 二进制。

| 改动 | 文件 | 说明 |
|---|---|---|
| Python 写入 | `graph.py` `to_msgpack()` | `msgpack.pack(d, f)` 二进制输出 |
| CLI 双输出 | `cli.py` `cmd_analyze` | 同时生成 `.json` + `.hologram` |
| Rust 透传 | `main.rs` `load_binary_graph` | `Vec<u8>` 原样返回，零解析开销 |
| 前端解码 | `main.ts` 两处加载路径 | `@msgpack/msgpack` decode, 优先 `.hologram` |
| 工具栏 | `index.html` + `main.ts` | 「重分析」按钮一键重新跑流水线 |

**数据流**: `Python msgpack.pack → .hologram 文件 → Rust Vec<u8> → 前端 decode → 渲染`  
**兼容**: `.hologram` 不存在时自动 fallback JSON 分析流水线

---

## 2026-06-10 审计修复记录

审计报告发现 17 个问题（0 高危 / 5 中危 / 12 低危），全部已修复：

| 类别 | 修复项 | 改动量 |
|---|---|---|
| 逻辑反转 | summary.py:751 — 历史路由状态判断反转 → 直接用 all_routed 判定 | 2行 |
| 逻辑错误 | cli.py:656 — 三元两边都是 "commit" → commit_violation / commit_clean | 1行 |
| 资源泄露 | timeline.py — TimelineStore 改为 context manager，4 个调用点全部改 with | +5/-8行 |
| 并发安全 | python_adapter.py — _MediaVisitor._build_index() 双检锁加 threading.Lock | +2行 |
| 并发安全 | pipeline/cache.py — IncrementalCache 全部 _cache 读写加 threading.Lock | +8行 |
| 死代码 | python_adapter.py — 删除 _visit_annotation_ref、空循环体 | -8行 |
| 死代码 | pipeline/runner.py — 删除 _resolve_cross_file（空操作函数） | -28行 |
| 死代码 | timeline.py — 删除未使用的 asdict import | 1行 |
| 架构诚实 | merger.py — 注释标注"V1 未实现" | 1行 |
| 死逻辑 | mcp_server.py:391 — 删除 is None 永假分支 | 1行 |
| 一致性 | 统一 enum→string 转换：graph.py 新增 type_val() 工具函数，12 处内联替换 | +5/-12行 |
| 一致性 | watcher.py — 导入路径对齐 from .adapters.registry | 1行 |

测试：798 通过 / 2 失败（预存 constraints.py bug，非本次引入）

---

## 用户

外行 vibe coder。不看代码。靠 Agent（DeepSeek/Claude）高速迭代复杂系统。一天几十轮变更。
需要的不是可视化工具，是在他不主动查看时自动守门、在关键时刻强制打断的系统。

---

## 引擎全景（全部已实现 ✅）

```
V1 图骨架    core/graph.py          节点×边 + 社区聚类(Leiden) + BFS波及 + 路径搜索 + 图diff
V2 深度分析  analysis/coupling.py   L1-L4耦合深度 + 数据流环 + 线程交错 + SQLite时间轴 + 边界检测
V3 约束框架  routing/signals.py     L5-L1破坏信号 + 约束校验(YAML) + 局面简报(enrich)
```

| 模块 | 文件 | 测试数 |
|---|---|---|
| 图数据模型 | core/graph.py | 40 |
| 图合并 | core/merger.py | 9 |
| 社区发现 | core/community.py | 6 |
| 图diff | core/diff.py | 6 |
| Python适配器 | adapters/python_adapter.py | 21 |
| TS适配器 | adapters/typescript_adapter.py | 23 |
| **Tree-sitter 适配器** | adapters/tree_sitter_adapter.py | — |
| 适配器注册 | adapters/registry.py | 9 |
| 流水线编排 | pipeline/runner.py | 27 |
| 增量缓存 | pipeline/cache.py | — |
| 耦合深度计 | analysis/coupling.py | 19 |
| 数据流环 | analysis/dataflow.py | 13 |
| 线程交错 | analysis/threading.py | 15 |
| 边界检测 | analysis/blindspots.py | 8 |
| 时间轴 | timeline.py | 15 |
| 模式匹配器 | routing/patterns.py | 82 |
| 信号生成器 | routing/signals.py | 28 |
| 约束校验器 | routing/constraints.py | 40 |
| 变更摘要 | routing/summary.py | 24 |
| MCP Server | mcp_server.py | 19 |
| CLI | cli.py | 29 |
| 文件监听 | watcher.py | 12 |
| 集成测试 | — | 14+147 |

**总测试数：740 · CLI 命令：14 · MCP 工具：14**

---

## 前端全景

### 已实现 ✅

| 功能 | 位置 | 状态 |
|---|---|---|
| 3D 深空星图 | src-ui/src/ui/graph.ts (2030行) | ✅ Three.js 完整渲染 |
| 三模式 (minimal/standard/full) | graph.ts VisualMode | ✅ 独立实例，切换重建 |
| 力导向布局 | graph.ts layout3D() | ✅ Fibonacci球面 + 力导向 |
| 节点类型着色 | 蓝=SYMBOL, 琥珀=MEDIUM, 紫=TEMPORAL | ✅ |
| 耦合深度L1-L4边着色 | graph.ts edgeOpacityByDepth() | ✅ |
| Pie Menu (右键) | graph.ts setupPieMenu() | ✅ 波及/聚焦/路径/信息 |
| 聚焦飞行 | graph.ts flyToNode() | ✅ 平滑相机动画 |
| 波及模式 | graph.ts startBlastMode() | ✅ BFS分层着色 |
| 路径搜索 | graph.ts findShortestPath() | ✅ BFS + 路径高亮 |
| 社区折叠三层视图 | graph.ts foldMode + enterGalaxy/exitGalaxy | ✅ 宇宙层/星座层/正常层 |
| Galaxy云渲染 | graph.ts buildGalaxyClouds() | ✅ spiral arms + golden ratio色调 |
| 跨星系连线 | graph.ts buildCrossEdges() | ✅ |
| 能量流粒子 | graph.ts crossFlowParticles | ✅ |
| 全息参考网格 | graph.ts buildHoloGrid() — shader 无限网格 | ✅ 静态，shader 绘制 |
| Bloom后处理 | graph.ts UnrealBloomPass | ✅ full mode ACES色调映射 |
| 悬停Tooltip | graph.ts setupTooltip() | ✅ |
| 详情卡片 | graph.ts setupDetailCard() | ✅ 耦合分布条 |
| 节点标签 | graph.ts updateLabels() | ✅ |
| 文件监听实时更新 | main.ts listen('graph-updated') | ✅ Tauri event → 星图刷新 |
| 文件夹选择器 | main.ts pickFolder() | ✅ Tauri dialog |
| 搜索节点 | main.ts doSearch() → starGraph.focusNode() | ✅ |
| **聊天面板** | chat.ts ChatPanel → Agent → Provider → ToolRegistry | ✅ P0 |
| **简报面板** | check.ts CheckPanel → hologram_run_check → summary.py | ✅ P1 |
| **约束面板** | constraints.ts ConstraintsPanel — YAML 规则编辑 | ✅ |
| **终端面板** | terminal.ts TerminalPanel — xterm.js 内嵌终端 | ✅ |
| **时间轴面板** | timeline.ts — 左侧滑入，固定左边缘入口 | ✅ |
| **Dock 标签页** | index.html dock-tabs + main.ts 互斥逻辑 | ✅ 右: 对话/约束 · 底: 简报/终端 |
| **浮动文件查看器** | file-viewer.ts — Monaco Editor 标签页窗口 | ✅ 语法高亮/Ctrl+S/拖拽/缩放 |
| Agent 引擎 | agent.ts 569行 + tool.ts 276行 (14个工具) | ✅ |
| Provider 层 | anthropic.ts + openai.ts + types.ts | ✅ |
| 事件总线 | events.ts — navigate:node 跨组件通信 | ✅ |
| **简报 ↔ 星图链路** | Signal.graph_node_ids + summary enrich + 前端点击跳转 | ✅ P2 |
| **CSS 对比度修复** | --starlight-dim 0.7→0.85, --text-muted 0.5→0.65, 45处硬编码提亮 | ✅ 2026-06-10 |
| **原型视觉对齐** | Google Fonts (Orbitron/JetBrains/Noto SC) + 深空气氛层(全息网格/轨道环/扫描线/暗角) + 面板角括号装饰 | ✅ 2026-06-10 |
| **Tree-sitter 多语言适配器** | 通用 TreeSitterAdapter 实现 LanguageAdapter 接口，支持 15 种语言（Python/JS/TS/Go/Rust/Java/C/C++/Ruby/C#/Kotlin/Swift/PHP/Lua/TSX），GrammarManager 自动下载编译缓存 | ✅ 2026-06-10 |
| **Agent 会话持久化** | 对话历史自动保存到 .hologram/chat_sessions.json，重启/切换工作区后恢复 | ✅ 2026-06-10 |
| **Git 源代码管理** | GitPanel — 变更文件列表/暂存/提交/推送/拉取/差异查看，左边缘 dock | ✅ 2026-06-10 |
| **Agent ↔ 星图联动** | Agent 调工具后自动触发星图可视化 — path→路径高亮、fragile→脆弱节点标琥珀、cycle→循环节点标红、impact/neighbors→聚焦飞行、diff→绿增红删、blindspots→盲区标记 | ✅ 2026-06-10 |
| **"问 Agent" 全面板覆盖** | 星图详情卡 + 简报违规行 + 文件查看器 + 文件树 + 时间轴事件 + 约束面板 — 6 个面板全部有"问 Agent"入口，点一下打开聊天窗自动发送上下文 | ✅ 2026-06-10 |

### 未落地 ❌ — 感知升级（Vibe Coding 安全后视镜）

> 以下不是要扩展引擎，是把已有数据中"能统计但没渲染成感知"的东西亮出来。
> 每一个都是 vibe coding 过程中真实遇到的"今天特别不顺"，数据已经在数据库里，缺的是呈现。

| 功能 | 说明 | 优先级 |
|---|---|---|
| **变更风险指纹** | 时间轴每条变更附带当时 check 简报快照，可回溯风险状态 | P5 |
| **复发热点检测** | 文件级复发计数，同一文件多次触发 L4 警报 → 星图着色升级 | P6 |
| **多工作区冲突预演** | 两个工作区 diff 叠加耦合分析，标记共同波及节点 | P7 |
| **门禁模式** | 新模块加入时自动评估 fan-in/fan-out/耦合深度分布 | P8 |

**架构能力储备（仅记录，不排期）：**
- 同表耦合检测：两个模块 import 图无关但读写同一个 DB 表/Redis key
- 事件驱动耦合检测：A emit 事件 B listen — 静态图上无边的 L4 隐形耦合
- 废弃/动态引用扫描：`importlib`、`getattr`、类路径字符串注入的暗区

> 2026-06-10: Tree-sitter 多语言适配器落地 — TreeSitterAdapter 实现 LanguageAdapter 接口，GrammarManager 管理下载/编译/缓存，15 种语言支持（Python/JS/TS/Go/Rust/Java/C/C++/Ruby/C#/Kotlin/Swift/PHP/Lua/TSX），架构为 TreeSitterAdapter 做 fallback → PythonAdapter/TypeScriptAdapter 覆盖专用语言。796 测试全部通过，零回归。
> 2026-06-10: 面板优化大回合 — CSS 对比度全局提亮、shader 无限全息网格、dock 标签页互斥、时间轴左侧面板、浮动文件窗口 Monaco Editor 集成。
> 2026-06-10: 原型视觉对齐 + CSS 变量换皮完工。
> 2026-06-09: P0-P4 全线完工。21 个 Tauri 命令，16 个 Agent 工具，740 个 Python 测试。

---

## Tauri 桥接层（src-tauri/src/main.rs）

21 个 `#[tauri::command]`，全部透传 Python CLI：

```
hologram_analyze · hologram_neighbors · hologram_impact · hologram_path
hologram_diff · hologram_fragile · hologram_cycle · hologram_coupling_report
hologram_blindspots · hologram_thread_conflicts · hologram_timeline
hologram_community_report · hologram_graph_summary
load_graph_json · analyze_and_load · start_watching · stop_watching
```

文件监听：1秒 polling mtime 对比，检测到变更 → 增量分析 → emit `graph-updated` 事件 → 前端刷新星图。

---

## 已知 Bug

| 问题 | 状态 |
|---|---|
| 折叠视图：星系叠加时加法混合过曝 | 未修复（ACES + 低 Bloom 缓解，不根治） |
| 跨星系连线 + 能量流粒子在深色背景中不可见 | 未修复 |
| 粒子流在 3794 条边上均布，密度被稀释 | 未修复（3794 是上次分析的边数，不同项目不同） |
| 应用偶发崩溃 | 未定位 |
| constraints.py — allowlist 为 None 时 from_dict 抛 TypeError | 预存，2 个测试失败 |

---

## 施工优先级（2026-06-09 确认）

**不会再扩展引擎。** 引擎完整。以下全部是胶水层工作：

### P0: Agent 能对话 ✅ (2026-06-09 完工)
- [x] 聊天 UI：输入框 + 消息列表 + EventSink 渲染 (`src-ui/src/ui/chat.ts` 380行)
- [x] 连接 settings.ts → Provider → Agent → ToolRegistry → Tauri invoke
- 全息指挥台现在是"星图 + 可对话的 Agent"

### P1: check 简报入指挥台 ✅ (2026-06-09 完工)
- [x] Tauri command `hologram_run_check`（包装 `hologram check --json`）
- [x] CLI `cmd_check` 加 `--json` 输出结构化 ChangeSummary JSON
- [x] 前端渲染组件：`CheckPanel`（`src-ui/src/ui/check.ts` 240行，底部抽屉面板）
- [x] 文件保存 → watcher → 自动跑 check → 结果出现在面板
- [x] Agent 工具注册：Agent 可主动调用 `hologram_run_check`
- [x] 工具栏 📋 简报按钮 + debounce 防重入

### P2: 简报 ↔ 星图链路 ✅ (2026-06-09 完工)
- [x] Signal 加 `graph_node_id` 字段 — signals.py + to_dict()
- [x] summary.py enrich() 查出坐标 — generate() 中 resolve names→IDs
- [x] 前端事件总线 — events.ts EventBus (navigate:node)
- [x] 简报条目可点击 → 星图响应 — check.ts 点击 affected_nodes → main.ts focusNode()

### P3: preflight + health ✅ (2026-06-09 完工)
- [x] preflight CLI + MCP — preflight.py 组装 impact + coupling + community + cycles
- [x] health CLI — preflight.py 聚合 timeline + coupling 快照 → 健康分 + 趋势
- [x] Tauri 桥接: hologram_run_preflight + hologram_run_health
- [x] Agent 工具注册: 14 个工具 (+2)

### P4: 锦上添花 ✅ (2026-06-09 完工)
- [x] 浮动文件窗口 — file-viewer.ts (可拖拽、调整大小、从简报点击打开)
- [x] 决策时间轴前端 — timeline.ts (底部抽屉面板，自动刷新)
- [x] 变更回看着色 — graph.ts showDiff/clearDiff (绿=新增, 红=删除, 橙=修改)
- [x] 约束配置 UI — constraints.ts (路由开关 + 阈值 + 白名单/黑名单编辑)

---

## 不再维护的文档

以下文件保留作为历史参考，但不再更新：

- `SPEC.md` — V1 设计文档（历史归档）
- `SPEC_V2.md` — V2 设计文档（历史归档）
- `SPEC_V3.md` — V3 设计文档（历史归档）
- `SPEC_V4.md` — V4 角色模型（历史归档）
- `TODO.md` — 已被本文档的施工优先级替代
- `CLAUDE.md` — 已被本文档替代

**此文件是项目唯一需要维护的规划文档。**
