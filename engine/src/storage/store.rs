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
                    let idx = MemoryIndex::from_existing_graph(g.nodes, g.edges);
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

    /// 将当前 MemoryIndex 持久化到 SQLite。
    pub fn save(&self) -> Result<(), String> {
        let idx = self.index.read();
        idx.to_sqlite(&self.db)
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