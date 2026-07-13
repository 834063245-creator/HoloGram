// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

/// Root of hologram.constraints.yaml.
#[derive(Debug, Clone, Deserialize, Default)]
struct ConstraintsFile {
    #[serde(default)]
    constraints: ConstraintsBlock,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ConstraintsBlock {
    #[serde(default)]
    routing: RoutingBlock,
    #[serde(default)]
    thresholds: ThresholdsBlock,
    #[serde(default)]
    allowlist: AllowlistBlock,
    #[serde(default)]
    denylist: DenylistBlock,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct RoutingBlock {
    #[serde(default = "default_true")]
    l5_irreversible: bool,
    #[serde(default = "default_true")]
    l4_silent: bool,
    #[serde(default = "default_true")]
    l3_delayed: bool,
    #[serde(default = "default_true")]
    l2_blast: bool,
    #[serde(default)]
    l1_visible: bool,
}

impl Default for RoutingBlock {
    fn default() -> Self {
        Self {
            l5_irreversible: true,
            l4_silent: true,
            l3_delayed: true,
            l2_blast: true,
            l1_visible: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct ThresholdsBlock {
    #[serde(default = "default_blast_radius")]
    blast_radius_max: usize,
    #[serde(default)]
    cross_community_tolerance: usize,
    #[serde(default)]
    api_signature_tolerance: usize,
    #[serde(default)]
    l4_penetration_tolerance: usize,
    #[serde(default)]
    l4_threshold_change_tolerance: usize,
}

impl Default for ThresholdsBlock {
    fn default() -> Self {
        Self {
            blast_radius_max: 50,
            cross_community_tolerance: 0,
            api_signature_tolerance: 0,
            l4_penetration_tolerance: 0,
            l4_threshold_change_tolerance: 0,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[allow(dead_code)]
struct AllowlistBlock {
    #[serde(default)]
    modules: Vec<String>,
    #[serde(default)]
    files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DenylistBlock {
    #[serde(default)]
    keywords: Vec<String>,
}

fn default_true() -> bool { true }
fn default_blast_radius() -> usize { 50 }

/// Runtime constraint config — flattened from the YAML structure.
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

    /// Load from a hologram.constraints.yaml file.
    /// Falls back to defaults() if the file is missing or malformed.
    pub fn from_yaml_file(project_root: &Path) -> Self {
        let yaml_path = project_root.join("hologram.constraints.yaml");
        match std::fs::read_to_string(&yaml_path) {
            Ok(contents) => {
                match serde_yaml::from_str::<ConstraintsFile>(&contents) {
                    Ok(f) => Self::from_parsed(&f),
                    Err(e) => {
                        tracing::warn!(
                            path = %yaml_path.display(),
                            err = %e,
                            "[constraints] yaml parse failed — using defaults"
                        );
                        Self::defaults()
                    }
                }
            }
            Err(_) => {
                tracing::debug!(
                    "[constraints] no {} found — using defaults",
                    yaml_path.display()
                );
                Self::defaults()
            }
        }
    }

    fn from_parsed(f: &ConstraintsFile) -> Self {
        let allowlist_files: Vec<String> = f.constraints
            .allowlist
            .files
            .iter()
            .map(|g| format!("file:{}", g))
            .collect();

        let mut denylist = f.constraints.denylist.keywords.clone();
        // Always keep the built-in dangerous keywords
        for kw in &["DROP ", "DELETE ", "rm -rf", "shutdown"] {
            if !denylist.iter().any(|d| d.contains(kw)) {
                denylist.push(kw.to_string());
            }
        }

        Self {
            routing_l4: f.constraints.routing.l4_silent,
            routing_l3: f.constraints.routing.l3_delayed,
            routing_l2: f.constraints.routing.l2_blast,
            blast_radius_max: f.constraints.thresholds.blast_radius_max,
            allowlist_files,
            denylist_keywords: denylist,
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

    #[test]
    fn test_from_yaml_parses_real_config() {
        // Simulate the real hologram.constraints.yaml structure
        let yaml = r#"
constraints:
  routing:
    l4_silent: true
    l3_delayed: false
    l2_blast: true
  thresholds:
    blast_radius_max: 20
  allowlist:
    files:
      - "docs/*.md"
      - "tests/*.py"
  denylist:
    keywords:
      - "password"
      - "secret"
      - "token"
"#;
        let f: ConstraintsFile = serde_yaml::from_str(yaml).unwrap();
        let c = ConstraintConfig::from_parsed(&f);
        assert!(c.routing_l4);
        assert!(!c.routing_l3);
        assert!(c.routing_l2);
        assert_eq!(c.blast_radius_max, 20);
        assert_eq!(c.allowlist_files, vec!["file:docs/*.md", "file:tests/*.py"]);
        assert!(c.denylist_keywords.contains(&"password".to_string()));
        assert!(c.denylist_keywords.contains(&"secret".to_string()));
        // Built-in dangerous keywords always appended
        assert!(c.denylist_keywords.contains(&"rm -rf".to_string()));
    }

    #[test]
    fn test_from_yaml_empty_defaults() {
        let yaml = "constraints: {}";
        let f: ConstraintsFile = serde_yaml::from_str(yaml).unwrap();
        let c = ConstraintConfig::from_parsed(&f);
        // Should have all defaults
        assert!(c.routing_l4);
        assert!(c.routing_l3);
        assert!(c.routing_l2);
        assert_eq!(c.blast_radius_max, 50);
        assert!(c.allowlist_files.is_empty());
        assert!(!c.denylist_keywords.is_empty()); // built-in keywords
    }
}