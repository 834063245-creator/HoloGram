"""
TypeScript / JavaScript 语言适配器。

使用正则模式匹配提取符号、介质、时间节点及边。
覆盖 80% 常见模式——与 Python 适配器同样的设计理念：
  - 无状态、单个文件分析
  - 不符合模式的边缘 case 静默跳过
  - 不阻断管线执行
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional, Set

from .base import LanguageAdapter, AdapterResult
from ..core.graph import (
    Graph, Node, Edge,
    NodeType, EdgeType,
    SymbolKind, MediumKind, TemporalKind,
    StructuralDirection, TemporalDirection,
)


class TypeScriptAdapter(LanguageAdapter):
    """TypeScript/JavaScript 代码分析适配器。"""

    language = "typescript"
    file_extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

    # ── 关键词排除列表 ──────────────────────────────────

    _KEYWORDS: Set[str] = {
        "if", "else", "for", "while", "do", "switch", "case", "break",
        "continue", "return", "throw", "try", "catch", "finally",
        "new", "delete", "typeof", "instanceof", "void", "this",
        "super", "class", "function", "var", "let", "const", "import",
        "export", "default", "from", "as", "async", "await", "yield",
        "true", "false", "null", "undefined", "require", "module",
        "public", "private", "protected", "static", "readonly",
        "abstract", "implements", "extends", "interface", "type",
        "enum", "namespace", "declare",
        "console", "window", "document", "process", "global",
        "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        "fetch", "JSON", "Math", "Date", "Array", "Object", "Map",
        "Set", "Promise", "Error", "RegExp",
        "parseInt", "parseFloat", "toString", "valueOf",
    }

    # ── Phase 1: 符号提取 + 结构边 ──────────────────────

    def extract_symbols(self, file_path: str, source: str) -> AdapterResult:
        result = AdapterResult(file_path=file_path)

        module_name = Path(file_path).stem
        module_node = Node(
            id=Node.make_id(),
            type=NodeType.SYMBOL,
            name=module_name,
            location=file_path,
            language="typescript",
            kind=SymbolKind.MODULE.value,
            properties={"is_root": True},
        )
        result.nodes.append(module_node)

        # 按行索引
        lines = source.split("\n")

        # ── 函数 ──
        func_patterns = [
            r'(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(',
            r'(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(',
            r'(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function',
        ]
        seen: Set[str] = set()
        for pattern in func_patterns:
            for m in re.finditer(pattern, source, re.MULTILINE):
                name = m.group(1)
                if name in seen or name in self._KEYWORDS:
                    continue
                seen.add(name)
                line_no = source[:m.start()].count("\n") + 1
                result.nodes.append(Node(
                    id=Node.make_id(),
                    type=NodeType.SYMBOL,
                    name=name,
                    location=f"{file_path}:{line_no}",
                    language="typescript",
                    kind=SymbolKind.FUNCTION.value,
                ))

        # ── 类 ──
        for m in re.finditer(r'(?:export\s+)?(?:abstract\s+)?class\s+(\w+)', source):
            name = m.group(1)
            if name in self._KEYWORDS:
                continue
            line_no = source[:m.start()].count("\n") + 1
            result.nodes.append(Node(
                id=Node.make_id(),
                type=NodeType.SYMBOL,
                name=name,
                location=f"{file_path}:{line_no}",
                language="typescript",
                kind=SymbolKind.CLASS.value,
            ))

        # ── 接口 ──
        for m in re.finditer(r'(?:export\s+)?interface\s+(\w+)', source):
            name = m.group(1)
            line_no = source[:m.start()].count("\n") + 1
            result.nodes.append(Node(
                id=Node.make_id(),
                type=NodeType.SYMBOL,
                name=name,
                location=f"{file_path}:{line_no}",
                language="typescript",
                kind=SymbolKind.INTERFACE.value,
            ))

        # ── 常量 / 枚举 ──
        for m in re.finditer(r'(?:export\s+)?const\s+([A-Z][A-Z_0-9]+)\s*=', source):
            name = m.group(1)
            line_no = source[:m.start()].count("\n") + 1
            result.nodes.append(Node(
                id=Node.make_id(),
                type=NodeType.SYMBOL,
                name=name,
                location=f"{file_path}:{line_no}",
                language="typescript",
                kind=SymbolKind.CONSTANT.value,
            ))

        for m in re.finditer(r'(?:export\s+)?enum\s+(\w+)', source):
            name = m.group(1)
            line_no = source[:m.start()].count("\n") + 1
            result.nodes.append(Node(
                id=Node.make_id(),
                type=NodeType.SYMBOL,
                name=name,
                location=f"{file_path}:{line_no}",
                language="typescript",
                kind=SymbolKind.CONSTANT.value,
            ))

        # ── 结构边 ──
        node_map = {n.name: n.id for n in result.nodes}

        # import 边: import { X } from '...'  → 引用被导入的符号
        for m in re.finditer(r'import\s+\{?\s*(\w+(?:\s*,\s*\w+)*)\s*\}?\s*from', source):
            imported_names = re.findall(r'\w+', m.group(1))
            line_no = source[:m.start()].count("\n") + 1
            for name in imported_names:
                if name in node_map:
                    result.edges.append(Edge(
                        id=Edge.make_id(),
                        type=EdgeType.STRUCTURAL,
                        direction=StructuralDirection.IMPORT.value,
                        source=module_node.id,
                        target=node_map[name],
                        properties={"location": f"{file_path}:{line_no}"},
                    ))

        # extends 边: class A extends B
        for m in re.finditer(r'class\s+(\w+)\s+extends\s+(\w+)', source):
            cls_name, parent = m.group(1), m.group(2)
            if cls_name in node_map and parent in node_map:
                line_no = source[:m.start()].count("\n") + 1
                result.edges.append(Edge(
                    id=Edge.make_id(),
                    type=EdgeType.STRUCTURAL,
                    direction=StructuralDirection.INHERIT.value,
                    source=node_map[cls_name],
                    target=node_map[parent],
                    properties={"location": f"{file_path}:{line_no}"},
                ))

        # implements 边: class A implements I1, I2
        for m in re.finditer(r'class\s+(\w+)\s+implements\s+(\w+(?:\s*,\s*\w+)*)', source):
            cls_name = m.group(1)
            iface_str = m.group(2)
            line_no = source[:m.start()].count("\n") + 1
            for iface in re.findall(r'\w+', iface_str):
                if cls_name in node_map and iface in node_map:
                    result.edges.append(Edge(
                        id=Edge.make_id(),
                        type=EdgeType.STRUCTURAL,
                        direction=StructuralDirection.IMPLEMENT.value,
                        source=node_map[cls_name],
                        target=node_map[iface],
                        properties={"location": f"{file_path}:{line_no}"},
                    ))

        # 调用边: 每个函数内调用其他已知函数
        for i, line in enumerate(lines, 1):
            for m in re.finditer(r'(?<!")(?<![\'`])\b(\w+)\s*\(', line):
                called = m.group(1)
                if called in node_map and called not in self._KEYWORDS:
                    # 找到包含此调用的最内层函数
                    caller = self._find_enclosing(result.nodes, file_path, i)
                    if caller and caller.id != node_map[called]:
                        result.edges.append(Edge(
                            id=Edge.make_id(),
                            type=EdgeType.STRUCTURAL,
                            direction=StructuralDirection.CALL.value,
                            source=caller.id,
                            target=node_map[called],
                            properties={"location": f"{file_path}:{i}"},
                        ))

        return result

    # ── Phase 2: 介质提取 + 数据边 ──────────────────────

    def extract_media(self, file_path: str, source: str, graph: Graph) -> AdapterResult:
        result = AdapterResult(file_path=file_path)

        # fetch / HTTP
        for m in re.finditer(r'fetch\s*\(\s*["\'`]([^"\'`]+)', source):
            uri = m.group(1)
            medium = Node(
                id=Node.make_id(),
                type=NodeType.MEDIUM,
                name=f"HTTP {uri}",
                location=file_path,
                language="typescript",
                kind=MediumKind.NETWORK.value,
                properties={"uri": uri},
            )
            result.nodes.append(medium)

        # fs.readFile / fs.writeFile / fs.readFileSync / fs.writeFileSync
        for m in re.finditer(r'(?:readFile|writeFile|readFileSync|writeFileSync)\s*\(\s*["\'`]([^"\'`]+)', source):
            fp = m.group(1)
            medium = Node(
                id=Node.make_id(),
                type=NodeType.MEDIUM,
                name=Path(fp).name,
                location=file_path,
                language="typescript",
                kind=MediumKind.FILE.value,
                properties={"uri": fp},
            )
            result.nodes.append(medium)

        # localStorage / sessionStorage
        for m in re.finditer(r'(?:localStorage|sessionStorage)\.(get|set)Item\s*\(\s*["\'`]([^"\'`]+)', source):
            key = m.group(2)
            medium = Node(
                id=Node.make_id(),
                type=NodeType.MEDIUM,
                name=f"storage:{key}",
                location=file_path,
                language="typescript",
                kind=MediumKind.CACHE.value,
                properties={"uri": f"localStorage:{key}"},
            )
            result.nodes.append(medium)

        # 数据库操作模式 — 先剥离注释避免误报
        source_no_comments = re.sub(r'//[^\n]*', ' ', source)        # 单行注释
        source_no_comments = re.sub(r'/\*.*?\*/', ' ', source_no_comments, flags=re.DOTALL)  # 块注释
        db_patterns = [r'\.query\s*\(', r'\.execute\s*\(', r'\.find\s*\(', r'\.findOne\s*\(',
                        r'\.findMany\s*\(', r'\.create\s*\(', r'\.insert\s*\(', r'\.delete\s*\(']
        for pattern in db_patterns:
            if re.search(pattern, source_no_comments):
                medium = Node(
                    id=Node.make_id(),
                    type=NodeType.MEDIUM,
                    name=f"db@{Path(file_path).stem}",
                    location=file_path,
                    language="typescript",
                    kind=MediumKind.DATABASE.value,
                    properties={"uri": file_path},
                )
                result.nodes.append(medium)
                break  # 一个文件一个 DB 介质节点

        return result

    # ── Phase 3: 时间提取 + 时间边 ──────────────────────

    def extract_temporal(self, file_path: str, source: str, graph: Graph) -> AdapterResult:
        result = AdapterResult(file_path=file_path)

        # setInterval(fn, delay)
        for m in re.finditer(r'setInterval\s*\(\s*(\w+)\s*,\s*(\d+)', source):
            callback = m.group(1)
            delay_ms = int(m.group(2))
            temporal = Node(
                id=Node.make_id(),
                type=NodeType.TEMPORAL,
                name=f"interval:{callback}",
                location=file_path,
                language="typescript",
                kind=TemporalKind.TIMER.value,
                properties={"interval_sec": delay_ms / 1000, "is_daemon": True},
            )
            result.nodes.append(temporal)

        # setTimeout(fn, delay)
        for m in re.finditer(r'setTimeout\s*\(\s*(\w+)\s*,\s*(\d+)', source):
            callback = m.group(1)
            delay_ms = int(m.group(2))
            temporal = Node(
                id=Node.make_id(),
                type=NodeType.TEMPORAL,
                name=f"timeout:{callback}",
                location=file_path,
                language="typescript",
                kind=TemporalKind.TIMER.value,
                properties={"interval_sec": delay_ms / 1000, "is_daemon": False},
            )
            result.nodes.append(temporal)

        # 连接时间边：callback → interval/timeout
        for sym_node in graph.nodes.values():
            if sym_node.language == "typescript":
                for tmp_node in result.nodes:
                    match = re.match(r'(?:interval|timeout):(\w+)', tmp_node.name)
                    if match and match.group(1) == sym_node.name:
                        result.edges.append(Edge(
                            id=Edge.make_id(),
                            type=EdgeType.TEMPORAL,
                            direction=TemporalDirection.EXECUTES_ON.value,
                            source=sym_node.id,
                            target=tmp_node.id,
                            properties={"temporal_delay_sec": tmp_node.properties.get("interval_sec")},
                        ))

        return result

    # ── 辅助 ────────────────────────────────────────────

    def _find_enclosing(self, nodes: List[Node], path: str, target_line: int) -> Optional[Node]:
        """找到包含 target_line 的最内层函数或类节点。"""
        best: Optional[Node] = None
        best_line = 0
        for n in nodes:
            if n.kind not in (SymbolKind.FUNCTION.value, SymbolKind.CLASS.value):
                continue
            if not n.location or not n.location.startswith(path):
                continue
            try:
                n_line = int(n.location.rsplit(":", 1)[-1])
            except (ValueError, IndexError):
                continue
            if n_line <= target_line and n_line > best_line:
                best = n
                best_line = n_line
        return best
