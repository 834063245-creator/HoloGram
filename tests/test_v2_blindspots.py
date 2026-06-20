# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试 V2 边界标注 (Boundary Markers) — SPEC V2 §9。"""

import pytest

from src_python.analysis.blindspots import (
    Boundary, BoundaryDetector, BoundaryType,
)


class TestBoundaryModel:
    """测试边界数据模型。"""

    def test_create_boundary(self):
        b = Boundary(
            id="bnd_0001",
            type=BoundaryType.L4_ENCAPSULATION,
            title="L4 封装穿透: data_sync.py",
            description="12 处私有属性访问",
            related_files=["data_sync.py", "cache_store.py"],
            certainty="确定 — 12 处 _ 开头属性被外部访问",
            uncertainty="不确定 — 是故意的还是意外的？",
            priority=80,
        )
        d = b.to_dict()
        assert d["id"] == "bnd_0001"
        assert d["type"] == "L4_encapsulation_violation"
        assert d["certainty"] == "确定 — 12 处 _ 开头属性被外部访问"

    def test_boundary_to_agent_context(self):
        b = Boundary(
            id="bnd_0001",
            type=BoundaryType.UNLOCKED_CONCURRENT,
            title="无锁并发: cache_store",
            description="3 个线程无锁访问",
            related_files=["cache.py"],
            context={"shared_resource": "cache_store", "threads": ["t1", "t2"]},
        )
        ctx = b.to_agent_context()
        assert "无锁并发" in ctx
        assert "cache_store" in ctx
        assert "t1" in ctx

    def test_certainty_field(self):
        b = Boundary(id="b1", type=BoundaryType.L4_ENCAPSULATION,
                     title="test", description="test")
        assert b.certainty == ""  # default empty
        assert b.uncertainty == ""


class TestBoundaryDetector:
    """测试边界检测器。"""

    @pytest.fixture
    def coupling_result(self):
        return {
            "module_reports": [
                {
                    "module_name": "data_sync", "file_path": "data_sync.py",
                    "l4_count": 12, "l3_count": 3, "l2_count": 5, "l1_count": 10,
                    "l4_violations": [
                        {"line": 142, "access": "cache_store._internal_index"},
                    ],
                    "fragility_score": 1.6,
                },
                {
                    "module_name": "safe_module", "file_path": "safe.py",
                    "l4_count": 0, "l3_count": 0, "l2_count": 2, "l1_count": 5,
                    "l4_violations": [],
                    "fragility_score": 0.2,
                },
            ],
        }

    @pytest.fixture
    def cycle_result(self):
        return {
            "cycles": [
                {
                    "cycle_id": "cycle_001", "length": 5,
                    "nodes": ["n1", "n2", "n3", "n4", "n5"],
                    "node_names": ["api_handler", "shared_cache.db", "query_builder",
                                  "formatter", "LLM_API"],
                    "category": "llm_involved",
                    "degradation_risk": "存在自噬风险",
                },
                {
                    "cycle_id": "cycle_002", "length": 3,
                    "nodes": ["na", "nb", "nc"],
                    "node_names": ["A", "B", "C"],
                    "category": "pure_code",
                    "degradation_risk": None,
                },
            ],
        }

    def test_detect_from_coupling(self, coupling_result):
        detector = BoundaryDetector()
        spots = detector.detect_from_coupling(coupling_result)
        assert len(spots) == 1
        assert spots[0].type == BoundaryType.L4_ENCAPSULATION
        assert "data_sync" in spots[0].title

    def test_detect_from_cycles(self, cycle_result):
        detector = BoundaryDetector()
        spots = detector.detect_from_cycles(cycle_result)
        assert len(spots) == 1
        assert spots[0].type == BoundaryType.LLM_FEEDBACK_LOOP

    def test_filter_all(self, coupling_result, cycle_result):
        detector = BoundaryDetector()
        detector.detect_from_coupling(coupling_result)
        detector.detect_from_cycles(cycle_result)

        all_spots = detector.all()
        assert len(all_spots) == 2

        l4_spots = detector.all("L4")
        assert len(l4_spots) == 1

    def test_get_by_id(self, coupling_result):
        detector = BoundaryDetector()
        detector.detect_from_coupling(coupling_result)

        spot = detector.get("bnd_0001")
        assert spot is not None
        assert spot.type == BoundaryType.L4_ENCAPSULATION

        missing = detector.get("bnd_9999")
        assert missing is None

    def test_boundary_ids_are_unique(self, coupling_result, cycle_result):
        detector = BoundaryDetector()
        detector.detect_from_coupling(coupling_result)
        detector.detect_from_cycles(cycle_result)

        ids = [b.id for b in detector.all()]
        assert len(ids) == len(set(ids))  # all unique
        assert all(id.startswith("bnd_") for id in ids)
