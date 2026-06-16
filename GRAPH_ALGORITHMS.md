# HoloGram 图系统算法全览

## 一、整体架构

```
源码目录
  │
  ├─ 1. 文件发现 (discovery)        — walkdir + 排除列表
  ├─ 2. 并行解析 (parallel parser)  — rayon + 多个语言适配器
  ├─ 3. 增量合并 (GraphMerger)      — O(n) 去重合并
  ├─ 4. 跨文件解析 (resolver)       — 短名→全限定名
  ├─ 5. 耦合分析 (coupling)         — L1-L4 深度分配
  ├─ 6. 社区检测 (louvain)          — Louvain 模块度优化
  └─ 7. 约束检查 (preflight)        — 全量分析管线
        │
        ▼
  全量依赖图 → 3D 力导向布局 → Three.js 星图渲染
```

核心数据结构：有向图 `Graph`，节点 `Node` 三种，边 `Edge` 十种。

---

## 二、节点与边模型

### 节点三种类型（`engine/src/graph/node.rs`）

| 类型 | 含义 | 示例 |
|------|------|------|
| `Symbol` | 代码符号 | 函数、类、变量 |
| `Medium` | 数据媒介 | 数据库、缓存、文件 |
| `Temporal` | 时序节点 | 定时器、异步任务、线程 |

关键字段：
- `in_degree` / `out_degree`：预计算出入度，避免以前 O(V×E) 的遍历 bug
- `loc_key()`：`"location::name::kind"` 稳定键，用于跨文件去重
- `community_id`：Louvain 社区检测结果

### 边十种类型（`engine/src/graph/edge.rs`）

**结构边（L1-L2）：** `Imports`, `Calls`, `Inherits`, `Defines`
**数据边（L3）：** `Reads`, `Writes`, `Shares`
**时序边（L4）：** `Triggers`, `Awaits`, `Sequences`

关键字段：
- `coupling_depth`：1-4，耦合深度
- `cross_file`：是否跨文件边
- `temporal_delay_sec`：时序延迟（秒）
- `medium_node_id`：中介节点 ID

---

## 三、管线算法（分析全流程）

### 3.1 文件发现 — `engine/src/pipeline/discovery.rs`

```
算法：walkdir 递归遍历 + 排除过滤
排除目录：.git, __pycache__, node_modules, venv, target, dist, build...
支持扩展名：py, js, ts, tsx, go, rs, java, c, cpp, rb, lua 等 17+ 种
```

### 3.2 并行解析 — `engine/src/pipeline/parser.rs`

```
算法：rayon 并行迭代器 (par_iter)
输入：文件路径列表
过程：每个文件 → 根据扩展名选择适配器 → tree-sitter 解析 AST
      → 提取函数/类/导入/调用 → 生成 Node + Edge
输出：Vec<FileData>（每个文件独立子图）
```

三个语言适配器：
1. **PythonAdapter** — 专门处理 Python `import` / `def` / `class`
2. **TypeScriptAdapter** — 专门处理 TS/JS `import` / `function` / `class`
3. **TreeSitterAdapter** — 通用 tree-sitter 覆盖 Go、Rust、Java、C/C++、Ruby、Lua 等

### 3.3 增量合并 (GraphMerger) — `engine/src/graph/merge.rs`

**关键优化：** v3 Python 版的 bug 是每次合并都从整个累积图重建 `loc_key` 索引，导致 O(V²) 累积复杂度。修正后保持索引常驻，每次合并 O(|incoming|)。

```
算法：增量索引合并
1. 对每个文件的子图：
   a. 对每个节点，计算 loc_key = "location::name::kind"
   b. 查全局索引：已存在 → 跳过
   c. 不存在 → 加入图 + 更新索引
2. 所有边直接加入（跨文件解析稍后处理）
复杂度：O(files × nodes_per_file)，不再二次方
```

### 3.4 跨文件名解析 (CrossFileResolver) — `engine/src/graph/resolver.rs`

```
算法：短名→全限定名匹配
1. 构建 name_index: "short_name" → ["full.qualified.id", ...]
   "User" → ["app.models.User", "auth.models.User"]
2. 对每条边：
   a. source/target 是否已在图中？是 → 不变
   b. 不在 → 用 short_name 查 name_index
      - 唯一匹配 → 直接解析
      - 多候选 → 从右向左匹配包路径（如 models.User 匹配 app.models.User）
3. 创建解析后的边（标记 cross_file = true）
4. 清理孤立边（两端点均不存在的边）
```

---

## 四、分析算法（7 个核心分析器）

### 4.1 耦合深度分配 — `engine/src/analysis/coupling.rs`

```
算法：O(E) 单次遍历
对每条边根据其 EdgeKind 和包层级分配 L1-L4：
  L1 = 结构边 + 同包（如 src/views.py → src/models.py，同 "src" 前缀）
  L2 = 结构边 + 跨包（如 src/views.py → lib/utils.py）
  L3 = 数据边（Reads / Writes / Shares）
  L4 = 时序边（Triggers / Awaits / Sequences）

包前缀提取：location 的 "/" 前第一段
```

### 4.2 循环检测 (Tarjan SCC) — `engine/src/analysis/cycles.rs`

```
算法：Tarjan 强连通分量 (SCC)
1. 节点映射到连续索引 0..n-1
2. DFS 遍历，维护：
   - index[v]：发现时间
   - lowlink[v]：能回溯到的最早节点
   - on_stack[v]：是否在递归栈中
3. 当 lowlink[v] == index[v] 时，弹出栈中节点形成一个 SCC
4. 过滤：只保留 size > 1 的 SCC（真正的循环）
5. 自环（size=1）被过滤，不计为循环

复杂度：O(V + E)
输出：每个循环的节点列表 + size
```

### 4.3 脆弱性评分 — `engine/src/analysis/fragility.rs`

```
算法：节点脆弱性排名
对每个节点 n：
  fan = out_degree + in_degree
  coupling_penalty = Σ(出边 coupling_depth) / max(fan, 1)
  fragility_score = fan × (1 + coupling_penalty)

排序 → 取 top N

直观含义：
- 度数越高 → 越脆弱（影响面大）
- 耦合越深（L3/L4） → 越脆弱（改它炸的远）
```

### 4.4 循环分类 — `engine/src/analysis/dataflow.rs`

```
算法：对 Tarjan SCC 结果分类
1. 检测循环中是否包含 Medium 节点 → data_persistent（数据持久化循环）
2. 检测循环中是否有 LLM 属性 → llm_involved（LLM 反馈循环）
3. 否则 → pure_code（纯代码循环）

输出：{ total, pure_code, data_persistent, llm_involved, cycles }
```

### 4.5 线程冲突检测 — `engine/src/analysis/threading.rs`

```
算法：基于名称模式的线程 × 资源冲突矩阵
1. 扫描节点名包含 "thread"/"worker"/"async_task" → 识别为线程
2. 扫描 Medium 类型节点 → 识别为共享资源
3. 对每个资源：
   - 统计访问它的所有线程
   - 访问者 > 1 → 冲突
   - 访问者 > 3 → 高风险
4. 区分读写：Writes → 并发写风险

输出：{ threads, resources, conflicts, conflict_count }
```

### 4.6 盲点检测 — `engine/src/analysis/blindspots.rs`

```
算法：聚合三个维度的边界标记
1. L4 耦合 > 0 → "封装穿透" (encapsulation_penetration)
2. 循环数 > 0 → "循环依赖" (circular_dependency)
   - >5 个循环 → severity="high"
3. 冲突数 > 0 → "并发访问" (concurrent_access)
   - >3 个冲突 → severity="high"

输出：{ boundaries[], count }
```

### 4.7 耦合报告 — `engine/src/analysis/coupling_report.rs`

```
算法：按模块统计 L1-L4 分布
对图的所有边，筛选 source 或 target 包含模块名的边
统计各 coupling_depth 的数量
fragility = (L4×4 + L3×3) / total_edges

输出：{ module, L1, L2, L3, L4, total_edges, fragility }
```

---

## 五、图查询算法（`engine/src/graph/query.rs`）

### 5.1 邻居查询 (neighbors)

```
算法：BFS 邻域扩展
从起始节点开始：
1. visited 集合防回环
2. 对每条边，检查 source==current → target 是邻居，反之亦然
3. 逐层 BFS 到指定深度

返回：(source_id, target_id, coupling_depth) 三元组列表
```

### 5.2 最短路径 (shortest_path)

```
算法：BFS 最短路径（无权图）
1. 构建邻接表（双向，因为图是无向查询语义）
2. BFS + prev 前驱映射
3. 到达目标后反向追溯

复杂度：O(V + E)
返回：节点 ID 序列
```

### 5.3 影响分析 (impact)

```
算法：分层 BFS 波及分析
从源节点开始 BFS：
1. 按距离分层收集节点
2. 到 max_depth 停止
3. 返回 [(depth0, nodes), (depth1, nodes), ...]

用途：改一个函数，看能炸多远
```

### 5.4 模糊搜索 (search_nodes)

```
算法：线性扫描 + 大小写不敏感子串匹配
遍历所有节点，匹配 name 或 id 包含 query

复杂度：O(V)
```

---

## 六、社区检测（`engine/src/community/louvain.rs`）

### Louvain 模块度优化

```
算法：Louvain 社区检测（无向、无权版本）
1. 初始化：每个节点自成一社区
2. 迭代（最多 100 次）：
   a. 随机打乱节点顺序（确定性种子）
   b. 对每个节点 i：
      - 统计邻居社区权重
      - 计算移动到每个邻居社区的模块度增益：
        ΔQ = (ki_in - ki_in_old) / m - ki × (σ_tot_new - (σ_tot_old - ki)) / (2m²)
      - 选择最大正增益的社区
      - 也检查独立成新社区是否更好
   c. 如果有节点移动 → improved = true，继续
   d. 重编号社区（压缩）
3. 转换输出：按社区大小降序排列

种子固定（42）保证确定性输出
复杂度：O(n_iter × V × avg_degree)
```

模块度增益公式解释：
- `ki_in`：节点 i 到目标社区的内部边权重
- `ki_in_old`：节点 i 到旧社区的内部边权重
- `ki`：节点 i 的总度数
- `σ_tot_c`：社区 c 的总度数
- `m`：图总边权重

---

## 七、3D 布局算法（`src-ui/src/ui/layout.worker.ts`）

### 力导向布局 on Fibonacci 球

```
算法：约束力导向布局（Web Worker 线程执行）
1. 初始位置：Fibonacci 球均匀分布
   - phi = π(1 + √5) 黄金角
   - y = 1 - 2i/(n-1) 均匀纵向
   - r = √(1-y²) 截面半径
   - θ = phi × i 旋转角
   - 球半径 = ³√n × 14（随规模自适应）

2. 迭代（15-60 次，自适应 n/800）：
   a. 斥力（所有节点对，O(n²)）：
      - 力 = min(600 / (dist²+1), cap)
      - 斥力上限 = shellRadius × 8
   b. 引力（仅边连接的节点对）：
      - 力 = min(dist × 0.018, cap)
      - 引力上限 = shellRadius
   c. 原点引力（防止飘散）：
      - 每个节点向原点回拉 0.0004
   d. 速度上限：shellRadius × 0.25
   e. 阻尼：0.72（每帧衰减）
   f. 位置更新

3. 壳约束（自适应）：
   - sp = 0.006 + (n>2000?0.008:0) + (n>4000?0.006:0)
   - 节点漂出球壳时按比例拉回

4. NaN 防护：
   - 每 5 次迭代全量扫描
   - 非全量迭代随机采样 √n 个节点
   - 发现发散 → Fibonacci 球复位

核心参数（LOCKED 不可改）：
  rep=600, att=0.018, damp=0.72, shellRadius=³√n×14
```

---

## 八、Preflight 变更前检查（`engine/src/routing/preflight.rs`）

这是最综合的分析管线，回答了"改这些文件会炸吗"：

```
算法：run_full_check(before, after, changed_files, project_root)
1. 耦合统计：计算全图 L4 耦合数
2. 循环检测：Tarjan SCC
3. 信号生成：对比 before/after 图的变更信号
4. 约束检查：信号 × 约束规则 → 违规列表（L2-L5 级）
5. 波及半径 (blast_radius)：
   - 找出 changed_files 中的所有节点
   - BFS 深度 3，统计受影响节点数（不含自身）
6. 跨社区边统计：
   - 跑 Louvain 检测
   - 统计 source 和 target 不在同一社区的边数
7. 线程冲突：检测 changed_files 中的并发访问冲突
8. API 签名变更：
   - 对比 before/after 中 Symbol 节点的 in/out degree 变化
   - 新 Symbol 节点也计入

输出：{ passed, blast_radius, cross_community_edges, new_cycles,
        new_thread_conflicts, api_signature_changes, violations[] }
```

---

## 九、算法复杂度总览

| 算法 | 复杂度 | 位置 |
|------|--------|------|
| 文件发现 | O(files) | pipeline/discovery.rs |
| 并行解析 | O(files × avg_file_size) / rayon | pipeline/parser.rs |
| 增量合并 | O(Σ\|per_file\|) | graph/merge.rs |
| 跨文件解析 | O(V + E) | graph/resolver.rs |
| 耦合深度 | O(E) | analysis/coupling.rs |
| 循环检测 (Tarjan) | O(V + E) | analysis/cycles.rs |
| 脆弱性评分 | O(V + E) | analysis/fragility.rs |
| 社区检测 (Louvain) | O(iter × V × avg_degree) | community/louvain.rs |
| BFS 查询 | O(V + E) | graph/query.rs |
| 力导向布局 | O(iter × V²) | layout.worker.ts |
| Preflight | O(V + E + V×avg_degree) | routing/preflight.rs |

---

## 十、MCP 工具接口

所有算法通过 22 个 MCP 工具对外暴露（`engine/src/mcp.rs`），JSON-RPC over stdio：

| 工具 | 算法 | 用途 |
|------|------|------|
| `hologram_analyze` | 全管线 | 分析项目 |
| `hologram_neighbors` | BFS | 查邻居 |
| `hologram_impact` | BFS 分层 | 影响分析 |
| `hologram_path` | BFS 最短路 | 找路径 |
| `hologram_search` | 子串匹配 | 搜节点 |
| `hologram_cycle` | Tarjan SCC | 查循环 |
| `hologram_fragile` | 脆弱性排名 | 找脆弱模块 |
| `hologram_coupling_report` | L1-L4 统计 | 耦合报告 |
| `hologram_community` | Louvain | 查社区 |
| `hologram_community_report` | Louvain | 社区总览 |
| `hologram_thread_conflicts` | 名称匹配 | 线程冲突 |
| `hologram_blindspots` | 边界聚合 | 盲点检测 |
| `hologram_preflight` | 全量检查 | 变更前检查 |
| `hologram_diff` | 图对比 | 版本对比 |
| `hologram_graph_summary` | 统计 | 图概览 |
| `hologram_rename` | 搜索+替换 | 重命名 |
| `hologram_history` | 边遍历 | 决策历史 |
| `hologram_delayed` | 过滤 | 时序边查询 |
| `hologram_changes` | 时间线 | 变更记录 |
| `hologram_timeline` | 时间线 | 审计追溯 |
| `hologram_run_check` | 全量 | 约束验证 |
| `hologram_run_health` | 统计 | 健康评分 |

---

**一句话总结：** 整个系统 = 源码 AST 解析 → 有向图构建 → 7 个分析器并行运行 → Louvain 社区检测 → 3D 力导向布局 → Three.js 星图渲染，所有分析通过 22 个 MCP 工具暴露。
