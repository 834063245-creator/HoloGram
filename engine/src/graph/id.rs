// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use serde::{Deserialize, Serialize};

/// 节点 ID 的强类型句柄。R0~R9 内部为 String;R10 起 Graph 容器与热路径
/// 索引 u32 化,但 NodeId 本身**永远保持字符串句柄**——
/// 这保证 as_str() 签名全程稳定,消费方零感知。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)] // 序列化表现 = 纯字符串,磁盘/线格式零漂移
pub struct NodeId(String);

/// 边 ID 的强类型句柄。设计同 NodeId。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EdgeId(String);

macro_rules! impl_id {
    ($T:ident) => {
        impl $T {
            pub fn new(s: impl Into<String>) -> Self {
                Self(s.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
            pub fn into_string(self) -> String {
                self.0
            }
        }
        impl std::fmt::Display for $T {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl From<String> for $T {
            fn from(s: String) -> Self {
                Self(s)
            }
        }
        impl From<&str> for $T {
            fn from(s: &str) -> Self {
                Self(s.to_string())
            }
        }
        impl AsRef<str> for $T {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
        impl std::borrow::Borrow<str> for $T {
            fn borrow(&self) -> &str {
                &self.0
            }
        }
    };
}
impl_id!(NodeId);
impl_id!(EdgeId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_id_serde_transparent() {
        // serde(transparent): 序列化表现必须是纯字符串,磁盘格式零漂移
        let id = NodeId::new("a.rs.fn_a");
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"a.rs.fn_a\"");
        let back: NodeId = serde_json::from_str("\"a.rs.fn_a\"").unwrap();
        assert_eq!(back.as_str(), "a.rs.fn_a");
    }

    #[test]
    fn test_id_borrow_str_lookup() {
        // Borrow<str>: HashMap<NodeId, _>.get(&str) 可用,迁移期关键
        let mut m = std::collections::HashMap::new();
        m.insert(EdgeId::new("e1"), 42);
        assert_eq!(m.get("e1"), Some(&42));
    }
}
