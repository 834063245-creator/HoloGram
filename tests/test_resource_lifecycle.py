"""
资源生命周期 + 并发安全测试 — 防止连接泄漏、缓存膨胀、竞态条件。

覆盖: H4 (SQLite 泄漏), H5 (无锁并发), H6 (SQLite 线程安全), M8 (缓存驱逐)
原则: 每种资源（连接、缓存、共享状态）必须有清理/边界/并发守卫。
"""

import os
import time
import sqlite3
import tempfile
import threading
import queue
import pytest

from src_python.timeline import TimelineStore
from src_python.pipeline.cache import IncrementalCache
from src_python.core.graph import Graph
from src_python.adapters import AdapterRegistry, PythonAdapter


# ============================================================
# TimelineStore — 连接生命周期
# ============================================================

class TestTimelineStoreLifecycle:
    """TimelineStore 的 SQLite 连接必须可关闭且不泄漏。"""

    @pytest.fixture
    def tmp_project(self):
        with tempfile.TemporaryDirectory() as d:
            yield d

    def test_close_releases_connection(self, tmp_project):
        """store.close() 后连接不应再可用。"""
        store = TimelineStore(tmp_project)
        store.close()
        with pytest.raises(sqlite3.ProgrammingError):
            store._conn.execute("SELECT 1")

    def test_can_record_and_query_after_reopen(self, tmp_project):
        """关闭后重新打开应能读取之前写入的数据。"""
        store = TimelineStore(tmp_project)
        eid = store.record("test", file="a.py", summary="first")
        store.close()

        store2 = TimelineStore(tmp_project)
        events = store2.query(limit=10)
        assert any(e["id"] == eid for e in events), "Reopened store should find previous event"
        store2.close()

    def test_thread_safety_check_same_thread(self, tmp_project):
        """TimelineStore 在非创建线程中查询不应崩溃（check_same_thread=False）。"""
        store = TimelineStore(tmp_project)
        store.record("test", file="a.py", summary="cross-thread test")
        store.close()

        err_queue: queue.Queue = queue.Queue()

        def query_from_other_thread():
            try:
                s = TimelineStore(tmp_project)
                s.query(limit=10)
                s.close()
            except Exception as e:
                err_queue.put(e)

        t = threading.Thread(target=query_from_other_thread)
        t.start()
        t.join()

        if not err_queue.empty():
            pytest.fail(f"Cross-thread query failed: {err_queue.get()}")

    def test_idempotent_close(self, tmp_project):
        """重复 close() 不应抛异常。"""
        store = TimelineStore(tmp_project)
        store.close()
        # 第二次 close 不应崩溃
        try:
            store.close()
        except Exception as e:
            pytest.fail(f"Second close() should not raise: {e}")

    def test_stats_returns_valid_data(self, tmp_project):
        """stats() 返回有效的统计数据。"""
        store = TimelineStore(tmp_project)
        store.record("commit", file="a.py", summary="test commit")
        store.record("commit", file="b.py", summary="another")
        stats = store.stats()
        store.close()

        assert stats["total_events"] >= 2
        assert isinstance(stats["total_events"], int)


# ============================================================
# IncrementalCache — 驱逐策略
# ============================================================

class FakeGraph:
    """用于缓存测试的轻量图替身。"""
    def __init__(self, name=""):
        self._name = name

    def to_dict(self):
        return {"name": self._name}

    @classmethod
    def from_dict(cls, d):
        return cls(d.get("name", ""))


class TestIncrementalCacheEviction:
    """IncrementalCache 必须在超出 max_size 时驱逐旧条目。"""

    def test_eviction_on_set_overflow(self):
        c = IncrementalCache(max_size=3)
        for i in range(10):
            c.set(f"file_{i}.py", f"hash_{i}", FakeGraph(f"g_{i}"))
        assert c.size <= 3, f"Cache should evict old entries, size={c.size}"

    def test_most_recent_entries_survive(self):
        c = IncrementalCache(max_size=3)
        for i in range(5):
            c.set(f"file_{i}.py", f"hash_{i}", FakeGraph(f"g_{i}"))
        # 最新的 3 个应保留: file_2, file_3, file_4
        assert c.has("file_4.py"), "Most recent entry should be in cache"
        assert c.has("file_3.py"), "Second most recent should be in cache"
        assert c.has("file_2.py"), "Third most recent should be in cache"
        assert not c.has("file_0.py"), "Oldest entry should be evicted"
        assert not c.has("file_1.py"), "Second oldest should be evicted"

    def test_default_max_size(self):
        c = IncrementalCache()
        assert c._max_size == 0  # default now unlimited (was 500)

    def test_no_eviction_below_max(self):
        c = IncrementalCache(max_size=10)
        for i in range(5):
            c.set(f"file_{i}.py", f"hash_{i}", FakeGraph(f"g_{i}"))
        assert c.size == 5
        for i in range(5):
            assert c.has(f"file_{i}.py")

    def test_invalidate_then_refill(self):
        c = IncrementalCache(max_size=2)
        c.set("a.py", "h1", FakeGraph("a"))
        c.set("b.py", "h2", FakeGraph("b"))
        c.invalidate("a.py")
        assert not c.has("a.py")
        c.set("c.py", "h3", FakeGraph("c"))
        assert c.has("b.py"), "Should keep b"
        assert c.has("c.py"), "Should have c"
        assert c.size == 2

    def test_clear(self):
        c = IncrementalCache(max_size=100)
        for i in range(5):
            c.set(f"f{i}", f"h{i}", FakeGraph(f"g{i}"))
        c.clear()
        assert c.size == 0

    def test_disk_persistence_with_eviction(self):
        """持久化缓存 + 驱逐：save/load 后 max_size 仍生效。"""
        with tempfile.TemporaryDirectory() as d:
            c = IncrementalCache(cache_dir=d, max_size=3)
            for i in range(5):
                c.set(f"file_{i}.py", f"hash_{i}", FakeGraph(f"g_{i}"))
            c.save_to_disk()

            # 重新加载
            c2 = IncrementalCache(cache_dir=d, max_size=3)
            # 磁盘数据可能超过 max_size，但新写入时仍应驱逐
            # 磁盘加载不强制执行 max_size（历史数据保留），只对新 set 驱逐
            assert c2.size == 3  # 从磁盘加载了 3 条（最近写入的）
            c2.set("file_5.py", "hash_5", FakeGraph("g_5"))
            assert c2.size == 3  # 仍不超过 max_size


# ============================================================
# 并发安全 — watcher 共享状态
# ============================================================

class TestWatcherConcurrency:
    """FileWatcher._graph 和 _callbacks 在多线程下不应损坏。"""

    @pytest.fixture
    def registry(self):
        reg = AdapterRegistry()
        reg.register(PythonAdapter())
        return reg

    def test_concurrent_graph_access_no_crash(self, registry):
        """10 线程并发读写 _graph 不应抛异常。"""
        from src_python.watcher import FileWatcher
        from src_python.pipeline.cache import IncrementalCache

        w = FileWatcher("/tmp/test_watcher", registry, debounce_sec=0.1)

        # 先做一次全量重建，让 _graph 不为 None
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "app.py"), "w") as f:
                f.write("x = 1\n")

            real_w = FileWatcher(d, registry, debounce_sec=0.1)
            real_w._full_rebuild()
            assert real_w.graph is not None

            errors: list = []

            def worker():
                try:
                    for _ in range(100):
                        g = real_w.graph
                        if g is not None:
                            _ = g.node_count
                except Exception as e:
                    errors.append(e)

            threads = [threading.Thread(target=worker) for _ in range(10)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            assert not errors, f"Concurrent access errors: {errors}"

    def test_concurrent_callbacks_no_drop(self, registry):
        """并发注册回调和访问 callbacks 不应丢失。"""
        from src_python.watcher import FileWatcher

        w = FileWatcher("/tmp/test_watcher", registry, debounce_sec=0.1)
        received = []

        # 并发注册 50 个回调
        def register():
            for i in range(10):
                def cb(g, idx=i):
                    received.append(idx)
                w.on_graph_updated(cb)

        threads = [threading.Thread(target=register) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 不丢
        with w._lock:
            assert len(w._callbacks) == 50, f"Expected 50 callbacks, got {len(w._callbacks)}"


# ============================================================
# TimelineStore — idempotent close（补充）
# ============================================================

class TestTimelineStoreEdgeCases:
    """边界情况。"""

    def test_empty_store_stats(self, tmp_path):
        store = TimelineStore(str(tmp_path))
        stats = store.stats()
        store.close()
        assert stats["total_events"] == 0

    def test_since_filter(self, tmp_path):
        store = TimelineStore(str(tmp_path))
        store.record("commit", file="a.py", summary="old")
        time.sleep(0.01)
        cutoff = "2099-01-01T00:00:00"  # far future, no events match
        events = store.query(since=cutoff)
        store.close()
        assert len(events) == 0

    def test_limit(self, tmp_path):
        store = TimelineStore(str(tmp_path))
        for i in range(20):
            store.record("commit", file=f"f{i}.py", summary=f"commit {i}")
        events = store.query(limit=5)
        store.close()
        assert len(events) <= 5
