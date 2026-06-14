"""
模式匹配器 — 文件名/变量名/数值/字符串的简单模式匹配

V3 新增的信号全部是简单规则——文件名模式、变量名模式、字符串匹配。
不需要新算法。实现方式是在 V2 的 AST 分析流水线上附加一组模式匹配器。

依赖：无（纯标准库）
"""

from __future__ import annotations

import ast
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple


# ============================================================
# 数据类型
# ============================================================

@dataclass
class PatternMatch:
    """单次模式匹配结果。"""
    pattern_name: str           # 模式名（如 "threshold_value_change"）
    file_path: str
    line: int
    variable: str               # 变量名
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    context: str = ""           # 人类可读的上下文描述
    confidence: str = "确定"


@dataclass
class FileChange:
    """单个文件的变更信息。"""
    file_path: str
    old_source: Optional[str] = None
    new_source: Optional[str] = None
    added_lines: List[int] = field(default_factory=list)
    removed_lines: List[int] = field(default_factory=list)
    modified_lines: Dict[int, Tuple[str, str]] = field(default_factory=dict)


# ============================================================
# 模式定义
# ============================================================

# ── 文件名模式 ──

MIGRATION_FILE_PATTERNS: List[str] = [
    r"migrations?/",           # Django/Flask/SQLAlchemy migration dirs
    r"alembic/",               # SQLAlchemy migration tool
    r"\b\d{4,}_.*\.(py|sql)$", # Timestamped migration files
    r"\.sql$",                 # Raw SQL files
    r".*schema.*\.(py|sql)$",  # Schema definition files
    r"\bschema\.sql\b",
    r"\bmigrate\b.*\.(py|sql)$",
]

SERIALIZATION_FILE_PATTERNS: List[str] = [
    r"\.proto$",               # Protobuf
    r"\.fbs$",                 # FlatBuffers
    r"\.avsc$",                # Avro schema
    r"\.thrift$",              # Thrift
    r"\.capnp$",               # Cap'n Proto
]

CONFIG_FILE_PATTERNS: List[str] = [
    r"\.yaml$", r"\.yml$",
    r"\.toml$",
    r"\.json$",                # config JSON (exclude package.json/lock)
    r"\.ini$", r"\.cfg$",
    r"\.env$", r"\.env\.",
    r"settings\.py$",
    r"config\.py$",
    r"\.conf$",
]

# ── 变量名模式（用于检测阈值/超时等变更）──

THRESHOLD_VARIABLE_PATTERNS: List[str] = [
    # 中文变量名模式
    r".*阈[值限].*",
    r".*上限.*",
    r".*下限.*",
    # 英文变量名模式
    r".*\bthreshold.*",
    r".*\bTHRESHOLD.*",
    r".*\bTimeout.*",
    r".*\btimeout.*",
    r".*\bTIMEOUT.*",
    r".*\binterval.*",
    r".*\bINTERVAL.*",
    r".*\bttl.*",
    r".*\bTTL.*",
    r".*\bdelay.*",
    r".*\bDELAY.*",
    r".*\blimit.*",
    r".*\bLIMIT.*",
    r".*\bmax_?retries?.*",
    r".*\bMAX_RETRIES?.*",
    r".*\brate_limit.*",
    r".*\bRATE_LIMIT.*",
    r".*\bcapacity.*",
    r".*\bbuffer_?size.*",
    r".*\bBUFFER_SIZE.*",
    r".*\bheartbeat.*",
    r".*\bdeadline.*",
    r".*\bexpir\w*.*",        # expire, expiry, expiration
    r".*\bmax_\w+.*",         # max_connections, max_workers, etc.
    r".*\bmin_\w+.*",         # min_interval, etc.
]

LLM_PROMPT_VARIABLE_PATTERNS: List[str] = [
    r".*\bprompt.*",
    r".*\bPROMPT.*",
    r".*\bsystem_prompt.*",
    r".*\bSYSTEM_PROMPT.*",
    r".*\btemplate.*",
    r".*\bTEMPLATE.*",
    r".*\binstruction.*",
    r".*\bINSTRUCTION.*",
    r".*\bsystem_message.*",
    r".*\buser_message.*",
    r".*\bassistant_message.*",
    r".*\bfew_shot.*",
    r".*\bexample.*_prompt.*",
    r".*\bmessages?.*template.*",
]

SORT_FILTER_FUNCTION_PATTERNS: List[str] = [
    r".*\bsort.*",
    r".*\bfilter.*",
    r".*\brank.*",
    r".*\bscore.*",
    r".*\bweigh\w*.*",        # weigh, weight, weighting
    r".*\border\w*.*",         # order, ordering
    r".*\brelevan\w*.*",      # relevant, relevance
    r".*\bpriorit\w*.*",      # priority, prioritize
    r".*\brecommend\w*.*",
]

RHYTHM_VARIABLE_PATTERNS: List[str] = [
    r".*\binterval.*",
    r".*\bperiod.*",
    r".*\bfrequency.*",
    r".*\bcron.*",
    r".*\bschedule.*",
    r".*\bSCHEDULE.*",
    r".*\btick.*",
    r".*\bpoll.*interval.*",
    r".*\brefresh.*interval.*",
    r".*\bsleep.*duration.*",
]

# DENYLIST_KEYWORDS moved to constraints.py (single source of truth)
# Import via: from .constraints import DEFAULT_CONSTRAINTS

SHARED_DATA_STRUCTURE_NAMES: List[str] = [
    # Python
    "BaseModel", "TypedDict", "dataclass", "NamedTuple",
    "Protocol", "ABC",
    # TS
    "interface", "type", "enum",
]


# ============================================================
# PatternMatcher 主类
# ============================================================

class PatternMatcher:
    """
    模式匹配器 — 对文件变更运行一组模式匹配规则。

    所有规则都是确定性的字符串/正则匹配，不涉及概率或推断。
    """

    def __init__(self):
        self._compiled_migration = [re.compile(p, re.IGNORECASE) for p in MIGRATION_FILE_PATTERNS]
        self._compiled_serialization = [re.compile(p, re.IGNORECASE) for p in SERIALIZATION_FILE_PATTERNS]
        self._compiled_config = [re.compile(p, re.IGNORECASE) for p in CONFIG_FILE_PATTERNS]
        self._compiled_threshold = [re.compile(p) for p in THRESHOLD_VARIABLE_PATTERNS]
        self._compiled_llm_prompt = [re.compile(p) for p in LLM_PROMPT_VARIABLE_PATTERNS]
        self._compiled_sort_filter = [re.compile(p) for p in SORT_FILTER_FUNCTION_PATTERNS]
        self._compiled_rhythm = [re.compile(p) for p in RHYTHM_VARIABLE_PATTERNS]
        from .constraints import DEFAULT_CONSTRAINTS
        self._compiled_denylist = [
            re.compile(re.escape(kw), re.IGNORECASE)
            for kw in DEFAULT_CONSTRAINTS["denylist"]["keywords"]
        ]

    # ── 文件名匹配 ──

    def is_migration_file(self, file_path: str) -> bool:
        """检查文件是否为数据库 migration 文件。"""
        for pat in self._compiled_migration:
            if pat.search(file_path):
                return True
        return False

    def is_serialization_file(self, file_path: str) -> bool:
        """检查文件是否为序列化格式定义文件。"""
        for pat in self._compiled_serialization:
            if pat.search(file_path):
                return True
        return False

    def is_config_file(self, file_path: str) -> bool:
        """检查文件是否为配置文件。"""
        # 排除 package.json / package-lock.json / tsconfig.json 等工具配置
        basename = os.path.basename(file_path)
        if basename in ("package.json", "package-lock.json", "tsconfig.json",
                        "composer.json", "Cargo.toml", "Cargo.lock"):
            return False
        for pat in self._compiled_config:
            if pat.search(file_path):
                return True
        return False

    def is_doc_or_test_file(self, file_path: str) -> bool:
        """检查文件是否为文档或测试文件。"""
        return (
            file_path.startswith("docs/") or
            "docs" in file_path.split(os.sep) or
            file_path.startswith("tests/") or
            "test_" in os.path.basename(file_path) or
            file_path.endswith(".md") or
            file_path.endswith(".rst") or
            file_path.endswith(".txt")
        )

    # ── 变量名匹配 ──

    def matches_threshold_variable(self, var_name: str) -> bool:
        """检查变量名是否匹配阈值/超时/限制相关模式。"""
        for pat in self._compiled_threshold:
            if pat.match(var_name):
                return True
        return False

    def matches_llm_prompt_variable(self, var_name: str) -> bool:
        """检查变量名是否匹配 LLM prompt 相关模式。"""
        for pat in self._compiled_llm_prompt:
            if pat.match(var_name):
                return True
        return False

    def matches_sort_filter_function(self, func_name: str) -> bool:
        """检查函数名是否匹配排序/过滤/评分相关模式。"""
        for pat in self._compiled_sort_filter:
            if pat.match(func_name):
                return True
        return False

    def matches_rhythm_variable(self, var_name: str) -> bool:
        """检查变量名是否匹配节律参数相关模式。"""
        for pat in self._compiled_rhythm:
            if pat.match(var_name):
                return True
        return False

    def matches_denylist_keyword(self, name: str) -> bool:
        """检查名称是否包含敏感关键词。"""
        for pat in self._compiled_denylist:
            if pat.search(name):
                return True
        return False

    # ── 数值变更检测（基于 AST diff）──

    @staticmethod
    def extract_numeric_assignments(source: str) -> Dict[str, Tuple[int, Any]]:
        """从 Python 源码中提取所有数值字面量赋值。
        返回：{变量名: (行号, 数值)}
        """
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return {}

        result: Dict[str, Tuple[int, Any]] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    name = PatternMatcher._get_name(target)
                    if name is None:
                        continue
                    val = PatternMatcher._extract_numeric_value(node.value)
                    if val is not None:
                        result[name] = (node.lineno, val)
        return result

    @staticmethod
    def extract_string_assignments(source: str) -> Dict[str, Tuple[int, str]]:
        """从 Python 源码中提取所有字符串字面量赋值。
        返回：{变量名: (行号, 字符串)}
        """
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return {}

        result: Dict[str, Tuple[int, str]] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    name = PatternMatcher._get_name(target)
                    if name is None:
                        continue
                    if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                        result[name] = (node.lineno, node.value.value)
        return result

    @staticmethod
    def extract_function_defs(source: str) -> Dict[str, int]:
        """从 Python 源码中提取所有函数/方法定义。
        返回：{函数名: 行号}
        """
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return {}

        result: Dict[str, int] = {}
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                result[node.name] = node.lineno
        return result

    @staticmethod
    def extract_class_defs(source: str) -> Dict[str, Tuple[int, List[str]]]:
        """从 Python 源码中提取类定义及其基类。
        返回：{类名: (行号, [基类名])}
        """
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return {}

        result: Dict[str, Tuple[int, List[str]]] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                bases = []
                for base in node.bases:
                    name = PatternMatcher._get_name(base)
                    if name:
                        bases.append(name)
                result[node.name] = (node.lineno, bases)
        return result

    @staticmethod
    def extract_config_keys(source: str) -> Set[str]:
        """从 Python 源码中提取所有配置 key 引用（如 os.environ["KEY"] 或 config["key"]）。"""
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return set()

        keys: Set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Subscript):
                if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
                    # config["key"] 或 os.environ["KEY"]
                    keys.add(node.slice.value)
        return keys

    # ── 变更检测（比较 before/after 源码）──

    def detect_numeric_changes(
        self,
        old_source: Optional[str],
        new_source: Optional[str],
        file_path: str,
        variable_filter=None,  # Optional[Callable[[str], bool]]
    ) -> List[PatternMatch]:
        """检测数值字面量变更。"""
        if not old_source or not new_source:
            return []

        old_nums = self.extract_numeric_assignments(old_source)
        new_nums = self.extract_numeric_assignments(new_source)

        matches = []
        for var_name, (line, new_val) in new_nums.items():
            if var_name not in old_nums:
                continue
            _, old_val = old_nums[var_name]
            if old_val != new_val:
                if variable_filter and not variable_filter(var_name):
                    continue
                matches.append(PatternMatch(
                    pattern_name="numeric_value_change",
                    file_path=file_path,
                    line=line,
                    variable=var_name,
                    old_value=str(old_val),
                    new_value=str(new_val),
                    context=f"{var_name} 数值变更: {old_val} → {new_val}",
                    confidence="确定",
                ))
        return matches

    def detect_string_changes(
        self,
        old_source: Optional[str],
        new_source: Optional[str],
        file_path: str,
        variable_filter=None,
    ) -> List[PatternMatch]:
        """检测字符串字面量变更。"""
        if not old_source or not new_source:
            return []

        old_strs = self.extract_string_assignments(old_source)
        new_strs = self.extract_string_assignments(new_source)

        matches = []
        for var_name, (line, new_val) in new_strs.items():
            if var_name not in old_strs:
                continue
            _, old_val = old_strs[var_name]
            if old_val != new_val:
                if variable_filter and not variable_filter(var_name):
                    continue
                # 截断过长的字符串
                old_display = old_val[:80] + "..." if len(old_val) > 80 else old_val
                new_display = new_val[:80] + "..." if len(new_val) > 80 else new_val
                matches.append(PatternMatch(
                    pattern_name="string_value_change",
                    file_path=file_path,
                    line=line,
                    variable=var_name,
                    old_value=old_display,
                    new_value=new_display,
                    context=f"{var_name} 内容变更",
                    confidence="确定",
                ))
        return matches

    def detect_function_changes(
        self,
        old_source: Optional[str],
        new_source: Optional[str],
        file_path: str,
        func_filter=None,
    ) -> List[PatternMatch]:
        """检测函数定义的增删。"""
        if not old_source or not new_source:
            return []

        old_funcs = self.extract_function_defs(old_source)
        new_funcs = self.extract_function_defs(new_source)

        matches = []

        # 新增函数
        for fname, line in new_funcs.items():
            if fname not in old_funcs:
                if func_filter and not func_filter(fname):
                    continue
                matches.append(PatternMatch(
                    pattern_name="function_added",
                    file_path=file_path,
                    line=line,
                    variable=fname,
                    context=f"新增函数: {fname}",
                    confidence="确定",
                ))

        # 修改函数（同一文件同一行位置的同名函数改变了 — 这里检查同名函数所在行是否变化）
        for fname, line in new_funcs.items():
            if fname in old_funcs and old_funcs[fname] != line:
                if func_filter and not func_filter(fname):
                    continue
                matches.append(PatternMatch(
                    pattern_name="function_modified",
                    file_path=file_path,
                    line=line,
                    variable=fname,
                    context=f"函数 {fname} 行位置变更: {old_funcs[fname]} → {line}（可能重写）",
                    confidence="确定",
                ))

        return matches

    def detect_class_field_changes(
        self,
        old_source: Optional[str],
        new_source: Optional[str],
        file_path: str,
    ) -> List[PatternMatch]:
        """检测数据类/TypedDict/model 的字段增删。"""
        if not old_source or not new_source:
            return []

        new_classes = self.extract_class_defs(new_source)

        matches = []

        # 检测数据结构的基类
        data_class_bases = {"BaseModel", "TypedDict", "NamedTuple", "ABC", "Protocol"}

        for cls_name, (line, bases) in new_classes.items():
            is_data_class = any(b in data_class_bases for b in bases) or cls_name.endswith("TypedDict")
            if not is_data_class:
                # 也检查 @dataclass 装饰器（粗略：检查类名附近是否有 @dataclass）
                if new_source:
                    cls_pattern = re.search(rf"@dataclass\s*\n\s*class\s+{cls_name}\b", new_source)
                    if not cls_pattern:
                        continue

            # 比较这个类的字段（简化版：比较类体中的赋值语句）
            old_fields = self._extract_class_fields(old_source, cls_name) if old_source else set()
            new_fields = self._extract_class_fields(new_source, cls_name) if new_source else set()

            added = new_fields - old_fields
            removed = old_fields - new_fields

            for field_name in added:
                matches.append(PatternMatch(
                    pattern_name="data_field_added",
                    file_path=file_path,
                    line=line,
                    variable=f"{cls_name}.{field_name}",
                    context=f"数据结构 {cls_name} 新增字段: {field_name}",
                    confidence="确定",
                ))
            for field_name in removed:
                matches.append(PatternMatch(
                    pattern_name="data_field_removed",
                    file_path=file_path,
                    line=line,
                    variable=f"{cls_name}.{field_name}",
                    context=f"数据结构 {cls_name} 删除字段: {field_name}",
                    confidence="确定",
                ))

        return matches

    @staticmethod
    def _extract_class_fields(source: str, class_name: str) -> Set[str]:
        """从 Python 源码中提取指定类的字段名。"""
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return set()

        fields: Set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == class_name:
                for item in node.body:
                    # 带类型注解的赋值: x: int
                    if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                        if not item.target.id.startswith("_"):
                            fields.add(item.target.id)
                    # 普通赋值: x = 1
                    elif isinstance(item, ast.Assign):
                        for target in item.targets:
                            if isinstance(target, ast.Name) and not target.id.startswith("_"):
                                fields.add(target.id)
        return fields

    # ── 公共 API 签名变更检测 ──

    @staticmethod
    def detect_signature_changes(
        old_source: Optional[str],
        new_source: Optional[str],
        file_path: str,
    ) -> List[PatternMatch]:
        """检测函数签名的变更（参数增删、类型变更）。"""
        if not old_source or not new_source:
            return []

        try:
            old_tree = ast.parse(old_source)
            new_tree = ast.parse(new_source)
        except SyntaxError:
            return []

        old_sigs: Dict[str, Dict[str, Any]] = {}
        new_sigs: Dict[str, Dict[str, Any]] = {}

        for node in ast.walk(old_tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                old_sigs[node.name] = PatternMatcher._extract_signature(node)

        for node in ast.walk(new_tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                new_sigs[node.name] = PatternMatcher._extract_signature(node)

        matches = []
        for fname, new_sig in new_sigs.items():
            if fname not in old_sigs:
                continue
            old_sig = old_sigs[fname]

            old_params = old_sig.get("params", [])
            new_params = new_sig.get("params", [])

            # 新增参数（未提供默认值 → 必填）
            old_param_names = {p["name"] for p in old_params}
            new_param_names = {p["name"] for p in new_params}

            for p in new_params:
                if p["name"] not in old_param_names:
                    if p.get("default") is None and p["name"] != "self" and p["name"] != "cls":
                        matches.append(PatternMatch(
                            pattern_name="required_param_added",
                            file_path=file_path,
                            line=new_sig["line"],
                            variable=f"{fname}({p['name']})",
                            context=f"公开函数 {fname} 新增必填参数: {p['name']}",
                            confidence="确定",
                        ))
                    else:
                        matches.append(PatternMatch(
                            pattern_name="optional_param_added",
                            file_path=file_path,
                            line=new_sig["line"],
                            variable=f"{fname}({p['name']})",
                            context=f"函数 {fname} 新增可选参数: {p['name']}",
                            confidence="确定",
                        ))

            # 删除参数
            for p in old_params:
                if p["name"] not in new_param_names:
                    matches.append(PatternMatch(
                        pattern_name="param_removed",
                        file_path=file_path,
                        line=new_sig.get("line", 0),
                        variable=f"{fname}({p['name']})",
                        context=f"函数 {fname} 删除参数: {p['name']}（破坏性变更）",
                        confidence="确定",
                    ))

            # 类型变更
            for old_p, new_p in zip(
                [p for p in old_params if p["name"] in new_param_names],
                [p for p in new_params if p["name"] in old_param_names],
            ):
                if old_p.get("annotation") != new_p.get("annotation"):
                    matches.append(PatternMatch(
                        pattern_name="param_type_changed",
                        file_path=file_path,
                        line=new_sig.get("line", 0),
                        variable=f"{fname}({new_p['name']})",
                        context=f"参数 {new_p['name']} 类型变更: "
                                f"{old_p.get('annotation', '无')} → {new_p.get('annotation', '无')}",
                        confidence="确定",
                    ))

        return matches

    @staticmethod
    def _extract_signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> Dict[str, Any]:
        """提取函数签名信息。"""
        params = []
        for arg in node.args.args + node.args.posonlyargs + node.args.kwonlyargs:
            p = {"name": arg.arg}
            if arg.annotation:
                p["annotation"] = ast.unparse(arg.annotation)
            params.append(p)

        # 检查默认值
        defaults = node.args.defaults
        offset = len(node.args.args) - len(defaults)
        for i, d in enumerate(defaults):
            if offset + i < len(params):
                params[offset + i]["default"] = ast.unparse(d) if d else "None"

        return {
            "name": node.name,
            "line": node.lineno,
            "params": params,
            "return_type": ast.unparse(node.returns) if node.returns else None,
        }

    @staticmethod
    def _get_name(node: ast.expr) -> Optional[str]:
        """从 AST 表达式节点提取名称。"""
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            base = PatternMatcher._get_name(node.value)
            return f"{base}.{node.attr}" if base else node.attr
        return None

    @staticmethod
    def _extract_numeric_value(node: ast.expr) -> Optional[Any]:
        """从 AST 表达式节点提取数值字面量（int, float, complex），排除 bool。"""
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float, complex)):
            # Python 中 bool 是 int 的子类，但 True/False 不是数值阈值
            if isinstance(node.value, bool):
                return None
            return node.value
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            inner = PatternMatcher._extract_numeric_value(node.operand)
            if inner is not None:
                return -inner
        return None
