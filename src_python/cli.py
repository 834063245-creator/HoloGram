"""
CLI 工具：Agent 通过 bash 调用的兜底通道。

用法：
  $ hologram analyze <project_root>
  $ hologram neighbors <node_name>
  $ hologram impact <node_name> --depth 3
  $ hologram path <from_name> <to_name>
  $ hologram diff <before> <after>
  $ hologram fragile [--limit 5]    # V2: 最脆弱模块
  $ hologram cycle [--mode all]     # V2: 数据流环
  $ hologram coupling-report <module> # V2: 耦合深度报告
  $ hologram serve                  # 启动 MCP Server (stdio)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Optional


_stdout_configured = False


def _safe_print(text: str, **kwargs) -> None:
    """Print UTF-8 safely — ensures stdout is UTF-8 regardless of system locale."""
    global _stdout_configured
    if not _stdout_configured:
        try:
            enc = (sys.stdout.encoding or '').lower()
            if enc not in ('utf-8', 'utf8'):
                sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass  # stdout not reconfigurable (e.g. piped), rely on PYTHONIOENCODING env
        _stdout_configured = True
    try:
        print(text, **kwargs)
    except UnicodeEncodeError:
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
            print(text, **kwargs)
        except Exception:
            safe = text.encode('ascii', errors='replace').decode('ascii')
            print(safe, **kwargs)

from .adapters import AdapterRegistry, PythonAdapter
from .adapters.typescript_adapter import TypeScriptAdapter
from .adapters.tree_sitter_adapter import TreeSitterAdapter
from .core.graph import Graph, type_val, file_from_location, safe_json_dumps
from .core.merger import GraphMerger, CrossFileResolver
from .core.community import CommunityDetector
from .core.diff import GraphDiffer, GraphDiff
from .pipeline import PipelineRunner, IncrementalCache


def _load_graph(graph_path: str) -> Optional[Graph]:
    """加载已保存的图文件。A4: SQLite 优先（快 5-10×），fallback JSON。

    防御：检查 SQLite 的边数是否与 JSON 一致——如果不一致说明 DB 过时
    （增量分析后忘了刷 DB），自动 fallback JSON。
    """
    # Try SQLite first
    db_path = graph_path.replace('.json', '.db')
    if os.path.exists(db_path):
        try:
            if os.path.exists(graph_path):
                json_mtime = os.path.getmtime(graph_path)
                db_mtime = os.path.getmtime(db_path)
                if db_mtime < json_mtime - 2.0:  # DB older than JSON by 2+ seconds
                    print("  SQLite DB older than JSON, regenerating...", file=sys.stderr)
                    graph = Graph.from_json(graph_path)
                    try:
                        graph.to_sqlite(db_path)
                    except Exception as exc:
                        print(f"  DB regeneration failed ({exc}), using in-memory graph", file=sys.stderr)
                    return graph
            return Graph.from_sqlite(db_path)
        except Exception as exc:
            print(f"  SQLite load failed ({exc}), falling back to JSON", file=sys.stderr)

    if not os.path.exists(graph_path):
        print(f"Graph file not found: {graph_path}", file=sys.stderr)
        print("Run 'hologram analyze <project_root>' first.", file=sys.stderr)
        return None
    return Graph.from_json(graph_path)


def _find_node_id(graph: Graph, name_or_id: str) -> Optional[str]:
    """统一的模糊节点查找 — 委托给 Graph.resolve_node()。

    支持：精确 ID、精确名称、短名称、大小写不敏感、子串、location 匹配。
    """
    node = graph.resolve_node(name_or_id)
    return node.id if node else None


def cmd_analyze(args) -> int:
    """分析项目目录，生成图 JSON 文件。"""
    root = os.path.abspath(args.root)
    output = args.output or os.path.join(root, "hologram_graph.json")

    print(f"Analyzing: {root}")
    registry = AdapterRegistry()
    registry.register(TreeSitterAdapter())  # fallback: 通用 tree-sitter（31+ 语言）
    registry.register(PythonAdapter())      # Python 专用适配器（更精确）
    registry.register(TypeScriptAdapter())

    runner = PipelineRunner(registry)
    graph, report = runner.run(root, on_progress=lambda f, i, t: print(f"  [{i}/{t}] {f}", file=sys.stderr))

    # 跨文件关系解析
    resolver = CrossFileResolver()
    cross_added = resolver.resolve(graph)
    if cross_added:
        print(f"  Cross-file edges resolved: {cross_added}", file=sys.stderr)

    # 社区发现
    detector = CommunityDetector()
    communities = detector.detect(graph)
    if communities:
        print(f"  Communities detected: {len(communities)}", file=sys.stderr)

    # 耦合深度分析
    try:
        from .analysis.coupling import CouplingDepthAnalyzer
        coupler = CouplingDepthAnalyzer()
        sources = {}
        for fp in report.files:
            try:
                with open(fp, "r", encoding="utf-8", errors="replace") as f:
                    sources[fp] = f.read()
            except (OSError, PermissionError):
                pass
        for fp, src in sources.items():
            coupler.pre_scan_file(fp, src)
        cr = coupler.analyze(graph, sources)
        graph.coupling_summary = cr
        print(f"  coupling: L1={cr['total_l1']} L2={cr['total_l2']} L3={cr['total_l3']} L4={cr['total_l4']}", file=sys.stderr)
    except Exception as exc:
        print(f"  coupling analysis skipped: {exc}", file=sys.stderr)

    # 输出
    graph.to_json(output)
    # A3: 同时输出 MessagePack（大项目加载快 10×）
    msgpack_path = output.replace('.json', '.hologram')
    try:
        graph.to_msgpack(msgpack_path)
        print(f"MsgPack saved: {msgpack_path}")
    except Exception as exc:
        print(f"  msgpack skipped: {exc}", file=sys.stderr)
    # A4: SQLite 查询加速层
    db_path = output.replace('.json', '.db')
    try:
        graph.to_sqlite(db_path)
        print(f"SQLite saved: {db_path}")
    except Exception as exc:
        print(f"  sqlite skipped: {exc}", file=sys.stderr)
    # A5: 文件级聚合图
    files_path = output.replace('.json', '_files.json')
    try:
        fg = graph.to_file_graph()
        fg.to_json(files_path)
        print(f"File graph saved: {files_path}")
    except Exception as exc:
        print(f"  file-graph skipped: {exc}", file=sys.stderr)
    print(f"Graph saved: {output}")
    print(f"  Nodes: {graph.node_count}, Edges: {graph.edge_count}")
    print(f"  Communities: {graph.community_count}")
    print(f"  Time: {report.elapsed_sec:.2f}s")

    if report.errors:
        print(f"  Errors: {len(report.errors)}")
        for e in report.errors[:5]:
            print(f"    ! {e}")
    if report.warnings:
        print(f"  Warnings: {len(report.warnings)}")

    return 0


def cmd_neighbors(args) -> int:
    """查询一阶邻接。"""
    graph = _load_graph(args.graph)
    if graph is None:
        return 1

    node_id = _find_node_id(graph, args.node)
    if node_id is None:
        print(f"Node not found: {args.node}", file=sys.stderr)
        return 1

    neighbors = graph.neighbors(node_id)
    for n in neighbors:
        print(f"  {n.name} [{n.kind}] — {n.location}")
    print(f"\n{len(neighbors)} neighbors")
    return 0


def cmd_impact(args) -> int:
    """波及分析。"""
    graph = _load_graph(args.graph)
    if graph is None:
        return 1

    node_id = _find_node_id(graph, args.node)
    if node_id is None:
        print(f"Node not found: {args.node}", file=sys.stderr)
        return 1

    layers = graph.impact_bfs(node_id, args.depth)
    for layer in layers:
        depth = layer["depth"]
        nodes = layer["nodes"]
        if depth == 0:
            print(f"Depth {depth} (source): {nodes[0]['name'] if nodes else '?'}")
        else:
            delayed = [n for n in nodes if n.get("properties", {}).get("delay_sec")]
            tag = " [DELAYED]" if delayed else ""
            print(f"Depth {depth}: {len(nodes)} nodes{tag}")
            for n in nodes[:5]:
                print(f"    {n['name']} [{n['kind']}] — {n['location']}")
            if len(nodes) > 5:
                print(f"    ... and {len(nodes) - 5} more")

    total = sum(len(l["nodes"]) for l in layers) - 1
    print(f"\nTotal affected: {total} nodes across {len(layers) - 1} layers")
    return 0


def cmd_path(args) -> int:
    """路径查询。"""
    graph = _load_graph(args.graph)
    if graph is None:
        return 1

    from_id = _find_node_id(graph, args.from_node)
    to_id = _find_node_id(graph, args.to_node)
    if from_id is None:
        print(f"Source not found: {args.from_node}", file=sys.stderr)
        return 1
    if to_id is None:
        print(f"Target not found: {args.to_node}", file=sys.stderr)
        return 1

    paths = graph.paths(from_id, to_id)
    if not paths:
        print("No paths found.")
        return 0

    for i, path in enumerate(paths[:10]):
        names = []
        for nid in path:
            node = graph.get_node(nid)
            names.append(node.name if node else nid)
        print(f"  Path {i + 1} ({len(path) - 1} hops): {' -> '.join(names)}")

    if len(paths) > 10:
        print(f"  ... and {len(paths) - 10} more paths")
    print(f"\n{len(paths)} total paths")
    return 0


def cmd_diff(args) -> int:
    """比较两个图快照。"""
    try:
        before = Graph.from_json(args.before)
    except (FileNotFoundError, ValueError) as e:
        print(f"Error loading before graph: {e}", file=sys.stderr)
        return 1
    try:
        after = Graph.from_json(args.after)
    except (FileNotFoundError, ValueError) as e:
        print(f"Error loading after graph: {e}", file=sys.stderr)
        return 1
    differ = GraphDiffer()
    diff = differ.diff(before, after)
    if args.json:
        import json
        _safe_print(json.dumps(diff.to_dict(), indent=2, ensure_ascii=False))
    else:
        print(GraphDiffer.impact_summary(diff))
    return 0


# ── V2 CLI 命令 ───────────────────────────────────────────

def cmd_fragile(args) -> int:
    """按 L4 封装穿透密度排序，输出 Top N 最脆弱模块。"""
    graph = _load_graph(args.graph)
    if graph is None:
        return 1

    try:
        from .analysis.coupling import coupling_depth_report
        result = coupling_depth_report(graph)
    except ImportError as e:
        print(f"V2 analysis module not available: {e}", file=sys.stderr)
        return 1

    reports = sorted(
        result.get("module_reports", []),
        key=lambda r: r.get("fragility_score", 0),
        reverse=True,
    )[:args.limit]

    if not reports:
        print("No coupling data available. All modules have zero or unknown coupling depth.")
        return 0

    print(f"Top {len(reports)} Most Fragile Modules (by L4 encapsulation violation density):\n")
    print(f"  {'Module':<25} {'L4':>5} {'L3':>5} {'L2':>5} {'L1':>5} {'Score':>8}")
    print(f"  {'-'*25} {'-'*5} {'-'*5} {'-'*5} {'-'*5} {'-'*8}")

    for r in reports:
        print(f"  {r['module_name']:<25} {r['l4_count']:>5} {r['l3_count']:>5} "
              f"{r['l2_count']:>5} {r['l1_count']:>5} {r['fragility_score']:>8.3f}")

    print(f"\nSummary: {result.get('total_l4', 0)} L4 violations, "
          f"{result.get('total_l3', 0)} L3 shared data, "
          f"{result.get('total_l2', 0)} L2 internal imports, "
          f"{result.get('total_l1', 0)} L1 public APIs")

    return 0


def cmd_cycle(args) -> int:
    """检测并列出数据流环。"""
    graph = _load_graph(args.graph)
    if graph is None:
        return 1

    try:
        from .analysis.dataflow import cycle_report
        result = cycle_report(graph, mode=args.mode)
    except ImportError as e:
        print(f"V2 analysis module not available: {e}", file=sys.stderr)
        return 1

    cycles = result.get("cycles", [])
    if not cycles:
        print("No data flow cycles detected.")
        return 0

    print(f"Data Flow Cycles (mode={args.mode}):\n")
    print(f"  Pure code cycles:     {result.get('pure_code_cycles', 0)}")
    print(f"  Data persistent cycles: {result.get('data_persistent_cycles', 0)}")
    print(f"  LLM-involved cycles:  {result.get('llm_involved_cycles', 0)}")
    print()

    for c in cycles:
        cat_label = {"pure_code": "纯代码", "data_persistent": "数据持久", "llm_involved": "LLM参与"}
        cat_str = cat_label.get(c.get("category"), c.get("category", "?"))
        risk = c.get("degradation_risk", "")
        risk_str = f"  ⚠ {risk}" if risk else ""
        print(f"  [{cat_str}] 环长 {c['length']} 跳: {' → '.join(c.get('node_names', [])[:6])}{risk_str}")

    print(f"\n{result.get('certainty_note', '')}")
    return 0


def cmd_coupling_report(args) -> int:
    """输出指定模块的耦合深度分布。"""
    graph = _load_graph(args.graph)
    if graph is None:
        return 1

    try:
        from .analysis.coupling import coupling_depth_report
        result = coupling_depth_report(graph)
    except ImportError as e:
        print(f"V2 analysis module not available: {e}", file=sys.stderr)
        return 1

    # 查找指定模块
    module_name = args.module
    reports = result.get("module_reports", [])
    found = None
    for r in reports:
        if (r.get("module_name") == module_name or
            r.get("file_path", "").endswith(module_name) or
            module_name in r.get("file_path", "")):
            found = r
            break

    if not found:
        print(f"Module '{module_name}' not found in coupling analysis.", file=sys.stderr)
        if reports:
            print("Available modules:", file=sys.stderr)
            for r in reports[:20]:
                print(f"  - {r['module_name']} ({r['file_path']})", file=sys.stderr)
        return 1

    print(f"Coupling Depth Report: {found['module_name']}")
    print(f"  File: {found['file_path']}")
    print(f"\n  L1 公开API:       {found['l1_count']:>4} 条  {'█' * min(40, found['l1_count'])}")
    print(f"  L2 内部导入:       {found['l2_count']:>4} 条  {'█' * min(40, found['l2_count'])}")
    print(f"  L3 共享数据文件:   {found['l3_count']:>4} 条  {'█' * min(40, found['l3_count'])}")
    print(f"  L4 封装穿透:       {found['l4_count']:>4} 条  {'█' * min(40, found['l4_count'])}")
    print(f"\n  Total: {found['total']} edges")
    print(f"  Fragility Score: {found['fragility_score']:.3f}")

    if found.get("l4_violations"):
        print(f"\n  L4 Violations:")
        for v in found["l4_violations"][:10]:
            print(f"    Line {v.get('line')}: {v.get('access')} — {v.get('context')}")
        if len(found["l4_violations"]) > 10:
            print(f"    ... and {len(found['l4_violations']) - 10} more")

    if found.get("l3_shared_resources"):
        print(f"\n  L3 Shared Resources:")
        for res in found["l3_shared_resources"][:10]:
            print(f"    - {res}")
        if len(found["l3_shared_resources"]) > 10:
            print(f"    ... and {len(found['l3_shared_resources']) - 10} more")

    return 0


def cmd_serve(args) -> int:
    """以 stdio 模式启动 MCP Server。

    两种模式：
      --project-root ROOT  → 分析项目 + 启动服务（Rust mcp_manager 用）
      -g GRAPH             → 加载已有图文件 + 启动服务（手动调试用）
    """
    if getattr(args, 'project_root', None):
        root = os.path.abspath(args.project_root)
        from .mcp_server import MCPServer
        server = MCPServer.from_project(root)
        # Signal readiness to the parent Rust process before entering the loop
        import json as _json
        sys.stdout.write(_json.dumps({"jsonrpc": "2.0", "method": "ready", "params": {}}) + "\n")
        sys.stdout.flush()
        server.run_stdio()
        return 0

    graph = _load_graph(args.graph)
    if graph is None:
        return 1

    from .mcp_server import MCPServer
    server = MCPServer(graph)
    print(f"MCP Server ready (graph: {graph.node_count} nodes, {graph.edge_count} edges)", file=sys.stderr)
    server.run_stdio()
    return 0


# ── V3 CLI 命令 ───────────────────────────────────────────

def cmd_check(args) -> int:
    """
    运行约束校验，输出变更摘要。

    正常流（99%）：只输出一行 "✅ 通过"
    例外流（1%）：展开为变更摘要面板

    快路径：如果源文件未变更且有缓存的 check 结果，直接返回。
    """
    import time
    root = os.path.abspath(args.root)
    graph_path = args.graph or os.path.join(root, "hologram_graph.json")
    cache_path = os.path.join(root, ".hologram", "last_check.json")
    force = getattr(args, 'force', False)

    # ── 快路径：源文件未变更 → 返回缓存结果 ──
    if not force and os.path.exists(graph_path) and os.path.exists(cache_path):
        graph_mtime = os.path.getmtime(graph_path)
        # 检查源文件是否有比图更新的
        src_newer = False
        exts = {'.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs'}
        for dirpath, _, filenames in os.walk(root):
            # 跳过隐藏目录和 venv
            basename = os.path.basename(dirpath)
            if basename.startswith('.') or basename == 'venv' or basename == 'node_modules':
                continue
            for fn in filenames:
                ext = os.path.splitext(fn)[1]
                if ext in exts:
                    fp = os.path.join(dirpath, fn)
                    try:
                        if os.path.getmtime(fp) > graph_mtime:
                            src_newer = True
                            break
                    except OSError:
                        pass
            if src_newer:
                break

        if not src_newer:
            # 源文件没变过，直接返回缓存的 check 结果
            try:
                with open(cache_path, 'r', encoding='utf-8') as f:
                    cached = f.read()
                if args.json:
                    # 兼容旧缓存格式：如果缓存是外层包装 dict，提取 summary
                    try:
                        data = json.loads(cached)
                        if isinstance(data, dict) and "summary" in data:
                            cached = json.dumps(data["summary"], ensure_ascii=False)
                    except Exception:
                        pass
                    _safe_print(cached)
                else:
                    try:
                        data = json.loads(cached)
                        _safe_print(data.get('one_line', 'OK (cached, no changes)'))
                    except Exception:
                        _safe_print(cached)
                return 0
            except Exception:
                pass  # 缓存损坏，继续完整分析

    # Step 1: 加载旧图 — 优先使用上一次 check 保存的快照
    # hologram_before.json 是上一次 check 结束时保存的基线，不受 watcher 增量分析影响
    before_snapshot_path = os.path.join(root, "hologram_before.json")
    before_graph = None
    if os.path.exists(before_snapshot_path):
        try:
            before_graph = Graph.from_json(before_snapshot_path)
        except Exception as e:
            print(f"Warning: could not load before snapshot: {e}", file=sys.stderr)
    if before_graph is None and os.path.exists(graph_path):
        try:
            before_graph = Graph.from_json(graph_path)
        except Exception as e:
            print(f"Warning: could not load previous graph: {e}", file=sys.stderr)

    # Step 2: 重新分析项目生成新图
    print(f"Re-analyzing: {root}", file=sys.stderr)
    from .adapters import AdapterRegistry, PythonAdapter
    from .adapters.typescript_adapter import TypeScriptAdapter
    from .adapters.tree_sitter_adapter import TreeSitterAdapter
    from .pipeline import PipelineRunner
    from .core.merger import CrossFileResolver
    from .core.community import CommunityDetector

    registry = AdapterRegistry()
    registry.register(TreeSitterAdapter())
    registry.register(PythonAdapter())
    registry.register(TypeScriptAdapter())

    runner = PipelineRunner(registry)
    after_graph, report = runner.run(
        root,
        on_progress=lambda f, i, t: print(f"  [{i}/{t}] {f}", file=sys.stderr),
    )

    # 跨文件解析
    resolver = CrossFileResolver()
    cross_added = resolver.resolve(after_graph)
    if cross_added:
        print(f"  Cross-file edges resolved: {cross_added}", file=sys.stderr)

    # 社区发现
    detector = CommunityDetector()
    communities = detector.detect(after_graph)
    if communities:
        print(f"  Communities: {len(communities)}", file=sys.stderr)

    # 保存新图
    after_graph.to_json(graph_path)
    # 同步更新 MsgPack（前端优先加载 .hologram，不同步会导致读到旧数据）
    msgpack_path = graph_path.replace('.json', '.hologram')
    try:
        after_graph.to_msgpack(msgpack_path)
    except Exception:
        pass
    print(f"Graph saved: {graph_path} ({after_graph.node_count} nodes, "
          f"{after_graph.edge_count} edges)", file=sys.stderr)

    # 保存基线快照 — 供下次 check 的 before_graph 和前端 diff 按钮使用
    import shutil
    try:
        shutil.copy2(graph_path, before_snapshot_path)
    except Exception:
        pass

    # 首次扫描：无旧图 → 跳过变更检测，不生成简报
    # 简报系统设计为增量变更场景，首次索引把所有文件当"变更"无意义
    if before_graph is None:
        import datetime
        summary_dict = {
            "passed": True,
            "timestamp": datetime.datetime.now().isoformat(),
            "changed_files": [],
            "total_changed_files": 0,
            "l5_violations": [],
            "l4_violations": [],
            "l3_violations": [],
            "l2_violations": [],
            "passed_checks": [],
            "blast_radius": 0,
            "cross_community_edges": 0,
            "new_cycles": 0,
            "new_thread_conflicts": 0,
            "api_signature_changes": 0,
            "is_first_scan": True,
        }
        json_output = safe_json_dumps(summary_dict, ensure_ascii=False)
        if args.json:
            _safe_print(json_output)
        else:
            _safe_print(f"首次索引完成 ({after_graph.node_count} 节点, {after_graph.edge_count} 边) — 增量简报将在下次变更时触发")
        # 缓存结果
        try:
            os.makedirs(os.path.join(root, ".hologram"), exist_ok=True)
            with open(cache_path, 'w', encoding='utf-8') as f:
                f.write(json_output)
        except Exception:
            pass
        return 0

    # Step 3: 收集变更文件
    changed_files: List[str] = []
    if before_graph:
        differ = GraphDiffer()
        diff = differ.diff(before_graph, after_graph)

        # 从变更节点中提取文件列表
        changed_file_set: set = set()
        for mn in diff.modified_nodes:
            node = after_graph.get_node(mn.node_id)
            if node and node.location:
                f = file_from_location(node.location) if node.location else node.location
                changed_file_set.add(f)
        for n in diff.added_nodes:
            if n.location:
                f = file_from_location(n.location) if n.location else n.location
                changed_file_set.add(f)
        for n in diff.removed_nodes:
            if n.location:
                f = file_from_location(n.location) if n.location else n.location
                changed_file_set.add(f)
        changed_files = sorted(changed_file_set)

    if not changed_files:
        import datetime as _dt_nochg
        if args.json:
            _safe_print(safe_json_dumps({
                "passed": True,
                "timestamp": _dt_nochg.datetime.now().isoformat(),
                "changed_files": [],
                "total_changed_files": 0,
                "l5_violations": [],
                "l4_violations": [],
                "l3_violations": [],
                "l2_violations": [],
                "passed_checks": [],
                "blast_radius": 0,
                "cross_community_edges": 0,
                "new_cycles": 0,
                "new_thread_conflicts": 0,
                "api_signature_changes": 0,
            }, ensure_ascii=False))
        else:
            _safe_print("No changes detected — passed.")
        return 0

    print(f"Changed files: {len(changed_files)}", file=sys.stderr)

    # Step 4: 读取变更文件的源码
    from .routing.patterns import FileChange
    file_changes: Dict[str, FileChange] = {}
    for fp in changed_files:
        full_path = os.path.join(root, fp) if not os.path.isabs(fp) else fp
        if os.path.exists(full_path):
            try:
                with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                    source = f.read()
            except Exception:
                source = ""
            file_changes[fp] = FileChange(
                file_path=fp,
                old_source=None,   # 无旧源码（可扩展为 git diff）
                new_source=source,
            )

    # Step 5-8: 运行 V3 全量约束校验（CLI/MCP 共用核心）
    from .routing.preflight import run_full_check
    check_result = run_full_check(
        before_graph=before_graph,
        after_graph=after_graph,
        changed_files=changed_files,
        file_changes=file_changes,
        project_root=root,
    )

    # Step 9: 输出 — 使用 summary 字段（匹配前端 CheckResult 接口，含 l5/l4/l3/l2_violations 等扁平字段）
    import datetime as _dt
    output_data = check_result.get("summary", check_result) if isinstance(check_result, dict) else check_result
    json_output = safe_json_dumps(output_data, indent=2, ensure_ascii=False)
    if args.json:
        _safe_print(json_output)
    elif check_result["passed"]:
        _safe_print(check_result["one_line"])
    else:
        # 从 check_result 重建 ChangeSummary 以使用 render_panel
        from .routing.summary import ChangeSummary, ChangeSummaryGenerator
        s = check_result["summary"]
        summary_obj = ChangeSummary(
            passed=check_result["passed"],
            timestamp=s.get("timestamp", _dt.datetime.now().isoformat()),
            commit_hash=s.get("commit_hash", ""),
            changed_files=s.get("changed_files", []),
            total_changed_files=s.get("total_changed_files", 0),
            l5_violations=s.get("l5_violations", []),
            l4_violations=s.get("l4_violations", []),
            l3_violations=s.get("l3_violations", []),
            l2_violations=s.get("l2_violations", []),
            passed_checks=s.get("passed_checks", []),
            blast_radius=s.get("blast_radius", 0),
            cross_community_edges=s.get("cross_community_edges", 0),
            new_cycles=s.get("new_cycles", 0),
            new_thread_conflicts=s.get("new_thread_conflicts", 0),
            api_signature_changes=s.get("api_signature_changes", 0),
        )
        _safe_print(ChangeSummaryGenerator.render_panel(summary_obj))

    # Step 9.5: 缓存 check 结果（加速二次调用）
    try:
        os.makedirs(os.path.join(root, ".hologram"), exist_ok=True)
        with open(cache_path, 'w', encoding='utf-8') as f:
            f.write(json_output)
    except Exception:
        pass

    # Step 10: 写入时间轴
    try:
        from .timeline import TimelineStore
        with TimelineStore(root) as store:
            store.record(
                event_type="commit_violation" if not check_result["passed"] else "commit_clean",
                file=", ".join(changed_files[:3]),
                changed_by=f"hologram check {'⚠' if not check_result['passed'] else '✅'}",
                summary=check_result["one_line"],
                properties={
                    "passed": check_result["passed"],
                    "violations": check_result.get("summary", check_result),
                    "signals_count": check_result.get("signals_count", 0),
                },
            )
    except Exception:
        pass

    # 用 --json 时始终返回 0：pass/fail 信息已在 JSON 中编码，
    # 非零 exit code 在 Tauri/HTTP 层会被误判为"命令失败"而丢弃 JSON 输出。
    return 0


def cmd_constraints(args) -> int:
    """管理约束配置。"""
    root = os.path.abspath(args.root) if args.root else os.getcwd()

    if args.init:
        from .routing.constraints import ConstraintChecker
        path = ConstraintChecker.write_default_config(root)
        print(f"Default constraints config created: {path}")
        return 0

    # 列出当前配置
    from .routing.constraints import ConstraintChecker
    checker = ConstraintChecker(root)
    cfg = checker.config

    print(f"Constraints for: {root}")
    print(f"  Config file: {os.path.join(root, ConstraintChecker.CONFIG_FILE_NAME)}")
    print(f"  Exists: {os.path.exists(os.path.join(root, ConstraintChecker.CONFIG_FILE_NAME))}")
    print()

    print("  -- Routing --")
    for key, val in cfg.routing.items():
        status = "[ROUTED]" if val else "[suppressed]"
        print(f"    {key}: {status}")

    print("  -- Thresholds --")
    for key, val in cfg.thresholds.items():
        print(f"    {key}: {val}")

    if cfg.allowlist_modules:
        print("  -- Allowlist Modules --")
        for m in cfg.allowlist_modules:
            print(f"    {m}")
    if cfg.allowlist_files:
        print("  -- Allowlist Files --")
        for f in cfg.allowlist_files:
            print(f"    {f}")
    if cfg.denylist_keywords:
        print("  -- Denylist Keywords --")
        for k in cfg.denylist_keywords:
            print(f"    {k}")

    print()
    print("  Use --init to generate default config file if it doesn't exist.")
    return 0


def cmd_incremental(args) -> int:
    """增量分析：只分析给定变更文件，输出 GraphDiff JSON。"""
    root = os.path.abspath(args.root)
    files = args.files

    registry = AdapterRegistry()
    registry.register(TreeSitterAdapter())
    registry.register(PythonAdapter())
    registry.register(TypeScriptAdapter())

    # 加载已有图
    graph_path = args.graph or os.path.join(root, "hologram_graph.json")
    if os.path.exists(graph_path):
        graph = Graph.from_json(graph_path)
    else:
        graph = Graph(source_root=root)

    runner = PipelineRunner(registry)
    diff: GraphDiff = runner.run_incremental(root, files, graph)

    # 增量跨文件解析
    if diff.added_nodes:
        resolver = CrossFileResolver()
        changed_ids = [n.id for n in diff.added_nodes]
        resolver.resolve_incremental(graph, changed_ids)

    # 保存图
    graph.to_json(graph_path)
    try:
        graph.to_msgpack(graph_path.replace('.json', '.hologram'))
    except Exception:
        pass

    # 输出 diff JSON
    print(json.dumps({
        "added_nodes": [n.to_dict() for n in diff.added_nodes],
        "removed_nodes": [n.to_dict() for n in diff.removed_nodes if n.id],
        "modified_nodes": [
            {"node_id": mn.node_id, "name": mn.name, "changed": mn.changed_properties}
            for mn in diff.modified_nodes
        ],
        "added_edges": [e.to_dict() for e in diff.added_edges],
    }, indent=2, ensure_ascii=False))

    return 0


def cmd_preflight(args) -> int:
    """起飞前检查：变更这些文件会产生什么影响？"""
    root = os.path.abspath(args.root)
    graph_path = args.graph or os.path.join(root, "hologram_graph.json")

    if not os.path.exists(graph_path):
        print(f"Error: 图文件不存在: {graph_path}", file=sys.stderr)
        print("请先运行 hologram analyze", file=sys.stderr)
        return 1

    graph = Graph.from_json(graph_path)

    changed_files = args.files or []
    if not changed_files:
        # 如果没指定文件，检查所有文件
        changed_files = sorted(set(
            file_from_location(node.location) if node.location else node.location
            for node in graph.nodes.values()
            if node.location
        ))

    from .routing.preflight import run_preflight
    report = run_preflight(graph, changed_files, project_root=root)

    if args.json:
        _safe_print(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
    else:
        _print_preflight_text(report)

    # 用 --json 时始终返回 0：risk_level 已在 JSON 中编码。
    return 0


def _print_preflight_text(report) -> None:
    """终端友好的 preflight 报告渲染。"""
    W = 66

    def _box(text: str) -> str:
        return f"| {text:<{W - 4}} |"

    print(f"+{'=' * (W - 2)}+")
    print(_box("PREFLIGHT CHECK — 起飞前检查"))
    print(_box(""))

    # Risk badge
    risk_icons = {"low": "🟢", "medium": "🟡", "high": "🟠", "critical": "🔴"}
    icon = risk_icons.get(report.risk_level, "⚪")
    print(_box(f"风险等级: {icon} {report.risk_level.upper()}  (评分: {report.risk_score}/100)"))
    print(_box(""))

    # Files
    print(_box(f"检查文件: {len(report.files_checked)} 个"))
    for f in report.files_checked[:5]:
        print(_box(f"  - {os.path.basename(f)}"))
    if len(report.files_checked) > 5:
        print(_box(f"  ... 还有 {len(report.files_checked) - 5} 个"))
    print(_box(""))

    # Impact
    print(_box(f"直接影响节点: {report.nodes_directly_changed}"))
    print(_box(f"波及节点数:   {report.blast_radius}"))
    print(_box(""))

    # Coupling
    if report.l4_violations > 0:
        print(_box(f"L4 封装穿透: {report.l4_violations} 个"))
    else:
        print(_box("L4 封装穿透: 无"))

    # Community
    if report.cross_community:
        comms = ", ".join(c["community_label"] for c in report.cross_community_details)
        print(_box(f"跨社区影响: 是 — {comms}"))
    else:
        print(_box("跨社区影响: 否"))

    # Cycles
    if report.cycles_touched > 0:
        print(_box(f"涉及数据流环: {len(report.cycle_details)} 个"))
    print(_box(""))

    # Warnings
    if report.warnings:
        print(_box("⚠ 警告:"))
        for w in report.warnings:
            print(_box(f"  - {w}"))
        print(_box(""))

    # Per-file details
    if report.per_file:
        print(_box("按文件详情:"))
        for pf in report.per_file[:5]:
            total_impact = sum(n["impact_count"] for n in pf["nodes"])
            print(_box(f"  {os.path.basename(pf['file'])}: {len(pf['nodes'])} 节点, 波及 {total_impact}"))
        print(_box(""))

    print(f"+{'=' * (W - 2)}+")


def cmd_health(args) -> int:
    """健康趋势报告：聚合时间轴 + 耦合快照。"""
    root = os.path.abspath(args.root)
    graph_path = args.graph or os.path.join(root, "hologram_graph.json")

    from .routing.preflight import run_health

    graph = None
    if os.path.exists(graph_path):
        graph = Graph.from_json(graph_path)

    report = run_health(root, graph=graph, days=args.days)

    if args.json:
        _safe_print(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
    else:
        _print_health_text(report)

    # 用 --json 时始终返回 0：health_score 已在 JSON 中编码。
    return 0


def _print_health_text(report) -> None:
    """终端友好的 health 报告渲染。"""
    W = 66

    def _box(text: str) -> str:
        return f"| {text:<{W - 4}} |"

    # Health score color
    if report.health_score >= 80:
        badge = f"🟢 {report.health_score}/100"
    elif report.health_score >= 50:
        badge = f"🟡 {report.health_score}/100"
    else:
        badge = f"🔴 {report.health_score}/100"

    print(f"+{'=' * (W - 2)}+")
    print(_box("PROJECT HEALTH — 项目健康趋势"))
    print(_box(""))
    print(_box(f"健康评分: {badge}"))
    print(_box(""))

    # Graph snapshot
    print(_box(f"图规模: {report.total_nodes} 节点, {report.total_edges} 边, "
              f"{report.community_count} 社区"))
    print(_box(""))

    # Coupling
    cd = report.coupling_distribution
    if cd:
        print(_box(f"耦合分布: L1={cd.get('l1', 0)} L2={cd.get('l2', 0)} "
                  f"L3={cd.get('l3', 0)} L4={cd.get('l4', 0)}"))

    # Cycles
    print(_box(f"数据流环: {report.cycle_count} 个 "
              f"(数据持久={report.data_persistent_cycles}, "
              f"LLM参与={report.llm_involved_cycles})"))
    print(_box(""))

    # Trends
    if report.trends:
        print(_box("趋势:"))
        for key, val in report.trends.items():
            label = {"coupling": "耦合", "cycles": "环", "change_frequency": "变更频率"}.get(key, key)
            print(_box(f"  {label}: {val}"))

    print(_box(""))

    # Timeline
    print(_box(f"时间轴事件: {report.timeline_total_events} 总计, "
              f"{report.timeline_recent_changes} 近期"))
    print(_box(""))

    # Top changed
    if report.top_changed_files:
        print(_box("高频变更文件:"))
        for f in report.top_changed_files[:5]:
            print(_box(f"  {os.path.basename(f['file'])} — {f['changes']} 次"))
        print(_box(""))

    # Fragility
    if report.fragility_top5:
        print(_box("最脆弱模块 Top 5:"))
        for r in report.fragility_top5:
            print(_box(f"  {r['module']} — fragility={r['fragility_score']}, L4={r['l4_count']}"))
        print(_box(""))

    # Warnings
    if report.warnings:
        print(_box("⚠ 警告:"))
        for w in report.warnings:
            print(_box(f"  - {w}"))
        print(_box(""))

    print(f"+{'=' * (W - 2)}+")


def cmd_search(args) -> int:
    """模糊搜索节点——Agent 不需要知道精确 node_id。"""
    query = args.query
    graph_path = args.graph or os.path.join(os.getcwd(), "hologram_graph.json")
    limit = getattr(args, 'limit', 20)

    # Try SQLite FTS5 first (倒排索引，MATCH <1ms，vs LIKE 全表扫)
    db_path = graph_path.replace('.json', '.db')
    nodes = []
    db_used = False
    if os.path.exists(db_path):
        # Staleness check: if DB is older than JSON, regenerate from JSON
        use_db = True
        if os.path.exists(graph_path):
            db_mtime = os.path.getmtime(db_path)
            json_mtime = os.path.getmtime(graph_path)
            if db_mtime < json_mtime - 2.0:
                print(f"  SQLite DB older than JSON, regenerating...", file=sys.stderr)
                try:
                    graph = Graph.from_json(graph_path)
                    graph.to_sqlite(db_path)
                except Exception as exc:
                    print(f"  DB regeneration failed ({exc}), falling back to in-memory search", file=sys.stderr)
                    use_db = False
        if use_db:
            import sqlite3
            db_used = True
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                # FTS5 MATCH: escape special chars, split into OR terms, suffix * for prefix
                safe = query.translate(str.maketrans({c: ' ' for c in r'"*^()[]{}:+~-=&|!<>'}))
                terms = [f'"{t}"*' for t in safe.split() if t]
                fts_query = " OR ".join(terms) if terms else f'"{safe}"*'
                try:
                    for row in conn.execute(
                        "SELECT id, name, type, kind, location FROM nodes "
                        "WHERE rowid IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?) "
                        "ORDER BY degree DESC LIMIT ?",
                        (fts_query, limit),
                    ):
                        nodes.append({
                            "id": row["id"],
                            "name": row["name"],
                            "type": row["type"],
                            "kind": row["kind"],
                            "location": row["location"],
                        })
                except Exception:
                    # FTS table might not exist; fallback to LIKE
                    pattern = f"%{query}%"
                    for row in conn.execute(
                        "SELECT id, name, type, kind, location FROM nodes "
                        "WHERE name LIKE ? OR id LIKE ? "
                        "ORDER BY degree DESC LIMIT ?",
                        (pattern, pattern, limit),
                    ):
                        nodes.append({
                            "id": row["id"],
                            "name": row["name"],
                            "type": row["type"],
                            "kind": row["kind"],
                            "location": row["location"],
                        })
            finally:
                conn.close()
    if not db_used:
        # Fallback: load full graph and search in memory
        graph = _load_graph(graph_path)
        if not graph:
            return 1
        ql = query.lower()
        matched = []
        for n in graph.nodes.values():
            if ql in n.name.lower() or ql in n.id.lower():
                # Score: exact prefix match > substring in name > substring in id
                name_l = n.name.lower()
                id_l = n.id.lower()
                if name_l == ql or id_l == ql:
                    score = 300
                elif name_l.startswith(ql):
                    score = 200
                elif ql in name_l:
                    score = 100
                else:
                    score = 50
                matched.append((n, score))
        matched.sort(key=lambda x: -x[1])
        for n, _ in matched[:limit]:
            nodes.append({
                "id": n.id,
                "name": n.name,
                "type": type_val(n.type),
                "kind": getattr(n, 'kind', '') or '',
                "location": getattr(n, 'location', '') or '',
            })

    import json as _json
    print(_json.dumps(nodes, indent=2, ensure_ascii=False))
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="hologram",
        description="代码全息观测站 CLI — 代码库依赖拓扑图查询工具",
    )
    sub = parser.add_subparsers(dest="command")

    # ── V1 commands ──

    # hologram analyze
    p_analyze = sub.add_parser("analyze", help="Analyze a project directory")
    p_analyze.add_argument("root", help="Project root directory")
    p_analyze.add_argument("-o", "--output", help="Output JSON file path")
    p_analyze.set_defaults(func=cmd_analyze)

    # hologram neighbors
    p_neighbors = sub.add_parser("neighbors", help="Get first-order neighbors")
    p_neighbors.add_argument("node", help="Node name or ID")
    p_neighbors.add_argument("-g", "--graph", default="hologram_graph.json", help="Graph JSON file")
    p_neighbors.set_defaults(func=cmd_neighbors)

    # hologram impact
    p_impact = sub.add_parser("impact", help="BFS impact analysis")
    p_impact.add_argument("node", help="Node name or ID")
    p_impact.add_argument("-d", "--depth", type=int, default=3, help="BFS max depth")
    p_impact.add_argument("-g", "--graph", default="hologram_graph.json", help="Graph JSON file")
    p_impact.set_defaults(func=cmd_impact)

    # hologram path
    p_path = sub.add_parser("path", help="Find paths between two nodes")
    p_path.add_argument("from_node", help="Source node name or ID")
    p_path.add_argument("to_node", help="Target node name or ID")
    p_path.add_argument("-g", "--graph", default="hologram_graph.json", help="Graph JSON file")
    p_path.set_defaults(func=cmd_path)

    # hologram diff
    p_diff = sub.add_parser("diff", help="Compare two graph snapshots")
    p_diff.add_argument("before", help="Before graph JSON file")
    p_diff.add_argument("after", help="After graph JSON file")
    p_diff.add_argument("--json", action="store_true", help="Output structured JSON")
    p_diff.set_defaults(func=cmd_diff)

    # ── V2 commands ──

    # hologram fragile
    p_fragile = sub.add_parser("fragile", help="Show top N most fragile modules (V2)")
    p_fragile.add_argument("-l", "--limit", type=int, default=5, help="Number of top modules to show")
    p_fragile.add_argument("-g", "--graph", default="hologram_graph.json", help="Graph JSON file")
    p_fragile.set_defaults(func=cmd_fragile)

    # hologram cycle
    p_cycle = sub.add_parser("cycle", help="Detect data flow cycles (V2)")
    p_cycle.add_argument("-m", "--mode", default="all", choices=["all", "data", "llm"],
                         help="Cycle filter: all, data, llm")
    p_cycle.add_argument("-g", "--graph", default="hologram_graph.json", help="Graph JSON file")
    p_cycle.set_defaults(func=cmd_cycle)

    # hologram coupling-report
    p_coupling = sub.add_parser("coupling-report", help="Coupling depth report for a module (V2)")
    p_coupling.add_argument("module", help="Module name or file path")
    p_coupling.add_argument("-g", "--graph", default="hologram_graph.json", help="Graph JSON file")
    p_coupling.set_defaults(func=cmd_coupling_report)

    # hologram serve
    p_serve = sub.add_parser("serve", help="Start MCP Server (stdio)")
    p_serve.add_argument("-g", "--graph", default="hologram_graph.json", help="Graph JSON file")
    p_serve.add_argument("--project-root", help="Project root to analyze before serving (Rust mcp_manager)")
    p_serve.set_defaults(func=cmd_serve)

    # ── V3 commands ──

    # hologram incremental (内部用：增量更新)
    p_incremental = sub.add_parser("incremental", help="Incremental analysis for changed files (internal)")
    p_incremental.add_argument("root", help="Project root directory")
    p_incremental.add_argument("--files", nargs="+", required=True, help="Changed file paths")
    p_incremental.add_argument("-g", "--graph", help="Graph JSON file path")
    p_incremental.set_defaults(func=cmd_incremental)

    # hologram check
    p_check = sub.add_parser("check", help="Run constraint validation and show change summary (V3)")
    p_check.add_argument("root", help="Project root directory")
    p_check.add_argument("-g", "--graph", help="Graph JSON file path")
    p_check.add_argument("--json", action="store_true", help="Output structured JSON instead of text panel")
    p_check.set_defaults(func=cmd_check)

    # hologram constraints
    p_constraints = sub.add_parser("constraints", help="List or initialize constraint config (V3)")
    p_constraints.add_argument("root", nargs="?", default=".", help="Project root directory")
    p_constraints.add_argument("--init", action="store_true",
                               help="Generate default hologram.constraints.yaml")
    p_constraints.set_defaults(func=cmd_constraints)

    # hologram preflight
    p_preflight = sub.add_parser("preflight", help="Pre-flight check: what happens if these files change? (V3)")
    p_preflight.add_argument("root", help="Project root directory")
    p_preflight.add_argument("--files", nargs="+", help="Changed file paths (if omitted, checks all files)")
    p_preflight.add_argument("-g", "--graph", help="Graph JSON file path")
    p_preflight.add_argument("--json", action="store_true", help="Output structured JSON")
    p_preflight.set_defaults(func=cmd_preflight)

    # hologram health
    p_health = sub.add_parser("health", help="Project health trends — timeline + coupling snapshot (V3)")
    p_health.add_argument("root", help="Project root directory")
    p_health.add_argument("-g", "--graph", help="Graph JSON file path")
    p_health.add_argument("--days", type=int, default=30, help="Days to look back for trends (default 30)")
    p_health.add_argument("--json", action="store_true", help="Output structured JSON")
    p_health.set_defaults(func=cmd_health)

    # hologram search
    p_search = sub.add_parser("search", help="Fuzzy search for nodes by name or ID")
    p_search.add_argument("query", help="Search query (partial name or ID)")
    p_search.add_argument("-g", "--graph", help="Graph JSON file path")
    p_search.add_argument("-l", "--limit", type=int, default=20, help="Max results (default 20)")
    p_search.set_defaults(func=cmd_search)

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        sys.exit(1)

    sys.exit(args.func(args) or 0)


if __name__ == "__main__":
    main()
