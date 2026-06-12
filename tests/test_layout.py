"""测试布局引擎：社区优先两阶段 3D 布局。

注意: src_python/pipeline/layout.py 尚未实现（PROJECT.md A2 标记为完成但代码未落地）。
当模块可用时这些测试自动激活。
"""

import math
import pytest

pytest.importorskip("src_python.pipeline.layout", reason="pipeline/layout.py not yet implemented")

from src_python.core.graph import Graph, Node, Edge, Community, NodeType, EdgeType
from src_python.pipeline.layout import compute_layout, apply_layout


# ═══════════════════════════════════════════════════════════════
# 退化路径
# ═══════════════════════════════════════════════════════════════

class TestEmptyAndTrivial:
    def test_empty_graph_returns_empty(self):
        g = Graph()
        pos = compute_layout(g)
        assert pos == {}

    def test_single_node_at_origin(self):
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "f", "f.py:1", "python", "function"))
        pos = compute_layout(g)
        assert "n1" in pos
        x, y, z = pos["n1"]
        assert x == 0.0 and y == 0.0 and z == 0.0

    def test_no_edges_fibonacci_sphere(self):
        """无边图 → Fibonacci 球面均匀分布。"""
        g = Graph()
        for i in range(10):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function"))
        pos = compute_layout(g)
        assert len(pos) == 10
        # 所有节点距离原点应在 shell_radius 附近
        shell = max(80, math.sqrt(10) * 5)
        for nid, (x, y, z) in pos.items():
            dist = math.sqrt(x * x + y * y + z * z)
            assert dist > 0, f"node {nid} at origin, expected spread"
            # Fibonacci sphere places nodes on surface; allow some tolerance
            assert dist <= shell * 1.1, f"node {nid} too far: {dist} > {shell * 1.1}"


# ═══════════════════════════════════════════════════════════════
# 无社区 / 单社区 → fallback
# ═══════════════════════════════════════════════════════════════

class TestFallbackLayout:
    def test_no_communities_fr3d(self):
        """无社区检测结果时 → 标准 FR 3D 全图。"""
        g = Graph()
        for i in range(8):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function"))
        # 链式边
        for i in range(7):
            g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", f"n{i}", f"n{i+1}"))
        pos = compute_layout(g)
        assert len(pos) == 8
        # 所有节点有非零坐标
        for nid, (x, y, z) in pos.items():
            dist = math.sqrt(x * x + y * y + z * z)
            assert dist > 0 or (x != 0 or y != 0 or z != 0), \
                f"node {nid} at exact origin, FR should spread it"

    def test_single_community_fallback(self):
        """单社区时退化为 FR 3D 全图。"""
        g = Graph()
        for i in range(6):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function"))
        for i in range(5):
            g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", f"n{i}", f"n{i+1}"))
        g.communities = [Community(id="c0", level=0, label="all", node_ids={f"n{i}" for i in range(6)})]
        pos = compute_layout(g)
        assert len(pos) == 6


# ═══════════════════════════════════════════════════════════════
# 两阶段社区优先布局
# ═══════════════════════════════════════════════════════════════

class TestTwoPhaseLayout:
    def test_two_communities_different_centroids(self):
        """两个社区应有不同的质心位置。"""
        g = Graph()
        # 社区 A: 3 个内部互联节点
        for i in range(3):
            g.add_node(Node(f"a{i}", NodeType.SYMBOL, f"fa{i}", f"a.py:{i+1}", "python", "function",
                           community_id="cA"))
        g.add_edge(Edge("ea01", EdgeType.STRUCTURAL, "call", "a0", "a1"))
        g.add_edge(Edge("ea12", EdgeType.STRUCTURAL, "call", "a1", "a2"))

        # 社区 B: 3 个内部互联节点
        for i in range(3):
            g.add_node(Node(f"b{i}", NodeType.SYMBOL, f"fb{i}", f"b.py:{i+1}", "python", "function",
                           community_id="cB"))
        g.add_edge(Edge("eb01", EdgeType.STRUCTURAL, "call", "b0", "b1"))
        g.add_edge(Edge("eb12", EdgeType.STRUCTURAL, "call", "b1", "b2"))

        g.communities = [
            Community(id="cA", level=0, label="A", node_ids={"a0", "a1", "a2"}),
            Community(id="cB", level=0, label="B", node_ids={"b0", "b1", "b2"}),
        ]

        pos = compute_layout(g)
        assert len(pos) == 6

        # 计算两个社区的质心
        ca = _centroid([pos[n] for n in ["a0", "a1", "a2"]])
        cb = _centroid([pos[n] for n in ["b0", "b1", "b2"]])
        dist = _distance(ca, cb)
        assert dist > 0, "communities should be separated"

    def test_coupled_communities_closer_than_uncoupled(self):
        """跨社区边多的社区对比跨社区边少的社区对更近。"""
        # 三个社区: A, B, C
        # A↔B: 5 条跨社区边 (紧密耦合)
        # A↔C: 1 条跨社区边 (松散耦合)
        # 预期: dist(A,B) < dist(A,C)

        def make_graph():
            g = Graph()
            for label, cid in [("a", "cA"), ("b", "cB"), ("c", "cC")]:
                for i in range(4):
                    g.add_node(Node(f"{label}{i}", NodeType.SYMBOL, f"f{label}{i}",
                                    f"{label}.py:{i+1}", "python", "function",
                                    community_id=cid))
                # 社区内部边
                for i in range(3):
                    g.add_edge(Edge(f"e_{label}_{i}", EdgeType.STRUCTURAL, "call",
                                    f"{label}{i}", f"{label}{i+1}"))
            # A↔B: 5 条跨社区边
            for i in range(5):
                g.add_edge(Edge(f"e_ab_{i}", EdgeType.STRUCTURAL, "call",
                                f"a{i % 4}", f"b{i % 4}"))
            # A↔C: 1 条跨社区边
            g.add_edge(Edge("e_ac_0", EdgeType.STRUCTURAL, "call", "a0", "c0"))

            g.communities = [
                Community(id="cA", level=0, label="A", node_ids={f"a{i}" for i in range(4)}),
                Community(id="cB", level=0, label="B", node_ids={f"b{i}" for i in range(4)}),
                Community(id="cC", level=0, label="C", node_ids={f"c{i}" for i in range(4)}),
            ]
            return g

        # 跑多次取平均（随机种子 42，结果确定，但验证设计意图）
        g = make_graph()
        pos = compute_layout(g)

        ca = _centroid([pos[n] for n in ["a0", "a1", "a2", "a3"]])
        cb = _centroid([pos[n] for n in ["b0", "b1", "b2", "b3"]])
        cc = _centroid([pos[n] for n in ["c0", "c1", "c2", "c3"]])

        dist_ab = _distance(ca, cb)
        dist_ac = _distance(ca, cc)

        # FR 3D with weights: stronger weight = more attraction → shorter distance
        assert dist_ab < dist_ac, \
            f"A↔B (5 edges) should be closer than A↔C (1 edge): {dist_ab:.1f} vs {dist_ac:.1f}"

    def test_community_voids(self):
        """社区内部节点间距应远小于社区间距（星座之间有暗区）。"""
        g = Graph()
        comms = []
        for cidx in range(3):
            cid = f"c{cidx}"
            nodes = {f"n{cidx}_{i}" for i in range(4)}
            for i in range(4):
                g.add_node(Node(f"n{cidx}_{i}", NodeType.SYMBOL, f"f{cidx}_{i}",
                                f"mod{cidx}.py:{i+1}", "python", "function",
                                community_id=cid))
            # 内部边
            for i in range(3):
                g.add_edge(Edge(f"e{cidx}_{i}", EdgeType.STRUCTURAL, "call",
                                f"n{cidx}_{i}", f"n{cidx}_{i+1}"))
            comms.append(Community(id=cid, level=0, label=f"C{cidx}", node_ids=nodes))

        # 社区间边：少量连接
        g.add_edge(Edge("x01", EdgeType.STRUCTURAL, "call", "n0_0", "n1_0"))
        g.add_edge(Edge("x12", EdgeType.STRUCTURAL, "call", "n1_3", "n2_3"))

        g.communities = comms
        pos = compute_layout(g)

        # 每个社区内部的平均节点间距
        intra_dists = []
        for comm in comms:
            nids = list(comm.node_ids)
            for i in range(len(nids)):
                for j in range(i + 1, len(nids)):
                    intra_dists.append(_distance(pos[nids[i]], pos[nids[j]]))
        avg_intra = sum(intra_dists) / len(intra_dists)

        # 社区质心间距
        inter_dists = []
        centroids = {c.id: _centroid([pos[n] for n in c.node_ids]) for c in comms}
        cids = list(centroids.keys())
        for i in range(len(cids)):
            for j in range(i + 1, len(cids)):
                inter_dists.append(_distance(centroids[cids[i]], centroids[cids[j]]))
        avg_inter = sum(inter_dists) / len(inter_dists)

        ratio = avg_inter / avg_intra
        assert ratio > 1.5, \
            f"community spacing ({avg_inter:.1f}) should clearly exceed internal spread ({avg_intra:.1f}), ratio={ratio:.1f}"


# ═══════════════════════════════════════════════════════════════
# 边缘情况
# ═══════════════════════════════════════════════════════════════

class TestEdgeCases:
    def test_community_no_internal_edges(self):
        """社区内部无边 → Fibonacci 球面分布。"""
        g = Graph()
        for i in range(5):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function",
                           community_id="c0"))
        g.communities = [
            Community(id="c0", level=0, label="C0", node_ids={f"n{i}" for i in range(5)}),
            Community(id="c1", level=0, label="C1", node_ids={"nx"}),
        ]
        g.add_node(Node("nx", NodeType.SYMBOL, "fx", "fx.py:1", "python", "function",
                        community_id="c1"))
        # 单条跨社区边（避免社区图为无边）
        g.add_edge(Edge("ex", EdgeType.STRUCTURAL, "call", "n0", "nx"))

        pos = compute_layout(g)
        assert len(pos) == 6
        # 所有节点都有坐标
        for nid in ["n0", "n1", "n2", "n3", "n4", "nx"]:
            assert nid in pos

    def test_community_with_single_node(self):
        """单节点社区 → 放在质心位置。"""
        g = Graph()
        for i in range(3):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function",
                           community_id="c0"))
        g.add_node(Node("nx", NodeType.SYMBOL, "fx", "fx.py:1", "python", "function",
                        community_id="c1"))
        g.add_edge(Edge("e01", EdgeType.STRUCTURAL, "call", "n0", "n1"))
        g.add_edge(Edge("e12", EdgeType.STRUCTURAL, "call", "n1", "n2"))
        g.add_edge(Edge("ex", EdgeType.STRUCTURAL, "call", "n0", "nx"))  # 跨社区边

        g.communities = [
            Community(id="c0", level=0, label="C0", node_ids={"n0", "n1", "n2"}),
            Community(id="c1", level=0, label="C1", node_ids={"nx"}),
        ]

        pos = compute_layout(g)
        assert len(pos) == 4
        # 单节点社区 "nx" 被排放
        assert pos["nx"] is not None

    def test_ungrouped_nodes_placed(self):
        """没有 community_id 的节点放在原点附近。"""
        g = Graph()
        for i in range(3):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function",
                           community_id="c0"))
        g.add_node(Node("orphan", NodeType.SYMBOL, "orphan", "orphan.py:1", "python", "function"))
        g.add_edge(Edge("e01", EdgeType.STRUCTURAL, "call", "n0", "n1"))
        g.add_edge(Edge("e12", EdgeType.STRUCTURAL, "call", "n1", "n2"))

        g.communities = [
            Community(id="c0", level=0, label="C0", node_ids={"n0", "n1", "n2"}),
        ]
        # 只有 1 个社区 → fallback FR 3D，但 orphan 也会被包含
        # 此测试验证当有 ≥2 个社区时，未归属节点的处理
        g2 = Graph()
        for i in range(2):
            g2.add_node(Node(f"a{i}", NodeType.SYMBOL, f"fa{i}", f"a.py:{i+1}", "python", "function",
                            community_id="cA"))
        for i in range(2):
            g2.add_node(Node(f"b{i}", NodeType.SYMBOL, f"fb{i}", f"b.py:{i+1}", "python", "function",
                            community_id="cB"))
        g2.add_node(Node("orphan", NodeType.SYMBOL, "orphan", "orphan.py:1", "python", "function"))
        g2.add_edge(Edge("ea", EdgeType.STRUCTURAL, "call", "a0", "a1"))
        g2.add_edge(Edge("eb", EdgeType.STRUCTURAL, "call", "b0", "b1"))
        g2.add_edge(Edge("ex", EdgeType.STRUCTURAL, "call", "a0", "b0"))  # 跨社区

        g2.communities = [
            Community(id="cA", level=0, label="A", node_ids={"a0", "a1"}),
            Community(id="cB", level=0, label="B", node_ids={"b0", "b1"}),
        ]
        pos = compute_layout(g2)
        assert "orphan" in pos, "ungrouped node should still get a position"

    def test_no_cross_community_edges(self):
        """社区间无边 → 质心 Fibonacci 球面分布，内部节点正常。"""
        g = Graph()
        for cidx in range(3):
            cid = f"c{cidx}"
            for i in range(3):
                g.add_node(Node(f"n{cidx}_{i}", NodeType.SYMBOL, f"f{cidx}_{i}",
                                f"mod{cidx}.py:{i+1}", "python", "function",
                                community_id=cid))
            # 仅内部边，无跨社区边
            for i in range(2):
                g.add_edge(Edge(f"e{cidx}_{i}", EdgeType.STRUCTURAL, "call",
                                f"n{cidx}_{i}", f"n{cidx}_{i+1}"))

        g.communities = [
            Community(id=f"c{i}", level=0, label=f"C{i}", node_ids={f"n{i}_0", f"n{i}_1", f"n{i}_2"})
            for i in range(3)
        ]
        pos = compute_layout(g)
        assert len(pos) == 9
        # 三个社区的质心应不同
        centroids = []
        for i in range(3):
            c = _centroid([pos[f"n{i}_0"], pos[f"n{i}_1"], pos[f"n{i}_2"]])
            centroids.append(c)
        for i in range(3):
            for j in range(i + 1, 3):
                assert _distance(centroids[i], centroids[j]) > 0, \
                    "different communities should not share centroid"


# ═══════════════════════════════════════════════════════════════
# 稳定性 & 一致性
# ═══════════════════════════════════════════════════════════════

class TestStability:
    def test_deterministic_layout(self):
        """相同种子 → 相同布局。"""
        def build():
            g = Graph()
            for i in range(6):
                g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function",
                               community_id=f"c{i // 3}"))
            for i in range(5):
                g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", f"n{i}", f"n{i+1}"))
            g.communities = [
                Community(id="c0", level=0, label="C0", node_ids={"n0", "n1", "n2"}),
                Community(id="c1", level=0, label="C1", node_ids={"n3", "n4", "n5"}),
            ]
            return g

        pos1 = compute_layout(build(), seed=42)
        pos2 = compute_layout(build(), seed=42)
        assert pos1 == pos2

    def test_different_seeds_different_layout(self):
        """不同种子可能产生不同布局（至少不应完全一致）。"""
        def build():
            g = Graph()
            for i in range(12):
                g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function",
                               community_id=f"c{i // 4}"))
            for i in range(11):
                g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", f"n{i}", f"n{i+1}"))
            g.communities = [
                Community(id="c0", level=0, label="C0", node_ids={f"n{i}" for i in range(4)}),
                Community(id="c1", level=0, label="C1", node_ids={f"n{i}" for i in range(4, 8)}),
                Community(id="c2", level=0, label="C2", node_ids={f"n{i}" for i in range(8, 12)}),
            ]
            return g

        pos1 = compute_layout(build(), seed=42)
        pos2 = compute_layout(build(), seed=12345)
        # 取第一个节点的坐标——不同种子应产生不同值
        n0_pos1 = pos1["n0"]
        n0_pos2 = pos2["n0"]
        assert n0_pos1 != n0_pos2, \
            f"different seeds should produce different positions, got {n0_pos1} == {n0_pos2}"

    def test_large_community_bigger_radius(self):
        """大社区的节点扩散半径应大于小社区。"""
        g = Graph()
        # 大社区: 8 个节点
        for i in range(8):
            g.add_node(Node(f"big{i}", NodeType.SYMBOL, f"fb{i}", f"big.py:{i+1}", "python", "function",
                           community_id="cBig"))
        for i in range(7):
            g.add_edge(Edge(f"eb{i}", EdgeType.STRUCTURAL, "call", f"big{i}", f"big{i+1}"))
        # 小社区: 3 个节点
        for i in range(3):
            g.add_node(Node(f"small{i}", NodeType.SYMBOL, f"fs{i}", f"small.py:{i+1}", "python", "function",
                           community_id="cSmall"))
        for i in range(2):
            g.add_edge(Edge(f"es{i}", EdgeType.STRUCTURAL, "call", f"small{i}", f"small{i+1}"))
        # 跨社区边
        g.add_edge(Edge("cross", EdgeType.STRUCTURAL, "call", "big0", "small0"))

        g.communities = [
            Community(id="cBig", level=0, label="Big", node_ids={f"big{i}" for i in range(8)}),
            Community(id="cSmall", level=0, label="Small", node_ids={f"small{i}" for i in range(3)}),
        ]
        pos = compute_layout(g)

        big_centroid = _centroid([pos[f"big{i}"] for i in range(8)])
        small_centroid = _centroid([pos[f"small{i}"] for i in range(3)])

        big_spread = max(_distance(pos[f"big{i}"], big_centroid) for i in range(8))
        small_spread = max(_distance(pos[f"small{i}"], small_centroid) for i in range(3))

        assert big_spread > small_spread * 0.8, \
            f"big community spread ({big_spread:.1f}) should not be smaller than small ({small_spread:.1f})"


# ═══════════════════════════════════════════════════════════════
# apply_layout
# ═══════════════════════════════════════════════════════════════

class TestApplyLayout:
    def test_apply_layout_writes_positions(self):
        g = Graph()
        for i in range(4):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"f{i}", f"f{i}.py:1", "python", "function"))
        for i in range(3):
            g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", f"n{i}", f"n{i+1}"))

        count = apply_layout(g)
        assert count == 4
        for nid in ["n0", "n1", "n2", "n3"]:
            node = g.nodes[nid]
            assert node.position is not None
            assert len(node.position) == 3
            assert all(isinstance(v, float) for v in node.position)

    def test_apply_layout_empty(self):
        g = Graph()
        count = apply_layout(g)
        assert count == 0


# ═══════════════════════════════════════════════════════════════
# 工具
# ═══════════════════════════════════════════════════════════════

def _centroid(positions):
    """计算一组坐标的质心。"""
    if not positions:
        return (0.0, 0.0, 0.0)
    n = len(positions)
    sx = sum(p[0] for p in positions)
    sy = sum(p[1] for p in positions)
    sz = sum(p[2] for p in positions)
    return (sx / n, sy / n, sz / n)


def _distance(a, b):
    """两点间欧氏距离。"""
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
