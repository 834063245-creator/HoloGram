// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::analysis::detect_cycles;
use crate::graph::Graph;
use crate::routing::patterns::PatternMatcher;
use serde_json::{json, Value};

fn count_l4_edges(graph: &Graph) -> usize {
    graph.edges_iter().filter(|(_, e)| e.coupling_depth >= 4).count()
}

/// 稳定的违规标识 — 确定性、可读、跨检查运行保持一致。
/// 格式：`L{level}_{category}_{discriminator}`，路径分隔符已归一化。
fn vid(level: u32, category: &str, discriminator: &str) -> String {
    format!("L{}_{}_{}", level, category, discriminator)
        .replace(['/', '\\'], "_")
        .replace(' ', "_")
}

/// 来自 `query_dataflow_files` 的聚合数据流信号计数。
pub struct DataflowSignalCounts {
    pub l3_shared_vars: usize,
    pub l3_reads: usize,
    pub l3_writes: usize,
    pub l4_triggers: usize,
    pub l4_awaits: usize,
    pub l4_sequences: usize,
}

pub struct SignalGenerator {
    matcher: PatternMatcher,
}

impl Default for SignalGenerator {
    fn default() -> Self {
        Self::new()
    }
}

impl SignalGenerator {
    pub fn new() -> Self { Self { matcher: PatternMatcher::new() } }

    /// 通过对比 `before` → `after` 生成变更信号。
    /// L4/L2 仅在耦合/环 **增加** 时触发 — 不针对静态项目状态。
    /// 如果提供了 `df_counts`，则使用数据流引擎结果代替 graph 边来生成 L3/L4 信号。
    pub fn generate(&self, before: &Graph, after: &Graph, changed_files: &[String],
        _coupling_l4_after: usize, cycle_count_after: usize,
        df_counts: Option<&DataflowSignalCounts>) -> Vec<Value> {
        let mut signals = Vec::new();
        let l4_before = count_l4_edges(before);
        let l4_after = count_l4_edges(after);
        let cycles_before = detect_cycles(before).len();

        // L5 — 不可逆操作（仅当用户实际修改了这些文件时触发）
        for f in changed_files {
            if self.matcher.is_migration_file(f) {
                signals.push(json!({"signal":{"description":"Migration file changed — may irreversibly alter data schema. Requires manual review.","file_path":f,"line":0,"level":5,"affected_nodes":[],"violation_id":vid(5,"migration",f)},"level":5}));
            }
            if self.matcher.is_serialization_file(f) {
                signals.push(json!({"signal":{"description":"Serialization format changed — may break data interchange.","file_path":f,"line":0,"level":5,"affected_nodes":[],"violation_id":vid(5,"serialization",f)},"level":5}));
            }
            if self.matcher.is_config_file(f) {
                signals.push(json!({"signal":{"description":"Configuration file changed — may alter runtime behavior globally.","file_path":f,"line":0,"level":5,"affected_nodes":[],"violation_id":vid(5,"config",f)},"level":5}));
            }
        }

        // L4 — 自上次基线以来的新增深度耦合（或来自数据流引擎）
        if let Some(df) = df_counts {
            let df_l4 = df.l4_triggers + df.l4_awaits + df.l4_sequences;
            if df_l4 > 0 {
                signals.push(json!({"signal":{"description":format!("{} temporal edge(s) detected by dataflow engine (triggers={}, awaits={}, sequences={}).", df_l4, df.l4_triggers, df.l4_awaits, df.l4_sequences),"file_path":"","line":0,"level":4,"affected_nodes":[],"violation_id":vid(4,"coupling","dataflow")},"level":4}));
            }
        } else if l4_after > l4_before {
            let delta = l4_after - l4_before;
            signals.push(json!({"signal":{"description":format!("{} new L4 deep coupling edge(s) since last check.", delta),"file_path":"","line":0,"level":4,"affected_nodes":[],"violation_id":vid(4,"coupling","graph")},"level":4}));
        }

        // L3 — 共享数据（优先使用数据流引擎，否则使用 graph 边）
        if let Some(df) = df_counts {
            if df.l3_shared_vars > 0 {
                signals.push(json!({"signal":{"description":format!("{} shared variable(s) detected across function boundaries ({} reads, {} writes).", df.l3_shared_vars, df.l3_reads, df.l3_writes),"file_path":"","line":0,"level":3,"affected_nodes":[],"violation_id":vid(3,"shared_vars","dataflow")},"level":3}));
            }
        } else {
            for (_, edge) in after.edges_iter() {
                if edge.coupling_depth >= 3 {
                    let loc = after.get_node(&edge.source)
                        .and_then(|n| n.location.as_deref())
                        .unwrap_or("");
                    // 使用路径感知匹配：文件必须匹配路径段，而非任意子串
                    let is_affected = changed_files.iter().any(|f| {
                        let f_norm = f.replace('\\', "/");
                        let loc_norm = loc.replace('\\', "/");
                        loc_norm == f_norm
                            || loc_norm.starts_with(&format!("{}/", f_norm))
                            || f_norm.ends_with(&format!("/{}", loc_norm.rsplit('/').next().unwrap_or(&loc_norm)))
                    });
                    if is_affected {
                        let disc = format!("{}->{}", edge.source, edge.target);
                        signals.push(json!({"signal":{"description":format!("{} -> {} writes shared data.", edge.source, edge.target),"file_path":"","line":0,"level":3,"affected_nodes":[edge.source.clone(), edge.target.clone()],"violation_id":vid(3,"shared_data",&disc)},"level":3}));
                    }
                }
            }
        }

        // L2 — 自上次基线以来的新增环
        if cycle_count_after > cycles_before {
            let delta = cycle_count_after - cycles_before;
            signals.push(json!({"signal":{"description":format!("{} new circular dependency cycle(s) since last check.", delta),"file_path":"","line":0,"level":2,"affected_nodes":[],"violation_id":vid(2,"cycles","delta")},"level":2}));
        }

        // L1 — 仅文档/测试（v1 版本跳过）
        signals
    }
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};
    use super::*;

    #[test]
    fn test_signals_empty() {
        let gen = SignalGenerator::new();
        let g = Graph::new();
        let signals = gen.generate(&g, &g, &[], 0, 0, None);
        assert!(signals.is_empty());
    }

    #[test]
    fn test_signals_l5_migration() {
        let gen = SignalGenerator::new();
        let g = Graph::new();
        let signals = gen.generate(&g, &g, &["migrations/0001_init.py".into()], 0, 0, None);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 5);
    }

    #[test]
    fn test_signals_l5_config() {
        let gen = SignalGenerator::new();
        let g = Graph::new();
        let signals = gen.generate(&g, &g, &["config.yaml".into()], 0, 0, None);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 5);
    }

    #[test]
    fn test_signals_l4_coupling() {
        let gen = SignalGenerator::new();
        let before = Graph::new();
        let mut after = Graph::new();
        after.add_node(Node::new("a", "mod_a", NodeKind::Symbol));
        after.add_node(Node::new("b", "mod_b", NodeKind::Symbol));
        let mut e = Edge::new("e1", "a", "b", EdgeKind::Calls);
        e.coupling_depth = 4;
        after.add_edge_unchecked(e);
        let signals = gen.generate(&before, &after, &["src/a.rs".into()], 1, 0, None);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 4);
    }

    #[test]
    fn test_signals_l2_cycles() {
        let gen = SignalGenerator::new();
        let before = Graph::new();
        let mut after = Graph::new();
        after.add_node(Node::new("a", "a", NodeKind::Symbol));
        after.add_node(Node::new("b", "b", NodeKind::Symbol));
        after.add_node(Node::new("c", "c", NodeKind::Symbol));
        after.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));
        after.add_edge_unchecked(Edge::new("e2", "b", "c", EdgeKind::Calls));
        after.add_edge_unchecked(Edge::new("e3", "c", "a", EdgeKind::Calls));
        let signals = gen.generate(&before, &after, &[], 0, 1, None);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 2);
    }

    #[test]
    fn test_signals_no_false_alarm_on_static_cycles() {
        let gen = SignalGenerator::new();
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        g.add_node(Node::new("c", "c", NodeKind::Symbol));
        g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e2", "b", "c", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e3", "c", "a", EdgeKind::Calls));
        let signals = gen.generate(&g, &g, &[], 0, 1, None);
        assert!(signals.is_empty(), "same graph should not re-alert on existing cycles");
    }

    #[test]
    fn test_signals_l3_shared_data() {
        let gen = SignalGenerator::new();
        let mut g = Graph::new();
        let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
        a.location = Some("src/handler.rs".into());
        g.add_node(a);
        g.add_node(Node::new("b", "mod_b", NodeKind::Symbol));
        let mut e = Edge::new("e1", "a", "b", EdgeKind::Writes);
        e.coupling_depth = 3;
        g.add_edge_unchecked(e);

        let signals = gen.generate(&g, &g, &["src/handler.rs".into()], 0, 0, None);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 3);
    }

    #[test]
    fn test_signals_multiple_levels() {
        let gen = SignalGenerator::new();
        let before = Graph::new();
        let mut after = Graph::new();
        after.add_node(Node::new("a", "a", NodeKind::Symbol));
        after.add_node(Node::new("b", "b", NodeKind::Symbol));
        after.add_node(Node::new("c", "c", NodeKind::Symbol));
        after.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));
        after.add_edge_unchecked(Edge::new("e2", "b", "c", EdgeKind::Calls));
        after.add_edge_unchecked(Edge::new("e3", "c", "a", EdgeKind::Calls));
        let mut l4 = Edge::new("e4", "a", "b", EdgeKind::Calls);
        l4.coupling_depth = 4;
        after.add_edge_unchecked(l4);
        let signals = gen.generate(&before, &after,
            &["migrations/init.py".into(), "config.toml".into()],
            1, 1, None);
        // L5：migration + config + serialization？仅 config = 1 config + 1 migration = 2，L4 delta 1，L2 delta 1
        assert!(signals.len() >= 3);
    }
}
