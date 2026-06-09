# SPEC V4: 多角色入口 — 同一个引擎，不同的驾驶舱

> V1 定义了"要什么"。V2 定义了"什么能做到"。V3 定义了"怎么看"。
> V4 定义了**"谁在看"**——当引擎服务于四个完全不同的人时，系统需要几个入口。
>
> 核心命题：**引擎是通用的。入口不是。** 为一个人设计的交互层，对另一个人是障碍。
> V4 不新增分析能力。V4 定义四套驾驶舱——每条都消费同一份引擎输出，组装方式不同。

---

## 目录

1. [诊断：引擎完整，入口残缺](#1-诊断引擎完整入口残缺)
2. [四个角色，四套驾驶舱](#2-四个角色四套驾驶舱)
3. [角色 A：外行 vibe coder — Constraint Setter](#3-角色-a外行-vibe-coder--constraint-setter)
4. [角色 B：专业开发者 — Explorer](#4-角色-b专业开发者--explorer)
5. [角色 C：专业 vibe coder — Hybrid Operator](#5-角色-c专业-vibe-coder--hybrid-operator)
6. [角色 D：架构师 — Health Watcher](#6-角色-d架构师--health-watcher)
7. [共通缺失：空间↔文本叙事链路](#7-共通缺失空间文本叙事链路)
8. [引擎输出标准化：一份输出，四套消费](#8-引擎输出标准化一份输出四套消费)
9. [实现路径](#9-实现路径)
10. [V4 不做什么](#10-v4-不做什么)

---

## 1. 诊断：引擎完整，入口残缺

### 1.1 现状

```
V1 引擎: 图骨架 + 社区 + 波及环 + 路径搜索
V2 引擎: 耦合深度 + 线程交错 + 数据流环 + 时间轴 + 边界覆盖
V3 引擎: L5-L1 信号 + 约束校验 + 局面简报

交互层:
  3D 星图    — 空间界面。可探索、可操作。不与简报对话。
  check 简报  — 文本界面。可决策、可发送 Agent。不与星图对话。
  CLI 命令    — 原子工具。可查询。需要用户知道该查什么。
```

交互层三条通路互相不知道对方存在。

### 1.2 根因

**V1-V3 的所有设计假设中，"用户"是单数。**

V3 的约束框架解决的是**一个外行 vibe coder** 的裁决带宽问题——这是正确的起点，因为这个人是最需要帮助的。但当系统要作为通用工具服务更多人时，问题不再是"约束够不够精确"，而是"入口对不对路"。

专业开发者不需要你替他拦截变更——他自己会判断。他需要的是改之前看清全局。
架构师不需要看单次变更的简报——粒度假了。他需要的是看趋势。

### 1.3 核心洞察

**新增的不是分析能力。新增的是"组装方式"。**

所有分析数据已经存在：`impact_bfs()`、耦合深度报告、环列表、社区归属、时间轴事件。需要的不是新算法，是把这些数据按角色的思维习惯重新打包——同一份引擎输出，四套不同的驾驶舱。

---

## 2. 四个角色，四套驾驶舱

```
                        ┌──────────────────────────┐
                        │       HoloGram 引擎        │
                        │  V1 图 + V2 分析 + V3 信号  │
                        └──────────┬───────────────┘
                                   │ 同一份输出
               ┌───────────────────┼───────────────────┐
               │                   │                   │
          ┌────▼────┐      ┌──────▼──────┐      ┌─────▼─────┐
          │ 事后拦截  │      │  事前探查    │      │  趋势面板  │
          │ V3 check │      │  preflight  │      │  health   │
          └─────────┘      └─────────────┘      └───────────┘
               │                   │                   │
         外行 vibe coder     专业开发者            架构师
                              专业 vibe coder
```

| 角色 | 驾驶舱 | 核心操作 | 触发时机 | 现状态 |
|---|---|---|---|---|
| 外行 vibe coder | V3 check 简报 | 设约束 → 看拦截 → 做决定 | 事后（变更已做完） | ✅ V3 已定义 |
| 专业开发者 | preflight 简报 | 指定目标 → 看波及 → 决定改不改 | 事前（改之前） | ❌ 缺失 |
| 专业 vibe coder | check 简报 + 星图 drill-down | 看拦截 → 点进星图 → 空间理解 → 决定 | 事后 | ⚠️ 简报/星图无链路 |
| 架构师 | health 趋势面板 | 打开看 → 发现恶化区域 → 定向检查 | 周期性（日/周） | ❌ 缺失 |

---

## 3. 角色 A：外行 vibe coder — Constraint Setter

### 3.1 定义

不懂代码结构。Agent 生成代码。他设边界，系统守边界。

### 3.2 入口

V3 的 `hologram check` — 已经完整定义。不需要新增。

### 3.3 他对系统的认知路径

```
Agent 改代码 → check 自动触发 → 99% 一行 ✅ → 1% 简报 → 他点 [确认] 或 [Agent 先分析]
```

他不主动使用星图。星图对他而言是"存在但不需要打开的东西"——就像你不需要打开手机的文件系统来用 app。

### 3.4 V4 对他的变化

**无。** V3 已经定义了他需要的全部交互。他不需要 preflight（改了再说，反正会被拦截），不需要 health（看 trend 的前提是看得懂模块名）。

---

## 4. 角色 B：专业开发者 — Explorer

### 4.1 定义

自己写代码，不用 Agent 生成。理解结构，能读 AST，但系统太大、记不住全部依赖关系。

他的核心行为不是"改完被拦截"，而是**"改之前看清全局"**。

### 4.2 缺失的入口：preflight

```
$ hologram preflight auth.py::handle_session

┌──────────────────────────────────────────────────────────────┐
│  Preflight: handle_session · auth.py                         │
│                                                              │
│  ── 直接邻居 ─────────────────────────────────────────────── │
│  被依赖 (此函数调用):                                         │
│    · db.query_user()           L1 公开API                    │
│    · cache.get_session()       L3 共享数据 (redis)            │
│    · validator.check_token()   L1 公开API                    │
│    · log.write()               L1 公开API                    │
│                                                              │
│  依赖方 (谁调用此函数):                                       │
│    · request_handler.py:102    L1 · 每次请求                  │
│    · middleware.py:55           L1 · 请求管道                  │
│    · scheduler.py:203          L3 · 后台定时任务 ⚠            │
│    · tests/test_auth.py:34     L1 · 测试                     │
│                                                              │
│  ── 波及预估 (BFS 3层) ───────────────────────────────────── │
│  Depth 1: 4 节点                                              │
│  Depth 2: 12 节点 (含 1 个延迟 — scheduler_state.json)        │
│  Depth 3: 31 节点 (进入 payment 社区)                         │
│  总波及: 47 节点 · 跨 3 社区                                  │
│                                                              │
│  ── 脆弱性 ────────────────────────────────────────────────── │
│  此函数耦合深度: 无 L4 穿透                                   │
│  但 scheduler.py:203 调用方在后台线程上 —                     │
│  改动后行为变化在数小时后暴露 ⚠                                │
│                                                              │
│  ── 历史 ─────────────────────────────────────────────────── │
│  过去 30 天: 此函数变更 2 次，均未引发回滚                     │
│  最近变更: 2026-06-03 (d4e8f2a) — 加了一个参数                │
│                                                              │
│  [→ 在星图中打开]  [发送给 Agent]                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 数据来源（全部已有）

| 信息块 | 来源 |
|---|---|
| 直接邻居 | `graph.neighbors()` + `outgoing_edges()`(被依赖) / `incoming_edges()`(依赖方) |
| 波及预估 | `graph.impact_bfs()` + L3/L4 标注来自 `coupling.py` |
| 脆弱性 | `coupling_depth_report()` + `thread_conflict_report()` |
| 历史 | `timeline.py` SQLite 查询 |
| 跨社区 | `community.py` 归属映射 |

**零新算法。** `preflight` 是一个胶水函数——组装已有报告的职能。

### 4.4 CLI + MCP 双通道

```
$ hologram preflight <target>        # CLI
hologram_preflight(target)           # MCP tool (新增第 14 个)
```

专业开发者可能在 IDE 终端里直接跑，也可能通过 Agent 调 MCP。两个通道底层同一份 `SummaryGenerator.enrich()` 逻辑。

---

## 5. 角色 C：专业 vibe coder — Hybrid Operator

### 5.1 定义

既懂代码又用 Agent 加速。收到拦截简报后，不满足于看文字——他想**"看到"耦合关系在空间里的形状**。

### 5.2 缺失的链路：简报 ↔ 星图

他现在收到 V3 简报：

```
⛔ api/schemas.py:47  ChatRequest 新增必填字段 session_id
   影响调用方: chat.py:102, system.py:33, mcp_server.py:18
```

他脑子里想："让我看看 chat.py 和 schemas.py 在空间里什么关系，中间经过了什么。"

**他现在需要：关掉简报 → 打开星图 → 搜索 ChatRequest → 手动找调用链。路径断裂。**

### 5.3 解法：简报条目 = 星图坐标

简报里每一个条目，带上它对应的图节点 ID：

```json
{
  "signal_type": "l5_api_contract_kind",
  "description": "ChatRequest 新增必填字段 session_id",
  "graph_node_id": "node_a1b2c3d4",          // ← 新增
  "affected_node_ids": [                        // ← 新增
    "node_e5f6g7h8",  // chat.py:102
    "node_i9j0k1l2",  // system.py:33
    "node_m3n4o5p6"   // mcp_server.py:18
  ]
}
```

点击简报条目 → 前端 `starGraph.highlightSubgraph(node_a1b2c3d4, affected_node_ids)` → 星图自动飞到该节点，波及范围高亮，其余节点半透明。

**这个链路打通之后：**
- 简报不再是独立的"读取界面"，而是星图的**远程控制器**
- 星图不再是独立的"观赏界面"，而是简报的**空间投影**
- 用户在简报里看到一个"形状怪异"的拦截 → 点一下 → 空间里看到形状 → 理解了 → 回去做决定

### 5.4 实现代价

- `Signals.py` 的 `Signal` dataclass 加两个字段：`graph_node_id: Optional[str]`，`affected_node_ids: List[str]`
- `summary.py` 的 `enrich()` 在生成简报时查出对应节点 ID
- 前端 `graph.ts` 新增 `highlightSubgraph(centerId, affectedIds)` 方法
- 前端简报 UI 里的条目加 `onclick → invoke('focus_graph', {nodeId})`

**这是 V4 里实现代价最小、但感知变化最大的一个改动。**

---

## 6. 角色 D：架构师 — Health Watcher

### 6.1 定义

自己不常写代码。管理的是系统的**结构健康度**——模块耦合是否在恶化、社区是否在分裂、热点是否在形成。

他不看变更级数据。他看趋势。

### 6.2 缺失的入口：health

```
$ hologram health --days 30

┌──────────────────────────────────────────────────────────────┐
│  结构健康度 · 2026-05-10 → 2026-06-09                         │
│                                                              │
│  ── 规模 ─────────────────────────────────────────────────── │
│  节点: 768 → 937    (+169)                                    │
│  边:   754 → 912    (+158)                                    │
│  社区: 12 → 14      (+2 · 裂变: auth 社区分裂为 auth + session)│
│                                                              │
│  ── 耦合趋势 ─────────────────────────────────────────────── │
│  L1 公开API:     312 → 389   (+77)   ████████████            │
│  L2 内部导入:     201 → 228   (+27)   ████                    │
│  L3 共享数据:      89 → 112   (+23)   ████                    │
│  L4 封装穿透:      12 → 31    (+19)   ████████████ ⚠ 翻倍    │
│                                                              │
│  ── 热点社区 ─────────────────────────────────────────────── │
│  payment 社区 L4 密度: 0.08 → 0.23  🔴 恶化                  │
│  auth 社区跨社区边:   12 → 27        🟡 关注                  │
│  data 社区新增环:     0 → 2          🟡 关注                  │
│                                                              │
│  ── 时间轴异常 ───────────────────────────────────────────── │
│  过去 30 天 check 拦截率: 3.2% (6/188 次变更)                 │
│  拦截率趋势: 稳定 (波动 < 1%)                                  │
│  最常被拦截的模块: schemas.py (3次), scheduler.py (2次)       │
│                                                              │
│  [→ 在星图中打开 payment 社区]  [导出 JSON]                    │
└──────────────────────────────────────────────────────────────┘
```

### 6.3 数据来源

| 信息块 | 来源 | 工程量 |
|---|---|---|
| 规模变化 | diff 两张图的 `node_count` / `edge_count` | 已有 |
| 耦合趋势 | 每天存一份 `coupling_depth_report()` 的快照 | 快照逻辑新增 |
| 热点社区 | 按社区聚合耦合深度统计 | 已有数据，聚合查询 |
| 时间轴异常 | `timeline.py` 的 event 聚合 | 已有数据，聚合查询 |

**主要工程增量是健康快照的存储。** 需要一个每日 cron 或 commit hook 来保存当天的 `coupling_depth_report()` + 图统计摘要。其余全是已有数据的聚合。

### 6.4 不需要的东西

- 不需要实时性。架构师一天看一次或一周看一次。
- 不需要 fine-grained drill-down（如果真的需要，他可以用星图）。
- 不需要约束配置——健康面板是只读的。

---

## 7. 共通缺失：空间 ↔ 文本叙事链路

这不是任何一个角色的需求。这是**所有角色都会遇到的系统性断裂**。

### 7.1 现状

```
星图:
  - 可以看节点
  - 可以看耦合边
  - 可以展开社区
  - 但不知道"这个节点刚刚触发了一条 L5 拦截"

简报:
  - 知道拦截了什么
  - 知道影响面
  - 但不知道"这个拦截在星图里长什么样"
```

### 7.2 解法：统一坐标系统

每一个有意义的输出，带上它的**空间坐标**：

| 输出 | 携带坐标 |
|---|---|
| Signal（简报条目） | `graph_node_id` + `affected_node_ids` |
| CouplingReport（模块） | `file_path` → 图节点 ID 列表 |
| Cycle（数据流环） | `node_ids`（已有） |
| TimelineEvent | `related_nodes`（已有） |
| Community | `node_ids`（已有） |

前端的每一个视图，都能**消费坐标并响应**：

| 视图 | 响应方式 |
|---|---|
| 星图 | `flyToNode(id)` / `highlightSubgraph(ids)` / `showCommunity(id)` |
| 简报 UI | 条目可点击 → invoke 星图 |
| health 面板 | 社区/模块名可点击 → invoke 星图 |
| Agent 对话 | Agent 调 MCP 拿到带坐标的 JSON → 在对话里生成可点击链接 |

### 7.3 实现

不是新模块。是**现有数据结构的字段补充** + **前端事件总线**。

```
src_python/
  routing/signals.py   → Signal 加 graph_node_id, affected_node_ids
  routing/summary.py   → enrich() 查出坐标

src-ui/
  events.ts            → 新增事件总线 (NEW)
  ui/graph.ts          → 新增 highlightSubgraph(), showCommunity()
  ui/panel.ts           → 简报 UI 组件，消费信号 + 触发星图事件 (NEW)
```

---

## 8. 引擎输出标准化：一份输出，四套消费

### 8.1 引擎层新增

引擎层唯一的增量：`PreflightReport` — 事前探查的结构化输出。

```python
@dataclass
class PreflightReport:
    """Preflight 查询的结构化输出。胶水层 — 不新增分析。"""
    target_node: Dict[str, Any]           # 目标节点信息
    direct_dependencies: List[Dict]       # 被依赖方 (outgoing)
    direct_dependents: List[Dict]         # 依赖方 (incoming)
    blast_layers: List[Dict]              # impact_bfs() 分层结果
    total_affected: int
    cross_community_count: int
    fragility: Dict[str, Any]             # coupling_depth_report 摘取
    thread_risk: Optional[Dict]           # thread_conflict_report 摘取
    recent_history: List[Dict]            # timeline 查询
    graph_node_id: str                    # 星图坐标
    affected_node_ids: List[str]          # 波及节点的星图坐标
```

### 8.2 角色 → 消费端映射

| 能力 | 引擎 | A 外行 coder | B 专业 dev | C 混合 coder | D 架构师 |
|---|---|---|---|---|---|
| 图查询 | V1 | Agent 消费 | preflight + CLI | 星图 drill-down | health 聚合 |
| 耦合深度 | V2 | 简报信号源 | preflight 脆弱性 | 简报条目 | health 趋势 |
| 数据流环 | V2 | 简报信号源 | preflight 标注 | 简报条目 | health 趋势 |
| 线程冲突 | V2 | 简报信号源 | preflight 标注 | 简报条目 | health 列表 |
| 社区归属 | V1 | 后台 | preflight 跨社区 | 星图折叠 | health 热点 |
| 时间轴 | V2 | 简报历史 | preflight 历史 | 简报历史 | health 异常的根源 |
| 约束校验 | V3 | ✅ 核心交互 | 不需要 | ✅ 核心交互 | 不需要 |
| 局面简报 | V3 | ✅ 核心交付 | preflight(变体) | ✅ + drill-down | 不需要 |

---

## 9. 实现路径

V4 不引入新算法。按"谁被卡得最痛"排序。

### P0: 数据层 — 空间坐标（先做，所有后续依赖它）
```
1. Signal dataclass 加 graph_node_id + affected_node_ids       (~10行)
2. summary.py enrich() 查出坐标                                   (~30行)
3. 前端事件总线 events.ts                                         (~50行)
```
做完这个，简报和星图之间就有了**可以连接的插头**。后续所有 drill-down 功能都靠它。

### P1: 简报 → 星图链路（打通第一条叙事线）
```
4. 前端 graph.ts 加 highlightSubgraph(centerId, affectedIds)    (~40行)
5. 简报 UI 条目可点击 → 触发星图事件                             (~30行，新组件 ui/panel.ts)
```
做完这个，角色 C（专业 vibe coder）的体验彻底不一样了。简报不再是一个"看完就关"的面板——它是星图的遥控器。

### P2: preflight 命令（打开第二个角色入口）
```
6. preflight.py — PreflightReport 胶水函数 (~80行)
7. CLI: hologram preflight <target> (~20行，cli.py 加子命令)
8. MCP: hologram_preflight(target) (~15行，mcp_server.py 加工具)
```
做完这个，角色 B（专业开发者）有了入口。preflight 的 `PreflightReport` 结构和局面简报复用同一套 `enrich()` 逻辑——信息来源相同，组装角度不同。

### P3: health 趋势（打开第四个角色入口）
```
9. health.py — 健康快照存储 + 聚合查询 (~120行)
10. CLI: hologram health --days N (~30行)
11. 可选：health 趋势面板 UI (~150行，不阻塞交付——CLI 先够用)
```
做完这个，角色 D（架构师）有了入口。health 是四个角色里容忍度最高的——他一周看一次，CLI 输出对他来说已经足够了。

### 不做：前端星图重构
星图本身（`graph.ts` 2000+行）不需要大改。只需要新增两个方法（`highlightSubgraph`、`showCommunity`）作为事件总线的响应端。现有交互范式不变。

---

## 10. V4 不做什么

### 10.1 不新增分析算法

preflight = impact + coupling + community + timeline 的胶水组装。health = 同一份数据的聚合。所有信息已在引擎中。

### 10.2 不做交互偏好猜测

一个人喜欢星图主导 + 简报辅助，另一个人喜欢简报主导 + 星图偶尔打开。V4 不替用户选——它提供四套驾驶舱，用户自己决定打开哪一套。

### 10.3 不做个性化推荐

"根据你的使用习惯，建议你看看 payment 社区的健康度"——不做。V4 是机械的入口开关，不是智能推荐系统。那个留给 Agent。

### 10.4 不统一驾驶舱

四套驾驶舱不会合并成一个"超级视图"。那不叫通用——那叫谁都嫌多。每个人只看到自己需要的那个仪表盘。

### 10.5 不替代现有设计

V3 的约束框架 + check 简报是角色 A 的完美驾驶舱。V4 不会"重构"它。V4 只是不再假设所有用户都是角色 A。

---

## 附录 A：与 V1/V2/V3 的关系

```
V1  图骨架     ── 空间数据
V2  深度分析   ── 信号数据
V3  约束框架   ── 事后路由（角色 A 的驾驶舱）
V4  多角色入口 ── 同一引擎的另外三套驾驶舱 + 空间↔文本叙事链路

V4 坐在 V1/V2/V3 上面。消费它们的数据，不做新分析。
V4 新增的是：
  - PreflightReport（事前探查的胶水组装）
  - HealthReport（趋势聚合的胶水组装）
  - 空间坐标（每个输出带 node_id）
  - 前端事件总线（简报↔星图链路）
```

## 附录 B：一句话总结

**V1-V3 建了引擎。V4 把引擎装进了四台不同的车上。**

引擎是同一个。但司机不同——有人需要仪表盘（简报），有人需要方向盘（星图），有人只需要一个急刹按钮（约束拦截）。V4 做的事不是改造引擎。是把每个司机该够到的按钮，放到他手边。
