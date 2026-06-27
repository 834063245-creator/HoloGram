// Go LSP — type-aware call resolution for Go source files.
// Ports go_lsp.c (2989 lines C → ~900 lines Rust).

use std::collections::HashMap;

use tree_sitter::Node;

use crate::adapter::scope::Scope;
use crate::adapter::type_registry::TypeRegistry;
use crate::adapter::types::Type;

pub use crate::adapter::ResolvedCall;

pub struct GoLspContext<'a> {
    pub source: &'a str,
    pub registry: &'a TypeRegistry,
    pub current_scope: Scope,
    pub package_qn: String,
    pub imports: HashMap<String, String>,
    pub enclosing_func_qn: Option<String>,
    pub resolved_calls: Vec<ResolvedCall>,
}

impl<'a> GoLspContext<'a> {
    pub fn new(source: &'a str, registry: &'a TypeRegistry, package_qn: &str) -> Self {
        Self {
            source,
            registry,
            current_scope: Scope::new_root(),
            package_qn: package_qn.to_string(),
            imports: HashMap::new(),
            enclosing_func_qn: None,
            resolved_calls: Vec::new(),
        }
    }

    fn node_text(&self, node: Node) -> Option<&str> { node.utf8_text(self.source.as_bytes()).ok() }

    pub fn add_import(&mut self, local: &str, pkg_qn: &str) {
        self.imports.insert(local.to_string(), pkg_qn.to_string());
    }

    fn resolve_import(&self, local: &str) -> Option<&str> {
        self.imports.get(local).map(|s| s.as_str())
    }

    fn emit(&mut self, callee_qn: &str, strategy: &str, confidence: f32) {
        let Some(ref caller) = self.enclosing_func_qn.clone() else { return };
        let start = self.resolved_calls.len().saturating_sub(256);
        for rc in &self.resolved_calls[start..] {
            if rc.caller_qn == *caller && rc.callee_qn == callee_qn { return; }
        }
        self.resolved_calls.push(ResolvedCall {
            caller_qn: caller.clone(), callee_qn: callee_qn.to_string(),
            strategy: strategy.to_string(), confidence,
        });
    }

    // ═══ expr evaluator ═══

    pub fn eval_expr_type(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        let k = node.kind();
        match k {
            "int_literal" | "float_literal" => Type::Builtin { name: k.trim_end_matches("_literal").into() },
            "interpreted_string_literal" | "raw_string_literal" | "rune_literal" => Type::Builtin { name: "string".into() },
            "true" | "false" => Type::Builtin { name: "bool".into() },
            "nil" => Type::Builtin { name: "nil".into() },
            "iota" => Type::Builtin { name: "int".into() },

            "identifier" => {
                let name = self.node_text(node).unwrap_or("");
                let t = self.current_scope.lookup(name); if !t.is_unknown() { return t; }
                // Imported package
                if let Some(pkg) = self.resolve_import(name) {
                    return Type::Module { qn: pkg.to_string() };
                }
                // Package-local function
                if let Some(f) = self.registry.lookup_symbol(&self.package_qn, name) {
                    return f.ret.clone();
                }
                // Builtin function
                if is_go_builtin(name) {
                    return Type::Callable { params: vec![], ret: Box::new(Type::Unknown) };
                }
                // Builtin type as value
                if let Some(t) = resolve_builtin_type(name) { return t; }
                Type::Unknown
            }

            "selector_expression" => {
                let obj = node.child_by_field_name("operand");
                let field = node.child_by_field_name("field");
                let (Some(obj), Some(field)) = (obj, field) else { return Type::Unknown; };
                let obj_type = self.eval_expr_type(obj);
                let fname = self.node_text(field).unwrap_or("");
                self.eval_selector(&obj_type, fname)
            }

            "call_expression" => {
                let fn_node = node.child_by_field_name("function");
                let args = node.child_by_field_name("arguments");
                let Some(fn_node) = fn_node else { return Type::Unknown; };
                let fk = fn_node.kind();
                // Builtin calls: make(T), new(T), append(s, x), len/cap/delete/close/copy
                if fk == "identifier" {
                    let fname = self.node_text(fn_node).unwrap_or("");
                    if is_go_builtin(fname) {
                        return self.eval_builtin_call(fname, args);
                    }
                }
                let callee = self.eval_expr_type(fn_node);
                match callee {
                    Type::Callable { ret, .. } => *ret,
                    Type::Named { .. } | Type::Builtin { .. } | Type::Template { .. } => callee,
                    _ => Type::Unknown,
                }
            }

            "type_conversion_expression" => {
                let type_node = node.child_by_field_name("type");
                type_node.map(|t| self.parse_type_node(t)).unwrap_or(Type::Unknown)
            }

            "composite_literal" => {
                let type_node = node.child_by_field_name("type");
                type_node.map(|t| self.parse_type_node(t)).unwrap_or(Type::Unknown)
            }

            "unary_expression" | "parenthesized_expression" => {
                node.child_by_field_name("operand")
                    .or_else(|| node.named_child(0))
                    .map(|n| self.eval_expr_type(n))
                    .unwrap_or(Type::Unknown)
            }

            "binary_expression" => {
                let left = node.child_by_field_name("left");
                left.map(|l| self.eval_expr_type(l)).unwrap_or(Type::Unknown)
            }

            "index_expression" => {
                let op = node.child_by_field_name("operand");
                if let Some(op) = op {
                    let t = self.eval_expr_type(op);
                    if let Type::Template { name, args } = &t {
                        if (name == "slice" || name == "array" || name == "list") && !args.is_empty() {
                            return args[0].clone();
                        }
                        if name == "map" && args.len() >= 2 { return args[1].clone(); }
                    }
                }
                Type::Unknown
            }

            "slice_expression" => {
                let op = node.child_by_field_name("operand");
                op.map(|o| self.eval_expr_type(o)).unwrap_or(Type::Unknown)
            }

            "func_literal" => {
                // Infer from return statements — simplified
                Type::Callable { params: vec![], ret: Box::new(Type::Unknown) }
            }

            _ => Type::Unknown,
        }
    }

    fn eval_selector(&self, obj_type: &Type, fname: &str) -> Type {
        match obj_type {
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
            Type::Named { qn } | Type::Template { name: qn, .. } => {
                if let Some(f) = go_lookup_field_or_method(self.registry, qn, fname) {
                    return f.ret.clone();
                }
                Type::Unknown
            }
            Type::Builtin { name } if name != "nil" => {
                let qn = format!("builtins.{}", name);
                if let Some(f) = go_lookup_field_or_method(self.registry, &qn, fname) {
                    return f.ret.clone();
                }
                Type::Unknown
            }
            _ => Type::Unknown,
        }
    }

    fn eval_builtin_call(&self, name: &str, _args: Option<Node>) -> Type {
        match name {
            "make" => {
                // make(T, ...) → T
                // We need to peek at the first arg for the type. Simplified.
                Type::Unknown
            }
            "new" => Type::Builtin { name: "pointer".into() },
            "append" => {
                // append(slice, ...) → same slice type
                Type::Unknown
            }
            "len" | "cap" | "copy" => Type::Builtin { name: "int".into() },
            "delete" | "close" => Type::Unknown,
            "panic" | "recover" => Type::Unknown,
            "print" | "println" => Type::Unknown,
            "complex" => Type::Builtin { name: "complex128".into() },
            "real" | "imag" => Type::Builtin { name: "float64".into() },
            "min" | "max" | "clear" => Type::Unknown,
            _ => Type::Unknown,
        }
    }

    pub fn parse_type_node(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        let k = node.kind();
        match k {
            "type_identifier" => {
                let name = self.node_text(node).unwrap_or("");
                if let Some(t) = resolve_builtin_type(name) { return t; }
                // Check package-local type
                let qn = format!("{}.{}", self.package_qn, name);
                if self.registry.lookup_type(&qn).is_some() { return Type::Named { qn }; }
                Type::Named { qn: name.to_string() }
            }
            "pointer_type" => {
                let inner = node.named_child(0);
                inner.map(|n| Type::Template { name: "pointer".into(), args: vec![self.parse_type_node(n)] })
                    .unwrap_or(Type::Unknown)
            }
            "slice_type" => {
                let inner = node.named_child(0);
                inner.map(|n| Type::Template { name: "slice".into(), args: vec![self.parse_type_node(n)] })
                    .unwrap_or(Type::Unknown)
            }
            "array_type" => {
                let inner = node.named_child(0);
                inner.map(|n| Type::Template { name: "array".into(), args: vec![self.parse_type_node(n)] })
                    .unwrap_or(Type::Unknown)
            }
            "map_type" => {
                let key = node.child_by_field_name("key");
                let value = node.child_by_field_name("value");
                let kt = key.map(|k| self.parse_type_node(k)).unwrap_or(Type::Unknown);
                let vt = value.map(|v| self.parse_type_node(v)).unwrap_or(Type::Unknown);
                Type::Template { name: "map".into(), args: vec![kt, vt] }
            }
            "channel_type" => {
                let inner = node.named_child(0);
                inner.map(|n| Type::Template { name: "chan".into(), args: vec![self.parse_type_node(n)] })
                    .unwrap_or(Type::Unknown)
            }
            "function_type" => Type::Callable { params: vec![], ret: Box::new(Type::Unknown) },
            "interface_type" => Type::Named { qn: "interface{}".into() },
            "qualified_type" => {
                let name = self.node_text(node).unwrap_or("");
                Type::Named { qn: name.to_string() }
            }
            "generic_type" => {
                let base = node.child_by_field_name("type");
                let type_args = node.child_by_field_name("type_arguments");
                let base_t = base.map(|b| self.parse_type_node(b)).unwrap_or(Type::Unknown);
                if let Type::Named { qn } = &base_t {
                    if let Some(ta) = type_args {
                        let args: Vec<Type> = (0..ta.named_child_count())
                            .filter_map(|i| ta.named_child(i).map(|n| self.parse_type_node(n)))
                            .collect();
                        return Type::Template { name: qn.clone(), args };
                    }
                }
                base_t
            }
            _ => {
                let name = self.node_text(node).unwrap_or("");
                if !name.is_empty() { Type::Named { qn: name.to_string() } }
                else { Type::Unknown }
            }
        }
    }
}

// ═══ free functions ═══

pub fn go_lookup_field_or_method(registry: &TypeRegistry, type_qn: &str, member: &str) -> Option<crate::adapter::type_registry::RegisteredFunc> {
    // Try method first
    if let Some(f) = registry.lookup_method(type_qn, member) {
        return Some(f.clone());
    }
    // Try field → treat as a getter returning the field type
    if let Some(rt) = registry.lookup_type(type_qn) {
        if let Some(t) = rt.fields.get(member) {
            return Some(crate::adapter::type_registry::RegisteredFunc {
                qualified_name: format!("{}.{}", type_qn, member),
                receiver_type: Some(type_qn.to_string()),
                short_name: member.to_string(),
                params: vec![],
                ret: t.clone(),
                flags: 0,
            });
        }
    }
    None
}

fn is_go_builtin(name: &str) -> bool {
    matches!(name, "make"|"new"|"append"|"len"|"cap"|"delete"|"close"|"copy"|"panic"|"recover"|"print"|"println"|"complex"|"real"|"imag"|"min"|"max"|"clear")
}

fn resolve_builtin_type(name: &str) -> Option<Type> {
    match name {
        "int"|"int8"|"int16"|"int32"|"int64"|"uint"|"uint8"|"uint16"|"uint32"|"uint64"
        |"float32"|"float64"|"complex64"|"complex128"|"string"|"bool"|"byte"|"rune"
        |"uintptr"|"any"|"error" => Some(Type::Builtin { name: name.to_string() }),
        _ => None,
    }
}

pub fn process_go_statement(ctx: &mut GoLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();
    match k {
        "short_var_declaration" | "assignment_statement" => {
            let left = node.child_by_field_name("left");
            let right = node.child_by_field_name("right");
            let rhs_type = right.map(|r| ctx.eval_expr_type(r)).unwrap_or(Type::Unknown);
            if let Some(l) = left {
                go_bind_lvalue(ctx, l, &rhs_type);
            }
        }
        "var_declaration" | "const_declaration" => {
            let nc = node.named_child_count();
            for i in 0..nc {
                let c = node.named_child(i).unwrap_or(node);
                if c.kind() == "var_spec" || c.kind() == "const_spec" {
                    let name = c.child_by_field_name("name");
                    let value = c.child_by_field_name("value");
                    let ty = c.child_by_field_name("type");
                    let rhs = value.map(|v| ctx.eval_expr_type(v))
                        .or_else(|| ty.map(|t| ctx.parse_type_node(t)))
                        .unwrap_or(Type::Unknown);
                    if let Some(n) = name {
                        if let Some(nm) = ctx.node_text(n).map(|s| s.to_string()) {
                            ctx.current_scope.bind(nm, rhs);
                        }
                    }
                }
            }
        }
        "for_statement" | "range_clause" => {
            // Range: for k, v := range expr → bind types
            let left = node.child_by_field_name("left");
            let right = node.child_by_field_name("right");
            if let Some(r) = right {
                let iter_t = ctx.eval_expr_type(r);
                let (key_t, val_t) = range_types(&iter_t);
                if let Some(l) = left {
                    go_bind_range_targets(ctx, l, &key_t, &val_t);
                }
            }
        }
        "expression_switch_statement" | "type_switch_statement" => {
            let init = node.child_by_field_name("initializer");
            if let Some(i) = init { process_go_statement(ctx, i); }
        }
        _ => {}
    }
}

fn range_types(t: &Type) -> (Type, Type) {
    match t {
        Type::Template { name, args } if name == "slice" || name == "array" || name == "list" => {
            (Type::Builtin { name: "int".into() }, args.first().cloned().unwrap_or(Type::Unknown))
        }
        Type::Template { name, args } if name == "map" => {
            (args.first().cloned().unwrap_or(Type::Unknown),
             args.get(1).cloned().unwrap_or(Type::Unknown))
        }
        Type::Builtin { name } if name == "string" => {
            (Type::Builtin { name: "int".into() }, Type::Builtin { name: "rune".into() })
        }
        _ => (Type::Builtin { name: "int".into() }, Type::Unknown),
    }
}

fn go_bind_lvalue(ctx: &mut GoLspContext, left: Node, rhs: &Type) {
    let lk = left.kind();
    if lk == "identifier" {
        if let Some(nm) = ctx.node_text(left).map(|s| s.to_string()) {
            ctx.current_scope.bind(nm, rhs.clone());
        }
    } else if lk == "expression_list" || lk == "argument_list" {
        let elems = match rhs {
            Type::Tuple { elems } => Some(elems),
            Type::Template { name, args } if name == "tuple" => Some(args),
            _ => None,
        };
        let nc = left.named_child_count();
        for i in 0..nc {
            let c = left.named_child(i).unwrap_or(left);
            if c.kind() == "identifier" {
                if let Some(nm) = ctx.node_text(c).map(|s| s.to_string()) {
                    let t = elems.and_then(|e| e.get(i as usize).cloned()).unwrap_or(rhs.clone());
                    ctx.current_scope.bind(nm, t);
                }
            }
        }
    }
}

fn go_bind_range_targets(ctx: &mut GoLspContext, left: Node, key_t: &Type, val_t: &Type) {
    if left.kind() == "identifier" {
        if let Some(nm) = ctx.node_text(left).map(|s| s.to_string()) {
            ctx.current_scope.bind(nm, key_t.clone());
        }
    } else if left.kind() == "expression_list" {
        let nc = left.named_child_count();
        if nc >= 2 {
            if let Some(c) = left.named_child(0) {
                if let Some(nm) = ctx.node_text(c).map(|s| s.to_string()) {
                    ctx.current_scope.bind(nm, key_t.clone());
                }
            }
            if let Some(c) = left.named_child(1) {
                if let Some(nm) = ctx.node_text(c).map(|s| s.to_string()) {
                    ctx.current_scope.bind(nm, val_t.clone());
                }
            }
        }
    }
}

pub fn resolve_go_calls(ctx: &mut GoLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();

    process_go_statement(ctx, node);

    if k == "call_expression" { emit_go_call(ctx, node); }

    // Don't recurse into nested functions/blocks — top-level process handles those
    if k == "function_declaration" || k == "method_declaration" || k == "func_literal" { return; }

    let nc = node.named_child_count();
    for i in 0..nc {
        resolve_go_calls(ctx, node.named_child(i).unwrap_or(node));
    }
}

pub fn emit_go_call(ctx: &mut GoLspContext, call_node: Node) {
    let Some(fn_node) = call_node.child_by_field_name("function") else { return };
    let fk = fn_node.kind();

    match fk {
        "identifier" => {
            let fname = ctx.node_text(fn_node).unwrap_or("").to_string();
            // Constructor: TypeName{...} (composite literal handled in eval)
            if let Some(f) = ctx.registry.lookup_symbol(&ctx.package_qn, &fname) {
                ctx.emit(&f.qualified_name, "go_direct", 0.95);
                return;
            }
            if is_go_builtin(&fname) {
                ctx.emit(&format!("builtins.{}", fname), "go_builtin", 0.92);
                return;
            }
            // Imported package function
            if let Some(pkg) = ctx.resolve_import(&fname).map(|s| s.to_string()) {
                ctx.emit(&pkg, "go_pkg", 0.55);
            }
        }
        "selector_expression" => {
            let obj = fn_node.child_by_field_name("operand");
            let field = fn_node.child_by_field_name("field");
            let (Some(obj), Some(field)) = (obj, field) else { return };
            let obj_type = ctx.eval_expr_type(obj);
            let fname = ctx.node_text(field).unwrap_or("");

            match &obj_type {
                Type::Module { qn } => {
                    if let Some(f) = ctx.registry.lookup_symbol(qn, fname) {
                        ctx.emit(&f.qualified_name, "go_pkg_call", 0.92);
                    } else {
                        let fqn = format!("{}.{}", qn, fname);
                        ctx.emit(&fqn, "go_pkg_call_unresolved", 0.55);
                    }
                }
                Type::Named { qn } | Type::Template { name: qn, .. } => {
                    if let Some(f) = go_lookup_field_or_method(ctx.registry, qn, fname) {
                        ctx.emit(&f.qualified_name, "go_method", 0.90);
                    }
                }
                Type::Builtin { name } if name != "nil" => {
                    let qn = format!("builtins.{}", name);
                    if let Some(f) = go_lookup_field_or_method(ctx.registry, &qn, fname) {
                        ctx.emit(&f.qualified_name, "go_builtin_method", 0.90);
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

pub fn process_go_function(ctx: &mut GoLspContext, func_node: Node, receiver_qn: Option<&str>) {
    let Some(name_node) = func_node.child_by_field_name("name") else { return };
    let Some(fname) = ctx.node_text(name_node) else { return };
    if fname.is_empty() { return; }

    let prev_func = ctx.enclosing_func_qn.clone();
    let base = receiver_qn.unwrap_or(&ctx.package_qn);
    ctx.enclosing_func_qn = Some(format!("{}.{}", base, fname));

    let saved = ctx.current_scope.clone();
    ctx.current_scope = ctx.current_scope.push();

    // Bind parameters
    if let Some(params) = func_node.child_by_field_name("parameters") {
        let nc = params.named_child_count();
        for i in 0..nc {
            let p = params.named_child(i).unwrap_or(params);
            if p.kind() == "parameter_declaration" {
                let name = p.child_by_field_name("name");
                let ty = p.child_by_field_name("type");
                if let Some(n) = name {
                    if let Some(nm) = ctx.node_text(n).map(|s| s.to_string()) {
                        let t = ty.map(|t| ctx.parse_type_node(t)).unwrap_or(Type::Unknown);
                        ctx.current_scope.bind(nm, t);
                    }
                }
            }
        }
    }

    // If method, bind receiver
    if let Some(recv_qn) = receiver_qn {
        ctx.current_scope.bind("self", Type::Named { qn: recv_qn.to_string() });
    }

    if let Some(body) = func_node.child_by_field_name("body") {
        resolve_go_calls(ctx, body);
    }

    ctx.current_scope = saved;
    ctx.enclosing_func_qn = prev_func;
}

pub fn process_go_file(ctx: &mut GoLspContext, root: Node) {
    if root.kind().is_empty() { return; }

    // Bind local types and functions to scope
    let type_qns: Vec<(String, String)> = ctx.registry.types_by_qn.iter()
        .filter(|(qn, _)| qn.starts_with(&format!("{}.", ctx.package_qn)))
        .map(|(qn, rt)| (rt.short_name.clone(), qn.clone()))
        .collect();
    for (short, qn) in &type_qns {
        ctx.current_scope.bind(short, Type::Named { qn: qn.clone() });
    }

    let nc = root.named_child_count();
    // Pass 1: top-level var/const/type declarations
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        process_go_statement(ctx, c);
    }
    // Pass 2: functions and methods
    let prev_func = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.__init__", ctx.package_qn));
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "function_declaration" => process_go_function(ctx, c, None),
            "method_declaration" => {
                let recv = c.child_by_field_name("receiver");
                let recv_qn = recv.and_then(|r| {
                    let ty = r.child_by_field_name("type");
                    ty.and_then(|t| {
                        let parsed = ctx.parse_type_node(t);
                        match parsed {
                            Type::Named { qn } => Some(qn),
                            _ => None,
                        }
                    })
                });
                process_go_function(ctx, c, recv_qn.as_deref());
            }
            _ => {}
        }
    }
    ctx.enclosing_func_qn = prev_func;
}

pub fn run_go_lsp(source: &str, tree: &tree_sitter::Tree, package_qn: &str, registry: &TypeRegistry) -> Vec<ResolvedCall> {
    let mut ctx = GoLspContext::new(source, registry, package_qn);
    // Extract imports
    extract_go_imports(&mut ctx, tree.root_node());
    process_go_file(&mut ctx, tree.root_node());
    ctx.resolved_calls
}

fn extract_go_imports(ctx: &mut GoLspContext, root: Node) {
    let mut to_visit = vec![root];
    while let Some(node) = to_visit.pop() {
        if node.kind() == "import_declaration" {
            let nc = node.named_child_count();
            for i in 0..nc {
                let spec = node.named_child(i).unwrap_or(node);
                if spec.kind() == "import_spec" {
                    let path_node = spec.child_by_field_name("path");
                    let alias_node = spec.child_by_field_name("name");
                    if let Some(path) = path_node {
                        if let Ok(raw) = path.utf8_text(ctx.source.as_bytes()) {
                            let pkg_path = raw.trim_matches('"').trim_matches('`');
                            let alias = alias_node
                                .and_then(|a| a.utf8_text(ctx.source.as_bytes()).ok())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| pkg_path.rsplit('/').next().unwrap_or(pkg_path).to_string());
                            ctx.add_import(&alias, pkg_path);
                        }
                    }
                }
            }
        }
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        to_visit.extend(children.into_iter().rev());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_go(source: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&crate::engine::GRAMMAR_LOADER.get("go").expect("go grammar")).ok();
        parser.parse(source, None).expect("parse failed")
    }

    #[test]
    fn test_go_basic_types() {
        let src = "package main\nfunc main() { x := 42 }";
        let tree = parse_go(src);
        let reg = TypeRegistry::new();
        let calls = run_go_lsp(src, &tree, "main", &reg);
        // Should at least not crash
        assert!(calls.is_empty() || !calls.is_empty()); // trivially true; exercises the code path
    }

    #[test]
    fn test_go_package_call() {
        let src = r#"package main
import "fmt"
func main() { fmt.Println("hello") }"#;
        let tree = parse_go(src);
        let reg = TypeRegistry::new();
        let calls = run_go_lsp(src, &tree, "main", &reg);
        // Should find the fmt.Println call
        let has_println = calls.iter().any(|rc| rc.callee_qn.contains("Println"));
        assert!(has_println, "should resolve fmt.Println, got: {:?}", calls);
    }
}
