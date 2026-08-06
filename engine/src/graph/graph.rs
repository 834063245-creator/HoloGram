// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{Edge, EdgeId, Node, NodeId};

/// 依赖图 — 核心数据结构。
/// 对应 Python 的 `Graph` 类，修复了 O(V×E) 性能问题。
///
/// R10-deep: 容器键从 `String` 改为全局驻留的 `NodeId/EdgeId`(u32 句柄)。
/// 句柄按内容寻址 —— 同一字符串永远同一句柄,因此 `HashMap<NodeId, _>` 的
/// 查找/哈希等价于按字符串。字符串本身只存驻留器一份(见 id.rs)。
/// 所有以 `&str` 为入参的公共访问器(get_node 等)经 `NodeId::lookup`
/// (驻留器非插入查询)→ 句柄 → 容器 get,签名全程稳定。
///
/// ```
/// use hologram_engine::graph::{Edge, EdgeKind, Graph, Node, NodeKind};
///
/// let mut g = Graph::new();
/// g.add_node(Node::new("a", "main", NodeKind::Symbol));
/// g.add_node(Node::new("b", "helper", NodeKind::Symbol));
/// g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));
///
/// assert_eq!(g.node_count(), 2);
/// assert_eq!(g.edge_count(), 1);
/// assert_eq!(g.get_node("a").unwrap().out_degree, 1);
/// assert_eq!(g.get_node("b").unwrap().in_degree, 1);
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Graph {
    // R8: 字段私有化第一步 —— pub(crate),跨 crate 访问一律走访问器。
    // R10-deep: 键为全局驻留句柄;NodeId/EdgeId serde 序列化为纯字符串,
    // 故磁盘/线格式(HashMap 字符串键)零漂移。
    #[serde(default)]
    pub(crate) nodes: HashMap<NodeId, Node>,
    #[serde(default)]
    pub(crate) edges: HashMap<EdgeId, Edge>,
    #[serde(default)]
    pub meta: serde_json::Value,
}

impl Graph {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: HashMap::new(),
            meta: serde_json::Value::Object(Default::default()),
        }
    }

    /// 从 JSON 文件加载 Graph。
    /// 同时支持数组格式（Python：nodes/edges 为数组）和
    /// HashMap 格式（Rust serde：nodes/edges 为对象）。
    pub fn from_json_file(path: &str) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Cannot read {}: {}", path, e))?;
        let val: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid JSON: {}", e))?;

        let mut g = Graph::new();
        if let Some(meta) = val.get("meta") {
            g.meta = meta.clone();
        }
        // Nodes：接受数组格式 [n1, n2, ...] 或 HashMap 格式 {"id": {...}, ...}
        if let Some(nodes_val) = val.get("nodes") {
            if let Some(arr) = nodes_val.as_array() {
                for n in arr {
                    if let Ok(node) = serde_json::from_value::<Node>(n.clone()) {
                        g.add_node(node);
                    }
                }
            } else if let Some(map) = nodes_val.as_object() {
                for (_, n) in map {
                    if let Ok(node) = serde_json::from_value::<Node>(n.clone()) {
                        g.add_node(node);
                    }
                }
            }
        }
        // Edges：同样的双格式支持
        if let Some(edges_val) = val.get("edges") {
            if let Some(arr) = edges_val.as_array() {
                for e in arr {
                    if let Ok(edge) = serde_json::from_value::<Edge>(e.clone()) {
                        g.insert_edge_raw(edge);
                    }
                }
            } else if let Some(map) = edges_val.as_object() {
                for (_, e) in map {
                    if let Ok(edge) = serde_json::from_value::<Edge>(e.clone()) {
                        g.insert_edge_raw(edge);
                    }
                }
            }
        }
        Ok(g)
    }

    // ── Node 操作 ──

    pub fn add_node(&mut self, node: Node) {
        self.nodes.insert(node.id, node);
    }

    /// 原样插入边(不更新度数)—— 从 JSON 加载时度数来自序列化值。
    fn insert_edge_raw(&mut self, edge: Edge) {
        self.edges.insert(edge.id, edge);
    }

    pub fn get_node(&self, id: &str) -> Option<&Node> {
        let h = NodeId::lookup(id)?;
        self.nodes.get(&h)
    }

    pub fn get_node_mut(&mut self, id: &str) -> Option<&mut Node> {
        let h = NodeId::lookup(id)?;
        self.nodes.get_mut(&h)
    }

    pub fn remove_node(&mut self, id: &str) -> Option<Node> {
        let handle = NodeId::lookup(id)?;
        let edge_ids: Vec<EdgeId> = self
            .edges
            .iter()
            .filter(|(_, e)| e.source == id || e.target == id)
            .map(|(k, _)| *k)
            .collect();
        for eid in edge_ids {
            self.edges.remove(&eid);
        }
        self.nodes.remove(&handle)
    }

    // ── Edge 操作 ──

    pub fn add_edge(&mut self, edge: Edge) -> Result<(), String> {
        if self.get_node(edge.source.as_str()).is_none() {
            return Err(format!("source node does not exist: {}", edge.source));
        }
        if self.get_node(edge.target.as_str()).is_none() {
            return Err(format!("target node does not exist: {}", edge.target));
        }
        self.add_edge_unchecked(edge);
        Ok(())
    }

    /// 插入边但不验证节点是否存在。
    /// 仅在调用方确保两端节点已存在时使用。
    pub fn add_edge_unchecked(&mut self, edge: Edge) {
        if let Some(src) = self.nodes.get_mut(&edge.source) {
            src.out_degree += 1;
        }
        if let Some(tgt) = self.nodes.get_mut(&edge.target) {
            tgt.in_degree += 1;
        }
        self.edges.insert(edge.id, edge);
    }

    pub fn remove_edge(&mut self, id: &str) -> Option<Edge> {
        let handle = EdgeId::lookup(id)?;
        let removed = self.edges.remove(&handle);
        if let Some(ref edge) = removed {
            if let Some(src) = self.nodes.get_mut(&edge.source) {
                src.out_degree = src.out_degree.saturating_sub(1);
            }
            if let Some(tgt) = self.nodes.get_mut(&edge.target) {
                tgt.in_degree = tgt.in_degree.saturating_sub(1);
            }
        }
        removed
    }

    pub fn get_edge(&self, id: &str) -> Option<&Edge> {
        let h = EdgeId::lookup(id)?;
        self.edges.get(&h)
    }

    pub fn get_edge_mut(&mut self, id: &str) -> Option<&mut Edge> {
        let h = EdgeId::lookup(id)?;
        self.edges.get_mut(&h)
    }

    /// O(E) 全扫出边,惰性迭代 —— 替代 outgoing_edges 的 Vec 分配。
    pub fn outgoing<'a>(&'a self, node_id: &'a str) -> impl Iterator<Item = &'a Edge> {
        self.edges.values().filter(move |e| e.source == node_id)
    }

    /// O(E) 全扫入边,惰性迭代 —— 替代 incoming_edges 的 Vec 分配。
    pub fn incoming<'a>(&'a self, node_id: &'a str) -> impl Iterator<Item = &'a Edge> {
        self.edges.values().filter(move |e| e.target == node_id)
    }

    #[deprecated(note = "use outgoing()/incoming()")]
    pub fn outgoing_edges(&self, node_id: &str) -> Vec<&Edge> {
        self.edges
            .values()
            .filter(|e| e.source == node_id)
            .collect()
    }

    #[deprecated(note = "use outgoing()/incoming()")]
    pub fn incoming_edges(&self, node_id: &str) -> Vec<&Edge> {
        self.edges
            .values()
            .filter(|e| e.target == node_id)
            .collect()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    // ── 迭代访问器(R0)—— 替代消费方直接访问 pub 字段 ──
    // 当前容器仍是 HashMap<String, _>,故 yield &str;R8 换容器后签名不变。

    pub fn nodes_iter(&self) -> impl Iterator<Item = (&str, &Node)> {
        self.nodes.values().map(|v| (v.id.as_str(), v))
    }

    pub fn edges_iter(&self) -> impl Iterator<Item = (&str, &Edge)> {
        self.edges.values().map(|v| (v.id.as_str(), v))
    }

    pub fn node_ids(&self) -> impl Iterator<Item = &str> {
        self.nodes.values().map(|v| v.id.as_str())
    }

    pub fn edge_ids(&self) -> impl Iterator<Item = &str> {
        self.edges.values().map(|v| v.id.as_str())
    }

    // ── 表级访问器(R8)—— 字段私有化后的整表出入口 ──

    /// 字段级只读借用 —— 供借用分裂场景(如同时 &nodes 与 &mut edges)。
    pub fn nodes_map(&self) -> &HashMap<NodeId, Node> {
        &self.nodes
    }

    /// 字段级只读借用 —— 供借用分裂场景。
    pub fn edges_map(&self) -> &HashMap<EdgeId, Edge> {
        &self.edges
    }

    /// 字段级可变借用 —— 供 rayon par_iter_mut 等批量可变场景。
    pub fn nodes_map_mut(&mut self) -> &mut HashMap<NodeId, Node> {
        &mut self.nodes
    }

    /// 字段级可变借用 —— 供 rayon par_iter_mut 等批量可变场景。
    pub fn edges_map_mut(&mut self) -> &mut HashMap<EdgeId, Edge> {
        &mut self.edges
    }

    /// 整表按值取出(消耗 Graph,meta 随壳丢弃)。
    pub fn into_parts(self) -> (HashMap<NodeId, Node>, HashMap<EdgeId, Edge>) {
        (self.nodes, self.edges)
    }

    /// std::mem::take 语义 —— 取走节点表,原位留空表。
    pub fn take_nodes(&mut self) -> HashMap<NodeId, Node> {
        std::mem::take(&mut self.nodes)
    }

    /// std::mem::take 语义 —— 取走边表,原位留空表。
    pub fn take_edges(&mut self) -> HashMap<EdgeId, Edge> {
        std::mem::take(&mut self.edges)
    }

    pub fn meta(&self) -> &serde_json::Value {
        &self.meta
    }

    pub fn meta_mut(&mut self) -> &mut serde_json::Value {
        &mut self.meta
    }
}

impl Default for Graph {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
pub struct GraphDiff {
    pub added_nodes: Vec<Node>,
    pub removed_nodes: Vec<Node>,
    pub added_edges: Vec<Edge>,
    pub removed_edges: Vec<Edge>,
    pub modified_nodes: Vec<(Node, Node)>,
}

impl Graph {
    pub fn diff(&self, other: &Graph) -> GraphDiff {
        let mut diff = GraphDiff {
            added_nodes: Vec::new(),
            removed_nodes: Vec::new(),
            added_edges: Vec::new(),
            removed_edges: Vec::new(),
            modified_nodes: Vec::new(),
        };
        for node in other.nodes.values() {
            if let Some(before) = self.get_node(node.id.as_str()) {
                if before.name != node.name
                    || before.kind != node.kind
                    || before.out_degree != node.out_degree
                    || before.in_degree != node.in_degree
                {
                    diff.modified_nodes.push((before.clone(), node.clone()));
                }
            } else {
                diff.added_nodes.push(node.clone());
            }
        }
        for node in self.nodes.values() {
            if other.get_node(node.id.as_str()).is_none() {
                diff.removed_nodes.push(node.clone());
            }
        }
        for edge in other.edges.values() {
            if self.get_edge(edge.id.as_str()).is_none() {
                diff.added_edges.push(edge.clone());
            }
        }
        for edge in self.edges.values() {
            if other.get_edge(edge.id.as_str()).is_none() {
                diff.removed_edges.push(edge.clone());
            }
        }
        diff
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_add_node() {
        let mut g = Graph::new();
        g.add_node(Node::new("n1", "main", NodeKind::Symbol));
        assert_eq!(g.node_count(), 1);
        assert!(g.get_node("n1").is_some());
    }

    #[test]
    fn test_add_edge_updates_degree() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));

        assert_eq!(g.get_node("a").unwrap().out_degree, 1);
        assert_eq!(g.get_node("b").unwrap().in_degree, 1);
    }

    #[test]
    fn test_add_edge_validates_both_nodes_exist() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        let result = g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        assert!(result.is_ok(), "should accept edge when both nodes exist");
        assert_eq!(g.edge_count(), 1);
        assert_eq!(g.get_node("a").unwrap().out_degree, 1);
        assert_eq!(g.get_node("b").unwrap().in_degree, 1);
    }

    #[test]
    fn test_add_edge_rejects_missing_source() {
        let mut g = Graph::new();
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        let result = g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("source node does not exist"));
        assert_eq!(g.edge_count(), 0, "no edge should be inserted on error");
    }

    #[test]
    fn test_add_edge_rejects_missing_target() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        let result = g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("target node does not exist"));
        assert_eq!(g.edge_count(), 0, "no edge should be inserted on error");
    }

    #[test]
    fn test_remove_node_cascades_edges() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));

        g.remove_node("a");
        assert_eq!(g.node_count(), 1);
        assert_eq!(g.edge_count(), 0); // 边被移除
    }

    #[test]
    fn test_merge_incremental_index() {
        use super::super::merge::GraphMerger;

        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        let mut n1 = Node::new("n1", "handle_request", NodeKind::Symbol);
        n1.location = Some("src/main.py".into());
        g1.add_node(n1);

        let mut g2 = Graph::new();
        let mut n1_dup = Node::new("n1_dup", "handle_request", NodeKind::Symbol);
        n1_dup.location = Some("src/main.py".into());
        g2.add_node(n1_dup);

        merger.merge(g1);
        assert_eq!(merger.node_count(), 1);
        merger.merge(g2);
        assert_eq!(merger.node_count(), 1, "重复项应被跳过");
    }

    #[test]
    fn test_diff_detects_additions() {
        let mut before = Graph::new();
        before.add_node(Node::new("a", "old_fn", NodeKind::Symbol));

        let mut after = before.clone();
        after.add_node(Node::new("b", "new_fn", NodeKind::Symbol));

        let diff = before.diff(&after);
        assert_eq!(diff.added_nodes.len(), 1);
        assert_eq!(diff.added_nodes[0].id, "b");
    }

    #[test]
    fn test_diff_detects_degree_change_as_modified() {
        let mut before = Graph::new();
        before.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        before.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        before.add_node(Node::new("c", "fn_c", NodeKind::Symbol));
        before.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));

        // 变更后：a 获得一条到 c 的新出边 → a.out_degree 和 c.in_degree 改变
        let mut after = before.clone();
        after.add_edge_unchecked(Edge::new("e2", "a", "c", EdgeKind::Calls));

        let diff = before.diff(&after);
        let modified_ids: Vec<&str> = diff.modified_nodes.iter().map(|(_, n)| n.id.as_str()).collect();
        assert_eq!(diff.modified_nodes.len(), 2, "a (out_degree) and c (in_degree) should be modified");
        assert!(modified_ids.contains(&"a"));
        assert!(modified_ids.contains(&"c"));
        assert_eq!(diff.added_edges.len(), 1);
    }

    #[test]
    fn test_from_json_file_array_format() {
        let json = r#"{
            "nodes": [
                {"id":"n1","name":"main","type":"symbol","location":null,"properties":{}},
                {"id":"n2","name":"helper","type":"function","location":null,"properties":{}}
            ],
            "edges": [
                {"id":"e1","source":"n1","target":"n2","type":"calls"}
            ]
        }"#;
        let tmp = std::env::temp_dir().join("hologram_test_array.json");
        std::fs::write(&tmp, json).unwrap();
        let g = Graph::from_json_file(tmp.to_str().unwrap()).unwrap();
        assert_eq!(g.node_count(), 2);
        assert_eq!(g.edge_count(), 1);
        assert_eq!(g.get_node("n1").unwrap().name, "main");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn test_from_json_file_hashmap_format() {
        // Rust serde 将 Graph 序列化为 HashMap 对象格式的 nodes/edges，而非数组。
        // 这是 save_baseline 写入的格式 — from_json_file 必须能将其读回。
        let mut original = Graph::new();
        original.add_node(Node::new("n1", "main", NodeKind::Symbol));
        original.add_node(Node::new("n2", "helper", NodeKind::Function));
        original.add_edge_unchecked(Edge::new("e1", "n1", "n2", EdgeKind::Calls));
        let serialized = serde_json::to_string_pretty(&original).unwrap();

        let tmp = std::env::temp_dir().join("hologram_test_hashmap.json");
        std::fs::write(&tmp, &serialized).unwrap();
        let g = Graph::from_json_file(tmp.to_str().unwrap()).unwrap();
        assert_eq!(g.node_count(), 2, "HashMap 格式的 nodes 应被加载");
        assert_eq!(g.edge_count(), 1, "HashMap 格式的 edges 应被加载");
        assert_eq!(g.get_node("n2").unwrap().name, "helper");
        let _ = std::fs::remove_file(&tmp);
    }
}