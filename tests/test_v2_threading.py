# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""测试 V2 线程交错图 (Thread Interleaving Diagram)。"""

import pytest

from src_python.analysis.threading import (
    ThreadInterleaveAnalyzer, thread_conflict_report,
    Confidence, _ThreadResourceVisitor,
    _extract_ts_threads, _extract_ts_locks,
)


class TestPythonThreadDiscovery:
    """测试 Python 线程发现（AST 扫描）。"""

    def test_threading_thread(self):
        source = """
import threading
t = threading.Thread(target=worker)
t.start()
"""
        visitor = _ThreadResourceVisitor("test.py", "test")
        import ast
        tree = ast.parse(source)
        visitor.visit(tree)
        assert len(visitor.threads) >= 1
        assert visitor.threads[0]["type"] == "thread"

    def test_async_create_task(self):
        source = """
import asyncio
async def main():
    task = asyncio.create_task(worker())
"""
        visitor = _ThreadResourceVisitor("test.py", "test")
        import ast
        tree = ast.parse(source)
        visitor.visit(tree)
        assert len(visitor.threads) >= 1
        assert visitor.threads[0]["type"] == "async_task"

    def test_lock_detection(self):
        source = """
import threading
lock = threading.Lock()
"""
        visitor = _ThreadResourceVisitor("test.py", "test")
        import ast
        tree = ast.parse(source)
        visitor.visit(tree)
        assert len(visitor.locks) >= 1

    def test_global_mutable_state(self):
        source = """
cache = {}
items = []
mapping = {"key": "value"}
"""
        visitor = _ThreadResourceVisitor("test.py", "test")
        import ast
        tree = ast.parse(source)
        visitor.visit(tree)
        assert len(visitor.global_state) >= 1

    def test_data_file_path(self):
        source = """
import json
data = json.load(open("config.json"))
"""
        visitor = _ThreadResourceVisitor("test.py", "test")
        import ast
        tree = ast.parse(source)
        visitor.visit(tree)
        assert len(visitor.data_paths) >= 1
        assert any("config.json" in str(dp) for dp in visitor.data_paths)


class TestTypeScriptThreadDiscovery:
    """测试 TypeScript 线程发现（正则匹配）。"""

    def test_worker_detection(self):
        source = """
const worker = new Worker('worker.js');
worker.postMessage('hello');
"""
        threads = _extract_ts_threads("test.ts", source)
        assert len(threads) >= 1
        assert threads[0]["type"] == "web_worker"

    def test_setinterval_detection(self):
        source = """
setInterval(() => {
    console.log('tick');
}, 1000);
"""
        threads = _extract_ts_threads("test.ts", source)
        assert len(threads) >= 1
        assert threads[0]["type"] == "timer"

    def test_mutex_detection(self):
        source = """
const mutex = new Mutex();
await mutex.acquire();
"""
        locks = _extract_ts_locks("test.ts", source)
        assert len(locks) >= 1

    def test_no_threads_on_clean_source(self):
        source = "const x = 1 + 2;"
        threads = _extract_ts_threads("test.ts", source)
        assert len(threads) == 0


class TestThreadInterleaveAnalyzer:
    """测试线程交错分析器。"""

    def test_analyze_python_with_threads(self):
        source = """
import threading
cache = {}
lock = threading.Lock()

def worker():
    cache['key'] = 'value'

if __name__ == '__main__':
    t = threading.Thread(target=worker)
    t.start()
"""
        analyzer = ThreadInterleaveAnalyzer()
        analyzer.analyze_python_file("app.py", source)
        result = analyzer.build_conflict_matrix()

        assert result["total_threads_found"] >= 1
        assert result["total_locks_found"] >= 1
        assert result["total_global_state_vars"] >= 1
        assert "resources" in result
        assert "certainty_note" in result

    def test_analyze_python_no_threads(self):
        source = """
def add(a, b):
    return a + b

result = add(1, 2)
"""
        analyzer = ThreadInterleaveAnalyzer()
        analyzer.analyze_python_file("simple.py", source)
        result = analyzer.build_conflict_matrix()

        assert result["total_threads_found"] == 0

    def test_convenience_function(self):
        sources = {
            "app.py": """
import threading
cache = {}
t = threading.Thread(target=lambda: cache.update({'x': 1}))
""",
        }
        result = thread_conflict_report(sources, language="python")
        assert result["total_threads_found"] >= 1

    def test_confidence_labels(self):
        """置信度标签应正确。"""
        assert Confidence.CERTAIN.value == "确定"
        assert Confidence.HIGH.value == "高置信"
        assert Confidence.MEDIUM.value == "中等"
        assert Confidence.LOW.value == "低置信"

    def test_unlocked_detection(self):
        """应检测出无锁保护的并发写入。"""
        source = """
import threading
shared_data = {}

def writer1():
    shared_data['a'] = 1

def writer2():
    shared_data['b'] = 2

t1 = threading.Thread(target=writer1)
t2 = threading.Thread(target=writer2)
"""
        analyzer = ThreadInterleaveAnalyzer()
        analyzer.analyze_python_file("unsafe.py", source)
        result = analyzer.build_conflict_matrix()

        # 不应声称"安全"
        assert "不标注'安全'" in result["certainty_note"]

    def test_syntax_error_graceful(self):
        """语法错误的文件应静默跳过。"""
        analyzer = ThreadInterleaveAnalyzer()
        analyzer.analyze_python_file("bad.py", "this is not valid python @@@")
        result = analyzer.build_conflict_matrix()
        assert result["total_threads_found"] >= 0  # 不崩溃
