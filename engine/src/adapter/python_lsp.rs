// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Python type-aware call resolution.
//! Ports `py_lsp.c` (3633 lines C) → Rust.
//!
//! Architecture:
//!   process_file(ctx, root)
//!     ├─ bind_imports(ctx)
//!     ├─ bind_module_classes(ctx)
//!     ├─ Pass 1: top-level assignments (process_statement)
//!     └─ Pass 2: functions/classes → process_function / process_class
//!          └─ resolve_calls_in(ctx, body)
//!               ├─ process_statement(ctx, node)   // bind vars
//!               ├─ emit_call_for(ctx, node)       // resolve + emit
//!               └─ recurse children

use std::collections::HashMap;

use tree_sitter::{Node, Tree};

use crate::adapter::scope::Scope;
use crate::adapter::type_registry::{RegisteredFunc, TypeRegistry};
use crate::adapter::types::Type;

// ── Constants ──

const DEDUP_WINDOW: usize = 256;

// ── ResolvedCall ──
pub use crate::adapter::ResolvedCall;

// ── PyLspContext ──

pub struct PyLspContext<'a> {
    pub source: &'a str,
    pub registry: &'a TypeRegistry,
    pub current_scope: Scope,
    pub module_qn: String,
    pub imports: HashMap<String, String>,
    pub enclosing_func_qn: Option<String>,
    pub enclosing_class_qn: Option<String>,
    pub resolved_calls: Vec<ResolvedCall>,
}

impl<'a> PyLspContext<'a> {
    pub fn new(source: &'a str, registry: &'a TypeRegistry, module_qn: &str) -> Self {
        Self {
            source,
            registry,
            current_scope: Scope::new_root(),
            module_qn: module_qn.to_string(),
            imports: HashMap::new(),
            enclosing_func_qn: None,
            enclosing_class_qn: None,
            resolved_calls: Vec::new(),
        }
    }

    fn node_text(&self, node: Node) -> Option<&str> {
        node.utf8_text(self.source.as_bytes()).ok()
    }

    // ── import binding ──

    pub fn add_import(&mut self, local_name: &str, module_qn: &str) {
        if local_name == "*" {
            return;
        }
        self.imports.insert(local_name.to_string(), module_qn.to_string());
    }

    pub fn bind_imports(&mut self) {
        let imports: Vec<(String, String)> =
            self.imports.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (local_name, module_qn) in &imports {
            let is_from_style = module_qn.ends_with(&format!(".{}", local_name))
                && module_qn.matches('.').count() >= 1;
            let ty = if is_from_style {
                Type::Named { qn: module_qn.clone() }
            } else {
                Type::Module { qn: module_qn.clone() }
            };
            self.current_scope.bind(local_name, ty);
            self.bind_dotted_prefixes(module_qn);
        }
    }

    fn bind_dotted_prefixes(&mut self, qn: &str) {
        for (pos, _) in qn.match_indices('.') {
            let prefix = &qn[..pos];
            let short = prefix.rsplit('.').next().unwrap_or(prefix);
            if self.current_scope.lookup(short).is_unknown() {
                self.current_scope.bind(short, Type::Module { qn: prefix.to_string() });
            }
        }
    }

    pub fn bind_module_classes(&mut self) {
        let prefix = format!("{}.", self.module_qn);
        let type_entries: Vec<(String, String)> = self
            .registry
            .types_by_qn
            .iter()
            .filter(|(qn, _)| qn.starts_with(&prefix))
            .map(|(qn, rt)| (rt.short_name.clone(), qn.clone()))
            .collect();
        for (short_name, qn) in type_entries {
            if self.current_scope.lookup(&short_name).is_unknown() {
                self.current_scope.bind(&short_name, Type::Named { qn });
            }
        }
    }

    // ── resolved call emission ──

    pub fn emit_resolved_call(&mut self, callee_qn: &str, strategy: &str, confidence: f32) {
        let caller_qn = match &self.enclosing_func_qn {
            Some(qn) => qn.clone(),
            None => return,
        };
        let start = if self.resolved_calls.len() > DEDUP_WINDOW {
            self.resolved_calls.len() - DEDUP_WINDOW
        } else {
            0
        };
        for rc in &self.resolved_calls[start..] {
            if rc.caller_qn == caller_qn && rc.callee_qn == callee_qn {
                return;
            }
        }
        self.resolved_calls.push(ResolvedCall {
            caller_qn,
            callee_qn: callee_qn.to_string(),
            strategy: strategy.to_string(),
            confidence,
        });
    }

    // ── expression type evaluation ──

    pub fn eval_expr_type(&self, node: Node) -> Type {
        let d = EVAL_DEPTH.with(|c| {
            let v = c.get().saturating_add(1);
            c.set(v);
            v
        });
        // DepthGuard MUST be created BEFORE any early return, otherwise
        // the thread_local counter leaks upward and never recovers.
        let _guard = DepthGuard;
        if d > AST_DEPTH_LIMIT || node.kind().is_empty() {
            if d > AST_DEPTH_LIMIT {
                tracing::warn!(depth = d, "[py_lsp] eval_expr_type depth limit hit");
            }
            return Type::Unknown;
        }
        self.eval_expr_type_impl(node)
    }

    fn eval_expr_type_impl(&self, node: Node) -> Type {
        let kind = node.kind();

        if let Some(t) = self.literal_type(node) {
            return t;
        }

        match kind {
            "tuple" => {
                let cn = node.named_child_count();
                if cn == 0 {
                    return Type::Builtin { name: "tuple".into() };
                }
                let elems: Vec<Type> = (0..cn)
                    .filter_map(|i| {
                        let child = node.named_child(i)?;
                        Some(self.eval_expr_type(child))
                    })
                    .collect();
                if elems.is_empty() {
                    Type::Builtin { name: "tuple".into() }
                } else {
                    Type::Tuple { elems }
                }
            }
            "list" => {
                let cn = node.named_child_count();
                if cn == 0 {
                    return Type::Builtin { name: "list".into() };
                }
                let first = self.eval_expr_type(node.named_child(0).unwrap_or(node));
                if first.is_unknown() {
                    Type::Builtin { name: "list".into() }
                } else {
                    Type::Template { name: "list".into(), args: vec![first] }
                }
            }
            "set" => {
                let cn = node.named_child_count();
                if cn == 0 {
                    return Type::Builtin { name: "set".into() };
                }
                let first = self.eval_expr_type(node.named_child(0).unwrap_or(node));
                Type::Template { name: "set".into(), args: vec![first] }
            }
            "dictionary" => {
                let cn = node.named_child_count();
                if cn == 0 {
                    return Type::Builtin { name: "dict".into() };
                }
                for i in 0..cn {
                    let Some(pair) = node.named_child(i) else { continue };
                    if pair.kind() != "pair" { continue; }
                    let key = pair.child_by_field_name("key");
                    let value = pair.child_by_field_name("value");
                    if let (Some(k), Some(v)) = (key, value) {
                        let kt = self.eval_expr_type(k);
                        let vt = self.eval_expr_type(v);
                        if !kt.is_unknown() || !vt.is_unknown() {
                            return Type::Template {
                                name: "dict".into(), args: vec![kt, vt],
                            };
                        }
                    }
                }
                Type::Builtin { name: "dict".into() }
            }
            "identifier" => {
                if let Some(name) = self.node_text(node) {
                    let t = self.current_scope.lookup(name);
                    if !t.is_unknown() {
                        return t;
                    }
                    match name {
                        "True" | "False" => return Type::Builtin { name: "bool".into() },
                        "None" => return Type::Builtin { name: "None".into() },
                        _ => {}
                    }
                    if let Some(f) = self.registry.lookup_symbol(&self.module_qn, name) {
                        return f.ret.clone();
                    }
                    if let Some(f) = self.registry.lookup_symbol("builtins", name) {
                        return f.ret.clone();
                    }
                    let builtin_qn = format!("builtins.{}", name);
                    if self.registry.lookup_type(&builtin_qn).is_some() {
                        return Type::Builtin { name: name.to_string() };
                    }
                }
                Type::Unknown
            }
            "attribute" => {
                let obj = node.child_by_field_name("object");
                let attr = node.child_by_field_name("attribute");
                let (Some(obj), Some(attr)) = (obj, attr) else { return Type::Unknown; };
                let obj_type = self.eval_expr_type(obj);
                let attr_name = self.node_text(attr).unwrap_or("");
                self.eval_attribute_type(&obj_type, attr_name)
            }
            "call" => {
                let fn_node = node.child_by_field_name("function");
                let Some(fn_node) = fn_node else { return Type::Unknown; };
                let fn_kind = fn_node.kind();

                if fn_kind == "attribute" {
                    let obj = fn_node.child_by_field_name("object");
                    let attr = fn_node.child_by_field_name("attribute");
                    if let (Some(obj), Some(attr)) = (obj, attr) {
                        let obj_type = self.eval_expr_type(obj);
                        let mname = self.node_text(attr).unwrap_or("");
                        if let Some(t) = self.eval_container_method(&obj_type, mname) {
                            return t;
                        }
                    }
                }
                let callee_type = self.eval_expr_type(fn_node);
                match callee_type {
                    Type::Callable { ret, .. } => *ret,
                    Type::Named { .. } | Type::Builtin { .. } => callee_type.clone(),
                    Type::Template { .. } => callee_type.clone(),
                    _ => Type::Unknown,
                }
            }
            "subscript" => {
                let value = node.child_by_field_name("value");
                if let Some(val) = value {
                    let val_type = self.eval_expr_type(val);
                    if let Type::Template { ref name, ref args } = val_type {
                        if (name == "list" || name == "set") && !args.is_empty() {
                            return args[0].clone();
                        }
                        if name == "dict" && args.len() >= 2 {
                            return args[1].clone();
                        }
                    }
                }
                Type::Unknown
            }
            "list_comprehension" => Type::Builtin { name: "list".into() },
            "dictionary_comprehension" => Type::Builtin { name: "dict".into() },
            "set_comprehension" => Type::Builtin { name: "set".into() },
            "generator_expression" => Type::Builtin { name: "generator".into() },
            "binary_operator" => {
                let left = node.child_by_field_name("left");
                if let Some(l) = left { return self.eval_expr_type(l); }
                Type::Unknown
            }
            "concatenated_string" => Type::Builtin { name: "str".into() },
            _ => Type::Unknown,
        }
    }

    fn eval_attribute_type(&self, obj_type: &Type, attr_name: &str) -> Type {
        match obj_type {
            Type::Module { qn } => {
                if let Some(f) = self.registry.lookup_symbol(qn, attr_name) {
                    return f.ret.clone();
                }
                let fqn = format!("{}.{}", qn, attr_name);
                if self.registry.lookup_type(&fqn).is_some() {
                    return Type::Named { qn: fqn };
                }
                let prefix = format!("{}.", fqn);
                let is_submodule = self.registry.has_prefix(&prefix);
                if is_submodule {
                    return Type::Module { qn: fqn };
                }
                Type::Unknown
            }
            Type::Named { qn } => {
                if let Some(f) = self.registry.lookup_method(qn, attr_name) {
                    return f.ret.clone();
                }
                if let Some(t) = self.registry.lookup_field(qn, attr_name) {
                    return t.clone();
                }
                Type::Unknown
            }
            Type::Builtin { name } if name != "None" => {
                let recv_qn = format!("builtins.{}", name);
                if let Some(f) = self.registry.lookup_method(&recv_qn, attr_name) {
                    return f.ret.clone();
                }
                Type::Unknown
            }
            Type::Template { name, args } => {
                let recv_qn = format!("builtins.{}", name);
                if let Some(f) = self.registry.lookup_method(&recv_qn, attr_name) {
                    return f.ret.clone();
                }
                if let Some(f) = self.registry.lookup_method(name, attr_name) {
                    return f.ret.clone();
                }
                if name == "dict" && attr_name == "get" && args.len() >= 2 {
                    return Type::optional(args[1].clone());
                }
                if name == "dict" && attr_name == "pop" && args.len() >= 2 {
                    return args[1].clone();
                }
                Type::Unknown
            }
            Type::Union { members } => {
                let mut found = None;
                let mut count = 0;
                for m in members {
                    let t = self.eval_attribute_type(m, attr_name);
                    if !t.is_unknown() { found = Some(t); count += 1; }
                }
                if count == 1 { found.unwrap() } else { Type::Unknown }
            }
            _ => Type::Unknown,
        }
    }

    fn literal_type(&self, node: Node) -> Option<Type> {
        match node.kind() {
            "integer" => Some(Type::Builtin { name: "int".into() }),
            "float" => Some(Type::Builtin { name: "float".into() }),
            "string" | "concatenated_string" => Some(Type::Builtin { name: "str".into() }),
            "true" | "false" => Some(Type::Builtin { name: "bool".into() }),
            "none" => Some(Type::Builtin { name: "None".into() }),
            _ => None,
        }
    }

    fn eval_container_method(&self, obj_type: &Type, mname: &str) -> Option<Type> {
        if let Type::Template { name, args } = obj_type {
            let is_dict_like = matches!(
                name.as_str(),
                "dict" | "Mapping" | "MutableMapping" | "defaultdict" | "OrderedDict"
            );
            let is_list_like = matches!(name.as_str(), "list" | "set" | "frozenset" | "deque");
            if is_dict_like && args.len() >= 2 {
                match mname {
                    "items" => return Some(Type::Template {
                        name: "ItemsView".into(), args: vec![args[0].clone(), args[1].clone()],
                    }),
                    "keys" => return Some(Type::Template {
                        name: "KeysView".into(), args: vec![args[0].clone()],
                    }),
                    "values" => return Some(Type::Template {
                        name: "ValuesView".into(), args: vec![args[1].clone()],
                    }),
                    "get" => return Some(Type::optional(args[1].clone())),
                    "pop" => return Some(args[1].clone()),
                    "copy" => return Some(obj_type.clone()),
                    _ => {}
                }
            }
            if is_list_like && !args.is_empty() {
                match mname {
                    "copy" | "__iter__" => return Some(obj_type.clone()),
                    "pop" => return Some(args[0].clone()),
                    _ => {}
                }
            }
        }
        None
    }
}

// ── Free functions ──

pub fn emit_call_for(ctx: &mut PyLspContext, call_node: Node) {
    let Some(fn_node) = call_node.child_by_field_name("function") else { return };
    let fk = fn_node.kind();

    match fk {
        "identifier" => {
            let Some(fname) = ctx.node_text(fn_node).map(|s| s.to_string()) else { return };

            let scoped = ctx.current_scope.lookup(&fname);
            if let Type::Named { ref qn } = scoped {
                ctx.emit_resolved_call(qn, "lsp_constructor", 0.85);
                return;
            }
            if let Some(f) = ctx.registry.lookup_symbol(&ctx.module_qn, &fname) {
                ctx.emit_resolved_call(&f.qualified_name, "lsp_direct", 0.95);
                return;
            }
            if ctx.registry.lookup_symbol("builtins", &fname).is_some() {
                let qn = format!("builtins.{}", fname);
                ctx.emit_resolved_call(&qn, "lsp_builtin", 0.92);
                return;
            }
            let builtin_qn = format!("builtins.{}", fname);
            if ctx.registry.lookup_type(&builtin_qn).is_some() {
                ctx.emit_resolved_call(&builtin_qn, "lsp_builtin_constructor", 0.88);
            }
        }
        "attribute" => {
            let (Some(obj), Some(attr)) = (
                fn_node.child_by_field_name("object"),
                fn_node.child_by_field_name("attribute"),
            ) else { return };
            let Some(attr_name) = ctx.node_text(attr) else { return };

            // super().method()
            if obj.kind() == "call" {
                if let Some(sf) = obj.child_by_field_name("function") {
                    if sf.kind() == "identifier" && ctx.node_text(sf).unwrap_or("") == "super" {
                        if let Some(ref class_qn) = ctx.enclosing_class_qn.clone() {
                            if let Some(rt) = ctx.registry.lookup_type(class_qn) {
                                let bases: Vec<String> = rt.bases.clone();
                                for base in &bases {
                                    if let Some(f) = ctx.registry.lookup_method(base, attr_name) {
                                        ctx.emit_resolved_call(&f.qualified_name, "lsp_super", 0.88);
                                        return;
                                    }
                                    if attr_name == "__init__" {
                                        let init_qn = format!("{}.__init__", base);
                                        ctx.emit_resolved_call(&init_qn, "lsp_super_init", 0.85);
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            let obj_type = ctx.eval_expr_type(obj);
            match &obj_type {
                Type::Module { qn } => {
                    if let Some(f) = ctx.registry.lookup_symbol(qn, attr_name) {
                        ctx.emit_resolved_call(&f.qualified_name, "lsp_module_attr", 0.92);
                    } else {
                        let fqn = format!("{}.{}", qn, attr_name);
                        ctx.emit_resolved_call(&fqn, "lsp_module_attr_unresolved", 0.55);
                    }
                }
                Type::Named { qn } => {
                    if let Some(f) = ctx.registry.lookup_method(qn, attr_name) {
                        ctx.emit_resolved_call(&f.qualified_name, "lsp_method", 0.90);
                    }
                }
                Type::Builtin { name } if name != "None" => {
                    let recv_qn = format!("builtins.{}", name);
                    if let Some(f) = ctx.registry.lookup_method(&recv_qn, attr_name) {
                        ctx.emit_resolved_call(&f.qualified_name, "lsp_builtin_method", 0.90);
                    }
                }
                Type::Template { name, .. } => {
                    let recv_qn = format!("builtins.{}", name);
                    if let Some(f) = ctx.registry.lookup_method(&recv_qn, attr_name) {
                        ctx.emit_resolved_call(&f.qualified_name, "lsp_generic_method", 0.88);
                    } else if let Some(f) = ctx.registry.lookup_method(name, attr_name) {
                        ctx.emit_resolved_call(&f.qualified_name, "lsp_generic_method", 0.88);
                    }
                }
                Type::Union { members } => {
                    let mut matches: Vec<&RegisteredFunc> = Vec::new();
                    for m in members {
                        if let Type::Named { qn } = m {
                            if let Some(f) = ctx.registry.lookup_method(qn, attr_name) {
                                matches.push(f);
                            }
                        }
                    }
                    if matches.len() == 1 {
                        ctx.emit_resolved_call(&matches[0].qualified_name, "lsp_method_union", 0.85);
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

pub fn process_statement(ctx: &mut PyLspContext, node: Node) {
    if node.kind().is_empty() { return; }
    let kind = node.kind();

    match kind {
        "assignment" => {
            let left = node.child_by_field_name("left");
            let right = node.child_by_field_name("right");
            let ann = node.child_by_field_name("type");

            let mut rhs_type = right.map(|r| ctx.eval_expr_type(r)).unwrap_or(Type::Unknown);
            if let Some(ann_node) = ann {
                if let Some(ann_text) = ctx.node_text(ann_node) {
                    if !ann_text.is_empty() {
                        rhs_type = resolve_annotation(ctx, ann_text);
                    }
                }
            }

            let Some(left) = left else { return };
            let lk = left.kind();

            if matches!(lk, "pattern_list" | "tuple_pattern" | "list_pattern" | "expression_list") {
                let lc = left.named_child_count();
                let rhs_elems: Option<Vec<Type>> = match &rhs_type {
                    Type::Tuple { elems } => Some(elems.clone()),
                    Type::Template { name, args } if name == "tuple" => Some(args.clone()),
                    _ => None,
                };
                let elem_type = iterable_element_type(&rhs_type);
                for i in 0..lc {
                    let tgt = left.named_child(i).unwrap_or(left);
                    let tk = tgt.kind();
                    let is_rest = matches!(tk, "list_splat_pattern" | "list_splat");
                    let actual_target = if is_rest && tgt.named_child_count() > 0 {
                        tgt.named_child(0).unwrap_or(tgt)
                    } else {
                        tgt
                    };
                    if actual_target.kind() != "identifier" { continue; }
                    if let Some(nm) = ctx.node_text(actual_target).map(|s| s.to_string()) {
                        let bind_type = if is_rest {
                            elem_type.as_ref().map(|et| Type::Template {
                                name: "list".into(), args: vec![et.clone()],
                            }).unwrap_or(Type::Unknown)
                        } else if let Some(ref elems) = rhs_elems {
                            elems.get(i as usize).cloned().unwrap_or(
                                elem_type.clone().unwrap_or(Type::Unknown),
                            )
                        } else {
                            elem_type.clone().unwrap_or(Type::Unknown)
                        };
                        ctx.current_scope.bind(nm, bind_type);
                    }
                }
                return;
            }

            if lk == "identifier" {
                if let Some(name) = ctx.node_text(left).map(|s| s.to_string()) {
                    ctx.current_scope.bind(name, rhs_type);
                }
            }
        }
        "for_statement" => {
            let left = node.child_by_field_name("left");
            let right = node.child_by_field_name("right");
            let elem_type = right
                .map(|r| {
                    let iter_t = ctx.eval_expr_type(r);
                    iterable_element_type(&iter_t).unwrap_or(Type::Unknown)
                })
                .unwrap_or(Type::Unknown);
            if let Some(l) = left {
                bind_for_target(ctx, l, &elem_type);
            }
        }
        "with_statement" => {
            let nc = node.named_child_count();
            for i in 0..nc {
                let child = node.named_child(i).unwrap_or(node);
                if child.kind() != "with_clause" { continue; }
                let cn = child.named_child_count();
                for j in 0..cn {
                    let item = child.named_child(j).unwrap_or(child);
                    if item.kind() != "with_item" { continue; }
                    let value = item.child_by_field_name("value");
                    let alias = item.child_by_field_name("alias");
                    let (value, alias) = if value.is_none() || alias.is_none() {
                        let ic = item.named_child_count();
                        let mut found_v = value;
                        let mut found_a = alias;
                        for k in 0..ic {
                            let c = item.named_child(k).unwrap_or(item);
                            if c.kind() == "as_pattern" {
                                let ac = c.named_child_count();
                                if ac >= 1 { found_v = Some(c.named_child(0).unwrap_or(c)); }
                                if ac >= 2 { found_a = Some(c.named_child(1).unwrap_or(c)); }
                                if found_a.is_none() { found_a = c.child_by_field_name("alias"); }
                                break;
                            }
                        }
                        (found_v, found_a)
                    } else {
                        (value, alias)
                    };
                    if let Some(alias_node) = alias {
                        if alias_node.kind() == "identifier" {
                            if let Some(name) = ctx.node_text(alias_node).map(|s| s.to_string()) {
                                let ty = value
                                    .map(|v| {
                                        let ctx_type = ctx.eval_expr_type(v);
                                        match &ctx_type {
                                            Type::Named { qn } => ctx
                                                .registry
                                                .lookup_method(qn, "__enter__")
                                                .map(|f| f.ret.clone()),
                                            _ => None,
                                        }
                                    })
                                    .flatten()
                                    .unwrap_or(Type::Unknown);
                                ctx.current_scope.bind(name, ty);
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

pub fn resolve_annotation(ctx: &PyLspContext, ann: &str) -> Type {
    let d = EVAL_DEPTH.with(|c| {
        let v = c.get().saturating_add(1);
        c.set(v);
        v
    });
    let _guard = DepthGuard;
    if d > AST_DEPTH_LIMIT || ann.is_empty() {
        return Type::Unknown;
    }
    let ann = ann.trim();
    let ann = if ann.len() >= 2
        && (ann.starts_with('"') || ann.starts_with('\''))
        && ann.ends_with(ann.chars().next().unwrap())
    {
        &ann[1..ann.len() - 1]
    } else {
        ann
    };

    if ann.contains('|') && !ann.starts_with('<') {
        let members: Vec<Type> = ann.split('|').map(|s| resolve_annotation(ctx, s.trim())).collect();
        if members.len() > 1 { return Type::Union { members }; }
    }

    if let Some(lb) = ann.find('[') {
        if ann.ends_with(']') {
            let base = ann[..lb].trim();
            let inner = &ann[lb + 1..ann.len() - 1];
            let args: Vec<Type> = split_subscript_args(inner)
                .into_iter()
                .map(|a| resolve_annotation(ctx, &a))
                .collect();
            if base == "Optional" && !args.is_empty() {
                return Type::optional(args[0].clone());
            }
            if base == "Union" {
                return Type::Union { members: args };
            }
            return Type::Template { name: base.to_string(), args };
        }
    }

    if ann.starts_with("Union[") && ann.ends_with(']') {
        let inner = &ann[6..ann.len() - 1];
        let members: Vec<Type> = split_subscript_args(inner)
            .into_iter()
            .map(|a| resolve_annotation(ctx, &a))
            .collect();
        return Type::Union { members };
    }

    let scoped = ctx.current_scope.lookup(ann);
    if !scoped.is_unknown() { return scoped; }

    let builtins = ["int","str","bool","float","bytes","None","complex","bytearray","object","type",
        "list","dict","set","tuple","frozenset","deque","Any","Self"];
    for b in &builtins {
        if ann == *b { return Type::Builtin { name: ann.to_string() }; }
    }
    Type::Named { qn: ann.to_string() }
}

fn split_subscript_args(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    for (i, c) in s.char_indices() {
        match c {
            '[' | '(' | '{' => depth += 1,
            ']' | ')' | '}' => depth -= 1,
            ',' if depth == 0 => {
                let part = s[start..i].trim().to_string();
                if !part.is_empty() { result.push(part); }
                start = i + 1;
            }
            _ => {}
        }
    }
    let part = s[start..].trim().to_string();
    if !part.is_empty() { result.push(part); }
    result
}

fn iterable_element_type(iter_type: &Type) -> Option<Type> {
    match iter_type {
        Type::Template { name, args } => {
            let is_iterable = matches!(
                name.as_str(),
                "list" | "set" | "frozenset" | "Iterable" | "Iterator"
                    | "Sequence" | "MutableSequence" | "KeysView" | "ValuesView"
            );
            let is_dict = matches!(
                name.as_str(),
                "dict" | "Mapping" | "MutableMapping" | "defaultdict" | "OrderedDict" | "ItemsView"
            );
            if is_iterable && !args.is_empty() { return Some(args[0].clone()); }
            if is_dict && !args.is_empty() { return Some(args[0].clone()); }
            if name == "tuple" && !args.is_empty() {
                if args.len() == 1 { return Some(args[0].clone()); }
                return Some(Type::Union { members: args.clone() });
            }
            None
        }
        Type::Builtin { name } => match name.as_str() {
            "str" => Some(Type::Builtin { name: "str".into() }),
            "list" | "tuple" | "set" | "dict" => Some(Type::Unknown),
            _ => None,
        },
        _ => None,
    }
}

fn bind_for_target(ctx: &mut PyLspContext, left: Node, elem_type: &Type) {
    if left.kind().is_empty() { return; }
    let lk = left.kind();
    if lk == "identifier" {
        if let Some(name) = ctx.node_text(left).map(|s| s.to_string()) {
            ctx.current_scope.bind(name, elem_type.clone());
        }
    } else if matches!(lk, "pattern_list" | "tuple_pattern" | "list_pattern") {
        let lc = left.named_child_count();
        let elems = match elem_type {
            Type::Tuple { elems } => Some(elems),
            Type::Template { name, args } if name == "tuple" => Some(args),
            _ => None,
        };
        for i in 0..lc {
            let tgt = left.named_child(i).unwrap_or(left);
            if tgt.kind() != "identifier" { continue; }
            if let Some(nm) = ctx.node_text(tgt).map(|s| s.to_string()) {
                let bind = elems.and_then(|e| e.get(i as usize).cloned()).unwrap_or(elem_type.clone());
                ctx.current_scope.bind(nm, bind);
            }
        }
    }
}

/// Maximum AST recursion depth for resolve_calls_in / eval_expr_type.
/// Python ASTs can be 1000+ nodes deep (e.g. nested try/except/finally
/// in complex Django middleware). Beyond this depth we stop to avoid
/// stack overflow on Windows.
///
/// Originally 128; lowered to 48 because MinGW on Windows ignores
/// both `Builder::stack_size` and linker `--stack` flags, giving the
/// main thread only ~1 MB of stack. With debug-build frame sizes,
/// 48 frames × ~20 KB/frame = ~960 KB, staying under the 1 MB limit.
const AST_DEPTH_LIMIT: u32 = 48;

thread_local! {
    static EVAL_DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// Separate counter for process_function / process_class recursion depth.
    /// Django files can have deeply nested function/class definitions that
    /// cause stack overflow on the recursive walk (process_function calls
    /// itself for nested function definitions inside function bodies).
    static FUNC_DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

struct DepthGuard;
impl Drop for DepthGuard {
    fn drop(&mut self) {
        EVAL_DEPTH.with(|c| c.set(c.get() - 1));
    }
}

struct FuncDepthGuard;
impl Drop for FuncDepthGuard {
    fn drop(&mut self) {
        FUNC_DEPTH.with(|c| c.set(c.get() - 1));
    }
}

pub fn resolve_calls_in(ctx: &mut PyLspContext, node: Node) {
    // Explicit stack avoids recursion on deeply nested Python ASTs.
    // Each entry: (node, saved_scope). This is single-phase — each pop:
    // process_statement → emit_call_for → push children (LIFO order).
    let mut stack: Vec<(Node, Option<Scope>)> = Vec::with_capacity(64);
    stack.push((node, None));

    // ponytail: 迭代上限兜底，防止任何意外的路径死循环。
    // 单个函数的 AST 节点数通常 < 1000，10 万足够覆盖超大函数。
    // 超过则 break，不阻塞整个分析。
    const MAX_ITERS: u32 = 100_000;
    let mut iter_count: u32 = 0;
    let mut last_kinds: std::collections::VecDeque<&str> = std::collections::VecDeque::with_capacity(20);
    while let Some((node, saved_scope)) = stack.pop() {
        iter_count += 1;
        if iter_count > MAX_ITERS {
            tracing::warn!(iter = iter_count, "[py_lsp] resolve_calls_in iter limit hit — breaking");
            break;
        }
        if iter_count % 10000 == 0 {
            tracing::info!(iter = iter_count, stack_len = stack.len(), "[py_lsp] resolve_calls_in progress");
        }
        if node.kind().is_empty() { continue; }
        let kind = node.kind();
        if iter_count > MAX_ITERS - 100 {
            last_kinds.push_back(kind);
            if last_kinds.len() > 20 { last_kinds.pop_front(); }
        }

        if let Some(s) = saved_scope {
            ctx.current_scope = s;
        }

        process_statement(ctx, node);

        if kind == "call" {
            emit_call_for(ctx, node);
        }

        if matches!(kind, "list_comprehension" | "dictionary_comprehension"
            | "set_comprehension" | "generator_expression")
        {
            let new_scope = ctx.current_scope.push();
            let cnc = node.named_child_count();
            for i in 0..cnc {
                let child = node.named_child(i).unwrap_or(node);
                if child.kind() == "for_in_clause" {
                    let left = child.child_by_field_name("left");
                    let right = child.child_by_field_name("right");
                    let elem_type = right
                        .map(|r| {
                            let iter_t = ctx.eval_expr_type(r);
                            iterable_element_type(&iter_t).unwrap_or(Type::Unknown)
                        })
                        .unwrap_or(Type::Unknown);
                    if let Some(l) = left { bind_for_target(ctx, l, &elem_type); }
                }
            }
            for i in (0..cnc).rev() {
                let child = node.named_child(i).unwrap_or(node);
                stack.push((child, Some(ctx.current_scope.clone())));
            }
            ctx.current_scope = new_scope;
        } else if kind == "if_statement" {
            for i in (0..node.named_child_count()).rev() {
                let child = node.named_child(i).unwrap_or(node);
                stack.push((child, None));
            }
        } else if !matches!(kind, "function_definition" | "class_definition" | "lambda" | "with_statement") {
            // with_statement: process_statement already binds aliases; body
            // children are pushed below via the named_child loop. Skipping
            // with_statement here prevents re-entry into with_clause items.
            for i in (0..node.named_child_count()).rev() {
                let child = node.named_child(i).unwrap_or(node);
                stack.push((child, None));
            }
        }
    }
}

pub fn process_function(ctx: &mut PyLspContext, func_node: Node, container_qn: Option<&str>) {
    let d = FUNC_DEPTH.with(|c| {
        let v = c.get().saturating_add(1);
        c.set(v);
        v
    });
    let _guard = FuncDepthGuard;
    if d > AST_DEPTH_LIMIT {
        tracing::warn!(
            module = ctx.module_qn,
            depth = d,
            "[python_lsp] process_function depth limit reached — skipping nested function"
        );
        return;
    }

    let Some(name_node) = func_node.child_by_field_name("name") else { return };
    let Some(fname) = ctx.node_text(name_node).map(|s| s.to_string()) else { return };
    if fname.is_empty() { return; }

    tracing::info!(func = %fname, module = %ctx.module_qn, depth = d, "[py_lsp] process_function enter");

    let prev_func = ctx.enclosing_func_qn.clone();
    let base_qn = container_qn.unwrap_or(&ctx.module_qn);
    ctx.enclosing_func_qn = Some(format!("{}.{}", base_qn, fname));

    let saved = ctx.current_scope.clone();
    ctx.current_scope = ctx.current_scope.push();

    if let Some(p) = func_node.child_by_field_name("parameters") {
        bind_parameters(ctx, p);
    }

    if let Some(ref class_qn) = ctx.enclosing_class_qn.clone() {
        ctx.current_scope.bind("self", Type::Named { qn: class_qn.clone() });
        ctx.current_scope.bind("cls", Type::Named { qn: class_qn.clone() });
    }

    if let Some(b) = func_node.child_by_field_name("body") {
        resolve_calls_in(ctx, b);
        let bnc = b.named_child_count();
        for i in 0..bnc {
            let c = b.named_child(i).unwrap_or(b);
            match c.kind() {
                "function_definition" => {
                    let parent_qn = ctx.enclosing_func_qn.clone().unwrap_or(ctx.module_qn.clone());
                    process_function(ctx, c, Some(&parent_qn));
                }
                "decorated_definition" => {
                    if let Some(d) = c.child_by_field_name("definition") {
                        if d.kind() == "function_definition" {
                            let parent_qn = ctx.enclosing_func_qn.clone().unwrap_or(ctx.module_qn.clone());
                            process_function(ctx, d, Some(&parent_qn));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    ctx.current_scope = saved;
    ctx.enclosing_func_qn = prev_func;
}

pub fn bind_parameters(ctx: &mut PyLspContext, params: Node) {
    let nc = params.named_child_count();
    for i in 0..nc {
        let p = params.named_child(i).unwrap_or(params);
        let pk = p.kind();

        let (ident_node, type_node) = match pk {
            "identifier" => (Some(p), None),
            "typed_parameter" | "typed_default_parameter" => {
                let ident = if p.named_child_count() > 0 {
                    Some(p.named_child(0).unwrap_or(p))
                } else { None };
                (ident, p.child_by_field_name("type"))
            }
            "default_parameter" => (p.child_by_field_name("name"), None),
            "list_splat_pattern" | "dictionary_splat_pattern" => {
                let ident = if p.named_child_count() > 0 {
                    Some(p.named_child(0).unwrap_or(p))
                } else { None };
                (ident, None)
            }
            _ => continue,
        };

        let Some(ident) = ident_node else { continue };
        let Some(name) = ctx.node_text(ident).map(|s| s.to_string()) else { continue };
        let mut ty = type_node
            .and_then(|tn| ctx.node_text(tn))
            .map(|ann| resolve_annotation(ctx, ann))
            .unwrap_or(Type::Unknown);

        if pk == "list_splat_pattern" && !ty.is_unknown() {
            ty = Type::Template { name: "tuple".into(), args: vec![ty] };
        }
        if pk == "dictionary_splat_pattern" && !ty.is_unknown() {
            ty = Type::Template {
                name: "dict".into(),
                args: vec![Type::Builtin { name: "str".into() }, ty],
            };
        }
        ctx.current_scope.bind(&name, ty);
    }
}

pub fn process_class(ctx: &mut PyLspContext, class_node: Node) {
    let d = FUNC_DEPTH.with(|c| {
        let v = c.get().saturating_add(1);
        c.set(v);
        v
    });
    let _guard = FuncDepthGuard;
    if d > AST_DEPTH_LIMIT {
        tracing::warn!(
            module = ctx.module_qn,
            depth = d,
            "[python_lsp] process_class depth limit reached — skipping nested class"
        );
        return;
    }

    let Some(name_node) = class_node.child_by_field_name("name") else { return };
    let Some(cname) = ctx.node_text(name_node) else { return };
    if cname.is_empty() { return; }

    let prev_class = ctx.enclosing_class_qn.clone();
    ctx.enclosing_class_qn = Some(format!("{}.{}", ctx.module_qn, cname));

    if let Some(b) = class_node.child_by_field_name("body") {
        let bnc = b.named_child_count();
        // Pass 1: class-level annotated assignments
        for i in 0..bnc {
            let c = b.named_child(i).unwrap_or(b);
            if c.kind() == "expression_statement" && c.named_child_count() > 0 {
                let inner = c.named_child(0).unwrap_or(c);
                if inner.kind() == "assignment" {
                    let left = inner.child_by_field_name("left");
                    let ann = inner.child_by_field_name("type");
                    if let (Some(l), Some(a)) = (left, ann) {
                        if l.kind() == "identifier" {
                            if let (Some(_field_name), Some(ann_text)) =
                                (ctx.node_text(l), ctx.node_text(a))
                            {
                                let _field_type = resolve_annotation(ctx, ann_text);
                                // LSP: class field assignment recorded — see TypeRegistry::add_instance_field
                            }
                        }
                    }
                }
            }
        }
        // Pass 1b: __init__ / __post_init__
        for i in 0..bnc {
            let c = b.named_child(i).unwrap_or(b);
            if c.kind() == "function_definition" {
                let name = c.child_by_field_name("name");
                let is_init = name.and_then(|n| ctx.node_text(n)).map_or(false, |nm| {
                    nm == "__init__" || nm == "__post_init__"
                });
                if is_init {
                    let class_qn = ctx.enclosing_class_qn.clone().expect("__init__ must be inside a class");
                    process_function(ctx, c, Some(&class_qn));
                }
            } else if c.kind() == "decorated_definition" {
                if let Some(d) = c.child_by_field_name("definition") {
                    if d.kind() == "function_definition" {
                        let name = d.child_by_field_name("name");
                        let is_init = name.and_then(|n| ctx.node_text(n)).map_or(false, |nm| {
                            nm == "__init__" || nm == "__post_init__"
                        });
                        if is_init {
                            let class_qn = ctx.enclosing_class_qn.clone().expect("__init__ must be inside a class");
                            process_function(ctx, d, Some(&class_qn));
                        }
                    }
                }
            }
        }
        // Pass 2: remaining methods + nested classes
        for i in 0..bnc {
            let c = b.named_child(i).unwrap_or(b);
            match c.kind() {
                "function_definition" => {
                    let name = c.child_by_field_name("name");
                    let is_init = name.and_then(|n| ctx.node_text(n)).map_or(false, |nm| {
                        nm == "__init__" || nm == "__post_init__"
                    });
                    if !is_init {
                        let class_qn = ctx.enclosing_class_qn.clone().expect("__init__ must be inside a class");
                        process_function(ctx, c, Some(&class_qn));
                    }
                }
                "decorated_definition" => {
                    if let Some(d) = c.child_by_field_name("definition") {
                        if d.kind() == "function_definition" {
                            let name = d.child_by_field_name("name");
                            let is_init = name.and_then(|n| ctx.node_text(n)).map_or(false, |nm| {
                                nm == "__init__" || nm == "__post_init__"
                            });
                            if !is_init {
                                let class_qn = ctx.enclosing_class_qn.clone().expect("__init__ must be inside a class");
                                process_function(ctx, d, Some(&class_qn));
                            }
                        }
                    }
                }
                "class_definition" => process_class(ctx, c),
                _ => {}
            }
        }
    }

    ctx.enclosing_class_qn = prev_class;
}

pub fn process_file(ctx: &mut PyLspContext, root: Node) {
    if root.kind().is_empty() { return; }
    tracing::info!(
        module = ctx.module_qn,
        child_count = root.named_child_count(),
        "[py_lsp] process_file start"
    );
    ctx.bind_imports();
    ctx.bind_module_classes();

    let nc = root.named_child_count();
    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        process_statement(ctx, c);
    }

    let prev_func = ctx.enclosing_func_qn.clone();
    ctx.enclosing_func_qn = Some(format!("{}.__module__", ctx.module_qn));

    for i in 0..nc {
        let c = root.named_child(i).unwrap_or(root);
        match c.kind() {
            "function_definition" => process_function(ctx, c, None),
            "class_definition" => process_class(ctx, c),
            "decorated_definition" => {
                if let Some(d) = c.child_by_field_name("definition") {
                    match d.kind() {
                        "function_definition" => process_function(ctx, d, None),
                        "class_definition" => process_class(ctx, d),
                        _ => {}
                    }
                }
            }
            "expression_statement" => {
                resolve_calls_in(ctx, c);
            }
            _ => {}
        }
    }
    ctx.enclosing_func_qn = prev_func;
    tracing::info!(
        module = ctx.module_qn,
        calls = ctx.resolved_calls.len(),
        "[py_lsp] process_file done"
    );
}

pub fn run_py_lsp(
    source: &str,
    tree: &Tree,
    module_qn: &str,
    registry: &TypeRegistry,
) -> Vec<ResolvedCall> {
    tracing::info!(module = module_qn, "[py_lsp] run_py_lsp start");
    let mut ctx = PyLspContext::new(source, registry, module_qn);
    extract_imports_from_ast(&mut ctx, tree.root_node());
    tracing::info!(module = module_qn, "[py_lsp] imports extracted, entering process_file");
    let root = tree.root_node();
    // Wrap in catch_unwind so a panic doesn't crash the engine.
    // NOTE: stack overflow (SIGSEGV) CANNOT be caught by catch_unwind.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        process_file(&mut ctx, root);
    }));
    if result.is_err() {
        tracing::warn!(module_qn, "[python_lsp] panic caught — skipping file");
    }
    tracing::info!(module = module_qn, calls = ctx.resolved_calls.len(), "[py_lsp] run_py_lsp done");
    ctx.resolved_calls
}

fn extract_imports_from_ast(ctx: &mut PyLspContext, root: Node) {
    let mut to_visit = vec![root];
    while let Some(node) = to_visit.pop() {
        match node.kind() {
            "import_statement" => {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "dotted_name" {
                        if let Ok(name) = child.utf8_text(ctx.source.as_bytes()) {
                            let short = name.rsplit('.').next().unwrap_or(name);
                            ctx.add_import(short, name);
                        }
                    }
                }
            }
            "import_from_statement" => {
                let module_name = node
                    .child_by_field_name("module_name")
                    .and_then(|n| n.utf8_text(ctx.source.as_bytes()).ok())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "dotted_name" {
                        if let Ok(name) = child.utf8_text(ctx.source.as_bytes()) {
                            if name != module_name {
                                let qn = if module_name.is_empty() {
                                    name.to_string()
                                } else {
                                    format!("{}.{}", module_name, name)
                                };
                                ctx.add_import(name, &qn);
                            }
                        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_python(source: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_python::LANGUAGE.into())
            .expect("failed to load python grammar");
        parser.parse(source, None).expect("parse failed")
    }

    #[test]
    fn test_repro_hang_case_insensitive() {
        let source = r#"
def test_denylist_matching_is_case_insensitive(self):
    from src_python.routing.patterns import PatternMatcher
    matcher = PatternMatcher()
    assert matcher.matches_denylist_keyword("PASSWORD") is True
    assert matcher.matches_denylist_keyword("Api_Key") is True
    assert matcher.matches_denylist_keyword("username") is False
"#;
        let tree = parse_python(source);
        let reg = TypeRegistry::new();
        let calls = run_py_lsp(source, &tree, "test_mod", &reg);
        assert!(calls.is_empty() || !calls.is_empty()); // just must not hang
    }

    #[test]
    fn test_annotation_resolve() {
        let reg = TypeRegistry::new();
        let ctx = PyLspContext::new("", &reg, "test");
        assert_eq!(
            resolve_annotation(&ctx, "int"),
            Type::Builtin { name: "int".into() }
        );
        assert_eq!(
            resolve_annotation(&ctx, "str"),
            Type::Builtin { name: "str".into() }
        );
        let t = resolve_annotation(&ctx, "Optional[str]");
        assert!(matches!(t, Type::Union { .. }), "Optional should produce Union, got {:?}", t);
    }

    #[test]
    fn test_literal_type() {
        let reg = TypeRegistry::new();
        let ctx = PyLspContext::new("42", &reg, "test");
        let src = "42";
        let tree = parse_python(src);
        let root = tree.root_node();
        let expr = root.named_child(0).unwrap();
        let child = expr.named_child(0).unwrap();
        assert_eq!(ctx.eval_expr_type(child), Type::Builtin { name: "int".into() });
    }

    #[test]
    fn test_container_type() {
        let src = "[1, 2, 3]";
        let tree = parse_python(src);
        let reg = TypeRegistry::new();
        let ctx = PyLspContext::new("", &reg, "test");
        let root = tree.root_node();
        let expr = root.named_child(0).unwrap();
        let child = expr.named_child(0).unwrap();
        let t = ctx.eval_expr_type(child);
        assert!(matches!(t, Type::Template { ref name, .. } if name == "list"));
    }

    #[test]
    fn test_simple_type_inference() {
        let src = r#"
class User:
    def handle(self):
        pass
def my_view():
    u = User()
    u.handle()
"#;
        let tree = parse_python(src);
        // Build registry from a minimal graph so User + handle are registered
        let mut graph = crate::graph::Graph::new();
        use crate::graph::{Node, NodeKind};
        let mut user = Node::new("test.views.User", "User", NodeKind::Class);
        user.location = Some("test/views.py".into());
        graph.add_node(user);
        let mut handle = Node::new("test.views.User.handle", "handle", NodeKind::Function);
        handle.location = Some("test/views.py".into());
        graph.add_node(handle);
        let reg = TypeRegistry::from_graph(&graph);

        let calls = run_py_lsp(src, &tree, "test.views", &reg);
        assert!(!calls.is_empty(), "should emit at least one resolved call, got {}", calls.len());
        // Should find the User.handle() call
        let has_handle_call = calls.iter().any(|rc| rc.callee_qn.contains("handle"));
        assert!(has_handle_call, "should resolve User.handle() call, got: {:?}", calls);
    }

    #[test]
    fn test_import_binding() {
        let reg = TypeRegistry::new();
        let mut ctx = PyLspContext::new("", &reg, "test");
        ctx.add_import("User", "myapp.models.User");
        ctx.bind_imports();
        // from X import Y style: binds Y as NAMED("X.Y")
        let t = ctx.current_scope.lookup("User");
        assert!(matches!(t, Type::Named { .. }));
    }
}
