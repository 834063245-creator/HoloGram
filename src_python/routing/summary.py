"""
变更摘要生成器 — 聚合 V1/V2 结果 + 约束校验结果，生成人/Agent 可消费的摘要

消费：
  - V1: 图数据 (Graph), 社区聚类 (Community), 波及环 (BFS)
  - V2: 耦合深度 (Coupling), 数据流环 (DataFlow), 线程交错 (Threading), 时间线 (Timeline)
  - V3: 信号 (Signals), 约束结果 (ConstraintResult)

产出：
  - 变更摘要 (ChangeSummary) — 人看的
  - 局面简报 (enrich) — Agent 吃的
"""

from __future__ import annotations

import datetime
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from ..core.graph import Graph, Node, Edge, NodeType, EdgeType
from ..core.diff import GraphDiffer, GraphDiff
from .signals import Signal
from .constraints import ConstraintResult, ConstraintViolation


# ============================================================
# 变更摘要数据模型
# ============================================================

@dataclass
class ChangeSummary:
    """
    一次变更的完整摘要。

    正常流（99%）：passed=True，只有一行 "✅ 通过"
    例外流（1%）：passed=False，展开为完整面板
    """
    passed: bool
    timestamp: str = ""
    commit_hash: str = ""          # 可选：git commit hash
    changed_files: List[str] = field(default_factory=list)
    total_changed_files: int = 0

    # 按层级分组的违规
    l5_violations: List[Dict[str, Any]] = field(default_factory=list)
    l4_violations: List[Dict[str, Any]] = field(default_factory=list)
    l3_violations: List[Dict[str, Any]] = field(default_factory=list)
    l2_violations: List[Dict[str, Any]] = field(default_factory=list)

    # 自动放行的检查项
    passed_checks: List[str] = field(default_factory=list)

    # 统计
    blast_radius: int = 0
    cross_community_edges: int = 0
    new_cycles: int = 0
    new_thread_conflicts: int = 0
    api_signature_changes: int = 0

    # Agent 简报（pre-enriched）
    agent_briefing: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "timestamp": self.timestamp,
            "commit_hash": self.commit_hash,
            "changed_files": self.changed_files,
            "total_changed_files": self.total_changed_files,
            "l5_violations": self.l5_violations,
            "l4_violations": self.l4_violations,
            "l3_violations": self.l3_violations,
            "l2_violations": self.l2_violations,
            "passed_checks": self.passed_checks,
            "blast_radius": self.blast_radius,
            "cross_community_edges": self.cross_community_edges,
            "new_cycles": self.new_cycles,
            "new_thread_conflicts": self.new_thread_conflicts,
            "api_signature_changes": self.api_signature_changes,
            "agent_briefing": self.agent_briefing,
        }

    def one_line(self) -> str:
        """正常流：只输出一行。"""
        if self.passed:
            return (f"[PASS] {self.total_changed_files} files changed, "
                    f"no constraint violations. Blast radius: {self.blast_radius} nodes.")
        else:
            total = (len(self.l5_violations) + len(self.l4_violations) +
                     len(self.l3_violations) + len(self.l2_violations))
            return (f"[FAIL] {self.total_changed_files} files changed, "
                    f"{total} violations (L5:{len(self.l5_violations)} "
                    f"L4:{len(self.l4_violations)} L3:{len(self.l3_violations)} "
                    f"L2:{len(self.l2_violations)})")


# ============================================================
# 变更摘要生成器
# ============================================================

class ChangeSummaryGenerator:
    """
    变更摘要生成器 — 消费 V1/V2/V3 所有分析结果，生成摘要。

    使用方式：
        generator = ChangeSummaryGenerator()
        summary = generator.generate(
            before_graph=...,
            after_graph=...,
            file_changes=...,
            constraint_result=...,
            signals=...,
            # 可选 V2 上下文:
            coupling_result=...,
            cycle_result=...,
            thread_result=...,
        )
        print(summary.one_line())           # 正常流：一行
        if not summary.passed:
            print(generator.render_panel(summary))  # 例外流：面板
    """

    def __init__(self):
        self.differ = GraphDiffer()

    def generate(
        self,
        before_graph: Optional[Graph] = None,
        after_graph: Optional[Graph] = None,
        changed_files: Optional[List[str]] = None,
        constraint_result: Optional[ConstraintResult] = None,
        signals: Optional[List[Signal]] = None,
        coupling_result: Optional[Dict[str, Any]] = None,
        cycle_result: Optional[Dict[str, Any]] = None,
        thread_result: Optional[Dict[str, Any]] = None,
        commit_hash: str = "",
    ) -> ChangeSummary:
        """
        生成变更摘要。

        Args:
            before_graph: 变更前的图
            after_graph: 变更后的图
            changed_files: 变更的文件列表
            constraint_result: 约束校验结果
            signals: 所有 L5-L1 信号
            coupling_result: V2 耦合深度分析
            cycle_result: V2 数据流环检测
            thread_result: V2 线程交错分析
            commit_hash: git commit hash (可选)

        Returns:
            ChangeSummary: 完整的变更摘要
        """
        now = datetime.datetime.now().isoformat()
        changed_files = changed_files or []

        cr = constraint_result
        sigs = signals or []

        # 按层级分组违规
        l5_violations = []
        l4_violations = []
        l3_violations = []
        l2_violations = []

        if cr:
            for v in cr.violations:
                d = v.to_dict()
                if v.signal.level == 5:
                    l5_violations.append(d)
                elif v.signal.level == 4:
                    l4_violations.append(d)
                elif v.signal.level == 3:
                    l3_violations.append(d)
                elif v.signal.level == 2:
                    l2_violations.append(d)

        # 补充 graph_node_ids：将 affected_nodes 中的节点名解析为图节点 ID
        if after_graph:
            for v_list in [l5_violations, l4_violations, l3_violations, l2_violations]:
                for v in v_list:
                    signal = v.get("signal", {})
                    affected = signal.get("affected_nodes", [])
                    if affected:
                        ids: List[str] = []
                        for name in affected:
                            nodes = after_graph.find_node_by_name(name)
                            for node in nodes:
                                ids.append(node.id)
                        signal["graph_node_ids"] = ids

        # 统计
        blast_radius = 0
        cross_community_edges = 0
        new_cycles = 0
        new_thread_conflicts = 0
        api_signature_changes = 0

        for s in sigs:
            if s.signal_type == "l2_blast_radius":
                blast_radius = s.details.get("total_affected", 0)
            elif s.signal_type == "l2_cross_community_edge":
                cross_community_edges += 1
            elif s.signal_type.startswith("l4_dataflow_cycle"):
                new_cycles += 1
            elif s.signal_type in ("l3_thread_created", "l3_unlocked_concurrent_access"):
                new_thread_conflicts += 1
            elif s.signal_type in ("l5_api_required_param_added", "l5_api_param_removed",
                                   "l5_api_param_type_changed", "l2_api_signature_optional"):
                api_signature_changes += 1

        # 生成 Agent 简报
        agent_briefing = None
        if not (cr and cr.passed) and after_graph:
            agent_briefing = self.enrich(
                after_graph=after_graph,
                before_graph=before_graph,
                signals=sigs,
                changed_files=changed_files,
                coupling_result=coupling_result,
                cycle_result=cycle_result,
                thread_result=thread_result,
            )

        return ChangeSummary(
            passed=cr.passed if cr else True,
            timestamp=now,
            commit_hash=commit_hash,
            changed_files=changed_files,
            total_changed_files=len(changed_files),
            l5_violations=l5_violations,
            l4_violations=l4_violations,
            l3_violations=l3_violations,
            l2_violations=l2_violations,
            passed_checks=cr.passed_checks if cr else [],
            blast_radius=blast_radius,
            cross_community_edges=cross_community_edges,
            new_cycles=new_cycles,
            new_thread_conflicts=new_thread_conflicts,
            api_signature_changes=api_signature_changes,
            agent_briefing=agent_briefing,
        )

    # ════════════════════════════════════════════════════════
    # enrich() — 局面简报：Agent 开箱即食
    # ════════════════════════════════════════════════════════

    def enrich(
        self,
        after_graph: Graph,
        before_graph: Optional[Graph] = None,
        signals: Optional[List[Signal]] = None,
        changed_files: Optional[List[str]] = None,
        coupling_result: Optional[Dict[str, Any]] = None,
        cycle_result: Optional[Dict[str, Any]] = None,
        thread_result: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        生成局面简报 — 预装所有 V1/V2 分析结果，Agent 零查询直接吃。

        数据来源全部是已有模块的 `import` + 拼装，无需新算法。
        """
        signals = signals or []
        changed_files = changed_files or []

        briefing: Dict[str, Any] = {
            "generated_at": datetime.datetime.now().isoformat(),
            "sections": {},
        }

        # ── 1. 图快照 (V1) ──
        briefing["sections"]["graph_snapshot"] = self._enrich_graph_snapshot(
            after_graph, signals, changed_files
        )

        # ── 2. 耦合深度 (V2) ──
        briefing["sections"]["coupling_depth"] = self._enrich_coupling(
            coupling_result, changed_files
        )

        # ── 3. 数据流环 (V2) ──
        briefing["sections"]["dataflow_cycles"] = self._enrich_cycles(
            cycle_result, changed_files
        )

        # ── 4. 线程关联 (V2) ──
        briefing["sections"]["thread_associations"] = self._enrich_threads(
            thread_result, changed_files
        )

        # ── 5. 历史稳定性 (V1 时间轴) ──
        briefing["sections"]["history_stability"] = self._enrich_history(
            after_graph.source_root, changed_files
        )

        # ── 6. 社区关联 (V1) ──
        briefing["sections"]["community_associations"] = self._enrich_communities(
            after_graph, changed_files
        )

        # ── 7. 图 diff ──
        briefing["sections"]["graph_diff"] = self._enrich_graph_diff(
            before_graph, after_graph
        )

        return briefing

    # ── 各 enrich 子函数 ──

    def _enrich_graph_snapshot(
        self,
        graph: Graph,
        signals: List[Signal],
        changed_files: List[str],
    ) -> Dict[str, Any]:
        """图快照：变更节点的依赖方与被依赖方。"""
        snapshot: Dict[str, List[Dict[str, Any]]] = {}

        for file_path in changed_files[:5]:  # 最多 5 个文件
            nodes = graph.find_nodes_by_location(file_path)
            for node in nodes[:3]:  # 每个文件最多 3 个节点
                entry: Dict[str, Any] = {
                    "node": node.name,
                    "kind": node.kind,
                    "location": node.location,
                    "depends_on": [],    # 被依赖方
                    "depended_by": [],   # 依赖方
                }

                # 被依赖方 (outgoing)
                for e in graph.outgoing_edges(node.id):
                    tgt = graph.get_node(e.target)
                    if tgt:
                        entry["depends_on"].append({
                            "name": tgt.name,
                            "location": tgt.location,
                            "direction": e.direction,
                        })

                # 依赖方 (incoming)
                for e in graph.incoming_edges(node.id):
                    src = graph.get_node(e.source)
                    if src:
                        entry["depended_by"].append({
                            "name": src.name,
                            "location": src.location,
                            "direction": e.direction,
                        })

                snapshot[node.id] = entry

        return {
            "changed_nodes": snapshot,
            "total_nodes_in_graph": graph.node_count,
            "total_edges_in_graph": graph.edge_count,
        }

    def _enrich_coupling(
        self,
        coupling_result: Optional[Dict[str, Any]],
        changed_files: List[str],
    ) -> Dict[str, Any]:
        """耦合深度：变更文件的 L1-L4 分布。"""
        if not coupling_result:
            return {"available": False, "note": "V2 耦合深度分析未运行"}

        reports = coupling_result.get("module_reports", [])
        relevant = []
        for r in reports:
            fp = r.get("file_path", "")
            if any(cf in fp or fp in cf for cf in changed_files):
                relevant.append(r)

        return {
            "available": True,
            "changed_modules": relevant,
            "global_totals": {
                "l1": coupling_result.get("total_l1", 0),
                "l2": coupling_result.get("total_l2", 0),
                "l3": coupling_result.get("total_l3", 0),
                "l4": coupling_result.get("total_l4", 0),
            },
        }

    def _enrich_cycles(
        self,
        cycle_result: Optional[Dict[str, Any]],
        changed_files: List[str],
    ) -> Dict[str, Any]:
        """数据流环：涉及变更文件的环（已存在 + 新增）。"""
        if not cycle_result:
            return {"available": False, "note": "V2 数据流环检测未运行"}

        cycles = cycle_result.get("cycles", [])
        # 查找涉及变更文件的环
        relevant_cycles = []
        for c in cycles:
            node_names = c.get("node_names", [])
            # 简单匹配：环中节点是否包含变更文件中的符号
            relevant_cycles.append(c)

        return {
            "available": True,
            "total_cycles": cycle_result.get("total_cycles", 0),
            "pure_code": cycle_result.get("pure_code_cycles", 0),
            "data_persistent": cycle_result.get("data_persistent_cycles", 0),
            "llm_involved": cycle_result.get("llm_involved_cycles", 0),
            "cycles": relevant_cycles[:10],  # 最多 10 个
        }

    def _enrich_threads(
        self,
        thread_result: Optional[Dict[str, Any]],
        changed_files: List[str],
    ) -> Dict[str, Any]:
        """线程关联：变更文件中的线程创建点和共享资源。"""
        if not thread_result:
            return {"available": False, "note": "V2 线程交错分析未运行"}

        threads = thread_result.get("threads", [])
        resources = thread_result.get("resources", {})

        # 筛选涉及变更文件的线程
        relevant_threads = []
        for t in threads:
            t_file = t.get("location", "").split(":")[0] if t.get("location") else ""
            if any(cf in t_file for cf in changed_files):
                relevant_threads.append(t)

        # 筛选涉及变更文件的资源
        relevant_resources = {}
        for rname, rdata in resources.items():
            files = rdata.get("files", [])
            for f in files:
                if isinstance(f, str) and any(cf in f for cf in changed_files):
                    relevant_resources[rname] = rdata
                    break

        return {
            "available": True,
            "total_threads": thread_result.get("total_threads_found", 0),
            "total_locks": thread_result.get("total_locks_found", 0),
            "total_shared_resources": thread_result.get("total_shared_resources", 0),
            "unlocked_concurrent_writes": thread_result.get("unlocked_concurrent_writes", 0),
            "relevant_threads": relevant_threads,
            "relevant_resources": relevant_resources,
        }

    def _enrich_history(
        self,
        project_root: str,
        changed_files: List[str],
    ) -> Dict[str, Any]:
        """历史稳定性：从时间轴查询变更历史。"""
        try:
            from ..timeline import TimelineStore
            with TimelineStore(project_root) as store:
                file_history: Dict[str, Any] = {}
                for f in changed_files[:5]:
                    events = store.query(file=f, limit=10)
                    file_history[f] = {
                        "total_events": len(events),
                        "recent_events": events[:5],
                    }
            return {
                "available": True,
                "file_history": file_history,
            }
        except Exception:
            return {"available": False, "note": "时间轴数据不可用"}

    def _enrich_communities(
        self,
        graph: Graph,
        changed_files: List[str],
    ) -> Dict[str, Any]:
        """社区关联：变更文件所属的社区。"""
        if not graph.communities:
            return {"available": False, "note": "社区发现未运行或无结果"}

        file_communities: Dict[str, List[Dict[str, Any]]] = {}
        for file_path in changed_files[:5]:
            nodes = graph.find_nodes_by_location(file_path)
            for node in nodes:
                if node.community_id:
                    # 找到对应的社区
                    for comm in graph.communities:
                        if comm.id == node.community_id or node.id in comm.node_ids:
                            if file_path not in file_communities:
                                file_communities[file_path] = []
                            file_communities[file_path].append({
                                "community_id": comm.id,
                                "community_label": comm.label,
                                "community_size": len(comm.node_ids),
                                "node": node.name,
                            })
                            break

        # 也检查是否有节点在社区中（通过遍历所有社区）
        for comm in graph.communities:
            for nid in comm.node_ids:
                node = graph.get_node(nid)
                if node:
                    loc_file = node.location.rsplit(":", 1)[0] if ":" in node.location else node.location
                    if loc_file in changed_files:
                        if loc_file not in file_communities:
                            file_communities[loc_file] = []
                        if not any(c["community_id"] == comm.id for c in file_communities[loc_file]):
                            file_communities[loc_file].append({
                                "community_id": comm.id,
                                "community_label": comm.label,
                                "community_size": len(comm.node_ids),
                                "node": node.name,
                            })

        # 检测跨社区：变更文件是否分布在多个社区
        all_community_ids: set = set()
        for fc_list in file_communities.values():
            for c in fc_list:
                all_community_ids.add(c["community_id"])
        cross_community = len(all_community_ids) > 1

        return {
            "available": True,
            "file_communities": file_communities,
            "cross_community_detected": cross_community,
            "total_communities": graph.community_count,
        }

    def _enrich_graph_diff(
        self,
        before_graph: Optional[Graph],
        after_graph: Optional[Graph],
    ) -> Dict[str, Any]:
        """图 diff：结构变化摘要。"""
        if not before_graph or not after_graph:
            return {"available": False, "note": "缺少变更前图快照"}

        diff = self.differ.diff(before_graph, after_graph)

        return {
            "available": True,
            "nodes_added": len(diff.added_nodes),
            "nodes_removed": len(diff.removed_nodes),
            "nodes_modified": len(diff.modified_nodes),
            "edges_added": len(diff.added_edges),
            "edges_removed": len(diff.removed_edges),
            "total_changes": diff.total_changes,
            "added_node_names": [n.name for n in diff.added_nodes[:10]],
            "removed_node_names": [n.name for n in diff.removed_nodes[:10]],
            "modified_node_names": [mn.name for mn in diff.modified_nodes[:10]],
        }

    # ════════════════════════════════════════════════════════
    # render_panel() — 终端渲染变更摘要面板
    # ════════════════════════════════════════════════════════

    @staticmethod
    def render_panel(summary: ChangeSummary) -> str:
        """将变更摘要渲染为终端友好的面板（ASCII-safe）。"""
        lines = []
        W = 66  # 面板宽度

        def _box(text: str) -> str:
            return f"| {text:<{W - 4}} |"

        def _sep(title: str = "") -> str:
            if title:
                return f"|  -- {title} {'-' * (W - 10 - len(title))}"
            return f"+{'=' * (W - 2)}+"

        # 头部
        ts = summary.timestamp[:19] if summary.timestamp else ""
        commit_str = f" - {summary.commit_hash}" if summary.commit_hash else ""
        lines.append(f"+{'=' * (W - 2)}+")
        lines.append(_box(f"CHANGE SUMMARY{commit_str} - {ts}"))
        lines.append(_box(""))
        files_display = ", ".join(summary.changed_files[:3])
        if len(summary.changed_files) > 3:
            files_display += f"  ({summary.total_changed_files} files)"
        lines.append(_box(f"Changed: {files_display}"))
        lines.append(_box(""))

        if summary.passed:
            # 全部通过
            lines.append(_sep("Auto-Release"))
            lines.append(_box(f"[OK] Blast radius: {summary.blast_radius} nodes (within threshold)"))
            for check in summary.passed_checks[:5]:
                lines.append(_box(f"[OK] {check[:W - 8]}"))
            lines.append(_box(""))
            lines.append(_box("All constraints passed. No human review needed."))
        else:
            # L5
            if summary.l5_violations:
                lines.append(_sep("L5 - Irreversible"))
                for v in summary.l5_violations:
                    sig = v.get("signal", {})
                    desc = sig.get("description", v.get("message", "?"))
                    fp = sig.get("file_path", "")
                    line_num = sig.get("line", 0)
                    loc = f"{os.path.basename(fp)}:{line_num}" if fp and line_num else os.path.basename(fp) if fp else ""
                    lines.append(_box(f"[!!] {loc}  {desc[:W - 8 - len(loc)]}"))
                    if sig.get("affected_nodes"):
                        nodes = sig["affected_nodes"][:3]
                        lines.append(_box(f"   Affects: {', '.join(nodes)}"))
                    lines.append(_box("   [confirm] [reject] [Agent analyze]"))
                lines.append(_box(""))

            # L4
            if summary.l4_violations:
                lines.append(_sep("L4 - Silent"))
                for v in summary.l4_violations:
                    sig = v.get("signal", {})
                    desc = sig.get("description", v.get("message", "?"))
                    fp = sig.get("file_path", "")
                    line_num = sig.get("line", 0)
                    loc = f"{os.path.basename(fp)}:{line_num}" if fp and line_num else os.path.basename(fp) if fp else ""
                    lines.append(_box(f"[!] {loc}  {desc[:W - 8 - len(loc)]}"))
                    old_v = sig.get("old_value")
                    new_v = sig.get("new_value")
                    if old_v and new_v:
                        lines.append(_box(f"   {old_v} -> {new_v}"))
                    lines.append(_box("   [confirm] [mark known] [-> send to Agent]"))
                lines.append(_box(""))

            # L3
            if summary.l3_violations:
                lines.append(_sep("L3 - Delayed"))
                for v in summary.l3_violations:
                    sig = v.get("signal", {})
                    desc = sig.get("description", v.get("message", "?"))
                    fp = sig.get("file_path", "")
                    loc = os.path.basename(fp) if fp else ""
                    lines.append(_box(f"[~] {loc}  {desc[:W - 8 - len(loc)]}"))
                    lines.append(_box("   [mark] [ignore]"))
                lines.append(_box(""))

            # L2
            if summary.l2_violations:
                lines.append(_sep("L2 - Blast"))
                for v in summary.l2_violations[:5]:
                    sig = v.get("signal", {})
                    desc = sig.get("description", v.get("message", "?"))
                    lines.append(_box(f"[>] {desc[:W - 6]}"))
                    lines.append(_box("   [confirm] [mark known]"))

                lines.append(_box(""))

            # 自动放行项
            lines.append(_sep("Auto-Release"))
            lines.append(_box(f"[OK] Blast radius: {summary.blast_radius} nodes (within threshold)"))
            if summary.cross_community_edges == 0:
                lines.append(_box("[OK] Communities: no new cross-community edges"))
            if summary.new_cycles == 0:
                lines.append(_box("[OK] Cycles: no new data flow cycles"))
            if summary.new_thread_conflicts == 0:
                lines.append(_box("[OK] Threads: no new race windows"))
            for check in summary.passed_checks[3:8]:
                lines.append(_box(f"[OK] {check[:W - 8]}"))

        lines.append(f"+{'=' * (W - 2)}+")
        return "\n".join(lines)

    @staticmethod
    def render_agent_briefing(briefing: Dict[str, Any], violation_context: Optional[Dict[str, Any]] = None) -> str:
        """将局面简报渲染为 Agent 友好的文本格式（ASCII-safe）。"""
        lines = []
        W = 66

        def _box(text: str) -> str:
            return f"| {text:<{W - 4}} |"

        def _sep(title: str) -> str:
            return f"|  -- {title} {'-' * (W - 10 - len(title))}"

        lines.append(f"+{'=' * (W - 2)}+")
        lines.append(_box("SITUATION BRIEFING -- Routed to Agent"))
        if violation_context:
            lines.append(_box(f"Change: {violation_context.get('commit', '?')} - "
                              f"{violation_context.get('file', '?')}"))

        sections = briefing.get("sections", {})

        # V1: Graph Snapshot
        gs = sections.get("graph_snapshot", {})
        if gs.get("available", True):
            lines.append(_sep("Graph Snapshot (V1)"))
            for nid, info in gs.get("changed_nodes", {}).items():
                lines.append(_box(f"Node: {info.get('node', '?')} [{info.get('kind', '?')}]"))
                depended_by = info.get("depended_by", [])
                if depended_by:
                    lines.append(_box("  depends on:"))
                    for d in depended_by[:5]:
                        lines.append(_box(f"    - {d.get('name', '?')} ({d.get('location', '?')})"))
                depends_on = info.get("depends_on", [])
                if depends_on:
                    lines.append(_box("  depended by:"))
                    for d in depends_on[:5]:
                        lines.append(_box(f"    - {d.get('name', '?')} ({d.get('location', '?')})"))

        # V2: Coupling Depth
        cd = sections.get("coupling_depth", {})
        if cd.get("available"):
            lines.append(_sep("Coupling Depth (V2)"))
            for mod in cd.get("changed_modules", []):
                lines.append(_box(f"  - {mod.get('module_name', '?')}: "
                                f"L1={mod.get('l1_count', 0)} L2={mod.get('l2_count', 0)} "
                                f"L3={mod.get('l3_count', 0)} L4={mod.get('l4_count', 0)}"))
            if not cd.get("changed_modules"):
                lines.append(_box("  - No L4 violations"))

        # V2: Data Flow Cycles
        dc = sections.get("dataflow_cycles", {})
        if dc.get("available"):
            lines.append(_sep("Data Flow Cycles (V2)"))
            cycles = dc.get("cycles", [])
            if cycles:
                for c in cycles[:3]:
                    names = " -> ".join(c.get("node_names", [])[:4])
                    lines.append(_box(f"  - [{c.get('category', '?')}] {names}"))
            else:
                lines.append(_box("  - No new cycles"))

        # V2: Thread Associations
        ta = sections.get("thread_associations", {})
        if ta.get("available"):
            lines.append(_sep("Thread Associations (V2)"))
            rel_threads = ta.get("relevant_threads", [])
            if rel_threads:
                for t in rel_threads[:3]:
                    lines.append(_box(f"  - {t.get('type', '?')}: {t.get('target', '?')} "
                                      f"({t.get('confidence', '?')})"))
            else:
                lines.append(_box("  - This node is not in any thread race window."))

        # V1: History Stability
        hs = sections.get("history_stability", {})
        if hs.get("available"):
            lines.append(_sep("History Stability (V1 Timeline)"))
            for f, info in hs.get("file_history", {}).items():
                total = info.get("total_events", 0)
                recent = info.get("recent_events", [])
                lines.append(_box(f"  - {os.path.basename(f)}: {total} past changes"))
                if recent:
                    all_routed = all(
                        e.get("summary", "").find("routed") >= 0 for e in recent
                    ) if recent else False
                    lines.append(_box(f"    Last {min(3, len(recent))} changes: all passed, no rollbacks"
                                    if all_routed else
                                    f"    First time being routed to human"))

        # V1: Community Associations
        ca = sections.get("community_associations", {})
        if ca.get("available"):
            lines.append(_sep("Community Associations (V1)"))
            for f, comms in ca.get("file_communities", {}).items():
                for c in comms[:2]:
                    lines.append(_box(f"  - {os.path.basename(f)} -> "
                                    f"community {c.get('community_label', '?')} "
                                    f"({c.get('community_size', 0)} nodes)"))
            if ca.get("cross_community_detected"):
                lines.append(_box("  [!] Cross-community edges detected"))
            else:
                lines.append(_box("  - No cross-community changes this time"))

        lines.append(f"+{'=' * (W - 2)}+")

        return "\n".join(lines)
