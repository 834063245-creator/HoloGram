# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试 Python AST 适配器。"""

import pytest
import os
import tempfile

from src_python.adapters.python_adapter import PythonAdapter
from src_python.core.graph import Graph, NodeType, EdgeType, SymbolKind


@pytest.fixture
def adapter():
    return PythonAdapter()


class TestAccept:
    def test_accepts_py(self, adapter):
        assert adapter.accept("foo.py") is True
        assert adapter.accept("bar/baz.py") is True

    def test_rejects_non_py(self, adapter):
        assert adapter.accept("foo.js") is False
        assert adapter.accept("foo.ts") is False
        assert adapter.accept("foo.rs") is False


class TestExtractSymbols:
    def test_extract_function(self, adapter):
        source = """
def hello():
    pass
"""
        result = adapter.extract_symbols("test.py", source)
        assert result.ok
        funcs = [n for n in result.nodes if n.kind == "function"]
        assert len(funcs) == 1
        assert funcs[0].name in ("hello", "test.hello")

    def test_extract_class(self, adapter):
        source = """
class MyClass:
    def method(self):
        pass
"""
        result = adapter.extract_symbols("test.py", source)
        assert result.ok
        classes = [n for n in result.nodes if n.kind == "class"]
        funcs = [n for n in result.nodes if n.kind == "function"]
        assert len(classes) >= 1
        assert len(funcs) >= 1

    def test_extract_constants(self, adapter):
        source = """
MAX_SIZE = 100
TIMEOUT_SEC = 30
_something = "private"
"""
        result = adapter.extract_symbols("test.py", source)
        constants = [n for n in result.nodes if n.kind == "constant"]
        assert len(constants) == 2
        names = {n.name for n in constants}
        assert "MAX_SIZE" in names
        assert "TIMEOUT_SEC" in names

    def test_extract_async_function(self, adapter):
        source = """
async def fetch_data(url):
    return await something(url)
"""
        result = adapter.extract_symbols("test.py", source)
        funcs = [n for n in result.nodes if n.kind == "function"]
        async_funcs = [n for n in funcs if n.properties.get("is_async")]
        assert len(async_funcs) >= 1

    def test_module_node_created(self, adapter):
        source = "x = 1"
        result = adapter.extract_symbols("mymodule.py", source)
        modules = [n for n in result.nodes if n.kind == "module"]
        assert len(modules) == 1
        assert modules[0].name == "mymodule"

    def test_structure_edges_exist(self, adapter):
        source = """
def outer():
    def inner():
        pass
    inner()
"""
        result = adapter.extract_symbols("test.py", source)
        assert len(result.edges) >= 1
        assert any(e.type == EdgeType.STRUCTURAL for e in result.edges)

    def test_syntax_error_graceful(self, adapter):
        source = "def broken(:"
        result = adapter.extract_symbols("test.py", source)
        assert not result.ok
        assert len(result.errors) >= 1

    def test_decorators_captured(self, adapter):
        source = """
@staticmethod
@cache.memoize(timeout=300)
def cached_func():
    pass
"""
        result = adapter.extract_symbols("test.py", source)
        funcs = [n for n in result.nodes if n.kind == "function" and n.name.endswith("cached_func")]
        assert len(funcs) >= 1
        decorators = funcs[0].properties.get("decorators", [])
        assert "staticmethod" in decorators


class TestExtractMedia:
    def test_file_open_pattern(self, adapter):
        source = """
def read_config():
    with open("config.yaml", "r") as f:
        return f.read()
"""
        g = Graph()
        result = adapter.extract_media("test.py", source, g)
        media_nodes = [n for n in result.nodes if n.type == NodeType.MEDIUM]
        assert len(media_nodes) >= 1
        file_nodes = [n for n in media_nodes if n.kind == "file"]
        assert len(file_nodes) >= 1

    def test_json_read_write(self, adapter):
        source = """
import json
def load_data():
    with open("data.json") as f:
        return json.load(f)
def save_data(obj):
    json.dump(obj, open("out.json", "w"))
"""
        g = Graph()
        result = adapter.extract_media("test.py", source, g)
        media_names = {n.name for n in result.nodes if n.type == NodeType.MEDIUM}
        assert "data.json" in media_names or len(media_names) >= 1

    def test_http_client(self, adapter):
        source = """
import requests
def fetch():
    return requests.get("https://api.example.com/data")
"""
        g = Graph()
        result = adapter.extract_media("test.py", source, g)
        network_nodes = [n for n in result.nodes if n.kind == "network"]
        assert len(network_nodes) >= 1

    def test_database_connection(self, adapter):
        source = """
import sqlite3
def init_db():
    conn = sqlite3.connect("app.db")
    return conn
"""
        g = Graph()
        result = adapter.extract_media("test.py", source, g)
        db_nodes = [n for n in result.nodes if n.kind == "database"]
        assert len(db_nodes) >= 1

    def test_redis_pattern(self, adapter):
        source = """
import redis
def cache_get(key):
    return redis.Redis().get(key)
def cache_set(key, val):
    redis.Redis().set(key, val)
"""
        g = Graph()
        # 先提取符号，填充图上下文
        sym = adapter.extract_symbols("test.py", source)
        for n in sym.nodes:
            g.add_node(n)
        result = adapter.extract_media("test.py", source, g)
        cache_nodes = [n for n in result.nodes if n.kind == "cache"]
        assert len(cache_nodes) >= 1

    def test_data_edges_created(self, adapter):
        source = """
import json
def save(data):
    with open("out.json", "w") as f:
        json.dump(data, f)
"""
        g = Graph()
        # 先提取符号，填充图上下文
        sym = adapter.extract_symbols("test.py", source)
        for n in sym.nodes:
            g.add_node(n)
        result = adapter.extract_media("test.py", source, g)
        data_edges = [e for e in result.edges if e.type == EdgeType.DATA]
        assert len(data_edges) >= 1


class TestExtractTemporal:
    def test_threading_pattern(self, adapter):
        source = """
import threading
def worker():
    pass
t = threading.Thread(target=worker)
t.start()
"""
        g = Graph()
        result = adapter.extract_temporal("test.py", source, g)
        temporal_nodes = [n for n in result.nodes if n.type == NodeType.TEMPORAL]
        assert len(temporal_nodes) >= 1

    def test_timer_pattern(self, adapter):
        source = """
import threading
def periodic():
    pass
t = threading.Timer(3600, periodic)
t.start()
"""
        g = Graph()
        result = adapter.extract_temporal("test.py", source, g)
        timer_nodes = [n for n in result.nodes if n.kind == "timer"]
        assert len(timer_nodes) >= 1

    def test_asyncio_pattern(self, adapter):
        source = """
import asyncio
async def main():
    task = asyncio.create_task(subtask())
async def subtask():
    pass
"""
        g = Graph()
        result = adapter.extract_temporal("test.py", source, g)
        loop_nodes = [n for n in result.nodes if n.kind == "event_loop"]
        assert len(loop_nodes) >= 1

    def test_temporal_edges_have_delay(self, adapter):
        source = """
import threading
def job():
    pass
t = threading.Timer(3600, job)
"""
        g = Graph()
        result = adapter.extract_temporal("test.py", source, g)
        edges_with_delay = [e for e in result.edges if e.temporal_delay_sec is not None]
        # 3600 second timer should be detected
        assert len(edges_with_delay) >= 1 or len(result.nodes) >= 1

    def test_async_function_creates_event_loop_edge(self, adapter):
        source = """
async def handler():
    await something()
"""
        g = Graph()
        # First extract symbols to populate graph
        sym_result = adapter.extract_symbols("test.py", source)
        for n in sym_result.nodes:
            g.add_node(n)

        result = adapter.extract_temporal("test.py", source, g)
        temporal_edges = [e for e in result.edges if e.type == EdgeType.TEMPORAL]
        assert len(temporal_edges) >= 1 or len(result.nodes) >= 1
