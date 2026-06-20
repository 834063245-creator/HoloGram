# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""补覆盖率缺口：MCP stdio、社区层级、diff 边界、缓存边界。"""

import os
import json
import tempfile
import pytest
from unittest.mock import patch, MagicMock
from io import StringIO

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType, Community
from src_python.core.community import CommunityDetector, HAS_LEIDEN, _generate_label
from src_python.core.diff import GraphDiffer, GraphDiff, ModifiedNode
from src_python.mcp_server import MCPServer


class TestMCPServerRunStdio:
    @pytest.fixture
    def graph(self):
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "test", "test.py:1", "python", "function"))
        return g

    def test_run_stdio_single_request(self, graph):
        """run_stdio 应处理 stdin 输入并写回 stdout。"""
        server = MCPServer(graph)
        request = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})

        with patch("sys.stdin", StringIO(request + "\n")):
            with patch("sys.stdout", new=StringIO()) as fake_out:
                server.run_stdio()
                output = fake_out.getvalue()
                assert output.strip()
                resp = json.loads(output.strip())
                assert resp["id"] == 1
                assert "tools" in resp["result"]

    def test_run_stdio_skips_empty_lines(self, graph):
        """空行应被跳过。"""
        server = MCPServer(graph)
        request = "\n\n" + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}) + "\n"

        with patch("sys.stdin", StringIO(request)):
            with patch("sys.stdout", new=StringIO()) as fake_out:
                server.run_stdio()
                output = fake_out.getvalue()
                assert output.strip()

    def test_run_stdio_skips_invalid_json(self, graph):
        """无效 JSON 行应被跳过。"""
        server = MCPServer(graph)
        request = "not valid json\n" + json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}) + "\n"

        with patch("sys.stdin", StringIO(request)):
            with patch("sys.stdout", new=StringIO()) as fake_out:
                server.run_stdio()
                output = fake_out.getvalue()
                assert output.strip()
                resp = json.loads(output.strip())
                assert resp["id"] == 3

    def test_run_stdio_notification_skipped(self, graph):
        """通知（无 id）不应产生 stdout 输出。"""
        server = MCPServer(graph)
        # 先发通知，再发正常请求
        request = (
            json.dumps({"jsonrpc": "2.0", "method": "tools/list"}) + "\n" +
            json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/list"}) + "\n"
        )

        with patch("sys.stdin", StringIO(request)):
            with patch("sys.stdout", new=StringIO()) as fake_out:
                server.run_stdio()
                output = fake_out.getvalue().strip()
                # 应只有一行响应（通知被跳过）
                lines = [l for l in output.split("\n") if l.strip()]
                assert len(lines) == 1


class TestCommunityDetectorGaps:
    @pytest.fixture
    def detector(self):
        return CommunityDetector(max_levels=1)

    def test_label_empty_node_ids(self, detector):
        """空 node_ids 应返回 'empty'。"""
        g = Graph()
        label = _generate_label(g, set())
        assert label == "empty"

    def test_label_single_node(self, detector):
        """单节点社区标签应为该节点名。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "SoloFunction", "solo.py:1", "python", "function"))
        label = _generate_label(g, {"n1"})
        assert label == "SoloFunction"

    def test_recurse_subcommunity_small_parent_returns_zero(self, detector):
        """_recurse_subcommunity 在父社区 < 3 节点时返回 0。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "a", "a.py:1", "python", "function"))
        g.add_node(Node("n2", NodeType.SYMBOL, "b", "b.py:1", "python", "function"))
        parent = Community(id="parent", level=0, label="small", node_ids={"n1", "n2"})
        result = detector._recurse_subcommunity(g, parent, [], 0, level=0)
        assert result == 0

    def test_recurse_subcommunity_max_level_reached_returns_zero(self, detector):
        """_recurse_subcommunity 在 level >= max_levels 时返回 0。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "a", "a.py:1", "python", "function"))
        g.add_node(Node("n2", NodeType.SYMBOL, "b", "b.py:1", "python", "function"))
        g.add_node(Node("n3", NodeType.SYMBOL, "c", "c.py:1", "python", "function"))
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
        parent = Community(id="parent", level=0, label="big", node_ids={"n1", "n2", "n3"})
        # max_levels=1, current level=1 → 应返回 0
        result = detector._recurse_subcommunity(g, parent, [], 0, level=1)
        assert result == 0

    def test_community_not_assigned_when_no_detection(self):
        """未运行社区发现的图上的节点 community_id 应为 None。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function"))
        assert g.nodes["n1"].community_id is None

    def test_communities_stored_on_graph(self):
        """detect() 应把社区存到 graph.communities。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "a", "a.py:1", "python", "function"))
        g.add_node(Node("n2", NodeType.SYMBOL, "b", "b.py:1", "python", "function"))
        g.add_node(Node("n3", NodeType.SYMBOL, "c", "c.py:1", "python", "function"))
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))

        detector = CommunityDetector()
        communities = detector.detect(g)

        assert g.communities == communities
        assert g.community_count == len(communities)


class TestGraphDifferGaps:
    def test_no_edge_changes(self):
        """相同的边不应出现在 diff 中。"""
        g1 = Graph()
        g2 = Graph()
        for nid, name in [("n1", "a"), ("n2", "b")]:
            g1.add_node(Node(nid, NodeType.SYMBOL, name, f"{name}.py:1", "python", "function"))
            g2.add_node(Node(nid, NodeType.SYMBOL, name, f"{name}.py:1", "python", "function"))
        e = Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2")
        g1.add_edge(e)
        g2.add_edge(e)

        diff = GraphDiffer.diff(g1, g2)
        assert len(diff.added_edges) == 0
        assert len(diff.removed_edges) == 0

    def test_added_edge(self):
        g1 = Graph()
        g2 = Graph()
        g1.add_node(Node("n1", NodeType.SYMBOL, "a", "a.py:1", "python", "function"))
        g1.add_node(Node("n2", NodeType.SYMBOL, "b", "b.py:1", "python", "function"))
        g2.add_node(Node("n1", NodeType.SYMBOL, "a", "a.py:1", "python", "function"))
        g2.add_node(Node("n2", NodeType.SYMBOL, "b", "b.py:1", "python", "function"))
        g2.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))

        diff = GraphDiffer.diff(g1, g2)
        assert len(diff.added_edges) == 1

    def test_removed_edge(self):
        g1 = Graph()
        g2 = Graph()
        g1.add_node(Node("n1", NodeType.SYMBOL, "a", "a.py:1", "python", "function"))
        g1.add_node(Node("n2", NodeType.SYMBOL, "b", "b.py:1", "python", "function"))
        g2.add_node(Node("n1", NodeType.SYMBOL, "a", "a.py:1", "python", "function"))
        g2.add_node(Node("n2", NodeType.SYMBOL, "b", "b.py:1", "python", "function"))
        g1.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))

        diff = GraphDiffer.diff(g1, g2)
        assert len(diff.removed_edges) == 1

    def test_kind_change_detected(self):
        g1 = Graph()
        g2 = Graph()
        g1.add_node(Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function"))
        g2.add_node(Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "class"))  # kind changed

        diff = GraphDiffer.diff(g1, g2)
        # kind included in dedup key → kind change is remove+add, not modified
        assert len(diff.modified_nodes) == 0
        assert len(diff.added_nodes) == 1
        assert len(diff.removed_nodes) == 1
        assert diff.added_nodes[0].kind == "class"
        assert diff.removed_nodes[0].kind == "function"

    def test_is_empty_true(self):
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function"))
        diff = GraphDiffer.diff(g, g)
        assert diff.is_empty

    def test_empty_summary(self):
        diff = GraphDiff()
        summary = GraphDiffer.impact_summary(diff)
        assert "No structural changes" in summary

    def test_summary_truncation(self):
        """多于 5 个新增节点应显示截断信息。"""
        diff = GraphDiff()
        for i in range(7):
            diff.added_nodes.append(
                Node(f"n{i}", NodeType.SYMBOL, f"func_{i}", f"f{i}.py:1", "python", "function")
            )
        summary = GraphDiffer.impact_summary(diff)
        assert "7 nodes added" in summary
        assert "and 2 more" in summary


class TestCacheDiskPersistence:
    def test_load_from_disk_corrupted(self):
        """损坏的缓存文件应被优雅处理。"""
        d = tempfile.mkdtemp()
        try:
            cache_path = os.path.join(d, "pipeline_cache.json")
            with open(cache_path, "w") as f:
                f.write("this is not json")

            from src_python.pipeline.cache import IncrementalCache
            cache = IncrementalCache(cache_dir=d)
            assert cache.size == 0  # 加载失败，回退为空
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_load_from_disk_os_error(self):
        """磁盘 I/O 错误应被优雅处理。"""
        from src_python.pipeline.cache import IncrementalCache
        # 使用无效路径
        cache = IncrementalCache(cache_dir="/nonexistent/path/that/cannot/be/created")
        # 不应崩溃
        assert cache.size == 0

    def test_save_to_disk_no_cache_dir(self):
        """无 cache_dir 时 save_to_disk 应为空操作。"""
        from src_python.pipeline.cache import IncrementalCache
        cache = IncrementalCache()  # 无 cache_dir
        cache.set("test.py", "hash123", Graph())
        # 不应崩溃
        cache.save_to_disk()

    def test_hash_file_read_error(self):
        """无法读取的文件应返回 None。"""
        from src_python.pipeline.cache import IncrementalCache
        result = IncrementalCache.hash_file("/nonexistent/file.txt")
        assert result is None


class TestPipelineRunnerReadError:
    def test_read_file_permission_error(self):
        """无法读取的文件不应崩溃流水线。"""
        from src_python.pipeline.runner import PipelineRunner
        from src_python.adapters import AdapterRegistry
        reg = AdapterRegistry()

        runner = PipelineRunner(reg)
        result = runner._read_file("/nonexistent/file.py")
        assert result is None


class TestDiscoverFilesEdgeCases:
    def test_exclude_dot_dirs(self):
        """以点开头的隐藏目录应被排除。"""
        d = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(d, ".hidden"), exist_ok=True)
            with open(os.path.join(d, ".hidden", "secret.py"), "w") as f:
                f.write("x=1")

            from src_python.pipeline.discovery import discover_files
            from src_python.adapters import AdapterRegistry, PythonAdapter
            reg = AdapterRegistry()
            reg.register(PythonAdapter())

            files = discover_files(d, reg)
            assert len(files) == 0
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)
