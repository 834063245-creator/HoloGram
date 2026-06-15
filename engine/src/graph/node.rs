use serde::{Deserialize, Serialize};

/// Node kind — mirrors Python NodeType enum.
/// O(1) degree tracking (fixes the O(V×E) bug in v3 community detection).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Symbol,
    Medium,
    Temporal,
}

impl NodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeKind::Symbol => "symbol",
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
