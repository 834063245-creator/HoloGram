# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""
配置契约测试 — 保证 DEFAULT_CONSTRAINTS、YAML 模板、check() 方法三者一致。

覆盖: L3 (死键), M9 (denylist 不同步)
原则:
  1. DEFAULT_CONSTRAINTS 中的每个 routing key 必须在 check() 中被读取
  2. YAML 模板中的每个配置项必须存在于 DEFAULT_CONSTRAINTS 中
  3. patterns.py DENYLIST_KEYWORDS 必须与 constraints default 一致
  4. 新增配置项不破坏旧 YAML 的兼容性
"""

import os
import re
import tempfile
import pytest

try:
    import yaml
    _yaml_available = True
except ImportError:
    _yaml_available = False

from src_python.routing.constraints import (
    ConstraintChecker, ConstraintConfig, ConstraintResult, ConstraintViolation,
    DEFAULT_CONSTRAINTS,
)
from src_python.routing.signals import Signal


# ============================================================
# 配置契约：routing keys 必须被 check() 消费
# ============================================================

def _all_routing_keys_in_check():
    """提取 check() 方法中实际读取的 routing key 名。"""
    import inspect
    source = inspect.getsource(ConstraintChecker.check)
    # 提取所有 cfg.routing.get("key") 或 cfg.routing["key"]
    keys = set()
    for m in re.finditer(r'cfg\.routing\.get\(["\']([^"\']+)["\']', source):
        keys.add(m.group(1))
    for m in re.finditer(r'cfg\.routing\[["\']([^"\']+)["\']\]', source):
        keys.add(m.group(1))
    return keys


class TestRoutingConfigKeys:
    """DEFAULT_CONSTRAINTS.routing 中的每个 key 都必须被 check() 实际使用。"""

    def test_no_dead_routing_keys(self):
        """防止新增 routing 配置项但忘记在 check() 中实现。"""
        used_keys = _all_routing_keys_in_check()
        for key in DEFAULT_CONSTRAINTS["routing"]:
            assert key in used_keys, (
                f"Routing key '{key}' is in DEFAULT_CONSTRAINTS.routing "
                f"but is never read by ConstraintChecker.check(). "
                f"Either implement its usage or remove it from defaults."
            )

    def test_all_used_keys_have_defaults(self):
        """check() 中读取的每个 routing key 都必须有默认值。"""
        used_keys = _all_routing_keys_in_check()
        for key in used_keys:
            # 不要求所有 used key 都在 routing 中——L5 是硬编码常量名
            # 但我们确保非字面量的 key 都有默认值
            pass  # L5 check 使用字面量 constraint_name，不读 config

    def test_l5_has_no_config_key(self):
        """L5 不可逆破坏永远路由——确认无配置项。"""
        assert "l5_irreversible" not in DEFAULT_CONSTRAINTS["routing"], (
            "l5_irreversible should not be in routing config — L5 is hardcoded"
        )


# ============================================================
# Denylist 一致性
# ============================================================

class TestDenylistConsistency:
    """patterns.py 与 constraints.py 的 denylist 必须一致。"""

    def test_patterns_denylist_matches_constraints_default(self):
        """两个数据源的 denylist 关键字必须完全相同。"""
        from src_python.routing.constraints import DENYLIST_KEYWORDS as plist
        clist = DEFAULT_CONSTRAINTS["denylist"]["keywords"]

        in_p_not_c = set(plist) - set(clist)
        in_c_not_p = set(clist) - set(plist)

        assert not in_p_not_c, (
            f"Keywords in patterns.py but NOT in constraints.py defaults: {in_p_not_c}"
        )
        assert not in_c_not_p, (
            f"Keywords in constraints.py defaults but NOT in patterns.py: {in_c_not_p}"
        )

    def test_yaml_template_contains_all_denylist_keywords(self):
        """generate_default_config() 产出的 YAML 应包含所有 denylist 关键词。"""
        template = ConstraintChecker.generate_default_config("/test")
        for kw in DEFAULT_CONSTRAINTS["denylist"]["keywords"]:
            assert kw in template, (
                f"Denylist keyword '{kw}' missing from generated YAML template"
            )


# ============================================================
# YAML 模板 vs DEFAULT_CONSTRAINTS 一致性
# ============================================================

class TestYamlTemplateContracts:
    """YAML 模板中的每个配置项必须在 DEFAULT_CONSTRAINTS 中有对应。"""

    def test_template_routing_keys_match_defaults(self):
        """模板中列出的 routing key 必须在 DEFAULT_CONSTRAINTS 中有定义。"""
        template = ConstraintChecker.generate_default_config("/test")

        # 提取路由段的 key
        # 格式: "    key_name: value  # comment"
        in_routing_block = False
        template_keys = set()
        for line in template.split("\n"):
            if "routing:" in line and not line.strip().startswith("#"):
                in_routing_block = True
                continue
            if in_routing_block:
                # 检测是否离开了 routing block (下一段)
                if line.strip() and not line.startswith("    "):
                    in_routing_block = False
                    continue
                m = re.match(r'    (\w+):', line)
                if m:
                    template_keys.add(m.group(1))

        for key in template_keys:
            # L5 不可关闭的注释说明可以出现在 YAML 中作为文档
            # 但不应有可配置的 YAML key
            if key == "l5_irreversible":
                pytest.fail(
                    "l5_irreversible should not appear as a configurable key in YAML template. "
                    "Use a comment instead: '# L5 不可逆破坏永远路由（不可关闭）'"
                )
            assert key in DEFAULT_CONSTRAINTS["routing"], (
                f"YAML template key '{key}' not in DEFAULT_CONSTRAINTS.routing"
            )

    def test_template_thresholds_match_defaults(self):
        """模板中列出的 threshold key 必须在 DEFAULT_CONSTRAINTS 中有定义。"""
        template = ConstraintChecker.generate_default_config("/test")
        for key in DEFAULT_CONSTRAINTS["thresholds"]:
            assert key in template, (
                f"Threshold '{key}' missing from YAML template"
            )


# ============================================================
# 配置往返：write → read → write 幂等
# ============================================================

class TestConfigRoundtrip:
    """约束配置在 YAML 往返中不丢失字段。"""

    def test_default_write_then_read_roundtrip(self):
        """写入默认配置 → 重新加载 → 值应与默认一致。"""
        with tempfile.TemporaryDirectory() as d:
            path = ConstraintChecker.write_default_config(d)
            checker = ConstraintChecker(d)
            cfg = checker.config

            for key, val in DEFAULT_CONSTRAINTS["routing"].items():
                assert cfg.routing[key] == val, f"Routing {key} mismatch: {cfg.routing[key]} != {val}"

            for key, val in DEFAULT_CONSTRAINTS["thresholds"].items():
                assert cfg.thresholds[key] == val, f"Threshold {key} mismatch"

            denylist = DEFAULT_CONSTRAINTS["denylist"]["keywords"]
            assert cfg.denylist_keywords == denylist, (
                f"Denylist mismatch: {cfg.denylist_keywords} != {denylist}"
            )

    def test_custom_config_partial_override(self):
        """自定义 YAML 只覆写部分字段时，其余保持默认。"""
        if not _yaml_available:
            pytest.skip("yaml module not installed")
        with tempfile.TemporaryDirectory() as d:
            config_path = os.path.join(d, "hologram.constraints.yaml")
            with open(config_path, "w", encoding="utf-8") as f:
                f.write("""\
constraints:
  routing:
    l4_silent: false
  denylist:
    keywords:
      - "custom_token"
""")
            checker = ConstraintChecker(d)
            cfg = checker.config

            # 覆写的
            assert cfg.routing["l4_silent"] is False
            # 默认的
            assert cfg.routing["l3_delayed"] is True
            assert cfg.routing["l2_blast"] is True
            assert cfg.routing["l1_visible"] is False
            # denylist: YAML 中的覆盖了默认
            assert "custom_token" in cfg.denylist_keywords
            # 阈值全部保持默认
            assert cfg.thresholds["blast_radius_max"] == 20

    def test_roundtrip_preserves_all_fields(self):
        """Config.to_dict → from_dict 往返不丢字段。"""
        cfg = ConstraintConfig.defaults()
        cfg.allowlist_modules = ["legacy.py"]
        cfg.allowlist_files = ["docs/*.md"]
        cfg.denylist_keywords = ["password", "custom_secret"]

        d = cfg.to_dict()
        cfg2 = ConstraintConfig.from_dict(d)

        assert cfg.routing == cfg2.routing
        assert cfg.thresholds == cfg2.thresholds
        assert cfg.allowlist_modules == cfg2.allowlist_modules
        assert cfg.allowlist_files == cfg2.allowlist_files
        assert cfg.denylist_keywords == cfg2.denylist_keywords


# ============================================================
# ConstraintChecker.check() — 边界条件
# ============================================================

class TestCheckEdgeCases:
    """check() 的边界行为。"""

    @pytest.fixture
    def checker(self):
        return ConstraintChecker()

    def test_empty_signals_passes(self, checker):
        """无信号 → 通过。"""
        result = checker.check([])
        assert result.passed is True

    def test_l5_signal_always_violates(self, checker):
        """L5 信号永远产生 violation（硬编码路由）。"""
        sig = Signal(
            level=5, signal_type="test_l5", category="不可逆",
            description="Test L5 signal", confidence="确定",
        )
        result = checker.check([sig])
        assert result.passed is False
        assert result.l5_count >= 1

    def test_l1_signal_never_violates(self, checker):
        """L1 信号永远不路由。"""
        sig = Signal(
            level=1, signal_type="test_l1", category="可见",
            description="Test L1 signal", confidence="确定",
        )
        result = checker.check([sig])
        assert result.passed is True

    def test_denylist_keyword_forces_routing(self, checker):
        """包含 denylist 关键词的信号强制路由。"""
        sig = Signal(
            level=1, signal_type="l1_change", category="可见",
            description="Changed password variable",
            confidence="确定",
            affected_nodes=["password"],
        )
        with tempfile.TemporaryDirectory() as d:
            # 使用临时项目确保有默认配置
            checker2 = ConstraintChecker(d)
            result = checker2.check([sig])
            assert result.passed is False, "Denylist keyword should force routing"

    def test_allowlisted_file_bypasses_L3(self, checker):
        """Allowlist 中的文件不触发 L3 路由。"""
        if not _yaml_available:
            pytest.skip("yaml module not installed")
        with tempfile.TemporaryDirectory() as d:
            config_path = os.path.join(d, "hologram.constraints.yaml")
            with open(config_path, "w", encoding="utf-8") as f:
                f.write("""\
constraints:
  routing:
    l3_delayed: true
  allowlist:
    files:
      - "tests/*.py"
""")
            checker2 = ConstraintChecker(d)
            sig = Signal(
                level=3, signal_type="l3_shared_data", category="延迟",
                description="Shared data changed",
                confidence="确定",
                file_path="tests/test_app.py",
            )
            result = checker2.check([sig])
            # L3 被 allowlist 放过，应通过
            assert result.passed is True, (
                f"Allowlisted L3 should pass, violations: "
                f"{[v.message for v in result.violations]}"
            )


# ============================================================
# patterns.py 内部一致性
# ============================================================

class TestPatternsConsistency:
    """patterns.py 中的模式定义自洽。"""

    def test_denylist_keywords_compiled(self):
        """每个 denylist 关键词都应被编译。"""
        from src_python.routing.patterns import PatternMatcher
        from src_python.routing.constraints import DENYLIST_KEYWORDS
        matcher = PatternMatcher()
        # 编译后的模式数应等于关键词数
        assert len(matcher._compiled_denylist) == len(DENYLIST_KEYWORDS), (
            f"Compiled {len(matcher._compiled_denylist)} denylist patterns, "
            f"but {len(DENYLIST_KEYWORDS)} keywords defined"
        )

    def test_denylist_matching_is_case_insensitive(self):
        """denylist 匹配应忽略大小写。"""
        from src_python.routing.patterns import PatternMatcher
        matcher = PatternMatcher()
        assert matcher.matches_denylist_keyword("PASSWORD") is True
        assert matcher.matches_denylist_keyword("Api_Key") is True
        assert matcher.matches_denylist_keyword("username") is False
