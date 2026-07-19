// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Runtime-hidden dependency synthesis — fills graph edges that static
//! analysis misses due to runtime dispatch, dynamic code, and reflection.
//!
//! ========================================
//! Blind spots covered (README §已知局限)
//! ========================================
//! 1. DI / Reflection (Phase 2 — 10 languages):
//!    - Python: `getattr`/`setattr` · Java: `@Autowired`/`@Inject`
//!    - TypeScript: `@Injectable`/`@Inject` · C#: `Assembly.Load`/`Type.GetType`
//!    - Ruby: `send`/`method_missing` · PHP: `ReflectionClass`/`call_user_func`
//!    - Go: `reflect.ValueOf` · Kotlin: `@Inject`/`Koin`
//! 2. Dynamic import:
//!    - JS/TS, Python, C# (Assembly.Load), Ruby (autoload/require), PHP (require_once)
//! 3. Eval / dynamic code (marked as unresolvable):
//!    - JS/TS, Python, C# (CodeDom), Ruby (eval/instance_eval), PHP (eval/create_function), Rust (proc_macro)
//! 4. Cross-language call boundaries:
//!    - Subprocess: Py/JS/Java/Go/C#/Ruby/PHP/Kotlin
//!    - HTTP client: Py/JS/Go/C#/Ruby/PHP
//!    - FFI: Python (ctypes)
//!
//! Synthesized edges use coupling_depth=3 (L3 — hidden coupling) or
//! coupling_depth=4 (L4 — unresolvable). All edge IDs use the `di_`
//! prefix for tooling to filter/identify reflection edges.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Graph, Node, NodeKind};
use crate::graph::resolver::infer_language;

/// Parsed source held in the pipeline parse cache.

mod langs;

/// Parsed source held in the pipeline parse cache.
pub(crate) type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;


/// Run DI/reflection detection on the graph for all supported languages.
/// Uses the parse cache from Step 1 to avoid re-reading + re-parsing files.
/// Returns the number of synthesized edges added.
pub fn detect_di_reflection(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    // Filter pipeline-discovered files to JS/TS/Python/Java only
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

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') { file.clone() }
            else { project_root.join(file).to_string_lossy().replace('\\', "/") };

        if let Some((source, _tree_opt)) = parse_cache.get(&abs_key) {
            let source = source.clone();
            if lower.ends_with(".py") { added += langs::detect_python_reflection(graph, file, &source); }
            else if lower.ends_with(".java") { added += langs::detect_java_di(graph, file, &source); }
            else if lower.ends_with(".cs") { added += langs::detect_cs_di(graph, file, &source); }
            else if lower.ends_with(".rb") { added += langs::detect_ruby_di(graph, file, &source); }
            else if lower.ends_with(".php") { added += langs::detect_php_di(graph, file, &source); }
            else if lower.ends_with(".go") { added += langs::detect_go_di(graph, file, &source); }
            else if lower.ends_with(".kt") { added += langs::detect_kotlin_di(graph, file, &source); }
            else { added += langs::detect_ts_di(graph, file, &source); }
        } else {
            let full_path = project_root.join(file);
            if let Ok(source) = std::fs::read_to_string(&full_path) {
                if lower.ends_with(".py") { added += langs::detect_python_reflection(graph, file, &source); }
                else if lower.ends_with(".java") { added += langs::detect_java_di(graph, file, &source); }
                else if lower.ends_with(".cs") { added += langs::detect_cs_di(graph, file, &source); }
                else if lower.ends_with(".rb") { added += langs::detect_ruby_di(graph, file, &source); }
                else if lower.ends_with(".php") { added += langs::detect_php_di(graph, file, &source); }
                else if lower.ends_with(".go") { added += langs::detect_go_di(graph, file, &source); }
                else if lower.ends_with(".kt") { added += langs::detect_kotlin_di(graph, file, &source); }
                else { added += langs::detect_ts_di(graph, file, &source); }
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
            added += langs::detect_python_dynamic_import(graph, file, source_ref);
        } else if lower.ends_with(".cs") {
            added += langs::detect_cs_dynamic_import(graph, file, source_ref);
        } else if lower.ends_with(".rb") {
            added += langs::detect_ruby_dynamic_import(graph, file, source_ref);
        } else if lower.ends_with(".php") {
            added += langs::detect_php_dynamic_import(graph, file, source_ref);
        } else {
            added += langs::detect_js_ts_dynamic_import(graph, file, source_ref);
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
            added += langs::detect_python_eval(graph, file, source_ref);
        } else if lower.ends_with(".cs") {
            added += langs::detect_cs_eval(graph, file, source_ref);
        } else if lower.ends_with(".rb") {
            added += langs::detect_ruby_eval(graph, file, source_ref);
        } else if lower.ends_with(".php") {
            added += langs::detect_php_eval(graph, file, source_ref);
        } else if lower.ends_with(".rs") {
            added += langs::detect_rust_eval(graph, file, source_ref);
        } else {
            added += langs::detect_js_ts_eval(graph, file, source_ref);
        }
    }

    added
}


pub(crate) fn find_or_create_di_node(graph: &mut Graph, name: &str, file: &str, line: usize) -> String {
    let file_lang = infer_language(file);
    // Try exact match first — prefer same-language nodes
    for (id, node) in &graph.nodes {
        if node.name == name && file_lang == infer_language(id) {
            return id.clone();
        }
    }
    // Fallback: exact match regardless of language (synthesized markers may be langless)
    for (id, node) in &graph.nodes {
        if node.name == name {
            return id.clone();
        }
    }
    // Try last-component match (for qualified names) — same-language first
    if let Some(last_part) = name.rsplit('.').next() {
        if last_part != name {
            for (id, node) in &graph.nodes {
                if node.name == last_part && file_lang == infer_language(id) {
                    return id.clone();
                }
            }
            // Fallback: last-component match regardless of language
            for (id, node) in &graph.nodes {
                if node.name == last_part {
                    return id.clone();
                }
            }
        }
    }
    // Create placeholder
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

// ── Python: subprocess, os.system, ctypes, requests ──


#[cfg(test)]
mod tests {
    use super::*;

    // ── Python tests ──

    #[test]
    fn test_detect_getattr_string_literal() {
        let mut g = Graph::new();
        let source = r#"
def connect():
    db = getattr(settings, 'DATABASE_URL')
"#;
        let added = langs::detect_python_reflection(&mut g, "config.py", source);
        assert!(added >= 1, "Should detect getattr with string literal, got {}", added);
    }

    #[test]
    fn test_detect_setattr_string_literal() {
        let mut g = Graph::new();
        let source = r#"
def configure():
    setattr(obj, 'timeout', 30)
"#;
        let added = langs::detect_python_reflection(&mut g, "setup.py", source);
        assert!(added >= 1, "Should detect setattr with string literal, got {}", added);
    }

    #[test]
    fn test_detect_getattr_variable_unresolvable() {
        let mut g = Graph::new();
        let source = r#"
def dynamic_access(obj, attr_name):
    return getattr(obj, attr_name)
"#;
        let added = langs::detect_python_reflection(&mut g, "reflect.py", source);
        // Variable attribute → unresolvable marker edge
        assert!(added >= 1, "Should create unresolvable marker for variable attr, got {}", added);
    }

    #[test]
    fn test_no_reflection_returns_zero() {
        let mut g = Graph::new();
        let source = "def hello():\n    return 42\n";
        let added = langs::detect_python_reflection(&mut g, "plain.py", source);
        assert_eq!(added, 0, "No reflection patterns → 0 edges");
    }

    // ── Java tests ──

    #[test]
    fn test_detect_autowired_field() {
        let mut g = Graph::new();
        let source = r#"
public class UserService {
    @Autowired
    private UserRepository userRepo;
}
"#;
        let added = langs::detect_java_di(&mut g, "UserService.java", source);
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
        let added = langs::detect_java_di(&mut g, "OrderService.java", source);
        assert!(added >= 1, "Should detect @Inject field, got {}", added);
    }

    #[test]
    fn test_no_java_di_returns_zero() {
        let mut g = Graph::new();
        let source = "public class Plain { private int x; }\n";
        let added = langs::detect_java_di(&mut g, "Plain.java", source);
        assert_eq!(added, 0, "No DI annotations → 0 edges");
    }

    // ── TypeScript tests ──

    #[test]
    fn test_detect_injectable_class() {
        let mut g = Graph::new();
        let source = r#"
@Injectable()
export class UserService {
    constructor(private repo: UserRepository) {}
}
"#;
        let added = langs::detect_ts_di(&mut g, "user.service.ts", source);
        // Should detect: Injectable marker + constructor param
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
        let added = langs::detect_ts_di(&mut g, "worker.ts", source);
        assert!(added >= 1, "Should detect @Inject decorated param, got {}", added);
    }

    #[test]
    fn test_no_ts_di_returns_zero() {
        let mut g = Graph::new();
        let source = "class Plain { doStuff() {} }\n";
        let added = langs::detect_ts_di(&mut g, "plain.ts", source);
        assert_eq!(added, 0, "No decorators → 0 edges");
    }

    // ── Integration test ──

    #[test]
    fn test_full_di_detection_multi_language() {
        let mut g = Graph::new();
        let py_src = "def init():\n    db = getattr(config, 'DB_HOST')\n";
        let java_src = "public class Svc { @Autowired private Repo r; }\n";
        let ts_src = "@Injectable() export class Svc { constructor(private r: Repo) {} }\n";

        let a1 = langs::detect_python_reflection(&mut g, "app.py", py_src);
        let a2 = langs::detect_java_di(&mut g, "Svc.java", java_src);
        let a3 = langs::detect_ts_di(&mut g, "svc.ts", ts_src);

        assert!(a1 >= 1);
        assert!(a2 >= 1);
        assert!(a3 >= 1);
        assert!(g.node_count() >= 5, "Should have multiple synthesized nodes, got {}", g.node_count());
    }

    // ── Dynamic import tests ──

    #[test]
    fn test_detect_js_import_variable() {
        let mut g = Graph::new();
        let source = r#"
async function loadModule(name) {
    const mod = await import(name);
}
"#;
        let added = langs::detect_js_ts_dynamic_import(&mut g, "loader.js", source);
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
        let added = langs::detect_js_ts_dynamic_import(&mut g, "plugins.js", source);
        assert!(added >= 1, "Should detect require(variable), got {}", added);
    }

    #[test]
    fn test_require_string_literal_not_flagged() {
        let mut g = Graph::new();
        let source = r#"const fs = require('fs');"#;
        let added = langs::detect_js_ts_dynamic_import(&mut g, "app.js", source);
        assert_eq!(added, 0, "require('string') should NOT be flagged — static import");
    }

    #[test]
    fn test_detect_py_import_module() {
        let mut g = Graph::new();
        let source = r#"
def load_plugin(name):
    mod = importlib.import_module(name)
"#;
        let added = langs::detect_python_dynamic_import(&mut g, "loader.py", source);
        assert!(added >= 1, "Should detect importlib.import_module, got {}", added);
    }

    #[test]
    fn test_detect_py_dunder_import() {
        let mut g = Graph::new();
        let source = r#"
def dynamic_load(name):
    return __import__(name)
"#;
        let added = langs::detect_python_dynamic_import(&mut g, "dyn.py", source);
        assert!(added >= 1, "Should detect __import__, got {}", added);
    }

    // ── Eval tests ──

    #[test]
    fn test_detect_js_eval() {
        let mut g = Graph::new();
        let source = r#"
function runCode(code) {
    eval(code);
}
"#;
        let added = langs::detect_js_ts_eval(&mut g, "runner.js", source);
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
        let added = langs::detect_js_ts_eval(&mut g, "factory.js", source);
        assert!(added >= 1, "Should detect new Function(), got {}", added);
    }

    #[test]
    fn test_detect_py_eval() {
        let mut g = Graph::new();
        let source = r#"
def run(code):
    eval(code)
"#;
        let added = langs::detect_python_eval(&mut g, "run.py", source);
        assert!(added >= 1, "Should detect eval(), got {}", added);
    }

    #[test]
    fn test_detect_py_exec() {
        let mut g = Graph::new();
        let source = r#"
def execute(code):
    exec(code)
"#;
        let added = langs::detect_python_eval(&mut g, "exec.py", source);
        assert!(added >= 1, "Should detect exec(), got {}", added);
    }

    #[test]
    fn test_no_eval_returns_zero() {
        let mut g = Graph::new();
        let source = "function add(a, b) { return a + b; }\n";
        let added = langs::detect_js_ts_eval(&mut g, "math.js", source);
        assert_eq!(added, 0, "No eval → 0 edges");
    }

    // ── Cross-language tests ──

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
}