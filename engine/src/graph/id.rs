// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 节点/边 ID 的强类型句柄 + 全局字符串驻留器(R10-deep)。
//!
//! R0 时代 NodeId/EdgeId 内部为 String;R10-deep 起改为 **全局驻留的 u32 句柄**:
//! 每个唯一字符串只驻留一次(进程生命周期内),句柄按内容寻址 ——
//! 同一字符串永远得到同一句柄,所以句柄相等 ⟺ 字符串相等。
//!
//! 对外语义保持"字符串句柄"不变: `as_str()` 签名稳定、`serde` 线格式是纯字符串、
//! `Display`/`Deref<Target=str>`/`PartialEq<&str>` 让消费方行为零感知。
//! 真正的内存收益:Node.id / Edge.id / Edge.source / Edge.target 从各自堆分配的
//! String 变成 4B 句柄,字符串只在驻留器里存一份(handoff 承诺的 5~10× 方向)。
//!
//! 注意:句柄是进程全局的,驻留器只增不删 —— 长驻进程多次分析不同项目时表会增长,
//! 但对同一项目重复分析是内容寻址复用,无正确性问题。
//!
//! 设计要点(与 String 时代的差异):
//! - **无 `Borrow<str>`**:句柄的 Hash 是 u32 数值,与 str 的词法 Hash 不一致,
//!   `HashMap<NodeId, _>.get(&str)` 会撞 Hash 不一致陷阱。字符串查找一律走
//!   `handle_of(s)`(驻留器查询)→ 句柄 → 容器 get。
//! - **`Ord` 是词法序**:句柄数值序依赖驻留顺序(进程相关),排序语义必须与
//!   String 时代一致,故按 `as_str()` 比较。

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

// ── 全局驻留器(非重复:每个字符串的字节只分配一次)──

/// 驻留表。`strings` 持有唯一的 `Arc<str>`;`lookup` 的 key 是同一份 `Arc` 的 clone
/// (共享同一块堆分配,只多一个指针),所以字符串字节只存一次。
///
/// `strings` 用 `Option` 支持**稀疏句柄**:快照读回时按写入句柄精确重建
/// (见 `intern_with_handle`),句柄槽可能跳号(槽位为 `None`)。
/// 索引 0 恒为 `Some("")` 空哨兵 —— 与 StringArena 时代的 `get(0) == ""`
/// 语义一致,空字符串句柄恒为 0。
struct Interner {
    /// 句柄 → 字符串(句柄就是 `strings` 的下标;None = 未占用的稀疏槽)
    strings: Vec<Option<Arc<str>>>,
    /// 字符串 → 句柄(内容寻址)
    lookup: HashMap<Arc<str>, u32>,
}

impl Interner {
    fn new() -> Self {
        let mut strings = Vec::new();
        let mut lookup = HashMap::new();
        // 空哨兵:句柄 0 = 空字符串(与 StringArena 历史语义一致)
        let sentinel: Arc<str> = Arc::from("");
        strings.push(Some(sentinel.clone()));
        lookup.insert(sentinel, 0);
        Self { strings, lookup }
    }

    fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.lookup.get(s) {
            return id;
        }
        let id = self.strings.len() as u32;
        self.strings.push(Some(Arc::from(s)));
        // clone 只增加引用计数,共享同一块 str 字节
        self.lookup.insert(self.strings[id as usize].as_ref().expect("intern 刚写入的槽位必为 Some").clone(), id);
        id
    }

    /// 按指定句柄驻留(快照读回精确重建用)。
    /// - 字符串已驻留 → 返回现有句柄(幂等,不检查 h)。
    /// - 槽位空闲 → 注册 h ↔ s。
    /// - 槽位已占用且字符串不同 → panic(快照损坏/冲突,不应发生)。
    fn intern_with_handle(&mut self, s: &str, h: u32) -> u32 {
        if let Some(&id) = self.lookup.get(s) {
            return id;
        }
        let slot = self.strings.get(h as usize);
        match slot {
            Some(Some(existing)) if existing.as_ref() != s => {
                panic!(
                    "intern_with_handle conflict: handle {} already holds {:?}, asked for {:?}",
                    h, existing, s
                );
            }
            _ => {}
        }
        if self.strings.len() <= h as usize {
            self.strings.resize(h as usize + 1, None);
        }
        let arc: Arc<str> = Arc::from(s);
        self.strings[h as usize] = Some(arc.clone());
        self.lookup.insert(arc, h);
        h
    }

    fn handle_of(&self, s: &str) -> Option<u32> {
        self.lookup.get(s).copied()
    }

    fn get(&self, id: u32) -> &str {
        self.strings
            .get(id as usize)
            .and_then(|o| o.as_deref())
            .unwrap_or("")
    }

    #[allow(dead_code)]
    fn len(&self) -> usize {
        self.strings.len()
    }
}

fn interner() -> &'static RwLock<Interner> {
    static IN: OnceLock<RwLock<Interner>> = OnceLock::new();
    IN.get_or_init(|| RwLock::new(Interner::new()))
}

/// 驻留字符串,返回稳定 u32 句柄。fast path 只读锁,miss 才取写锁。
pub fn intern(s: &str) -> u32 {
    let r = interner()
        .read()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(id) = r.handle_of(s) {
        return id;
    }
    drop(r);
    interner()
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .intern(s)
}

/// 按指定句柄驻留(快照读回精确重建句柄空间用)。
/// 字符串已驻留时返回现有句柄;槽位冲突时 panic。
pub fn intern_with_handle(s: &str, h: u32) -> u32 {
    interner()
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .intern_with_handle(s, h)
}

/// 查询已驻留字符串的句柄(不含驻留副作用)。
pub fn handle_of(s: &str) -> Option<u32> {
    interner()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .handle_of(s)
}

/// 解析句柄为字符串。
///
/// 返回 `&'static str` 借驻留器的堆数据:驻留器是进程生命周期 static,字符串只增不删;
/// `Arc<str>` 的字节在 Vec 扩容时不被移动(只移 8B 指针),引用计数变化不影响 str 数据。
/// 因此该 `&str` 在进程剩余生命周期内始终有效 —— rustc Symbol 式驻留器的常规做法。
pub fn resolve(id: u32) -> &'static str {
    // SAFETY: 见上方说明。驻留器静态存活、只增不删,Arc<str> 堆数据稳定,
    // transmute 缩短引用到 'static 是健全的。
    unsafe {
        let r = interner()
            .read()
            .unwrap_or_else(|e| e.into_inner());
        std::mem::transmute::<&str, &'static str>(r.get(id))
    }
}

/// 当前驻留的唯一字符串数(诊断/测试用)。
#[allow(dead_code)]
pub fn interned_count() -> usize {
    interner()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .len()
}

// ── 强类型句柄 ──

/// 节点 ID 的强类型句柄。内部是全局驻留的 u32 句柄,对外是字符串语义:
/// `as_str()` 解析回字符串,`serde` 序列化为纯字符串(线格式零漂移)。
///
/// `Deref<Target=str>` 让 `.contains()/.len()/.starts_with()` 等只读 str 方法
/// 自动可用(句柄不可变,无字符串手术风险);`PartialEq<&str>` 支持 `id == "x"`。
/// `Ord` 实现为**词法序**(句柄数值序会破坏既有排序语义)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId(u32);

/// 边 ID 的强类型句柄。设计同 NodeId。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EdgeId(u32);

macro_rules! impl_id_handle {
    ($T:ident) => {
        impl $T {
            /// 构造:将字符串驻留进全局表,返回稳定句柄。
            #[inline]
            pub fn new(s: impl Into<String>) -> Self {
                Self(crate::graph::id::intern(&s.into()))
            }

            /// 解析回字符串(进程生命周期内稳定)。
            #[inline]
            pub fn as_str(&self) -> &str {
                crate::graph::id::resolve(self.0)
            }

            /// 字符串所有权版本。
            #[inline]
            pub fn into_string(self) -> String {
                self.as_str().to_owned()
            }

            /// 原始 u32 句柄(内部快速路径)。
            #[inline]
            pub fn handle(self) -> u32 {
                self.0
            }

            /// 查询已驻留字符串的句柄(不含驻留副作用)—— 字符串查找的入口。
            #[inline]
            pub fn lookup(s: &str) -> Option<Self> {
                crate::graph::id::handle_of(s).map(Self::from_handle)
            }

            /// 构造句柄(不经驻留)—— 仅用于已驻留句柄的透传。
            #[inline]
            pub(crate) fn from_handle(h: u32) -> Self {
                Self(h)
            }
        }

        impl std::fmt::Display for $T {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl std::ops::Deref for $T {
            type Target = str;
            #[inline]
            fn deref(&self) -> &str {
                self.as_str()
            }
        }

        impl AsRef<str> for $T {
            #[inline]
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl From<&str> for $T {
            fn from(s: &str) -> Self {
                Self::new(s)
            }
        }
        impl From<String> for $T {
            fn from(s: String) -> Self {
                Self::new(s)
            }
        }
        impl From<u32> for $T {
            fn from(h: u32) -> Self {
                Self::from_handle(h)
            }
        }

        impl PartialEq<&str> for $T {
            fn eq(&self, other: &&str) -> bool {
                self.as_str() == *other
            }
        }
        impl PartialEq<str> for $T {
            fn eq(&self, other: &str) -> bool {
                self.as_str() == other
            }
        }
        impl PartialEq<String> for $T {
            fn eq(&self, other: &String) -> bool {
                self.as_str() == other.as_str()
            }
        }
        impl PartialEq<$T> for &str {
            fn eq(&self, other: &$T) -> bool {
                *self == other.as_str()
            }
        }
        impl PartialEq<$T> for str {
            fn eq(&self, other: &$T) -> bool {
                self == other.as_str()
            }
        }
        impl PartialEq<$T> for String {
            fn eq(&self, other: &$T) -> bool {
                self.as_str() == other.as_str()
            }
        }

        // 词法序 —— 与 String 时代完全一致;句柄数值序会破坏排序语义。
        impl PartialOrd for $T {
            fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
                Some(self.as_str().cmp(other.as_str()))
            }
        }
        impl Ord for $T {
            fn cmp(&self, other: &Self) -> std::cmp::Ordering {
                self.as_str().cmp(other.as_str())
            }
        }

        impl serde::Serialize for $T {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }
        impl<'de> serde::Deserialize<'de> for $T {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let s = String::deserialize(deserializer)?;
                Ok(Self::new(s))
            }
        }
    };
}
impl_id_handle!(NodeId);
impl_id_handle!(EdgeId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_intern_dedup_content_addressed() {
        let a = NodeId::new("hello");
        let b = NodeId::new("hello");
        assert_eq!(a, b, "same string must map to same handle");
        assert_eq!(a.as_str(), "hello");
        assert_eq!(a.handle(), b.handle());
    }

    #[test]
    fn test_intern_distinct_strings_distinct_handles() {
        let a = NodeId::new("alpha");
        let b = NodeId::new("beta");
        assert_ne!(a, b);
        assert_ne!(a.handle(), b.handle());
        assert_eq!(a.as_str(), "alpha");
        assert_eq!(b.as_str(), "beta");
    }

    #[test]
    fn test_handle_of_non_inserting() {
        NodeId::new("present");
        assert_eq!(handle_of("present"), Some(NodeId::new("present").handle()));
        assert_eq!(handle_of("absent"), None, "non-interning lookup must not create");
    }

    #[test]
    fn test_handle_of_stable_across_analyses() {
        // 内容寻址:同一字符串两次驻留得到同一句柄(模拟重复分析同一项目)
        let h1 = NodeId::new("pkg/mod.rs::fn_main").handle();
        let h2 = NodeId::new("pkg/mod.rs::fn_main").handle();
        assert_eq!(h1, h2);
        assert_eq!(resolve(h1), "pkg/mod.rs::fn_main");
    }

    #[test]
    fn test_display_and_deref() {
        let id = NodeId::new("app.views.index");
        assert_eq!(format!("{}", id), "app.views.index");
        assert!(id.contains("views"), "Deref<Target=str> 应使 str 方法可用");
        assert_eq!(id.len(), "app.views.index".len());
        assert!(id.starts_with("app"));
        assert_eq!(id.to_lowercase(), "app.views.index");
    }

    #[test]
    fn test_partial_eq_with_str() {
        let id = NodeId::new("foo");
        assert!(id == "foo");
        assert!("foo" == id);
        assert!(id != "bar");
        let owned = "foo".to_string();
        assert!(id == owned);
        assert!(owned == id);
    }

    #[test]
    fn test_ord_is_lexical_not_handle_order() {
        // 句柄数值序依赖全局驻留顺序(测试间共享驻留器,不可控);
        // Ord 必须按词法序 —— 无论句柄怎么分配,a < z 恒成立。
        let z = NodeId::new("z");
        let a = NodeId::new("a");
        assert!(a < z, "词法序 a < z");
        assert!(z > a, "词法序 z > a");
        let mut v = vec![z, a];
        v.sort();
        assert_eq!(v[0].as_str(), "a");
        assert_eq!(v[1].as_str(), "z");
    }

    #[test]
    fn test_serde_roundtrip_string_wire() {
        let id = NodeId::new("wire.format::fn");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"wire.format::fn\"", "线格式必须是纯字符串");
        let back: NodeId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
        assert_eq!(back.as_str(), "wire.format::fn");
    }

    #[test]
    fn test_edge_id_separate_namespace() {
        let e = EdgeId::new("e1");
        let n = NodeId::new("n1");
        assert_eq!(e.as_str(), "e1");
        assert_eq!(n.as_str(), "n1");
        let ejson = serde_json::to_string(&e).unwrap();
        assert_eq!(ejson, "\"e1\"");
        let en: EdgeId = serde_json::from_str("\"e1\"").unwrap();
        assert_eq!(en, e);
    }

    #[test]
    fn test_lookup_goes_through_handle_of() {
        // R10-deep 无 Borrow<str>(Hash 不一致陷阱),字符串查找必须经 handle_of。
        let mut m: HashMap<NodeId, i32> = HashMap::new();
        m.insert(NodeId::new("n1"), 42);
        let h = handle_of("n1").unwrap();
        assert_eq!(m.get(&NodeId::from_handle(h)), Some(&42));
        assert!(handle_of("nope").is_none());
    }
}
