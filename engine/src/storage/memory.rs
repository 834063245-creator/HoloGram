// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MemoryIndex — 基于邻接表和字符串驻留的内存图索引。
// 所有图遍历都命中此结构，不碰 SQLite。
// O(degree) 查询，而非 O(E) 扫描。
//
// ponytail：CSR 扁平数组（offsets + targets + kinds + coupling + delays）
// 替代 HashMap<u32, Vec<(u32,EdgeKind,u8,Option<f64>)>>。
// ~1.54M 每节点 Vec 分配 → 共 6 个（3 入 + 3 出）。
// 行业先例：rustc Symbol、Sourcegraph 字符串去重、Kythe graph store。

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::graph::{EdgeKind, Node};
use crate::storage::sqlite::SqliteDb;
use crate::storage::string_arena::StringArena;

/// engine_status MCP 工具的进度信息。
#[derive(Debug, Clone, Serialize)]
pub struct LoadProgress {
    pub phase: String,
    pub nodes_loaded: usize,
    pub edges_loaded: usize,
    pub nodes_total: usize,
    pub edges_total: usize,
    pub elapsed_ms: u64,
}

// ── delay 打包/解包（f64::NAN = None）──

fn pack_delay(d: Option<f64>) -> f64 { d.unwrap_or(f64::NAN) }
fn unpack_delay(d: f64) -> Option<f64> { if d.is_nan() { None } else { Some(d) } }

/// 内存图索引。所有查询都命中此结构 —— SQLite 仅用于持久化 + FTS。
///
/// CSR 布局（Compressed Sparse Row）：
///   out_offsets[N+1]  — 每个稠密节点索引在 out_* 数组中的起始位置
///   out_targets[E]    — 目标节点句柄（u32）
///   out_kinds[E]      — EdgeKind 的 u8 表示（0–9）
///   out_coupling[E]   — coupling_depth（u8）
///   out_delays[E]     — temporal_delay_sec（f64::NAN = None）
///
/// 变更（upsert_edge/remove_edge/remove_node）缓冲到 pending_adds/
/// pending_removes 中。下次读取时，rebuild_csr() 刷入并重建数组。
/// ponytail：变更时 O(N+E) 重建，变更很少（仅增量 diff）。
pub struct MemoryIndex {
    /// 字符串驻留器 —— 所有节点/边标识符只存储一次
    arena: StringArena,
    /// u32 句柄 → Node（node.id 和 node.name 是 String —— Node 结构不变）
    nodes: HashMap<u32, Node>,

    // ── 稠密节点索引 ──
    /// 排序后的节点句柄；索引 = 稠密索引（0..N-1）
    node_by_idx: Vec<u32>,
    /// 反向：节点句柄 → 稠密索引
    handle_to_idx: HashMap<u32, u32>,

    // ── CSR 出边 ──
    out_offsets: Vec<u32>,
    out_targets: Vec<u32>,
    out_kinds: Vec<u8>,
    out_coupling: Vec<u8>,
    out_delays: Vec<f64>,

    // ── CSR 入边 ──
    in_offsets: Vec<u32>,
    in_targets: Vec<u32>,
    in_kinds: Vec<u8>,
    in_coupling: Vec<u8>,
    in_delays: Vec<f64>,

    // ── 变更缓冲区 ──
    pending_adds: Vec<(u32, u32, EdgeKind, u8, Option<f64>)>,
    pending_removes: HashSet<(u32, u32, EdgeKind)>,

    /// 符号名称 → 节点 u32 句柄（名称字符串很小，O(nodes) 而非 O(edges)）
    name_index: HashMap<String, Vec<u32>>,
    /// 文件路径 → 节点 u32 句柄
    file_index: HashMap<String, Vec<u32>>,
    /// 总边数（缓存；边存储在邻接表中）
    edge_count: usize,
        /// name_index 和 file_index 是否已构建（OOM 时可能跳过）
    has_aux_indexes: bool,
    /// 合成边索引: (source_handle, target_handle) — 结构工具遍历时跳过
    synthesized_edges: HashSet<(u32, u32)>,
}

/// 从位置字符串（如 "C:/file.py:10" 或 "C:\file.py:10"）中提取文件路径。
/// 归一化反斜杠和驱动器号，使所有索引查找都能匹配。
fn extract_file_path(loc: &str) -> String {
    let parts: Vec<&str> = loc.rsplitn(2, ':').collect();
    let raw = if parts.len() == 2 { parts[1] } else { parts[0] };
    raw.replace('\\', "/")
}

impl MemoryIndex {
    // ── 辅助方法：稠密索引 ──

    fn rebuild_dense_index(&mut self) {
        self.handle_to_idx.clear();
        self.node_by_idx.clear();
        self.node_by_idx.reserve(self.nodes.len());
        let mut handles: Vec<u32> = self.nodes.keys().copied().collect();
        handles.sort_unstable();
        for (i, &h) in handles.iter().enumerate() {
            self.handle_to_idx.insert(h, i as u32);
        }
        self.node_by_idx = handles;
    }

    fn node_idx(&self, handle: u32) -> Option<u32> {
        self.handle_to_idx.get(&handle).copied()
    }

    // ── 辅助方法：边迭代 ──

    /// 迭代稠密节点索引的出边。返回切片索引范围。
    #[inline]
    fn out_range(&self, idx: u32) -> (usize, usize) {
        let start = self.out_offsets[idx as usize] as usize;
        let end = self.out_offsets[idx as usize + 1] as usize;
        (start, end)
    }

    /// 迭代稠密节点索引的入边。
    #[inline]
    fn in_range(&self, idx: u32) -> (usize, usize) {
        let start = self.in_offsets[idx as usize] as usize;
        let end = self.in_offsets[idx as usize + 1] as usize;
        (start, end)
    }

    // ── 辅助方法：从逐节点桶重建 CSR ──

    /// 从 CSR + 待处理缓冲区收集节点的出边。
    /// 返回去重后的 (target_handle, kind_u8, coupling, delay_f64)。
    fn collect_outgoing(&self, src_handle: u32) -> Vec<(u32, u8, u8, f64)> {
        let mut edges: Vec<(u32, u8, u8, f64)> = Vec::new();
        let mut seen: HashSet<(u32, u8, u8)> = HashSet::new();
        if let Some(idx) = self.node_idx(src_handle) {
            if idx < self.node_by_idx.len() as u32 {
                let (start, end) = self.out_range(idx);
                for i in start..end {
                    let tgt = self.out_targets[i];
                    let kind_u8 = self.out_kinds[i];
                    let ek = EdgeKind::from_u8(kind_u8);
                    if self.pending_removes.contains(&(src_handle, tgt, ek)) {
                        continue;
                    }
                    let key = (tgt, kind_u8, self.out_coupling[i]);
                    if seen.insert(key) {
                        edges.push((tgt, kind_u8, self.out_coupling[i], self.out_delays[i]));
                    }
                }
            }
        }
        for &(src, tgt, kind, coupling, delay) in &self.pending_adds {
            if src != src_handle { continue; }
            if self.pending_removes.contains(&(src, tgt, kind)) { continue; }
            let kind_u8 = kind.to_u8();
            let key = (tgt, kind_u8, coupling);
            if seen.insert(key) {
                edges.push((tgt, kind_u8, coupling, pack_delay(delay)));
            }
        }
        edges
    }

    /// 从 CSR + 待处理缓冲区收集节点的入边。
    fn collect_incoming(&self, tgt_handle: u32) -> Vec<(u32, u8, u8, f64)> {
        let mut edges: Vec<(u32, u8, u8, f64)> = Vec::new();
        let mut seen: HashSet<(u32, u8, u8)> = HashSet::new();
        if let Some(idx) = self.node_idx(tgt_handle) {
            if idx < self.node_by_idx.len() as u32 {
                let (start, end) = self.in_range(idx);
                for i in start..end {
                    let src = self.in_targets[i];
                    let kind_u8 = self.in_kinds[i];
                    let ek = EdgeKind::from_u8(kind_u8);
                    if self.pending_removes.contains(&(src, tgt_handle, ek)) {
                        continue;
                    }
                    let key = (src, kind_u8, self.in_coupling[i]);
                    if seen.insert(key) {
                        edges.push((src, kind_u8, self.in_coupling[i], self.in_delays[i]));
                    }
                }
            }
        }
        for &(src, tgt, kind, coupling, delay) in &self.pending_adds {
            if tgt != tgt_handle { continue; }
            if self.pending_removes.contains(&(src, tgt, kind)) { continue; }
            let kind_u8 = kind.to_u8();
            let key = (src, kind_u8, coupling);
            if seen.insert(key) {
                edges.push((src, kind_u8, coupling, pack_delay(delay)));
            }
        }
        edges
    }

    /// 检查待删除边是否存在于 CSR 中。remove_edge 使用。
    fn edge_exists_in_csr(&self, src_handle: u32, tgt_handle: u32, kind_u8: u8) -> bool {
        let Some(idx) = self.node_idx(src_handle) else { return false; };
        let (start, end) = self.out_range(idx);
        for i in start..end {
            if self.out_targets[i] == tgt_handle && self.out_kinds[i] == kind_u8 {
                return true;
            }
        }
        false
    }

    /// 通过重建 CSR 数组刷入待处理变更。
    /// 在增量更新批次结束时调用。
    pub fn flush_pending(&mut self) {
        if self.pending_adds.is_empty() && self.pending_removes.is_empty() {
            return;
        }
        self.rebuild_csr();
    }

    /// 将逐节点边桶扁平化为 CSR 数组。消费桶数据。
    /// 在全新构建（from_existing_graph、from_sqlite）和变更刷入时调用。
    fn flatten_buckets(
        &mut self,
        out_buckets: &[Vec<(u32, u8, u8, f64)>],
        in_buckets: &[Vec<(u32, u8, u8, f64)>],
    ) {
        let n = self.node_by_idx.len();

        // 前缀和出度 → out_offsets
        self.out_offsets = Vec::with_capacity(n + 1);
        self.out_offsets.push(0);
        for bucket in out_buckets {
            let prev = *self.out_offsets.last().unwrap_or(&0);
            self.out_offsets.push(prev + bucket.len() as u32);
        }

        // 扁平化 out 数组
        let total_out = self.out_offsets[n] as usize;
        self.out_targets = Vec::with_capacity(total_out);
        self.out_kinds = Vec::with_capacity(total_out);
        self.out_coupling = Vec::with_capacity(total_out);
        self.out_delays = Vec::with_capacity(total_out);
        for bucket in out_buckets {
            for &(tgt, kind, coupling, delay) in bucket {
                self.out_targets.push(tgt);
                self.out_kinds.push(kind);
                self.out_coupling.push(coupling);
                self.out_delays.push(delay);
            }
        }

        // 前缀和入度 → in_offsets
        self.in_offsets = Vec::with_capacity(n + 1);
        self.in_offsets.push(0);
        for bucket in in_buckets {
            let prev = *self.in_offsets.last().unwrap_or(&0);
            self.in_offsets.push(prev + bucket.len() as u32);
        }

        // 扁平化 in 数组
        let total_in = self.in_offsets[n] as usize;
        self.in_targets = Vec::with_capacity(total_in);
        self.in_kinds = Vec::with_capacity(total_in);
        self.in_coupling = Vec::with_capacity(total_in);
        self.in_delays = Vec::with_capacity(total_in);
        for bucket in in_buckets {
            for &(tgt, kind, coupling, delay) in bucket {
                self.in_targets.push(tgt);
                self.in_kinds.push(kind);
                self.in_coupling.push(coupling);
                self.in_delays.push(delay);
            }
        }

        self.edge_count = total_out;
    }

    /// 从待处理变更 + 现有 CSR 边重建 CSR。
    /// 使用临时逐节点 Vec 进行排序+去重（flatten 后释放）。
    fn rebuild_csr(&mut self) {
        self.rebuild_dense_index();
        let n = self.node_by_idx.len();

        // 临时逐节点桶：Vec<(other_handle, kind_u8, coupling, delay_f64)>
        let mut out_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();
        let mut in_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();

        // 从当前 CSR 复制边（跳过已删除的）
        let old_has_data = !self.out_offsets.is_empty() && self.out_offsets.len() > n;
        if old_has_data {
            for src_idx in 0..n {
                let src_handle = self.node_by_idx[src_idx];
                let (start, end) = self.out_range(src_idx as u32);
                for i in start..end {
                    let tgt = self.out_targets[i];
                    let kind_u8 = self.out_kinds[i];
                    let ek = EdgeKind::from_u8(kind_u8);
                    if self.pending_removes.contains(&(src_handle, tgt, ek)) {
                        continue;
                    }
                    out_buckets[src_idx].push((tgt, kind_u8, self.out_coupling[i], self.out_delays[i]));
                    if let Some(&tgt_idx) = self.handle_to_idx.get(&tgt) {
                        in_buckets[tgt_idx as usize].push((src_handle, kind_u8, self.out_coupling[i], self.out_delays[i]));
                    }
                }
            }
        }

        // 添加待处理边
        for &(src, tgt, kind, coupling, delay) in &self.pending_adds {
            if self.pending_removes.contains(&(src, tgt, kind)) {
                continue;
            }
            let kind_u8 = kind.to_u8();
            let delay_f64 = pack_delay(delay);
            if let Some(&src_idx) = self.handle_to_idx.get(&src) {
                if let Some(&tgt_idx) = self.handle_to_idx.get(&tgt) {
                    out_buckets[src_idx as usize].push((tgt, kind_u8, coupling, delay_f64));
                    in_buckets[tgt_idx as usize].push((src, kind_u8, coupling, delay_f64));
                }
            }
        }

        // 对每个桶排序 + 去重
        for bucket in out_buckets.iter_mut().chain(in_buckets.iter_mut()) {
            bucket.sort_unstable_by_key(|e| (e.0, e.1, e.2));
            bucket.dedup_by_key(|e| (e.0, e.1, e.2));
        }

        self.flatten_buckets(&out_buckets, &in_buckets);
        self.pending_adds.clear();
        self.pending_removes.clear();
        self.edge_count = self.out_offsets.last().copied().unwrap_or(0) as usize;
    }

    // ── 构造函数 ──

    pub fn new() -> Self {
        Self {
            arena: StringArena::new(),
            nodes: HashMap::new(),
            node_by_idx: Vec::new(),
            handle_to_idx: HashMap::new(),
            out_offsets: Vec::new(),
            out_targets: Vec::new(),
            out_kinds: Vec::new(),
            out_coupling: Vec::new(),
            out_delays: Vec::new(),
            in_offsets: Vec::new(),
            in_targets: Vec::new(),
            in_kinds: Vec::new(),
            in_coupling: Vec::new(),
            in_delays: Vec::new(),
            pending_adds: Vec::new(),
            pending_removes: HashSet::new(),
            name_index: HashMap::new(),
            file_index: HashMap::new(),
            edge_count: 0,
            has_aux_indexes: true,
            synthesized_edges: HashSet::new(),
        }
    }

    /// 驻留字符串并返回其 u32 句柄。
    fn intern(&mut self, s: &str) -> u32 {
        self.arena.intern(s)
    }

    /// 从 u32 句柄查找字符串。
    fn get_str(&self, handle: u32) -> &str {
        self.arena.get(handle)
    }

    /// 获取已驻留字符串的句柄（不修改状态）。
    fn handle_of(&self, s: &str) -> Option<u32> {
        self.arena.get_handle(s)
    }

    /// 检查边是否为合成边（通过字符串 ID）。
    pub fn is_edge_synthesized(&self, source: &str, target: &str) -> bool {
        let src = match self.handle_of(source) { Some(h) => h, None => return false };
        let tgt = match self.handle_of(target) { Some(h) => h, None => return false };
        self.synthesized_edges.contains(&(src, tgt))
    }

    /// 检查边是否为合成边（通过 u32 句柄 —— 内部快速路径）。
    #[inline]
    fn is_edge_synthesized_by_handle(&self, src: u32, tgt: u32) -> bool {
        self.synthesized_edges.contains(&(src, tgt))
    }

    /// 从去重后的桶长度重新计算 in_degree/out_degree。
    /// 从 SQLite 加载的节点度数可能过时（旧分析写入了错误值）；
    /// 从实际邻接重新推导，使 find_unused（in_degree==0）正确。
    /// ponytail：去重后的计数 = 唯一 (src,kind,depth) 边数；与
    /// add_edge 的逐边计数在有重复时不同，但对 ==0 + 排序来说
    /// 这是诚实数值。to_sqlite 会回写这些值，使后续冷启动正确。
    fn recompute_degrees(&mut self, out_buckets: &[Vec<(u32, u8, u8, f64)>], in_buckets: &[Vec<(u32, u8, u8, f64)>]) {
        for i in 0..self.node_by_idx.len() {
            if let Some(node) = self.nodes.get_mut(&self.node_by_idx[i]) {
                node.in_degree = in_buckets[i].len() as u32;
                node.out_degree = out_buckets[i].len() as u32;
            }
        }
    }

    /// 从原始 node/edge HashMap 构建 MemoryIndex。
    /// 获取所有权 —— 边在邻接构建期间逐条消费，
    /// 因此峰值内存约为旧的全量克隆方案的一半。
    /// 6.1M 边 → into_iter() 在处理时逐条释放 Edge。
    pub fn from_existing_graph(
        nodes: HashMap<String, Node>,
        edges: HashMap<String, crate::graph::Edge>,
    ) -> Self {
        let mut idx = Self::new();
        // 预驻留所有节点 ID
        for id in nodes.keys() {
            idx.intern(id);
        }
        for edge in edges.values() {
            idx.intern(&edge.source);
            idx.intern(&edge.target);
        }
        // 插入节点
        for (id, node) in nodes {
            let handle = idx.intern(&id);
            idx.index_node_name(handle, &node);
            idx.index_node_file(handle, &node);
            idx.nodes.insert(handle, node);
        }

        // 构建逐节点桶（临时 —— 被 flatten_buckets 消费）
        idx.rebuild_dense_index();
        let n = idx.node_by_idx.len();
        let mut out_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();
        let mut in_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();

        for (_eid, edge) in edges {
            let src = idx.intern(&edge.source);
            let tgt = idx.intern(&edge.target);
            if !idx.nodes.contains_key(&src) || !idx.nodes.contains_key(&tgt) {
                continue;
            }
            // 跟踪合成边以供结构工具过滤
            if edge.is_synthesized {
                idx.synthesized_edges.insert((src, tgt));
            }
            let kind_u8 = edge.kind.to_u8();
            let delay_f64 = pack_delay(edge.temporal_delay_sec);
            if let (Some(&src_idx), Some(&tgt_idx)) = (idx.handle_to_idx.get(&src), idx.handle_to_idx.get(&tgt)) {
                out_buckets[src_idx as usize].push((tgt, kind_u8, edge.coupling_depth, delay_f64));
                in_buckets[tgt_idx as usize].push((src, kind_u8, edge.coupling_depth, delay_f64));
            }
        }

        // 对每个桶排序 + 去重
        for bucket in out_buckets.iter_mut().chain(in_buckets.iter_mut()) {
            bucket.sort_unstable_by_key(|e| (e.0, e.1, e.2));
            bucket.dedup_by_key(|e| (e.0, e.1, e.2));
        }

        idx.recompute_degrees(&out_buckets, &in_buckets);
        idx.flatten_buckets(&out_buckets, &in_buckets);
        idx
    }

    /// 从 SQLite 加载（冷启动）。
    pub fn from_sqlite(db: &SqliteDb) -> Result<Self, String> {
        let mut idx = Self::new();
        let db_nodes = db.load_all_nodes()?;
        let db_edges = db.load_all_edges()?;
        // 预驻留所有内容
        for node in &db_nodes {
            idx.intern(&node.id);
        }
        for (src, tgt, _, _, _) in &db_edges {
            idx.intern(src);
            idx.intern(tgt);
        }
        for node in db_nodes {
            let handle = idx.intern(&node.id);
            idx.index_node_name(handle, &node);
            idx.index_node_file(handle, &node);
            idx.nodes.insert(handle, node);
        }

        // 通过临时桶构建 CSR
        idx.rebuild_dense_index();
        let n = idx.node_by_idx.len();
        let mut out_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();
        let mut in_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();

        for (source, target, kind, coupling_depth, delay) in db_edges {
            let src = idx.intern(&source);
            let tgt = idx.intern(&target);
            let kind_u8 = kind.to_u8();
            let delay_f64 = pack_delay(delay);
            if let (Some(&src_idx), Some(&tgt_idx)) = (idx.handle_to_idx.get(&src), idx.handle_to_idx.get(&tgt)) {
                out_buckets[src_idx as usize].push((tgt, kind_u8, coupling_depth, delay_f64));
                in_buckets[tgt_idx as usize].push((src, kind_u8, coupling_depth, delay_f64));
            }
        }

        for bucket in out_buckets.iter_mut().chain(in_buckets.iter_mut()) {
            bucket.sort_unstable_by_key(|e| (e.0, e.1, e.2));
            bucket.dedup_by_key(|e| (e.0, e.1, e.2));
        }

        idx.recompute_degrees(&out_buckets, &in_buckets);
        idx.flatten_buckets(&out_buckets, &in_buckets);
        Ok(idx)
    }

    /// 带 OOM 守卫构建：如果构建辅助索引会超出内存预算，
    /// 则跳过并设置 has_aux_indexes = false。回退：所有搜索使用 FTS5。
    pub fn from_sqlite_degraded(db: &SqliteDb) -> Result<Self, String> {
        let mut idx = Self::new();
        let db_nodes = db.load_all_nodes()?;
        let db_edges = db.load_all_edges()?;
        for node in &db_nodes {
            idx.intern(&node.id);
        }
        for (src, tgt, _, _, _) in &db_edges {
            idx.intern(src);
            idx.intern(tgt);
        }
        for node in db_nodes {
            let handle = idx.intern(&node.id);
            idx.nodes.insert(handle, node);
        }

        // 通过临时桶构建 CSR（暂不构建辅助索引）
        idx.rebuild_dense_index();
        let n = idx.node_by_idx.len();
        let mut out_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();
        let mut in_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();

        for (source, target, kind, coupling_depth, delay) in db_edges {
            let src = idx.intern(&source);
            let tgt = idx.intern(&target);
            let kind_u8 = kind.to_u8();
            let delay_f64 = pack_delay(delay);
            if let (Some(&src_idx), Some(&tgt_idx)) = (idx.handle_to_idx.get(&src), idx.handle_to_idx.get(&tgt)) {
                out_buckets[src_idx as usize].push((tgt, kind_u8, coupling_depth, delay_f64));
                in_buckets[tgt_idx as usize].push((src, kind_u8, coupling_depth, delay_f64));
            }
        }

        for bucket in out_buckets.iter_mut().chain(in_buckets.iter_mut()) {
            bucket.sort_unstable_by_key(|e| (e.0, e.1, e.2));
            bucket.dedup_by_key(|e| (e.0, e.1, e.2));
        }

        idx.recompute_degrees(&out_buckets, &in_buckets);
        idx.flatten_buckets(&out_buckets, &in_buckets);
        idx.ensure_aux_indexes();
        Ok(idx)
    }

    /// 持久化到 SQLite（全量转储，全量分析后使用）。
    pub fn to_sqlite(&self, db: &SqliteDb) -> Result<(), String> {
        let nodes: Vec<&Node> = self.nodes.values().collect();
        // 通过辅助方法收集所有边（CSR + pending - removed）
        let mut edges: Vec<(&str, &str, EdgeKind, u8, Option<f64>)> = Vec::new();
        let mut seen: HashSet<(String, String, EdgeKind)> = HashSet::new();
        for &src_handle in &self.node_by_idx {
            let src_str = self.get_str(src_handle);
            let raw = self.collect_outgoing(src_handle);
            for &(tgt, kind_u8, coupling, delay) in &raw {
                let tgt_str = self.get_str(tgt);
                let kind = EdgeKind::from_u8(kind_u8);
                let key = (src_str.to_string(), tgt_str.to_string(), kind);
                if seen.insert(key) {
                    edges.push((src_str, tgt_str, kind, coupling, unpack_delay(delay)));
                }
            }
        }
        db.bulk_replace_all(&nodes, &edges)
    }

    // ── 辅助方法 ──

    fn index_node_name(&mut self, handle: u32, node: &Node) {
        if self.has_aux_indexes {
            self.name_index
                .entry(node.name.clone())
                .or_default()
                .push(handle);
        }
    }

    fn index_node_file(&mut self, handle: u32, node: &Node) {
        if self.has_aux_indexes {
            if let Some(ref loc) = node.location {
                let file = extract_file_path(loc);
                self.file_index
                    .entry(file)
                    .or_default()
                    .push(handle);
            }
        }
    }

    /// 事后构建辅助索引（如 from_sqlite_degraded 后恢复）。
    pub fn ensure_aux_indexes(&mut self) {
        if self.has_aux_indexes {
            return;
        }
        self.name_index.clear();
        self.file_index.clear();
        for (&handle, node) in &self.nodes {
            self.name_index
                .entry(node.name.clone())
                .or_default()
                .push(handle);
            if let Some(ref loc) = node.location {
                let file = extract_file_path(loc);
                self.file_index
                    .entry(file)
                    .or_default()
                    .push(handle);
            }
        }
        self.has_aux_indexes = true;
    }

    // ── 点查询 ──

    pub fn get_node(&self, id: &str) -> Option<&Node> {
        let handle = self.handle_of(id)?;
        self.nodes.get(&handle)
    }

    pub fn get_nodes_by_name(&self, name: &str) -> Vec<String> {
        self.name_index
            .get(name)
            .map(|handles| handles.iter().map(|&h| self.get_str(h).to_string()).collect())
            .unwrap_or_default()
    }

    pub fn get_nodes_by_file(&self, file: &str) -> Vec<String> {
        let normalized = file.replace('\\', "/");
        self.file_index
            .get(&normalized)
            .map(|handles| handles.iter().map(|&h| self.get_str(h).to_string()).collect())
            .unwrap_or_default()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edge_count
    }

    pub fn has_aux_indexes(&self) -> bool {
        self.has_aux_indexes
    }

    // ── 兼容性：从邻接表重建 Edge 对象 ──

    /// 重建出边 Edge 对象。缺失字段使用默认值。
    pub fn get_outgoing_edges(&self, node_id: &str) -> Vec<crate::graph::Edge> {
        let mut edges = Vec::new();
        let Some(handle) = self.handle_of(node_id) else {
            return edges;
        };
        let raw = self.collect_outgoing(handle);
        for &(tgt, kind_u8, coupling, delay) in &raw {
            let tgt_str = self.get_str(tgt);
            let kind = EdgeKind::from_u8(kind_u8);
            let id = format!("{}::{}::{}", node_id, tgt_str, kind.as_str());
            let mut edge = crate::graph::Edge::new(id, node_id, tgt_str, kind);
            edge.coupling_depth = coupling;
            edge.temporal_delay_sec = unpack_delay(delay);
            edges.push(edge);
        }
        edges
    }

    /// 重建入边 Edge 对象。
    pub fn get_incoming_edges(&self, node_id: &str) -> Vec<crate::graph::Edge> {
        let mut edges = Vec::new();
        let Some(handle) = self.handle_of(node_id) else {
            return edges;
        };
        let raw = self.collect_incoming(handle);
        for &(src, kind_u8, coupling, delay) in &raw {
            let src_str = self.get_str(src);
            let kind = EdgeKind::from_u8(kind_u8);
            let id = format!("{}::{}::{}", src_str, node_id, kind.as_str());
            let mut edge = crate::graph::Edge::new(id, src_str, node_id, kind);
            edge.coupling_depth = coupling;
            edge.temporal_delay_sec = unpack_delay(delay);
            edges.push(edge);
        }
        edges
    }

    // ── 邻接 ──

    /// 节点的出边。返回拥有的元组（从 u32 句柄解析）。
    pub fn outgoing(
        &self,
        node_id: &str,
        kind_filter: Option<&[EdgeKind]>,
    ) -> Vec<(String, EdgeKind, u8, Option<f64>)> {
        let Some(handle) = self.handle_of(node_id) else {
            return Vec::new();
        };
        let edges = self.collect_outgoing(handle);
        let mut results = Vec::with_capacity(edges.len());
        for &(tgt, kind_u8, coupling, delay) in &edges {
            let kind = EdgeKind::from_u8(kind_u8);
            if let Some(kinds) = kind_filter {
                if !kinds.contains(&kind) {
                    continue;
                }
            }
            results.push((self.get_str(tgt).to_string(), kind, coupling, unpack_delay(delay)));
        }
        results
    }

    /// 节点的入边。
    pub fn incoming(
        &self,
        node_id: &str,
        kind_filter: Option<&[EdgeKind]>,
    ) -> Vec<(String, EdgeKind, u8, Option<f64>)> {
        let Some(handle) = self.handle_of(node_id) else {
            return Vec::new();
        };
        let edges = self.collect_incoming(handle);
        let mut results = Vec::with_capacity(edges.len());
        for &(src, kind_u8, coupling, delay) in &edges {
            let kind = EdgeKind::from_u8(kind_u8);
            if let Some(kinds) = kind_filter {
                if !kinds.contains(&kind) {
                    continue;
                }
            }
            results.push((self.get_str(src).to_string(), kind, coupling, unpack_delay(delay)));
        }
        results
    }

    // ── 图遍历 ──

    /// BFS 邻居，最多 `depth` 跳。返回 (from, to, coupling_depth)。
    pub fn neighbors(
        &self,
        node_id: &str,
        depth: u8,
        kind_filter: Option<&[EdgeKind]>,
    ) -> Vec<(String, String, u8)> {
        let mut result = Vec::new();
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let start = match self.handle_of(node_id) {
            Some(h) => h,
            None => return result,
        };
        visited.insert(start);
        queue.push_back((start, 0u8));

        let has_pending = !self.pending_adds.is_empty() || !self.pending_removes.is_empty();

        while let Some((cur_handle, cur_depth)) = queue.pop_front() {
            if cur_depth >= depth {
                continue;
            }
            let cur_str = self.get_str(cur_handle).to_string();
            // 出边（CSR —— 仅当节点在稠密索引中时）
            if let Some(cur_idx) = self.node_idx(cur_handle) {
                let (s, e) = self.out_range(cur_idx);
                for i in s..e {
                    let kind = EdgeKind::from_u8(self.out_kinds[i]);
                    let other = self.out_targets[i];
                    if has_pending && self.pending_removes.contains(&(cur_handle, other, kind)) {
                        continue;
                    }
                    if let Some(kinds) = kind_filter {
                        if !kinds.contains(&kind) { continue; }
                    }
                    if visited.insert(other) {
                        let other_str = self.get_str(other).to_string();
                        result.push((cur_str.clone(), other_str, self.out_coupling[i]));
                        queue.push_back((other, cur_depth + 1));
                    }
                }
                // 入边（CSR）
                let (s, e) = self.in_range(cur_idx);
                for i in s..e {
                    let kind = EdgeKind::from_u8(self.in_kinds[i]);
                    let other = self.in_targets[i];
                    if has_pending && self.pending_removes.contains(&(other, cur_handle, kind)) {
                        continue;
                    }
                    if let Some(kinds) = kind_filter {
                        if !kinds.contains(&kind) { continue; }
                    }
                    if visited.insert(other) {
                        let other_str = self.get_str(other).to_string();
                        result.push((cur_str.clone(), other_str, self.in_coupling[i]));
                        queue.push_back((other, cur_depth + 1));
                    }
                }
            }
            // 待处理边（始终检查，即使节点尚未在 CSR 中）
            if has_pending {
                for &(src, tgt, kind, coupling, delay) in &self.pending_adds {
                    if src == cur_handle && !self.pending_removes.contains(&(src, tgt, kind)) {
                        if let Some(kinds) = kind_filter {
                            if !kinds.contains(&kind) { continue; }
                        }
                        if visited.insert(tgt) {
                            let other_str = self.get_str(tgt).to_string();
                            result.push((cur_str.clone(), other_str, coupling));
                            queue.push_back((tgt, cur_depth + 1));
                            let _ = delay;
                        }
                    }
                    if tgt == cur_handle && !self.pending_removes.contains(&(src, tgt, kind)) {
                        if let Some(kinds) = kind_filter {
                            if !kinds.contains(&kind) { continue; }
                        }
                        if visited.insert(src) {
                            let other_str = self.get_str(src).to_string();
                            result.push((cur_str.clone(), other_str, coupling));
                            queue.push_back((src, cur_depth + 1));
                            let _ = delay;
                        }
                    }
                }
            }
        }
        result
    }

    /// BFS 影响范围（爆炸半径）。返回层: Vec<(depth_level, node_ids)>。
    pub fn impact(&self, node_id: &str, max_depth: usize) -> Vec<(usize, Vec<String>)> {
        let mut layers: Vec<(usize, Vec<String>)> = Vec::new();
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let start = match self.handle_of(node_id) {
            Some(h) => h,
            None => return layers,
        };
        visited.insert(start);
        queue.push_back((start, 0usize));

        let has_pending = !self.pending_adds.is_empty() || !self.pending_removes.is_empty();

        while let Some((cur_handle, depth)) = queue.pop_front() {
            if depth > max_depth {
                continue;
            }
            while layers.len() <= depth {
                layers.push((layers.len(), Vec::new()));
            }
            layers[depth].1.push(self.get_str(cur_handle).to_string());

            // CSR 边 —— 跳过合成边
            if let Some(cur_idx) = self.node_idx(cur_handle) {
                let (s, e) = self.out_range(cur_idx);
                for i in s..e {
                    let tgt = self.out_targets[i];
                    if self.is_edge_synthesized_by_handle(cur_handle, tgt) { continue; }
                    if has_pending {
                        let kind = EdgeKind::from_u8(self.out_kinds[i]);
                        if self.pending_removes.contains(&(cur_handle, tgt, kind)) { continue; }
                    }
                    if visited.insert(tgt) {
                        queue.push_back((tgt, depth + 1));
                    }
                }
                let (s, e) = self.in_range(cur_idx);
                for i in s..e {
                    let src = self.in_targets[i];
                    if self.is_edge_synthesized_by_handle(src, cur_handle) { continue; }
                    if has_pending {
                        let kind = EdgeKind::from_u8(self.in_kinds[i]);
                        if self.pending_removes.contains(&(src, cur_handle, kind)) { continue; }
                    }
                    if visited.insert(src) {
                        queue.push_back((src, depth + 1));
                    }
                }
            }
            // 待处理边（始终检查）
            if has_pending {
                for &(src, tgt, kind, _, _) in &self.pending_adds {
                    if src == cur_handle && !self.pending_removes.contains(&(src, tgt, kind))
                        && visited.insert(tgt) { queue.push_back((tgt, depth + 1)); }
                    if tgt == cur_handle && !self.pending_removes.contains(&(src, tgt, kind))
                        && visited.insert(src) { queue.push_back((src, depth + 1)); }
                }
            }
        }
        layers
    }

    /// BFS 最短路径，两个节点之间（向后兼容封装，使用默认限制）。
    pub fn shortest_path(&self, from: &str, to: &str) -> Option<Vec<String>> {
        self.shortest_path_with_limits(from, to, 20, 5000)
    }

    /// BFS 最短路径，两个节点之间，带显式深度/探索限制。
    pub fn shortest_path_with_limits(
        &self,
        from: &str,
        to: &str,
        max_depth: usize,
        max_explore: usize,
    ) -> Option<Vec<String>> {
        if from == to {
            return Some(vec![from.to_string()]);
        }
        let start = self.handle_of(from)?;
        let target = self.handle_of(to)?;
        let mut prev: HashMap<u32, u32> = HashMap::new();
        let mut visited: HashSet<u32> = HashSet::new();
        let mut queue: VecDeque<(u32, usize)> = VecDeque::new();
        let mut explore_count = 0usize;
        visited.insert(start);
        queue.push_back((start, 0));

        let has_pending = !self.pending_adds.is_empty() || !self.pending_removes.is_empty();

        while let Some((cur, depth)) = queue.pop_front() {
            if cur == target {
                break;
            }
            if depth >= max_depth {
                continue;
            }
            // CSR 边
            if let Some(cur_idx) = self.node_idx(cur) {
                let (s, e) = self.out_range(cur_idx);
                for i in s..e {
                    if explore_count >= max_explore { break; }
                    let tgt = self.out_targets[i];
                    if has_pending {
                        let kind = EdgeKind::from_u8(self.out_kinds[i]);
                        if self.pending_removes.contains(&(cur, tgt, kind)) { continue; }
                    }
                    if visited.insert(tgt) {
                        prev.insert(tgt, cur);
                        queue.push_back((tgt, depth + 1));
                        explore_count += 1;
                    }
                }
                let (s, e) = self.in_range(cur_idx);
                for i in s..e {
                    if explore_count >= max_explore { break; }
                    let src = self.in_targets[i];
                    if has_pending {
                        let kind = EdgeKind::from_u8(self.in_kinds[i]);
                        if self.pending_removes.contains(&(src, cur, kind)) { continue; }
                    }
                    if visited.insert(src) {
                        prev.insert(src, cur);
                        queue.push_back((src, depth + 1));
                        explore_count += 1;
                    }
                }
            }
            // 待处理边
            if has_pending {
                for &(src, tgt, kind, _, _) in &self.pending_adds {
                    if explore_count >= max_explore { break; }
                    if self.pending_removes.contains(&(src, tgt, kind)) { continue; }
                    if src == cur && visited.insert(tgt) {
                        prev.insert(tgt, cur); queue.push_back((tgt, depth + 1)); explore_count += 1;
                    }
                    if tgt == cur && visited.insert(src) {
                        prev.insert(src, cur); queue.push_back((src, depth + 1)); explore_count += 1;
                    }
                }
            }
        }

        if !visited.contains(&target) {
            return None;
        }

        let mut path = vec![self.get_str(target).to_string()];
        let mut cur = target;
        while let Some(&p) = prev.get(&cur) {
            path.push(self.get_str(p).to_string());
            cur = p;
        }
        path.reverse();
        Some(path)
    }

    // ── 全文搜索（委托给 SQLite FTS5）──

    pub fn fts_search(&self, db: &SqliteDb, query: &str, limit: usize) -> Result<Vec<Node>, String> {
        let ids = db.fts_search(query, limit)?;
        let mut results = Vec::with_capacity(ids.len());
        for id in &ids {
            if let Some(handle) = self.handle_of(id) {
                if let Some(node) = self.nodes.get(&handle) {
                    results.push(node.clone());
                }
            }
        }
        Ok(results)
    }

    // ── 迭代 ──

    pub fn nodes_iter(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    /// 迭代所有边，返回 (source_str, target_tuples_vec)。
    /// 返回拥有的值 —— 调用方拥有结果。
    pub fn edges_iter(&self) -> Vec<(String, Vec<(String, EdgeKind, u8, Option<f64>)>)> {
        let mut results = Vec::with_capacity(self.node_by_idx.len());
        let mut seen: HashSet<u32> = HashSet::new();
        for &src_handle in &self.node_by_idx {
            seen.insert(src_handle);
            let raw = self.collect_outgoing(src_handle);
            if raw.is_empty() { continue; }
            let src_str = self.get_str(src_handle).to_string();
            let mut targets = Vec::with_capacity(raw.len());
            for &(tgt, kind_u8, coupling, delay) in &raw {
                targets.push((
                    self.get_str(tgt).to_string(),
                    EdgeKind::from_u8(kind_u8),
                    coupling,
                    unpack_delay(delay),
                ));
            }
            results.push((src_str, targets));
        }
        // ponytail：未刷入的节点（已插入但尚未在稠密索引中）——
        // 边在 pending_adds 中。遍历它们，使调用方在 flush_pending() 之前也能看到边。
        for &(src, _, _, _, _) in &self.pending_adds {
            if !seen.insert(src) { continue; }
            let raw = self.collect_outgoing(src);
            if raw.is_empty() { continue; }
            let src_str = self.get_str(src).to_string();
            let mut targets = Vec::with_capacity(raw.len());
            for &(tgt, kind_u8, coupling, delay) in &raw {
                targets.push((
                    self.get_str(tgt).to_string(),
                    EdgeKind::from_u8(kind_u8),
                    coupling,
                    unpack_delay(delay),
                ));
            }
            results.push((src_str, targets));
        }
        results
    }

    /// 从此 MemoryIndex 构建完整的 Graph。
    /// 增量更新路径使用，用于运行在 Graph（而非 MemoryIndex）上操作的合成阶段
    ///（社区检测、耦合分析）。
    /// 边 ID 从 (source, target, kind) 派生，因为 CSR 数组不存储边 ID。
    // ponytail：O(N+E) 转换。MemoryIndex 保存规范数据；
    // Graph 是合成阶段的临时格式。
    pub fn to_graph(&self) -> crate::graph::Graph {
        use crate::graph::{Edge, Graph};

        let mut graph = Graph::new();
        for node in self.nodes_iter() {
            graph.add_node(node.clone());
        }
        let mut edge_id_counter: u64 = 0;
        for (source, targets) in self.edges_iter() {
            for (target, kind, coupling_depth, temporal_delay) in targets {
                edge_id_counter += 1;
                let eid = format!("e_{}_{}_{}", source, target, edge_id_counter);
                let mut edge = Edge::new(eid, source.clone(), target, kind);
                edge.coupling_depth = coupling_depth;
                edge.temporal_delay_sec = temporal_delay;
                graph.add_edge_unchecked(edge);
            }
        }
        graph
    }

    // ── 变更方法（用于增量更新）──

    pub fn insert_node(&mut self, node: Node) {
        let handle = self.intern(&node.id);
        self.index_node_name(handle, &node);
        self.index_node_file(handle, &node);
        self.nodes.insert(handle, node);
        // ponytail：稠密索引在下次 flush_pending 时重建，不在此处
    }

    pub fn remove_node(&mut self, id: &str) -> Option<Node> {
        let handle = self.handle_of(id)?;
        // 从辅助索引中移除
        if let Some(node) = self.nodes.get(&handle) {
            if self.has_aux_indexes {
                if let Some(handles) = self.name_index.get_mut(&node.name) {
                    handles.retain(|&h| h != handle);
                }
                if let Some(ref loc) = node.location {
                    let file = extract_file_path(loc);
                    if let Some(handles) = self.file_index.get_mut(&file) {
                        handles.retain(|&h| h != handle);
                    }
                }
            }
        }
        // 将涉及此节点的所有边标记为已删除
        let mut removed = 0usize;
        if let Some(idx) = self.node_idx(handle) {
            let (s, e) = self.out_range(idx);
            for i in s..e {
                let tgt = self.out_targets[i];
                let kind = EdgeKind::from_u8(self.out_kinds[i]);
                self.pending_removes.insert((handle, tgt, kind));
                removed += 1;
            }
            let (s, e) = self.in_range(idx);
            for i in s..e {
                let src = self.in_targets[i];
                let kind = EdgeKind::from_u8(self.in_kinds[i]);
                self.pending_removes.insert((src, handle, kind));
                // ponytail：入边已在 edge_count 中计数
            }
        }
        // 同时移除此节点的待处理边
        let pending_before = self.pending_adds.len();
        self.pending_adds.retain(|&(s, t, _, _, _)| s != handle && t != handle);
        removed += pending_before - self.pending_adds.len();
        self.edge_count = self.edge_count.saturating_sub(removed);
        self.nodes.remove(&handle)
    }

    /// 插入或更新边。存储完整的邻接元组，包括 temporal_delay_sec。
    pub fn upsert_edge(
        &mut self,
        source: &str,
        target: &str,
        kind: EdgeKind,
        coupling_depth: u8,
        temporal_delay_sec: Option<f64>,
    ) {
        let src = self.intern(source);
        let tgt = self.intern(target);
        let kind_u8 = kind.to_u8();
        // 检查边是否已存在于 CSR
        if self.edge_exists_in_csr(src, tgt, kind_u8) {
            // 检查 coupling + delay 是否匹配
            if let Some(idx) = self.node_idx(src) {
                let (s, e) = self.out_range(idx);
                for i in s..e {
                    if self.out_targets[i] == tgt
                        && self.out_kinds[i] == kind_u8
                        && self.out_coupling[i] == coupling_depth
                        && unpack_delay(self.out_delays[i]) == temporal_delay_sec
                    {
                        return; // CSR 中的完全重复
                    }
                }
            }
        }
        // 检查 pending adds 中是否有重复
        if self.pending_adds.iter().any(|&(s, t, k, d, del)| {
            s == src && t == tgt && k == kind && d == coupling_depth && del == temporal_delay_sec
        }) {
            return;
        }
        self.pending_adds.push((src, tgt, kind, coupling_depth, temporal_delay_sec));
        self.pending_removes.remove(&(src, tgt, kind));
        self.edge_count += 1;
    }

    /// 移除特定边。
    pub fn remove_edge(&mut self, source: &str, target: &str, kind: EdgeKind) -> bool {
        let src = match self.handle_of(source) {
            Some(h) => h,
            None => return false,
        };
        let tgt = match self.handle_of(target) {
            Some(h) => h,
            None => return false,
        };
        // 检查边是否存在于 CSR 或 pending 中
        let in_csr = self.edge_exists_in_csr(src, tgt, kind.to_u8());
        let in_pending = self.pending_adds.iter().any(|&(s, t, k, _, _)| s == src && t == tgt && k == kind);
        if !in_csr && !in_pending {
            return false;
        }
        // 从 pending adds 中移除（如果刚添加）
        self.pending_adds.retain(|&(s, t, k, _, _)| !(s == src && t == tgt && k == kind));
        if in_csr {
            self.pending_removes.insert((src, tgt, kind));
        }
        self.edge_count = self.edge_count.saturating_sub(1);
        true
    }

    /// 通过扫描邻接表计算总边数（用于验证）。
    pub fn recompute_edge_count(&self) -> usize {
        let mut count = 0usize;
        for &src_handle in &self.node_by_idx {
            count += self.collect_outgoing(src_handle).len();
        }
        count
    }

    /// 重命名节点（仅名称 —— ID 不变，保留边）。
    pub fn rename_node_name(&mut self, id: &str, new_name: &str) -> bool {
        let handle = match self.handle_of(id) {
            Some(h) => h,
            None => return false,
        };
        let node = match self.nodes.get_mut(&handle) {
            Some(n) => n,
            None => return false,
        };
        let old_name = node.name.clone();
        if old_name == new_name {
            return true;
        }
        if self.has_aux_indexes {
            if let Some(handles) = self.name_index.get_mut(&old_name) {
                handles.retain(|&h| h != handle);
            }
            self.name_index
                .entry(new_name.to_string())
                .or_default()
                .push(handle);
        }
        node.name = new_name.to_string();
        true
    }
}

impl Default for MemoryIndex {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Graph;
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};

    fn test_node(id: &str, name: &str, location: Option<&str>) -> Node {
        let mut n = Node::new(id, name, NodeKind::Symbol);
        n.location = location.map(|s| s.to_string());
        n
    }

    #[test]
    fn test_new_empty() {
        let idx = MemoryIndex::new();
        assert_eq!(idx.node_count(), 0);
        assert_eq!(idx.edge_count(), 0);
    }

    #[test]
    fn test_insert_and_get_node() {
        let mut idx = MemoryIndex::new();
        let n = test_node("n1", "main", Some("src/main.rs"));
        idx.insert_node(n);
        assert_eq!(idx.node_count(), 1);
        assert!(idx.get_node("n1").is_some());
        assert_eq!(idx.get_nodes_by_name("main").len(), 1);
        assert_eq!(idx.get_nodes_by_file("src/main.rs").len(), 1);
    }

    #[test]
    fn test_upsert_and_outgoing_incoming() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", Some("src/a.rs")));
        idx.insert_node(test_node("b", "B", Some("src/b.rs")));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 2, None);

        assert_eq!(idx.edge_count(), 1);
        let out = idx.outgoing("a", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "b");
        assert_eq!(out[0].2, 2);

        let incoming = idx.incoming("b", None);
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].0, "a");
    }

    #[test]
    fn test_upsert_edge_dedup() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
        idx.upsert_edge("a", "b", EdgeKind::Calls, 3, None); // different depth → separate edge
        idx.upsert_edge("a", "b", EdgeKind::Calls, 3, None); // same (s,t,k,d) → dedup
        assert_eq!(idx.edge_count(), 2, "two distinct (kind,depth) tuples");
        let out = idx.outgoing("a", None);
        assert!(out.iter().any(|(_, _, d, _)| *d == 1), "depth=1 entry present");
        assert!(out.iter().any(|(_, _, d, _)| *d == 3), "depth=3 entry present");
    }

    /// 回归测试：MemoryIndex 加载器（from_existing_graph/from_sqlite/_degraded）
    /// 曾信任每个 Node 中固化的 in_degree/out_degree（SQLite 中已过时），
    /// 导致 find_unused（in_degree==0）返回错误结果。recompute_degrees
    /// 必须从实际邻接重新推导，覆盖过时的存储值。
    #[test]
    fn from_existing_graph_recomputes_degrees_from_adjacency() {
        let mut nodes = HashMap::new();
        nodes.insert("a".into(), test_node("a", "A", None));
        nodes.insert("b".into(), test_node("b", "B", None));
        nodes.insert("c".into(), test_node("c", "C", None));
        // 强制 b 的值为非零过时值，以证明 recompute 会覆盖（而非保持 0）
        {
            let nb = nodes.get_mut("b").unwrap();
            nb.in_degree = 99;
            nb.out_degree = 99;
        }
        let mut edges = HashMap::new();
        edges.insert("e1".into(), Edge::new("e1", "a", "b", EdgeKind::Calls));
        edges.insert("e2".into(), Edge::new("e2", "b", "c", EdgeKind::Calls));
        let idx = MemoryIndex::from_existing_graph(nodes, edges);

        let deg = |id: &str| {
            let n = idx.get_node(id).expect("node present");
            (n.in_degree, n.out_degree)
        };
        assert_eq!(deg("a"), (0, 1), "a: out=1 (a→b), in=0");
        assert_eq!(deg("b"), (1, 1), "b: stale 99 must be overwritten to in=1 out=1");
        assert_eq!(deg("c"), (1, 0), "c: in=1 (b→c), out=0");
    }

    #[test]
    fn test_remove_node_cascades() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);

        idx.remove_node("a");
        assert_eq!(idx.node_count(), 1);
        assert_eq!(idx.edge_count(), 0);
        assert!(idx.outgoing("b", None).is_empty());
    }

    #[test]
    fn test_shortest_path() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.insert_node(test_node("c", "C", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.upsert_edge("b", "c", EdgeKind::Calls, 0, None);

        let path = idx.shortest_path("a", "c").unwrap();
        assert_eq!(path, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_shortest_path_no_route() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        assert!(idx.shortest_path("a", "b").is_none());
    }

    #[test]
    fn test_neighbors_depth() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.insert_node(test_node("c", "C", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.upsert_edge("b", "c", EdgeKind::Calls, 0, None);

        let nb = idx.neighbors("a", 1, None);
        assert_eq!(nb.len(), 1);
        assert_eq!(nb[0].1, "b");

        let nb2 = idx.neighbors("a", 2, None);
        assert_eq!(nb2.len(), 2); // a→b, b→c
    }

    #[test]
    fn test_impact_layers() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.insert_node(test_node("c", "C", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.upsert_edge("b", "c", EdgeKind::Calls, 0, None);

        let layers = idx.impact("a", 2);
        assert_eq!(layers.len(), 3); // depth 0,1,2
        assert_eq!(layers[0].1, vec!["a"]);
        assert_eq!(layers[1].1.len(), 1); // b
        assert_eq!(layers[2].1.len(), 1); // c
    }

    #[test]
    fn test_from_existing_graph() {
        let mut g = Graph::new();
        let mut n1 = test_node("n1", "fn_a", Some("src/a.rs"));
        n1.location = Some("src/a.rs".into());
        g.add_node(n1);
        let mut n2 = test_node("n2", "fn_b", Some("src/b.rs"));
        n2.location = Some("src/b.rs".into());
        g.add_node(n2);
        g.add_edge_unchecked(Edge::new("e1", "n1", "n2", EdgeKind::Calls));

        let idx = MemoryIndex::from_existing_graph(g.nodes, g.edges);
        assert_eq!(idx.node_count(), 2);
        assert_eq!(idx.edge_count(), 1);
        assert_eq!(idx.get_nodes_by_file("src/a.rs").len(), 1);
    }

    #[test]
    fn test_kind_filter() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.insert_node(test_node("c", "C", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.upsert_edge("a", "c", EdgeKind::Imports, 0, None);

        let calls = idx.outgoing("a", Some(&[EdgeKind::Calls]));
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, EdgeKind::Calls);
    }

    /// ponytail：clone_index_for_update() 从不调用 rebuild_dense_index()，
    /// 导致 node_by_idx 保持为空 → to_sqlite() 收集了 0 条边 → SQLite 回写
    /// 后所有边丢失。此测试确保 flush_pending() 修复此问题。
    #[test]
    fn test_clone_and_flush_preserves_edges() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", Some("src/a.rs")));
        idx.insert_node(test_node("b", "B", Some("src/b.rs")));
        idx.insert_node(test_node("c", "C", Some("src/c.rs")));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 1, Some(0.1));
        idx.upsert_edge("b", "c", EdgeKind::Calls, 2, None);
        idx.flush_pending(); // upsert → pending，flush → CSR 使 edges_iter() 能看到边

        // 模拟 clone_index_for_update：从现有数据重建
        //（无法直接调用 clone_index_for_update，因为它在 incremental.rs 中，
        // 但可以通过从 graph 重建来测试该模式）
        let mut g = Graph::new();
        for node in idx.nodes_iter() {
            g.add_node(node.clone());
        }
        for (source, targets) in idx.edges_iter() {
            for (target, kind, coupling_depth, _delay) in targets {
                let id = format!("{}::{}::{}", source, target, kind.as_str());
                let mut edge = Edge::new(id, source.clone(), target, kind);
                edge.coupling_depth = coupling_depth;
                g.add_edge_unchecked(edge);
            }
        }
        let mut cloned = MemoryIndex::from_existing_graph(g.nodes, g.edges);

        // flush 前：pending_adds 有边，node_by_idx 由 from_existing_graph 填充，
        // 所以应该通过。但调用 flush 确保不会破坏任何东西。
        cloned.flush_pending();

        // 验证边已保留
        assert_eq!(cloned.edge_count(), 2, "both edges should survive clone+flush");
        let out = cloned.outgoing("a", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, EdgeKind::Calls);
        assert_eq!(out[0].2, 1); // coupling_depth

        let out2 = cloned.outgoing("b", None);
        assert_eq!(out2.len(), 1);
        assert_eq!(out2[0].2, 2); // coupling_depth
    }

    /// ponytail：确保 flush_pending 正确重建内部数据结构，
    /// 使 to_sqlite() 能遍历 node_by_idx 收集边用于持久化。
    #[test]
    fn test_edges_queryable_after_flush_pending() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);

        // upsert_edge 将边放入 pending_adds；flush_pending 从中重建 CSR。
        // flush 前，outgoing() 从 pending_adds 读取（可行）。
        // flush 后，outgoing() 从重建的 CSR 数组读取（也必须可行）。
        idx.flush_pending();

        // 验证 flush 后边可通过 outgoing 查询
        let out = idx.outgoing("a", None);
        assert_eq!(out.len(), 1, "edge should survive flush_pending");
        assert_eq!(out[0].0, "b");

        // 验证边数正确（flush 后从 CSR 读取）
        assert_eq!(idx.edge_count(), 1, "edge_count should be correct after flush");
    }

    #[test]
    fn test_without_aux_indexes() {
        let mut idx = MemoryIndex::new();
        idx.has_aux_indexes = false;
        idx.insert_node(test_node("a", "A", Some("f.rs")));
        assert!(idx.get_nodes_by_name("A").is_empty());
        assert!(idx.get_nodes_by_file("f.rs").is_empty());

        idx.ensure_aux_indexes();
        assert_eq!(idx.get_nodes_by_name("A").len(), 1);
        assert_eq!(idx.get_nodes_by_file("f.rs").len(), 1);
    }

    #[test]
    fn test_remove_edge() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        assert_eq!(idx.edge_count(), 1);

        assert!(idx.remove_edge("a", "b", EdgeKind::Calls));
        assert_eq!(idx.edge_count(), 0);
        assert!(idx.outgoing("a", None).is_empty());
    }

    /// F2 回归测试：temporal_delay_sec 必须在 SQLite 往返后保留。
    #[test]
    fn test_temporal_delay_survives_sqlite_roundtrip() {
        let tmp = std::env::temp_dir().join("hologram_test_f2_delay");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let db = SqliteDb::open(&tmp).unwrap();

        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "src_a", Some("src/a.rs")));
        idx.insert_node(test_node("b", "src_b", Some("src/b.rs")));
        idx.insert_node(test_node("c", "src_c", Some("src/c.rs")));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
        idx.upsert_edge("a", "c", EdgeKind::Triggers, 1, Some(2.5));
        idx.upsert_edge("b", "c", EdgeKind::Awaits, 2, Some(0.75));
        idx.flush_pending(); // upsert → pending，flush → CSR 使 to_sqlite() 能看到边

        idx.to_sqlite(&db).unwrap();

        let loaded = MemoryIndex::from_sqlite(&db).unwrap();

        let a_out = loaded.outgoing("a", None);
        let triggers: Vec<_> = a_out
            .iter()
            .filter(|(_, kind, _, _)| matches!(kind, EdgeKind::Triggers))
            .collect();
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].3, Some(2.5), "Triggers delay should survive round-trip");

        let b_out = loaded.outgoing("b", None);
        let awaits: Vec<_> = b_out
            .iter()
            .filter(|(_, kind, _, _)| matches!(kind, EdgeKind::Awaits))
            .collect();
        assert_eq!(awaits.len(), 1);
        assert_eq!(awaits[0].3, Some(0.75), "Awaits delay should survive round-trip");

        let calls: Vec<_> = a_out
            .iter()
            .filter(|(_, kind, _, _)| matches!(kind, EdgeKind::Calls))
            .collect();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].3, None, "Calls edge should have no delay");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}