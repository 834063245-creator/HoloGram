// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 运行时隐藏依赖合成 — 填充因运行时分派、动态代码和反射而
//! 被静态分析遗漏的 Graph 边。
//!
//! ========================================
//! 覆盖的盲点（README §已知局限）
//! ========================================
//! 1. DI / Reflection（Phase 2 — 10 种语言）：
//!    - Python：`getattr`/`setattr` · Java：`@Autowired`/`@Inject`
//!    - TypeScript：`@Injectable`/`@Inject` · C#：`Assembly.Load`/`Type.GetType`
//!    - Ruby：`send`/`method_missing` · PHP：`ReflectionClass`/`call_user_func`
//!    - Go：`reflect.ValueOf` · Kotlin：`@Inject`/`Koin`
//! 2. 动态导入：
//!    - JS/TS、Python、C#（Assembly.Load）、Ruby（autoload/require）、PHP（require_once）
//! 3. Eval / 动态代码（标记为不可解析）：
//!    - JS/TS、Python、C#（CodeDom）、Ruby（eval/instance_eval）、PHP（eval/create_function）、Rust（proc_macro）
//! 4. 跨语言调用边界：
//!    - 子进程：Py/JS/Java/Go/C#/Ruby/PHP/Kotlin
//!    - HTTP 客户端：Py/JS/Go/C#/Ruby/PHP
//!    - FFI：Python（ctypes）
//!
//! 合成边使用 coupling_depth=3（L3 — 隐藏耦合）或
//! coupling_depth=4（L4 — 不可解析）。所有边 ID 使用 `di_`
//! 前缀，供工具过滤/识别 reflection 边。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Graph, Node, NodeId, NodeKind};
use crate::graph::resolver::infer_language;

/// 管道解析缓存中保存的已解析源码。

mod langs;

/// 管道解析缓存中保存的已解析源码。
pub(crate) type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;


/// 对 Graph 运行所有支持语言的 DI/reflection 检测。
/// 使用 Step 1 的解析缓存以避免重新读取和重新解析文件。
/// 返回新增的合成边数量。
pub fn detect_di_reflection(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    // 将管道发现的文件筛选为仅 JS/TS/Python/Java
    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy();
        let lower = s.to_lowercase();
        if lower.ends_with(".py") || lower.ends_with(".js") || lower.ends_with(".ts")
            || lower.ends_with(".tsx") || lower.ends_with(".java") || lower.ends_with(".cs")
            || lower.ends_with(".rb") || lower.ends_with(".php") || lower.ends_with(".go")
            || lower.ends_with(".kt")
        {
            files.insert(s.replace('\\', "/"));
        }
    }

    // W1: 名称索引 — 消除 find_or_create_di_node 每次调用 4 次全图扫描
    // (kernel 2.49M 节点 × ~500 次调用 → 304.5s)
    let mut index = build_name_index(graph);

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') { file.clone() }
            else { project_root.join(file).to_string_lossy().replace('\\', "/") };

        if let Some((source, _tree_opt)) = parse_cache.get(&abs_key) {
            let source = source.clone();
            if lower.ends_with(".py") { added += langs::detect_python_reflection(graph, &mut index, file, &source); }
            else if lower.ends_with(".java") { added += langs::detect_java_di(graph, &mut index, file, &source); }
            else if lower.ends_with(".cs") { added += langs::detect_cs_di(graph, file, &source); }
            else if lower.ends_with(".rb") { added += langs::detect_ruby_di(graph, file, &source); }
            else if lower.ends_with(".php") { added += langs::detect_php_di(graph, file, &source); }
            else if lower.ends_with(".go") { added += langs::detect_go_di(graph, file, &source); }
            else if lower.ends_with(".kt") { added += langs::detect_kotlin_di(graph, file, &source); }
            else { added += langs::detect_ts_di(graph, &mut index, file, &source); }
        } else {
            let full_path = project_root.join(file);
            if let Ok(source) = std::fs::read_to_string(&full_path) {
                if lower.ends_with(".py") { added += langs::detect_python_reflection(graph, &mut index, file, &source); }
                else if lower.ends_with(".java") { added += langs::detect_java_di(graph, &mut index, file, &source); }
                else if lower.ends_with(".cs") { added += langs::detect_cs_di(graph, file, &source); }
                else if lower.ends_with(".rb") { added += langs::detect_ruby_di(graph, file, &source); }
                else if lower.ends_with(".php") { added += langs::detect_php_di(graph, file, &source); }
                else if lower.ends_with(".go") { added += langs::detect_go_di(graph, file, &source); }
                else if lower.ends_with(".kt") { added += langs::detect_kotlin_di(graph, file, &source); }
                else { added += langs::detect_ts_di(graph, &mut index, file, &source); }
            }
        }
    }

    added
}


pub fn detect_dynamic_imports(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy();
        let lower = s.to_lowercase();
        if lower.ends_with(".py") || lower.ends_with(".js") || lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".mjs")
            || lower.ends_with(".cs") || lower.ends_with(".rb") || lower.ends_with(".php")
        {
            files.insert(s.replace('\\', "/"));
        }
    }

    // W1: 名称索引 — 消除 find_or_create_di_node 全图扫描
    let mut index = build_name_index(graph);

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };

        let source: String;
        let source_ref: &str;
        if let Some((cached_src, _)) = parse_cache.get(&abs_key) {
            source = cached_src.clone();
            source_ref = &source;
        } else {
            let full_path = project_root.join(file);
            match std::fs::read_to_string(&full_path) {
                Ok(s) => { source = s; source_ref = &source; }
                Err(_) => continue,
            }
        }

        if lower.ends_with(".py") {
            added += langs::detect_python_dynamic_import(graph, &mut index, file, source_ref);
        } else if lower.ends_with(".cs") {
            added += langs::detect_cs_dynamic_import(graph, file, source_ref);
        } else if lower.ends_with(".rb") {
            added += langs::detect_ruby_dynamic_import(graph, file, source_ref);
        } else if lower.ends_with(".php") {
            added += langs::detect_php_dynamic_import(graph, file, source_ref);
        } else {
            added += langs::detect_js_ts_dynamic_import(graph, &mut index, file, source_ref);
        }
    }

    added
}


pub(crate) fn is_first_arg_string_literal(call: &tree_sitter::Node, _source: &str) -> bool {
    if let Some(args) = call.child_by_field_name("arguments") {
        let mut ac = args.walk();
        for arg in args.children(&mut ac) {
            let kind = arg.kind();
            if kind == "(" || kind == ")" || kind == "," { continue; }
            return kind == "string" || kind == "template_string";
        }
    }
    false
}

pub(crate) fn find_js_enclosing_func(node: &tree_sitter::Node, source: &str, default_file: &str) -> String {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "function_declaration" | "function_expression"
            | "method_definition" | "arrow_function" => {
                if let Some(name_node) = p.child_by_field_name("name") {
                    return name_node.utf8_text(source.as_bytes()).unwrap_or(default_file).to_string();
                }
                let line = p.start_position().row + 1;
                return format!("<fn@{}:{}>", default_file, line);
            }
            _ => {}
        }
        cur = p.parent();
    }
    format!("<module:{}>", default_file)
}


pub fn detect_eval(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy();
        let lower = s.to_lowercase();
        if lower.ends_with(".py") || lower.ends_with(".js") || lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".mjs")
            || lower.ends_with(".cs") || lower.ends_with(".rb") || lower.ends_with(".php") || lower.ends_with(".rs")
        {
            files.insert(s.replace('\\', "/"));
        }
    }

    // W1: 名称索引 — 消除 find_or_create_di_node 全图扫描
    let mut index = build_name_index(graph);

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };

        let source: String;
        let source_ref: &str;
        if let Some((cached_src, _)) = parse_cache.get(&abs_key) {
            source = cached_src.clone();
            source_ref = &source;
        } else {
            let full_path = project_root.join(file);
            match std::fs::read_to_string(&full_path) {
                Ok(s) => { source = s; source_ref = &source; }
                Err(_) => continue,
            }
        }

        if lower.ends_with(".py") {
            added += langs::detect_python_eval(graph, &mut index, file, source_ref);
        } else if lower.ends_with(".cs") {
            added += langs::detect_cs_eval(graph, file, source_ref);
        } else if lower.ends_with(".rb") {
            added += langs::detect_ruby_eval(graph, file, source_ref);
        } else if lower.ends_with(".php") {
            added += langs::detect_php_eval(graph, file, source_ref);
        } else if lower.ends_with(".rs") {
            added += langs::detect_rust_eval(graph, &mut index, file, source_ref);
        } else {
            added += langs::detect_js_ts_eval(graph, &mut index, file, source_ref);
        }
    }

    added
}


/// 名称 → 节点句柄索引。
///
/// 消除 `find_or_create_di_node` 每次调用最多 4 次全图 O(N) 扫描的
/// 超线性根因(kernel 2.49M 节点 × ~500 次调用 → 304.5s)。
/// 桶内保持 build 时的图遍历序 + 后续创建节点的追加序,
/// 与旧全图扫描的「首个匹配」语义一致。
pub(crate) type NameIndex = HashMap<String, Vec<NodeId>>;

/// 遍历图一次构建名称索引。桶内保持遍历序。
pub(crate) fn build_name_index(graph: &Graph) -> NameIndex {
    let mut index: NameIndex = HashMap::new();
    for (id, node) in graph.nodes_iter() {
        if let Some(h) = NodeId::lookup(id) {
            index.entry(node.name.clone()).or_default().push(h);
        }
    }
    index
}

/// 索引版 `find_or_create_di_node` — 精确/末尾组件匹配均走哈希索引,
/// 只遍历候选(同名节点数,通常 0-3),保留同语言优先语义。
/// 创建占位节点后同步更新索引(检测器只 `add_edge_unchecked` 不直接
/// `add_node`,故索引只在创建处更新即保持一致)。
pub(crate) fn find_or_create_di_node_indexed(
    graph: &mut Graph,
    index: &mut NameIndex,
    name: &str,
    file: &str,
    line: usize,
) -> String {
    let file_lang = infer_language(file);
    // 先尝试精确匹配 — 优先同语言节点
    if let Some(cands) = index.get(name) {
        if let Some(&h) = cands.iter().find(|h| file_lang == infer_language(h.as_str())) {
            return h.into_string();
        }
    }
    // 回退：不限语言的精确匹配（合成标记可能无语言）
    if let Some(cands) = index.get(name) {
        if let Some(&h) = cands.first() {
            return h.into_string();
        }
    }
    // 尝试末尾组件匹配（用于限定名）— 优先同语言
    if let Some(last_part) = name.rsplit('.').next() {
        if last_part != name {
            if let Some(cands) = index.get(last_part) {
                if let Some(&h) = cands.iter().find(|h| file_lang == infer_language(h.as_str())) {
                    return h.into_string();
                }
            }
            // 回退：不限语言的末尾组件匹配
            if let Some(cands) = index.get(last_part) {
                if let Some(&h) = cands.first() {
                    return h.into_string();
                }
            }
        }
    }
    // 创建占位节点
    let node_id = format!("di_syn_{}_{}", file.replace(['.', '/', '\\'], "_"), name);
    let mut node = Node::new(&node_id, name, NodeKind::Symbol);
    node.location = Some(format!("{}:{}", file, line));
    node.properties = serde_json::json!({
        "kind": "synthesized_target",
        "provenance": "di_reflection"
    });
    graph.add_node(node);
    // 索引同步：新占位节点追加到桶尾（与遍历序一致）
    index.entry(name.to_string()).or_default().push(NodeId::new(node_id.clone()));
    node_id
}

/// 旧版全图扫描实现 — 仅供非热点检测器（cs/ruby/php/go/kt/rust/cross-lang）使用。
pub(crate) fn find_or_create_di_node(graph: &mut Graph, name: &str, file: &str, line: usize) -> String {
    let file_lang = infer_language(file);
    // 先尝试精确匹配 — 优先同语言节点
    for (id, node) in graph.nodes_iter() {
        if node.name == name && file_lang == infer_language(id) {
            return id.to_string();
        }
    }
    // 回退：不限语言的精确匹配（合成标记可能无语言）
    for (id, node) in graph.nodes_iter() {
        if node.name == name {
            return id.to_string();
        }
    }
    // 尝试末尾组件匹配（用于限定名）— 优先同语言
    if let Some(last_part) = name.rsplit('.').next() {
        if last_part != name {
            for (id, node) in graph.nodes_iter() {
                if node.name == last_part && file_lang == infer_language(id) {
                    return id.to_string();
                }
            }
            // 回退：不限语言的末尾组件匹配
            for (id, node) in graph.nodes_iter() {
                if node.name == last_part {
                    return id.to_string();
                }
            }
        }
    }
    // 创建占位节点
    let node_id = format!("di_syn_{}_{}", file.replace(['.', '/', '\\'], "_"), name);
    let mut node = Node::new(&node_id, name, NodeKind::Symbol);
    node.location = Some(format!("{}:{}", file, line));
    node.properties = serde_json::json!({
        "kind": "synthesized_target",
        "provenance": "di_reflection"
    });
    graph.add_node(node);
    node_id
}


pub fn detect_cross_lang_calls(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy();
        let lower = s.to_lowercase();
        if lower.ends_with(".py") || lower.ends_with(".js") || lower.ends_with(".ts")
            || lower.ends_with(".tsx") || lower.ends_with(".mjs") || lower.ends_with(".java")
            || lower.ends_with(".go") || lower.ends_with(".rs") || lower.ends_with(".rb")
            || lower.ends_with(".cs") || lower.ends_with(".kt") || lower.ends_with(".php")
        {
            files.insert(s.replace('\\', "/"));
        }
    }

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };

        let source: String;
        let source_ref: &str;
        if let Some((cached_src, _)) = parse_cache.get(&abs_key) {
            source = cached_src.clone();
            source_ref = &source;
        } else {
            let full_path = project_root.join(file);
            match std::fs::read_to_string(&full_path) {
                Ok(s) => { source = s; source_ref = &source; }
                Err(_) => continue,
            }
        }

        if lower.ends_with(".py") {
            added += langs::detect_py_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".js") || lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".mjs") {
            added += langs::detect_js_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".java") {
            added += langs::detect_java_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".go") {
            added += langs::detect_go_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".rb") {
            added += langs::detect_ruby_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".cs") {
            added += langs::detect_cs_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".kt") {
            added += langs::detect_kotlin_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".php") {
            added += langs::detect_php_cross_lang(graph, file, source_ref);
        }
    }

    added
}

// ── Python：subprocess、os.system、ctypes、requests ──


#[cfg(test)]
mod tests {
    use super::*;

    // ── Python 测试 ──

    #[test]
    fn test_detect_getattr_string_literal() {
        let mut g = Graph::new();
        let source = r#"
def connect():
    db = getattr(settings, 'DATABASE_URL')
"#;
        let added = langs::detect_python_reflection(&mut g, &mut NameIndex::new(), "config.py", source);
        assert!(added >= 1, "Should detect getattr with string literal, got {}", added);
    }

    #[test]
    fn test_detect_setattr_string_literal() {
        let mut g = Graph::new();
        let source = r#"
def configure():
    setattr(obj, 'timeout', 30)
"#;
        let added = langs::detect_python_reflection(&mut g, &mut NameIndex::new(), "setup.py", source);
        assert!(added >= 1, "Should detect setattr with string literal, got {}", added);
    }

    #[test]
    fn test_detect_getattr_variable_unresolvable() {
        let mut g = Graph::new();
        let source = r#"
def dynamic_access(obj, attr_name):
    return getattr(obj, attr_name)
"#;
        let added = langs::detect_python_reflection(&mut g, &mut NameIndex::new(), "reflect.py", source);
        // 变量属性 → 不可解析的标记边
        assert!(added >= 1, "Should create unresolvable marker for variable attr, got {}", added);
    }

    #[test]
    fn test_no_reflection_returns_zero() {
        let mut g = Graph::new();
        let source = "def hello():\n    return 42\n";
        let added = langs::detect_python_reflection(&mut g, &mut NameIndex::new(), "plain.py", source);
        assert_eq!(added, 0, "No reflection patterns → 0 edges");
    }

    // ── Java 测试 ──

    #[test]
    fn test_detect_autowired_field() {
        let mut g = Graph::new();
        let source = r#"
public class UserService {
    @Autowired
    private UserRepository userRepo;
}
"#;
        let added = langs::detect_java_di(&mut g, &mut NameIndex::new(), "UserService.java", source);
        assert!(added >= 1, "Should detect @Autowired field, got {}", added);
    }

    #[test]
    fn test_detect_inject_field() {
        let mut g = Graph::new();
        let source = r#"
public class OrderService {
    @Inject
    private PaymentGateway payment;
}
"#;
        let added = langs::detect_java_di(&mut g, &mut NameIndex::new(), "OrderService.java", source);
        assert!(added >= 1, "Should detect @Inject field, got {}", added);
    }

    #[test]
    fn test_no_java_di_returns_zero() {
        let mut g = Graph::new();
        let source = "public class Plain { private int x; }\n";
        let added = langs::detect_java_di(&mut g, &mut NameIndex::new(), "Plain.java", source);
        assert_eq!(added, 0, "No DI annotations → 0 edges");
    }

    // ── TypeScript 测试 ──

    #[test]
    fn test_detect_injectable_class() {
        let mut g = Graph::new();
        let source = r#"
@Injectable()
export class UserService {
    constructor(private repo: UserRepository) {}
}
"#;
        let added = langs::detect_ts_di(&mut g, &mut NameIndex::new(), "user.service.ts", source);
        // 应检测到：Injectable 标记 + 构造函数参数
        assert!(added >= 1, "Should detect @Injectable + constructor DI, got {}", added);
    }

    #[test]
    fn test_detect_inject_decorator_param() {
        let mut g = Graph::new();
        let source = r#"
@Injectable()
export class Worker {
    constructor(@Inject('CONFIG') private config: AppConfig) {}
}
"#;
        let added = langs::detect_ts_di(&mut g, &mut NameIndex::new(), "worker.ts", source);
        assert!(added >= 1, "Should detect @Inject decorated param, got {}", added);
    }

    #[test]
    fn test_no_ts_di_returns_zero() {
        let mut g = Graph::new();
        let source = "class Plain { doStuff() {} }\n";
        let added = langs::detect_ts_di(&mut g, &mut NameIndex::new(), "plain.ts", source);
        assert_eq!(added, 0, "No decorators → 0 edges");
    }

    // ── 集成测试 ──

    #[test]
    fn test_full_di_detection_multi_language() {
        let mut g = Graph::new();
        let py_src = "def init():\n    db = getattr(config, 'DB_HOST')\n";
        let java_src = "public class Svc { @Autowired private Repo r; }\n";
        let ts_src = "@Injectable() export class Svc { constructor(private r: Repo) {} }\n";

        let mut idx = build_name_index(&g);
        let a1 = langs::detect_python_reflection(&mut g, &mut idx, "app.py", py_src);
        let a2 = langs::detect_java_di(&mut g, &mut idx, "Svc.java", java_src);
        let a3 = langs::detect_ts_di(&mut g, &mut idx, "svc.ts", ts_src);

        assert!(a1 >= 1);
        assert!(a2 >= 1);
        assert!(a3 >= 1);
        assert!(g.node_count() >= 5, "Should have multiple synthesized nodes, got {}", g.node_count());
    }

    // ── 动态导入测试 ──

    #[test]
    fn test_detect_js_import_variable() {
        let mut g = Graph::new();
        let source = r#"
async function loadModule(name) {
    const mod = await import(name);
}
"#;
        let added = langs::detect_js_ts_dynamic_import(&mut g, &mut NameIndex::new(), "loader.js", source);
        assert!(added >= 1, "Should detect import(variable), got {}", added);
    }

    #[test]
    fn test_detect_require_variable() {
        let mut g = Graph::new();
        let source = r#"
function loadPlugin(path) {
    const plugin = require(path);
}
"#;
        let added = langs::detect_js_ts_dynamic_import(&mut g, &mut NameIndex::new(), "plugins.js", source);
        assert!(added >= 1, "Should detect require(variable), got {}", added);
    }

    #[test]
    fn test_require_string_literal_not_flagged() {
        let mut g = Graph::new();
        let source = r#"const fs = require('fs');"#;
        let added = langs::detect_js_ts_dynamic_import(&mut g, &mut NameIndex::new(), "app.js", source);
        assert_eq!(added, 0, "require('string') should NOT be flagged — static import");
    }

    #[test]
    fn test_detect_py_import_module() {
        let mut g = Graph::new();
        let source = r#"
def load_plugin(name):
    mod = importlib.import_module(name)
"#;
        let added = langs::detect_python_dynamic_import(&mut g, &mut NameIndex::new(), "loader.py", source);
        assert!(added >= 1, "Should detect importlib.import_module, got {}", added);
    }

    #[test]
    fn test_detect_py_dunder_import() {
        let mut g = Graph::new();
        let source = r#"
def dynamic_load(name):
    return __import__(name)
"#;
        let added = langs::detect_python_dynamic_import(&mut g, &mut NameIndex::new(), "dyn.py", source);
        assert!(added >= 1, "Should detect __import__, got {}", added);
    }

    // ── Eval 测试 ──

    #[test]
    fn test_detect_js_eval() {
        let mut g = Graph::new();
        let source = r#"
function runCode(code) {
    eval(code);
}
"#;
        let added = langs::detect_js_ts_eval(&mut g, &mut NameIndex::new(), "runner.js", source);
        assert!(added >= 1, "Should detect eval(), got {}", added);
    }

    #[test]
    fn test_detect_js_new_function() {
        let mut g = Graph::new();
        let source = r#"
function makeFn(body) {
    return new Function(body);
}
"#;
        let added = langs::detect_js_ts_eval(&mut g, &mut NameIndex::new(), "factory.js", source);
        assert!(added >= 1, "Should detect new Function(), got {}", added);
    }

    #[test]
    fn test_detect_py_eval() {
        let mut g = Graph::new();
        let source = r#"
def run(code):
    eval(code)
"#;
        let added = langs::detect_python_eval(&mut g, &mut NameIndex::new(), "run.py", source);
        assert!(added >= 1, "Should detect eval(), got {}", added);
    }

    #[test]
    fn test_detect_py_exec() {
        let mut g = Graph::new();
        let source = r#"
def execute(code):
    exec(code)
"#;
        let added = langs::detect_python_eval(&mut g, &mut NameIndex::new(), "exec.py", source);
        assert!(added >= 1, "Should detect exec(), got {}", added);
    }

    #[test]
    fn test_no_eval_returns_zero() {
        let mut g = Graph::new();
        let source = "function add(a, b) { return a + b; }\n";
        let added = langs::detect_js_ts_eval(&mut g, &mut NameIndex::new(), "math.js", source);
        assert_eq!(added, 0, "No eval → 0 edges");
    }

    // ── 跨语言测试 ──

    #[test]
    fn test_detect_py_subprocess_popen() {
        let mut g = Graph::new();
        let source = r#"
def run_shell():
    import subprocess
    proc = subprocess.Popen(['ls', '-la'])
"#;
        let added = langs::detect_py_cross_lang(&mut g, "runner.py", source);
        assert!(added >= 1, "Should detect subprocess.Popen, got {}", added);
    }

    #[test]
    fn test_detect_py_requests_get() {
        let mut g = Graph::new();
        let source = r#"
def fetch_data():
    import requests
    resp = requests.get('https://api.example.com/data')
"#;
        let added = langs::detect_py_cross_lang(&mut g, "api.py", source);
        assert!(added >= 1, "Should detect requests.get, got {}", added);
    }

    #[test]
    fn test_detect_py_ctypes_cdll() {
        let mut g = Graph::new();
        let source = r#"
def load_native():
    import ctypes
    lib = ctypes.CDLL('./mylib.so')
"#;
        let added = langs::detect_py_cross_lang(&mut g, "ffi.py", source);
        assert!(added >= 1, "Should detect ctypes.CDLL, got {}", added);
    }

    #[test]
    fn test_detect_js_child_process_exec() {
        let mut g = Graph::new();
        let source = r#"
function run(cmd) {
    const { exec } = require('child_process');
    exec(cmd);
}
"#;
        let added = langs::detect_js_cross_lang(&mut g, "process.js", source);
        assert!(added >= 1, "Should detect child_process.exec, got {}", added);
    }

    #[test]
    fn test_detect_js_fetch() {
        let mut g = Graph::new();
        let source = r#"
async function getData() {
    const resp = await fetch('https://api.example.com');
    return resp.json();
}
"#;
        let added = langs::detect_js_cross_lang(&mut g, "fetch.js", source);
        assert!(added >= 1, "Should detect fetch(), got {}", added);
    }

    #[test]
    fn test_detect_java_runtime_exec() {
        let mut g = Graph::new();
        let source = r#"
public class Runner {
    public void run(String cmd) {
        Runtime.getRuntime().exec(cmd);
    }
}
"#;
        let added = langs::detect_java_cross_lang(&mut g, "Runner.java", source);
        assert!(added >= 1, "Should detect Runtime.exec, got {}", added);
    }

    #[test]
    fn test_detect_go_exec_command() {
        let mut g = Graph::new();
        let source = r#"
package main
import "os/exec"
func main() {
    cmd := exec.Command("ls", "-la")
    cmd.Run()
}
"#;
        let added = langs::detect_go_cross_lang(&mut g, "main.go", source);
        assert!(added >= 1, "Should detect exec.Command, got {}", added);
    }

    #[test]
    fn test_no_cross_lang_returns_zero() {
        let mut g = Graph::new();
        let source = "def add(a, b):\n    return a + b\n";
        let added = langs::detect_py_cross_lang(&mut g, "math.py", source);
        assert_eq!(added, 0, "No cross-lang calls → 0 edges");
    }

    // ── 回归:未命中模式时不得创建任何占位节点(di_syn 垃圾节点事故) ──

    #[test]
    fn test_go_no_match_creates_no_nodes() {
        let mut g = Graph::new();
        let source = r#"
package main
import "fmt"
func main() {
    fmt.Println("hello")
    x := add(1, 2)
    fmt.Sprintf("%d", x)
}
func add(a, b int) int { return a + b }
"#;
        let added = langs::detect_go_cross_lang(&mut g, "main.go", source);
        assert_eq!(added, 0);
        assert_eq!(g.nodes.len(), 0,
            "未命中时不得创建占位节点, 实际 {} 个", g.nodes.len());
    }

    #[test]
    fn test_java_no_match_creates_no_nodes() {
        let mut g = Graph::new();
        let source = r#"
public class Calc {
    public int add(int a, int b) {
        return a + b;
    }
    public void run() {
        System.out.println(add(1, 2));
    }
}
"#;
        let added = langs::detect_java_cross_lang(&mut g, "Calc.java", source);
        assert_eq!(added, 0);
        assert_eq!(g.nodes.len(), 0,
            "未命中时不得创建占位节点, 实际 {} 个", g.nodes.len());
    }
}