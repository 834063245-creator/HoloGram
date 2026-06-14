"""
python -m src_python 入口。

两种模式：
  1. python -m src_python <project_root> --format json  → 输出 JSON 到 stdout
  2. python -m src_python <project_root>               → 输出到 hologram_graph.json
  3. python -m src_python analyze <args>               → 等同于 CLI hologram 命令
"""

import os
import sys
import datetime
import json
import threading
import time as _time


def _heartbeat(label: str, interval: float = 2.0):
    """后台心跳：每 interval 秒输出一条 HOLO:HEARTBEAT 消息，防止状态栏卡死。"""
    stop = threading.Event()
    def _run():
        elapsed = 0.0
        while not stop.is_set():
            stop.wait(interval)
            if stop.is_set():
                break
            elapsed += interval
            print(f"HOLO:HEARTBEAT:{label}:{elapsed:.0f}s", file=sys.stderr, flush=True)
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return stop


from .adapters import AdapterRegistry, PythonAdapter
from .adapters.tree_sitter_adapter import TreeSitterAdapter
from .adapters.typescript_adapter import TypeScriptAdapter
from .core.graph import Graph, _sanitize_for_json, safe_json_dumps
from .core.merger import GraphMerger, CrossFileResolver
from .core.community import CommunityDetector
from .core.diff import GraphDiffer
from .pipeline import PipelineRunner, IncrementalCache
from .analysis.coupling import CouplingDepthAnalyzer


def _analyze_and_output(root: str, output_json: bool = False, output_path: str = "",
                        changed_files: list = None) -> Graph:
    """分析项目并输出。支持增量模式：只分析变更文件，在原图上打补丁。"""
    root = os.path.abspath(root)

    # 持久化缓存
    cache_dir = os.path.join(root, ".hologram", "cache")
    cache = IncrementalCache(cache_dir)

    # ── 增量模式 ──
    if changed_files:
        graph_path = output_path or os.path.join(root, "hologram_graph.json")
        if os.path.exists(graph_path):
            graph = Graph.from_json(graph_path)
        else:
            graph = Graph(source_root=root)

        registry = AdapterRegistry()
        registry.register(TreeSitterAdapter())  # fallback: 通用 tree-sitter（31+ 语言）
        registry.register(PythonAdapter())
        registry.register(TypeScriptAdapter())
        runner = PipelineRunner(registry, cache)

        diff = runner.run_incremental(root, changed_files, graph)

        # 增量跨文件解析
        if diff.added_nodes:
            resolver = CrossFileResolver()
            changed_ids = [n.id for n in diff.added_nodes]
            resolver.resolve_incremental(graph, changed_ids)

        # 增量耦合分析 — 重新分类所有边（补上新增/修改边缺失的 coupling_depth）
        try:
            coupler = CouplingDepthAnalyzer()
            sources = {}
            for fp in changed_files:
                try:
                    with open(fp, "r", encoding="utf-8", errors="replace") as f:
                        sources[fp] = f.read()
                except (OSError, PermissionError):
                    pass
            for fp, src in sources.items():
                coupler.pre_scan_file(fp, src)
            # Only pre-scan changed files; analyze() re-classifies all edges
            cr = coupler.analyze(graph, sources)
            graph.coupling_summary = cr
            print(f"  coupling: L1={cr['total_l1']} L2={cr['total_l2']} L3={cr['total_l3']} L4={cr['total_l4']}", file=sys.stderr)
        except Exception as exc:
            print(f"  coupling analysis skipped: {exc}", file=sys.stderr)

        cache.save_to_disk()

        # Always save graph to disk for future incremental runs
        save_path = output_path or os.path.join(root, "hologram_graph.json")
        graph.to_json(save_path)

        print(f"[inc] {len(diff.added_nodes)} nodes added, "
              f"{len(diff.removed_nodes)} removed, "
              f"{len(diff.added_edges)} edges added "
              f"→ {graph.node_count} total nodes", file=sys.stderr)

        # Output — to_dict() now includes generated_at + coupling_summary
        if output_json:
            sys.stdout.write(safe_json_dumps(_sanitize_for_json(graph.to_dict()), indent=2, ensure_ascii=False))
        else:
            print(f"  saved: {save_path}", file=sys.stderr)

        return graph

    # ── 全量模式（原有逻辑）──
    registry = AdapterRegistry()
    registry.register(TreeSitterAdapter())  # fallback: 通用 tree-sitter（31+ 语言）
    registry.register(PythonAdapter())
    registry.register(TypeScriptAdapter())

    def _progress(file_path: str, current: int, total: int) -> None:
        print(f"  [{current}/{total}] {file_path}", file=sys.stderr)
        print(f"HOLO:PROGRESS:{current}:{total}:{file_path}", file=sys.stderr, flush=True)

    print(f"  scanning {root}...", file=sys.stderr)
    print("HOLO:PHASE:analysis:分析源码", file=sys.stderr, flush=True)
    runner = PipelineRunner(registry, cache)
    graph, report = runner.run(root, on_progress=_progress)
    cache.save_to_disk()
    print(f"[{report.elapsed_sec:.2f}s] {graph.node_count} nodes / {graph.edge_count} edges  (cached: {report.cached_files})", file=sys.stderr)

    # Cross-file resolution
    print(f"  resolving cross-file references...", file=sys.stderr)
    print("HOLO:PHASE:cross_file:解析跨文件引用", file=sys.stderr, flush=True)
    resolver = CrossFileResolver()
    cross_added = resolver.resolve(graph)
    if cross_added:
        print(f"  cross-file edges: {cross_added}", file=sys.stderr)

    # Coupling depth analysis — classify every structural edge L1-L4
    print(f"  coupling analysis...", file=sys.stderr)
    print("HOLO:PHASE:coupling:耦合深度分析", file=sys.stderr, flush=True)
    _coupling_hb = _heartbeat("耦合深度分析")
    try:
        coupler = CouplingDepthAnalyzer()
        # Reuse sources from pipeline runner; only re-read cache-hit files
        sources = dict(report.sources) if hasattr(report, 'sources') else {}
        for fp in report.files:
            if fp not in sources:
                try:
                    with open(fp, "r", encoding="utf-8", errors="replace") as f:
                        sources[fp] = f.read()
                except (OSError, PermissionError):
                    pass
        for fp, src in sources.items():
            coupler.pre_scan_file(fp, src)
        cr = coupler.analyze(graph, sources)
        graph.coupling_summary = cr  # stash for JSON output
        print(f"  coupling: L1={cr['total_l1']} L2={cr['total_l2']} L3={cr['total_l3']} L4={cr['total_l4']}", file=sys.stderr)
    except Exception as exc:
        print(f"  coupling analysis skipped: {exc}", file=sys.stderr)
    _coupling_hb.set()

    # Community detection (graceful degradation)
    # Use detect_fast (Label Propagation / Louvain, O(n+m)) instead of
    # CommunityDetector (recursive Leiden) — 10-100x faster on large graphs.
    print(f"  community detection...", file=sys.stderr)
    print("HOLO:PHASE:community:社区聚类", file=sys.stderr, flush=True)
    _comm_hb = _heartbeat("社区聚类")
    try:
        from .core.community import detect_fast
        communities = detect_fast(graph)
        if communities:
            graph.communities = communities
            for node in graph.nodes.values():
                node.community_id = None
            for comm in communities:
                for nid in comm.node_ids:
                    n = graph.get_node(nid)
                    if n is not None:
                        n.community_id = comm.id
            print(f"  communities: {len(communities)}", file=sys.stderr)
    except Exception as exc:
        print(f"  community detection skipped: {exc}", file=sys.stderr)
    _comm_hb.set()

    # Output — always save to disk first (enables incremental cache reuse)
    print("HOLO:PHASE:saving:保存图数据", file=sys.stderr, flush=True)
    save_path = output_path or os.path.join(root, "hologram_graph.json")
    graph.to_json(save_path)
    # A3: 同时输出 MessagePack（二进制格式，大项目加载快 10×）
    msgpack_path = save_path.replace('.json', '.hologram')
    try:
        graph.to_msgpack(msgpack_path)
    except Exception as exc:
        print(f"  msgpack skipped: {exc}", file=sys.stderr)

    # A4: SQLite 查询加速层（Agent 工具不用解析整个 JSON）
    db_path = save_path.replace('.json', '.db')
    try:
        graph.to_sqlite(db_path)
    except Exception as exc:
        print(f"  sqlite skipped: {exc}", file=sys.stderr)

    # A5: 文件级聚合图 — 大项目兜底渲染
    files_path = save_path.replace('.json', '_files.json')
    try:
        fg = graph.to_file_graph()
        fg.to_json(files_path)
    except Exception as exc:
        print(f"  file-graph skipped: {exc}", file=sys.stderr)

    if output_json:
        # JSON to stdout — to_dict() now includes generated_at + coupling_summary
        print("HOLO:PHASE:serializing:序列化JSON", file=sys.stderr, flush=True)
        sys.stdout.write(safe_json_dumps(_sanitize_for_json(graph.to_dict()), indent=2, ensure_ascii=False))
    else:
        print(f"  saved: {save_path}", file=sys.stderr)

    if report.errors:
        for e in report.errors[:5]:
            print(f"  ! {e}", file=sys.stderr)

    return graph


def main():
    # 支持直接传参
    if len(sys.argv) > 1:
        cmd = sys.argv[1]

        # 子命令通过 CLI 处理
        if cmd in ("analyze", "neighbors", "impact", "path", "diff", "serve",
                    "fragile", "cycle", "coupling-report", "check", "constraints",
                    "incremental", "preflight", "health", "search"):
            from .cli import main as cli_main
            cli_main()
            return

        # python -m src_python <project_root> [--format json] [-o output.json] [--files f1 f2 ...]
        root = cmd
        output_json = "--format" in sys.argv and "json" in sys.argv
        output_path = ""
        if "-o" in sys.argv:
            idx = sys.argv.index("-o")
            if idx + 1 < len(sys.argv):
                output_path = sys.argv[idx + 1]

        # 增量模式：--files f1.py f2.py ...
        changed_files = None
        if "--files" in sys.argv:
            idx = sys.argv.index("--files")
            changed_files = sys.argv[idx + 1:]

        _analyze_and_output(root, output_json, output_path, changed_files)
    else:
        # 默认分析当前目录
        _analyze_and_output(".", output_path="hologram_graph.json")


if __name__ == "__main__":
    main()
