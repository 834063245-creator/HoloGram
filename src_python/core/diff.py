"""
变更影响分析：比较两个图快照，计算结构变化。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from .graph import Graph, Node, Edge, type_val


@dataclass
class GraphDiff:
    """两张图快照之间的差异。"""
    added_nodes: List[Node] = field(default_factory=list)
    removed_nodes: List[Node] = field(default_factory=list)
    modified_nodes: List[ModifiedNode] = field(default_factory=list)
    added_edges: List[Edge] = field(default_factory=list)
    removed_edges: List[Edge] = field(default_factory=list)

    @property
    def total_changes(self) -> int:
        return (
            len(self.added_nodes) + len(self.removed_nodes) + len(self.modified_nodes) +
            len(self.added_edges) + len(self.removed_edges)
        )

    @property
    def is_empty(self) -> bool:
        return self.total_changes == 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "added_nodes": [n.to_dict() for n in self.added_nodes],
            "removed_nodes": [n.to_dict() for n in self.removed_nodes],
            "modified_nodes": [{"node_id": mn.node_id, "name": mn.name, "changed_properties": {k: list(v) for k, v in mn.changed_properties.items()}} for mn in self.modified_nodes],
            "added_edges": [e.to_dict() for e in self.added_edges],
            "removed_edges": [e.to_dict() for e in self.removed_edges],
            "total_changes": self.total_changes,
            "is_empty": self.is_empty,
        }


@dataclass
class ModifiedNode:
    """被修改的节点（同一位置同名，但属性变了）。"""
    node_id: str
    name: str
    changed_properties: Dict[str, tuple] = field(default_factory=dict)
    # tuple 格式: (old_value, new_value)


class GraphDiffer:
    """比较两个图快照，生成结构差异报告。"""

    @staticmethod
    def diff(before: Graph, after: Graph) -> GraphDiff:
        result = GraphDiff()

        before_ids = set(before.nodes.keys())
        after_ids = set(after.nodes.keys())

        # 基于 location::name 去重键来匹配节点
        def _loc_key(n: Node) -> str:
            return f"{n.location}::{n.name}"

        before_index: Dict[str, Node] = {_loc_key(n): n for n in before.nodes.values()}
        after_index: Dict[str, Node] = {_loc_key(n): n for n in after.nodes.values()}

        before_keys = set(before_index.keys())
        after_keys = set(after_index.keys())

        # 新增节点
        for key in after_keys - before_keys:
            result.added_nodes.append(after_index[key])

        # 删除节点
        for key in before_keys - after_keys:
            result.removed_nodes.append(before_index[key])

        # 修改节点
        for key in before_keys & after_keys:
            old_n = before_index[key]
            new_n = after_index[key]
            changed = {}
            if old_n.kind != new_n.kind:
                changed["kind"] = (old_n.kind, new_n.kind)
            if old_n.properties != new_n.properties:
                for pk, pv in new_n.properties.items():
                    if old_n.properties.get(pk) != pv:
                        changed[pk] = (old_n.properties.get(pk), pv)
            if changed:
                result.modified_nodes.append(ModifiedNode(
                    node_id=new_n.id,
                    name=new_n.name,
                    changed_properties=changed,
                ))

        # 边的 diff（基于 source+target+type+direction 键）
        def _edge_key(e: Edge) -> str:
            t = type_val(e.type)
            return f"{e.source}::{e.target}::{t}::{e.direction}"

        before_edge_index = {_edge_key(e): e for e in before.edges.values()}
        after_edge_index = {_edge_key(e): e for e in after.edges.values()}

        for key in after_edge_index.keys() - before_edge_index.keys():
            result.added_edges.append(after_edge_index[key])

        for key in before_edge_index.keys() - after_edge_index.keys():
            result.removed_edges.append(before_edge_index[key])

        return result

    @staticmethod
    def impact_summary(diff: GraphDiff) -> str:
        """生成人类可读的变更摘要。"""
        lines = []
        if diff.is_empty:
            return "No structural changes detected."

        if diff.added_nodes:
            names = [n.name for n in diff.added_nodes[:5]]
            suffix = f" and {len(diff.added_nodes) - 5} more" if len(diff.added_nodes) > 5 else ""
            lines.append(f"+ {len(diff.added_nodes)} nodes added: {', '.join(names)}{suffix}")

        if diff.removed_nodes:
            names = [n.name for n in diff.removed_nodes[:5]]
            suffix = f" and {len(diff.removed_nodes) - 5} more" if len(diff.removed_nodes) > 5 else ""
            lines.append(f"- {len(diff.removed_nodes)} nodes removed: {', '.join(names)}{suffix}")

        if diff.modified_nodes:
            names = [mn.name for mn in diff.modified_nodes[:5]]
            suffix = f" and {len(diff.modified_nodes) - 5} more" if len(diff.modified_nodes) > 5 else ""
            lines.append(f"~ {len(diff.modified_nodes)} nodes modified: {', '.join(names)}{suffix}")

        if diff.added_edges:
            lines.append(f"+ {len(diff.added_edges)} edges added")
        if diff.removed_edges:
            lines.append(f"- {len(diff.removed_edges)} edges removed")

        return "\n".join(lines)
