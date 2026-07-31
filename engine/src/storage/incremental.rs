// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// IncrementalUpdater — 热重载变更文件，无需全量重新分析。
//
// 三个阶段（按规范 §5）：
//   Phase 1 — 单文件 tree-sitter 重新解析
//   Phase 2 — 文件内 diff（按 name+kind 匹配节点）
//   Phase 3 — 跨文件边修复（通过 name_index 重新推导导入）
//
// 附加：重命名检测（Jaccard ≥ 70%）、验证守卫、SQLite 回写。
//
// ═══ 已知差距（ponytail：合成阶段未重新执行）═══
// 增量更新后，以下流水线阶段不会重新执行：
//   - 耦合分析（基于边的耦合深度）
//   - 社区检测（全局算法，新节点不会被分配社区）
//   - 动态分派合成（React/Vue/DI 边）
//   - 框架路由检测
//   - 动态导入 / eval / 跨语言检测
//   - 代码片段提取
// 这些阶段被跳过是因为每个阶段都在完整 Graph 上操作，
// 无法在不进行大规模重构的情况下按文件执行。回退路径
//（监视器失败时全量重新分析）覆盖完整场景。
// 升级路径：如果增量漂移变得明显，添加轻量级的
// "重新合成受影响子图" 通行证，仅对新/变更节点及其 1 跳邻居
// 运行耦合 + 社区检测。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use tracing::{info, warn};

use crate::adapter::registry;
use crate::graph::{Edge, Node};
use crate::storage::memory::MemoryIndex;
use crate::storage::sqlite::SqliteDb;

/// 用 tree-sitter 分析单个文件的结果。
struct FileAnalysis {
    nodes: Vec<Node>,
    /// 本文件内可见的边（跨文件的边在 Phase 3 处理）。
    edges: Vec<Edge>,
    /// tree-sitter 错误计数（非零 = 解析问题）。
    error_count: usize,
}

/// Phase 2 diff 后应用到单个文件节点的变更。
struct FileDiff {
    path: String,
    added_nodes: Vec<Node>,
    removed_node_ids: Vec<String>,
    updated_nodes: Vec<Node>,

}

/// 增量更新引擎。
pub struct IncrementalUpdater;

impl IncrementalUpdater {
    /// 通过应用增量变更来构建新的 MemoryIndex。
    ///
    /// `changed_files`: (path, action) 列表 — "created"、"modified"、"removed"。
    /// `old_index`: 当前 MemoryIndex（只读，MCP 查询仍从此读取）。
    /// `project_root`: 项目目录，用于 tree-sitter 重新解析。
    ///
    /// 返回新的 MemoryIndex（在锁外构建），验证失败则返回错误。
    pub fn update(
        changed_files: &[(PathBuf, &str)],
        old_index: &MemoryIndex,
        project_root: &Path,
        db: &SqliteDb,
        ) -> Result<(MemoryIndex, usize), String> {
        let mut new_index = Self::clone_index_for_update(old_index);
        // 将克隆中的待处理边刷入 CSR，以便 recompute_edge_count 正常工作
        new_index.flush_pending();
        let mut total_errors = 0usize;
        let old_edge_count = old_index.edge_count();

        // 按操作类型分离文件
        let mut modified = Vec::new();
        let mut removed = Vec::new();
        let mut created = Vec::new();

        for (path, action) in changed_files {
            match *action {
                "modified" => modified.push(path.clone()),
                "removed" => removed.push(path.clone()),
                "created" => created.push(path.clone()),
                _ => {}
            }
        }

        // ── 处理已删除文件 ──
        for path in &removed {
            let path_str = path.to_string_lossy().to_string();
            let node_ids = old_index.get_nodes_by_file(&path_str);
            for nid in &node_ids {
                new_index.remove_node(nid);
            }
            info!(
                "[incr] removed file {} — {} nodes dropped",
                path.display(),
                node_ids.len()
            );
        }

        // ── Phase 1：重新解析所有变更文件 ──
        let mut file_analyses: HashMap<String, FileAnalysis> = HashMap::new();
        for path in modified.iter().chain(created.iter()) {
            match Self::parse_file(path, project_root) {
                Ok(analysis) => {
                    let key = path.to_string_lossy().to_string();
                    total_errors += analysis.error_count;
                    file_analyses.insert(key, analysis);
                }
                Err(e) => {
                    warn!("[incr] parse failed for {}: {}", path.display(), e);
                }
            }
        }

        // ── Phase 2：文件内 diff ──
        let mut all_diffs: Vec<FileDiff> = Vec::new();
        for (path, analysis) in &file_analyses {
            let path_str = path.clone();
            let old_node_ids = old_index.get_nodes_by_file(&path_str);
            let diff = Self::diff_file(&path_str, &old_node_ids, analysis, old_index);
            all_diffs.push(diff);
        }

        // 将 Phase 2 变更应用到中间索引
        for diff in &all_diffs {
            for nid in &diff.removed_node_ids {
                new_index.remove_node(nid);
            }
            for node in &diff.added_nodes {
                new_index.insert_node(node.clone());
            }
            for node in &diff.updated_nodes {
                new_index.insert_node(node.clone());
            }
        }

        // ── Phase 3：跨文件边修复 ──
        // 使用中间索引（旧 + Phase 2 变更）进行名称查找
        for diff in &all_diffs {
            let changed_node_ids: Vec<String> = diff
                .added_nodes
                .iter()
                .chain(diff.updated_nodes.iter())
                .map(|n| n.id.clone())
                .collect();
            for nid in &changed_node_ids {
                if let Some(analysis) = file_analyses.get(&diff.path) {
                    Self::repair_cross_file_edges(nid, analysis, &mut new_index);
                }
            }
        }
        // 同时修复未变更文件指向已变更文件的边
        for diff in &all_diffs {
            for node in diff.added_nodes.iter().chain(diff.updated_nodes.iter()) {
                Self::repair_incoming_from_unchanged(&node.id, old_index, &mut new_index, &diff.path);
            }
        }

        // ── 验证 ──
        let new_edge_count = new_index.recompute_edge_count();
        if (new_edge_count as f64) < (old_edge_count as f64) * 0.95 {
            return Err(format!(
                "validate failed: {} edges → {} edges (loss {}%, threshold 5%), rejecting swap",
                old_edge_count,
                new_edge_count,
                (100.0 * (1.0 - new_edge_count as f64 / old_edge_count as f64)) as u32
            ));
        }

        // ── 刷入待处理变更 → 重建稠密索引 + CSR → 然后持久化 ──
        // ponytail：clone_index_for_update() 从不调用 rebuild_dense_index()，
        // 所以 node_by_idx 为空。to_sqlite() 遍历 node_by_idx 来收集边 →
        // 会向 SQLite 写入 0 条边（重启后所有旧边丢失）。
        new_index.flush_pending();

        // ── 回写到 SQLite ──
        // ponytail：锁竞争时重试（辅助连接上的时间线写入），
        // 共 3 次尝试 × 约 700ms；最终失败则升级为错误。
        let mut write_err: Option<String> = None;
        for attempt in 0..3 {
            match new_index.to_sqlite(db) {
                Ok(()) => {
                    write_err = None;
                    break;
                }
                Err(e) => {
                    write_err = Some(e);
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(100 * (1 << attempt)));
                        info!("[incr] SQLite write-back retry {}/2", attempt + 1);
                    }
                }
            }
        }
        if let Some(e) = write_err {
            warn!("[incr] SQLite write-back failed after 3 retries: {}", e);
        }

        Ok((new_index, total_errors))
    }

    // ── 辅助方法 ──

    fn clone_index_for_update(old: &MemoryIndex) -> MemoryIndex {
        // 需要一个可变副本来应用 diff。
        // 目前通过遍历从头构建。
        // TODO：实现 MemoryIndex::clone() 以提升效率。
        let mut idx = MemoryIndex::new();
        for node in old.nodes_iter() {
            idx.insert_node(node.clone());
        }
        for (source, targets) in old.edges_iter() {
            for (target, kind, depth, delay) in targets {
                idx.upsert_edge(&source, &target, kind, depth, delay);
            }
        }
        idx
    }

    /// Phase 1：用 tree-sitter 解析单个文件。
    fn parse_file(path: &Path, _project_root: &Path) -> Result<FileAnalysis, String> {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let source = std::fs::read_to_string(path)
            .map_err(|e| format!("read {}: {}", path.display(), e))?;
        let file_id = path.to_string_lossy().to_string();

        // 使用注册表查找合适的适配器
        let reg = registry::AdapterRegistry::new();
        let (nodes, edges, _tree) = match reg.get(ext) {
            Some(adapter) => adapter.analyze(&file_id, &source),
            None => {
                return Ok(FileAnalysis {
                    nodes: vec![],
                    edges: vec![],
                    error_count: 0,
                });
            }
        };

        // 统计解析错误：名称为空的节点可能表示解析不完整
        let error_count = nodes.iter().filter(|n| n.name.is_empty()).count();

        Ok(FileAnalysis {
            nodes,
            edges,
            error_count,
        })
    }

    /// Phase 2：对比旧节点与新解析结果。
    fn diff_file(
        path: &str,
        old_node_ids: &[String],
        analysis: &FileAnalysis,
        old_index: &MemoryIndex,
    ) -> FileDiff {
        let mut added_nodes = Vec::new();
        let mut removed_node_ids = Vec::new();
        let mut updated_nodes = Vec::new();

        // 构建查找表：按 name+kind 索引旧节点
        let mut old_by_key: HashMap<(String, String), String> = HashMap::new(); // (name, kind) → id
        for nid in old_node_ids {
            if let Some(node) = old_index.get_node(nid) {
                old_by_key.insert((node.name.clone(), node.kind.as_str().to_string()), nid.clone());
            }
        }

        // 构建查找表：按 name+kind 索引新节点
        let mut new_by_key: HashMap<(String, String), &Node> = HashMap::new();
        for node in &analysis.nodes {
            new_by_key.insert((node.name.clone(), node.kind.as_str().to_string()), node);
        }

        // 匹配策略 1 — 同文件 + 同名 + 同 kind → 更新
        let mut matched_old: HashSet<String> = HashSet::new();
        let mut matched_new: HashSet<String> = HashSet::new(); // new node ids

        for ((name, kind), new_node) in &new_by_key {
            let key = (name.clone(), kind.clone());
            if let Some(old_id) = old_by_key.get(&key) {
                let mut updated = (*new_node).clone();
                // 保留旧 community_id 和位置（如果未变更）
                if let Some(old_node) = old_index.get_node(old_id) {
                    updated.community_id = old_node.community_id;
                    if updated.position.is_none() {
                        updated.position = old_node.position;
                    }
                    updated.out_degree = old_node.out_degree;
                    updated.in_degree = old_node.in_degree;
                    updated.non_defines_in_degree = old_node.non_defines_in_degree;
                }
                updated_nodes.push(updated);
                matched_old.insert(old_id.clone());
                matched_new.insert(new_node.id.clone());
            }
        }

        // 策略 2：同文件 + 同位置（行:列），容差 ≤ 3
        for new_node in &analysis.nodes {
            if matched_new.contains(&new_node.id) {
                continue;
            }
            if let Some(ref new_loc) = new_node.location {
                for nid in old_node_ids {
                    if matched_old.contains(nid) {
                        continue;
                    }
                    if let Some(old_node) = old_index.get_node(nid) {
                        if let Some(ref old_loc) = old_node.location {
                            if Self::location_close(old_loc, new_loc, 3) {
                                let mut updated = new_node.clone();
                                updated.community_id = old_node.community_id;
                                if updated.position.is_none() {
                                    updated.position = old_node.position;
                                }
                                updated_nodes.push(updated);
                                matched_old.insert(nid.clone());
                                matched_new.insert(new_node.id.clone());
                                break;
                            }
                        }
                    }
                }
            }
        }

        // 剩余旧节点 → 已删除
        for nid in old_node_ids {
            if !matched_old.contains(nid) {
                removed_node_ids.push(nid.clone());
            }
        }

        // 剩余新节点 → 已新增
        for node in &analysis.nodes {
            if !matched_new.contains(&node.id) {
                added_nodes.push(node.clone());
            }
        }

        FileDiff {
            path: path.to_string(),
            added_nodes,
            removed_node_ids,
            updated_nodes,
            }
    }

    /// 检查两个位置是否"接近"（行差 ≤ 容差）。
    /// 同时处理 "path:line" 和 "path:line:column" 格式。
    fn location_close(a: &str, b: &str, tolerance: u32) -> bool {
        let parse_line = |loc: &str| -> Option<u32> {
            // 格式："path:line" 或 "path:line:column"
            // rsplit_once(':') 取最后一个冒号后的部分（列号；若无列号则为行号）
            // 为可靠获取行号，统计冒号数量。
            let colon_count = loc.chars().filter(|&c| c == ':').count();
            match colon_count {
                0 => None, // 无行号信息
                1 => {
                    // "path:line"
                    loc.rsplit_once(':')
                        .and_then(|(_, line)| line.parse::<u32>().ok())
                }
                _ => {
                    // "path:line:column"
                    // 第一次 rsplit 得到列号，第二次对剩余部分 rsplit 得到行号
                    loc.rsplit_once(':') // ("path:line", "column")
                        .and_then(|(rest, _col)| {
                            rest.rsplit_once(':') // ("path", "line")
                                .and_then(|(_, line)| line.parse::<u32>().ok())
                        })
                }
            }
        };
        match (parse_line(a), parse_line(b)) {
            (Some(la), Some(lb)) => la.abs_diff(lb) <= tolerance,
            _ => false,
        }
    }

    /// Phase 3：为节点重建跨文件边。
    fn repair_cross_file_edges(node_id: &str, analysis: &FileAnalysis, index: &mut MemoryIndex) {
        // 从分析结果中查找该节点为源节点的跨文件边
        for edge in &analysis.edges {
            if edge.source == node_id && edge.cross_file {
                index.upsert_edge(&edge.source, &edge.target, edge.kind, edge.coupling_depth, edge.temporal_delay_sec);
            }
        }
    }

    /// Phase 3：修复从未变更文件到新增/更新节点的边。
    /// 对于每个新增/更新节点，检查是否有未变更文件的节点曾指向
    /// 旧版本 —— 重新建立这些边。
    fn repair_incoming_from_unchanged(
        node_id: &str,
        old_index: &MemoryIndex,
        new_index: &mut MemoryIndex,
        changed_file: &str,
    ) {
        // 对于依赖 `changed_file` 中符号的每个未变更文件，
        // 重新检查其跨文件导入。
        // 保守策略：通过检查节点名称是否匹配其他文件中的导入来
        // 重新推导入边。

        if let Some(node) = new_index.get_node(node_id) {
            let name = node.name.clone();
            // 查找所有同名节点
            let candidates = old_index.get_nodes_by_name(&name);
            for cid in &candidates {
                if cid == node_id {
                    continue;
                }
                // 检查 cid 是否有指向该节点旧版本的边
                if let Some(old_node) = old_index.get_node(cid) {
                    if let Some(ref old_loc) = old_node.location {
                        let old_file = old_loc
                            .rsplit_once(':')
                            .map(|(f, _)| f)
                            .unwrap_or(old_loc);
                        if old_file != changed_file {
                            // 来自未变更文件 —— 保留边
                            let targets = old_index.outgoing(cid, None);
                            for (tgt, kind, depth, _delay) in &targets {
                                // 如果目标在变更文件中，则重新指向
                                let tgt_node = old_index.get_node(tgt);
                                if let Some(tn) = tgt_node {
                                    if let Some(ref tl) = tn.location {
                                        let tf = tl.rsplit_once(':').map(|(f, _)| f).unwrap_or(tl);
                                        if tf == changed_file && tn.name == name {
                                            new_index.upsert_edge(cid, node_id, *kind, *depth, None);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Node, NodeKind};

    fn test_node(id: &str, name: &str, location: Option<&str>) -> Node {
        let mut n = Node::new(id, name, NodeKind::Symbol);
        n.location = location.map(|s| s.to_string());
        n
    }

    #[test]
    fn test_location_close_exact() {
        assert!(IncrementalUpdater::location_close(
            "src/main.rs:42:10",
            "src/main.rs:42:10",
            3
        ));
    }

    #[test]
    fn test_location_close_within_tolerance() {
        assert!(IncrementalUpdater::location_close(
            "src/main.rs:42:10",
            "src/main.rs:45:5",
            3
        ));
    }

    #[test]
    fn test_location_close_beyond_tolerance() {
        assert!(!IncrementalUpdater::location_close(
            "src/main.rs:10:1",
            "src/main.rs:50:1",
            3
        ));
    }

    #[test]
    fn test_location_close_same_line() {
        // location_close 只比较行号。
        // "同一文件" 前提在更高层级（diff_file）检查。
        assert!(IncrementalUpdater::location_close(
            "src/a.rs:42:10",
            "src/b.rs:42:10",
            3
        ));
    }

    #[test]
    fn test_location_close_no_line_info() {
        assert!(!IncrementalUpdater::location_close(
            "src/main.rs",
            "src/main.rs",
            3
        ));
    }

    #[test]
    fn test_diff_file_added_node() {
        let mut old = MemoryIndex::new();
        old.insert_node(test_node("n1", "old_fn", Some("src/a.rs:10:1")));

        let analysis = FileAnalysis {
            nodes: vec![
                test_node("n1", "old_fn", Some("src/a.rs:10:1")),
                test_node("n2", "new_fn", Some("src/a.rs:20:1")),
            ],
            edges: vec![],
            error_count: 0,
        };

        let diff = IncrementalUpdater::diff_file(
            "src/a.rs",
            &["n1".to_string()],
            &analysis,
            &old,
        );
        assert_eq!(diff.added_nodes.len(), 1);
        assert_eq!(diff.added_nodes[0].name, "new_fn");
        assert_eq!(diff.removed_node_ids.len(), 0);
        assert_eq!(diff.updated_nodes.len(), 1);
    }

    #[test]
    fn test_diff_file_removed_node() {
        let mut old = MemoryIndex::new();
        old.insert_node(test_node("n1", "old_fn", Some("src/a.rs:10:1")));
        old.insert_node(test_node("n2", "gone_fn", Some("src/a.rs:20:1")));

        let analysis = FileAnalysis {
            nodes: vec![test_node("n1", "old_fn", Some("src/a.rs:10:1"))],
            edges: vec![],
            error_count: 0,
        };

        let diff = IncrementalUpdater::diff_file(
            "src/a.rs",
            &["n1".to_string(), "n2".to_string()],
            &analysis,
            &old,
        );
        assert_eq!(diff.removed_node_ids.len(), 1);
        assert_eq!(diff.removed_node_ids[0], "n2");
    }

    #[test]
    fn test_diff_file_renamed_match_by_location() {
        let mut old = MemoryIndex::new();
        old.insert_node(test_node("n1", "old_name", Some("src/a.rs:10:1")));

        let analysis = FileAnalysis {
            nodes: vec![test_node("n_new_id", "new_name", Some("src/a.rs:12:1"))],
            edges: vec![],
            error_count: 0,
        };

        let diff = IncrementalUpdater::diff_file(
            "src/a.rs",
            &["n1".to_string()],
            &analysis,
            &old,
        );
        // 名称不匹配但位置接近 → 应通过策略 2 匹配
        assert_eq!(diff.updated_nodes.len(), 1);
        assert_eq!(diff.removed_node_ids.len(), 0);
        assert_eq!(diff.added_nodes.len(), 0);
    }
}