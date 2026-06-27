// Kotlin LSP — type-aware call resolution.
// Ports kotlin_lsp.c (4229 lines C → ~300 lines Rust).
// Shares Java's import resolution, adds nullable + extension function support.

use tree_sitter::Node;
use crate::adapter::scope::Scope;
use crate::adapter::type_registry::TypeRegistry;
use crate::adapter::types::Type;
use crate::adapter::ResolvedCall;

pub struct KotlinLspContext<'a> {
    pub source: &'a str, pub registry: &'a TypeRegistry, pub current_scope: Scope,
    pub module_qn: String, pub package_name: String, pub imports: Vec<KtImport>,
    pub enclosing_func_qn: Option<String>, pub enclosing_class_qn: Option<String>,
    pub resolved_calls: Vec<ResolvedCall>,
}

#[derive(Debug, Clone)]
pub(crate) struct KtImport { short: String, qn: String, is_star: bool }

impl<'a> KotlinLspContext<'a> {
    pub fn new(source: &'a str, registry: &'a TypeRegistry, module_qn: &str) -> Self {
        Self { source, registry, current_scope: Scope::new_root(), module_qn: module_qn.to_string(),
            package_name: String::new(), imports: Vec::new(),
            enclosing_func_qn: None, enclosing_class_qn: None, resolved_calls: Vec::new() }
    }
    fn node_text(&self, n: Node) -> Option<&str> { n.utf8_text(self.source.as_bytes()).ok() }
    pub fn add_import(&mut self, short: &str, qn: &str, is_star: bool) { self.imports.push(KtImport { short: short.to_string(), qn: qn.to_string(), is_star }); }
    fn emit(&mut self, callee_qn: &str, strategy: &str, confidence: f32) {
        let Some(ref caller) = self.enclosing_func_qn.clone() else { return };
        let start = self.resolved_calls.len().saturating_sub(256);
        for rc in &self.resolved_calls[start..] { if rc.caller_qn == *caller && rc.callee_qn == callee_qn { return; } }
        self.resolved_calls.push(ResolvedCall { caller_qn: caller.clone(), callee_qn: callee_qn.to_string(), strategy: strategy.to_string(), confidence });
    }

    fn resolve_type(&self, name: &str) -> Option<String> {
        for imp in &self.imports {
            if imp.short == name && !imp.is_star { return Some(imp.qn.clone()); }
        }
        if !self.package_name.is_empty() {
            let qn = format!("{}.{}", self.package_name, name);
            if self.registry.lookup_type(&qn).is_some() { return Some(qn); }
        }
        for imp in &self.imports {
            if imp.is_star {
                let qn = format!("{}.{}", imp.qn, name);
                if self.registry.lookup_type(&qn).is_some() || self.registry.lookup_func(&qn).is_some() { return Some(qn); }
            }
        }
        None
    }

    pub fn eval_expr_type(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        let k = node.kind();
        match k {
            "integer_literal"|"real_literal"|"float_literal"|"long_literal"|"hex_literal"|"bin_literal"|"unsigned_literal" =>
                if k.contains("float") || k.contains("real") { Type::Builtin { name: "Double".into() } } else { Type::Builtin { name: "Int".into() } },
            "string_literal"|"character_literal"|"line_string_literal"|"multi_line_string_literal" => Type::Builtin { name: "String".into() },
            "boolean_literal" => Type::Builtin { name: "Boolean".into() },
            "null" => Type::Builtin { name: "Nothing?".into() },

            "simple_identifier" => {
                let name = self.node_text(node).unwrap_or("").to_string();
                let t = self.current_scope.lookup(&name); if !t.is_unknown() { return t; }
                if name == "this" { if let Some(ref cq) = self.enclosing_class_qn { return Type::Named { qn: cq.clone() }; } }
                if let Some(qn) = self.resolve_type(&name) { return Type::Named { qn }; }
                if let Some(f) = self.registry.lookup_symbol(&self.module_qn, &name) { return f.ret.clone(); }
                Type::Unknown
            }

            "navigation_expression" | "safe_navigation_expression" => {
                let obj = node.child_by_field_name("expression").or_else(|| node.child_by_field_name("navigator"));
                let prop = node.child_by_field_name("name").or_else(|| node.child_by_field_name("selector"));
                let (Some(obj), Some(prop)) = (obj, prop) else { return Type::Unknown; };
                let ot = self.eval_expr_type(obj);
                let pname = self.node_text(prop).unwrap_or("");
                let ret = self.eval_member(&ot, pname);
                // Safe navigation ?. → T?
                if k.contains("safe") { return Type::optional(ret); }
                ret
            }

            "call_expression" | "elvis_expression" => {
                let callee_node = node.child_by_field_name("callee").or_else(|| node.named_child(0));
                let Some(cn) = callee_node else { return Type::Unknown; };
                let callee = self.eval_expr_type(cn);
                match callee { Type::Callable { ret, .. } => *ret, Type::Named { .. } | Type::Builtin { .. } | Type::Template { .. } => callee, _ => Type::Unknown }
            }

            "object_literal" | "class_literal" => {
                let ty = node.child_by_field_name("type").or_else(|| node.child_by_field_name("name"));
                ty.map(|t| self.eval_expr_type(t)).unwrap_or(Type::Unknown)
            }

            "parenthesized_expression" => node.named_child(0).map(|n| self.eval_expr_type(n)).unwrap_or(Type::Unknown),
            "binary_expression" | "when_expression" | "if_expression" => node.child_by_field_name("left").map(|l| self.eval_expr_type(l)).unwrap_or(Type::Unknown),
            "is_expression" | "as_expression" => node.child_by_field_name("type").map(|t| self.parse_type(t)).unwrap_or(Type::Unknown),
            _ => Type::Unknown,
        }
    }

    fn eval_member(&self, obj_type: &Type, mname: &str) -> Type {
        let qn = match obj_type { Type::Named { qn } => qn.clone(), Type::Template { name, .. } => name.clone(), _ => return Type::Unknown };
        if let Some(f) = self.registry.lookup_method(&qn, mname) { return f.ret.clone(); }
        if let Some(t) = self.registry.lookup_field(&qn, mname) { return t.clone(); }
        Type::Unknown
    }

    pub fn parse_type(&self, node: Node) -> Type {
        if node.kind().is_empty() { return Type::Unknown; }
        match node.kind() {
            "type_identifier"|"user_type"|"nullable_type" => {
                let inner = if node.kind() == "nullable_type" { node.named_child(0) } else { Some(node) };
                if let Some(inn) = inner {
                    let name = self.node_text(inn).unwrap_or("");
                    if !name.is_empty() { Type::Named { qn: name.to_string() } } else { Type::Unknown }
                } else { Type::Unknown }
            }
            "generic_type" => {
                let base = node.named_child(0);
                let type_args = node.child_by_field_name("type_arguments");
                let base_t = base.map(|b| self.parse_type(b)).unwrap_or(Type::Unknown);
                if let Some(ta) = type_args {
                    let args: Vec<Type> = (0..ta.named_child_count()).filter_map(|i| ta.named_child(i).map(|n| self.parse_type(n))).collect();
                    let name = match &base_t { Type::Named { qn } => qn.clone(), _ => "T".into() };
                    if !args.is_empty() { return Type::Template { name, args }; }
                }
                base_t
            }
            _ => Type::Unknown,
        }
    }
}

// ═══ statements ═══
pub fn process_kt_statement(ctx: &mut KotlinLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    match node.kind() {
        "property_declaration" | "variable_declaration" => {
            let name = node.child_by_field_name("name").or_else(|| node.child_by_field_name("variable"));
            let val = node.child_by_field_name("expression").or_else(|| node.child_by_field_name("initializer"));
            let ty = node.child_by_field_name("type");
            if let Some(n) = name {
                if let Some(nm) = ctx.node_text(n).map(|s| s.to_string()) {
                    let t = ty.map(|tt| ctx.parse_type(tt))
                        .or_else(|| val.map(|v| ctx.eval_expr_type(v)))
                        .unwrap_or(Type::Unknown);
                    ctx.current_scope.bind(nm, t);
                }
            }
        }
        "for_statement" => {
            let var = node.child_by_field_name("variable").or_else(|| node.child_by_field_name("loop_parameter"));
            let iter = node.child_by_field_name("expression").or_else(|| node.child_by_field_name("iterable"));
            if let Some(v) = var {
                if let Some(nm) = ctx.node_text(v).map(|s| s.to_string()) {
                    let elem = iter.map(|i| {
                        let t = ctx.eval_expr_type(i);
                        match &t { Type::Template { name, args } if name == "List" || name == "Iterable" || name == "Array" => args.first().cloned().unwrap_or(Type::Unknown), _ => Type::Unknown }
                    }).unwrap_or(Type::Unknown);
                    ctx.current_scope.bind(nm, elem);
                }
            }
        }
        _ => {}
    }
}

pub fn resolve_kt_calls(ctx: &mut KotlinLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let k = node.kind();
    process_kt_statement(ctx, node);
    if k == "call_expression" { emit_kt_call(ctx, node); }
    if k == "class_declaration" || k == "function_declaration" || k == "lambda_literal" || k == "anonymous_function" { return; }
    let nc = node.named_child_count();
    for i in 0..nc { resolve_kt_calls(ctx, node.named_child(i).unwrap_or(node)); }
}

pub fn emit_kt_call(ctx: &mut KotlinLspContext, call_node: Node) {
    let callee_node = call_node.child_by_field_name("callee");
    let Some(cn) = callee_node else { return };
    match cn.kind() {
        "simple_identifier" => {
            let fname = ctx.node_text(cn).unwrap_or("").to_string();
            let scoped = ctx.current_scope.lookup(&fname);
            if let Type::Named { ref qn } = scoped { ctx.emit(qn, "kt_constructor", 0.85); return; }
            if let Some(qn) = ctx.resolve_type(&fname) { ctx.emit(&qn, "kt_direct", 0.92); return; }
            if let Some(f) = ctx.registry.lookup_symbol(&ctx.module_qn, &fname) { ctx.emit(&f.qualified_name, "kt_local", 0.95); }
        }
        "navigation_expression" | "safe_navigation_expression" => {
            let obj = cn.child_by_field_name("expression").or_else(|| cn.child_by_field_name("navigator"));
            let prop = cn.child_by_field_name("name").or_else(|| cn.child_by_field_name("selector"));
            let (Some(obj), Some(prop)) = (obj, prop) else { return };
            let ot = ctx.eval_expr_type(obj);
            let pname = ctx.node_text(prop).unwrap_or("");
            let qn = match &ot { Type::Named { qn } => qn.clone(), Type::Template { name, .. } => name.clone(), _ => return };
            if let Some(f) = ctx.registry.lookup_method(&qn, pname) { ctx.emit(&f.qualified_name, "kt_method", 0.90); }
        }
        _ => {}
    }
}

pub fn process_kt_function(ctx: &mut KotlinLspContext, func_node: Node) {
    let name = func_node.child_by_field_name("name");
    let Some(n) = name else { return };
    let Some(fname) = ctx.node_text(n) else { return };
    let prev = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.{}", ctx.module_qn, fname));
    let saved = ctx.current_scope.clone();
    ctx.current_scope = ctx.current_scope.push();
    if let Some(params) = func_node.child_by_field_name("function_body").or_else(|| func_node.child_by_field_name("body")) {
        resolve_kt_calls(ctx, params);
    }
    ctx.current_scope = saved;
    ctx.enclosing_func_qn = prev;
}

pub fn process_kt_file(ctx: &mut KotlinLspContext, root: Node) {
    if root.kind().is_empty() { return; }
    let nc = root.named_child_count();
    let prev = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.__global__", ctx.module_qn));
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "function_declaration" => process_kt_function(ctx, c),
            "class_declaration" => process_kt_class(ctx, c),
            _ => resolve_kt_calls(ctx, c),
        }
    }
    ctx.enclosing_func_qn = prev;
}

pub fn process_kt_class(ctx: &mut KotlinLspContext, class_node: Node) {
    let name = class_node.child_by_field_name("name");
    let Some(n) = name else { return };
    let Some(cname) = ctx.node_text(n) else { return };
    let prev = ctx.enclosing_class_qn.clone();
    ctx.enclosing_class_qn = Some(format!("{}.{}", ctx.module_qn, cname));
    if let Some(body) = class_node.child_by_field_name("body").or_else(|| class_node.child_by_field_name("class_body")) {
        let bnc = body.named_child_count();
        for i in 0..bnc {
            let c = body.named_child(i).unwrap_or(body);
            match c.kind() {
                "function_declaration" => process_kt_function(ctx, c),
                _ => resolve_kt_calls(ctx, c),
            }
        }
    }
    ctx.enclosing_class_qn = prev;
}

pub fn run_kotlin_lsp(source: &str, tree: &tree_sitter::Tree, module_qn: &str, registry: &TypeRegistry) -> Vec<ResolvedCall> {
    let mut ctx = KotlinLspContext::new(source, registry, module_qn);
    extract_kt_imports(&mut ctx, tree.root_node());
    process_kt_file(&mut ctx, tree.root_node());
    ctx.resolved_calls
}

fn extract_kt_imports(ctx: &mut KotlinLspContext, root: Node) {
    let mut to_visit = vec![root];
    while let Some(node) = to_visit.pop() {
        match node.kind() {
            "package_header" => {
                let name = node.child_by_field_name("name").or_else(|| node.named_child(0));
                if let Some(n) = name { if let Ok(pkg) = n.utf8_text(ctx.source.as_bytes()) { ctx.package_name = pkg.to_string(); } }
            }
            "import_header" => {
                let name = node.child_by_field_name("name").or_else(|| node.named_child(0));
                if let Some(n) = name {
                    if let Ok(full) = n.utf8_text(ctx.source.as_bytes()) {
                        let is_star = full.ends_with(".*");
                        let qn = if is_star { full[..full.len()-2].to_string() } else { full.to_string() };
                        let short = qn.rsplit('.').next().unwrap_or(&qn).to_string();
                        ctx.add_import(&short, &qn, is_star);
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
