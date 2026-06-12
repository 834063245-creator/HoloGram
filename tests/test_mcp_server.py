"""测试 MCP Server JSON-RPC 协议处理。"""

import json
import pytest

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.mcp_server import MCPServer


class TestMCPServer:
    @pytest.fixture
    def graph(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "handle_request", "h.py:10", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "validate", "h.py:5", "python", "function")
        n3 = Node("n3", NodeType.SYMBOL, "log_error", "h.py:15", "python", "function")
        g.add_node(n1)
        g.add_node(n2)
        g.add_node(n3)
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
        return g

    @pytest.fixture
    def server(self, graph):
        return MCPServer(graph)

    def _req(self, method, params=None, req_id=1):
        return {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}}

    # -- tools/list --

    def test_tools_list(self, server):
        req = self._req("tools/list")
        resp = server.handle_request(req)
        assert resp["id"] == 1
        assert "tools" in resp["result"]
        tool_names = [t["name"] for t in resp["result"]["tools"]]
        assert "hologram_neighbors" in tool_names
        assert "hologram_impact" in tool_names
        assert "hologram_path" in tool_names
        assert "hologram_history" in tool_names
        assert "hologram_community" in tool_names
        assert "hologram_delayed" in tool_names
        assert "hologram_changes" in tool_names

    # -- hologram_neighbors --

    def test_neighbors(self, server):
        req = self._req("tools/call", {
            "name": "hologram_neighbors",
            "arguments": {"node_id": "n1"},
        })
        resp = server.handle_request(req)
        assert resp["id"] == 1
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["neighbor_count"] == 1
        # 新格式：按边类型分组的 incoming/outgoing
        assert "incoming" in content
        assert "outgoing" in content
        # n1 → n2 (structural call), 所以 outgoing.structural 里有 validate
        outgoing_structural = content["outgoing"].get("structural", [])
        assert len(outgoing_structural) == 1
        assert outgoing_structural[0]["target"] == "n2"

    def test_neighbors_no_neighbors(self, server, graph):
        """孤立节点应返回空邻居列表。"""
        n4 = Node("n4", NodeType.SYMBOL, "orphan", "o.py:1", "python", "function")
        graph.add_node(n4)
        server2 = MCPServer(graph)
        req = self._req("tools/call", {
            "name": "hologram_neighbors",
            "arguments": {"node_id": "n4"},
        })
        resp = server2.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["neighbor_count"] == 0
        assert content["incoming"] == {}
        assert content["outgoing"] == {}

    # -- hologram_impact --

    def test_impact(self, server):
        """波及分析：从叶子节点 n3 出发，应波及 n2 和 n1（n1→n2→n3 依赖链反向追踪）"""
        req = self._req("tools/call", {
            "name": "hologram_impact",
            "arguments": {"node_id": "n3", "depth": 3},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["source_node_id"] == "n3"
        assert content["max_depth"] == 3
        assert content["total_affected_nodes"] >= 1

    def test_impact_default_depth(self, server):
        req = self._req("tools/call", {
            "name": "hologram_impact",
            "arguments": {"node_id": "n1"},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["max_depth"] == 3  # default

    # -- hologram_path --

    def test_path_found(self, server):
        req = self._req("tools/call", {
            "name": "hologram_path",
            "arguments": {"from_id": "n1", "to_id": "n3"},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["path_count"] == 1
        assert content["paths"][0] == ["n1", "n2", "n3"]

    def test_path_not_found(self, server, graph):
        n4 = Node("n4", NodeType.SYMBOL, "isolated", "i.py:1", "python", "function")
        graph.add_node(n4)
        server2 = MCPServer(graph)
        req = self._req("tools/call", {
            "name": "hologram_path",
            "arguments": {"from_id": "n1", "to_id": "n4"},
        })
        resp = server2.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["path_count"] == 0

    # -- hologram_history --

    def test_history(self, server):
        req = self._req("tools/call", {
            "name": "hologram_history",
            "arguments": {"node_id": "n1"},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert "node" in content
        assert content["node"]["name"] == "handle_request"

    def test_history_not_found(self, server):
        req = self._req("tools/call", {
            "name": "hologram_history",
            "arguments": {"node_id": "nonexistent"},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert "error" in content

    # -- hologram_community --

    def test_community_no_detection(self, server):
        """未运行社区发现的节点返回空社区。"""
        req = self._req("tools/call", {
            "name": "hologram_community",
            "arguments": {"node_id": "n1"},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["community"] is None

    def test_community_with_assignment(self, graph):
        """节点已分配 community_id 时返回社区信息。"""
        from src_python.core.graph import Community
        c = Community(id="community_000", level=0, label="core", node_ids={"n1"})
        graph.communities = [c]
        graph.nodes["n1"].community_id = "community_000"
        server = MCPServer(graph)

        req = self._req("tools/call", {
            "name": "hologram_community",
            "arguments": {"node_id": "n1"},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["community"] is not None
        assert content["community"]["label"] == "core"

    # -- hologram_delayed --

    def test_delayed_empty(self, server):
        """无时间延迟边的图中应返回空。"""
        req = self._req("tools/call", {
            "name": "hologram_delayed",
            "arguments": {},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["total_delayed_edges"] == 0

    def test_delayed_with_temporal_edges(self, graph):
        """有含延迟的时间边时应正确列出。"""
        from src_python.core.graph import Edge, Node, NodeType, EdgeType, TemporalKind
        # 添加时间节点和时间边
        t1 = Node("t1", NodeType.TEMPORAL, "scheduler_h", "h.py:20", "python", TemporalKind.TIMER.value,
                   properties={"interval_sec": 3600})
        graph.add_node(t1)
        graph.add_edge(Edge("e3", EdgeType.TEMPORAL, "executes_on", "n1", "t1",
                            temporal_delay_sec=3600))
        server = MCPServer(graph)

        req = self._req("tools/call", {
            "name": "hologram_delayed",
            "arguments": {},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["total_delayed_edges"] == 1
        assert content["periodic_count"] == 1
        assert len(content["periodic"]) == 1
        assert content["periodic"][0]["delay_sec"] == 3600

    # -- hologram_changes --

    def test_changes_no_timeline(self, server):
        """无 timeline 文件时返回空。"""
        req = self._req("tools/call", {
            "name": "hologram_changes",
            "arguments": {"project_root": "/nonexistent/path"},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert "message" in content
        assert content["changes"] == []

    def test_changes_with_timeline(self, server, tmp_path):
        """有 timeline 数据时应返回最近变更信息。"""
        # Populate TimelineStore (SQLite) instead of the old timeline.json
        from src_python.timeline import TimelineStore
        store = TimelineStore(str(tmp_path))
        store.record(
            event_type="file_changed",
            file="h.py",
            changed_by="git commit abc1234",
            related_nodes=["n1", "n2"],
            summary="改了 handle_request，波及 5 节点",
            properties={"snippet": "讨论后决定用方案 B"},
        )
        store.record(
            event_type="file_changed",
            file="h.py",
            changed_by="git commit def5678",
            related_nodes=["n3"],
            summary="加了 validate_session",
        )
        store.close()

        req = self._req("tools/call", {
            "name": "hologram_changes",
            "arguments": {"project_root": str(tmp_path)},
        })
        resp = server.handle_request(req)
        content = json.loads(resp["result"]["content"][0]["text"])
        assert "last_change" in content
        assert content["last_change"]["summary"] == "加了 validate_session"
        assert content["last_change"]["impact_count"] == 1
        assert content["last_change"]["commit_hash"] == "def5678"
        assert content["timeline_anchor_count"] == 2

    # -- error handling --

    def test_unknown_tool(self, server):
        req = self._req("tools/call", {
            "name": "nonexistent_tool",
            "arguments": {},
        })
        resp = server.handle_request(req)
        assert "error" in resp
        assert resp["error"]["code"] == -32601

    def test_unknown_method(self, server):
        req = self._req("unknown/method")
        resp = server.handle_request(req)
        assert "error" in resp

    def test_notification_no_response(self, server):
        """通知（无 id）不应返回响应。"""
        req = {"jsonrpc": "2.0", "method": "tools/list"}
        resp = server.handle_request(req)
        assert resp is None

    def test_missing_required_args(self, server):
        """缺少必需参数应返回错误。"""
        req = self._req("tools/call", {
            "name": "hologram_neighbors",
            "arguments": {},  # 缺少 node_id
        })
        resp = server.handle_request(req)
        assert "error" in resp
