// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use serde::{Deserialize, Serialize};

/// Node 类型 — 对应 Python 的 NodeType 枚举。
/// O(1) 度数追踪（修复了 v3 社区检测中的 O(V×E) 性能问题）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Symbol,    // 通用 / 未分类
    Function,  // 函数 / 方法 / 构造函数
    Class,     // 类 / 结构体 / 枚举
    Module,    // 命名空间 / 包
    File,      // 源文件模块
    Interface, // 接口 / trait / 类型别名
    Variable,  // 变量 / 常量 / 字段
    Medium,    // 存储 / IO
    Temporal,  // 异步 / 定时器
}

impl NodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeKind::Symbol => "symbol",
            NodeKind::Function => "function",
            NodeKind::Class => "class",
            NodeKind::Module => "module",
            NodeKind::File => "file",
            NodeKind::Interface => "interface",
            NodeKind::Variable => "variable",
            NodeKind::Medium => "medium",
            NodeKind::Temporal => "temporal",
        }
    }
}

/// 依赖图中的节点。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    /// 源文件位置："src/main.py" 或 "src/main.rs:42"
    pub location: Option<String>,
    /// 该节点的源码文本（函数体、类定义等）
    /// 在解析时填充；供向量索引用于语义搜索。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// 任意元数据
    pub properties: serde_json::Value,
        /// 预计算的度数（修复 O(V×E) 社区标签性能问题）
    #[serde(default)]
    pub out_degree: u32,
    #[serde(default)]
    pub in_degree: u32,
    /// 剔除 defines 边后的入度。find_unused 用此字段判断，
    /// 避免"唯一入边是自身文件 defines 边"的假阳性。
    #[serde(default)]
    pub non_defines_in_degree: u32,
    /// 预计算的 3D 位置（可选，用于 Unity）
    pub position: Option<[f32; 3]>,
    /// 社区 ID（由社区检测分配）
    pub community_id: Option<usize>,
}

impl Node {
    pub fn new(id: impl Into<String>, name: impl Into<String>, kind: NodeKind) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            kind,
            location: None,
            snippet: None,
            properties: serde_json::Value::Object(Default::default()),
            out_degree: 0,
            in_degree: 0,
            non_defines_in_degree: 0,
            position: None,
            community_id: None,
        }
    }

    /// 去重用的稳定键："location::name::kind"
    pub fn loc_key(&self) -> String {
        format!(
            "{}::{}::{}",
            self.location.as_deref().unwrap_or(""),
            self.name,
            self.kind.as_str()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_new_defaults() {
        let n = Node::new("n1", "main", NodeKind::Symbol);
        assert_eq!(n.id, "n1");
        assert_eq!(n.name, "main");
        assert!(matches!(n.kind, NodeKind::Symbol));
        assert!(n.location.is_none());
        assert_eq!(n.out_degree, 0);
        assert_eq!(n.in_degree, 0);
        assert!(n.position.is_none());
        assert!(n.community_id.is_none());
    }

    #[test]
    fn test_node_with_location() {
        let mut n = Node::new("n1", "main", NodeKind::Symbol);
        n.location = Some("src/main.rs".into());
        assert_eq!(n.location.as_deref(), Some("src/main.rs"));
    }

    #[test]
    fn test_node_kind_as_str() {
        assert_eq!(NodeKind::Symbol.as_str(), "symbol");
        assert_eq!(NodeKind::Function.as_str(), "function");
        assert_eq!(NodeKind::Class.as_str(), "class");
        assert_eq!(NodeKind::Module.as_str(), "module");
        assert_eq!(NodeKind::File.as_str(), "file");
        assert_eq!(NodeKind::Interface.as_str(), "interface");
        assert_eq!(NodeKind::Medium.as_str(), "medium");
        assert_eq!(NodeKind::Temporal.as_str(), "temporal");
    }

    #[test]
    fn test_node_kind_as_str_roundtrip() {
        // ponytail: 验证所有 8 种 NodeKind 变体能通过字符串往返。
        // SQLite 层通过 as_str() 将 kind 存储为 TEXT；此测试确保
        // 每个变体都能正确映射回对应的枚举值。
        let kinds = vec![
            NodeKind::Symbol,
            NodeKind::Function,
            NodeKind::Class,
            NodeKind::Module,
            NodeKind::File,
            NodeKind::Interface,
            NodeKind::Medium,
            NodeKind::Temporal,
        ];
        for original in kinds {
            let s = original.as_str();
            let parsed = match s {
                "symbol" => NodeKind::Symbol,
                "function" => NodeKind::Function,
                "class" => NodeKind::Class,
                "module" => NodeKind::Module,
                "file" => NodeKind::File,
                "interface" => NodeKind::Interface,
                "medium" => NodeKind::Medium,
                "temporal" => NodeKind::Temporal,
                _ => panic!("unknown kind: {}", s),
            };
            assert_eq!(std::mem::discriminant(&parsed), std::mem::discriminant(&original),
                "kind {:?} → '{s}' did not round-trip back to same variant", original);
        }
    }

    #[test]
    fn test_loc_key_with_location() {
        let mut n = Node::new("n1", "handle_request", NodeKind::Symbol);
        n.location = Some("src/handlers.py".into());
        assert_eq!(n.loc_key(), "src/handlers.py::handle_request::symbol");
    }

    #[test]
    fn test_loc_key_without_location() {
        let n = Node::new("n1", "global_var", NodeKind::Symbol);
        assert_eq!(n.loc_key(), "::global_var::symbol");
    }

    #[test]
    fn test_loc_key_different_kinds() {
        let mut sym = Node::new("s1", "db", NodeKind::Medium);
        sym.location = Some("store.rs".into());
        assert_eq!(sym.loc_key(), "store.rs::db::medium");

        let mut tmp = Node::new("t1", "timer", NodeKind::Temporal);
        tmp.location = Some("scheduler.rs".into());
        assert_eq!(tmp.loc_key(), "scheduler.rs::timer::temporal");
    }

    #[test]
    fn test_loc_key_deduplication_same_loc_name_kind() {
        let mut a = Node::new("id_a", "fn", NodeKind::Symbol);
        a.location = Some("lib.rs".into());
        let mut b = Node::new("id_b", "fn", NodeKind::Symbol);
        b.location = Some("lib.rs".into());
        assert_eq!(a.loc_key(), b.loc_key(), "same loc+name+kind should produce same key");
    }

    #[test]
    fn test_node_serde_roundtrip() {
        let mut n = Node::new("n1", "test_fn", NodeKind::Symbol);
        n.location = Some("src/test.rs:42".into());
        n.out_degree = 3;
        n.in_degree = 1;
        n.community_id = Some(0);
        let json = serde_json::to_string(&n).unwrap();
        let back: Node = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "n1");
        assert_eq!(back.name, "test_fn");
        assert!(matches!(back.kind, NodeKind::Symbol));
        assert_eq!(back.location.as_deref(), Some("src/test.rs:42"));
        assert_eq!(back.out_degree, 3);
        assert_eq!(back.in_degree, 1);
        assert_eq!(back.community_id, Some(0));
    }
}