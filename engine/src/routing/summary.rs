use serde_json::{json, Value};

pub fn generate_summary(changed_files: &[String], violations: &[Value], coupling_l4: usize, cycle_count: usize) -> Value {
    let l5 = violations.iter().filter(|v| v["level"].as_u64() == Some(5)).count();
    let l4 = violations.iter().filter(|v| v["level"].as_u64() == Some(4)).count();
    let l3 = violations.iter().filter(|v| v["level"].as_u64() == Some(3)).count();
    let l2 = violations.iter().filter(|v| v["level"].as_u64() == Some(2)).count();
    let passed = violations.is_empty();
    let one_line = if passed {
        "No violations detected — all checks passed.".to_string()
    } else {
        format!("{} violations: L5={} L4={} L3={} L2={} (coupling_L4={} cycles={})",
            violations.len(), l5, l4, l3, l2, coupling_l4, cycle_count)
    };
    json!({
        "passed": passed, "one_line": one_line,
        "violations_by_level": { "5": l5, "4": l4, "3": l3, "2": l2 },
        "changed_files": changed_files, "total_violations": violations.len(),
        "coupling_l4": coupling_l4, "cycles": cycle_count
    })
}
