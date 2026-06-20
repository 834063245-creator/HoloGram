# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""CLI 命令端到端测试——覆盖所有子命令的完整路径。"""

import os
import json
import tempfile
import pytest
from unittest.mock import patch, MagicMock
from io import StringIO

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.cli import main, cmd_analyze, cmd_neighbors, cmd_impact, cmd_path, cmd_diff, cmd_serve


class TestCmdAnalyzeFull:
    def test_analyze_creates_output_file(self):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "app.py"), "w") as f:
                f.write("""
def run():
    return "ok"
""")
            import argparse
            ns = argparse.Namespace(root=d, output=os.path.join(d, "graph.json"))
            result = cmd_analyze(ns)
            assert result == 0
            assert os.path.exists(os.path.join(d, "graph.json"))
            # 验证 JSON 有效性
            with open(os.path.join(d, "graph.json"), encoding="utf-8") as f:
                data = json.load(f)
            assert data["meta"]["node_count"] > 0
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_analyze_default_output(self):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "app.py"), "w") as f:
                f.write("x = 1")
            import argparse
            ns = argparse.Namespace(root=d, output=None)
            result = cmd_analyze(ns)
            assert result == 0
            # 默认输出位置
            assert os.path.exists(os.path.join(d, "hologram_graph.json"))
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_analyze_empty_dir(self):
        d = tempfile.mkdtemp()
        try:
            import argparse
            ns = argparse.Namespace(root=d, output=os.path.join(d, "out.json"))
            result = cmd_analyze(ns)
            assert result == 0
            with open(os.path.join(d, "out.json"), encoding="utf-8") as f:
                data = json.load(f)
            assert data["meta"]["node_count"] == 0
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)


class TestCmdNeighborsFull:
    @pytest.fixture
    def temp_graph(self):
        """创建临时图文件。"""
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "main", "main.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "helper", "main.py:5", "python", "function")
        g.add_node(n1)
        g.add_node(n2)
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        path = os.path.join(tempfile.gettempdir(), "test_graph_neighbors.json")
        g.to_json(path)
        return path, g

    def test_neighbors_by_name(self, temp_graph):
        path, g = temp_graph
        try:
            import argparse
            ns = argparse.Namespace(node="main", graph=path)
            result = cmd_neighbors(ns)
            assert result == 0
        finally:
            os.unlink(path)

    def test_neighbors_by_short_name(self, temp_graph):
        path, g = temp_graph
        try:
            import argparse
            ns = argparse.Namespace(node="helper", graph=path)
            result = cmd_neighbors(ns)
            assert result == 0
        finally:
            os.unlink(path)

    def test_neighbors_nonexistent_node(self, temp_graph):
        path, g = temp_graph
        try:
            import argparse
            ns = argparse.Namespace(node="nonexistent", graph=path)
            result = cmd_neighbors(ns)
            assert result == 1  # 错误退出
        finally:
            os.unlink(path)

    def test_neighbors_missing_graph(self):
        import argparse
        ns = argparse.Namespace(node="foo", graph="/nonexistent/path.json")
        result = cmd_neighbors(ns)
        assert result == 1


class TestCmdImpactFull:
    @pytest.fixture
    def temp_graph(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "root", "r.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "mid", "r.py:5", "python", "function")
        n3 = Node("n3", NodeType.SYMBOL, "leaf", "r.py:10", "python", "function")
        g.add_node(n1)
        g.add_node(n2)
        g.add_node(n3)
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
        path = os.path.join(tempfile.gettempdir(), "test_graph_impact.json")
        g.to_json(path)
        return path

    def test_impact_default_depth(self, temp_graph):
        try:
            import argparse
            ns = argparse.Namespace(node="root", depth=3, graph=temp_graph)
            result = cmd_impact(ns)
            assert result == 0
        finally:
            os.unlink(temp_graph)

    def test_impact_shallow(self, temp_graph):
        try:
            import argparse
            ns = argparse.Namespace(node="root", depth=1, graph=temp_graph)
            result = cmd_impact(ns)
            assert result == 0
        finally:
            os.unlink(temp_graph)

    def test_impact_not_found(self, temp_graph):
        try:
            import argparse
            ns = argparse.Namespace(node="ghost", depth=3, graph=temp_graph)
            result = cmd_impact(ns)
            assert result == 1
        finally:
            os.unlink(temp_graph)


class TestCmdPathFull:
    @pytest.fixture
    def temp_graph(self):
        g = Graph()
        for i in range(3):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function"))
        g.add_edge(Edge("e0", EdgeType.STRUCTURAL, "call", "n0", "n1"))
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        path = os.path.join(tempfile.gettempdir(), "test_graph_path.json")
        g.to_json(path)
        return path

    def test_path_found(self, temp_graph):
        try:
            import argparse
            ns = argparse.Namespace(from_node="f0", to_node="f2", graph=temp_graph)
            result = cmd_path(ns)
            assert result == 0
        finally:
            os.unlink(temp_graph)

    def test_path_not_found(self, temp_graph):
        try:
            # 添加孤立节点
            g = Graph.from_json(temp_graph)
            g.add_node(Node("n99", NodeType.SYMBOL, "orphan", "o.py:1", "python", "function"))
            g.to_json(temp_graph)

            import argparse
            ns = argparse.Namespace(from_node="f0", to_node="orphan", graph=temp_graph)
            result = cmd_path(ns)
            assert result == 0  # 正常退出，只是没有路径
        finally:
            os.unlink(temp_graph)


class TestCmdDiffFull:
    @pytest.fixture
    def two_graphs(self):
        g1 = Graph()
        g1.add_node(Node("n1", NodeType.SYMBOL, "old", "old.py:1", "python", "function"))
        g1_path = os.path.join(tempfile.gettempdir(), "test_graph_before.json")
        g1.to_json(g1_path)

        g2 = Graph()
        g2.add_node(Node("n2", NodeType.SYMBOL, "new", "new.py:1", "python", "function"))
        g2_path = os.path.join(tempfile.gettempdir(), "test_graph_after.json")
        g2.to_json(g2_path)

        return g1_path, g2_path

    def test_diff_output(self, two_graphs):
        before, after = two_graphs
        try:
            import argparse
            ns = argparse.Namespace(before=before, after=after, json=False)
            result = cmd_diff(ns)
            assert result == 0
        finally:
            os.unlink(before)
            os.unlink(after)


class TestCmdServeFull:
    @pytest.fixture
    def temp_graph(self):
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "test", "test.py:1", "python", "function"))
        path = os.path.join(tempfile.gettempdir(), "test_graph_serve.json")
        g.to_json(path)
        return path

    def test_serve_missing_graph(self):
        import argparse
        ns = argparse.Namespace(graph="/nonexistent/graph.json")
        result = cmd_serve(ns)
        assert result == 1

    def test_serve_valid_graph_does_not_block(self, temp_graph):
        """cmd_serve 不应在测试中阻塞——它会进入 run_stdio 循环。"""
        try:
            import argparse
            ns = argparse.Namespace(graph=temp_graph)
            # 不调用 cmd_serve（会阻塞在 stdin），
            # 只验证图的加载路径
            from src_python.cli import _load_graph
            graph = _load_graph(temp_graph)
            assert graph is not None
            assert graph.node_count == 1
        finally:
            os.unlink(temp_graph)


class TestMainEntry:
    """测试 main() 入口函数。"""

    def test_main_no_args_shows_help(self):
        with patch("sys.argv", ["hologram"]):
            with pytest.raises(SystemExit) as exc:
                main()
            assert exc.value.code == 1

    def test_main_unknown_command(self):
        with patch("sys.argv", ["hologram", "unknown_cmd"]):
            with pytest.raises(SystemExit) as exc:
                main()
            assert exc.value.code != 0
