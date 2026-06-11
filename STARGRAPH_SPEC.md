# 星图规模化升级 SPEC

**日期**: 2026-06-11  
**状态**: A1 完成 · A2 待开工  
**目标**: 从"小项目 5K 节点凑合看"升级到"大型项目可分析、监控场景可驾驭"

---

## 一、规模现实

| 项目规模 | 节点量级 | 例子 |
|---------|---------|------|
| 小型库 | 1K-5K | 你现在测的 amazing5 |
| 中型项目 | 5K-30K | React、Vue 源码级 |
| 大型项目 | 30K-200K | Linux kernel、Chromium、LLVM |
| 超大型/单仓库 | 200K-1M+ | Google monorepo、Meta monorepo |

你的 amazing5 已经 5339 节点。目标是"能分析 Linux kernel"（~100K 节点）时仍可交互。

---

## 二、核心原则

### 2.1 三个硬瓶颈

| 瓶颈 | 现状 | 解法 |
|------|------|------|
| **布局计算** | 前端 JS 每次打开重算，纯弹簧无斥力 | Python igraph 预计算，算一次存磁盘 |
| **渲染帧率** | `THREE.Mesh` × N → 5000 draw calls | `InstancedMesh` → 1 draw call |
| **数据传输** | JSON 5K 节点 = 4.4MB，500K = 400MB 不可行 | MessagePack + 按需加载 |

### 2.2 "全项目视图永远存在"原则

**全项目视图始终存在，缩放决定了你看到多少细节，不是"给不给看"。**

```
缩放到最远（全貌）
  → 连续 LOD：节点自动退化为光点 → 同社区光点聚合为光团（Galaxy）
  → 用户感知：星海 → 星系。不是"切换模式"，是"自然退化"

缩放到中等距离
  → 视野内：单个节点可见，标签淡入
  → 视野外：保持退化状态或不可见（视锥剔除）

缩放到最近
  → 单个节点 + 标签 + 边细节 + 粒子流
```

**用户永远可以拉远看整片星空。** 没有"折叠模式"和"展开模式"的二元切换，只有连续的细节梯度。

这跟 Google Earth 一样——你不会觉得它"不让你看全地球"，只是在轨道高度你看到的是大陆轮廓，街道合并进去了。

### 2.3 监控 vs 探索：两个入口，同一个星空

| | 监控模式（默认） | 探索模式（用户触发） |
|---|---|---|
| 入口 | 打开已分析项目 | 点击"探索"或缩小到极远 |
| 初始镜头 | 对准最近变更区域 | 全图概览 |
| 高亮 | 变更节点 + 波及半径 | 无特殊高亮 |
| 数据加载 | 社区骨架 + BlastResult | 社区骨架（同源数据） |

**两种模式共享同一份全量布局 + 社区检测结果。** 只是镜头初始位置和默认高亮不同。底层的星空是同一片。

---

## 三、分阶段实施路线

---

### 阶段 A：夯实根基（A1-A3）

**目标**: 50K 节点项目流畅分析  
**改动文件**:
- `src_python/core/graph.py` — Node 加 `position` 字段
- `src_python/pipeline/runner.py` — 加 `compute_layout()` + `detect_communities()` 步骤
- `src_python/core/community.py` — CPM 替换 Modularity，暴露 `resolution_parameter`
- `src-ui/src/ui/graph.ts` — `buildNodes()` 替换为 InstancedMesh，`render()` 优先读预计算坐标
- `src-tauri/src/main.rs` — 转发新字段（无结构变化）

**新依赖**: 无（igraph 已有，msgpack 阶段 A3 才加）

---

#### A1. InstancedMesh 替换 Mesh

**文件**: [graph.ts](src-ui/src/ui/graph.ts)

**现状** ([buildNodes:2110-2147](src-ui/src/ui/graph.ts#L2110-L2147)):
```typescript
// 每个节点 = 1-2 个 Sprite + 1 个 Mesh
for (let i = 0; i < nodes.length; i++) {
  const glow = new THREE.Sprite(...);  // draw call
  const core = new THREE.Mesh(...);    // draw call
}
// → 5000 节点 = ~10000 draw calls
```

**目标**:
```typescript
// 1 个 InstancedMesh 承载所有核心球体
const nodeMesh = new THREE.InstancedMesh(sphereGeo, coreMat, nodeCount);
for (let i = 0; i < nodes.length; i++) {
  const matrix = new THREE.Matrix4().compose(pos, quat, scale);
  nodeMesh.setMatrixAt(i, matrix);
  nodeMesh.setColorAt(i, color);
}
nodeMesh.instanceMatrix.needsUpdate = true;
// → 1 draw call

// Glow 层：1 个 InstancedMesh (point sprite) 或 延迟到 D1 用 InstancedMesh2 LOD
// 先用后处理 bloom 替代独立 Sprite 做 glow
```

**受影响的现有功能**:
| 功能 | 现在 | InstancedMesh 后 |
|------|------|-----------------|
| hover 缩放 | 直接改 `mesh.scale` | CPU 侧改 instanceMatrix 对应行 |
| 点击检测 (raycasting) | `raycaster.intersectObjects(cores)` | 返回 `instanceId`，直接映射到 nodeIndex |
| 每个节点不同颜色 | `material.color` 各自设 | `setColorAt(i, color)` + `instanceColor` |
| 节点被选中高亮 | 改 material | 改对应 instance 的 matrix/color |
| 动画（twinkle） | 改 Sprite opacity | 改 instanceColor 亮度 或 后处理 bloom 强度 |

**风险**: 低。InstancedMesh 是 Three.js 最成熟的优化 API。  
**回退**: 保留 `buildNodesLegacy()` 通过 URL param `?instanced=0` 切换。  
**成功标准**: 5000 节点场景 draw calls 从 ~10000 降到 <10，帧率 60 FPS。

**实施记录 (2026-06-11)**:
- `graph.ts` ~30 处修改: `nodeCores: Mesh[]` → `nodeCoresIM: InstancedMesh` + `_coreScale`/`_coreBaseScale` CPU 缓冲
- 全部交互路径适配: hover/click/file highlight/agent highlight/blast/path/diff/fold/constellation/focus
- 辅助方法: `_setCoreScale()` / `_writeCoreMatrix()` / `_flushCores()` 批量 GPU 同步
- Glow Sprites 未动 — 延后到阶段 D
- hover 修正: full mode `base*0.4` 一致性 + 放大系数 `1.2→0.7`
- 构建: tsc 零错误 / Rust release 编译通过
- 提交: `63625ec`

---

#### A2. 布局 + 社区检测搬到 Python

##### A2a. 布局预计算

**文件**: [runner.py](src_python/pipeline/runner.py)，`run()` 方法末尾，`report.phase = "done"` 之前

```python
def compute_layout(graph: Graph, algorithm: str = "auto") -> dict[str, tuple[float, float, float]]:
    """预计算 2D 布局，Z 轴编码社区层级。返回 {node_id: (x, y, z)}。"""
    n = graph.node_count
    if n == 0:
        return {}
    if n == 1:
        nid = next(iter(graph.nodes.keys()))
        return {nid: (0.0, 0.0, 0.0)}  # 边缘情况

    # 构建 igraph 图
    idx_to_id = list(graph.nodes.keys())
    id_to_idx = {nid: i for i, nid in enumerate(idx_to_id)}
    edges = []
    for e in graph.edges.values():
        if e.source in id_to_idx and e.target in id_to_idx:
            edges.append((id_to_idx[e.source], id_to_idx[e.target]))

    g = ig.Graph(n=n, edges=edges, directed=True) if edges else ig.Graph(n=n, directed=True)

    # 选算法
    if algorithm == "auto":
        if n <= 10000:
            layout = g.layout_fruchterman_reingold()
        else:
            layout = g.layout_drl()
    elif algorithm == "fr":
        layout = g.layout_fruchterman_reingold()
    elif algorithm == "drl":
        layout = g.layout_drl()
    elif algorithm == "kk":
        layout = g.layout_kamada_kawai()  # n<2000 only
    else:
        layout = g.layout_drl()

    # Z 轴编码社区层级（如果社区检测已完成）
    positions = {}
    for i, nid in enumerate(idx_to_id):
        x, y = layout[i][0], layout[i][1]
        node = graph.nodes.get(nid)
        z = 0.0
        if node and node.community_id:
            # 同一社区的节点 Z 相同 → 形成"层"
            # 用社区 ID hash 映射到 Z 范围，避免同层重叠
            z = (hash(node.community_id) % 100 - 50) * 2.0
        positions[nid] = (x, y, z)

    return positions
```

**为什么 2D + Z 编码而非真 3D**: 行业共识是 2D 布局质量 > 3D。Z 轴编码社区层级形成"分层星盘"的效果。

**Node 数据模型变更** ([graph.py](src_python/core/graph.py)):
```python
@dataclass
class Node:
    # ... 现有字段 ...
    position: Optional[tuple[float, float, float]] = None  # 新增
```

`to_dict()` 加:
```python
if self.position:
    d["position"] = list(self.position)
```

##### A2b. 社区检测升级：Modularity → CPM

**文件**: [community.py](src_python/core/community.py)

**变更**: 第 54-58 行

```python
# 现在
partition = la.find_partition(
    ig_graph,
    la.ModularityVertexPartition,   # 有分辨率极限
    seed=self.seed,
)

# 改为
partition = la.find_partition(
    ig_graph,
    la.CPMVertexPartition,          # 无分辨率极限，粒度可调
    resolution_parameter=0.5,       # 默认值；暴露给用户调
    seed=self.seed,
)
```

**resolution_parameter 含义**: `γ` = 社区内部密度的最低阈值。
- `γ=0.1` → 大社区，数量少（整个子系统一个星系）
- `γ=0.5` → 默认，适中
- `γ=1.0` → 小社区，数量多（每个独立 package 一个星系）
- `γ=2.0` → 极小社区，接近单个文件级

**暴露给前端**: 在设置面板加一个滑块 `community_granularity: 0.1-2.0, default 0.5`。

**为什么换**: Modularity 有分辨率极限——紧密的小模块会被大社区吞掉。代码依赖图里，一个小 utils 包可能被合并到它的主项目里，看不见。CPM 无此问题。

**风险**: 极低。只改一个参数。向后兼容——旧项目重新分析时自动用 CPM 重新聚类。

##### A2c. 前端适配

**文件**: [graph.ts](src-ui/src/ui/graph.ts)，`render()` 方法

```typescript
// 现在 (line 2008)
const rawPos = layout3D(nodes.length, pairs);

// 改为
const precomputed = extractPrecomputedPositions(nodes);
const rawPos = precomputed
  ? precomputed  // 直接用 Python 算好的
  : layout3D(nodes.length, pairs);  // fallback: 旧数据 / 小项目
```

**向后兼容**: `hologram_full.json` 中没有 `position` 字段的节点，前端用现有 `layout3D()` 计算位置。旧项目无缝打开。

**成功标准**: 同一项目布局质量肉眼优于现在（社区间距清晰），布局每次打开一致（确定性）。

---

#### A3. JSON → MessagePack（50K+ 节点场景）

**触发条件**: 节点数 > 10000 时自动使用 MessagePack，否则保持 JSON。

**改动**:
- Python: `pip install msgpack` → `msgpack.packb(graph.to_dict())`
- Rust: `Cargo.toml` 加 `rmp-serde` → 透传二进制
- 前端: `npm install @msgpack/msgpack` → `decode(buffer)`

**输出文件**: `hologram_full.hologram` (msgpack) 替代 `hologram_full.json`。小项目两种格式都生成。

**成功标准**: 50K 节点项目加载时间 < 2 秒（含解析）。

---

### 阶段 B：监控驱动架构

**目标**: 默认视图 = 变更聚焦，波及半径可视化  
**改动文件**:
- `src_python/core/blast.py` — **新建**，波及半径计算
- `src_python/pipeline/runner.py` — 加 `run_incremental_with_blast()`
- `src-ui/src/ui/graph.ts` — 加 `renderBlastView()`，改 `render()` 入口逻辑
- `src-ui/src/ui/chat.ts` — 监控模式下 chat 直接显示 diff 摘要

**新依赖**: 无

---

#### B1. 波及半径计算

**新建文件**: `src_python/core/blast.py`

```python
from dataclasses import dataclass, field
from typing import Set, Dict, List
from .graph import Graph

@dataclass
class BlastResult:
    """从变更节点出发的 BFS 波及层。"""
    changed_node_ids: Set[str] = field(default_factory=set)
    layers: Dict[str, Set[str]] = field(default_factory=dict)
    # layers["L1"] = 直接邻居, layers["L2"] = 邻居的邻居, ...
    affected_community_ids: Set[str] = field(default_factory=set)
    total_affected: int = 0

    def to_dict(self) -> dict:
        return {
            "changed_node_ids": list(self.changed_node_ids),
            "layers": {k: list(v) for k, v in self.layers.items()},
            "affected_community_ids": list(self.affected_community_ids),
            "total_affected": self.total_affected,
        }


def blast_radius(
    graph: Graph,
    changed_node_ids: Set[str],
    max_depth: int = 5,
    cross_community: bool = True,
) -> BlastResult:
    """BFS 从变更节点出发，按跳数分层。"""
    result = BlastResult(changed_node_ids=changed_node_ids)
    visited = set(changed_node_ids)
    frontier = set(changed_node_ids)

    for depth in range(1, max_depth + 1):
        next_frontier: Set[str] = set()
        for nid in frontier:
            node = graph.nodes.get(nid)
            if not node:
                continue
            for edge in graph.outgoing_edges(nid) + graph.incoming_edges(nid):
                neighbor = edge.target if edge.source == nid else edge.source
                if neighbor in visited:
                    continue
                # 跨社区阻断
                neighbor_node = graph.nodes.get(neighbor)
                if not cross_community and neighbor_node and node.community_id != neighbor_node.community_id:
                    continue
                visited.add(neighbor)
                next_frontier.add(neighbor)

        if not next_frontier:
            break
        result.layers[f"L{depth}"] = next_frontier
        frontier = next_frontier

    result.total_affected = len(visited)
    result.affected_community_ids = {
        graph.nodes[nid].community_id
        for nid in visited
        if nid in graph.nodes and graph.nodes[nid].community_id
    }
    return result
```

**边缘情况处理**:
- 无变更节点 → 返回空 BlastResult
- 变更节点不存在 → 跳过，只处理存在的
- 孤立节点（无边）→ 只标记自身，无波及层
- 环形依赖 → `visited` set 天然防死循环
- `max_depth=0` → 只返回变更节点本身

---

#### B2. 默认视图：变更聚焦

**文件**: [graph.ts](src-ui/src/ui/graph.ts)

**新增方法**: `renderBlastView(blast: BlastResult, skeleton: CommunitySkeleton)`

```
渲染顺序（从底到顶）：
  1. 背景星场 (已有，不动)
  2. 社区骨架 — 受影响社区的中心点 + 标签（淡化 opacity: 0.15）
  3. 未受影响的节点 — 极小暗点（opacity: 0.05）或按距离剔除
  4. 波及层 L4 → L1 — 从暗黄到亮橙，透明度递增
  5. 变更节点 — 白色/金色，脉冲动画
  6. 受影响边 — 按深度着色
```

**镜头初始位置**: 变更节点质心 + 后退适当距离（能装下所有 L1-L4 波及节点）。

**全项目视图可用性**: 用户随时可以滚轮缩小 → 波及高亮渐隐 → LOD 连续退化 → 看到全貌（星系视图）。再放大 → 自动回到变更区域的高亮。

---

#### B3. 增量分析链路

**已有基础**:
- `PipelineRunner.run_incremental()` ([runner.py:129](src_python/pipeline/runner.py#L129)) — 只分析变更文件
- `IncrementalCache` ([cache.py](src_python/pipeline/cache.py)) — SHA256 哈希缓存
- `GraphDiffer.diff()` ([diff.py](src_python/core/diff.py)) — 比较两张快照

**需要补齐的**:
- `run_incremental()` 末尾加 `blast_radius()` 调用
- 增量结果序列化为独立的小文件 `diff_{timestamp}.msgpack`
- 前端加载 diff 文件 + 从全量文件中抽取社区骨架

**数据流**:
```
git commit → Tauri 检测变更文件列表
  → Python: run_incremental(changed_files)
    → GraphDiffer.diff(old, new)
    → blast_radius(new, changed_node_ids)
    → 输出 diff_{ts}.msgpack
  → 前端: 加载 diff → 渲染变更聚焦视图
```

---

### 阶段 C：视觉净化

**目标**: 边不再毛线团，LOD 连续过渡  
**改动文件**:
- `src-ui/src/ui/graph.ts` — 加 LOD 管理器、边策略

**新依赖**: 无（InstancedMesh2 到阶段 D 才引入）

---

#### C1. 连续 LOD（替代三个固定档位）

你现在有三个固定档位 (`minimal`/`standard`/`full`)。改成**相机距离驱动的连续 lerp**。

```typescript
interface LODState {
  // 0 = 最近（显微镜）, 1 = 最远（宇宙）
  t: number;  // clamp((cameraDist - nearDist) / (farDist - nearDist), 0, 1)
}

const LOD = {
  // 每个视觉参数的 lerp 范围
  nodeScale:       { near: 1.0,  far: 0.08 },   // t=0→1 时缩小
  labelOpacity:    { near: 1.0,  far: 0.0  },   // 远处标签消失
  glowIntensity:   { near: 1.0,  far: 0.15 },
  edgeAlpha:       { near: 0.6,  far: 0.02 },
  edgeWidth:       { near: 1.0,  far: 0.3  },
  particleCount:   { near: 60,   far: 3    },
  bloomStrength:   { near: 1.5,  far: 0.2  },
  // 聚合阈值
  clusterMergeRadius: { near: 0, far: 80 },  // 同社区节点在这个半径内→合并为光团
};
```

**关键**: 这不是模式切换，是 `requestAnimationFrame` 每帧 lerp。过渡时间 ~300ms。

**3 个旧档位处理**: `minimal`/`standard`/`full` 变成 LOD 参数的预设起点，然后相机距离在此基础上连续调整。

#### C2. 边密度自适应

```typescript
function edgeVisibility(edge: EdgeData, lod: number, totalEdges: number): EdgeVisibility {
  const isCrossCommunity = edge.communitySource !== edge.communityTarget;

  if (lod > 0.8) {
    // 极远：只显示社区间主干（合并后的粗边）
    return isCrossCommunity ? 'thick-trunk' : 'hidden';
  }
  if (lod > 0.5) {
    // 远：社区间边 + L3/L4 高耦合内部边
    return isCrossCommunity || edge.couplingDepth >= 3 ? 'visible' : 'hidden';
  }
  if (totalEdges > 2000 && lod > 0.3) {
    // 中等距离 + 边太多：社区内部边变淡
    return isCrossCommunity ? 'visible' : 'faint';
  }
  return 'visible';
}
```

#### C3. 社区间主干边合并

同一对社区之间，同方向同类型的边合并为一条"粗边"：
- 粗边宽度 = `log(合并边数) * 2`
- 粗边亮度 = 合并边数在全局的百分位
- hover 粗边 → tooltip 显示"23 条依赖"并展开列表

**不需要复杂的边捆绑算法**（FEB/FDB），因为社区间边的数量通常已经降到可管理范围。

---

### 阶段 D：渲染极致优化

**目标**: 100K+ 节点流畅交互  
**改动文件**:
- `src-ui/src/ui/graph.ts` — InstancedMesh2 替换 + Worker
- `src-ui/src/workers/layout.worker.ts` — **新建**

**新依赖**: `npm install instanced-mesh`（agargaro/instanced-mesh）

---

#### D1. InstancedMesh2 + BVH

```typescript
import { InstancedMesh2 } from 'instanced-mesh';

const nodes = new InstancedMesh2(sphereGeo, mat, maxCapacity);
nodes.setLOD(0, sphereGeo);  // 近: 球体 (16 segment)
nodes.setLOD(1, boxGeo);     // 中: 低面数替代
nodes.setLOD(2, pointGeo);   // 远: 点精灵
nodes.culling = 'frustum';   // 自动每实例视锥剔除
nodes.bvh = true;            // BVH 加速 raycasting
```

**LOD 切换距离**（可调）:
```
< 500 units   → LOD 0: 球体
500-2000      → LOD 1: 方块/低面数
> 2000        → LOD 2: 点
> 5000        → 退化为 THREE.Points (全点云)
```

#### D2. 布局计算搬进 Web Worker

```
主线程:  UI 响应 + 渲染
Worker:  layout3D() fallback（只有没预计算坐标时才跑）
         → 返回 Float32Array (transfer list, 零拷贝)
```

---

## 四、规模能力矩阵

| 阶段 | 可分析项目 | 全量布局 | 默认加载 | 渲染 | 增量更新 |
|------|-----------|---------|---------|------|---------|
| 现在 | ~5K | 前端每次 | 全量 5K | Mesh×N | ❌ |
| A 完成后 | ~50K | Python igraph | 全量 50K | InstancedMesh | ❌ |
| B 完成后 | ~500K | 多级粗化+DrL | 波及 5K+骨架 | 变更聚焦+Galaxy | 增量分析 |
| C+D 完成后 | 1M+ | GPU/多级 | 波及 5K+骨架 | IM2+BVH+点云 | 增量全链路 |

**"可分析项目"** = 能跑完整分析流水线的项目规模。  
**"默认加载"** = 前端打开时实际读取的数据量。  
**全量布局始终存在于磁盘**，前端按需加载子集。全项目视图始终可缩放到达。

---

## 五、数据格式规格

### 5.1 全量图文件 (`hologram_full.msgpack`)

```python
{
    "meta": {
        "source_root": "/path/to/project",
        "node_count": 5339,
        "edge_count": 7835,
        "community_count": 127,
        "layout_algorithm": "drl",
        "community_algorithm": "leiden_cpm",
        "resolution_parameter": 0.5,
        "created_at": "2026-06-11T12:00:00Z",
    },
    "nodes": {
        "node_abc123": {
            "id": "node_abc123",
            "name": "MyClass.method",
            "type": "SYMBOL",
            "kind": "method",
            "location": "src\\utils.py:42",
            "language": "python",
            "community_id": "community_003",
            "position": [12.5, -8.3, 4.2],   # 新增：预计算坐标
            "properties": {...}
        },
        ...
    },
    "edges": {
        "edge_def456": {
            "id": "edge_def456",
            "source": "node_abc123",
            "target": "node_xyz789",
            "type": "STRUCTURAL",
            "direction": "call",
            "properties": {"coupling_depth": 3}
        },
        ...
    },
    "communities": [
        {
            "id": "community_003",
            "level": 0,
            "label": "utils/helpers",
            "node_ids": ["node_abc123", ...],
            "parent_id": None,
        },
        ...
    ],
    "galaxy_summary": {                    # 新增：前端快速加载
        "galaxies": [
            {
                "community_id": "community_003",
                "centroid": [12.1, -8.0, 4.2],  # 成员坐标均值
                "radius": 45.2,                  # 成员最远距离
                "node_count": 42,
                "dominant_kinds": ["function", "class"],
                "label": "utils/helpers",
            },
            ...
        ],
        "trunk_edges": [                    # 社区间主干边（去重合并）
            {"source_galaxy": "community_003", "target_galaxy": "community_012",
             "weight": 17, "types": ["call", "import"]},
            ...
        ],
    },
}
```

### 5.2 增量 diff 文件 (`diff_{timestamp}.msgpack`)

```python
{
    "timestamp": "2026-06-11T14:30:00Z",
    "graph_diff": {
        "added_nodes": [...],
        "removed_nodes": [...],
        "modified_nodes": [...],
        "added_edges": [...],
        "removed_edges": [...],
    },
    "blast": {
        "changed_node_ids": ["node_abc123"],
        "layers": {
            "L1": ["node_def456", "node_ghi789"],
            "L2": ["node_jkl012"],
            ...
        },
        "affected_community_ids": ["community_003", "community_012"],
        "total_affected": 47,
    },
}
```

### 5.3 前端 TypeScript 接口

```typescript
interface GalaxySummary {
  communityId: string;
  centroid: [number, number, number];
  radius: number;
  nodeCount: number;
  dominantKinds: string[];
  label: string;
}

interface TrunkEdge {
  sourceGalaxy: string;
  targetGalaxy: string;
  weight: number;
  types: string[];
}

interface BlastResult {
  changedNodeIds: string[];
  layers: Record<string, string[]>;  // "L1" → node IDs
  affectedCommunityIds: string[];
  totalAffected: number;
}

interface FullGraphData {
  nodes: Map<string, GraphNodeWithPosition>;
  edges: Map<string, GraphEdge>;
  communities: CommunityData[];
  galaxySummary: { galaxies: GalaxySummary[]; trunkEdges: TrunkEdge[] };
}

interface MonitorData {
  blast: BlastResult;
  skeleton: GalaxySummary[];  // 受影响社区的摘要
}
```

---

## 六、向后兼容方案

| 场景 | 处理 |
|------|------|
| 打开旧项目（无 `position` 字段） | 前端 `layout3D()` fallback，提示"建议重新分析以获取更好布局" |
| 打开旧项目（无 `galaxy_summary`） | 前端从 communities + positions 实时计算星系摘要 |
| 打开旧项目（JSON 格式） | 自动检测文件扩展名，`.json` 用 `JSON.parse`，`.msgpack` 用 msgpack |
| 分析中断（部分节点有 position） | 已有 position 的节点用预计算坐标，没收到的回退 |
| `resolution_parameter` 变更 | 需要重新运行社区检测（用户点"重新分析"时自动） |
| 大项目 msgpack 加载失败 | 前端 catch 错误 → 回退尝试 JSON（如果存在）→ 提示用户 |

---

## 七、测试与验证

### 7.1 每阶段成功指标

| 阶段 | 指标 | 目标值 | 怎么测 |
|------|------|--------|--------|
| A1 | Draw calls | < 10 (原来是 ~10000) | Chrome DevTools → 渲染 → draw calls |
| A1 | FPS (5K 节点) | 60 FPS | `requestAnimationFrame` 计时 |
| A2 | 布局质量 | 社区间距肉眼可见 | 对比旧/新布局截图 |
| A2 | 布局稳定性 | 同一项目每次结果一致 | 跑 5 次，对比坐标 (MSE < 0.001) |
| A2 | 社区粒度 | 用户调 slider 星系大小变化 | 手动测试极端值 0.1 / 2.0 |
| A3 | 50K 加载时间 | < 2 秒 | `performance.now()` 计时 |
| B1 | 波及计算时间 | < 100ms (10K 波及节点) | Python `time.perf_counter()` |
| B2 | 默认视图加载 | < 500ms | `DOMContentLoaded` → 视图就绪 |
| C1 | LOD 过渡 | 无可见跳变 | 慢速缩放观察 |
| D1 | 100K 节点交互 | 30+ FPS 旋转/缩放 | Chrome DevTools FPS meter |

### 7.2 测试数据集

| 项目 | 规模 | 用途 |
|------|------|------|
| amazing5 (已有) | 5K 节点 | 日常开发自测 |
| Linux kernel | ~100K 节点 | 阶段 A 完成后的压力测试 |
| CPython | ~30K 节点 | 中等规模验证 |

### 7.3 边缘情况清单

- [ ] 空项目（无源文件）→ 空星空 + "无代码可分析"提示
- [ ] 单文件项目（<3 节点）→ 社区检测跳过，节点显示在原点附近
- [ ] 全孤立节点（无边）→ 按 Fibonacci 球面均匀散布
- [ ] 全部节点同一个社区 → 只有一个星系，内部展开显示
- [ ] 大量重复边（同一对节点多条边）→ igraph 自动处理多重边
- [ ] 超大节点名称（>100 字符）→ 标签截断
- [ ] 坐标极大值（布局算法溢出）→ clamp 到合理范围
- [ ] 环状依赖 → BFS visited set 防死循环
- [ ] 项目路径含非 ASCII 字符 → 完整 Unicode 支持
- [ ] 分析过程中用户关闭窗口 → 进程清理（Tauri 侧处理）
- [ ] 内存不足 → 降至低配模式（全点云，无 bloom）

---

## 八、文件级改动总览

```
阶段 A:
  src_python/core/graph.py          [+3 lines]  Node.position 字段 + to_dict 序列化
  src_python/core/community.py      [~5 lines]  CPM 替换 Modularity
  src_python/pipeline/runner.py     [+40 lines] compute_layout() + 集成到 run()
  src-ui/src/ui/graph.ts            [~80 lines] InstancedMesh 替换 buildNodes() + 预计算坐标读取
  src-tauri/Cargo.toml              [+1 line]   rmp-serde (A3)
  src-ui/package.json               [+1 line]   @msgpack/msgpack (A3)

阶段 B:
  src_python/core/blast.py          [新文件]    blast_radius() + BlastResult
  src_python/pipeline/runner.py     [+20 lines] run_incremental 集成 blast_radius
  src-ui/src/ui/graph.ts            [+100 lines] renderBlastView() + 数据加载分支
  src-ui/src/ui/chat.ts             [+30 lines]  diff 摘要显示

阶段 C:
  src-ui/src/ui/graph.ts            [+80 lines] LOD 连续过渡 + 边密度策略

阶段 D:
  src-ui/src/ui/graph.ts            [+60 lines] InstancedMesh2 替换 + LOD 几何体
  src-ui/src/workers/layout.worker.ts [新文件]   fallback 布局计算
```

---

## 九、配置面板暴露参数

| 参数 | 默认值 | 范围 | 说明 |
|------|--------|------|------|
| `layout_algorithm` | `auto` | auto/fr/drl | 布局算法选择 |
| `community_granularity` | 0.5 | 0.1-2.0 | CPM resolution_parameter（星系粒度） |
| `blast_radius_max` | 5 | 1-10 | BFS 波及深度上限 |
| `cross_community_blast` | true | bool | 波及是否跨社区传播 |
| `lod_transition_speed` | 300 | 100-1000 | LOD 过渡动画时长 (ms) |
| `max_visible_edges` | 2000 | 100-10000 | 超过此数量触发边合并/隐藏 |

---

## 十、与工业工具的定位

| 方面 | Graphistry | Cosmograph | 本项目 |
|------|-----------|------------|--------|
| 部署 | 服务端 GPU 集群 | 纯浏览器 | Tauri 桌面 |
| 最大规模 | 10 亿元素 | 100 万+ 节点 | 可分析 500K，交互 100K |
| 布局 | GPU OpenCL | GPU WebGL | Python CPU/GPU 预计算 |
| 渲染 | WebGL 点云 | WebGL Shader | Three.js IM + 点云 |
| 核心交互 | 过滤 → 看 | 拖拽实时力 | 预计算 + 层级缩放 |
| 差异化优势 | 规模最大 | 零安装 | **离线可用 + 代码分析管线 + 变更监控** |

---

## 十一、推荐起步（修正后）

```
第 1-2 天: A1 InstancedMesh 替换 → draw calls 从 10000 降到 <10
第 3-4 天: A2 布局 + 社区检测搬 Python → 布局质量飞跃 + 社区粒度可调
第 5-6 天: 用 Linux kernel 实测 10 万节点 → 诊断瓶颈
第 7-8 天: B1 波及半径 + B2 变更聚焦视图 → 监控模式可用
第 9 天:   评估：如果全量加载成了瓶颈就做 A3 (MsgPack)，否则继续 C
```

**每步做完都跑 amazing5 回归，确保不炸。Linux kernel 在第 5 天作为压力测试。**

---

## 十二、参考来源

- **Cosmograph** — 浏览器 GPU 力模拟 + 网格分桶，百万节点实时交互
- **Graphistry** — 服务端 GPU OpenCL ForceAtlas2 → 客户端 WebGL 点云，800 万元素
- **PacificVis 2025** — WebGPU + Hilbert 四叉树，95K 节点 5.48 秒，69.5× 加速
- **CoRe-GD (ICLR 2024)** — GNN 增强多级粗化/细化布局，sub-quadratic
- **MERIT (2024)** — 谱距离约束多级粗化，126K 节点/22M 边，25× 加速
- **FEB (IEEE VIS 2025)** — 谱稀疏化边捆绑，61% 时间减少
- **FDB (IEEE TVCG 2025)** — Filter-Draw-Bundle 边捆绑
- **NNP-NET (IEEE TVCG 2025)** — 神经网络逼近 t-SNE，50M 节点线性扩展
- **AMD ROCm GPU Layout (2026.02)** — ~200 行 PyTorch，80× GPU 加速
- **InstancedMesh2** — BVH + LOD + 每实例视锥剔除
- **leidenalg CPMVertexPartition** — 无分辨率极限，密度阈值粒度控制
