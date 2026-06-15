use crate::analysis::{coupling_report, detect_cycles};
use crate::graph::Graph;
use crate::routing::{constraints::{ConstraintConfig, check_constraints}, signals::SignalGenerator, summary::generate_summary};
use serde_json::{json, Value};

/// run_full_check — equivalent of Python preflight.py run_full_check()
pub fn run_full_check(before: &Graph, after: &Graph, changed_files: &[String], _project_root: &str) -> Value {
    let coupling = coupling_report(after, ""); // full graph
    let l4_count = coupling["L4"].as_u64().unwrap_or(0) as usize;
    let cycles = detect_cycles(after);
    let cycle_count = cycles.len();
    let signals = SignalGenerator::new().generate(before, after, changed_files, l4_count, cycle_count);
    let config = ConstraintConfig::defaults();
    let constraint_result = check_constraints(&signals, &config);
    let violations: Vec<Value> = constraint_result["violations"].as_array().cloned().unwrap_or_default();
    let summary = generate_summary(changed_files, &violations, l4_count, cycle_count);

    json!({
        "passed": summary["passed"],
        "one_line": summary["one_line"],
        "timestamp": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "changed_files": changed_files,
        "total_changed_files": changed_files.len(),
        "l5_violations": violations.iter().filter(|v| v["level"]==5).collect::<Vec<_>>(),
        "l4_violations": violations.iter().filter(|v| v["level"]==4).collect::<Vec<_>>(),
        "l3_violations": violations.iter().filter(|v| v["level"]==3).collect::<Vec<_>>(),
        "l2_violations": violations.iter().filter(|v| v["level"]==2).collect::<Vec<_>>(),
        "passed_checks": Vec::<String>::new(),
        "blast_radius": 0u32,
        "cross_community_edges": 0u32,
        "new_cycles": cycle_count as u32,
        "new_thread_conflicts": 0u32,
        "api_signature_changes": 0u32,
        "coupling_l4": l4_count as u32,
        "cycles_detected": cycle_count as u32,
        "signals_count": signals.len() as u32,
        "violation_count": violations.len() as u32,
    })
}
