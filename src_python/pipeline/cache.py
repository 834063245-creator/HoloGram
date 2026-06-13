"""
增量缓存：基于文件哈希，缓存已分析文件的图数据，避免重复分析。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from typing import Dict, Optional

from ..core.graph import Graph

logger = logging.getLogger(__name__)


class IncrementalCache:
    """文件级分析结果缓存。

    存储结构（内存 + 可选磁盘持久化）：
      {
        "/path/to/file.py": {
          "hash": "sha256...",
          "graph": Graph(...)
        }
      }
    """

    def __init__(self, cache_dir: Optional[str] = None, max_size: int = 0):
        """max_size=0 means unlimited (safe — per-file graphs are small)."""
        self._cache: Dict[str, Dict] = {}
        self._cache_dir = cache_dir
        self._max_size = max_size
        self._lock = threading.Lock()
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)
            self._load_from_disk()

    @staticmethod
    def hash_source(source: str) -> str:
        return hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def hash_file(file_path: str) -> Optional[str]:
        try:
            with open(file_path, "rb") as f:
                return hashlib.sha256(f.read()).hexdigest()[:16]
        except OSError:
            return None

    def has(self, file_path: str) -> bool:
        with self._lock:
            return file_path in self._cache

    def get_hash(self, file_path: str) -> Optional[str]:
        with self._lock:
            entry = self._cache.get(file_path)
        return entry["hash"] if entry else None

    def get_graph(self, file_path: str) -> Optional[Graph]:
        with self._lock:
            entry = self._cache.get(file_path)
        return entry.get("graph") if entry else None

    def get_entry(self, file_path: str) -> Optional[tuple[str, Graph]]:
        """原子获取缓存条目 — 消除 get_hash/get_graph 之间的 TOCTOU 窗口。"""
        with self._lock:
            entry = self._cache.get(file_path)
        if entry:
            return (entry["hash"], entry.get("graph"))
        return None

    def set(self, file_path: str, file_hash: str, graph: Graph) -> None:
        with self._lock:
            # 如果已经在缓存中，直接更新，不需要逐出
            if file_path in self._cache:
                self._cache[file_path] = {"hash": file_hash, "graph": graph}
                return
            if self._max_size > 0 and len(self._cache) >= self._max_size:
                # Simple FIFO eviction: remove oldest entry (dict insertion order)
                oldest = next(iter(self._cache))
                self._cache.pop(oldest)
            self._cache[file_path] = {"hash": file_hash, "graph": graph}

    def invalidate(self, file_path: str) -> None:
        with self._lock:
            self._cache.pop(file_path, None)

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()

    # -- 磁盘持久化 --

    def _cache_file_path(self) -> str:
        return os.path.join(self._cache_dir, "pipeline_cache.json") if self._cache_dir else ""

    def _load_from_disk(self) -> None:
        path = self._cache_file_path()
        if not path or not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for file_path, entry in data.items():
                self._cache[file_path] = {
                    "hash": entry["hash"],
                    "graph": Graph.from_dict(entry["graph"]),
                }
        except json.JSONDecodeError:
            logger.warning("Pipeline cache JSON corrupt, deleting: %s", path)
            try:
                os.remove(path)
            except OSError:
                pass
        except (KeyError, OSError) as e:
            logger.warning("Failed to load pipeline cache: %s", e)

    def save_to_disk(self) -> None:
        if not self._cache_dir:
            return
        with self._lock:
            data = {}
            for file_path, entry in self._cache.items():
                data[file_path] = {
                    "hash": entry["hash"],
                    "graph": entry["graph"].to_dict(),
                }
            target = self._cache_file_path()
            tmp_path = target + ".tmp"
            try:
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                os.replace(tmp_path, target)
            except OSError as e:
                logger.error("Failed to save pipeline cache: %s", e)
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    @property
    def size(self) -> int:
        return len(self._cache)
