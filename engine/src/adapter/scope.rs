// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Scope stack for variable type binding during LSP analysis.
//! Mirrors `scope.h` — simple parent-pointer chain.

use std::collections::HashMap;

use super::types::Type;

/// A single scope frame with variable bindings.
#[derive(Debug, Clone)]
pub struct Scope {
    /// Parent scope (None = root / module scope).
    pub parent: Option<Box<Scope>>,
    /// Variable name → inferred type.
    pub bindings: HashMap<String, Type>,
}

impl Scope {
    /// Create a new root scope.
    pub fn new_root() -> Self {
        Self {
            parent: None,
            bindings: HashMap::new(),
        }
    }

    /// Push a new child scope inheriting from this one.
    pub fn push(&self) -> Self {
        Self {
            parent: Some(Box::new(self.clone())),
            bindings: HashMap::new(),
        }
    }

    /// Bind a variable name to a type in the current scope.
    pub fn bind(&mut self, name: impl Into<String>, ty: Type) {
        self.bindings.insert(name.into(), ty);
    }

    /// Look up a variable name, walking up the parent chain.
    /// Returns Unknown if not found.
    pub fn lookup(&self, name: &str) -> Type {
        if let Some(ty) = self.bindings.get(name) {
            return ty.clone();
        }
        if let Some(ref parent) = self.parent {
            return parent.lookup(name);
        }
        Type::Unknown
    }

    /// Check if a name is bound in any scope along the chain.
    pub fn contains(&self, name: &str) -> bool {
        if self.bindings.contains_key(name) {
            return true;
        }
        if let Some(ref parent) = self.parent {
            return parent.contains(name);
        }
        false
    }
}

/// Convenience wrapper: ScopeStack maintains the current scope pointer.
#[derive(Debug, Clone)]
pub struct ScopeStack {
    /// Root scope (module-level).
    pub root: Scope,
}

impl ScopeStack {
    /// Create a new scope stack with a root scope.
    pub fn new() -> Self {
        Self {
            root: Scope::new_root(),
        }
    }

    /// Bind a name in the root scope.
    pub fn bind_global(&mut self, name: &str, ty: Type) {
        self.root.bind(name, ty);
    }

    /// Look up from the root scope only.
    pub fn lookup_global(&self, name: &str) -> Type {
        self.root.lookup(name)
    }
}

impl Default for ScopeStack {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scope_lookup_chain() {
        let mut root = Scope::new_root();
        root.bind("x", Type::builtin("int"));

        let mut child = root.push();
        child.bind("y", Type::named("User"));

        // Lookup in child should find both
        assert_eq!(child.lookup("x"), Type::builtin("int"));
        assert_eq!(child.lookup("y"), Type::named("User"));
        assert!(child.lookup("z").is_unknown());

        // Root should only have x
        assert_eq!(root.lookup("x"), Type::builtin("int"));
        assert!(root.lookup("y").is_unknown());
    }

    #[test]
    fn test_shadowing() {
        let mut root = Scope::new_root();
        root.bind("x", Type::builtin("int"));

        let mut child = root.push();
        child.bind("x", Type::named("User")); // shadow

        assert_eq!(root.lookup("x"), Type::builtin("int"));
        assert_eq!(child.lookup("x"), Type::named("User"));
    }

    #[test]
    fn test_contains() {
        let mut root = Scope::new_root();
        root.bind("a", Type::builtin("int"));
        assert!(root.contains("a"));
        assert!(!root.contains("b"));
    }

    #[test]
    fn test_scope_stack() {
        let mut stack = ScopeStack::new();
        stack.bind_global("module_var", Type::named("Config"));
        assert_eq!(stack.lookup_global("module_var"), Type::named("Config"));
    }
}
