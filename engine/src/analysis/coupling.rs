// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;

use crate::graph::{EdgeKind, Graph};

/// 为所有边分配 L1-L4 耦合深度。O(E) 单次遍历。
/// L1 = 直接导入（同包），L2 = 跨包，L3 = 数据，L4 = 时序。
pub fn compute_coupling(graph: &mut Graph) {
    compute_coupling_impl(graph, false)
}

/// 仅对 coupling_depth == 0 的边（新添加的、尚未分类的）计算耦合深度。
/// 保留 DI reflection 显式设置的 L3/L4 深度。
pub fn compute_coupling_incremental(graph: &mut Graph) {
    compute_coupling_impl(graph, true)
}

fn compute_coupling_impl(graph: &mut Graph, incremental: bool) {
    // 从节点位置提取包前缀，用于区分 L1 和 L2
    let node_pkg: HashMap<String, String> = graph
        .nodes
        .values()
        .map(|n| {
            let loc = n.location.as_deref().unwrap_or("");
            // 提取顶层包："src/views.py" → "src"
            let pkg = loc.split('/').next().unwrap_or("").to_string();
            (n.id.clone(), pkg)
        })
        .collect();

    for edge in graph.edges.values_mut() {
        // 增量模式：跳过已被 DI reflection 分类过的边（L3/L4）
        if incremental && edge.coupling_depth > 0 {
            continue;
        }
        edge.coupling_depth = match edge.kind {
            EdgeKind::Imports | EdgeKind::Calls | EdgeKind::Inherits | EdgeKind::Defines => {
                let src_pkg = node_pkg.get(&edge.source);
                let tgt_pkg = node_pkg.get(&edge.target);
                match (src_pkg, tgt_pkg) {
                    (Some(s), Some(t)) if s == t && !s.is_empty() => 1, // L1：同包
                    _ => 2, // L2：跨包
                }
            }
            EdgeKind::Reads | EdgeKind::Writes | EdgeKind::Shares | EdgeKind::Usage => 3, // L3：数据
            EdgeKind::Triggers | EdgeKind::Awaits | EdgeKind::Sequences | EdgeKind::Throws => 4, // L4：时序
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

    #[test]
    fn test_coupling_assigns_depths() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "A", NodeKind::Symbol));
        g.add_node(Node::new("b", "B", NodeKind::Symbol));
        g.add_node(Node::new("c", "C", NodeKind::Symbol));

        // a → b → c（链式，深度递增）
        g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e2", "b", "c", EdgeKind::Calls));

        compute_coupling(&mut g);

        // a→b 应为 L1（相邻）
        let e1 = g.get_edge("e1").unwrap();
        assert!(e1.coupling_depth >= 1);
        // b→c 应为 L1（相邻）
        let e2 = g.get_edge("e2").unwrap();
        assert!(e2.coupling_depth >= 1);
    }

    #[test]
    fn test_data_edge_is_l3() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "A", NodeKind::Symbol));
        g.add_node(Node::new("db", "DB", NodeKind::Medium));
        g.add_edge_unchecked(Edge::new("e1", "a", "db", EdgeKind::Reads));

        compute_coupling(&mut g);

        let e = g.get_edge("e1").unwrap();
        assert_eq!(e.coupling_depth, 3);
    }

    #[test]
    fn test_temporal_edge_is_l4() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "A", NodeKind::Symbol));
        g.add_node(Node::new("t", "Thread", NodeKind::Temporal));
        g.add_edge_unchecked(Edge::new("e1", "a", "t", EdgeKind::Triggers));

        compute_coupling(&mut g);

        let e = g.get_edge("e1").unwrap();
        assert_eq!(e.coupling_depth, 4);
    }
}