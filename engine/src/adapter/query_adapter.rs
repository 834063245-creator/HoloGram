// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 基于查询的结构适配器 — 替代手写的 tree 遍历器。
//! 使用 tree-sitter .scm 查询文件来查找符号并创建 Node/Edge。
//! ponytail: 每个语言族一个适配器，通过每种语言一个 .scm 文件实现。
//! 添加新语言 = 一个 .scm 文件 + 一个 new_xx() 构造函数。
//! 无需手写 match 分支。

use crate::adapter::traits::LanguageAdapter;
use crate::engine::GRAMMAR_LOADER;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};
use crate::path_utils::normalize_path;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Parser, Query, QueryCursor};

thread_local! {
    static TL_PARSER: RefCell<Option<(Parser, Language, String)>> = const { RefCell::new(None) };
}

/// 编译后查询的全局缓存,按查询源码内容索引。
/// Query::new 开销可观,此前 process_query 每个文件都重新编译一次 ——
/// 大项目(如 5.1 万文件的 Linux 内核)下等于白耗一个阶段的 CPU;
/// 对编译失败的查询(如引用了语法中不存在的节点类型)还会逐文件刷屏。
/// 成功与失败都缓存:失败只报一次错,后续直接走降级路径。
static QUERY_CACHE: OnceLock<Mutex<HashMap<&'static str, Option<Arc<Query>>>>> = OnceLock::new();

/// 获取编译后的查询,命中缓存则 O(1) 返回。
/// query_src 必须来自 include_str!( &'static str),保证键稳定。
fn get_compiled_query(lang: &Language, query_src: &'static str) -> Option<Arc<Query>> {
    let cache = QUERY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(entry) = guard.get(query_src) {
        return entry.clone();
    }
    let compiled = match Query::new(lang, query_src) {
        Ok(q) => Some(Arc::new(q)),
        Err(e) => {
            eprintln!("[query_adapter] query compile failed (后续不再重复报告): {e}");
            None
        }
    };
    guard.insert(query_src, compiled.clone());
    compiled
}

// ── 作用域边界（Phase 1）──

struct Scope {
    name: String,
    start: usize,
    end: usize,
}

fn find_scope(pos: usize, scopes: &[Scope]) -> Option<&str> {
    scopes
        .iter()
        .rev() // 最后声明的 scope 优先（最内层）
        .find(|s| s.start <= pos && pos < s.end)
        .map(|s| s.name.as_str())
}

/// 查找严格包含某节点的 scope（start < node_start），
/// 排除节点自身的 scope。用于 @fn/@class 中
/// 声明本身即为 scope 边界的情况。
fn find_enclosing_scope(node_start: usize, scopes: &[Scope]) -> Option<&str> {
    scopes
        .iter()
        .rev()
        .find(|s| s.start < node_start && node_start < s.end)
        .map(|s| s.name.as_str())
}

// ── import 路径解析 ──

fn resolve_import_path(import_path: &str, current_file: &str) -> String {
    let trimmed = import_path.trim_matches(|c| c == '\'' || c == '"' || c == '`');
    if trimmed.starts_with("./") || trimmed.starts_with("../") {
        let current_dir = Path::new(current_file).parent().unwrap_or(Path::new("."));
        let resolved = current_dir.join(trimmed);
        // ponytail: Path::join 不会规范化 ".."。手动解析各段。
        let s = normalize_path(&resolved.to_string_lossy());
        // 按 '/' 分割，解析 "." 和 ".." 段
        let mut parts: Vec<&str> = Vec::new();
        for seg in s.split('/') {
            match seg {
                "." | "" => {}
                ".." => { parts.pop(); }
                _ => parts.push(seg),
            }
        }
        parts.join(".")
    } else {
        trimmed.to_string()
    }
}

// ── 继承名称提取 ──

// ── 适配器 ──

pub struct QueryStructureAdapter {
    extensions: Vec<String>,
    /// 查询源：单查询语言（Rust）为 Some，JS/TS 为 None（运行时选择）。
    query_src: Option<&'static str>,
    /// TS 查询（用于 .ts/.tsx/.mts/.cts）
    ts_query_src: &'static str,
    /// JS 查询（用于 .js/.jsx/.mjs/.cjs）
    js_query_src: &'static str,
    func_kinds: &'static [&'static str],
    class_kinds: &'static [&'static str],
}

impl QueryStructureAdapter {
    pub fn new_js_ts() -> Self {
        Self {
            extensions: vec![
                "ts".into(), "tsx".into(), "mts".into(), "cts".into(),
                "js".into(), "jsx".into(), "mjs".into(), "cjs".into(),
            ],
            query_src: None, // 运行时根据扩展名选择
            ts_query_src: include_str!("../../queries/ts_structure.scm"),
            js_query_src: include_str!("../../queries/js_structure.scm"),
            func_kinds: &[
                "function_declaration", "generator_function_declaration",
                "function_expression", "method_definition", "arrow_function",
            ],
            class_kinds: &["class_declaration"],
        }
    }

    pub fn new_rust() -> Self {
        Self {
            extensions: vec!["rs".into()],
            query_src: Some(include_str!("../../queries/rust_structure.scm")),
            ts_query_src: "",
            js_query_src: "",
            func_kinds: &["function_item", "closure_expression"],
            class_kinds: &["impl_item", "struct_item", "enum_item", "trait_item"],
        }
    }

    /// 单查询语言的通用构造函数。
    /// ponytail: registry.rs 中每语言一行 — 无需每语言单独的适配器文件。
    pub fn new_generic(
        extensions: Vec<String>,
        query_src: &'static str,
        func_kinds: &'static [&'static str],
        class_kinds: &'static [&'static str],
    ) -> Self {
        Self {
            extensions,
            query_src: Some(query_src),
            ts_query_src: "",
            js_query_src: "",
            func_kinds,
            class_kinds,
        }
    }

    fn resolve_query_src(&self, ext: &str) -> &'static str {
        self.query_src.unwrap_or_else(|| {
            // ponytail: TSX 使用独立的语法（LANGUAGE_TSX），支持 JSX。
            // TSX 查询文件包含的 JSX 模式无法在
            // 普通 TypeScript 语法上编译。
            if ext == "tsx" {
                include_str!("../../queries/tsx_structure.scm")
            } else if matches!(ext, "ts" | "mts" | "cts") {
                self.ts_query_src
            } else {
                self.js_query_src
            }
        })
    }

    fn lang_for_ext(ext: &str) -> Option<Language> {
        GRAMMAR_LOADER.get(ext)
    }
}

impl LanguageAdapter for QueryStructureAdapter {
    fn extensions(&self) -> Vec<String> {
        self.extensions.clone()
    }

    fn analyze(
        &self,
        file_path: &str,
        source: &str,
    ) -> (Vec<Node>, Vec<Edge>, Option<tree_sitter::Tree>) {
        let ext = file_path.rsplit('.').next().unwrap_or("");
        let lang = match Self::lang_for_ext(ext) {
            Some(l) => l,
            None => return (vec![], vec![], None),
        };
        // ponytail: Language 是 Clone 的。在原始 Language 被 move 到
        // TL_PARSER 之后，保留一份副本供 query 使用。
        let lang_for_query = lang.clone();

        TL_PARSER.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let reuse = borrow
                .as_ref()
                .is_some_and(|(_, _, cached_ext)| cached_ext == ext);
            if !reuse {
                let mut p = Parser::new();
                if p.set_language(&lang).is_err() {
                    return (vec![], vec![], None);
                }
                *borrow = Some((p, lang, ext.to_string()));
            }
            let (ref mut parser, _, _) = borrow.as_mut().unwrap();

            let tree = match parser.parse(source, None) {
                Some(t) => t,
                None => return (vec![], vec![], None),
            };

            let query_src = self.resolve_query_src(ext);
            let (nodes, edges) = process_query(
                &tree, source, file_path, query_src,
                &lang_for_query, self.func_kinds, self.class_kinds,
            );
            (nodes, edges, Some(tree))
        })
    }
}

// ── 查询处理器 ──

fn process_query(
    tree: &tree_sitter::Tree,
    source: &str,
    file_path: &str,
    query_src: &'static str,
    lang: &Language,
    func_kinds: &[&str],
    class_kinds: &[&str],
) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut counter = 0u32;
    // 按作用域去重 USAGE 边 — 跳过对同一名称的重复引用
    let mut usage_seen: HashSet<String> = HashSet::new();

    let file_id = normalize_path(file_path);
    // ponytail: 在 module_id 中包含扩展名，使 CrossFileResolver 能将
    // import 目标匹配到 module 节点。匹配旧适配器使用的格式。
    let module_id = file_id.replace(['/', '\\'], ".");

    // Module 节点
    let mut file_node = Node::new(&module_id, &file_id, NodeKind::File);
    file_node.location = Some(file_path.to_string());
    nodes.push(file_node);

    let root = tree.root_node();
    let source_bytes = source.as_bytes();

    // ── Phase 1：收集具有正确嵌套的 scope 边界 ──
    // ponytail: 压入 (node, parent_scope_name) 对，使嵌套
    // 函数/类获得带 scope 限定的名称（如 module.as_view.view
    // 而非 module.view）。这是 find_scope 为 @fn/@class/@var/@call
    // 归属返回正确外层 scope 所必需的。
    let mut scopes: Vec<Scope> = Vec::new();
    {
        let mut stack: Vec<(tree_sitter::Node, String)> = vec![(root, module_id.clone())];
        while let Some((node, parent_scope)) = stack.pop() {
            let kind = node.kind();
            let is_func = func_kinds.contains(&kind);
            let is_class = class_kinds.contains(&kind);
            let scope_name = if is_func || is_class {
                // name 字段(JS/Go 等)或 C/C++ declarator 链(function_definition)
                let mut name = extract_def_name(&node, source_bytes);
                let mut anonymous = name.is_none();
                // 匿名箭头函数/函数表达式：尝试从 parent 继承名字 —
                //   const f = () => {}            → variable_declarator
                //   { subAgentSpawner: () => {} } → pair
                // 避免 <anon@N> scope 截胡内部调用归属（factory 内调用
                // 曾挂到外层父函数、source 解析失败整条边丢失）。
                if anonymous && (kind == "arrow_function" || kind == "function_expression") {
                    if let Some(parent) = node.parent() {
                        let inherited = match parent.kind() {
                            "variable_declarator" => parent
                                .child_by_field_name("name")
                                .and_then(|n| n.utf8_text(source_bytes).ok())
                                .map(|s| s.to_string()),
                            "pair" => parent
                                .child_by_field_name("key")
                                .and_then(|n| n.utf8_text(source_bytes).ok())
                                .map(|s| s.to_string()),
                            _ => None,
                        };
                        if let Some(iname) = inherited {
                            name = Some(iname);
                            anonymous = false;
                        }
                    }
                }
                if anonymous {
                    // 匿名函数且无法命名：不创建 scope，内部调用归属外层
                    parent_scope.clone()
                } else {
                    let name = name.unwrap_or_else(|| format!("<anon@{}>", node.start_position().row + 1));
                    let qualified = format!("{}.{}", parent_scope, name);
                    scopes.push(Scope {
                        name: qualified.clone(),
                        start: node.start_byte(),
                        end: node.end_byte(),
                    });
                    qualified
                }
            } else {
                parent_scope.clone()
            };
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                stack.push((child, scope_name.clone()));
            }
        }
    }
    scopes.sort_by_key(|s| s.start);

    // ── Phase 2：运行结构查询(编译结果全局缓存,不再逐文件编译) ──
    let query = match get_compiled_query(lang, query_src) {
        Some(q) => q,
        None => {
            return (nodes, edges);
        }
    };

    let mut cursor = QueryCursor::new();
    let mut created_ids: HashSet<String> = HashSet::new();
    let mut matches = cursor.matches(&query, root, source_bytes);

    while let Some(qmatch) = matches.next() {
        // 查找主捕获（@fn、@class、@interface、@call、@import、@inherit）
        let mut primary_cap: Option<(&str, tree_sitter::Node)> = None;
        let mut trait_name: Option<String> = None;
        let mut type_name: Option<String> = None;
        for capture in qmatch.captures {
            let cn: &str = query.capture_names()[capture.index as usize];
            match cn {
                "fn" | "class" | "interface" | "call" | "import" | "inherit"
                | "var" | "write" | "throws" | "usage" => {
                    primary_cap = Some((cn, capture.node));
                }
                "trait_name" => {
                    trait_name = capture.node.utf8_text(source_bytes).ok().map(|s| s.to_string());
                }
                "type_name" => {
                    type_name = capture.node.utf8_text(source_bytes).ok().map(|s| s.to_string());
                }
                _ => {}
            }
        }
        let (cap_name, node) = match primary_cap {
            Some(c) => c,
            None => continue,
        };

        match cap_name {
            "fn" => {
                // function_declaration、generator_function_declaration、function_expression、
                // method_definition、arrow_function 或 variable_declarator
                let (name, scope_end) = resolve_fn(&node, source_bytes, func_kinds);
                let name = match name {
                    Some(n) => n,
                    None => continue, // 匿名回调 — 跳过
                };
                // ponytail: 使用外层 scope 使嵌套函数获得正确路径
                // （如 module.as_view.view 而非 module.view）。
                let scope_id = find_enclosing_scope(node.start_byte(), &scopes)
                    .unwrap_or(&module_id);
                let nid = format!("{}.{}", scope_id, name);
                if created_ids.contains(&nid) {
                    continue;
                }
                created_ids.insert(nid.clone());
                counter += 1;
                edges.push(Edge::new(
                    format!("def_{}_{}", file_id, counter),
                    scope_id,
                    &nid,
                    EdgeKind::Defines,
                ));
                let mut n = Node::new(&nid, &name, NodeKind::Function);
                n.location = Some(format!("{}:{}", file_path, node.start_position().row + 1));
                nodes.push(n);
                // 作用域边界 — Phase 1 已找到 scope 定义节点，
                // 但 variable_declarator 包装的函数需要显式 scope 以进行 call 归属
                let end = scope_end.unwrap_or(node.end_byte());
                scopes.push(Scope { name: nid.clone(), start: node.start_byte(), end });
                scopes.sort_by_key(|s| s.start);
            }

            "class" => {
                let name = match node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                    .map(|s| s.to_string())
                {
                    Some(n) => n,
                    None => continue,
                };
                let scope_id = find_enclosing_scope(node.start_byte(), &scopes)
                    .unwrap_or(&module_id);
                let nid = format!("{}.{}", scope_id, name);
                if created_ids.contains(&nid) {
                    continue;
                }
                created_ids.insert(nid.clone());
                counter += 1;
                edges.push(Edge::new(
                    format!("def_{}_{}", file_id, counter),
                    scope_id,
                    &nid,
                    EdgeKind::Defines,
                ));
                let mut n = Node::new(&nid, &name, NodeKind::Class);
                n.location = Some(format!("{}:{}", file_path, node.start_position().row + 1));
                nodes.push(n);
                // 作用域
                scopes.push(Scope { name: nid.clone(), start: node.start_byte(), end: node.end_byte() });
                scopes.sort_by_key(|s| s.start);
                // 继承：遍历子节点查找 extends_clause / implements_clause
                emit_class_inherits(&node, source_bytes, &nid, &module_id, &file_id, &mut counter, &mut edges);
            }

            "interface" => {
                let name = match node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                    .map(|s| s.to_string())
                {
                    Some(n) => n,
                    None => continue,
                };
                let nid = format!("{}.{}", module_id, name);
                if created_ids.contains(&nid) {
                    continue;
                }
                created_ids.insert(nid.clone());
                counter += 1;
                edges.push(Edge::new(
                    format!("def_{}_{}", file_id, counter),
                    &module_id,
                    &nid,
                    EdgeKind::Defines,
                ));
                let mut n = Node::new(&nid, &name, NodeKind::Interface);
                n.location = Some(format!("{}:{}", file_path, node.start_position().row + 1));
                nodes.push(n);
            }

            "call" => {
                let name = match extract_call_target(&node, source_bytes) {
                    Some(n) => n,
                    None => continue,
                };
                // require() → import 边
                if name == "require" {
                    if let Some(target) = extract_first_string_arg(&node, source_bytes) {
                        let target = target.trim_matches(|c| c == '\'' || c == '"' || c == '`');
                        if !target.is_empty() {
                            counter += 1;
                            let mut e = Edge::new(
                                format!("imp_{}_{}", file_id, counter),
                                &module_id, target, EdgeKind::Imports,
                            );
                            e.cross_file = true;
                            edges.push(e);
                        }
                    }
                    continue;
                }
                // 动态 import() → import 边
                if name == "import" {
                    if let Some(target) = extract_first_string_arg(&node, source_bytes) {
                        let target = target.trim_matches(|c| c == '\'' || c == '"' || c == '`');
                        if !target.is_empty() {
                            let resolved = resolve_import_path(target, file_path);
                            counter += 1;
                            let mut e = Edge::new(
                                format!("imp_{}_{}", file_id, counter),
                                &module_id, &resolved, EdgeKind::Imports,
                            );
                            e.cross_file = true;
                            edges.push(e);
                        }
                    }
                    continue;
                }
                // 跳过内置名称
                if is_skip_name(&name) {
                    continue;
                }
                let call_pos = node.start_byte();
                let scope_id = find_scope(call_pos, &scopes).unwrap_or(&module_id);
                counter += 1;
                let mut e = Edge::new(
                    format!("call_{}_{}", file_id, counter),
                    scope_id, &name, EdgeKind::Calls,
                );
                e.cross_file = true;
                edges.push(e);
            }

            "import" => {
                // ponytail: @import 捕获处理器。
                // JS/TS：节点有 "source" 字段（"import x from 'y'"）
                // Python import_from_statement："module_name" 字段（"from X import Y"）
                // Python import_statement：子节点包含 dotted_name（"import X"）
                // Rust：use_declaration 文本（如 "use std::collections::HashMap"）
                let raw_target = match node.child_by_field_name("source")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                {
                    Some(s) => s.to_string(),
                    None => {
                        let kind = node.kind();
                        if kind == "export_statement" {
                            continue; // 命名导出，非重新导出 — 跳过
                        }
                        // Python：from X import Y
                        if kind == "import_from_statement" {
                            match node.child_by_field_name("module_name")
                                .and_then(|n| n.utf8_text(source_bytes).ok())
                            {
                                Some(name) => name.to_string(),
                                None => continue,
                            }
                        } else if kind == "import_statement" {
                            // Python：import X → 每个 dotted_name 子节点一条边
                            let mut cursor = node.walk();
                            for child in node.children(&mut cursor) {
                                if child.kind() == "dotted_name" {
                                    if let Ok(name) = child.utf8_text(source_bytes) {
                                        counter += 1;
                                        let mut e = Edge::new(
                                            format!("imp_{}_{}", file_id, counter),
                                            &module_id, name, EdgeKind::Imports,
                                        );
                                        e.cross_file = true;
                                        edges.push(e);
                                    }
                                }
                            }
                            continue; // 已发出边
                        } else {
                            // Rust use_declaration 或其他 import 类节点：使用完整文本
                            node.utf8_text(source_bytes).ok()
                                .map(|s| s.to_string())
                                .unwrap_or_default()
                        }
                    }
                };
                if raw_target.is_empty() {
                    continue;
                }
                let target = resolve_import_path(&raw_target, file_path);
                counter += 1;
                let mut e = Edge::new(
                    format!("imp_{}_{}", file_id, counter),
                    &module_id, &target, EdgeKind::Imports,
                );
                e.cross_file = true;
                edges.push(e);
            }

            "inherit" => {
                // Rust：impl Trait for Type — 名称来自捕获循环
                if let (Some(tn), Some(tyn)) = (trait_name.as_ref(), type_name.as_ref()) {
                    let type_nid = format!("{}.{}", module_id, tyn);
                    let trait_nid = format!("{}.{}", module_id, tn);
                    counter += 1;
                    edges.push(Edge::new(
                        format!("inh_{}_{}", file_id, counter),
                        &type_nid, &trait_nid, EdgeKind::Inherits,
                    ));
                }
            }

            "var" => {
                // 变量/常量 → Variable 节点（带 scope 限定）。
                // ponytail: 限定到外层 function/class，使 `foo()` 内的
                // `x = 1` 创建 `module.foo.x` 而非 `module.x`。这避免了
                // 跨函数名称冲突并与 cbm 的作用域规则一致。
                let name = match node
                    .child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                {
                    Some(n) => n.to_string(),
                    None => {
                        // 无 name 字段 — 尝试赋值的左侧
                        let left = node.child_by_field_name("left")
                            .and_then(|l| l.utf8_text(source_bytes).ok())
                            .map(|s| s.to_string());
                        match left {
                            Some(s) => s,
                            None => continue,
                        }
                    }
                };
                if name.is_empty() { continue; }
                let scope_id = find_scope(node.start_byte(), &scopes).unwrap_or(&module_id);
                let nid = format!("{}.{}", scope_id, name);
                if created_ids.contains(&nid) { continue; }
                created_ids.insert(nid.clone());
                counter += 1;
                edges.push(Edge::new(
                    format!("def_{}_{}", file_id, counter),
                    scope_id, &nid, EdgeKind::Defines,
                ));
                let mut n = Node::new(&nid, &name, NodeKind::Variable);
                n.location = Some(format!("{}:{}", file_path, node.start_position().row + 1));
                nodes.push(n);
            }

            "write" => {
                // 赋值 → WRITES 边，从外层 scope 到变量。
                // target 使用带 scope 限定的名称以匹配 Variable 节点。
                let left = node.child_by_field_name("left");
                let target = match left {
                    Some(l) => l.utf8_text(source_bytes).ok().map(|s| s.to_string()),
                    None => node
                        .child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source_bytes).ok())
                        .map(|s| s.to_string()),
                };
                let name = match target {
                    Some(n) => n,
                    None => continue,
                };
                if name.is_empty() { continue; }
                let scope_id = find_scope(node.start_byte(), &scopes).unwrap_or(&module_id);
                let qualified = format!("{}.{}", scope_id, name);
                counter += 1;
                edges.push(Edge::new(
                    format!("write_{}_{}", file_id, counter),
                    scope_id, &qualified, EdgeKind::Writes,
                ));
            }

            "throws" => {
                // raise/throw → THROWS 边，从外层 scope 到异常类型
                let exc_name = extract_throw_target(&node, source_bytes);
                let name = match exc_name {
                    Some(n) => n,
                    None => continue,
                };
                let scope_id = find_scope(node.start_byte(), &scopes).unwrap_or(&module_id);
                counter += 1;
                edges.push(Edge::new(
                    format!("throw_{}_{}", file_id, counter),
                    scope_id, &name, EdgeKind::Throws,
                ));
            }

            "usage" => {
                // identifier/attribute 引用 → USAGE 边，从外层 scope
                let name = node.utf8_text(source_bytes).ok().map(|s| s.to_string());
                let name = match name {
                    Some(n) => n,
                    None => continue,
                };
                let lang_ext = file_path.rsplit('.').next().unwrap_or("");
                // 跳过单字符、内置名称、定义位置、参数声明
                if name.len() <= 1 || is_skip_name(&name) || is_builtin_for_ext(&name, lang_ext)
                    || is_definition_site(&node, source_bytes) || is_param_decl(&node, source_bytes)
                {
                    continue;
                }
                let scope_id = find_scope(node.start_byte(), &scopes).unwrap_or(&module_id);
                let dedup_key = format!("{}:{}", scope_id, name);
                if !usage_seen.insert(dedup_key) { continue; }
                counter += 1;
                edges.push(Edge::new(
                    format!("use_{}_{}", file_id, counter),
                    scope_id, &name, EdgeKind::Usage,
                ));
            }

            _ => {}
        }
    }

    (nodes, edges)
}

// ── 名称提取辅助函数 ──

/// 解析函数类节点：返回 (name, scope_end_byte)。
/// 对于 variable_declarator，检查其值是否为函数。
/// 提取函数/类型定义节点的名字。
/// 优先 name 字段(JS/Go/Python/Rust 等);其次 C/C++ 的 declarator 链 ——
/// tree-sitter-c/cpp 的 function_definition 没有 name 字段,名字嵌在
/// declarator → (function_declarator/pointer_declarator/…) → identifier 中。
fn extract_def_name(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    if let Some(n) = node
        .child_by_field_name("name")
        .and_then(|n| n.utf8_text(source).ok())
        .map(|s| s.to_string())
    {
        return Some(n);
    }
    // C/C++ declarator 链:逐层向下钻,直到 identifier 类叶子
    let mut cur = *node;
    loop {
        cur = cur.child_by_field_name("declarator")?;
        match cur.kind() {
            "identifier" | "field_identifier" | "destructor_name" | "operator_name" => {
                return cur.utf8_text(source).ok().map(|s| s.to_string());
            }
            "qualified_identifier" => {
                // C++ 命名空间限定:优先取末段 name,否则取整段文本
                return cur
                    .child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source).ok())
                    .map(|s| s.to_string())
                    .or_else(|| cur.utf8_text(source).ok().map(|s| s.to_string()));
            }
            _ => {} // function_declarator / pointer_declarator 等:继续向下
        }
    }
}

fn resolve_fn(
    node: &tree_sitter::Node,
    source: &[u8],
    func_kinds: &[&str],
) -> (Option<String>, Option<usize>) {
    let kind = node.kind();
    if func_kinds.contains(&kind) {
        // 直接函数节点:function_declaration、arrow_function、
        // function_definition(C/C++,名字走 declarator 链)等。
        let name = extract_def_name(node, source);
        if name.is_some() {
            return (name, Some(node.end_byte()));
        }
        // 匿名箭头函数/函数表达式：尝试从 parent 继承名字
        // （const f = () => {} → variable_declarator；
        //   { subAgentSpawner: () => {} } → pair）。
        // 与 Phase 1 scope 构建保持一致，否则 scope 存在但节点缺失、
        // 内部调用 source 解析失败整条边被删。
        if kind == "arrow_function" || kind == "function_expression" {
            if let Some(parent) = node.parent() {
                // ponytail: variable_declarator 本身也会被 @fn 捕获并在下方
                // variable_declarator 分支建节点（const X = () => {} 建
                // module.X）。若此处再继承名字建一个 module.X.X，会出现
                // 双节点：调用方连到壳 module.X，真函数体 module.X.X 成孤儿
                // 被 find_unused 误报死代码。故 variable_declarator 包装
                // 的匿名函数此处直接跳过（节点由 declarator 分支负责）。
                // pair 包装（{ subAgentSpawner: () => {} }）无兜底节点，
                // 仍需继承名建节点。
                if parent.kind() == "variable_declarator" {
                    return (None, None);
                }
                let inherited = match parent.kind() {
                    "pair" => parent
                        .child_by_field_name("key")
                        .and_then(|n| n.utf8_text(source).ok())
                        .map(|s| s.to_string()),
                    _ => None,
                };
                if let Some(iname) = inherited {
                    return (Some(iname), Some(node.end_byte()));
                }
            }
        }
        // 匿名回调 — 跳过（回调，非命名符号）
        return (None, None);
    }
    if kind == "variable_declarator" {
        let name = node
            .child_by_field_name("name")
            .and_then(|n| n.utf8_text(source).ok())
            .map(|s| s.to_string());
        let value = node.child_by_field_name("value");
        let is_fn = value.is_some_and(|v| {
            let vk = v.kind();
            func_kinds.contains(&vk) || vk == "function_expression" || vk == "generator_function_expression"
        });
        if is_fn {
            let end = value.map(|v| v.end_byte());
            return (name, end);
        }
        return (None, None);
    }
    (None, None)
}

/// 从 call/new/JSX 节点提取调用目标名。
/// 从函数字段子节点提取函数/方法名。
/// 处理 member_expression（a.b.c → "c"）、field_expression（v.len → "len"）、
/// attribute（obj.method → "method"）和普通 identifier。
fn extract_func_field_name(func: tree_sitter::Node, source: &[u8]) -> Option<String> {
    match func.kind() {
        // ponytail: 返回完整 object.property（而非仅 property），
        // 使跨文件静态方法调用（如 Workspace.open、bus.emit）在 resolver
        // 中能用 best_qualified_match 后缀匹配消歧。与下方 Python
        // attribute 分支行为一致。resolver 策略 6 会渐进剥离接收者前缀。
        "member_expression" => {
            let obj = func
                .child_by_field_name("object")
                .and_then(|o| o.utf8_text(source).ok());
            let prop = func
                .child_by_field_name("property")
                .and_then(|p| p.utf8_text(source).ok());
            match (obj, prop) {
                (Some(o), Some(p)) if !o.is_empty() => Some(format!("{}.{}", o, p)),
                (_, Some(p)) => Some(p.to_string()),
                _ => func.utf8_text(source).ok().map(|s| s.to_string()),
            }
        }
        "field_expression" => func
            .child_by_field_name("field")
            .and_then(|f| f.utf8_text(source).ok())
            .map(|s| s.to_string()),
        "optional_chain" => {
            // TS/JS 可选链：a?.b.c() → 解包到内部表达式再递归提取
            // （a?.b() 的 function 字段是 optional_chain 而非 member_expression，
            //   否则会落到兜底分支返回整段文本导致跨文件解析失败）。
            let inner = func.child_by_field_name("expression");
            let inner = inner.or_else(|| {
                let mut cursor = func.walk();
                let found = func.children(&mut cursor)
                    .find(|c| c.kind() == "member_expression");
                found
            });
            match inner {
                Some(inner) => extract_func_field_name(inner, source),
                None => func.utf8_text(source).ok().map(|s| s.to_string()),
            }
        }
        "attribute" => {
            // Python：obj.method() → 从 attribute.object.method 提取 "method"
            let attr = func
                .child_by_field_name("attribute")
                .and_then(|a| a.utf8_text(source).ok())
                .map(|s| s.to_string());
            let obj = func
                .child_by_field_name("object")
                .and_then(|o| o.utf8_text(source).ok());
            match (obj, attr) {
                (Some(o), Some(a)) if !o.is_empty() => Some(format!("{}.{}", o, a)),
                (_, Some(a)) => Some(a),
                _ => func.utf8_text(source).ok().map(|s| s.to_string()),
            }
        }
        "selector_expression" => {
            // Dart：a.b.c() → 遍历链到叶节点
            let mut cur = func;
            loop {
                let field = cur.child_by_field_name("field");
                let obj = cur.child_by_field_name("object");
                if let (Some(f), Some(o)) = (field, obj) {
                    if o.kind() == "selector_expression" {
                        cur = o;
                        continue;
                    }
                    return f.utf8_text(source).ok().map(|s| s.to_string());
                }
                return cur.utf8_text(source).ok().map(|s| s.to_string());
            }
        }
        "identifier" | "simple_identifier" => func.utf8_text(source).ok().map(|s| s.to_string()),
        "import" => Some("import".to_string()),
        "dot" => {
            // Elixir：Mod.func() → 提取最右侧
            func.child_by_field_name("right")
                .and_then(|r| r.utf8_text(source).ok())
                .map(|s| s.to_string())
                .or_else(|| func.utf8_text(source).ok().map(|s| s.to_string()))
        }
        _ => func.utf8_text(source).ok().map(|s| s.to_string()),
    }
}

fn extract_call_target(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    // ── 有 "function" 字段的节点 ──
    const FUNC_FIELD_NODES: &[&str] = &[
        "call_expression", "call", "function_call",
        "invocation_expression", "method_invocation",
        "selector", "command_call", "builtin_function",
        "constructor_expression", "generic_function",
        "navigation_expression", "with_statement",
        // PHP：function_call_expression 有 "function" 字段；
        // member_call_expression / scoped_call_expression /
        // nullsafe_member_call_expression 有 "name" 字段
        "function_call_expression", "member_call_expression",
        "scoped_call_expression", "nullsafe_member_call_expression",
    ];
    let nk = node.kind();
    if FUNC_FIELD_NODES.contains(&nk) {
        // 先尝试 "function" 字段（JS/TS/Python/Rust/Go/Swift/C#/Scala）
        if let Some(result) = node
            .child_by_field_name("function")
            .and_then(|f| extract_func_field_name(f, source))
        {
            return Some(result);
        }
        // 回退："method" 字段（Ruby call/command_call）
        if let Some(result) = node
            .child_by_field_name("method")
            .and_then(|f| extract_func_field_name(f, source))
        {
            return Some(result);
        }
        // 回退："name" 字段（Java method_invocation、PHP member_call_expression）
        if let Some(result) = node
            .child_by_field_name("name")
            .and_then(|f| extract_func_field_name(f, source))
        {
            return Some(result);
        }
        // 继续到下面的语言特定处理器
    }

    // ── 有 "name" 或 "constructor" 字段的节点 ──
    if nk == "object_creation_expression" || nk == "new_expression" {
        let ctor = node.child_by_field_name("constructor")
            .or_else(|| node.child_by_field_name("name"))?;
        if ctor.kind() == "member_expression" {
            return ctor
                .child_by_field_name("property")
                .and_then(|p| p.utf8_text(source).ok())
                .map(|s| s.to_string());
        }
        return ctor.utf8_text(source).ok().map(|s| s.to_string());
    }

    // ── Ruby："method" + 可选 "receiver" 字段 ──
    // ponytail："command_call"（无括号调用如 `puts "hi"`）也
    // 使用 "method" 字段。由上面的 FUNC_FIELD_NODES 回退处理，
    // 但此路径添加 receiver.method 限定。
    if nk == "call" || nk == "command_call" {
        if let Some(method) = node.child_by_field_name("method") {
            let m = method.utf8_text(source).ok()?.to_string();
            if let Some(recv) = node.child_by_field_name("receiver") {
                if let Ok(r) = recv.utf8_text(source) {
                    if !r.is_empty() {
                        return Some(format!("{}.{}", r, m));
                    }
                }
            }
            return Some(m);
        }
    }

    // ── Rust macro_invocation ──
    if nk == "macro_invocation" {
        return node
            .child_by_field_name("macro")
            .and_then(|m| m.utf8_text(source).ok())
            .map(|s| s.to_string());
    }

    // ── JSX ──
    if matches!(nk, "jsx_self_closing_element" | "jsx_opening_element" | "jsx_opening_tag") {
        return node
            .child_by_field_name("name")
            .and_then(|n| n.utf8_text(source).ok())
            .map(|s| s.to_string());
    }

    // ── Bash：command — 第一个命名子节点是命令名 ──
    if nk == "command" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.is_named() {
                return child.utf8_text(source).ok().map(|s| s.to_string());
            }
        }
    }

    // ── Elixir：dot → 最右侧，binary_operator → 运算符文本 ──
    if nk == "dot" {
        return node
            .child_by_field_name("right")
            .and_then(|r| r.utf8_text(source).ok())
            .map(|s| s.to_string());
    }
    if nk == "binary_operator" {
        return node
            .child_by_field_name("operator")
            .and_then(|op| op.utf8_text(source).ok())
            .map(|s| s.to_string());
    }

    // ── 函数式族：第一个子节点是被调用者 ──
    if matches!(nk, "apply" | "application_expression" | "exp_apply" | "list" | "list_lit" | "applicative") {
        let first = node.child(0)?;
        return extract_func_field_name(first, source);
    }

    None
}

/// 从 call expression 中提取第一个字符串参数（用于 require/import）。
fn extract_first_string_arg(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    let args = node.child_by_field_name("arguments")?;
    let mut cursor = args.walk();
    for child in args.children(&mut cursor) {
        let ck = child.kind();
        if ck == "string" || ck == "string_fragment" {
            return child.utf8_text(source).ok().map(|s| s.to_string());
        }
    }
    None
}

/// 从 throw/raise 节点提取异常类名。
fn extract_throw_target(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    // throw/raise 关键字之后的命名子节点是异常类型
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.is_named() && child.kind() != "throw" && child.kind() != "raise" {
            return child.utf8_text(source).ok().map(|s| s.to_string());
        }
    }
    None
}

/// 检查 identifier 是否在定义位置（不应创建 USAGE 边）。
/// ponytail: 仅跳过 (a) name 字段定义、(b) import/export 语句中的
/// identifier（绑定，非使用引用）。其他所有情况 — 包括函数
/// 参数和 call expression 中的非被调用者 identifier — 都会创建 USAGE 边。
fn is_definition_site(node: &tree_sitter::Node, _source: &[u8]) -> bool {
    if let Some(parent) = node.parent() {
        // 情况 1：identifier 是其父节点的 "name" 字段 → 定义位置
        if let Some(name_field) = parent.child_by_field_name("name") {
            if name_field.id() == node.id() {
                return true;
            }
        }
        // 情况 2：identifier 在 import/export 语句中 → 绑定，非使用
        // 向上遍历但在 scope 边界停止；仅检查 import/export 祖先。
        let mut cur = Some(parent);
        while let Some(p) = cur {
            let k = p.kind();
            if k.contains("import") || k.contains("export") {
                return true;
            }
            // 在 scope 边界停止 — 不要越过 function/class/module
            if k.contains("function") || k.contains("class") || k.contains("method")
                || k == "lambda" || k == "arrow_function" || k == "module"
                || k == "block" || k == "statement_block" || k == "source_file"
                || k == "program" || k == "module" || k == "translation_unit"
            {
                break;
            }
            cur = p.parent();
        }
    }
    false
}

/// 检查 identifier 是否在参数声明中（函数签名）。
fn is_param_decl(node: &tree_sitter::Node, _source: &[u8]) -> bool {
    let mut cur = Some(*node);
    while let Some(p) = cur.and_then(|n| n.parent()) {
        let k = p.kind();
        if k.contains("parameter") || k.contains("param") { return true; }
        // 在 function/class 边界停止
        if k.contains("function") || k.contains("class") || k.contains("method")
            || k == "lambda" || k == "arrow_function" || k == "module"
        {
            break;
        }
        cur = Some(p);
    }
    false
}

/// 各语言内置/常见名称黑名单，用于 USAGE 边过滤。
fn is_builtin_for_ext(name: &str, ext: &str) -> bool {
    match ext {
        "py" | "pyi" => matches!(
            name,
            "True" | "False" | "None" | "self" | "cls"
                | "print" | "len" | "range" | "str" | "int" | "float" | "bool"
                | "list" | "dict" | "tuple" | "set" | "frozenset"
                | "type" | "isinstance" | "issubclass" | "super"
                | "Exception" | "ValueError" | "TypeError" | "KeyError"
                | "IndexError" | "AttributeError" | "RuntimeError" | "StopIteration"
                | "map" | "filter" | "zip" | "enumerate" | "sorted" | "reversed"
                | "any" | "all" | "min" | "max" | "sum" | "abs" | "round"
                | "open" | "iter" | "next" | "hasattr" | "getattr" | "setattr"
                | "staticmethod" | "classmethod" | "property"
                | "os" | "sys" | "re" | "json" | "datetime" | "logging"
                | "__name__" | "__file__" | "__init__" | "__str__" | "__repr__"
        ),
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" => matches!(
            name,
            "console" | "window" | "document" | "globalThis" | "undefined" | "null"
                | "true" | "false" | "this" | "super" | "arguments"
                | "parseInt" | "parseFloat" | "isNaN" | "isFinite"
                | "JSON" | "Math" | "Object" | "Array" | "String" | "Number" | "Boolean"
                | "Map" | "Set" | "Date" | "RegExp" | "Promise" | "Symbol"
                | "Error" | "TypeError" | "SyntaxError" | "ReferenceError"
                | "Buffer" | "process" | "module" | "exports" | "require"
                | "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval"
                | "fetch" | "async" | "await" | "yield"
        ),
        "rs" => matches!(
            name,
            "true" | "false" | "self" | "Self" | "None" | "Ok" | "Err" | "Some"
                | "println" | "print" | "format" | "dbg" | "panic" | "todo" | "unimplemented"
                | "vec" | "Vec" | "String" | "str" | "Option" | "Result" | "Box"
                | "HashMap" | "HashSet" | "Iterator" | "Clone" | "Copy" | "Debug"
                | "Drop" | "Default" | "std" | "core" | "alloc"
                | "i32" | "i64" | "u32" | "u64" | "f32" | "f64" | "bool" | "usize" | "isize"
        ),
        "go" => matches!(
            name,
            "true" | "false" | "nil" | "iota"
                | "fmt" | "Println" | "Printf" | "Sprintf" | "Errorf"
                | "string" | "int" | "int32" | "int64" | "float32" | "float64"
                | "bool" | "byte" | "rune" | "error"
                | "make" | "new" | "len" | "cap" | "append" | "copy" | "delete"
                | "panic" | "recover" | "defer" | "close"
                | "context" | "os" | "io" | "http" | "json"
        ),
        "java" => matches!(
            name,
            "true" | "false" | "null" | "this" | "super"
                | "System" | "out" | "err" | "in"
                | "String" | "Integer" | "Long" | "Double" | "Float" | "Boolean"
                | "List" | "Map" | "Set" | "ArrayList" | "HashMap" | "HashSet"
                | "Optional" | "Stream" | "Collectors" | "Objects"
                | "Override" | "Deprecated" | "SuppressWarnings"
        ),
        "rb" => matches!(
            name,
            "true" | "false" | "nil" | "self"
                | "puts" | "print" | "p" | "pp" | "gets" | "raise" | "require"
                | "Array" | "Hash" | "String" | "Symbol" | "Integer" | "Float"
                | "Enumerable" | "each" | "map" | "select" | "reduce" | "inject"
                | "attr_accessor" | "attr_reader" | "attr_writer" | "include" | "extend"
        ),
        "php" => matches!(
            name,
            "true" | "false" | "null" | "this" | "self" | "static" | "parent"
                | "echo" | "print" | "isset" | "empty" | "unset" | "array" | "list"
                | "count" | "strlen" | "sprintf" | "explode" | "implode"
                | "array_map" | "array_filter" | "array_merge" | "array_keys"
                | "json_encode" | "json_decode" | "file_get_contents" | "file_put_contents"
        ),
        // 单字符 identifier 始终是噪声
        _ => name.len() <= 1,
    }
}

/// call 边中需跳过的噪声名称。
fn is_skip_name(name: &str) -> bool {
    // ponytail: 点分调用（obj.method）按首段判断 — console.log → "console"。
    // member_expression 提取完整名后，内置对象调用（console.log、JSON.parse、
    // Object.assign…）必须像裸名一样被跳过，否则会产生虚假调用边。
    let head = name.split('.').next().unwrap_or(name);
    matches!(
        head,
        "console" | "Error" | "TypeError" | "SyntaxError" | "ReferenceError"
            | "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval"
            | "fetch" | "JSON" | "Math" | "Object" | "Array" | "Promise"
            | "Map" | "Set" | "Date" | "RegExp" | "parseInt" | "parseFloat"
            | "require" | "import"
    )
}

/// 遍历类的子节点查找 extends_clause / implements_clause 并发出 Inherits 边。
fn emit_class_inherits(
    class_node: &tree_sitter::Node,
    source: &[u8],
    nid: &str,
    module_id: &str,
    file_id: &str,
    counter: &mut u32,
    edges: &mut Vec<Edge>,
) {
    let mut found = false;

    // 先尝试字段访问（在某些语法版本中有效）
    if let Some(ext) = class_node.child_by_field_name("extends") {
        emit_inherits_from_clause(&ext, source, nid, module_id, file_id, counter, edges);
        found = true;
    }
    if let Some(imp) = class_node.child_by_field_name("implements") {
        emit_inherits_from_clause(&imp, source, nid, module_id, file_id, counter, edges);
        found = true;
    }

    // 遍历子节点查找 extends_clause / implements_clause / class_heritage / argument_list
    let mut cursor = class_node.walk();
    for child in class_node.children(&mut cursor) {
        match child.kind() {
            "extends_clause" | "implements_clause" => {
                emit_inherits_from_clause(&child, source, nid, module_id, file_id, counter, edges);
                found = true;
            }
            "class_heritage" => {
                let mut hc = child.walk();
                for gc in child.children(&mut hc) {
                    if gc.kind() == "extends_clause" || gc.kind() == "implements_clause" {
                        emit_inherits_from_clause(&gc, source, nid, module_id, file_id, counter, edges);
                        found = true;
                    }
                }
            }
            // Python：class Foo(Bar) → argument_list 包含基类 identifier
            "argument_list" => {
                let mut ac = child.walk();
                for gc in child.children(&mut ac) {
                    if gc.kind() == "identifier" {
                        if let Ok(name) = gc.utf8_text(source) {
                            *counter += 1;
                            let target = format!("{}.{}", module_id, name);
                            edges.push(Edge::new(
                                format!("inh_{}_{}", file_id, counter),
                                nid, &target, EdgeKind::Inherits,
                            ));
                            found = true;
                        }
                    }
                }
            }
            // ponytail: 某些语法版本将 implements 类型直接嵌入为子节点，
            // 没有 implements_clause 包装。扫描在源文本中出现在
            // "implements" 之后的 type/identifier 子节点。
            _ => {}
        }
    }

    // 最后手段：扫描类源文本查找 extends/implements 模式
    if !found {
        // 跳过 — 已由上面的主遍历处理
    }
    // ponytail: 最后手段已禁用 — 它通过扫描类体文本中的
    // "extends"/"implements" 关键字产生了垃圾边。
    #[allow(unreachable_code)]
    if false {
        if let Ok(text) = class_node.utf8_text(source) {
            for keyword in &["extends", "implements"] {
                if let Some(pos) = text.find(keyword) {
                    let after = &text[pos + keyword.len()..];
                    // 提取到 '{' 或末尾
                    let clause = after.split('{').next().unwrap_or(after);
                    for part in clause.split(',') {
                        let name = part.split_whitespace().next().unwrap_or("").trim();
                        if !name.is_empty() && name != "{" && name != "}" {
                            let target_nid = format!("{}.{}", module_id, name);
                            *counter += 1;
                            let mut e = Edge::new(
                                format!("inh_{}_{}", file_id, *counter),
                                nid, &target_nid, EdgeKind::Inherits,
                            );
                            e.cross_file = true;
                            edges.push(e);
                        }
                    }
                }
            }
        }
    }
}

fn emit_inherits_from_clause(
    clause: &tree_sitter::Node,
    source: &[u8],
    nid: &str,
    module_id: &str,
    file_id: &str,
    counter: &mut u32,
    edges: &mut Vec<Edge>,
) {
    for name in extract_base_names_from_source(clause, source) {
        let target_nid = format!("{}.{}", module_id, name);
        *counter += 1;
        let mut e = Edge::new(
            format!("inh_{}_{}", file_id, *counter),
            nid,
            &target_nid,
            EdgeKind::Inherits,
        );
        e.cross_file = true;
        edges.push(e);
    }
}

/// 从继承子句节点提取基类型名（使用源文本）。
/// ponytail: 比 extract_base_names 更简单 — 仅从 "type_identifier"
/// 和 "identifier" 子节点读取文本。用于 extends/implements 子句。
fn extract_base_names_from_source(clause: &tree_sitter::Node, source: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    let mut to_visit: Vec<tree_sitter::Node> = vec![*clause];
    while let Some(node) = to_visit.pop() {
        let ck = node.kind();
        if ck == "identifier" || ck == "type_identifier" || ck == "property_identifier"
            || ck == "nested_type_identifier" || ck == "member_expression"
        {
            if let Ok(t) = node.utf8_text(source) {
                let t = t.trim().to_string();
                if !t.is_empty() && !names.contains(&t) {
                    names.push(t);
                }
            }
            continue;
        }
        // 递归进入容器节点
        if node.is_named() {
            let mut cursor = node.walk();
            let children: Vec<_> = node.children(&mut cursor).collect();
            to_visit.extend(children.into_iter().rev());
        }
    }
    // 回退：原始文本分割
    if names.is_empty() {
        if let Ok(text) = clause.utf8_text(source) {
            let text = text.trim();
            let text = text
                .trim_start_matches("extends ")
                .trim_start_matches("implements ")
                .trim_start_matches(':');
            for p in text.split(',') {
                let t = p.split_whitespace().next().unwrap_or("").trim();
                if !t.is_empty() {
                    names.push(t.to_string());
                }
            }
        }
    }
    names
}

// ── 测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    // ── JS/TS 测试 ──

    #[test]
    fn test_ts_function_declaration() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function hello() {}";
        let (nodes, _edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello"), "should find hello function, got {:?}", names);
    }

    #[test]
    fn test_ts_variable_assigned_arrow() {
        // ponytail: 这曾是一个关键缺口 — const f = () => {} 曾不可见
        let a = QueryStructureAdapter::new_js_ts();
        let src = "const fetchData = async () => { return 42; };";
        let (nodes, edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"fetchData"), "var-assigned arrow should be found, got {:?}", names);
        let defs: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Defines) && e.target.contains("fetchData")).collect();
        assert!(!defs.is_empty(), "should have Defines edge for fetchData");
        // ponytail: 防双节点回归 — variable_declarator 与包装的 arrow_function
        // 都建节点会出现 module.fetchData + module.fetchData.fetchData，
        // 后者成孤儿被 find_unused 误报死代码。只允许一个 fetchData 节点。
        let fetch_nodes: Vec<_> = nodes.iter().filter(|n| n.name == "fetchData").collect();
        assert_eq!(
            fetch_nodes.len(),
            1,
            "const X = () => {{}} must produce exactly ONE node, got {:#?}",
            fetch_nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_ts_variable_assigned_function_expr() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "const handler = function onEvent(ev) { return ev; };";
        let (nodes, _edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"handler"), "var-assigned fn expr should be found, got {:?}", names);
    }

    #[test]
    fn test_ts_call_expression() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function foo() {}\nfunction bar() { foo(); }";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "foo").collect();
        assert!(!calls.is_empty(), "should have call to foo");
    }

    #[test]
    fn test_ts_member_expression_call() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function bar() { obj.method(); }";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        // ponytail: member_expression 现在提取完整 object.property，
        // 以便 resolver 用 best_qualified_match 消歧跨文件静态方法调用。
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "obj.method").collect();
        assert!(!calls.is_empty(), "member expression call should extract object.property, got {:?}",
            edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls)).map(|e| &e.target).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_optional_chain_call() {
        // ponytail: a?.b() 的 function 字段是 optional_chain 而非 member_expression，
        // 需解包提取方法名（否则返回整段文本、跨文件解析失败）。
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function bar() { agentRef.current?.spawnSubAgent(); }";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls)).collect();
        let targets: Vec<&str> = calls.iter().map(|e| e.target.as_str()).collect();
        assert!(
            targets.iter().any(|t| t.contains("spawnSubAgent")),
            "optional chain call should extract method name, got {:?}",
            targets
        );
    }

    #[test]
    fn test_ts_nested_arrow_scope_call() {
        // ponytail: 嵌套箭头函数（const factory = async () => {...}）内的调用
        // 应归属到 factory scope。曾因 arrow_function 无 name 字段生成 <anon@N>
        // scope 截胡，导致内部调用挂到外层父函数、source 解析失败整条边丢失。
        let a = QueryStructureAdapter::new_js_ts();
        let src = "class A {\n  m() {\n    const factory = async () => {\n      loadSettings();\n    };\n  }\n}";
        let (nodes, edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"factory"), "factory node should exist, got {:?}", names);
        let calls: Vec<_> = edges.iter()
            .filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "loadSettings")
            .collect();
        assert!(!calls.is_empty(), "should have call to loadSettings");
        let srcs: Vec<&str> = calls.iter().map(|e| e.source.as_str()).collect();
        assert!(
            srcs.iter().any(|s| s.contains("A.m.factory")),
            "call should be attributed to A.m.factory, got {:?}",
            srcs
        );
        assert!(
            !srcs.iter().any(|s| s.ends_with("A.m")),
            "call must NOT be attributed to outer A.m, got {:?}",
            srcs
        );
    }

    #[test]
    fn test_ts_object_pair_arrow_scope_call() {
        // ponytail: 对象字面量属性里的箭头函数（{ subAgentSpawner: async () => {...} }）
        // 应从 pair.key 继承名字。曾生成 <anon@N> scope 导致内部调用
        // （agentRef.current?.spawnSubAgent()）挂到不存在节点、整条边丢失。
        let a = QueryStructureAdapter::new_js_ts();
        let src = "class A {\n  m() {\n    build({\n      subAgentSpawner: async () => {\n        spawnSubAgent();\n      },\n    });\n  }\n}";
        let (nodes, edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(
            names.contains(&"subAgentSpawner"),
            "subAgentSpawner node should exist, got {:?}",
            names
        );
        let calls: Vec<_> = edges.iter()
            .filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "spawnSubAgent")
            .collect();
        assert!(!calls.is_empty(), "should have call to spawnSubAgent");
        let srcs: Vec<&str> = calls.iter().map(|e| e.source.as_str()).collect();
        assert!(
            srcs.iter().any(|s| s.contains("A.m.subAgentSpawner")),
            "call should be attributed to A.m.subAgentSpawner, got {:?}",
            srcs
        );
    }

    #[test]
    fn test_ts_jsx_component() {
        // ponytail: JSX 需要 LANGUAGE_TSX 语法（而非 LANGUAGE_TYPESCRIPT）。
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function App() { return <div><Header /><Footer>text</Footer></div>; }";
        let (_nodes, edges, _) = a.analyze("test.tsx", src);
        let jsx_calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls)).collect();
        let targets: Vec<&str> = jsx_calls.iter().map(|e| e.target.as_str()).collect();
        assert!(targets.contains(&"Header"), "should find <Header /> call, got {:?}", targets);
        assert!(targets.contains(&"Footer"), "should find <Footer> call, got {:?}", targets);
        assert!(targets.contains(&"div"), "should find <div> call, got {:?}", targets);
    }

    /// 诊断：导出 TSX AST 以查找 tree-sitter-typescript 0.23 中的 JSX 节点类型名。
    #[test]
    fn test_tsx_ast_dump() {
        use crate::engine::GRAMMAR_LOADER;
        use tree_sitter::Parser;
        let lang = GRAMMAR_LOADER.get("tsx").expect("TSX grammar not loaded");
        let mut p = Parser::new();
        p.set_language(&lang).unwrap();
        let src = "<div><span>hello</span></div>";
        let tree = p.parse(src, None).unwrap();
        let root = tree.root_node();
        // 遍历所有节点并打印包含 "jsx" 或 "element" 的 kind
        let mut stack = vec![root];
        let mut jsx_nodes: Vec<String> = Vec::new();
        while let Some(node) = stack.pop() {
            let k = node.kind();
            if k.contains("jsx") || k.contains("element") || k.contains("JSX") {
                let text = node.utf8_text(src.as_bytes()).unwrap_or("?");
                jsx_nodes.push(format!("kind={} text='{}'", k, text));
            }
            for child in node.children(&mut node.walk()) {
                stack.push(child);
            }
        }
        // 同时导出树中所有节点 kind
        let mut kinds: Vec<String> = Vec::new();
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            kinds.push(node.kind().to_string());
            for child in node.children(&mut node.walk()) {
                stack.push(child);
            }
        }
        kinds.sort();
        kinds.dedup();
        eprintln!("JSX nodes: {:?}", jsx_nodes);
        eprintln!("ALL node kinds: {:?}", kinds);
    }

    #[test]
    fn test_ts_import() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "import { stuff } from './module';";
        let (_nodes, edges, _) = a.analyze("src/test.ts", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        assert!(!imports.is_empty(), "should have import edge");
    }

    #[test]
    fn test_ts_export_reexport() {
        // ponytail: barrel 文件导出曾不可见
        let a = QueryStructureAdapter::new_js_ts();
        let src = "export { foo } from './bar';";
        let (_nodes, edges, _) = a.analyze("src/index.ts", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        assert!(!imports.is_empty(), "re-export should create import edge, got {:?}",
            edges.iter().map(|e| format!("{} kind={}", e.target, e.kind.as_str())).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_class_extends() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "class Dog extends Animal {}";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let inh: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Inherits)).collect();
        assert!(!inh.is_empty(), "extends should create Inherits edge, got {:?}",
            edges.iter().map(|e| format!("{} -> {}", e.source, e.target)).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_class_implements() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "class UserRepo implements IUserRepo {}";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        // ponytail: implements_clause 提取取决于语法结构。
        // 验证类节点及其子节点可访问。
        // extract_base_names_from_source 中的回退文本解析处理
        // 结构化遍历遗漏名称的情况。
        let inh: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Inherits)).collect();
        if inh.is_empty() {
            // 如果结构化提取遗漏了，回退文本解析器应能捕获。
            // 打印边以调试语法差异。
            eprintln!("DEBUG implements: all edges = {:?}",
                edges.iter().map(|e| format!("{} -> {} ({})", e.source, e.target, e.kind.as_str())).collect::<Vec<_>>());
        }
        assert!(!inh.is_empty(), "implements should create Inherits edge, got {:?}",
            edges.iter().map(|e| format!("{} -> {}", e.source, e.target)).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_require_import() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "const fs = require('fs');";
        let (_nodes, edges, _) = a.analyze("test.js", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports) && e.target.contains("fs")).collect();
        assert!(!imports.is_empty(), "require('fs') should create import edge, got imports: {:?}",
            edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).map(|e| &e.target).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_dynamic_import() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "const mod = await import('./lazy');";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports) && e.target.contains("lazy")).collect();
        assert!(!imports.is_empty(), "dynamic import() should create import edge, got imports: {:?}",
            edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).map(|e| &e.target).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_call_scope_attribution() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function outer() {\n  function inner() {\n    foo();\n  }\n}";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let call = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "foo");
        assert!(call.is_some(), "should have call to foo");
        let call = call.unwrap();
        assert!(call.source.contains("inner"), "call inside inner should be attributed to inner, got '{}'", call.source);
    }

    #[test]
    fn test_ts_enum() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "enum Status { Active, Inactive }";
        let (nodes, _edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Status"), "enum should be found, got {:?}", names);
    }

    #[test]
    fn test_ts_new_expression() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "class Foo {}\nfunction bar() { new Foo(); }";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "Foo").collect();
        assert!(!calls.is_empty(), "new Foo() should create call edge");
    }

    // ── Rust 测试 ──

    #[test]
    fn test_rust_function() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn hello() {}\npub fn add(a: i32, b: i32) -> i32 { a + b }";
        let (nodes, _edges, _) = a.analyze("lib.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello"), "should find hello, got {:?}", names);
        assert!(names.contains(&"add"), "should find add, got {:?}", names);
    }

    #[test]
    fn test_rust_struct() {
        let a = QueryStructureAdapter::new_rust();
        let src = "struct Point { x: f64, y: f64 }";
        let (nodes, _edges, _) = a.analyze("lib.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Point"), "struct should be found, got {:?}", names);
    }

    #[test]
    fn test_rust_trait_and_impl() {
        let a = QueryStructureAdapter::new_rust();
        let src = "trait Draw { fn draw(&self); }\nstruct Circle;\nimpl Draw for Circle { fn draw(&self) {} }";
        let (nodes, edges, _) = a.analyze("lib.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Draw"), "trait should be found");
        assert!(names.contains(&"Circle"), "struct should be found");
        let inh: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Inherits)).collect();
        assert!(!inh.is_empty(), "impl Draw for Circle should produce Inherits edge, got {:?}",
            edges.iter().map(|e| format!("{} -> {}", e.source, e.target)).collect::<Vec<_>>());
    }

    #[test]
    fn test_rust_call() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn helper() {}\nfn outer() { helper(); }";
        let (_nodes, edges, _) = a.analyze("lib.rs", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "helper").collect();
        assert!(!calls.is_empty(), "should have call to helper");
    }

    #[test]
    fn test_rust_call_scope_attribution() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn outer() { fn inner() { foo(); } }";
        let (_nodes, edges, _) = a.analyze("lib.rs", src);
        let call = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "foo");
        assert!(call.is_some(), "should have call to foo");
        let call = call.unwrap();
        assert!(call.source.contains("inner"), "call inside inner should be attributed to inner, got '{}'", call.source);
    }

    #[test]
    fn test_rust_macro_call() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn main() { println!(\"hello\"); }";
        let (_nodes, edges, _) = a.analyze("main.rs", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "println").collect();
        assert!(!calls.is_empty(), "macro invocation should create call edge");
    }

    #[test]
    fn test_rust_method_call() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn process(v: Vec<i32>) { let n = v.len(); }";
        let (_nodes, edges, _) = a.analyze("lib.rs", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "len").collect();
        assert!(!calls.is_empty(), "field expression call should extract method name");
    }

    #[test]
    fn test_rust_use_declaration() {
        let a = QueryStructureAdapter::new_rust();
        let src = "use std::collections::HashMap;";
        let (_nodes, edges, _) = a.analyze("lib.rs", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        assert!(!imports.is_empty(), "use declaration should create import edge");
    }

    #[test]
    fn test_rust_type_alias() {
        let a = QueryStructureAdapter::new_rust();
        let src = "type Meters = f64;";
        let (nodes, _edges, _) = a.analyze("lib.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Meters"), "type alias should be found, got {:?}", names);
    }

    #[test]
    fn test_ts_multiple_imports() {
        // 验证所有 import 变体都创建边
        let a = QueryStructureAdapter::new_js_ts();
        let src = "import { bus } from './events';\nimport type { AgentEvent } from '../agent/types';\nexport function foo() {}";
        let (_nodes, edges, _) = a.analyze("src/ui/chat.ts", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        let targets: Vec<&str> = imports.iter().map(|e| e.target.as_str()).collect();
        assert!(!imports.is_empty(), "should have import edges, got edges: {:?}",
            edges.iter().map(|e| format!("{}->{} ({})", e.source, e.target, e.kind.as_str())).collect::<Vec<_>>());
        eprintln!("DEBUG import targets: {:?}", targets);
    }

    #[test]
    fn test_ts_file_id_preserves_directory() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function hello() {}";
        let (nodes, _, _) = a.analyze("src/ui/graph.ts", src);
        let file_node = nodes.iter().find(|n| matches!(n.kind, NodeKind::File));
        assert!(file_node.is_some());
        let fid = &file_node.unwrap().id;
        assert!(fid.contains("src"), "file_id should contain dir, got '{}'", fid);
        assert!(fid.contains("ui"), "file_id should contain subdir, got '{}'", fid);
    }

    // ── Python 覆盖率测试 ──

    fn py_adapter() -> QueryStructureAdapter {
        QueryStructureAdapter::new_generic(
            vec!["py".into()],
            include_str!("../../queries/python_structure.scm"),
            &["function_definition", "lambda"],
            &["class_definition"],
        )
    }

    #[test]
    fn test_py_function_declaration() {
        let a = py_adapter();
        let src = "def foo():\n    pass";
        let (nodes, _edges, _) = a.analyze("test.py", src);
        let fns: Vec<_> = nodes.iter().filter(|n| matches!(n.kind, NodeKind::Function)).collect();
        assert_eq!(fns.len(), 1, "should have 1 function");
        assert_eq!(fns[0].name, "foo");
    }

    #[test]
    fn test_py_decorator_function() {
        let a = py_adapter();
        let src = "@classmethod\ndef foo(cls):\n    pass";
        let (nodes, _edges, _) = a.analyze("test.py", src);
        let fns: Vec<_> = nodes.iter().filter(|n| matches!(n.kind, NodeKind::Function)).collect();
        assert!(!fns.is_empty(), "decorated function should be captured by @fn, got nodes: {:?}",
            nodes.iter().map(|n| format!("[{:?}] {}", n.kind, n.name)).collect::<Vec<_>>());
        assert_eq!(fns[0].name, "foo");
    }

    #[test]
    fn test_py_class_method() {
        let a = py_adapter();
        let src = "class Foo:\n    def bar(self):\n        pass";
        let (nodes, _edges, _) = a.analyze("test.py", src);
        let fns: Vec<_> = nodes.iter().filter(|n| matches!(n.kind, NodeKind::Function)).collect();
        assert!(!fns.is_empty(), "class method should be captured");
        // 现在带 scope 限定：test.py.Foo.bar 而非 test.py.bar
        assert!(fns[0].id.contains("Foo.bar"), "method should be scoped to class, got id={}", fns[0].id);
    }

    #[test]
    fn test_py_nested_function_scope() {
        let a = py_adapter();
        let src = "def outer():\n    def inner():\n        pass";
        let (nodes, _edges, _) = a.analyze("test.py", src);
        let fns: Vec<_> = nodes.iter().filter(|n| matches!(n.kind, NodeKind::Function)).collect();
        assert_eq!(fns.len(), 2);
        let inner = fns.iter().find(|n| n.name == "inner").unwrap();
        assert!(inner.id.contains("outer.inner"), "nested fn should be scope-qualified, got id={}", inner.id);
    }

    #[test]
    fn test_py_decorated_method_scope() {
        let a = py_adapter();
        let src = "class Foo:\n    @staticmethod\n    def bar():\n        pass";
        let (nodes, _edges, _) = a.analyze("test.py", src);
        let fns: Vec<_> = nodes.iter().filter(|n| matches!(n.kind, NodeKind::Function)).collect();
        assert!(!fns.is_empty());
        assert!(fns[0].id.contains("Foo.bar"), "decorated method should be scoped to class, got id={}", fns[0].id);
    }

    #[test]
    fn test_py_class_var_scope() {
        let a = py_adapter();
        let src = "class Foo:\n    x = 1\n    def bar(self):\n        y = 2";
        let (nodes, _edges, _) = a.analyze("test.py", src);
        let vars: Vec<_> = nodes.iter().filter(|n| matches!(n.kind, NodeKind::Variable)).collect();
        let class_var = vars.iter().find(|n| n.name == "x").unwrap();
        let local_var = vars.iter().find(|n| n.name == "y").unwrap();
        assert!(class_var.id.contains("Foo.x"), "class var should be in class scope, got {}", class_var.id);
        assert!(local_var.id.contains("bar.y"), "local var should be in fn scope, got {}", local_var.id);
    }

    #[test]
    fn test_py_usage_scope_attribution() {
        let a = py_adapter();
        let src = "class Foo:\n    def bar(self):\n        val = 1\n        print(val)";
        let (_nodes, edges, _) = a.analyze("test.py", src);
        // "val" 的 Usage 边应来自 bar 的 scope
        let usage = edges.iter().find(|e| matches!(e.kind, EdgeKind::Usage) && e.target == "val");
        assert!(usage.is_some(), "should have Usage edge for val, got usages: {:?}",
            edges.iter().filter(|e| matches!(e.kind, EdgeKind::Usage)).map(|e| format!("{}->{}", e.source, e.target)).collect::<Vec<_>>());
        let u = usage.unwrap();
        assert!(u.source.contains("Foo.bar"), "usage of val should be from Foo.bar scope, got source={}", u.source);
    }

    #[test]
    fn test_py_call_scope_attribution() {
        let a = py_adapter();
        let src = "class Foo:\n    def bar(self):\n        self.baz()";
        let (_nodes, edges, _) = a.analyze("test.py", src);
        // self.baz 的 Call 边应来自 bar 的 scope
        let call = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls));
        assert!(call.is_some(), "should have Calls edge for self.baz, got edges: {:?}",
            edges.iter().map(|e| format!("[{}] {}->{}", e.kind.as_str(), e.source, e.target)).collect::<Vec<_>>());
        let c = call.unwrap();
        assert!(c.source.contains("Foo.bar"), "call source should be Foo.bar scope, got {}", c.source);
    }

    #[test]
    fn test_py_write_scope_attribution() {
        let a = py_adapter();
        let src = "val = 1\ndef foo():\n    val += 2";
        let (_nodes, edges, _) = a.analyze("test.py", src);
        // @write should create write edge from foo's scope
        let writes: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Writes)).collect();
        let foo_write = writes.iter().find(|e| e.source.contains("foo"));
        assert!(foo_write.is_some(), "write inside foo() should be from foo scope, got writes: {:?}",
            writes.iter().map(|e| format!("{}->{}", e.source, e.target)).collect::<Vec<_>>());
    }

    /// 诊断：解析真实文件并导出所有节点和边。
    /// 运行方式：cargo test -p hologram-engine -- inspect_real_file --nocapture
    #[test]
    fn inspect_real_file() {
        let path = r"D:\django\django\views\generic\base.py";
        let source = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => { eprintln!("SKIP: cannot read {path}: {e}"); return; }
        };
        let lang = match crate::engine::GRAMMAR_LOADER.get("py") {
            Some(l) => l,
            None => { eprintln!("SKIP: no Python grammar"); return; }
        };

        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&lang).unwrap();
        let tree = parser.parse(&source, None).unwrap();

        let query_src = include_str!("../../queries/python_structure.scm");
        let (nodes, edges) = process_query(
            &tree, &source, path, query_src,
            &lang,
            &["function_definition", "lambda"],
            &["class_definition"],
        );

        // ── 摘要 ──
        let mut nk: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for n in &nodes { *nk.entry(format!("{:?}", n.kind)).or_default() += 1; }
        let mut ek: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for e in &edges { *ek.entry(format!("{:?}", e.kind)).or_default() += 1; }

        println!("=== {path} ===");
        println!("Nodes: {}  Edges: {}", nodes.len(), edges.len());
        println!("Node kinds: {:?}", nk);
        println!("Edge kinds: {:?}", ek);

        // ── 按 kind 排序的节点 ──
        println!("\n=== NODES ===");
        for n in &nodes {
            let cf = if n.location.as_deref() == Some(path) { "" } else { " [REMOTE]" };
            println!("  [{:?}] id={} name={}{}", n.kind, n.id, n.name, cf);
        }

        // ── 按 kind 分组的边 ──
        println!("\n=== EDGES (Calls) ===");
        for e in &edges {
            if matches!(e.kind, crate::graph::EdgeKind::Calls) {
                println!("  {} -> {}", e.source, e.target);
            }
        }
        println!("\n=== EDGES (Usage) ===");
        for e in &edges {
            if matches!(e.kind, crate::graph::EdgeKind::Usage) {
                println!("  {} -> {}", e.source, e.target);
            }
        }
        println!("\n=== EDGES (Imports) ===");
        for e in &edges {
            if matches!(e.kind, crate::graph::EdgeKind::Imports) {
                println!("  {} -> {}", e.source, e.target);
            }
        }
        println!("\n=== EDGES (Inherits) ===");
        for e in &edges {
            if matches!(e.kind, crate::graph::EdgeKind::Inherits) {
                println!("  {} -> {}", e.source, e.target);
            }
        }
        println!("\n=== EDGES (Defines) ===");
        for e in &edges {
            if matches!(e.kind, crate::graph::EdgeKind::Defines) {
                println!("  {} -> {}", e.source, e.target);
            }
        }
        println!("\n=== EDGES (Writes) ===");
        for e in &edges {
            if matches!(e.kind, crate::graph::EdgeKind::Writes) {
                println!("  {} -> {}", e.source, e.target);
            }
        }
        println!("\n=== EDGES (Other) ===");
        for e in &edges {
            if !matches!(e.kind, crate::graph::EdgeKind::Calls | crate::graph::EdgeKind::Usage | crate::graph::EdgeKind::Imports | crate::graph::EdgeKind::Inherits | crate::graph::EdgeKind::Defines | crate::graph::EdgeKind::Writes) {
                println!("  [{:?}] {} -> {}", e.kind, e.source, e.target);
            }
        }
    }

    #[test]
    fn test_c_structure_query_extracts() {
        // 回归:c_structure.scm 必须能在 tree-sitter-c 上编译。
        // 曾因引用 C 语法不存在的 throw_statement 导致整个查询编译失败,
        // C 文件结构提取被静默跳过(内核压测 5.1 万文件只剩文件节点)。
        let source = r#"
#include <stdio.h>
int add(int a, int b) { return a + b; }
int main(void) {
    int r = add(1, 2);
    printf("%d\n", r);
    return 0;
}
"#;
        let lang = match crate::engine::GRAMMAR_LOADER.get("c") {
            Some(l) => l,
            None => { eprintln!("SKIP: no C grammar"); return; }
        };
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&lang).unwrap();
        let tree = parser.parse(source, None).unwrap();

        let query_src = include_str!("../../queries/c_structure.scm");
        let (nodes, edges) = process_query(
            &tree, source, "test.c", query_src,
            &lang,
            &["function_definition"],
            &["struct_specifier", "union_specifier"],
        );

        assert!(
            nodes.iter().any(|n| n.name.contains("add")),
            "C 函数定义应被提取,实际节点: {:?}",
            nodes.iter().map(|n| &n.name).collect::<Vec<_>>()
        );
        assert!(
            edges.iter().any(|e| matches!(e.kind, crate::graph::EdgeKind::Calls)),
            "C 调用边应被提取"
        );
    }
}
