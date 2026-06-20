# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试辅助: 临时项目工厂、图比较、文件操作。"""

import os
import json
import tempfile
import shutil
from pathlib import Path
from typing import List, Tuple, Optional


class TempProject:
    """在临时目录创建微型项目，含 Python/TypeScript/Rust 源文件。

    用法:
        with TempProject() as p:
            p.write("a.py", "def foo(): pass")
            p.write("b.py", "from a import foo")
            graph = analyze(p.root)
    """
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="hg_test_")
        self._files: List[str] = []

    def write(self, relpath: str, content: str) -> str:
        full = os.path.join(self.root, relpath)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
        self._files.append(full)
        return full

    def touch(self, relpath: str) -> None:
        """更新 mtime，模拟文件修改。"""
        full = os.path.join(self.root, relpath)
        os.utime(full, None)

    def delete(self, relpath: str) -> None:
        os.remove(os.path.join(self.root, relpath))

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.cleanup()


def analyze(root: str, changed_files: list = None) -> dict:
    """通过 _analyze_and_output 分析项目，返回 to_dict()。

    changed_files 为 None 时走全量分析，否则走增量模式。
    """
    from src_python.__main__ import _analyze_and_output
    graph = _analyze_and_output(root, changed_files=changed_files)
    return graph.to_dict()


def analyze_cli(root: str, output: str = None) -> dict:
    """通过 cmd_analyze 分析项目，返回 JSON dict。"""
    import argparse
    from src_python.cli import cmd_analyze
    output = output or os.path.join(root, "hologram_graph.json")
    args = argparse.Namespace(root=root, output=output)
    cmd_analyze(args)
    with open(output, "r", encoding="utf-8") as f:
        return json.load(f)


def graph_sizes(d: dict) -> Tuple[int, int]:
    """返回 (node_count, edge_count)。"""
    return len(d.get("nodes", [])), len(d.get("edges", []))


def node_names(d: dict) -> set:
    return {n["name"] for n in d.get("nodes", [])}


def has_coupling(d: dict) -> bool:
    return "coupling" in d.get("meta", {})


def assert_graphs_equal(a: dict, b: dict, ignore_meta_keys: set = None):
    """比较两个 graph dict 的结构等价性（忽略时间戳等可变字段）。"""
    ignore = ignore_meta_keys or {"generated_at"}
    # 比较 meta（忽略时间戳）
    ma = {k: v for k, v in a["meta"].items() if k not in ignore}
    mb = {k: v for k, v in b["meta"].items() if k not in ignore}
    assert ma == mb, f"Meta mismatch: {ma} != {mb}"
    # 比较 nodes
    assert len(a["nodes"]) == len(b["nodes"]), \
        f"Node count mismatch: {len(a['nodes'])} != {len(b['nodes'])}"
    # 比较 edges
    assert len(a["edges"]) == len(b["edges"]), \
        f"Edge count mismatch: {len(a['edges'])} != {len(b['edges'])}"
    # 比较 communities
    assert len(a.get("communities", [])) == len(b.get("communities", []))
