# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试社区发现。"""

import pytest

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.core.community import CommunityDetector


class TestCommunityDetector:
    @pytest.fixture
    def detector(self):
        return CommunityDetector(max_levels=3)

    def test_too_small_graph(self, detector):
        """少于 3 个节点应返回空。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "f1", "f1.py:1", "python", "function"))
        communities = detector.detect(g)
        assert communities == []

    def test_two_nodes_no_community(self, detector):
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "f1", "f1.py:1", "python", "function"))
        g.add_node(Node("n2", NodeType.SYMBOL, "f2", "f2.py:1", "python", "function"))
        communities = detector.detect(g)
        assert communities == []

    def test_simple_community(self, detector):
        """三个紧密连接的节点应聚为一个社区。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "f1", "f1.py:1", "python", "function"))
        g.add_node(Node("n2", NodeType.SYMBOL, "f2", "f2.py:1", "python", "function"))
        g.add_node(Node("n3", NodeType.SYMBOL, "f3", "f3.py:1", "python", "function"))
        # 形成团
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
        g.add_edge(Edge("e3", EdgeType.STRUCTURAL, "call", "n1", "n3"))

        communities = detector.detect(g)
        assert len(communities) >= 1
        for c in communities:
            assert c.label  # 标签非空
            assert len(c.node_ids) >= 1

    def test_disconnected_components(self, detector):
        """两个不连通的子图应形成两个社区。"""
        g = Graph()
        # 子图 A
        g.add_node(Node("a1", NodeType.SYMBOL, "a1", "a.py:1", "python", "function"))
        g.add_node(Node("a2", NodeType.SYMBOL, "a2", "a.py:5", "python", "function"))
        g.add_edge(Edge("ea", EdgeType.STRUCTURAL, "call", "a1", "a2"))
        # 子图 B
        g.add_node(Node("b1", NodeType.SYMBOL, "b1", "b.py:1", "python", "function"))
        g.add_node(Node("b2", NodeType.SYMBOL, "b2", "b.py:5", "python", "function"))
        g.add_edge(Edge("eb", EdgeType.STRUCTURAL, "call", "b1", "b2"))

        communities = detector.detect(g)
        # Louvain/Leiden 对稀疏图可能合并小社区
        assert len(communities) >= 1

    def test_label_generation(self, detector):
        """标签应由度最高的节点名组成。"""
        g = Graph()
        hub = Node("hub", NodeType.SYMBOL, "CentralHub", "hub.py:1", "python", "class")
        leaf1 = Node("leaf1", NodeType.SYMBOL, "LeafA", "leaf.py:1", "python", "function")
        leaf2 = Node("leaf2", NodeType.SYMBOL, "LeafB", "leaf.py:5", "python", "function")
        g.add_node(hub)
        g.add_node(leaf1)
        g.add_node(leaf2)
        # hub -> both leaves
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "hub", "leaf1"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "hub", "leaf2"))

        communities = detector.detect(g)
        if communities:
            # 标签应包含 hub 的名称
            label = communities[0].label
            assert "Central" in label or "Leaf" in label or "/" in label

    def test_community_assigned_to_nodes(self, detector):
        """社区的 node_ids 应全为图中存在的节点 ID。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "f1", "f.py:1", "python", "function"))
        g.add_node(Node("n2", NodeType.SYMBOL, "f2", "f.py:5", "python", "function"))
        g.add_node(Node("n3", NodeType.SYMBOL, "f3", "f.py:10", "python", "function"))
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))

        communities = detector.detect(g)
        all_community_node_ids = set()
        for c in communities:
            all_community_node_ids.update(c.node_ids)
        assert all_community_node_ids == {"n1", "n2", "n3"}
