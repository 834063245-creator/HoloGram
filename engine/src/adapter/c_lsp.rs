// C/C++ LSP — type-aware call resolution.
// Ports c_lsp.c (5330 lines C → ~500 lines Rust).
// Covers C, C++, CUDA, Objective-C.

use std::collections::HashMap;
use tree_sitter::Node;
use crate::adapter::scope::Scope;
use crate::adapter::type_registry::TypeRegistry;
use crate::adapter::types::Type;
use crate::adapter::ResolvedCall;

pub struct CLspContext<'a> {
    pub source: &'a str, pub registry: &'a TypeRegistry, pub current_scope: Scope,
    pub module_qn: String,

    pub enclosing_func_qn: Option<String>, pub enclosing_class_qn: Option<String>,
    pub resolved_calls: Vec<ResolvedCall>,
    eval_cache: HashMap<usize, Type>,
}

impl<'a> CLspContext<'a> {
    pub fn new(source: &'a str, registry: &'a TypeRegistry, module_qn: &str) -> Self {
        Self { source, registry, current_scope: Scope::new_root(), module_qn: module_qn.to_string(),
            enclosing_func_qn: None, enclosing_class_qn: None,
            resolved_calls: Vec::new(), eval_cache: HashMap::new() }
    }
    fn node_text(&self, n: Node) -> Option<&str> { n.utf8_text(self.source.as_bytes()).ok() }
    fn emit(&mut self, callee_qn: &str, strategy: &str, confidence: f32) {
        let Some(caller) = self.enclosing_func_qn.as_ref() else { return };
        let start = self.resolved_calls.len().saturating_sub(256);
        for rc in &self.resolved_calls[start..] { if &rc.caller_qn == caller && rc.callee_qn == callee_qn { return; } }
        self.resolved_calls.push(ResolvedCall { caller_qn: caller.clone(), callee_qn: callee_qn.to_string(), strategy: strategy.to_string(), confidence });
    }

    /// Memoized type evaluation. Repeated calls on the same tree-sitter node
    /// return the cached result — critical for large C files with deeply nested
    /// expressions where the same sub-expression is evaluated many times.
    pub fn eval_expr_type(&mut self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        if let Some(cached) = self.eval_cache.get(&node.id()) {
            return cached.clone();
        }
        let result = self.eval_expr_type_impl(node);
        self.eval_cache.insert(node.id(), result.clone());
        result
    }

    fn eval_expr_type_impl(&mut self, node: Node) -> Type {
        let k = node.kind();
        match k {
            "number_literal" | "string_literal" | "char_literal" | "true" | "false" | "null" | "nullptr" => c_literal_type(k),
            "identifier" => {
                let name = self.node_text(node).unwrap_or("").to_string();
                let t = self.current_scope.lookup(&name); if !t.is_unknown() { return t; }
                if name == "this" {
                    if let Some(ref cq) = self.enclosing_class_qn { return Type::Named { qn: format!("{}*", cq) }; }
                }
                if let Some(f) = self.registry.lookup_symbol(&self.module_qn, &name) { return f.ret.clone(); }
                Type::Unknown
            }
            "field_expression" | "member_expression" => {
                let obj = node.child_by_field_name("object").or_else(|| node.child_by_field_name("argument"));
                let field = node.child_by_field_name("field");
                let (Some(obj), Some(field)) = (obj, field) else { return Type::Unknown; };
                let ot = self.eval_expr_type(obj);
                let fnm = self.node_text(field).unwrap_or("");
                self.eval_field(&ot, fnm)
            }
            "call_expression" => {
                let fn_node = node.child_by_field_name("function");
                let Some(fn_node) = fn_node else { return Type::Unknown; };
                let callee = self.eval_expr_type(fn_node);
                match callee { Type::Callable { ret, .. } => *ret, Type::Named { .. } | Type::Builtin { .. } | Type::Template { .. } => callee, _ => Type::Unknown }
            }
            "pointer_expression" | "reference_expression" => {
                let inner = node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown);
                match &inner { Type::Named { qn } => Type::Template { name: "pointer".into(), args: vec![Type::Named { qn: qn.trim_end_matches('*').trim().to_string() }] }, _ => inner }
            }
            "sizeof_expression" => Type::Builtin { name: "size_t".into() },
            "cast_expression" => {
                let ty = node.child_by_field_name("type");
                ty.map(|t| self.parse_type_node(t)).unwrap_or(Type::Unknown)
            }
            "subscript_expression" => {
                let obj = node.child_by_field_name("argument");
                if let Some(o) = obj {
                    let t = self.eval_expr_type(o);
                    if let Type::Template { name, args } = &t { if name == "pointer" || name == "array" { return args.first().cloned().unwrap_or(t); } }
                }
                Type::Unknown
            }
            "parenthesized_expression" => node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown),
            "binary_expression" | "conditional_expression" | "comma_expression" => node.child_by_field_name("left").map(|l| self.eval_expr_type(l)).unwrap_or(Type::Unknown),
            "new_expression" | "delete_expression" => {
                let ty = node.child_by_field_name("type").or_else(|| node.named_child(0));
                ty.map(|t| self.parse_type_node(t)).unwrap_or(Type::Unknown)
            }
            _ => Type::Unknown,
        }
    }

    fn eval_field(&self, obj_type: &Type, fname: &str) -> Type {
        let qn = match obj_type {
            Type::Named { qn } => qn.clone(),
            Type::Template { name, .. } => name.clone(),
            Type::Builtin { name } if name != "null" && name != "nullptr" => format!("std.{}", name),
            _ => return Type::Unknown,
        };
        // Strip pointer/reference
        let base_qn = qn.trim_end_matches('*').trim_end_matches('&').trim();
        if let Some(f) = self.registry.lookup_method(base_qn, fname) { return f.ret.clone(); }
        if let Some(t) = self.registry.lookup_field(base_qn, fname) { return t.clone(); }
        Type::Unknown
    }

    pub fn parse_type_node(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        let k = node.kind();
        match k {
            "type_identifier" | "qualified_identifier" | "template_type" | "typename_identifier" => {
                let name = self.node_text(node).unwrap_or("");
                if !name.is_empty() { Type::Named { qn: name.to_string() } } else { Type::Unknown }
            }
            "primitive_type" => Type::Builtin { name: self.node_text(node).unwrap_or("int").to_string() },
            "pointer_declarator" | "reference_declarator" => {
                let inner = node.named_child(0).map(|n| self.parse_type_node(n)).unwrap_or(Type::Unknown);
                Type::Template { name: "pointer".into(), args: vec![inner] }
            }
            "array_declarator" => {
                let inner = node.named_child(0).map(|n| self.parse_type_node(n)).unwrap_or(Type::Unknown);
                Type::Template { name: "array".into(), args: vec![inner] }
            }
            "struct_specifier" | "class_specifier" | "union_specifier" | "enum_specifier" => {
                let name = node.child_by_field_name("name");
                name.and_then(|n| self.node_text(n)).map(|s| Type::Named { qn: s.to_string() }).unwrap_or(Type::Unknown)
            }
            _ => Type::Unknown,
        }
    }
}

fn c_literal_type(k: &str) -> Type {
    match k {
        "number_literal" => Type::Builtin { name: "int".into() },
        "string_literal" => Type::Template { name: "pointer".into(), args: vec![Type::Builtin { name: "char".into() }] },
        "char_literal" => Type::Builtin { name: "char".into() },
        "true" | "false" => Type::Builtin { name: "bool".into() },
        "null" | "nullptr" => Type::Builtin { name: "null".into() },
        _ => Type::Unknown,
    }
}

// ═══ statements + call resolution ═══
pub fn process_c_statement(ctx: &mut CLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    match node.kind() {
        "declaration" => {
            let ty = node.child_by_field_name("type");
            let base_t = ty.map(|t| ctx.parse_type_node(t)).unwrap_or(Type::Unknown);
            if let Some(decl) = node.child_by_field_name("declarator") {
                c_bind_declarator(ctx, decl, &base_t);
            }
        }
        "init_declarator" => {
            let decl = node.child_by_field_name("declarator");
            let val = node.child_by_field_name("value");
            if let Some(d) = decl {
                let t = val.map(|v| ctx.eval_expr_type(v)).unwrap_or(Type::Unknown);
                c_bind_declarator(ctx, d, &t);
            }
        }
        _ => {}
    }
}

fn c_bind_declarator(ctx: &mut CLspContext, decl: Node, ty: &Type) {
    match decl.kind() {
        "identifier" => {
            if let Some(nm) = ctx.node_text(decl).map(|s| s.to_string()) { ctx.current_scope.bind(nm, ty.clone()); }
        }
        "pointer_declarator" | "reference_declarator" => {
            let ptr_t = Type::Template { name: "pointer".into(), args: vec![ty.clone()] };
            if let Some(inner) = decl.named_child(0) { c_bind_declarator(ctx, inner, &ptr_t); }
        }
        "array_declarator" => {
            let arr_t = Type::Template { name: "array".into(), args: vec![ty.clone()] };
            if let Some(inner) = decl.named_child(0) { c_bind_declarator(ctx, inner, &arr_t); }
        }
        "init_declarator" => {
            if let Some(d) = decl.child_by_field_name("declarator") { c_bind_declarator(ctx, d, ty); }
        }
        _ => {}
    }
}

pub fn resolve_c_calls(ctx: &mut CLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();
    process_c_statement(ctx, node);
    if k == "call_expression" { emit_c_call(ctx, node); }
    if k == "function_definition" || k == "class_specifier" || k == "struct_specifier" || k == "lambda_expression" { return; }
    let nc = node.named_child_count();
    for i in 0..nc { resolve_c_calls(ctx, node.named_child(i).unwrap_or(node)); }
}

pub fn emit_c_call(ctx: &mut CLspContext, call_node: Node) {
    let Some(fn_node) = call_node.child_by_field_name("function") else { return };
    match fn_node.kind() {
        "identifier" => {
            let fname = ctx.node_text(fn_node).unwrap_or("").to_string();
            if let Some(f) = ctx.registry.lookup_symbol(&ctx.module_qn, &fname) { ctx.emit(&f.qualified_name, "c_direct", 0.95); return; }
        }
        "field_expression" | "member_expression" => {
            let obj = fn_node.child_by_field_name("object").or_else(|| fn_node.child_by_field_name("argument"));
            let field = fn_node.child_by_field_name("field");
            let (Some(obj), Some(field)) = (obj, field) else { return };
            let ot = ctx.eval_expr_type(obj);
            let mname = ctx.node_text(field).unwrap_or("");
            let qn = match &ot { Type::Named { qn } => qn.trim_end_matches('*').trim().to_string(), Type::Template { name, .. } => name.clone(), _ => return };
            if let Some(f) = ctx.registry.lookup_method(&qn, mname) { ctx.emit(&f.qualified_name, "c_method", 0.90); }
        }
        _ => {}
    }
}

pub fn process_c_function(ctx: &mut CLspContext, func_node: Node) {
    let decl = func_node.child_by_field_name("declarator");
    let Some(d) = decl else { return };
    let name = c_declarator_name(d, ctx.source);
    let Some(fname) = name else { return };

    let prev = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.{}", ctx.module_qn, fname));
    let saved = ctx.current_scope.clone();
    ctx.current_scope = ctx.current_scope.push();

    if let Some(params) = d.child_by_field_name("parameters") {
        let nc = params.named_child_count();
        for i in 0..nc {
            let p = params.named_child(i).unwrap_or(params);
            if p.kind() == "parameter_declaration" {
                let ptype = p.child_by_field_name("type");
                let pdecl = p.child_by_field_name("declarator");
                let t = ptype.map(|pt| ctx.parse_type_node(pt)).unwrap_or(Type::Unknown);
                if let Some(pd) = pdecl { c_bind_declarator(ctx, pd, &t); }
            }
        }
    }

    if let Some(body) = func_node.child_by_field_name("body") { resolve_c_calls(ctx, body); }
    ctx.current_scope = saved;
    ctx.enclosing_func_qn = prev;
}

fn c_declarator_name<'a>(decl: Node<'a>, source: &'a str) -> Option<String> {
    match decl.kind() {
        "identifier" => decl.utf8_text(source.as_bytes()).ok().map(|s| s.to_string()),
        "function_declarator" | "pointer_declarator" | "reference_declarator" | "array_declarator" | "init_declarator" => {
            decl.child_by_field_name("declarator").and_then(|d| c_declarator_name(d, source))
                .or_else(|| decl.named_child(0).and_then(|n| c_declarator_name(n, source)))
        }
        _ => decl.named_child(0).and_then(|n| c_declarator_name(n, source)),
    }
}

pub fn process_c_file(ctx: &mut CLspContext, root: Node) {
    if root.kind().is_empty() { return; }
    let nc = root.named_child_count();
    let prev = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.__global__", ctx.module_qn));
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "function_definition" => process_c_function(ctx, c),
            _ => resolve_c_calls(ctx, c),
        }
    }
    ctx.enclosing_func_qn = prev;
}

pub fn run_c_lsp(source: &str, tree: &tree_sitter::Tree, module_qn: &str, registry: &TypeRegistry) -> Vec<ResolvedCall> {
    let mut ctx = CLspContext::new(source, registry, module_qn);
    process_c_file(&mut ctx, tree.root_node());
    ctx.resolved_calls
}
