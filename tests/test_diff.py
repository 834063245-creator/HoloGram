# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试图差异比较。"""

import pytest

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.core.diff import GraphDiffer, GraphDiff


class TestGraphDiffer:
    @pytest.fixture
    def differ(self):
        return GraphDiffer()

    def test_no_changes(self, differ):
        g1 = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function")
        g1.add_node(n1)

        g2 = Graph()
        n2 = Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function")
        g2.add_node(n2)

        diff = differ.diff(g1, g2)
        assert diff.is_empty

    def test_added_node(self, differ):
        g1 = Graph()
        g2 = Graph()
        n = Node("n1", NodeType.SYMBOL, "new_func", "new.py:1", "python", "function")
        g2.add_node(n)

        diff = differ.diff(g1, g2)
        assert len(diff.added_nodes) == 1
        assert diff.added_nodes[0].name == "new_func"

    def test_removed_node(self, differ):
        g1 = Graph()
        n = Node("n1", NodeType.SYMBOL, "old_func", "old.py:1", "python", "function")
        g1.add_node(n)
        g2 = Graph()

        diff = differ.diff(g1, g2)
        assert len(diff.removed_nodes) == 1
        assert diff.removed_nodes[0].name == "old_func"

    def test_modified_node(self, differ):
        g1 = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function", properties={"a": 1})
        g1.add_node(n1)

        g2 = Graph()
        n2 = Node("n2", NodeType.SYMBOL, "f", "f.py:1", "python", "function", properties={"a": 2, "b": 3})
        g2.add_node(n2)

        diff = differ.diff(g1, g2)
        assert len(diff.modified_nodes) >= 1

    def test_modified_node_property_removed(self, differ):
        """属性被删除也应该被检测到（旧代码只遍历 new 侧会漏掉）。"""
        g1 = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function",
                  properties={"a": 1, "b": 2})
        g1.add_node(n1)

        g2 = Graph()
        n2 = Node("n2", NodeType.SYMBOL, "f", "f.py:1", "python", "function",
                  properties={"a": 1})
        g2.add_node(n2)

        diff = differ.diff(g1, g2)
        assert len(diff.modified_nodes) == 1
        mn = diff.modified_nodes[0]
        assert "b" in mn.changed_properties
        assert mn.changed_properties["b"] == (2, None)

    def test_total_changes(self, differ):
        g1 = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "f1", "f.py:1", "python", "function")
        g1.add_node(n1)

        g2 = Graph()
        n2 = Node("n2", NodeType.SYMBOL, "f2", "f.py:2", "python", "function")
        g2.add_node(n2)

        diff = differ.diff(g1, g2)
        # n1 removed, n2 added
        assert diff.total_changes == 2

    def test_impact_summary(self, differ):
        g1 = Graph()
        g2 = Graph()
        n = Node("n1", NodeType.SYMBOL, "new_feature", "feat.py:1", "python", "function")
        g2.add_node(n)

        diff = differ.diff(g1, g2)
        summary = GraphDiffer.impact_summary(diff)
        assert "new_feature" in summary
        assert "1 nodes added" in summary
