"""
MCP Server：Agent 主动查询全息图的通道。
实现 MCP (Model Context Protocol) 的 tool 语义。

工具清单（21 个 — 与 CLI 全量对齐）：
  V1 查询 (7):
    hologram_neighbors(node_id)    → 一阶邻接（按边类型分组）
    hologram_impact(node_id, depth)→ BFS 波及分层
    hologram_path(from_id, to_id)  → 两点间所有路径
    hologram_history(node_id)      → 节点决策历史
    hologram_community(node_id)    → 所属社区信息
    hologram_delayed()             → 所有含时间延迟边的节点
    hologram_changes()             → 上次变更的回看标记
  V2 分析 (5):
    hologram_fragile(limit)        → 按 L4 密度排序的最脆弱模块
    hologram_cycle(mode)           → 数据流环列表
    hologram_thread_conflicts(node_id) → 线程 × 资源冲突矩阵
    hologram_coupling_report(module)   → 模块的 L1-L4 分布
    hologram_timeline(limit)       → 因果审计时间线查询
  V2 边界 (1):
    hologram_blindspots(filter)    → 边界列表 + 上下文数据
  V3 分析 (2):
    hologram_preflight(files)      → 起飞前检查：impact + coupling + community
    hologram_run_check(path)       → 全量约束校验
  V3 趋势 (1):
    hologram_run_health(path, days)→ 项目健康评分 + 趋势
  通用查询 (5):
    hologram_search(query)         → 模糊搜索节点
    hologram_graph_summary()       → 图统计摘要
    hologram_community_report(min) → 社区结构报告
    hologram_diff(before_path)     → 与基线快照对比
    hologram_analyze(path)         → 重新分析项目
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional

from .core.graph import Graph, file_from_location, type_val, safe_json_dumps


class MCPServer:
    """
    MCP Server 简易实现。

    遵循 MCP JSON-RPC 协议的最小语义：
      - 从 stdin 读 JSON-RPC 请求
      - 向 stdout 写 JSON-RPC 响应
      - 支持 tools/list 和 tools/call
    """

    def __init__(self, graph: Graph):
        self.graph = graph

        # 懒加载 V2 分析模块
        self._coupling_result: Optional[Dict[str, Any]] = None
        self._cycle_result: Optional[Dict[str, Any]] = None
        self._boundaries: Optional[List[Dict[str, Any]]] = None

        # 防重入锁：防止 _tool_analyze 被并发调用导致全量分析重复执行
        import threading
        self._analyze_lock = threading.Lock()

        self._tools = {
            # V1 tools
            "hologram_neighbors": self._tool_neighbors,
            "hologram_impact": self._tool_impact,
            "hologram_path": self._tool_path,
            "hologram_history": self._tool_history,
            "hologram_community": self._tool_community,
            "hologram_delayed": self._tool_delayed,
            "hologram_changes": self._tool_changes,
            # V2 analysis tools
            "hologram_fragile": self._tool_fragile,
            "hologram_cycle": self._tool_cycle,
            "hologram_thread_conflicts": self._tool_thread_conflicts,
            "hologram_coupling_report": self._tool_coupling_report,
            "hologram_timeline": self._tool_timeline,
            # V2 boundary routing
            "hologram_blindspots": self._tool_blindspots,
            # V3 preflight
            "hologram_preflight": self._tool_preflight,
            # V3+ parity
            "hologram_search": self._tool_search,
            "hologram_graph_summary": self._tool_graph_summary,
            "hologram_community_report": self._tool_community_report,
            "hologram_diff": self._tool_diff,
            "hologram_analyze": self._tool_analyze,
            "hologram_run_check": self._tool_run_check,
            "hologram_run_health": self._tool_run_health,
            "hologram_rename": self._tool_rename,
        }

        self._tool_definitions = [
            # ── V1 tools ──
            {
                "name": "hologram_neighbors",
                "description": "Get first-order neighbors of a node, grouped by edge type (structural/data/temporal).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "node_id": {"type": "string", "description": "The node ID"},
                    },
                    "required": ["node_id"],
                },
            },
            {
                "name": "hologram_impact",
                "description": "BFS impact analysis from a node. Returns layered results with distance, edge types, and temporal delay info.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "node_id": {"type": "string", "description": "The source node ID"},
                        "depth": {"type": "integer", "description": "BFS max depth (default 3)"},
                    },
                    "required": ["node_id"],
                },
            },
            {
                "name": "hologram_path",
                "description": "Find all paths between two nodes. Each path includes hop count and edge types.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "from_id": {"type": "string", "description": "Source node ID"},
                        "to_id": {"type": "string", "description": "Target node ID"},
                    },
                    "required": ["from_id", "to_id"],
                },
            },
            {
                "name": "hologram_history",
                "description": "Get decision history for a node — what decisions involved this node.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "node_id": {"type": "string", "description": "The node ID"},
                    },
                    "required": ["node_id"],
                },
            },
            {
                "name": "hologram_community",
                "description": "Get community information for a node — its community, parent, and sibling nodes.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "node_id": {"type": "string", "description": "The node ID"},
                    },
                    "required": ["node_id"],
                },
            },
            {
                "name": "hologram_delayed",
                "description": "Get all nodes connected via temporal edges with non-null delays. Includes delay duration and trigger type.",
                "inputSchema": {"type": "object", "properties": {}},
            },
            {
                "name": "hologram_changes",
                "description": "Get change markers from the last commit comparison — hit (predicted correctly), miss (changed but not predicted), over (predicted but not changed).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_root": {"type": "string", "description": "Project root path"},
                    },
                },
            },
            # ── V2 analysis tools ──
            {
                "name": "hologram_fragile",
                "description": "Get top N most fragile modules ranked by L4 encapsulation violation density. Requires coupling analysis to have been run.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "description": "Number of top fragile modules to return (default 5)"},
                    },
                },
            },
            {
                "name": "hologram_cycle",
                "description": "Get all detected data flow cycles. Filter by mode: all (default), data (data-persistent + LLM), llm (LLM-involved only).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "mode": {"type": "string", "description": "Filter: all, data, or llm (default all)"},
                    },
                },
            },
            {
                "name": "hologram_thread_conflicts",
                "description": "Get thread × resource conflict matrix for a node or the entire graph.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "node_id": {"type": "string", "description": "Optional node ID — if omitted, returns global matrix"},
                    },
                },
            },
            {
                "name": "hologram_coupling_report",
                "description": "Get complete coupling depth distribution (L1-L4 stats + per-edge details) for a module.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "module_name": {"type": "string", "description": "Module file name or path (e.g. 'data_sync.py' or full path)"},
                    },
                    "required": ["module_name"],
                },
            },
            # ── V2 boundary routing ──
            {
                "name": "hologram_blindspots",
                "description": "Get all detected boundaries (L4 violations, unlocked concurrency, LLM feedback loops). Returns boundary list with context data for each. Filter by type: all, L4, thread, cycle.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "filter": {"type": "string", "description": "Boundary type filter: all, L4, thread, cycle (default all)"},
                    },
                },
            },
            # ── V2 timeline ──
            {
                "name": "hologram_timeline",
                "description": "Query the causal audit timeline — code changes, data file changes, events aligned on time axis.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "description": "Max events to return (default 100)"},
                        "since": {"type": "string", "description": "ISO timestamp to filter events after (optional)"},
                    },
                },
            },
            # ── V3 preflight ──
            {
                "name": "hologram_preflight",
                "description": "Pre-flight check: analyze what would happen if the given files change. Combines impact BFS, coupling depth, community cross-edges, and cycle detection. Returns risk level and warnings.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "files": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "List of file paths that would be changed",
                        },
                    },
                    "required": ["files"],
                },
            },
            # ── V3+ parity tools (补齐 CLI 全量) ──
            {
                "name": "hologram_search",
                "description": "Fuzzy search for nodes by name or ID. Returns matching symbols with their IDs, types, degrees, and locations. Use this as the FIRST step when looking for a function/class/module but don't know its exact name or ID.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Partial name or ID to search for"},
                        "limit": {"type": "integer", "description": "Max results (default 20)", "default": 20},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "hologram_graph_summary",
                "description": "Get a high-level summary of the current dependency graph: total nodes/edges, node type distribution, edge type distribution, density, community count, and coupling depth breakdown if available.",
                "inputSchema": {"type": "object", "properties": {}},
            },
            {
                "name": "hologram_community_report",
                "description": "Report on community/cluster structure in the codebase. Returns all communities above the minimum size threshold, sorted by size.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "min_size": {"type": "integer", "description": "Minimum community size to report (default 3)", "default": 3},
                    },
                },
            },
            {
                "name": "hologram_diff",
                "description": "Diff the current graph against a baseline snapshot. Returns added/removed/modified nodes and edges.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "before_path": {"type": "string", "description": "Path to the baseline graph JSON file"},
                    },
                    "required": ["before_path"],
                },
            },
            {
                "name": "hologram_analyze",
                "description": "Re-analyze a project directory and reload the graph. Use when switching to a different project or refreshing after major changes.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Project root directory path"},
                    },
                    "required": ["path"],
                },
            },
            {
                "name": "hologram_run_check",
                "description": "Run full constraint validation (V3) on the current project. Checks against constraints and returns violations found plus confirmation of rules that pass. Use for thorough project audits.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Project root directory path"},
                    },
                    "required": ["path"],
                },
            },
            {
                "name": "hologram_run_health",
                "description": "Project health overview (V3): aggregates timeline change history and coupling snapshot to compute a health score (0-100), trends, top changed files, and most fragile modules.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Project root directory path"},
                        "days": {"type": "integer", "description": "Days to look back (default 30)", "default": 30},
                    },
                    "required": ["path"],
                },
            },
            {
                "name": "hologram_rename",
                "description": (
                    "Safely rename a symbol (function, class, method, variable) across the entire codebase. "
                    "Uses the dependency graph to find ALL references — not text grep — so comments and "
                    "string literals are never false positives. Updates all files atomically with rollback. "
                    "Always run with dry_run=true first to preview changes before executing."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "old_name": {"type": "string", "description": "Current name of the symbol to rename"},
                        "new_name": {"type": "string", "description": "New name for the symbol"},
                        "dry_run": {"type": "boolean", "description": "Preview only, do not modify files (default: false)", "default": False},
                        "node_id": {"type": "string", "description": "Optional: specific node ID to rename when multiple symbols share the same name"},
                    },
                    "required": ["old_name", "new_name"],
                },
            },
        ]

    @classmethod
    def from_project(cls, root: str) -> "MCPServer":
        """分析项目并创建 MCP Server — 一体化入口。

        供 Rust mcp_manager 通过 `serve --project-root` 调用。
        运行完整分析管线后返回就绪的 MCPServer 实例。
        """
        import sys
        print(f"[MCP] 开始分析项目: {root}", file=sys.stderr)

        from .adapters import AdapterRegistry, PythonAdapter
        from .adapters.typescript_adapter import TypeScriptAdapter
        from .adapters.tree_sitter_adapter import TreeSitterAdapter
        from .pipeline import PipelineRunner

        registry = AdapterRegistry()
        registry.register(TreeSitterAdapter())
        registry.register(PythonAdapter())
        registry.register(TypeScriptAdapter())

        runner = PipelineRunner(registry)
        graph, report = runner.run(root)

        # 跨文件关系解析
        # 注意：runner.run() 已经调用了 resolve()，这里不再重复调用
        # 但保留这段代码以兼容旧版本或手动调用场景

        # 社区发现 → 懒加载（首次 hologram_community_report / hologram_community 调用时触发）
        # 大型项目的 Leiden 递归聚类可能超过 120s MCP 启动超时，改延迟初始化。
        graph.communities = []  # 占位，_ensure_communities 会在首次访问时填充

        # 耦合分析
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

        # 布局预计算已在首次分析时完成（坐标随 graph JSON 写入磁盘），
        # MCP 不需要布局——它只做图查询，不渲染。跳过可省 2-5 分钟启动时间。
        print(f"[MCP] 分析完成: {graph.node_count} 节点, {graph.edge_count} 边, {report.elapsed_sec:.1f}s", file=sys.stderr)

        return cls(graph)

    # ── 辅助: 从 location 提取文件路径 ─────────────────────


    # ── V2: 懒加载分析结果 ────────────────────────────────

    def _ensure_coupling(self) -> Dict[str, Any]:
        if self._coupling_result is not None:
            return self._coupling_result
        try:
            from .analysis.coupling import coupling_depth_report
            self._coupling_result = coupling_depth_report(self.graph)
        except Exception as e:
            self._coupling_result = {"error": str(e), "module_reports": []}
        return self._coupling_result

    def _ensure_cycles(self) -> Dict[str, Any]:
        if self._cycle_result is not None:
            return self._cycle_result
        try:
            from .analysis.dataflow import cycle_report
            self._cycle_result = cycle_report(self.graph)
        except Exception as e:
            self._cycle_result = {"error": str(e), "cycles": []}
        return self._cycle_result

    def _ensure_boundaries(self) -> List[Dict[str, Any]]:
        if self._boundaries is not None:
            return self._boundaries
        try:
            from .analysis.blindspots import BoundaryDetector
            detector = BoundaryDetector()
            coupling = self._ensure_coupling()
            cycles = self._ensure_cycles()
            detector.detect_from_coupling(coupling)
            detector.detect_from_cycles(cycles)
            self._boundaries = [b.to_dict() for b in detector.all()]
            self._boundary_detector = detector
        except Exception:
            self._boundaries = []
            self._boundary_detector = None
        return self._boundaries

    def _ensure_communities(self) -> List[Dict[str, Any]]:
        """懒加载社区检测 — 首次 hologram_community_report 调用时触发。
        使用 Label Propagation（O(n+m) 近线性），秒级完成。"""
        if self.graph.communities:
            return self.graph.communities
        try:
            from .core.community import detect_fast
            communities = detect_fast(self.graph)
            if communities:
                self.graph.communities = communities
                # Backfill: 每个节点归属其社区
                for node in self.graph.nodes.values():
                    node.community_id = None
                for comm in communities:
                    for nid in comm.node_ids:
                        node = self.graph.get_node(nid)
                        if node is not None:
                            node.community_id = comm.id
                print(f"  [lazy] Communities detected: {len(communities)}", file=sys.stderr)
            return self.graph.communities
        except Exception as e:
            print(f"  community detection skipped: {e}", file=sys.stderr)
            self.graph.communities = []
            return []

    # ── 参数提取辅助 ────────────────────────────────────────

    @staticmethod
    def _get_node_id(args: Dict[str, Any]) -> str:
        """从工具参数中提取 node_id，兼容 nodeId (JS 驼峰) 和 node_id (Python 蛇形)。
        不做 json.loads — node ID 就是裸字符串。"""
        # 先取蛇形（Python schema），再取驼峰（前端硬编码 fallback）
        nid = args.get("node_id") or args.get("nodeId") or ""
        # 防御：即使调用方传了奇怪的值，也当字符串用
        return str(nid)

    # ── V1 工具实现 ────────────────────────────────────────

    def _tool_neighbors(self, args: Dict[str, Any]) -> Dict[str, Any]:
        node_id = self._get_node_id(args)
        node = self.graph.get_node(node_id)
        if not node:
            return {"error": f"Node {node_id} not found"}

        neighbors = self.graph.neighbors(node_id)
        incoming = self.graph.incoming_edges(node_id)
        outgoing = self.graph.outgoing_edges(node_id)

        def group_by_type(edges):
            result: Dict[str, list] = {}
            for e in edges:
                t = getattr(e, 'type', 'unknown')
                t_val = t.value if hasattr(t, 'value') else str(t)
                result.setdefault(t_val, []).append(e.to_dict())
            return result

        return {
            "node": node.to_dict(),
            "neighbor_count": len(neighbors),
            "neighbors": [n.to_dict() for n in neighbors],
            "incoming": group_by_type(incoming),
            "outgoing": group_by_type(outgoing),
        }

    def _tool_impact(self, args: Dict[str, Any]) -> Dict[str, Any]:
        node_id = self._get_node_id(args)
        depth = args.get("depth", 3)
        layers = self.graph.impact_bfs(node_id, depth)
        total_affected = sum(len(layer["nodes"]) for layer in layers) - 1

        delayed_nodes = []
        for layer in layers:
            for n in layer.get("nodes", []):
                nid = n.get("id", "")
                outgoing = self.graph.outgoing_edges(nid)
                for e in outgoing:
                    delay = getattr(e, 'temporal_delay_sec', None)
                    if delay:
                        delayed_nodes.append({
                            "node_id": nid,
                            "node_name": n.get("name", nid),
                            "delay_sec": delay,
                            "edge_id": e.id,
                        })

        return {
            "source_node_id": node_id,
            "max_depth": depth,
            "total_affected_nodes": total_affected,
            "delayed_nodes": delayed_nodes,
            "layers": layers,
        }

    def _tool_path(self, args: Dict[str, Any]) -> Dict[str, Any]:
        from_id = args["from_id"]
        to_id = args["to_id"]
        paths = self.graph.paths(from_id, to_id)
        return {
            "from_id": from_id,
            "to_id": to_id,
            "path_count": len(paths),
            "paths": paths[:20],
        }

    def _tool_history(self, args: Dict[str, Any]) -> Dict[str, Any]:
        node_id = self._get_node_id(args)
        node = self.graph.get_node(node_id)
        if not node:
            return {"error": f"Node {node_id} not found"}

        incoming = self.graph.incoming_edges(node_id)
        outgoing = self.graph.outgoing_edges(node_id)

        return {
            "node": node.to_dict(),
            "decision_history": node.properties.get("history", []) if node.properties else [],
            "dependency_count": len(incoming),
            "dependent_count": len(outgoing),
        }

    def _tool_community(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """局部 BFS 聚类 — 不跑全图，毫秒级。
        从节点出发 2 跳，按边权重找耦合最紧的邻居群。"""
        node_id = self._get_node_id(args)
        node = self.graph.get_node(node_id)
        if not node:
            return {"error": f"Node {node_id} not found"}

        from .core.community import detect_local
        community = detect_local(self.graph, node_id)
        if community is None:
            return {"node_id": node_id, "community": None, "message": "Node not found in graph"}

        return {
            "node_id": node_id,
            "community": community.to_dict(),
            "sibling_nodes": [nid for nid in community.node_ids if nid != node_id],
        }

    def _tool_delayed(self, args: Dict[str, Any]) -> Dict[str, Any]:
        delayed = []
        for edge in self.graph.edges.values():
            delay = getattr(edge, 'temporal_delay_sec', None)
            edge_type = type_val(edge.type)
            if delay is not None and edge_type == 'temporal':
                src = self.graph.get_node(edge.source)
                tgt = self.graph.get_node(edge.target)
                delayed.append({
                    "source": src.to_dict() if src else {"id": edge.source},
                    "target": tgt.to_dict() if tgt else {"id": edge.target},
                    "delay_sec": delay,
                    "edge_direction": getattr(edge, 'direction', 'unknown'),
                })

        realtime = [d for d in delayed if d["delay_sec"] == 0]
        periodic = [d for d in delayed if d["delay_sec"] and d["delay_sec"] > 0]

        return {
            "total_delayed_edges": len(delayed),
            "realtime_count": len(realtime),
            "periodic_count": len(periodic),
            "realtime": realtime,
            "periodic": periodic,
        }

    def _tool_changes(self, args: Dict[str, Any]) -> Dict[str, Any]:
        source_root = args.get("project_root") or getattr(self.graph, 'source_root', "")
        if not source_root:
            return {
                "message": "No project root available. Changes are recorded after git commit with snapshot comparison.",
                "changes": [],
            }

        try:
            try:
                from .timeline import TimelineStore
            except ImportError:
                from timeline import TimelineStore  # fallback for non-package execution
            store = TimelineStore(source_root)
            # Query the most recent file_changed or commit event
            rows = store.query(limit=1, event_type="file_changed")
            if not rows:
                rows = store.query(limit=1, event_type="commit")
            if not rows:
                store.close()
                return {"message": "No timeline data available", "changes": []}

            last = rows[0]
            related = last.get("related_nodes", [])
            total = len(store.query(limit=1000))
            commit_hash = ""
            cb = last.get("changed_by", "")
            if cb.startswith("git commit "):
                commit_hash = cb[len("git commit "):]
            store.close()

            return {
                "last_change": {
                    "timestamp": last.get("timestamp"),
                    "summary": last.get("summary"),
                    "event_type": last.get("event_type"),
                    "file": last.get("file"),
                    "impact_count": len(related),
                    "delayed_count": 0,
                    "affected_nodes": related,
                    "commit_hash": commit_hash,
                },
                "timeline_anchor_count": total,
            }
        except Exception as e:
            return {"message": f"Failed to read timeline: {e}", "changes": []}

    # ── V2 分析工具实现 ────────────────────────────────────

    def _tool_fragile(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """按 L4 边密度排序，返回 Top N 最脆弱模块。"""
        limit = args.get("limit", 5)
        coupling = self._ensure_coupling()

        if "error" in coupling:
            return {"error": coupling["error"]}

        reports = coupling.get("module_reports", [])
        # 按 fragility_score 降序，取 top N
        top = sorted(reports, key=lambda r: r.get("fragility_score", 0), reverse=True)[:limit]

        return {
            "top_fragile_modules": top,
            "total_modules_analyzed": len(reports),
            "summary": {
                "total_l4_edges": coupling.get("total_l4", 0),
                "total_l3_edges": coupling.get("total_l3", 0),
                "total_l2_edges": coupling.get("total_l2", 0),
                "total_l1_edges": coupling.get("total_l1", 0),
            },
            "note": (
                "L4 = 封装穿透（红色闪烁虚线）, L3 = 共享数据文件（橙色虚线）, "
                "L2 = 内部导入（浅蓝实线）, L1 = 公开API（蓝色实线）"
            ),
        }

    def _tool_cycle(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """返回所有检测到的数据流环。"""
        mode = args.get("mode", "all")
        cycles = self._ensure_cycles()

        if "error" in cycles:
            return {"error": cycles["error"]}

        # 重新过滤（因为懒加载默认是 all）
        all_cycles = cycles.get("cycles", [])
        if mode == "data":
            filtered = [c for c in all_cycles if c.get("category") in ("data_persistent", "llm_involved")]
        elif mode == "llm":
            filtered = [c for c in all_cycles if c.get("category") == "llm_involved"]
        else:
            filtered = all_cycles

        return {
            "total_cycles": len(filtered),
            "mode_filter": mode,
            "cycles": filtered,
            "certainty_note": cycles.get("certainty_note", ""),
        }

    def _tool_thread_conflicts(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """返回线程 × 资源冲突矩阵。"""
        node_id = args.get("node_id")

        # 收集所有时间节点（线程）
        temporal_nodes = []
        for node in self.graph.nodes.values():
            if hasattr(node, 'type'):
                nt = type_val(node.type)
                if nt == 'temporal':
                    temporal_nodes.append(node)

        # 收集所有介质节点（共享资源）
        medium_nodes = []
        for node in self.graph.nodes.values():
            if hasattr(node, 'type'):
                nt = type_val(node.type)
                if nt == 'medium':
                    medium_nodes.append(node)

        # 构建冲突矩阵
        resources: Dict[str, Dict[str, Any]] = {}
        for medium in medium_nodes:
            threads_info = []
            incoming = self.graph.incoming_edges(medium.id)
            has_write = False

            for edge in incoming:
                src_node = self.graph.get_node(edge.source)
                if src_node:
                    direction = getattr(edge, 'direction', '')
                    access = "R"
                    if direction in ("write", "subscribe"):
                        access = "W"
                        has_write = True
                    elif direction == "read":
                        # 检查是否有对应的 write
                        for e2 in self.graph.outgoing_edges(edge.source):
                            d2 = getattr(e2, 'direction', '')
                            if d2 in ("write", "subscribe") and e2.target == edge.target:
                                access = "R/W"
                                has_write = True
                                break

                    threads_info.append({
                        "name": src_node.name,
                        "location": src_node.location,
                        "access": access,
                        "thread_type": src_node.kind,
                    })

            # 检查是否有锁保护
            lock_edges = [e for e in incoming if "lock" in getattr(self.graph.get_node(e.source), 'name', '').lower()
                          or getattr(e, 'properties', {}).get('is_lock')]

            if threads_info:
                resources[medium.name] = {
                    "medium_type": medium.kind,
                    "threads": threads_info,
                    "thread_count": len(threads_info),
                    "has_concurrent_write": has_write,
                    "lock_detected": len(lock_edges) > 0,
                    "lock_edges": [e.id for e in lock_edges],
                    "files": list(set(file_from_location(t.get("location", "")) for t in threads_info)),
                }

        if node_id:
            node = self.graph.get_node(node_id)
            if not node:
                return {"error": f"Node {node_id} not found"}
            # 过滤到与该节点相关的资源
            related = {}
            for rname, info in resources.items():
                if node.location:
                    node_file = file_from_location(node.location)
                    if node_file in info.get("files", []):
                        related[rname] = info
            resources = related

        # 统计无锁保护的并发写入
        unlocked = {k: v for k, v in resources.items()
                    if v.get("has_concurrent_write") and not v.get("lock_detected")}

        return {
            "resources": resources,
            "total_shared_resources": len(resources),
            "unlocked_concurrent_writes": len(unlocked),
            "unlocked_resources": list(unlocked.keys()),
            "certainty_note": (
                "[确定] 线程声明来自静态字面量匹配。"
                "[高置信] 同一文件路径出现在两个线程中。"
                "[中等] 全局变量被两个线程引用，无法静态确定是否真的并发访问。"
                "[低置信] while+sleep 模式被识别为轮询，但可能是普通循环。"
                "不标注'安全'——只标注'检测到的风险'和'检测不到的区域'。"
            ),
        }

    def _tool_coupling_report(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """返回指定模块的完整耦合深度分布。"""
        module_name = args["module_name"]
        coupling = self._ensure_coupling()

        if "error" in coupling:
            return {"error": coupling["error"]}

        # 按模块名或文件路径查找
        reports = coupling.get("module_reports", [])
        found = None
        for r in reports:
            if (r.get("module_name") == module_name or
                r.get("file_path", "").endswith(module_name) or
                module_name in r.get("file_path", "")):
                found = r
                break

        if not found:
            return {
                "error": f"Module '{module_name}' not found in coupling analysis",
                "available_modules": [r["module_name"] for r in reports[:20]],
            }

        # 补充边级详情
        edge_details = []
        for edge in self.graph.edges.values():
            edge_file = edge.properties.get("location", "") if hasattr(edge, 'properties') else ""
            if edge_file:
                edge_file = file_from_location(edge_file)

            src_node = self.graph.get_node(edge.source)
            src_file = file_from_location(src_node.location) if src_node and src_node.location else ""

            if src_file and (module_name in src_file or src_file.endswith(module_name)):
                cd = edge.properties.get("coupling_depth") if hasattr(edge, 'properties') else None
                edge_details.append({
                    "edge_id": edge.id,
                    "type": type_val(edge.type),
                    "direction": getattr(edge, 'direction', ''),
                    "source": edge.source,
                    "target": edge.target,
                    "coupling_depth": cd,
                })

        return {
            "module_report": found,
            "edge_details": edge_details,
            "node_count": len(self.graph.find_nodes_by_location(found.get("file_path", ""))),
        }

    # ── V2 盲区路由工具实现 ────────────────────────────────

    def _tool_blindspots(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """返回边界列表 + 每个边界的上下文数据。"""
        filter_type = args.get("filter", "all")
        boundaries = self._ensure_boundaries()

        if filter_type != "all":
            type_map = {
                "L4": "L4_encapsulation_violation",
                "thread": "unlocked_concurrent_write",
                "cycle": "llm_feedback_loop",
            }
            target = type_map.get(filter_type)
            if target:
                boundaries = [b for b in boundaries if b.get("type") == target]

        return {
            "boundaries": boundaries,
            "total": len(boundaries),
            "filter": filter_type,
        }

    def _tool_timeline(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """查询因果审计时间线。"""
        limit = args.get("limit", 100)
        since = args.get("since")

        try:
            from .timeline import TimelineStore
            source_root = getattr(self.graph, 'source_root', '') or '.'
            with TimelineStore(source_root) as store:
                events = store.query(limit=limit, since=since)
                stats = store.stats()
            return {
                "events": events,
                "total_events": len(events),
                "stats": stats,
            }
        except ImportError:
            return {
                "message": "Timeline module not available. Run 'hologram analyze' with --watch to record events.",
                "events": [],
            }
        except Exception as e:
            return {"error": str(e), "events": []}

    # ── V3 preflight 工具实现 ─────────────────────────────

    def _tool_preflight(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """起飞前检查：变更这些文件会产生什么影响？"""
        files = args.get("files", [])
        if not files:
            return {"error": "No files provided", "risk_level": "unknown"}

        try:
            from .routing.preflight import run_preflight
            project_root = getattr(self.graph, 'source_root', '') or '.'
            report = run_preflight(self.graph, files, project_root=project_root)
            return report.to_dict()
        except Exception as e:
            return {"error": str(e), "risk_level": "unknown"}

    # ── V3+ parity 工具实现 ─────────────────────────────────

    def _tool_search(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """模糊搜索节点——Agent 不需要知道精确 node_id。"""
        query = args.get("query", "")
        limit = args.get("limit", 20)
        ql = query.lower()
        matched = []
        for n in self.graph.nodes.values():
            name_l = n.name.lower()
            id_l = n.id.lower()
            if ql in name_l or ql in id_l:
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
        return {
            "query": query,
            "count": min(len(matched), limit),
            "results": [
                {
                    "id": n.id,
                    "name": n.name,
                    "type": type_val(n.type),
                    "kind": getattr(n, 'kind', '') or '',
                    "location": getattr(n, 'location', '') or '',
                }
                for n, _ in matched[:limit]
            ],
        }

    def _tool_graph_summary(self, _args: Dict[str, Any]) -> Dict[str, Any]:
        """图统计摘要。"""
        nodes = list(self.graph.nodes.values())
        edges = list(self.graph.edges.values())
        node_types: Dict[str, int] = {}
        edge_types: Dict[str, int] = {}
        for n in nodes:
            nt = n.type.value if hasattr(n.type, 'value') else str(n.type)
            node_types[nt] = node_types.get(nt, 0) + 1
        for e in edges:
            et = e.type.value if hasattr(e.type, 'value') else str(e.type)
            edge_types[et] = edge_types.get(et, 0) + 1
        n = len(nodes)
        density = round((2 * len(edges)) / (n * (n - 1)), 6) if n > 1 else 0
        coupling = getattr(self.graph, 'coupling_summary', None)
        return {
            "total_nodes": n,
            "total_edges": len(edges),
            "node_types": node_types,
            "edge_types": edge_types,
            "density": density,
            "communities": getattr(self.graph, 'community_count', 0),
            "coupling": coupling,
            "top_node_kinds": sorted(node_types.items(), key=lambda x: x[1], reverse=True)[:10],
        }

    def _tool_community_report(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """社区结构报告。"""
        self._ensure_communities()
        min_size = args.get("min_size", 3)
        communities = []
        for c in self.graph.communities:
            if len(c.node_ids) >= min_size:
                communities.append(c.to_dict())
        communities.sort(key=lambda c: len(c.get("node_ids", [])), reverse=True)
        return {
            "total_communities": len(communities),
            "min_size_filter": min_size,
            "communities": communities,
        }

    def _tool_diff(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """与基线快照对比。"""
        before_path = args.get("before_path", "")
        if not before_path:
            return {"error": "before_path is required"}
        try:
            before = Graph.from_json(before_path)
            from .core.diff import GraphDiffer
            differ = GraphDiffer()
            diff = differ.diff(before, self.graph)
            return diff.to_dict()
        except FileNotFoundError:
            return {"error": f"Baseline graph not found: {before_path}"}
        except Exception as e:
            return {"error": str(e)}

    def _tool_analyze(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """重新分析项目并热加载图。防重入保护防止并发全量分析。"""
        path = args.get("path", "")
        if not path:
            return {"error": "path is required"}
        # 防重入：如果已经有分析在进行，返回等待状态
        if not self._analyze_lock.acquire(blocking=False):
            return {"error": "分析正在进行中，请稍后重试", "status": "in_progress"}
        try:
            server = MCPServer.from_project(path)
            # Hot-reload: replace our graph and reset caches
            self.graph = server.graph
            self._coupling_result = None
            self._cycle_result = None
            self._boundaries = None
            return {
                "status": "ok",
                "total_nodes": self.graph.node_count,
                "total_edges": self.graph.edge_count,
                "communities": self.graph.community_count,
            }
        except Exception as e:
            return {"error": str(e)}
        finally:
            self._analyze_lock.release()

    def _tool_run_check(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """V3 全量约束校验 — 与 CLI cmd_check 行为对齐。

        重新分析项目 → 与旧图 diff → 运行完整 V3 管线
        （耦合 + 数据流环 + 线程 + 信号生成 + 约束校验 + 摘要）。
        """
        path = args.get("path", "")
        if not path:
            return {"error": "path is required"}
        try:
            import os as _os
            # 保存旧图作为基线
            before_graph = self.graph

            # 重新分析项目
            new_server = MCPServer.from_project(path)
            after_graph = new_server.graph

            # 热加载新图 + 重置缓存
            self.graph = after_graph
            self._coupling_result = None
            self._cycle_result = None
            self._boundaries = None

            # 收集变更文件（通过 diff）
            from .core.diff import GraphDiffer
            differ = GraphDiffer()
            diff_result = differ.diff(before_graph, after_graph)

            changed_file_set: set = set()
            for mn in diff_result.modified_nodes:
                node = after_graph.get_node(mn.node_id)
                if node and node.location:
                    f = file_from_location(node.location) if node.location else node.location
                    changed_file_set.add(f)
            for n in diff_result.added_nodes:
                if n.location:
                    f = file_from_location(n.location) if n.location else n.location
                    changed_file_set.add(f)
            for n in diff_result.removed_nodes:
                if n.location:
                    f = file_from_location(n.location) if n.location else n.location
                    changed_file_set.add(f)
            changed_files = sorted(changed_file_set)

            if not changed_files:
                return {
                    "passed": True,
                    "message": "No changes detected",
                    "total_nodes": after_graph.node_count,
                    "total_edges": after_graph.edge_count,
                }

            # 读取变更文件源码
            from .routing.patterns import FileChange
            file_changes: Dict[str, Any] = {}
            for fp in changed_files:
                full_path = _os.path.join(path, fp) if not _os.path.isabs(fp) else fp
                if _os.path.exists(full_path):
                    try:
                        with open(full_path, "r", encoding="utf-8", errors="replace") as fh:
                            source = fh.read()
                    except Exception:
                        source = ""
                    file_changes[fp] = FileChange(
                        file_path=fp,
                        old_source=None,
                        new_source=source,
                    )

            # 运行完整 V3 约束校验
            from .routing.preflight import run_full_check
            result = run_full_check(
                before_graph=before_graph,
                after_graph=after_graph,
                changed_files=changed_files,
                file_changes=file_changes,
                project_root=path,
            )
            return result
        except Exception as e:
            return {"error": str(e)}

    def _tool_run_health(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """V3 健康趋势。"""
        path = args.get("path", "")
        days = args.get("days", 30)
        if not path:
            return {"error": "path is required"}
        try:
            from .routing.preflight import run_health
            report = run_health(path, graph=self.graph, days=days)
            return report.to_dict()
        except Exception as e:
            return {"error": str(e)}

    def _tool_rename(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """安全重命名符号。"""
        old_name = args.get("old_name", "")
        new_name = args.get("new_name", "")
        dry_run = args.get("dry_run", False)
        node_id = args.get("node_id", None)

        if not old_name or not new_name:
            return {"error": "old_name and new_name are required"}

        from .core.rename import preview_rename, execute_rename

        project_root = getattr(self.graph, 'source_root', '') or os.getcwd()

        if dry_run:
            return preview_rename(self.graph, old_name, new_name, node_id)
        else:
            result = execute_rename(self.graph, old_name, new_name, project_root, node_id)
            # 清除缓存 —— 图已变更
            self._coupling_result = None
            self._cycle_result = None
            self._boundaries = None
            return result

    # ── JSON-RPC 协议 ───────────────────────────────────

    def handle_request(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """处理单个 JSON-RPC 请求，返回响应或 None（通知）。"""
        method = request.get("method", "")
        req_id = request.get("id")

        if req_id is None:
            return None

        if method == "tools/list":
            return self._response(req_id, {"tools": self._tool_definitions})

        if method == "tools/call":
            params = request.get("params", {})
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})

            if tool_name not in self._tools:
                return self._error(req_id, -32601, f"Tool not found: {tool_name}")

            try:
                result = self._tools[tool_name](tool_args)
                return self._response(req_id, {
                    "content": [{"type": "text", "text": safe_json_dumps(result, indent=2, ensure_ascii=False)}],
                })
            except Exception as exc:
                return self._error(req_id, -32000, str(exc))

        return self._error(req_id, -32601, f"Method not found: {method}")

    def run_stdio(self) -> None:
        """从 stdin 读取 JSON-RPC 请求，向 stdout 写响应。"""
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue

            response = self.handle_request(request)
            if response is not None:
                sys.stdout.write(safe_json_dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()

    @staticmethod
    def _response(req_id: Any, result: Any) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    @staticmethod
    def _error(req_id: Any, code: int, message: str) -> Dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": code, "message": message},
        }
