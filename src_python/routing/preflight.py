"""
preflight + health — V3 胶水层，组装已有引擎模块

preflight: 起飞前检查 — impact + coupling + community
health:    健康趋势 — timeline 聚合 + coupling 快照

依赖：V1 图、V2 分析、V3 时间轴 — 全部已有，纯组装。
"""

from __future__ import annotations

import datetime
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..core.graph import Graph

logger = logging.getLogger(__name__)


# ============================================================
# preflight — 起飞前检查
# ============================================================

@dataclass
class PreflightReport:
    """起飞前检查报告 — 改这些文件会怎样？"""
    files_checked: List[str] = field(default_factory=list)
    nodes_directly_changed: int = 0
    blast_radius: int = 0                # 波及节点数
    cross_community: bool = False
    cross_community_details: List[Dict[str, Any]] = field(default_factory=list)
    l4_violations: int = 0
    l4_violation_details: List[Dict[str, Any]] = field(default_factory=list)
    cycles_touched: int = 0
    cycle_details: List[Dict[str, Any]] = field(default_factory=list)
    risk_level: str = "low"              # low / medium / high / critical
    risk_score: int = 0                  # 0-100
    warnings: List[str] = field(default_factory=list)
    per_file: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "files_checked": self.files_checked,
            "nodes_directly_changed": self.nodes_directly_changed,
            "blast_radius": self.blast_radius,
            "cross_community": self.cross_community,
            "cross_community_details": self.cross_community_details,
            "l4_violations": self.l4_violations,
            "l4_violation_details": self.l4_violation_details,
            "cycles_touched": self.cycles_touched,
            "cycle_details": self.cycle_details,
            "risk_level": self.risk_level,
            "risk_score": self.risk_score,
            "warnings": self.warnings,
            "per_file": self.per_file,
        }


def run_preflight(
    graph: Graph,
    changed_files: List[str],
    project_root: Optional[str] = None,
) -> PreflightReport:
    """
    起飞前检查：变更这些文件会产生什么影响？

    Args:
        graph: 依赖图
        changed_files: 变更文件列表
        project_root: 项目根目录（用于时间轴查询）

    Returns:
        PreflightReport: 完整的起飞前检查报告
    """
    report = PreflightReport(files_checked=list(changed_files))
    warnings: List[str] = []
    risk_score = 0

    # ── 1. Impact: 对每个变更文件中的节点运行 BFS ──
    all_affected_ids: set = set()
    per_file: List[Dict[str, Any]] = []
    direct_node_count = 0

    for file_path in changed_files:
        nodes = graph.find_nodes_by_location(file_path)
        direct_node_count += len(nodes)

        file_entry: Dict[str, Any] = {
            "file": file_path,
            "nodes": [],
        }

        for node in nodes:
            layers = graph.impact_bfs(node.id, max_depth=3)
            affected_in_file: set = set()
            for layer in layers:
                for nd in layer.get("nodes", []):
                    nid = nd.get("id", "") if isinstance(nd, dict) else getattr(nd, "id", "")
                    if nid:
                        affected_in_file.add(nid)
                        all_affected_ids.add(nid)

            file_entry["nodes"].append({
                "node_id": node.id,
                "node_name": node.name,
                "kind": node.kind,
                "impact_count": len(affected_in_file) - 1,  # exclude self
            })

        per_file.append(file_entry)

    report.per_file = per_file
    report.nodes_directly_changed = direct_node_count
    report.blast_radius = len(all_affected_ids)

    # Risk: blast radius scoring
    if report.blast_radius > 50:
        risk_score += 30
        warnings.append(f"波及 {report.blast_radius} 个节点（>50），建议分批提交")
    elif report.blast_radius > 20:
        risk_score += 15
        warnings.append(f"波及 {report.blast_radius} 个节点（>20）")

    # ── 2. Coupling: 检查 L4 封装穿透 ──
    try:
        from ..analysis.coupling import coupling_depth_report
        coupling = coupling_depth_report(graph)

        l4_total = coupling.get("total_l4", 0)
        module_reports = coupling.get("module_reports", [])

        # 筛选涉及变更文件的模块
        relevant_l4: List[Dict[str, Any]] = []
        for mr in module_reports:
            fp = mr.get("file_path", "")
            if any(cf in fp or fp in cf for cf in changed_files):
                l4_violations = mr.get("l4_violations", [])
                if l4_violations:
                    relevant_l4.append({
                        "module": mr.get("module_name", fp),
                        "file_path": fp,
                        "l4_count": mr.get("l4_count", 0),
                        "fragility_score": mr.get("fragility_score", 0),
                        "violations": l4_violations[:5],
                    })

        report.l4_violations = l4_total
        report.l4_violation_details = relevant_l4

        if l4_total > 10:
            risk_score += 25
            warnings.append(f"检测到 {l4_total} 个 L4 封装穿透（>10），架构退化风险")
        elif l4_total > 5:
            risk_score += 10
            warnings.append(f"检测到 {l4_total} 个 L4 封装穿透")

    except Exception as e:
        logger.warning("耦合分析不可用: %s", e, exc_info=True)
        warnings.append(f"耦合分析不可用: {e}")

    # ── 3. Community: 检查跨社区影响 ──
    try:
        if graph.communities:
            # 构建节点→社区映射
            node_community: Dict[str, str] = {}
            for comm in graph.communities:
                for nid in comm.node_ids:
                    node_community[nid] = comm.id

            # 检查变更节点是否跨社区
            changed_communities: set = set()
            for nid in all_affected_ids:
                cid = node_community.get(nid)
                if cid:
                    changed_communities.add(cid)

            report.cross_community = len(changed_communities) > 1
            if report.cross_community:
                # 列出涉及的社区
                for cid in changed_communities:
                    for comm in graph.communities:
                        if comm.id == cid:
                            report.cross_community_details.append({
                                "community_id": comm.id,
                                "community_label": comm.label,
                                "size": len(comm.node_ids),
                            })
                            break

                risk_score += 15
                warnings.append(
                    f"变更跨 {len(changed_communities)} 个社区: "
                    + ", ".join(c["community_label"] for c in report.cross_community_details)
                )
    except Exception as e:
        logger.warning("社区分析不可用: %s", e, exc_info=True)
        warnings.append(f"社区分析不可用: {e}")

    # ── 4. Cycles: 检查是否触碰到已有数据流环 ──
    try:
        from ..analysis.dataflow import cycle_report
        cycles = cycle_report(graph)
        all_cycles = cycles.get("cycles", [])
        report.cycles_touched = len(all_cycles)

        # 检查哪些环涉及变更节点
        touched_cycles = []
        for c in all_cycles:
            c_nodes = c.get("node_names", [])
            # 检查环中是否有节点在变更文件中
            touches = False
            for cn in c_nodes:
                for file_path in changed_files:
                    file_nodes = graph.find_nodes_by_location(file_path)
                    for fn in file_nodes:
                        if fn.name == cn:
                            touches = True
                            break
                    if touches:
                        break
                if touches:
                    break
            if touches:
                touched_cycles.append({
                    "cycle_id": c.get("cycle_id", ""),
                    "category": c.get("category", "pure_code"),
                    "node_count": len(c_nodes),
                    "nodes": c_nodes[:5],
                })

        report.cycle_details = touched_cycles
        if touched_cycles:
            risk_score += 20
            warnings.append(f"变更涉及 {len(touched_cycles)} 个数据流环")

        if len(all_cycles) > 10:
            risk_score += 10
            warnings.append(f"项目中存在 {len(all_cycles)} 个数据流环（>10）")

    except Exception as e:
        logger.warning("数据流环检测不可用: %s", e, exc_info=True)
        warnings.append(f"数据流环检测不可用: {e}")

    # ── 5. 汇总风险等级 ──
    report.risk_score = min(risk_score, 100)
    if risk_score >= 60:
        report.risk_level = "critical"
    elif risk_score >= 30:
        report.risk_level = "high"
    elif risk_score >= 10:
        report.risk_level = "medium"
    else:
        report.risk_level = "low"

    report.warnings = warnings
    return report


# ============================================================
# health — 健康趋势
# ============================================================

@dataclass
class HealthReport:
    """项目健康趋势报告 — 聚合时间轴 + 耦合快照。"""
    health_score: int = 100               # 0-100, higher is better
    total_nodes: int = 0
    total_edges: int = 0
    community_count: int = 0
    coupling_distribution: Dict[str, int] = field(default_factory=dict)
    cycle_count: int = 0
    pure_code_cycles: int = 0
    data_persistent_cycles: int = 0
    llm_involved_cycles: int = 0
    timeline_total_events: int = 0
    timeline_recent_changes: int = 0     # changes in recent window
    top_changed_files: List[Dict[str, Any]] = field(default_factory=list)
    fragility_top5: List[Dict[str, Any]] = field(default_factory=list)
    trends: Dict[str, str] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    generated_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "health_score": self.health_score,
            "total_nodes": self.total_nodes,
            "total_edges": self.total_edges,
            "community_count": self.community_count,
            "coupling_distribution": self.coupling_distribution,
            "cycle_count": self.cycle_count,
            "pure_code_cycles": self.pure_code_cycles,
            "data_persistent_cycles": self.data_persistent_cycles,
            "llm_involved_cycles": self.llm_involved_cycles,
            "timeline_total_events": self.timeline_total_events,
            "timeline_recent_changes": self.timeline_recent_changes,
            "top_changed_files": self.top_changed_files,
            "fragility_top5": self.fragility_top5,
            "trends": self.trends,
            "warnings": self.warnings,
            "generated_at": self.generated_at,
        }


def run_health(
    project_root: str,
    graph: Optional[Graph] = None,
    days: int = 30,
) -> HealthReport:
    """
    健康趋势报告：聚合时间轴 + 耦合快照。

    Args:
        project_root: 项目根目录
        graph: 依赖图（如不提供则从默认路径加载）
        days: 回溯天数

    Returns:
        HealthReport: 健康趋势报告
    """
    report = HealthReport()
    report.generated_at = datetime.datetime.now().isoformat()
    warnings: List[str] = []
    health_deductions = 0

    # ── 加载图 ──
    if graph is None:
        graph_path = os.path.join(project_root, "hologram_graph.json")
        if os.path.exists(graph_path):
            try:
                graph = Graph.from_json(graph_path)
            except Exception as e:
                warnings.append(f"无法加载图: {e}")
                report.warnings = warnings
                report.health_score = 0
                return report
        else:
            warnings.append("图文件不存在，请先运行 hologram analyze")
            report.warnings = warnings
            report.health_score = 0
            return report

    report.total_nodes = graph.node_count
    report.total_edges = graph.edge_count
    report.community_count = graph.community_count

    # ── 1. 耦合深度快照 ──
    try:
        from ..analysis.coupling import coupling_depth_report
        coupling = coupling_depth_report(graph)

        report.coupling_distribution = {
            "l1": coupling.get("total_l1", 0),
            "l2": coupling.get("total_l2", 0),
            "l3": coupling.get("total_l3", 0),
            "l4": coupling.get("total_l4", 0),
        }

        l4 = report.coupling_distribution["l4"]
        l3 = report.coupling_distribution["l3"]
        total_coupling = sum(report.coupling_distribution.values())

        if total_coupling > 0:
            l4_ratio = l4 / total_coupling
            if l4_ratio > 0.05:
                health_deductions += 20
                warnings.append(f"L4 封装穿透占比 {l4_ratio:.1%}（>5%），架构健康度下降")
            elif l4_ratio > 0.02:
                health_deductions += 10
                warnings.append(f"L4 封装穿透占比 {l4_ratio:.1%}（>2%）")

        # Fragility top 5
        module_reports = coupling.get("module_reports", [])
        top5 = sorted(module_reports, key=lambda r: r.get("fragility_score", 0), reverse=True)[:5]
        report.fragility_top5 = [
            {
                "module": r.get("module_name", "?"),
                "file_path": r.get("file_path", ""),
                "fragility_score": r.get("fragility_score", 0),
                "l4_count": r.get("l4_count", 0),
            }
            for r in top5
        ]

    except Exception as e:
        warnings.append(f"耦合分析不可用: {e}")

    # ── 2. 数据流环快照 ──
    try:
        from ..analysis.dataflow import cycle_report
        cycles = cycle_report(graph)
        report.cycle_count = cycles.get("total_cycles", 0)
        report.pure_code_cycles = cycles.get("pure_code_cycles", 0)
        report.data_persistent_cycles = cycles.get("data_persistent_cycles", 0)
        report.llm_involved_cycles = cycles.get("llm_involved_cycles", 0)

        if report.cycle_count > 15:
            health_deductions += 25
            warnings.append(f"数据流环数量过高: {report.cycle_count}（>15）")
        elif report.cycle_count > 5:
            health_deductions += 10
            warnings.append(f"数据流环数量偏高: {report.cycle_count}（>5）")

        if report.llm_involved_cycles > 0:
            health_deductions += 15
            warnings.append(f"存在 {report.llm_involved_cycles} 个 LLM 参与的数据流环 — 高风险")

    except Exception as e:
        warnings.append(f"数据流环检测不可用: {e}")

    # ── 3. 时间轴聚合 ──
    try:
        from ..timeline import TimelineStore
        with TimelineStore(project_root) as store:
            events = store.query(limit=500)

            report.timeline_total_events = len(events)

            # 最近 N 天的变更
            cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()
            recent = [e for e in events if e.get("timestamp", "") >= cutoff]
            report.timeline_recent_changes = len(recent)

            # Top changed files
            file_counts: Dict[str, int] = {}
            for e in events:
                file_str = e.get("file", "")
                if file_str:
                    for f in file_str.split(", "):
                        f = f.strip()
                        if f:
                            file_counts[f] = file_counts.get(f, 0) + 1

            report.top_changed_files = sorted(
                [{"file": f, "changes": c} for f, c in file_counts.items()],
                key=lambda x: x["changes"],
                reverse=True,
            )[:10]

            # 高频变更预警
            if report.top_changed_files:
                top = report.top_changed_files[0]
                if top["changes"] > 20:
                    health_deductions += 10
                    warnings.append(f"文件 {top['file']} 变更过于频繁 ({top['changes']} 次)")

    except Exception as e:
        warnings.append(f"时间轴数据不可用: {e}")

    # ── 4. 趋势判断 ──
    trends: Dict[str, str] = {}

    # Coupling trend (simplified: based on current snapshot only)
    l4 = report.coupling_distribution.get("l4", 0)
    if l4 == 0:
        trends["coupling"] = "clean"
    elif l4 <= 3:
        trends["coupling"] = "stable"
    elif l4 <= 8:
        trends["coupling"] = "degrading"
    else:
        trends["coupling"] = "critical"

    # Cycle trend
    if report.cycle_count == 0:
        trends["cycles"] = "clean"
    elif report.cycle_count <= 5:
        trends["cycles"] = "stable"
    elif report.cycle_count <= 10:
        trends["cycles"] = "concerning"
    else:
        trends["cycles"] = "critical"

    # Change frequency trend
    if report.timeline_recent_changes == 0:
        trends["change_frequency"] = "quiet"
    elif report.timeline_recent_changes <= 10:
        trends["change_frequency"] = "normal"
    elif report.timeline_recent_changes <= 30:
        trends["change_frequency"] = "active"
    else:
        trends["change_frequency"] = "hot"

    report.trends = trends

    # ── 5. 综合健康分 ──
    report.health_score = max(0, 100 - health_deductions)
    report.warnings = warnings

    return report


# ============================================================
# run_full_check — V3 全量约束校验（CLI 与 MCP 共用核心）
# ============================================================

def run_full_check(
    before_graph: Graph,
    after_graph: Graph,
    changed_files: List[str],
    file_changes: Optional[Dict[str, Any]] = None,
    project_root: str = "",
) -> Dict[str, Any]:
    """
    运行完整 V3 约束校验管线：耦合 → 数据流环 → 线程 → 信号 → 约束 → 摘要。

    供 CLI cmd_check 和 MCP hologram_run_check 共用，保证行为一致。

    Args:
        before_graph: 变更前的图
        after_graph: 变更后的图
        changed_files: 变更文件列表
        file_changes: {file_path: FileChange} 字典（可选）
        project_root: 项目根目录

    Returns:
        dict: 包含 passed, violations, signals, summary 等字段
    """
    import sys

    # ── Step 1: 运行 V2 分析 ──
    coupling_result = None
    cycle_result = None
    thread_result = None

    # 从 file_changes 提取源码（优先于磁盘读取，性能更好）
    coupling_sources: Optional[Dict[str, str]] = None
    if file_changes:
        coupling_sources = {}
        for fp, fc in file_changes.items():
            src = getattr(fc, 'new_source', None) or (fc.get('new_source') if isinstance(fc, dict) else None)
            if src:
                coupling_sources[fp] = src

    try:
        from ..analysis.coupling import coupling_depth_report
        coupling_result = coupling_depth_report(after_graph, coupling_sources)
        print(f"  Coupling analysis: {coupling_result.get('total_l4', 0)} L4 violations", file=sys.stderr)
    except Exception as e:
        logger.warning("耦合分析不可用: %s", e, exc_info=True)
        print(f"  Coupling analysis skipped: {e}", file=sys.stderr)

    try:
        from ..analysis.dataflow import cycle_report as _cycle_report
        cycle_result = _cycle_report(after_graph, mode="all")
        print(f"  Cycle detection: {cycle_result.get('total_cycles', 0)} cycles", file=sys.stderr)
    except Exception as e:
        logger.warning("数据流环检测不可用: %s", e, exc_info=True)
        print(f"  Cycle detection skipped: {e}", file=sys.stderr)

    try:
        from ..analysis.threading import thread_conflict_report
        thread_sources = {}
        if file_changes:
            for fp, fc in file_changes.items():
                source = getattr(fc, 'new_source', None) or (fc.get('new_source') if isinstance(fc, dict) else None)
                if source:
                    thread_sources[fp] = source
        if thread_sources:
            thread_result = thread_conflict_report(thread_sources, language="python")
            print(f"  Thread analysis: {thread_result.get('total_threads_found', 0)} threads", file=sys.stderr)
    except Exception as e:
        logger.warning("线程分析不可用: %s", e, exc_info=True)
        print(f"  Thread analysis skipped: {e}", file=sys.stderr)

    # ── Step 2: 生成 L5-L1 信号 ──
    from .signals import SignalGenerator
    sig_gen = SignalGenerator()
    signals = sig_gen.generate(
        before_graph=before_graph,
        after_graph=after_graph,
        file_changes=file_changes or {},
        coupling_result=coupling_result,
        cycle_result=cycle_result,
        thread_result=thread_result,
    )
    print(f"  Signals generated: {len(signals)} (L5={sum(1 for s in signals if s.level==5)} "
          f"L4={sum(1 for s in signals if s.level==4)} "
          f"L3={sum(1 for s in signals if s.level==3)} "
          f"L2={sum(1 for s in signals if s.level==2)} "
          f"L1={sum(1 for s in signals if s.level==1)})", file=sys.stderr)

    # ── Step 3: 约束校验 ──
    from .constraints import ConstraintChecker
    checker = ConstraintChecker(project_root) if project_root else ConstraintChecker()
    constraint_result = checker.check(signals)

    # ── Step 4: 生成变更摘要 ──
    from .summary import ChangeSummaryGenerator
    summary_gen = ChangeSummaryGenerator()
    summary = summary_gen.generate(
        before_graph=before_graph,
        after_graph=after_graph,
        changed_files=changed_files,
        constraint_result=constraint_result,
        signals=signals,
        coupling_result=coupling_result,
        cycle_result=cycle_result,
        thread_result=thread_result,
    )

    return {
        "passed": summary.passed,
        "one_line": summary.one_line(),
        "violations": [v.to_dict() for v in constraint_result.violations],
        "violation_count": constraint_result.violation_count,
        "l5_count": constraint_result.l5_count,
        "l4_count": constraint_result.l4_count,
        "l3_count": constraint_result.l3_count,
        "l2_count": constraint_result.l2_count,
        "passed_checks": constraint_result.passed_checks,
        "auto_released": constraint_result.auto_released,
        "signals_count": len(signals),
        "signals": [s.to_dict() for s in signals],
        "coupling": coupling_result,
        "cycles": cycle_result,
        "summary": summary.to_dict(),
        "changed_files": changed_files,
        "total_changed_files": len(changed_files),
    }
