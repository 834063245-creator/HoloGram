use serde::{Deserialize, Serialize};

/// Edge kind — classifies the nature of the dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    /// Structural: imports, calls, inheritance
    Imports,
    Calls,
    Inherits,
    Defines,
    /// Data flow: reads, writes, shares
    Reads,
    Writes,
    Shares,
    /// Temporal: triggers, awaits, sequences
    Triggers,
    Awaits,
    Sequences,
}

impl EdgeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EdgeKind::Imports => "imports",
            EdgeKind::Calls => "calls",
            EdgeKind::Inherits => "inherits",
            EdgeKind::Defines => "defines",
            EdgeKind::Reads => "reads",
            EdgeKind::Writes => "writes",
            EdgeKind::Shares => "shares",
            EdgeKind::Triggers => "triggers",
            EdgeKind::Awaits => "awaits",
            EdgeKind::Sequences => "sequences",
        }
    }
}

/// An edge in the dependency graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub kind: EdgeKind,
    /// L1-L4 coupling depth
    #[serde(default)]
    pub coupling_depth: u8,
    /// Cross-file edge?
    #[serde(default)]
    pub cross_file: bool,
    /// Direction: "forward" | "backward"
    #[serde(default = "default_direction")]
    pub direction: String,
}

fn default_direction() -> String {
    "forward".into()
}

impl Edge {
    pub fn new(
        id: impl Into<String>,
        source: impl Into<String>,
        target: impl Into<String>,
        kind: EdgeKind,
    ) -> Self {
        Self {
            id: id.into(),
            source: source.into(),
            target: target.into(),
            kind,
            coupling_depth: 0,
            cross_file: false,
            direction: "forward".into(),
        }
    }
}
