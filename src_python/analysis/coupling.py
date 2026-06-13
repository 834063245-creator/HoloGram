"""
耦合深度计 (Coupling Depth Meter)

对每条结构边，判定其耦合深度等级 L1-L4：
  L1 — 公开 API 调用（蓝色实线）
  L2 — 内部模块导入（浅蓝实线）
  L3 — 共享数据文件（橙色虚线）
  L4 — 封装穿透（红色闪烁虚线）

实现：
  - Python: 基于 AST 分析，补充 adapter 已有的边属性
  - TypeScript: 基于正则模式匹配的保守近似
  - 输出: 图边上的 coupling_depth 属性 + 模块级统计报告
"""

from __future__ import annotations

import ast
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from ..core.graph import Graph, Node, Edge, NodeType, EdgeType, SymbolKind, file_from_location, type_val


# ============================================================
# 耦合深度等级
# ============================================================

class CouplingLevel:
    L1_PUBLIC_API = 1       # 公开 API 调用
    L2_INTERNAL_IMPORT = 2  # 内部模块导入
    L3_SHARED_DATA = 3      # 共享数据文件
    L4_ENCAPSULATION_VIOLATION = 4  # 封装穿透


COUPLING_LABELS = {
    1: "公开API",
    2: "内部导入",
    3: "共享数据文件",
    4: "封装穿透",
}

COUPLING_COLORS = {
    1: "#4A9EFF",   # 蓝色实线
    2: "#89C4F4",   # 浅蓝实线
    3: "#F4A460",   # 橙色虚线
    4: "#FF4444",   # 红色闪烁虚线
}

COUPLING_STYLES = {
    1: "solid",
    2: "solid",
    3: "dashed",
    4: "dashed-blinking",
}


@dataclass
class CouplingReport:
    """模块级耦合深度统计。"""
    module_name: str
    file_path: str
    l1_count: int = 0
    l2_count: int = 0
    l3_count: int = 0
    l4_count: int = 0
    l4_violations: List[Dict[str, Any]] = field(default_factory=list)
    l3_shared_resources: List[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return self.l1_count + self.l2_count + self.l3_count + self.l4_count

    @property
    def l4_density(self) -> float:
        """L4 边密度 = L4 数 / 总边数。若无边则为 0。"""
        if self.total == 0:
            return 0.0
        return self.l4_count / self.total

    @property
    def fragility_score(self) -> float:
        """脆弱性评分（用于排序 Top N 最脆弱模块）。

        L4 权重 4, L3 权重 2, L2 权重 1, L1 权重 0.
        归一化到 [0, 1]。
        """
        weighted = self.l4_count * 4 + self.l3_count * 2 + self.l2_count * 1
        if self.total == 0:
            return 0.0
        return weighted / self.total

    def to_dict(self) -> Dict[str, Any]:
        return {
            "module_name": self.module_name,
            "file_path": self.file_path,
            "l1_count": self.l1_count,
            "l2_count": self.l2_count,
            "l3_count": self.l3_count,
            "l4_count": self.l4_count,
            "total": self.total,
            "l4_density": round(self.l4_density, 3),
            "fragility_score": round(self.fragility_score, 3),
            "l4_violations": self.l4_violations,
            "l3_shared_resources": self.l3_shared_resources,
        }


# ============================================================
# Python: __all__ 导出解析
# ============================================================

def _parse_all_exports(file_path: str, source: str) -> Set[str]:
    """解析 Python 文件的 __all__ 导出列表。"""
    exports: Set[str] = set()
    try:
        tree = ast.parse(source, filename=file_path)
    except SyntaxError:
        return exports

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    if isinstance(node.value, (ast.List, ast.Tuple)):
                        for elt in node.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                exports.add(elt.value)
    return exports


def _is_public_name(name: str, all_exports: Set[str]) -> bool:
    """判断符号名是否为公开 API。"""
    short = name.split(".")[-1]
    if short.startswith("_"):
        return False
    if all_exports and short in all_exports:
        return True
    if not all_exports:
        return True
    return False


# ============================================================
# Python: L4 封装穿透检测 (AST 遍历)
# ============================================================

class _L4ViolationVisitor(ast.NodeVisitor):
    """检测访问其他模块私有属性的模式。"""

    def __init__(self, file_path: str, own_module_name: str):
        self.file_path = file_path
        self.own_module = own_module_name
        self.violations: List[Dict[str, Any]] = []

    def visit_Attribute(self, node: ast.Attribute) -> None:
        # 检测 _private_attr 访问（attr 以 _ 开头且 value 不是 self）
        import_module = None
        if isinstance(node.value, ast.Name):
            if node.value.id != "self" and node.value.id != "cls":
                import_module = node.value.id
        elif isinstance(node.value, ast.Attribute):
            # 如 module.obj._private
            pass

        if node.attr.startswith("_") and not node.attr.startswith("__") and import_module:
            if import_module != self.own_module:
                self.violations.append({
                    "line": node.lineno,
                    "access": f"{import_module}.{node.attr}",
                    "context": f"访问外部模块 {import_module} 的私有属性 {node.attr}",
                })

        # 检测 __ double-underscore 私有属性（更强的封装信号）
        if node.attr.startswith("__") and not node.attr.endswith("__"):
            if isinstance(node.value, ast.Name) and node.value.id != "self":
                self.violations.append({
                    "line": node.lineno,
                    "access": f"{node.value.id}.{node.attr}",
                    "context": f"访问 name-mangled 私有属性 {node.attr}（强封装穿透）",
                })

        self.generic_visit(node)


def _detect_l4_violations_python(file_path: str, source: str) -> List[Dict[str, Any]]:
    """Python AST 遍历检测 L4 封装穿透。"""
    module_name = os.path.splitext(os.path.basename(file_path))[0]
    try:
        tree = ast.parse(source, filename=file_path)
    except SyntaxError:
        return []

    visitor = _L4ViolationVisitor(file_path, module_name)
    visitor.visit(tree)
    return visitor.violations


# ============================================================
# Python: L3 共享数据文件检测
# ============================================================

class _DataFileVisitor(ast.NodeVisitor):
    """检测文件/DB 路径字符串字面量。"""

    # 文件路径相关的函数调用模式
    PATH_FUNCTIONS = {
        "open", "Path", "pathlib.Path",
        "json.load", "json.dump",
        "pickle.load", "pickle.dump",
        "sqlite3.connect",
    }

    def __init__(self):
        self.data_paths: List[Dict[str, Any]] = []

    def visit_Call(self, node: ast.Call) -> None:
        func_name = self._get_func_name(node.func)
        for kw in node.keywords:
            if kw.arg in ("file", "filename", "path", "database", "db"):
                if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                    self.data_paths.append({
                        "line": node.lineno,
                        "path": kw.value.value,
                        "type": self._path_type(kw.value.value),
                    })

        # 位置参数：第一个参数通常是路径
        if node.args:
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                val = first.value
                if self._looks_like_path(val) or func_name in self.PATH_FUNCTIONS:
                    self.data_paths.append({
                        "line": node.lineno,
                        "path": val,
                        "type": self._path_type(val),
                    })

        self.generic_visit(node)

    @staticmethod
    def _get_func_name(node: ast.expr) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            base = _DataFileVisitor._get_func_name(node.value)
            return f"{base}.{node.attr}" if base else node.attr
        return ""

    @staticmethod
    def _looks_like_path(s: str) -> bool:
        """启发式：字符串看起来像文件路径？"""
        return bool(re.search(r'\.(json|db|sqlite|yaml|yml|toml|ini|cfg|csv|txt|log|xml|pkl|pickle)$', s))

    @staticmethod
    def _path_type(path: str) -> str:
        """根据扩展名推断存储类型。"""
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        mapping = {
            "json": "json_file",
            "db": "sqlite_db",
            "sqlite": "sqlite_db",
            "csv": "csv_file",
            "yaml": "yaml_file",
            "yml": "yaml_file",
            "toml": "toml_file",
            "ini": "ini_file",
            "cfg": "config_file",
            "log": "log_file",
            "xml": "xml_file",
            "pkl": "pickle_file",
            "pickle": "pickle_file",
        }
        return mapping.get(ext, "data_file")


def _detect_data_paths_python(file_path: str, source: str) -> List[Dict[str, Any]]:
    """提取 Python 文件中的数据文件路径。"""
    try:
        tree = ast.parse(source, filename=file_path)
    except SyntaxError:
        return []

    visitor = _DataFileVisitor()
    visitor.visit(tree)
    return visitor.data_paths


# ============================================================
# 耦合深度分析器（主入口）
# ============================================================

class CouplingDepthAnalyzer:
    """对图上的每条结构边进行耦合深度分类。"""

    def __init__(self):
        self._file_source_cache: Dict[str, str] = {}
        self._all_exports_cache: Dict[str, Set[str]] = {}
        self._violations_cache: Dict[str, List[Dict[str, Any]]] = {}
        self._data_paths_cache: Dict[str, List[Dict[str, Any]]] = {}

    def analyze(self, graph: Graph, file_sources: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """
        对整张图的边进行耦合深度分类。

        Args:
            graph: 已构建的代码库图
            file_sources: 可选的文件路径 → 源码内容映射（用于 AST 扫描）

        Returns:
            包含 edge_classifications 和 module_reports 的字典
        """
        if file_sources:
            self._file_source_cache = dict(file_sources)

        edge_classifications: Dict[str, int] = {}
        module_reports: Dict[str, CouplingReport] = {}

        # 遍历所有结构边
        for edge in graph.edges.values():
            edge_type_str = type_val(edge.type)
            if edge_type_str != "structural":
                continue

            level = self._classify_edge(edge, graph)
            edge_classifications[edge.id] = level
            # 写入边属性
            edge.coupling_depth = level

            # 按源文件聚合报告
            src_node = graph.get_node(edge.source)
            if src_node and src_node.location:
                mod_file = file_from_location(src_node.location)
                if mod_file not in module_reports:
                    module_reports[mod_file] = CouplingReport(
                        module_name=os.path.splitext(os.path.basename(mod_file))[0],
                        file_path=mod_file,
                    )
                report = module_reports[mod_file]
                if level == CouplingLevel.L1_PUBLIC_API:
                    report.l1_count += 1
                elif level == CouplingLevel.L2_INTERNAL_IMPORT:
                    report.l2_count += 1
                elif level == CouplingLevel.L3_SHARED_DATA:
                    report.l3_count += 1
                elif level == CouplingLevel.L4_ENCAPSULATION_VIOLATION:
                    report.l4_count += 1

        # 补充 L4 违规详情（从 AST 扫描中获取）
        for mod_file, report in module_reports.items():
            if report.l4_count > 0 and mod_file in self._violations_cache:
                report.l4_violations = self._violations_cache[mod_file]

            # 检测共享数据文件 (L3)
            if mod_file in self._data_paths_cache:
                data_paths = self._data_paths_cache[mod_file]
                report.l3_shared_resources = list(set(p["path"] for p in data_paths))

        # 按脆弱性评分排序
        sorted_reports = sorted(
            module_reports.values(),
            key=lambda r: r.fragility_score,
            reverse=True,
        )

        return {
            "edge_classifications": edge_classifications,
            "module_reports": [r.to_dict() for r in sorted_reports],
            "total_l1": sum(r.l1_count for r in module_reports.values()),
            "total_l2": sum(r.l2_count for r in module_reports.values()),
            "total_l3": sum(r.l3_count for r in module_reports.values()),
            "total_l4": sum(r.l4_count for r in module_reports.values()),
        }

    def _classify_edge(self, edge: Edge, graph: Graph) -> int:
        """对单条边进行 L1-L4 分类。"""
        edge_dir = getattr(edge, 'direction', '')
        edge_props = getattr(edge, 'properties', {}) or {}
        edge_type_str = type_val(edge.type)

        # 数据边 → 检查是否为 L3 共享数据
        if edge_type_str == "data":
            if self._is_shared_data_edge(edge, graph):
                return CouplingLevel.L3_SHARED_DATA
            return CouplingLevel.L1_PUBLIC_API

        # 结构边 → 基于方向判断
        src_node = graph.get_node(edge.source)
        tgt_node = graph.get_node(edge.target)

        if not src_node or not tgt_node:
            return CouplingLevel.L1_PUBLIC_API

        # 检查 L4 封装穿透（已在 AST 扫描中标记）
        if edge_props.get("is_encapsulation_violation"):
            return CouplingLevel.L4_ENCAPSULATION_VIOLATION

        # 根据目标符号判断访问级别
        tgt_name = tgt_node.name
        tgt_short = tgt_name.split(".")[-1]

        # Python 约定：__ 开头（非 dunder）是严重私有
        if tgt_short.startswith("__") and not tgt_short.endswith("__"):
            return CouplingLevel.L4_ENCAPSULATION_VIOLATION

        # 检查 __all__ 导出列表（如果目标文件有定义）
        tgt_file = file_from_location(tgt_node.location or "")
        exports = self._all_exports_cache.get(tgt_file)
        if exports:
            # 有 __all__ → 按导出列表判定
            if tgt_short in exports:
                return CouplingLevel.L1_PUBLIC_API
            return CouplingLevel.L2_INTERNAL_IMPORT

        # Python 约定：_ 开头的是私有/内部
        if tgt_short.startswith("_"):
            return CouplingLevel.L2_INTERNAL_IMPORT

        # 默认 L1 公开 API
        return CouplingLevel.L1_PUBLIC_API

    @staticmethod
    def _is_shared_data_edge(edge: Edge, graph: Graph) -> bool:
        """判断数据边是否为跨模块的共享数据访问。"""
        src_node = graph.get_node(edge.source)
        tgt_node = graph.get_node(edge.target)

        if not src_node or not tgt_node:
            return False

        # 检查是否多个不同的源节点访问同一介质
        tgt_type_str = type_val(tgt_node.type)
        if tgt_type_str == "medium":
            incoming = graph.incoming_edges(tgt_node.id)
            sources = set()
            for e in incoming:
                if e.source != edge.source:
                    sources.add(e.source)
            return len(sources) > 0

        return False

    # ── 辅助方法：文件级预处理 ──

    def pre_scan_file(self, file_path: str, source: str) -> None:
        """预处理单个文件的 AST 数据（供后续分类使用）。"""
        self._file_source_cache[file_path] = source
        self._all_exports_cache[file_path] = _parse_all_exports(file_path, source)
        self._violations_cache[file_path] = _detect_l4_violations_python(file_path, source)
        self._data_paths_cache[file_path] = _detect_data_paths_python(file_path, source)


def _auto_pre_scan(analyzer: CouplingDepthAnalyzer, graph: Graph) -> None:
    """当调用方未提供 sources 时，从磁盘自动读取源文件进行预扫描。"""
    unique_files: set = set()
    for node in graph.nodes.values():
        fp = file_from_location(node.location or "")
        if fp:
            unique_files.add(fp)

    source_root = graph.source_root or ""
    for fp in unique_files:
        try:
            full_path = os.path.join(source_root, fp) if source_root else fp
            full_path = os.path.abspath(full_path)
            if os.path.isfile(full_path):
                with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                    analyzer.pre_scan_file(fp, f.read())
        except (OSError, UnicodeDecodeError):
            pass


def coupling_depth_report(graph: Graph, file_sources: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """便捷函数：对图运行耦合深度分析并返回报告。

    当 file_sources 为 None 时，自动从磁盘读取图节点涉及的源文件。
    """
    analyzer = CouplingDepthAnalyzer()
    if file_sources:
        for fp, src in file_sources.items():
            analyzer.pre_scan_file(fp, src)
    else:
        _auto_pre_scan(analyzer, graph)
    return analyzer.analyze(graph, file_sources)
