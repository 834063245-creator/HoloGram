// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use serde::{Deserialize, Serialize};

/// Node kind — mirrors Python NodeType enum.
/// O(1) degree tracking (fixes the O(V×E) bug in v3 community detection).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Symbol,    // generic / uncategorized
    Function,  // function / method / constructor
    Class,     // class / struct / enum
    Module,    // namespace / package
    File,      // source file module
    Interface, // interface / trait / type alias
    Medium,    // storage / IO
    Temporal,  // async / timer
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
            NodeKind::Medium => "medium",
            NodeKind::Temporal => "temporal",
        }
    }
}

/// A node in the dependency graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    /// Source file location: "src/main.py" or "src/main.rs:42"
    pub location: Option<String>,
    /// Arbitrary metadata
    pub properties: serde_json::Value,
    /// Pre-computed degree (fixes O(V×E) community label bug)
    #[serde(default)]
    pub out_degree: u32,
    #[serde(default)]
    pub in_degree: u32,
    /// Pre-computed 3D position (optional, for Unity)
    pub position: Option<[f32; 3]>,
    /// Community ID (assigned by community detection)
    pub community_id: Option<usize>,
}

impl Node {
    pub fn new(id: impl Into<String>, name: impl Into<String>, kind: NodeKind) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            kind,
            location: None,
            properties: serde_json::Value::Object(Default::default()),
            out_degree: 0,
            in_degree: 0,
            position: None,
            community_id: None,
        }
    }

    /// Stable key for deduplication: "location::name::kind"
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
        // ponytail: verify all 8 NodeKind variants survive string round-trip.
        // The SQLite layer stores kind as TEXT via as_str(); this test ensures
        // every variant maps back to the correct enum value.
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
