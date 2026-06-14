"""
文件监听器：基于 watchdog 监听文件变更，自动触发图重跑。
"""

from __future__ import annotations

import logging
import os
import sys
import time
import threading
from typing import Callable, Optional, Set

from .core.graph import Graph
from .pipeline import PipelineRunner, IncrementalCache
from .adapters.registry import AdapterRegistry

logger = logging.getLogger(__name__)


class FileWatcher:
    """
    监听项目文件变更，自动触发增量重分析。

    使用 watchdog（如果可用）监听文件系统事件，
    在变更发生后延迟（debounce）重跑分析。
    """

    def __init__(
        self,
        root: str,
        registry: AdapterRegistry,
        cache: Optional[IncrementalCache] = None,
        debounce_sec: float = 2.0,
    ):
        self.root = os.path.abspath(root)
        self.registry = registry
        self.cache = cache or IncrementalCache()
        self.debounce_sec = debounce_sec
        self._runner = PipelineRunner(registry, self.cache)
        self._graph: Optional[Graph] = None
        self._callbacks: list[Callable[[Graph], None]] = []
        self._pending: Set[str] = set()
        self._timer: Optional[threading.Timer] = None
        self._lock = threading.Lock()
        self._rebuild_lock = threading.Lock()

    @property
    def graph(self) -> Optional[Graph]:
        with self._lock:
            return self._graph

    def on_graph_updated(self, callback: Callable[[Graph], None]) -> None:
        """注册回调：图更新时调用。"""
        with self._lock:
            self._callbacks.append(callback)

    def start(self, blocking: bool = True) -> None:
        """启动文件监听。"""
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler
        except ImportError:
            print("watchdog not installed. Falling back to polling mode.", file=sys.stderr)
            self._run_polling()
            return

        # 初始分析
        self._full_rebuild()

        class Handler(FileSystemEventHandler):
            def __init__(self, watcher: FileWatcher):
                self._w = watcher

            def on_modified(self, event):
                if not event.is_directory:
                    self._w._on_change(event.src_path)

            def on_created(self, event):
                if not event.is_directory:
                    self._w._on_change(event.src_path)

            def on_deleted(self, event):
                if not event.is_directory:
                    self._w._on_change(event.src_path)

        observer = Observer()
        observer.schedule(Handler(self), self.root, recursive=True)
        observer.start()

        print(f"Watching {self.root} for changes...", file=sys.stderr)

        try:
            if blocking:
                while True:
                    time.sleep(1)
        except KeyboardInterrupt:
            observer.stop()
        observer.join()

    def _on_change(self, file_path: str) -> None:
        """文件变更事件处理（debounce）。"""
        ext = os.path.splitext(file_path)[1]
        if ext not in self.registry.supported_extensions:
            return

        with self._lock:
            self._pending.add(file_path)
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self.debounce_sec, self._process_pending)
            self._timer.start()

    def _process_pending(self) -> None:
        """处理积累的变更文件列表。"""
        with self._lock:
            files = list(self._pending)
            self._pending.clear()
            self._timer = None

        if not files:
            return

        print(f"Re-analyzing {len(files)} changed file(s)...", file=sys.stderr)

        # 如果已有图，走增量路径；否则全量重建
        with self._lock:
            graph_ref = self._graph
            callbacks = list(self._callbacks)
        if graph_ref is not None and graph_ref.node_count > 0:
            try:
                diff = self._runner.run_incremental(self.root, files, graph_ref)
                changes = (len(diff.added_nodes) + len(diff.removed_nodes) +
                           len(diff.added_edges) + len(diff.removed_edges))
                print(f"  Incremental update: {len(diff.added_nodes)} added nodes, "
                      f"{len(diff.removed_nodes)} removed, {changes} total changes", file=sys.stderr)
                # A4: 增量后同步刷新 SQLite
                db_path = os.path.join(self.root, "hologram_graph.db")
                try:
                    graph_ref.to_sqlite(db_path)
                except Exception:
                    pass
                for cb in callbacks:
                    try:
                        cb(graph_ref)
                    except Exception as exc:
                        logger.warning("Callback %s failed: %s", cb, exc)
            except Exception:
                print("  Incremental failed, falling back to full rebuild", file=sys.stderr)
                self._full_rebuild()
        else:
            self._full_rebuild()

    def _full_rebuild(self) -> None:
        """全量重建图。"""
        if not self._rebuild_lock.acquire(blocking=False):
            logger.warning("Rebuild already in progress, skipping")
            return
        try:
            graph, report = self._runner.run(self.root)
            with self._lock:
                self._graph = graph
                callbacks = list(self._callbacks)
            for cb in callbacks:
                try:
                    cb(graph)
                except Exception as exc:
                    logger.warning("Callback %s failed: %s", cb, exc)
        finally:
            self._rebuild_lock.release()

    def _run_polling(self) -> None:
        """退化为轮询模式（无 watchdog 时）。"""
        self._full_rebuild()
        last_mtimes: dict[str, float] = {}
        for dirpath, _, filenames in os.walk(self.root):
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                try:
                    last_mtimes[fp] = os.path.getmtime(fp)
                except OSError:
                    pass

        print(f"Polling {self.root} every {self.debounce_sec}s...", file=sys.stderr)
        try:
            while True:
                time.sleep(self.debounce_sec)
                changed_files: list[str] = []
                current_mtimes: dict[str, float] = {}
                for dirpath, _, filenames in os.walk(self.root):
                    for fn in filenames:
                        fp = os.path.join(dirpath, fn)
                        try:
                            current_mtimes[fp] = os.path.getmtime(fp)
                        except OSError:
                            pass
                # 检测变更
                for fp, new_mtime in current_mtimes.items():
                    old = last_mtimes.get(fp)
                    if old is None or new_mtime > old:
                        changed_files.append(fp)
                for fp in last_mtimes:
                    if fp not in current_mtimes:
                        changed_files.append(fp)
                if changed_files:
                    last_mtimes = current_mtimes
                    print(f"Polling: {len(changed_files)} changed file(s)", file=sys.stderr)
                    for fp in changed_files:
                        self._on_change(fp)  # 全部加入 pending，debounce timer 触发 _process_pending
        except KeyboardInterrupt:
            pass
