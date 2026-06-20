# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试 V3 变更摘要生成器 (ChangeSummaryGenerator)。"""

import pytest

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.core.community import Community
from src_python.routing.signals import Signal
from src_python.routing.constraints import ConstraintChecker, ConstraintResult, ConstraintViolation
from src_python.routing.summary import ChangeSummary, ChangeSummaryGenerator


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def summary_gen():
    return ChangeSummaryGenerator()


@pytest.fixture
def empty_test_graph():
    g = Graph(source_root="/test")
    return g


@pytest.fixture
def populated_graph():
    """构建一个有节点、边、社区的图用于测试 enrich。"""
    g = Graph(source_root="/test")

    n1 = Node(id="n1", type=NodeType.SYMBOL, name="api.get_user",
              location="api.py:5", language="python", kind="function")
    n2 = Node(id="n2", type=NodeType.SYMBOL, name="handlers.process",
              location="handlers.py:10", language="python", kind="function")
    n3 = Node(id="n3", type=NodeType.SYMBOL, name="db.query",
              location="db.py:15", language="python", kind="function")

    g.add_node(n1)
    g.add_node(n2)
    g.add_node(n3)

    # 边: n1 calls n2, n2 calls n3, n1 calls n3
    e1 = Edge(id="e1", type=EdgeType.STRUCTURAL, direction="call",
              source="n1", target="n2")
    e2 = Edge(id="e2", type=EdgeType.STRUCTURAL, direction="call",
              source="n2", target="n3")
    e3 = Edge(id="e3", type=EdgeType.STRUCTURAL, direction="call",
              source="n1", target="n3")
    g.add_edge(e1)
    g.add_edge(e2)
    g.add_edge(e3)

    # 社区
    g.communities = [
        Community(id="c1", level=0, label="api-core",
                  node_ids={"n1", "n3"}),
        Community(id="c2", level=0, label="handlers",
                  node_ids={"n2"}),
    ]

    return g


@pytest.fixture
def violated_signals():
    return [
        Signal(level=5, signal_type="l5_db_migration",
               category="Database migration",
               description="Migration file changed",
               file_path="migrations/001.py", line=1,
               affected_nodes=["migration_001"],
               confidence="determined"),
        Signal(level=4, signal_type="l4_threshold_change",
               category="Numeric threshold",
               description="timeout 30 -> 15",
               file_path="config.py", line=10,
               old_value="30", new_value="15",
               confidence="determined"),
        Signal(level=2, signal_type="l2_blast_radius",
               category="Blast radius",
               description="Blast radius 25 nodes",
               details={"total_affected": 25, "changed_nodes": 3},
               confidence="determined"),
    ]


@pytest.fixture
def constraint_result_with_violations(violated_signals):
    checker = ConstraintChecker()
    return checker.check(violated_signals)


@pytest.fixture
def constraint_result_passed():
    checker = ConstraintChecker()
    signals = [
        Signal(level=2, signal_type="l2_blast_radius",
               category="Blast radius",
               description="Blast radius 12 nodes",
               details={"total_affected": 12},
               confidence="determined"),
    ]
    return checker.check(signals)


# ============================================================
# ChangeSummary 数据模型
# ============================================================

class TestChangeSummary:
    """变更摘要数据模型测试。"""

    def test_passed_summary(self):
        s = ChangeSummary(passed=True, total_changed_files=3, blast_radius=12)
        assert s.passed
        assert "PASS" in s.one_line()
        assert "12" in s.one_line()

    def test_failed_summary(self):
        s = ChangeSummary(
            passed=False,
            total_changed_files=5,
            l5_violations=[{"signal": {"description": "test"}}],
            l4_violations=[{"signal": {"description": "test"}}],
            blast_radius=25,
        )
        assert not s.passed
        line = s.one_line()
        assert "FAIL" in line
        assert "5" in line
        assert "L5:1" in line
        assert "L4:1" in line

    def test_to_dict(self):
        s = ChangeSummary(
            passed=True,
            timestamp="2026-06-08T14:00:00",
            commit_hash="abc123",
            changed_files=["a.py", "b.py"],
            total_changed_files=2,
            blast_radius=8,
            cross_community_edges=0,
            new_cycles=0,
            new_thread_conflicts=0,
            api_signature_changes=0,
            passed_checks=["check1"],
        )
        d = s.to_dict()
        assert d["passed"] is True
        assert d["commit_hash"] == "abc123"
        assert d["changed_files"] == ["a.py", "b.py"]
        assert d["blast_radius"] == 8


# ============================================================
# ChangeSummaryGenerator
# ============================================================

class TestChangeSummaryGenerator:
    """变更摘要生成器测试。"""

    def test_generate_passed(self, summary_gen, constraint_result_passed):
        summary = summary_gen.generate(
            changed_files=["config.py", "utils.py"],
            constraint_result=constraint_result_passed,
            signals=[],
        )
        assert summary.passed
        assert summary.total_changed_files == 2

    def test_generate_failed(self, summary_gen, violated_signals,
                              constraint_result_with_violations):
        summary = summary_gen.generate(
            changed_files=["migrations/001.py", "config.py", "main.py"],
            constraint_result=constraint_result_with_violations,
            signals=violated_signals,
        )
        assert not summary.passed
        assert summary.total_changed_files == 3
        assert len(summary.l5_violations) == 1
        assert len(summary.l4_violations) == 1
        assert len(summary.l2_violations) == 1

    def test_generate_no_constraint_result(self, summary_gen):
        summary = summary_gen.generate(
            changed_files=["main.py"],
            constraint_result=None,
            signals=[],
        )
        # 无 constraint_result 时默认 passed
        assert summary.passed

    def test_generate_with_stats(self, summary_gen, violated_signals,
                                  constraint_result_with_violations):
        summary = summary_gen.generate(
            changed_files=["config.py"],
            constraint_result=constraint_result_with_violations,
            signals=violated_signals,
        )
        # blast_radius 来自 l2_blast_radius 信号
        assert summary.blast_radius == 25

    def test_generate_with_commit(self, summary_gen, constraint_result_passed):
        summary = summary_gen.generate(
            changed_files=["config.py"],
            constraint_result=constraint_result_passed,
            signals=[],
            commit_hash="d4e8f2a",
        )
        assert summary.commit_hash == "d4e8f2a"
        assert summary.timestamp  # 应该有时间戳


# ============================================================
# Render 面板
# ============================================================

class TestRenderPanel:
    """变更摘要面板渲染测试。"""

    def test_render_passed_panel(self, summary_gen, constraint_result_passed):
        summary = summary_gen.generate(
            changed_files=["config.py", "utils.py"],
            constraint_result=constraint_result_passed,
            signals=[],
        )
        panel = summary_gen.render_panel(summary)
        assert "CHANGE SUMMARY" in panel
        assert "All constraints passed" in panel
        assert "[OK]" in panel

    def test_render_failed_panel(self, summary_gen, violated_signals,
                                  constraint_result_with_violations):
        summary = summary_gen.generate(
            changed_files=["migrations/001.py", "config.py", "main.py"],
            constraint_result=constraint_result_with_violations,
            signals=violated_signals,
        )
        panel = summary_gen.render_panel(summary)
        assert "L5" in panel
        assert "L4" in panel
        assert "Migration" in panel
        assert "timeout" in panel
        assert "[confirm]" in panel
        assert "[!!]" in panel
        assert "[!]" in panel

    def test_render_panel_no_emoji(self, summary_gen, violated_signals,
                                    constraint_result_with_violations):
        """确保面板输出不包含 Unicode 表情符号（ASCII-safe）。"""
        summary = summary_gen.generate(
            changed_files=["config.py"],
            constraint_result=constraint_result_with_violations,
            signals=violated_signals,
        )
        panel = summary_gen.render_panel(summary)
        # 检查没有常见的中文/emoji 字符
        forbidden = ["✅", "⚠️", "⛔", "⏱", "🔗", "─", "│", "┌", "└", "├"]
        for char in forbidden:
            assert char not in panel, f"Found forbidden Unicode char: {char}"

    def test_render_panel_with_multiple_violations(self, summary_gen):
        signals = [
            Signal(level=5, signal_type="l5_db_migration",
                   category="migration", description="A", file_path="a.py",
                   confidence="determined"),
            Signal(level=5, signal_type="l5_config_key_deleted",
                   category="config", description="B", file_path="b.py",
                   confidence="determined"),
            Signal(level=4, signal_type="l4_threshold_change",
                   category="threshold", description="C 5->3",
                   file_path="c.py", old_value="5", new_value="3",
                   confidence="determined"),
            Signal(level=3, signal_type="l3_rhythm_change",
                   category="rhythm", description="D", file_path="d.py",
                   confidence="determined"),
        ]
        checker = ConstraintChecker()
        result = checker.check(signals)
        summary = summary_gen.generate(
            changed_files=["a.py", "b.py", "c.py", "d.py"],
            constraint_result=result,
            signals=signals,
        )
        panel = summary_gen.render_panel(summary)
        assert panel.count("[!!]") >= 2  # two L5 violations
        assert panel.count("[!]") >= 1   # one L4
        assert panel.count("[~]") >= 1   # one L3


# ============================================================
# enrich() — 局面简报
# ============================================================

class TestEnrich:
    """局面简报生成测试。"""

    def test_enrich_empty(self, summary_gen):
        g = Graph(source_root="/test")
        briefing = summary_gen.enrich(after_graph=g)
        assert "sections" in briefing
        assert "graph_snapshot" in briefing["sections"]
        assert "coupling_depth" in briefing["sections"]

    def test_enrich_with_graph(self, summary_gen, populated_graph):
        briefing = summary_gen.enrich(
            after_graph=populated_graph,
            changed_files=["api.py"],
        )
        gs = briefing["sections"]["graph_snapshot"]
        assert "changed_nodes" in gs

    def test_enrich_with_coupling(self, summary_gen, populated_graph):
        coupling_result = {
            "module_reports": [
                {
                    "module_name": "api",
                    "file_path": "api.py",
                    "l1_count": 3, "l2_count": 1, "l3_count": 0, "l4_count": 0,
                    "total": 4, "l4_density": 0.0, "fragility_score": 0.25,
                    "l4_violations": [], "l3_shared_resources": [],
                }
            ],
            "total_l1": 3, "total_l2": 1, "total_l3": 0, "total_l4": 0,
            "edge_classifications": {},
        }
        briefing = summary_gen.enrich(
            after_graph=populated_graph,
            changed_files=["api.py"],
            coupling_result=coupling_result,
        )
        cd = briefing["sections"]["coupling_depth"]
        assert cd["available"]
        assert len(cd["changed_modules"]) == 1

    def test_enrich_with_cycles(self, summary_gen, populated_graph):
        cycle_result = {
            "total_cycles": 2,
            "pure_code_cycles": 1,
            "data_persistent_cycles": 1,
            "llm_involved_cycles": 0,
            "cycles": [
                {
                    "cycle_id": "c1", "node_names": ["api.get_user", "db.query"],
                    "length": 2, "category": "pure_code",
                },
                {
                    "cycle_id": "c2", "node_names": ["handlers.process", "db.query"],
                    "length": 2, "category": "data_persistent",
                },
            ],
        }
        briefing = summary_gen.enrich(
            after_graph=populated_graph,
            changed_files=["api.py"],
            cycle_result=cycle_result,
        )
        dc = briefing["sections"]["dataflow_cycles"]
        assert dc["available"]
        assert dc["total_cycles"] == 2

    def test_enrich_with_threads(self, summary_gen, populated_graph):
        thread_result = {
            "total_threads_found": 1,
            "total_locks_found": 0,
            "total_shared_resources": 0,
            "unlocked_concurrent_writes": 0,
            "threads": [
                {"type": "thread", "target": "worker", "location": "api.py:10",
                 "confidence": "determined"}
            ],
            "resources": {},
        }
        briefing = summary_gen.enrich(
            after_graph=populated_graph,
            changed_files=["api.py"],
            thread_result=thread_result,
        )
        ta = briefing["sections"]["thread_associations"]
        assert ta["available"]
        assert ta["total_threads"] == 1

    def test_enrich_with_communities(self, summary_gen, populated_graph):
        briefing = summary_gen.enrich(
            after_graph=populated_graph,
            changed_files=["api.py", "handlers.py"],
        )
        ca = briefing["sections"]["community_associations"]
        assert ca["available"]
        # api.py nodes are in community c1, handlers.py in c2
        assert ca["cross_community_detected"]

    def test_enrich_with_diff(self, summary_gen, empty_test_graph, populated_graph):
        briefing = summary_gen.enrich(
            after_graph=populated_graph,
            before_graph=empty_test_graph,
        )
        gd = briefing["sections"]["graph_diff"]
        assert gd["available"]
        assert gd["nodes_added"] == 3
        assert gd["edges_added"] == 3

    def test_enrich_unavailable_modules(self, summary_gen, populated_graph):
        briefing = summary_gen.enrich(after_graph=populated_graph)
        assert not briefing["sections"]["coupling_depth"]["available"]
        assert not briefing["sections"]["dataflow_cycles"]["available"]
        assert not briefing["sections"]["thread_associations"]["available"]


# ============================================================
# Render Agent Briefing
# ============================================================

class TestRenderAgentBriefing:
    """Agent 局面简报渲染。"""

    def test_render_briefing(self, summary_gen, populated_graph):
        briefing = summary_gen.enrich(
            after_graph=populated_graph,
            changed_files=["api.py"],
        )
        ctx = {"commit": "d4e8f2a", "file": "api.py:5"}
        text = summary_gen.render_agent_briefing(briefing, violation_context=ctx)
        assert "SITUATION BRIEFING" in text
        assert "d4e8f2a" in text
        assert "Graph Snapshot" in text
        assert "Community Associations" in text

    def test_render_briefing_no_emoji(self, summary_gen, populated_graph):
        briefing = summary_gen.enrich(after_graph=populated_graph)
        text = summary_gen.render_agent_briefing(briefing)
        # ASCII-safe
        forbidden = ["✅", "⚠️", "⛔", "─", "│", "┌", "└"]
        for char in forbidden:
            assert char not in text, f"Found forbidden Unicode char: {char}"


# ============================================================
# Summary 统计
# ============================================================

class TestSummaryStats:
    """变更摘要统计准确性。"""

    def test_empty_summary_stats(self):
        s = ChangeSummary(passed=True)
        assert s.blast_radius == 0
        assert s.cross_community_edges == 0
        assert s.new_cycles == 0
        assert s.new_thread_conflicts == 0
        assert s.api_signature_changes == 0

    def test_violation_counts(self):
        s = ChangeSummary(
            passed=False,
            l5_violations=[{}, {}],
            l4_violations=[{}, {}, {}],
            l3_violations=[{}],
            l2_violations=[],
        )
        assert len(s.l5_violations) == 2
        assert len(s.l4_violations) == 3
        assert len(s.l3_violations) == 1
        assert len(s.l2_violations) == 0
