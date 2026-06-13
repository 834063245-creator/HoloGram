"""
流水线编排：按三阶段（符号 → 介质 → 时间）批量处理所有文件。
"""

from __future__ import annotations

import copy
import logging
import os as _os_module
import time
from multiprocessing import Pool, cpu_count
from typing import Callable, Dict, List, Optional, Tuple

from ..adapters.base import LanguageAdapter, AdapterResult
from ..adapters.registry import AdapterRegistry
from ..core.graph import Graph, Node, Edge
from ..core.diff import GraphDiff
from .discovery import discover_files
from .cache import IncrementalCache
from .worker import analyze_file

logger = logging.getLogger(__name__)


class PipelineRunner:
    """编排分析流水线：发现 → 适配 → 合并 → 聚类。"""

    def __init__(self, registry: AdapterRegistry, cache: Optional[IncrementalCache] = None):
        self.registry = registry
        self.cache = cache or IncrementalCache()

    def run(
        self,
        root: str,
        on_progress: Optional[Callable[[str, int, int], None]] = None,
    ) -> Tuple[Graph, PipelineReport]:
        """
        执行完整流水线。

        Args:
            root: 项目根目录
            on_progress: 进度回调 (file_path, current, total)

        Returns:
            (合并后的全图, 执行报告)
        """
        report = PipelineReport()
        t0 = time.time()

        # Phase 1: 发现文件
        report.phase = "discovery"
        files = discover_files(root, self.registry)
        report.total_files = len(files)
        report.files = files

        if not files:
            report.phase = "done"
            report.elapsed_sec = time.time() - t0
            return Graph(source_root=root), report

        # Phase 2: 逐文件分析（并行）
        report.phase = "analysis"
        merged_graph = Graph(source_root=root)
        file_graphs: Dict[str, Graph] = {}

        # ── 2a: 分离缓存命中 / 未命中 ──
        cache_misses: List[Tuple[str, str, str]] = []  # (file_path, source, adapter_key)
        skipped = 0

        for file_path in files:
            adapter = self.registry.find(file_path)
            if not adapter:
                report.skipped_files += 1
                continue
            skipped += 1

            source = self._read_file(file_path)
            if source is None:
                report.error_files += 1
                continue

            report.sources[file_path] = source

            file_hash = self.cache.hash_source(source)
            entry = self.cache.get_entry(file_path)
            if entry and entry[0] == file_hash and entry[1] is not None:
                cached = entry[1]
                file_graphs[file_path] = cached
                merged_graph.merge(cached)
                report.cached_files += 1
                if on_progress:
                    on_progress(file_path, skipped, len(files))
                continue

            # Derive adapter key for the worker
            ext = _os_module.path.splitext(file_path)[1].lower()
            if ext == '.py':
                adapter_key = 'python'
            elif ext in ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'):
                adapter_key = 'typescript'
            else:
                adapter_key = 'treesitter'
            cache_misses.append((file_path, source, adapter_key))

        # ── 2b: 并行分析未命中文件 ──
        # ── 2b: 并行分析未命中文件 ──
        if cache_misses:
            # For ≤2 files, serial is faster (no pool overhead).
            n_workers = min(cpu_count() or 4, len(cache_misses))
            if n_workers <= 1 or len(cache_misses) <= 2:
                # Serial fallback — uses registry adapters (keeps mock path for tests)
                logger.info("Serial analysis: %d files", len(cache_misses))
                worker_results = []
                for fp, src, _key in cache_misses:
                    ad = self.registry.find(fp)
                    try:
                        r = ad.analyze(fp, src)
                        worker_results.append((fp, list(r.nodes), list(r.edges), list(r.errors), list(r.warnings)))
                    except Exception as exc:
                        worker_results.append((fp, [], [], [str(exc)], []))
            else:
                import multiprocessing as _mp_module
                try:
                    _ctx = _mp_module.get_context('spawn')
                except (AttributeError, ValueError):
                    _ctx = _mp_module
                logger.info("Parallel analysis: %d files on %d workers", len(cache_misses), n_workers)
                with _ctx.Pool(processes=n_workers) as pool:
                    worker_results = pool.starmap(analyze_file, cache_misses)
        else:
            worker_results = []

        # ── 2c: 收集结果、合并、缓存 ──
        processed = skipped
        for file_path, nodes, edges, errs, warns in worker_results:
            processed += 1
            if errs:
                report.errors.extend(f"{file_path}: {e}" for e in errs)
            if warns:
                report.warnings.extend(f"{file_path}: {w}" for w in warns)

            if not nodes and not edges and errs:
                report.error_files += 1
                if on_progress:
                    on_progress(file_path, processed, len(files))
                continue

            file_graph = Graph(source_root=root)
            for node in nodes:
                file_graph.add_node(node)
            for edge in edges:
                file_graph.add_edge(edge)

            file_graphs[file_path] = file_graph
            merged_graph.merge(file_graph)

            file_hash = self.cache.hash_source(report.sources.get(file_path, ""))
            self.cache.set(file_path, file_hash, file_graph)

            report.processed_files += 1
            report.total_nodes_emitted += len(nodes)
            report.total_edges_emitted += len(edges)

            if on_progress:
                on_progress(file_path, processed, len(files))

        # Phase 3: 跨文件关系解析
        report.phase = "cross_file_resolution"
        from ..core.merger import CrossFileResolver
        resolver = CrossFileResolver()
        cross_edges = resolver.resolve(merged_graph)
        logger.info("Cross-file resolution: added %d edges", cross_edges)

        report.phase = "done"
        report.elapsed_sec = time.time() - t0
        return merged_graph, report

    def run_incremental(
        self,
        root: str,
        changed_files: list[str],
        merged_graph: Graph,
    ) -> GraphDiff:
        """
        增量流水线：只分析变更文件，在原图上打补丁。

        Args:
            root: 项目根目录
            changed_files: 变更文件路径列表（相对或绝对，会自动规范化）
            merged_graph: 当前的全图（原地修改）

        Returns:
            GraphDiff 描述变更内容
        """
        import os as _os
        from ..core.merger import CrossFileResolver

        diff = GraphDiff()
        changed_node_ids: list[str] = []

        for raw_path in changed_files:
            # 路径规范化：确保是绝对路径
            file_path = raw_path if _os.path.isabs(raw_path) else _os.path.join(root, raw_path)
            file_path = _os.path.normpath(file_path)
            adapter = self.registry.find(file_path)
            if not adapter:
                continue

            source = self._read_file(file_path)

            # 文件被删除 → 移除所有节点
            if source is None:
                removed_nodes, _ = merged_graph.remove_file(file_path)
                for _ in range(removed_nodes):
                    diff.removed_nodes.append(Node(
                        id="", type="symbol", name="", location=file_path, language="", kind="",
                    ))
                continue

            # 文件存在但不可读（PermissionError 等）→ 跳过，不移除节点
            if source == "":
                continue

            # 分析文件（三阶段）
            try:
                result = adapter.analyze(file_path, source, merged_graph)
            except Exception as e:
                logger.warning("Incremental analysis failed for %s: %s", file_path, e)
                continue

            # Remove old nodes for this file, add new ones
            removed_nodes, added_nodes, added_edges = merged_graph.replace_file(
                file_path,
                Graph.from_nodes_and_edges(result.nodes, result.edges),
            )

            # Record changes
            diff.added_nodes.extend(result.nodes)
            diff.added_edges.extend(result.edges)

            # Track changed node IDs for cross-file resolution
            for node in result.nodes:
                changed_node_ids.append(node.id)

            # Update cache
            file_hash = self.cache.hash_source(source)
            file_graph = Graph.from_nodes_and_edges(result.nodes, result.edges)
            self.cache.set(file_path, file_hash, file_graph)

        # 跨文件解析：全量解析以确保与 run() 结果一致
        resolver = CrossFileResolver()
        resolver.resolve(merged_graph)

        # 增量社区发现：图结构变化后重新聚类
        try:
            from ..core.community import CommunityDetector
            detector = CommunityDetector()
            detector.detect(merged_graph)
        except Exception as e:
            logger.warning("Community detection failed during incremental update: %s", e)

        return diff

    def _read_file(self, path: str) -> Optional[str]:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except FileNotFoundError:
            return None  # 文件被删除 — 调用方应移除图节点
        except PermissionError:
            logger.warning("Permission denied reading %s, skipping", path)
            return ""  # 文件存在但不可读 — 调用方不应移除节点
        except OSError as e:
            logger.warning("OS error reading %s: %s", path, e)
            return ""

class PipelineReport:
    """流水线执行报告。"""

    def __init__(self):
        self.phase: str = "init"
        self.total_files: int = 0
        self.processed_files: int = 0
        self.cached_files: int = 0
        self.skipped_files: int = 0
        self.error_files: int = 0
        self.total_nodes_emitted: int = 0
        self.total_edges_emitted: int = 0
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.files: List[str] = []
        self.sources: Dict[str, str] = {}  # file_path → source text (avoid re-reading during coupling)
        self.elapsed_sec: float = 0.0

    def to_dict(self) -> Dict:
        return {
            "phase": self.phase,
            "total_files": self.total_files,
            "processed_files": self.processed_files,
            "cached_files": self.cached_files,
            "skipped_files": self.skipped_files,
            "error_files": self.error_files,
            "total_nodes_emitted": self.total_nodes_emitted,
            "total_edges_emitted": self.total_edges_emitted,
            "error_count": len(self.errors),
            "warning_count": len(self.warnings),
            "elapsed_sec": round(self.elapsed_sec, 3),
        }

    def __repr__(self) -> str:
        return (
            f"PipelineReport(phase={self.phase}, files={self.total_files}, "
            f"processed={self.processed_files}, cached={self.cached_files}, "
            f"errors={self.error_files}, nodes={self.total_nodes_emitted}, "
            f"edges={self.total_edges_emitted}, elapsed={self.elapsed_sec:.2f}s)"
        )
