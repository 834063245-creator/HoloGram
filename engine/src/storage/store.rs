// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// GraphStore — 核心图数据访问层。
// 用 RwLock<MemoryIndex> + SqliteDb 替代 CACHED_GRAPH: Mutex<Option<Graph>>。
// 支持 N 个并发读、1 个写（用于交换操作）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::{Mutex, RwLock};
use tracing::{info, warn};

use crate::graph::Graph;
use crate::storage::memory::{LoadProgress, MemoryIndex};
use crate::storage::sqlite::SqliteDb;

/// 核心图存储。所有 MCP 工具通过此层读取。
pub struct GraphStore {
    /// 内存索引（RwLock 支持并发读取）。
    pub index: RwLock<MemoryIndex>,
    /// 持久化数据库。
    pub db: SqliteDb,
    /// 此存储对应的项目根目录。用于检测工作区切换，
    /// 以便在正确路径重新打开 SQLite，而非交叉污染。
    project_root: PathBuf,
    /// 加载进度（用于 engine_status）。启动加载期间更新。
    loading: RwLock<LoadProgress>,
    /// 加载开始时间戳（毫秒级 epoch，用于计算 elapsed_ms）。
    load_start_ms: AtomicU64,
    /// 后台向量重建的防重入守卫 —— 防止重复重建。
    reindex_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl GraphStore {
    /// 为项目打开存储。处理：
    /// 1. SQLite 缓存检查
    /// 2. 从 SQLite 加载（快速路径）
    /// 3. JSON 迁移（回退）
    pub fn open(project_root: &Path) -> Result<Self, String> {
        let start = std::time::Instant::now();
        // 快照优先级比较需要 hologram.db 的「真实」mtime ——
        // SqliteDb::open 会在文件缺失时创建它（mtime 变成现在），必须先取样。
        let db_path = project_root.join(".hologram").join("hologram.db");
        let db_mtime = std::fs::metadata(&db_path).and_then(|m| m.modified()).ok();
        let db = SqliteDb::open(project_root)?;

        let load_start = chrono::Utc::now().timestamp_millis() as u64;
        let store = Self {
            index: RwLock::new(MemoryIndex::new()),
            db,
            project_root: project_root.to_path_buf(),
            loading: RwLock::new(LoadProgress {
                phase: "loading".into(),
                nodes_loaded: 0,
                edges_loaded: 0,
                nodes_total: 0,
                edges_total: 0,
                elapsed_ms: 0,
            }),
            load_start_ms: AtomicU64::new(load_start),
            reindex_handle: Mutex::new(None),
        };

        // 快照快速路径（超大图）：快照存在且 mtime ≥ hologram.db 时优先加载；
        // hologram.db 原本不存在 → 快照存在即优先。
        let snap_path = crate::storage::snapshot::snapshot_path(project_root);
        if let Ok(snap_meta) = std::fs::metadata(&snap_path) {
            let prefer = match (snap_meta.modified().ok(), db_mtime) {
                (Some(snap_ts), Some(db_ts)) => snap_ts >= db_ts,
                (Some(_), None) => true,
                _ => false,
            };
            if prefer {
                match MemoryIndex::load_snapshot(project_root) {
                    Ok(idx) => {
                        let nodes = idx.node_count();
                        let edges = idx.edge_count();
                        *store.index.write() = idx;
                        let elapsed = start.elapsed().as_millis() as u64;
                        *store.loading.write() = LoadProgress {
                            phase: "ready".into(),
                            nodes_loaded: nodes,
                            edges_loaded: edges,
                            nodes_total: nodes,
                            edges_total: edges,
                            elapsed_ms: elapsed,
                        };
                        info!(
                            "[store] loaded from snapshot: {} nodes, {} edges in {}ms",
                            nodes, edges, elapsed
                        );
                        return Ok(store);
                    }
                    Err(e) => {
                        warn!("[store] 快照加载失败（{}），删除快照并回退 SQLite", e);
                        let _ = std::fs::remove_file(&snap_path);
                    }
                }
            }
        }

        // 优先尝试 SQLite
        match MemoryIndex::from_sqlite(&store.db) {
            Ok(idx) => {
                let nodes = idx.node_count();
                let edges = idx.edge_count();
                *store.index.write() = idx;
                let elapsed = start.elapsed().as_millis() as u64;
                *store.loading.write() = LoadProgress {
                    phase: "ready".into(),
                    nodes_loaded: nodes,
                    edges_loaded: edges,
                    nodes_total: nodes,
                    edges_total: edges,
                    elapsed_ms: elapsed,
                };
                info!(
                    "[store] loaded from SQLite: {} nodes, {} edges in {}ms",
                    nodes, edges, elapsed
                );
                return Ok(store);
            }
            Err(e) => {
                info!("[store] SQLite 加载失败（{}），尝试 JSON 回退", e);
            }
        }

        // JSON 迁移回退
        let json_path = project_root.join(".hologram").join("hologram_graph.json");
        if json_path.exists() {
            info!("[store] 从 JSON 迁移: {}", json_path.display());
            match Graph::from_json_file(&json_path.to_string_lossy()) {
                Ok(g) => {
                    let (g_nodes, g_edges) = g.into_parts();
                    let idx = MemoryIndex::from_existing_graph(g_nodes, g_edges);
                    let nodes = idx.node_count();
                    let edges = idx.edge_count();
                    // 尝试持久化到 SQLite（失败非致命）
                    if let Err(e) = idx.to_sqlite(&store.db) {
                        warn!("[store] JSON→SQLite 写入失败（非致命）: {}", e);
                    }
                    *store.index.write() = idx;
                    let elapsed = start.elapsed().as_millis() as u64;
                    *store.loading.write() = LoadProgress {
                        phase: "ready".into(),
                        nodes_loaded: nodes,
                        edges_loaded: edges,
                        nodes_total: nodes,
                        edges_total: edges,
                        elapsed_ms: elapsed,
                    };
                    info!(
                        "[store] 从 JSON 迁移加载: {} 节点, {} 边, 耗时 {}ms",
                        nodes, edges, elapsed
                    );
                    return Ok(store);
                }
                Err(e) => {
                    info!("[store] JSON 迁移失败: {}", e);
                }
            }
        }

        // SQLite 和 JSON 都没有 —— 空存储，用户需运行 analyze
        *store.loading.write() = LoadProgress {
            phase: "ready".into(),
            nodes_loaded: 0,
            edges_loaded: 0,
            nodes_total: 0,
            edges_total: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
        };
        info!("[store] 空存储就绪（无 SQLite 缓存，无 JSON）");
        Ok(store)
    }

    /// 将当前 MemoryIndex 持久化。保存漏斗：
    /// edge_count ≥ snapshot_min_edges()（默认 5M，env
    /// HOLOGRAM_SNAPSHOT_MIN_EDGES 覆盖）→ bincode 快照（原子 rename）；
    /// 否则走现有 SQLite 全量重写。
    pub fn save(&self) -> Result<(), String> {
        let idx = self.index.read();
        if idx.edge_count() >= crate::storage::snapshot::snapshot_min_edges() {
            idx.save_snapshot(&self.project_root)
        } else {
            idx.to_sqlite(&self.db)
        }
    }

    /// 返回此存储对应的项目根目录。
    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

        /// 交换内存索引为新索引。短暂持有写锁。
    /// 守卫：在服务查询前验证辅助索引已构建。
    /// 如果辅助索引缺失（降级加载后的竞争窗口），
    /// 内联重建以防止空搜索结果。
    pub fn swap_index(&self, mut new_idx: MemoryIndex) {
        if !new_idx.has_aux_indexes() {
            tracing::warn!("[store] swap_index: 新索引缺少辅助索引，内联重建中");
            new_idx.ensure_aux_indexes();
        }
        let mut old = self.index.write();
        *old = new_idx;
    }

    /// 从当前内存节点重建语义向量索引。
    /// 后台即发即忘任务 —— 不阻塞调用方。
    /// 在增量更新后调用以保持向量搜索同步。
    pub fn reindex_vectors(&self) {
        // ponytail: 防并发 — 上一轮后台重建没跑完就跳过，下次增量更新时再触发
        let mut guard = self.reindex_handle.lock();
        if let Some(ref handle) = *guard {
            if !handle.is_finished() {
                return;
            }
        }

        let idx = self.index.read();
        let nodes: Vec<crate::graph::Node> = idx.nodes_iter().cloned().collect();
        drop(idx);

        let project_root = self.project_root.clone();
        let vector_path = project_root.join(".hologram").join("vectors.usearch");

        let handle = std::thread::spawn(move || {
            // 并发守卫：与全量重建互斥，避免同时写同一索引文件
            if !crate::vector::try_begin_build() {
                tracing::info!("[vector] 已有重建在进行，跳过本轮增量重建");
                return;
            }
            let mut nodes = nodes;
            // 为缺少 snippet 的节点提取片段（增量添加的）
            for node in &mut nodes {
                if node.snippet.is_some() { continue; }
                if let Some(loc) = &node.location {
                    if let Some((file_path, _line)) = loc.split_once(':') {
                        let full_path = project_root.join(file_path);
                        if let Ok(source) = std::fs::read_to_string(&full_path) {
                            if let Some(snippet) = crate::vector::extract_snippet(
                                &source, &node.name, &node.kind,
                            ) {
                                node.snippet = Some(snippet);
                            }
                        }
                    }
                }
            }

            let vi = crate::vector::CodeVectorIndex::new(&vector_path);
            match vi.build(&nodes) {
                Ok(n) if n > 0 => match vi.save() {
                    Ok(()) => {
                        tracing::info!("[vector] 增量重建: {} 个向量", n);
                        // 让搜索侧缓存失效，下次搜索加载新索引
                        crate::vector::invalidate_cache();
                    }
                    Err(e) => tracing::warn!("[vector] 增量重建保存失败: {e}"),
                },
                Ok(_) => {}
                Err(e) => tracing::warn!("[vector] 增量重建失败: {e}"),
            }
            crate::vector::end_build();
        });

        *guard = Some(handle);
    }

    /// 获取当前加载进度（用于 engine_status）。
    pub fn load_progress(&self) -> LoadProgress {
        let p = self.loading.read().clone();
        let start = self.load_start_ms.load(Ordering::Relaxed);
        let now = chrono::Utc::now().timestamp_millis() as u64;
        LoadProgress {
            elapsed_ms: now.saturating_sub(start),
            ..p
        }
    }

    /// 通过读锁查询索引。闭包接收 &MemoryIndex。
    pub fn read<R>(&self, f: impl FnOnce(&MemoryIndex) -> R) -> R {
        let idx = self.index.read();
        f(&idx)
    }

    /// 通过写锁修改索引。闭包接收 &mut MemoryIndex。
    pub fn write<R>(&self, f: impl FnOnce(&mut MemoryIndex) -> R) -> R {
        let mut idx = self.index.write();
        f(&mut idx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use crate::storage::snapshot::{snapshot_path, SNAPSHOT_ENV_LOCK};
    use std::collections::HashMap;

    fn tmp_project(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("hologram_test_store_{}_{}", name, std::process::id()))
    }

    fn small_index() -> MemoryIndex {
        let mut nodes = HashMap::new();
        let mut a = Node::new("a", "fn_a", NodeKind::Function);
        a.location = Some("src/a.rs:1".into());
        nodes.insert("a".into(), a);
        nodes.insert("b".into(), Node::new("b", "fn_b", NodeKind::Function));
        let mut edges = HashMap::new();
        edges.insert("e1".into(), Edge::new("e1", "a", "b", EdgeKind::Calls));
        MemoryIndex::from_existing_graph(nodes, edges)
    }

    /// 小阈值集成：HOLOGRAM_SNAPSHOT_MIN_EDGES=0 时 save 走快照路径，
    /// 重开 GraphStore 优先快照加载，FTS 惰性重建后可用。
    #[test]
    fn test_store_save_snapshot_path_and_reload() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        std::env::set_var("HOLOGRAM_SNAPSHOT_MIN_EDGES", "0");
        let tmp = tmp_project("snap_save");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // store1 保持存活 —— 关闭最后连接会触发 WAL checkpoint 推高
        // hologram.db mtime（生产稳定态下 db 无写入、mtime 保持 ≤ 快照），
        // 测试内用并发连接模拟「快照更新」的前提。
        let store1 = GraphStore::open(&tmp).unwrap();
        store1.swap_index(small_index());
        store1.save().unwrap();
        assert!(snapshot_path(&tmp).exists(), "阈值 0 → 应生成 graph.snapshot");

        // 重开：快照 mtime ≥ hologram.db → 快照优先
        let store2 = GraphStore::open(&tmp).unwrap();
        store2.read(|idx| {
            assert_eq!(idx.node_count(), 2);
            assert_eq!(idx.edge_count(), 1);
            assert!(idx.fts_dirty(), "快照加载 → dirty=true");
            assert_eq!(idx.get_node("a").unwrap().name, "fn_a");
        });
        // 快照模式下首个 FTS 查询惰性重建，之后 dirty=false
        let hits = store2
            .read(|idx| idx.fts_search(&store2.db, "fn_a", 10))
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "fn_a");
        store2.read(|idx| assert!(!idx.fts_dirty()));

        std::env::remove_var("HOLOGRAM_SNAPSHOT_MIN_EDGES");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// open 级回退：损坏快照 + 有效 SQLite → 删快照、走 SQLite 成功。
    #[test]
    fn test_store_open_falls_back_on_corrupt_snapshot() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        std::env::remove_var("HOLOGRAM_SNAPSHOT_MIN_EDGES");
        let tmp = tmp_project("corrupt_fallback");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        {
            let store = GraphStore::open(&tmp).unwrap();
            store.swap_index(small_index());
            store.save().unwrap(); // 小图 < 默认阈值 → SQLite 路径
            assert!(!snapshot_path(&tmp).exists(), "小图不应生成快照");
        }

        // 写入垃圾快照（mtime 现在 ≥ db mtime → 会被优先尝试）
        std::fs::write(snapshot_path(&tmp), b"corrupted garbage bytes").unwrap();

        let store2 = GraphStore::open(&tmp).unwrap();
        assert!(!snapshot_path(&tmp).exists(), "损坏快照应被删除");
        store2.read(|idx| {
            assert_eq!(idx.node_count(), 2, "应回退到 SQLite 数据");
            assert_eq!(idx.edge_count(), 1);
            assert!(!idx.fts_dirty(), "SQLite 加载 → dirty=false");
        });

        let _ = std::fs::remove_dir_all(&tmp);
    }
}