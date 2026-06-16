use crate::adapter::traits::LanguageAdapter;
use crate::adapter::python::PythonAdapter;
use crate::adapter::typescript::TypeScriptAdapter;
use crate::adapter::tree_sitter::TreeSitterAdapter;
use std::collections::HashMap;

pub struct AdapterRegistry {
    adapters: Vec<Box<dyn LanguageAdapter>>,
    ext_index: HashMap<String, usize>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        let mut registry = Self { adapters: Vec::new(), ext_index: HashMap::new() };
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
        // Python adapter is registered first, so "py" maps to PythonAdapter
        let r = AdapterRegistry::new();
        let adapter = r.get("py").unwrap();
        let exts = adapter.extensions();
        assert!(exts.iter().any(|e| e == "py"));
    }

    #[test]
    fn test_registry_returns_same_adapter_for_variants() {
        // tsx should use the same TypeScriptAdapter as ts
        let r = AdapterRegistry::new();
        let ts = r.get("ts");
        let tsx = r.get("tsx");
        assert!(ts.is_some());
        assert!(tsx.is_some());
    }
}
