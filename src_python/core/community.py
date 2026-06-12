"""
社区发现：基于 Leiden 算法的节点聚类，支持多层级。
"""

from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple

import networkx as nx

from .graph import Graph, Node, Community


# 尝试导入 leidenalg，不可用时退化为 NetworkX 内置 Louvain
try:
    import leidenalg as la
    HAS_LEIDEN = True
except ImportError:
    HAS_LEIDEN = False


class CommunityDetector:
    """对图运行社区发现算法，产出层级社区结构。"""

    def __init__(self, max_levels: int = 3, seed: int = 42):
        self.max_levels = max_levels
        self.seed = seed

    def detect(self, graph: Graph) -> List[Community]:
        """
        在图 G 上运行层级社区发现，返回所有层级的社区列表。
        如果图太小（< 3 节点），返回空。

        层级结构：
          Level 0: 全图聚类 → 粗粒度模块
          Level 1: 每个 Level-0 社区内部再聚类 → 子模块
          Level 2: 每个 Level-1 社区内部再聚类 → 更细粒度
          ...直到 max_levels 或节点数 < 3
        """
        if graph.node_count < 3:
            return []

        all_communities: List[Community] = []
        comm_counter = 0

        # Level 0: 全图聚类
        level0_map = self._cluster_all(graph)
        for comm_idx, node_ids in sorted(level0_map.items()):
            label = self._generate_label(graph, node_ids)
            comm = Community(
                id=f"community_{comm_counter:03d}",
                level=0,
                label=label,
                node_ids=node_ids,
                parent_id=None,
            )
            all_communities.append(comm)
            comm_counter += 1

            # 递归子聚类
            self._recurse_subcommunity(
                graph, comm, all_communities, comm_counter, level=1,
            )
            # 更新计数器
            comm_counter = len(all_communities)

        if all_communities:
            graph.communities = all_communities
            # Backfill: 每个节点归属最细粒度的社区
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
        """对 parent 社区内部的子图递归聚类。返回新增社区数。"""
        if level >= self.max_levels or len(parent.node_ids) < 3:
            return 0

        # 提取子图的节点集合
        sub_node_ids = parent.node_ids
        sub_edges = [
            e for e in graph.edges.values()
            if e.source in sub_node_ids and e.target in sub_node_ids
        ]

        if len(sub_edges) < 2:
            # 边太少，聚类无意义
            return 0

        # 构建子图索引
        sub_list = sorted(sub_node_ids)
        idx_map = {nid: i for i, nid in enumerate(sub_list)}
        edge_pairs = [(idx_map[e.source], idx_map[e.target]) for e in sub_edges]

        # 聚类
        sub_map = self._cluster_subgraph(sub_list, edge_pairs, level)

        added = 0
        for sub_idx, sub_node_indices in sorted(sub_map.items()):
            child_nids = {sub_list[i] for i in sub_node_indices}
            if len(child_nids) < 2:
                continue
            label = self._generate_label(graph, child_nids)
            child = Community(
                id=f"community_{comm_counter + added:03d}",
                level=level,
                label=label,
                node_ids=child_nids,
                parent_id=parent.id,
            )
            all_communities.append(child)
            added += 1

            # 继续递归
            added += self._recurse_subcommunity(
                graph, child, all_communities,
                comm_counter + added, level + 1,
            )

        return added

    def _cluster_all(self, graph: Graph) -> Dict[int, Set[str]]:
        """对全图跑一次聚类，返回 {comm_idx: set(node_id)}。"""
        if HAS_LEIDEN:
            import igraph as ig
            ig_graph = ig.Graph()
            node_id_to_idx: Dict[str, int] = {}
            for idx, (nid, node) in enumerate(graph.nodes.items()):
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
        """对子图跑聚类，返回 {comm_idx: set(node_index)}。"""
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

    def _generate_label(self, graph: Graph, node_ids: Set[str]) -> str:
        """自动生成社区标签：用度最高的符号名拼接。"""
        if not node_ids:
            return "empty"

        degree_scores: List[Tuple[str, int]] = []
        for nid in node_ids:
            node = graph.get_node(nid)
            if node is None:
                continue
            deg = len(graph.outgoing_edges(nid)) + len(graph.incoming_edges(nid))
            degree_scores.append((node.name.split(".")[-1], deg))

        degree_scores.sort(key=lambda x: -x[1])

        top_names = [name for name, _ in degree_scores[:3]]
        if len(top_names) == 1:
            return top_names[0]
        return "/".join(top_names)
