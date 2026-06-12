"""
MCP Server：Agent 主动查询全息图的通道。
实现 MCP (Model Context Protocol) 的 tool 语义。

V1 工具（7 个）：
  - hologram_neighbors(node_id)    → 一阶邻接（按边类型分组）
  - hologram_impact(node_id, depth)→ BFS 波及分层
  - hologram_path(from_id, to_id)  → 两点间所有路径
  - hologram_history(node_id)      → 节点决策历史
  - hologram_community(node_id)    → 所属社区信息
  - hologram_delayed()             → 所有含时间延迟边的节点
  - hologram_changes()             → 上次变更的回看标记

V2 新增工具（5 个查询 + 1 个边界路由）：
  - hologram_fragile(limit)        → 按 L4 密度排序的最脆弱模块
  - hologram_cycle(mode)           → 数据流环列表
  - hologram_thread_conflicts(node_id) → 线程 × 资源冲突矩阵
  - hologram_coupling_report(module)   → 模块的 L1-L4 分布
  - hologram_timeline(limit)       → 因果审计时间线查询
  - hologram_blindspots(filter)    → 边界列表 + 上下文数据

V3 新增工具（1 个）：
  - hologram_preflight(files)      → 起飞前检查：impact + coupling + community
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional

from .core.graph import Graph, EdgeType, file_from_location, type_val


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
        ]

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

    # ── V1 工具实现 ────────────────────────────────────────

    def _tool_neighbors(self, args: Dict[str, Any]) -> Dict[str, Any]:
        node_id = args["node_id"]
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
        node_id = args["node_id"]
        depth = args.get("depth", 3)
        layers = self.graph.impact_bfs(node_id, depth)
        total_affected = sum(len(l["nodes"]) for l in layers) - 1

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
        node_id = args["node_id"]
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
        node_id = args["node_id"]
        node = self.graph.get_node(node_id)
        if not node:
            return {"error": f"Node {node_id} not found"}

        if not hasattr(node, 'community_id') or not node.community_id:
            return {"node_id": node_id, "community": None, "message": "Community detection not yet run or node not assigned"}

        for c in self.graph.communities:
            if c.id == node.community_id:
                return {
                    "node_id": node_id,
                    "community": c.to_dict(),
                    "sibling_nodes": [nid for nid in c.node_ids if nid != node_id],
                }
        return {"node_id": node_id, "community": None}

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
                from src_python.timeline import TimelineStore
            except ImportError:
                from timeline import TimelineStore
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
            has_lock = False

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
                    "content": [{"type": "text", "text": json.dumps(result, indent=2, ensure_ascii=False)}],
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
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
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
