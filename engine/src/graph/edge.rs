// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

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
    pub fn from_str(s: &str) -> Option<EdgeKind> {
        match s {
            "imports" => Some(EdgeKind::Imports),
            "calls" => Some(EdgeKind::Calls),
            "inherits" => Some(EdgeKind::Inherits),
            "defines" => Some(EdgeKind::Defines),
            "reads" => Some(EdgeKind::Reads),
            "writes" => Some(EdgeKind::Writes),
            "shares" => Some(EdgeKind::Shares),
            "triggers" => Some(EdgeKind::Triggers),
            "awaits" => Some(EdgeKind::Awaits),
            "sequences" => Some(EdgeKind::Sequences),
            _ => None,
        }
    }

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

    /// CSR storage: pack EdgeKind into u8 (0–9).
    pub fn to_u8(self) -> u8 {
        match self {
            EdgeKind::Imports => 0,
            EdgeKind::Calls => 1,
            EdgeKind::Inherits => 2,
            EdgeKind::Defines => 3,
            EdgeKind::Reads => 4,
            EdgeKind::Writes => 5,
            EdgeKind::Shares => 6,
            EdgeKind::Triggers => 7,
            EdgeKind::Awaits => 8,
            EdgeKind::Sequences => 9,
        }
    }

    /// CSR storage: unpack u8 back to EdgeKind.
    pub fn from_u8(v: u8) -> EdgeKind {
        match v {
            0 => EdgeKind::Imports,
            1 => EdgeKind::Calls,
            2 => EdgeKind::Inherits,
            3 => EdgeKind::Defines,
            4 => EdgeKind::Reads,
            5 => EdgeKind::Writes,
            6 => EdgeKind::Shares,
            7 => EdgeKind::Triggers,
            8 => EdgeKind::Awaits,
            9 => EdgeKind::Sequences,
            _ => EdgeKind::Calls, // ponytail: default to Calls for forward compat
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

    /// Temporal delay in seconds (for temporal edges)
    #[serde(default)]
    pub temporal_delay_sec: Option<f64>,

    /// Resolved via LSP type analysis (vs. same-name heuristic)
    #[serde(default)]
    pub lsp_resolved: bool,
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
            temporal_delay_sec: None,
            lsp_resolved: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_edge_new_defaults() {
        let e = Edge::new("e1", "a", "b", EdgeKind::Calls);
        assert_eq!(e.id, "e1");
        assert_eq!(e.source, "a");
        assert_eq!(e.target, "b");
        assert!(matches!(e.kind, EdgeKind::Calls));
        assert_eq!(e.coupling_depth, 0);
        assert!(!e.cross_file);
        assert!(e.temporal_delay_sec.is_none());
    }

    #[test]
    fn test_edge_kind_as_str() {
        assert_eq!(EdgeKind::Imports.as_str(), "imports");
        assert_eq!(EdgeKind::Calls.as_str(), "calls");
        assert_eq!(EdgeKind::Inherits.as_str(), "inherits");
        assert_eq!(EdgeKind::Defines.as_str(), "defines");
        assert_eq!(EdgeKind::Reads.as_str(), "reads");
        assert_eq!(EdgeKind::Writes.as_str(), "writes");
        assert_eq!(EdgeKind::Shares.as_str(), "shares");
        assert_eq!(EdgeKind::Triggers.as_str(), "triggers");
        assert_eq!(EdgeKind::Awaits.as_str(), "awaits");
        assert_eq!(EdgeKind::Sequences.as_str(), "sequences");
    }

    #[test]
    fn test_all_edge_kinds_covered() {
        // All 10 edge kinds should have distinct string representations
        let all = [
            EdgeKind::Imports, EdgeKind::Calls, EdgeKind::Inherits,
            EdgeKind::Defines, EdgeKind::Reads, EdgeKind::Writes,
            EdgeKind::Shares, EdgeKind::Triggers, EdgeKind::Awaits,
            EdgeKind::Sequences,
        ];
        let strs: Vec<&str> = all.iter().map(|k| k.as_str()).collect();
        // All unique
        let mut sorted = strs.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 10, "all edge kinds must have unique strings");
    }

    #[test]
    fn test_edge_with_coupling_depth() {
        let mut e = Edge::new("e1", "a", "b", EdgeKind::Writes);
        e.coupling_depth = 4;
        assert_eq!(e.coupling_depth, 4);
    }

    #[test]
    fn test_edge_cross_file() {
        let mut e = Edge::new("e1", "a", "b", EdgeKind::Imports);
        e.cross_file = true;
        assert!(e.cross_file);
    }

    #[test]
    fn test_edge_temporal_delay() {
        let mut e = Edge::new("e1", "a", "b", EdgeKind::Triggers);
        e.temporal_delay_sec = Some(0.5);
        assert_eq!(e.temporal_delay_sec, Some(0.5));
    }

    #[test]
    fn test_edge_serde_roundtrip() {
        let mut e = Edge::new("e1", "src/a.rs", "src/b.rs", EdgeKind::Imports);
        e.coupling_depth = 2;
        e.cross_file = true;
        e.temporal_delay_sec = Some(1.5);
        let json = serde_json::to_string(&e).unwrap();
        let back: Edge = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "e1");
        assert_eq!(back.source, "src/a.rs");
        assert_eq!(back.target, "src/b.rs");
        assert!(matches!(back.kind, EdgeKind::Imports));
        assert_eq!(back.coupling_depth, 2);
        assert!(back.cross_file);
        assert_eq!(back.temporal_delay_sec, Some(1.5));
    }
}
