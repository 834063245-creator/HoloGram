"""测试 V3 模式匹配器 (PatternMatcher)。"""

import pytest

from src_python.routing.patterns import (
    PatternMatcher, PatternMatch, FileChange,
    MIGRATION_FILE_PATTERNS, SERIALIZATION_FILE_PATTERNS, CONFIG_FILE_PATTERNS,
    THRESHOLD_VARIABLE_PATTERNS, LLM_PROMPT_VARIABLE_PATTERNS,
    SORT_FILTER_FUNCTION_PATTERNS, RHYTHM_VARIABLE_PATTERNS,
)
from src_python.routing.constraints import DENYLIST_KEYWORDS


# ============================================================
# 文件名匹配
# ============================================================

class TestMigrationFileDetection:
    """L5: 数据库 migration 文件检测。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_detect_migrations_dir(self):
        assert self.pm.is_migration_file("migrations/001_init.py")

    def test_detect_alembic_versions(self):
        assert self.pm.is_migration_file("alembic/versions/abc123def456.py")

    def test_detect_raw_sql(self):
        assert self.pm.is_migration_file("db/schema.sql")

    def test_detect_timestamped_migration(self):
        assert self.pm.is_migration_file("20240101_initial_migration.sql")

    def test_non_migration_file(self):
        assert not self.pm.is_migration_file("main.py")

    def test_non_migration_regular_sql_name(self):
        # 文件名包含 "sql" 但不是真的 migration
        assert not self.pm.is_migration_file("sql_helper.py")

    def test_schema_py(self):
        assert self.pm.is_migration_file("models/schema.py")


class TestSerializationFileDetection:
    """L5: 序列化格式文件检测。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_detect_protobuf(self):
        assert self.pm.is_serialization_file("api/schema.proto")

    def test_detect_flatbuffers(self):
        assert self.pm.is_serialization_file("types.fbs")

    def test_detect_avro(self):
        assert self.pm.is_serialization_file("user.avsc")

    def test_detect_thrift(self):
        assert self.pm.is_serialization_file("service.thrift")

    def test_detect_capnp(self):
        assert self.pm.is_serialization_file("messages.capnp")

    def test_non_serialization_file(self):
        assert not self.pm.is_serialization_file("main.py")
        assert not self.pm.is_serialization_file("config.yaml")


class TestConfigFileDetection:
    """L5: 配置文件检测。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_detect_yaml(self):
        assert self.pm.is_config_file("config.yaml")

    def test_detect_toml(self):
        assert self.pm.is_config_file("pyproject.toml")

    def test_detect_json_config(self):
        assert self.pm.is_config_file("settings.json")

    def test_detect_ini(self):
        assert self.pm.is_config_file("app.ini")

    def test_detect_env_file(self):
        assert self.pm.is_config_file(".env")
        assert self.pm.is_config_file(".env.production")

    def test_detect_settings_py(self):
        assert self.pm.is_config_file("settings.py")

    def test_exclude_package_json(self):
        assert not self.pm.is_config_file("package.json")

    def test_exclude_package_lock(self):
        assert not self.pm.is_config_file("package-lock.json")

    def test_exclude_tsconfig(self):
        assert not self.pm.is_config_file("tsconfig.json")

    def test_detect_config_py(self):
        assert self.pm.is_config_file("config.py")


class TestDocOrTestFileDetection:
    """文档/测试文件检测。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_detect_test_file(self):
        assert self.pm.is_doc_or_test_file("tests/test_main.py")

    def test_detect_test_prefix(self):
        assert self.pm.is_doc_or_test_file("test_utils.py")

    def test_detect_docs_dir(self):
        assert self.pm.is_doc_or_test_file("docs/api.md")

    def test_detect_markdown(self):
        assert self.pm.is_doc_or_test_file("README.md")

    def test_detect_rst(self):
        assert self.pm.is_doc_or_test_file("index.rst")

    def test_non_doc_test_file(self):
        assert not self.pm.is_doc_or_test_file("main.py")


# ============================================================
# 变量名模式匹配
# ============================================================

class TestThresholdVariableMatching:
    """L4: 阈值/超时/限制变量名匹配。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    @pytest.mark.parametrize("var_name", [
        "timeout", "TIMEOUT", "Timeout",
        "interval", "INTERVAL",
        "threshold", "THRESHOLD",
        "ttl", "TTL",
        "delay", "DELAY",
        "limit", "LIMIT",
        "max_retries", "MAX_RETRIES",
        "rate_limit", "RATE_LIMIT",
        "capacity",
        "buffer_size", "BUFFER_SIZE",
        "heartbeat",
        "deadline",
        "expiry", "expiration",
        "max_connections", "max_workers",
        "min_interval",
        # 中文变量名
        "threshold_value",
        "timeout_seconds",
    ])
    def test_matches_threshold(self, var_name):
        assert self.pm.matches_threshold_variable(var_name), \
            f"Expected '{var_name}' to match threshold pattern"

    @pytest.mark.parametrize("var_name", [
        "username", "hostname", "description",
        "count", "name", "email",
    ])
    def test_does_not_match_non_threshold(self, var_name):
        assert not self.pm.matches_threshold_variable(var_name), \
            f"Expected '{var_name}' NOT to match threshold pattern"


class TestLLMPromptVariableMatching:
    """L4: LLM prompt 变量名匹配。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    @pytest.mark.parametrize("var_name", [
        "system_prompt", "SYSTEM_PROMPT",
        "prompt", "PROMPT",
        "template", "TEMPLATE",
        "instruction", "INSTRUCTION",
        "system_message",
        "user_message",
        "assistant_message",
        "few_shot",
        "example_prompt",
        "messages_template",
    ])
    def test_matches_prompt(self, var_name):
        assert self.pm.matches_llm_prompt_variable(var_name)

    @pytest.mark.parametrize("var_name", [
        "username", "file_path", "counter",
    ])
    def test_does_not_match_non_prompt(self, var_name):
        assert not self.pm.matches_llm_prompt_variable(var_name)


class TestSortFilterFunctionMatching:
    """L4: 排序/过滤/评分逻辑匹配。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    @pytest.mark.parametrize("func_name", [
        "sort", "sort_items", "filter_results",
        "rank", "ranking",
        "score",
        "weight", "weighting", "weigh",
        "order", "ordering",
        "relevant", "relevance",
        "prioritize", "priority",
        "recommend",
    ])
    def test_matches_sort_filter(self, func_name):
        assert self.pm.matches_sort_filter_function(func_name)

    @pytest.mark.parametrize("func_name", [
        "main", "calculate", "render", "parse", "validate",
    ])
    def test_does_not_match_regular(self, func_name):
        assert not self.pm.matches_sort_filter_function(func_name)


class TestRhythmVariableMatching:
    """L3: 节律参数匹配。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    @pytest.mark.parametrize("var_name", [
        "interval", "period", "frequency",
        "cron", "cron_expression",
        "schedule", "SCHEDULE",
        "tick", "poll_interval",
        "refresh_interval", "sleep_duration",
    ])
    def test_matches_rhythm(self, var_name):
        assert self.pm.matches_rhythm_variable(var_name)

    @pytest.mark.parametrize("var_name", [
        "username", "file_size", "retry_count",
    ])
    def test_does_not_match_non_rhythm(self, var_name):
        assert not self.pm.matches_rhythm_variable(var_name)


class TestDenylistKeywordMatching:
    """黑名单关键词匹配。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    @pytest.mark.parametrize("name", [
        "password", "api_password", "PASSWORD",
        "secret", "top_secret",
        "token", "auth_token",
        "api_key", "API_KEY",
    ])
    def test_matches_denylist(self, name):
        assert self.pm.matches_denylist_keyword(name)

    @pytest.mark.parametrize("name", [
        "username", "hostname", "count",
    ])
    def test_does_not_match_non_denylist(self, name):
        assert not self.pm.matches_denylist_keyword(name)


# ============================================================
# AST 提取
# ============================================================

class TestNumericExtraction:
    """数值字面量提取。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_extract_integers(self):
        source = "timeout = 30\ninterval = 60\nmax_retries = 3\n"
        nums = self.pm.extract_numeric_assignments(source)
        assert "timeout" in nums
        assert "interval" in nums
        assert "max_retries" in nums
        assert nums["timeout"] == (1, 30)
        assert nums["max_retries"] == (3, 3)

    def test_extract_floats(self):
        source = "threshold = 0.5\nrate = 1.5\n"
        nums = self.pm.extract_numeric_assignments(source)
        assert nums["threshold"] == (1, 0.5)
        assert nums["rate"] == (2, 1.5)

    def test_extract_negatives(self):
        source = "offset = -10\n"
        nums = self.pm.extract_numeric_assignments(source)
        assert nums["offset"] == (1, -10)

    def test_skip_non_numeric(self):
        source = 'name = "hello"\nactive = True\ndata = None\n'
        nums = self.pm.extract_numeric_assignments(source)
        assert "name" not in nums
        assert "active" not in nums  # True is not int/float/complex

    def test_syntax_error_graceful(self):
        source = "this is not valid @@@ python"
        nums = self.pm.extract_numeric_assignments(source)
        assert nums == {}


class TestStringExtraction:
    """字符串字面量提取。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_extract_strings(self):
        source = 'system_prompt = "You are helpful"\nname = "Claude"\n'
        strs = self.pm.extract_string_assignments(source)
        assert "system_prompt" in strs
        assert "name" in strs
        assert strs["system_prompt"] == (1, "You are helpful")

    def test_skip_non_string(self):
        source = "timeout = 30\nflag = True\n"
        strs = self.pm.extract_string_assignments(source)
        assert "timeout" not in strs

    def test_syntax_error_graceful(self):
        source = "invalid @@@ python"
        strs = self.pm.extract_string_assignments(source)
        assert strs == {}


class TestFunctionExtraction:
    """函数/方法定义提取。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_extract_functions(self):
        source = "def foo():\n    pass\n\ndef bar(x):\n    return x\n"
        funcs = self.pm.extract_function_defs(source)
        assert "foo" in funcs
        assert "bar" in funcs
        assert funcs["foo"] == 1

    def test_extract_async_functions(self):
        source = "async def fetch():\n    pass\n"
        funcs = self.pm.extract_function_defs(source)
        assert "fetch" in funcs


class TestClassExtraction:
    """类定义提取。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_extract_class_with_bases(self):
        source = "class Config(BaseModel):\n    host: str\n"
        classes = self.pm.extract_class_defs(source)
        assert "Config" in classes
        assert classes["Config"][1] == ["BaseModel"]

    def test_extract_multiple_bases(self):
        source = "class MyView(APIView, Mixin):\n    pass\n"
        classes = self.pm.extract_class_defs(source)
        assert "MyView" in classes
        assert "APIView" in classes["MyView"][1]
        assert "Mixin" in classes["MyView"][1]


class TestClassFieldExtraction:
    """类字段提取。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_extract_annotated_fields(self):
        source = "class Config(BaseModel):\n    host: str\n    port: int = 8080\n"
        fields = self.pm._extract_class_fields(source, "Config")
        assert "host" in fields
        assert "port" in fields

    def test_skip_private_fields(self):
        source = "class Config:\n    _cache: dict\n    public: str\n"
        fields = self.pm._extract_class_fields(source, "Config")
        assert "public" in fields
        assert "_cache" not in fields

    def test_non_existent_class(self):
        source = "class Foo:\n    x: int\n"
        fields = self.pm._extract_class_fields(source, "Bar")
        assert fields == set()


class TestConfigKeyExtraction:
    """配置 key 引用提取。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_extract_dict_keys(self):
        source = 'config["host"] = "localhost"\nconfig["port"] = 8080\n'
        keys = self.pm.extract_config_keys(source)
        assert "host" in keys
        assert "port" in keys

    def test_extract_os_environ(self):
        source = 'os.environ["API_KEY"]\nos.environ["SECRET"]\n'
        keys = self.pm.extract_config_keys(source)
        assert "API_KEY" in keys
        assert "SECRET" in keys


# ============================================================
# 变更检测
# ============================================================

class TestNumericChangeDetection:
    """数值变更检测。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_detect_numeric_change(self):
        old_src = "timeout = 30\ninterval = 60\n"
        new_src = "timeout = 15\ninterval = 60\n"
        changes = self.pm.detect_numeric_changes(
            old_src, new_src, "test.py",
            variable_filter=self.pm.matches_threshold_variable,
        )
        assert len(changes) == 1
        assert changes[0].variable == "timeout"
        assert changes[0].old_value == "30"
        assert changes[0].new_value == "15"

    def test_no_change_same_values(self):
        old_src = "timeout = 30\n"
        new_src = "timeout = 30\n"
        changes = self.pm.detect_numeric_changes(
            old_src, new_src, "test.py",
            variable_filter=self.pm.matches_threshold_variable,
        )
        assert len(changes) == 0

    def test_filter_excludes_non_matching(self):
        old_src = "timeout = 30\nname = 42\n"
        new_src = "timeout = 15\nname = 99\n"
        changes = self.pm.detect_numeric_changes(
            old_src, new_src, "test.py",
            variable_filter=self.pm.matches_threshold_variable,
        )
        # 只有 timeout 匹配 filter，name 不匹配
        assert len(changes) == 1
        assert changes[0].variable == "timeout"

    def test_missing_source_graceful(self):
        changes = self.pm.detect_numeric_changes(
            None, "timeout = 30\n", "test.py",
            variable_filter=self.pm.matches_threshold_variable,
        )
        assert changes == []


class TestStringChangeDetection:
    """字符串变更检测。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_detect_string_change(self):
        old_src = 'system_prompt = "You are helpful"\n'
        new_src = 'system_prompt = "You are very helpful"\n'
        changes = self.pm.detect_string_changes(
            old_src, new_src, "test.py",
            variable_filter=self.pm.matches_llm_prompt_variable,
        )
        assert len(changes) == 1
        assert changes[0].variable == "system_prompt"

    def test_truncate_long_strings(self):
        long_old = "a" * 100
        long_new = "b" * 100
        old_src = f'system_prompt = "{long_old}"\n'
        new_src = f'system_prompt = "{long_new}"\n'
        changes = self.pm.detect_string_changes(
            old_src, new_src, "test.py",
            variable_filter=self.pm.matches_llm_prompt_variable,
        )
        assert len(changes) == 1
        assert len(changes[0].old_value) <= 83  # 80 + "..."


class TestFunctionChangeDetection:
    """函数变更检测。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_detect_new_function(self):
        old_src = "def foo():\n    pass\n"
        new_src = "def foo():\n    pass\n\ndef bar():\n    pass\n"
        changes = self.pm.detect_function_changes(
            old_src, new_src, "test.py",
        )
        assert any(c.variable == "bar" and c.pattern_name == "function_added"
                   for c in changes)

    def test_filter_by_name(self):
        old_src = "def sort():\n    pass\n"
        new_src = "def sort():\n    pass\n\ndef render():\n    pass\n"
        changes = self.pm.detect_function_changes(
            old_src, new_src, "test.py",
            func_filter=self.pm.matches_sort_filter_function,
        )
        # "sort" already existed, "render" not matched by filter
        assert len(changes) == 0


class TestSignatureChangeDetection:
    """函数签名变更检测。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_detect_required_param_added(self):
        # 注意：Python 语法中必填参数不能在可选参数之后
        # 这里测试新增必填参数的情况
        old_sig = "def foo(a: int, b: str) -> int:\n    pass\n"
        new_sig = "def foo(a: int, b: str, c: float) -> int:\n    pass\n"
        changes = self.pm.detect_signature_changes(old_sig, new_sig, "test.py")
        assert any(s.variable == "foo(c)" and s.pattern_name == "required_param_added"
                   for s in changes)

    def test_detect_optional_param_added(self):
        old_sig = "def foo(a: int) -> None:\n    pass\n"
        new_sig = "def foo(a: int, b: str = 'default') -> None:\n    pass\n"
        changes = self.pm.detect_signature_changes(old_sig, new_sig, "test.py")
        assert any(s.variable == "foo(b)" and s.pattern_name == "optional_param_added"
                   for s in changes)

    def test_detect_param_removed(self):
        old_sig = "def foo(a: int, b: str) -> None:\n    pass\n"
        new_sig = "def foo(a: int) -> None:\n    pass\n"
        changes = self.pm.detect_signature_changes(old_sig, new_sig, "test.py")
        assert any(s.variable == "foo(b)" and s.pattern_name == "param_removed"
                   for s in changes)

    def test_detect_type_change(self):
        old_sig = "def foo(x: int) -> None:\n    pass\n"
        new_sig = "def foo(x: str) -> None:\n    pass\n"
        changes = self.pm.detect_signature_changes(old_sig, new_sig, "test.py")
        assert any(s.pattern_name == "param_type_changed" for s in changes)

    def test_no_change_same_signature(self):
        sig = "def foo(a: int) -> None:\n    pass\n"
        changes = self.pm.detect_signature_changes(sig, sig, "test.py")
        assert changes == []

    def test_skip_self_cls_params(self):
        # self/cls 不标记为 required
        old_sig = "def foo(self, a: int) -> None:\n    pass\n"
        new_sig = "def foo(self, a: int, b: int) -> None:\n    pass\n"
        changes = self.pm.detect_signature_changes(old_sig, new_sig, "test.py")
        # b 没有默认值 → required
        assert any(s.variable == "foo(b)" and s.pattern_name == "required_param_added"
                   for s in changes)


class TestClassFieldChangeDetection:
    """数据结构字段变更检测。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pm = PatternMatcher()

    def test_detect_field_added(self):
        old_cls = "class Config(BaseModel):\n    host: str\n    port: int\n"
        new_cls = "class Config(BaseModel):\n    host: str\n    port: int\n    timeout: int\n"
        changes = self.pm.detect_class_field_changes(old_cls, new_cls, "test.py")
        assert any("timeout" in s.variable and s.pattern_name == "data_field_added"
                   for s in changes)

    def test_detect_field_removed(self):
        old_cls = "class Config(BaseModel):\n    host: str\n    debug: bool\n"
        new_cls = "class Config(BaseModel):\n    host: str\n"
        changes = self.pm.detect_class_field_changes(old_cls, new_cls, "test.py")
        assert any("debug" in s.variable and s.pattern_name == "data_field_removed"
                   for s in changes)

    def test_detect_dataclass_decorator(self):
        old_dc = "@dataclass\nclass Item:\n    name: str\n"
        new_dc = "@dataclass\nclass Item:\n    name: str\n    price: float\n"
        changes = self.pm.detect_class_field_changes(old_dc, new_dc, "test.py")
        assert any("price" in s.variable for s in changes)

    def test_no_change_same_fields(self):
        cls_def = "class Config(BaseModel):\n    host: str\n"
        changes = self.pm.detect_class_field_changes(cls_def, cls_def, "test.py")
        assert changes == []


# ============================================================
# 模式列表完整性检查
# ============================================================

class TestPatternLists:
    """确保所有模式列表非空且可编译。"""

    def test_migration_patterns_non_empty(self):
        assert len(MIGRATION_FILE_PATTERNS) > 0

    def test_serialization_patterns_non_empty(self):
        assert len(SERIALIZATION_FILE_PATTERNS) > 0

    def test_config_patterns_non_empty(self):
        assert len(CONFIG_FILE_PATTERNS) > 0

    def test_threshold_patterns_non_empty(self):
        assert len(THRESHOLD_VARIABLE_PATTERNS) > 0

    def test_llm_prompt_patterns_non_empty(self):
        assert len(LLM_PROMPT_VARIABLE_PATTERNS) > 0

    def test_sort_filter_patterns_non_empty(self):
        assert len(SORT_FILTER_FUNCTION_PATTERNS) > 0

    def test_rhythm_patterns_non_empty(self):
        assert len(RHYTHM_VARIABLE_PATTERNS) > 0

    def test_denylist_keywords_non_empty(self):
        assert len(DENYLIST_KEYWORDS) > 0
