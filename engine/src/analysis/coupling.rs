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
    use rayon::prelude::*;

    // 从节点位置提取包前缀，用于区分 L1 和 L2。
    // M5: 全借用零分配 —— 原实现对每个节点克隆 id + pkg 两个 String
    // （内核 249 万节点 ≈ 500 万次分配），边循环再对每条边做两次
    // 110B 字符串哈希查找。pkg 只取首段切片，不为切片分配。
    let node_pkg: HashMap<&str, &str> = graph
        .nodes
        .values()
        .map(|n| {
            let loc = n.location.as_deref().unwrap_or("");
            // 提取顶层包："src/views.py" → "src"
            let pkg = match loc.find('/') {
                Some(pos) => &loc[..pos],
                None => loc,
            };
            (n.id.as_str(), pkg)
        })
        .collect();

    // M5: rayon 并行 —— 每条边独立写自己的 coupling_depth,无共享状态。
    // 内核 17M 边 × 2 次大表哈希查找是常数大头,单机 6 线程摊薄。
    graph.edges.par_iter_mut().for_each(|(_, edge)| {
        // 增量模式：跳过已被 DI reflection 分类过的边（L3/L4）
        if incremental && edge.coupling_depth > 0 {
            return;
        }
        edge.coupling_depth = match edge.kind {
            EdgeKind::Imports | EdgeKind::Calls | EdgeKind::Inherits | EdgeKind::Defines => {
                let src_pkg = node_pkg.get(edge.source.as_str());
                let tgt_pkg = node_pkg.get(edge.target.as_str());
                match (src_pkg, tgt_pkg) {
                    (Some(s), Some(t)) if s == t && !s.is_empty() => 1, // L1：同包
                    _ => 2, // L2：跨包
                }
            }
            EdgeKind::Reads | EdgeKind::Writes | EdgeKind::Shares | EdgeKind::Usage => 3, // L3：数据
            EdgeKind::Triggers | EdgeKind::Awaits | EdgeKind::Sequences | EdgeKind::Throws => 4, // L4：时序
        };
    });
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