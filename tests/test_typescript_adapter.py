# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""TypeScript/JavaScript 适配器测试 — 覆盖率补全。"""

import pytest
from src_python.adapters.typescript_adapter import TypeScriptAdapter
from src_python.core.graph import Graph, NodeType, EdgeType
from src_python.adapters.base import AdapterResult


class TestTypeScriptAdapter:
    @pytest.fixture
    def adapter(self):
        return TypeScriptAdapter()

    # ── accepts ────────────────────────────────────────

    def test_accepts_ts(self, adapter):
        assert adapter.accept("src/foo.ts")
        assert adapter.accept("bar.tsx")
        assert adapter.accept("lib.js")
        assert adapter.accept("app.jsx")
        assert adapter.accept("config.mjs")

    def test_rejects_non_ts(self, adapter):
        assert not adapter.accept("main.py")
        assert not adapter.accept("lib.rs")
        assert not adapter.accept("README.md")

    # ── 符号提取 ───────────────────────────────────────

    def test_extract_functions(self, adapter):
        src = """
export async function handleRequest(req: Request): Promise<Response> {
    return { status: 'ok' };
}
function validate(input: any) { return input; }
const sanitize = (x: string) => x.trim();
const parse = async (raw: string) => JSON.parse(raw);
"""
        result = adapter.extract_symbols("test.ts", src)
        names = {n.name for n in result.nodes if n.kind == "function"}
        assert "handleRequest" in names
        assert "validate" in names
        assert "sanitize" in names
        assert "parse" in names

    def test_extract_classes(self, adapter):
        src = """
class BaseHandler { handle() {} }
export abstract class ApiHandler extends BaseHandler {
    async process(req: Request): Promise<Response> { return {} as Response; }
}
"""
        result = adapter.extract_symbols("test.ts", src)
        classes = {n.name for n in result.nodes if n.kind == "class"}
        assert "BaseHandler" in classes
        assert "ApiHandler" in classes

    def test_extract_interfaces(self, adapter):
        src = """
export interface RequestHandler {
    handle(req: Request): Response;
}
interface DataStore {
    get(key: string): any;
}
"""
        result = adapter.extract_symbols("test.ts", src)
        ifaces = {n.name for n in result.nodes if n.kind == "interface"}
        assert "RequestHandler" in ifaces
        assert "DataStore" in ifaces

    def test_extract_constants_and_enums(self, adapter):
        src = """
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 5000;
enum Status { ACTIVE, INACTIVE, PENDING }
"""
        result = adapter.extract_symbols("test.ts", src)
        consts = {n.name for n in result.nodes if n.kind == "constant"}
        assert "MAX_RETRIES" in consts
        assert "DEFAULT_TIMEOUT" in consts
        assert "Status" in consts

    def test_module_node_created(self, adapter):
        src = "export const x = 1;"
        result = adapter.extract_symbols("src/utils/helpers.ts", src)
        modules = [n for n in result.nodes if n.kind == "module"]
        assert len(modules) == 1
        assert modules[0].name == "helpers"

    def test_keywords_not_extracted(self, adapter):
        src = """
if (true) return null;
const new = 42;
function for(){}
"""
        result = adapter.extract_symbols("test.ts", src)
        symbols = [n for n in result.nodes if n.kind == "function"]
        names = {n.name for n in symbols}
        assert "if" not in names
        assert "return" not in names
        assert "for" not in names
        # 'new' is keyword, 'const' is keyword
        assert "const" not in names

    # ── 结构边 ─────────────────────────────────────────

    def test_extract_import_edges(self, adapter):
        src = """
import { validate, sanitize } from './utils';
export function handleRequest(req: any) { return validate(req); }
function validate(input: any) { return input; }
function sanitize(x: any) { return x; }
"""
        result = adapter.extract_symbols("test.ts", src)
        import_edges = [e for e in result.edges if e.direction == "import"]
        # import 边从 module node 到被导入符号
        assert len(import_edges) >= 2
        targets = {e.target for e in import_edges}
        node_map = {n.name: n.id for n in result.nodes}
        assert node_map.get("validate") in targets or node_map.get("sanitize") in targets

    def test_extract_inherit_edges(self, adapter):
        src = """
class BaseHandler { handle() {} }
class ApiHandler extends BaseHandler {}
class UserHandler extends BaseHandler {}
"""
        result = adapter.extract_symbols("test.ts", src)
        inherit_edges = [e for e in result.edges if e.direction == "inherit"]
        assert len(inherit_edges) == 2

    def test_extract_implement_edges(self, adapter):
        src = """
interface IHandler { handle(): void; }
interface ILogger { log(msg: string): void; }
class App implements IHandler, ILogger {
    handle() {}
    log(msg: string) {}
}
"""
        result = adapter.extract_symbols("test.ts", src)
        impl_edges = [e for e in result.edges if e.direction == "implement"]
        assert len(impl_edges) == 2

    def test_extract_call_edges(self, adapter):
        src = """
function foo() { bar(); }
function bar() { baz(); }
function baz() {}
"""
        result = adapter.extract_symbols("test.ts", src)
        call_edges = [e for e in result.edges if e.direction == "call"]
        assert len(call_edges) >= 2

    # ── 介质提取 ───────────────────────────────────────

    def test_extract_http_media(self, adapter):
        src = """
async function fetchData() {
    const resp = await fetch('/api/users');
    const data = await resp.json();
    return data;
}
"""
        graph = Graph()
        result = adapter.extract_media("test.ts", src, graph)
        networks = [n for n in result.nodes if n.kind == "network"]
        assert len(networks) >= 1
        # 至少有一个 HTTP 介质
        uris = [n.properties.get("uri", "") for n in networks]
        assert any("/api/users" in u for u in uris)

    def test_extract_file_media(self, adapter):
        src = """
import fs from 'fs';
const data = fs.readFileSync('/path/to/config.json');
fs.writeFile('/tmp/output.json', JSON.stringify(data));
"""
        graph = Graph()
        result = adapter.extract_media("test.ts", src, graph)
        files = [n for n in result.nodes if n.kind == "file"]
        assert len(files) >= 2

    def test_extract_storage_media(self, adapter):
        src = """
localStorage.setItem('token', 'abc123');
const val = sessionStorage.getItem('key');
"""
        graph = Graph()
        result = adapter.extract_media("test.ts", src, graph)
        caches = [n for n in result.nodes if n.kind == "cache"]
        assert len(caches) >= 2

    def test_extract_database_media(self, adapter):
        src = """
const users = await db.find({ active: true });
await db.insert({ name: 'test' });
"""
        graph = Graph()
        result = adapter.extract_media("test.ts", src, graph)
        dbs = [n for n in result.nodes if n.kind == "database"]
        assert len(dbs) >= 1

    def test_no_media_on_clean_source(self, adapter):
        src = "const x = 1 + 2;"
        graph = Graph()
        result = adapter.extract_media("test.ts", src, graph)
        assert len(result.nodes) == 0

    # ── 时间提取 ───────────────────────────────────────

    def test_extract_setinterval(self, adapter):
        src = """
function poll() { console.log('tick'); }
setInterval(poll, 5000);
"""
        graph = Graph()
        # 先添加符号节点
        from src_python.core.graph import Node, NodeType, SymbolKind
        fn = Node("n1", NodeType.SYMBOL, "poll", "test.ts:2", "typescript", SymbolKind.FUNCTION.value)
        graph.add_node(fn)

        result = adapter.extract_temporal("test.ts", src, graph)
        timers = [n for n in result.nodes if n.kind == "timer"]
        assert len(timers) == 1
        assert timers[0].properties.get("interval_sec") == 5.0
        assert timers[0].properties.get("is_daemon") is True

    def test_extract_settimeout(self, adapter):
        src = """
function delayed() { console.log('later'); }
setTimeout(delayed, 2000);
"""
        graph = Graph()
        from src_python.core.graph import Node, NodeType, SymbolKind
        fn = Node("n2", NodeType.SYMBOL, "delayed", "test.ts:2", "typescript", SymbolKind.FUNCTION.value)
        graph.add_node(fn)

        result = adapter.extract_temporal("test.ts", src, graph)
        timers = [n for n in result.nodes if n.kind == "timer"]
        timeout_nodes = [t for t in timers if not t.properties.get("is_daemon", True)]
        # setTimeout → is_daemon=False
        assert any(not (t.properties.get("is_daemon", True)) for t in timers)

    def test_temporal_edges_created(self, adapter):
        src = """
function refresh() { console.log('refresh'); }
setInterval(refresh, 10000);
"""
        graph = Graph()
        from src_python.core.graph import Node, NodeType, SymbolKind
        fn = Node("n3", NodeType.SYMBOL, "refresh", "test.ts:2", "typescript", SymbolKind.FUNCTION.value)
        graph.add_node(fn)

        result = adapter.extract_temporal("test.ts", src, graph)
        edges = [e for e in result.edges if e.type == EdgeType.TEMPORAL]
        assert len(edges) == 1
        assert edges[0].direction == "executes_on"
        assert edges[0].source == "n3"

    def test_no_temporal_on_clean_source(self, adapter):
        src = "function hello() { console.log('hi'); }"
        graph = Graph()
        from src_python.core.graph import Node, NodeType, SymbolKind
        fn = Node("nx", NodeType.SYMBOL, "hello", "test.ts:1", "typescript", SymbolKind.FUNCTION.value)
        graph.add_node(fn)
        result = adapter.extract_temporal("test.ts", src, graph)
        assert len(result.nodes) == 0

    # ── 完整分析流程 ───────────────────────────────────

    def test_full_analyze_flow(self, adapter):
        src = """
import { parse } from './parser';

export function processData(raw: string): string {
    const parsed = parse(raw);
    const resp = fetch('/api/validate', { method: 'POST', body: parsed });
    return parsed;
}

function parse(input: string) { return input.trim(); }

class DataProcessor {
    process() { parse('test'); }
}

setInterval(processData, 60000);
"""
        result = adapter.analyze("test.ts", src)
        assert result.ok

        symbols = [n for n in result.nodes if n.type == NodeType.SYMBOL]
        media = [n for n in result.nodes if n.type == NodeType.MEDIUM]
        temporal = [n for n in result.nodes if n.type == NodeType.TEMPORAL]

        assert len(symbols) >= 4  # module + processData + parse + DataProcessor
        assert len(media) >= 1     # HTTP fetch
        assert len(temporal) >= 1  # setInterval
        assert len(result.edges) >= 2  # import + call

    def test_syntax_error_graceful(self, adapter):
        """语法错误的 TS 文件不应阻断分析——静默跳过。"""
        src = "this is not valid typescript {{{"
        result = adapter.extract_symbols("bad.ts", src)
        # 至少 module 节点会被创建
        modules = [n for n in result.nodes if n.kind == "module"]
        assert len(modules) == 1
