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
        在图 G 上运行社区发现，返回社区列表。
        如果图太小（< 3 节点），返回空。
        """
        if graph.node_count < 3:
            return []

        # 运行 Leiden 或 Louvain
        if HAS_LEIDEN:
            # leidenalg 0.10+ 需要 igraph.Graph
            import igraph as ig
            ig_graph = ig.Graph()
            node_id_to_idx: Dict[str, int] = {}
            for idx, (nid, node) in enumerate(graph.nodes.items()):
                node_id_to_idx[nid] = idx
                ig_graph.add_vertex(name=node.name)

            edge_list: List[Tuple[int, int]] = []
            for edge in graph.edges.values():
                if edge.source in node_id_to_idx and edge.target in node_id_to_idx:
                    edge_list.append((node_id_to_idx[edge.source], node_id_to_idx[edge.target]))

            ig_graph.add_edges(edge_list)

            partition = la.find_partition(
                ig_graph,
                la.ModularityVertexPartition,
                seed=self.seed,
            )
            community_map: Dict[int, Set[str]] = {}
            idx_to_node_id = {v: k for k, v in node_id_to_idx.items()}
            for idx, comm_id in enumerate(partition.membership):
                nid = idx_to_node_id[idx]
                community_map.setdefault(int(comm_id), set()).add(nid)
        else:
            # 退化为 NetworkX Louvain
            nx_graph = nx.Graph()
            for node in graph.nodes.values():
                nx_graph.add_node(node.id, name=node.name)
            for edge in graph.edges.values():
                nx_graph.add_edge(edge.source, edge.target, weight=1.0)
            from networkx.algorithms.community import louvain_communities
            raw_communities = louvain_communities(nx_graph, seed=self.seed)
            community_map = {}
            for i, comm_set in enumerate(raw_communities):
                community_map[i] = set(comm_set)

        # 构建 Community 对象
        communities: List[Community] = []
        for comm_idx, node_ids in community_map.items():
            label = self._generate_label(graph, node_ids)
            communities.append(Community(
                id=f"community_{comm_idx:03d}",
                level=0,
                label=label,
                node_ids=node_ids,
            ))

        if communities:
            graph.communities = communities
            # Backfill community_id onto each Node so serialization is self-contained
            for comm in communities:
                for nid in comm.node_ids:
                    node = graph.get_node(nid)
                    if node is not None:
                        node.community_id = comm.id
        return communities

    def _generate_label(self, graph: Graph, node_ids: Set[str]) -> str:
        """自动生成社区标签：用介数中心性最高的符号名拼接。"""
        if not node_ids:
            return "empty"

        # 取度最高的前几个节点名
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

    def _build_hierarchy(self, graph: Graph, raw_graph, level: int) -> Dict[int, Set[str]]:
        """递归构建层级社区结构。接受 NetworkX 或 igraph 图。"""
        node_count = raw_graph.number_of_nodes() if hasattr(raw_graph, 'number_of_nodes') else raw_graph.vcount()
        if level >= self.max_levels or node_count < 3:
            return {}

        if HAS_LEIDEN:
            # 确保使用 igraph
            if hasattr(raw_graph, 'vcount'):
                ig_graph = raw_graph
            else:
                import igraph as ig
                ig_graph = ig.Graph()
                node_list = list(raw_graph.nodes)
                idx_lookup = {nid: i for i, nid in enumerate(node_list)}
                for nid in node_list:
                    ig_graph.add_vertex(name=str(nid))
                edge_list = [(idx_lookup[u], idx_lookup[v]) for u, v in raw_graph.edges]
                if edge_list:
                    ig_graph.add_edges(edge_list)

            partition = la.find_partition(
                ig_graph,
                la.ModularityVertexPartition,
                seed=self.seed + level,
            )
            result: Dict[int, Set[str]] = {}
            for idx, comm_id in enumerate(partition.membership):
                nid = ig_graph.vs[idx]["name"]
                result.setdefault(int(comm_id), set()).add(nid)
            return result
        else:
            # 退化为 NetworkX Louvain
            if not hasattr(raw_graph, 'nodes'):
                nx_g = nx.Graph()
                for v in raw_graph.vs:
                    nx_g.add_node(v["name"])
                for e in raw_graph.es:
                    nx_g.add_edge(raw_graph.vs[e.source]["name"], raw_graph.vs[e.target]["name"])
                raw_graph = nx_g
            from networkx.algorithms.community import louvain_communities
            raw = louvain_communities(raw_graph, seed=self.seed + level)
            return {i: set(c) for i, c in enumerate(raw)}
