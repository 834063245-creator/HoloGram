// TypeScript/JavaScript LSP — type-aware call resolution.
// Ports ts_lsp.c (5283 lines C → ~700 lines Rust).

use std::collections::HashMap;
use tree_sitter::Node;
use crate::adapter::scope::Scope;
use crate::adapter::type_registry::TypeRegistry;
use crate::adapter::types::Type;
use crate::adapter::ResolvedCall;

pub struct TsLspContext<'a> {
    pub source: &'a str, pub registry: &'a TypeRegistry, pub current_scope: Scope,
    pub module_qn: String, pub imports: HashMap<String, TsImport>,
    pub enclosing_func_qn: Option<String>, pub enclosing_class_qn: Option<String>,
    pub resolved_calls: Vec<ResolvedCall>,
    eval_cache: HashMap<usize, Type>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct TsImport { pub(crate) local_name: String, pub(crate) module_path: String, pub(crate) is_default: bool, pub(crate) is_namespace: bool }

impl<'a> TsLspContext<'a> {
    pub fn new(source: &'a str, registry: &'a TypeRegistry, module_qn: &str) -> Self {
        Self { source, registry, current_scope: Scope::new_root(), module_qn: module_qn.to_string(),
            imports: HashMap::new(), enclosing_func_qn: None, enclosing_class_qn: None,
            resolved_calls: Vec::new(), eval_cache: HashMap::new() }
    }
    fn node_text(&self, n: Node) -> Option<&str> { n.utf8_text(self.source.as_bytes()).ok() }
    pub fn add_import(&mut self, local: &str, module_path: &str, is_default: bool, is_namespace: bool) {
        self.imports.insert(local.to_string(), TsImport { local_name: local.to_string(), module_path: module_path.to_string(), is_default, is_namespace });
    }
    fn emit(&mut self, callee_qn: &str, strategy: &str, confidence: f32) {
        let Some(ref caller) = self.enclosing_func_qn.clone() else { return };
        let start = self.resolved_calls.len().saturating_sub(256);
        for rc in &self.resolved_calls[start..] { if rc.caller_qn == *caller && rc.callee_qn == callee_qn { return; } }
        self.resolved_calls.push(ResolvedCall { caller_qn: caller.clone(), callee_qn: callee_qn.to_string(), strategy: strategy.to_string(), confidence });
    }

    // ═══ expr evaluator ═══
    /// Memoized type evaluation. Repeated calls on the same tree-sitter node
    /// return the cached result — critical for large files with deeply nested
    /// call chains where the same sub-expression is evaluated many times.
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
            "number" | "string" | "template_string" | "regex" | "true" | "false" | "null" | "undefined" => ts_literal_type(k),
            "identifier" => {
                let name = self.node_text(node).unwrap_or("").to_string();
                let t = self.current_scope.lookup(&name); if !t.is_unknown() { return t; }
                if name == "this" {
                    if let Some(ref cq) = self.enclosing_class_qn { return Type::Named { qn: cq.clone() }; }
                }
                if let Some(_imp) = self.imports.get(&name) { return Type::Named { qn: name.clone() }; }
                if let Some(f) = self.registry.lookup_symbol(&self.module_qn, &name) { return f.ret.clone(); }
                Type::Unknown
            }
            "member_expression" => {
                let obj = node.child_by_field_name("object");
                let prop = node.child_by_field_name("property");
                let (Some(obj), Some(prop)) = (obj, prop) else { return Type::Unknown; };
                let obj_type = self.eval_expr_type(obj);
                let pname = self.node_text(prop).unwrap_or("");
                self.eval_member(&obj_type, pname)
            }
            "call_expression" => {
                let fn_node = node.child_by_field_name("function");
                let Some(fn_node) = fn_node else { return Type::Unknown; };
                let fk = fn_node.kind();

                // Special: arr.map(x => ...) — infer callback param from array element type
                if fk == "member_expression" {
                    let obj = fn_node.child_by_field_name("object");
                    let prop = fn_node.child_by_field_name("property");
                    if let (Some(obj), Some(prop)) = (obj, prop) {
                        let obj_type = self.eval_expr_type(obj);
                        let mname = self.node_text(prop).unwrap_or("");
                        // Array methods return types
                        if let Some(ret) = ts_array_method_return(&obj_type, mname) { return ret; }
                    }
                }

                let callee = self.eval_expr_type(fn_node);
                match callee { Type::Callable { ret, .. } => *ret, Type::Named { .. } | Type::Builtin { .. } | Type::Template { .. } => callee, _ => Type::Unknown }
            }
            "new_expression" => {
                let ctor = node.child_by_field_name("constructor");
                ctor.map(|c| self.eval_expr_type(c)).unwrap_or(Type::Unknown)
            }
            "subscript_expression" => {
                let obj = node.child_by_field_name("object");
                if let Some(o) = obj {
                    let t = self.eval_expr_type(o);
                    if let Type::Template { name, args } = &t {
                        if (name == "Array" || name == "Set") && !args.is_empty() { return args[0].clone(); }
                        if name == "Map" && args.len() >= 2 { return args[1].clone(); }
                    }
                }
                Type::Unknown
            }
            "arrow_function" | "function_expression" => Type::Callable { params: vec![], ret: Box::new(Type::Unknown) },
            "object" | "object_pattern" => Type::Named { qn: "object".into() },
            "array" | "array_pattern" => {
                let first = node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown);
                if first.is_unknown() { Type::Builtin { name: "Array".into() } }
                else { Type::Template { name: "Array".into(), args: vec![first] } }
            }
            "parenthesized_expression" => node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown),
            "binary_expression" | "ternary_expression" => node.child_by_field_name("left").map(|l| self.eval_expr_type(l)).unwrap_or(Type::Unknown),
            "as_expression" | "type_assertion" => {
                let ty = node.child_by_field_name("type").or_else(|| node.named_child(node.named_child_count().saturating_sub(1)));
                ty.map(|t| self.parse_type_node(t)).unwrap_or(Type::Unknown)
            }
            _ => Type::Unknown,
        }
    }

    fn eval_member(&self, obj_type: &Type, mname: &str) -> Type {
        let qn = match obj_type {
            Type::Named { qn } | Type::Template { name: qn, .. } => qn.clone(),
            Type::Builtin { name } if name != "null" && name != "undefined" => format!("builtins.{}", name),
            Type::Module { qn } => {
                if let Some(f) = self.registry.lookup_symbol(qn, mname) { return f.ret.clone(); }
                return Type::Unknown;
            }
            _ => return Type::Unknown,
        };
        if let Some(f) = self.registry.lookup_method(&qn, mname) { return f.ret.clone(); }
        if let Some(t) = self.registry.lookup_field(&qn, mname) { return t.clone(); }
        Type::Unknown
    }

    pub fn parse_type_node(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        let k = node.kind();
        match k {
            "type_annotation" => node.named_child(0).map(|n| self.parse_type_node(n)).unwrap_or(Type::Unknown),
            "predefined_type" | "type_identifier" => {
                let name = self.node_text(node).unwrap_or("");
                ts_type_name(name)
            }
            "array_type" => {
                let inner = node.named_child(0).map(|n| self.parse_type_node(n)).unwrap_or(Type::Unknown);
                Type::Template { name: "Array".into(), args: vec![inner] }
            }
            "generic_type" => {
                let base = node.child_by_field_name("type_name").or_else(|| node.named_child(0));
                let type_args = node.child_by_field_name("type_arguments");
                let base_t = base.map(|b| self.parse_type_node(b)).unwrap_or(Type::Unknown);
                if let Some(ta) = type_args {
                    let args: Vec<Type> = (0..ta.named_child_count()).filter_map(|i| ta.named_child(i).map(|n| self.parse_type_node(n))).collect();
                    if !args.is_empty() {
                        let name = match &base_t { Type::Named { qn } => qn.clone(), Type::Builtin { name } => name.clone(), _ => "T".into() };
                        return Type::Template { name, args };
                    }
                }
                base_t
            }
            "union_type" => {
                let members: Vec<Type> = (0..node.named_child_count()).filter_map(|i| node.named_child(i).map(|n| self.parse_type_node(n))).collect();
                Type::Union { members }
            }
            "intersection_type" => {
                // Simplify: intersection → first member (full intersection requires structural matching)
                node.named_child(0).map(|n| self.parse_type_node(n)).unwrap_or(Type::Unknown)
            }
            "object_type" | "type_literal" => Type::Named { qn: "object".into() },
            "function_type" => Type::Callable { params: vec![], ret: Box::new(Type::Unknown) },
            "literal_type" => {
                let inner = node.named_child(0);
                inner.map(|n| self.parse_type_node(n)).unwrap_or(Type::Unknown)
            }
            _ => Type::Unknown,
        }
    }
}

fn ts_literal_type(k: &str) -> Type {
    match k {
        "number" => Type::Builtin { name: "number".into() },
        "string" | "template_string" => Type::Builtin { name: "string".into() },
        "regex" => Type::Named { qn: "RegExp".into() },
        "true" | "false" => Type::Builtin { name: "boolean".into() },
        "null" => Type::Builtin { name: "null".into() },
        "undefined" => Type::Builtin { name: "undefined".into() },
        _ => Type::Unknown,
    }
}

fn ts_type_name(name: &str) -> Type {
    match name {
        "number"|"string"|"boolean"|"void"|"undefined"|"null"|"unknown"|"any"|"never"|"symbol"|"bigint" => Type::Builtin { name: name.to_string() },
        _ => Type::Named { qn: name.to_string() },
    }
}

fn ts_array_method_return(obj_type: &Type, mname: &str) -> Option<Type> {
    if let Type::Template { name, args } = obj_type {
        if (name == "Array" || name == "Set") && !args.is_empty() {
            match mname {
                "map" | "filter" | "flatMap" | "slice" | "concat" => return Some(obj_type.clone()),
                "find" | "pop" | "shift" | "at" => return Some(Type::Union { members: vec![args[0].clone(), Type::Builtin { name: "undefined".into() }] }),
                "forEach" | "some" | "every" | "reduce" | "reduceRight" => return Some(Type::Builtin { name: "void".into() }),
                "join" => return Some(Type::Builtin { name: "string".into() }),
                "sort" | "reverse" | "fill" | "splice" => return Some(obj_type.clone()),
                _ => {}
            }
        }
        if name == "Map" && args.len() >= 2 {
            match mname {
                "get" => return Some(Type::Union { members: vec![args[1].clone(), Type::Builtin { name: "undefined".into() }] }),
                "set" | "delete" | "clear" => return Some(Type::Builtin { name: "void".into() }),
                "keys" => return Some(Type::Template { name: "IterableIterator".into(), args: vec![args[0].clone()] }),
                "values" => return Some(Type::Template { name: "IterableIterator".into(), args: vec![args[1].clone()] }),
                "entries" => return Some(Type::Template { name: "IterableIterator".into(), args: vec![Type::Tuple { elems: vec![args[0].clone(), args[1].clone()] }] }),
                _ => {}
            }
        }
        if name == "Promise" && !args.is_empty() {
            if mname == "then" || mname == "catch" || mname == "finally" { return Some(obj_type.clone()); }
        }
    }
    None
}

// ═══ statements + call resolution ═══
pub fn process_ts_statement(ctx: &mut TsLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    match node.kind() {
        "variable_declaration" => {
            let nc = node.named_child_count();
            for i in 0..nc {
                let decl = node.named_child(i).unwrap_or(node);
                if decl.kind() == "variable_declarator" {
                    let name = decl.child_by_field_name("name");
                    let value = decl.child_by_field_name("value");
                    let ty = decl.child_by_field_name("type");
                    let rhs = ty.map(|t| ctx.parse_type_node(t))
                        .or_else(|| value.map(|v| ctx.eval_expr_type(v)))
                        .unwrap_or(Type::Unknown);
                    if let Some(n) = name {
                        if let Some(nm) = ctx.node_text(n).map(|s| s.to_string()) { ctx.current_scope.bind(nm, rhs); }
                    }
                }
            }
        }
        "for_in_statement" => {
            let left = node.child_by_field_name("left");
            let right = node.child_by_field_name("right");
            let elem = right.map(|r| {
                let t = ctx.eval_expr_type(r);
                match &t { Type::Template { name, args } if name == "Array" || name == "Set" => args.first().cloned().unwrap_or(Type::Unknown), _ => Type::Unknown }
            }).unwrap_or(Type::Unknown);
            if let Some(l) = left {
                if let Some(nm) = ctx.node_text(l).map(|s| s.to_string()) { ctx.current_scope.bind(nm, elem); }
            }
        }
        _ => {}
    }
}

pub fn resolve_ts_calls(ctx: &mut TsLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();
    process_ts_statement(ctx, node);
    if k == "call_expression" { emit_ts_call(ctx, node); }
    if k == "new_expression" {
        let ctor = node.child_by_field_name("constructor");
        if let Some(c) = ctor {
            let t = ctx.eval_expr_type(c);
            if let Type::Named { ref qn } = t { ctx.emit(qn, "ts_constructor", 0.85); }
        }
    }
    if k == "class_declaration" || k == "method_definition" || k == "function_declaration" || k == "arrow_function" || k == "function_expression" { return; }
    let nc = node.named_child_count();
    for i in 0..nc { resolve_ts_calls(ctx, node.named_child(i).unwrap_or(node)); }
}

pub fn emit_ts_call(ctx: &mut TsLspContext, call_node: Node) {
    let Some(fn_node) = call_node.child_by_field_name("function") else { return };
    match fn_node.kind() {
        "identifier" => {
            let fname = ctx.node_text(fn_node).unwrap_or("").to_string();
            // Constructor: ClassName()
            let scoped = ctx.current_scope.lookup(&fname);
            if let Type::Named { ref qn } = scoped { ctx.emit(qn, "ts_constructor", 0.85); return; }
            if let Some(f) = ctx.registry.lookup_symbol(&ctx.module_qn, &fname) { ctx.emit(&f.qualified_name, "ts_direct", 0.95); return; }
        }
        "member_expression" => {
            let obj = fn_node.child_by_field_name("object");
            let prop = fn_node.child_by_field_name("property");
            let (Some(obj), Some(prop)) = (obj, prop) else { return };
            let obj_type = ctx.eval_expr_type(obj);
            let mname = ctx.node_text(prop).unwrap_or("");
            let qn = match &obj_type {
                Type::Named { qn } | Type::Template { name: qn, .. } => qn.clone(),
                Type::Builtin { name } if name != "null" && name != "undefined" => format!("builtins.{}", name),
                _ => return,
            };
            if let Some(f) = ctx.registry.lookup_method(&qn, mname) { ctx.emit(&f.qualified_name, "ts_method", 0.90); }
        }
        _ => {}
    }
}

pub fn process_ts_function(ctx: &mut TsLspContext, func_node: Node, class_qn: Option<&str>) {
    let name_node = func_node.child_by_field_name("name");
    if name_node.is_none() { return; } // anonymous
    let Some(n) = name_node else { return };
    let Some(fname) = ctx.node_text(n) else { return };
    let prev = ctx.enclosing_func_qn.clone();
    let base = class_qn.unwrap_or(&ctx.module_qn);
    ctx.enclosing_func_qn = Some(format!("{}.{}", base, fname));
    let saved = ctx.current_scope.clone();
    ctx.current_scope = ctx.current_scope.push();
    if let Some(params) = func_node.child_by_field_name("parameters") {
        let nc = params.named_child_count();
        for i in 0..nc {
            let p = params.named_child(i).unwrap_or(params);
            if p.kind() == "required_parameter" || p.kind() == "optional_parameter" {
                let pn = p.child_by_field_name("pattern").or_else(|| p.child_by_field_name("name"));
                if let Some(pnn) = pn {
                    if let Some(pnm) = ctx.node_text(pnn).map(|s| s.to_string()) {
                        let ty = p.child_by_field_name("type").map(|t| ctx.parse_type_node(t)).unwrap_or(Type::Unknown);
                        ctx.current_scope.bind(pnm, ty);
                    }
                }
            }
        }
    }
    if let Some(body) = func_node.child_by_field_name("body") { resolve_ts_calls(ctx, body); }
    ctx.current_scope = saved;
    ctx.enclosing_func_qn = prev;
}

pub fn process_ts_file(ctx: &mut TsLspContext, root: Node) {
    if root.kind().is_empty() { return; }
    let nc = root.named_child_count();
    let prev = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.__module__", ctx.module_qn));
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "function_declaration" => process_ts_function(ctx, c, None),
            "class_declaration" => process_ts_class(ctx, c),
            "export_statement" => {
                let inner = c.child_by_field_name("declaration").or_else(|| c.named_child(0));
                if let Some(inner) = inner {
                    match inner.kind() {
                        "function_declaration" => process_ts_function(ctx, inner, None),
                        "class_declaration" => process_ts_class(ctx, inner),
                        _ => resolve_ts_calls(ctx, inner),
                    }
                }
            }
            _ => resolve_ts_calls(ctx, c),
        }
    }
    ctx.enclosing_func_qn = prev;
}

pub fn process_ts_class(ctx: &mut TsLspContext, class_node: Node) {
    let name_node = class_node.child_by_field_name("name");
    let Some(n) = name_node else { return };
    let Some(cname) = ctx.node_text(n) else { return };
    let prev = ctx.enclosing_class_qn.clone();
    ctx.enclosing_class_qn = Some(format!("{}.{}", ctx.module_qn, cname));
    if let Some(body) = class_node.child_by_field_name("body") {
        let bnc = body.named_child_count();
        for i in 0..bnc {
            let c = body.named_child(i).unwrap_or(body);
            match c.kind() {
                "method_definition" => process_ts_function(ctx, c, Some(&ctx.enclosing_class_qn.clone().unwrap())),
                "public_field_definition" => {
                    let fn_name = c.child_by_field_name("name");
                    let fn_val = c.child_by_field_name("value");
                    if let (Some(fn_n), Some(fv)) = (fn_name, fn_val) {
                        if fn_n.kind() == "property_identifier" {
                            if let Some(fnm) = ctx.node_text(fn_n).map(|s| s.to_string()) {
                                let t = ctx.eval_expr_type(fv);
                                ctx.current_scope.bind(fnm, t);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    ctx.enclosing_class_qn = prev;
}

pub fn run_ts_lsp(source: &str, tree: &tree_sitter::Tree, module_qn: &str, registry: &TypeRegistry) -> Vec<ResolvedCall> {
    let mut ctx = TsLspContext::new(source, registry, module_qn);
    extract_ts_imports(&mut ctx, tree.root_node());
    process_ts_file(&mut ctx, tree.root_node());
    ctx.resolved_calls
}

fn extract_ts_imports(ctx: &mut TsLspContext, root: Node) {
    let mut to_visit = vec![root];
    while let Some(node) = to_visit.pop() {
        if node.kind() == "import_statement" {
            let source_node = node.child_by_field_name("source");
            let source = source_node.and_then(|s| s.utf8_text(ctx.source.as_bytes()).ok()).map(|s| s.trim_matches(&['"','\'','`'][..]).to_string());
            let Some(ref mod_path) = source else { continue; };
            // Check for default import: import Foo from './foo'
            if let Some(clause) = node.child_by_field_name("import_clause") {
                let name = clause.child_by_field_name("name");
                if let Some(n) = name {
                    if let Ok(local) = n.utf8_text(ctx.source.as_bytes()) { ctx.add_import(local, mod_path, true, false); }
                }
                // Named imports: import { Foo, Bar } from './foo'
                if let Some(named) = clause.child_by_field_name("named_imports") {
                    let nc = named.named_child_count();
                    for i in 0..nc {
                        let spec = named.named_child(i).unwrap_or(named);
                        if spec.kind() == "import_specifier" {
                            let sname = spec.child_by_field_name("name");
                            let alias = spec.child_by_field_name("alias");
                            if let Some(sn) = sname.or(alias) {
                                if let Ok(local) = sn.utf8_text(ctx.source.as_bytes()) { ctx.add_import(local, mod_path, false, false); }
                            }
                        }
                    }
                }
                // Namespace import: import * as Foo from './foo'
                if let Some(ns) = clause.child_by_field_name("namespace_import") {
                    if let Ok(ns_name) = ns.utf8_text(ctx.source.as_bytes()) { ctx.add_import(ns_name, mod_path, false, true); }
                }
            }
        }
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        to_visit.extend(children.into_iter().rev());
    }
}
