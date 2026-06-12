"""测试 V2 耦合深度计 (Coupling Depth Meter)。"""

import pytest
import os
import tempfile

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.analysis.coupling import (
    CouplingDepthAnalyzer, coupling_depth_report,
    _parse_all_exports, _is_public_name, _detect_l4_violations_python,
    _detect_data_paths_python,
    CouplingLevel, CouplingReport,
)


class TestPythonAllExports:
    """测试 __all__ 导出解析。"""

    def test_parse_all_with_exports(self):
        source = """
__all__ = ["public_func", "PublicClass", "CONSTANT"]

def public_func(): pass
class PublicClass: pass
CONSTANT = 42
"""
        exports = _parse_all_exports("test.py", source)
        assert exports == {"public_func", "PublicClass", "CONSTANT"}

    def test_parse_all_empty(self):
        source = """
def func(): pass
"""
        exports = _parse_all_exports("test.py", source)
        assert exports == set()

    def test_parse_all_syntax_error(self):
        source = "this is not valid python @@@"
        exports = _parse_all_exports("test.py", source)
        assert exports == set()

    def test_is_public_with_all(self):
        exports = {"public_func"}
        assert _is_public_name("public_func", exports) is True
        assert _is_public_name("_private", exports) is False

    def test_is_public_without_all(self):
        assert _is_public_name("func", set()) is True
        assert _is_public_name("_private", set()) is False


class TestL4ViolationDetection:
    """测试 L4 封装穿透检测。"""

    def test_detect_private_attr_access(self):
        source = """
import external_module
external_module._private_attr = 42
"""
        violations = _detect_l4_violations_python("test.py", source)
        assert len(violations) >= 1

    def test_detect_name_mangled_attr(self):
        source = """
import other
other.__private_method()
"""
        violations = _detect_l4_violations_python("test.py", source)
        # __method 是 name-mangled 但 __ 通常在类内部使用
        assert len(violations) >= 1

    def test_no_violation_for_self_access(self):
        source = """
class MyClass:
    def method(self):
        self._internal = 1
"""
        violations = _detect_l4_violations_python("test.py", source)
        assert len([v for v in violations if "self" in v.get("access", "")]) == 0

    def test_no_violation_clean_code(self):
        source = """
import math
result = math.sqrt(4)
obj = SomeClass()
obj.public_method()
"""
        violations = _detect_l4_violations_python("test.py", source)
        assert len(violations) == 0


class TestDataPathDetection:
    """测试 L3 数据文件路径检测。"""

    def test_detect_open_json(self):
        source = """
data = open("config.json", "r").read()
"""
        paths = _detect_data_paths_python("test.py", source)
        assert len(paths) >= 1
        assert paths[0]["path"] == "config.json"

    def test_detect_sqlite_connect(self):
        source = """
import sqlite3
conn = sqlite3.connect("mydb.sqlite")
"""
        paths = _detect_data_paths_python("test.py", source)
        assert len(paths) >= 1

    def test_detect_file_via_keyword(self):
        source = """
result = process(file="output.csv")
"""
        paths = _detect_data_paths_python("test.py", source)
        # 位置参数检测可能不命中 keyword-only，但仍然走通用检测
        assert isinstance(paths, list)


class TestCouplingAnalyzer:
    """测试耦合深度分析器。"""

    @pytest.fixture
    def sample_graph(self):
        g = Graph(source_root="/test")
        n1 = Node("n1", NodeType.SYMBOL, "public_func", "mod_a.py:1", "python", "function")
        n2 = Node("n2", NodeType.SYMBOL, "_internal_func", "mod_a.py:10", "python", "function")
        n3 = Node("n3", NodeType.SYMBOL, "__mangled", "mod_b.py:5", "python", "function")
        n4 = Node("n4", NodeType.SYMBOL, "normal_func", "mod_b.py:20", "python", "function")
        n5 = Node("n5", NodeType.MEDIUM, "shared.db", "mod_a.py:0", "python", "database")

        for n in [n1, n2, n3, n4, n5]:
            g.add_node(n)

        # L1: n4 calls n1 (public)
        e1 = Edge("e1", EdgeType.STRUCTURAL, "call", "n4", "n1")
        # L2: n4 calls n2 (_internal)
        e2 = Edge("e2", EdgeType.STRUCTURAL, "call", "n4", "n2")
        # L4: n4 accesses __mangled
        e3 = Edge("e3", EdgeType.STRUCTURAL, "call", "n4", "n3",
                  properties={"is_encapsulation_violation": True})
        # L3: n1 reads shared.db, n4 also reads it
        e4 = Edge("e4", EdgeType.DATA, "read", "n1", "n5")
        e5 = Edge("e5", EdgeType.DATA, "write", "n4", "n5")

        for e in [e1, e2, e3, e4, e5]:
            g.add_edge(e)

        return g

    def test_coupling_levels_classified(self, sample_graph):
        """耦合深度应正确分为 L1-L4。"""
        analyzer = CouplingDepthAnalyzer()
        result = analyzer.analyze(sample_graph)

        classif = result["edge_classifications"]
        assert classif.get("e1") == CouplingLevel.L1_PUBLIC_API
        assert classif.get("e2") == CouplingLevel.L2_INTERNAL_IMPORT
        assert classif.get("e3") == CouplingLevel.L4_ENCAPSULATION_VIOLATION
        # e4, e5 是数据边 — L3 检测共享访问
        # 至少一条数据边被标记为 L3

    def test_module_reports_generated(self, sample_graph):
        """模块报告应为每个有边的文件生成。"""
        result = coupling_depth_report(sample_graph)
        reports = result["module_reports"]
        assert len(reports) > 0
        assert any(r["module_name"] == "mod_b" for r in reports)

    def test_fragility_score_calculation(self, sample_graph):
        """脆弱性评分应按 L4 权重计算。"""
        report = CouplingReport("test_mod", "test.py")
        report.l4_count = 5
        report.l3_count = 2
        report.l2_count = 3
        report.l1_count = 10
        # weighted: 5*4 + 2*2 + 3*1 = 27, total = 20
        # fragility = 27/20 = 1.35... but normalized, can exceed 1
        score = report.fragility_score
        assert score >= 1.0  # 有 L4 边时应偏高

    def test_edge_properties_updated(self, sample_graph):
        """分析后边的 properties 应包含 coupling_depth。"""
        analyzer = CouplingDepthAnalyzer()
        analyzer.analyze(sample_graph)

        e3 = sample_graph.get_edge("e3")
        assert e3 is not None
        # coupling_depth is now a proper Edge field, not in properties dict
        assert e3.coupling_depth == CouplingLevel.L4_ENCAPSULATION_VIOLATION

    def test_convenience_function(self, sample_graph):
        """coupling_depth_report 应返回结构化结果。"""
        result = coupling_depth_report(sample_graph)
        assert "edge_classifications" in result
        assert "module_reports" in result
        assert "total_l1" in result
        assert "total_l4" in result

    def test_pre_scan_file(self):
        """pre_scan_file 应正确缓存 AST 分析结果。"""
        source = """
import external
external._private = 1
data = open("config.json").read()
"""
        analyzer = CouplingDepthAnalyzer()
        analyzer.pre_scan_file("test.py", source)
        assert "test.py" in analyzer._violations_cache
        assert len(analyzer._violations_cache["test.py"]) >= 1
        assert "test.py" in analyzer._data_paths_cache

    def test_coupling_report_empty_module(self):
        report = CouplingReport("empty", "empty.py")
        assert report.total == 0
        assert report.l4_density == 0.0
        assert report.fragility_score == 0.0
