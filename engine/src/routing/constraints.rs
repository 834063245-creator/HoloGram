// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use serde_json::{json, Value};

pub struct ConstraintConfig {
    pub routing_l4: bool,
    pub routing_l3: bool,
    pub routing_l2: bool,
    pub blast_radius_max: usize,
    pub allowlist_files: Vec<String>,
    pub denylist_keywords: Vec<String>,
}

impl ConstraintConfig {
    pub fn defaults() -> Self {
        Self {
            routing_l4: true, routing_l3: true, routing_l2: true,
            blast_radius_max: 50,
            allowlist_files: vec![],
            denylist_keywords: vec!["DROP ".into(), "DELETE ".into(), "rm -rf".into(), "shutdown".into()],
        }
    }

    pub fn from_json(v: &Value) -> Self {
        let mut c = Self::defaults();
        if let Some(r) = v.get("routing") {
            c.routing_l4 = r.get("l4_silent").and_then(|v| v.as_bool()).unwrap_or(true);
            c.routing_l3 = r.get("l3_delayed").and_then(|v| v.as_bool()).unwrap_or(true);
            c.routing_l2 = r.get("l2_blast").and_then(|v| v.as_bool()).unwrap_or(true);
        }
        c
    }
}

pub fn check_constraints(signals: &[Value], config: &ConstraintConfig) -> Value {
    let mut violations = Vec::new();
    let mut passed = 0usize;
    let allowlist: Vec<&str> = config.allowlist_files.iter().map(|s| s.as_str()).collect();
    let denylist: Vec<&str> = config.denylist_keywords.iter().map(|s| s.as_str()).collect();
    for s in signals {
        let level = s["level"].as_u64().unwrap_or(0) as u8;
        // Description may be at s.signal.description (SignalGenerator) or s.desc (test flat format)
        let desc = s.get("signal").and_then(|sig| sig.get("description")).and_then(|v| v.as_str())
            .or_else(|| s.get("desc").and_then(|v| v.as_str()))
            .unwrap_or("");
        let denied = !denylist.is_empty() && denylist.iter().any(|k| desc.contains(k));
        // Affected nodes may be at s.signal.affected_nodes (SignalGenerator) or absent (flat format)
        let files: Vec<&str> = s.get("signal")
            .and_then(|sig| sig.get("affected_nodes"))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let allowed = !allowlist.is_empty() && !files.is_empty()
            && files.iter().all(|f| allowlist.iter().any(|a| f.contains(a)));
        let enabled = match level { 5 => true, 4 => config.routing_l4, 3 => config.routing_l3, 2 => config.routing_l2, _ => false };
        if denied || (enabled && !allowed) {
            violations.push(s.clone());
        } else {
            passed += 1;
        }
    }
    json!({ "passed": violations.is_empty(), "violations": violations, "violation_count": violations.len(), "passed_count": passed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_defaults() {
        let c = ConstraintConfig::defaults();
        assert!(c.routing_l4);
        assert!(c.routing_l3);
        assert!(c.routing_l2);
        assert_eq!(c.blast_radius_max, 50);
        assert!(c.allowlist_files.is_empty());
        assert_eq!(c.denylist_keywords.len(), 4);
    }

    #[test]
    fn test_from_json_partial() {
        let v = json!({"routing": {"l4_silent": false}});
        let c = ConstraintConfig::from_json(&v);
        assert!(!c.routing_l4);
        assert!(c.routing_l3); // unchanged
        assert!(c.routing_l2); // unchanged
    }

    #[test]
    fn test_check_constraints_empty() {
        let c = ConstraintConfig::defaults();
        let r = check_constraints(&[], &c);
        assert!(r["passed"].as_bool().unwrap());
        assert_eq!(r["violation_count"], 0);
    }

    #[test]
    fn test_check_constraints_l5_always_enabled() {
        let mut c = ConstraintConfig::defaults();
        c.routing_l4 = false;
        c.routing_l3 = false;
        c.routing_l2 = false;
        let signals = vec![json!({"level": 5, "desc": "irreversible"})];
        let r = check_constraints(&signals, &c);
        assert_eq!(r["violation_count"], 1, "L5 is always enabled");
    }

    #[test]
    fn test_check_constraints_respects_config() {
        let mut c = ConstraintConfig::defaults();
        c.routing_l4 = false;
        let signals = vec![
            json!({"level": 4, "desc": "L4 coupling"}),
            json!({"level": 3, "desc": "L3 shared data"}),
        ];
        let r = check_constraints(&signals, &c);
        assert_eq!(r["violation_count"], 1, "L4 disabled, L3 still enabled");
        assert_eq!(r["passed_count"], 1);
    }

    #[test]
    fn test_check_constraints_unknown_level_ignored() {
        let c = ConstraintConfig::defaults();
        let signals = vec![json!({"level": 99, "desc": "bogus"})];
        let r = check_constraints(&signals, &c);
        assert_eq!(r["violation_count"], 0);
        assert_eq!(r["passed_count"], 1);
    }

    #[test]
    fn test_allowlist_filters_signals() {
        let mut c = ConstraintConfig::defaults();
        c.allowlist_files = vec!["src/legacy/".into()];
        let signals = vec![
            json!({"signal": {"description": "L4 coupling edge", "affected_nodes": ["src/legacy/a.rs"]}, "level": 4}),
            json!({"signal": {"description": "L3 shared data", "affected_nodes": ["src/new/b.rs"]}, "level": 3}),
        ];
        let r = check_constraints(&signals, &c);
        assert_eq!(r["violation_count"], 1, "legacy file allowed, new file still flagged");
    }

    #[test]
    fn test_denylist_triggers_on_keyword() {
        let mut c = ConstraintConfig::defaults();
        c.routing_l4 = false;
        let signals = vec![
            json!({"signal": {"description": "Found a dangerous DELETE statement", "affected_nodes": []}, "level": 4}),
        ];
        let r = check_constraints(&signals, &c);
        assert_eq!(r["violation_count"], 1, "denylist keyword should override level toggle");
    }
}
