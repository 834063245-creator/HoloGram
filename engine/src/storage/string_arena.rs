// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// StringArena — string interner for MemoryIndex.
// Stores each unique string once, returns a u32 handle.
// Reduces edge adjacency storage from ~80 bytes/entry to ~16 bytes/entry.
// Industry precedent: rustc Symbol, Sourcegraph string dedup, Kythe graph store.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct StringArena {
    strings: Vec<String>,
    /// String → index in `strings`
    lookup: HashMap<String, u32>,
}

impl StringArena {
    pub fn new() -> Self {
        let mut arena = Self {
            strings: Vec::new(),
            lookup: HashMap::new(),
        };
        // Reserve index 0 as empty string sentinel
        arena.strings.push(String::new());
        arena.lookup.insert(String::new(), 0);
        arena
    }

    /// Intern a string, returning its u32 handle. Deduplicates automatically.
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.lookup.get(s) {
            return id;
        }
        let id = self.strings.len() as u32;
        self.strings.push(s.to_string());
        self.lookup.insert(s.to_string(), id);
        id
    }

    /// Look up a u32 handle. Returns empty string for invalid handles.
    pub fn get(&self, id: u32) -> &str {
        self.strings
            .get(id as usize)
            .map(|s| s.as_str())
            .unwrap_or("")
    }

    /// Get handle for an already-interned string (no mutation).
    pub fn get_handle(&self, s: &str) -> Option<u32> {
        self.lookup.get(s).copied()
    }

    pub fn len(&self) -> usize {
        self.strings.len()
    }
}

impl Default for StringArena {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_intern_dedup() {
        let mut arena = StringArena::new();
        let a = arena.intern("hello");
        let b = arena.intern("hello");
        assert_eq!(a, b);
        assert_eq!(arena.get(a), "hello");
    }

    #[test]
    fn test_get_handle() {
        let mut arena = StringArena::new();
        arena.intern("world");
        assert_eq!(arena.get_handle("world"), Some(1)); // index 0 = empty sentinel, 1 = "world"
        assert_eq!(arena.get_handle("nope"), None);
    }
}
