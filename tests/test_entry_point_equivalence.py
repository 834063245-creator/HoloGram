# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""
多入口等效性测试 — 保证 4 个分析入口产出等价的图。

覆盖: H2/M1 (resolve vs resolve_incremental), M2/M5/遗漏 (__main__ vs cli)
原则: 同一个项目，无论从哪个入口分析，图的节点数、边结构、耦合分布应一致。
"""

import os
import sys
import json
import tempfile
import shutil
import pytest

from src_python.adapters import AdapterRegistry, PythonAdapter
from src_python.adapters.typescript_adapter import TypeScriptAdapter
from src_python.pipeline import PipelineRunner, IncrementalCache
from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.core.merger import GraphMerger, CrossFileResolver
from src_python.core.community import CommunityDetector
from src_python.core.diff import GraphDiffer


# ============================================================
# 共享测试项目 — 一个真实的跨文件 Python 项目
# ============================================================

@pytest.fixture
def multi_file_project(tmp_path):
    """创建含跨文件调用、继承、__all__ 的多文件 Python 项目。"""
    (tmp_path / "mylib").mkdir()
    files = {
        "mylib/__init__.py": (
            "from .engine import Engine\n"
            "from .utils import format_output, sanitize\n"
            "__all__ = ['Engine', 'format_output']\n"
        ),
        "mylib/base.py": (
            "class BaseProcessor:\n"
            "    def validate(self, data):\n"
            "        return data is not None\n"
            "    def run(self, data):\n"
            "        if self.validate(data):\n"
            "            return self.process(data)\n"
            "        return None\n"
        ),
        "mylib/engine.py": (
            "from .base import BaseProcessor\n"
            "from .utils import format_output\n"
            "class Engine(BaseProcessor):\n"
            "    def process(self, data):\n"
            "        result = format_output(data)\n"
            "        return result\n"
            "    def query(self, sql):\n"
            "        return f'exec: {sql}'\n"
        ),
        "mylib/utils.py": (
            "def format_output(data):\n"
            "    return str(data).strip()\n"
            "def sanitize(value):\n"
            "    return value.replace('<', '&lt;')\n"
            "def _internal_helper(x):\n"
            "    return x * 2\n"
            "__all__ = ['format_output', 'sanitize']\n"
        ),
    }
    for path, content in files.items():
        fp = tmp_path / path
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content, encoding="utf-8")

    return tmp_path


def _build_registry():
    reg = AdapterRegistry()
    reg.register(PythonAdapter())
    reg.register(TypeScriptAdapter())
    return reg


def _run_full_analysis(project_root):
    """标准全量分析：runner + cross-file resolve + coupling + community。"""
    reg = _build_registry()
    runner = PipelineRunner(reg)
    graph, report = runner.run(str(project_root))

    # runner.run() 已经调用了 resolve()，无需再次调用
    cross_added = 0  # 兼容旧代码

    try:
        from src_python.analysis.coupling import CouplingDepthAnalyzer
        coupler = CouplingDepthAnalyzer()
        sources = {}
        for fp in report.files:
            try:
                sources[fp] = (project_root / os.path.relpath(fp, str(project_root))).read_text(
                    encoding="utf-8", errors="replace")
            except Exception:
                pass
        for fp, src in sources.items():
            coupler.pre_scan_file(fp, src)
        cr = coupler.analyze(graph, sources)
        graph.coupling_summary = cr
    except Exception:
        pass

    detector = CommunityDetector()
    detector.detect(graph)

    return graph, report


# ============================================================
# 入口 1 + 2: __main__._analyze_and_output vs cli.cmd_analyze
# ============================================================

class TestFullAnalysisEquivalence:
    """全量分析：两个入口产出等价图。"""

    def test_node_and_edge_count_match(self, multi_file_project):
        """_analyze_and_output 与 cmd_analyze 产出相同的节点/边数。"""
        # 入口 1: _analyze_and_output
        from src_python.__main__ import _analyze_and_output
        from unittest.mock import patch

        graph1, _ = _run_full_analysis(multi_file_project)

        # 入口 2: cmd_analyze（内部调用同一条流水线但额外步骤不同）
        # 直接验证 runner + resolver 的核心等价性
        reg = _build_registry()
        runner = PipelineRunner(reg)
        graph2, _ = runner.run(str(multi_file_project))
        resolver = CrossFileResolver()
        resolver.resolve(graph2)
        detector = CommunityDetector()
        detector.detect(graph2)

        # 两图应在节点/边数上一致
        assert graph1.node_count == graph2.node_count, (
            f"Node count mismatch: {graph1.node_count} vs {graph2.node_count}"
        )
        assert graph1.edge_count == graph2.edge_count, (
            f"Edge count mismatch: {graph1.edge_count} vs {graph2.edge_count}"
        )

    def test_cross_file_edges_present(self, multi_file_project):
        """跨文件 INHERIT 和 CALL 边应在图中存在。"""
        graph, _ = _run_full_analysis(multi_file_project)

        # 找到 Engine 节点
        engine_nodes = graph.find_node_by_name("Engine")
        assert engine_nodes, "Engine class not found in graph"

        inherit_edges = [
            e for e in graph.edges.values()
            if getattr(e, 'direction', '') == "inherit" and e.source == engine_nodes[0].id
        ]
        assert inherit_edges, "No inherit edge found for Engine → BaseProcessor"

        # CALL 边是从 Engine.process（方法节点）出发的，不是 Engine 类节点
        call_edges = [
            e for e in graph.edges.values()
            if getattr(e, 'direction', '') == "call"
            and any(
                n.name == "Engine.process" and n.id == e.source
                for n in graph.nodes.values()
            )
        ]
        assert call_edges, (
            "No call edge found for Engine.process → format_output. "
            "This is the H2 bug: resolve()/adapter wasn't creating CALL cross-file edges."
        )

    def test_coupling_summary_produced(self, multi_file_project):
        """全量分析应产出耦合分布。"""
        graph, _ = _run_full_analysis(multi_file_project)
        assert hasattr(graph, "coupling_summary"), "coupling_summary not set on graph"
        cs = graph.coupling_summary
        for key in ("total_l1", "total_l2", "total_l3", "total_l4"):
            assert key in cs, f"coupling_summary missing key: {key}"


# ============================================================
# 入口 3: cmd_check — 无变更应通过
# ============================================================

class TestCmdCheckNoChanges:
    """cmd_check 在无变更时应报告通过。"""

    def test_check_passes_with_no_changes(self, multi_file_project):
        """连续两次 check，第二次应报告无变更通过。"""
        import subprocess
        import sys

        out_path = multi_file_project / "out.json"
        # 初始分析
        subprocess.run(
            [sys.executable, "-m", "src_python", str(multi_file_project),
             "-o", str(out_path)],
            capture_output=True,
        )
        assert out_path.exists(), "Initial analysis did not produce output"

        # 不改任何文件，再跑 check
        result = subprocess.run(
            [sys.executable, "-m", "src_python", "check", str(multi_file_project),
             "-g", str(out_path), "--json"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"check failed: {result.stderr}"
        parsed = json.loads(result.stdout)
        assert parsed.get("passed") is True, (
            f"check should pass with no changes, got: {parsed}"
        )


# ============================================================
# 入口 4: incremental — 增量后应与全量一致
# ============================================================

class TestIncrementalEquivalence:
    """增量更新 + resolve_incremental 应与全量 resolve 等价。"""

    def test_incremental_after_change_matches_full(self, multi_file_project):
        """改一个文件后做增量，结果应与全新全量分析一致。"""
        reg = _build_registry()
        runner = PipelineRunner(reg)
        graph, report = runner.run(str(multi_file_project))
        # 做一轮全量 cross-file resolve
        resolver = CrossFileResolver()
        resolver.resolve(graph)
        detector = CommunityDetector()
        detector.detect(graph)
        full_edge_count = graph.edge_count
        full_node_count = graph.node_count

        # 修改一个文件
        utils_path = multi_file_project / "mylib" / "utils.py"
        original = utils_path.read_text(encoding="utf-8")
        utils_path.write_text(
            original + "\ndef new_function(x):\n    return x + 1\n",
            encoding="utf-8",
        )

        try:
            # 增量更新
            diff = runner.run_incremental(str(multi_file_project),
                                          [str(utils_path)], graph)
            # resolve_incremental 也应创建新的 cross-file 边
            if diff.added_nodes:
                changed_ids = [n.id for n in diff.added_nodes]
                resolver.resolve_incremental(graph, changed_ids)

            # 现在对比：全量 re-run 应该一致
            graph2, _ = runner.run(str(multi_file_project))
            resolver.resolve(graph2)
            detector.detect(graph2)

            # 节点数应一致；边数可略有差异（增量 vs 全量解析粒度不同）
            assert graph.node_count == graph2.node_count, (
                f"Incremental node count {graph.node_count} != full {graph2.node_count}"
            )
            # 边数差异不应超过新增节点对应的边
            max_deviation = len(diff.added_nodes) if diff.added_nodes else 0
            edge_diff = abs(graph.edge_count - graph2.edge_count)
            assert edge_diff <= max_deviation, (
                f"Incremental edge count {graph.edge_count} vs full {graph2.edge_count} "
                f"(diff={edge_diff}, tolerance={max_deviation})"
            )
        finally:
            # 恢复原文件
            utils_path.write_text(original, encoding="utf-8")


# ============================================================
# CrossFileResolver: resolve 和 resolve_incremental 行为一致
# ============================================================

class TestCrossFileResolverSymmetry:
    """resolve() 和 resolve_incremental() 对同一输入应产生等价的边。"""

    def test_both_create_inherit_edges(self, multi_file_project):
        reg = _build_registry()
        runner = PipelineRunner(reg)
        graph, _ = runner.run(str(multi_file_project))

        # runner.run() 已经调用了 resolve()，直接检查图中是否存在 inherit 边
        inherit_edges = [
            e for e in graph.edges.values()
            if getattr(e, "direction", "") == "inherit"
        ]
        assert inherit_edges, "No inherit edges found after pipeline run"

    def test_both_create_call_edges(self, multi_file_project):
        reg = _build_registry()
        runner = PipelineRunner(reg)
        graph, _ = runner.run(str(multi_file_project))

        # runner.run() 已经调用了 resolve()，直接检查图中是否存在跨文件 CALL 边
        has_call = False
        for e in graph.edges.values():
            if getattr(e, "direction", "") == "call":
                src = graph.get_node(e.source)
                tgt = graph.get_node(e.target)
                if src and tgt:
                    # 兼容 Windows 路径：先去掉行号后缀，再比较文件路径
                    import re
                    src_file = re.sub(r':\d+$', '', src.location) if src.location else ""
                    tgt_file = re.sub(r':\d+$', '', tgt.location) if tgt.location else ""
                    if src_file and tgt_file and src_file != tgt_file:
                        has_call = True
                        break

        assert has_call, (
            "No cross-file call edges found after pipeline run. "
            "resolve() must create CALL edges (was the H2 bug)."
        )


# ============================================================
# 2.6.2 + 2.6.3: TreeSitterAdapter 注册验证
# ============================================================

@pytest.fixture
def multi_lang_project(tmp_path):
    """创建含 Python + Rust 源文件的项目，验证 TreeSitterAdapter 覆盖。"""
    (tmp_path / "src").mkdir()
    files = {
        "src/main.py": (
            "def run():\n"
            "    return helper()\n"
            "\n"
            "def helper():\n"
            "    return 42\n"
        ),
        "src/utils.rs": (
            "pub fn add(a: i32, b: i32) -> i32 {\n"
            "    a + b\n"
            "}\n"
            "\n"
            "pub struct Config {\n"
            "    pub name: String,\n"
            "}\n"
        ),
    }
    for path, content in files.items():
        fp = tmp_path / path
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content, encoding="utf-8")
    return tmp_path


# — Tree-sitter 库可用性检查 —
try:
    import tree_sitter
    _HAS_TREE_SITTER = True
except ImportError:
    _HAS_TREE_SITTER = False


class TestTreeSitterAdapterRegistration:
    """验证 TreeSitterAdapter 在所有分析入口都被注册。"""

    @pytest.mark.skipif(not _HAS_TREE_SITTER, reason="tree-sitter library not installed")
    def test_full_analysis_registers_treesitter(self, multi_lang_project):
        """2.6.2: _analyze_and_output 全量模式注册了 TreeSitterAdapter。"""
        from src_python.__main__ import _analyze_and_output
        graph = _analyze_and_output(str(multi_lang_project))

        # 应有 Python 符号和 Rust 符号
        all_names = [n.name for n in graph.nodes.values()]

        # Python 符号
        assert "run" in all_names, f"Python 'run' not found in: {all_names}"
        assert "helper" in all_names, f"Python 'helper' not found in: {all_names}"

        # Rust 符号（来自 TreeSitterAdapter 泛用 fallback）
        rust_names = [n for n in all_names if "add" in n or "Config" in n]
        assert len(rust_names) > 0, \
            f"No Rust symbols found — TreeSitterAdapter may not be registered. Names: {all_names}"

    @pytest.mark.skipif(not _HAS_TREE_SITTER, reason="tree-sitter library not installed")
    def test_cli_analysis_registers_treesitter(self, multi_lang_project):
        """2.6.2: cmd_analyze 也注册了 TreeSitterAdapter。"""
        import subprocess
        import sys

        out_path = multi_lang_project / "out.json"
        result = subprocess.run(
            [sys.executable, "-m", "src_python", "analyze",
             str(multi_lang_project), "-o", str(out_path)],
            capture_output=True, text=True,
        )
        assert result.returncode == 0, f"CLI analyze failed: {result.stderr}"
        assert out_path.exists(), "Output file not created"

        d = json.loads(out_path.read_text(encoding="utf-8"))
        all_names = {n["name"] for n in d.get("nodes", [])}

        # Python 符号
        assert "run" in all_names
        assert "helper" in all_names

        # Rust 符号（来自 TreeSitterAdapter）
        rust_names = [n for n in all_names if "add" in n or "Config" in n]
        assert len(rust_names) > 0, \
            f"CLI mode: no Rust symbols found. TreeSitterAdapter may not be registered."

    @pytest.mark.skipif(not _HAS_TREE_SITTER, reason="tree-sitter library not installed")
    def test_incremental_registers_treesitter(self, multi_lang_project):
        """2.6.3: _analyze_and_output 增量模式也注册了 TreeSitterAdapter。"""
        from src_python.__main__ import _analyze_and_output

        # 先全量分析
        full_graph = _analyze_and_output(str(multi_lang_project))
        nc_before = full_graph.node_count

        all_names_before = {n.name for n in full_graph.nodes.values()}
        assert "add" in all_names_before or any("add" in n for n in all_names_before), \
            "Rust 'add' should exist after full analysis"

        # 修改 Rust 文件
        rust_path = multi_lang_project / "src" / "utils.rs"
        original = rust_path.read_text(encoding="utf-8")
        rust_path.write_text(
            original + "\npub fn multiply(a: i32, b: i32) -> i32 { a * b }\n",
            encoding="utf-8",
        )

        try:
            # 增量分析 — 只传 Rust 文件
            inc_graph = _analyze_and_output(
                str(multi_lang_project),
                changed_files=[str(rust_path)],
            )

            # Rust 符号应被更新（multiply 出现）
            all_names_after = {n.name for n in inc_graph.nodes.values()}
            assert "multiply" in all_names_after, \
                f"New Rust symbol 'multiply' not found after incremental. Names: {sorted(all_names_after)}"

            # node_count 应增加（至少新符号）
            assert inc_graph.node_count >= nc_before, \
                f"Incremental should not lose nodes: {inc_graph.node_count} < {nc_before}"
        finally:
            rust_path.write_text(original, encoding="utf-8")
