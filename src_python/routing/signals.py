"""
信号生成器 — L5-L1 破坏层级信号

消费 V1 图数据、V2 分析结果、V3 模式匹配器，生成结构化的信号列表。
每个信号标注层级（L5-L1）、确定性、受影响的节点。

依赖：patterns.py、V1 核心模块（graph, diff）、V2 分析模块（coupling, dataflow, threading）
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from ..core.graph import Graph, type_val, file_from_location
from ..core.diff import GraphDiffer
from .patterns import PatternMatcher, FileChange


# ============================================================
# 信号数据模型
# ============================================================

@dataclass
class Signal:
    """
    单条破坏信号。

    level:  L5=不可逆, L4=静默, L3=延迟, L2=波及, L1=可见
    """
    level: int                      # 5, 4, 3, 2, 1
    signal_type: str                # 信号类型标识
    category: str                   # 人类可读分类
    description: str                # 简述
    file_path: str = ""
    line: int = 0
    affected_nodes: List[str] = field(default_factory=list)  # 受影响的节点名
    graph_node_ids: List[str] = field(default_factory=list)   # 图中节点ID（由 summary enrich 填充）
    affected_files: List[str] = field(default_factory=list)   # 受影响的文件
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    confidence: str = "确定"         # 确定/高置信/中等/低置信
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "level": self.level,
            "signal_type": self.signal_type,
            "category": self.category,
            "description": self.description,
            "file_path": self.file_path,
            "line": self.line,
            "affected_nodes": self.affected_nodes,
            "graph_node_ids": self.graph_node_ids,
            "affected_files": self.affected_files,
            "old_value": self.old_value,
            "new_value": self.new_value,
            "confidence": self.confidence,
            "details": self.details,
        }

    @property
    def is_routable(self) -> bool:
        """L5-L2 路由给人，L1 不路由。"""
        return self.level >= 2


# ============================================================
# 信号生成器主类
# ============================================================

class SignalGenerator:
    """
    从变更信息中生成 L5-L1 破坏信号。

    输入：
      - before_graph / after_graph: 变更前后的图快照
      - file_changes: 变更前后文件的源码
      - coupling_result: V2 耦合深度分析结果 (optional)
      - cycle_result: V2 数据流环检测结果 (optional)
      - thread_result: V2 线程交错分析结果 (optional)
    """

    def __init__(self):
        self.matcher = PatternMatcher()

    def generate(
        self,
        before_graph: Optional[Graph] = None,
        after_graph: Optional[Graph] = None,
        file_changes: Optional[Dict[str, FileChange]] = None,
        coupling_result: Optional[Dict[str, Any]] = None,
        cycle_result: Optional[Dict[str, Any]] = None,
        thread_result: Optional[Dict[str, Any]] = None,
    ) -> List[Signal]:
        """
        生成所有 L5-L1 信号。

        Returns:
            按层级降序排列的信号列表
        """
        signals: List[Signal] = []

        file_changes = file_changes or {}
        changed_files = list(file_changes.keys())

        # ── L5: 不可逆破坏 ──
        signals.extend(self._detect_l5_migration(file_changes))
        signals.extend(self._detect_l5_api_contract(before_graph, after_graph, file_changes, coupling_result))
        signals.extend(self._detect_l5_serialization(file_changes))
        signals.extend(self._detect_l5_config_key(file_changes))

        # ── L4: 静默破坏 ──
        signals.extend(self._detect_l4_numeric_threshold(file_changes))
        signals.extend(self._detect_l4_llm_prompt(file_changes))
        signals.extend(self._detect_l4_sort_filter(file_changes))
        signals.extend(self._detect_l4_encapsulation(before_graph, after_graph, coupling_result))
        signals.extend(self._detect_l4_new_cycle(before_graph, after_graph, cycle_result))

        # ── L3: 延迟破坏 ──
        signals.extend(self._detect_l3_thread_timer(file_changes, thread_result))
        signals.extend(self._detect_l3_shared_data_write(before_graph, after_graph, file_changes))
        signals.extend(self._detect_l3_async_trigger(file_changes, thread_result))
        signals.extend(self._detect_l3_rhythm(file_changes))

        # ── L2: 波及破坏 ──
        signals.extend(self._detect_l2_blast_radius(before_graph, after_graph, changed_files))
        signals.extend(self._detect_l2_cross_community(before_graph, after_graph))
        signals.extend(self._detect_l2_api_signature(file_changes, coupling_result))
        signals.extend(self._detect_l2_shared_data_structure(file_changes, before_graph, after_graph))

        # ── L1: 可见破坏（不路由，仅记录）──
        signals.extend(self._detect_l1_visible(changed_files))

        return sorted(signals, key=lambda s: (-s.level, s.signal_type))

    # ════════════════════════════════════════════════════════
    # L5 — 不可逆破坏
    # ════════════════════════════════════════════════════════

    def _detect_l5_migration(self, file_changes: Dict[str, FileChange]) -> List[Signal]:
        """L5: 数据库 migration 文件新增/变更。

        注意：当前仅按文件名模式匹配，不对比文件内容。
        touch 一个 migration 文件也会触发此信号。
        """
        signals = []
        for file_path in file_changes:
            if self.matcher.is_migration_file(file_path):
                signals.append(Signal(
                    level=5,
                    signal_type="l5_db_migration",
                    category="数据库 migration 变更",
                    description=f"Migration 文件变更: {os.path.basename(file_path)}。"
                                f"数据库 schema 变更不可通过 git reset 回滚。",
                    file_path=file_path,
                    confidence="高",
                ))
        return signals

    def _detect_l5_api_contract(
        self,
        before_graph: Optional[Graph],
        after_graph: Optional[Graph],
        file_changes: Dict[str, FileChange],
        coupling_result: Optional[Dict[str, Any]],
    ) -> List[Signal]:
        """L5: API 合同变更 — 公开函数签名变更。"""
        signals = []

        # 方案 A: 基于图 diff: 检测 L1 公开 API 边的 source 节点签名变更
        if before_graph and after_graph:
            differ = GraphDiffer()
            diff = differ.diff(before_graph, after_graph)

            for mn in diff.modified_nodes:
                node = after_graph.get_node(mn.node_id) if after_graph else None
                if node is None:
                    continue
                if "kind" in mn.changed_properties:
                    old_kind, new_kind = mn.changed_properties["kind"]
                    signals.append(Signal(
                        level=5,
                        signal_type="l5_api_contract_kind",
                        category="公开 API 类型变更",
                        description=f"节点 {node.name} 类型变更: {old_kind} → {new_kind}",
                        file_path=file_from_location(node.location) if node.location else node.location,
                        affected_nodes=[node.name],
                        confidence="确定",
                    ))

        # 方案 B: 基于文件变更的 AST 签名检测
        for file_path, fc in file_changes.items():
            sig_changes = self.matcher.detect_signature_changes(
                fc.old_source, fc.new_source, file_path
            )
            for sc in sig_changes:
                if sc.pattern_name in ("required_param_added", "param_removed", "param_type_changed"):
                    # 保守策略：签名变更一律标记为公开 API

                    signals.append(Signal(
                        level=5,
                        signal_type=f"l5_api_{sc.pattern_name}",
                        category="公开 API 签名变更",
                        description=sc.context,
                        file_path=file_path,
                        line=sc.line,
                        affected_nodes=[sc.variable],
                        confidence="确定",
                        old_value=sc.old_value,
                        new_value=sc.new_value,
                    ))

        return signals

    def _detect_l5_serialization(self, file_changes: Dict[str, FileChange]) -> List[Signal]:
        """L5: 序列化格式变更。"""
        signals = []
        for file_path in file_changes:
            if self.matcher.is_serialization_file(file_path):
                signals.append(Signal(
                    level=5,
                    signal_type="l5_serialization_format",
                    category="序列化格式变更",
                    description=f"序列化格式定义文件变更: {os.path.basename(file_path)}。"
                                f"可能破坏跨语言/跨版本兼容性。",
                    file_path=file_path,
                    confidence="确定",
                ))
            # 也检测代码中的序列化方法
            fc = file_changes[file_path]
            for source in (fc.old_source, fc.new_source):
                if not source:
                    continue
                # 检测 __getstate__/__setstate__/to_dict/from_dict 是否在变更中
                func_defs = self.matcher.extract_function_defs(source)
                for fname in func_defs:
                    if fname in ("__getstate__", "__setstate__", "to_dict", "from_dict",
                                 "to_json", "from_json", "serialize", "deserialize"):
                        signals.append(Signal(
                            level=5,
                            signal_type="l5_serialization_method",
                            category="序列化方法变更",
                            description=f"序列化方法 {fname} 在 {file_path} 中被修改",
                            file_path=file_path,
                            line=func_defs[fname],
                            confidence="确定",
                        ))
        return signals

    def _detect_l5_config_key(self, file_changes: Dict[str, FileChange]) -> List[Signal]:
        """L5: 配置 key 删除/重命名。"""
        signals = []
        for file_path, fc in file_changes.items():
            if not self.matcher.is_config_file(file_path):
                continue
            if not fc.old_source or not fc.new_source:
                continue

            old_keys = self.matcher.extract_config_keys(fc.old_source)
            new_keys = self.matcher.extract_config_keys(fc.new_source)

            deleted = old_keys - new_keys
            added = new_keys - old_keys

            for key in deleted:
                signals.append(Signal(
                    level=5,
                    signal_type="l5_config_key_deleted",
                    category="配置 key 删除",
                    description=f"配置 key '{key}' 在 {os.path.basename(file_path)} 中被删除。"
                                f"代码中对旧 key 的引用将读取不到配置。",
                    file_path=file_path,
                    confidence="确定",
                    old_value=key,
                ))

            # 检测可能的 key 重命名 (added 和 deleted 同时存在，可能是重命名)
            if len(deleted) == 1 and len(added) == 1:
                old_key = next(iter(deleted))
                new_key = next(iter(added))
                signals.append(Signal(
                    level=5,
                    signal_type="l5_config_key_renamed",
                    category="配置 key 重命名",
                    description=f"配置 key 疑似重命名: '{old_key}' → '{new_key}'。"
                                f"代码中引用旧 key 的地方需要同步更新。",
                    file_path=file_path,
                    confidence="高置信",
                    old_value=old_key,
                    new_value=new_key,
                ))

        return signals

    # ════════════════════════════════════════════════════════
    # L4 — 静默破坏
    # ════════════════════════════════════════════════════════

    def _detect_l4_numeric_threshold(self, file_changes: Dict[str, FileChange]) -> List[Signal]:
        """L4: 数值阈值/超时/间隔变更。"""
        signals = []
        for file_path, fc in file_changes.items():
            matches = self.matcher.detect_numeric_changes(
                fc.old_source, fc.new_source, file_path,
                variable_filter=self.matcher.matches_threshold_variable,
            )
            for m in matches:
                signals.append(Signal(
                    level=4,
                    signal_type="l4_threshold_change",
                    category="数值阈值变更",
                    description=f"{m.context}（该变量名匹配阈值/超时/限制模式）",
                    file_path=file_path,
                    line=m.line,
                    affected_nodes=[m.variable],
                    confidence="确定",
                    old_value=m.old_value,
                    new_value=m.new_value,
                ))

            # 也检测 denylist 关键字的变量
            denylist_matches = self.matcher.detect_numeric_changes(
                fc.old_source, fc.new_source, file_path,
                variable_filter=self.matcher.matches_denylist_keyword,
            )
            for m in denylist_matches:
                if any(s.file_path == file_path and s.line == m.line for s in signals):
                    continue
                signals.append(Signal(
                    level=4,
                    signal_type="l4_sensitive_value_change",
                    category="敏感数值变更",
                    description=f"{m.context}（变量名匹配安全敏感关键词）",
                    file_path=file_path,
                    line=m.line,
                    affected_nodes=[m.variable],
                    confidence="高置信",
                    old_value=m.old_value,
                    new_value=m.new_value,
                ))

        return signals

    def _detect_l4_llm_prompt(self, file_changes: Dict[str, FileChange]) -> List[Signal]:
        """L4: LLM prompt 变更。"""
        signals = []
        for file_path, fc in file_changes.items():
            # 检查字符串变更
            str_matches = self.matcher.detect_string_changes(
                fc.old_source, fc.new_source, file_path,
                variable_filter=self.matcher.matches_llm_prompt_variable,
            )
            for m in str_matches:
                signals.append(Signal(
                    level=4,
                    signal_type="l4_llm_prompt_change",
                    category="LLM Prompt 变更",
                    description=f"LLM prompt 变量 '{m.variable}' 内容变更。"
                                f"可能影响 LLM 输出质量/行为。",
                    file_path=file_path,
                    line=m.line,
                    affected_nodes=[m.variable],
                    confidence="高置信",
                ))

        return signals

    def _detect_l4_sort_filter(self, file_changes: Dict[str, FileChange]) -> List[Signal]:
        """L4: 排序/过滤/评分逻辑变更。"""
        signals = []
        for file_path, fc in file_changes.items():
            func_matches = self.matcher.detect_function_changes(
                fc.old_source, fc.new_source, file_path,
                func_filter=self.matcher.matches_sort_filter_function,
            )
            for m in func_matches:
                signals.append(Signal(
                    level=4,
                    signal_type="l4_sort_filter_change",
                    category="排序/过滤/评分逻辑变更",
                    description=m.context + "。该函数名匹配排序/过滤/评分模式。",
                    file_path=file_path,
                    line=m.line,
                    affected_nodes=[m.variable],
                    confidence="确定" if m.pattern_name == "function_modified" else "高置信",
                ))

        return signals

    def _detect_l4_encapsulation(
        self,
        before_graph: Optional[Graph],
        after_graph: Optional[Graph],
        coupling_result: Optional[Dict[str, Any]],
    ) -> List[Signal]:
        """L4: 新增 L4 封装穿透（利用 V2 耦合深度分析结果）。"""
        signals = []
        if not coupling_result:
            return signals

        # coupling_result 包含 edge_classifications 和 module_reports
        module_reports = coupling_result.get("module_reports", [])

        # 从 module_reports 中提取 L4 违规
        for report in module_reports:
            l4_violations = report.get("l4_violations", [])
            file_path = report.get("file_path", "")
            for v in l4_violations:
                signals.append(Signal(
                    level=4,
                    signal_type="l4_encapsulation_violation",
                    category="L4 封装穿透",
                    description=f"封装穿透: {v.get('access', '?')} — {v.get('context', '?')}",
                    file_path=file_path,
                    line=v.get("line", 0),
                    confidence="确定",
                    details={"access": v.get("access", ""), "context": v.get("context", "")},
                ))

        return signals

    def _detect_l4_new_cycle(
        self,
        before_graph: Optional[Graph],
        after_graph: Optional[Graph],
        cycle_result: Optional[Dict[str, Any]],
    ) -> List[Signal]:
        """L4: 新增数据流环。"""
        signals = []
        if not cycle_result:
            return signals

        cycles = cycle_result.get("cycles", [])
        for c in cycles:
            # 检查环是否包含本次变更的文件
            node_names = c.get("node_names", [])
            category = c.get("category", "pure_code")
            risk = c.get("degradation_risk", "")

            desc = f"检测到{len(node_names)}跳数据流环"
            if risk:
                desc += f"。{risk}"
            desc += f"。环节点: {' → '.join(node_names[:4])}"
            if len(node_names) > 4:
                desc += f" ... 共 {len(node_names)} 个"

            signals.append(Signal(
                level=4,
                signal_type=f"l4_dataflow_cycle_{category}",
                category=f"数据流环 ({self._cycle_label(category)})",
                description=desc,
                affected_nodes=node_names,
                confidence="确定（环检测是数学属性）",
                details={"cycle_id": c.get("cycle_id", ""), "category": category},
            ))

        return signals

    # ════════════════════════════════════════════════════════
    # L3 — 延迟破坏
    # ════════════════════════════════════════════════════════

    def _detect_l3_thread_timer(
        self,
        file_changes: Dict[str, FileChange],
        thread_result: Optional[Dict[str, Any]],
    ) -> List[Signal]:
        """L3: 后台线程/定时器新增或变更。"""
        signals = []
        if not thread_result:
            # 回退：检查文件变更中是否有线程相关导入
            for file_path, fc in file_changes.items():
                for source in [fc.old_source, fc.new_source]:
                    if not source:
                        continue
                    if "threading" in source or "Thread(" in source or "Timer(" in source:
                        signals.append(Signal(
                            level=3,
                            signal_type="l3_thread_related_file",
                            category="线程/定时器相关文件变更",
                            description=f"文件 {os.path.basename(file_path)} 涉及线程/定时器代码",
                            file_path=file_path,
                            confidence="中等",
                        ))
                        break
            return signals

        threads = thread_result.get("threads", [])
        resources = thread_result.get("resources", {})

        # 检测线程新增
        for t in threads:
            t_file = file_from_location(t.get("location") or "")
            if t_file in file_changes:
                signals.append(Signal(
                    level=3,
                    signal_type="l3_thread_created",
                    category="线程创建点变更",
                    description=f"检测到线程创建: {t.get('type', '?')} → {t.get('target', '?')} "
                                f"({t.get('confidence', '中等')})",
                    file_path=t_file,
                    confidence=t.get("confidence", "中等"),
                ))

        # 检测共享资源冲突
        unlocked = {k: v for k, v in resources.items()
                    if v.get("thread_count", 0) > 1 and not v.get("lock_detected", True)}
        for rname, rdata in unlocked.items():
            rfiles = rdata.get("files", [])
            for f in rfiles:
                if f in file_changes:
                    signals.append(Signal(
                        level=3,
                        signal_type="l3_unlocked_concurrent_access",
                        category="无锁并发访问",
                        description=f"共享资源 {rname} 被 {rdata.get('thread_count', 0)} 个线程并发访问，"
                                    f"无锁保护",
                        file_path=f if isinstance(f, str) else str(f),
                        confidence="中等",
                    ))
                    break

        return signals

    def _detect_l3_shared_data_write(
        self,
        before_graph: Optional[Graph],
        after_graph: Optional[Graph],
        file_changes: Dict[str, FileChange],
    ) -> List[Signal]:
        """L3: 共享数据文件的写入逻辑变更。"""
        signals = []
        if not after_graph:
            return signals

        # 查找 medium 类型节点，检测是否有写边
        for node in after_graph.nodes.values():
            node_type_str = type_val(node.type)
            if node_type_str != "medium":
                continue

            # 获取此介质的所有写入边
            incoming = after_graph.incoming_edges(node.id)
            write_edges = [
                e for e in incoming
                if e.direction in ("write", "subscribe")
            ]

            if len(write_edges) >= 1:
                # 检查写入节点是否在变更文件中
                for e in write_edges:
                    src_node = after_graph.get_node(e.source)
                    if src_node is None:
                        continue
                    src_file = file_from_location(src_node.location) if src_node.location else src_node.location
                    if src_file in file_changes:
                        signals.append(Signal(
                            level=3,
                            signal_type="l3_shared_data_write_changed",
                            category="共享数据写入逻辑变更",
                            description=f"对共享介质 {node.name} ({node.kind}) 的写入逻辑发生变更。"
                                        f"写入方: {src_node.name}",
                            file_path=src_file,
                            affected_nodes=[src_node.name, node.name],
                            confidence="高置信",
                        ))

        return signals

    def _detect_l3_async_trigger(
        self,
        file_changes: Dict[str, FileChange],
        thread_result: Optional[Dict[str, Any]],
    ) -> List[Signal]:
        """L3: 异步任务的触发条件变更。"""
        signals = []
        for file_path, fc in file_changes.items():
            if not fc.old_source or not fc.new_source:
                continue

            # 检测 async 函数的新增
            for source in [fc.new_source]:
                if not source:
                    continue
                try:
                    import ast as _ast
                    tree = _ast.parse(source)
                except SyntaxError:
                    continue
                for node in _ast.walk(tree):
                    if isinstance(node, _ast.AsyncFunctionDef):
                        func_name = node.name
                        # 检查调用此 async 函数的调度代码是否也在变更中
                        signals.append(Signal(
                            level=3,
                            signal_type="l3_async_function_changed",
                            category="异步函数变更",
                            description=f"异步函数 {func_name} 定义变更。"
                                        f"其调度器/事件循环的触发条件可能受影响。",
                            file_path=file_path,
                            line=node.lineno,
                            confidence="低置信",
                        ))

        return signals

    def _detect_l3_rhythm(self, file_changes: Dict[str, FileChange]) -> List[Signal]:
        """L3: 节律参数变更。"""
        signals = []
        for file_path, fc in file_changes.items():
            matches = self.matcher.detect_numeric_changes(
                fc.old_source, fc.new_source, file_path,
                variable_filter=self.matcher.matches_rhythm_variable,
            )
            for m in matches:
                signals.append(Signal(
                    level=3,
                    signal_type="l3_rhythm_change",
                    category="节律参数变更",
                    description=f"节律参数 {m.variable} 变更: {m.old_value} → {m.new_value}。"
                                f"影响后台任务调度频率。",
                    file_path=file_path,
                    line=m.line,
                    confidence="确定",
                    old_value=m.old_value,
                    new_value=m.new_value,
                ))

        return signals

    # ════════════════════════════════════════════════════════
    # L2 — 波及破坏
    # ════════════════════════════════════════════════════════

    def _detect_l2_blast_radius(
        self,
        before_graph: Optional[Graph],
        after_graph: Optional[Graph],
        changed_files: List[str],
    ) -> List[Signal]:
        """L2: 波及半径（BFS 从变更节点出发）。"""
        signals = []
        if not after_graph:
            return signals

        # 找到变更文件中的所有节点
        changed_nodes: List[str] = []
        for file_path in changed_files:
            nodes = after_graph.find_nodes_by_location(file_path)
            changed_nodes.extend(n.id for n in nodes)

        if not changed_nodes:
            return signals

        # 对每个变更节点运行 BFS 波及分析
        total_affected: Set[str] = set()
        for nid in changed_nodes:
            layers = after_graph.impact_bfs(nid, max_depth=3)
            for layer in layers:
                for nd in layer.get("nodes", []):
                    if isinstance(nd, dict):
                        total_affected.add(nd.get("id", ""))
                    else:
                        total_affected.add(getattr(nd, "id", ""))

        # 排除自身
        affected = total_affected - set(changed_nodes)
        if affected:
            signals.append(Signal(
                level=2,
                signal_type="l2_blast_radius",
                category="波及节点数",
                description=f"变更波及 {len(affected)} 个下游节点。"
                            f"变更点: {len(changed_nodes)} 个节点。",
                affected_nodes=list(affected)[:20],
                details={
                    "total_affected": len(affected),
                    "changed_nodes": len(changed_nodes),
                },
                confidence="确定",
            ))

        return signals

    def _detect_l2_cross_community(
        self,
        before_graph: Optional[Graph],
        after_graph: Optional[Graph],
    ) -> List[Signal]:
        """L2: 跨社区边新增。"""
        signals = []
        if not before_graph or not after_graph:
            return signals

        if not before_graph.communities or not after_graph.communities:
            return signals

        # 构建社区归属映射
        def _get_community_map(graph: Graph) -> Dict[str, str]:
            cmap: Dict[str, str] = {}
            for comm in graph.communities:
                for nid in comm.node_ids:
                    cmap[nid] = comm.id
            return cmap

        after_map = _get_community_map(after_graph)

        differ = GraphDiffer()
        diff = differ.diff(before_graph, after_graph)

        cross_community_edges = []
        for e in diff.added_edges:
            src_comm = after_map.get(e.source, "")
            tgt_comm = after_map.get(e.target, "")
            if src_comm and tgt_comm and src_comm != tgt_comm:
                src_node = after_graph.get_node(e.source)
                tgt_node = after_graph.get_node(e.target)
                src_name = src_node.name if src_node else e.source
                tgt_name = tgt_node.name if tgt_node else e.target
                cross_community_edges.append({
                    "source": src_name,
                    "target": tgt_name,
                    "from_community": src_comm,
                    "to_community": tgt_comm,
                })

        for cce in cross_community_edges:
            signals.append(Signal(
                level=2,
                signal_type="l2_cross_community_edge",
                category="跨社区边新增",
                description=f"新增跨社区依赖: {cce['source']} (社区 {cce['from_community']}) "
                            f"→ {cce['target']} (社区 {cce['to_community']})",
                confidence="确定",
                details=cce,
            ))

        return signals

    def _detect_l2_api_signature(
        self,
        file_changes: Dict[str, FileChange],
        coupling_result: Optional[Dict[str, Any]],
    ) -> List[Signal]:
        """L2: 公开 API 签名变更（非破坏性的参数变更）。"""
        signals = []
        for file_path, fc in file_changes.items():
            sig_changes = self.matcher.detect_signature_changes(
                fc.old_source, fc.new_source, file_path
            )
            for sc in sig_changes:
                if sc.pattern_name == "optional_param_added":
                    signals.append(Signal(
                        level=2,
                        signal_type="l2_api_signature_optional",
                        category="公开 API 签名变更（可选参数）",
                        description=sc.context,
                        file_path=file_path,
                        line=sc.line,
                        affected_nodes=[sc.variable],
                        confidence="确定",
                    ))

        return signals

    def _detect_l2_shared_data_structure(
        self,
        file_changes: Dict[str, FileChange],
        before_graph: Optional[Graph],
        after_graph: Optional[Graph],
    ) -> List[Signal]:
        """L2: 共享数据结构字段变更。"""
        signals = []
        for file_path, fc in file_changes.items():
            field_changes = self.matcher.detect_class_field_changes(
                fc.old_source, fc.new_source, file_path
            )
            for fc_match in field_changes:
                # 检查此数据结构是否被 ≥ 3 个模块引用
                ref_count = 0
                if after_graph:
                    cls_name = fc_match.variable.split(".")[0] if "." in fc_match.variable else ""
                    found_nodes = after_graph.find_node_by_name(cls_name) if cls_name else []
                    for node in found_nodes:
                        incoming = after_graph.incoming_edges(node.id)
                        ref_count = len(set(
                            file_from_location(after_graph.get_node(e.source).location)  # type: ignore[union-attr]
                            for e in incoming
                            if after_graph.get_node(e.source)
                        ))
                        break  # 只取第一个匹配节点的引用数

                if ref_count >= 3 or fc_match.pattern_name == "data_field_removed":
                    signals.append(Signal(
                        level=2,
                        signal_type="l2_data_structure_field_change",
                        category="共享数据结构字段变更",
                        description=f"{fc_match.context}（被 {ref_count} 个模块引用）"
                                    if ref_count >= 3 else fc_match.context,
                        file_path=file_path,
                        line=fc_match.line,
                        affected_nodes=[fc_match.variable],
                        confidence="确定",
                    ))

        return signals

    # ════════════════════════════════════════════════════════
    # L1 — 可见破坏（不路由，仅记录）
    # ════════════════════════════════════════════════════════

    def _detect_l1_visible(self, changed_files: List[str]) -> List[Signal]:
        """L1: 可见破坏 — 测试文件变更 / 语法错误（不路由）。"""
        signals = []
        for file_path in changed_files:
            if self.matcher.is_doc_or_test_file(file_path):
                signals.append(Signal(
                    level=1,
                    signal_type="l1_test_file_changed",
                    category="测试文件变更",
                    description=f"测试文件变更: {os.path.basename(file_path)}。"
                                f"如有测试失败，LLM 可以自行修复。",
                    file_path=file_path,
                    confidence="确定",
                ))
        return signals

    # ── 辅助 ──

    @staticmethod
    def _cycle_label(category: str) -> str:
        labels = {
            "pure_code": "纯代码环",
            "data_persistent": "数据持久环",
            "llm_involved": "LLM参与环",
        }
        return labels.get(category, category)
