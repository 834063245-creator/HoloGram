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

        // 快照快速路径（超大图）：代际 token 判定 —— 快照头部 token 与
        // db meta 的 snapshot_token 一致，说明快照落盘后 db 未写入更新的
        // 全量图（to_sqlite 会清空 token；FTS 惰性重建/timeline 不影响）。
        let snap_path = crate::storage::snapshot::snapshot_path(project_root);
        if snap_path.exists() {
            match crate::storage::snapshot::peek_snapshot_token(&snap_path) {
                Err(e) => {
                    // 无头部旧格式 / 截断 / 损坏 → 按损坏处理
                    warn!("[store] 快照头部无效（{}），删除快照并回退 SQLite", e);
                    let _ = std::fs::remove_file(&snap_path);
                }
                Ok(snap_token) => {
                    let db_token = match store.db.get_meta("snapshot_token") {
                        Ok(t) => t,
                        Err(e) => {
                            warn!("[store] snapshot_token 读取失败（{}），按无 token 处理", e);
                            None
                        }
                    };
                    let prefer = match db_token.as_deref() {
                        // 代际一致 → 快照有效；空串 = 已被 to_sqlite 作废
                        Some(t) if !t.is_empty() => t == snap_token,
                        // 从未记录 token：仅当 db 为空（全新/被删重建）时兼容加载
                        None => match store.db.has_any_node() {
                            Ok(has) => !has,
                            Err(e) => {
                                warn!("[store] nodes 探测失败（{}），回退 SQLite", e);
                                false
                            }
                        },
                        Some(_) => false,
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
                                warn!("[store] 快照反序列化失败（{}），删除快照并回退 SQLite", e);
                                let _ = std::fs::remove_file(&snap_path);
                                if let Err(e2) = store.db.set_meta("snapshot_token", "") {
                                    warn!("[store] snapshot_token 清除失败: {}", e2);
                                }
                            }
                        }
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
    /// 快照路径同时写代际 token：文件头部 + db meta 的 snapshot_token，
    /// open 时两者一致才认快照（FTS 惰性重建/timeline 写 db 不影响）。
    pub fn save(&self) -> Result<(), String> {
        let idx = self.index.read();
        if idx.edge_count() >= crate::storage::snapshot::snapshot_min_edges() {
            let token = format!(
                "{}:{}:{}",
                idx.node_count(),
                idx.edge_count(),
                chrono::Utc::now().timestamp_millis()
            );
            idx.save_snapshot(&self.project_root, &token)?;
            // token 落库失败只 warn —— 退化为下次启动走 SQLite，安全。
            // 但此时磁盘上没有可被冷启动认可的权威快照，不能刷新 graph_generated_at，
            // 否则 SQLite 旧图会被误判为“新鲜”。
            if let Err(e) = self.db.set_meta("snapshot_token", &token) {
                warn!("[store] snapshot_token 写入失败（下次启动走 SQLite，安全退化）: {}", e);
                return Ok(());
            }
            // 记录本次持久化的完成时刻 —— 冷启动新鲜度判定的单一事实源。
            if let Err(e) = self
                .db
                .set_meta("graph_generated_at", &chrono::Utc::now().timestamp_millis().to_string())
            {
                warn!("[store] graph_generated_at 写入失败（冷启动新鲜度判定将回退旧逻辑）: {e}");
            }
            Ok(())
        } else {
            let result = idx.to_sqlite(&self.db);
            if result.is_ok() {
                // 记录本次持久化的完成时刻 —— 旧实现用 root/hologram_graph.json 的
                // mtime 判定新鲜度，而冷启动实际读的是 SQLite，两者由不同路径写入
                // 可能分歧 → 旧 SQLite 会被误判为“新鲜”永不重分析。
                if let Err(e) = self.db.set_meta(
                    "graph_generated_at",
                    &chrono::Utc::now().timestamp_millis().to_string(),
                ) {
                    warn!("[store] graph_generated_at 写入失败（冷启动新鲜度判定将回退旧逻辑）: {e}");
                }
            }
            result
        }
    }

    /// 将给定的新索引持久化到磁盘（SQLite 或快照），**成功后才由调用方交换进内存**。
    /// 与 save() 的区别：save() 持久化当前内存索引，供「已交换」场景使用；
    /// 本方法持久化一个尚未进入内存的待换入索引，供「先落盘、后换入」的全量
    /// 重分析路径使用，从而保证内存与磁盘永远一致 —— 落盘失败时调用方直接
    /// 终止分析，旧的（仍有效的）内存索引保留，绝不让「内存是新图、磁盘是旧图」
    /// 的分裂状态存在。
    ///
    /// 保存漏斗与 save() 一致：edge_count ≥ snapshot_min_edges() → bincode 快照；
    /// 否则走 SQLite 全量重写。快照路径的代际 token 写入失败视为落盘失败并向上
    /// 传播（上一版吞错会让下次启动因 token 不匹配回退读旧 SQLite）。
    pub fn save_index(&self, idx: &MemoryIndex) -> Result<(), String> {
        let stored = if idx.edge_count() >= crate::storage::snapshot::snapshot_min_edges() {
            let token = format!(
                "{}:{}:{}",
                idx.node_count(),
                idx.edge_count(),
                chrono::Utc::now().timestamp_millis()
            );
            idx.save_snapshot(&self.project_root, &token)?;
            self.db
                .set_meta("snapshot_token", &token)
                .map_err(|e| format!("snapshot_token 写入失败，快照可能不被冷启动认可: {e}"))?;
            Ok(())
        } else {
            idx.to_sqlite(&self.db)
        };
        // 全量分析主路径（pipeline.rs）走这里 —— 同样记录持久化时刻，见 save() 注释。
        if let Err(e) = self
            .db
            .set_meta("graph_generated_at", &chrono::Utc::now().timestamp_millis().to_string())
        {
            warn!("[store] graph_generated_at 写入失败（冷启动新鲜度判定将回退旧逻辑）: {e}");
        }
        stored
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

    /// 一个「重分析后的新图」：节点集/边集与 small_index 不同，模拟旧内存图被换入为更新的图。
    fn second_index() -> MemoryIndex {
        let mut nodes = HashMap::new();
        nodes.insert("x".into(), Node::new("x", "fn_x", NodeKind::Function));
        nodes.insert("y".into(), Node::new("y", "fn_y", NodeKind::Function));
        nodes.insert("z".into(), Node::new("z", "fn_z", NodeKind::Function));
        let mut edges = HashMap::new();
        edges.insert("e2".into(), Edge::new("e2", "x", "y", EdgeKind::Calls));
        edges.insert("e3".into(), Edge::new("e3", "y", "z", EdgeKind::Calls));
        MemoryIndex::from_existing_graph(nodes, edges)
    }

    /// 回归：先落盘、后换入的契约 —— save_index 持久化一个尚未进入内存的
    /// 待换入索引后，一个全新进程重开 store 必须读到该新图（而非旧内存图）。
    /// 旧实现是「先 swap 内存、后 save」，save 失败被吞，产生
    /// 内存新 / 磁盘旧的分裂 → 冷启动读回旧图（本 bug 的直接根因）。
    #[test]
    fn test_store_save_index_persists_before_swap_reload() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        std::env::set_var("HOLOGRAM_SNAPSHOT_MIN_EDGES", "0");
        let tmp = tmp_project("save_index_regression");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        {
            let store1 = GraphStore::open(&tmp).unwrap();
            // 落盘旧图（等价上一次分析留下的缓存）
            store1.save_index(&small_index()).unwrap();
            // 重分析产生新图 —— 先落盘、后换入的顺序（save_index 先于 swap_index）。
            // save_index 只写磁盘、不动内存：此时内存仍是刚落库时读回的旧图，磁盘已是新图 ——
            // 这正是不一致被消除的关键：落盘成功才随后 swap，失败则内存/磁盘都是旧图。
            store1.save_index(&second_index()).unwrap();
        } // drop → 连接关闭 → WAL checkpoint

        // 全新进程重开：必须读到新图（save_index 已落盘新图）
        let store2 = GraphStore::open(&tmp).unwrap();
        store2.read(|idx| {
            assert_eq!(idx.node_count(), 3, "重开须读到新图（3 节点）而非旧图（2 节点）");
            assert!(idx.get_node("z").is_some(), "新图节点 z 必须存在");
        });

        std::env::remove_var("HOLOGRAM_SNAPSHOT_MIN_EDGES");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 小阈值集成 + 核心回归：HOLOGRAM_SNAPSHOT_MIN_EDGES=0 时 save 走快照路径。
    /// 快照落盘后再写 db（timeline —— 模拟 FTS 惰性重建/timeline 写入），
    /// drop store 让连接关闭触发 WAL checkpoint（db mtime 推过快照 ——
    /// R9 初版 mtime 启发式在此场景翻车），重开仍须走快照加载。
    #[test]
    fn test_store_save_snapshot_path_and_reload() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        std::env::set_var("HOLOGRAM_SNAPSHOT_MIN_EDGES", "0");
        let tmp = tmp_project("snap_save");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        {
            let store1 = GraphStore::open(&tmp).unwrap();
            store1.swap_index(small_index());
            store1.save().unwrap();
            assert!(snapshot_path(&tmp).exists(), "阈值 0 → 应生成 graph.snapshot");
            // 代际 token 同时写入文件头部与 db meta
            let snap_token =
                crate::storage::snapshot::peek_snapshot_token(&snapshot_path(&tmp)).unwrap();
            assert_eq!(
                store1.db.get_meta("snapshot_token").unwrap(),
                Some(snap_token)
            );
            // 模拟 checkpoint 场景：快照落盘后 db 再有写入
            store1
                .db
                .record_timeline("test_event", None, "simulated post-snapshot write")
                .unwrap();
        } // store1 drop → 连接关闭 → WAL checkpoint（db mtime 推过快照）

        // 重开：token 一致 → 仍走快照（与 db mtime 无关）
        let store2 = GraphStore::open(&tmp).unwrap();
        store2.read(|idx| {
            assert_eq!(idx.node_count(), 2, "checkpoint 后仍应加载快照图");
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

    /// to_sqlite 失效规则：快照 save 后走一次 SQLite 全量保存 →
    /// snapshot_token 清空 → 重开走 SQLite（快照文件仍在但被无视）。
    #[test]
    fn test_store_to_sqlite_invalidates_snapshot() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        std::env::set_var("HOLOGRAM_SNAPSHOT_MIN_EDGES", "0");
        let tmp = tmp_project("invalidate");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        {
            let store1 = GraphStore::open(&tmp).unwrap();
            store1.swap_index(small_index());
            store1.save().unwrap();
            assert!(snapshot_path(&tmp).exists());
            // 强制一次 SQLite 全量保存（模拟 incremental.rs 直调路径）
            store1.read(|idx| idx.to_sqlite(&store1.db)).unwrap();
            assert_eq!(
                store1.db.get_meta("snapshot_token").unwrap(),
                Some(String::new()),
                "to_sqlite 成功应清空 snapshot_token"
            );
        }

        let store2 = GraphStore::open(&tmp).unwrap();
        assert!(snapshot_path(&tmp).exists(), "失效快照不删除，仅无视");
        store2.read(|idx| {
            assert_eq!(idx.node_count(), 2, "SQLite 路径同样载回 2 节点");
            assert_eq!(idx.edge_count(), 1);
            assert!(!idx.fts_dirty(), "SQLite 加载 → dirty=false（证明未走快照）");
        });

        std::env::remove_var("HOLOGRAM_SNAPSHOT_MIN_EDGES");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// token 不匹配：db 里的 snapshot_token 被改成别的值 → 重开走 SQLite
    ///（db 为空 → 0 节点，证明快照未被加载；快照文件保留不删）。
    #[test]
    fn test_store_token_mismatch_goes_sqlite() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        std::env::set_var("HOLOGRAM_SNAPSHOT_MIN_EDGES", "0");
        let tmp = tmp_project("mismatch");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        {
            let store1 = GraphStore::open(&tmp).unwrap();
            store1.swap_index(small_index());
            store1.save().unwrap();
            store1.db.set_meta("snapshot_token", "999:888:1").unwrap();
        }

        let store2 = GraphStore::open(&tmp).unwrap();
        assert!(snapshot_path(&tmp).exists(), "token 不匹配不删快照");
        store2.read(|idx| {
            assert_eq!(idx.node_count(), 0, "token 不匹配 → SQLite 空库 → 0 节点");
            assert_eq!(idx.edge_count(), 0);
        });

        std::env::remove_var("HOLOGRAM_SNAPSHOT_MIN_EDGES");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 无头部旧格式（R9 初版：裸 bincode payload）→ open 判损坏：
    /// 删快照、走 SQLite 成功。
    #[test]
    fn test_store_open_deletes_legacy_headerless_snapshot() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().unwrap();
        std::env::remove_var("HOLOGRAM_SNAPSHOT_MIN_EDGES");
        let tmp = tmp_project("legacy");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        {
            let store = GraphStore::open(&tmp).unwrap();
            store.swap_index(small_index());
            store.save().unwrap(); // 小图 < 默认阈值 → SQLite 路径，db 有数据
            // 手写 R9 初版格式：裸 bincode payload（无 token 头部）
            let legacy = store
                .read(|idx| bincode::serialize(&crate::storage::memory::to_snapshot(idx)).unwrap());
            std::fs::write(snapshot_path(&tmp), &legacy).unwrap();
        }

        let store2 = GraphStore::open(&tmp).unwrap();
        assert!(!snapshot_path(&tmp).exists(), "无头部旧格式应被删除");
        store2.read(|idx| {
            assert_eq!(idx.node_count(), 2, "应回退到 SQLite 数据");
            assert_eq!(idx.edge_count(), 1);
            assert!(!idx.fts_dirty(), "SQLite 加载 → dirty=false");
        });

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

        // 写入垃圾快照（peek 头部失败 → 按损坏处理）
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