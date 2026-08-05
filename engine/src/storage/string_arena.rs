// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// StringArena — MemoryIndex 的字符串驻留器。
// 每个唯一字符串只存储一次，返回 u32 句柄。
// 将每条边邻接存储从 ~80 字节降至 ~16 字节。
// 行业先例：rustc Symbol、Sourcegraph 字符串去重、Kythe graph store。

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct StringArena {
    strings: Vec<String>,
    /// String → 在 `strings` 中的索引
    lookup: HashMap<String, u32>,
}

impl StringArena {
    pub fn new() -> Self {
        let mut arena = Self {
            strings: Vec::new(),
            lookup: HashMap::new(),
        };
        // 预留索引 0 作为空字符串哨兵
        arena.strings.push(String::new());
        arena.lookup.insert(String::new(), 0);
        arena
    }

    /// 驻留字符串，返回其 u32 句柄。自动去重。
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.lookup.get(s) {
            return id;
        }
        let id = self.strings.len() as u32;
        self.strings.push(s.to_string());
        self.lookup.insert(s.to_string(), id);
        id
    }

    /// 查找 u32 句柄。无效句柄返回空字符串。
    pub fn get(&self, id: u32) -> &str {
        self.strings
            .get(id as usize)
            .map(|s| s.as_str())
            .unwrap_or("")
    }

    /// 获取已驻留字符串的句柄（不修改状态）。
    pub fn get_handle(&self, s: &str) -> Option<u32> {
        self.lookup.get(s).copied()
    }

    pub fn len(&self) -> usize {
        self.strings.len()
    }

    /// 返回全部驻留字符串（含索引 0 的空哨兵）。快照序列化用。
    pub fn strings(&self) -> &[String] {
        &self.strings
    }

    /// 从字符串表重建 arena（快照反序列化用）。lookup 全量重建。
    /// 索引 0 空哨兵语义保持：传入表为空或首项非空串时，前置插入空哨兵兜底。
    pub fn from_strings(strings: Vec<String>) -> Self {
        let mut strings = strings;
        if strings.first().map(|s| !s.is_empty()).unwrap_or(true) {
            strings.insert(0, String::new());
        }
        let lookup = strings
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i as u32))
            .collect();
        Self { strings, lookup }
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
        assert_eq!(arena.get_handle("world"), Some(1)); // 索引 0 = 空哨兵，1 = "world"
        assert_eq!(arena.get_handle("nope"), None);
    }

    #[test]
    fn test_strings_roundtrip_via_from_strings() {
        let mut arena = StringArena::new();
        let h_a = arena.intern("alpha");
        let h_b = arena.intern("beta");
        let rebuilt = StringArena::from_strings(arena.strings().to_vec());
        assert_eq!(rebuilt.len(), arena.len());
        assert_eq!(rebuilt.get(h_a), "alpha");
        assert_eq!(rebuilt.get(h_b), "beta");
        assert_eq!(rebuilt.get_handle("alpha"), Some(h_a));
        assert_eq!(rebuilt.get_handle(""), Some(0)); // 空哨兵保持索引 0
    }

    #[test]
    fn test_from_strings_sentinel_fallback() {
        // 空表 → 兜底出空哨兵
        let a = StringArena::from_strings(vec![]);
        assert_eq!(a.get(0), "");
        // 首项非空串 → 前置插入哨兵，原句柄 +1
        let b = StringArena::from_strings(vec!["x".to_string()]);
        assert_eq!(b.get(0), "");
        assert_eq!(b.get_handle("x"), Some(1));
    }
}
