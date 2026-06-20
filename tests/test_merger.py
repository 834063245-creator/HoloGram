# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试图合并器和跨文件解析器。"""

import pytest

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.core.merger import GraphMerger, CrossFileResolver


class TestGraphMerger:
    @pytest.fixture
    def merger(self):
        return GraphMerger()

    def test_merge_two_graphs(self, merger):
        g1 = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "func_a", "a.py:1", "python", "function")
        g1.add_node(n1)

        g2 = Graph()
        n2 = Node("n2", NodeType.SYMBOL, "func_b", "b.py:1", "python", "function")
        g2.add_node(n2)

        added = merger.merge_two(g1, g2)
        assert added == 1
        assert g1.node_count == 2

    def test_dedup_same_location_name(self, merger):
        g1 = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "func", "a.py:1", "python", "function")
        g1.add_node(n1)

        g2 = Graph()
        n2 = Node("n2", NodeType.SYMBOL, "func", "a.py:1", "python", "function", properties={"extra": True})
        g2.add_node(n2)

        added = merger.merge_two(g1, g2)
        assert added == 0  # deduped
        assert g1.nodes["n1"].properties.get("extra") is True

    def test_merge_preserves_edges(self, merger):
        g1 = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "caller", "a.py:1", "python", "function")
        g1.add_node(n1)

        g2 = Graph()
        n2 = Node("n2", NodeType.SYMBOL, "callee", "b.py:1", "python", "function")
        g2.add_node(n2)
        # 边两端节点都必须在 g2 中存在才能 add_edge
        g2.add_node(n1)
        e = Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2")
        added = g2.add_edge(e)
        assert added is not None, "Edge should be added to g2"

        # 合并：g1 已有 n1，g2 有 n1, n2, e1
        g1.add_node(n2)
        merger.merge_two(g1, g2)
        assert g1.edge_count >= 1

    def test_merge_many(self, merger):
        graphs = []
        for i in range(3):
            g = Graph()
            n = Node(f"n{i}", NodeType.SYMBOL, f"func_{i}", f"f{i}.py:1", "python", "function")
            g.add_node(n)
            graphs.append(g)

        merged = merger.merge_many(graphs)
        assert merged.node_count == 3


class TestCrossFileResolver:
    def test_resolve_inheritance(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "BaseClass", "base.py:1", "python", "class")
        n2 = Node("n2", NodeType.SYMBOL, "ChildClass", "child.py:1", "python", "class",
                  properties={"bases": ["BaseClass"]})
        g.add_node(n1)
        g.add_node(n2)

        resolver = CrossFileResolver()
        added = resolver.resolve(g)
        assert added >= 1
        inherit_edges = [e for e in g.edges.values() if e.direction == "inherit"]
        assert len(inherit_edges) >= 1

    def test_empty_graph(self):
        g = Graph()
        resolver = CrossFileResolver()
        added = resolver.resolve(g)
        assert added == 0

    # ── resolve_incremental ───────────────────────────────────

    def test_resolve_incremental_only_targets_changed_nodes(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "Base", "base.py:1", "python", "class")
        n2 = Node("n2", NodeType.SYMBOL, "Child", "child.py:1", "python", "class",
                  properties={"bases": ["Base"]})
        n3 = Node("n3", NodeType.SYMBOL, "Other", "other.py:1", "python", "class",
                  properties={"bases": ["Base"]})
        g.add_node(n1); g.add_node(n2); g.add_node(n3)

        resolver = CrossFileResolver()
        # Only resolve for n2, not n3
        added = resolver.resolve_incremental(g, ["n2"])
        assert added >= 1
        # Should have created inherit edge n2 → n1
        inherit_edges = [e for e in g.edges.values()
                         if e.direction == "inherit" and e.source == "n2"]
        assert len(inherit_edges) >= 1
        # n3 should NOT have been processed
        n3_inherit = [e for e in g.edges.values()
                      if e.direction == "inherit" and e.source == "n3"]
        assert len(n3_inherit) == 0

    def test_resolve_incremental_empty_changed_list(self):
        g = Graph()
        resolver = CrossFileResolver()
        added = resolver.resolve_incremental(g, [])
        assert added == 0

    def test_resolve_incremental_handles_calls(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "target_func", "target.py:5", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "source_func", "source.py:5", "python", "function",
                  properties={"calls": ["target_func"]})
        g.add_node(n1); g.add_node(n2)

        resolver = CrossFileResolver()
        added = resolver.resolve_incremental(g, ["n2"])
        assert added >= 1
        call_edges = [e for e in g.edges.values()
                      if e.direction == "call" and e.source == "n2"]
        assert len(call_edges) >= 1

    def test_resolve_incremental_no_duplicate_edges(self):
        """增量解析不应创建重复边（TOCTOU/去重修复）。"""
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "Base", "base.py:1", "python", "class")
        n2 = Node("n2", NodeType.SYMBOL, "Child", "child.py:1", "python", "class",
                  properties={"bases": ["Base"]})
        g.add_node(n1); g.add_node(n2)

        resolver = CrossFileResolver()

        # 第一次解析：创建继承边
        added1 = resolver.resolve_incremental(g, ["n2"])
        assert added1 >= 1
        edge_count_after_first = g.edge_count

        # 第二次解析：不应该再创建重复边
        added2 = resolver.resolve_incremental(g, ["n2"])
        assert added2 == 0, f"Expected 0 new edges, got {added2}"
        assert g.edge_count == edge_count_after_first, \
            f"Edge count changed from {edge_count_after_first} to {g.edge_count}"

    def test_resolve_incremental_dedup_across_types(self):
        """不同边类型（call + inherit）的去重检查各自独立。"""
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "Base", "base.py:1", "python", "class")
        n2 = Node("n2", NodeType.SYMBOL, "Child", "child.py:1", "python", "class",
                  properties={"bases": ["Base"], "calls": ["Base"]})
        g.add_node(n1); g.add_node(n2)

        resolver = CrossFileResolver()
        added = resolver.resolve_incremental(g, ["n2"])
        # 应创建两条边：inherit(n2→n1) + call(n2→n1)
        assert added >= 2

        # 重复调用不应再创建新边
        added2 = resolver.resolve_incremental(g, ["n2"])
        assert added2 == 0
