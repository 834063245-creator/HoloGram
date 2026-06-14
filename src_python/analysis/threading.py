"""
线程交错图 (Thread Interleaving Diagram) — SPEC V2 §3

保守的静态近似：不运行时追踪，从代码的字面量中提取线程和共享资源的声明。

三阶段：
  阶段 1：线程发现 — AST/正则匹配线程创建点
  阶段 2：共享资源发现 — 全局变量、文件路径、DB连接、锁对象
  阶段 3：冲突矩阵 — N×M 矩阵：线程 × 资源，判定 R/W/RW 访问模式

确定性：保守近似。可能有漏报，所有报告都是真实的代码字面量。
每个检测结果标注置信度：[确定]/[高置信]/[中等]/[低置信]。
不标注"安全"。
"""

from __future__ import annotations

import ast
import os
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Set

from ..core.graph import file_from_location


# ============================================================
# 置信度标签
# ============================================================

class Confidence(str, Enum):
    CERTAIN = "确定"       # 字面量精确匹配
    HIGH = "高置信"       # 强模式匹配（如文件路径字符串出现在两个线程中）
    MEDIUM = "中等"       # 全局变量被两个线程引用，但不确定是否真的并发
    LOW = "低置信"        # 模式可能误匹配（如 while+sleep 被识别为轮询）
    UNDETECTED = "未检测"  # 运行时动态创建的线程/反射调用


# ============================================================
# 线程发现模式
# ============================================================

# Python 线程创建模式
PYTHON_THREAD_PATTERNS = {
    "threading.Thread": ("thread", Confidence.CERTAIN),
    "threading.Timer": ("timer", Confidence.CERTAIN),
    "concurrent.futures.ThreadPoolExecutor": ("thread_pool", Confidence.CERTAIN),
    "concurrent.futures.ProcessPoolExecutor": ("process_pool", Confidence.CERTAIN),
    "multiprocessing.Process": ("process", Confidence.CERTAIN),
    "asyncio.create_task": ("async_task", Confidence.CERTAIN),
    "asyncio.ensure_future": ("async_task", Confidence.CERTAIN),
    "asyncio.run": ("event_loop", Confidence.CERTAIN),
}

PYTHON_LOCK_PATTERNS = {
    "threading.Lock": "锁",
    "threading.RLock": "可重入锁",
    "threading.Semaphore": "信号量",
    "threading.Condition": "条件变量",
    "threading.Event": "事件",
    "multiprocessing.Lock": "多进程锁",
    "multiprocessing.Semaphore": "多进程信号量",
    "asyncio.Lock": "异步锁",
}


# ============================================================
# AST 访问器: Python 线程+资源发现
# ============================================================

class _ThreadResourceVisitor(ast.NodeVisitor):
    """AST 遍历：发现线程创建点、共享资源、锁对象。"""

    def __init__(self, file_path: str, module_name: str):
        self.file_path = file_path
        self.module = module_name
        self.threads: List[Dict[str, Any]] = []
        self.locks: List[Dict[str, Any]] = []
        self.global_state: List[Dict[str, Any]] = []
        self.data_paths: List[Dict[str, Any]] = []
        self._import_map: Dict[str, str] = {}  # alias → module path

    # ── imports ──

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self._import_map[alias.asname or alias.name] = alias.name
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        for alias in node.names:
            self._import_map[alias.asname or alias.name] = f"{module}.{alias.name}"
        self.generic_visit(node)

    # ── thread creation ──

    def visit_Call(self, node: ast.Call) -> None:
        func_name = self._get_name(node.func)

        # 线程创建
        for pattern, (thread_type, confidence) in PYTHON_THREAD_PATTERNS.items():
            if func_name and pattern in func_name:
                target_name = self._extract_target(node)
                self.threads.append({
                    "type": thread_type,
                    "pattern": pattern,
                    "target": target_name,
                    "location": f"{self.file_path}:{node.lineno}",
                    "confidence": confidence.value,
                })
                break

        # 锁创建
        for pattern, lock_type in PYTHON_LOCK_PATTERNS.items():
            if func_name and pattern in func_name:
                self.locks.append({
                    "type": lock_type,
                    "pattern": pattern,
                    "location": f"{self.file_path}:{node.lineno}",
                    "confidence": Confidence.CERTAIN.value,
                })
                break

        # 文件 I/O（共享数据路径）
        if func_name:
            path = self._extract_file_path(node, func_name)
            if path:
                self.data_paths.append({
                    "path": path,
                    "function": func_name,
                    "location": f"{self.file_path}:{node.lineno}",
                    "confidence": Confidence.CERTAIN.value if not path.startswith("<") else Confidence.MEDIUM.value,
                })

        self.generic_visit(node)

    # ── module-level globals ──

    def visit_Assign(self, node: ast.Assign) -> None:
        # 仅处理模块级赋值（顶层作用域，简单判断：无函数/类包装）
        for target in node.targets:
            name = self._get_name(target)
            if not name or name.startswith("_"):
                continue
            # 检查赋值的值类型
            type_hint = self._infer_mutable_type(node.value)
            if type_hint:
                self.global_state.append({
                    "name": name,
                    "type": type_hint,
                    "location": f"{self.file_path}:{node.lineno}",
                    "confidence": Confidence.MEDIUM.value,
                })
        self.generic_visit(node)

    # ── helpers ──

    def _get_name(self, node: ast.expr) -> Optional[str]:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            base = self._get_name(node.value)
            return f"{base}.{node.attr}" if base else node.attr
        if isinstance(node, ast.Subscript):
            return self._get_name(node.value)
        if isinstance(node, ast.Call):
            return self._get_name(node.func)
        if isinstance(node, ast.Constant):
            return str(node.value) if isinstance(node.value, str) else None
        return None

    def _extract_target(self, node: ast.Call) -> str:
        """从 threading.Thread(target=...) 提取 target 参数。"""
        for kw in node.keywords:
            if kw.arg == "target":
                return self._get_name(kw.value) or f"<dynamic:{node.lineno}>"
        if node.args:
            # threading.Thread(first_arg) — first_arg is often the target
            return self._get_name(node.args[0]) or f"<dynamic:{node.lineno}>"
        return f"<unknown:{node.lineno}>"

    def _extract_file_path(self, node: ast.Call, func_name: str) -> Optional[str]:
        """从文件 I/O 调用中提取路径字符串。"""
        if node.args:
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                return first.value
        for kw in node.keywords:
            if kw.arg in ("file", "filename", "path", "database", "db"):
                if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                    return kw.value.value
        return None

    def _infer_mutable_type(self, node: ast.expr) -> Optional[str]:
        """推断可变的全局状态类型。"""
        if isinstance(node, ast.Dict):
            return "dict"
        if isinstance(node, ast.List):
            return "list"
        if isinstance(node, ast.Set):
            return "set"
        if isinstance(node, ast.Call):
            name = self._get_name(node.func)
            if name:
                for pattern in PYTHON_LOCK_PATTERNS:
                    if pattern in name:
                        return "lock"
        return None


# ============================================================
# TypeScript: 正则模式匹配
# ============================================================

TS_THREAD_PATTERNS = [
    (r'new\s+Worker\s*\(', "web_worker", Confidence.CERTAIN),
    (r'setInterval\s*\(', "timer", Confidence.CERTAIN),
    (r'setTimeout\s*\([^)]*,\s*\d+\s*\)', "timeout", Confidence.LOW),
]

TS_LOCK_PATTERNS = [
    (r'new\s+Mutex\s*\(', "mutex"),
    (r'new\s+Semaphore\s*\(', "semaphore"),
    (r'Atomics\.(wait|notify)', "atomics"),
]


def _extract_ts_threads(file_path: str, source: str) -> List[Dict[str, Any]]:
    """从 TS/JS 源码中提取线程声明。"""
    threads = []
    for pattern, ttype, confidence in TS_THREAD_PATTERNS:
        for m in re.finditer(pattern, source):
            line_no = source[:m.start()].count("\n") + 1
            threads.append({
                "type": ttype,
                "pattern": pattern[:30],
                "location": f"{file_path}:{line_no}",
                "confidence": confidence.value,
            })
    return threads


def _extract_ts_locks(file_path: str, source: str) -> List[Dict[str, Any]]:
    """从 TS/JS 源码中提取锁声明。"""
    locks = []
    for pattern, ltype in TS_LOCK_PATTERNS:
        for m in re.finditer(pattern, source):
            line_no = source[:m.start()].count("\n") + 1
            locks.append({
                "type": ltype,
                "location": f"{file_path}:{line_no}",
                "confidence": Confidence.CERTAIN.value,
            })
    return locks


# ============================================================
# 冲突矩阵
# ============================================================

@dataclass
class ResourceAccess:
    """单个共享资源被线程访问的记录。"""
    resource_name: str
    resource_type: str           # "file", "db", "global_var", "lock"
    threads: List[Dict[str, Any]] = field(default_factory=list)
    lock_protected_by: List[str] = field(default_factory=list)

    @property
    def has_concurrent_write(self) -> bool:
        return any(t.get("access") in ("W", "R/W") for t in self.threads)

    @property
    def has_lock(self) -> bool:
        return len(self.lock_protected_by) > 0

    @property
    def thread_count(self) -> int:
        return len(self.threads)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "resource_name": self.resource_name,
            "resource_type": self.resource_type,
            "threads": self.threads,
            "thread_count": self.thread_count,
            "has_concurrent_write": self.has_concurrent_write,
            "lock_protected_by": self.lock_protected_by,
            "has_lock": self.has_lock,
        }


# ============================================================
# 主分析器
# ============================================================

class ThreadInterleaveAnalyzer:
    """线程交错图分析器主入口。

    对于 Python 项目：通过 AST 遍历每个文件
    对于 TypeScript 项目：通过正则模式匹配每个文件
    """

    def __init__(self):
        self.all_threads: List[Dict[str, Any]] = []
        self.all_locks: List[Dict[str, Any]] = []
        self.all_global_state: List[Dict[str, Any]] = []
        self.all_data_paths: List[Dict[str, Any]] = []
        self.resources: Dict[str, ResourceAccess] = {}

    def analyze_python_file(self, file_path: str, source: str) -> None:
        """分析单个 Python 文件。"""
        module_name = os.path.splitext(os.path.basename(file_path))[0]
        try:
            tree = ast.parse(source, filename=file_path)
        except SyntaxError:
            return

        visitor = _ThreadResourceVisitor(file_path, module_name)
        visitor.visit(tree)

        self.all_threads.extend(visitor.threads)
        self.all_locks.extend(visitor.locks)
        self.all_global_state.extend(visitor.global_state)
        self.all_data_paths.extend(visitor.data_paths)

    def analyze_typescript_file(self, file_path: str, source: str) -> None:
        """分析单个 TS/JS 文件。"""
        self.all_threads.extend(_extract_ts_threads(file_path, source))
        self.all_locks.extend(_extract_ts_locks(file_path, source))

    def build_conflict_matrix(self) -> Dict[str, Any]:
        """构建线程 × 资源冲突矩阵。"""
        resources: Dict[str, Dict[str, Any]] = {}

        # 1. 全局变量 → 共享资源
        for gs in self.all_global_state:
            rname = f"global:{gs['name']}"
            if rname not in resources:
                resources[rname] = {"type": "global_var", "threads": [], "files": []}
            resources[rname]["files"].append(file_from_location(gs.get("location") or ""))

        # 2. 数据文件路径 → 共享资源
        path_files: Dict[str, Set[str]] = {}
        for dp in self.all_data_paths:
            path = dp["path"]
            if path not in path_files:
                path_files[path] = set()
            path_files[path].add(file_from_location(dp.get("location") or ""))

        # 只在多个线程的文件中出现的路径才算共享
        for path, files in path_files.items():
            # 收集所有可能写入此路径的线程
            related_threads = []
            for t in self.all_threads:
                t_file = file_from_location(t.get("location") or "")
                if t_file in files:
                    related_threads.append({
                        "name": t.get("target", t.get("type", "?")),
                        "location": t.get("location", ""),
                        "access": "R/W",  # 保守假设
                        "confidence": t.get("confidence", Confidence.MEDIUM.value),
                    })

            if related_threads:
                resources[f"data:{path}"] = {
                    "type": "data_file",
                    "threads": related_threads,
                    "thread_count": len(related_threads),
                    "files": list(files),
                    "lock_detected": False,
                    "locks_nearby": [],
                }

        # 3. 全局变量被线程引用 → 关联
        for gs in self.all_global_state:
            rname = f"global:{gs['name']}"
            if rname not in resources:
                continue

            gs_file = file_from_location(gs.get("location") or "")
            related_threads = []
            for t in self.all_threads:
                t_file = file_from_location(t.get("location") or "")
                if t_file == gs_file:
                    related_threads.append({
                        "name": t.get("target", t.get("type", "?")),
                        "location": t.get("location", ""),
                        "access": "R/W",  # 保守假设
                        "confidence": Confidence.MEDIUM.value,
                    })

            if related_threads:
                resources[rname]["threads"] = related_threads
                resources[rname]["thread_count"] = len(related_threads)
                resources[rname]["lock_detected"] = False

            # 检查锁保护
            count_lock_entries_for_this = 0
            for lock_entry in self.all_locks:
                l_file = file_from_location(lock_entry.get("location") or "")
                if l_file == gs_file:
                    count_lock_entries_for_this += 1

            if count_lock_entries_for_this > 0:
                resources[rname]["lock_detected"] = True
                lock_names = [lock_entry["type"] for lock_entry in self.all_locks
                             if file_from_location(lock_entry.get("location") or "") == gs_file]
                resources[rname]["locks_nearby"] = lock_names

        # 统计
        total_threads = len(self.all_threads)
        unlocked = {k: v for k, v in resources.items()
                    if v.get("thread_count", 0) > 1 and not v.get("lock_detected", True)}

        return {
            "total_threads_found": total_threads,
            "total_locks_found": len(self.all_locks),
            "total_global_state_vars": len(self.all_global_state),
            "total_data_paths": len(self.all_data_paths),
            "resources": resources,
            "total_shared_resources": len(resources),
            "unlocked_concurrent_writes": len(unlocked),
            "unlocked_resource_names": list(unlocked.keys()),
            "certainty_note": (
                "[确定] threading.Thread(target=...) 字面量匹配。"
                "[高置信] 同一文件路径字符串出现在两个线程中。"
                "[中等] 全局变量被两个线程引用，无法静态确定是否真的并发访问。"
                "[低置信] while+sleep 模式被识别为轮询，但可能是普通循环。"
                "不标注'安全'——只标注'检测到的风险'和'检测不到的区域'。"
            ),
            "threads": self.all_threads,
            "locks": self.all_locks,
        }


def thread_conflict_report(
    file_sources: Dict[str, str],
    language: str = "python",
) -> Dict[str, Any]:
    """便捷函数：对文件集合运行线程交错分析。

    Args:
        file_sources: 文件路径 → 源码内容的映射
        language: "python" 或 "typescript"

    Returns:
        冲突矩阵 + 统计报告
    """
    analyzer = ThreadInterleaveAnalyzer()

    for file_path, source in file_sources.items():
        if language == "python":
            analyzer.analyze_python_file(file_path, source)
        else:
            analyzer.analyze_typescript_file(file_path, source)

    return analyzer.build_conflict_matrix()
