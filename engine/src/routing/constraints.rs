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
