"""
图合并器：多文件、多阶段分析的图片段合并为一张全图。
"""

from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple

from .graph import Graph, Node, Edge, NodeType, EdgeType, type_val


class GraphMerger:
    """将多个局部图合并为全图，处理去重和 ID 统一。"""

    def __init__(self):
        self._node_key_index: Dict[str, str] = {}   # key → node_id
        self._edge_key_index: Dict[str, str] = {}   # key → edge_id

    @staticmethod
    def node_key(node: Node) -> str:
        """节点的去重键：location + name + kind。"""
        return f"{node.location}::{node.name}::{node.kind}"

    @staticmethod
    def edge_key(edge: Edge) -> str:
        """边的去重键：source + target + type + direction。"""
        return f"{edge.source}::{edge.target}::{type_val(edge.type)}::{edge.direction}"

    def merge_many(self, graphs: List[Graph], source_root: str = "") -> Graph:
        """合并多个图为一个全图。"""
        merged = Graph(source_root=source_root)
        for g in graphs:
            self._merge_one(merged, g)
        return merged

    def merge_two(self, base: Graph, incoming: Graph) -> int:
        """将 incoming 合并到 base。返回新增节点数。"""
        return self._merge_one(base, incoming)

    def _seed_index(self, base: Graph) -> None:
        """用 base 图中已有的节点填充索引（增量去重）。"""
        for node in base.nodes.values():
            key = self.node_key(node)
            if key not in self._node_key_index:
                self._node_key_index[key] = node.id

    def _merge_one(self, base: Graph, incoming: Graph) -> int:
        """
        将 incoming 合并到 base（原地修改 base）。
        返回新增节点数。
        """
        # 确保 base 中已有节点在索引中
        self._seed_index(base)

        added = 0
        id_remap: Dict[str, str] = {}    # incoming node_id → base node_id

        for node in incoming.nodes.values():
            key = self.node_key(node)
            if key in self._node_key_index:
                id_remap[node.id] = self._node_key_index[key]
                # 更新已有节点的属性
                existing = base.get_node(self._node_key_index[key])
                if existing:
                    existing.properties.update(node.properties)
            else:
                self._node_key_index[key] = node.id
                base.add_node(node)
                id_remap[node.id] = node.id
                added += 1

        for edge in incoming.edges.values():
            # 重映射 source/target
            new_source = id_remap.get(edge.source, edge.source)
            new_target = id_remap.get(edge.target, edge.target)

            if new_source not in base.nodes or new_target not in base.nodes:
                continue

            edge.source = new_source
            edge.target = new_target

            key = self.edge_key(edge)
            if key in self._edge_key_index:
                continue

            self._edge_key_index[key] = edge.id
            base.add_edge(edge)

        return added


class CrossFileResolver:
    """
    跨文件关系解析器：基于导入语义补全结构边。
    识别模式：
      - from X import Y → 建立对 X.Y 的 IMPORT 边
      - 函数调用匹配 → 建立 CALL 边
      - 继承匹配 → 建立 INHERIT 边
    """

    def resolve(self, graph: Graph) -> int:
        """
        在图内解析跨文件关系。返回新增边数。

        识别模式：
          - 继承匹配 → 建立 INHERIT 边
          - 函数调用匹配 → 建立 CALL 边

        (已知限制：跨文件 IMPORT 边需语义级适配器支持，V1 未实现。)
        """
        added = 0

        # 构建全局名称索引: short_name → [node, ...]
        name_index: Dict[str, List[Node]] = {}
        for node in graph.nodes.values():
            if node.type != NodeType.SYMBOL:
                continue
            short = node.name.split(".")[-1]
            name_index.setdefault(short, []).append(node)

        # 对每个节点的 properties 中的引用进行匹配
        for node in list(graph.nodes.values()):
            if node.type != NodeType.SYMBOL:
                continue

            # 处理 bases（继承关系）
            bases: List[str] = node.properties.get("bases", [])
            for base_name in bases:
                short = base_name.split(".")[-1]
                for target in name_index.get(short, []):
                    if target.id != node.id:
                        edge = Edge(
                            id=Edge.make_id(),
                            type=EdgeType.STRUCTURAL,
                            direction="inherit",
                            source=node.id,
                            target=target.id,
                        )
                        if graph.add_edge(edge):
                            added += 1
                        break   # 只匹配第一个同名

            # 处理 calls（调用关系）
            calls: List[str] = node.properties.get("calls", [])
            for call_name in calls:
                short = call_name.split(".")[-1]
                for target in name_index.get(short, []):
                    if target.id != node.id:
                        edge = Edge(
                            id=Edge.make_id(),
                            type=EdgeType.STRUCTURAL,
                            direction="call",
                            source=node.id,
                            target=target.id,
                        )
                        if graph.add_edge(edge):
                            added += 1
                        break

        return added

    def resolve_incremental(self, graph: Graph, changed_node_ids: list[str]) -> int:
        """增量跨文件解析：只处理变化节点的跨文件关系。

        Args:
            graph: 当前全图
            changed_node_ids: 本次变化的节点 ID 列表

        Returns:
            新增边数
        """
        if not changed_node_ids:
            return 0

        # 构建全局名称索引（需要全图，但只在首次或 dirty 时重建）
        name_index: Dict[str, List[Node]] = {}
        for node in graph.nodes.values():
            if node.type != NodeType.SYMBOL:
                continue
            short = node.name.split(".")[-1]
            name_index.setdefault(short, []).append(node)

        changed_set = set(changed_node_ids)
        added = 0

        for node_id in changed_set:
            node = graph.get_node(node_id)
            if not node or node.type != NodeType.SYMBOL:
                continue

            # 处理 bases（继承关系）
            bases: List[str] = node.properties.get("bases", [])
            for base_name in bases:
                short = base_name.split(".")[-1]
                for target in name_index.get(short, []):
                    if target.id != node.id:
                        edge = Edge(
                            id=Edge.make_id(),
                            type=EdgeType.STRUCTURAL,
                            direction="inherit",
                            source=node.id,
                            target=target.id,
                        )
                        if graph.add_edge(edge):
                            added += 1
                        break

            # 处理 calls（调用关系）
            calls: List[str] = node.properties.get("calls", [])
            for call_name in calls:
                short = call_name.split(".")[-1]
                for target in name_index.get(short, []):
                    if target.id != node.id:
                        edge = Edge(
                            id=Edge.make_id(),
                            type=EdgeType.STRUCTURAL,
                            direction="call",
                            source=node.id,
                            target=target.id,
                        )
                        if graph.add_edge(edge):
                            added += 1
                        break

        return added
