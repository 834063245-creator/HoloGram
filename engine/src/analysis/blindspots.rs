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
