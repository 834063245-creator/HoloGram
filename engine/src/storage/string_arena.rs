// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// StringArena — MemoryIndex / GraphMerger 的字符串驻留器。
//
// R10-deep 后全局驻留器(graph::id)已覆盖全部字符串句柄语义,本类型
// 收缩为**全局驻留器的薄封装**(句柄空间统一,消除双份驻留):
//   - intern(s)       → 全局驻留,返回进程级稳定 u32 句柄
//   - get(h)          → 全局解析回字符串
//   - get_handle(s)   → 查询已驻留句柄(不含驻留副作用)
//   - intern_with_handle(s, h) → 按指定句柄注册(快照读回精确重建)
//
// 句柄 0 = 空字符串哨兵(全局驻留器保证)。
// 快照的字符串表导出/重建改由 memory.rs 按「引用句柄收集」完成,
// strings()/from_strings() 不再属于本类型。

use crate::graph::id;

#[derive(Debug, Clone, Copy, Default)]
pub struct StringArena;

impl StringArena {
    pub fn new() -> Self {
        Self
    }

    /// 驻留字符串,返回其 u32 句柄(全局驻留器,内容寻址,自动去重)。
    pub fn intern(&mut self, s: &str) -> u32 {
        id::intern(s)
    }

    /// 按指定句柄驻留(快照读回精确重建句柄空间)。
    pub fn intern_with_handle(&mut self, s: &str, h: u32) -> u32 {
        id::intern_with_handle(s, h)
    }

    /// 解析 u32 句柄为字符串。无效句柄返回空字符串。
    pub fn get(&self, h: u32) -> &str {
        id::resolve(h)
    }

    /// 获取已驻留字符串的句柄(不修改状态)。
    pub fn get_handle(&self, s: &str) -> Option<u32> {
        id::handle_of(s)
    }

    /// 全局驻留器当前容量(诊断用;含本索引之外的驻留)。
    pub fn len(&self) -> usize {
        id::interned_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 串行化依赖「句柄槽空闲」的测试 —— 全局驻留器跨测试共享,
    /// 并行测试会并发 intern 推高句柄水位,绝对槽位不可假设。
    /// 恢复式加锁:conflict 测试会持锁 panic(毒化锁),后续测试须容忍。
    static ARENA_SLOT_LOCK: Mutex<()> = Mutex::new(());

    fn slot_guard() -> std::sync::MutexGuard<'static, ()> {
        ARENA_SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 构造本测试独有的未驻留字符串(锁内调用,保证唯一)。
    fn unique_str(tag: &str) -> String {
        let count = id::interned_count();
        format!("__arena_test_{}_{}_{}", tag, std::process::id(), count)
    }

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
        let h = arena.intern("world");
        assert_eq!(arena.get_handle("world"), Some(h));
        assert_eq!(arena.get_handle("nope"), None);
    }

    #[test]
    fn test_sentinel_handle_zero_is_empty() {
        // 全局驻留器保证句柄 0 = 空哨兵(与 StringArena 历史语义一致)
        let arena = StringArena::new();
        assert_eq!(arena.get(0), "");
        let mut arena = StringArena::new();
        assert_eq!(arena.intern(""), 0, "空字符串恒为句柄 0");
    }

    #[test]
    fn test_intern_with_handle_sparse() {
        let _guard = slot_guard();
        let mut arena = StringArena::new();
        // 稀疏注册:落到当前水位之后的大偏移槽(槽 1..h-1 留空)
        let s = unique_str("sparse");
        let h = id::interned_count() as u32 + 100_000;
        let got = arena.intern_with_handle(&s, h);
        assert_eq!(got, h);
        assert_eq!(arena.get(h), s);
        // 稀疏空洞为 ""(h = 当前水位 + 10 万,前后槽在并发下不会被触碰)
        assert_eq!(arena.get(h - 1), "");
        assert_eq!(arena.get(h + 1), "");
        // 幂等:已驻留字符串返回现有句柄
        assert_eq!(arena.intern_with_handle(&s, h + 1), h);
        // 后续普通驻留不受稀疏槽影响
        let h2 = arena.intern("after-sparse");
        assert_eq!(arena.get(h2), "after-sparse");
        assert_eq!(arena.get_handle("after-sparse"), Some(h2));
    }

    #[test]
    fn test_intern_with_handle_same_slot_same_string() {
        let _guard = slot_guard();
        let mut arena = StringArena::new();
        let s = unique_str("same");
        let h = id::interned_count() as u32 + 100_000;
        arena.intern_with_handle(&s, h);
        // 同槽同串:幂等返回
        assert_eq!(arena.intern_with_handle(&s, h), h);
        // 同串不同槽:已驻留,返回现有句柄
        assert_eq!(arena.intern_with_handle(&s, h + 1), h);
    }

    #[test]
    #[should_panic(expected = "conflict")]
    fn test_intern_with_handle_conflict_panics() {
        let _guard = slot_guard();
        let mut arena = StringArena::new();
        let s1 = unique_str("conflict_a");
        let s2 = unique_str("conflict_b");
        let h = id::interned_count() as u32 + 100_000;
        arena.intern_with_handle(&s1, h);
        let _ = arena.intern_with_handle(&s2, h);
    }
}
