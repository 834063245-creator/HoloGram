# Changelog

HoloGram 遵循 [Semantic Versioning](https://semver.org/)。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
分类为：Added · Changed · Fixed · Removed · Security。

---

## [0.5.0] — 2026-06-20 · 边界规则引擎

### Added
- **`hologram_policy_check`** — 自定义架构边界规则引擎。用户定义 source/target 文件匹配模式（glob 或正则）+ 边类型，引擎扫描依赖图返回越界违规清单
- **EdgeKind::from_str()** — 字符串→边类型枚举的反序列化
- **快捷模式**：直接传 `source` + `target` 即可单条规则检查，无需构造完整 rules 数组
- **内置 Agent 工具定义** — 硬编码中文描述，LLM 自动识别"查边界""模块隔离""有没有越界"等触发词

### Changed
- MCP 工具数 24→25，`test_tools_list` 断言同步更新

---
## [0.4.0] — 2026-06-18 · 存储引擎 v2.5 + 全线 Bug 扫除

### Added
- **NL 自然语言探索** — `hologram_explore` 接受自然语言 query，引擎自动切词+消歧
- **框架路由覆盖（8 种）** — Django / Express / FastAPI / Flask / Rails / Spring / Gin / NestJS URL→处理函数映射
- **动态调度合成 Phase 1** — 检测 callback/observer 注册模式，创建 synthesized 边
- **语言支持扩展** — tree-sitter 语法 10→18 种（新增 C# / Swift / Dart / Scala / Haskell / JSON / HTML / CSS）

### Changed
- **存储引擎 v2.5** — MemoryIndex 邻接表 + SqliteDb FTS5 + GraphStore `parking_lot::RwLock` N 路并发读
- **增量更新** — watcher → IncrementalUpdater（重解析 → 文件内 diff → 跨文件边修复）→ validate → swap
- **双管线移除** — 前端不再自动切文件视图，所有项目直接渲染星图

### Fixed
- 23 项 Bug（5 致命 + 4 高危 + 9 中危 + 5 低危），覆盖 mcp / dataflow / coupling / parser / resolver / runner / graph / incremental / memory / sqlite / louvain
- 275 tests（257 lib + 18 RPC）全绿

---

## [0.3.0] — 2026-06-17 · 前端感知升级

### Added
- **子 Agent 系统** — `agent_spawn` 工具，主 Agent 可 spawn 子 Agent 执行并行任务
- **流式 Markdown 渲染** — 边收 chunk 边 `marked.parse()` 渲染，rAF 节流
- **工具进度直播** — `ToolProgress` 事件 → 工具卡片增量追加输出
- **焦点上下文** — 监听文件/节点焦点，自动注入用户消息前缀
- **Agent 模式切换** — 通用/编码/架构/极速四档预设
- **文件树实时更新** — 监听 `workspace:files-changed`，1.5s 防抖自动刷新

---

## [0.2.0] — 2026-06-16 · Python → Rust 全量迁移

### Added
- **Rust 引擎 `engine/`** — 45 源文件，28 tests，29 RPC 端点，10 模块
- **MCP 协议 Rust 实现** — `engine/src/mcp.rs`（~1,400 行），25 个工具
- **全量分析 Rust** — Django 3,031 文件 4.1s（Python 50-100x 提升）
- **引擎自启动** — Tauri 启动时 spawn `engine.exe`（TCP :9777 + MCP serve）
- **安全沙箱 8 层** — 目录监禁/读写分级/审计日志/CSP/SSRF/DPAPI/fail-closed/权限闸门
- **代码翻译器** — LLM 逐行翻译 + 三栏审计，缓存落 `.hologram/translations/`
- **Explore 聚合查询** — `hologram_explore` 一次返回 Flow + Blast Radius + Relationships + Source Code + Architecture Alerts

### Changed
- 所有分析、查询、MCP 工具从 Python CLI 子进程切为 Rust 引擎 TCP RPC
- McpManager 从 `python -m src_python serve` 切为 `engine.exe serve --project-root`

### Removed
- `src_python/` 完全退役（Python 引擎 + 嵌入式 Python 运行时）
- `run_hologram()` / `run_python_code()` / `python()` / `py_json()` 全部删除
- `tauri.conf.json` 移除 Python bundle

### Fixed
- 22 条审计缺陷（6 致命 / 4 高危 / 7 中危 / 5 低危），927 测试通过

---

## [0.1.0] — 2026-06-14 · 首个可用版本

### Added
- **14 门语言统一分析** — Python AST + 13 门 tree-sitter 语言
- **三层分析体系** — V1 拓扑 / V2 深层诊断 / V3 变更路由
- **3D 交互式星图** — Three.js 力导向 + BloomPass + 全息网格 Shader + GPU Instancing
- **内置 LLM Agent** — 46 个工具，图↔Agent 双向实时联动
- **约束门禁** — YAML 规则 + 5 级破坏信号 + CI 集成
- **IDE 工具集** — Monaco 浮动编辑器 / xterm.js 多标签终端 / Git 面板
- **三格式序列化** — JSON / MessagePack / SQLite+FTS5
- **MCP 持久化服务** — JSON-RPC 长驻进程 + CLI 自动降级
- **增量实时更新** — 文件监听 + 原子替换 + 自动回滚
- **大项目双管线** — >500 源文件走轻量文件视图 + 后台分析
- **Tauri 2 桌面应用** — Windows .msi / .nsis 安装包
- **简报 ↔ 星图链路** — Signal graph_node_ids + summary enrich + 前端点击跳转
- **"问 Agent" 全面板覆盖** — 星图/简报/文件查看器/文件树/时间轴/约束 6 面板
- **复发热点检测 (P6)** — L4 复发文件统计 + 星图着色升级
- **多工作区冲突预演 (P7)** — 双工作区重叠节点 + 耦合风险评级
- **门禁模式 (P8)** — 新模块 fan-in/fan-out/耦合深度分布评估
- **嵌入式 Python 打包** — NSIS 安装包内嵌完整 Python 3.14.4 + 依赖
- **卸载时询问清除用户数据** — WiX fragment + PowerShell 弹窗
