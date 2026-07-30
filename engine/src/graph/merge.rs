// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

use super::{Edge, EdgeKind, Graph, Node};

/// 持久化 Graph 合并器，带增量索引。
///
/// v3 Python 性能问题：`Graph.merge()` 在每次单文件合并时
/// 从整个不断增长的 Graph 重建完整的 loc_key 索引。
/// 2500 个文件 × O(V) 索引重建 = O(V²) 累积复杂度。
///
/// 修复：保持索引跨合并存活，增量更新。
/// 每次合并复杂度为 O(|incoming|) 而非 O(|existing| + |incoming|)。
///
/// v4 边去重：`edge_index` 镜像 `loc_index` — 一个持久的
/// (source, target, kind) 去重集合，防止冗余的调用点
/// 边淹没 edge HashMap。否则每个 TS/JS 文件中的
/// 每个 call_expression 都会生成一条边（14K+/文件），
/// 在百万级条目时引发反复的 HashMap rehash 风暴。
pub struct GraphMerger {
    graph: Graph,
    /// "location::name::kind" → node ID
    loc_index: HashMap<String, String>,
    /// "(source, target, edge_kind_discriminant)" — 全局边去重。
    /// ponytail: 跨合并调用持久化，镜像 loc_index 模式。
    /// 整个项目中每个唯一的 (source, target, kind) 只保留一条边。
    edge_index: HashSet<(String, String, u8)>,
}

// ponytail: 将 EdgeKind 编码为 u8 判别值，用于索引中高效的 Hash+Eq。
fn edge_kind_id(k: &EdgeKind) -> u8 {
    match k {
        EdgeKind::Imports => 0,
        EdgeKind::Calls => 1,
        EdgeKind::Inherits => 2,
        EdgeKind::Defines => 3,
        EdgeKind::Reads => 4,
        EdgeKind::Writes => 5,
        EdgeKind::Shares => 6,
        EdgeKind::Triggers => 7,
        EdgeKind::Awaits => 8,
        EdgeKind::Sequences => 9,
        EdgeKind::Usage => 10,
        EdgeKind::Throws => 11,
    }
}

impl GraphMerger {
    pub fn new() -> Self {
        Self {
            graph: Graph::new(),
            loc_index: HashMap::new(),
            edge_index: HashSet::new(),
        }
    }

    pub fn with_capacity(estimated_nodes: usize, estimated_edges: usize) -> Self {
        let mut graph = Graph::new();
        graph.nodes.reserve(estimated_nodes);
        graph.edges.reserve(estimated_edges);
        Self {
            graph,
            loc_index: HashMap::with_capacity(estimated_nodes),
            edge_index: HashSet::with_capacity(estimated_edges),
        }
    }

    /// 仅在 (source, target, kind) 之前未出现过时插入边。
    /// 返回 true 表示边确实被添加了。
    fn add_edge_deduped(&mut self, edge: Edge) -> bool {
        let key = (
            edge.source.clone(),
            edge.target.clone(),
            edge_kind_id(&edge.kind),
        );
        if self.edge_index.insert(key) {
            // 合并时有意允许目标为未解析裸名的边
            // （例如 `from db import ...` 中的 "db"）。跨文件解析器
            // 稍后会将这些解析为实际的 node ID。
            self.graph.add_edge_unchecked(edge);
            true
        } else {
            false
        }
    }

    /// 将另一个 Graph 合并到累加器中。O(|other.nodes| + |other.edges|)。
    pub fn merge(&mut self, other: Graph) -> usize {
        let mut added = 0usize;
        let mut seen: HashMap<String, ()> = HashMap::new();

        for (_, node) in other.nodes {
            let key = node_key(&node);
            if seen.contains_key(&key) {
                continue;
            }
            match self.loc_index.entry(key) {
                Entry::Occupied(_) => continue,
                Entry::Vacant(e) => {
                    seen.insert(e.key().clone(), ());
                    e.insert(node.id.clone());
                    self.graph.add_node(node);
                    added += 1;
                }
            }
        }
        for (_, edge) in other.edges {
            self.add_edge_deduped(edge);
        }
        added
    }

    /// 直接从切片合并 — 避免中间 Graph 分配。
    /// ponytail: 跳过 build_file_graph() → 节省每文件 HashMap 分配/释放开销。
    pub fn merge_slices(&mut self, nodes: &[Node], edges: &[Edge]) -> usize {
        let mut added = 0usize;
        let mut seen: HashMap<String, ()> = HashMap::with_capacity(nodes.len());

        for node in nodes {
            let key = node_key(node);
            if seen.contains_key(&key) {
                continue;
            }
            match self.loc_index.entry(key) {
                Entry::Occupied(_) => continue,
                Entry::Vacant(e) => {
                    seen.insert(e.key().clone(), ());
                    e.insert(node.id.clone());
                    self.graph.add_node(node.clone());
                    added += 1;
                }
            }
        }
        // ponytail: 两级边去重。
        // 第一级（快速）：文件内去重，使用借用的 &str，零克隆。
        //    一个 React 组件调用 console.log 100 次 → 99 次在此跳过。
        // 第二级（慢速）：全局持久索引，克隆 source+target。
        //    每文件仅 1 个唯一的 (src,tgt,kind) 到达此级别。
        let cap = edges.len().min(5000);
        let mut local_dedup: HashSet<(&str, &str, u8)> = HashSet::with_capacity(cap);
        for edge in edges {
            let ek = edge_kind_id(&edge.kind);
            if !local_dedup.insert((&edge.source, &edge.target, ek)) {
                continue; // 文件内重复 — 跳过且不克隆
            }
            self.add_edge_deduped(edge.clone());
        }
        added
    }

    /// 消费合并器并返回累积的 Graph。
    pub fn into_graph(self) -> Graph {
        self.graph
    }

    /// 获取累积 Graph 的引用。
    pub fn graph(&self) -> &Graph {
        &self.graph
    }

    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }
}

/// 构建去重键："location::name::kind"
fn node_key(node: &Node) -> String {
    if let Some(loc) = &node.location {
        // ponytail: String::with_capacity 避免 format!() 的重新分配开销。
        // 逐节点的 format 开销在 300K+ 节点时会累积。
        let cap = loc.len() + node.name.len() + node.kind.as_str().len() + 6;
        let mut key = String::with_capacity(cap);
        key.push_str(loc);
        key.push_str("::");
        key.push_str(&node.name);
        key.push_str("::");
        key.push_str(node.kind.as_str());
        key
    } else {
        // 无 location — 使用 node id（每文件唯一）
        let cap = node.id.len() + node.name.len() + node.kind.as_str().len() + 6;
        let mut key = String::with_capacity(cap);
        key.push_str(&node.id);
        key.push_str("::");
        key.push_str(&node.name);
        key.push_str("::");
        key.push_str(node.kind.as_str());
        key
    }
}

impl Default for GraphMerger {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    fn make_node(id: &str, name: &str, loc: &str, kind: NodeKind) -> Node {
        let mut n = Node::new(id, name, kind);
        n.location = Some(loc.into());
        n
    }

    #[test]
    fn test_new_merger_empty() {
        let m = GraphMerger::new();
        assert_eq!(m.node_count(), 0);
        assert_eq!(m.graph().node_count(), 0);
    }

    #[test]
    fn test_merge_single_graph() {
        let mut merger = GraphMerger::new();
        let mut g = Graph::new();
        g.add_node(make_node("n1", "fn_a", "src/a.rs", NodeKind::Symbol));
        g.add_node(make_node("n2", "fn_b", "src/b.rs", NodeKind::Symbol));
        g.add_edge_unchecked(Edge::new("e1", "n1", "n2", EdgeKind::Calls));

        let added = merger.merge(g);
        assert_eq!(added, 2);
        assert_eq!(merger.node_count(), 2);
        assert_eq!(merger.graph().edge_count(), 1);
    }

    #[test]
    fn test_merge_dedup_by_loc_key() {
        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        g1.add_node(make_node("n1", "handle", "src/main.rs", NodeKind::Symbol));

        let mut g2 = Graph::new();
        g2.add_node(make_node("n2", "handle", "src/main.rs", NodeKind::Symbol));

        assert_eq!(merger.merge(g1), 1);
        assert_eq!(merger.merge(g2), 0, "duplicate loc+name+kind should be skipped");
        assert_eq!(merger.node_count(), 1);
    }

    #[test]
    fn test_merge_dedup_different_name_same_loc() {
        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        g1.add_node(make_node("n1", "fn_a", "src/lib.rs", NodeKind::Symbol));

        let mut g2 = Graph::new();
        g2.add_node(make_node("n2", "fn_b", "src/lib.rs", NodeKind::Symbol));

        assert_eq!(merger.merge(g1), 1);
        assert_eq!(merger.merge(g2), 1, "different name => different key");
        assert_eq!(merger.node_count(), 2);
    }

    #[test]
    fn test_merge_dedup_different_kind_same_loc_name() {
        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        g1.add_node(make_node("n1", "db", "store.rs", NodeKind::Medium));

        let mut g2 = Graph::new();
        g2.add_node(make_node("n2", "db", "store.rs", NodeKind::Symbol));

        assert_eq!(merger.merge(g1), 1);
        assert_eq!(merger.merge(g2), 1, "different kind => different key");
        assert_eq!(merger.node_count(), 2);
    }

    #[test]
    fn test_merge_preserves_edges() {
        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        g1.add_node(make_node("a", "src_a", "src/a.rs", NodeKind::Symbol));
        g1.add_node(make_node("b", "src_b", "src/b.rs", NodeKind::Symbol));
        g1.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));

        let mut g2 = Graph::new();
        g2.add_node(make_node("c", "src_c", "src/c.rs", NodeKind::Symbol));
        g2.add_edge_unchecked(Edge::new("e2", "c", "a", EdgeKind::Calls));

        merger.merge(g1);
        merger.merge(g2);
        assert_eq!(merger.node_count(), 3);
        assert_eq!(merger.graph().edge_count(), 2);
    }

    #[test]
    fn test_merge_intra_graph_dedup() {
        let mut merger = GraphMerger::new();
        let mut g = Graph::new();
        // 同一 graph 内出现两次相同 loc_key
        g.add_node(make_node("n1", "fn", "src/x.rs", NodeKind::Symbol));
        g.add_node(make_node("n2", "fn", "src/x.rs", NodeKind::Symbol));

        let added = merger.merge(g);
        assert_eq!(added, 1, "intra-graph duplicates should be deduplicated");
    }

    #[test]
    fn test_into_graph_consumes() {
        let mut merger = GraphMerger::new();
        let mut g = Graph::new();
        g.add_node(make_node("n1", "fn", "src/x.rs", NodeKind::Symbol));
        merger.merge(g);

        let graph = merger.into_graph();
        assert_eq!(graph.node_count(), 1);
    }

    #[test]
    fn test_merge_empty_graph() {
        let mut merger = GraphMerger::new();
        let added = merger.merge(Graph::new());
        assert_eq!(added, 0);
        assert_eq!(merger.node_count(), 0);
    }

    #[test]
    fn test_merge_slices_edge_dedup() {
        // ponytail: 验证文件内 (source, target, kind) 去重。
        // 同一函数调用同一目标 3 次 → 1 条边，而非 3 条。
        let mut merger = GraphMerger::new();

        // 添加 source 和 target 节点，以便 add_edge 能更新度数
        let src = Node::new("a.foo", "foo", NodeKind::Function);
        let tgt = Node::new("b.helper", "helper", NodeKind::Function);
        let other = Node::new("c.other", "other", NodeKind::Function);
        merger.graph.add_node(src);
        merger.graph.add_node(tgt);
        merger.graph.add_node(other);

        let nodes: Vec<Node> = vec![];
        let edges: Vec<Edge> = vec![
            Edge::new("call_1", "a.foo", "b.helper", EdgeKind::Calls),
            Edge::new("call_2", "a.foo", "b.helper", EdgeKind::Calls),  // 重复：相同 (src, tgt, kind)
            Edge::new("call_3", "a.foo", "b.helper", EdgeKind::Calls),  // 重复
            Edge::new("call_4", "a.foo", "c.other", EdgeKind::Calls),   // 不同 target
        ];

        merger.merge_slices(&nodes, &edges);
        assert_eq!(merger.graph().edge_count(), 2, "should dedup 3 foo→helper calls into 1, keep foo→other");
    }

    #[test]
    fn test_merge_slices_edge_dedup_different_source() {
        // 不同 source → 不同边，不去重
        let mut merger = GraphMerger::new();

        merger.graph.add_node(Node::new("a.foo", "foo", NodeKind::Function));
        merger.graph.add_node(Node::new("a.bar", "bar", NodeKind::Function));
        merger.graph.add_node(Node::new("b.helper", "helper", NodeKind::Function));

        let nodes: Vec<Node> = vec![];
        let edges: Vec<Edge> = vec![
            Edge::new("call_1", "a.foo", "b.helper", EdgeKind::Calls),
            Edge::new("call_2", "a.bar", "b.helper", EdgeKind::Calls),
        ];

        merger.merge_slices(&nodes, &edges);
        assert_eq!(merger.graph().edge_count(), 2, "different sources should NOT be deduped");
    }

    #[test]
    fn test_merge_slices_edge_dedup_different_kind() {
        // 相同 (source, target) 但 kind 不同 → 不去重
        let mut merger = GraphMerger::new();

        merger.graph.add_node(Node::new("mod", "mod", NodeKind::File));
        merger.graph.add_node(Node::new("fn", "fn", NodeKind::Function));

        let nodes: Vec<Node> = vec![];
        let edges: Vec<Edge> = vec![
            Edge::new("e1", "mod", "fn", EdgeKind::Defines),
            Edge::new("e2", "mod", "fn", EdgeKind::Calls),
        ];

        merger.merge_slices(&nodes, &edges);
        assert_eq!(merger.graph().edge_count(), 2, "different kinds should NOT be deduped");
    }

    #[test]
    fn test_merge_slices_edge_dedup_cross_call() {
        // 全局去重：两次 merge_slices 调用中相同 (source, target, kind) → 1 条边
        let mut merger = GraphMerger::new();

        merger.graph.add_node(Node::new("a.foo", "foo", NodeKind::Function));
        merger.graph.add_node(Node::new("b.helper", "helper", NodeKind::Function));

        let nodes1: Vec<Node> = vec![];
        let edges1: Vec<Edge> = vec![
            Edge::new("call_1", "a.foo", "b.helper", EdgeKind::Calls),
        ];
        merger.merge_slices(&nodes1, &edges1);
        assert_eq!(merger.graph().edge_count(), 1);

        // 第二个文件（不同的 edge ID，相同的语义边）
        let nodes2: Vec<Node> = vec![];
        let edges2: Vec<Edge> = vec![
            Edge::new("call_file2_1", "a.foo", "b.helper", EdgeKind::Calls),
        ];
        merger.merge_slices(&nodes2, &edges2);
        assert_eq!(merger.graph().edge_count(), 1, "cross-call global dedup: same (src,tgt,kind) should be skipped");
    }

    #[test]
    fn test_merge_slices_edge_dedup_cross_call_different_scope() {
        // 不同 scope（source）→ 跨调用不去重
        let mut merger = GraphMerger::new();

        merger.graph.add_node(Node::new("a.foo", "foo", NodeKind::Function));
        merger.graph.add_node(Node::new("a.bar", "bar", NodeKind::Function));
        merger.graph.add_node(Node::new("b.helper", "helper", NodeKind::Function));

        let nodes1: Vec<Node> = vec![];
        let edges1: Vec<Edge> = vec![
            Edge::new("call_1", "a.foo", "b.helper", EdgeKind::Calls),
        ];
        merger.merge_slices(&nodes1, &edges1);

        let nodes2: Vec<Node> = vec![];
        let edges2: Vec<Edge> = vec![
            Edge::new("call_2", "a.bar", "b.helper", EdgeKind::Calls),
        ];
        merger.merge_slices(&nodes2, &edges2);
        assert_eq!(merger.graph().edge_count(), 2, "different sources across calls should NOT be deduped");
    }
}
