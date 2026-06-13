"""
约束校验器 — 加载 YAML 配置 + 校验信号是否触碰约束

依赖：signals.py（信号生成）、hologram.constraints.yaml（用户配置）
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .signals import Signal


# ============================================================
# 约束配置默认值
# ============================================================

DEFAULT_CONSTRAINTS = {
    "routing": {
        "l4_silent": True,           # L4 默认路由
        "l3_delayed": True,          # L3 默认路由
        "l2_blast": True,            # L2 默认路由
        "l1_visible": False,         # L1 从不路由
    },
    "thresholds": {
        "blast_radius_max": 20,               # 波及节点上限
        "cross_community_tolerance": 0,        # 跨社区边新增容忍（0 = 任何都路由）
        "api_signature_tolerance": 0,          # 公开 API 签名变更容忍
        "l4_penetration_tolerance": 0,         # L4 穿透新增容忍
        "l4_threshold_change_tolerance": 0,    # 数值阈值变更容忍
    },
    "allowlist": {
        "modules": [],    # 允许 L4 穿透的模块
        "files": [],      # 不触发 L3 路由的文件（如 docs/*.md, tests/*.py）
    },
    "denylist": {
        "keywords": [     # 包含这些关键词的变量变更永远路由
            "password",
            "secret",
            "token",
            "api_key",
            "private_key",
            "credential",
            "authorization",
        ],
    },
}

# Backward-compatible module-level constant (moved from patterns.py)
DENYLIST_KEYWORDS = list(DEFAULT_CONSTRAINTS["denylist"]["keywords"])


# ============================================================
# 约束配置数据模型
# ============================================================

@dataclass
class ConstraintConfig:
    """用户可调的约束配置。"""
    routing: Dict[str, bool] = field(default_factory=lambda: dict(DEFAULT_CONSTRAINTS["routing"]))
    thresholds: Dict[str, int] = field(default_factory=lambda: dict(DEFAULT_CONSTRAINTS["thresholds"]))
    allowlist_modules: List[str] = field(default_factory=list)
    allowlist_files: List[str] = field(default_factory=list)
    denylist_keywords: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "routing": self.routing,
            "thresholds": self.thresholds,
            "allowlist": {
                "modules": self.allowlist_modules,
                "files": self.allowlist_files,
            },
            "denylist": {
                "keywords": self.denylist_keywords,
            },
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> ConstraintConfig:
        routing = {**DEFAULT_CONSTRAINTS["routing"], **(d.get("routing") or {})}
        thresholds = {**DEFAULT_CONSTRAINTS["thresholds"], **(d.get("thresholds") or {})}
        # 兼容两种格式：嵌套 {allowlist: {modules: [...], files: [...]}} 或扁平 {allowlist_modules: [...], ...}
        allowlist = d.get("allowlist") or {}
        if not allowlist and "allowlist_modules" in d:
            allowlist = {"modules": d.get("allowlist_modules") or [], "files": d.get("allowlist_files") or []}
        denylist = d.get("denylist") or {}
        if not denylist and "denylist_keywords" in d:
            denylist = {"keywords": d.get("denylist_keywords") or []}
        return cls(
            routing=routing,
            thresholds=thresholds,
            allowlist_modules=list(allowlist.get("modules") or []),
            allowlist_files=list(allowlist.get("files") or []),
            denylist_keywords=list(denylist.get("keywords") or []),
        )

    @classmethod
    def defaults(cls) -> ConstraintConfig:
        """返回默认配置。"""
        return cls.from_dict(DEFAULT_CONSTRAINTS)


# ============================================================
# 约束校验结果
# ============================================================

@dataclass
class ConstraintViolation:
    """单条约束触碰。"""
    signal: Signal
    constraint_name: str            # 被触碰的约束名
    threshold: Optional[int] = None
    actual_value: Optional[int] = None
    message: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "signal": self.signal.to_dict(),
            "constraint_name": self.constraint_name,
            "threshold": self.threshold,
            "actual_value": self.actual_value,
            "message": self.message,
        }


@dataclass
class ConstraintResult:
    """约束校验的完整结果。"""
    passed: bool                     # 所有约束通过？
    violations: List[ConstraintViolation] = field(default_factory=list)
    passed_checks: List[str] = field(default_factory=list)   # 通过的检查项摘要
    auto_released: bool = False      # 是否自动放行
    config: Optional[ConstraintConfig] = None

    @property
    def violation_count(self) -> int:
        return len(self.violations)

    @property
    def l5_count(self) -> int:
        return sum(1 for v in self.violations if v.signal.level == 5)

    @property
    def l4_count(self) -> int:
        return sum(1 for v in self.violations if v.signal.level == 4)

    @property
    def l3_count(self) -> int:
        return sum(1 for v in self.violations if v.signal.level == 3)

    @property
    def l2_count(self) -> int:
        return sum(1 for v in self.violations if v.signal.level == 2)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "auto_released": self.auto_released,
            "violation_count": self.violation_count,
            "l5_count": self.l5_count,
            "l4_count": self.l4_count,
            "l3_count": self.l3_count,
            "l2_count": self.l2_count,
            "violations": [v.to_dict() for v in self.violations],
            "passed_checks": self.passed_checks,
        }


# ============================================================
# 约束校验器
# ============================================================

class ConstraintChecker:
    """
    约束校验器 — 将信号列表与用户配置的约束阈值进行比对。

    核心逻辑：
      - L5 信号永远路由（即使配置关闭，L5 也不可关闭）
      - L4-L2 信号根据配置决定是否路由
      - L1 信号永不路由
      - allowlist 可豁免特定文件/模块
      - denylist 可强制路由特定关键词
    """

    CONFIG_FILE_NAME = "hologram.constraints.yaml"

    def __init__(self, project_root: str = ""):
        self.project_root = project_root
        self.config = self._load_config(project_root) if project_root else ConstraintConfig.defaults()

    def _load_config(self, project_root: str) -> ConstraintConfig:
        """加载项目根目录的 hologram.constraints.yaml。"""
        config_path = os.path.join(project_root, self.CONFIG_FILE_NAME)
        if not os.path.exists(config_path):
            return ConstraintConfig.defaults()

        try:
            import yaml
        except ImportError:
            # yaml 未安装时回退到默认配置
            import sys
            print(
                "Warning: PyYAML not installed — using default constraints. "
                f"Install PyYAML to use {config_path}.",
                file=sys.stderr,
            )
            return ConstraintConfig.defaults()

        try:
            with open(config_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            return ConstraintConfig.from_dict(data.get("constraints", {}))
        except (yaml.YAMLError, OSError, ValueError) as exc:
            import sys
            print(f"Warning: failed to parse {config_path}: {exc}", file=sys.stderr)
            return ConstraintConfig.defaults()

    def check(self, signals: List[Signal]) -> ConstraintResult:
        """
        对信号列表进行约束校验。

        Args:
            signals: SignalGenerator 产出的所有 L5-L1 信号

        Returns:
            ConstraintResult: 包含是否通过、违规列表、通过检查项
        """
        violations: List[ConstraintViolation] = []
        passed_checks: List[str] = []

        cfg = self.config or ConstraintConfig.defaults()

        # 分类信号
        l5_signals = [s for s in signals if s.level == 5]
        l4_signals = [s for s in signals if s.level == 4]
        l3_signals = [s for s in signals if s.level == 3]
        l2_signals = [s for s in signals if s.level == 2]
        l1_signals = [s for s in signals if s.level == 1]

        # ── L5: 不可逆 — 永远路由，不可关闭，不可 allowlist ──
        for s in l5_signals:
            violations.append(ConstraintViolation(
                signal=s,
                constraint_name="l5_irreversible",
                message=f"L5 不可逆破坏: {s.description}",
            ))

        # ── L4: 静默破坏 ──
        if cfg.routing.get("l4_silent", True):
            for s in l4_signals:
                if self._is_allowlisted(s):
                    passed_checks.append(f"L4 allowlisted: {s.description[:60]}")
                    continue
                # 检查具体阈值
                if s.signal_type == "l4_encapsulation_violation":
                    if cfg.thresholds.get("l4_penetration_tolerance", 0) > 0:
                        # 容忍 N 个穿透新增
                        current_count = sum(
                            1 for vs in violations
                            if vs.signal.signal_type == "l4_encapsulation_violation"
                        )
                        if current_count < cfg.thresholds["l4_penetration_tolerance"]:
                            passed_checks.append(f"L4 penetration within tolerance: {s.description[:60]}")
                            continue
                if s.signal_type == "l4_threshold_change":
                    if cfg.thresholds.get("l4_threshold_change_tolerance", 0) > 0:
                        current_count = sum(
                            1 for vs in violations
                            if vs.signal.signal_type == "l4_threshold_change"
                        )
                        if current_count < cfg.thresholds["l4_threshold_change_tolerance"]:
                            passed_checks.append(f"L4 threshold change within tolerance: {s.description[:60]}")
                            continue
                violations.append(ConstraintViolation(
                    signal=s,
                    constraint_name="l4_silent",
                    message=f"L4 静默破坏: {s.description}",
                ))
        else:
            passed_checks.append(f"L4 routing disabled — {len(l4_signals)} signals suppressed")

        # ── L3: 延迟破坏 ──
        if cfg.routing.get("l3_delayed", True):
            for s in l3_signals:
                if self._is_allowlisted(s):
                    passed_checks.append(f"L3 allowlisted: {s.description[:60]}")
                    continue
                violations.append(ConstraintViolation(
                    signal=s,
                    constraint_name="l3_delayed",
                    message=f"L3 延迟破坏: {s.description}",
                ))
        else:
            passed_checks.append(f"L3 routing disabled — {len(l3_signals)} signals suppressed")

        # ── L2: 波及破坏 ──
        if cfg.routing.get("l2_blast", True):
            for s in l2_signals:
                if self._is_allowlisted(s):
                    passed_checks.append(f"L2 allowlisted: {s.description[:60]}")
                    continue

                # 波及半径阈值检查
                if s.signal_type == "l2_blast_radius":
                    blast_max = cfg.thresholds.get("blast_radius_max", 20)
                    affected = s.details.get("total_affected", 0)
                    if affected <= blast_max:
                        passed_checks.append(
                            f"Blast radius {affected} ≤ {blast_max} — passed"
                        )
                        continue
                    violations.append(ConstraintViolation(
                        signal=s,
                        constraint_name="l2_blast_radius",
                        threshold=blast_max,
                        actual_value=affected,
                        message=f"波及节点 {affected} 超过阈值 {blast_max}: {s.description}",
                    ))
                    continue

                # 跨社区容忍度
                if s.signal_type == "l2_cross_community_edge":
                    tolerance = cfg.thresholds.get("cross_community_tolerance", 0)
                    current = sum(
                        1 for vs in violations
                        if vs.signal.signal_type == "l2_cross_community_edge"
                    )
                    if current < tolerance:
                        passed_checks.append(
                            f"Cross-community edge within tolerance ({current + 1}/{tolerance})"
                        )
                        continue
                    violations.append(ConstraintViolation(
                        signal=s,
                        constraint_name="l2_cross_community",
                        threshold=tolerance,
                        actual_value=current + 1,
                        message=f"跨社区边新增超过容忍度 {tolerance}: {s.description}",
                    ))
                    continue

                # 公开 API 签名变更容忍度
                if s.signal_type == "l2_api_signature_optional":
                    tolerance = cfg.thresholds.get("api_signature_tolerance", 0)
                    current = sum(
                        1 for vs in violations
                        if vs.signal.signal_type == "l2_api_signature_optional"
                    )
                    if current < tolerance:
                        passed_checks.append(
                            f"API signature change within tolerance ({current + 1}/{tolerance})"
                        )
                        continue
                    violations.append(ConstraintViolation(
                        signal=s,
                        constraint_name="l2_api_signature",
                        threshold=tolerance,
                        actual_value=current + 1,
                        message=f"公开 API 签名变更超过容忍度 {tolerance}: {s.description}",
                    ))
                    continue

                violations.append(ConstraintViolation(
                    signal=s,
                    constraint_name="l2_blast",
                    message=f"L2 波及破坏: {s.description}",
                ))
        else:
            passed_checks.append(f"L2 routing disabled — {len(l2_signals)} signals suppressed")

        # ── L1: 可见破坏 — 默认不路由（LLM 可自修复）──
        if cfg.routing.get("l1_visible", False):
            for s in l1_signals:
                violations.append(ConstraintViolation(
                    signal=s,
                    constraint_name="l1_visible",
                    message=f"L1 可见破坏: {s.description}",
                ))
        else:
            passed_checks.append(f"L1 signals suppressed ({len(l1_signals)} visible breakages — LLM can self-repair)")

        # ── Denylist 强制路由 ──
        for s in signals:
            if self._matches_denylist(s):
                already_violated = any(
                    v.signal.file_path == s.file_path and v.signal.line == s.line
                    for v in violations
                )
                if not already_violated:
                    violations.append(ConstraintViolation(
                        signal=s,
                        constraint_name="denylist_keyword",
                        message=f"Denylist keyword matched — forced routing: {s.description}",
                    ))

        # 判断是否全部通过
        passed = len(violations) == 0

        return ConstraintResult(
            passed=passed,
            violations=violations,
            passed_checks=passed_checks,
            auto_released=passed,
            config=cfg,
        )

    def _is_allowlisted(self, signal: Signal) -> bool:
        """检查信号是否被 allowlist 豁免。"""
        cfg = self.config
        if not cfg:
            return False

        # 模块 allowlist
        file_name = os.path.basename(signal.file_path)
        for mod_pattern in cfg.allowlist_modules:
            if file_name == mod_pattern or mod_pattern in signal.file_path:
                return True

        # 文件 allowlist
        for file_pattern in cfg.allowlist_files:
            # 简单的 glob 匹配
            if self._glob_match(file_pattern, signal.file_path):
                return True

        return False

    def _matches_denylist(self, signal: Signal) -> bool:
        """检查信号是否命中 denylist。"""
        cfg = self.config
        if not cfg:
            return False

        for kw in cfg.denylist_keywords:
            if kw.lower() in signal.description.lower():
                return True
            if signal.affected_nodes:
                for node in signal.affected_nodes:
                    if kw.lower() in node.lower():
                        return True
        return False

    @staticmethod
    def _glob_match(pattern: str, path: str) -> bool:
        """简单的 glob 风格匹配（支持 * 通配符）。"""
        import fnmatch
        return fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(os.path.basename(path), pattern)

    @staticmethod
    def generate_default_config(project_root: str) -> str:
        """生成默认的 constraint YAML 配置文件内容。"""
        return """# 全息仓约束配置 — hologram.constraints.yaml
#
# 约束 = 不可逾越的边界。触碰边界 = 路由到人。完全在边界内 = 自动放行。
#
# 修改此文件来定制你的项目的破坏性变更阈值。
# 删除此文件即可恢复默认值。

constraints:
  # ── 路由开关 ──
  # 控制哪些级别的信号路由到人。
  # 注：L5 不可逆破坏永远路由（不可关闭，无需配置项）。
  routing:
    l4_silent: true              # L4 静默破坏默认路由
    l3_delayed: true             # L3 延迟破坏默认路由
    l2_blast: true               # L2 波及破坏默认路由
    l1_visible: false            # L1 可见破坏从不路由

  # ── 阈值 ──
  # 调整"什么程度才算触碰约束"。
  thresholds:
    blast_radius_max: 20         # 波及节点上限
    cross_community_tolerance: 0 # 跨社区边新增容忍（0 = 任何都路由）
    api_signature_tolerance: 0   # 公开 API 签名变更容忍
    l4_penetration_tolerance: 0  # L4 封装穿透新增容忍
    l4_threshold_change_tolerance: 0  # 数值阈值变更容忍

  # ── 白名单 ──
  # 这些模块/文件的变更不触发特定级别的路由。
  allowlist:
    modules:                     # 这些模块允许 L4 穿透（不触发路由）
      # - "legacy_adapter.py"
    files:                       # 这些文件的变更不触发 L3 延迟路由
      - "docs/*.md"
      - "tests/*.py"
      - "*.txt"

  # ── 黑名单 ──
  # 包含这些关键词的变量变更永远路由。
  denylist:
    keywords:
      - "password"
      - "secret"
      - "token"
      - "api_key"
      - "private_key"
      - "credential"
      - "authorization"
"""

    @staticmethod
    def write_default_config(project_root: str) -> str:
        """写入默认配置文件到项目根目录。返回文件路径。"""
        config_path = os.path.join(project_root, ConstraintChecker.CONFIG_FILE_NAME)
        content = ConstraintChecker.generate_default_config(project_root)
        with open(config_path, "w", encoding="utf-8") as f:
            f.write(content)
        return config_path
