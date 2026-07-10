# 六引擎协同 Preflight 设计文档

> 状态: 施工中 — 分析引擎已接入，LSP/合成/向量待接入
> 更新: 2026-07-13

---

## 一、六引擎全景

| # | 引擎 | 管什么 | 数据在哪 | 查询方式 |
|---|------|--------|---------|---------|
| 1 | 解析引擎 | AST 解析、短名消歧、跨文件边 | `fileIndex` (内存) | `buildFileNodeIndex` - 同步 <1ms |
| 2 | LSP 引擎 | 类型推理、多态消歧、10语言调用链 | SQLite edges + type_registry | `hologram_call resolve_call` |
| 3 | 分析引擎 | 耦合深度、脆弱度、环检测、Leiden社区 | MemoryIndex CSR | `hologram_call fragile_modules/detect_cycles/coupling_report` |
| 4 | 合成引擎 | 动态调度、框架路由、DI、动态导入、跨语言FFI | Graph edges (合成边带 metadata.synthesizedBy) | `hologram_call arch_blindspots` |
| 5 | 向量引擎 | n-gram 语义代码搜索 HNSW | usearch 磁盘索引 | `hologram_call search_symbols` (FTS5) |
| 6 | 查询引擎 | explore_deps + 全部 MCP 工具 | MemoryIndex + SQLite | MCP/Tauri 调用 |

---

## 二、设计原则

1. **Read-only 查询** — Preflight 从不触发重分析，只查已有数据
2. **独立并行** — 每个引擎查询不依赖其他引擎的结果，可以并发
3. **静默降级** — 任何引擎查询失败，preflight 继续跑剩下的，不阻塞
4. **增量刷新** — 每次 `edit_file`/`write_file` 完成后，3秒防抖刷新引擎快照
5. **三层汇总** — 快照查询(1ms) + 引擎查询(50ms) + 趋势对比(内存diff)

---

## 三、三层 Preflight 结构

### 第一层: 文件快照查询 (同步，<1ms)

```
来源: 解析引擎 (fileIndex)
数据: 文件名、符号数、扇入扇出、top5 被依赖符号
作用: 最轻量的风险评级。文件不在图中 = 新文件，放行。
```

### 第二层: 引擎查询 (异步，~50ms，启动时预加载)

```
来源: 分析 + LSP + 合成 + 向量
数据:
  - 脆弱度排名 & 耦合健康分 (分析引擎)
  - 循环参与 (分析引擎)
  - 类型调用链 & 有多少调用者 (LSP引擎)
  - 框架路由/DI/动态导入标记 (合成引擎)
  - 语义相似符号 (向量引擎)
作用: 深度风险评估。当前文件 + 全局趋势 = 是否门禁。
```

### 第三层: 会话趋势对比 (内存 diff)

```
来源: EngineSnapshot.baselineFragility vs 最新 fragilityRanks
数据: 脆弱度增量、新环出现、健康分下降
作用: 累积退化检测。连续小幅退化 → 升级门禁等级。
```

---

## 四、数据流

```
┌──────────────────────────────────────────────┐
│                 Agent setup                   │
│  loadEngineSnapshot(ctx, path, false)         │
│    → 并行调 4 个 hologram_call:              │
│       fragile_modules, detect_cycles,         │
│       project_health, arch_blindspots         │
│    → 写入 ctx.engine (baseline)              │
│    → 子Agent 创建时同样调用                  │
└──────────────┬───────────────────────────────┘
               │ ctx.engine 就绪
               ▼
┌──────────────────────────────────────────────┐
│              Agent 调 edit_file                │
│  PreflightHook.check()                      │
│    L1: fileIndex 查文件符号 (同步)           │
│    L2: ctx.engine 读引擎数据 (同步，已缓存)  │
│    L3: sessionDrift 累积退化 (同步)          │
│    → 汇总: LOW/MEDIUM/HIGH 风险             │
│    → HIGH → 门禁拦截                        │
│    → MEDIUM+ → ⚠️ 警告注入结果顶部          │
└──────────────┬───────────────────────────────┘
               │ 文件已修改
               ▼
┌──────────────────────────────────────────────┐
│          agent:tool-done 事件                  │
│  scheduleEngineSnapshotRefresh(ctx, path)    │
│    → 3s 防抖 → loadEngineSnapshot(refresh)  │
│    → 对比 baseline → 更新 sessionDrift       │
│    → 下次 preflight 看到最新数据            │
└──────────────────────────────────────────────┘
```

---

## 五、待接入的引擎

### 5.1 LSP 引擎

| 项目 | 说明 |
|------|------|
| 数据源 | `hologram_call resolve_call` 按文件路径 |
| 注入到 EngineSnapshot | `lspCallers: Array<{symbol, file, line, callCount}>` |
| Preflight 显示 | `│ LSP: handleClick 被 3 个调用者引用 (src/ui/chat.ts:42, ...)` |
| 门禁逻辑 | 调用者 > 5 → 警告；调用者跨文件 > 3 → 升级风险 |
| 实现位置 | `loadEngineSnapshot` 加一个并行 invoke |

### 5.2 合成引擎

| 项目 | 说明 |
|------|------|
| 数据源 | `hologram_call arch_blindspots` 过滤当前文件 |
| 注入到 EngineSnapshot | `synthesisMarkers: Array<{type, detail}>` |
| Preflight 显示 | `│ 合成: React JSX 引用, Vue event handler` |
| 门禁逻辑 | 有框架路由标记 → 警告"改动可能影响运行时行为" |
| 实现位置 | `loadEngineSnapshot` 加一个并行 invoke |

### 5.3 向量引擎

| 项目 | 说明 |
|------|------|
| 数据源 | `hologram_call search_symbols` 用文件内 top 符号名搜索 |
| 注入到 EngineSnapshot | `semanticNeighbors: Array<{name, file, similarity}>` |
| Preflight 显示 | `│ 相似符号: handleClick (src/ui/graph.ts), onClick (src/ui/chat.ts)` |
| 门禁逻辑 | 有高相似度邻居 → 建议"同时检查这些函数" |
| 实现位置 | `loadEngineSnapshot` 加一个并行 invoke |

---

## 六、实现优先级

1. ✅ 解析引擎（fileIndex）— 已接入
2. ✅ 分析引擎（fragility/cycles/health）— 已接入
3. ⬜ LSP 引擎 — 调用者信息最有价值，先做
4. ⬜ 合成引擎 — 框架/DI 盲区检测
5. ⬜ 向量引擎 — 语义邻居提示，锦上添花
6. ⬜ 会话趋势对比 — drift 计算已做，需要更细粒度（per-file drift）

---

## 七、不可做的事

- ❌ Preflight 不跑 analyze_project（太重，60秒+）
- ❌ 不改 Agent prompt 让它"先调 trace_impact"（hook 替它调了）
- ❌ 不在 preflight 里做增量更新（那是 watcher 的事）
- ❌ 不串行调引擎（各自独立，用 Promise.all）
