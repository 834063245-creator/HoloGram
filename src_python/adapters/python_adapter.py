"""
Python AST 适配器：从 Python 源码中提取符号节点、介质节点、时间节点，
以及它们之间的结构边、数据边、时间边。
"""

from __future__ import annotations

import ast
import os
import threading
from typing import Any, Dict, List, Optional, Set, Tuple

from .base import LanguageAdapter, AdapterResult
from ..core.graph import (
    Graph, Node, Edge, NodeType, EdgeType,
    SymbolKind, MediumKind, TemporalKind,
    StructuralDirection, DataDirection, TemporalDirection,
)


class PythonAdapter(LanguageAdapter):
    language = "python"
    file_extensions = [".py"]

    # ── Parse-once cache ─────────────────────────────────────

    def analyze(self, file_path: str, source: str, graph: Optional[Graph] = None) -> AdapterResult:
        """Override base to parse AST once, reuse across all three phases."""
        try:
            self._cached_ast = ast.parse(source, filename=file_path)
        except SyntaxError:
            self._cached_ast = None  # let extractors handle error reporting
        try:
            return super().analyze(file_path, source, graph)
        finally:
            self._cached_ast = None

    def _get_ast(self, file_path: str, source: str):
        """Return cached AST if available (inside analyze()), else parse."""
        cached = getattr(self, '_cached_ast', None)
        if cached is not None:
            return cached
        return ast.parse(source, filename=file_path)

    # --------------------------------------------------------
    # Phase 1: 符号提取 + 结构边
    # --------------------------------------------------------

    def extract_symbols(self, file_path: str, source: str) -> AdapterResult:
        result = AdapterResult(file_path=file_path)

        try:
            tree = self._get_ast(file_path, source)
        except SyntaxError as e:
            result.errors.append(f"Syntax error in {file_path}: {e}")
            return result

        module_name = self._module_name(file_path)
        module_node = Node(
            id=Node.make_id(),
            type=NodeType.SYMBOL,
            name=module_name,
            location=file_path,
            language="python",
            kind=SymbolKind.MODULE.value,
            properties={"is_root": True},
        )
        result.nodes.append(module_node)

        visitor = _SymbolVisitor(file_path, module_node.id)
        visitor.visit(tree)

        result.nodes.extend(visitor.nodes)
        result.edges.extend(visitor.edges)
        result.warnings.extend(visitor.warnings)

        return result

    # --------------------------------------------------------
    # Phase 2: 介质提取 + 数据边
    # --------------------------------------------------------

    def extract_media(self, file_path: str, source: str, graph: Graph) -> AdapterResult:
        result = AdapterResult(file_path=file_path)

        try:
            tree = self._get_ast(file_path, source)
        except SyntaxError:
            return result

        visitor = _MediaVisitor(file_path, graph)
        visitor.visit(tree)

        result.nodes.extend(visitor.nodes)
        result.edges.extend(visitor.edges)
        result.warnings.extend(visitor.warnings)

        return result

    # --------------------------------------------------------
    # Phase 3: 时间提取 + 时间边
    # --------------------------------------------------------

    def extract_temporal(self, file_path: str, source: str, graph: Graph) -> AdapterResult:
        result = AdapterResult(file_path=file_path)

        try:
            tree = ast.parse(source, filename=file_path)
        except SyntaxError:
            return result

        visitor = _TemporalVisitor(file_path, graph)
        visitor.visit(tree)

        result.nodes.extend(visitor.nodes)
        result.edges.extend(visitor.edges)
        result.warnings.extend(visitor.warnings)

        return result

    # --------------------------------------------------------
    # helpers
    # --------------------------------------------------------

    @staticmethod
    def _module_name(file_path: str) -> str:
        """从文件路径推导模块名。"""
        name = os.path.splitext(os.path.basename(file_path))[0]
        if name == "__init__":
            return os.path.basename(os.path.dirname(file_path))
        return name


# ============================================================
# AST Visitor: 符号节点 + 结构边
# ============================================================

class _SymbolVisitor(ast.NodeVisitor):
    """遍历 AST，提取符号节点和结构边。"""

    def __init__(self, file_path: str, module_id: str):
        self.file_path = file_path
        self.module_id = module_id
        self.nodes: List[Node] = []
        self.edges: List[Edge] = []
        self.warnings: List[str] = []
        self._current_class: Optional[str] = None     # 当前在哪个 class 内
        self._scope_stack: List[str] = [module_id]    # 作用域栈
        self._import_map: Dict[str, str] = {}          # alias -> module path
        self._local_symbols: Dict[str, str] = {}       # short_name → node_id (本文件内)

    # -- helpers --

    def _make_node(self, name: str, kind: SymbolKind, lineno: int, **props) -> Node:
        node = Node(
            id=Node.make_id(),
            type=NodeType.SYMBOL,
            name=name,
            location=f"{self.file_path}:{lineno}",
            language="python",
            kind=kind.value,
            properties=props,
        )
        self.nodes.append(node)
        # 注册到本地符号表
        short = name.split(".")[-1]
        self._local_symbols[short] = node.id
        return node

    def _make_edge(self, src: str, tgt: str, direction: StructuralDirection) -> None:
        self.edges.append(Edge(
            id=Edge.make_id(),
            type=EdgeType.STRUCTURAL,
            direction=direction.value,
            source=src,
            target=tgt,
        ))

    def _full_name(self, name: str) -> str:
        if self._current_class:
            return f"{self._current_class}.{name}"
        return name

    # -- top-level --

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        is_method = self._current_class is not None
        kind = SymbolKind.FUNCTION
        full_name = self._full_name(node.name)
        fn_node = self._make_node(full_name, kind, node.lineno,
                                  is_method=is_method,
                                  decorators=[self._decorator_name(d) for d in node.decorator_list])

        self._make_edge(fn_node.id, self._scope_stack[-1], StructuralDirection.IMPORT)

        prev_class = self._current_class
        self._current_class = None
        self._scope_stack.append(fn_node.id)

        self.generic_visit(node)

        self._scope_stack.pop()
        self._current_class = prev_class

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        fn_node = self._make_node(
            self._full_name(node.name), SymbolKind.FUNCTION, node.lineno,
            is_async=True, is_method=self._current_class is not None,
            decorators=[self._decorator_name(d) for d in node.decorator_list],
        )
        self._make_edge(fn_node.id, self._scope_stack[-1], StructuralDirection.IMPORT)

        prev_class = self._current_class
        self._current_class = None
        self._scope_stack.append(fn_node.id)
        self.generic_visit(node)
        self._scope_stack.pop()
        self._current_class = prev_class

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        full_name = self._full_name(node.name)
        cls_node = self._make_node(full_name, SymbolKind.CLASS, node.lineno,
                                   bases=[self._name_of(b) for b in node.bases],
                                   decorators=[self._decorator_name(d) for d in node.decorator_list])

        self._make_edge(cls_node.id, self._scope_stack[-1], StructuralDirection.IMPORT)

        # 继承关系在 merger 中基于名称解析

        prev_class = self._current_class
        self._current_class = full_name
        self._scope_stack.append(cls_node.id)
        self.generic_visit(node)
        self._scope_stack.pop()
        self._current_class = prev_class

    # -- assignments --

    def visit_Assign(self, node: ast.Assign) -> None:
        # 模块级常量/变量
        if self._scope_stack[-1] == self.module_id or (
            len(self._scope_stack) == 2 and self._scope_stack[0] == self.module_id
        ):
            for target in node.targets:
                name = self._name_of(target)
                if name and name.isupper():
                    self._make_node(name, SymbolKind.CONSTANT, node.lineno)
                elif name and not name.startswith("_"):
                    self._make_node(name, SymbolKind.VARIABLE, node.lineno)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if self._scope_stack[-1] == self.module_id or len(self._scope_stack) == 1:
            name = self._name_of(node.target) if node.target else None
            if name and name.isupper():
                self._make_node(name, SymbolKind.CONSTANT, node.lineno)
            elif name and not name.startswith("_"):
                self._make_node(name, SymbolKind.VARIABLE, node.lineno)
        self.generic_visit(node)

    # -- imports --

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            module_path = alias.name
            local_name = alias.asname or alias.name
            self._import_map[local_name] = module_path
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        for alias in node.names:
            full_path = f"{module}.{alias.name}" if module else alias.name
            local_name = alias.asname or alias.name
            self._import_map[local_name] = full_path
        self.generic_visit(node)

    # -- calls --

    def visit_Call(self, node: ast.Call) -> None:
        caller_id = self._scope_stack[-1] if len(self._scope_stack) > 1 else self.module_id
        callee_name = self._name_of(node.func)

        if callee_name:
            short = callee_name.split(".")[-1]
            # 在本文件符号表中查找
            if short in self._local_symbols:
                self._make_edge(caller_id, self._local_symbols[short], StructuralDirection.CALL)
            else:
                # 跨模块调用——记录引用，在跨文件解析阶段补全
                # 如果是从 import 来的短名，解析为全限定名
                full_ref = self._import_map.get(short, callee_name)
                for n in self.nodes:
                    if n.id == caller_id:
                        calls = n.properties.setdefault("calls", [])
                        if full_ref not in calls:
                            calls.append(full_ref)
                        break

        self.generic_visit(node)

    # -- helpers --

    @staticmethod
    def _decorator_name(node: ast.expr) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return f"{_SymbolVisitor._name_of(node.value)}.{node.attr}" if _SymbolVisitor._name_of(node.value) else node.attr
        if isinstance(node, ast.Call):
            return _SymbolVisitor._decorator_name(node.func)
        return "?"

    @staticmethod
    def _name_of(node: ast.expr) -> Optional[str]:
        """从 AST 表达式提取可读名称。"""
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            base = _SymbolVisitor._name_of(node.value)
            return f"{base}.{node.attr}" if base else node.attr
        if isinstance(node, ast.Subscript):
            return _SymbolVisitor._name_of(node.value)
        if isinstance(node, ast.Call):
            return _SymbolVisitor._name_of(node.func)
        if isinstance(node, ast.Constant):
            return str(node.value) if isinstance(node.value, str) else None
        if isinstance(node, ast.Starred):
            return _SymbolVisitor._name_of(node.value)
        if isinstance(node, ast.Lambda):
            return "<lambda>"
        return None


# ============================================================
# AST Visitor: 介质节点 + 数据边
# ============================================================

class _MediaVisitor(ast.NodeVisitor):
    """识别 I/O 模式，提取介质节点和数据边。"""

    # 常见 I/O 函数签名 (模块, 函数名, 介质类型, 数据方向)
    IO_PATTERNS: List[Tuple[str, str, MediumKind, DataDirection]] = [
        # 文件 I/O
        ("builtins.open", "open", MediumKind.FILE, DataDirection.READ),
        ("pathlib.Path.read_text", "read_text", MediumKind.FILE, DataDirection.READ),
        ("pathlib.Path.write_text", "write_text", MediumKind.FILE, DataDirection.WRITE),
        # JSON
        ("json.load", "load", MediumKind.FILE, DataDirection.READ),
        ("json.dump", "dump", MediumKind.FILE, DataDirection.WRITE),
        # pickle
        ("pickle.load", "load", MediumKind.FILE, DataDirection.READ),
        ("pickle.dump", "dump", MediumKind.FILE, DataDirection.WRITE),
        # CSV
        ("csv.reader", "reader", MediumKind.FILE, DataDirection.READ),
        ("csv.writer", "writer", MediumKind.FILE, DataDirection.WRITE),
        # 数据库 (sqlite3)
        ("sqlite3.connect", "connect", MediumKind.DATABASE, DataDirection.READ),
        ("sqlite3.Cursor.execute", "execute", MediumKind.DATABASE, DataDirection.WRITE),
        ("sqlite3.Cursor.executemany", "executemany", MediumKind.DATABASE, DataDirection.WRITE),
        # 数据库 (SQLAlchemy)
        ("sqlalchemy.create_engine", "create_engine", MediumKind.DATABASE, DataDirection.READ),
        ("sqlalchemy.orm.Session.query", "query", MediumKind.DATABASE, DataDirection.READ),
        ("sqlalchemy.orm.Session.add", "add", MediumKind.DATABASE, DataDirection.WRITE),
        ("sqlalchemy.orm.Session.commit", "commit", MediumKind.DATABASE, DataDirection.WRITE),
        # Redis
        ("redis.Redis.get", "get", MediumKind.CACHE, DataDirection.READ),
        ("redis.Redis.set", "set", MediumKind.CACHE, DataDirection.WRITE),
        ("redis.Redis.publish", "publish", MediumKind.QUEUE, DataDirection.WRITE),
        ("redis.Redis.subscribe", "subscribe", MediumKind.QUEUE, DataDirection.SUBSCRIBE),
        # 消息队列 (Kafka)
        ("kafka.KafkaProducer.send", "send", MediumKind.QUEUE, DataDirection.WRITE),
        ("kafka.KafkaConsumer", "KafkaConsumer", MediumKind.QUEUE, DataDirection.SUBSCRIBE),
        # 消息队列 (RabbitMQ / pika)
        ("pika.BlockingConnection", "BlockingConnection", MediumKind.QUEUE, DataDirection.READ),
        ("pika.channel.Channel.basic_publish", "basic_publish", MediumKind.QUEUE, DataDirection.WRITE),
        ("pika.channel.Channel.basic_consume", "basic_consume", MediumKind.QUEUE, DataDirection.SUBSCRIBE),
        # HTTP 客户端
        ("requests.get", "get", MediumKind.NETWORK, DataDirection.READ),
        ("requests.post", "post", MediumKind.NETWORK, DataDirection.WRITE),
        ("requests.put", "put", MediumKind.NETWORK, DataDirection.WRITE),
        ("requests.delete", "delete", MediumKind.NETWORK, DataDirection.WRITE),
        ("httpx.get", "get", MediumKind.NETWORK, DataDirection.READ),
        ("httpx.post", "post", MediumKind.NETWORK, DataDirection.WRITE),
        # HTTP 服务端
        ("flask.Flask.route", "route", MediumKind.NETWORK, DataDirection.READ),
        ("fastapi.FastAPI.get", "get", MediumKind.NETWORK, DataDirection.READ),
        ("fastapi.FastAPI.post", "post", MediumKind.NETWORK, DataDirection.READ),
        # 环境变量 / 配置
        ("os.getenv", "getenv", MediumKind.FILE, DataDirection.READ),
        ("os.environ.get", "get", MediumKind.FILE, DataDirection.READ),
        # 共享内存 / 同步原语
        ("multiprocessing.Queue", "Queue", MediumKind.QUEUE, DataDirection.READ),
        ("multiprocessing.Pipe", "Pipe", MediumKind.SHARED_MEMORY, DataDirection.READ),
        ("threading.Lock", "Lock", MediumKind.SHARED_MEMORY, DataDirection.READ),
        ("threading.Semaphore", "Semaphore", MediumKind.SHARED_MEMORY, DataDirection.READ),
    ]

    # 过于通用的动词，只按全限定名匹配，不按短名匹配
    _GENERIC_VERBS: Set[str] = {
        "get", "set", "execute", "executemany", "commit", "add", "query",
        "read", "write", "send", "post", "put", "delete", "route",
        "load", "dump", "reader", "writer", "connect",
        "publish", "subscribe", "basic_publish", "basic_consume",
        "getenv", "create_engine", "KafkaConsumer", "BlockingConnection",
        "Queue", "Pipe", "Lock", "Semaphore",
    }

    # 快速查找索引
    IO_INDEX: Dict[str, List[Tuple[MediumKind, DataDirection]]] = {}
    _index_built = False
    _index_lock = threading.Lock()

    @classmethod
    def _build_index(cls) -> None:
        if cls._index_built:
            return
        with cls._index_lock:
            if cls._index_built:
                return
            for module_func, func, kind, direction in cls.IO_PATTERNS:
                # 全限定名始终索引
                cls.IO_INDEX.setdefault(module_func, []).append((kind, direction))
                # 短名仅对非通用动词索引
                if func not in cls._GENERIC_VERBS:
                    cls.IO_INDEX.setdefault(func, []).append((kind, direction))
            cls._index_built = True

    def __init__(self, file_path: str, graph: Graph):
        _MediaVisitor._build_index()
        self.file_path = file_path
        self.graph = graph
        self.nodes: List[Node] = []
        self.edges: List[Edge] = []
        self.warnings: List[str] = []
        self._file_nodes: Dict[str, Node] = {}   # 文件节点 → 介质节点
        self._medium_cache: Dict[str, Node] = {}  # 介质名 → 介质节点

    def visit_Call(self, node: ast.Call) -> None:
        func_name = _SymbolVisitor._name_of(node.func)
        if func_name and func_name in self.IO_INDEX:
            for kind, direction in self.IO_INDEX[func_name]:
                medium_name = self._extract_medium_name(node, func_name)
                medium_node = self._get_or_create_medium(medium_name, kind)

                # 找到当前所在的符号节点
                caller_node = self._find_enclosing_symbol(node)
                if caller_node:
                    self.edges.append(Edge(
                        id=Edge.make_id(),
                        type=EdgeType.DATA,
                        direction=direction.value,
                        source=caller_node.id,
                        target=medium_node.id,
                        medium_node_id=medium_node.id,
                    ))

        self.generic_visit(node)

    def _extract_medium_name(self, node: ast.Call, func_name: str) -> str:
        """从调用中提取介质标识（文件名、URL、DB 连接字符串等）。"""
        if node.args:
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                return first.value
            if isinstance(first, ast.JoinedStr):
                # f-string：无法静态确定，标注为动态
                return f"<dynamic_fstring:{func_name}>"
            name = _SymbolVisitor._name_of(first)
            if name:
                return f"<var:{name}>"
        for kw in node.keywords:
            if kw.arg in ("file", "filename", "path", "url", "host", "database", "db"):
                if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                    return kw.value.value
        return f"<unknown:{func_name}:{node.lineno}>"

    def _get_or_create_medium(self, name: str, kind: MediumKind) -> Node:
        cache_key = f"{kind.value}:{name}"
        if cache_key in self._medium_cache:
            return self._medium_cache[cache_key]

        node = Node(
            id=Node.make_id(),
            type=NodeType.MEDIUM,
            name=name,
            location=f"{self.file_path}:0",
            language="python",
            kind=kind.value,
            properties={"source": "static_analysis", "confidence": "medium"},
        )
        self.nodes.append(node)
        self._medium_cache[cache_key] = node
        return node

    def _find_enclosing_symbol(self, node: ast.AST) -> Optional[Node]:
        """在当前图中查找包含此 AST 节点的符号节点。"""
        # 用 lineno 匹配：找本文件中 lineno 最接近的符号
        candidates = [
            n for n in self.graph.nodes.values()
            if n.location.startswith(self.file_path) and n.type == NodeType.SYMBOL
        ]
        # 简单策略：返回文件中最后一个定义的函数
        if candidates:
            # 返回最近的一个
            for n in reversed(candidates):
                try:
                    loc_lineno = int(n.location.rsplit(":", 1)[-1])
                    if loc_lineno <= getattr(node, "lineno", float("inf")):
                        return n
                except (ValueError, IndexError):
                    pass
            return candidates[-1]
        return None


# ============================================================
# AST Visitor: 时间节点 + 时间边
# ============================================================

class _TemporalVisitor(ast.NodeVisitor):
    """识别并发/调度模式，提取时间节点和时间边。"""

    THREAD_PATTERNS = {
        "threading.Thread": TemporalKind.THREAD,
        "threading.Timer": TemporalKind.TIMER,
        "concurrent.futures.ThreadPoolExecutor": TemporalKind.THREAD,
        "concurrent.futures.ProcessPoolExecutor": TemporalKind.THREAD,
        "multiprocessing.Process": TemporalKind.THREAD,
    }

    ASYNC_PATTERNS = {
        "asyncio.create_task": TemporalKind.EVENT_LOOP,
        "asyncio.ensure_future": TemporalKind.EVENT_LOOP,
        "asyncio.gather": TemporalKind.EVENT_LOOP,
        "asyncio.run": TemporalKind.EVENT_LOOP,
        "asyncio.get_event_loop": TemporalKind.EVENT_LOOP,
        "asyncio.get_running_loop": TemporalKind.EVENT_LOOP,
    }

    SCHEDULER_PATTERNS = {
        "schedule.every": TemporalKind.TIMER,
        "schedule.run_pending": TemporalKind.TIMER,
        "apscheduler.schedulers.background.BackgroundScheduler": TemporalKind.TIMER,
        "celery.Celery.task": TemporalKind.TIMER,
        "celery.app.task.Task": TemporalKind.TIMER,
    }

    TRIGGER_PATTERNS = {
        "signal.signal": TemporalKind.TRIGGER,
        "atexit.register": TemporalKind.TRIGGER,
        "threading.Event.set": TemporalKind.TRIGGER,
        "threading.Event.wait": TemporalKind.TRIGGER,
        "threading.Condition.notify": TemporalKind.TRIGGER,
        "threading.Condition.wait": TemporalKind.TRIGGER,
    }

    def __init__(self, file_path: str, graph: Graph):
        self.file_path = file_path
        self.graph = graph
        self.nodes: List[Node] = []
        self.edges: List[Edge] = []
        self.warnings: List[str] = []
        self._temporal_cache: Dict[str, Node] = {}

    def visit_Call(self, node: ast.Call) -> None:
        func_name = _SymbolVisitor._name_of(node.func)
        if not func_name:
            self.generic_visit(node)
            return

        temporal_kind: Optional[TemporalKind] = None
        delay: Optional[float] = None

        # 匹配线程
        if func_name in self.THREAD_PATTERNS:
            temporal_kind = self.THREAD_PATTERNS[func_name]
            if func_name == "threading.Timer":
                if node.args:
                    first = node.args[0]
                    if isinstance(first, ast.Constant) and isinstance(first.value, (int, float)):
                        delay = float(first.value)

        # 匹配异步
        elif func_name in self.ASYNC_PATTERNS:
            temporal_kind = self.ASYNC_PATTERNS[func_name]

        # 匹配调度器
        elif func_name in self.SCHEDULER_PATTERNS:
            temporal_kind = self.SCHEDULER_PATTERNS[func_name]
            # 尝试提取周期参数
            delay = self._extract_delay(node)

        # 匹配触发器
        elif func_name in self.TRIGGER_PATTERNS:
            temporal_kind = self.TRIGGER_PATTERNS[func_name]

        if temporal_kind:
            temporal_node = self._get_or_create_temporal(func_name, temporal_kind, delay)

            # 找到当前所在的符号节点
            caller_node = self._find_enclosing_symbol(node)
            if caller_node:
                self.edges.append(Edge(
                    id=Edge.make_id(),
                    type=EdgeType.TEMPORAL,
                    direction=TemporalDirection.EXECUTES_ON.value,
                    source=caller_node.id,
                    target=temporal_node.id,
                    temporal_delay_sec=delay,
                ))

        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        # async def 隐式创建 event loop 上的执行
        loop_key = f"event_loop:{self.file_path}"
        loop_node = self._get_or_create_temporal(loop_key, TemporalKind.EVENT_LOOP)

        # 找到该函数的符号节点
        for n in self.graph.nodes.values():
            if n.location == f"{self.file_path}:{node.lineno}" and n.name.endswith(node.name):
                self.edges.append(Edge(
                    id=Edge.make_id(),
                    type=EdgeType.TEMPORAL,
                    direction=TemporalDirection.EXECUTES_ON.value,
                    source=n.id,
                    target=loop_node.id,
                ))
                break

        self.generic_visit(node)

    def _extract_delay(self, node: ast.Call) -> Optional[float]:
        """尝试从调度调用中提取延迟/周期参数。"""
        for kw in node.keywords:
            if kw.arg in ("seconds", "interval", "delay", "period", "every"):
                if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, (int, float)):
                    return float(kw.value.value)
        return None

    def _get_or_create_temporal(self, name: str, kind: TemporalKind,
                                delay: Optional[float] = None) -> Node:
        cache_key = f"{kind.value}:{name}"
        if cache_key in self._temporal_cache:
            return self._temporal_cache[cache_key]

        node = Node(
            id=Node.make_id(),
            type=NodeType.TEMPORAL,
            name=name,
            location=self.file_path,
            language="python",
            kind=kind.value,
            properties={"delay_sec": delay} if delay else {},
        )
        self.nodes.append(node)
        self._temporal_cache[cache_key] = node
        return node

    def _find_enclosing_symbol(self, node: ast.AST) -> Optional[Node]:
        candidates = [
            n for n in self.graph.nodes.values()
            if n.location.startswith(self.file_path) and n.type == NodeType.SYMBOL
        ]
        if candidates:
            for n in reversed(candidates):
                try:
                    loc_lineno = int(n.location.rsplit(":", 1)[-1])
                    if loc_lineno <= getattr(node, "lineno", float("inf")):
                        return n
                except (ValueError, IndexError):
                    pass
            return candidates[-1]
        return None
