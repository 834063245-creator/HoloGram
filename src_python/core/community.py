"""
社区发现：Leiden / Louvain 聚类 + 局部 BFS + Label Propagation。
"""
from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple

import networkx as nx

from .graph import Graph, Community

try:
    import leidenalg as la
    HAS_LEIDEN = True
except ImportError:
    HAS_LEIDEN = False


# ═══════════════════════════════════════════════════════
# 边权重
# ═══════════════════════════════════════════════════════

def edge_weight(edge) -> float:
    """根据边类型和方向返回耦合权重。

    原则：继承/实现 > 调用/实例化 > import > 引用；写 > 读；阻塞 > 触发。
    """
    etype = edge.type.value if hasattr(edge.type, 'value') else str(edge.type)
    direction = getattr(edge, 'direction', '')
    if hasattr(direction, 'value'):
        direction = direction.value
    return _EDGE_WEIGHTS.get((etype, direction), 1.0)


_EDGE_WEIGHTS: Dict[Tuple[str, str], float] = {
    ("structural", "inherit"): 3.0,
    ("structural", "implement"): 2.5,
    ("structural", "call"): 2.0,
    ("structural", "instantiate"): 2.0,
    ("structural", "import"): 1.0,
    ("structural", "reference"): 0.5,
    ("data", "read"): 1.5,
    ("data", "write"): 2.0,
    ("data", "subscribe"): 1.0,
    ("temporal", "executes_on"): 1.5,
    ("temporal", "triggers"): 1.5,
    ("temporal", "blocks"): 2.0,
}


# ═══════════════════════════════════════════════════════
# 标签生成
# ═══════════════════════════════════════════════════════

def _generate_label(graph: Graph, node_ids: Set[str]) -> str:
    """用度最高的 2 个符号短名拼接社区标签。"""
    if not node_ids:
        return "empty"
    scored = []
    for nid in node_ids:
        node = graph.get_node(nid)
        if node is None:
            continue
        deg = len(graph.outgoing_edges(nid)) + len(graph.incoming_edges(nid))
        scored.append((node.name.split(".")[-1], deg))
    scored.sort(key=lambda x: -x[1])
    top = [name for name, _ in scored[:2]]
    return "/".join(top) if top else "unnamed"


# ═══════════════════════════════════════════════════════
# 局部聚类 — hologram_community 用
# ═══════════════════════════════════════════════════════

def detect_local(
    graph: Graph,
    node_id: str,
    depth: int = 2,
    max_siblings: int = 15,
) -> Optional[Community]:
    """BFS 局部聚类：从 node_id 出发 2 跳，按边权重找耦合最紧的邻居。

    不跑全图。毫秒级。返回一个虚拟 Community 对象。
    """
    if node_id not in graph.nodes:
        return None

    # BFS 收局部子图
    visited: Dict[str, int] = {node_id: 0}
    frontier = {node_id}
    for d in range(1, depth + 1):
        nxt: Set[str] = set()
        for nid in frontier:
            for e in graph.outgoing_edges(nid):
                if e.target not in visited:
                    visited[e.target] = d
                    nxt.add(e.target)
            for e in graph.incoming_edges(nid):
                if e.source not in visited:
                    visited[e.source] = d
                    nxt.add(e.source)
        frontier = nxt
        if not frontier:
            break

    # 对每个邻居打分（边权重 × 距离衰减）
    scores: Dict[str, float] = {}
    for nid in visited:
        if nid == node_id:
            continue
        score = 0.0
        for e in graph.outgoing_edges(node_id):
            if e.target == nid:
                score += edge_weight(e)
        for e in graph.incoming_edges(node_id):
            if e.source == nid:
                score += edge_weight(e)
        dist = visited[nid]
        if dist > 0:
            score *= (1.0 / dist)
        if score > 0:
            scores[nid] = score

    # Top-k 邻居
    sorted_nbrs = sorted(scores.items(), key=lambda x: -x[1])[:max_siblings]
    member_ids = {node_id} | {nid for nid, _ in sorted_nbrs}
    label = _generate_label(graph, member_ids)

    return Community(
        id=f"local_{node_id}",
        level=0,
        label=label,
        node_ids=member_ids,
        parent_id=None,
    )


# ═══════════════════════════════════════════════════════
# 快速全局 — hologram_community_report 用
# ═══════════════════════════════════════════════════════

def detect_fast(graph: Graph, seed: int = 42) -> List[Community]:
    """Label Propagation 全局聚类 — O(n+m) 近线性。

    5000 节点图秒级完成。按社区大小降序排列。
    """
    if graph.node_count < 3:
        return []

    # 构建加权无向 NetworkX 图
    nx_g = nx.Graph()
    for node in graph.nodes.values():
        nx_g.add_node(node.id)

    for edge in graph.edges.values():
        w = edge_weight(edge)
        if nx_g.has_edge(edge.source, edge.target):
            nx_g[edge.source][edge.target]['weight'] += w
        else:
            nx_g.add_edge(edge.source, edge.target, weight=w)

    # Louvain (deterministic with seed; label_propagation doesn't accept seed)
    from networkx.algorithms.community import louvain_communities
    raw = louvain_communities(nx_g, seed=seed)

    # 构建 Community 对象
    communities = []
    for i, node_set in enumerate(raw):
        label = _generate_label(graph, node_set)
        communities.append(Community(
            id=f"community_{i:03d}",
            level=0,
            label=label,
            node_ids=node_set,
            parent_id=None,
        ))

    communities.sort(key=lambda c: len(c.node_ids), reverse=True)
    return communities


# ═══════════════════════════════════════════════════════
# CommunityDetector — 保留原始 Leiden/Louvain 路径
# ═══════════════════════════════════════════════════════

class CommunityDetector:
    """对图运行社区发现算法，产出层级社区结构。"""

    def __init__(self, max_levels: int = 1, seed: int = 42):
        self.max_levels = max_levels
        self.seed = seed

    def detect(self, graph: Graph) -> List[Community]:
        """Leiden/Louvain 层级聚类。保留用于需要层级结构的场景。"""
        if graph.node_count < 3:
            return []

        all_communities: List[Community] = []
        comm_counter = 0

        level0_map = self._cluster_all(graph)
        for comm_idx, node_ids in sorted(level0_map.items()):
            label = _generate_label(graph, node_ids)
            comm = Community(
                id=f"community_{comm_counter:03d}",
                level=0,
                label=label,
                node_ids=node_ids,
                parent_id=None,
            )
            all_communities.append(comm)
            comm_counter += 1

            self._recurse_subcommunity(
                graph, comm, all_communities, comm_counter, level=1,
            )
            comm_counter = len(all_communities)

        if all_communities:
            graph.communities = all_communities
            for node in graph.nodes.values():
                node.community_id = None
            for comm in all_communities:
                for nid in comm.node_ids:
                    node = graph.get_node(nid)
                    if node is not None:
                        node.community_id = comm.id

        return all_communities

    def _recurse_subcommunity(
        self,
        graph: Graph,
        parent: Community,
        all_communities: List[Community],
        comm_counter: int,
        level: int,
    ) -> int:
        if level >= self.max_levels or len(parent.node_ids) < 3:
            return 0

        sub_node_ids = parent.node_ids
        sub_edges = [
            e for e in graph.edges.values()
            if e.source in sub_node_ids and e.target in sub_node_ids
        ]
        if len(sub_edges) < 2:
            return 0

        sub_list = sorted(sub_node_ids)
        idx_map = {nid: i for i, nid in enumerate(sub_list)}
        edge_pairs = [(idx_map[e.source], idx_map[e.target]) for e in sub_edges]

        sub_map = self._cluster_subgraph(sub_list, edge_pairs, level)

        added = 0
        for sub_idx, sub_node_indices in sorted(sub_map.items()):
            child_nids = {sub_list[i] for i in sub_node_indices}
            if len(child_nids) < 2:
                continue
            label = _generate_label(graph, child_nids)
            child = Community(
                id=f"community_{comm_counter + added:03d}",
                level=level,
                label=label,
                node_ids=child_nids,
                parent_id=parent.id,
            )
            all_communities.append(child)
            added += 1
            added += self._recurse_subcommunity(
                graph, child, all_communities,
                comm_counter + added, level + 1,
            )

        return added

    def _cluster_all(self, graph: Graph) -> Dict[int, Set[str]]:
        if HAS_LEIDEN:
            import igraph as ig
            ig_graph = ig.Graph()
            node_id_to_idx: Dict[str, int] = {}
            for idx, (nid, _node) in enumerate(graph.nodes.items()):
                node_id_to_idx[nid] = idx
                ig_graph.add_vertex(name=nid)

            edge_list: List[Tuple[int, int]] = []
            for edge in graph.edges.values():
                if edge.source in node_id_to_idx and edge.target in node_id_to_idx:
                    edge_list.append((node_id_to_idx[edge.source], node_id_to_idx[edge.target]))
            ig_graph.add_edges(edge_list)

            partition = la.find_partition(
                ig_graph, la.ModularityVertexPartition, seed=self.seed,
            )
            idx_to_node_id = {v: k for k, v in node_id_to_idx.items()}
            community_map: Dict[int, Set[str]] = {}
            for idx, comm_id in enumerate(partition.membership):
                nid = idx_to_node_id[idx]
                community_map.setdefault(int(comm_id), set()).add(nid)
            return community_map
        else:
            nx_graph = nx.Graph()
            for node in graph.nodes.values():
                nx_graph.add_node(node.id)
            for edge in graph.edges.values():
                nx_graph.add_edge(edge.source, edge.target, weight=1.0)
            from networkx.algorithms.community import louvain_communities
            raw = louvain_communities(nx_graph, seed=self.seed)
            return {i: set(c) for i, c in enumerate(raw)}

    def _cluster_subgraph(
        self, node_ids: List[str], edge_pairs: List[Tuple[int, int]], level: int,
    ) -> Dict[int, Set[int]]:
        n = len(node_ids)
        if n < 3:
            return {0: set(range(n))}

        if HAS_LEIDEN:
            import igraph as ig
            ig_graph = ig.Graph(n)
            for i, nid in enumerate(node_ids):
                ig_graph.vs[i]["name"] = nid
            if edge_pairs:
                ig_graph.add_edges(edge_pairs)
            partition = la.find_partition(
                ig_graph, la.ModularityVertexPartition, seed=self.seed + level,
            )
            result: Dict[int, Set[int]] = {}
            for idx, comm_id in enumerate(partition.membership):
                result.setdefault(int(comm_id), set()).add(idx)
            return result
        else:
            nx_g = nx.Graph()
            nx_g.add_nodes_from(range(n))
            nx_g.add_edges_from(edge_pairs)
            from networkx.algorithms.community import louvain_communities
            raw = louvain_communities(nx_g, seed=self.seed + level)
            return {i: set(c) for i, c in enumerate(raw)}
