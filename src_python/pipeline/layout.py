"""
布局预计算引擎 — 用 igraph 专业算法生成 3D 坐标，前端不再跑力导向。

设计：
  - ≤10K 节点: igraph FR (Fruchterman-Reingold) — 力导向，质量好
  - >10K 节点: igraph DrL (Distributed Recursive Layout) — 可扩展
  - Z 轴 = community_id 映射 — 同社区节点在同一"星盘层"
  - 确定性: seed=42 作为 igraph RNG, 同一项目每次结果一致

输出: 写入 Graph 节点的 position 字段 [x, y, z]，JSON/MsgPack 序列化后前端直接读取。
"""

from __future__ import annotations

import hashlib
import logging
import math
from typing import Dict, List, Optional, Tuple

from ..core.graph import Graph

logger = logging.getLogger(__name__)


# ============================================================
# 布局计算
# ============================================================

def compute_layout(graph: Graph, seed: int = 42) -> int:
    """
    计算图中所有节点的 3D 坐标并写入 node.position。

    Returns:
        成功设置坐标的节点数。
    """
    if graph.node_count == 0:
        return 0

    try:
        import igraph as ig
    except ImportError:
        logger.warning("igraph not installed — layout precomputation skipped")
        return 0

    # 构建 igraph 图
    node_ids = list(graph.nodes.keys())
    node_index = {nid: i for i, nid in enumerate(node_ids)}
    n = len(node_ids)

    ig_edges = []
    for edge in graph.edges.values():
        src_idx = node_index.get(edge.source)
        tgt_idx = node_index.get(edge.target)
        if src_idx is not None and tgt_idx is not None:
            ig_edges.append((src_idx, tgt_idx))

    ig_graph = ig.Graph(n=n, edges=ig_edges, directed=True)

    # 选择算法: FR for small graphs, DrL for large
    try:
        if n <= 10000:
            layout = ig_graph.layout_fruchterman_reingold(
                dim=2,
                seed=seed,
                maxiter=500,
                area=float(n * n),
            )
        else:
            # DrL is more scalable but lower quality
            layout = ig_graph.layout_drl(
                dim=2,
                seed=seed,
                options={
                    "attraction": 0.1,
                    "damping_mult": 0.7,
                    "iterations": 500,
                },
            )
    except Exception as e:
        logger.warning("igraph layout failed: %s — falling back to no layout", e)
        return 0

    # 归一化 2D 坐标到 [-1, 1]
    coords = layout.coords
    if not coords:
        return 0

    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    x_range = x_max - x_min if x_max != x_min else 1.0
    y_range = y_max - y_min if y_max != y_min else 1.0

    # 球壳半径: sqrt(n) * 5 (与 graph.ts 匹配)
    radius = math.sqrt(n) * 5.0

    # 计算 Z 轴 (community_id 映射到层级)
    z_levels = _compute_z_levels(graph, node_ids)

    # 设置节点坐标
    count = 0
    for i, nid in enumerate(node_ids):
        node = graph.nodes.get(nid)
        if node is None:
            continue

        # 归一化到 [-1, 1]
        nx = (coords[i][0] - x_min) / x_range * 2.0 - 1.0
        ny = (coords[i][1] - y_min) / y_range * 2.0 - 1.0

        # 映射到球壳
        x = nx * radius
        y = ny * radius
        z = z_levels.get(nid, 0.0)

        node.position = [x, y, z]
        count += 1

    logger.info("Layout computed: %d nodes, radius=%.1f", count, radius)
    return count


def _compute_z_levels(
    graph: Graph,
    node_ids: List[str],
    z_spacing: float = 2.0,
) -> Dict[str, float]:
    """
    将 community_id 映射到 Z 轴层级。

    同社区节点在同一"星盘层"，层间间距由 z_spacing 控制。
    使用 community_id 的哈希值确保确定性（不依赖字典序）。
    """
    # 收集所有唯一的 community_id
    community_ids = set()
    for nid in node_ids:
        node = graph.nodes.get(nid)
        if node and node.community_id is not None:
            community_ids.add(node.community_id)

    if not community_ids:
        # 无社区信息时 Z=0
        return {nid: 0.0 for nid in node_ids}

    # 为每个 community_id 分配一个 Z 层级
    # 使用哈希确保确定性（不同运行结果一致）
    sorted_communities = sorted(community_ids)
    n_levels = len(sorted_communities)

    # Z 轴范围: [-total_height/2, +total_height/2]
    total_height = (n_levels - 1) * z_spacing if n_levels > 1 else 0.0
    community_to_z: Dict[str, float] = {}
    for i, cid in enumerate(sorted_communities):
        community_to_z[cid] = -total_height / 2.0 + i * z_spacing

    # 为每个节点分配 Z
    z_levels: Dict[str, float] = {}
    for nid in node_ids:
        node = graph.nodes.get(nid)
        if node and node.community_id is not None:
            z_levels[nid] = community_to_z.get(node.community_id, 0.0)
        else:
            z_levels[nid] = 0.0

    return z_levels


# ============================================================
# 便捷入口
# ============================================================

def has_precomputed_layout(graph: Graph) -> bool:
    """检查图是否已有预计算坐标。"""
    if graph.node_count == 0:
        return True
    # 检查至少一个节点有 position
    for node in graph.nodes.values():
        if node.position is not None:
            return True
    return False
