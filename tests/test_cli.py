# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试 CLI 命令。"""

import os
import json
import tempfile
import pytest
from unittest.mock import patch
from io import StringIO

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.cli import (
    _load_graph, _find_node_id,
    cmd_neighbors, cmd_impact, cmd_path, cmd_diff,
)


class TestLoadGraph:
    def test_load_valid(self):
        g_path = os.path.join(tempfile.gettempdir(), "test_load_graph.json")
        g = Graph(source_root="/test")
        g.add_node(Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function"))
        g.to_json(g_path)
        try:
            loaded = _load_graph(g_path)
            assert loaded is not None
            assert loaded.node_count == 1
        finally:
            os.unlink(g_path)

    def test_load_missing(self):
        result = _load_graph("/nonexistent/path.json")
        assert result is None


class TestFindNodeId:
    @pytest.fixture
    def graph(self):
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "handle_request", "h.py:10", "python", "function"))
        g.add_node(Node("n2", NodeType.SYMBOL, "MyClass.process", "m.py:20", "python", "function"))
        g.add_node(Node("n3", NodeType.SYMBOL, "helper", "h.py:5", "python", "function"))
        return g

    def test_by_id(self, graph):
        assert _find_node_id(graph, "n1") == "n1"

    def test_by_full_name(self, graph):
        assert _find_node_id(graph, "handle_request") == "n1"
        assert _find_node_id(graph, "MyClass.process") == "n2"

    def test_by_short_name(self, graph):
        assert _find_node_id(graph, "process") == "n2"

    def test_not_found(self, graph):
        assert _find_node_id(graph, "nonexistent") is None


class TestCmdNeighbors:
    @pytest.fixture
    def graph(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "main", "main.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "helper", "main.py:5", "python", "function")
        n3 = Node("n3", NodeType.SYMBOL, "Worker.run", "w.py:10", "python", "function")
        g.add_node(n1)
        g.add_node(n2)
        g.add_node(n3)
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n1", "n3"))
        return g

    def test_neighbors_count(self, graph, capsys):
        with patch("src_python.cli._load_graph", return_value=graph):
            with patch("sys.argv", ["hologram", "neighbors", "main", "-g", "fake.json"]):
                import argparse
                ns = argparse.Namespace(node="main", graph="fake.json")
                with patch("sys.stdout", new=StringIO()) as fake_out:
                    try:
                        from src_python.cli import cmd_neighbors
                        result = cmd_neighbors(ns)
                    except SystemExit:
                        pass


class TestCmdImpact:
    @pytest.fixture
    def graph(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "root", "r.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "child", "r.py:5", "python", "function")
        n3 = Node("n3", NodeType.SYMBOL, "grandchild", "r.py:10", "python", "function")
        g.add_node(n1)
        g.add_node(n2)
        g.add_node(n3)
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
        return g

    def test_impact_two_layers(self, graph):
        """BFS 应找到两层波及（反向追踪 dependents）。
        图: n1→n2→n3 (n1依赖n2, n2依赖n3)
        从 n3 出发: n3 被 n2 依赖 → n2 被 n1 依赖 → 共 3 层"""
        layers = graph.impact_bfs("n3", max_depth=2)
        # 3 层: depth 0 (n3), depth 1 (n2), depth 2 (n1)
        assert len(layers) == 3
        assert layers[0]["depth"] == 0
        assert len(layers[0]["nodes"]) == 1  # n3
        assert layers[1]["depth"] == 1
        assert layers[2]["depth"] == 2


class TestCmdPath:
    @pytest.fixture
    def graph(self):
        g = Graph()
        for i in range(4):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function"))
        g.add_edge(Edge("e0", EdgeType.STRUCTURAL, "call", "n0", "n1"))
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
        g.add_edge(Edge("e3", EdgeType.STRUCTURAL, "call", "n0", "n2"))  # 捷径
        return g

    def test_multiple_paths(self, graph):
        paths = graph.paths("n0", "n3")
        assert len(paths) == 2  # n0→n1→n2→n3 和 n0→n2→n3

    def test_direct_path(self, graph):
        paths = graph.paths("n0", "n2")
        assert len(paths) == 2  # n0→n2 和 n0→n1→n2


class TestCmdDiff:
    @pytest.fixture
    def graph1(self):
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "old_func", "old.py:1", "python", "function"))
        return g

    @pytest.fixture
    def graph2(self):
        g = Graph()
        g.add_node(Node("n2", NodeType.SYMBOL, "new_func", "new.py:1", "python", "function"))
        return g

    def test_diff_detects_changes(self, graph1, graph2):
        from src_python.core.diff import GraphDiffer
        diff = GraphDiffer.diff(graph1, graph2)
        assert not diff.is_empty
        assert len(diff.removed_nodes) == 1
        assert len(diff.added_nodes) == 1


class TestCmdAnalyzeIntegration:
    """集成测试：通过 CLI analyze 分析小型项目。"""

    def test_analyze_small_project(self):
        d = tempfile.mkdtemp()
        try:
            # 创建小型 Python 项目
            with open(os.path.join(d, "main.py"), "w") as f:
                f.write("""
def greet(name):
    return f"Hello, {name}"

class App:
    def run(self):
        msg = greet("World")
        print(msg)

if __name__ == "__main__":
    App().run()
""")
            with open(os.path.join(d, "utils.py"), "w") as f:
                f.write("""
MAX_RETRIES = 3

def retry(func, times=MAX_RETRIES):
    for i in range(times):
        try:
            return func()
        except Exception:
            pass
    return None
""")

            from src_python.cli import cmd_analyze
            import argparse
            ns = argparse.Namespace(root=d, output=os.path.join(d, "out.json"))
            result = cmd_analyze(ns)
            assert result == 0

            # 验证输出
            with open(os.path.join(d, "out.json"), encoding="utf-8") as f:
                data = json.load(f)
            assert data["meta"]["node_count"] > 0
            assert data["meta"]["edge_count"] > 0
            # 应包含函数和类
            kinds = [n["kind"] for n in data["nodes"]]
            assert "function" in kinds
            assert "class" in kinds
            assert "constant" in kinds
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)
