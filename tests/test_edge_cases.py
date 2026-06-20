# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""边界和压力测试。"""

import pytest

from src_python.core.graph import Graph, Node, Edge, NodeType, EdgeType
from src_python.adapters.python_adapter import PythonAdapter


class TestEdgeCasesSymbolExtraction:
    @pytest.fixture
    def adapter(self):
        return PythonAdapter()

    def test_empty_file(self, adapter):
        result = adapter.extract_symbols("empty.py", "")
        # 空文件至少应产生模块节点
        modules = [n for n in result.nodes if n.kind == "module"]
        assert len(modules) == 1

    def test_only_comments_and_whitespace(self, adapter):
        result = adapter.extract_symbols("comments.py", """
# This is a comment
# Another comment

""")
        assert result.ok

    def test_recursive_function(self, adapter):
        source = """
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)
"""
        result = adapter.extract_symbols("rec.py", source)
        funcs = [n for n in result.nodes if n.kind == "function" and "factorial" in n.name]
        assert len(funcs) == 1

    def test_nested_functions(self, adapter):
        source = """
def outer():
    x = 1
    def inner():
        return x + 1
    return inner()
"""
        result = adapter.extract_symbols("nested.py", source)
        funcs = [n for n in result.nodes if n.kind == "function"]
        # outer + inner
        assert len(funcs) >= 2

    def test_lambda(self, adapter):
        source = """
sort_key = lambda x: x.name
"""
        result = adapter.extract_symbols("lambda.py", source)
        assert result.ok

    def test_property_decorator(self, adapter):
        source = """
class MyClass:
    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, v):
        self._value = v
"""
        result = adapter.extract_symbols("prop.py", source)
        funcs = [n for n in result.nodes if n.kind == "function"]
        assert len(funcs) >= 2

    def test_classmethod_staticmethod(self, adapter):
        source = """
class Utils:
    @classmethod
    def from_config(cls, cfg):
        return cls(cfg)

    @staticmethod
    def validate(x):
        return x is not None
"""
        result = adapter.extract_symbols("utils.py", source)
        funcs = [n for n in result.nodes if n.kind == "function"]
        assert len(funcs) >= 2

    def test_inheritance_chain(self, adapter):
        source = """
class A:
    pass
class B(A):
    pass
class C(B):
    pass
"""
        result = adapter.extract_symbols("inherit.py", source)
        classes = [n for n in result.nodes if n.kind == "class"]
        assert len(classes) == 3

    def test_multiple_inheritance(self, adapter):
        source = """
class MixinA:
    pass
class MixinB:
    pass
class Combined(MixinA, MixinB):
    pass
"""
        result = adapter.extract_symbols("multi.py", source)
        classes = [n for n in result.nodes if n.kind == "class"]
        combined = [n for n in classes if "Combined" in n.name]
        assert len(combined) == 1

    def test_try_except_finally(self, adapter):
        source = """
def risky():
    try:
        do_something()
    except ValueError as e:
        log(e)
    except (TypeError, KeyError):
        pass
    else:
        cleanup()
    finally:
        close()
"""
        result = adapter.extract_symbols("try.py", source)
        assert result.ok

    def test_with_statement(self, adapter):
        source = """
def process_file(path):
    with open(path) as f1, open(path + '.bak', 'w') as f2:
        data = f1.read()
        f2.write(data)
"""
        result = adapter.extract_symbols("with.py", source)
        assert result.ok

    def test_comprehensions(self, adapter):
        source = """
def transform(items):
    return [x * 2 for x in items if x > 0]
def make_dict(keys):
    return {k: len(k) for k in keys}
def unique(items):
    return {x for x in items}
"""
        result = adapter.extract_symbols("comp.py", source)
        funcs = [n for n in result.nodes if n.kind == "function"]
        assert len(funcs) == 3

    def test_generator(self, adapter):
        source = """
def fibonacci():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b
"""
        result = adapter.extract_symbols("gen.py", source)
        assert result.ok

    def test_type_hints(self, adapter):
        source = """
from typing import List, Optional, Dict

def process(items: List[str], config: Optional[Dict] = None) -> Dict[str, int]:
    return {item: len(item) for item in items}
"""
        result = adapter.extract_symbols("types.py", source)
        funcs = [n for n in result.nodes if n.kind == "function"]
        assert len(funcs) >= 1


class TestEdgeCasesMedia:
    @pytest.fixture
    def adapter(self):
        return PythonAdapter()

    def test_no_io_calls(self, adapter):
        source = """
def pure_function(x, y):
    return x + y
"""
        g = Graph()
        sym = adapter.extract_symbols("pure.py", source)
        for n in sym.nodes:
            g.add_node(n)
        result = adapter.extract_media("pure.py", source, g)
        # 纯函数不应产生介质节点
        media = [n for n in result.nodes if n.type == NodeType.MEDIUM]
        assert len(media) == 0

    def test_dynamic_filename(self, adapter):
        """f-string 文件名应被标注为动态。"""
        source = """
def log_to_file(name):
    with open(f"{name}.log", "w") as f:
        f.write("log")
"""
        g = Graph()
        sym = adapter.extract_symbols("dynamic.py", source)
        for n in sym.nodes:
            g.add_node(n)
        result = adapter.extract_media("dynamic.py", source, g)
        # 应该生成介质节点（标注 <dynamic_fstring>）
        dynamic_media = [
            n for n in result.nodes
            if n.type == NodeType.MEDIUM and "dynamic" in n.name
        ]
        assert len(dynamic_media) >= 1

    def test_multiple_io_in_one_function(self, adapter):
        source = """
import json
def pipeline():
    with open("input.json") as f:
        data = json.load(f)
    result = process(data)
    with open("output.json", "w") as f:
        json.dump(result, f)
"""
        g = Graph()
        sym = adapter.extract_symbols("multi_io.py", source)
        for n in sym.nodes:
            g.add_node(n)
        result = adapter.extract_media("multi_io.py", source, g)
        file_nodes = [n for n in result.nodes if n.kind == "file"]
        assert len(file_nodes) >= 1


class TestEdgeCasesGraph:
    def test_large_graph_serialization(self):
        """测试大量节点的序列化/反序列化。"""
        g = Graph()
        for i in range(500):
            g.add_node(Node(f"n{i}", NodeType.SYMBOL, f"func_{i}", f"f{i}.py:1", "python", "function"))
        for i in range(0, 500, 2):
            g.add_edge(Edge(f"e{i}", EdgeType.STRUCTURAL, "call", f"n{i}", f"n{i+1}"))

        d = g.to_dict()
        g2 = Graph.from_dict(d)
        assert g2.node_count == 500
        assert g2.edge_count == 250

    def test_duplicate_edge_prevention(self):
        """重复添加同 key 边应被阻止。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "a", "a.py:1", "python", "function"))
        g.add_node(Node("n2", NodeType.SYMBOL, "b", "b.py:1", "python", "function"))

        e1 = Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2")
        e2 = Edge("e1", EdgeType.STRUCTURAL, "call", "n1", "n2")
        assert g.add_edge(e1) is not None
        assert g.add_edge(e2) is None  # 同 ID 拒绝
        assert g.edge_count == 1

    def test_empty_graph_serialization(self):
        g = Graph()
        d = g.to_dict()
        assert d["meta"]["node_count"] == 0
        assert d["meta"]["edge_count"] == 0
        assert d["nodes"] == []
        assert d["edges"] == []

    def test_node_with_unicode_name(self, adapter=None):
        """Unicode 节点名应正确处理。"""
        g = Graph()
        g.add_node(Node("n1", NodeType.SYMBOL, "处理函数", "handler.py:1", "python", "function"))
        g.add_node(Node("n2", NodeType.SYMBOL, "résumé_parser", "parser.py:10", "python", "function"))
        d = g.to_dict()
        g2 = Graph.from_dict(d)
        assert g2.node_count == 2
        names = {n.name for n in g2.nodes.values()}
        assert "处理函数" in names
        assert "résumé_parser" in names


class TestEdgeCasesTemporal:
    @pytest.fixture
    def adapter(self):
        return PythonAdapter()

    def test_no_concurrency(self, adapter):
        source = """
def synchronous():
    return 42
"""
        g = Graph()
        sym = adapter.extract_symbols("sync.py", source)
        for n in sym.nodes:
            g.add_node(n)
        result = adapter.extract_temporal("sync.py", source, g)
        # 无并发模式不应产生时间节点
        temporal = [n for n in result.nodes if n.type == NodeType.TEMPORAL]
        assert len(temporal) == 0

    def test_celery_task(self, adapter):
        source = """
from celery import Celery
app = Celery('tasks')

@app.task
def heavy_computation():
    pass
"""
        g = Graph()
        sym = adapter.extract_symbols("celery_task.py", source)
        for n in sym.nodes:
            g.add_node(n)
        result = adapter.extract_temporal("celery_task.py", source, g)
        # Celery task decorator detection（V1限：装饰器名包含 task）
        assert result.ok
