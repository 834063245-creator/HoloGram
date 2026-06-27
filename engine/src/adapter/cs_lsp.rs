// C# LSP — type-aware call resolution.
// Ports cs_lsp.c (3021 lines C → ~600 lines Rust).

use tree_sitter::Node;
use crate::adapter::scope::Scope;
use crate::adapter::type_registry::TypeRegistry;
use crate::adapter::types::Type;

pub use crate::adapter::ResolvedCall;

#[derive(Debug, Clone)]
pub(crate) struct CSUsing { kind: CSUsingKind, local_name: String, target_qn: String }
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum CSUsingKind { Namespace, Static, Alias }

pub struct CSLspContext<'a> {
    pub source: &'a str, pub registry: &'a TypeRegistry, pub current_scope: Scope,
    pub module_qn: String, pub usings: Vec<CSUsing>, pub namespace_stack: Vec<String>,
    pub enclosing_class_qn: Option<String>, pub enclosing_func_qn: Option<String>,
    pub resolved_calls: Vec<ResolvedCall>,
}

impl<'a> CSLspContext<'a> {
    pub fn new(source: &'a str, registry: &'a TypeRegistry, module_qn: &str) -> Self {
        Self { source, registry, current_scope: Scope::new_root(), module_qn: module_qn.to_string(),
            usings: Vec::new(), namespace_stack: Vec::new(),
            enclosing_class_qn: None, enclosing_func_qn: None, resolved_calls: Vec::new() }
    }

    fn node_text(&self, node: Node) -> Option<&str> { node.utf8_text(self.source.as_bytes()).ok() }
    pub fn add_using(&mut self, kind: CSUsingKind, local: &str, target: &str) {
        self.usings.push(CSUsing { kind, local_name: local.to_string(), target_qn: target.to_string() });
    }

    fn emit(&mut self, callee_qn: &str, strategy: &str, confidence: f32) {
        let Some(ref caller) = self.enclosing_func_qn.clone() else { return };
        let start = self.resolved_calls.len().saturating_sub(256);
        for rc in &self.resolved_calls[start..] {
            if rc.caller_qn == *caller && rc.callee_qn == callee_qn { return; }
        }
        self.resolved_calls.push(ResolvedCall { caller_qn: caller.clone(), callee_qn: callee_qn.to_string(), strategy: strategy.to_string(), confidence });
    }

    fn resolve_type_name(&self, name: &str) -> Option<String> {
        // 1. Using alias
        for u in &self.usings {
            if u.kind == CSUsingKind::Alias && u.local_name == name { return Some(u.target_qn.clone()); }
        }
        // 2. Current namespace
        for ns in self.namespace_stack.iter().rev() {
            let qn = format!("{}.{}", ns, name);
            if self.registry.lookup_type(&qn).is_some() { return Some(qn); }
        }
        // 3. Using namespace
        for u in &self.usings {
            if u.kind == CSUsingKind::Namespace {
                let qn = format!("{}.{}", u.target_qn, name);
                if self.registry.lookup_type(&qn).is_some() { return Some(qn); }
                if self.registry.lookup_func(&qn).is_some() { return Some(qn); }
            }
        }
        // 4. Using static
        for u in &self.usings {
            if u.kind == CSUsingKind::Static {
                let short = u.target_qn.rsplit('.').next().unwrap_or(&u.target_qn);
                if short == name { return Some(u.target_qn.clone()); }
                // Also check as method on the static type
                let type_qn = &u.target_qn[..u.target_qn.rfind('.').unwrap_or(0)];
                if let Some(f) = self.registry.lookup_method(type_qn, name) { return Some(f.qualified_name.clone()); }
            }
        }
        // 5. System namespace fallback
        let sys_qn = format!("System.{}", name);
        if self.registry.lookup_type(&sys_qn).is_some() { return Some(sys_qn); }
        None
    }

    // ═══ expr evaluator ═══
    pub fn eval_expr_type(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        let k = node.kind();
        match k {
            "integer_literal" => Type::Builtin { name: "int".into() },
            "real_literal" => Type::Builtin { name: "double".into() },
            "string_literal"|"interpolated_string_expression"|"character_literal" => Type::Builtin { name: "string".into() },
            "boolean_literal" => Type::Builtin { name: "bool".into() },
            "null_literal" => Type::Builtin { name: "null".into() },

            "identifier" | "alias_qualified_name" => {
                let name = self.node_text(node).unwrap_or("").to_string();
                let t = self.current_scope.lookup(&name); if !t.is_unknown() { return t; }
                if name == "this" || name == "base" {
                    if let Some(ref cq) = self.enclosing_class_qn { return Type::Named { qn: cq.clone() }; }
                }
                if let Some(qn) = self.resolve_type_name(&name) { return Type::Named { qn }; }
                if let Some(f) = self.registry.lookup_symbol(&self.module_qn, &name) { return f.ret.clone(); }
                Type::Unknown
            }

            "member_access_expression" | "conditional_access_expression" => {
                let expr = node.child_by_field_name("expression");
                let name = node.child_by_field_name("name");
                let (Some(obj), Some(n)) = (expr, name) else { return Type::Unknown; };
                let obj_type = self.eval_expr_type(obj);
                let mname = self.node_text(n).unwrap_or("");
                self.eval_member(&obj_type, mname)
            }

            "invocation_expression" => {
                let func = node.child_by_field_name("function");
                let Some(f) = func else { return Type::Unknown; };
                let callee = self.eval_expr_type(f);
                match callee { Type::Callable { ret, .. } => *ret, Type::Named { .. } | Type::Template { .. } => callee, _ => Type::Unknown }
            }

            "object_creation_expression" => {
                let ty = node.child_by_field_name("type");
                ty.map(|t| self.parse_type_node(t)).unwrap_or(Type::Unknown)
            }

            "cast_expression" => {
                let ty = node.child_by_field_name("type");
                ty.map(|t| self.parse_type_node(t)).unwrap_or(Type::Unknown)
            }

            "parenthesized_expression" => node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown),
            "binary_expression" | "conditional_expression" => node.child_by_field_name("left").map(|l| self.eval_expr_type(l)).unwrap_or(Type::Unknown),
            "prefix_unary_expression" | "postfix_unary_expression" | "await_expression" => {
                node.named_child(0).or_else(|| node.child_by_field_name("operand")).map(|n| {
                    let t = self.eval_expr_type(n);
                    // await Task<T> → T
                    if k == "await_expression" {
                        if let Type::Template { name, args } = &t {
                            if name == "Task" || name == "ValueTask" { return args.first().cloned().unwrap_or(t); }
                        }
                    }
                    t
                }).unwrap_or(Type::Unknown)
            }

            "element_access_expression" => {
                let expr = node.child_by_field_name("expression");
                if let Some(e) = expr {
                    let t = self.eval_expr_type(e);
                    if let Type::Template { name, args } = &t {
                        if (name == "List" || name == "array" || name == "IEnumerable") && !args.is_empty() { return args[0].clone(); }
                        if name == "Dictionary" && args.len() >= 2 { return args[1].clone(); }
                    }
                }
                Type::Unknown
            }

            _ => Type::Unknown,
        }
    }

    fn eval_member(&self, obj_type: &Type, mname: &str) -> Type {
        let qn = match obj_type {
            Type::Named { qn } | Type::Template { name: qn, .. } => qn.clone(),
            Type::Builtin { name } if name != "null" => format!("System.{}", name),
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
            "identifier"|"qualified_name"|"alias_qualified_name"|"generic_name" => {
                let name = self.node_text(node).unwrap_or("");
                if !name.is_empty() { Type::Named { qn: name.to_string() } } else { Type::Unknown }
            }
            "predefined_type" | "nullable_type" => {
                if let Some(n) = node.named_child(0) { self.parse_type_node(n) } else { Type::Unknown }
            }
            "array_type" => {
                let inner = node.named_child(0).map(|n| self.parse_type_node(n)).unwrap_or(Type::Unknown);
                Type::Template { name: "array".into(), args: vec![inner] }
            }
            "tuple_type" => {
                let elems: Vec<Type> = (0..node.named_child_count()).filter_map(|i| node.named_child(i).map(|n| self.parse_type_node(n))).collect();
                Type::Tuple { elems }
            }
            _ => Type::Unknown,
        }
    }
}

pub fn process_cs_statement(ctx: &mut CSLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();
    match k {
        "local_declaration_statement" | "variable_declaration" => {
            let ty = node.child_by_field_name("type");
            let base_t = ty.map(|t| ctx.parse_type_node(t)).unwrap_or(Type::Unknown);
            // Walk declarators
            let nc = node.named_child_count();
            for i in 0..nc {
                let c = node.named_child(i).unwrap_or(node);
                if c.kind() == "variable_declarator" || c.kind() == "equals_value_clause" {
                    let name = c.child_by_field_name("name");
                    if let Some(n) = name {
                        if let Some(nm) = ctx.node_text(n).map(|s| s.to_string()) {
                            ctx.current_scope.bind(nm, base_t.clone());
                        }
                    }
                }
            }
        }
        "foreach_statement" => {
            let ty = node.child_by_field_name("type");
            let left = node.child_by_field_name("left");
            let right = node.child_by_field_name("right");
            let elem = ty.map(|t| ctx.parse_type_node(t))
                .or_else(|| right.map(|r| {
                    let iter_t = ctx.eval_expr_type(r);
                    match &iter_t { Type::Template { name, args } if name == "IEnumerable" || name == "List" || name == "array" => args.first().cloned().unwrap_or(Type::Unknown), _ => Type::Unknown }
                })).unwrap_or(Type::Unknown);
            if let Some(l) = left {
                if let Some(nm) = ctx.node_text(l).map(|s| s.to_string()) { ctx.current_scope.bind(nm, elem); }
            }
        }
        _ => {}
    }
}

pub fn resolve_cs_calls(ctx: &mut CSLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();
    process_cs_statement(ctx, node);
    if k == "invocation_expression" { emit_cs_call(ctx, node); }
    if k == "object_creation_expression" {
        let ty = node.child_by_field_name("type");
        if let Some(t) = ty {
            let p = ctx.parse_type_node(t);
            if let Type::Named { ref qn } = p { ctx.emit(qn, "cs_constructor", 0.85); }
        }
    }
    if k == "class_declaration" || k == "struct_declaration" || k == "interface_declaration" || k == "method_declaration" || k == "constructor_declaration" || k == "lambda_expression" { return; }
    let nc = node.named_child_count();
    for i in 0..nc { resolve_cs_calls(ctx, node.named_child(i).unwrap_or(node)); }
}

pub fn emit_cs_call(ctx: &mut CSLspContext, call_node: Node) {
    let func = call_node.child_by_field_name("function");
    let Some(f) = func else { return };
    let fk = f.kind();

    match fk {
        "identifier" | "alias_qualified_name" => {
            let fname = ctx.node_text(f).unwrap_or("").to_string();
            if let Some(qn) = ctx.resolve_type_name(&fname) { ctx.emit(&qn, "cs_direct", 0.92); return; }
            if let Some(rf) = ctx.registry.lookup_symbol(&ctx.module_qn, &fname) { ctx.emit(&rf.qualified_name, "cs_local", 0.95); return; }
        }
        "member_access_expression" | "conditional_access_expression" => {
            let expr = f.child_by_field_name("expression");
            let name = f.child_by_field_name("name");
            let (Some(obj), Some(n)) = (expr, name) else { return };
            let obj_type = ctx.eval_expr_type(obj);
            let mname = ctx.node_text(n).unwrap_or("");

            match &obj_type {
                Type::Named { qn } | Type::Template { name: qn, .. } => {
                    if let Some(rf) = ctx.registry.lookup_method(qn, mname) { ctx.emit(&rf.qualified_name, "cs_method", 0.90); }
                }
                Type::Builtin { name } if name != "null" => {
                    let qn = format!("System.{}", name);
                    if let Some(rf) = ctx.registry.lookup_method(&qn, mname) { ctx.emit(&rf.qualified_name, "cs_builtin_method", 0.88); }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

pub fn process_cs_method(ctx: &mut CSLspContext, method_node: Node) {
    let name_node = method_node.child_by_field_name("name");
    let Some(n) = name_node else { return };
    let Some(mname) = ctx.node_text(n) else { return };
    if mname.is_empty() { return; }

    let prev = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.{}", ctx.module_qn, mname));
    let saved = ctx.current_scope.clone();
    ctx.current_scope = ctx.current_scope.push();

    if let Some(params) = method_node.child_by_field_name("parameter_list") {
        let nc = params.named_child_count();
        for i in 0..nc {
            let p = params.named_child(i).unwrap_or(params);
            if p.kind() == "parameter" {
                let pname = p.child_by_field_name("name");
                let ptype = p.child_by_field_name("type");
                if let Some(pn) = pname {
                    if let Some(pnm) = ctx.node_text(pn).map(|s| s.to_string()) {
                        let t = ptype.map(|pt| ctx.parse_type_node(pt)).unwrap_or(Type::Unknown);
                        ctx.current_scope.bind(pnm, t);
                    }
                }
            }
        }
    }

    if let Some(body) = method_node.child_by_field_name("body") { resolve_cs_calls(ctx, body); }
    ctx.current_scope = saved;
    ctx.enclosing_func_qn = prev;
}

pub fn process_cs_file(ctx: &mut CSLspContext, root: Node) {
    if root.kind().is_empty() { return; }
    let nc = root.named_child_count();
    let prev = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.__static__", ctx.module_qn));
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "method_declaration" | "constructor_declaration" => process_cs_method(ctx, c),
            "class_declaration" | "struct_declaration" | "record_declaration" | "interface_declaration" => process_cs_class(ctx, c),
            _ => resolve_cs_calls(ctx, c),
        }
    }
    ctx.enclosing_func_qn = prev;
}

pub fn process_cs_class(ctx: &mut CSLspContext, class_node: Node) {
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
                "method_declaration" | "constructor_declaration" => process_cs_method(ctx, c),
                "class_declaration" | "struct_declaration" | "record_declaration" | "interface_declaration" => process_cs_class(ctx, c),
                _ => resolve_cs_calls(ctx, c),
            }
        }
    }
    ctx.enclosing_class_qn = prev;
}

pub fn run_cs_lsp(source: &str, tree: &tree_sitter::Tree, module_qn: &str, registry: &TypeRegistry) -> Vec<ResolvedCall> {
    let mut ctx = CSLspContext::new(source, registry, module_qn);
    extract_cs_usings(&mut ctx, tree.root_node());
    process_cs_file(&mut ctx, tree.root_node());
    ctx.resolved_calls
}

fn extract_cs_usings(ctx: &mut CSLspContext, root: Node) {
    let mut to_visit = vec![root];
    while let Some(node) = to_visit.pop() {
        match node.kind() {
            "using_directive" => {
                let name = node.child_by_field_name("name");
                if let Some(n) = name {
                    if let Ok(full) = n.utf8_text(ctx.source.as_bytes()) {
                        let kind = if full.contains('=') { CSUsingKind::Alias }
                        else if node.utf8_text(ctx.source.as_bytes()).unwrap_or("").contains("static") { CSUsingKind::Static }
                        else { CSUsingKind::Namespace };
                        let short = full.rsplit('.').next().unwrap_or(full).to_string();
                        ctx.add_using(kind, &short, full);
                    }
                }
            }
            "namespace_declaration" => {
                let name = node.child_by_field_name("name");
                if let Some(n) = name {
                    if let Ok(ns) = n.utf8_text(ctx.source.as_bytes()) { ctx.namespace_stack.push(ns.to_string()); }
                }
            }
            _ => {}
        }
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        to_visit.extend(children.into_iter().rev());
    }
}
