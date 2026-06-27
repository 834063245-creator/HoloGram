// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use serde_json::{json, Value};

/// Aggregate boundary markers from coupling + cycles + conflicts.
pub fn find_blindspots(
    coupling_l4: usize,
    cycle_count: usize,
    conflict_count: usize,
) -> Value {
    let mut boundaries = Vec::new();

    // L4 coupling → encapsulation boundary
    if coupling_l4 > 0 {
        boundaries.push(json!({
            "type": "encapsulation_penetration",
            "severity": "medium",
            "desc": format!("{} L4 deep coupling edges", coupling_l4)
        }));
    }

    // Cycles → architectural boundary
    if cycle_count > 0 {
        boundaries.push(json!({
            "type": "circular_dependency",
            "severity": if cycle_count > 5 { "high" } else { "medium" },
            "desc": format!("{} circular dependency cycles", cycle_count)
        }));
    }

    // Thread conflicts → concurrent access boundary
    if conflict_count > 0 {
        boundaries.push(json!({
            "type": "concurrent_access",
            "severity": if conflict_count > 3 { "high" } else { "low" },
            "desc": format!("{} shared resources with concurrent access", conflict_count)
        }));
    }

    json!({ "boundaries": boundaries, "count": boundaries.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blindspots_all_zero() {
        let r = find_blindspots(0, 0, 0);
        assert_eq!(r["count"], 0);
        assert!(r["boundaries"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_blindspots_l4_only() {
        let r = find_blindspots(3, 0, 0);
        assert_eq!(r["count"], 1);
        let b = &r["boundaries"][0];
        assert_eq!(b["type"], "encapsulation_penetration");
        assert_eq!(b["severity"], "medium");
    }

    #[test]
    fn test_blindspots_cycles_high_severity() {
        let r = find_blindspots(0, 10, 0);
        assert_eq!(r["count"], 1);
        let b = &r["boundaries"][0];
        assert_eq!(b["type"], "circular_dependency");
        assert_eq!(b["severity"], "high");
    }

    #[test]
    fn test_blindspots_cycles_medium_severity() {
        let r = find_blindspots(0, 3, 0);
        let b = &r["boundaries"][0];
        assert_eq!(b["severity"], "medium");
    }

    #[test]
    fn test_blindspots_conflicts_high() {
        let r = find_blindspots(0, 0, 10);
        let b = &r["boundaries"][0];
        assert_eq!(b["type"], "concurrent_access");
        assert_eq!(b["severity"], "high");
    }

    #[test]
    fn test_blindspots_conflicts_low() {
        let r = find_blindspots(0, 0, 2);
        let b = &r["boundaries"][0];
        assert_eq!(b["severity"], "low");
    }

    #[test]
    fn test_blindspots_all_three() {
        let r = find_blindspots(1, 1, 1);
        assert_eq!(r["count"], 3);
    }
}
