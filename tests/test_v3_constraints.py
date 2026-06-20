# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试 V3 约束校验器 (ConstraintChecker)。"""

import os
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
# Fixtures
# ============================================================

@pytest.fixture
def default_checker():
    """不带项目根目录的 checker，使用默认配置。"""
    return ConstraintChecker()


@pytest.fixture
def temp_project():
    """创建临时项目目录用于加载配置。"""
    with tempfile.TemporaryDirectory() as tmp:
        yield tmp


# ============================================================
# ConstraintConfig 测试
# ============================================================

class TestConstraintConfig:
    """约束配置数据模型。"""

    def test_defaults_routing(self):
        cfg = ConstraintConfig.defaults()
        assert "l5_irreversible" not in cfg.routing  # L5 永远硬编码路由，无配置项
        assert cfg.routing["l4_silent"] is True
        assert cfg.routing["l3_delayed"] is True
        assert cfg.routing["l2_blast"] is True
        assert cfg.routing["l1_visible"] is False

    def test_defaults_thresholds(self):
        cfg = ConstraintConfig.defaults()
        assert cfg.thresholds["blast_radius_max"] == 20
        assert cfg.thresholds["cross_community_tolerance"] == 0
        assert cfg.thresholds["api_signature_tolerance"] == 0
        assert cfg.thresholds["l4_penetration_tolerance"] == 0
        assert cfg.thresholds["l4_threshold_change_tolerance"] == 0

    def test_defaults_denylist(self):
        cfg = ConstraintConfig.defaults()
        assert "password" in cfg.denylist_keywords
        assert "secret" in cfg.denylist_keywords
        assert "token" in cfg.denylist_keywords
        assert "api_key" in cfg.denylist_keywords
        assert "private_key" in cfg.denylist_keywords
        assert "credential" in cfg.denylist_keywords
        assert "authorization" in cfg.denylist_keywords

    def test_from_dict_override(self):
        data = {
            "routing": {"l4_silent": False},
            "thresholds": {"blast_radius_max": 50},
        }
        cfg = ConstraintConfig.from_dict(data)
        assert cfg.routing["l4_silent"] is False
        assert cfg.routing["l3_delayed"] is True  # 未覆写的保持默认
        assert cfg.thresholds["blast_radius_max"] == 50
        assert cfg.thresholds["cross_community_tolerance"] == 0  # 保持默认

    def test_to_dict_roundtrip(self):
        cfg = ConstraintConfig.defaults()
        d = cfg.to_dict()
        cfg2 = ConstraintConfig.from_dict(d)
        assert cfg.routing == cfg2.routing
        assert cfg.thresholds == cfg2.thresholds

    def test_from_dict_with_allowlist_denylist(self):
        data = {
            "allowlist": {
                "modules": ["legacy.py"],
                "files": ["docs/*.md", "tests/*.py"],
            },
            "denylist": {
                "keywords": ["password", "secret"],
            },
        }
        cfg = ConstraintConfig.from_dict(data)
        assert "legacy.py" in cfg.allowlist_modules
        assert "docs/*.md" in cfg.allowlist_files
        assert "password" in cfg.denylist_keywords


# ============================================================
# L5 永远路由
# ============================================================

class TestL5AlwaysRouted:
    """L5 不可逆破坏永远路由，不可关闭。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.checker = ConstraintChecker()
        self.signal = Signal(
            level=5,
            signal_type="l5_db_migration",
            category="migration",
            description="Migration file changed",
            file_path="migrations/001.py",
            line=1,
            confidence="determined",
        )

    def test_l5_routed(self):
        result = self.checker.check([self.signal])
        assert not result.passed
        assert result.l5_count == 1

    def test_l5_not_affected_by_allowlist(self):
        # 即使文件在 allowlist 中，L5 也应该路由
        self.checker.config.allowlist_files = ["migrations/*.py"]
        result = self.checker.check([self.signal])
        assert not result.passed
        assert result.l5_count == 1


# ============================================================
# L4 静默破坏
# ============================================================

class TestL4Routing:
    """L4 静默破坏路由。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.checker = ConstraintChecker()

    def test_l4_threshold_change_routed(self):
        s = Signal(level=4, signal_type="l4_threshold_change",
                   category="threshold",
                   description="timeout changed from 30 to 15",
                   file_path="config.py", line=10,
                   confidence="determined")
        result = self.checker.check([s])
        assert not result.passed
        assert result.l4_count == 1

    def test_l4_encapsulation_routed(self):
        s = Signal(level=4, signal_type="l4_encapsulation_violation",
                   category="encapsulation",
                   description="Access to _private attr",
                   file_path="core.py", line=42,
                   confidence="determined")
        result = self.checker.check([s])
        assert not result.passed

    def test_l4_disabled_in_config(self):
        self.checker.config.routing["l4_silent"] = False
        s = Signal(level=4, signal_type="l4_threshold_change",
                   category="threshold",
                   description="timeout changed",
                   file_path="config.py",
                   confidence="determined")
        result = self.checker.check([s])
        assert result.passed  # L4 routing disabled

    def test_l4_penetration_within_tolerance(self):
        self.checker.config.thresholds["l4_penetration_tolerance"] = 5
        s = Signal(level=4, signal_type="l4_encapsulation_violation",
                   category="encapsulation",
                   description="L4 violation",
                   file_path="core.py",
                   confidence="determined")
        result = self.checker.check([s])
        # 1 < 5 tolerance → passed
        assert result.passed

    def test_l4_can_be_allowlisted(self):
        self.checker.config.allowlist_modules = ["config.py"]
        s = Signal(level=4, signal_type="l4_threshold_change",
                   category="threshold",
                   description="timeout changed",
                   file_path="config.py",
                   confidence="determined")
        result = self.checker.check([s])
        assert result.passed


# ============================================================
# L3 延迟破坏
# ============================================================

class TestL3Routing:
    """L3 延迟破坏路由。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.checker = ConstraintChecker()

    def test_l3_rhythm_change_routed(self):
        s = Signal(level=3, signal_type="l3_rhythm_change",
                   category="rhythm",
                   description="poll_interval changed",
                   file_path="scheduler.py", line=5,
                   confidence="determined")
        result = self.checker.check([s])
        assert not result.passed
        assert result.l3_count == 1

    def test_l3_disabled_in_config(self):
        self.checker.config.routing["l3_delayed"] = False
        s = Signal(level=3, signal_type="l3_rhythm_change",
                   category="rhythm",
                   description="poll_interval changed",
                   file_path="scheduler.py",
                   confidence="determined")
        result = self.checker.check([s])
        assert result.passed

    def test_l3_allowlisted_test_file(self):
        self.checker.config.allowlist_files = ["tests/*.py"]
        s = Signal(level=3, signal_type="l3_thread_created",
                   category="thread",
                   description="Thread created in test",
                   file_path="tests/test_worker.py",
                   confidence="determined")
        result = self.checker.check([s])
        assert result.passed

    def test_l3_allowlisted_docs(self):
        self.checker.config.allowlist_files = ["docs/*.md"]
        s = Signal(level=3, signal_type="l3_rhythm_change",
                   category="rhythm",
                   description="interval changed",
                   file_path="docs/changelog.md",
                   confidence="determined")
        result = self.checker.check([s])
        assert result.passed


# ============================================================
# L2 波及破坏
# ============================================================

class TestL2Routing:
    """L2 波及破坏路由。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.checker = ConstraintChecker()

    def test_l2_blast_within_threshold(self):
        s = Signal(level=2, signal_type="l2_blast_radius",
                   category="blast",
                   description="Blast radius analysis",
                   confidence="determined",
                   details={"total_affected": 15})
        result = self.checker.check([s])
        # 15 <= 20 → passed
        assert result.passed

    def test_l2_blast_exceeds_threshold(self):
        s = Signal(level=2, signal_type="l2_blast_radius",
                   category="blast",
                   description="Blast radius analysis",
                   confidence="determined",
                   details={"total_affected": 25})
        result = self.checker.check([s])
        # 25 > 20 → violation
        assert not result.passed
        assert result.l2_count == 1

    def test_l2_blast_at_exact_threshold(self):
        s = Signal(level=2, signal_type="l2_blast_radius",
                   category="blast",
                   description="Blast radius analysis",
                   confidence="determined",
                   details={"total_affected": 20})
        result = self.checker.check([s])
        # 20 <= 20 → passed
        assert result.passed

    def test_l2_blast_custom_threshold(self):
        self.checker.config.thresholds["blast_radius_max"] = 10
        s = Signal(level=2, signal_type="l2_blast_radius",
                   category="blast",
                   description="Blast radius analysis",
                   confidence="determined",
                   details={"total_affected": 15})
        result = self.checker.check([s])
        assert not result.passed

    def test_l2_cross_community_first_edge(self):
        s = Signal(level=2, signal_type="l2_cross_community_edge",
                   category="cross_community",
                   description="New cross-community edge",
                   confidence="determined")
        result = self.checker.check([s])
        # tolerance=0, first edge → violation
        assert not result.passed

    def test_l2_cross_community_within_tolerance(self):
        self.checker.config.thresholds["cross_community_tolerance"] = 2
        s = Signal(level=2, signal_type="l2_cross_community_edge",
                   category="cross_community",
                   description="New cross-community edge",
                   confidence="determined")
        result = self.checker.check([s])
        # 1 <= 2 tolerance → passed
        assert result.passed

    def test_l2_disabled_in_config(self):
        self.checker.config.routing["l2_blast"] = False
        s = Signal(level=2, signal_type="l2_cross_community_edge",
                   category="cross_community",
                   description="New cross-community edge",
                   confidence="determined")
        result = self.checker.check([s])
        assert result.passed


# ============================================================
# L1 从不路由
# ============================================================

class TestL1NotRouted:
    """L1 可见破坏从不路由。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.checker = ConstraintChecker()

    def test_l1_never_routed(self):
        s = Signal(level=1, signal_type="l1_test_file_changed",
                   category="test",
                   description="Test file changed",
                   file_path="tests/test_x.py",
                   confidence="determined")
        result = self.checker.check([s])
        assert result.passed
        assert result.l5_count == 0
        assert result.l4_count == 0
        assert result.l3_count == 0
        assert result.l2_count == 0

    def test_multiple_l1_still_passes(self):
        signals = [
            Signal(level=1, signal_type="l1_test_file_changed",
                   category="test", description="Test 1",
                   file_path="tests/a.py", confidence="determined"),
            Signal(level=1, signal_type="l1_test_file_changed",
                   category="test", description="Test 2",
                   file_path="tests/b.py", confidence="determined"),
        ]
        result = self.checker.check(signals)
        assert result.passed


# ============================================================
# Denylist 强制路由
# ============================================================

class TestDenylist:
    """黑名单关键词强制路由。"""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.checker = ConstraintChecker()

    def test_denylist_forces_routing(self):
        # 即使是 L1 信号，denylist 关键词也应强制路由
        s = Signal(level=1, signal_type="l1_test_file_changed",
                   category="test",
                   description="password changed in config",
                   file_path="config.py",
                   confidence="determined")
        result = self.checker.check([s])
        assert not result.passed
        assert any(v.constraint_name == "denylist_keyword" for v in result.violations)

    def test_denylist_in_affected_nodes(self):
        s = Signal(level=3, signal_type="l3_rhythm_change",
                   category="rhythm",
                   description="interval changed",
                   file_path="scheduler.py",
                   affected_nodes=["api_key_validator"],
                   confidence="determined")
        result = self.checker.check([s])
        assert not result.passed


# ============================================================
# ConstraintResult 测试
# ============================================================

class TestConstraintResult:
    """约束校验结果数据模型。"""

    def test_passed_result(self):
        r = ConstraintResult(passed=True, auto_released=True)
        assert r.violation_count == 0
        assert r.l5_count == 0
        assert r.l4_count == 0
        assert r.l3_count == 0
        assert r.l2_count == 0

    def test_violated_result(self):
        violations = [
            ConstraintViolation(
                signal=Signal(level=5, signal_type="test", category="test",
                              description="test", confidence="determined"),
                constraint_name="l5_irreversible",
                message="Test violation",
            ),
        ]
        r = ConstraintResult(passed=False, violations=violations)
        assert r.violation_count == 1
        assert r.l5_count == 1
        assert r.l4_count == 0

    def test_to_dict(self):
        r = ConstraintResult(passed=True, auto_released=True,
                             passed_checks=["check1", "check2"])
        d = r.to_dict()
        assert d["passed"] is True
        assert d["auto_released"] is True
        assert len(d["passed_checks"]) == 2


# ============================================================
# 配置文件加载
# ============================================================

class TestConfigFileLoading:
    """YAML 配置文件加载。"""

    def test_load_nonexistent_config(self, temp_project):
        checker = ConstraintChecker(temp_project)
        # 应回退到默认配置
        cfg = checker.config
        assert "l5_irreversible" not in cfg.routing  # 配置中已移除，L5 硬编码
        assert cfg.thresholds["blast_radius_max"] == 20

    def test_write_and_load_default_config(self, temp_project):
        if not _yaml_available:
            pytest.skip("yaml module not installed")
        path = ConstraintChecker.write_default_config(temp_project)
        assert os.path.exists(path)
        assert os.path.basename(path) == "hologram.constraints.yaml"

        # 加载写入的配置
        checker = ConstraintChecker(temp_project)
        cfg = checker.config
        assert "l5_irreversible" not in cfg.routing  # 配置中已移除，L5 硬编码
        assert cfg.thresholds["blast_radius_max"] == 20
        assert "password" in cfg.denylist_keywords

    def test_load_custom_config(self, temp_project):
        """自定义 YAML 配置加载。"""
        if not _yaml_available:
            pytest.skip("yaml module not installed")
        config_path = os.path.join(temp_project, "hologram.constraints.yaml")
        with open(config_path, "w", encoding="utf-8") as f:
            f.write("""
constraints:
  routing:
    l4_silent: false
  thresholds:
    blast_radius_max: 50
  allowlist:
    modules:
      - "legacy.py"
  denylist:
    keywords:
      - "custom_secret"
""")
        checker = ConstraintChecker(temp_project)
        cfg = checker.config
        assert cfg.routing["l4_silent"] is False
        assert cfg.routing["l3_delayed"] is True  # 未覆写的保持默认
        assert cfg.thresholds["blast_radius_max"] == 50
        assert "legacy.py" in cfg.allowlist_modules
        assert "custom_secret" in cfg.denylist_keywords

    def test_generate_default_config_content(self):
        content = ConstraintChecker.generate_default_config("/test")
        assert "constraints:" in content
        assert "L5 不可逆破坏永远路由" in content
        assert "blast_radius_max" in content
        assert "password" in content


# ============================================================
# Glob 匹配
# ============================================================

class TestGlobMatching:
    """allowlist 文件的 glob 匹配。"""

    def test_exact_match(self):
        assert ConstraintChecker._glob_match("config.py", "config.py")

    def test_wildcard_match(self):
        assert ConstraintChecker._glob_match("*.py", "main.py")

    def test_path_wildcard(self):
        assert ConstraintChecker._glob_match("docs/*.md", "docs/api.md")

    def test_non_match(self):
        assert not ConstraintChecker._glob_match("*.py", "README.md")

    def test_allowlist_module_name_match(self):
        checker = ConstraintChecker()
        checker.config.allowlist_modules = ["config.py"]
        s = Signal(level=4, signal_type="l4_threshold_change",
                   category="threshold",
                   description="timeout changed",
                   file_path="/some/path/config.py",
                   confidence="determined")
        assert checker._is_allowlisted(s)
