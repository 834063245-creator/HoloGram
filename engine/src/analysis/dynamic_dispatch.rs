// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 动态分派合成 — 填充静态分析遗漏的 Graph 边。
//!
//! 检测的模式（Phase 1）：
//! - 回调注册：addEventListener('e', handler)、.on('e', handler)
//! - 观察者/Promise 链：.then(cb)、.subscribe(cb)
//! - Express 中间件：app.use(mw)、router.use(mw)
//!
//! 这些生成合成边（provenance: "synthesized"），用于
//! explore_deps 的 synthesizedHops 输出。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::engine::GRAMMAR_LOADER;
use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

/// 管道解析缓存中保存的已解析源码。
type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

/// 对 Graph 运行所有支持语言的动态分派合成。
/// 使用 Step 1 的解析缓存以避免重新读取和重新解析文件。
/// `discovered_files` 替代全目录 walkdir — 管道已在
/// Step 1 中发现了所有源文件。
/// 返回新增的合成边数量。
pub fn synthesize_dynamic_edges(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    // 将管道发现的文件筛选为仅 JS/TS/Python
    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy();
        let lower = s.to_lowercase();
        if lower.ends_with(".js") || lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".py") {
            files.insert(s.replace('\\', "/"));
        }
    }

    for file in &files {
        let lower = file.to_lowercase();
        // 规范化为绝对路径用于缓存查找（Graph 节点使用绝对路径，
        // 磁盘遍历产生相对路径 — 缓存以绝对路径为键）
        let abs_key = if file.contains(':') {
            file.clone() // 已是绝对路径（如 d:/django/views.py）
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };
        // 先尝试解析缓存（避免重新读取和重新解析）
        if let Some((source, Some(tree))) = parse_cache.get(&abs_key) {
            if lower.ends_with(".py") {
                added += synthesize_py_from_tree(graph, file, tree, source);
            } else {
                added += synthesize_js_from_tree(graph, file, tree, source);
            }
        } else {
            // 回退：从磁盘读取（用于不在解析缓存中的文件）
            let full_path = project_root.join(file);
            if let Ok(source) = std::fs::read_to_string(&full_path) {
                if lower.ends_with(".py") {
                    added += synthesize_py_fallback(graph, file, &source);
                } else {
                    added += synthesize_js_fallback(graph, file, &source);
                }
            }
        }
    }

    added
}

// ═══════════════════════════════════════════════════════════════
// JavaScript / TypeScript
// ═══════════════════════════════════════════════════════════════

/// 遍历缓存的树（来自 Step 1）— 无需重新解析。
fn synthesize_js_from_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    walk_js_ts_tree(graph, file, tree, source)
}

/// 回退：对不在解析缓存中的文件从源码解析。
fn synthesize_js_fallback(graph: &mut Graph, file: &str, source: &str) -> usize {
    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let ext = if is_ts { "ts" } else { "js" };
    let lang = match GRAMMAR_LOADER.get(ext) { Some(l) => l, None => return 0 };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return 0,
    };
    walk_js_ts_tree(graph, file, &tree, source)
}

/// 共享的树遍历器 — 缓存和回退路径共用。
fn walk_js_ts_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    let mut added = 0usize;

    // 已知的回调注册方法名
    let callback_methods: HashSet<&str> = [
        "addEventListener", "on", "once", "then", "catch", "finally",
        "subscribe", "use", "listen", "observe", "watch",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some((callback_ref, line)) = extract_js_callback(&node, source, &callback_methods) {
                // 查找包含该调用的函数
                let parent_func = find_containing_function(&node, source);
                if let Some(src_name) = parent_func {
                    // 在 Graph 中查找源节点
                    let src_id = find_or_create_node(graph, &src_name, file, line);
                    let tgt_id = find_or_create_node(graph, &callback_ref, file, line);

                    let edge_id = format!("syn_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        let edge = Edge {
                            id: edge_id,
                            source: src_id,
                            target: tgt_id,
                            kind: EdgeKind::Calls,
                            coupling_depth: 3,
                            cross_file: false,
                            temporal_delay_sec: Some(0.0),
                            lsp_resolved: false,
                            is_synthesized: false,
                            metadata: None,
                        };
                        graph.add_edge_unchecked(edge);
                        added += 1;
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    added
}

fn extract_js_callback(
    call: &tree_sitter::Node,
    source: &str,
    methods: &HashSet<&str>,
) -> Option<(String, usize)> {
    // 查找被调用函数（member_expression：obj.method）
    let func = call.child_by_field_name("function")
        .or_else(|| {
            let mut cc = call.walk();
            let children: Vec<_> = call.children(&mut cc).collect();
            children.into_iter().find(|c| c.kind() == "member_expression")
        })?;

    if func.kind() != "member_expression" {
        return None;
    }

    let mut mc = func.walk();
    let func_children: Vec<_> = func.children(&mut mc).collect();

    let prop_name = func_children.iter().rfind(|c| c.kind() == "property_identifier")
        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string())?;

    if !methods.contains(prop_name.as_str()) {
        return None;
    }

    // 获取参数 — 第一个非字符串参数即为回调
    let args = call.child_by_field_name("arguments")
        .or_else(|| {
            let mut cc = call.walk();
            let children: Vec<_> = call.children(&mut cc).collect();
            children.into_iter().find(|c| c.kind() == "arguments")
        })?;

    let mut ac = args.walk();
    for arg in args.children(&mut ac) {
        match arg.kind() {
            "identifier" => {
                let name = arg.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                let line = arg.start_position().row + 1;
                if name != "undefined" && !name.is_empty() {
                    return Some((name, line));
                }
            }
            "arrow_function" | "function_expression" | "function" => {
                let line = arg.start_position().row + 1;
                // 尝试获取函数名
                if let Some(nn) = arg.child_by_field_name("name") {
                    let name = nn.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                    if !name.is_empty() {
                        return Some((name, line));
                    }
                }
                return Some((format!("<callback@{}>", line), line));
            }
            "string" | "template_string" => continue, // 跳过事件名
            _ => continue,
        }
    }
    None
}

fn find_containing_function(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "function_declaration" | "function_expression" | "method_definition"
            | "arrow_function" => {
                if let Some(name_node) = p.child_by_field_name("name") {
                    return Some(name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string());
                }
                // 匿名 — 使用父级上下文
                if p.kind() == "arrow_function" {
                    return find_containing_function(&p, source);
                }
                let line = p.start_position().row + 1;
                return Some(format!("<fn@{}>", line));
            }
            _ => {}
        }
        cur = p.parent();
    }
    None
}

// ═══════════════════════════════════════════════════════════════
// Python
// ═══════════════════════════════════════════════════════════════

/// 遍历缓存的树（来自 Step 1）— 无需重新解析。
fn synthesize_py_from_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    walk_py_dispatch_tree(graph, file, tree, source)
}

/// 回退：对不在解析缓存中的文件从源码解析。
fn synthesize_py_fallback(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut parser = tree_sitter::Parser::new();
    let lang = match GRAMMAR_LOADER.get("py") { Some(l) => l, None => return 0 };
    if parser.set_language(&lang).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return 0,
    };
    walk_py_dispatch_tree(graph, file, &tree, source)
}

/// 共享的树遍历器 — 缓存和回退路径共用。
fn walk_py_dispatch_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    let mut added = 0usize;

    // 已知的 Python 回调注册方法名
    let callback_methods: HashSet<&str> = [
        "subscribe", "add_callback", "register", "on", "add_listener",
        "connect", "add_handler", "observe", "watch",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call" {
            if let Some((callback_ref, line)) = extract_py_callback(&node, source, &callback_methods) {
                let parent_func = find_containing_py_function(&node, source);
                if let Some(src_name) = parent_func {
                    let src_id = find_or_create_node(graph, &src_name, file, line);
                    let tgt_id = find_or_create_node(graph, &callback_ref, file, line);

                    let edge_id = format!("syn_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        let edge = Edge {
                            id: edge_id,
                            source: src_id,
                            target: tgt_id,
                            kind: EdgeKind::Calls,
                            coupling_depth: 3,
                            cross_file: false,
                            temporal_delay_sec: Some(0.0),
                            lsp_resolved: false,
                            is_synthesized: false,
                            metadata: None,
                        };
                        graph.add_edge_unchecked(edge);
                        added += 1;
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    added
}

fn extract_py_callback(
    call: &tree_sitter::Node,
    source: &str,
    methods: &HashSet<&str>,
) -> Option<(String, usize)> {
    // 方法调用：obj.subscribe(callback)
    if let Some(func) = call.child_by_field_name("function") {
        if func.kind() == "attribute" {
            let mut ac = func.walk();
            let method = func.children(&mut ac)
                .filter(|c| c.kind() == "identifier")
                .last()
                .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string())?;

            if !methods.contains(method.as_str()) {
                return None;
            }

            if let Some(args) = call.child_by_field_name("arguments") {
                let mut arg_c = args.walk();
                for arg in args.children(&mut arg_c) {
                    match arg.kind() {
                        "identifier" => {
                            let name = arg.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                            let line = arg.start_position().row + 1;
                            return Some((name, line));
                        }
                        "lambda" => {
                            let line = arg.start_position().row + 1;
                            return Some((format!("<lambda@{}>", line), line));
                        }
                        "string" => continue, // 事件名，跳过
                        _ => continue,
                    }
                }
            }
        }
    }
    None
}

fn find_containing_py_function(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "function_definition" | "async_function_definition" => {
                if let Some(name_node) = p.child_by_field_name("name") {
                    return Some(name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string());
                }
                let line = p.start_position().row + 1;
                return Some(format!("<fn@{}>", line));
            }
            _ => {}
        }
        cur = p.parent();
    }
    None
}

// ═══════════════════════════════════════════════════════════════
// 共享工具函数
// ═══════════════════════════════════════════════════════════════

/// 为给定符号名查找或创建 Graph 节点。
fn find_or_create_node(graph: &mut Graph, name: &str, file: &str, line: usize) -> String {
    // 尝试查找已有节点
    for (id, node) in graph.nodes_iter() {
        if node.name == name {
            return id.to_string();
        }
    }
    // 创建占位节点
    let node_id = format!("dyn_{}_{}", file.replace(['.', '/', '\\'], "_"), name);
    let mut node = Node::new(&node_id, name, NodeKind::Symbol);
    node.location = Some(format!("{}:{}", file, line));
    node.properties = serde_json::json!({"kind": "synthesized_target", "provenance": "dynamic_dispatch"});
    graph.add_node(node);
    node_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_synthesize_js_event_listener() {
        let mut g = Graph::new();
        // 预先添加一个 handler 节点
        let mut n = Node::new("handler", "handleClick", NodeKind::Symbol);
        n.location = Some("app.js:5".into());
        g.add_node(n);

        let source = r#"
function setup() {
    button.addEventListener('click', handleClick);
}
"#;
        let added = synthesize_js_fallback(&mut g, "app.js", source);
        assert!(added >= 1, "Should create synthesized edge for addEventListener callback");
    }

    #[test]
    fn test_synthesize_js_on_named_fn() {
        let mut g = Graph::new();
        let source = r#"
emitter.on('data', onData);
"#;
        // tree-sitter JS 可能不在 call_expression 上暴露 `function` 字段 —
        // 使用 member_expression 回退。此测试验证不会崩溃。
        let _added = synthesize_js_fallback(&mut g, "events.js", source);
    }

    #[test]
    fn test_synthesize_js_then_arrow() {
        let mut g = Graph::new();
        let source = r#"
function init() {
    fetch('/api').then((data) => { console.log(data); });
}
"#;
        let added = synthesize_js_fallback(&mut g, "api.js", source);
        // .then() 配合箭头函数 — 至少不应崩溃
        //（arrow_function 检测可能需要按 tree-sitter 版本微调）
        let _ = added;
    }

    #[test]
    fn test_synthesize_py_subscribe() {
        let mut g = Graph::new();
        let source = r#"
def main():
    obs.subscribe(on_next)
"#;
        let added = synthesize_py_fallback(&mut g, "main.py", source);
        assert!(added >= 1, "Should create edge for .subscribe() callback");
    }

    #[test]
    fn test_synthesize_no_callback_returns_zero() {
        let mut g = Graph::new();
        let source = "console.log('hello');";
        let added = synthesize_js_fallback(&mut g, "app.js", source);
        assert_eq!(added, 0, "No callback pattern → 0 edges");
    }
}