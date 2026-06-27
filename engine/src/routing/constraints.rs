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
    for s in signals {
        let level = s["level"].as_u64().unwrap_or(0) as u8;
        let enabled = match level { 5=>true, 4=>config.routing_l4, 3=>config.routing_l3, 2=>config.routing_l2, _=>false };
        if enabled { violations.push(s.clone()); } else { passed += 1; }
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
}
