"""
图数据结构：节点、边、图。
系统无关的中间表示——所有语言适配器产出的统一格式。
"""

from __future__ import annotations

import json
import logging
import math
import os
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


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
    position: Optional[List[float]] = None  # [x, y, z] 预计算布局坐标
    properties: Dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def make_id() -> str:
        return f"node_{uuid.uuid4().hex[:16]}"

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
    coupling_depth: int = 0  # L1-L4 coupling analysis result
    properties: Dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def make_id() -> str:
        return f"edge_{uuid.uuid4().hex[:16]}"

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
# JSON 序列化安全层
# ============================================================

def _sanitize_for_json(obj: Any) -> Any:
    """递归清理 JSON 序列化前的所有隐患。

    - float('nan') / ±inf → None（JSON null）
    - Enum 实例 → 其 .value 字符串
    - 未知类型 → str(obj) 兜底
    - dict/list/tuple 递归处理
    """
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_sanitize_for_json(v) for v in obj]
    if isinstance(obj, Enum):
        return obj.value
    # 安全类型直通（str, int, bool, None, bytes）
    if isinstance(obj, (str, int, bool, type(None))):
        return obj
    # 最后兜底：转字符串
    return str(obj)


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
            logger.debug("Duplicate edge id: %s", edge.id)
            return None
        if edge.source not in self.nodes or edge.target not in self.nodes:
            missing = []
            if edge.source not in self.nodes:
                missing.append(edge.source)
            if edge.target not in self.nodes:
                missing.append(edge.target)
            logger.warning("Edge %s: dangling reference(s) %s (source=%s, target=%s)",
                           edge.id, missing, edge.source, edge.target)
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
        # 统计即将被移除的边（remove_node 会清理关联边）
        node_ids = {n.id for n in nodes_to_remove}
        removed_edges = sum(
            1 for e in self.edges.values()
            if e.source in node_ids or e.target in node_ids
        )
        for node in nodes_to_remove:
            self.remove_node(node.id)
        return (removed_nodes, removed_edges)

    def replace_file(self, file_path: str, new_file_graph: Graph) -> tuple:
        """原子替换：移除旧节点 + 合并新图的节点和边。

        返回 (removed_nodes, added_nodes, added_edges)。
        如果中途失败，回滚所有变更。
        """
        # 备份旧状态（仅此文件相关部分）
        old_node_ids = {n.id for n in self.find_nodes_by_location(file_path)}
        old_nodes_bak = {nid: self.nodes[nid] for nid in old_node_ids if nid in self.nodes}
        old_edges_bak = {
            eid: e for eid, e in self.edges.items()
            if e.source in old_node_ids or e.target in old_node_ids
        }
        removed_nodes = len(old_node_ids)
        removed_edges = len(old_edges_bak)

        try:
            # 移除旧节点/边
            for nid in old_node_ids:
                self.nodes.pop(nid, None)
            self.edges = {
                eid: e for eid, e in self.edges.items()
                if e.source not in old_node_ids and e.target not in old_node_ids
            }
            # 加入新节点/边
            added_nodes = 0
            for node in new_file_graph.nodes.values():
                if node.id not in self.nodes:
                    self.nodes[node.id] = node
                    added_nodes += 1
                else:
                    existing = self.nodes[node.id]
                    existing.properties.update(node.properties)
            added_edges = 0
            for edge in new_file_graph.edges.values():
                if self.add_edge(edge):
                    added_edges += 1
        except Exception:
            # 回滚
            self.nodes.update(old_nodes_bak)
            self.edges.update(old_edges_bak)
            logger.warning(
                "replace_file %s failed, rolled back (%d nodes, %d edges restored)",
                file_path, removed_nodes, removed_edges,
            )
            raise
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
        for n in self.nodes.values():
            if n.name.split(".")[-1] == query:
                return n
        # 3b. 带点后缀匹配
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
        BFS 波及分析：从 node_id 出发，按层扩散，返回每层的节点列表。
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
        import datetime
        d = {
            "meta": {
                "source_root": self.source_root,
                "generated_at": datetime.datetime.now().isoformat(),
                "version": "0.1.0",
                "node_count": self.node_count,
                "edge_count": self.edge_count,
                "community_count": self.community_count,
            },
            "nodes": [n.to_dict() for n in self.nodes.values()],
            "edges": [e.to_dict() for e in self.edges.values()],
            "communities": [c.to_dict() for c in self.communities],
        }
        # Include coupling summary if available (set after CouplingDepthAnalyzer runs)
        if hasattr(self, 'coupling_summary') and self.coupling_summary:
            d["meta"]["coupling"] = {
                k: self.coupling_summary[k] for k in
                ('total_l1', 'total_l2', 'total_l3', 'total_l4')
                if k in self.coupling_summary
            }
        return d

    def to_json(self, file_path: str) -> None:
        d = self.to_dict()
        d = _sanitize_for_json(d)
        target = os.path.abspath(file_path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp_path = target + ".tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(d, f, indent=2, ensure_ascii=False)
            os.replace(tmp_path, target)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    def to_msgpack(self, file_path: str) -> None:
        """A3: 写入 MessagePack 二进制文件，大项目加载快 10×。"""
        import msgpack
        d = self.to_dict()
        target = os.path.abspath(file_path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp_path = target + ".tmp"
        try:
            with open(tmp_path, "wb") as f:
                msgpack.pack(d, f)
            os.replace(tmp_path, target)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    @classmethod
    def from_msgpack(cls, file_path: str) -> "Graph":
        """A3: 从 MessagePack 二进制文件读取图。"""
        import msgpack
        with open(file_path, "rb") as f:
            d = msgpack.unpack(f, raw=False)
        return cls.from_dict(d)

    def to_sqlite(self, db_path: str) -> None:
        """A4: 写入 SQLite 数据库，Agent 工具查询不用解析整个 JSON。

        节点表 + 边表 + 社区表，带索引。查询走索引，大项目毫秒级。
        JSON 仍然是 master 数据源——DB 是查询加速层。
        """
        import sqlite3
        import json as _json
        import datetime as _dt

        target = os.path.abspath(db_path)
        os.makedirs(os.path.dirname(target), exist_ok=True)

        # 写入临时 DB，完成后再原子 rename（避免半成品 DB）
        tmp_path = target + ".tmp"
        conn = None
        try:
            conn = sqlite3.connect(tmp_path)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("BEGIN TRANSACTION")
            conn.executescript("""
                DROP TABLE IF EXISTS nodes;
                DROP TABLE IF EXISTS edges;
                DROP TABLE IF EXISTS communities;

                CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    kind TEXT NOT NULL DEFAULT '',
                    location TEXT NOT NULL DEFAULT '',
                    language TEXT NOT NULL DEFAULT '',
                    community_id TEXT DEFAULT '',
                    degree INTEGER NOT NULL DEFAULT 0,
                    l34_count INTEGER NOT NULL DEFAULT 0,
                    properties TEXT NOT NULL DEFAULT '{}'
                );

                CREATE TABLE edges (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    target TEXT NOT NULL,
                    type TEXT NOT NULL,
                    direction TEXT NOT NULL DEFAULT '',
                    coupling_depth INTEGER NOT NULL DEFAULT 0,
                    properties TEXT NOT NULL DEFAULT '{}'
                );

                CREATE TABLE communities (
                    id TEXT PRIMARY KEY,
                    level INTEGER NOT NULL DEFAULT 0,
                    label TEXT NOT NULL DEFAULT '',
                    parent_id TEXT DEFAULT '',
                    node_count INTEGER NOT NULL DEFAULT 0,
                    properties TEXT NOT NULL DEFAULT '{}'
                );

                CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
                CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
                CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
                CREATE INDEX IF NOT EXISTS idx_edges_depth ON edges(coupling_depth);
                CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
                CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community_id);
                CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);

                -- FTS5 全文搜索（大项目 LIKE 全表扫 100ms+，MATCH 走倒排索引 <1ms）
                DROP TABLE IF EXISTS nodes_fts;
                CREATE VIRTUAL TABLE nodes_fts USING fts5(
                    name, id, kind, location,
                    tokenize='unicode61 remove_diacritics 1'
                );
            """)

            now = _dt.datetime.now().isoformat()

            # Calculate degrees
            deg: dict[str, int] = {}
            for e in self.edges.values():
                deg[e.source] = deg.get(e.source, 0) + 1
                deg[e.target] = deg.get(e.target, 0) + 1

            # Calculate L3/L4 counts (coupling depth >= 3)
            l34: dict[str, int] = {}
            for e in self.edges.values():
                if e.coupling_depth >= 3:
                    l34[e.source] = l34.get(e.source, 0) + 1
                    l34[e.target] = l34.get(e.target, 0) + 1

            # Insert nodes in batches
            node_rows = []
            for n in self.nodes.values():
                node_rows.append((
                    n.id, n.name, type_val(n.type), getattr(n, 'kind', '') or '',
                    getattr(n, 'location', '') or '', getattr(n, 'language', '') or '',
                    getattr(n, 'community_id', '') or '',
                    deg.get(n.id, 0), l34.get(n.id, 0),
                    _json.dumps(getattr(n, 'properties', {}) or {}),
                ))
            conn.executemany(
                "INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?)", node_rows,
            )

            # Populate FTS5 index (name, id, kind, location)
            conn.executemany(
                "INSERT INTO nodes_fts(name, id, kind, location) VALUES (?,?,?,?)",
                [(n[1], n[0], n[3], n[4]) for n in node_rows],
            )

            # Insert edges in batches
            edge_rows = []
            for e in self.edges.values():
                edge_rows.append((
                    e.id, e.source, e.target, type_val(e.type),
                    getattr(e, 'direction', '') or '',
                    e.coupling_depth,
                    _json.dumps(getattr(e, 'properties', {}) or {}),
                ))
            conn.executemany(
                "INSERT INTO edges VALUES (?,?,?,?,?,?,?)", edge_rows,
            )

            # Insert communities
            comm_rows = []
            for c in self.communities:
                comm_rows.append((
                    c.id, getattr(c, 'level', 0), getattr(c, 'label', '') or '',
                    getattr(c, 'parent_id', '') or '', len(c.node_ids),
                    _json.dumps(getattr(c, 'properties', {}) or {}),
                ))
            conn.executemany(
                "INSERT INTO communities VALUES (?,?,?,?,?,?)", comm_rows,
            )

            # Meta table
            conn.execute("DROP TABLE IF EXISTS meta")
            conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
            conn.executemany("INSERT INTO meta VALUES (?,?)", [
                ("source_root", self.source_root or ""),
                ("node_count", str(self.node_count)),
                ("edge_count", str(self.edge_count)),
                ("community_count", str(self.community_count)),
                ("generated_at", now),
                ("version", "0.1.0"),
            ])

            conn.commit()
            conn.close()
            conn = None
            # 原子替换：只有完整写入成功后才 swap
            os.replace(tmp_path, target)
        except Exception:
            if conn is not None:
                try:
                    conn.rollback()
                except Exception:
                    pass
                try:
                    conn.close()
                except Exception:
                    pass
            # 清理临时文件
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            raise

    def to_file_graph(self) -> "Graph":
        """将符号级图聚合为文件级图。

        每个文件一个节点，文件间一条边 = 其中任一个符号有跨文件调用。
        大项目（Django 级别）符号级节点百万→文件级永远几千。
        星图渲染文件级秒出，Agent 查询仍用符号级 SQLite。
        """
        import os as _os
        g = Graph(source_root=self.source_root)

        # --- 1) Build file→node mapping ---
        file_nodes: dict[str, str] = {}  # file_path → node_id
        for n in self.nodes.values():
            loc = (n.location or "").strip()
            if not loc:
                continue
            fp = loc.split(":")[0]  # strip line number
            if fp not in file_nodes:
                nid = f"file_{len(file_nodes)}"
                g.add_node(Node(
                    id=nid,
                    type=NodeType.SYMBOL,
                    name=_os.path.basename(fp) or fp,
                    location=fp,
                    language=n.language,
                    kind="file",
                    properties={"path": fp},
                ))
                file_nodes[fp] = nid

        # --- 2) Aggregate edges across files ---
        edge_keys: set[tuple[str, str]] = set()
        for e in self.edges.values():
            src_loc = (self.nodes.get(e.source) or None)
            tgt_loc = (self.nodes.get(e.target) or None)
            if not src_loc or not tgt_loc:
                continue
            sfp = (src_loc.location or "").split(":")[0]
            tfp = (tgt_loc.location or "").split(":")[0]
            if not sfp or not tfp or sfp == tfp:
                continue
            sid = file_nodes.get(sfp)
            tid = file_nodes.get(tfp)
            if sid and tid and (sid, tid) not in edge_keys:
                edge_keys.add((sid, tid))
                g.add_edge(Edge(
                    id=f"fe_{len(g.edges)}",
                    type=EdgeType.STRUCTURAL,
                    direction="import",
                    source=sid,
                    target=tid,
                ))

        return g

    @classmethod
    def from_sqlite(cls, db_path: str) -> "Graph":
        """从 SQLite 数据库快速重建图（比 JSON 解析快 5-10×）。

        JSON 是全量序列化→反序列化。SQLite 按表流式读取，不需要
        一次性把整个图载入内存再解析。
        """
        import sqlite3
        import json as _json

        if not os.path.exists(db_path):
            raise FileNotFoundError(f"数据库不存在: {db_path}")

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row

        # Meta
        meta = {}
        for row in conn.execute("SELECT key, value FROM meta"):
            meta[row["key"]] = row["value"]

        g = cls(source_root=meta.get("source_root", ""))

        # Nodes — stream row by row
        for row in conn.execute("SELECT * FROM nodes"):
            props = _json.loads(row["properties"]) if row["properties"] else {}
            node_type = row["type"]
            try:
                node_type = NodeType(node_type)
            except ValueError:
                pass
            g.add_node(Node(
                id=row["id"],
                type=node_type,
                name=row["name"],
                location=row["location"],
                language=row["language"],
                kind=row["kind"],
                community_id=row["community_id"] or None,
                properties=props,
            ))

        # Edges — stream row by row
        for row in conn.execute("SELECT * FROM edges"):
            props = _json.loads(row["properties"]) if row["properties"] else {}
            edge_type = row["type"]
            try:
                edge_type = EdgeType(edge_type)
            except ValueError:
                pass
            g.add_edge(Edge(
                id=row["id"],
                type=edge_type,
                direction=row["direction"],
                source=row["source"],
                target=row["target"],
                coupling_depth=row["coupling_depth"],
                properties=props,
            ))

        # Communities
        for row in conn.execute("SELECT * FROM communities"):
            props = _json.loads(row["properties"]) if row["properties"] else {}
            node_ids_raw = row["node_count"]
            # Reconstruct node_ids from nodes table
            node_ids = set()
            for nr in conn.execute(
                "SELECT id FROM nodes WHERE community_id = ?", (row["id"],)
            ):
                node_ids.add(nr["id"])
            g.communities.append(Community(
                id=row["id"],
                level=row["level"],
                label=row["label"],
                node_ids=node_ids,
                parent_id=row["parent_id"] or None,
                properties=props,
            ))

        conn.close()
        return g

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
        # Restore coupling_summary from meta if present (round-trip safety)
        coupling_meta = d.get("meta", {}).get("coupling")
        if coupling_meta:
            g.coupling_summary = dict(coupling_meta)
        return g

    @classmethod
    def from_json(cls, file_path: str) -> Graph:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return cls.from_dict(json.load(f))
        except FileNotFoundError:
            raise FileNotFoundError(f"图文件不存在: {file_path}")
        except json.JSONDecodeError as e:
            raise ValueError(f"图文件 JSON 格式错误 ({file_path}): {e}") from e

    @staticmethod
    def from_nodes_and_edges(nodes: list, edges: list) -> Graph:
        """从节点和边列表快速构建图（内部用）。"""
        g = Graph()
        for n in nodes:
            g.add_node(n)
        for e in edges:
            g.add_edge(e)
        return g


def type_val(t) -> str:
    """统一提取枚举值的字符串形式，兼容 enum 和原生 str。

    项目内 NodeType/EdgeType 序列化后可能变成字符串，
    此函数同时处理 enum.value 和已反序列化的 str。
    """
    return t.value if hasattr(t, 'value') else str(t)


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
