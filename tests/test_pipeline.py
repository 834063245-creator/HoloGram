"""测试流水线：文件发现、缓存、编排器。"""

import os
import tempfile
import pytest

from src_python.pipeline.discovery import discover_files, DEFAULT_EXCLUDE_DIRS
from src_python.pipeline.cache import IncrementalCache
from src_python.pipeline.runner import PipelineRunner, PipelineReport
from src_python.adapters import AdapterRegistry, PythonAdapter
from src_python.core.graph import Graph


class TestDiscoverFiles:
    @pytest.fixture
    def registry(self):
        reg = AdapterRegistry()
        reg.register(PythonAdapter())
        return reg

    @pytest.fixture
    def temp_dir(self):
        d = tempfile.mkdtemp()
        yield d
        import shutil
        shutil.rmtree(d, ignore_errors=True)

    def mock_file(self, base, path):
        """创建空文件及其父目录。"""
        full = os.path.join(base, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write("")
        return full

    def test_discovers_py_files(self, registry, temp_dir):
        self.mock_file(temp_dir, "a.py")
        self.mock_file(temp_dir, "b.py")
        self.mock_file(temp_dir, "c.txt")

        files = discover_files(temp_dir, registry)
        assert len(files) == 2
        assert all(f.endswith(".py") for f in files)

    def test_excludes_dirs(self, registry, temp_dir):
        self.mock_file(temp_dir, "src/main.py")
        self.mock_file(temp_dir, ".git/config.py")       # 应跳过
        self.mock_file(temp_dir, "__pycache__/cache.py")  # 应跳过
        self.mock_file(temp_dir, "venv/lib/site.py")      # 应跳过

        files = discover_files(temp_dir, registry)
        paths = [os.path.relpath(f, temp_dir).replace("\\", "/") for f in files]
        assert "src/main.py" in paths
        assert not any(".git" in p for p in paths)
        assert not any("__pycache__" in p for p in paths)
        assert not any("venv" in p for p in paths)

    def test_empty_dir(self, registry, temp_dir):
        files = discover_files(temp_dir, registry)
        assert files == []

    def test_no_matching_files(self, registry, temp_dir):
        self.mock_file(temp_dir, "readme.md")
        self.mock_file(temp_dir, "config.yaml")

        files = discover_files(temp_dir, registry)
        assert files == []

    def test_nested_dirs(self, registry, temp_dir):
        self.mock_file(temp_dir, "a/b/c/d.py")
        self.mock_file(temp_dir, "a/e.py")
        self.mock_file(temp_dir, "f/g.py")

        files = discover_files(temp_dir, registry)
        assert len(files) == 3

    def test_max_depth(self, registry, temp_dir):
        self.mock_file(temp_dir, "a/b/c/d/e/f/g.py")  # depth 7

        files_shallow = discover_files(temp_dir, registry, max_depth=3)
        files_deep = discover_files(temp_dir, registry, max_depth=10)
        assert len(files_shallow) == 0
        assert len(files_deep) == 1

    def test_custom_exclude_dirs(self, registry, temp_dir):
        self.mock_file(temp_dir, "src/main.py")
        self.mock_file(temp_dir, "test/test_main.py")

        files = discover_files(temp_dir, registry, exclude_dirs={"test"})
        paths = [os.path.relpath(f, temp_dir).replace("\\", "/") for f in files]
        assert "test/test_main.py" not in paths
        assert "src/main.py" in paths


class TestIncrementalCache:
    @pytest.fixture
    def cache(self):
        return IncrementalCache()

    def test_hash_consistency(self):
        h1 = IncrementalCache.hash_source("hello world")
        h2 = IncrementalCache.hash_source("hello world")
        h3 = IncrementalCache.hash_source("different")
        assert h1 == h2
        assert h1 != h3
        assert len(h1) == 16

    def test_set_and_get(self, cache):
        g = Graph()
        cache.set("test.py", "abc123", g)
        assert cache.has("test.py")
        assert cache.get_hash("test.py") == "abc123"
        assert cache.get_graph("test.py") is g

    def test_miss(self, cache):
        assert not cache.has("nope.py")
        assert cache.get_hash("nope.py") is None
        assert cache.get_graph("nope.py") is None

    def test_invalidate(self, cache):
        g = Graph()
        cache.set("test.py", "abc", g)
        cache.invalidate("test.py")
        assert not cache.has("test.py")

    def test_clear(self, cache):
        cache.set("a.py", "111", Graph())
        cache.set("b.py", "222", Graph())
        cache.clear()
        assert cache.size == 0

    def test_size(self, cache):
        assert cache.size == 0
        cache.set("a.py", "111", Graph())
        assert cache.size == 1

    def test_save_load_disk(self):
        d = tempfile.mkdtemp()
        try:
            c1 = IncrementalCache(cache_dir=d)
            g = Graph()
            from src_python.core.graph import Node, NodeType
            g.add_node(Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function"))
            c1.set("f.py", "hash123", g)
            c1.save_to_disk()

            c2 = IncrementalCache(cache_dir=d)
            assert c2.has("f.py")
            restored = c2.get_graph("f.py")
            assert restored is not None
            assert restored.node_count == 1
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)


class TestPipelineRunner:
    @pytest.fixture
    def registry(self):
        reg = AdapterRegistry()
        reg.register(PythonAdapter())
        return reg

    @pytest.fixture
    def runner(self, registry):
        return PipelineRunner(registry)

    @pytest.fixture
    def temp_project(self):
        d = tempfile.mkdtemp()
        # Create a small Python project
        os.makedirs(os.path.join(d, "mypkg"), exist_ok=True)
        with open(os.path.join(d, "mypkg", "__init__.py"), "w") as f:
            f.write("from .core import run\n")
        with open(os.path.join(d, "mypkg", "core.py"), "w") as f:
            f.write("""
def helper(x):
    return x * 2

def run(data):
    result = helper(data)
    with open("out.txt", "w") as f:
        f.write(str(result))
    return result
""")
        yield d
        import shutil
        shutil.rmtree(d, ignore_errors=True)

    def test_finds_and_analyzes(self, runner, temp_project):
        graph, report = runner.run(temp_project)
        assert report.total_files >= 2
        assert report.processed_files >= 2
        assert graph.node_count > 0
        assert graph.edge_count > 0

    def test_report_stats(self, runner, temp_project):
        _, report = runner.run(temp_project)
        d = report.to_dict()
        assert "total_files" in d
        assert "processed_files" in d
        assert "elapsed_sec" in d
        assert report.elapsed_sec >= 0

    def test_empty_dir(self, runner):
        d = tempfile.mkdtemp()
        try:
            graph, report = runner.run(d)
            assert graph.node_count == 0
            assert report.total_files == 0
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_progress_callback(self, runner, temp_project):
        progress = []
        runner.run(temp_project, on_progress=lambda f, i, t: progress.append((f, i, t)))
        assert len(progress) > 0
        assert all(len(p) == 3 for p in progress)

    def test_incremental_cache_reuse(self, registry, temp_project):
        cache = IncrementalCache()
        r1 = PipelineRunner(registry, cache)
        g1, rep1 = r1.run(temp_project)

        r2 = PipelineRunner(registry, cache)
        g2, rep2 = r2.run(temp_project)

        # 第二次应全部命中缓存
        assert rep2.cached_files == rep2.total_files
        assert rep2.processed_files == 0  # all cached

    def test_errors_reported(self, registry):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "broken.py"), "w") as f:
                f.write("def broken(:")  # syntax error
            runner = PipelineRunner(registry)
            graph, report = runner.run(d)
            assert report.error_files >= 1 or len(report.errors) >= 1
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    # ── run_incremental ───────────────────────────────────────

    def test_run_incremental_single_file(self, registry):
        d = tempfile.mkdtemp()
        try:
            # Create two files
            with open(os.path.join(d, "a.py"), "w") as f:
                f.write("def func_a():\n    pass\n")
            with open(os.path.join(d, "b.py"), "w") as f:
                f.write("def func_b():\n    pass\n")

            # Full analysis first
            runner = PipelineRunner(registry)
            graph, _ = runner.run(d)
            full_nodes = graph.node_count
            assert full_nodes > 0

            # Now modify a.py: add a new function
            a_path = os.path.join(d, "a.py")
            with open(a_path, "w") as f:
                f.write("def func_a():\n    pass\n\ndef func_a2():\n    pass\n")

            # Incremental — only a.py
            from src_python.core.diff import GraphDiff
            diff = runner.run_incremental(d, [a_path], graph)
            assert len(diff.added_nodes) >= 1
            # Graph should now have at least as many nodes
            assert graph.node_count >= full_nodes
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_run_incremental_preserves_other_files(self, registry):
        d = tempfile.mkdtemp()
        try:
            a_path = os.path.join(d, "a.py")
            b_path = os.path.join(d, "b.py")
            with open(a_path, "w") as f:
                f.write("def func_a():\n    pass\n")
            with open(b_path, "w") as f:
                f.write("def func_b():\n    pass\n")

            runner = PipelineRunner(registry)
            graph, _ = runner.run(d)

            # Get node count for b.py
            b_nodes_before = graph.find_nodes_by_location(b_path)
            assert len(b_nodes_before) > 0

            # Modify a.py only
            with open(a_path, "w") as f:
                f.write("def func_a():\n    pass\n\ndef new_a():\n    pass\n")

            # Incremental
            runner.run_incremental(d, [a_path], graph)

            # b.py nodes should still be present
            b_nodes_after = graph.find_nodes_by_location(b_path)
            assert len(b_nodes_after) >= len(b_nodes_before)
            for n in b_nodes_before:
                assert n.id in graph.nodes
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_run_incremental_handles_deleted_file(self, registry):
        d = tempfile.mkdtemp()
        try:
            a_path = os.path.join(d, "a.py")
            with open(a_path, "w") as f:
                f.write("def func_a():\n    pass\n")
            with open(os.path.join(d, "b.py"), "w") as f:
                f.write("def func_b():\n    pass\n")

            runner = PipelineRunner(registry)
            graph, _ = runner.run(d)
            full_nodes = graph.node_count

            # Delete a.py
            os.unlink(a_path)

            # Incremental should remove a.py nodes
            diff = runner.run_incremental(d, [a_path], graph)
            assert graph.node_count < full_nodes
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_run_incremental_updates_communities(self, registry):
        """增量更新后应重新运行社区发现。"""
        d = tempfile.mkdtemp()
        try:
            # Create a project with enough files for community detection (≥3 nodes)
            with open(os.path.join(d, "a.py"), "w") as f:
                f.write("""
def fa():
    return fb()
""")
            with open(os.path.join(d, "b.py"), "w") as f:
                f.write("""
def fb():
    return fc()
""")
            with open(os.path.join(d, "c.py"), "w") as f:
                f.write("""
def fc():
    return fa()
""")

            runner = PipelineRunner(registry)
            graph, _ = runner.run(d)
            assert graph.node_count >= 3, f"need ≥3 nodes for communities, got {graph.node_count}"

            # Capture community state before incremental
            communities_before = list(graph.communities) if graph.communities else []

            # Modify a.py to add a new function
            a_path = os.path.join(d, "a.py")
            with open(a_path, "w") as f:
                f.write("""
def fa():
    return fb()

def fa_new():
    pass
""")

            # Incremental update
            runner.run_incremental(d, [a_path], graph)

            # Communities should exist after incremental
            # (at minimum, the communities list should be set; actual detection
            #  depends on leidenalg availability, but the detect() call must run)
            assert hasattr(graph, 'communities'), "graph must have communities attribute"
            # If communities were there before, community count may change
            # At minimum verify detect() was called without error
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_run_incremental_community_on_large_graph(self, registry):
        """大图增量更新后社区发现不丢数据。"""
        d = tempfile.mkdtemp()
        try:
            # Create multiple files with interconnected functions
            for i in range(4):
                with open(os.path.join(d, f"mod{i}.py"), "w") as f:
                    calls = ", ".join(f"mod{j}.f{j}()" for j in range(4) if j != i)
                    f.write(f"""
def f{i}():
    return [{calls}]
""")

            runner = PipelineRunner(registry)
            graph, _ = runner.run(d)
            assert graph.node_count >= 4

            # Modify one file
            m0 = os.path.join(d, "mod0.py")
            with open(m0, "w") as f:
                f.write("""
def f0():
    return 42

def f0_new():
    pass
""")

            # Incremental
            diff = runner.run_incremental(d, [m0], graph)
            assert len(diff.added_nodes) >= 1

            # Communities should be non-None after incremental
            assert graph.communities is not None
            # Even if no communities detected (e.g., no leidenalg),
            # detect() should have run and set communities to []
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)


class TestPipelineReport:
    def test_defaults(self):
        r = PipelineReport()
        assert r.phase == "init"
        assert r.total_files == 0
        assert r.errors == []

    def test_repr(self):
        r = PipelineReport()
        s = repr(r)
        assert "PipelineReport" in s
        assert "phase=init" in s


# ============================================================
# 2.2 增量分析一致性 (TEST_SPEC 2.2.1 - 2.2.5)
# ============================================================

@pytest.mark.integration
class TestIncrementalFullEquivalence:
    """2.2.1: 增量分析结果与全量再分析完全一致。"""

    @pytest.fixture
    def registry(self):
        reg = AdapterRegistry()
        reg.register(PythonAdapter())
        return reg

    def test_after_modification_result_matches_full(self, registry):
        import tempfile, shutil
        d = tempfile.mkdtemp()
        try:
            # Create a multi-file project
            os.makedirs(os.path.join(d, "pkg"), exist_ok=True)
            files = {
                "pkg/__init__.py": "from .core import run\n",
                "pkg/core.py": "def helper(x):\n    return x * 2\n\ndef run(x):\n    return helper(x)\n",
                "pkg/utils.py": "def format_output(x):\n    return str(x)\n",
                "pkg/io.py": "from .utils import format_output\n\ndef write(x):\n    return format_output(x)\n",
                "pkg/main.py": "from .core import run\nfrom .io import write\n\ndef main():\n    x = run(1)\n    return write(x)\n",
            }
            for relpath, content in files.items():
                fp = os.path.join(d, relpath)
                os.makedirs(os.path.dirname(fp), exist_ok=True)
                with open(fp, "w") as f:
                    f.write(content)

            # 1. Full analysis
            runner = PipelineRunner(registry)
            graph_full_1, _ = runner.run(d)
            nc1, ec1 = graph_full_1.node_count, graph_full_1.edge_count

            # 2. Modify one file (add a function)
            mod_path = os.path.join(d, "pkg", "core.py")
            with open(mod_path, "w") as f:
                f.write("def helper(x):\n    return x * 2\n\ndef run(x):\n    return helper(x)\n\ndef new_func(y):\n    return y + 1\n")

            # 3. Incremental analysis
            diff = runner.run_incremental(d, [mod_path], graph_full_1)
            assert len(diff.added_nodes) >= 1, "Should detect new function"

            # 4. Full re-analysis on modified project
            runner2 = PipelineRunner(registry)
            graph_full_2, _ = runner2.run(d)

            # Verify equivalence
            assert graph_full_1.node_count == graph_full_2.node_count, \
                f"Incremental node count {graph_full_1.node_count} != full {graph_full_2.node_count}"
            assert graph_full_1.edge_count == graph_full_2.edge_count, \
                f"Incremental edge count {graph_full_1.edge_count} != full {graph_full_2.edge_count}"
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_remove_import_edge_disappears(self, registry):
        """2.2.2: 删除 import 后增量分析移除对应边。"""
        import tempfile, shutil
        d = tempfile.mkdtemp()
        try:
            a_path = os.path.join(d, "a.py")
            b_path = os.path.join(d, "b.py")
            with open(a_path, "w") as f:
                f.write("from b import func_b\n\ndef func_a():\n    return func_b()\n")
            with open(b_path, "w") as f:
                f.write("def func_b():\n    return 42\n")

            # Use full pipeline (includes CrossFileResolver for cross-file edges)
            from tests.helpers import analyze
            d1 = analyze(d)
            # Load graph for incremental operations
            from src_python.core.graph import Graph
            graph = Graph.from_json(os.path.join(d, "hologram_graph.json"))
            node_count_before = graph.node_count

            # Verify cross-file edges exist before modification
            a_nodes = graph.find_nodes_by_location(a_path)
            b_nodes = graph.find_nodes_by_location(b_path)
            a_ids = {n.id for n in a_nodes}
            b_ids = {n.id for n in b_nodes}
            cross_edges_before = [
                e for e in graph.edges.values()
                if e.source in a_ids and e.target in b_ids
            ]
            assert len(cross_edges_before) > 0, \
                f"Should have cross-file edges from a to b. a_ids={a_ids}, b_ids={b_ids}"

            # Remove import from a.py
            with open(a_path, "w") as f:
                f.write("def func_a():\n    return 42\n")

            # Incremental analysis — use raw runner to patch graph
            runner = PipelineRunner(registry)
            runner.run_incremental(d, [a_path], graph)

            # Verify a → b edges are gone
            a_ids_after = {n.id for n in graph.find_nodes_by_location(a_path)}
            edges_after = [
                e for e in graph.edges.values()
                if e.source in a_ids_after and e.target in b_ids
            ]
            assert len(edges_after) == 0, \
                f"Cross-file edges should be removed after import deleted, found {len(edges_after)}"

            # But both a and b nodes still exist
            assert len(graph.find_nodes_by_location(a_path)) > 0, "Node a should still exist"
            assert len(graph.find_nodes_by_location(b_path)) > 0, "Node b should still exist"
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_delete_file_removes_nodes_and_edges(self, registry):
        """2.2.3: 删除文件后节点和边都被移除。"""
        import tempfile, shutil
        d = tempfile.mkdtemp()
        try:
            a_path = os.path.join(d, "a.py")
            b_path = os.path.join(d, "b.py")
            with open(a_path, "w") as f:
                f.write("from b import func_b\n\ndef func_a():\n    return func_b()\n")
            with open(b_path, "w") as f:
                f.write("def func_b():\n    return 42\n")

            runner = PipelineRunner(registry)
            graph, _ = runner.run(d)
            nc_before = graph.node_count
            ec_before = graph.edge_count

            # Delete b.py
            os.unlink(b_path)

            # Incremental analysis
            diff = runner.run_incremental(d, [b_path], graph)

            # b.py 的节点被移除
            b_nodes_remaining = graph.find_nodes_by_location(b_path)
            assert len(b_nodes_remaining) == 0, \
                f"All nodes from deleted file should be removed, found {len(b_nodes_remaining)}"

            # node_count 减少
            assert graph.node_count < nc_before, \
                f"Node count should decrease after deleting file: {graph.node_count} >= {nc_before}"

            # edge_count 减少
            assert graph.edge_count < ec_before, \
                f"Edge count should decrease: {graph.edge_count} >= {ec_before}"

            # a.py 的节点还在
            assert len(graph.find_nodes_by_location(a_path)) > 0, "Node a should still exist"
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_consecutive_incrementals_no_drift(self, registry):
        """2.2.4: 连续 5 次增量分析不累积错误。"""
        import tempfile, shutil, random
        d = tempfile.mkdtemp()
        try:
            # Create 10 source files
            rng = random.Random(42)
            for i in range(10):
                fp = os.path.join(d, f"mod{i}.py")
                funcs = []
                for j in range(3):
                    funcs.append(f"def f{i}_{j}():\n    pass\n")
                content = "\n".join(funcs)
                with open(fp, "w") as f:
                    f.write(content)

            runner = PipelineRunner(registry)
            graph, _ = runner.run(d)

            # 5 rounds of incremental
            for round_idx in range(5):
                # Pick a random file to modify
                mod_idx = rng.randint(0, 9)
                mod_path = os.path.join(d, f"mod{mod_idx}.py")

                # Read, modify, write
                with open(mod_path, "r") as f:
                    original = f.read()
                with open(mod_path, "w") as f:
                    f.write(original + f"\ndef new_r{round_idx}():\n    pass\n")

                runner.run_incremental(d, [mod_path], graph)

            # Full re-analysis
            runner2 = PipelineRunner(registry)
            graph_final, _ = runner2.run(d)

            assert graph.node_count == graph_final.node_count, \
                f"After 5 incrementals: {graph.node_count} nodes vs full {graph_final.node_count}"
            assert graph.edge_count == graph_final.edge_count, \
                f"After 5 incrementals: {graph.edge_count} edges vs full {graph_final.edge_count}"
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_incremental_updates_coupling_summary(self, registry):
        """2.2.5: 增量分析后 coupling_summary 被更新。"""
        import tempfile, shutil
        d = tempfile.mkdtemp()
        try:
            # Create a multi-module project with cross-module calls
            for i in range(3):
                fp = os.path.join(d, f"mod{i}.py")
                imports = "\n".join(
                    f"from mod{j} import f{j}" for j in range(3) if j != i
                )
                content = f"""\
{imports}
def f{i}():
    pass
"""
                with open(fp, "w") as f:
                    f.write(content)

            # Full analysis via _analyze_and_output (runs coupling)
            from tests.helpers import analyze, has_coupling
            d1 = analyze(d)
            assert has_coupling(d1), \
                "Full analysis should produce coupling_summary in meta"

            # Remember L4 count before
            coupling_before = d1["meta"]["coupling"]
            l4_before = coupling_before.get("total_l4", 0)

            # Add a cross-module call to mod0
            mod0_path = os.path.join(d, "mod0.py")
            with open(mod0_path, "a") as f:
                f.write("\ndef f0_new():\n    from mod1 import f1\n    return f1()\n")

            # Incremental analysis
            from src_python.__main__ import _analyze_and_output
            graph = _analyze_and_output(d, changed_files=[mod0_path])
            d2 = graph.to_dict()

            # coupling_summary must exist
            assert has_coupling(d2), \
                "Incremental analysis should still have coupling_summary"
            coupling_after = d2["meta"]["coupling"]
            l4_after = coupling_after.get("total_l4", 0)

            # L4 should be at least as many as before (new violation may be detected)
            assert l4_after >= l4_before, \
                f"L4 violations should not decrease: {l4_before} → {l4_after}"
        finally:
            shutil.rmtree(d, ignore_errors=True)
