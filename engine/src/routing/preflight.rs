// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::analysis::{coupling_report, detect_cycles, dataflow_engine::query_dataflow_files};
use crate::community::louvain::detect_communities;
use crate::graph::{Graph, NodeKind};
use crate::pipeline::discovery::is_ignored_path;
use crate::routing::{constraints::{ConstraintConfig, check_constraints}, signals::{DataflowSignalCounts, SignalGenerator}, summary::generate_summary};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

/// 每项目 graph 快照路径，用作简报基线。
pub fn baseline_path(project_root: &Path) -> PathBuf {
    project_root.join(".hologram").join("baseline.json")
}

/// 违规 ID 快照路径 — 来自上次非静默检查的 ID。
fn baseline_violations_path(project_root: &Path) -> PathBuf {
    project_root.join(".hologram").join("baseline_violations.json")
}

pub fn load_baseline(project_root: &Path) -> Graph {
    let path = baseline_path(project_root);
    if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Graph::default()
    }
}

fn load_previous_violation_ids(project_root: &Path) -> Vec<String> {
    let path = baseline_violations_path(project_root);
    if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    }
}

fn save_violation_ids(project_root: &Path, ids: &[String]) {
    let dir = project_root.join(".hologram");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_string_pretty(ids) {
        let _ = std::fs::write(baseline_violations_path(project_root), json);
    }
}

/// 从违规 Value 对象切片中提取违规 ID。
fn extract_violation_ids(violations: &[Value]) -> Vec<String> {
    violations.iter()
        .filter_map(|v| v["signal"]["violation_id"].as_str().map(String::from))
        .collect()
}

pub fn save_baseline(project_root: &Path, graph: &Graph) {
    let dir = project_root.join(".hologram");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_string_pretty(graph) {
        let _ = std::fs::write(baseline_path(project_root), json);
    }
}

/// 用于时间线往返的完整 CheckResult 属性（历史简报点击）。
pub fn check_timeline_props(result: &Value) -> Value {
    json!({
        "passed": result["passed"],
        "timestamp": result["timestamp"],
        "changed_files": result["changed_files"],
        "total_changed_files": result["total_changed_files"],
        "l5_violations": result["l5_violations"],
        "l4_violations": result["l4_violations"],
        "l3_violations": result["l3_violations"],
        "l2_violations": result["l2_violations"],
        "passed_checks": result["passed_checks"],
        "blast_radius": result["blast_radius"],
        "cross_community_edges": result["cross_community_edges"],
        "new_cycles": result["new_cycles"],
        "new_thread_conflicts": result["new_thread_conflicts"],
        "api_signature_changes": result["api_signature_changes"],
        "violation_count": result["violation_count"],
        "new_violations": result["new_violations"],
        "resolved_violations": result["resolved_violations"],
        "persistent_violations": result["persistent_violations"],
    })
}

fn quiet_check_result(changed_files: &[String], one_line: &str, baseline_seed: bool) -> Value {
    json!({
        "passed": true,
        "one_line": one_line,
        "timestamp": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "changed_files": changed_files,
        "total_changed_files": changed_files.len(),
        "l5_violations": [],
        "l4_violations": [],
        "l3_violations": [],
        "l2_violations": [],
        "passed_checks": Vec::<String>::new(),
        "blast_radius": 0u32,
        "cross_community_edges": 0u32,
        "new_cycles": 0u32,
        "new_thread_conflicts": 0u32,
        "api_signature_changes": 0u32,
        "coupling_l4": 0u32,
        "cycles_detected": 0u32,
        "signals_count": 0u32,
        "violation_count": 0u32,
        "new_violations": 0u32,
        "resolved_violations": 0u32,
        "persistent_violations": 0u32,
        "quiet": !baseline_seed,
        "baseline_seed": baseline_seed,
    })
}

/// run_full_check — 等价于 Python preflight.py 的 run_full_check()
pub fn run_full_check(before: &Graph, after: &Graph, changed_files: &[String], _project_root: &str) -> Value {
    // 过滤掉被忽略目录（.hologram、.git、node_modules 等）的变更
    // 这些是工具/运行时产物 — 非用户源码 — 不应在简报中
    // 产生约束违规。
    let changed_files: Vec<String> = changed_files.iter()
        .filter(|f| !is_ignored_path(f))
        .cloned()
        .collect();
    let changed_files = changed_files.as_slice();

    // 首次打开：静默建立基线 — 不审计整个项目。
    if before.node_count() == 0 && after.node_count() > 0 && changed_files.is_empty() {
        return quiet_check_result(changed_files, "基线已建立，等待文件变更", true);
    }

    // 无文件变更 → 无需报告，不论 graph 大小差异如何。
    // 没有 changed_files 时的 graph 大小差异意味着 graph 被重建（例如
    // 重新分析发现了更多节点），而非用户编辑。在此情况下报告 L2/L4
    // 差异是过期基线的误报。
    if changed_files.is_empty() {
        return quiet_check_result(changed_files, "无新变更", false);
    }

    let coupling = coupling_report(after, ""); // full graph
    let l4_count = coupling["L4"].as_u64().unwrap_or(0) as usize;
    let cycles = detect_cycles(after);
    let cycle_count = cycles.len();
    let cycles_before = detect_cycles(before).len();

    // ── 数据流：对 changed_files 运行以生成 L3/L4 信号 ──
    let df_counts: Option<DataflowSignalCounts> = if !changed_files.is_empty() {
        let paths: Vec<std::path::PathBuf> = changed_files.iter()
            .map(std::path::PathBuf::from)
            .collect();
        let df_results = query_dataflow_files(&paths);
        let mut l3_shared = 0usize; let mut l3_reads = 0usize; let mut l3_writes = 0usize;
        let mut l4_triggers = 0usize; let mut l4_awaits = 0usize; let mut l4_seqs = 0usize;
        for r in &df_results {
            if let Ok(df) = &r.result {
                l3_shared += df.shared.len();
                for s in &df.scopes {
                    l3_reads += s.reads.len();
                    l3_writes += s.writes.len();
                    l4_triggers += s.triggers.len();
                    l4_awaits += s.awaits_callbacks.len();
                    l4_seqs += s.sequence_calls.len();
                }
            }
        }
        let _df_l4_total = l4_triggers + l4_awaits + l4_seqs;
        Some(DataflowSignalCounts {
            l3_shared_vars: l3_shared, l3_reads, l3_writes,
            l4_triggers, l4_awaits, l4_sequences: l4_seqs,
        })
    } else {
        None
    };
    // 有数据流 L4 计数时使用，否则回退到 graph 边
    let effective_l4 = df_counts.as_ref()
        .map(|d| d.l4_triggers + d.l4_awaits + d.l4_sequences)
        .unwrap_or(l4_count);

    let signals = SignalGenerator::new().generate(before, after, changed_files, effective_l4, cycle_count, df_counts.as_ref());
    let config = ConstraintConfig::from_yaml_file(&PathBuf::from(_project_root));
    let constraint_result = check_constraints(&signals, &config);
    let violations: Vec<Value> = constraint_result["violations"].as_array().cloned().unwrap_or_default();
    let summary = generate_summary(changed_files, &violations, l4_count, cycle_count);

    // ── 违规差异：将当前 ID 与上次检查快照对比 ──
    let current_ids: Vec<String> = extract_violation_ids(&violations);
    let previous_ids: HashSet<String> = load_previous_violation_ids(&PathBuf::from(_project_root))
        .into_iter().collect();
    let current_set: HashSet<String> = current_ids.iter().cloned().collect();
    let new_count      = current_set.difference(&previous_ids).count() as u32;
    let resolved_count = previous_ids.difference(&current_set).count() as u32;
    let persistent_count = current_set.intersection(&previous_ids).count() as u32;
    // 保存当前 ID，以便下次检查可以与此运行计算差异。
    let project_path = PathBuf::from(_project_root);
    save_violation_ids(&project_path, &current_ids);

    // ── blast_radius：从文件在 changed_files 中的所有节点出发进行 BFS ──
    let blast_radius = if changed_files.is_empty() {
        0usize
    } else {
        let mut seed_nodes: HashSet<&str> = HashSet::new();
        for (_, node) in after.nodes_iter() {
            if let Some(ref loc) = node.location {
                if changed_files.iter().any(|f| loc.starts_with(f.as_str()) || loc.contains(f.as_str())) {
                    seed_nodes.insert(node.id.as_str());
                }
            }
        }
        // 从种子节点开始 BFS，深度上限为 3
        let mut visited: HashSet<&str> = HashSet::new();
        let mut queue = VecDeque::new();
        for &sid in &seed_nodes {
            visited.insert(sid);
            queue.push_back((sid, 0usize));
        }
        // 构建邻接表
        let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
        for (_, edge) in after.edges_iter() {
            adj.entry(&edge.source).or_default().push(&edge.target);
            adj.entry(&edge.target).or_default().push(&edge.source);
        }
        while let Some((cur, depth)) = queue.pop_front() {
            if depth >= 3 { continue; }
            if let Some(nbs) = adj.get(cur) {
                for &nb in nbs {
                    if visited.insert(nb) {
                        queue.push_back((nb, depth + 1));
                    }
                }
            }
        }
        visited.len().saturating_sub(seed_nodes.len()) // 排除种子节点自身
    };

    // ── cross_community_edges：after graph 上的社区 ──
    let communities = detect_communities(after, 42);
    let mut node_to_comm: HashMap<&str, usize> = HashMap::new();
    for (ci, comm) in communities.iter().enumerate() {
        for nid in comm {
            node_to_comm.insert(nid.as_str(), ci);
        }
    }
    let cross_community_edges = after.edges_iter()
        .filter(|(_, e)| {
            let sc = node_to_comm.get(e.source.as_str());
            let tc = node_to_comm.get(e.target.as_str());
            sc != tc || sc.is_none()
        })
        .count();

        // ── 线程冲突 ──
    let new_thread_conflicts = 0u32;

    // ── api_signature_changes：统计变更的函数/方法节点 ──
    let api_signature_changes = if before.node_count() == 0 {
        0u32
    } else {
        let mut changed = 0u32;
        for (nid, after_node) in after.nodes_iter() {
            if !matches!(after_node.kind, NodeKind::Symbol) { continue; }
            if let Some(before_node) = before.get_node(nid) {
                // 入度/出度不同则计为变更
                if before_node.out_degree != after_node.out_degree
                    || before_node.in_degree != after_node.in_degree
                {
                    changed += 1;
                }
            } else {
                // 新增 symbol 节点
                changed += 1;
            }
        }
        changed
    };

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
        "blast_radius": blast_radius as u32,
        "cross_community_edges": cross_community_edges as u32,
        "new_cycles": cycle_count.saturating_sub(cycles_before) as u32,
        "new_thread_conflicts": new_thread_conflicts,
        "api_signature_changes": api_signature_changes,
        "coupling_l4": l4_count as u32,
        "cycles_detected": cycle_count as u32,
        "signals_count": signals.len() as u32,
        "violation_count": violations.len() as u32,
        "new_violations": new_count,
        "resolved_violations": resolved_count,
        "persistent_violations": persistent_count,
    })
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_preflight_empty_graphs() {
        let g = Graph::new();
        let r = run_full_check(&g, &g, &[], ".");
        assert!(r["passed"].as_bool().unwrap());
        assert_eq!(r["blast_radius"], 0);
        assert_eq!(r["violation_count"], 0);
    }

    #[test]
    fn test_preflight_no_changes() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));

        let r = run_full_check(&g, &g, &[], ".");
        assert!(r["passed"].as_bool().unwrap());
        assert_eq!(r["blast_radius"], 0);
    }

    #[test]
    fn test_preflight_detects_l5_on_migration() {
        let g = Graph::new();
        let r = run_full_check(&g, &g, &["migrations/0001_init.py".into()], ".");
        assert!(!r["passed"].as_bool().unwrap());
        assert!(r["violation_count"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_preflight_blast_radius_with_changes() {
        let mut g = Graph::new();
        let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
        a.location = Some("src/handler.rs".into());
        g.add_node(a);
        let mut b = Node::new("b", "mod_b", NodeKind::Symbol);
        b.location = Some("src/handler.rs".into());
        g.add_node(b);
        g.add_node(Node::new("c", "mod_c", NodeKind::Symbol));
        g.add_edge_unchecked(Edge::new("e1", "a", "c", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e2", "c", "b", EdgeKind::Calls));

        let r = run_full_check(&g, &g, &["src/handler.rs".into()], ".");
        // 从 a,b 的 BFS 应在深度 3 内包含 c
        assert!(r["blast_radius"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_preflight_api_signature_changes() {
        let mut before = Graph::new();
        let mut a = Node::new("a", "fn_a", NodeKind::Symbol);
        a.out_degree = 1;
        before.add_node(a);

        let mut after = Graph::new();
        let mut a2 = Node::new("a", "fn_a", NodeKind::Symbol);
        a2.out_degree = 3; // 已变更
        after.add_node(a2);
        let mut b = Node::new("b", "fn_b", NodeKind::Symbol);
        b.out_degree = 1;
        after.add_node(b);

        let r = run_full_check(&before, &after, &["src/a.rs".into()], ".");
        assert_eq!(r["api_signature_changes"], 2, "a changed + b new = 2");
    }

    #[test]
    fn test_preflight_stable_cycles_no_false_alarm() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        g.add_node(Node::new("c", "c", NodeKind::Symbol));
        g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e2", "b", "c", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e3", "c", "a", EdgeKind::Calls));
        let r = run_full_check(&g, &g, &[], ".");
        assert!(r["passed"].as_bool().unwrap());
        assert_eq!(r["violation_count"], 0);
    }

    #[test]
    fn test_preflight_baseline_seed() {
        let mut after = Graph::new();
        after.add_node(Node::new("a", "fn", NodeKind::Symbol));
        let before = Graph::new();
        let r = run_full_check(&before, &after, &[], ".");
        assert!(r["passed"].as_bool().unwrap());
        assert_eq!(r["baseline_seed"], true);
        assert_eq!(r["violation_count"], 0);
    }

    /// 回归测试：过期基线（更少节点/环）+ 重新分析（更多节点/环）
    /// + 无 changed_files → 不得产生误报的 L2 "new cycles" 违规。
    /// 这是导致 "53 new circular dependency cycles" 误报的确切 bug。
    #[test]
    fn test_stale_baseline_no_false_positive() {
        // ── "旧基线"：小 graph，含 1 个环（3 个节点）──
        let mut before = Graph::new();
        before.add_node(Node::new("x", "old_x", NodeKind::Symbol));
        before.add_node(Node::new("y", "old_y", NodeKind::Symbol));
        before.add_node(Node::new("z", "old_z", NodeKind::Symbol));
        before.add_edge_unchecked(Edge::new("e_xy", "x", "y", EdgeKind::Calls));
        before.add_edge_unchecked(Edge::new("e_yz", "y", "z", EdgeKind::Calls));
        before.add_edge_unchecked(Edge::new("e_zx", "z", "x", EdgeKind::Calls)); // 1 个环：x→y→z→x

        // ── "重新分析后"：更大的 graph，含 2 个环 ──
        let mut after = Graph::new();
        after.add_node(Node::new("x", "old_x", NodeKind::Symbol));
        after.add_node(Node::new("y", "old_y", NodeKind::Symbol));
        after.add_node(Node::new("z", "old_z", NodeKind::Symbol));
        after.add_edge_unchecked(Edge::new("e_xy", "x", "y", EdgeKind::Calls));
        after.add_edge_unchecked(Edge::new("e_yz", "y", "z", EdgeKind::Calls));
        after.add_edge_unchecked(Edge::new("e_zx", "z", "x", EdgeKind::Calls)); // 环 1
        after.add_node(Node::new("a", "new_a", NodeKind::Symbol));
        after.add_node(Node::new("b", "new_b", NodeKind::Symbol));
        after.add_node(Node::new("c", "new_c", NodeKind::Symbol));
        after.add_edge_unchecked(Edge::new("e_ab", "a", "b", EdgeKind::Calls));
        after.add_edge_unchecked(Edge::new("e_bc", "b", "c", EdgeKind::Calls));
        after.add_edge_unchecked(Edge::new("e_ca", "c", "a", EdgeKind::Calls)); // 环 2

        // 无文件变更 — 应为静默
        let r = run_full_check(&before, &after, &[], ".");
        assert!(r["passed"].as_bool().unwrap(), "stale baseline without changed_files should pass");
        assert_eq!(r["violation_count"], 0, "should have zero violations");
        assert_eq!(r["one_line"], "无新变更");
        assert_eq!(r["new_cycles"], 0, "should report 0 new cycles");
    }

    /// 配套测试：与 test_stale_baseline_no_false_positive 相同场景，但带
    /// changed_files → 仍必须检测真实违规。确保防护不会
    /// 抑制真正的告警。
    #[test]
    fn test_stale_baseline_still_detects_with_real_changes() {
        let mut before = Graph::new();
        before.add_node(Node::new("x", "old_x", NodeKind::Symbol));
        before.add_edge_unchecked(Edge::new("e_self", "x", "x", EdgeKind::Calls));

        let mut after = Graph::new();
        let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
        a.location = Some("src/new_module.rs".into());
        after.add_node(a);
        after.add_node(Node::new("b", "mod_b", NodeKind::Symbol));
        let mut e = Edge::new("e_ab", "a", "b", EdgeKind::Calls);
        e.coupling_depth = 4;
        after.add_edge_unchecked(e);
        after.add_node(Node::new("c", "mod_c", NodeKind::Symbol));
        after.add_edge_unchecked(Edge::new("e_bc", "b", "c", EdgeKind::Calls));
        after.add_edge_unchecked(Edge::new("e_ca", "c", "a", EdgeKind::Calls)); // 1 new cycle

        // 有变更文件 → 应仍触发
        let r = run_full_check(&before, &after, &["src/new_module.rs".into()], ".");
        assert!(!r["passed"].as_bool().unwrap(), "real changes should not pass");
        assert!(r["violation_count"].as_u64().unwrap() > 0, "should have violations");
        assert!(r["new_cycles"].as_u64().unwrap() > 0, "should detect new cycles");
    }

    /// 回归测试：对 `.hologram/` 或其他被忽略目录的变更不得
    /// 产生违规。此前，`.hologram/baseline.json` 匹配了
    /// 配置文件模式（`.json$`）并触发了误报的 L5 违规。
    #[test]
    fn test_preflight_filters_ignored_paths() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));

        // 仅被忽略路径 → 应为静默（无违规）
        let r = run_full_check(&g, &g, &[
            ".hologram/baseline.json".into(),
            ".hologram/memory/context.json".into(),
            ".git/HEAD".into(),
            "node_modules/express/index.js".into(),
        ], ".");
        assert!(r["passed"].as_bool().unwrap(), "ignored paths should not produce violations");
        assert_eq!(r["violation_count"], 0, "ignored paths should have zero violations");
        assert_eq!(r["total_changed_files"], 0, "ignored paths should be filtered out");
    }

    /// 混合场景：被忽略路径 + 真实源文件 → 仅真实文件被计入。
    #[test]
    fn test_preflight_filters_ignored_mixed_with_real() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));

        let r = run_full_check(&g, &g, &[
            ".hologram/baseline.json".into(),  // 被忽略 — 否则会误报 L5
            "migrations/0001_init.py".into(),   // 真实文件 — 应为 L5
        ], ".");
        // 仅迁移文件应产生违规
        assert!(!r["passed"].as_bool().unwrap(), "migration file should produce violation");
        assert_eq!(r["violation_count"], 1, "only 1 violation from migration, not from .hologram");
        assert_eq!(r["total_changed_files"], 1, "only 1 real changed file");
    }
}