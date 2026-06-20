# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""
端到端测试：通过 subprocess 调用 python -m src_python，模拟真实用户行为。

覆盖：analyze → 输出文件 → MsgPack/JSON 一致 → check → 查询命令 → 错误处理。
"""

import json
import os
import subprocess
import sys
import pytest


def _run(*args, timeout=120, **kwargs):
    """运行 python -m src_python ... 并返回 CompletedProcess。

    Windows 下强制 UTF-8 编码，避免 GBK 解码失败。
    """
    env = os.environ.copy()
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return subprocess.run(
        [sys.executable, "-m", "src_python", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
        **kwargs,
    )


def _make_project(root, files: dict):
    """在 root 下创建文件字典。"""
    for rel_path, content in files.items():
        full = os.path.join(root, rel_path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)


# ============================================================
# analyze — 输出文件
# ============================================================

class TestAnalyzeE2E:
    """python -m src_python analyze <project>"""

    @pytest.fixture
    def project(self, tmp_path):
        p = tmp_path / "proj"
        p.mkdir()
        _make_project(str(p), {
            "pkg/__init__.py": "",
            "pkg/core.py": "def run():\n    return 42\n",
            "pkg/utils.py": "def helper(x):\n    return x + 1\n",
        })
        return str(p)

    def test_analyze_creates_output_files(self, project):
        """analyze 应创建 .json、.hologram 文件。"""
        result = _run("analyze", project)
        assert result.returncode == 0, f"stderr: {result.stderr[:500]}"

        assert os.path.exists(os.path.join(project, "hologram_graph.json"))
        assert os.path.exists(os.path.join(project, "hologram_graph.hologram"))

    def test_analyze_custom_output(self, project, tmp_path):
        """-o 指定输出路径。"""
        out = os.path.join(str(tmp_path), "custom.json")
        result = _run("analyze", project, "-o", out)
        assert result.returncode == 0
        assert os.path.exists(out)

    def test_analyze_missing_root_arg(self):
        """analyze 缺 root 参数应报错。"""
        result = _run("analyze")
        assert result.returncode != 0

    def test_analyze_empty_dir(self, tmp_path):
        """空目录不应崩溃，返回 0 或 1。"""
        result = _run("analyze", str(tmp_path))
        assert result.returncode in (0, 1)


# ============================================================
# 输出文件一致性
# ============================================================

class TestOutputConsistencyE2E:
    """.json 和 .hologram (MsgPack) 内容一致。"""

    @pytest.fixture
    def project(self, tmp_path):
        p = tmp_path / "proj"
        p.mkdir()
        _make_project(str(p), {
            "lib/__init__.py": "",
            "lib/base.py": "class Base:\n    def method(self):\n        pass\n",
            "lib/impl.py": "from .base import Base\nclass Impl(Base):\n    pass\n",
        })
        return str(p)

    def test_json_msgpack_content_equivalent(self, project):
        """analyze 后 .json 和 .hologram 包含等价的图数据。"""
        result = _run("analyze", project)
        assert result.returncode == 0

        json_path = os.path.join(project, "hologram_graph.json")
        msgpack_path = os.path.join(project, "hologram_graph.hologram")

        assert os.path.exists(json_path)
        assert os.path.exists(msgpack_path)

        with open(json_path, "r", encoding="utf-8") as f:
            json_data = json.load(f)

        from src_python.core.graph import Graph
        msgpack_graph = Graph.from_msgpack(msgpack_path)
        msgpack_data = msgpack_graph.to_dict()

        assert json_data["meta"]["node_count"] == msgpack_data["meta"]["node_count"]
        assert json_data["meta"]["edge_count"] == msgpack_data["meta"]["edge_count"]

    def test_msgpack_roundtrip_fidelity(self, project):
        """MsgPack 加载后再序列化，往返一致。"""
        result = _run("analyze", project)
        assert result.returncode == 0

        msgpack_path = os.path.join(project, "hologram_graph.hologram")
        from src_python.core.graph import Graph
        g = Graph.from_msgpack(msgpack_path)
        d = g.to_dict()
        g2 = Graph.from_dict(d)
        assert g2.node_count == g.node_count
        assert g2.edge_count == g.edge_count


# ============================================================
# check
# ============================================================

class TestCheckE2E:
    """python -m src_python check <project>"""

    @pytest.fixture
    def project(self, tmp_path):
        p = tmp_path / "proj"
        p.mkdir()
        _make_project(str(p), {
            "app/__init__.py": "",
            "app/main.py": "def main():\n    return 0\n",
        })
        return str(p)

    def test_check_after_analyze(self, project):
        """analyze 后 check --json 应输出合法结果。"""
        _run("analyze", project)
        result = _run("check", project, "--json")
        assert result.returncode in (0, 1)

        # 尝试解析 stdout 中的 JSON
        output = result.stdout.strip()
        try:
            data = json.loads(output)
            assert "passed" in data
        except json.JSONDecodeError:
            # 可能有日志混入，逐行尝试
            for line in output.split("\n"):
                line = line.strip()
                try:
                    data = json.loads(line)
                    assert "passed" in data
                    break
                except json.JSONDecodeError:
                    continue
            else:
                pytest.fail(f"check --json 输出不可解析: {output[:500]}")

    def test_check_detects_changes(self, project):
        """analyze → 改源码 → check 应响应变更。"""
        _run("analyze", project)

        with open(os.path.join(project, "app", "main.py"), "a", encoding="utf-8") as f:
            f.write("\ndef new_func():\n    return 1\n")

        result = _run("check", project, "--json")
        assert result.returncode in (0, 1)

    def test_check_missing_root_arg(self):
        """check 缺 root 参数应报错。"""
        result = _run("check")
        assert result.returncode != 0


# ============================================================
# 查询命令
# ============================================================

class TestQueryCommandsE2E:
    """neighbors / impact / path 等查询命令。"""

    @pytest.fixture
    def analyzed_project(self, tmp_path):
        p = tmp_path / "proj"
        p.mkdir()
        _make_project(str(p), {
            "mod/__init__.py": "",
            "mod/a.py": "def caller():\n    return callee()\n\ndef callee():\n    return 42\n",
        })
        _run("analyze", str(p))
        return str(p)

    def test_neighbors_by_name(self, analyzed_project):
        """neighbors 按函数名查询。"""
        graph_path = os.path.join(analyzed_project, "hologram_graph.json")
        result = _run("neighbors", "caller", "-g", graph_path)
        assert result.returncode == 0

    def test_neighbors_nonexistent(self, analyzed_project):
        """查询不存在的节点不应崩溃。"""
        graph_path = os.path.join(analyzed_project, "hologram_graph.json")
        result = _run("neighbors", "nonexistent_func_xyz", "-g", graph_path)
        assert result.returncode in (0, 1)

    def test_impact_query(self, analyzed_project):
        """impact 波及分析。"""
        graph_path = os.path.join(analyzed_project, "hologram_graph.json")
        result = _run("impact", "callee", "-g", graph_path, "-d", "3")
        assert result.returncode == 0

    def test_missing_node_arg(self, analyzed_project):
        """缺少必需参数时报错。"""
        graph_path = os.path.join(analyzed_project, "hologram_graph.json")
        result = _run("neighbors", "-g", graph_path)
        assert result.returncode != 0


# ============================================================
# preflight / health
# ============================================================

class TestPreflightHealthE2E:
    """preflight 和 health 命令。"""

    @pytest.fixture
    def project(self, tmp_path):
        p = tmp_path / "proj"
        p.mkdir()
        _make_project(str(p), {
            "src/__init__.py": "",
            "src/core.py": "def main():\n    pass\n",
            "src/lib.py": "from .core import main\n\ndef wrapper():\n    main()\n",
        })
        return str(p)

    def test_preflight_output(self, project):
        """preflight --json 应输出风险报告。"""
        _run("analyze", project)
        result = _run("preflight", project, "--json")
        assert result.returncode == 0

        output = result.stdout.strip()
        try:
            data = json.loads(output)
        except json.JSONDecodeError:
            for line in output.split("\n"):
                line = line.strip()
                try:
                    data = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
            else:
                pytest.fail(f"preflight --json 不可解析: {output[:500]}")

        assert "risk_level" in data
        assert "blast_radius" in data

    def test_health_output(self, project):
        """health --json 应输出健康报告。"""
        _run("analyze", project)
        result = _run("health", project, "--json")
        assert result.returncode == 0

        output = result.stdout.strip()
        try:
            data = json.loads(output)
        except json.JSONDecodeError:
            for line in output.split("\n"):
                line = line.strip()
                try:
                    data = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
            else:
                pytest.fail(f"health --json 不可解析: {output[:500]}")

        assert "health_score" in data
        assert "total_nodes" in data


# ============================================================
# 错误处理
# ============================================================

class TestErrorHandlingE2E:
    """CLI 错误处理：缺参数、错误输入。"""

    def test_analyze_no_args(self):
        """analyze 不带 root 应报错。"""
        result = _run("analyze")
        assert result.returncode != 0

    def test_check_no_args(self):
        """check 不带 root 应报错。"""
        result = _run("check")
        assert result.returncode != 0

    def test_neighbors_no_args(self):
        """neighbors 不带参数应报错。"""
        result = _run("neighbors")
        assert result.returncode != 0

    def test_impact_no_args(self):
        """impact 不带参数应报错。"""
        result = _run("impact")
        assert result.returncode != 0


# ============================================================
# 完整工作流
# ============================================================

class TestFullWorkflowE2E:
    """模拟用户真实操作：analyze → 查询 → 改代码 → check → 再分析。"""

    @pytest.fixture
    def project(self, tmp_path):
        p = tmp_path / "proj"
        p.mkdir()
        _make_project(str(p), {
            "app/__init__.py": "",
            "app/engine.py": (
                "class Engine:\n"
                "    def run(self, data):\n"
                "        return self.process(data)\n"
                "    def process(self, data):\n"
                "        return data * 2\n"
            ),
            "app/utils.py": "def helper(x):\n    return x + 1\n",
        })
        return str(p)

    def test_full_workflow(self, project):
        """analyze → neighbors → 改代码 → check → 再分析 → 节点增长。"""
        graph_path = os.path.join(project, "hologram_graph.json")

        # Step 1: analyze
        r = _run("analyze", project)
        assert r.returncode == 0
        assert os.path.exists(graph_path)

        # Step 2: 加载图验证
        from src_python.core.graph import Graph
        g = Graph.from_json(graph_path)
        node_names = [n.name for n in g.nodes.values()]
        assert len(node_names) >= 2

        # Step 3: neighbors 查询
        r = _run("neighbors", node_names[0], "-g", graph_path)
        assert r.returncode == 0

        # Step 4: 改代码
        with open(os.path.join(project, "app", "engine.py"), "a", encoding="utf-8") as f:
            f.write("\ndef new_method(self):\n    return 0\n")

        # Step 5: check
        r = _run("check", project, "--json")
        assert r.returncode in (0, 1)

        # Step 6: 重新分析，验证节点增长
        r = _run("analyze", project)
        assert r.returncode == 0

        g2 = Graph.from_json(graph_path)
        assert g2.node_count >= g.node_count

    def test_workflow_no_crash_on_empty_project(self, tmp_path):
        """空项目全程不崩溃。"""
        p = tmp_path / "empty_proj"
        p.mkdir()

        r1 = _run("analyze", str(p))
        assert r1.returncode in (0, 1)

        graph_path = os.path.join(str(p), "hologram_graph.json")
        if os.path.exists(graph_path):
            r2 = _run("check", str(p), "--json")
            assert r2.returncode in (0, 1)
