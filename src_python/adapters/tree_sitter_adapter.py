"""
Tree-sitter 通用适配器：用 tree-sitter AST 替代手写 AST Visitor。

实现 LanguageAdapter 接口，支持所有已安装 grammar 的语言。
对每种语言使用 tree-sitter Query 模式提取：
  - extract_symbols  → 符号节点 + 结构边（函数/类/变量/导入/调用）
  - extract_media    → 介质节点 + 数据边（I/O 操作）
  - extract_temporal → 时间节点 + 时间边（线程/异步/调度器）
"""

from __future__ import annotations

import os
from typing import Dict, List, Optional, Set, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    import tree_sitter

from .base import LanguageAdapter, AdapterResult
from .tree_sitter_grammars import GrammarManager
from ..core.graph import (
    Graph, Node, Edge, NodeType, EdgeType,
    SymbolKind, MediumKind, TemporalKind,
    StructuralDirection, DataDirection, TemporalDirection,
)


# ═══════════════════════════════════════════════════════════════
# 语言特定配置：tree-sitter node type → HoloGram 概念映射
# ═══════════════════════════════════════════════════════════════

class LanguageConfig:
    """定义一种语言在 tree-sitter AST 中的节点类型映射。"""

    def __init__(
        self,
        # 符号提取：tree-sitter node type → (SymbolKind, 名称子字段)
        function_types: Dict[str, str] = None,      # type → 名称获取模式
        class_types: Dict[str, str] = None,
        variable_types: Dict[str, str] = None,
        constant_types: Dict[str, str] = None,
        interface_types: Dict[str, str] = None,
        # 导入：node type → 解析方式
        import_types: List[str] = None,
        # 调用
        call_types: List[str] = None,
        # 模块级 block type
        module_type: str = None,
        # 名称字段名（如何从 AST 节点获取名称）
        name_field: str = "name",
        # 装饰器/注解
        decorator_field: str = "decorator",
        # 形参
        parameters_field: str = "parameters",
        # 类型注解
        type_field: str = "type",
        # 继承
        bases_field: str = "bases",
    ):
        self.function_types = function_types or {}
        self.class_types = class_types or {}
        self.variable_types = variable_types or {}
        self.constant_types = constant_types or {}
        self.interface_types = interface_types or {}
        self.import_types = import_types or []
        self.call_types = call_types or []
        self.module_type = module_type or ""
        self.name_field = name_field
        self.decorator_field = decorator_field
        self.parameters_field = parameters_field
        self.type_field = type_field
        self.bases_field = bases_field


# ── 语言配置字典 ──────────────────────────────────────────────

LANGUAGE_CONFIGS: Dict[str, LanguageConfig] = {
    "python": LanguageConfig(
        function_types={
            "function_definition": "name",
            "async_function_definition": "name",
        },
        class_types={
            "class_definition": "name",
        },
        variable_types={
            "assignment": "left",  # 需要特殊处理
        },
        constant_types={},
        import_types=[
            "import_statement",
            "import_from_statement",
            "future_import_statement",
        ],
        call_types=[
            "call",
        ],
        module_type="module",
        decorator_field="decorator",
    ),
    "javascript": LanguageConfig(
        function_types={
            "function_declaration": "name",
            "arrow_function": "",           # 箭头函数通常无名
            "method_definition": "name",
            "generator_function_declaration": "name",
        },
        class_types={
            "class_declaration": "name",
        },
        variable_types={
            "variable_declarator": "name",
            "lexical_declaration": "",       # const/let 语句
        },
        constant_types={},
        import_types=[
            "import_statement",
            "import",
        ],
        call_types=[
            "call_expression",
        ],
        module_type="program",
    ),
    "typescript": LanguageConfig(
        function_types={
            "function_declaration": "name",
            "arrow_function": "",
            "method_definition": "name",
            "generator_function_declaration": "name",
        },
        class_types={
            "class_declaration": "name",
        },
        interface_types={
            "interface_declaration": "name",
            "type_alias_declaration": "name",
        },
        variable_types={
            "variable_declarator": "name",
            "lexical_declaration": "",
        },
        constant_types={},
        import_types=[
            "import_statement",
            "import",
        ],
        call_types=[
            "call_expression",
        ],
        module_type="program",
    ),
    # tsx 复用 TypeScript 配置（在下方补全）
    "go": LanguageConfig(
        function_types={
            "function_declaration": "name",
            "method_declaration": "name",
        },
        class_types={
            "type_declaration": "name",
        },
        variable_types={
            "var_declaration": "",
            "short_var_declaration": "",
        },
        constant_types={
            "const_declaration": "",
        },
        interface_types={
            "interface_type": "name",
        },
        import_types=[
            "import_declaration",
        ],
        call_types=[
            "call_expression",
        ],
        module_type="source_file",
    ),
    "rust": LanguageConfig(
        function_types={
            "function_item": "name",
            "function_signature_item": "name",
        },
        class_types={
            "struct_item": "name",
            "enum_item": "name",
            "trait_item": "name",
            "impl_item": "",  # impl block
        },
        variable_types={
            "let_declaration": "",
        },
        constant_types={
            "const_item": "name",
        },
        import_types=[
            "use_declaration",
        ],
        call_types=[
            "call_expression",
            "macro_invocation",
        ],
        module_type="source_file",
    ),
    "java": LanguageConfig(
        function_types={
            "method_declaration": "name",
            "constructor_declaration": "name",
        },
        class_types={
            "class_declaration": "name",
            "interface_declaration": "name",
            "enum_declaration": "name",
        },
        variable_types={
            "field_declaration": "",
            "variable_declarator": "name",
            "local_variable_declaration": "",
        },
        constant_types={},
        import_types=[
            "import_declaration",
        ],
        call_types=[
            "method_invocation",
        ],
        module_type="program",
    ),
    "c": LanguageConfig(
        function_types={
            "function_definition": "name",
            "function_declarator": "name",
        },
        class_types={
            "struct_specifier": "name",
            "union_specifier": "name",
            "enum_specifier": "name",
        },
        variable_types={
            "declaration": "",
        },
        constant_types={},
        import_types=[
            "preproc_include",
        ],
        call_types=[
            "call_expression",
        ],
        module_type="translation_unit",
    ),
    "cpp": LanguageConfig(
        function_types={
            "function_definition": "name",
            "function_declarator": "name",
        },
        class_types={
            "class_specifier": "name",
            "struct_specifier": "name",
            "union_specifier": "name",
            "enum_specifier": "name",
        },
        variable_types={
            "declaration": "",
        },
        constant_types={},
        import_types=[
            "preproc_include",
        ],
        call_types=[
            "call_expression",
        ],
        module_type="translation_unit",
    ),
    "ruby": LanguageConfig(
        function_types={
            "method": "name",
            "singleton_method": "name",
        },
        class_types={
            "class": "name",
            "module": "name",
        },
        variable_types={
            "assignment": "left",
        },
        constant_types={
            "constant": "name",
        },
        import_types=[
            "call",  # require/require_relative
        ],
        call_types=[
            "call",
        ],
        module_type="program",
    ),
    "c_sharp": LanguageConfig(
        function_types={
            "method_declaration": "name",
            "constructor_declaration": "name",
            "local_function_statement": "name",
        },
        class_types={
            "class_declaration": "name",
            "struct_declaration": "name",
            "interface_declaration": "name",
            "enum_declaration": "name",
        },
        variable_types={
            "variable_declarator": "name",
            "field_declaration": "",
        },
        constant_types={},
        import_types=[
            "using_directive",
        ],
        call_types=[
            "invocation_expression",
        ],
        module_type="compilation_unit",
    ),
    "kotlin": LanguageConfig(
        function_types={
            "function_declaration": "name",
        },
        class_types={
            "class_declaration": "name",
            "interface_declaration": "name",
            "object_declaration": "name",
        },
        variable_types={
            "property_declaration": "name",
            "variable_declaration": "name",
        },
        constant_types={},
        import_types=[
            "import_header",
        ],
        call_types=[
            "call_expression",
        ],
        module_type="source_file",
    ),
    "swift": LanguageConfig(
        function_types={
            "function_declaration": "name",
        },
        class_types={
            "class_declaration": "name",
            "struct_declaration": "name",
            "enum_declaration": "name",
            "protocol_declaration": "name",
        },
        variable_types={
            "variable_declaration": "",
        },
        constant_types={
            "constant_declaration": "",
        },
        import_types=[
            "import_declaration",
        ],
        call_types=[
            "call_expression",
        ],
        module_type="source_file",
    ),
    "php": LanguageConfig(
        function_types={
            "function_definition": "name",
            "method_declaration": "name",
        },
        class_types={
            "class_declaration": "name",
            "interface_declaration": "name",
            "trait_declaration": "name",
            "enum_declaration": "name",
        },
        variable_types={
            "assignment_expression": "",
            "property_declaration": "name",
        },
        constant_types={},
        import_types=[
            "namespace_use_declaration",
        ],
        call_types=[
            "function_call_expression",
            "member_call_expression",
        ],
        module_type="program",
    ),
    "lua": LanguageConfig(
        function_types={
            "function_declaration": "name",
            "function_definition": "name",
        },
        class_types={},  # Lua 无原生 class
        variable_types={
            "variable_declaration": "",
            "assignment_statement": "",
        },
        constant_types={},
        import_types=[],
        call_types=[
            "function_call",
            "method_call",
        ],
        module_type="chunk",
    ),
}

# tsx 复用 TypeScript 配置
LANGUAGE_CONFIGS["tsx"] = LANGUAGE_CONFIGS["typescript"]


# ═══════════════════════════════════════════════════════════════
# I/O 模式（语言无关 —— 匹配函数名）
# ═══════════════════════════════════════════════════════════════

IO_PATTERNS: List[Tuple[List[str], MediumKind, DataDirection]] = [
    # 文件 I/O
    (["open", "file", "readFile", "readFileSync"], MediumKind.FILE, DataDirection.READ),
    (["writeFile", "writeFileSync", "write_text"], MediumKind.FILE, DataDirection.WRITE),
    # JSON
    (["json.load", "JSON.parse", "json_decode"], MediumKind.FILE, DataDirection.READ),
    (["json.dump", "JSON.stringify", "json_encode"], MediumKind.FILE, DataDirection.WRITE),
    # 数据库
    (["connect", "create_engine", "createConnection"], MediumKind.DATABASE, DataDirection.READ),
    (["execute", "executemany", "query", "insert", "update", "delete"], MediumKind.DATABASE, DataDirection.WRITE),
    # 缓存
    (["get", "fetch", "hget", "getenv"], MediumKind.CACHE, DataDirection.READ),
    (["set", "put", "hset", "setex"], MediumKind.CACHE, DataDirection.WRITE),
    # 消息队列
    (["send", "publish", "basic_publish"], MediumKind.QUEUE, DataDirection.WRITE),
    (["subscribe", "basic_consume", "on", "addEventListener"], MediumKind.QUEUE, DataDirection.SUBSCRIBE),
    # HTTP
    (["get", "fetch"], MediumKind.NETWORK, DataDirection.READ),
    (["post", "put", "patch", "delete"], MediumKind.NETWORK, DataDirection.WRITE),
]

# 过于通用的动词（需要额外上下文才能判定）
_GENERIC_IO_VERBS: Set[str] = {
    "get", "set", "execute", "query", "insert", "update", "delete",
    "send", "post", "put", "fetch", "connect", "on",
}


# ═══════════════════════════════════════════════════════════════
# 线程/异步模式（语言无关）
# ═══════════════════════════════════════════════════════════════

THREAD_PATTERNS: List[Tuple[List[str], TemporalKind]] = [
    (["Thread", "threading.Thread", "Timer", "threading.Timer"], TemporalKind.THREAD),
    (["ThreadPoolExecutor", "ProcessPoolExecutor", "Worker"], TemporalKind.THREAD),
    (["create_task", "ensure_future", "gather", "run", "spawn", "go"], TemporalKind.EVENT_LOOP),
    (["setInterval", "setTimeout", "schedule.every", "add_job"], TemporalKind.TIMER),
    (["signal", "atexit.register", "Event.set", "Condition.notify", "emit"], TemporalKind.TRIGGER),
]


# ═══════════════════════════════════════════════════════════════
# TreeSitterAdapter
# ═══════════════════════════════════════════════════════════════

class TreeSitterAdapter(LanguageAdapter):
    """
    通用 tree-sitter 适配器，实现 LanguageAdapter 接口。

    自动检测文件语言 → 加载对应 grammar → 遍历 AST 提取三类信息。
    """

    language = "auto"          # 动态检测
    file_extensions = []        # 运行时从 GrammarManager 获取

    def __init__(self, grammar_manager: Optional[GrammarManager] = None):
        self._grammars = grammar_manager or GrammarManager()
        # 动态扩展名列表
        self.file_extensions = self._grammars.supported_extensions()

    # ── LanguageAdapter 接口 ──────────────────────────────────

    def accept(self, file_path: str) -> bool:
        """检查文件扩展名是否可处理。"""
        return self._grammars.find_language(file_path) is not None

    # ── Parse-once cache ────────────────────────────────────

    def analyze(self, file_path: str, source: str, graph=None) -> AdapterResult:
        """Override base to parse source once, reuse tree across all three phases."""
        import tree_sitter
        lang_name = self._grammars.find_language(file_path)
        if lang_name:
            try:
                ts_lang = self._grammars.load(lang_name)
            except Exception:
                self._cached_ts = None
            else:
                parser = tree_sitter.Parser()
                parser.language = ts_lang
                self._cached_ts = parser.parse(source.encode("utf-8"))
                self._cached_ts_lang = lang_name
        else:
            self._cached_ts = None
        try:
            return super().analyze(file_path, source, graph)
        finally:
            self._cached_ts = None
            self._cached_ts_lang = None

    def _get_ts_tree(self, file_path: str, source: str):
        """Return cached tree-sitter tree + lang_name if available, else parse."""
        cached = getattr(self, '_cached_ts', None)
        if cached is not None:
            return cached, getattr(self, '_cached_ts_lang', None)
        # Standalone call — parse from scratch
        import tree_sitter
        lang_name = self._grammars.find_language(file_path)
        if not lang_name:
            return None, None
        try:
            ts_lang = self._grammars.load(lang_name)
        except Exception:
            return None, None
        parser = tree_sitter.Parser()
        parser.language = ts_lang
        tree = parser.parse(source.encode("utf-8"))
        return tree, lang_name

    def extract_symbols(self, file_path: str, source: str) -> AdapterResult:
        tree, lang_name = self._get_ts_tree(file_path, source)
        if tree is None or not lang_name:
            return AdapterResult(file_path=file_path,
                errors=[f"No tree-sitter grammar for: {file_path}"])
        root = tree.root_node
        config = LANGUAGE_CONFIGS.get(lang_name, LanguageConfig())
        result = AdapterResult(file_path=file_path)

        if root.has_error:
            # 记录但不阻断：部分语法错误仍可提取部分符号
            result.warnings.append(f"Parse errors in {file_path}")

        # 提取
        extractor = _SymbolExtractor(file_path, source, lang_name, config)
        extractor.walk(root)

        result.nodes = extractor.nodes
        result.edges = extractor.edges
        result.warnings.extend(extractor.warnings)

        return result

    def extract_media(self, file_path: str, source: str, graph: Graph) -> AdapterResult:
        tree, lang_name = self._get_ts_tree(file_path, source)
        if tree is None:
            return AdapterResult(file_path=file_path)
        root = tree.root_node
        result = AdapterResult(file_path=file_path)

        extractor = _MediaExtractor(file_path, source, graph, lang_name)
        extractor.walk(root)

        result.nodes = extractor.nodes
        result.edges = extractor.edges
        result.warnings.extend(extractor.warnings)

        return result

    def extract_temporal(self, file_path: str, source: str, graph: Graph) -> AdapterResult:
        tree, lang_name = self._get_ts_tree(file_path, source)
        if tree is None:
            return AdapterResult(file_path=file_path)
        root = tree.root_node
        result = AdapterResult(file_path=file_path)

        extractor = _TemporalExtractor(file_path, source, graph, lang_name)
        extractor.walk(root)

        result.nodes = extractor.nodes
        result.edges = extractor.edges
        result.warnings.extend(extractor.warnings)

        return result


# ═══════════════════════════════════════════════════════════════
# AST 提取器基类
# ═══════════════════════════════════════════════════════════════

class _BaseExtractor:
    """tree-sitter AST 遍历基类。"""

    def __init__(self, file_path: str, source: str, lang_name: str):
        self.file_path = file_path
        self.source = source
        self.lang_name = lang_name
        self._source_bytes = source.encode("utf-8")
        self.nodes: List[Node] = []
        self.edges: List[Edge] = []
        self.warnings: List[str] = []

    def _text(self, node: tree_sitter.Node) -> str:
        """获取节点的源码文本。"""
        return self._source_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")

    def _named_child_text(self, node: tree_sitter.Node, field: str) -> Optional[str]:
        """获取指定字段名的子节点文本。"""
        try:
            child = node.child_by_field_name(field)
        except Exception:
            child = None
        if child:
            return self._text(child)
        return None

    def _find_child(self, node: tree_sitter.Node, kind: str) -> Optional[tree_sitter.Node]:
        """查找第一个指定类型的子节点。"""
        for child in node.children:
            if child.type == kind:
                return child
            found = self._find_child(child, kind)
            if found:
                return found
        return None

    def walk(self, root: tree_sitter.Node) -> None:
        """遍历 AST。子类覆盖此方法。"""
        self._walk_recursive(root)

    def _walk_recursive(self, node: tree_sitter.Node) -> None:
        self._visit(node)
        for child in node.children:
            self._walk_recursive(child)

    def _visit(self, node: tree_sitter.Node) -> None:
        """子类覆盖：处理单个节点。"""
        pass


# ═══════════════════════════════════════════════════════════════
# 符号提取器
# ═══════════════════════════════════════════════════════════════

class _SymbolExtractor(_BaseExtractor):
    """从 tree-sitter AST 提取符号节点和结构边。"""

    def __init__(self, file_path: str, source: str, lang_name: str, config: LanguageConfig):
        super().__init__(file_path, source, lang_name)
        self.config = config
        self._module_id: Optional[str] = None
        self._scope_stack: List[str] = []
        self._local_symbols: Dict[str, str] = {}      # short_name → node_id
        self._import_map: Dict[str, str] = {}           # alias → full path
        self._current_class: Optional[str] = None
        self._pending_calls: List[Tuple[str, tree_sitter.Node]] = []  # (caller_id, call_node)

    def walk(self, root: tree_sitter.Node) -> None:
        # 创建模块节点
        module_name = self._module_name()
        self._module_id = Node.make_id()
        module_node = Node(
            id=self._module_id,
            type=NodeType.SYMBOL,
            name=module_name,
            location=self.file_path,
            language=self.lang_name,
            kind=SymbolKind.MODULE.value,
            properties={"is_root": True},
        )
        self.nodes.append(module_node)
        self._scope_stack.append(self._module_id)

        # 遍历
        self._walk_recursive(root)

        # 解析挂起的调用
        for caller_id, call_node in self._pending_calls:
            self._resolve_call(caller_id, call_node)

    def _module_name(self) -> str:
        name = os.path.splitext(os.path.basename(self.file_path))[0]
        if name == "__init__":
            return os.path.basename(os.path.dirname(self.file_path))
        return name

    def _visit(self, node: tree_sitter.Node) -> None:
        node_type = node.type

        # ── 函数 ──
        if node_type in self.config.function_types:
            self._handle_function(node)
        # ── 类 ──
        elif node_type in self.config.class_types:
            self._handle_class(node)
        # ── 接口/trait ──
        elif node_type in self.config.interface_types:
            self._handle_interface(node)
        # ── 变量/常量 ──
        elif node_type in self.config.variable_types or node_type in self.config.constant_types:
            self._handle_variable(node)
        # ── 导入 ──
        elif node_type in self.config.import_types:
            self._handle_import(node)
        # ── 调用 ──
        elif node_type in self.config.call_types:
            self._handle_call(node)

    # ── 节点处理 ──

    def _handle_function(self, node: tree_sitter.Node) -> None:
        name = self._get_node_name(node)
        if not name:
            return

        full_name = f"{self._current_class}.{name}" if self._current_class else name
        is_async = "async" in node.type

        fn_node = self._make_node(
            name=full_name,
            kind=SymbolKind.FUNCTION,
            line=node.start_point[0] + 1,
            is_method=self._current_class is not None,
            is_async=is_async,
        )
        self._make_edge(fn_node.id, self._scope_stack[-1], StructuralDirection.IMPORT)

        # 进入函数作用域
        prev_class = self._current_class
        self._current_class = None
        self._scope_stack.append(fn_node.id)

        # 处理函数体中的子节点
        for child in node.children:
            self._walk_recursive(child)

        self._scope_stack.pop()
        self._current_class = prev_class

    def _handle_class(self, node: tree_sitter.Node) -> None:
        name = self._get_node_name(node)
        if not name:
            return

        full_name = f"{self._current_class}.{name}" if self._current_class else name
        cls_node = self._make_node(
            name=full_name,
            kind=SymbolKind.CLASS,
            line=node.start_point[0] + 1,
        )
        self._make_edge(cls_node.id, self._scope_stack[-1], StructuralDirection.IMPORT)

        prev_class = self._current_class
        self._current_class = full_name
        self._scope_stack.append(cls_node.id)

        for child in node.children:
            self._walk_recursive(child)

        self._scope_stack.pop()
        self._current_class = prev_class

    def _handle_interface(self, node: tree_sitter.Node) -> None:
        name = self._get_node_name(node)
        if not name:
            return
        iface_node = self._make_node(
            name=name, kind=SymbolKind.INTERFACE, line=node.start_point[0] + 1,
        )
        self._make_edge(iface_node.id, self._scope_stack[-1], StructuralDirection.IMPORT)

    def _handle_variable(self, node: tree_sitter.Node) -> None:
        name = self._get_node_name(node)
        if not name:
            return
        # 只提取模块级变量
        if len(self._scope_stack) <= 2:
            is_const = name.isupper() or node.type in self.config.constant_types
            kind = SymbolKind.CONSTANT if is_const else SymbolKind.VARIABLE
            self._make_node(name=name, kind=kind, line=node.start_point[0] + 1)

    def _handle_import(self, node: tree_sitter.Node) -> None:
        """提取导入信息到 _import_map。"""
        text = self._text(node)
        # 简单解析：提取标识符字符串
        for child in node.children:
            if child.type in ("string", "string_fragment", "import", "identifier"):
                pass  # 在后续处理中提取
        # 记录导入文本供跨文件解析使用
        last = self._scope_stack[-1] if len(self._scope_stack) > 1 else ""
        if last:
            # 将 import 源文本作为调用引用存储
            for n in self.nodes:
                if n.id == last:
                    imports = n.properties.setdefault("imports", [])
                    import_text = text.replace("\n", " ").strip()
                    if len(import_text) > 200:
                        import_text = import_text[:200] + "..."
                    imports.append(import_text)
                    break

    def _handle_call(self, node: tree_sitter.Node) -> None:
        """记录调用，延迟解析。"""
        caller_id = self._scope_stack[-1] if len(self._scope_stack) > 1 else (self._module_id or "")
        self._pending_calls.append((caller_id, node))

    def _resolve_call(self, caller_id: str, call_node: tree_sitter.Node) -> None:
        """解析调用关系。"""
        # 获取被调用者名称
        func_node = call_node.child_by_field_name("function")
        if not func_node:
            # 尝试其他字段名
            for field in ("method", "object", "name"):
                func_node = call_node.child_by_field_name(field)
                if func_node:
                    break

        if not func_node:
            # 尝试第一个 named child
            named = [c for c in call_node.named_children]
            if named:
                func_node = named[0]

        if not func_node:
            return

        callee_name = self._text(func_node)
        if not callee_name:
            return

        # 去掉常见前缀
        callee_name = callee_name.strip().lstrip(".")

        # 提取短名
        short = callee_name.split(".")[-1]

        # 在同文件内查找
        if short in self._local_symbols:
            self._make_edge(caller_id, self._local_symbols[short], StructuralDirection.CALL)
        else:
            # 跨模块调用——记录引用
            full_ref = self._import_map.get(short, callee_name)
            for n in self.nodes:
                if n.id == caller_id:
                    calls = n.properties.setdefault("calls", [])
                    if full_ref not in calls:
                        calls.append(full_ref)
                    break

    # ── helpers ──

    def _get_node_name(self, node: tree_sitter.Node) -> Optional[str]:
        """从 AST 节点获取名称。"""
        name_field = self.config.name_field
        try:
            child = node.child_by_field_name(name_field)
            if child:
                return self._text(child)
        except Exception:
            pass

        # fallback: 查找 identifier 子节点
        for child in node.children:
            if child.type in ("identifier", "property_identifier", "type_identifier"):
                return self._text(child)
            # 嵌套查找（如 method_definition → property_identifier）
            for gc in child.children:
                if gc.type in ("identifier", "property_identifier"):
                    return self._text(gc)

        return None

    def _make_node(self, name: str, kind: SymbolKind, line: int, **props) -> Node:
        node = Node(
            id=Node.make_id(),
            type=NodeType.SYMBOL,
            name=name,
            location=f"{self.file_path}:{line}",
            language=self.lang_name,
            kind=kind.value,
            properties=props,
        )
        self.nodes.append(node)
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


# ═══════════════════════════════════════════════════════════════
# 介质提取器
# ═══════════════════════════════════════════════════════════════

class _MediaExtractor(_BaseExtractor):
    """从 tree-sitter AST 提取介质节点和数据边。"""

    def __init__(self, file_path: str, source: str, graph: Graph, lang_name: str):
        super().__init__(file_path, source, lang_name)
        self.graph = graph
        self._medium_cache: Dict[str, Node] = {}
        self._call_stack: List[tree_sitter.Node] = []

    def _visit(self, node: tree_sitter.Node) -> None:
        # 只处理调用节点
        if node.type not in ("call", "call_expression", "function_call_expression",
                             "member_call_expression", "method_invocation",
                             "invocation_expression", "function_call", "method_call"):
            return

        # 获取被调函数名
        func_node = node.child_by_field_name("function")
        if not func_node:
            named = [c for c in node.named_children]
            func_node = named[0] if named else None
        if not func_node:
            return

        func_name = self._text(func_node)
        if not func_name:
            return

        # 匹配 I/O 模式
        short = func_name.split(".")[-1]
        for patterns, kind, direction in IO_PATTERNS:
            if short in patterns or func_name in patterns:
                # 过滤过于通用的动词（除非全限定名匹配）
                if short in _GENERIC_IO_VERBS and func_name not in patterns:
                    continue

                medium_name = self._extract_medium_name(node, func_name)
                medium_node = self._get_or_create_medium(medium_name, kind)

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
                break

    def _extract_medium_name(self, node: tree_sitter.Node, func_name: str) -> str:
        """从调用中提取介质标识（文件名、URL 等）。"""
        # 获取 arguments 子节点
        args_node = node.child_by_field_name("arguments")
        if args_node:
            named_children = [c for c in args_node.named_children]
            if named_children:
                first = named_children[0]
                text = self._text(first)
                if text:
                    # 如果是字面量字符串
                    if first.type in ("string", "string_fragment"):
                        return text.strip("'\"")
                    # 如果是变量
                    if first.type in ("identifier", "property_identifier", "variable_name"):
                        return f"<var:{text}>"
                    return text[:100]

        return f"<unknown:{func_name}:{node.start_point[0] + 1}>"

    def _get_or_create_medium(self, name: str, kind: MediumKind) -> Node:
        cache_key = f"{kind.value}:{name}"
        if cache_key in self._medium_cache:
            return self._medium_cache[cache_key]

        node = Node(
            id=Node.make_id(),
            type=NodeType.MEDIUM,
            name=name,
            location=f"{self.file_path}:0",
            language=self.lang_name,
            kind=kind.value,
            properties={"source": "tree-sitter", "confidence": "medium"},
        )
        self.nodes.append(node)
        self._medium_cache[cache_key] = node
        return node

    def _find_enclosing_symbol(self, node: tree_sitter.Node) -> Optional[Node]:
        """在图谱中找到包含此 AST 节点的符号节点。"""
        lineno = node.start_point[0] + 1
        candidates = [
            n for n in self.graph.nodes.values()
            if getattr(n, 'location', '').startswith(self.file_path) and n.type == NodeType.SYMBOL
        ]
        if candidates:
            for n in reversed(candidates):
                try:
                    loc_lineno = int(n.location.rsplit(":", 1)[-1])
                    if loc_lineno <= lineno:
                        return n
                except (ValueError, IndexError):
                    pass
            return candidates[-1]
        return None


# ═══════════════════════════════════════════════════════════════
# 时间提取器
# ═══════════════════════════════════════════════════════════════

class _TemporalExtractor(_BaseExtractor):
    """从 tree-sitter AST 提取时间节点和时间边。"""

    def __init__(self, file_path: str, source: str, graph: Graph, lang_name: str):
        super().__init__(file_path, source, lang_name)
        self.graph = graph
        self._temporal_cache: Dict[str, Node] = {}

    def _visit(self, node: tree_sitter.Node) -> None:
        # 处理 async 函数声明
        if "async" in node.type and node.type in (
            "function_declaration", "function_definition",
            "async_function_definition", "method_definition",
        ):
            self._handle_async_declaration(node)
            return

        # 处理调用表达式
        if node.type not in ("call", "call_expression", "function_call_expression",
                             "member_call_expression", "method_invocation",
                             "invocation_expression", "function_call", "method_call",
                             "new_expression"):
            return

        func_node = node.child_by_field_name("function")
        if not func_node:
            named = [c for c in node.named_children]
            func_node = named[0] if named else None
        if not func_node:
            return

        func_name = self._text(func_node)
        if not func_name:
            return

        # 匹配线程模式
        short = func_name.split(".")[-1]
        for patterns, kind in THREAD_PATTERNS:
            if short in patterns or func_name in patterns:
                delay = self._extract_delay(node)
                temporal_node = self._get_or_create_temporal(func_name, kind, delay)

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
                break

    def _handle_async_declaration(self, node: tree_sitter.Node) -> None:
        """async def/function 隐式创建 event loop 执行。"""
        loop_key = f"event_loop:{self.file_path}"
        loop_node = self._get_or_create_temporal(loop_key, TemporalKind.EVENT_LOOP)

        name = ""
        for child in node.children:
            if child.type in ("identifier", "property_identifier"):
                name = self._text(child)
                break

        if name:
            for n in self.graph.nodes.values():
                loc = getattr(n, 'location', '')
                if loc.startswith(self.file_path) and n.name.endswith(name):
                    self.edges.append(Edge(
                        id=Edge.make_id(),
                        type=EdgeType.TEMPORAL,
                        direction=TemporalDirection.EXECUTES_ON.value,
                        source=n.id,
                        target=loop_node.id,
                    ))
                    break

    def _extract_delay(self, node: tree_sitter.Node) -> Optional[float]:
        """尝试从调用中提取延迟参数。"""
        args = node.child_by_field_name("arguments")
        if args:
            named = [c for c in args.named_children]
            if named:
                first = named[0]
                if first.type in ("number", "integer", "float"):
                    try:
                        return float(self._text(first))
                    except ValueError:
                        pass
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
            language=self.lang_name,
            kind=kind.value,
            properties={"delay_sec": delay} if delay else {},
        )
        self.nodes.append(node)
        self._temporal_cache[cache_key] = node
        return node

    def _find_enclosing_symbol(self, node: tree_sitter.Node) -> Optional[Node]:
        lineno = node.start_point[0] + 1
        candidates = [
            n for n in self.graph.nodes.values()
            if getattr(n, 'location', '').startswith(self.file_path) and n.type == NodeType.SYMBOL
        ]
        if candidates:
            for n in reversed(candidates):
                try:
                    loc_lineno = int(n.location.rsplit(":", 1)[-1])
                    if loc_lineno <= lineno:
                        return n
                except (ValueError, IndexError):
                    pass
            return candidates[-1]
        return None
