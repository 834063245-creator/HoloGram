use crate::adapter::traits::LanguageAdapter;
use crate::adapter::python::PythonAdapter;
use crate::adapter::typescript::TypeScriptAdapter;
use std::collections::HashMap;

/// Registry mapping file extensions to language adapters.
pub struct AdapterRegistry {
    adapters: Vec<Box<dyn LanguageAdapter>>,
    ext_index: HashMap<String, usize>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        let mut registry = Self {
            adapters: Vec::new(),
            ext_index: HashMap::new(),
        };
        registry.register(PythonAdapter::new());
        registry.register(TypeScriptAdapter::new());
        registry
    }

    pub fn register(&mut self, adapter: impl LanguageAdapter + 'static) {
        let idx = self.adapters.len();
        for ext in adapter.extensions() {
            self.ext_index.insert(ext.to_string(), idx);
        }
        self.adapters.push(Box::new(adapter));
    }

    pub fn get(&self, ext: &str) -> Option<&dyn LanguageAdapter> {
        let idx = self.ext_index.get(ext)?;
        Some(self.adapters[*idx].as_ref())
    }
}
