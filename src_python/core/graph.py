"""
图数据结构：节点、边、图。
系统无关的中间表示——所有语言适配器产出的统一格式。
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Dict, List, Optional, Set


# ============================================================
# 枚举定义
# ============================================================

class NodeType(str, Enum):
    SYMBOL = "symbol"
    MEDIUM = "medium"
    TEMPORAL = "temporal"


class SymbolKind(str, Enum):
    FUNCTION = "function"
    CLASS = "class"
    MODULE = "module"
    CONSTANT = "constant"
    INTERFACE = "interface"
    VARIABLE = "variable"


class MediumKind(str, Enum):
    FILE = "file"
    DATABASE = "database"
    QUEUE = "queue"
    CACHE = "cache"
    NETWORK = "network"
    SHARED_MEMORY = "shared_memory"


class TemporalKind(str, Enum):
    THREAD = "thread"
    TIMER = "timer"
    EVENT_LOOP = "event_loop"
    TRIGGER = "trigger"


class EdgeType(str, Enum):
    STRUCTURAL = "structural"
    DATA = "data"
    TEMPORAL = "temporal"


class StructuralDirection(str, Enum):
    CALL = "call"
    INHERIT = "inherit"
    IMPLEMENT = "implement"
    IMPORT = "import"
    REFERENCE = "reference"
    INSTANTIATE = "instantiate"


class DataDirection(str, Enum):
    READ = "read"
    WRITE = "write"
    SUBSCRIBE = "subscribe"


class TemporalDirection(str, Enum):
    EXECUTES_ON = "executes_on"
    TRIGGERS = "triggers"
    BLOCKS = "blocks"


# ============================================================
# 节点
# ============================================================

@dataclass
class Node:
    """图中的节点——可以是符号、介质或时间结构。"""
    id: str
    type: NodeType
    name: str
    location: str              # 文件路径:行号
    language: str
    kind: str                  # SymbolKind / MediumKind / TemporalKind 的值
    community_id: Optional[str] = None
    properties: Dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def make_id() -> str:
        return f"node_{uuid.uuid4().hex[:8]}"

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        # 兼容：type 可能已是字符串（从 JSON 反序列化后）
        d["type"] = self.type.value if isinstance(self.type, NodeType) else self.type
        return d

    def __hash__(self) -> int:
        return hash(self.id)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Node):
            return False
        return self.id == other.id


# ============================================================
# 边
# ============================================================

@dataclass
class Edge:
    """图中连接两个节点的边。"""
    id: str
    type: EdgeType
    direction: str                # StructuralDirection / DataDirection / TemporalDirection 的值
    source: str                   # Node.id
    target: str                   # Node.id
    temporal_delay_sec: Optional[float] = None
    medium_node_id: Optional[str] = None
    properties: Dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def make_id() -> str:
        return f"edge_{uuid.uuid4().hex[:8]}"

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        # 兼容：type 可能已是字符串（从 JSON 反序列化后）
        d["type"] = self.type.value if isinstance(self.type, EdgeType) else self.type
        return d

    def __hash__(self) -> int:
        return hash(self.id)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Edge):
            return False
        return self.id == other.id


# ============================================================
# 社区
# ============================================================

@dataclass
class Community:
    """由社区发现算法（Leiden）识别的节点聚类。"""
    id: str
    level: int                  # 层级（0 = 最粗）
    label: str                  # 自动生成的社区名
    node_ids: Set[str] = field(default_factory=set)
    parent_id: Optional[str] = None
    properties: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "level": self.level,
            "label": self.label,
            "node_ids": list(self.node_ids),
            "parent_id": self.parent_id,
            "properties": self.properties,
        }


# ============================================================
# 图
# ============================================================

@dataclass
class Graph:
    """完整的代码库依赖拓扑图。"""
    nodes: Dict[str, Node] = field(default_factory=dict)
    edges: Dict[str, Edge] = field(default_factory=dict)
    communities: List[Community] = field(default_factory=list)
    source_root: str = ""

    # -- 增删 --

    def add_node(self, node: Node) -> Node:
        if node.id in self.nodes:
            existing = self.nodes[node.id]
            existing.properties.update(node.properties)
            return existing
        self.nodes[node.id] = node
        return node

    def add_edge(self, edge: Edge) -> Optional[Edge]:
        if edge.id in self.edges:
            return None
        if edge.source not in self.nodes or edge.target not in self.nodes:
            return None
        self.edges[edge.id] = edge
        return edge

    def remove_node(self, node_id: str) -> None:
        self.nodes.pop(node_id, None)
        self.edges = {
            eid: e for eid, e in self.edges.items()
            if e.source != node_id and e.target != node_id
        }

    def remove_edge(self, edge_id: str) -> None:
        self.edges.pop(edge_id, None)

    def remove_file(self, file_path: str) -> tuple:
        """移除指定文件的所有节点和关联边。返回 (removed_node_count, removed_edge_count)。

        匹配规则：node.location 以 file_path 开头。
        这在 Windows 和 Unix 路径上都有效，因为 location 和
        file_path 都来自 os.scandir / abspath 产生的实际路径。
        """
        nodes_to_remove = self.find_nodes_by_location(file_path)
        removed_nodes = len(nodes_to_remove)
        for node in nodes_to_remove:
            self.remove_node(node.id)
        # remove_node 已经清理了关联边，这里统计一下
        return (removed_nodes, 0)  # edge count tracked elsewhere if needed

    def replace_file(self, file_path: str, new_file_graph: Graph) -> tuple:
        """原子替换：移除旧节点 + 合并新图的节点和边。

        返回 (removed_nodes, added_nodes, added_edges)。
        """
        removed_nodes, _ = self.remove_file(file_path)
        added_nodes = 0
        for node in new_file_graph.nodes.values():
            self.add_node(node)
            added_nodes += 1
        added_edges = 0
        for edge in new_file_graph.edges.values():
            if self.add_edge(edge):
                added_edges += 1
        return (removed_nodes, added_nodes, added_edges)

    # -- 查询 --

    def get_node(self, node_id: str) -> Optional[Node]:
        return self.nodes.get(node_id)

    def get_edge(self, edge_id: str) -> Optional[Edge]:
        return self.edges.get(edge_id)

    def find_node_by_name(self, name: str) -> List[Node]:
        return [n for n in self.nodes.values() if n.name == name]

    def resolve_node(self, query: str) -> Optional[Node]:
        """统一的模糊节点查找 — 所有工具共享同一套匹配策略。

        按优先级依次尝试：
        1. 精确 ID 匹配 (graph.nodes key)
        2. 精确名称匹配
        3. 短名称匹配（. 分割的最后一段，如 "process" 匹配 "Foo.process"）
        4. 大小写不敏感名称匹配
        5. 名称子串匹配
        6. location 包含查询串
        """
        if not query:
            return None
        # 1. Exact ID
        if query in self.nodes:
            return self.nodes[query]
        # 2. Exact name
        for n in self.nodes.values():
            if n.name == query:
                return n
        # 3. Short name (last segment after .)
        #    也处理用户输入带点的情况（如 "Class.method"）—
        #    先精确匹配，再逐级后缀匹配
        for n in self.nodes.values():
            if n.name.split(".")[-1] == query:
                return n
        # 3b. 用户输入是点分格式 — 检查节点名是否以该后缀结尾
        if "." in query:
            for n in self.nodes.values():
                if n.name.endswith("." + query) or n.name.endswith(query):
                    return n
        # 4. Case-insensitive exact
        ql = query.lower()
        for n in self.nodes.values():
            if n.name.lower() == ql:
                return n
        # 5. Substring in name
        for n in self.nodes.values():
            if ql in n.name.lower():
                return n
        # 6. Location contains query
        for n in self.nodes.values():
            if n.location and ql in n.location.lower():
                return n
        return None

    def find_nodes_by_location(self, file_path: str) -> List[Node]:
        """返回指定文件中的所有节点。

        同时尝试绝对路径和原始路径匹配（兼容相对/绝对混用，以及斜杠差异）。
        """
        # Normalize: resolve to absolute, then generate all slash variants
        def _norm(p: str) -> str:
            p = os.path.normpath(os.path.abspath(p) if not os.path.isabs(p) else p)
            return p

        candidates: set = {file_path}
        try:
            candidates.add(_norm(file_path))
        except Exception:
            pass
        # Both slash directions
        for c in list(candidates):
            if "\\" in c:
                candidates.add(c.replace("\\", "/"))
            if "/" in c:
                candidates.add(c.replace("/", "\\"))

        results = []
        for n in self.nodes.values():
            loc = n.location or ""
            loc_norm = {loc}
            if "\\" in loc:
                loc_norm.add(loc.replace("\\", "/"))
            if "/" in loc:
                loc_norm.add(loc.replace("/", "\\"))
            for c in candidates:
                for ln in loc_norm:
                    if ln.startswith(c):
                        results.append(n)
                        break
                else:
                    continue
                break  # break outer loop too
        return results

    def neighbors(self, node_id: str) -> List[Node]:
        """一阶邻接节点。"""
        neighbor_ids: Set[str] = set()
        for e in self.edges.values():
            if e.source == node_id:
                neighbor_ids.add(e.target)
            elif e.target == node_id:
                neighbor_ids.add(e.source)
        return [self.nodes[nid] for nid in neighbor_ids if nid in self.nodes]

    def outgoing_edges(self, node_id: str) -> List[Edge]:
        return [e for e in self.edges.values() if e.source == node_id]

    def incoming_edges(self, node_id: str) -> List[Edge]:
        return [e for e in self.edges.values() if e.target == node_id]

    def impact_bfs(self, node_id: str, max_depth: int = 3) -> List[Dict[str, Any]]:
        """
        BFS 波及分析：从 node_id 出发，追踪所有依赖它的节点（dependents）。
        在依赖图中 A→B 表示 A 依赖 B，所以沿 target→source 反向追踪：
        找所有 e.target == node_id 的 e.source（即依赖 node_id 的节点），
        然后递归追踪这些 source 节点的 dependents。

        结果格式：[{"depth": 0, "nodes": [...]}, {"depth": 1, "nodes": [...]}, ...]
        """
        if node_id not in self.nodes:
            return []
        layers: List[Dict[str, Any]] = []
        visited: Set[str] = {node_id}
        frontier: Set[str] = {node_id}
        for depth in range(max_depth + 1):
            layers.append({
                "depth": depth,
                "nodes": [self.nodes[nid].to_dict() for nid in frontier],
            })
            next_frontier: Set[str] = set()
            for nid in frontier:
                # Reverse traversal: find nodes whose edge TARGETS nid
                # (i.e., nodes that depend ON nid — they are impacted)
                for e in self.edges.values():
                    if e.target == nid and e.source not in visited:
                        next_frontier.add(e.source)
                        visited.add(e.source)
            if not next_frontier:
                break
            frontier = next_frontier
        return layers

    def paths(self, from_id: str, to_id: str, max_len: int = 12) -> List[List[str]]:
        """两点间所有路径（DFS，限长）。"""
        if from_id not in self.nodes or to_id not in self.nodes:
            return []
        all_paths: List[List[str]] = []
        adjacency: Dict[str, List[str]] = {nid: [] for nid in self.nodes}
        for e in self.edges.values():
            adjacency[e.source].append(e.target)

        def dfs(current: str, path: List[str], visited: Set[str]) -> None:
            if len(path) > max_len:
                return
            if current == to_id:
                all_paths.append(list(path))
                return
            for neighbor in adjacency.get(current, []):
                if neighbor not in visited:
                    visited.add(neighbor)
                    path.append(neighbor)
                    dfs(neighbor, path, visited)
                    path.pop()
                    visited.discard(neighbor)

        dfs(from_id, [from_id], {from_id})
        return all_paths

    # -- 统计 --

    @property
    def node_count(self) -> int:
        return len(self.nodes)

    @property
    def edge_count(self) -> int:
        return len(self.edges)

    @property
    def community_count(self) -> int:
        return len(self.communities)

    def nodes_by_type(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for n in self.nodes.values():
            t = n.type.value if hasattr(n.type, 'value') else str(n.type)
            counts[t] = counts.get(t, 0) + 1
        return counts

    def edges_by_type(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for e in self.edges.values():
            t = e.type.value if hasattr(e.type, 'value') else str(e.type)
            counts[t] = counts.get(t, 0) + 1
        return counts

    # -- 合并 --

    def merge(self, other: Graph) -> int:
        """
        将另一个图合并到当前图中。基于 location + name 去重。
        返回新增节点数。
        """
        loc_map: Dict[str, Node] = {}
        for n in self.nodes.values():
            key = f"{n.location}::{n.name}"
            loc_map[key] = n

        added = 0
        for node in other.nodes.values():
            key = f"{node.location}::{node.name}"
            if key not in loc_map:
                self.add_node(node)
                loc_map[key] = node
                added += 1

        for edge in other.edges.values():
            if edge.source in self.nodes and edge.target in self.nodes:
                self.add_edge(edge)

        return added

    # -- 序列化 --

    def to_dict(self) -> Dict[str, Any]:
        return {
            "meta": {
                "source_root": self.source_root,
                "generated_at": "",
                "version": "0.1.0",
                "node_count": self.node_count,
                "edge_count": self.edge_count,
                "community_count": self.community_count,
            },
            "nodes": [n.to_dict() for n in self.nodes.values()],
            "edges": [e.to_dict() for e in self.edges.values()],
            "communities": [c.to_dict() for c in self.communities],
        }

    def to_json(self, file_path: str) -> None:
        import datetime
        d = self.to_dict()
        d["meta"]["generated_at"] = datetime.datetime.now().isoformat()
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2, ensure_ascii=False)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> Graph:
        g = cls(source_root=d.get("meta", {}).get("source_root", ""))
        for nd in d.get("nodes", []):
            # Normalize type/kind fields from strings (JSON round-trip)
            nd["type"] = NodeType(nd["type"]) if isinstance(nd.get("type"), str) else nd["type"]
            if isinstance(nd.get("kind"), str):
                try:
                    nd["kind"] = SymbolKind(nd["kind"])
                except ValueError:
                    try:
                        nd["kind"] = MediumKind(nd["kind"])
                    except ValueError:
                        pass  # keep as string if unknown
            g.add_node(Node(**nd))
        for ed in d.get("edges", []):
            ed["type"] = EdgeType(ed["type"]) if isinstance(ed.get("type"), str) else ed["type"]
            g.add_edge(Edge(**ed))
        for cd in d.get("communities", []):
            g.communities.append(Community(
                id=cd["id"],
                level=cd["level"],
                label=cd["label"],
                node_ids=set(cd.get("node_ids", [])),
                parent_id=cd.get("parent_id"),
                properties=cd.get("properties", {}),
            ))
        return g

    @classmethod
    def from_json(cls, file_path: str) -> Graph:
        with open(file_path, "r", encoding="utf-8") as f:
            return cls.from_dict(json.load(f))

    @staticmethod
    def from_nodes_and_edges(nodes: list, edges: list) -> Graph:
        """从节点和边列表快速构建图（内部用）。"""
        g = Graph()
        for n in nodes:
            g.add_node(n)
        for e in edges:
            g.add_edge(e)
        return g


def file_from_location(loc: str) -> str:
    """从 "path:lineno" 格式的 location 中提取文件路径。

    Windows 兼容：处理 drive letter 冒号。
    """
    if not loc:
        return loc
    parts = loc.rsplit(":", 1)
    if len(parts) == 2 and parts[1].strip().isdigit():
        return parts[0]
    return loc
