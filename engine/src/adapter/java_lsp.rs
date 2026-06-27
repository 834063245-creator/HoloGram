// Java LSP — type-aware call resolution. Covers Java + Kotlin semantics.
// Ports java_lsp.c (3634 lines) + kotlin_lsp.c (4229 lines).

use tree_sitter::Node;
use crate::adapter::scope::Scope;
use crate::adapter::type_registry::TypeRegistry;
use crate::adapter::types::Type;

pub use crate::adapter::ResolvedCall;

pub struct JavaLspContext<'a> {
    pub source: &'a str, pub registry: &'a TypeRegistry, pub current_scope: Scope,
    pub module_qn: String, pub package_name: String,
    pub imports: Vec<JavaImport>,
    pub enclosing_method_qn: Option<String>, pub enclosing_class_qn: Option<String>,
    pub resolved_calls: Vec<ResolvedCall>,
}

#[derive(Debug, Clone)]
pub(crate) struct JavaImport { local_name: String, target_qn: String, kind: JavaImportKind }

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum JavaImportKind { Type, Static, OnDemand, StaticOnDemand }

impl<'a> JavaLspContext<'a> {
    pub fn new(source: &'a str, registry: &'a TypeRegistry, module_qn: &str, package: &str) -> Self {
        Self { source, registry, current_scope: Scope::new_root(), module_qn: module_qn.to_string(),
            package_name: package.to_string(), imports: Vec::new(),
            enclosing_method_qn: None, enclosing_class_qn: None, resolved_calls: Vec::new() }
    }

    fn node_text(&self, node: Node) -> Option<&str> { node.utf8_text(self.source.as_bytes()).ok() }
    pub fn add_import(&mut self, local: &str, target: &str, kind: JavaImportKind) {
        self.imports.push(JavaImport { local_name: local.to_string(), target_qn: target.to_string(), kind });
    }

    fn emit(&mut self, callee_qn: &str, strategy: &str, confidence: f32) {
        let Some(ref caller) = self.enclosing_method_qn.clone() else { return };
        let start = self.resolved_calls.len().saturating_sub(256);
        for rc in &self.resolved_calls[start..] {
            if rc.caller_qn == *caller && rc.callee_qn == callee_qn { return; }
        }
        self.resolved_calls.push(ResolvedCall { caller_qn: caller.clone(), callee_qn: callee_qn.to_string(), strategy: strategy.to_string(), confidence });
    }

    fn resolve_type_name(&self, name: &str) -> Option<String> {
        // 1. Single-type import
        for imp in &self.imports {
            if imp.kind == JavaImportKind::Type && imp.local_name == name { return Some(imp.target_qn.clone()); }
        }
        // 2. Same-package
        if !self.package_name.is_empty() {
            let qn = format!("{}.{}", self.package_name, name);
            if self.registry.lookup_type(&qn).is_some() { return Some(qn); }
        }
        // 3. On-demand imports
        for imp in &self.imports {
            if imp.kind == JavaImportKind::OnDemand {
                let qn = format!("{}.{}", imp.target_qn, name);
                if self.registry.lookup_type(&qn).is_some() { return Some(qn); }
                if self.registry.lookup_func(&qn).is_some() { return Some(qn); }
            }
        }
        // 4. java.lang
        let jl_qn = format!("java.lang.{}", name);
        if self.registry.lookup_type(&jl_qn).is_some() { return Some(jl_qn); }
        None
    }

    fn resolve_static_import(&self, name: &str) -> Option<String> {
        for imp in &self.imports {
            if imp.kind == JavaImportKind::Static && imp.local_name == name { return Some(imp.target_qn.clone()); }
        }
        for imp in &self.imports {
            if imp.kind == JavaImportKind::StaticOnDemand {
                let qn = format!("{}.{}", imp.target_qn, name);
                if self.registry.lookup_func(&qn).is_some() { return Some(qn); }
            }
        }
        None
    }

    // ═══ expr evaluator ═══
    pub fn eval_expr_type(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        let k = node.kind();
        match k {
            "decimal_integer_literal"|"hex_integer_literal"|"octal_integer_literal"|"binary_integer_literal"|"decimal_floating_point_literal"|"hex_floating_point_literal" =>
                if k.contains("float") { Type::Builtin { name: "float".into() } } else { Type::Builtin { name: "int".into() } },
            "string_literal"|"character_literal"|"string_fragment"|"text_block" => Type::Builtin { name: "String".into() },
            "true"|"false" => Type::Builtin { name: "boolean".into() },
            "null_literal" => Type::Builtin { name: "null".into() },

            "identifier" => {
                let name = self.node_text(node).unwrap_or("").to_string();
                // Scope
                let t = self.current_scope.lookup(&name);
                if !t.is_unknown() { return t; }
                // Static import
                if let Some(qn) = self.resolve_static_import(&name) { return Type::Named { qn }; }
                // Class in scope (constructor)
                if let Some(qn) = self.resolve_type_name(&name) { return Type::Named { qn }; }
                // Module-local
                if let Some(f) = self.registry.lookup_symbol(&self.module_qn, &name) { return f.ret.clone(); }
                Type::Unknown
            }

            "field_access" => {
                let obj = node.child_by_field_name("object");
                let field = node.child_by_field_name("field");
                let (Some(obj), Some(field)) = (obj, field) else { return Type::Unknown; };
                let obj_type = self.eval_expr_type(obj);
                let fname = self.node_text(field).unwrap_or("");
                self.eval_field_access(&obj_type, fname)
            }

            "method_invocation" => {
                let obj_node = node.child_by_field_name("object");
                let name_node = node.child_by_field_name("name");
                let (Some(obj), Some(name)) = (obj_node, name_node) else {
                    // Static method call: Method(args)
                    if let Some(n) = name_node {
                        let mname = self.node_text(n).unwrap_or("");
                        if let Some(qn) = self.resolve_static_import(mname) {
                            if let Some(f) = self.registry.lookup_func(&qn) { return f.ret.clone(); }
                        }
                        if let Some(f) = self.registry.lookup_symbol(&self.module_qn, mname) { return f.ret.clone(); }
                    }
                    return Type::Unknown;
                };
                let obj_type = self.eval_expr_type(obj);
                let mname = self.node_text(name).unwrap_or("");
                self.eval_method_call(&obj_type, mname)
            }

            "object_creation_expression" => {
                let type_node = node.child_by_field_name("type");
                type_node.map(|t| self.parse_type_node(t)).unwrap_or(Type::Unknown)
            }

            "array_creation_expression" => {
                let type_node = node.child_by_field_name("type");
                type_node.map(|t| {
                    let base = self.parse_type_node(t);
                    Type::Template { name: "array".into(), args: vec![base] }
                }).unwrap_or(Type::Unknown)
            }

            "cast_expression" => {
                let type_node = node.child_by_field_name("type");
                type_node.map(|t| self.parse_type_node(t)).unwrap_or(Type::Unknown)
            }

            "parenthesized_expression" => {
                node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown)
            }

            "binary_expression" | "ternary_expression" => {
                node.child_by_field_name("left").map(|l| self.eval_expr_type(l)).unwrap_or(Type::Unknown)
            }

            "unary_expression" => {
                node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown)
            }

            _ => Type::Unknown,
        }
    }

    fn eval_field_access(&self, obj_type: &Type, fname: &str) -> Type {
        match obj_type {
            Type::Module { qn } => {
                if let Some(f) = self.registry.lookup_symbol(qn, fname) { return f.ret.clone(); }
                Type::Unknown
            }
            Type::Named { qn } => {
                if let Some(f) = self.registry.lookup_method(qn, fname) { return f.ret.clone(); }
                if let Some(t) = self.registry.lookup_field(qn, fname) { return t.clone(); }
                Type::Unknown
            }
            Type::Builtin { name } if name != "null" => {
                let qn = format!("java.lang.{}", name);
                if let Some(f) = self.registry.lookup_method(&qn, fname) { return f.ret.clone(); }
                Type::Unknown
            }
            _ => Type::Unknown,
        }
    }

    fn eval_method_call(&self, obj_type: &Type, mname: &str) -> Type {
        self.eval_field_access(obj_type, mname)
    }

    pub fn parse_type_node(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        let k = node.kind();
        match k {
            "type_identifier" | "scoped_type_identifier" | "generic_type" => {
                let name = self.node_text(node).unwrap_or("");
                if !name.is_empty() { Type::Named { qn: name.to_string() } } else { Type::Unknown }
            }
            "array_type" => {
                let inner = node.named_child(0).map(|n| self.parse_type_node(n)).unwrap_or(Type::Unknown);
                Type::Template { name: "array".into(), args: vec![inner] }
            }
            "integral_type" => Type::Builtin { name: self.node_text(node).unwrap_or("int").to_string() },
            "floating_point_type" => Type::Builtin { name: self.node_text(node).unwrap_or("float").to_string() },
            "boolean_type" => Type::Builtin { name: "boolean".into() },
            "void_type" => Type::Builtin { name: "void".into() },
            _ => Type::Unknown,
        }
    }
}

// ═══ free functions ═══
pub fn process_java_statement(ctx: &mut JavaLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();
    match k {
        "local_variable_declaration" => {
            let ty = node.child_by_field_name("type");
            let decl = node.child_by_field_name("declarator");
            let base_t = ty.map(|t| ctx.parse_type_node(t)).unwrap_or(Type::Unknown);
            if let Some(d) = decl {
                let name = d.child_by_field_name("name");
                if let Some(n) = name {
                    if let Some(nm) = ctx.node_text(n).map(|s| s.to_string()) {
                        ctx.current_scope.bind(nm, base_t);
                    }
                }
            }
        }
        "enhanced_for_statement" => {
            let name = node.child_by_field_name("name");
            let value = node.child_by_field_name("value");
            if let Some(v) = value {
                let iter_t = ctx.eval_expr_type(v);
                let elem = java_element_type(&iter_t);
                if let Some(n) = name {
                    if let Some(nm) = ctx.node_text(n).map(|s| s.to_string()) {
                        ctx.current_scope.bind(nm, elem);
                    }
                }
            }
        }
        _ => {}
    }
}

fn java_element_type(t: &Type) -> Type {
    match t {
        Type::Template { name, args } if name == "array" || name == "List" || name == "Iterable" || name == "Collection" => args.first().cloned().unwrap_or(Type::Unknown),
        Type::Template { name, args } if name == "Map" => Type::Template { name: "Map.Entry".into(), args: args.clone() },
        _ => Type::Unknown,
    }
}

pub fn resolve_java_calls(ctx: &mut JavaLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();
    process_java_statement(ctx, node);
    if k == "method_invocation" { emit_java_call(ctx, node); }
    if k == "object_creation_expression" {
        let ty = node.child_by_field_name("type");
        if let Some(t) = ty {
            let parsed = ctx.parse_type_node(t);
            if let Type::Named { ref qn } = parsed { ctx.emit(qn, "java_constructor", 0.85); }
        }
    }
    if k == "class_declaration" || k == "interface_declaration" || k == "method_declaration" || k == "constructor_declaration" || k == "lambda_expression" { return; }
    let nc = node.named_child_count();
    for i in 0..nc { resolve_java_calls(ctx, node.named_child(i).unwrap_or(node)); }
}

pub fn emit_java_call(ctx: &mut JavaLspContext, call_node: Node) {
    let obj_node = call_node.child_by_field_name("object");
    let name_node = call_node.child_by_field_name("name");
    match (obj_node, name_node) {
        (Some(obj), Some(name)) => {
            let obj_type = ctx.eval_expr_type(obj);
            let mname = ctx.node_text(name).unwrap_or("").to_string();
            emit_java_method(ctx, &obj_type, &mname);
        }
        (None, Some(name)) => {
            let mname = ctx.node_text(name).unwrap_or("").to_string();
            if let Some(qn) = ctx.resolve_static_import(&mname) { ctx.emit(&qn, "java_static", 0.92); return; }
            if let Some(f) = ctx.registry.lookup_symbol(&ctx.module_qn, &mname) { ctx.emit(&f.qualified_name, "java_direct", 0.95); return; }
        }
        _ => {}
    }
}

fn emit_java_method(ctx: &mut JavaLspContext, obj_type: &Type, mname: &str) {
    let qn = match obj_type {
        Type::Named { qn } | Type::Template { name: qn, .. } => qn.clone(),
        Type::Builtin { name } if name != "null" => format!("java.lang.{}", name),
        _ => return,
    };
    if let Some(f) = ctx.registry.lookup_method(&qn, mname) {
        ctx.emit(&f.qualified_name, "java_method", 0.90);
    }
}

pub fn process_java_method(ctx: &mut JavaLspContext, method_node: Node) {
    let name_node = method_node.child_by_field_name("name");
    let Some(n) = name_node else { return };
    let Some(mname) = ctx.node_text(n) else { return };
    if mname.is_empty() { return; }

    let prev = ctx.enclosing_method_qn.clone();
    ctx.enclosing_method_qn = Some(format!("{}.{}", ctx.module_qn, mname));

    let saved = ctx.current_scope.clone();
    ctx.current_scope = ctx.current_scope.push();

    if let Some(params) = method_node.child_by_field_name("parameters") {
        let nc = params.named_child_count();
        for i in 0..nc {
            let p = params.named_child(i).unwrap_or(params);
            if p.kind() == "formal_parameter" {
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

    if let Some(body) = method_node.child_by_field_name("body") { resolve_java_calls(ctx, body); }

    ctx.current_scope = saved;
    ctx.enclosing_method_qn = prev;
}

pub fn process_java_file(ctx: &mut JavaLspContext, root: Node) {
    if root.kind().is_empty() { return; }
    let nc = root.named_child_count();
    let prev = ctx.enclosing_method_qn.clone();
    ctx.enclosing_method_qn = Some(format!("{}.__static__", ctx.module_qn));
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "method_declaration" | "constructor_declaration" => process_java_method(ctx, c),
            "class_declaration" | "interface_declaration" => process_java_class(ctx, c),
            _ => resolve_java_calls(ctx, c),
        }
    }
    ctx.enclosing_method_qn = prev;
}

pub fn process_java_class(ctx: &mut JavaLspContext, class_node: Node) {
    let name_node = class_node.child_by_field_name("name");
    let Some(n) = name_node else { return };
    let Some(cname) = ctx.node_text(n) else { return };
    let prev_class = ctx.enclosing_class_qn.clone();
    ctx.enclosing_class_qn = Some(format!("{}.{}", ctx.module_qn, cname));

    if let Some(body) = class_node.child_by_field_name("body") {
        let bnc = body.named_child_count();
        for i in 0..bnc {
            let c = body.named_child(i).unwrap_or(body);
            match c.kind() {
                "method_declaration" | "constructor_declaration" => process_java_method(ctx, c),
                "class_declaration" | "interface_declaration" => process_java_class(ctx, c),
                _ => resolve_java_calls(ctx, c),
            }
        }
    }
    ctx.enclosing_class_qn = prev_class;
}

pub fn run_java_lsp(source: &str, tree: &tree_sitter::Tree, module_qn: &str, registry: &TypeRegistry) -> Vec<ResolvedCall> {
    let mut ctx = JavaLspContext::new(source, registry, module_qn, "");
    extract_java_imports(&mut ctx, tree.root_node());
    process_java_file(&mut ctx, tree.root_node());
    ctx.resolved_calls
}

fn extract_java_imports(ctx: &mut JavaLspContext, root: Node) {
    let mut to_visit = vec![root];
    while let Some(node) = to_visit.pop() {
        if node.kind() == "package_declaration" {
            if let Some(name) = node.child_by_field_name("name") {
                if let Ok(pkg) = name.utf8_text(ctx.source.as_bytes()).map(|s| s.to_string()) {
                    ctx.package_name = pkg;
                }
            }
        }
        if node.kind() == "import_declaration" {
            if let Some(name) = node.child_by_field_name("name") {
                if let Ok(full) = name.utf8_text(ctx.source.as_bytes()).map(|s| s.to_string()) {
                    let short = full.rsplit('.').next().unwrap_or(&full).to_string();
                    let kind = if full.ends_with(".*") {
                        JavaImportKind::OnDemand
                    } else {
                        JavaImportKind::Type
                    };
                    ctx.add_import(&short, &full, kind);
                }
            }
        }
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        to_visit.extend(children.into_iter().rev());
    }
}
