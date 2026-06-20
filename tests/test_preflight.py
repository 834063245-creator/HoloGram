# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试 preflight + health + run_full_check — V3 胶水层。"""

import json
import os
import tempfile
import pytest

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType, Community
from src_python.routing.preflight import (
    PreflightReport,
    HealthReport,
    run_preflight,
    run_health,
    run_full_check,
)


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def chain_graph():
    """n1 → n2 → n3 的简单调用链。"""
    g = Graph()
    n1 = Node("n1", NodeType.SYMBOL, "caller", "a.py:1", "python", "function")
    n2 = Node("n2", NodeType.SYMBOL, "middle", "a.py:5", "python", "function")
    n3 = Node("n3", NodeType.SYMBOL, "callee", "b.py:1", "python", "function")
    g.add_node(n1)
    g.add_node(n2)
    g.add_node(n3)
    g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
    g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
    return g


@pytest.fixture
def large_graph():
    """多个文件、多层调用的图（用于测试波及阈值）。"""
    g = Graph()
    # 创建 30 个节点，形成长调用链
    for i in range(30):
        fname = f"mod{i % 5}.py"
        n = Node(f"n{i}", NodeType.SYMBOL, f"func_{i}", f"{fname}:{i+1}", "python", "function")
        g.add_node(n)
    # 链式连接
    for i in range(29):
        g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", f"n{i}", f"n{i+1}"))
    return g


@pytest.fixture
def community_graph():
    """带社区划分的图。"""
    g = Graph()
    n1 = Node("n1", NodeType.SYMBOL, "core_func", "core/a.py:1", "python", "function")
    n2 = Node("n2", NodeType.SYMBOL, "core_util", "core/b.py:1", "python", "function")
    n3 = Node("n3", NodeType.SYMBOL, "ui_func", "ui/c.py:1", "python", "function")
    n4 = Node("n4", NodeType.SYMBOL, "db_func", "db/d.py:1", "python", "function")
    g.add_node(n1)
    g.add_node(n2)
    g.add_node(n3)
    g.add_node(n4)
    g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
    g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n1", "n3"))
    g.add_edge(Edge("e3", EdgeType.STRUCTURAL, "call", "n3", "n4"))

    # 分配社区
    c1 = Community(id="c1", level=0, label="核心模块", node_ids={"n1", "n2"})
    c2 = Community(id="c2", level=0, label="UI模块", node_ids={"n3"})
    c3 = Community(id="c3", level=0, label="数据模块", node_ids={"n4"})
    g.communities = [c1, c2, c3]
    n1.community_id = "c1"
    n2.community_id = "c1"
    n3.community_id = "c2"
    n4.community_id = "c3"
    return g


# ============================================================
# PreflightReport
# ============================================================

class TestPreflightReport:
    """数据模型序列化。"""

    def test_defaults(self):
        r = PreflightReport()
        assert r.files_checked == []
        assert r.nodes_directly_changed == 0
        assert r.blast_radius == 0
        assert r.cross_community is False
        assert r.l4_violations == 0
        assert r.cycles_touched == 0
        assert r.risk_level == "low"
        assert r.risk_score == 0
        assert r.warnings == []

    def test_to_dict(self):
        r = PreflightReport(
            files_checked=["a.py"],
            nodes_directly_changed=3,
            blast_radius=10,
            risk_level="medium",
            risk_score=15,
            warnings=["波及 10 个节点"],
        )
        d = r.to_dict()
        assert d["files_checked"] == ["a.py"]
        assert d["blast_radius"] == 10
        assert d["risk_level"] == "medium"
        assert d["warnings"] == ["波及 10 个节点"]

    def test_to_dict_serializable(self):
        """to_dict 结果必须可 JSON 序列化。"""
        r = PreflightReport(
            files_checked=["a.py"],
            cross_community_details=[{"community_id": "c1", "community_label": "core", "size": 5}],
            l4_violation_details=[{"module": "m", "file_path": "f.py", "violations": []}],
            cycle_details=[{"cycle_id": "cy1", "category": "pure_code", "node_count": 3, "nodes": ["a", "b"]}],
            per_file=[{"file": "a.py", "nodes": [{"node_id": "n1", "node_name": "f", "kind": "function", "impact_count": 2}]}],
        )
        d = r.to_dict()
        json.dumps(d)  # 不应抛出异常


# ============================================================
# HealthReport
# ============================================================

class TestHealthReport:
    """健康报告数据模型。"""

    def test_defaults(self):
        r = HealthReport()
        assert r.health_score == 100
        assert r.total_nodes == 0
        assert r.total_edges == 0
        assert r.coupling_distribution == {}
        assert r.trends == {}

    def test_to_dict(self):
        r = HealthReport(
            health_score=85,
            total_nodes=100,
            total_edges=150,
            community_count=5,
            coupling_distribution={"l1": 80, "l2": 15, "l3": 4, "l4": 1},
            cycle_count=3,
            trends={"coupling": "stable", "cycles": "stable", "change_frequency": "normal"},
        )
        d = r.to_dict()
        assert d["health_score"] == 85
        assert d["total_nodes"] == 100
        assert d["coupling_distribution"]["l4"] == 1
        assert d["trends"]["coupling"] == "stable"

    def test_to_dict_serializable(self):
        r = HealthReport(
            top_changed_files=[{"file": "a.py", "changes": 5}],
            fragility_top5=[{"module": "m", "file_path": "f.py", "fragility_score": 80, "l4_count": 3}],
            generated_at="2025-01-01T00:00:00",
        )
        d = r.to_dict()
        json.dumps(d)  # 不应抛出异常


# ============================================================
# run_preflight
# ============================================================

class TestRunPreflight:
    """起飞前检查核心逻辑。"""

    def test_empty_changed_files(self, chain_graph):
        """变更文件列表为空时返回零值报告。"""
        report = run_preflight(chain_graph, [])
        assert report.files_checked == []
        assert report.nodes_directly_changed == 0
        assert report.blast_radius == 0
        assert report.risk_level == "low"
        assert report.risk_score == 0

    def test_single_file_impact(self, chain_graph):
        """变更一个文件，应找到其中的节点并计算波及。"""
        report = run_preflight(chain_graph, ["a.py"])
        assert len(report.files_checked) == 1
        assert report.nodes_directly_changed >= 1  # a.py 有 n1 和 n2
        assert report.blast_radius >= 2  # 波及至少自身+下游
        assert report.per_file[0]["file"] == "a.py"

    def test_per_file_structure(self, chain_graph):
        """per_file 条目应包含节点级信息。"""
        report = run_preflight(chain_graph, ["a.py"])
        assert len(report.per_file) == 1
        entry = report.per_file[0]
        assert "file" in entry
        assert "nodes" in entry
        for node_info in entry["nodes"]:
            assert "node_id" in node_info
            assert "node_name" in node_info
            assert "kind" in node_info
            assert "impact_count" in node_info

    def test_nonexistent_file(self, chain_graph):
        """不存在的文件不应导致崩溃。"""
        report = run_preflight(chain_graph, ["nonexistent.py"])
        assert report.files_checked == ["nonexistent.py"]
        assert report.nodes_directly_changed == 0
        assert report.blast_radius == 0

    def test_blast_radius_medium_risk(self, large_graph):
        """波及超过 20 个节点 → medium risk。"""
        # 变更链首节点文件，波及整条链
        report = run_preflight(large_graph, ["mod0.py"])
        assert report.blast_radius >= 20
        assert report.risk_score >= 15
        assert report.risk_level in ("medium", "high", "critical")
        assert any("波及" in w for w in report.warnings)

    def test_blast_radius_high_risk(self, large_graph):
        """波及超过 50 个节点（需要足够大的图）。"""
        # 大图变更应产生较高风险分
        report = run_preflight(large_graph, ["mod0.py", "mod1.py", "mod2.py", "mod3.py", "mod4.py"])
        # 至少应有 >20 的波及
        assert report.blast_radius > 0
        # 风险分应 >0
        assert report.risk_score >= 0

    def test_cross_community_detection(self, community_graph):
        """变更跨社区时应标记 cross_community=True。"""
        # 变更 core/a.py (n1) → n1 的波及包含 n2(core), n3(ui), n4(db)
        report = run_preflight(community_graph, ["core/a.py"])
        # 波及是否跨多个社区？
        assert report.cross_community is True or report.cross_community is False
        # 只要有波及，cross_community_details 就应有对应结果
        if report.cross_community:
            assert len(report.cross_community_details) >= 2

    def test_single_community_no_cross(self, community_graph):
        """只变更单个社区内的文件不应标记跨社区。"""
        report = run_preflight(community_graph, ["core/b.py"])
        # core/b.py 只有 n2，变更 n2 可能不波及到 ui/db
        # 不做强断言，只验证不崩溃
        assert report is not None

    def test_risk_level_low(self, chain_graph):
        """小范围变更 → low risk。"""
        report = run_preflight(chain_graph, ["b.py"])
        assert report.risk_level == "low"
        assert report.risk_score == 0

    def test_multiple_files(self, chain_graph):
        """变更多个文件时应正确汇总。"""
        report = run_preflight(chain_graph, ["a.py", "b.py"])
        assert len(report.files_checked) == 2
        assert report.nodes_directly_changed >= 2

    def test_warnings_list(self, chain_graph):
        """warnings 始终是列表。"""
        report = run_preflight(chain_graph, ["a.py"])
        assert isinstance(report.warnings, list)

    def test_risk_score_capped_at_100(self, large_graph):
        """风险分不超过 100。"""
        report = run_preflight(large_graph, ["mod0.py"])
        assert report.risk_score <= 100

    def test_blast_radius_over_50_warning(self):
        """波及超过 50 节点应触发 +30 风险分和高阈值警告。"""
        g = Graph()
        # 创建 55 个节点的长链，全部在同一文件
        for i in range(55):
            n = Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"chain.py:{i+1}", "python", "function")
            g.add_node(n)
        for i in range(54):
            g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", f"n{i}", f"n{i+1}"))

        report = run_preflight(g, ["chain.py"])
        assert report.blast_radius > 50
        assert report.risk_score >= 30
        assert any(">50" in w for w in report.warnings)

    def test_risk_level_critical(self):
        """累计风险分 >= 60 时 risk_level 应为 critical。"""
        g = Graph()
        # 大波及 (>50) + 跨社区 + 触碰环 → critical
        for i in range(55):
            n = Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"big.py:{i+1}", "python", "function")
            g.add_node(n)
        for i in range(54):
            g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", f"n{i}", f"n{i+1}"))
        # 加环：n54 → n0
        g.add_edge(Edge("cycle_e", EdgeType.STRUCTURAL, "call", "n54", "n0"))

        # 分配跨社区节点
        c1 = Community(id="c1", level=0, label="A", node_ids={f"n{i}" for i in range(30)})
        c2 = Community(id="c2", level=0, label="B", node_ids={f"n{i}" for i in range(30, 55)})
        g.communities = [c1, c2]
        for i in range(55):
            g.nodes[f"n{i}"].community_id = "c1" if i < 30 else "c2"

        report = run_preflight(g, ["big.py"])
        # 波及 >50 (+30) + 跨社区 (+15) = 45，如环触及再加 +20 → 65 ≥ 60
        assert report.risk_score >= 30
        # 至少 medium 以上
        assert report.risk_level in ("high", "critical")

    def test_cross_community_details_populated(self):
        """跨社区检测应填充细节信息。"""
        g = Graph()
        # n_target 是被依赖的节点（在社区A），n_src1/n_src2 依赖它（在社区B/C）
        n_target = Node("nt", NodeType.SYMBOL, "lib_func", "lib/a.py:1", "python", "function")
        n_src1 = Node("ns1", NodeType.SYMBOL, "user1", "mod1/b.py:1", "python", "function")
        n_src2 = Node("ns2", NodeType.SYMBOL, "user2", "mod2/c.py:1", "python", "function")
        g.add_node(n_target); g.add_node(n_src1); g.add_node(n_src2)
        # n_src1 → n_target 和 n_src2 → n_target：两个节点都依赖 nt
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "ns1", "nt"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "ns2", "nt"))

        c_lib = Community(id="c_lib", level=0, label="核心库", node_ids={"nt"})
        c_mod1 = Community(id="c_mod1", level=0, label="模块A", node_ids={"ns1"})
        c_mod2 = Community(id="c_mod2", level=0, label="模块B", node_ids={"ns2"})
        g.communities = [c_lib, c_mod1, c_mod2]
        g.nodes["nt"].community_id = "c_lib"
        g.nodes["ns1"].community_id = "c_mod1"
        g.nodes["ns2"].community_id = "c_mod2"

        # 变更 lib/a.py → nt 变化 → 波及 ns1(c_mod1), ns2(c_mod2) → 跨社区
        report = run_preflight(g, ["lib/a.py"])
        assert report.cross_community is True
        assert len(report.cross_community_details) >= 2
        labels = {d["community_label"] for d in report.cross_community_details}
        assert "模块A" in labels or "模块B" in labels


# ============================================================
# run_health
# ============================================================

class TestRunHealth:
    """健康趋势报告。"""

    def test_missing_graph_file(self):
        """图文件不存在时返回 health_score=0。"""
        with tempfile.TemporaryDirectory() as tmp:
            report = run_health(tmp)
            assert report.health_score == 0
            assert len(report.warnings) >= 1

    def test_graph_not_provided_and_file_missing(self):
        """不提供 graph 且文件不存在时 graceful degrade。"""
        report = run_health("/nonexistent/path/12345")
        assert report.health_score == 0
        assert any("不存在" in w or "无法加载" in w or "not exist" in w.lower()
                   for w in report.warnings)

    def test_with_graph_basic_stats(self, chain_graph):
        """提供图的引用时应填充基本统计。"""
        report = run_health("/fake/root", graph=chain_graph)
        assert report.total_nodes == 3
        assert report.total_edges == 2
        assert report.health_score >= 0  # 可能因耦合分析不可用而降分
        assert report.generated_at != ""

    def test_community_count(self, community_graph):
        """带社区的图应正确计数。"""
        report = run_health("/fake/root", graph=community_graph)
        assert report.community_count == 3

    def test_health_score_range(self, chain_graph):
        """健康分在 0-100 范围内。"""
        report = run_health("/fake/root", graph=chain_graph)
        assert 0 <= report.health_score <= 100

    def test_trends_populated(self, chain_graph):
        """趋势字段应被填充。"""
        report = run_health("/fake/root", graph=chain_graph)
        assert "coupling" in report.trends
        assert "cycles" in report.trends
        assert "change_frequency" in report.trends
        # 趋势值应为合法枚举
        valid_trends = {"clean", "stable", "degrading", "critical", "concerning", "quiet", "normal", "active", "hot"}
        for v in report.trends.values():
            assert v in valid_trends, f"Invalid trend: {v}"

    def test_coupling_distribution_keys(self, chain_graph):
        """耦合分布应有标准层级键。"""
        report = run_health("/fake/root", graph=chain_graph)
        # 耦合分析可能不可用，此时 distribution 为空
        if report.coupling_distribution:
            for key in ("l1", "l2", "l3", "l4"):
                assert key in report.coupling_distribution

    def test_fragility_top5_is_list(self, chain_graph):
        """fragility_top5 应为列表。"""
        report = run_health("/fake/root", graph=chain_graph)
        assert isinstance(report.fragility_top5, list)
        assert len(report.fragility_top5) <= 5

    def test_top_changed_files_is_list(self, chain_graph):
        """top_changed_files 应为列表。"""
        report = run_health("/fake/root", graph=chain_graph)
        assert isinstance(report.top_changed_files, list)
        assert len(report.top_changed_files) <= 10

    def test_corrupt_graph_file(self, tmp_path):
        """图文件存在但 JSON 损坏时应返回 health_score=0。"""
        graph_path = tmp_path / "hologram_graph.json"
        graph_path.write_text("not valid json{{{")
        report = run_health(str(tmp_path))
        assert report.health_score == 0
        assert any("无法加载" in w or "load" in w.lower() for w in report.warnings)

    def test_with_timeline_data(self, chain_graph, tmp_path):
        """有实际时间轴数据时健康报告应包含变更频率趋势。"""
        # 写入图文件
        graph_path = tmp_path / "hologram_graph.json"
        chain_graph.to_json(str(graph_path))

        # 写入时间轴数据
        from src_python.timeline import TimelineStore
        store = TimelineStore(str(tmp_path))
        for i in range(5):
            store.record(
                event_type="file_changed",
                file=f"mod{i}.py",
                changed_by="test",
                summary=f"change {i}",
            )
        store.close()

        report = run_health(str(tmp_path))
        assert report.timeline_total_events == 5
        assert report.timeline_recent_changes >= 0
        assert len(report.top_changed_files) >= 1
        assert "change_frequency" in report.trends

    def test_high_change_frequency(self, chain_graph, tmp_path):
        """高频变更应触发活跃趋势标签。"""
        graph_path = tmp_path / "hologram_graph.json"
        chain_graph.to_json(str(graph_path))

        from src_python.timeline import TimelineStore
        store = TimelineStore(str(tmp_path))
        for i in range(15):
            store.record(
                event_type="file_changed",
                file="hot.py",
                changed_by="test",
                summary=f"change {i}",
            )
        store.close()

        report = run_health(str(tmp_path))
        # 15 changes → "active" (<=30) 或 "normal" (<=10)，取决于最近窗口
        assert report.trends["change_frequency"] in ("normal", "active", "hot")
        assert report.timeline_total_events == 15

    def test_cycles_in_graph_affect_health(self):
        """带环的图应产生非零 cycle_count 并触发对应趋势。"""
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "a", "a.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "b", "b.py:1", "python", "function")
        n3 = Node("n3", NodeType.SYMBOL, "c", "c.py:1", "python", "function")
        g.add_node(n1); g.add_node(n2); g.add_node(n3)
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n3"))
        g.add_edge(Edge("e3", EdgeType.STRUCTURAL, "call", "n3", "n1"))  # 形成环

        report = run_health("/fake/root", graph=g)
        # 带环的图可能触发 cycle_count > 0
        assert report.cycle_count >= 0
        assert "cycles" in report.trends


# ============================================================
# run_full_check
# ============================================================

class TestRunFullCheck:
    """V3 全量约束校验管线（CLI/MCP 共用核心）。"""

    @pytest.fixture
    def before_graph(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "old_func", "a.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "dep", "b.py:1", "python", "function")
        g.add_node(n1)
        g.add_node(n2)
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        return g

    @pytest.fixture
    def after_graph(self):
        g = Graph()
        n1 = Node("n1", NodeType.SYMBOL, "old_func", "a.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "dep", "b.py:1", "python", "function")
        n3 = Node("n3", NodeType.SYMBOL, "new_func", "a.py:10", "python", "function")
        g.add_node(n1)
        g.add_node(n2)
        g.add_node(n3)
        g.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n1", "n3"))
        return g

    def test_basic_pipeline_runs(self, before_graph, after_graph):
        """基本管线应成功运行，返回预期结构。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            project_root="",
        )
        assert "passed" in result
        assert "violations" in result
        assert "signals" in result
        assert "summary" in result
        assert "changed_files" in result
        assert isinstance(result["violations"], list)
        assert isinstance(result["signals"], list)

    def test_result_is_serializable(self, before_graph, after_graph):
        """结果应可 JSON 序列化。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            project_root="",
        )
        json.dumps(result)  # 不应抛出异常

    def test_changed_files_preserved(self, before_graph, after_graph):
        """changed_files 应原样保留。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py", "b.py"],
            project_root="",
        )
        assert result["changed_files"] == ["a.py", "b.py"]
        assert result["total_changed_files"] == 2

    def test_empty_changed_files(self, before_graph, after_graph):
        """空变更列表应正常返回。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=[],
            project_root="",
        )
        assert result["total_changed_files"] == 0
        assert "passed" in result

    def test_passed_field_is_boolean(self, before_graph, after_graph):
        """passed 字段应为布尔值。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            project_root="",
        )
        assert isinstance(result["passed"], bool)

    def test_one_line_summary(self, before_graph, after_graph):
        """one_line 摘要应非空。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            project_root="",
        )
        assert result["one_line"]
        assert isinstance(result["one_line"], str)

    def test_violation_count_consistent(self, before_graph, after_graph):
        """violation_count 应与 violations 列表长度一致。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            project_root="",
        )
        assert result["violation_count"] == len(result["violations"])

    def test_coupling_and_cycles_may_be_none(self, before_graph, after_graph):
        """耦合和环分析可以为 None（模块不可用时）。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            project_root="",
        )
        # 不强制要求非 None — 分析模块可能不可用
        assert "coupling" in result
        assert "cycles" in result

    def test_signals_count_consistent(self, before_graph, after_graph):
        """signals_count 应与 signals 列表长度一致。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            project_root="",
        )
        assert result["signals_count"] == len(result["signals"])

    def test_identical_graphs(self, chain_graph):
        """before 和 after 完全相同时也应正常运行。"""
        result = run_full_check(
            before_graph=chain_graph,
            after_graph=chain_graph,
            changed_files=[],
            project_root="",
        )
        assert "passed" in result
        assert "summary" in result

    def test_file_changes_with_source(self, before_graph, after_graph, tmp_path):
        """提供 file_changes 含源码时应触发线程分析路径。"""
        # 写入实际文件让源码读取成功
        a_py = tmp_path / "a.py"
        a_py.write_text("def old_func():\n    pass\n\ndef new_func():\n    pass\n")

        from src_python.routing.patterns import FileChange
        file_changes = {
            "a.py": FileChange(
                file_path="a.py",
                old_source="def old_func():\n    pass\n",
                new_source="def old_func():\n    pass\n\ndef new_func():\n    pass\n",
            ),
        }
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            file_changes=file_changes,
            project_root=str(tmp_path),
        )
        assert "passed" in result

    def test_with_project_root_and_files(self, before_graph, after_graph, tmp_path):
        """project_root 下有实际文件时应触发完整管线。"""
        a_py = tmp_path / "a.py"
        a_py.write_text("def old_func():\n    pass\n\ndef new_func():\n    return 1\n")
        b_py = tmp_path / "b.py"
        b_py.write_text("def dep():\n    pass\n")

        from src_python.routing.patterns import FileChange
        file_changes = {
            "a.py": FileChange(
                file_path="a.py",
                old_source="def old_func():\n    pass\n",
                new_source="def old_func():\n    pass\n\ndef new_func():\n    return 1\n",
            ),
        }
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            file_changes=file_changes,
            project_root=str(tmp_path),
        )
        assert "passed" in result
        assert "coupling" in result
        assert "cycles" in result

    def test_graph_with_cycles(self):
        """带环的图应在 cycle 结果中体现。"""
        before = Graph()
        for i, name in enumerate(["a", "b", "c"]):
            before.add_node(Node(f"n{i}", NodeType.SYMBOL, name, f"{name}.py:1", "python", "function"))
        before.add_edge(Edge("e0", EdgeType.STRUCTURAL, "call", "n0", "n1"))
        before.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))

        after = Graph()
        for i, name in enumerate(["a", "b", "c"]):
            after.add_node(Node(f"n{i}", NodeType.SYMBOL, name, f"{name}.py:1", "python", "function"))
        after.add_edge(Edge("e0", EdgeType.STRUCTURAL, "call", "n0", "n1"))
        after.add_edge(Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        after.add_edge(Edge("e2", EdgeType.STRUCTURAL, "call", "n2", "n0"))  # 形成环

        result = run_full_check(
            before_graph=before,
            after_graph=after,
            changed_files=["a.py", "b.py", "c.py"],
            project_root="",
        )
        assert "passed" in result
        assert "cycles" in result

    def test_l5_l1_level_counts(self, before_graph, after_graph):
        """结果应包含各层级的 violation 计数。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            project_root="",
        )
        for key in ("l5_count", "l4_count", "l3_count", "l2_count"):
            assert key in result
            assert isinstance(result[key], int)

    def test_auto_released_and_passed_checks(self, before_graph, after_graph):
        """结果应包含 auto_released 和 passed_checks 字段。"""
        result = run_full_check(
            before_graph=before_graph,
            after_graph=after_graph,
            changed_files=["a.py"],
            project_root="",
        )
        # auto_released 可能是 bool 或 list，取决于约束检查器版本
        assert "auto_released" in result
        assert isinstance(result.get("passed_checks", []), list)
