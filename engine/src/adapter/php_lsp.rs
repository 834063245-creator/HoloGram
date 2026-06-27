// PHP LSP — type-aware call resolution.
// Ports php_lsp.c (4320 lines C → ~400 lines Rust).

use std::collections::HashMap;
use tree_sitter::Node;
use crate::adapter::scope::Scope;
use crate::adapter::type_registry::TypeRegistry;
use crate::adapter::types::Type;
use crate::adapter::ResolvedCall;

pub struct PhpLspContext<'a> {
    pub source: &'a str, pub registry: &'a TypeRegistry, pub current_scope: Scope,
    pub module_qn: String, pub namespace: String, pub use_map: HashMap<String, String>,
    pub enclosing_func_qn: Option<String>, pub enclosing_class_qn: Option<String>,
    pub resolved_calls: Vec<ResolvedCall>,
}

impl<'a> PhpLspContext<'a> {
    pub fn new(source: &'a str, registry: &'a TypeRegistry, module_qn: &str) -> Self {
        Self { source, registry, current_scope: Scope::new_root(), module_qn: module_qn.to_string(),
            namespace: String::new(), use_map: HashMap::new(),
            enclosing_func_qn: None, enclosing_class_qn: None, resolved_calls: Vec::new() }
    }
    fn node_text(&self, n: Node) -> Option<&str> { n.utf8_text(self.source.as_bytes()).ok() }
    fn emit(&mut self, callee_qn: &str, strategy: &str, confidence: f32) {
        let Some(ref caller) = self.enclosing_func_qn.clone() else { return };
        let start = self.resolved_calls.len().saturating_sub(256);
        for rc in &self.resolved_calls[start..] { if rc.caller_qn == *caller && rc.callee_qn == callee_qn { return; } }
        self.resolved_calls.push(ResolvedCall { caller_qn: caller.clone(), callee_qn: callee_qn.to_string(), strategy: strategy.to_string(), confidence });
    }

    fn resolve_name(&self, name: &str) -> Option<String> {
        // Fully qualified
        if name.starts_with('\\') {
            let qn = name[1..].to_string();
            if self.registry.lookup_type(&qn).is_some() || self.registry.lookup_func(&qn).is_some() { return Some(qn); }
        }
        // use imports (exact match)
        if let Some(qn) = self.use_map.get(name) { return Some(qn.clone()); }
        // Current namespace
        if !self.namespace.is_empty() {
            let qn = format!("{}\\{}", self.namespace, name);
            if self.registry.lookup_type(&qn).is_some() || self.registry.lookup_func(&qn).is_some() { return Some(qn); }
        }
        None
    }

    pub fn eval_expr_type(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        let k = node.kind();
        match k {
            "integer" | "float" | "string" | "boolean" | "null" | "encapsed_string" => php_literal_type(k),
            "variable_name" | "name" | "qualified_name" | "namespace_name" => {
                let name = self.node_text(node).unwrap_or("").to_string();
                let t = self.current_scope.lookup(&name); if !t.is_unknown() { return t; }
                if name == "this" || name == "$this" {
                    if let Some(ref cq) = self.enclosing_class_qn { return Type::Named { qn: cq.clone() }; }
                }
                if let Some(qn) = self.resolve_name(&name) { return Type::Named { qn }; }
                if let Some(f) = self.registry.lookup_symbol(&self.module_qn, &name) { return f.ret.clone(); }
                Type::Unknown
            }
            "member_access_expression" | "nullsafe_member_access_expression" => {
                let obj = node.child_by_field_name("object");
                let name = node.child_by_field_name("name");
                let (Some(obj), Some(name)) = (obj, name) else { return Type::Unknown; };
                let ot = self.eval_expr_type(obj);
                let mname = self.node_text(name).unwrap_or("");
                self.eval_member(&ot, mname)
            }
            "function_call_expression" | "member_call_expression" | "nullsafe_member_call_expression" => {
                let fn_node = node.child_by_field_name("function");
                let Some(fn_node) = fn_node else { return Type::Unknown; };
                let callee = self.eval_expr_type(fn_node);
                match callee { Type::Callable { ret, .. } => *ret, Type::Named { .. } | Type::Builtin { .. } | Type::Template { .. } => callee, _ => Type::Unknown }
            }
            "object_creation_expression" => {
                let ty = node.child_by_field_name("type").or_else(|| node.child_by_field_name("class"));
                ty.map(|t| self.eval_expr_type(t)).unwrap_or(Type::Unknown)
            }
            "array_creation_expression" => {
                let first = node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown);
                Type::Template { name: "array".into(), args: vec![first] }
            }
            "parenthesized_expression" => node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown),
            "binary_expression" | "conditional_expression" => node.child_by_field_name("left").map(|l| self.eval_expr_type(l)).unwrap_or(Type::Unknown),
            _ => Type::Unknown,
        }
    }

    fn eval_member(&self, obj_type: &Type, mname: &str) -> Type {
        let qn = match obj_type { Type::Named { qn } => qn.clone(), Type::Template { name, .. } => name.clone(), _ => return Type::Unknown };
        if let Some(f) = self.registry.lookup_method(&qn, mname) { return f.ret.clone(); }
        if let Some(t) = self.registry.lookup_field(&qn, mname) { return t.clone(); }
        Type::Unknown
    }
}

fn php_literal_type(k: &str) -> Type {
    match k {
        "integer" => Type::Builtin { name: "int".into() },
        "float" => Type::Builtin { name: "float".into() },
        "string" | "encapsed_string" => Type::Builtin { name: "string".into() },
        "boolean" => Type::Builtin { name: "bool".into() },
        "null" => Type::Builtin { name: "null".into() },
        _ => Type::Unknown,
    }
}

// ═══ statements + call resolution ═══
pub fn process_php_statement(ctx: &mut PhpLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    match node.kind() {
        "assignment_expression" => {
            let left = node.child_by_field_name("left");
            let right = node.child_by_field_name("right");
            if let Some(l) = left {
                let rhs = right.map(|r| ctx.eval_expr_type(r)).unwrap_or(Type::Unknown);
                if let Some(nm) = ctx.node_text(l).map(|s| s.to_string()) { ctx.current_scope.bind(nm, rhs); }
            }
        }
        "foreach_statement" => {
            let value = node.child_by_field_name("value");
            let key = node.child_by_field_name("key");
            let iter = value.and_then(|v| {
                let t = ctx.eval_expr_type(v);
                match &t { Type::Template { name, args } if name == "array" => args.first().cloned(), _ => None }
            });
            if let Some(k) = key {
                if let Some(nm) = ctx.node_text(k).map(|s| s.to_string()) { ctx.current_scope.bind(nm, Type::Builtin { name: "int".into() }); }
            }
            if let Some(v) = value {
                if let Some(nm) = ctx.node_text(v).map(|s| s.to_string()) { ctx.current_scope.bind(nm, iter.unwrap_or(Type::Unknown)); }
            }
        }
        _ => {}
    }
}

pub fn resolve_php_calls(ctx: &mut PhpLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();
    process_php_statement(ctx, node);
    if k == "function_call_expression" { emit_php_call(ctx, node); }
    if k == "member_call_expression" || k == "nullsafe_member_call_expression" {
        let fn_node = node.child_by_field_name("function");
        if let Some(fn_n) = fn_node {
            if fn_n.kind() == "member_access_expression" || fn_n.kind() == "nullsafe_member_access_expression" {
                let obj = fn_n.child_by_field_name("object");
                let name = fn_n.child_by_field_name("name");
                if let (Some(obj), Some(name)) = (obj, name) {
                    let ot = ctx.eval_expr_type(obj);
                    let mname = ctx.node_text(name).unwrap_or("");
                    let qn = match &ot { Type::Named { qn } => qn.clone(), Type::Template { name, .. } => name.clone(), _ => return };
                    if let Some(f) = ctx.registry.lookup_method(&qn, mname) { ctx.emit(&f.qualified_name, "php_method", 0.90); }
                }
            }
        }
    }
    if k == "class_declaration" || k == "method_declaration" || k == "function_definition" || k == "arrow_function" || k == "anonymous_function_creation_expression" { return; }
    let nc = node.named_child_count();
    for i in 0..nc { resolve_php_calls(ctx, node.named_child(i).unwrap_or(node)); }
}

pub fn emit_php_call(ctx: &mut PhpLspContext, call_node: Node) {
    let Some(fn_node) = call_node.child_by_field_name("function") else { return };
    let fname = ctx.node_text(fn_node).unwrap_or("").to_string();
    if let Some(qn) = ctx.resolve_name(&fname) { ctx.emit(&qn, "php_func", 0.92); return; }
    if let Some(f) = ctx.registry.lookup_symbol(&ctx.module_qn, &fname) { ctx.emit(&f.qualified_name, "php_local", 0.95); }
}

pub fn process_php_function(ctx: &mut PhpLspContext, func_node: Node) {
    let name_node = func_node.child_by_field_name("name");
    let Some(n) = name_node else { return };
    let Some(fname) = ctx.node_text(n) else { return };
    let prev = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}\\{}", ctx.module_qn, fname));
    let saved = ctx.current_scope.clone();
    ctx.current_scope = ctx.current_scope.push();
    if let Some(params) = func_node.child_by_field_name("parameters") {
        let nc = params.named_child_count();
        for i in 0..nc {
            let p = params.named_child(i).unwrap_or(params);
            if p.kind() == "simple_parameter" || p.kind() == "variadic_parameter" {
                let pn = p.child_by_field_name("name");
                let pt = p.child_by_field_name("type");
                if let Some(pnn) = pn {
                    if let Some(pnm) = ctx.node_text(pnn).map(|s| s.to_string()) {
                        let t = pt.map(|ptt| ctx.eval_expr_type(ptt)).unwrap_or(Type::Unknown);
                        ctx.current_scope.bind(pnm, t);
                    }
                }
            }
        }
    }
    if let Some(body) = func_node.child_by_field_name("body") { resolve_php_calls(ctx, body); }
    ctx.current_scope = saved;
    ctx.enclosing_func_qn = prev;
}

pub fn process_php_file(ctx: &mut PhpLspContext, root: Node) {
    if root.kind().is_empty() { return; }
    let nc = root.named_child_count();
    let prev = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}\\__global__", ctx.module_qn));
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "function_definition" => process_php_function(ctx, c),
            "class_declaration" => process_php_class(ctx, c),
            _ => resolve_php_calls(ctx, c),
        }
    }
    ctx.enclosing_func_qn = prev;
}

pub fn process_php_class(ctx: &mut PhpLspContext, class_node: Node) {
    let name_node = class_node.child_by_field_name("name");
    let Some(n) = name_node else { return };
    let Some(cname) = ctx.node_text(n) else { return };
    let prev = ctx.enclosing_class_qn.clone();
    ctx.enclosing_class_qn = Some(format!("{}\\{}", ctx.module_qn, cname));
    if let Some(body) = class_node.child_by_field_name("body") {
        let bnc = body.named_child_count();
        for i in 0..bnc {
            let c = body.named_child(i).unwrap_or(body);
            match c.kind() {
                "method_declaration" => process_php_function(ctx, c),
                _ => resolve_php_calls(ctx, c),
            }
        }
    }
    ctx.enclosing_class_qn = prev;
}

pub fn run_php_lsp(source: &str, tree: &tree_sitter::Tree, module_qn: &str, registry: &TypeRegistry) -> Vec<ResolvedCall> {
    let mut ctx = PhpLspContext::new(source, registry, module_qn);
    extract_php_use(&mut ctx, tree.root_node());
    process_php_file(&mut ctx, tree.root_node());
    ctx.resolved_calls
}

fn extract_php_use(ctx: &mut PhpLspContext, root: Node) {
    let mut to_visit = vec![root];
    while let Some(node) = to_visit.pop() {
        match node.kind() {
            "namespace_definition" => {
                let name = node.child_by_field_name("name");
                if let Some(n) = name { if let Ok(ns) = n.utf8_text(ctx.source.as_bytes()) { ctx.namespace = ns.to_string(); } }
            }
            "use_declaration" => {
                let name = node.child_by_field_name("name");
                let alias = node.child_by_field_name("alias");
                if let Some(n) = name {
                    if let Ok(full) = n.utf8_text(ctx.source.as_bytes()) {
                        let short = alias.and_then(|a| a.utf8_text(ctx.source.as_bytes()).ok()).map(|s| s.to_string())
                            .unwrap_or_else(|| full.rsplit('\\').next().unwrap_or(full).to_string());
                        ctx.use_map.insert(short, full.to_string());
                    }
                }
            }
            _ => {}
        }
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        to_visit.extend(children.into_iter().rev());
    }
}
