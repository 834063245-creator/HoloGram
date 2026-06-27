// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Cross-file type registry — maps qualified names to type/function definitions.
//! Mirrors `type_registry.h`. Built once from graph nodes before per-file LSP pass.

use std::collections::{BTreeSet, HashMap};

use crate::graph::{Graph, NodeKind};

use super::types::Type;

/// Decorator flags for Python functions/methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FuncFlag {
    None = 0,
    Property = 1 << 0,
    ClassMethod = 1 << 1,
    StaticMethod = 1 << 2,
    AbstractMethod = 1 << 3,
    Overload = 1 << 4,
    Async = 1 << 5,
    Generator = 1 << 6,
    Final = 1 << 7,
}

/// A registered function/method with full type signature.
#[derive(Debug, Clone)]
pub struct RegisteredFunc {
    /// Fully qualified: "myapp.models.User.handle"
    pub qualified_name: String,
    /// Receiver type QN: "myapp.models.User" (None for free functions)
    pub receiver_type: Option<String>,
    /// Short name: "handle"
    pub short_name: String,
    /// Parameter types (first = self/cls for methods)
    pub params: Vec<(String, Type)>,
    /// Return type
    pub ret: Type,
    /// Decorator flags (Python)
    pub flags: u32,
}

/// A registered type (class, interface, protocol).
#[derive(Debug, Clone)]
pub struct RegisteredType {
    /// Fully qualified: "myapp.models.User"
    pub qualified_name: String,
    /// Short name: "User"
    pub short_name: String,
    /// Method short names → qualified names
    pub methods: HashMap<String, String>,
    /// Field names → types
    pub fields: HashMap<String, Type>,
    /// Base class QNs (for MRO / method inheritance)
    pub bases: Vec<String>,
    /// Is this an interface/protocol?
    pub is_interface: bool,
    /// Alias target QN (for `type Foo = Bar`)
    pub alias_of: Option<String>,
}

/// Cross-file type/function registry.
/// Built from graph nodes once per analysis, then used read-only per file.
#[derive(Debug, Clone)]
pub struct TypeRegistry {
    /// Functions by qualified name
    pub funcs_by_qn: HashMap<String, RegisteredFunc>,
    /// Types by qualified name
    pub types_by_qn: HashMap<String, RegisteredType>,
    /// Methods indexed by (receiver_qn, method_name) → func_qn
    pub methods_index: HashMap<(String, String), String>,
    /// Sorted union of all func/type QNs — O(log N) prefix probing
    /// (replaces O(N) `.keys().any(starts_with)` in eval_attribute_type).
    pub qn_index: BTreeSet<String>,
    /// Fallback registry for two-level lookup (stdlib, etc.)
    pub fallback: Option<Box<TypeRegistry>>,
}

impl TypeRegistry {
    /// Create a registry with builtin types pre-registered.
    pub fn new() -> Self {
        let mut reg = Self {
            funcs_by_qn: HashMap::new(),
            types_by_qn: HashMap::new(),
            methods_index: HashMap::new(),
            qn_index: BTreeSet::new(),
            fallback: None,
        };
        reg.register_builtins();
        reg
    }

    /// Build a TypeRegistry from graph nodes.
    /// Scans all Class and Function nodes, builds method index.
    pub fn from_graph(graph: &Graph) -> Self {
        let mut reg = Self::new();

        // Register builtin stdlib first (our hand-coded typeshed equivalents)
        reg.register_builtins();

        // Pass 1: register all classes/types
        for (node_id, node) in &graph.nodes {
            if node.kind == NodeKind::Class {
                let qn = node_id.clone();
                let short = node.name.clone();
                let rt = RegisteredType {
                    qualified_name: qn,
                    short_name: short,
                    methods: HashMap::new(),
                    fields: HashMap::new(),
                    bases: Vec::new(),
                    is_interface: false,
                    alias_of: None,
                };
                // Bases are extracted from Inherits edges during analysis.
                // We'll populate them in pass 2 after edges are processed.
                reg.types_by_qn.insert(node_id.clone(), rt);
            }
        }

        // Collect inheritance edges to populate bases
        for edge in graph.edges.values() {
            if edge.kind == crate::graph::EdgeKind::Inherits {
                // Skip self-inheritance (class A(A): …) — would cause infinite lookup loops
                if edge.source == edge.target {
                    continue;
                }
                if let Some(rt) = reg.types_by_qn.get_mut(&edge.source) {
                    // Dedup: same base added only once
                    if !rt.bases.contains(&edge.target) {
                        rt.bases.push(edge.target.clone());
                    }
                }
            }
        }

        // Pass 2: register all functions/methods
        for (node_id, node) in &graph.nodes {
            if node.kind == NodeKind::Function {
                let qn = node_id.clone();
                let short = node.name.clone();

                // Determine receiver: looking at the QN, e.g.
                // "myapp.models.User.handle" → fn "handle", receiver "myapp.models.User"
                let (receiver_type, short_name) = Self::parse_method_qn(&qn, &short);

                let rf = RegisteredFunc {
                    qualified_name: qn.clone(),
                    receiver_type: receiver_type.clone(),
                    short_name: short_name.clone(),
                    params: Vec::new(),
                    ret: Type::Unknown,
                    flags: 0,
                };

                // If it's a method, register in the method index
                if let Some(ref recv_qn) = rf.receiver_type {
                    reg.methods_index.insert(
                        (recv_qn.clone(), short_name.clone()),
                        qn.clone(),
                    );
                    // Also register this method short_name in the type's method map
                    if let Some(rt) = reg.types_by_qn.get_mut(recv_qn) {
                        rt.methods.insert(short_name.clone(), qn.clone());
                    }
                }

                reg.funcs_by_qn.insert(qn, rf);
            }
        }

        // Build sorted prefix index once — O(N log N) here, O(log N) per probe later.
        reg.qn_index = reg
            .funcs_by_qn
            .keys()
            .chain(reg.types_by_qn.keys())
            .cloned()
            .collect();

        reg
    }

    /// Parse "myapp.models.User.handle" → (receiver="myapp.models.User", name="handle")
    fn parse_method_qn(full_qn: &str, short: &str) -> (Option<String>, String) {
        // If the QN is "module.Class.method", the receiver is everything before the last dot
        if let Some(last_dot) = full_qn.rfind('.') {
            let prefix = &full_qn[..last_dot];
            // Check if the prefix looks like it ends with a class (starts with uppercase)
            // Heuristic: if prefix has at least one dot and ends with uppercase, it's a method
            if prefix.contains('.') {
                let class_part = prefix.rsplit('.').next().unwrap_or("");
                if class_part.chars().next().map_or(false, |c| c.is_uppercase()) {
                    return (Some(prefix.to_string()), short.to_string());
                }
            }
        }
        (None, short.to_string())
    }

    /// Register Python builtin stdlib types.
    /// Hand-coded minimal typeshed covering the most common container operations.
    fn register_builtins(&mut self) {
        self.register_builtin_type("int", &[], &[]);
        self.register_builtin_type("str", &["capitalize","lower","upper","strip","split","join","replace","startswith","endswith","find","format","encode","isnumeric","isalpha","isdigit","__iter__","__add__","__getitem__"], &[]);
        self.register_builtin_type("float", &[], &[]);
        self.register_builtin_type("bool", &[], &[]);
        self.register_builtin_type("bytes", &[], &[]);
        self.register_builtin_type("list", &["append","extend","insert","remove","pop","clear","index","count","sort","reverse","copy","__iter__","__getitem__","__len__"], &[]);
        self.register_builtin_type("dict", &["get","keys","values","items","pop","update","clear","copy","setdefault","__getitem__","__iter__","__len__","__contains__"], &[]);
        self.register_builtin_type("set", &["add","remove","discard","pop","clear","union","intersection","difference","copy","__iter__","__len__","__contains__"], &[]);
        self.register_builtin_type("tuple", &["__iter__","__getitem__","__len__","count","index"], &[]);
        self.register_builtin_type("None", &[], &[]);
        self.register_builtin_type("object", &["__init__","__str__","__repr__","__eq__","__hash__","__class__"], &[]);
        self.register_builtin_type("type", &[], &[]);

        // --- builtin free functions ---
        let builtin_funcs = [
            "len","range","print","isinstance","issubclass","iter","next",
            "enumerate","zip","map","filter","sorted","reversed","type",
            "int","str","float","bool","list","dict","set","tuple",
            "open","hasattr","getattr","setattr","delattr","id","abs",
            "min","max","sum","any","all","super","repr","format",
            "input","eval","exec","compile","staticmethod","classmethod",
            "property","object",
        ];
        for &fname in &builtin_funcs {
            let qn = format!("builtins.{}", fname);
            let rf = RegisteredFunc {
                qualified_name: qn.clone(),
                receiver_type: None,
                short_name: fname.to_string(),
                params: Vec::new(),
                ret: Type::Unknown,
                flags: 0,
            };
            self.funcs_by_qn.insert(qn, rf);
        }
    }

    /// Register a single builtin type with its methods.
    fn register_builtin_type(&mut self, name: &str, methods: &[&str], _bases: &[&str]) {
        let qn = format!("builtins.{}", name);
        let mut rt = RegisteredType {
            qualified_name: qn.clone(),
            short_name: name.to_string(),
            methods: HashMap::new(),
            fields: HashMap::new(),
            bases: Vec::new(),
            is_interface: false,
            alias_of: None,
        };
        for &method_name in methods {
            let method_qn = format!("builtins.{}.{}", name, method_name);
            rt.methods.insert(method_name.to_string(), method_qn.clone());
            let rf = RegisteredFunc {
                qualified_name: method_qn.clone(),
                receiver_type: Some(qn.clone()),
                short_name: method_name.to_string(),
                params: Vec::new(),
                ret: Type::Unknown,
                flags: 0,
            };
            self.funcs_by_qn.insert(method_qn.clone(), rf);
            self.methods_index.insert((qn.clone(), method_name.to_string()), method_qn);
        }
        self.types_by_qn.insert(qn, rt);
    }

    // ── Lookup operations ──

    /// Does any registered QN start with `prefix`? O(log N) via sorted index.
    /// Replaces `funcs_by_qn.keys().any(|k| k.starts_with(prefix))` hot path.
    pub fn has_prefix(&self, prefix: &str) -> bool {
        use std::ops::Bound;
        self.qn_index
            .range((Bound::Included(prefix.to_string()), Bound::Unbounded))
            .next()
            .map_or(false, |k| k.starts_with(prefix))
    }

    /// Look up a function by qualified name.
    pub fn lookup_func(&self, qn: &str) -> Option<&RegisteredFunc> {
        if let Some(f) = self.funcs_by_qn.get(qn) {
            return Some(f);
        }
        if let Some(ref fallback) = self.fallback {
            return fallback.lookup_func(qn);
        }
        None
    }

    /// Look up a type by qualified name.
    pub fn lookup_type(&self, qn: &str) -> Option<&RegisteredType> {
        if let Some(t) = self.types_by_qn.get(qn) {
            return Some(t);
        }
        if let Some(ref fallback) = self.fallback {
            return fallback.lookup_type(qn);
        }
        None
    }

    /// Look up a method by (receiver_qn, method_name).
    /// Returns the RegisteredFunc if found.
    pub fn lookup_method(&self, receiver_qn: &str, method_name: &str) -> Option<&RegisteredFunc> {
        let mut visited = std::collections::HashSet::new();
        self.lookup_method_guarded(receiver_qn, method_name, &mut visited)
    }

    fn lookup_method_guarded<'a>(
        &'a self,
        receiver_qn: &str,
        method_name: &str,
        visited: &mut std::collections::HashSet<String>,
    ) -> Option<&'a RegisteredFunc> {
        // Cycle guard: each receiver QN visited at most once per lookup chain.
        // This prevents infinite recursion on inheritance cycles (A→B→A).
        if !visited.insert(receiver_qn.to_string()) {
            return None;
        }
        // Direct index lookup
        if let Some(qn) = self.methods_index.get(&(receiver_qn.to_string(), method_name.to_string())) {
            return self.lookup_func(qn);
        }
        // Walk base classes (MRO — linear scan for now, no C3)
        if let Some(rt) = self.types_by_qn.get(receiver_qn) {
            for base in &rt.bases {
                if let Some(f) = self.lookup_method_guarded(base, method_name, visited) {
                    return Some(f);
                }
            }
            // Alias chain
            if let Some(ref alias_target) = rt.alias_of {
                if let Some(f) = self.lookup_method_guarded(alias_target, method_name, visited) {
                    return Some(f);
                }
            }
        }
        // Fallback registry has its own namespace — fresh visited set
        if let Some(ref fallback) = self.fallback {
            let mut fb_visited = std::collections::HashSet::new();
            return fallback.lookup_method_guarded(receiver_qn, method_name, &mut fb_visited);
        }
        None
    }

    /// Look up a symbol (function or type) in a package/module by short name.
    pub fn lookup_symbol(&self, package_qn: &str, name: &str) -> Option<&RegisteredFunc> {
        let qn = format!("{}.{}", package_qn, name);
        if let Some(f) = self.funcs_by_qn.get(&qn) {
            return Some(f);
        }
        // Try the fallback
        if let Some(ref fallback) = self.fallback {
            return fallback.lookup_symbol(package_qn, name);
        }
        None
    }

    /// Register a function in the registry (mutable — for instance field tracking).
    pub fn add_func(&mut self, rf: RegisteredFunc) {
        if let Some(ref recv) = rf.receiver_type {
            self.methods_index
                .insert((recv.clone(), rf.short_name.clone()), rf.qualified_name.clone());
        }
        self.qn_index.insert(rf.qualified_name.clone());
        self.funcs_by_qn.insert(rf.qualified_name.clone(), rf);
    }

    /// Register a type in the registry.
    pub fn add_type(&mut self, rt: RegisteredType) {
        self.qn_index.insert(rt.qualified_name.clone());
        self.types_by_qn.insert(rt.qualified_name.clone(), rt);
    }

    /// Register an instance field on a class (from `self.x = expr` in __init__).
    pub fn add_instance_field(&mut self, class_qn: &str, field_name: &str, field_type: Type) {
        if let Some(rt) = self.types_by_qn.get_mut(class_qn) {
            rt.fields.insert(field_name.to_string(), field_type);
        }
    }

    /// Look up a field on a type (instance attributes from __init__).
    pub fn lookup_field(&self, class_qn: &str, field_name: &str) -> Option<&Type> {
        let mut visited = std::collections::HashSet::new();
        self.lookup_field_guarded(class_qn, field_name, &mut visited)
    }

    fn lookup_field_guarded<'a>(
        &'a self,
        class_qn: &str,
        field_name: &str,
        visited: &mut std::collections::HashSet<String>,
    ) -> Option<&'a Type> {
        // Cycle guard: each class QN visited at most once per lookup chain.
        if !visited.insert(class_qn.to_string()) {
            return None;
        }
        if let Some(rt) = self.types_by_qn.get(class_qn) {
            if let Some(t) = rt.fields.get(field_name) {
                return Some(t);
            }
            // Walk base classes
            for base in &rt.bases {
                if let Some(t) = self.lookup_field_guarded(base, field_name, visited) {
                    return Some(t);
                }
            }
        }
        // Fallback registry has its own namespace — fresh visited set
        if let Some(ref fallback) = self.fallback {
            let mut fb_visited = std::collections::HashSet::new();
            return fallback.lookup_field_guarded(class_qn, field_name, &mut fb_visited);
        }
        None
    }
}

impl Default for TypeRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Node;

    #[test]
    fn test_registry_from_graph() {
        let mut g = Graph::new();
        let mut user = Node::new("myapp.models.User", "User", NodeKind::Class);
        user.location = Some("myapp/models.py".into());
        g.add_node(user);
        let mut handle = Node::new("myapp.models.User.handle", "handle", NodeKind::Function);
        handle.location = Some("myapp/models.py".into());
        g.add_node(handle);
        let mut index = Node::new("myapp.views.index", "index", NodeKind::Function);
        index.location = Some("myapp/views.py".into());
        g.add_node(index);

        let reg = TypeRegistry::from_graph(&g);

        // Check class registered
        assert!(reg.lookup_type("myapp.models.User").is_some());

        // Check method registered
        let m = reg.lookup_method("myapp.models.User", "handle");
        assert!(m.is_some());
        assert_eq!(m.unwrap().qualified_name, "myapp.models.User.handle");

        // Check free function
        let f = reg.lookup_func("myapp.views.index");
        assert!(f.is_some());
    }

    #[test]
    fn test_lookup_method_inherited() {
        let mut reg = TypeRegistry::new();
        let mut base = RegisteredType {
            qualified_name: "builtins.Base".into(),
            short_name: "Base".into(),
            methods: HashMap::new(),
            fields: HashMap::new(),
            bases: Vec::new(),
            is_interface: false,
            alias_of: None,
        };
        base.methods.insert("do_stuff".into(), "builtins.Base.do_stuff".into());
        reg.add_type(base);
        reg.add_func(RegisteredFunc {
            qualified_name: "builtins.Base.do_stuff".into(),
            receiver_type: Some("builtins.Base".into()),
            short_name: "do_stuff".into(),
            params: Vec::new(),
            ret: Type::Unknown,
            flags: 0,
        });

        let mut child = RegisteredType {
            qualified_name: "myapp.Child".into(),
            short_name: "Child".into(),
            methods: HashMap::new(),
            fields: HashMap::new(),
            bases: vec!["builtins.Base".into()],
            is_interface: false,
            alias_of: None,
        };
        child.methods.insert("do_stuff".into(), "builtins.Base.do_stuff".into());
        reg.add_type(child);

        let m = reg.lookup_method("myapp.Child", "do_stuff");
        assert!(m.is_some());
        assert_eq!(m.unwrap().qualified_name, "builtins.Base.do_stuff");
    }

    #[test]
    fn test_builtins_registered() {
        let reg = TypeRegistry::new(); // new() calls register_builtins

        assert!(reg.lookup_type("builtins.list").is_some());
        assert!(reg.lookup_type("builtins.dict").is_some());
        assert!(reg.lookup_type("builtins.str").is_some());
        assert!(reg.lookup_type("builtins.int").is_some());

        // list.append should be registered
        let m = reg.lookup_method("builtins.list", "append");
        assert!(m.is_some());

        // builtin functions
        assert!(reg.lookup_func("builtins.len").is_some());
        assert!(reg.lookup_func("builtins.range").is_some());
    }

    #[test]
    fn test_inheritance_cycle_does_not_overflow() {
        // Regression: deprecation/tests.py has Renamed↔Deprecated mutual inheritance.
        // lookup_method / lookup_field must survive cycles without stack overflow.
        let mut reg = TypeRegistry::new();
        let a = RegisteredType {
            qualified_name: "pkg.A".into(),
            short_name: "A".into(),
            methods: HashMap::new(),
            fields: HashMap::new(),
            bases: vec!["pkg.B".into()],
            is_interface: false,
            alias_of: None,
        };
        let b = RegisteredType {
            qualified_name: "pkg.B".into(),
            short_name: "B".into(),
            methods: HashMap::new(),
            fields: HashMap::new(),
            bases: vec!["pkg.A".into()],
            is_interface: false,
            alias_of: None,
        };
        reg.add_type(a);
        reg.add_type(b);

        // These must return None quickly, not overflow.
        assert!(reg.lookup_method("pkg.A", "nonexistent").is_none());
        assert!(reg.lookup_field("pkg.A", "nonexistent").is_none());
    }

    #[test]
    fn test_parse_method_qn() {
        let (recv, name) = TypeRegistry::parse_method_qn("myapp.models.User.handle", "handle");
        assert_eq!(recv, Some("myapp.models.User".into()));
        assert_eq!(name, "handle");

        let (recv2, name2) = TypeRegistry::parse_method_qn("myapp.views.index", "index");
        assert_eq!(recv2, None); // "views" is lowercase, not a class
        assert_eq!(name2, "index");
    }
}
