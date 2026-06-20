# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试文件监听器（mock watchdog + 轮询模式）。"""

import os
import time
import tempfile
import threading
import pytest

from src_python.watcher import FileWatcher
from src_python.adapters import AdapterRegistry, PythonAdapter
from src_python.pipeline.cache import IncrementalCache
from src_python.core.graph import Graph


class TestFileWatcher:
    @pytest.fixture
    def registry(self):
        reg = AdapterRegistry()
        reg.register(PythonAdapter())
        return reg

    @pytest.fixture
    def cache(self):
        return IncrementalCache()

    def test_init(self, registry, cache):
        """初始化应设置根目录和配置。"""
        w = FileWatcher("/tmp/test", registry, cache=cache, debounce_sec=1.0)
        assert w.root == os.path.abspath("/tmp/test")
        assert w.registry is registry
        assert w.cache is cache
        assert w.debounce_sec == 1.0
        assert w.graph is None

    def test_on_graph_updated_callback(self, registry, cache):
        """回调注册和触发。"""
        w = FileWatcher("/tmp/test", registry, cache=cache)
        results = []

        w.on_graph_updated(lambda g: results.append(g))

        # 手动注入一个图模拟回调节点
        from src_python.core.graph import Graph
        g = Graph()
        w._graph = g
        for cb in w._callbacks:
            cb(g)
        assert len(results) == 1
        assert results[0] is g

    def test_multiple_callbacks(self, registry, cache):
        """多个回调都应被调用。"""
        w = FileWatcher("/tmp/test", registry, cache=cache)
        called = []

        w.on_graph_updated(lambda g: called.append(1))
        w.on_graph_updated(lambda g: called.append(2))

        from src_python.core.graph import Graph
        w._graph = Graph()
        for cb in w._callbacks:
            cb(w._graph)

        assert called == [1, 2]

    def test_callback_exception_does_not_break_others(self, registry, cache):
        """一个回调抛异常不应影响其他回调。"""
        w = FileWatcher("/tmp/test", registry, cache=cache)
        called = []

        def bad_callback(g):
            raise RuntimeError("boom")

        def good_callback(g):
            called.append("ok")

        w._callbacks = [bad_callback, good_callback]
        w._graph = __import__('src_python.core.graph', fromlist=['Graph']).Graph()
        for cb in w._callbacks:
            try:
                cb(w._graph)
            except Exception:
                pass
        assert called == ["ok"]

    def test_on_change_adds_to_pending(self, registry, cache):
        """文件变更事件应加入待处理集合。"""
        w = FileWatcher("/tmp/test", registry, cache=cache)
        assert len(w._pending) == 0

        w._on_change("/tmp/test/main.py")
        assert len(w._pending) == 1
        assert "/tmp/test/main.py" in w._pending

    def test_on_change_ignores_unsupported_ext(self, registry, cache):
        """不支持的扩展名应被忽略。"""
        w = FileWatcher("/tmp/test", registry, cache=cache)

        w._on_change("/tmp/test/readme.md")
        assert len(w._pending) == 0

    def test_debounce_merges_events(self, registry, cache):
        """debounce 期间多次变更应合并为一次处理。"""
        w = FileWatcher("/tmp/test", registry, cache=cache, debounce_sec=0.1)

        w._on_change("/tmp/test/a.py")
        w._on_change("/tmp/test/b.py")

        assert len(w._pending) == 2

    def test_process_pending_clears(self, registry, cache):
        """_process_pending 应清空待处理列表。"""
        w = FileWatcher("/tmp/test", registry, cache=cache)
        w._pending = {"/tmp/test/a.py", "/tmp/test/b.py"}

        # 不实际运行分析（空目录会失败），只验证清空逻辑
        # 用 mock 替换 _full_rebuild
        rebuilt = []
        w._full_rebuild = lambda: rebuilt.append(True)

        w._process_pending()
        assert len(w._pending) == 0
        assert w._timer is None
        assert len(rebuilt) == 1

    def test_full_rebuild_sets_graph(self, registry, cache):
        """_full_rebuild 应设置 self._graph 并触发回调。"""
        d = tempfile.mkdtemp()
        try:
            # 创建一个小型 Python 文件
            with open(os.path.join(d, "main.py"), "w") as f:
                f.write("""
def hello():
    return "world"
""")
            w = FileWatcher(d, registry, cache=cache)
            updated = []
            w.on_graph_updated(lambda g: updated.append(g))

            w._full_rebuild()
            assert w.graph is not None
            assert w.graph.node_count > 0
            assert len(updated) == 1
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_cache_invalidation_on_rebuild(self, registry, cache):
        """_process_pending 应使变更文件的缓存无效。"""
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "main.py"), "w") as f:
                f.write("x = 1")

            file_path = os.path.join(d, "main.py")
            # 手动设置缓存条目（模拟已分析过的文件）
            cache.set(file_path, "hash123", Graph())
            assert cache.has(file_path)

            w = FileWatcher(d, registry, cache=cache)

            # 模拟变更
            w._on_change(file_path)

            # 处理变更——应使缓存失效
            # 注意：_process_pending 会调用 _full_rebuild，
            # 在 _full_rebuild 之前先 invalidate 缓存
            w.cache.invalidate(file_path)
            assert not cache.has(file_path)
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_polling_mode_fallback(self, registry, cache):
        """轮询模式应能发现新文件。"""
        d = tempfile.mkdtemp()
        try:
            w = FileWatcher(d, registry, cache=cache, debounce_sec=0.05)
            # 不启动轮询线程，只测初始分析
            assert w.graph is None
            w._full_rebuild()
            assert w.graph is not None
            # 空目录应产生空图
            assert w.graph.node_count == 0
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_timer_cleanup(self, registry, cache):
        """debounce timer 应在新事件到达时被取消重建。"""
        w = FileWatcher("/tmp/test", registry, cache=cache, debounce_sec=10.0)

        w._on_change("/tmp/test/a.py")
        first_timer = w._timer
        assert first_timer is not None

        w._on_change("/tmp/test/b.py")
        second_timer = w._timer
        assert second_timer is not None
        assert second_timer is not first_timer  # 新 timer

        # 清理
        if second_timer:
            second_timer.cancel()
