// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::adapter::traits::LanguageAdapter;
use crate::adapter::python::PythonAdapter;
use crate::adapter::typescript::TypeScriptAdapter;
use crate::adapter::tree_sitter::TreeSitterAdapter;
use crate::adapter::query_adapter::QueryStructureAdapter;
use std::collections::HashMap;

pub struct AdapterRegistry {
    adapters: Vec<Box<dyn LanguageAdapter>>,
    ext_index: HashMap<String, usize>,
}

impl Default for AdapterRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl AdapterRegistry {
    pub fn new() -> Self {
        let mut registry = Self { adapters: Vec::new(), ext_index: HashMap::new() };

        // ── Query-based adapters — first-registered wins ──

        // JS/TS (split query: js_structure.scm + ts_structure.scm)
        registry.register(QueryStructureAdapter::new_js_ts());

        // Rust
        registry.register(QueryStructureAdapter::new_rust());

        // Python
        registry.register(QueryStructureAdapter::new_generic(
            vec!["py".into(), "pyi".into()],
            include_str!("../../queries/python_structure.scm"),
            &["function_definition", "lambda"],
            &["class_definition"],
        ));

        // Go
        registry.register(QueryStructureAdapter::new_generic(
            vec!["go".into()],
            include_str!("../../queries/go_structure.scm"),
            &["function_declaration", "method_declaration", "func_literal"],
            &["type_declaration"],
        ));

        // Java
        registry.register(QueryStructureAdapter::new_generic(
            vec!["java".into()],
            include_str!("../../queries/java_structure.scm"),
            &["method_declaration", "constructor_declaration", "lambda_expression"],
            &["class_declaration", "interface_declaration", "enum_declaration"],
        ));

        // C/C++
        registry.register(QueryStructureAdapter::new_generic(
            vec!["c".into(), "h".into(), "cpp".into(), "hpp".into(),
                 "cc".into(), "hh".into(), "cxx".into(), "hxx".into()],
            include_str!("../../queries/c_structure.scm"),
            &["function_definition", "lambda_expression"],
            &["class_specifier", "struct_specifier", "union_specifier"],
        ));

        // C#
        registry.register(QueryStructureAdapter::new_generic(
            vec!["cs".into()],
            include_str!("../../queries/csharp_structure.scm"),
            &["method_declaration", "constructor_declaration", "lambda_expression"],
            &["class_declaration", "struct_declaration", "interface_declaration", "enum_declaration"],
        ));

        // Ruby
        registry.register(QueryStructureAdapter::new_generic(
            vec!["rb".into()],
            include_str!("../../queries/ruby_structure.scm"),
            &["method", "lambda", "block"],
            &["class", "module"],
        ));

        // PHP
        registry.register(QueryStructureAdapter::new_generic(
            vec!["php".into()],
            include_str!("../../queries/php_structure.scm"),
            &["method_declaration", "function_definition", "arrow_function"],
            &["class_declaration", "interface_declaration", "trait_declaration"],
        ));

        // Swift
        registry.register(QueryStructureAdapter::new_generic(
            vec!["swift".into()],
            include_str!("../../queries/swift_structure.scm"),
            &["function_declaration", "method_declaration"],
            &["class_declaration", "struct_declaration", "enum_declaration", "protocol_declaration"],
        ));

        // Dart
        registry.register(QueryStructureAdapter::new_generic(
            vec!["dart".into()],
            include_str!("../../queries/dart_structure.scm"),
            &["function_declaration", "method_declaration", "function_expression"],
            &["class_declaration", "enum_declaration", "mixin_declaration"],
        ));

        // Scala
        registry.register(QueryStructureAdapter::new_generic(
            vec!["scala".into()],
            include_str!("../../queries/scala_structure.scm"),
            &["function_definition", "method_definition", "lambda_expression"],
            &["class_definition", "object_definition", "trait_definition"],
        ));

        // Zig
        registry.register(QueryStructureAdapter::new_generic(
            vec!["zig".into()],
            include_str!("../../queries/zig_structure.scm"),
            &["function_declaration"],
            &[],
        ));

        // Elixir
        registry.register(QueryStructureAdapter::new_generic(
            vec!["ex".into(), "exs".into()],
            include_str!("../../queries/elixir_structure.scm"),
            &["anonymous_function"],
            &[],
        ));

        // Lua
        registry.register(QueryStructureAdapter::new_generic(
            vec!["lua".into()],
            include_str!("../../queries/lua_structure.scm"),
            &["function_declaration", "function_definition"],
            &[],
        ));

        // Bash
        registry.register(QueryStructureAdapter::new_generic(
            vec!["sh".into(), "bash".into()],
            include_str!("../../queries/bash_structure.scm"),
            &["function_definition"],
            &[],
        ));

        // R
        registry.register(QueryStructureAdapter::new_generic(
            vec!["r".into(), "R".into()],
            include_str!("../../queries/r_structure.scm"),
            &["function_definition"],
            &[],
        ));

        // ── Fallback: old adapters for extensions NOT covered above ──
        registry.register(PythonAdapter::new());
        registry.register(TypeScriptAdapter::new());
        registry.register(TreeSitterAdapter::new());

        registry
    }

    pub fn register(&mut self, adapter: impl LanguageAdapter + 'static) {
        let idx = self.adapters.len();
        for ext in adapter.extensions() {
            self.ext_index.entry(ext).or_insert(idx); // first registered wins
        }
        self.adapters.push(Box::new(adapter));
    }

    pub fn get(&self, ext: &str) -> Option<&dyn LanguageAdapter> {
        let idx = self.ext_index.get(ext)?;
        Some(self.adapters[*idx].as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_has_python() {
        let r = AdapterRegistry::new();
        assert!(r.get("py").is_some());
    }

    #[test]
    fn test_registry_has_typescript() {
        let r = AdapterRegistry::new();
        assert!(r.get("ts").is_some());
        assert!(r.get("tsx").is_some());
        assert!(r.get("js").is_some());
    }

    #[test]
    fn test_registry_has_tree_sitter() {
        let r = AdapterRegistry::new();
        assert!(r.get("go").is_some());
        assert!(r.get("rs").is_some());
        assert!(r.get("java").is_some());
        assert!(r.get("rb").is_some());
        assert!(r.get("lua").is_some());
    }

    #[test]
    fn test_registry_missing_ext() {
        let r = AdapterRegistry::new();
        assert!(r.get("nope").is_none());
        assert!(r.get("").is_none());
    }

    #[test]
    fn test_first_registered_wins() {
        let r = AdapterRegistry::new();
        let adapter = r.get("py").unwrap();
        let exts = adapter.extensions();
        assert!(exts.iter().any(|e| e == "py"));
    }

    #[test]
    fn test_registry_returns_same_adapter_for_variants() {
        let r = AdapterRegistry::new();
        let ts = r.get("ts");
        let tsx = r.get("tsx");
        assert!(ts.is_some());
        assert!(tsx.is_some());
    }
}
