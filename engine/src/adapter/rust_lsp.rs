// Rust LSP — type-aware call resolution for Rust source files.
// Ports rust_lsp.c (5479 lines C → ~700 lines Rust).
//
// Architecture (mirrors go_lsp.rs):
//   process_file(ctx, root)
//     ├─ extract_uses → populate use map
//     ├─ bind_module_types → register local types/fns in scope
//     ├─ Pass 1: top-level items (struct/enum/trait/impl)
//     └─ Pass 2: functions/methods → process_function
//          └─ resolve_calls_in → emit_call_for

use tree_sitter::Node;

use crate::adapter::scope::Scope;
use crate::adapter::type_registry::TypeRegistry;
use crate::adapter::types::Type;

pub use crate::adapter::ResolvedCall;

// ── Confidence constants (mirrors rust_lsp.h) ──

const CONF_DIRECT: f32 = 0.95;
const CONF_METHOD: f32 = 0.95;
const CONF_TRAIT_SOLE: f32 = 0.92;
const CONF_TRAIT_AMB: f32 = 0.85;
const CONF_UFCS: f32 = 0.93;

// ── Context ──

pub(crate) struct UseEntry {
    pub local: String,
    pub path: String, // "std::collections::HashMap"
    pub is_glob: bool,
}

pub struct RustLspContext<'a> {
    pub source: &'a str,
    pub registry: &'a TypeRegistry,
    pub current_scope: Scope,
    pub module_qn: String,
    pub uses: Vec<UseEntry>,
    /// When inside `impl T { … }` or `impl Trait for T { … }`, the Self type QN.
    pub self_type_qn: Option<String>,
    /// When inside `impl Trait for T { … }`, the trait QN.
    pub self_trait_qn: Option<String>,
    pub enclosing_func_qn: Option<String>,
    pub resolved_calls: Vec<ResolvedCall>,
    /// Recursion depth guard — cap walk depth to avoid stack overflow.
    pub walk_depth: u32,
}

const MAX_WALK_DEPTH: u32 = 64;

impl<'a> RustLspContext<'a> {
    pub fn new(source: &'a str, registry: &'a TypeRegistry, module_qn: &str) -> Self {
        Self {
            source,
            registry,
            current_scope: Scope::new_root(),
            module_qn: module_qn.to_string(),
            uses: Vec::new(),
            self_type_qn: None,
            self_trait_qn: None,
            enclosing_func_qn: None,
            resolved_calls: Vec::new(),
            walk_depth: 0,
        }
    }

    fn node_text(&self, node: Node) -> Option<&str> {
        node.utf8_text(self.source.as_bytes()).ok()
    }

    pub fn add_use(&mut self, local: &str, path: &str, is_glob: bool) {
        self.uses.push(UseEntry {
            local: local.to_string(),
            path: path.to_string(),
            is_glob,
        });
    }

    fn emit(&mut self, callee_qn: &str, strategy: &str, confidence: f32) {
        let Some(ref caller) = self.enclosing_func_qn.clone() else {
            return;
        };
        let start = self.resolved_calls.len().saturating_sub(256);
        for rc in &self.resolved_calls[start..] {
            if rc.caller_qn == *caller && rc.callee_qn == callee_qn {
                return;
            }
        }
        self.resolved_calls.push(ResolvedCall {
            caller_qn: caller.clone(),
            callee_qn: callee_qn.to_string(),
            strategy: strategy.to_string(),
            confidence,
        });
    }

    // ── Path resolution (Rust `use` + module system) ──

    /// Resolve a simple name through `use` imports, returning the full path or None.
    fn resolve_use(&self, name: &str) -> Option<String> {
        // 1. Exact `use` match
        for u in &self.uses {
            if u.local == name && !u.is_glob {
                return Some(u.path.clone());
            }
        }
        // 2. Glob imports — check if the name exists under any glob module
        for u in &self.uses {
            if u.is_glob {
                let qn = format!("{}.{}", u.path, name);
                if self.registry.lookup_type(&qn).is_some()
                    || self.registry.lookup_func(&qn).is_some()
                {
                    return Some(qn);
                }
            }
        }
        // 3. Same-module lookup
        let local_qn = format!("{}.{}", self.module_qn, name);
        if self.registry.lookup_type(&local_qn).is_some()
            || self.registry.lookup_func(&local_qn).is_some()
        {
            return Some(local_qn);
        }
        // 4. Self-type member (when inside impl)
        if let Some(ref self_ty) = self.self_type_qn {
            if let Some(f) = self.registry.lookup_method(self_ty, name) {
                return Some(f.qualified_name.clone());
            }
        }
        None
    }

    /// Resolve `A::B::C` path to a fully-qualified name.
    fn resolve_path(&self, segments: &[&str]) -> Option<String> {
        if segments.is_empty() {
            return None;
        }
        // `self` → current module
        let start = if segments[0] == "self" {
            if segments.len() == 1 {
                return Some(self.module_qn.clone());
            }
            self.module_qn.clone()
        } else if segments[0] == "crate" {
            // `crate::foo` → <module_root>.foo
            let root = self
                .module_qn
                .split('.')
                .next()
                .unwrap_or(&self.module_qn);
            let rest: Vec<&str> = segments[1..].to_vec();
            if rest.is_empty() {
                return Some(root.to_string());
            }
            format!("{}.{}", root, rest.join("."))
        } else if segments[0] == "super" {
            // `super::foo` → parent module
            let parent = self.module_qn.rsplit('.').nth(1).unwrap_or("");
            if segments.len() == 1 {
                return Some(parent.to_string());
            }
            format!("{}.{}", parent, segments[1..].join("."))
        } else {
            // Try resolving the first segment through `use`
            if let Some(resolved) = self.resolve_use(segments[0]) {
                if segments.len() == 1 {
                    return Some(resolved);
                }
                return Some(format!("{}.{}", resolved, segments[1..].join(".")));
            }
            // Fallback: prepend module QN
            format!("{}.{}", self.module_qn, segments.join("."))
        };
        Some(start)
    }

    fn resolve_path_node(&self, node: Node) -> Option<String> {
        let mut segments = Vec::new();
        self.collect_path_segments(node, &mut segments);
        if segments.is_empty() {
            return self.node_text(node).map(|s| s.to_string());
        }
        let seg_refs: Vec<&str> = segments.iter().map(|s| s.as_str()).collect();
        self.resolve_path(&seg_refs)
    }

    fn collect_path_segments(&self, node: Node, out: &mut Vec<String>) {
        match node.kind() {
            "identifier" | "type_identifier" | "self" | "crate" | "super" => {
                if let Some(t) = self.node_text(node) {
                    out.push(t.to_string());
                }
            }
            "scoped_identifier" | "scoped_type_identifier" => {
                if let Some(path) = node.child_by_field_name("path") {
                    self.collect_path_segments(path, out);
                }
                if let Some(name) = node.child_by_field_name("name") {
                    if let Some(t) = self.node_text(name) {
                        out.push(t.to_string());
                    }
                }
            }
            "scoped_use_list" => {
                // use foo::{bar, baz}
                if let Some(path) = node.child_by_field_name("path") {
                    self.collect_path_segments(path, out);
                }
            }
            _ => {
                if let Some(t) = self.node_text(node) {
                    out.push(t.to_string());
                }
            }
        }
    }

    // ── Type parsing ──

    pub fn parse_type_node(&self, node: Node) -> Type {
        if node.kind().is_empty() {
            return Type::Unknown;
        }
        match node.kind() {
            "primitive_type" => {
                let name = self.node_text(node).unwrap_or("_");
                Type::Builtin {
                    name: name.to_string(),
                }
            }
            "type_identifier" | "identifier" => {
                let name = self.node_text(node).unwrap_or("");
                if let Some(resolved) = self.resolve_use(name) {
                    return Type::Named { qn: resolved };
                }
                let local = format!("{}.{}", self.module_qn, name);
                if self.registry.lookup_type(&local).is_some() {
                    return Type::Named { qn: local };
                }
                Type::Named {
                    qn: name.to_string(),
                }
            }
            "scoped_type_identifier" => {
                if let Some(qn) = self.resolve_path_node(node) {
                    Type::Named { qn }
                } else {
                    let name = self.node_text(node).unwrap_or("");
                    Type::Named {
                        qn: name.replace("::", "."),
                    }
                }
            }
            "reference_type" => {
                let inner = node
                    .named_child(0)
                    .map(|n| self.parse_type_node(n))
                    .unwrap_or(Type::Unknown);
                Type::Template {
                    name: "&".into(),
                    args: vec![inner],
                }
            }
            "pointer_type" => {
                let inner = node
                    .named_child(0)
                    .map(|n| self.parse_type_node(n))
                    .unwrap_or(Type::Unknown);
                Type::Template {
                    name: "*const".into(),
                    args: vec![inner],
                }
            }
            "generic_type" => {
                let base = node
                    .child_by_field_name("type")
                    .map(|t| self.parse_type_node(t))
                    .unwrap_or(Type::Unknown);
                let type_args = node.child_by_field_name("type_arguments");
                let args: Vec<Type> = type_args
                    .map(|ta| {
                        (0..ta.named_child_count())
                            .filter_map(|i| ta.named_child(i).map(|n| self.parse_type_node(n)))
                            .collect()
                    })
                    .unwrap_or_default();
                if let Type::Named { qn } = &base {
                    Type::Template {
                        name: qn.clone(),
                        args,
                    }
                } else {
                    base
                }
            }
            "tuple_type" => {
                let elems: Vec<Type> = (0..node.named_child_count())
                    .filter_map(|i| node.named_child(i).map(|n| self.parse_type_node(n)))
                    .collect();
                Type::Tuple { elems }
            }
            "array_type" => {
                let inner = node
                    .named_child(0)
                    .map(|n| self.parse_type_node(n))
                    .unwrap_or(Type::Unknown);
                Type::Template {
                    name: "array".into(),
                    args: vec![inner],
                }
            }
            "slice_type" => {
                let inner = node
                    .named_child(0)
                    .map(|n| self.parse_type_node(n))
                    .unwrap_or(Type::Unknown);
                Type::Template {
                    name: "slice".into(),
                    args: vec![inner],
                }
            }
            _ => {
                let name = self.node_text(node).unwrap_or("");
                if !name.is_empty() {
                    Type::Named {
                        qn: name.to_string(),
                    }
                } else {
                    Type::Unknown
                }
            }
        }
    }

    // ── Expression type evaluation ──

    pub fn eval_expr_type(&self, node: Node) -> Type {
        if node.kind().is_empty() {
            return Type::Unknown;
        }
        let k = node.kind();
        match k {
            "integer_literal" | "float_literal" | "decimal_literal" | "hex_literal"
            | "octal_literal" | "binary_literal" => {
                if k.contains("float") {
                    Type::Builtin {
                        name: "f64".into(),
                    }
                } else {
                    Type::Builtin { name: "i32".into() }
                }
            }
            "string_literal" | "raw_string_literal" | "character_literal" => {
                let name = if k == "character_literal" {
                    "char"
                } else {
                    "str"
                };
                Type::Builtin {
                    name: name.to_string(),
                }
            }
            "boolean_literal" => Type::Builtin {
                name: "bool".into(),
            },

            "identifier" | "type_identifier" => {
                let name = self.node_text(node).unwrap_or("").to_string();
                // 1. Scope lookup
                let t = self.current_scope.lookup(&name);
                if !t.is_unknown() {
                    return t;
                }
                // 2. `self` → receiver type
                if name == "self" {
                    if let Some(ref st) = self.self_type_qn {
                        return Type::Named { qn: st.clone() };
                    }
                }
                // 3. Use resolution
                if let Some(qn) = self.resolve_use(&name) {
                    return Type::Named { qn };
                }
                // 4. Module-local
                if let Some(f) = self.registry.lookup_symbol(&self.module_qn, &name) {
                    return f.ret.clone();
                }
                Type::Unknown
            }

            "scoped_identifier" => {
                if let Some(qn) = self.resolve_path_node(node) {
                    if let Some(f) = self.registry.lookup_func(&qn) {
                        return f.ret.clone();
                    }
                    return Type::Named { qn };
                }
                Type::Unknown
            }

            "field_expression" => {
                let value = node.child_by_field_name("value");
                let field = node.child_by_field_name("field");
                let (Some(val), Some(field)) = (value, field) else {
                    return Type::Unknown;
                };
                let val_type = self.eval_expr_type(val);
                let fname = self.node_text(field).unwrap_or("");
                self.eval_field_access(&val_type, fname)
            }

            "call_expression" => {
                let fn_node = node.child_by_field_name("function");
                let Some(fn_node) = fn_node else {
                    return Type::Unknown;
                };
                let callee = self.eval_expr_type(fn_node);
                match callee {
                    Type::Callable { ret, .. } => *ret,
                    Type::Named { .. } | Type::Builtin { .. } | Type::Template { .. } => callee,
                    _ => Type::Unknown,
                }
            }

            "method_call_expression" => {
                // obj.method() — field_expression inside a call
                let func_node = node.child_by_field_name("function");
                if let Some(func) = func_node {
                    if func.kind() == "field_expression" {
                        let value = func.child_by_field_name("value");
                        let field = func.child_by_field_name("field");
                        if let (Some(val), Some(field)) = (value, field) {
                            let val_type = self.eval_expr_type(val);
                            let fname = self.node_text(field).unwrap_or("");
                            let ret = self.eval_method_call(&val_type, fname);
                            if !ret.is_unknown() {
                                return ret;
                            }
                        }
                    }
                    self.eval_expr_type(func)
                } else {
                    Type::Unknown
                }
            }

            "struct_expression" | "struct_literal" => {
                let name_node = node.child_by_field_name("name");
                name_node
                    .map(|n| {
                        let t = self.eval_expr_type(n);
                        match t {
                            Type::Unknown => Type::Unknown,
                            other => other,
                        }
                    })
                    .unwrap_or(Type::Unknown)
            }

            "parenthesized_expression" => node
                .named_child(0)
                .map(|n| self.eval_expr_type(n))
                .unwrap_or(Type::Unknown),

            "binary_expression" => {
                let left = node.child_by_field_name("left");
                left.map(|l| self.eval_expr_type(l))
                    .unwrap_or(Type::Unknown)
            }

            "unary_expression" | "reference_expression" => node
                .named_child(0)
                .map(|n| self.eval_expr_type(n))
                .unwrap_or(Type::Unknown),

            "array_expression" | "array_literal" => {
                let first = node.named_child(0);
                first
                    .map(|f| {
                        let t = self.eval_expr_type(f);
                        Type::Template {
                            name: "Vec".into(),
                            args: vec![t],
                        }
                    })
                    .unwrap_or(Type::Template {
                        name: "Vec".into(),
                        args: vec![Type::Unknown],
                    })
            }

            "macro_invocation" => {
                // Heuristic: known macros that return specific types
                let macro_name = node
                    .child_by_field_name("macro")
                    .and_then(|m| self.node_text(m))
                    .unwrap_or("");
                match macro_name {
                    "vec" => {
                        let first_elem = node
                            .child_by_field_name("token_tree")
                            .and_then(|tt| tt.named_child(0))
                            .map(|n| self.eval_expr_type(n))
                            .unwrap_or(Type::Unknown);
                        Type::Template {
                            name: "Vec".into(),
                            args: vec![first_elem],
                        }
                    }
                    "format" | "print" | "println" | "eprintln" => Type::Builtin {
                        name: "()".into(),
                    },
                    "String" | "str" => {
                        if macro_name == "String" {
                            Type::Named {
                                qn: "std.string.String".into(),
                            }
                        } else {
                            Type::Builtin { name: "str".into() }
                        }
                    }
                    _ => Type::Unknown,
                }
            }

            "if_expression" | "match_expression" | "block" => {
                // Try to find the type from the first non-trivial expression
                let nc = node.named_child_count();
                for i in 0..nc {
                    let c = node.named_child(i).unwrap_or(node);
                    if c.kind() != "if" && c.kind() != "else" && c.kind() != "match_arm" {
                        let t = self.eval_expr_type(c);
                        if !t.is_unknown() {
                            return t;
                        }
                    }
                }
                Type::Unknown
            }

            "await_expression" => {
                node.named_child(0)
                    .map(|n| self.eval_expr_type(n))
                    .unwrap_or(Type::Unknown)
            }

            _ => Type::Unknown,
        }
    }

    fn eval_field_access(&self, obj_type: &Type, fname: &str) -> Type {
        match obj_type {
            Type::Named { qn } | Type::Template { name: qn, .. } => {
                // Try method first
                if let Some(f) = self.registry.lookup_method(qn, fname) {
                    return f.ret.clone();
                }
                // Try field
                if let Some(rt) = self.registry.lookup_type(qn) {
                    if let Some(t) = rt.fields.get(fname) {
                        return t.clone();
                    }
                }
                Type::Unknown
            }
            Type::Module { qn } => {
                if let Some(f) = self.registry.lookup_symbol(qn, fname) {
                    return f.ret.clone();
                }
                let fqn = format!("{}.{}", qn, fname);
                if self.registry.lookup_type(&fqn).is_some() {
                    return Type::Named { qn: fqn };
                }
                Type::Unknown
            }
            Type::Builtin { name } if name != "()" => {
                let qn = format!("std.{}.{}", name, name);
                if let Some(f) = self.registry.lookup_method(&qn, fname) {
                    return f.ret.clone();
                }
                Type::Unknown
            }
            _ => Type::Unknown,
        }
    }

    fn eval_method_call(&self, obj_type: &Type, mname: &str) -> Type {
        self.eval_field_access(obj_type, mname)
    }

    // ── Trait impl detection (from the 406-commit diff) ──

    /// True if `type_qn` implements a trait that declares `method_name` —
    /// i.e. the method came from `impl Trait for Type`, not inherent.
    /// Uses embedded_types (impl-link entries) to check.
    fn method_is_trait_impl(&self, type_qn: &str, method_name: &str) -> bool {
        let Some(_rt) = self.registry.lookup_type(type_qn) else {
            return false;
        };
        // Check if any embedded type (representing `impl Trait for Type`) declares this method
        for (_embed_qn, embed_rt) in &self.registry.types_by_qn {
            // ponytail: O(n) scan over all types; small N in practice.
            // Switch to embedded_types index if this shows up in profiles.
            if embed_rt.bases.contains(&type_qn.to_string())
                || embed_rt.qualified_name.starts_with(&format!("{}.", type_qn))
            {
                if embed_rt.methods.contains_key(method_name) {
                    return true;
                }
            }
        }
        // Also check the receiver's own embedded_types (the impl-link model)
        // ponytail: embedded_types not in current TypeRegistry; the above heuristic covers most cases.
        // Add proper embedded type tracking when multi-crate resolution is needed.
        false
    }

    /// Find the sole concrete implementer of trait `trait_qn` that declares `method_name`.
    /// Returns (impl_method_qn, count) — count capped at 2.
    fn find_sole_trait_impl(&self, trait_qn: &str, method_name: &str) -> (Option<String>, usize) {
        let mut first: Option<String> = None;
        let mut count: usize = 0;

        for (qn, rt) in &self.registry.types_by_qn {
            if rt.is_interface || rt.alias_of.is_some() {
                continue;
            }
            if count >= 2 {
                break;
            }
            // Check if this type implements the trait
            let implements =
                rt.bases.iter().any(|b| b == trait_qn || b.ends_with(&format!(".{}", trait_qn)));
            if !implements {
                continue;
            }
            // Check if it declares the method
            if let Some(_meth_qn) = rt.methods.get(method_name) {
                let meth_qn = format!("{}.{}", qn, method_name);
                if first.is_none() {
                    first = Some(meth_qn);
                }
                count += 1;
            }
        }
        (first, count)
    }
}

// ── Statement processing ──

pub fn process_rust_statement(ctx: &mut RustLspContext, node: Node) {
    if node.kind().is_empty() {
        return;
    }
    match node.kind() {
        "let_declaration" | "let_condition" => {
            let pattern = node.child_by_field_name("pattern");
            let value = node.child_by_field_name("value");
            let ty = node.child_by_field_name("type");
            let rhs_type = ty
                .map(|t| ctx.parse_type_node(t))
                .or_else(|| value.map(|v| ctx.eval_expr_type(v)))
                .unwrap_or(Type::Unknown);
            if let Some(p) = pattern {
                bind_rust_pattern(ctx, p, &rhs_type);
            }
        }
        "for_expression" => {
            let pattern = node.child_by_field_name("pattern");
            let value = node.child_by_field_name("value");
            if let Some(v) = value {
                let iter_t = ctx.eval_expr_type(v);
                let elem = match &iter_t {
                    Type::Template { name, args } if name == "Vec" || name == "slice" => {
                        args.first().cloned().unwrap_or(Type::Unknown)
                    }
                    _ => Type::Unknown,
                };
                if let Some(p) = pattern {
                    bind_rust_pattern(ctx, p, &elem);
                }
            }
        }
        _ => {}
    }
}

fn bind_rust_pattern(ctx: &mut RustLspContext, pattern: Node, ty: &Type) {
    match pattern.kind() {
        "identifier" | "mutable_identifier" => {
            if let Some(name) = ctx.node_text(pattern).map(|s| s.to_string()) {
                ctx.current_scope.bind(name, ty.clone());
            }
        }
        "tuple_pattern" | "tuple_struct_pattern" => {
            let elems = match ty {
                Type::Tuple { elems } => Some(elems),
                _ => None,
            };
            let nc = pattern.named_child_count();
            for i in 0..nc {
                let child = pattern.named_child(i).unwrap_or(pattern);
                let child_ty = elems
                    .and_then(|e| e.get(i as usize).cloned())
                    .unwrap_or(ty.clone());
                bind_rust_pattern(ctx, child, &child_ty);
            }
        }
        _ => {}
    }
}

// ── Call resolution ──

pub fn emit_rust_call(ctx: &mut RustLspContext, call_node: Node) {
    let fn_node = call_node.child_by_field_name("function");
    let Some(fn_node) = fn_node else {
        return;
    };

    match fn_node.kind() {
        "identifier" | "type_identifier" => {
            let fname = ctx.node_text(fn_node).unwrap_or("").to_string();
            // Scope (local variable of function type)
            let scoped = ctx.current_scope.lookup(&fname);
            if let Type::Named { ref qn } = scoped {
                ctx.emit(qn, "lsp_rust_constructor", CONF_UFCS);
                return;
            }
            // Use resolution
            if let Some(qn) = ctx.resolve_use(&fname) {
                if let Some(f) = ctx.registry.lookup_func(&qn) {
                    ctx.emit(&f.qualified_name, "lsp_rust_direct", CONF_DIRECT);
                } else {
                    ctx.emit(&qn, "lsp_rust_direct", CONF_DIRECT);
                }
                return;
            }
            // Module-local
            if let Some(f) = ctx.registry.lookup_symbol(&ctx.module_qn, &fname) {
                ctx.emit(&f.qualified_name, "lsp_rust_direct", CONF_DIRECT);
                return;
            }
        }

        "field_expression" => {
            let value = fn_node.child_by_field_name("value");
            let field = fn_node.child_by_field_name("field");
            let (Some(val), Some(field)) = (value, field) else {
                return;
            };
            let val_type = ctx.eval_expr_type(val);
            let fname = ctx.node_text(field).unwrap_or("");

            match &val_type {
                Type::Named { qn } | Type::Template { name: qn, .. } => {
                    if let Some(f) = ctx.registry.lookup_method(qn, fname) {
                        let strategy = if ctx.method_is_trait_impl(qn, fname) {
                            "lsp_trait_dispatch"
                        } else {
                            "lsp_method_dispatch"
                        };
                        ctx.emit(&f.qualified_name, strategy, CONF_METHOD);
                    }
                }
                Type::Builtin { name } if name != "()" => {
                    let qn = format!("std.{}.{}", name, name);
                    if let Some(f) = ctx.registry.lookup_method(&qn, fname) {
                        ctx.emit(&f.qualified_name, "lsp_rust_method", CONF_METHOD);
                    }
                }
                _ => {}
            }
        }

        "scoped_identifier" | "scoped_type_identifier" => {
            // UFCS: Trait::method() or Type::method()
            if let Some(path_qn) = ctx.resolve_path_node(fn_node) {
                // Try direct function first
                if let Some(f) = ctx.registry.lookup_func(&path_qn) {
                    ctx.emit(&f.qualified_name, "lsp_rust_ufcs", CONF_UFCS);
                    return;
                }
                // Trait::method → find sole implementer
                let parts: Vec<&str> = path_qn.rsplitn(2, '.').collect();
                if parts.len() == 2 {
                    let trait_or_type = parts[1];
                    let method = parts[0];
                    let (sole, count) = ctx.find_sole_trait_impl(trait_or_type, method);
                    if count == 1 {
                        if let Some(qn) = sole {
                            ctx.emit(&qn, "lsp_trait_ufcs", CONF_TRAIT_SOLE);
                            return;
                        }
                    } else if count > 1 {
                        ctx.emit(&path_qn, "lsp_trait_ufcs_amb", CONF_TRAIT_AMB);
                        return;
                    }
                }
                // Fallback: emit as-is
                ctx.emit(&path_qn, "lsp_rust_ufcs", CONF_UFCS);
            }
        }

        _ => {}
    }
}

// ── Recursive walk with depth guard ──

fn resolve_calls_in_inner(ctx: &mut RustLspContext, node: Node) {
    if node.kind().is_empty() {
        return;
    }
    let k = node.kind();

    process_rust_statement(ctx, node);

    if k == "call_expression" || k == "method_call_expression" {
        emit_rust_call(ctx, node);
    }

    // Don't cross function/item boundaries
    if matches!(
        k,
        "function_item"
            | "function_signature_item"
            | "closure_expression"
            | "lambda_expression"
            | "struct_item"
            | "enum_item"
            | "trait_item"
            | "impl_item"
    ) {
        return;
    }

    let nc = node.named_child_count();
    for i in 0..nc {
        resolve_calls_in_inner(ctx, node.named_child(i).unwrap_or(node));
    }
}

pub fn resolve_calls_in(ctx: &mut RustLspContext, node: Node) {
    if ctx.walk_depth >= MAX_WALK_DEPTH {
        return;
    }
    ctx.walk_depth += 1;
    resolve_calls_in_inner(ctx, node);
    ctx.walk_depth -= 1;
}

// ── Function processing ──

pub fn process_rust_function(ctx: &mut RustLspContext, func_node: Node) {
    let name_node = func_node.child_by_field_name("name");
    let Some(n) = name_node else {
        return;
    };
    let Some(fname) = ctx.node_text(n) else {
        return;
    };
    if fname.is_empty() {
        return;
    }

    let prev_func = ctx.enclosing_func_qn.clone();
    let prev_self_ty = ctx.self_type_qn.clone();
    let prev_self_trait = ctx.self_trait_qn.clone();

    let base_qn = prev_self_ty.as_deref().unwrap_or(&ctx.module_qn);
    ctx.enclosing_func_qn = Some(format!("{}.{}", base_qn, fname));

    let saved = ctx.current_scope.clone();
    ctx.current_scope = ctx.current_scope.push();

    // Bind self if this is a method (impl context)
    if let Some(ref self_ty) = prev_self_ty {
        ctx.current_scope
            .bind("self", Type::Named { qn: self_ty.clone() });
    }

    // Bind parameters
    if let Some(params) = func_node.child_by_field_name("parameters") {
        bind_rust_params(ctx, params);
    }

    // Process body
    if let Some(body) = func_node.child_by_field_name("body") {
        resolve_calls_in(ctx, body);
    }

    ctx.current_scope = saved;
    ctx.enclosing_func_qn = prev_func;
    ctx.self_type_qn = prev_self_ty;
    ctx.self_trait_qn = prev_self_trait;
}

fn bind_rust_params(ctx: &mut RustLspContext, params: Node) {
    let nc = params.named_child_count();
    for i in 0..nc {
        let p = params.named_child(i).unwrap_or(params);
        match p.kind() {
            "parameter" | "self_parameter" => {
                if p.kind() == "self_parameter" {
                    continue; // already bound as 'self' in process_rust_function
                }
                let pattern = p.child_by_field_name("pattern");
                let ty = p.child_by_field_name("type");
                if let Some(pat) = pattern {
                    let t = ty
                        .map(|t_node| ctx.parse_type_node(t_node))
                        .unwrap_or(Type::Unknown);
                    bind_rust_pattern(ctx, pat, &t);
                }
            }
            _ => {}
        }
    }
}

// ── Impl block processing ──

pub fn process_rust_impl(ctx: &mut RustLspContext, impl_node: Node) {
    let type_node = impl_node.child_by_field_name("type");
    let trait_node = impl_node.child_by_field_name("trait");

    let prev_self_ty = ctx.self_type_qn.clone();
    let prev_self_trait = ctx.self_trait_qn.clone();

    // Extract Self type QN
    if let Some(tn) = type_node {
        let parsed = ctx.parse_type_node(tn);
        ctx.self_type_qn = match &parsed {
            Type::Named { qn } => Some(qn.clone()),
            _ => ctx.node_text(tn).map(|s| s.to_string()),
        };
    }

    // Extract trait QN (for `impl Trait for Type`)
    if let Some(tn) = trait_node {
        let parsed = ctx.parse_type_node(tn);
        ctx.self_trait_qn = match &parsed {
            Type::Named { qn } => Some(qn.clone()),
            _ => ctx.node_text(tn).map(|s| s.to_string()),
        };
    }

    // Process methods in body
    if let Some(body) = impl_node.child_by_field_name("body") {
        let bnc = body.named_child_count();
        for i in 0..bnc {
            let c = body.named_child(i).unwrap_or(body);
            if c.kind() == "function_item" || c.kind() == "function_signature_item" {
                process_rust_function(ctx, c);
            }
        }
    }

    ctx.self_type_qn = prev_self_ty;
    ctx.self_trait_qn = prev_self_trait;
}

// ── File-level processing ──

pub fn process_rust_file(ctx: &mut RustLspContext, root: Node) {
    if root.kind().is_empty() {
        return;
    }

    // Bind module-level types and functions into scope
    let prefix = format!("{}.", ctx.module_qn);
    for (qn, rt) in &ctx.registry.types_by_qn {
        if qn.starts_with(&prefix) {
            ctx.current_scope
                .bind(&rt.short_name, Type::Named { qn: qn.clone() });
        }
    }
    // Also bind module-level functions
    for (qn, f) in &ctx.registry.funcs_by_qn {
        if qn.starts_with(&prefix) && f.receiver_type.is_none() {
            ctx.current_scope
                .bind(&f.short_name, Type::Named { qn: qn.clone() });
        }
    }

    let nc = root.named_child_count();

    // Pass 1: top-level items that aren't functions
    let prev_func = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.__module__", ctx.module_qn));

    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "impl_item" => process_rust_impl(ctx, c),
            _ => {}
        }
    }

    // Pass 2: functions
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "function_item" | "function_signature_item" => {
                process_rust_function(ctx, c);
            }
            _ => {
                // Process statements at module level (e.g. macro invocations, static items)
                resolve_calls_in(ctx, c);
            }
        }
    }

    ctx.enclosing_func_qn = prev_func;
}

// ── Entry point ──

pub fn run_rust_lsp(
    source: &str,
    tree: &tree_sitter::Tree,
    module_qn: &str,
    registry: &TypeRegistry,
) -> Vec<ResolvedCall> {
    let mut ctx = RustLspContext::new(source, registry, module_qn);
    extract_rust_uses(&mut ctx, tree.root_node());
    let root = tree.root_node();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        process_rust_file(&mut ctx, root);
    }));
    if result.is_err() {
        tracing::warn!(module_qn, "[rust_lsp] panic caught — skipping file");
    }
    ctx.resolved_calls
}

fn extract_rust_uses(ctx: &mut RustLspContext, root: Node) {
    let mut to_visit = vec![root];
    while let Some(node) = to_visit.pop() {
        if node.kind() == "use_declaration" {
            let mut segments: Vec<String> = Vec::new();
            let mut is_glob = false;

            // Walk the use tree to collect the path
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                match child.kind() {
                    "identifier" | "type_identifier" => {
                        if let Ok(t) = child.utf8_text(ctx.source.as_bytes()) {
                            segments.push(t.to_string());
                        }
                    }
                    "scoped_identifier" => {
                        // The path part is the first named child, the name is the second
                        // We handle this via recursion into the scope/use_list below
                    }
                    "use_list" => {
                        // use foo::{bar, baz} — process each item
                        // First get the parent path from segments so far
                        let parent_path = segments.join(".");
                        let mut list_cursor = child.walk();
                        for item in child.children(&mut list_cursor) {
                            if item.kind() == "identifier" || item.kind() == "type_identifier"
                            {
                                if let Ok(t) = item.utf8_text(ctx.source.as_bytes()) {
                                    let path = if parent_path.is_empty() {
                                        t.to_string()
                                    } else {
                                        format!("{}.{}", parent_path, t)
                                    };
                                    ctx.add_use(t, &path, false);
                                }
                            } else if item.kind() == "self" {
                                ctx.add_use("self", &parent_path, false);
                            }
                        }
                        segments.clear();
                    }
                    "self" => {
                        is_glob = true;
                    }
                    "as" => {
                        // alias — the next identifier is the alias name
                    }
                    _ => {}
                }
            }

            if !segments.is_empty() {
                let path = segments.join(".");
                let last = segments.last().map(|s| s.as_str()).unwrap_or(&path);
                if is_glob {
                    ctx.add_use(last, &path, true);
                } else {
                    ctx.add_use(last, &path, false);
                }
            }
        }

        // Also handle `use` inside `use_declaration` with as/self/glob — more complex patterns
        // are covered by the resolve_use fallback at call time.

        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        to_visit.extend(children.into_iter().rev());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_context_creation() {
        let reg = TypeRegistry::new();
        let ctx = RustLspContext::new("", &reg, "test_crate");
        assert_eq!(ctx.module_qn, "test_crate");
        assert!(ctx.resolved_calls.is_empty());
    }

    #[test]
    fn test_use_resolution() {
        let reg = TypeRegistry::new();
        let mut ctx = RustLspContext::new("", &reg, "test_crate");
        ctx.add_use("HashMap", "std.collections.HashMap", false);
        let resolved = ctx.resolve_use("HashMap");
        assert_eq!(resolved, Some("std.collections.HashMap".to_string()));
    }

    #[test]
    fn test_sole_trait_impl_none() {
        let reg = TypeRegistry::new();
        let ctx = RustLspContext::new("", &reg, "test_crate");
        let (result, count) = ctx.find_sole_trait_impl("std.fmt.Display", "fmt");
        assert_eq!(count, 0);
        assert!(result.is_none());
    }

    #[test]
    fn test_method_is_trait_impl_false_for_unknown() {
        let reg = TypeRegistry::new();
        let ctx = RustLspContext::new("", &reg, "test_crate");
        assert!(!ctx.method_is_trait_impl("nonexistent.Type", "foo"));
    }
}
