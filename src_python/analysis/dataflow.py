"""
数据流环检测 (Data Flow Cycle Detection)

在数据流图上运行 Johnson's algorithm (NetworkX simple_cycles) 找到所有有向环。
分类为三类：
  - 纯代码环    (gray)    环上全是符号节点
  - 数据持久环  (orange)  环上包含介质节点（文件/DB）
  - LLM 参与环  (red)     环上包含 LLM API 调用节点

算法确定性：
  ✓ 环检测完全确定（有向图的数学属性）
  ✗ 收敛/发散性不确定（需要运行时信息 + 模型权重）
  ✗ 自噬风险评估不确定（依赖用户纠正行为）

输出：在每个环上标注确定性和不确定性。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

import networkx as nx

from ..core.graph import Graph, Node, Edge, NodeType, EdgeType, type_val


# ============================================================
# LLM API 调用检测模式
# ============================================================

# 已知的 LLM SDK 调用模式
LLM_API_PATTERNS: List[str] = [
    # OpenAI
    "openai.ChatCompletion.create",
    "openai.Completion.create",
    "openai.chat.completions.create",
    # Anthropic
    "anthropic.messages.create",
    "anthropic.Anthropic.messages",
    "anthropic.Client.messages",
    # DeepSeek
    "deepseek.chat",
    "deepseek.ChatCompletion",
    "deepseek.chat.completions.create",
    # Google
    "google.generativeai.GenerativeModel.generate_content",
    # LangChain
    "langchain.chains.LLMChain.run",
    "langchain.llms.base.BaseLLM.__call__",
    "langchain.chat_models.base.BaseChatModel.__call__",
    # LangChain OpenAI Wrapper
    "langchain_openai.ChatOpenAI",
    "langchain_community.chat_models.ChatOpenAI",
    # Hugging Face
    "transformers.pipeline",
    "transformers.PreTrainedModel.generate",
    # Ollama
    "ollama.chat",
    "ollama.generate",
    # Generic HTTP patterns matching LLM API endpoints
    "httpx.post",    # 如果 URL 匹配已知 LLM API 端点
    "requests.post",  # 同上
]

# LLM API URL 模式（用于通用 HTTP 调用的进一步匹配）
LLM_API_URL_PATTERNS = [
    r"api\.openai\.com",
    r"api\.anthropic\.com",
    r"api\.deepseek\.com",
    r"generativelanguage\.googleapis\.com",
    r"localhost:11434/api",  # Ollama
    r"api\.groq\.com",
    r"api\.together\.xyz",
    r"api\.mistral\.ai",
    r"api\.cohere\.ai",
]


# ============================================================
# 数据流图构建
# ============================================================

class DataFlowGraphBuilder:
    """从全息图构建数据流子图。"""

    def __init__(self, graph: Graph):
        self.graph = graph
        self.nx_graph = nx.DiGraph()
        self.node_index: Dict[str, str] = {}  # graph node_id → nx node (str)

    def build(self) -> nx.DiGraph:
        """
        构建数据流有向图。

        节点包含：
          - 所有符号节点
          - 所有介质节点
          - LLM API 相关的虚拟节点

        边包含：
          - 数据边（读/写）
          - 结构边中的调用链（call）
          - LLM API 调用边
        """
        # 添加所有节点
        for node in self.graph.nodes.values():
            node_type_str = type_val(node.type)
            self.nx_graph.add_node(node.id, **{
                "name": node.name,
                "type": node_type_str,
                "kind": node.kind,
                "location": node.location,
                "is_llm_node": False,
            })

        # 添加边：数据边 + 结构边(call) + LLM API 边
        for edge in self.graph.edges.values():
            if edge.source not in self.nx_graph or edge.target not in self.nx_graph:
                continue

            edge_type_str = type_val(edge.type)

            # 数据边：总是加入
            if edge_type_str == "data":
                self.nx_graph.add_edge(edge.source, edge.target,
                                       type="data", direction=edge.direction,
                                       edge_id=edge.id)

            # 结构边：仅 call 方向加入（调用链形成数据流路径）
            elif edge_type_str == "structural" and edge.direction == "call":
                self.nx_graph.add_edge(edge.source, edge.target,
                                       type="structural", direction="call",
                                       edge_id=edge.id)

        # 检测 LLM API 相关节点并标记
        self._mark_llm_nodes()

        return self.nx_graph

    def _mark_llm_nodes(self) -> None:
        """在图上标记 LLM API 相关的节点。"""
        llm_node_ids: Set[str] = set()

        for node in self.graph.nodes.values():
            node_type_str = type_val(node.type)
            if node_type_str != "symbol":
                continue

            # 检查 properties 中是否有 llm_related 标记
            if node.properties and node.properties.get("is_llm_api"):
                llm_node_ids.add(node.id)
                continue

            # 检查节点名是否匹配 LLM SDK 模式
            name = node.name.lower()
            for pattern in LLM_API_PATTERNS:
                if pattern.lower() in name:
                    llm_node_ids.add(node.id)
                    break

        for nid in llm_node_ids:
            if nid in self.nx_graph:
                self.nx_graph.nodes[nid]["is_llm_node"] = True


# ============================================================
# 环分类
# ============================================================

@dataclass
class DataFlowCycle:
    """一个检测到的数据流环。"""
    cycle_id: str
    nodes: List[str]              # 环节点 ID 列表（有序）
    node_names: List[str]         # 环节点名称列表
    node_types: List[str]         # 每个节点的类型
    length: int                   # 环长（跳数）
    category: str                 # "pure_code" | "data_persistent" | "llm_involved"
    has_medium_node: bool = False
    has_llm_node: bool = False
    edge_ids: List[str] = field(default_factory=list)
    certainty: Dict[str, Any] = field(default_factory=dict)
    # 确定性标注
    degradation_risk: Optional[str] = None  # 仅 LLM 参与环

    def to_dict(self) -> Dict[str, Any]:
        return {
            "cycle_id": self.cycle_id,
            "nodes": self.nodes,
            "node_names": self.node_names,
            "node_types": self.node_types,
            "length": self.length,
            "category": self.category,
            "has_medium_node": self.has_medium_node,
            "has_llm_node": self.has_llm_node,
            "edge_ids": self.edge_ids,
            "certainty": self.certainty,
            "degradation_risk": self.degradation_risk,
        }


# ============================================================
# 主检测器
# ============================================================

class DataFlowCycleDetector:
    """
    数据流环检测器。

    在数据流有向图上运行环检测算法，分类每个环。
    """

    MAX_CYCLES_DEFAULT = 1000  # 每个强连通分量最多报告的环数
    MAX_CYCLE_LENGTH = 20      # 超过此长度的环忽略（分析价值低）

    def __init__(self, max_cycles: int = None, max_length: int = None):
        self.max_cycles = max_cycles or self.MAX_CYCLES_DEFAULT
        self.max_length = max_length or self.MAX_CYCLE_LENGTH

    def detect(self, graph: Graph) -> List[DataFlowCycle]:
        """
        在图上检测所有数据流环。

        Args:
            graph: 已构建的代码库图

        Returns:
            分类后的数据流环列表
        """
        # Step 1: 构建数据流图
        builder = DataFlowGraphBuilder(graph)
        nx_graph = builder.build()

        if nx_graph.number_of_nodes() == 0:
            return []

        # Step 2: 环检测（使用 NetworkX simple_cycles）
        cycles: List[DataFlowCycle] = []
        cycle_count = 0

        try:
            for cycle in nx.simple_cycles(nx_graph):
                if cycle_count >= self.max_cycles:
                    break

                # 环长过滤
                if len(cycle) < 2 or len(cycle) > self.max_length:
                    continue

                # 去重：只处理转回起点的完整环
                cycle_list = list(cycle)

                # Step 3: 分类环
                classified = self._classify_cycle(cycle_list, graph, nx_graph)
                if classified:
                    cycles.append(classified)
                    cycle_count += 1

        except nx.NetworkXNoCycle:
            pass

        return cycles

    def detect_scc(self, graph: Graph) -> List[DataFlowCycle]:
        """
        备选：基于强连通分量 (SCC) 的环检测。
        更快但不如 simple_cycles 精确——每个 SCC 可能有多个环交叠。
        """
        builder = DataFlowGraphBuilder(graph)
        nx_graph = builder.build()

        if nx_graph.number_of_nodes() == 0:
            return []

        cycles: List[DataFlowCycle] = []

        for scc in nx.strongly_connected_components(nx_graph):
            if len(scc) < 2:
                continue

            # 在每个 SCC 中找一个代表性环
            scc_list = list(scc)
            subgraph = nx_graph.subgraph(scc_list)

            try:
                for cycle in nx.simple_cycles(subgraph):
                    if len(cycles) >= self.max_cycles:
                        break
                    cycle_list = list(cycle)
                    if len(cycle_list) < 2 or len(cycle_list) > self.max_length:
                        continue

                    classified = self._classify_cycle(cycle_list, graph, nx_graph)
                    if classified:
                        cycles.append(classified)

            except Exception:
                pass

        return cycles

    def _classify_cycle(
        self,
        cycle_nodes: List[str],
        graph: Graph,
        nx_graph: nx.DiGraph,
    ) -> Optional[DataFlowCycle]:
        """分类单个环。"""
        has_medium = False
        has_llm = False
        node_names: List[str] = []
        node_types: List[str] = []
        edge_ids: List[str] = []

        for nid in cycle_nodes:
            node = graph.get_node(nid)
            if node:
                node_names.append(node.name)
                node_type_str = type_val(node.type)
                if node_type_str == "medium":
                    has_medium = True
                    node_types.append("medium")
                else:
                    node_types.append(node_type_str)
            else:
                node_names.append(nid)
                node_types.append("unknown")

            # 检查 LLM 标记
            if nid in nx_graph and nx_graph.nodes[nid].get("is_llm_node"):
                has_llm = True

            # 检查节点是否有 LLM SDK pattern
            if node and node.properties and node.properties.get("is_llm_api"):
                has_llm = True

        # 找环上的边
        for i in range(len(cycle_nodes)):
            src = cycle_nodes[i]
            tgt = cycle_nodes[(i + 1) % len(cycle_nodes)]
            for edge in graph.edges.values():
                if edge.source == src and edge.target == tgt:
                    edge_ids.append(edge.id)
                    break

        # 分类确定
        if has_llm:
            category = "llm_involved"
        elif has_medium:
            category = "data_persistent"
        else:
            category = "pure_code"

        # 确定性标注
        certainty = {
            "cycle_detection": "确定 — 有向图的环已精确识别",
            "convergence_assessment": "不确定 — 静态分析无法评估收敛/发散性",
            "degradation_speed": "不确定 — 退化速度取决于外部因素（模型权重、用户纠正）",
        }

        if has_llm:
            degradation_risk = "存在自噬风险 — LLM 输出影响未来 LLM 输入"
        elif has_medium:
            degradation_risk = "数据变更可能被放大 — 检查数据的一致性约束"
        else:
            degradation_risk = None

        cycle_id = f"cycle_{abs(hash(tuple(sorted(cycle_nodes)))) % 100000:05d}"

        return DataFlowCycle(
            cycle_id=cycle_id,
            nodes=cycle_nodes,
            node_names=node_names,
            node_types=node_types,
            length=len(cycle_nodes),
            category=category,
            has_medium_node=has_medium,
            has_llm_node=has_llm,
            edge_ids=edge_ids,
            certainty=certainty,
            degradation_risk=degradation_risk,
        )


def cycle_report(graph: Graph, mode: str = "all", max_cycles: int = 500) -> Dict[str, Any]:
    """便捷函数：对图运行环检测并返回结构化报告。

    Args:
        graph: 图
        mode: "all" | "data" | "llm" — 过滤环类型
        max_cycles: 最大环数

    Returns:
        包含环列表和统计的字典
    """
    detector = DataFlowCycleDetector(max_cycles=max_cycles)
    cycles = detector.detect(graph)

    if mode == "data":
        cycles = [c for c in cycles if c.category in ("data_persistent", "llm_involved")]
    elif mode == "llm":
        cycles = [c for c in cycles if c.category == "llm_involved"]

    pure_code_count = sum(1 for c in cycles if c.category == "pure_code")
    data_count = sum(1 for c in cycles if c.category == "data_persistent")
    llm_count = sum(1 for c in cycles if c.category == "llm_involved")

    return {
        "total_cycles": len(cycles),
        "pure_code_cycles": pure_code_count,
        "data_persistent_cycles": data_count,
        "llm_involved_cycles": llm_count,
        "mode_filter": mode,
        "cycles": [c.to_dict() for c in cycles],
        "certainty_note": (
            "环检测确定（数学属性）。"
            "收敛/发散性不确定。"
            f"{llm_count} 个 LLM 参与环的自噬风险评估不确定。"
        ),
    }
