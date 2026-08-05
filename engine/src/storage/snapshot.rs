// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// snapshot — MemoryIndex 的 bincode 快照持久化（M7c）。
// 超大图（默认 ≥ 5M 边）下 SQLite 全量重写（bulk_replace_all）无前途
// （22M 边 885s）；快照把 MemoryIndex 全量结构一次 bincode 序列化落盘，
// 启动时一次读回，绕开 SQLite 逐行读写。
// 折中：快照模式下 fts_nodes 不预建，首个 FTS 查询时惰性重建
// （见 memory.rs ensure_fts_fresh）；timeline_events 独立表不受影响。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::graph::{EdgeKind, Node, NodeKind};

/// 快照文件名（位于 `<project_root>/.hologram/` 下）。
pub const SNAPSHOT_FILE: &str = "graph.snapshot";
/// 快照临时文件名 —— 先写它再原子 rename 为 SNAPSHOT_FILE。
pub const SNAPSHOT_TMP_FILE: &str = "graph.snapshot.tmp";

/// 默认进入快照模式的边数阈值。
const DEFAULT_SNAPSHOT_MIN_EDGES: usize = 5_000_000;

/// 项目根下的快照文件路径。
pub fn snapshot_path(project_root: &Path) -> PathBuf {
    project_root.join(".hologram").join(SNAPSHOT_FILE)
}

/// 项目根下的快照临时文件路径（原子 rename 的源）。
pub fn snapshot_tmp_path(project_root: &Path) -> PathBuf {
    project_root.join(".hologram").join(SNAPSHOT_TMP_FILE)
}

/// 进入快照模式的最小边数。env `HOLOGRAM_SNAPSHOT_MIN_EDGES` 覆盖；
/// 未设置或非法值（非 usize 可解析）回退默认 5_000_000。
pub fn snapshot_min_edges() -> usize {
    match std::env::var("HOLOGRAM_SNAPSHOT_MIN_EDGES") {
        Ok(v) => v.trim().parse::<usize>().unwrap_or(DEFAULT_SNAPSHOT_MIN_EDGES),
        Err(_) => DEFAULT_SNAPSHOT_MIN_EDGES,
    }
}

/// Node 的快照镜像 —— 字段一一对应，唯 properties 以 JSON 文本承载：
/// serde_json::Value 的反序列化走 deserialize_any，bincode 1.3 不支持。
#[derive(Serialize, Deserialize)]
pub struct SnapshotNode {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub location: Option<String>,
    pub snippet: Option<String>,
    /// properties 的 JSON 文本（序列化自 serde_json::Value）
    pub properties: String,
    pub out_degree: u32,
    pub in_degree: u32,
    pub non_defines_in_degree: u32,
    pub position: Option<[f32; 3]>,
    pub community_id: Option<usize>,
}

impl SnapshotNode {
    /// 从 Node 提取快照镜像（properties 序列化为 JSON 文本）。
    pub fn from_node(node: &Node) -> Self {
        Self {
            id: node.id.clone(),
            name: node.name.clone(),
            kind: node.kind,
            location: node.location.clone(),
            snippet: node.snippet.clone(),
            properties: serde_json::to_string(&node.properties)
                .unwrap_or_else(|_| "{}".into()),
            out_degree: node.out_degree,
            in_degree: node.in_degree,
            non_defines_in_degree: node.non_defines_in_degree,
            position: node.position,
            community_id: node.community_id,
        }
    }

    /// 还原为 Node（properties 文本解析失败时回退空对象）。
    pub fn into_node(self) -> Node {
        Node {
            id: self.id,
            name: self.name,
            kind: self.kind,
            location: self.location,
            snippet: self.snippet,
            properties: serde_json::from_str(&self.properties).unwrap_or_default(),
            out_degree: self.out_degree,
            in_degree: self.in_degree,
            non_defines_in_degree: self.non_defines_in_degree,
            position: self.position,
            community_id: self.community_id,
        }
    }
}

/// MemoryIndex 的纯数据快照 —— bincode 1.3 序列化落盘。
/// 字段与 MemoryIndex 一一对应；arena 只存字符串表
/// （lookup 由 StringArena::from_strings 重建）。
/// fts_dirty 不进快照 —— 反序列化后恒置 true（FTS 惰性重建）。
#[derive(Serialize, Deserialize)]
pub struct MemoryIndexSnapshot {
    /// StringArena 的字符串表（索引 0 = 空哨兵）
    pub arena_strings: Vec<String>,
    /// u32 句柄 → Node 快照镜像（properties 为 JSON 文本）
    pub nodes: HashMap<u32, SnapshotNode>,
    /// 排序后的节点句柄；索引 = 稠密索引
    pub node_by_idx: Vec<u32>,
    /// 节点句柄 → 稠密索引
    pub handle_to_idx: HashMap<u32, u32>,
    // ── CSR 出边 ──
    pub out_offsets: Vec<u32>,
    pub out_targets: Vec<u32>,
    pub out_kinds: Vec<u8>,
    pub out_coupling: Vec<u8>,
    pub out_delays: Vec<f64>,
    // ── CSR 入边 ──
    pub in_offsets: Vec<u32>,
    pub in_targets: Vec<u32>,
    pub in_kinds: Vec<u8>,
    pub in_coupling: Vec<u8>,
    pub in_delays: Vec<f64>,
    // ── 变更缓冲区 ──
    pub pending_adds: Vec<(u32, u32, EdgeKind, u8, Option<f64>)>,
    pub pending_removes: HashSet<(u32, u32, EdgeKind)>,
    /// 符号名称 → 节点句柄
    pub name_index: HashMap<String, Vec<u32>>,
    /// 文件路径 → 节点句柄
    pub file_index: HashMap<String, Vec<u32>>,
    pub edge_count: usize,
    pub has_aux_indexes: bool,
    /// 合成边索引: (source_handle, target_handle)
    pub synthesized_edges: HashSet<(u32, u32)>,
}

/// env 串行锁 —— HOLOGRAM_SNAPSHOT_MIN_EDGES 相关测试互斥，
/// 避免并行测试读写到别的用例设置的值。
#[cfg(test)]
pub(crate) static SNAPSHOT_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, Graph, Node, NodeKind};
    use crate::storage::memory::MemoryIndex;

    fn unique_tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("hologram_test_snap_{}_{}", name, std::process::id()))
    }

    fn build_rich_index() -> MemoryIndex {
        let mut g = Graph::new();
        let mut n1 = Node::new("src/a.rs::fn_a", "fn_a", NodeKind::Function);
        n1.location = Some("src/a.rs:10".into());
        n1.community_id = Some(7);
        n1.position = Some([1.0, 2.0, 3.0]);
        n1.properties = serde_json::json!({"role": "entry", "weight": 3});
        let mut n2 = Node::new("src/b.rs::fn_b", "fn_b", NodeKind::Function);
        n2.location = Some("src/b.rs:20".into());
        n2.community_id = Some(7);
        let mut n3 = Node::new("src/c.rs::Cls", "Cls", NodeKind::Class);
        n3.location = Some("src/c.rs:1".into());
        n3.community_id = Some(9);
        g.add_node(n1);
        g.add_node(n2);
        g.add_node(n3);
        let mut e1 = Edge::new("e1", "src/a.rs::fn_a", "src/b.rs::fn_b", EdgeKind::Calls);
        e1.coupling_depth = 2;
        e1.temporal_delay_sec = Some(0.5);
        let e2 = Edge::synthesized("e2", "src/b.rs::fn_b", "src/c.rs::Cls", EdgeKind::Usage, "test-channel");
        g.add_edge_unchecked(e1);
        g.add_edge_unchecked(e2);
        let (nodes, edges) = g.into_parts();
        MemoryIndex::from_existing_graph(nodes, edges)
    }

    #[test]
    fn test_snapshot_min_edges_default() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        std::env::remove_var("HOLOGRAM_SNAPSHOT_MIN_EDGES");
        assert_eq!(snapshot_min_edges(), 5_000_000);
    }

    #[test]
    fn test_snapshot_min_edges_valid_override() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        std::env::set_var("HOLOGRAM_SNAPSHOT_MIN_EDGES", "42");
        assert_eq!(snapshot_min_edges(), 42);
        std::env::remove_var("HOLOGRAM_SNAPSHOT_MIN_EDGES");
    }

    #[test]
    fn test_snapshot_min_edges_invalid_fallback() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        for bad in ["not_a_number", "-1", "", "1.5"] {
            std::env::set_var("HOLOGRAM_SNAPSHOT_MIN_EDGES", bad);
            assert_eq!(snapshot_min_edges(), 5_000_000, "非法值 {:?} 应回退默认", bad);
        }
        std::env::remove_var("HOLOGRAM_SNAPSHOT_MIN_EDGES");
    }

    /// 快照 roundtrip：节点/边/社区/属性/辅助索引/合成边全部保留，
    /// 且反序列化后 fts_dirty 恒为 true（FTS 惰性重建）。
    #[test]
    fn test_snapshot_roundtrip() {
        let tmp = unique_tmp("roundtrip");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let idx = build_rich_index();
        assert!(idx.fts_dirty(), "from_existing_graph 后 dirty=true");
        idx.save_snapshot(&tmp).unwrap();
        assert!(snapshot_path(&tmp).exists());
        assert!(!snapshot_tmp_path(&tmp).exists(), "rename 后 .tmp 不应残留");

        let loaded = MemoryIndex::load_snapshot(&tmp).unwrap();
        assert_eq!(loaded.node_count(), idx.node_count());
        assert_eq!(loaded.edge_count(), idx.edge_count());
        assert_eq!(loaded.has_aux_indexes(), idx.has_aux_indexes());
        assert!(loaded.fts_dirty(), "快照反序列化后 dirty 恒为 true");

        // 抽样节点字段
        let n1 = loaded.get_node("src/a.rs::fn_a").unwrap();
        assert_eq!(n1.name, "fn_a");
        assert_eq!(n1.location.as_deref(), Some("src/a.rs:10"));
        assert_eq!(n1.community_id, Some(7));
        assert_eq!(n1.position, Some([1.0, 2.0, 3.0]));
        assert_eq!(n1.properties, serde_json::json!({"role": "entry", "weight": 3}));

        // 辅助索引可查
        assert_eq!(loaded.get_nodes_by_name("fn_b").len(), 1);
        assert_eq!(loaded.get_nodes_by_file("src/c.rs").len(), 1);

        // 边字段（kind/coupling/delay）保留
        let out = loaded.outgoing("src/a.rs::fn_a", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "src/b.rs::fn_b");
        assert_eq!(out[0].1, EdgeKind::Calls);
        assert_eq!(out[0].2, 2);
        assert_eq!(out[0].3, Some(0.5));

        // 合成边索引保留
        assert!(loaded.is_edge_synthesized("src/b.rs::fn_b", "src/c.rs::Cls"));
        assert!(!loaded.is_edge_synthesized("src/a.rs::fn_a", "src/b.rs::fn_b"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_load_snapshot_missing_file() {
        let tmp = unique_tmp("missing");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let result = MemoryIndex::load_snapshot(&tmp);
        assert!(result.is_err(), "不存在的快照应返回 Err");
        assert!(!snapshot_path(&tmp).exists(), "失败不应产生副作用文件");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_load_snapshot_corrupted() {
        let tmp = unique_tmp("corrupted");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".hologram")).unwrap();
        // 垃圾字节 —— bincode 反序列化必须失败
        std::fs::write(snapshot_path(&tmp), b"\xde\xad\xbe\xef garbage not bincode \x00\x01").unwrap();
        let result = MemoryIndex::load_snapshot(&tmp);
        assert!(result.is_err(), "损坏快照应返回 Err");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
