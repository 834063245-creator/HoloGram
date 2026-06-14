"""
边界标注 (Boundary Markers) — SPEC V2 §9

程序层职责：
  - 穷举代码与外部世界的接触面（L4 穿透、无锁并发窗口、LLM 参与环）
  - 为每个边界生成上下文数据
  - 程序层不解释、不推断、不下结论

Agent 职责：
  - 用户点击边界标记 → "发送给 Agent" → 边界上下文写入终端 stdin
  - Agent 自由回复（无格式约束，无 verdict 协议）
  - Agent 不是法官，是跑前参谋。人自己去跑。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from ..core.graph import Graph


# ============================================================
# 边界类型
# ============================================================

class BoundaryType(str, Enum):
    L4_ENCAPSULATION = "L4_encapsulation_violation"
    UNLOCKED_CONCURRENT = "unlocked_concurrent_write"
    LLM_FEEDBACK_LOOP = "llm_feedback_loop"
    UNCLASSIFIED = "unclassified"


# ============================================================
# 边界数据模型
# ============================================================

@dataclass
class Boundary:
    """程序层检测到的边界。"""
    id: str
    type: BoundaryType
    title: str
    description: str
    related_nodes: List[str] = field(default_factory=list)
    related_files: List[str] = field(default_factory=list)
    priority: int = 50                # 0-100

    # 程序层可确定的
    certainty: str = ""               # 程序层确定性描述
    uncertainty: str = ""             # 程序层不确定之处

    # 发送给 Agent 的上下文数据
    context: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type.value,
            "title": self.title,
            "description": self.description,
            "related_nodes": self.related_nodes,
            "related_files": self.related_files,
            "priority": self.priority,
            "certainty": self.certainty,
            "uncertainty": self.uncertainty,
            "context": self.context,
        }

    def to_agent_context(self) -> str:
        """生成发送给 Agent 的上下文文本。"""
        import json as _json
        lines = [
            f"=== 边界: {self.title} ===",
            f"类型: {self.type.value}",
            f"描述: {self.description}",
            f"涉及文件: {', '.join(self.related_files)}",
            f"涉及节点: {', '.join(self.related_nodes)}" if self.related_nodes else "",
            f"程序层确定性: {self.certainty}",
            f"程序层不确定: {self.uncertainty}",
            "--- 上下文数据 ---",
            _json.dumps(self.context, indent=2, ensure_ascii=False),
            "====================",
        ]
        return "\n".join(lines)


# ============================================================
# 边界检测器
# ============================================================

class BoundaryDetector:
    """检测图上所有程序层可识别的边界。

    检测类型：
      1. L4 封装穿透 — 来自耦合深度计的 edge_classifications
      2. 无锁并发窗口 — 来自线程交错图
      3. LLM 参与环 — 来自数据流环检测
      4. 未分类 — 静态分析发现的异常模式但无匹配类型
    """

    def __init__(self):
        self._boundaries: List[Boundary] = []
        self._counter = 0

    def detect_from_coupling(
        self,
        coupling_result: Dict[str, Any],
    ) -> List[Boundary]:
        """从耦合深度分析结果生成 L4 边界。"""
        spots: List[Boundary] = []

        for report in coupling_result.get("module_reports", []):
            if report.get("l4_count", 0) > 0:
                context = {
                    "boundary_type": "L4_encapsulation_violation",
                    "module": report["module_name"],
                    "file_path": report["file_path"],
                    "violations": report.get("l4_violations", []),
                    "total_count": report["l4_count"],
                    "fragility_score": report["fragility_score"],
                }

                spot = Boundary(
                    id=self._next_id(),
                    type=BoundaryType.L4_ENCAPSULATION,
                    title=f"L4 封装穿透: {report['module_name']}",
                    description=f"{report['l4_count']} 处私有属性访问，脆弱性评分 {report['fragility_score']:.2f}",
                    related_files=[report["file_path"]],
                    certainty=f"确定 — {report['l4_count']} 处 _ 开头属性被外部访问",
                    uncertainty="不确定 — 是故意的性能优化还是意外的债务？",
                    context=context,
                    priority=min(100, report["l4_count"] * 8),
                )
                spots.append(spot)

        self._boundaries.extend(spots)
        return spots

    def detect_from_cycles(
        self,
        cycle_result: Dict[str, Any],
    ) -> List[Boundary]:
        """从数据流环检测结果生成 LLM 参与环边界。"""
        spots: List[Boundary] = []

        for cycle in cycle_result.get("cycles", []):
            if cycle.get("category") == "llm_involved":
                context = {
                    "boundary_type": "llm_feedback_loop",
                    "cycle": {
                        "length": cycle["length"],
                        "nodes": cycle.get("node_names", []),
                    },
                    "cycle_category": "数据持久环 + LLM 参与",
                    "degradation_risk": cycle.get("degradation_risk", "存在自噬风险"),
                }

                spot = Boundary(
                    id=self._next_id(),
                    type=BoundaryType.LLM_FEEDBACK_LOOP,
                    title=f"LLM 参与环: {' → '.join(cycle.get('node_names', [])[:4])}",
                    description=f"环长 {cycle['length']} 跳。LLM 输出影响未来 LLM 输入。",
                    related_nodes=cycle.get("nodes", []),
                    certainty="确定 — 检测到含有 LLM API 调用的有向环",
                    uncertainty="不确定 — 收敛/发散性、退化速度不可静态判断",
                    context=context,
                    priority=75,
                )
                spots.append(spot)

        self._boundaries.extend(spots)
        return spots

    def detect_from_thread_conflicts(
        self,
        thread_conflicts: Dict[str, Any],
    ) -> List[Boundary]:
        """从线程交错图结果生成无锁并发窗口边界。"""
        spots: List[Boundary] = []

        for resource_name, info in thread_conflicts.get("resources", {}).items():
            threads = info.get("threads", [])
            has_write = any(t.get("access") in ("W", "R/W") for t in threads)
            has_lock = info.get("lock_detected", False)

            if has_write and not has_lock:
                context = {
                    "boundary_type": "unlocked_concurrent_write",
                    "shared_resource": resource_name,
                    "threads": threads,
                    "locks_detected": info.get("locks_nearby", []),
                }

                spot = Boundary(
                    id=self._next_id(),
                    type=BoundaryType.UNLOCKED_CONCURRENT,
                    title=f"无锁并发窗口: {resource_name}",
                    description=f"{len(threads)} 个线程访问同一共享资源，未检测到锁保护",
                    related_files=info.get("files", []),
                    certainty=f"确定 — {len(threads)} 个线程字面量检测",
                    uncertainty="不确定 — 是否有隐式的线程安全约定？",
                    context=context,
                    priority=80,
                )
                spots.append(spot)

        self._boundaries.extend(spots)
        return spots

    def _next_id(self) -> str:
        self._counter += 1
        return f"bnd_{self._counter:04d}"

    def all(self, filter_type: str = "all") -> List[Boundary]:
        """返回所有边界，可选过滤。"""
        if filter_type == "all":
            return list(self._boundaries)
        type_map = {
            "L4": BoundaryType.L4_ENCAPSULATION,
            "thread": BoundaryType.UNLOCKED_CONCURRENT,
            "cycle": BoundaryType.LLM_FEEDBACK_LOOP,
        }
        target = type_map.get(filter_type)
        if target:
            return [b for b in self._boundaries if b.type == target]
        return list(self._boundaries)

    def get(self, boundary_id: str) -> Optional[Boundary]:
        """按 ID 获取单个边界。"""
        for b in self._boundaries:
            if b.id == boundary_id:
                return b
        return None


def find_blindspots(graph: Graph, min_confidence: float = 0.5) -> List[Dict[str, Any]]:
    """快捷函数：检测图中所有盲区边界。

    Args:
        graph: 依赖图
        min_confidence: 最小置信度阈值（暂未使用于过滤，预留接口）

    Returns:
        盲区边界列表（dict 格式），按 priority 降序排列
    """
    from .coupling import coupling_depth_report
    from .dataflow import cycle_report

    detector = BoundaryDetector()

    # 耦合分析 → L4 封装穿透边界
    try:
        coupling_result = coupling_depth_report(graph)
        detector.detect_from_coupling(coupling_result)
    except Exception:
        pass

    # 数据流环 → LLM 参与环边界
    try:
        cycle_result = cycle_report(graph, mode="all")
        detector.detect_from_cycles(cycle_result)
    except Exception:
        pass

    # 按 priority 降序排列
    boundaries = detector.all()
    boundaries.sort(key=lambda b: b.priority, reverse=True)

    return [b.to_dict() for b in boundaries]
