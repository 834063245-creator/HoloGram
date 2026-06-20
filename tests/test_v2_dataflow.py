# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试 V2 数据流环检测 (Data Flow Cycle Detection)。"""

import pytest

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.analysis.dataflow import (
    DataFlowCycleDetector, DataFlowCycle, DataFlowGraphBuilder,
    cycle_report, LLM_API_PATTERNS,
)


class TestDataFlowGraphBuilder:
    """测试数据流子图构建。"""

    @pytest.fixture
    def mixed_graph(self):
        g = Graph()
        # 符号节点
        n1 = Node("n1", NodeType.SYMBOL, "api_handler", "api.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "query_builder", "query.py:5", "python", "function")
        n3 = Node("n3", NodeType.SYMBOL, "response_formatter", "format.py:10", "python", "function")
        n4 = Node("n4", NodeType.SYMBOL, "openai.ChatCompletion.create", "llm.py:1", "python", "function",
                  properties={"is_llm_api": True})
        # 介质节点
        n5 = Node("n5", NodeType.MEDIUM, "shared_cache.db", "cache.py:0", "python", "database")
        for n in [n1, n2, n3, n4, n5]:
            g.add_node(n)

        # Call edges: n1 → n2, n2 → n3, n3 → n4, n4 → n1 (code cycle)
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
        # Data edges: n3 writes cache, n1 reads cache
        g.add_edge(Edge("e3", EdgeType.STRUCTURAL, "call", "n3", "n4"))
        g.add_edge(Edge("e4", EdgeType.STRUCTURAL, "call", "n4", "n1"))
        # Data cycle through medium
        g.add_edge(Edge("e5", EdgeType.DATA, "write", "n3", "n5"))
        g.add_edge(Edge("e6", EdgeType.DATA, "read", "n1", "n5"))

        return g

    def test_build_dataflow_graph(self, mixed_graph):
        builder = DataFlowGraphBuilder(mixed_graph)
        nx_g = builder.build()
        assert nx_g.number_of_nodes() == 5
        # Call edges + data edges should be included
        assert nx_g.number_of_edges() >= 6

    def test_llm_nodes_marked(self, mixed_graph):
        builder = DataFlowGraphBuilder(mixed_graph)
        nx_g = builder.build()
        assert nx_g.nodes["n4"]["is_llm_node"] is True

    def test_no_llm_on_regular_node(self, mixed_graph):
        builder = DataFlowGraphBuilder(mixed_graph)
        nx_g = builder.build()
        assert nx_g.nodes["n1"]["is_llm_node"] is False


class TestCycleDetection:
    """测试环检测算法。"""

    @pytest.fixture
    def cycle_graph(self):
        g = Graph()
        # A → B → C → A (pure code cycle)
        n_a = Node("na", NodeType.SYMBOL, "A", "a.py:1", "python", "function")
        n_b = Node("nb", NodeType.SYMBOL, "B", "b.py:1", "python", "function")
        n_c = Node("nc", NodeType.SYMBOL, "C", "c.py:1", "python", "function")
        # D ↔ cache.db (data cycle)
        n_d = Node("nd", NodeType.SYMBOL, "D", "d.py:1", "python", "function")
        n_cache = Node("n_cache", NodeType.MEDIUM, "cache.db", "d.py:0", "python", "file")
        for n in [n_a, n_b, n_c, n_d, n_cache]:
            g.add_node(n)

        # Code cycle: A→B→C→A
        g.add_edge(Edge("ea", EdgeType.STRUCTURAL, "call", "na", "nb"))
        g.add_edge(Edge("eb", EdgeType.STRUCTURAL, "call", "nb", "nc"))
        g.add_edge(Edge("ec", EdgeType.STRUCTURAL, "call", "nc", "na"))
        # Data cycle: D→cache→D
        g.add_edge(Edge("ed1", EdgeType.DATA, "write", "nd", "n_cache"))
        g.add_edge(Edge("ed2", EdgeType.DATA, "read", "n_cache", "nd"))

        return g

    def test_detect_pure_code_cycle(self, cycle_graph):
        detector = DataFlowCycleDetector(max_cycles=100)
        cycles = detector.detect(cycle_graph)
        assert len(cycles) >= 1
        # Should find at least the A→B→C→A cycle
        pure_code = [c for c in cycles if c.category == "pure_code"]
        assert len(pure_code) >= 1
        assert any(c.length <= 5 for c in pure_code)

    def test_detect_data_persistent_cycle(self, cycle_graph):
        detector = DataFlowCycleDetector(max_cycles=100)
        cycles = detector.detect(cycle_graph)
        data_cycles = [c for c in cycles if c.category == "data_persistent"]
        assert len(data_cycles) >= 1

    def test_cycle_classification_has_labels(self, cycle_graph):
        detector = DataFlowCycleDetector()
        cycles = detector.detect(cycle_graph)
        for c in cycles:
            assert c.category in ("pure_code", "data_persistent", "llm_involved")
            assert len(c.node_names) == c.length
            assert c.certainty is not None
            assert "cycle_detection" in c.certainty

    def test_detect_scc_fallback(self, cycle_graph):
        detector = DataFlowCycleDetector(max_cycles=100)
        cycles = detector.detect_scc(cycle_graph)
        assert len(cycles) >= 1

    def test_llm_participated_cycle(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "llm_caller", "llm.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "anthropic.messages.create", "sdk.py:20", "python", "function",
                  properties={"is_llm_api": True})
        n3 = Node("n3", NodeType.SYMBOL, "response_handler", "handler.py:5", "python", "function")
        for n in [n1, n2, n3]:
            g.add_node(n)

        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
        g.add_edge(Edge("e3", EdgeType.STRUCTURAL, "call", "n3", "n1"))

        detector = DataFlowCycleDetector(max_cycles=100)
        cycles = detector.detect(g)
        llm_cycles = [c for c in cycles if c.category == "llm_involved"]
        assert len(llm_cycles) >= 1
        assert llm_cycles[0].degradation_risk is not None

    def test_cycle_report_convenience(self, cycle_graph):
        result = cycle_report(cycle_graph)
        assert "total_cycles" in result
        assert "cycles" in result
        assert "certainty_note" in result

    def test_cycle_report_mode_filter(self, cycle_graph):
        result_all = cycle_report(cycle_graph, mode="all")
        result_data = cycle_report(cycle_graph, mode="data")
        assert result_data["total_cycles"] <= result_all["total_cycles"]

    def test_to_dict(self):
        c = DataFlowCycle(
            cycle_id="test_001",
            nodes=["n1", "n2", "n3"],
            node_names=["A", "B", "C"],
            node_types=["symbol", "symbol", "symbol"],
            length=3,
            category="pure_code",
            certainty={"cycle_detection": "确定"},
        )
        d = c.to_dict()
        assert d["cycle_id"] == "test_001"
        assert d["length"] == 3
        assert d["category"] == "pure_code"

    def test_max_length_filter(self):
        """超过 max_length 的环应被过滤。"""
        g = Graph()
        prev = None
        first = None
        for i in range(25):
            n = Node(f"n{i}", NodeType.SYMBOL, f"func_{i}", f"f{i}.py:1", "python", "function")
            g.add_node(n)
            if prev and first is not None:
                g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", prev, n.id))
            if i == 0:
                first = n.id
            prev = n.id
        # Close the cycle: last → first
        g.add_edge(Edge("e_close", EdgeType.STRUCTURAL, "call", prev, first))

        detector = DataFlowCycleDetector(max_cycles=100, max_length=5)
        cycles = detector.detect(g)
        # 25-length cycle should be filtered
        assert all(c.length <= 5 for c in cycles)

    def test_llm_patterns_non_empty(self):
        """LLM API patterns 列表应包含已知 SDK。"""
        assert len(LLM_API_PATTERNS) >= 5
        assert any("openai" in p for p in LLM_API_PATTERNS)
        assert any("anthropic" in p for p in LLM_API_PATTERNS)
