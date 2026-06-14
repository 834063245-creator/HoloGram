"""
适配器基类：所有语言适配器必须实现的统一接口。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional

from ..core.graph import Graph, Node, Edge


@dataclass
class AdapterResult:
    """单个文件的分析结果。"""
    file_path: str
    nodes: List[Node] = field(default_factory=list)
    edges: List[Edge] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return len(self.errors) == 0


class LanguageAdapter(ABC):
    """语言适配器抽象基类。

    每个具体语言实现三个方法：
      - accept(file_path) -> bool     是否接受该文件
      - extract_symbols(...)          提取符号节点 + 结构边
      - extract_media(...)            提取介质节点 + 数据边
      - extract_temporal(...)         提取时间节点 + 时间边
    """

    language: str = "__unknown__"
    file_extensions: List[str] = []

    def accept(self, file_path: str) -> bool:
        """默认按扩展名判断。子类可覆盖。"""
        return any(file_path.endswith(ext) for ext in self.file_extensions)

    @abstractmethod
    def extract_symbols(self, file_path: str, source: str) -> AdapterResult:
        """提取符号节点 + 结构边。"""
        ...

    @abstractmethod
    def extract_media(self, file_path: str, source: str, graph: Graph) -> AdapterResult:
        """提取介质节点 + 数据边。需要已构建的符号图做上下文。"""
        ...

    @abstractmethod
    def extract_temporal(self, file_path: str, source: str, graph: Graph) -> AdapterResult:
        """提取时间节点 + 时间边。需要已构建的符号图做上下文。"""
        ...

    def analyze(self, file_path: str, source: str, graph: Optional[Graph] = None) -> AdapterResult:
        """完整分析流程：符号 → 介质 → 时间。"""
        g = graph or Graph()
        result = AdapterResult(file_path=file_path)

        sym = self.extract_symbols(file_path, source)
        result.nodes.extend(sym.nodes)
        result.edges.extend(sym.edges)
        result.errors.extend(sym.errors)
        result.warnings.extend(sym.warnings)

        # 将符号节点加入上下文图，供介质和时间提取使用
        for node in sym.nodes:
            g.add_node(node)
        for edge in sym.edges:
            g.add_edge(edge)

        med = self.extract_media(file_path, source, g)
        result.nodes.extend(med.nodes)
        result.edges.extend(med.edges)
        result.errors.extend(med.errors)
        result.warnings.extend(med.warnings)

        tmp = self.extract_temporal(file_path, source, g)
        result.nodes.extend(tmp.nodes)
        result.edges.extend(tmp.edges)
        result.errors.extend(tmp.errors)
        result.warnings.extend(tmp.warnings)

        return result
