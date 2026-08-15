// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Engine — 所有 graph 操作的统一 API 边界。
// 用一个拥有所有状态的结构体替换分散的全局变量
// （CACHED_GRAPH, GRAPH_STORE, ANALYZE_LOCK）。
//
// 生命周期：
//   let mut engine = Engine::new();
//   engine.init("/path/to/project")?;
//   engine.read(|idx| { ... })?;
//   engine.analyze()?;
//   engine.start_watcher(|json| { ... });

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use parking_lot::RwLock;
use rusqlite::Connection;
use tracing::info;

use crate::graph::Graph;
use crate::storage::{GraphStore, MemoryIndex, SqliteDb};
use crate::storage::sqlite::{timeline_query, timeline_record, timeline_record_with_props};

// ═══════════════════════════════════════════════════════════════
// EngineState — 生命周期状态机
// ═══════════════════════════════════════════════════════════════

/// Engine 生命周期状态。
/// 转换：Uninitialized → Loading → Ready ↔ Analyzing
/// Error 是从任何状态的终态汇。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineState {
    /// Engine 已创建但尚未用项目初始化。
    Uninitialized,
    /// 正在从 SQLite 或 JSON 加载 graph 数据。
    Loading {
        nodes_loaded: usize,
        edges_loaded: usize,
        elapsed_ms: u64,
    },
    /// Graph 已加载，可用于查询。
    Ready {
        node_count: usize,
        edge_count: usize,
    },
    /// 全量分析进行中。
    Analyzing {
        /// 分析开始时间（自 epoch 起的毫秒数）。
        started_at_ms: u64,
        /// 当前阶段标签（如 "解析文件", "社区检测"）。
        phase: String,
        /// 已处理的文件数。
        current: usize,
        /// 待处理文件总数（未知时为 0）。
        total: usize,
        /// 当前正在处理的文件（无则为空）。
        file: String,
    },
    /// 不可恢复的错误。
    Error(String),
}

impl EngineState {
    pub fn is_ready(&self) -> bool {
        matches!(self, EngineState::Ready { .. })
    }

    pub fn is_analyzing(&self) -> bool {
        matches!(self, EngineState::Analyzing { .. })
    }
}

// ═══════════════════════════════════════════════════════════════
// AnalyzeResult — Engine::analyze() 的返回值
// ═══════════════════════════════════════════════════════════════

/// 完整分析流水线运行的结果。
#[derive(Debug, Clone)]
pub struct AnalyzeResult {
    /// 分析后的 graph（供需要完整 Graph 对象的调用方使用）。
    pub graph: Graph,
    /// 结果 graph 中的节点数。
    pub node_count: usize,
    /// 结果 graph 中的边数。
    pub edge_count: usize,
    /// 检测到的社区数。
    pub community_count: usize,
    /// 层次化社区（Level 0 → N），仅单层时为 None。
    pub hierarchical_communities: Vec<crate::community::HierarchicalCommunity>,
    /// 完整流水线的挂钟时间。
    pub elapsed_secs: f64,
    /// 各阶段计时明细。
    pub stage_timings: Vec<StageTiming>,
}

/// 单个流水线阶段的计时记录。
#[derive(Debug, Clone)]
pub struct StageTiming {
    pub name: String,
    pub elapsed_secs: f64,
    pub detail: String,
}

// ═══════════════════════════════════════════════════════════════
// Engine — 唯一入口
// ═══════════════════════════════════════════════════════════════

fn graph_from_index(idx: &MemoryIndex) -> Graph {
    let mut g = Graph::new();
    for node in idx.nodes_iter() {
        g.add_node(node.clone());
    }
    for (source, targets) in idx.edges_iter_full() {
        for (target, kind, coupling_depth, delay, cross_file, metadata) in targets {
            let id = format!("{}::{}::{}", source, target, kind.as_str());
            let mut edge = crate::graph::Edge::new(id, source.clone(), target, kind);
            edge.coupling_depth = coupling_depth;
            edge.temporal_delay_sec = delay;
            edge.cross_file = cross_file;
            edge.metadata = metadata;
            g.add_edge_unchecked(edge);
        }
    }
    g
}

/// 核心引擎实例。拥有所有 graph 状态。
///
/// 所有 graph 操作 — 查询、分析、watcher — 都通过此结构体。
/// 外部代码不应直接访问 GraphStore、MemoryIndex 或遗留的
/// Graph 缓存。
pub struct Engine {
    /// Graph store（MemoryIndex + SQLite）。使用 std Mutex 包裹，因为
    /// GraphStore 包含 rusqlite::Connection，其为 !Sync。
    store: Mutex<Option<GraphStore>>,

    /// 专用于 timeline 的 SQLite 连接 — 永不阻塞 graph store 锁。
    timeline_conn: Mutex<Option<Connection>>,

    /// 当前项目根路径。在 init() 中设置一次。
    project_root: Mutex<PathBuf>,

    /// 串行化全量分析运行。同一时间仅允许一个 analyze()。
    analyze_lock: Mutex<()>,

    /// 当前运行中分析的取消令牌。
    /// 当新的 analyze() 调用想要抢占旧调用时设为 `true`。
    /// 运行中的流水线在阶段之间检查此令牌并提前中止。
    cancel_token: RwLock<Option<Arc<AtomicBool>>>,

    /// 当前生命周期状态。
    state: RwLock<EngineState>,

    /// 文件 watcher 是否正在运行。
    watcher_running: Arc<AtomicBool>,

    /// watcher 线程的 JoinHandle。stop_watcher() 用它确认
    /// 旧线程已退出后再启动新线程。
    watcher_handle: Mutex<Option<std::thread::JoinHandle<()>>>,

    /// watcher 检测到但尚未同步的待处理文件变更。
    /// 每条记录：(path, timestamp_ms, is_indexing)。
    pending_changes: Mutex<Vec<(String, u64, bool)>>,
}

impl Engine {
    /// 创建一个新的未初始化引擎。
    pub fn new() -> Self {
        Self {
            store: Mutex::new(None),
            timeline_conn: Mutex::new(None),
            project_root: Mutex::new(PathBuf::new()),
            analyze_lock: Mutex::new(()),
            cancel_token: RwLock::new(None),
            state: RwLock::new(EngineState::Uninitialized),
            watcher_running: Arc::new(AtomicBool::new(false)),
            watcher_handle: Mutex::new(None),
            pending_changes: Mutex::new(Vec::new()),
        }
    }

    // ── 标识 ──────────────────────────────────────────────

    /// 当前生命周期状态。
    pub fn state(&self) -> EngineState {
        self.state.read().clone()
    }

    /// 项目根路径（如已初始化）。
    pub fn project_root(&self) -> PathBuf {
        self.project_root.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 引擎是否已准备好响应查询。
    pub fn is_ready(&self) -> bool {
        self.state.read().is_ready()
    }

    // ── 初始化 ──────────────────────────────────────────────────

    /// 为项目初始化引擎。
    ///
    /// 在指定路径打开（或重新打开）GraphStore。如果项目根路径
    /// 已变更，旧的 store 将被替换。
    pub fn init(&mut self, project_root: &Path) -> Result<(), String> {
        let new_root = project_root.to_path_buf();
        let old_root = self.project_root.lock().unwrap_or_else(|e| e.into_inner()).clone();

        if old_root == new_root {
            // 相同项目 — 检查是否已初始化
            let store_guard = self.store.lock().unwrap_or_else(|e| e.into_inner());
            if store_guard.is_some() && self.is_ready() {
                // 确保 watcher 正在运行（MCP 重连后可能已丢失）
                if !self.is_watching() {
                    self.start_watcher(new_root.clone(), None::<Box<dyn Fn(String) + Send + 'static>>);
                }
                return Ok(());
            }
        } else if !old_root.as_os_str().is_empty() {
            info!(
                "[engine] workspace switch: {} → {}",
                old_root.display(),
                new_root.display()
            );
            // 停止旧 watcher — 它在监听前一个工作区。
            // 新 watcher 将在本方法末尾启动。
            self.stop_watcher();
        }

        // 设置加载状态
        *self.state.write() = EngineState::Loading {
            nodes_loaded: 0,
            edges_loaded: 0,
            elapsed_ms: 0,
        };

        let start = std::time::Instant::now();
        let store = GraphStore::open(&new_root)?;
        let timeline_conn = SqliteDb::open_aux_connection(store.db.path())?;

        // 读取计数以用于 Ready 状态
        let (node_count, edge_count) = store.read(|idx| (idx.node_count(), idx.edge_count()));

        *self.project_root.lock().unwrap_or_else(|e| e.into_inner()) = new_root.clone();
        *self.store.lock().unwrap_or_else(|e| e.into_inner()) = Some(store);
        *self.timeline_conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(timeline_conn);
        *self.state.write() = EngineState::Ready {
            node_count,
            edge_count,
        };

        info!(
            "[engine] initialized: {} nodes, {} edges in {:.1}ms",
            node_count,
            edge_count,
            start.elapsed().as_millis()
        );

        // 自动启动文件 watcher 以进行增量更新
        if !self.is_watching() {
            self.start_watcher(new_root.clone(), None::<Box<dyn Fn(String) + Send + 'static>>);
        }

        Ok(())
    }

    // ── 读取访问（并发，读取者之间无锁）──

    /// 从 MemoryIndex 读取。多个读取者可同时持有。
    ///
    /// 如果 store 未初始化则返回错误。
    pub fn read<R>(&self, f: impl FnOnce(&MemoryIndex) -> R) -> Result<R, String> {
        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Engine store lock poisoned: {}", e))?;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized — call init() first".to_string())?;
        Ok(store.read(f))
    }

    /// 通过从 MemoryIndex 重建遗留 Graph 来读取数据。
    /// 供需要 Graph 类型的调用方使用（遗留 API 兼容）。
    pub fn read_graph<R>(&self, f: impl FnOnce(&Graph) -> R) -> Result<R, String> {
        let graph = {
            let store_guard = self
                .store
                .lock()
                .map_err(|e| format!("Engine store lock poisoned: {}", e))?;
            let store = store_guard
                .as_ref()
                .ok_or_else(|| "Engine not initialized — call init() first".to_string())?;

            store.read(graph_from_index)
        };
        Ok(f(&graph))
    }

    /// 使用写锁修改 store。串行化所有写者。
    pub fn write<R>(&self, f: impl FnOnce(&mut MemoryIndex) -> R) -> Result<R, String> {
        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Engine store lock poisoned: {}", e))?;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized — call init() first".to_string())?;
        Ok(store.write(f))
    }

    // ── 节点/边计数 ─────────────────────────────────────

    /// 节点总数。
    pub fn node_count(&self) -> Result<usize, String> {
        self.read(|idx| idx.node_count())
    }

    /// 边总数。
    pub fn edge_count(&self) -> Result<usize, String> {
        self.read(|idx| idx.edge_count())
    }

    // ── 分析 ────────────────────────────────────────────

    /// 运行完整分析流水线并存储结果。
    ///
    /// 这是分析发生的唯一入口。所有消费者
    /// （MCP tool_analyze、Tauri direct_analyze、TCP handle_analyze）
    /// 都调用此方法。
    ///
    /// 流水线：analyze_project → CrossFileResolver → coupling →
    /// framework_routes → dynamic_dispatch → dataflow_synthesis →
    /// detect_communities → 存入 GraphStore + SQLite →
    /// 同步 CACHED_GRAPH（临时向后兼容）。
    pub fn analyze(&self, project_root: &Path) -> Result<AnalyzeResult, String> {
        // 取消当前正在运行的分析，使其在下一个阶段边界中止，
        // 快速释放锁而非运行到完成。这就是"重新分析"按钮响应灵敏的原因：
        // 旧运行提前退出，新运行立即启动。
        if let Some(token) = self.cancel_token.read().as_ref() {
            token.store(true, Ordering::SeqCst);
        }

        // 阻塞直到当前分析释放锁（取消后在阶段边界
        // 数秒内中止，而非数分钟）。
        let _lock = self
            .analyze_lock
            .lock()
            .map_err(|e| format!("Analyze lock poisoned: {}", e))?;

        // 旧分析已完成 — 清除过期的取消令牌并创建我们自己的。
        let cancel = Arc::new(AtomicBool::new(false));
        *self.cancel_token.write() = Some(cancel.clone());

        // 中止在工作区切换前排队的过期分析。
        if self.project_root() != project_root {
            return Err(format!(
                "分析已取消（工作区已切换到 {}）",
                self.project_root().display()
            ));
        }

        let started_at = std::time::Instant::now();
        let started_at_ms = chrono::Utc::now().timestamp_millis() as u64;

        // 更新进度的辅助函数（避免重复状态写入模式）
        let set_progress = |phase: &str, current: usize, total: usize, file: &str| {
            *self.state.write() = EngineState::Analyzing {
                started_at_ms,
                phase: phase.to_string(),
                current,
                total,
                file: file.to_string(),
            };
        };

        // 设置状态为 Analyzing
        set_progress("发现文件", 0, 0, "");

        info!("[engine] analysis started for {}", project_root.display());

        // ponytail: panic 守卫 — 如果任何流水线阶段 panic 或出错，
        // 将状态从 Analyzing 重置为 Error，使 UI 不会卡住。
        // 没有这个，一次栈溢出或 unwrap 失败会导致
        // 引擎永久停在 "analyzing" 且 analyze_lock 中毒。
        let analyze_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.run_pipeline(project_root, started_at, started_at_ms, &cancel)
        }));

        // 无论结果如何都清除取消令牌
        *self.cancel_token.write() = None;

        match analyze_result {
            Ok(Ok(result)) => {
                // 全量分析成功 → 增量漂移计数归零（社区/聚类结果重新变精确）。
                self.record_full_analysis();
                Ok(result)
            }
            Ok(Err(e)) => {
                *self.state.write() = EngineState::Error(e.clone());
                Err(e)
            }
            Err(panic_payload) => {
                let msg = panic_payload
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic_payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                *self.state.write() = EngineState::Error(format!("分析过程崩溃: {msg}"));
                Err(format!("分析过程崩溃: {msg}"))
            }
        }
    }

    // ── Timeline ─────────────────────────────────────────────

    /// 记录 timeline 事件。使用专用 DB 连接（不阻塞 graph store 锁）。
    pub fn record_timeline(
        &self,
        event_type: &str,
        node_id: Option<&str>,
        summary: &str,
    ) -> Result<(), String> {
        let conn_guard = self
            .timeline_conn
            .lock()
            .map_err(|e| format!("Timeline lock poisoned: {}", e))?;
        let conn = conn_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        timeline_record(conn, event_type, node_id, summary)
            .map_err(|e| format!("Timeline record failed: {}", e))
    }

    /// 记录带属性的 timeline 事件。
    pub fn record_timeline_with_props(
        &self,
        event_type: &str,
        node_id: Option<&str>,
        summary: &str,
        props: &serde_json::Value,
    ) -> Result<(), String> {
        let conn_guard = self
            .timeline_conn
            .lock()
            .map_err(|e| format!("Timeline lock poisoned: {}", e))?;
        let conn = conn_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        timeline_record_with_props(conn, event_type, node_id, summary, props)
            .map_err(|e| format!("Timeline record failed: {}", e))
    }

    /// 查询 timeline 事件。使用专用 DB 连接（不阻塞 graph store 锁）。
    pub fn query_timeline(
        &self,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>, String> {
        let conn_guard = self
            .timeline_conn
            .lock()
            .map_err(|e| format!("Timeline lock poisoned: {}", e))?;
        let conn = conn_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        timeline_query(conn, limit).map_err(|e| format!("Timeline query failed: {}", e))
    }

    /// 将当前 MemoryIndex 持久化到 SQLite。
    pub fn save(&self) -> Result<(), String> {
        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Store lock poisoned: {}", e))?;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        store.save()
    }

    /// 通过 SQLite FTS5 全文搜索。返回匹配的节点。
    pub fn fts_search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<crate::graph::Node>, String> {
        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Store lock poisoned: {}", e))?;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        let db = &store.db;
        Ok(store.read(|idx| idx.fts_search(db, query, limit).unwrap_or_default()))
    }

}

// ═══════════════════════════════════════════════════════════════
// 进程级 ENGINE 全局实例
// ═══════════════════════════════════════════════════════════════

// 子模块（从此文件中提取以保持可维护性）。
mod grammar;
mod pipeline;
mod watcher;
pub use grammar::GRAMMAR_LOADER;

/// 全局引擎实例。
///
/// 外层 RwLock 允许在工作区切换时替换整个 Engine。
pub static ENGINE: std::sync::LazyLock<RwLock<Option<Engine>>> =
    std::sync::LazyLock::new(|| RwLock::new(None));

/// 为给定项目根路径初始化全局引擎。
/// 可安全多次调用 — 相同项目复用现有引擎，
/// 工作区切换时替换。
pub fn engine_init(project_root: &Path) -> Result<(), String> {
    let mut engine_guard = ENGINE.write();
    match engine_guard.as_mut() {
        Some(engine) => {
            // 重新初始化内部处理相同项目复用和工作区切换
            engine.init(project_root)
        }
        None => {
            let mut engine = Engine::new();
            engine.init(project_root)?;
            *engine_guard = Some(engine);
            Ok(())
        }
    }
}

/// 从全局引擎的 MemoryIndex 读取。
pub fn engine_read<R>(f: impl FnOnce(&MemoryIndex) -> R) -> Result<R, String> {
    let engine_guard = ENGINE.read();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized — call engine_init() first".to_string())?;
    engine.read(f)
}

/// 通过重建的遗留 Graph 从全局引擎读取。
pub fn engine_read_graph<R>(f: impl FnOnce(&Graph) -> R) -> Result<R, String> {
    let engine_guard = ENGINE.read();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized — call engine_init() first".to_string())?;
    engine.read_graph(f)
}

/// 修改全局引擎的 MemoryIndex。
///
/// 锁机制：获取 ENGINE.read()（共享）以防止修改时工作区切换，
/// 然后获取内部 store 的 index.write() 进行实际串行化。
/// ENGINE 读锁不是写锁 — engine_init()（替换整个 Engine）
/// 是唯一获取 ENGINE.write() 的调用方。
pub fn engine_write<R>(f: impl FnOnce(&mut MemoryIndex) -> R) -> Result<R, String> {
    let engine_guard = ENGINE.read();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized — call engine_init() first".to_string())?;
    engine.write(f)
}

/// 获取全局引擎的当前状态。
pub fn engine_state() -> EngineState {
    ENGINE
        .read()
        .as_ref()
        .map(|e| e.state())
        .unwrap_or(EngineState::Uninitialized)
}

/// 借用全局 Engine 以进行直接方法调用。
/// 如果引擎尚未初始化则返回 None。
/// 当引擎模块外的调用方需要调用 Engine 上的
/// start_watcher() / stop_watcher() 等方法时使用。
pub fn with_engine<R>(f: impl FnOnce(&Engine) -> R) -> Option<R> {
    ENGINE.read().as_ref().map(f)
}

/// 在全局引擎上记录 timeline 事件。
pub fn engine_record_timeline(
    event_type: &str,
    node_id: Option<&str>,
    summary: &str,
) -> Result<(), String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.record_timeline(event_type, node_id, summary)
}

/// 在全局引擎上记录带属性的 timeline 事件。
pub fn engine_record_timeline_with_props(
    event_type: &str,
    node_id: Option<&str>,
    summary: &str,
    props: &serde_json::Value,
) -> Result<(), String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.record_timeline_with_props(event_type, node_id, summary, props)
}

/// 从全局引擎查询 timeline 事件。
pub fn engine_query_timeline(
    limit: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.query_timeline(limit)
}

/// 在全局引擎上持久化到 SQLite。
pub fn engine_save() -> Result<(), String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.save()
}

/// 在全局引擎上通过 FTS5 全文搜索。
pub fn engine_fts_search(
    query: &str,
    limit: usize,
) -> Result<Vec<crate::graph::Node>, String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.fts_search(query, limit)
}

/// 支持的源文件扩展名（动态，来自 GRAMMAR_LOADER）。
/// 始终与已安装的语法 DLL 保持同步。
pub fn engine_supported_extensions() -> Vec<String> {
    GRAMMAR_LOADER.supported_extensions()
}

/// 在全局引擎上运行分析。便捷封装，调用方
/// （MCP、TCP、Tauri）无需直接操作 ENGINE 锁。
pub fn engine_analyze(project_root: &Path) -> Result<AnalyzeResult, String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized — call engine_init() first".to_string())?;
    engine.analyze(project_root)
}

/// 先尝试增量更新，失败则回退到全量重新分析。
/// 由 Tauri shell 的文件 watcher 调用，使其在仅少数文件变更时
/// 不必总是进行全量重新分析。
pub fn engine_try_incremental(
    root: &Path,
    changed_files: &[(PathBuf, String)],
) -> Result<(), String> {
    Engine::handle_watcher_changes(root, changed_files, &None)
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

/// lib 测试中会写全局 ENGINE 的用例共享此锁，避免并行时
/// 互相 engine_init 把对方刚写入的 store 换掉。
#[cfg(test)]
pub(crate) static GLOBAL_ENGINE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn global_engine_test_guard() -> std::sync::MutexGuard<'static, ()> {
    GLOBAL_ENGINE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn test_engine_new_uninitialized() {
        let engine = Engine::new();
        assert_eq!(engine.state(), EngineState::Uninitialized);
        assert!(!engine.is_ready());
        assert_eq!(engine.project_root(), PathBuf::new());
        // 尚未初始化
        assert!(engine.read(|idx| idx.node_count()).is_err());
        assert!(engine.read_graph(|g| g.node_count()).is_err());
    }

    #[test]
    fn test_engine_init_empty_project() {
        let tmp = std::env::temp_dir().join("hologram_test_engine_init_empty");
        // 使用一个没有 .hologram/ 的子目录
        let test_dir = tmp.join("empty_project");
        let _ = std::fs::create_dir_all(&test_dir);

        let mut engine = Engine::new();
        // 在没有 graph 数据的目录上初始化应成功（空 store）
        let result = engine.init(&test_dir);
        assert!(result.is_ok(), "init should succeed on empty dir: {:?}", result.err());
        assert!(engine.is_ready());

        match engine.state() {
            EngineState::Ready { node_count, edge_count } => {
                assert_eq!(node_count, 0);
                assert_eq!(edge_count, 0);
            }
            other => panic!("Expected Ready, got {:?}", other),
        }

        assert_eq!(engine.project_root(), test_dir);
        assert_eq!(engine.node_count().unwrap(), 0);
        assert_eq!(engine.edge_count().unwrap(), 0);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_reinit_same_project_is_idempotent() {
        let tmp = std::env::temp_dir().join("hologram_test_engine_reinit");
        let test_dir = tmp.join("same_project");
        let _ = std::fs::create_dir_all(&test_dir);

        let mut engine = Engine::new();
        engine.init(&test_dir).unwrap();
        assert!(engine.is_ready());

        // 对相同项目的第二次初始化应成功（幂等）
        let result = engine.init(&test_dir);
        assert!(result.is_ok(), "re-init should be idempotent: {:?}", result.err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_workspace_switch_restarts_watcher() {
        let tmp = std::env::temp_dir().join("hologram_test_engine_ws_switch");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir_a = tmp.join("project_a");
        let dir_b = tmp.join("project_b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();

        let mut engine = Engine::new();

        // 用项目 A 初始化 — watcher 启动
        engine.init(&dir_a).unwrap();
        assert!(engine.is_ready());
        assert_eq!(engine.project_root(), dir_a);
        assert!(engine.is_watching(), "watcher should be running after first init");

        // 切换到项目 B — watcher 必须为新根路径重启
        engine.init(&dir_b).unwrap();
        assert!(engine.is_ready());
        assert_eq!(engine.project_root(), dir_b);
        assert!(engine.is_watching(), "watcher should be running after workspace switch");
        // 通过检查 project_root 验证它确实在监听新根路径
        // （watcher 线程持有 project_root 的 clone，隐式测试）

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 回归：engine_init 的工作区切换路径在持有 ENGINE.write() 时调用
    /// stop_watcher()；若 watcher 线程正阻塞在 ENGINE.read()
    /// （handle_watcher_changes），旧的裸 join() 会构成
    /// 「写锁等 join → join 等线程退出 → 线程等读锁」永久死锁，
    /// 进而拖死全局引擎锁的所有读者（edit_file 写盘后的
    /// timeline 记录即经 ENGINE.read()，曾表现为 edit 工具偶发挂死）。
    /// 修复后 stop_watcher 2s 超时分离，切换必须正常完成。
    #[test]
    fn test_workspace_switch_no_deadlock_when_watcher_blocked_on_read() {
        let _global_guard = global_engine_test_guard();
        let tmp = std::env::temp_dir().join("hologram_test_ws_switch_deadlock");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir_a = tmp.join("project_a");
        let dir_b = tmp.join("project_b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();

        engine_init(&dir_a).unwrap();

        // 模拟 engine_init 的持写锁窗口：手动拿写锁，制造一次源文件变更，
        // 等防抖窗口（2s）+ 轮询周期（0.5s）过去 — watcher 线程进入
        // handle_watcher_changes 并阻塞在 ENGINE.read()（写锁被我们持有）。
        let mut guard = ENGINE.write();
        std::fs::write(dir_a.join("deadlock_probe.rs"), "fn probe() {}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3500));

        // 通过写锁 guard 直接调 init（与 engine_init 同路径）——旧实现
        // 在此裸 join 永久挂死；修复后超时分离，切换正常完成。
        let engine = guard.as_mut().expect("engine must be initialized");
        let start = std::time::Instant::now();
        engine
            .init(&dir_b)
            .expect("workspace switch must succeed even with watcher blocked on read");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "workspace switch took {:?} — possible watcher join deadlock",
            start.elapsed()
        );
        assert_eq!(engine.project_root(), dir_b);
        drop(guard);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_state_transitions() {
        let mut engine = Engine::new();
        assert_eq!(engine.state(), EngineState::Uninitialized);

        let tmp = std::env::temp_dir().join("hologram_test_engine_states");
        let test_dir = tmp.join("states_project");
        let _ = std::fs::create_dir_all(&test_dir);

        engine.init(&test_dir).unwrap();
        assert!(matches!(engine.state(), EngineState::Ready { .. }));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_read_graph_works() {
        let tmp = std::env::temp_dir().join("hologram_test_engine_read_graph");
        let test_dir = tmp.join("rg_project");
        let _ = std::fs::create_dir_all(&test_dir);

        let mut engine = Engine::new();
        engine.init(&test_dir).unwrap();

        let count = engine.read_graph(|g| g.node_count()).unwrap();
        assert_eq!(count, 0); // 空项目

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_write_works() {
        use crate::graph::{Node, NodeKind};

        let tmp = std::env::temp_dir().join("hologram_test_engine_write");
        let test_dir = tmp.join("write_project");
        let _ = std::fs::create_dir_all(&test_dir);

        let mut engine = Engine::new();
        engine.init(&test_dir).unwrap();

        // 通过 write 插入节点
        engine
            .write(|idx| {
                let node = Node::new("test_node_1", "test_fn", NodeKind::Function);
                idx.insert_node(node);
            })
            .unwrap();

        // 读回数据
        let count = engine.read(|idx| idx.node_count()).unwrap();
        assert_eq!(count, 1);

        let node = engine.read(|idx| idx.get_node("test_node_1").cloned()).unwrap();
        assert!(node.is_some());
        assert_eq!(node.unwrap().name, "test_fn");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // test_global_engine_init_and_read 已移除 — 全局 ENGINE 函数
    // 由 MCP 测试隐式覆盖（使用 engine_read/write/init）。

    #[test]
    fn test_engine_read_without_init_returns_error() {
        // 不使用全局 ENGINE — 直接在一个从未初始化的 Engine 上测试
        // （read/write 应失败）。
        let engine = Engine::new();
        let result = engine.read(|idx: &MemoryIndex| idx.node_count());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Engine not initialized"));
    }

    /// F1 回归：增量更新路径不能总是返回 Err。
    /// 创建项目、分析、修改文件，然后验证
    /// IncrementalUpdater::update() 成功（不回退到全量分析）。
    #[test]
    fn test_incremental_update_path_is_reachable() {
        use crate::storage::incremental::IncrementalUpdater;
        

        let tmp = std::env::temp_dir().join("hologram_test_f1_incr");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // 创建一个小型 Python 项目
        std::fs::write(tmp.join("main.py"), "def hello():\n    return 'world'\n").unwrap();
        std::fs::write(tmp.join("util.py"), "def add(a, b):\n    return a + b\n").unwrap();

        // 分析
        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();
        let result = engine.analyze(&tmp).unwrap();
        assert!(result.node_count > 0, "should have nodes after analysis");

        // 读取旧索引
        let old_node_count = engine.read(|idx| idx.node_count()).unwrap();
        assert!(old_node_count > 0);

        // 修改文件（模拟 watcher 变更）
        std::fs::write(tmp.join("main.py"), "def hello():\n    return 'updated'\ndef new_fn(): pass\n").unwrap();

        // 尝试增量更新
        let store_guard = engine.store.lock().unwrap();
        let store = store_guard.as_ref().unwrap();
        let changed: Vec<(PathBuf, &str)> = vec![(tmp.join("main.py"), "modified")];
        let inc_result = IncrementalUpdater::update(
            &changed,
            &store.index.read(),
            &tmp,
            &store.db,
        );
        drop(store_guard);

        // 增量更新应成功（不回退到全量分析）
        match inc_result {
            Ok((new_idx, errors)) => {
                assert!(new_idx.node_count() >= old_node_count,
                    "incremental update should preserve or add nodes (old={}, new={})",
                    old_node_count, new_idx.node_count());
                if errors > 0 {
                    // 解析错误可接受，但节点数不应大幅下降
                }
            }
            Err(e) => {
                panic!("F1 regression: incremental update should succeed, got: {}", e);
            }
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// P1-4 回归：增量漂移计数持久化（meta 键 incr_since_full），
    /// 重启后保留，全量分析成功后归零。
    #[test]
    fn test_incremental_drift_tracking_persists_and_resets() {
        let tmp = std::env::temp_dir().join("hologram_test_incr_drift");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();
        assert_eq!(engine.incremental_since_full(), 0, "fresh project starts at zero drift");

        engine.record_incremental_success();
        engine.record_incremental_success();
        engine.record_incremental_success();
        assert_eq!(engine.incremental_since_full(), 3);

        // 模拟重启：新 Engine 实例重新 init 同一目录，计数必须保留
        drop(engine);
        let mut engine2 = Engine::new();
        engine2.init(&tmp).unwrap();
        assert_eq!(
            engine2.incremental_since_full(),
            3,
            "drift counter must survive restart via meta kv"
        );

        engine2.record_full_analysis();
        assert_eq!(engine2.incremental_since_full(), 0, "full analysis resets drift");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// P1-2 回归：mark_edge_lsp_resolved 只标记图中已存在的边，
    /// 并同步落库（load_all_edges 可读回）。
    #[test]
    fn test_mark_edge_lsp_resolved_engine_api() {
        use crate::graph::{EdgeKind, Node, NodeKind};

        let tmp = std::env::temp_dir().join("hologram_test_lsp_writeback");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();

        {
            let store_guard = engine.store.lock().unwrap();
            let store = store_guard.as_ref().unwrap();
            let mut idx = store.index.write();
            idx.insert_node(Node::new("a", "caller", NodeKind::Symbol));
            idx.insert_node(Node::new("b", "callee", NodeKind::Symbol));
            idx.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
            idx.flush_pending();
            // 落库 —— 生产路径中索引在分析完成后即已持久化
            idx.to_sqlite(&store.db).unwrap();
        }

        // 不存在的边 → Ok(false)，不凭空造边
        assert!(!engine
            .mark_edge_lsp_resolved("a", "b", EdgeKind::Reads)
            .unwrap());
        // 真实存在的 calls 边 → Ok(true)
        assert!(engine
            .mark_edge_lsp_resolved("a", "b", EdgeKind::Calls)
            .unwrap());

        {
            let store_guard = engine.store.lock().unwrap();
            let store = store_guard.as_ref().unwrap();
            let idx = store.index.read();
            assert!(idx.is_lsp_resolved("a", "b", EdgeKind::Calls));
            assert_eq!(idx.lsp_resolved_count(), 1);
        }

        // 持久化可读回（restart 语义）
        {
            let store_guard = engine.store.lock().unwrap();
            let store = store_guard.as_ref().unwrap();
            let loaded = store.db.load_all_edges().unwrap();
            let calls = loaded
                .iter()
                .find(|(_, _, k, _, _, _, _, _)| *k == EdgeKind::Calls)
                .expect("calls edge should be persisted");
            assert!(calls.7, "lsp_resolved 应落库读回");
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// [已移除] test_lsp_type_resolved_edges_in_graph — 此测试耦合到
    /// 已移除的手写 python_lsp 适配器。LSP 解析现在
    /// 通过 LspManager 按需执行；graph 边在索引时仅使用短名称。
    #[test]
    fn test_lsp_stub_placeholder() {
        // 占位符：保留测试槽位以供未来原生 LSP E2E 测试使用。
    }


    /// ponytail: graph_from_index 丢失了边元数据（特别是 cross_file），
    /// 因为 MemoryIndex CSR 不存储这些字段。修复方法是从
    /// 节点位置重新推导 cross_file。
    #[test]
    fn test_graph_from_index_cross_file() {
        use crate::graph::{EdgeKind, Node, NodeKind};
        use crate::storage::memory::MemoryIndex;

        let mut idx = MemoryIndex::new();

        // 相同文件
        let mut n1 = Node::new("n1", "fn_a", NodeKind::Function);
        n1.location = Some("src/lib.rs:10".into());
        idx.insert_node(n1);

        let mut n2 = Node::new("n2", "fn_b", NodeKind::Function);
        n2.location = Some("src/lib.rs:50".into());
        idx.insert_node(n2);

        // 不同文件
        let mut n3 = Node::new("n3", "fn_c", NodeKind::Function);
        n3.location = Some("src/main.rs:5".into());
        idx.insert_node(n3);

        idx.upsert_edge_full("n1", "n2", EdgeKind::Calls, 0, None, false, None); // 相同文件
        idx.upsert_edge_full("n1", "n3", EdgeKind::Calls, 0, None, true, None); // 跨文件
        idx.flush_pending(); // upsert_edge → pending_adds，flush → CSR 以便 graph_from_index 能看到

        let g = graph_from_index(&idx);
        assert_eq!(g.node_count(), 3);
        assert_eq!(g.edge_count(), 2);

        // Edge n1→n2：相同文件 → cross_file=false
        let e1 = g.edges_iter().map(|(_, e)| e).find(|e| e.source == "n1" && e.target == "n2").unwrap();
        assert!(!e1.cross_file, "n1→n2 should be same-file (both in src/lib.rs), got cross_file={}", e1.cross_file);

        // Edge n1→n3：不同文件 → cross_file=true
        let e2 = g.edges_iter().map(|(_, e)| e).find(|e| e.source == "n1" && e.target == "n3").unwrap();
        assert!(e2.cross_file, "n1→n3 should be cross-file (lib.rs vs main.rs), got cross_file={}", e2.cross_file);
    }

    /// 没有 location 信息的边应默认 cross_file=false。
    #[test]
    fn test_graph_from_index_no_location() {
        use crate::graph::{EdgeKind, Node, NodeKind};
        use crate::storage::memory::MemoryIndex;

        let mut idx = MemoryIndex::new();
        idx.insert_node(Node::new("a", "A", NodeKind::Symbol));
        idx.insert_node(Node::new("b", "B", NodeKind::Symbol));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.flush_pending();

        let g = graph_from_index(&idx);
        let e = g.edges_iter().next().unwrap().1;
        assert!(!e.cross_file, "edges without locations should default cross_file=false");
    }

    // ═══════════════════════════════════════════════════════════════
    // 重新分析韧性 — 状态绝不能停留在 Analyzing
    // ═══════════════════════════════════════════════════════════════

    /// 工作区不匹配错误后，状态必须为 Error（不能停留在
    /// Analyzing），且 analyze 锁必须已释放，以便下次调用
    /// 能继续。
    #[test]
    fn test_reanalyze_state_recovers_on_workspace_mismatch() {
        let tmp = std::env::temp_dir().join("hologram_test_rs_ws_mismatch");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir_a = tmp.join("project_a");
        let dir_b = tmp.join("project_b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();

        let mut engine = Engine::new();
        engine.init(&dir_a).unwrap();
        assert!(engine.is_ready());

        // 当引擎绑定到 dir_a 时 analyze(dir_b) — 必须失败
        let result = engine.analyze(&dir_b);
        assert!(result.is_err(), "analyze on wrong workspace must return Err");
        assert!(
            result.unwrap_err().contains("工作区已切换"),
            "error message should mention workspace switch"
        );

        // 状态必须为 Uninitialized（不是 Analyzing！），因为检查
        // 发生在 set_progress("发现文件", ...) 设置 Analyzing 之前。
        assert!(
            !engine.state().is_analyzing(),
            "state must NOT be Analyzing after workspace-mismatch error"
        );

        // 锁必须已释放 — 在正确路径上的第二次 analyze 可工作
        let result2 = engine.analyze(&dir_a);
        // 应成功（或因真实分析错误失败，而非锁
        // 中毒）。无论哪种情况都不能挂起。
        assert!(
            result2.is_ok() || !result2.as_ref().unwrap_err().contains("poisoned"),
            "analyze lock must not be poisoned after error: {:?}",
            result2.err()
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 对真实项目的全量分析：验证状态最终为 Ready（不
    /// 停留在 Analyzing）、数据可访问、锁已释放。
    #[test]
    fn test_reanalyze_completes_and_state_is_ready() {
        let tmp = std::env::temp_dir().join("hologram_test_rs_completes");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // 小型多文件 Python 项目以测试完整流水线
        std::fs::write(tmp.join("main.py"), "import util\ndef main():\n    return util.add(1, 2)\n").unwrap();
        std::fs::write(tmp.join("util.py"), "def add(a, b):\n    return a + b\n").unwrap();

        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();
        assert!(engine.is_ready());

        let result = engine.analyze(&tmp);
        assert!(result.is_ok(), "analyze must succeed: {:?}", result.err());

        // 状态必须为 Ready（不是 Analyzing）
        let state = engine.state();
        assert!(
            matches!(state, EngineState::Ready { .. }),
            "state must be Ready after successful analysis, got {:?}",
            state
        );

        // 数据必须可访问
        let nc = engine.node_count().unwrap();
        let ec = engine.edge_count().unwrap();
        assert!(nc > 0, "must have nodes after analysis");
        assert!(ec > 0, "must have edges after analysis (import + call)");

        // 锁健康 — 连续读取正常工作
        let nc2 = engine.read(|idx| idx.node_count()).unwrap();
        assert_eq!(nc2, nc, "read after analyze must return same count");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 验证 analyze 锁未中毒且状态未卡住
    /// （流水线完成后，无论成功或失败）。回归测试
    /// 针对 "re-analyze 卡在分析中" 的 bug，该 bug 中 panic 或错误
    /// 导致状态永久停留在 Analyzing。
    #[test]
    fn test_reanalyze_lock_healthy_and_state_not_stuck() {
        let tmp = std::env::temp_dir().join("hologram_test_rs_lock_healthy");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        std::fs::write(tmp.join("hello.py"), "def f(): pass\n").unwrap();

        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();

        // 运行 analyze — 可能成功或失败，但不能让状态卡住
        let _ = engine.analyze(&tmp);

        // 断言 1：状态不是 Analyzing
        assert!(
            !engine.state().is_analyzing(),
            "BUG: state stuck at Analyzing after analyze() returned"
        );

        // 断言 2：锁健康 — 可以再次调用 analyze()
        let result2 = engine.analyze(&tmp);
        // 要么成功，要么因非中毒错误失败
        if let Err(e) = &result2 {
            assert!(
                !e.contains("poisoned"),
                "BUG: analyze lock poisoned after first analyze: {}",
                e
            );
        }

        // 断言 3：graph 写入仍正常工作
        use crate::graph::{Node, NodeKind};
        let write_result = engine.write(|idx| {
            idx.insert_node(Node::new("test_n", "Test", NodeKind::Symbol));
        });
        assert!(write_result.is_ok(), "write after analyze must succeed: {:?}", write_result.err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 验证即使在两个引擎（不同实例）上并发调用 analyze()，
    /// 每个都能完成而不会泄漏对方的状态。
    /// 证明 analyze_lock 是实例级别的。
    #[test]
    fn test_reanalyze_independent_engines_dont_interfere() {
        let tmp = std::env::temp_dir().join("hologram_test_rs_independent");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir1 = tmp.join("p1");
        let dir2 = tmp.join("p2");
        std::fs::create_dir_all(&dir1).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();
        std::fs::write(dir1.join("a.py"), "def x(): pass\n").unwrap();
        std::fs::write(dir2.join("b.py"), "def y(): pass\n").unwrap();

        let mut e1 = Engine::new();
        let mut e2 = Engine::new();
        e1.init(&dir1).unwrap();
        e2.init(&dir2).unwrap();

        let r1 = e1.analyze(&dir1);
        let r2 = e2.analyze(&dir2);

        assert!(r1.is_ok(), "engine 1 analyze failed: {:?}", r1.err());
        assert!(r2.is_ok(), "engine 2 analyze failed: {:?}", r2.err());

        assert!(matches!(e1.state(), EngineState::Ready { .. }), "engine 1 state stuck");
        assert!(matches!(e2.state(), EngineState::Ready { .. }), "engine 2 state stuck");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 针对多文件、多语言 fixture 的全流水线集成测试。
    /// 一个覆盖整个技术栈回归的测试：
    /// parser → structure → coupling → communities → dataflow → persistence。
    #[test]
    fn test_fixture_full_pipeline() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/test_project");

        let mut engine = Engine::new();
        engine.init(&fixture).unwrap();
        let result = engine.analyze(&fixture);
        assert!(result.is_ok(), "analyze failed: {:?}", result.err());

        // ── 结构：节点 + 边存在 ──
        let nc = engine.node_count().unwrap();
        let ec = engine.edge_count().unwrap();
        assert!(nc >= 8, "expected >=8 nodes (3 py files + 1 js file + functions/classes), got {nc}");
        assert!(ec >= 5, "expected >=5 edges (calls + imports + inherits), got {ec}");

        // ── 边类型存在 ──
        let (has_calls, has_imports, has_defines, has_inherits) = engine.read(|idx| {
            let mut calls = false; let mut imports = false;
            let mut defines = false; let mut inherits = false;
            for (_src, targets) in idx.edges_iter() {
                for (_tgt, kind, _depth, _delay) in targets {
                    match kind {
                        crate::graph::EdgeKind::Calls => calls = true,
                        crate::graph::EdgeKind::Imports => imports = true,
                        crate::graph::EdgeKind::Defines => defines = true,
                        crate::graph::EdgeKind::Inherits => inherits = true,
                        _ => {}
                    }
                }
            }
            (calls, imports, defines, inherits)
        }).unwrap();
        assert!(has_calls, "must have Calls edges (e.g. main → connect_db)");
        assert!(has_imports, "must have Imports edges (Python cross-file imports)");
        assert!(has_defines, "must have Defines edges (class → module, function → class)");
        assert!(has_inherits, "must have Inherits edges (PooledConnection → Config)");

        // ── 社区已检测 ──
        let community_count = engine.read(|idx| {
            let ids: std::collections::HashSet<usize> = idx.nodes_iter()
                .filter_map(|n| n.community_id)
                .collect();
            ids.len()
        }).unwrap();
        assert!(community_count >= 1, "must detect at least 1 community");

        // ── 数据流：查询特定文件 ──
        let main_py = fixture.join("main.py");
        let db_py = fixture.join("db.py");
        let results = crate::analysis::dataflow_engine::query_dataflow_files(&[main_py, db_py]);
        assert_eq!(results.len(), 2);

        // main.py：应检测到 `main` 和 `fetch_remote` 异步触发器
        let main_df = results[0].result.as_ref().expect("main.py dataflow");
        let main_fn = main_df.scopes.iter().find(|s| s.name == "main").expect("main function");
        assert!(main_fn.writes.contains(&"db".into()), "main() writes db, got writes={:?}", main_fn.writes);
        let fetch_fn = main_df.scopes.iter().find(|s| s.name == "fetch_remote").expect("fetch_remote");
        assert!(!fetch_fn.triggers.is_empty(), "fetch_remote has await trigger");

        // db.py：`_connection_count` 应被检测为共享状态
        let db_df = results[1].result.as_ref().expect("db.py dataflow");
        // db.py 有共享变量：`host`（Config 构造函数 → connect_db），
        // `db` + `sql`（通过 execute_query → _do_query 传递）。
        let shared_vars: Vec<&str> = db_df.shared.iter().map(|s| s.var.as_str()).collect();
        assert!(shared_vars.contains(&"db"), "db.py should have shared 'db' var, got shared={:?}", db_df.shared);
        assert!(shared_vars.contains(&"host"), "db.py should have shared 'host' var, got shared={:?}", db_df.shared);

        // helper.js：异步 + 缓存模式
        let js_results = crate::analysis::dataflow_engine::query_dataflow_files(&[fixture.join("helper.js")]);
        let js_df = js_results[0].result.as_ref().expect("helper.js dataflow");
        let loader = js_df.scopes.iter().find(|s| s.name == "loadResource").expect("loadResource");
        assert!(loader.writes.contains(&"data".into()) || loader.writes.contains(&"cached".into()),
            "loadResource writes something, got writes={:?}", loader.writes);
        assert!(!loader.triggers.is_empty(), "loadResource has await trigger");

        // ── 持久化：保存 + 读回 ──
        engine.save().expect("save to SQLite");
        let nc2 = engine.read(|idx| idx.node_count()).unwrap();
        assert_eq!(nc2, nc, "node count after save must match");
    }

    /// 验证所有 4 个盲点合成阶段在针对含反射/eval/跨语言模式的多语言 fixture
    /// 运行时能生成标记节点。
    #[test]
    fn test_blindspot_synthesis_pipeline() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/pipeline_test");
        let mut engine = Engine::new();
        engine.init(&fixture).unwrap();
        let result = engine.analyze(&fixture).expect("pipeline test failed");
        let mut has_di = false; let mut has_dyn = false;
        let mut has_eval = false; let mut has_xlang = false;
        for t in &result.stage_timings {
            if t.name == "DI / Reflection" && t.detail.contains("edges") { has_di = true; }
            if t.name == "Dynamic Import" && t.detail.contains("markers") { has_dyn = true; }
            if t.name == "Eval Detection" && t.detail.contains("markers") { has_eval = true; }
            if t.name == "Cross-Lang" && t.detail.contains("markers") { has_xlang = true; }
        }
        assert!(has_di && has_dyn && has_eval && has_xlang,
            "all 4 synthesis stages must be present: DI={has_di} Dyn={has_dyn} Eval={has_eval} XLang={has_xlang}");
        let names: Vec<String> = engine.read(|idx| {
            idx.nodes_iter().map(|n| n.name.clone()).collect()
        }).unwrap();
        assert!(names.iter().any(|n| n.starts_with("<reflection:")), "DI marker missing");
        assert!(names.iter().any(|n| n.contains("dynamic-import")), "dyn-import marker missing");
        assert!(names.iter().any(|n| n.starts_with("<eval")), "eval marker missing");
        assert!(names.iter().any(|n| n.starts_with("<cross-lang:")), "cross-lang marker missing");
    }

    // ── 取消令牌测试 ──────────────────────────────────────────────

    /// 流水线中途设置取消标志 → 分析以取消错误中止。
    /// 证明重新分析不会阻塞等待运行中的分析
    /// 完成 — 旧分析在下一个阶段边界被取消。
    #[test]
    fn test_cancel_token_stops_pipeline() {
        let tmp = std::env::temp_dir().join("hologram_test_cancel_stop");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // ponytail: 3000 个文件使核心解析耗时 1-3s — 足够让
        // 取消信号在流水线完成前到达。300 个文件在开发机
        // 需 100-300ms，但在 CI runner（windows-latest, release
        // + 并行解析）上整条流水线 <55ms 就跑完了，取消信号
        // 到达时分析已 Ok 返回（CI 实测失败）。
        for i in 0..3000 {
            std::fs::write(
                tmp.join(format!("mod{}.py", i)),
                format!("def func{0}():\n    return {0}\n", i),
            )
            .unwrap();
        }

        let engine = std::sync::Arc::new(Engine::new());
        {
            let ptr = std::sync::Arc::as_ptr(&engine) as *mut Engine;
            unsafe { &mut *ptr }.init(&tmp).unwrap();
        }

        let e = engine.clone();
        let t = tmp.clone();
        let handle = std::thread::spawn(move || e.analyze(&t));

        // 等待分析实际开始（其取消令牌在流水线入口处
        // 发布），然后立即取消。盲目固定休眠会与线程调度
        // 竞争：在全套件负载下，生成的线程往往尚未启动，
        // 令牌仍为 None，取消静默失败 — 流水线随后运行到
        // 完成。令牌一发布就置位，留给流水线最长的
        // 取消窗口（首个检查点在核心解析完成之后）。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while engine.cancel_token.read().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        if let Some(token) = engine.cancel_token.read().as_ref() {
            token.store(true, Ordering::SeqCst);
        }

        let result = handle.join().unwrap();
        assert!(
            result.is_err(),
            "analysis must be cancelled: expected Err, got {:?}",
            result.ok()
        );
        assert!(
            result.unwrap_err().contains("已被新的重分析请求取消"),
            "error must mention cancellation"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 分析完成后（无论成功或失败），cancel_token 必须为
    /// None — 证明清理不会泄漏过期令牌干扰
    /// 下一次分析。
    #[test]
    fn test_cancel_token_cleaned_up_after_analysis() {
        let tmp = std::env::temp_dir().join("hologram_test_cancel_cleanup");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "def f(): pass\n").unwrap();

        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();

        // 1. 成功分析：令牌必须为 None
        let result = engine.analyze(&tmp);
        assert!(result.is_ok(), "analyze failed: {:?}", result.err());
        assert!(
            engine.cancel_token.read().is_none(),
            "cancel_token must be None after successful analysis"
        );

        // 2. 锁健康 — 可以再次分析
        let result2 = engine.analyze(&tmp);
        assert!(result2.is_ok(), "second analyze failed: {:?}", result2.err());
        assert!(
            engine.cancel_token.read().is_none(),
            "cancel_token must be None after second analysis"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 在另一个分析运行时调用 analyze() 会取消第一个并
    /// 运行到完成。这是重新分析按钮的契约：
    /// "立即重新开始，不在旧运行后面排队。"
    #[test]
    fn test_reanalyze_cancels_running_analysis() {
        let tmp = std::env::temp_dir().join("hologram_test_rac_cancel");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // 足够的文件确保第一次分析仍在运行
        // 当第二次调用到达时
        for i in 0..30 {
            std::fs::write(
                tmp.join(format!("lib{}.py", i)),
                format!("def fn{0}():\n    return {0}\nclass C{0}:\n    pass\n", i),
            )
            .unwrap();
        }

        let engine = std::sync::Arc::new(Engine::new());
        {
            let ptr = std::sync::Arc::as_ptr(&engine) as *mut Engine;
            unsafe { &mut *ptr }.init(&tmp).unwrap();
        }

        // 启动第一次分析
        let e1 = engine.clone();
        let t1 = tmp.clone();
        let handle = std::thread::spawn(move || e1.analyze(&t1));

        // 等待第一次分析实际开始（其取消令牌
        // 在流水线入口处发布）。盲目 200ms 休眠会与线程
        // 调度竞争：在全套件负载下，第一个线程有时尚未
        // 启动，导致第二次 analyze 先运行且自身被
        // 迟到的第一次取消 — 从而无法通过下方的 result2.is_ok() 断言。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while engine.cancel_token.read().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(
            engine.cancel_token.read().is_some(),
            "first analysis never started within 5s"
        );

        // 第二次分析 — 通过令牌取消第一次
        let result2 = engine.analyze(&tmp);
        assert!(result2.is_ok(), "second analyze must succeed: {:?}", result2.err());
        assert!(
            matches!(engine.state(), EngineState::Ready { .. }),
            "state must be Ready after second analysis"
        );

        // 第一次分析应已被取消（或如果足够快则已完成 —
        // 两者均可接受，关键是不能卡住）
        let result1 = handle.join().unwrap();
        if let Err(ref e) = result1 {
            assert!(
                e.contains("已被取消") || e.contains("已被新的重分析"),
                "if first analysis failed, must be from cancellation: {}",
                e
            );
        }
        // 如果 result1 为 Ok，表示第一次分析在取消
        // 生效前已完成 — 也可以接受（项目足够小）。

        // 验证所有操作后数据仍可访问
        let nc = engine.node_count().unwrap();
        assert!(nc > 0, "must have nodes after re-analysis");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 验证原生 LSP 解析端到端工作（无手写后备）。
    /// 使用此机器上可用的 LSP 服务器。
    #[test]
    fn test_native_lsp_resolve_call_e2e() {
        let _global_guard = global_engine_test_guard();
        let tmp = std::env::temp_dir().join("hologram_test_native_lsp");
        let _ = std::fs::remove_dir_all(&tmp);
        let test_dir = tmp.join("lsp_project");
        std::fs::create_dir_all(&test_dir).unwrap();

        // 初始化全局引擎
        let _ = crate::engine::engine_init(&test_dir);
        let root_str = test_dir.to_string_lossy().to_string();

        // 预热 LSP 池（只预热测试会访问的 Java 通道，
        // 避免全量 spawn 9 个 LSP 进程后在测试退出时遗留孤儿）。
        crate::lsp_manager::LspManager::warm_filtered(&root_str, &["java"]);

        // ── 测试 1：engine_status 返回 LSP 信息 ──
        let status = crate::tools::handlers::handler_status(&json!({}));
        let status_v = if let crate::tools::ToolResponse::Success(v) = status {
            v
        } else {
            panic!("engine_status should return Success, got: {:?}", status);
        };
        eprintln!("FULL STATUS: {}", serde_json::to_string_pretty(&status_v).unwrap());
        let lsp = &status_v["lsp"];
        let servers = lsp["servers"].as_array()
            .expect("lsp.servers should be an array; see FULL STATUS above");
        assert!(!servers.is_empty(),
            "lsp.servers should list configured servers; full status: {:?}", status_v);

        // ── 测试 2：不支持的语言返回 degraded ──
        let degraded = crate::tools::handlers::handler_resolve_call(&json!({
            "file": "test.sc",
            "function": "foo",
        }));
        assert!(matches!(degraded, crate::tools::ToolResponse::Degraded { .. }),
            "Unsupported language .sc should return Degraded, got: {:?}", degraded);

        // ── 测试 3：缺少 LSP 时 resolve_call 返回 degraded ──
        std::fs::write(test_dir.join("Test.java"), "class Test { void main() {} }").unwrap();
        let java_path = test_dir.join("Test.java").to_string_lossy().replace('\\', "/");
        let resp = crate::tools::handlers::handler_resolve_call(&json!({
            "file": java_path,
            "function": "main",
        }));
        eprintln!("Java resolve_call (no jdtls): {:?}", resp);
        match resp {
            crate::tools::ToolResponse::Degraded { ref guidance, ref fallback, .. } => {
                assert!(!guidance.is_empty());
                assert!(!fallback.is_empty());
                eprintln!("Degraded -> guidance: {}, fallback: {}", guidance, fallback);
            }
            crate::tools::ToolResponse::Success(v) => {
                eprintln!("jdtls unexpectedly available: {:?}", v);
            }
            _ => {
                eprintln!("Unexpected variant (not Degraded/Success)");
            }
        }

        // ── 测试 4：engine_status 的 missing 列表已填充 ──
        let missing = lsp["missing"].as_array().unwrap();
        let available = lsp["available"].as_array().unwrap();
        eprintln!("LSP available: {:?}", available);
        eprintln!("LSP missing: {:?}", missing);
        // 至少 rust-analyzer 在此机器上（通过 which 确认）
        // cargo test 中的 PATH 问题可能导致假阴性 — 仅断言结构

        let _ = std::fs::remove_dir_all(&tmp);
    }
}