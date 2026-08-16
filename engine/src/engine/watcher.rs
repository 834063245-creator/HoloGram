// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 文件 watcher — 基于 notify 的增量更新，带防抖和回退机制。
// 从 engine/mod.rs 中提取。

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tracing::{info, warn};

use super::Engine;
use crate::analysis::coupling::compute_coupling;
use crate::engine::GRAMMAR_LOADER;
use crate::storage::incremental::IncrementalUpdater;
use crate::storage::memory::MemoryIndex;

impl Engine {
    /// 文件 watcher 是否正在运行。
    pub fn is_watching(&self) -> bool {
        self.watcher_running.load(Ordering::SeqCst)
    }

    /// 启动此项目的文件 watcher。
    ///
    /// 使用操作系统级文件系统事件（notify crate），2 秒防抖。
    /// 变更时：先尝试增量更新，失败则回退到通过 Engine::analyze()
    /// 进行全量重新分析。
    ///
    /// 每次成功更新后调用 `on_change`，传入 JSON 摘要字符串。
    /// MCP 模式下通常为空操作；Tauri 模式下发出 `graph-updated` 事件。
    pub fn start_watcher(
        &self,
        project_root: PathBuf,
        on_change: Option<Box<dyn Fn(String) + Send + 'static>>,
    ) {
        // 守卫：如果已有 watcher 在运行，不启动第二个
        if self.is_watching() {
            info!("[engine watcher] already watching, skipping duplicate start");
            return;
        }

        use std::collections::HashSet;
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        use notify::{Event, EventKind, RecursiveMode, Watcher};

        self.watcher_running.store(true, Ordering::SeqCst);

        let running = Arc::clone(&self.watcher_running);
        let root = project_root.clone();

        let handle = std::thread::spawn(move || {
            let (tx, rx) = mpsc::channel();

            let mut watcher =
                match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                    let _ = tx.send(res);
                }) {
                    Ok(w) => w,
                    Err(e) => {
                        warn!("[engine watcher] failed to create watcher: {}", e);
                        return;
                    }
                };

            if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
                warn!("[engine watcher] failed to watch {:?}: {}", root, e);
                return;
            }

            info!("[engine watcher] watching {:?} for source changes", root);

            // 源文件扩展名 — 从 grammar_loader 派生，使新安装的
            // 语法 DLL 无需修改代码即可自动跟踪。
            let mut source_exts: std::collections::HashSet<String> =
                GRAMMAR_LOADER.supported_extensions().into_iter().collect();
            // gRPC 合成器（analysis/grpc_services.rs）依赖 .proto 定义；
            // 不在 grammar 扩展名白名单内，需显式纳入监听，
            // 否则 .proto 变更不会触发增量重分析，服务端节点保持陈旧。
            source_exts.insert("proto".to_string());

            let mut pending = false;
            let mut changed_paths: Vec<(PathBuf, String)> = Vec::new();
            let mut seen_paths: HashSet<PathBuf> = HashSet::new();
            let mut last_event = Instant::now();
            let debounce_window = Duration::from_millis(2000);
            let poll_interval = Duration::from_millis(500);

            loop {
                if !running.load(Ordering::SeqCst) {
                    info!("[engine watcher] stopped");
                    return;
                }

                match rx.recv_timeout(poll_interval) {
                    Ok(Ok(event)) => {
                        // 过滤：仅关注源文件变更
                        let is_source = match event.kind {
                            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => true,
                            _ => false,
                        };
                        if !is_source {
                            continue;
                        }
                        let is_tracked = |p: &PathBuf| -> bool {
                            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
                            let is_src = source_exts.contains(ext);
                            let is_ignored = crate::pipeline::discovery::is_ignored_path(
                                &p.to_string_lossy()
                            );
                            is_src && !is_ignored
                        };
                        if !event.paths.iter().any(&is_tracked) {
                            continue;
                        }

                        use notify::event::{ModifyKind, RenameMode};
                        let action = match event.kind {
                            EventKind::Create(_) => "created",
                            EventKind::Remove(_) => "removed",
                            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => "removed",
                            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => "created",
                            EventKind::Modify(ModifyKind::Name(_)) => "modified",
                            _ => "modified",
                        };
                        for p in &event.paths {
                            if !is_tracked(p) {
                                continue;
                            }
                            if seen_paths.insert(p.clone()) {
                                info!("[engine watcher] change ({}): {}", action, p.display());
                                changed_paths.push((p.clone(), action.to_string()));
                            }
                        }
                        pending = true;
                        last_event = Instant::now();
                    }
                    Ok(Err(e)) => {
                        warn!("[engine watcher] watch error: {}", e);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if pending && last_event.elapsed() >= debounce_window {
                            pending = false;
                            let paths: Vec<(PathBuf, String)> =
                                std::mem::take(&mut changed_paths);
                            seen_paths.clear();
                            if !paths.is_empty() {
                                // 先尝试增量更新，失败则回退到全量重新分析
                                let _ = Self::handle_watcher_changes(&root, &paths, &on_change);
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        if let Ok(mut guard) = self.watcher_handle.lock() {
            *guard = Some(handle);
        }
    }

    /// 停止文件 watcher。轮询最多 2s 等待线程退出，超时则分离
    /// （丢弃 JoinHandle — 线程会在下次检查 `running` 时自行退出）。
    ///
    /// 不得裸 `join()`：调用方可能正持有全局 `ENGINE` 写锁
    /// （`engine_init` 的工作区切换路径），而 watcher 线程退出前需要
    /// `ENGINE.read()`（`handle_watcher_changes`）——裸 join 在此构成
    /// 「写锁等 join → join 等线程 → 线程等读锁 → 读锁等写锁」的
    /// 永久死锁，并把全局引擎锁一起拖死（所有 `ENGINE.read()` 调用方
    /// 永久阻塞，如 edit_file 写盘后的 timeline 记录）。
    /// 2s 轮询先例见 src-tauri `WorkspaceHandle::deactivate`。
    pub fn stop_watcher(&self) {
        self.watcher_running.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.watcher_handle.lock() {
            if let Some(handle) = guard.take() {
                // watcher 每 500ms 轮询一次 running 标志，2s 足够正常退出。
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                loop {
                    if handle.is_finished() {
                        let _ = handle.join();
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        // 分离：ENGINE 写锁释放后线程的 read 会解除阻塞，
                        // 完成当前一轮后在循环顶部看到 running == false 退出。
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }
    }

    /// 暴露 watcher 中待处理的文件变更，用于过期提示横幅。
    /// 返回 (path, timestamp_ms, is_indexing) 列表。
    pub fn get_pending_files(&self) -> Vec<(String, u64, bool)> {
        self.pending_changes.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 清除待处理的文件变更（成功重新索引后调用）。
    pub fn clear_pending_files(&self) {
        self.pending_changes.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    // ── 增量漂移治理（P1-4）──────────────────────────────────
    // 增量更新跳过部分派生分析：全局聚类只对新节点做邻居投票、
    // 动态分派/框架路由/片段提取不重跑 —— 社区/聚类结果会随
    // 增量次数漂移。计数器持久化在 meta 表（键 incr_since_full），
    // 重启后仍能诚实标注近似结果，而不是静默冒充精确。

    /// 自上次全量分析以来的增量更新次数（持久化，重启后保留）。
    pub fn incremental_since_full(&self) -> u64 {
        let store_guard = match self.store.lock() {
            Ok(g) => g,
            Err(e) => {
                warn!("[engine] store lock poisoned reading incr_since_full: {}", e);
                return 0;
            }
        };
        match store_guard.as_ref() {
            Some(store) => match store.db.get_meta("incr_since_full") {
                Ok(Some(v)) => v.parse::<u64>().unwrap_or(0),
                Ok(None) => 0,
                Err(e) => {
                    warn!("[engine] meta read incr_since_full failed: {}", e);
                    0
                }
            },
            None => 0,
        }
    }

    /// 增量更新成功后调用：漂移计数 +1 并持久化。
    pub fn record_incremental_success(&self) {
        let next = self.incremental_since_full().saturating_add(1);
        let store_guard = match self.store.lock() {
            Ok(g) => g,
            Err(e) => {
                warn!("[engine] store lock poisoned recording incremental: {}", e);
                return;
            }
        };
        if let Some(store) = store_guard.as_ref() {
            if let Err(e) = store.db.set_meta("incr_since_full", &next.to_string()) {
                warn!("[engine] persist incr_since_full failed: {}", e);
            }
        }
    }

    /// 全量分析成功后调用：漂移计数归零（社区/聚类结果重新变精确）。
    pub fn record_full_analysis(&self) {
        let store_guard = match self.store.lock() {
            Ok(g) => g,
            Err(e) => {
                warn!("[engine] store lock poisoned resetting incremental drift: {}", e);
                return;
            }
        };
        if let Some(store) = store_guard.as_ref() {
            if let Err(e) = store.db.set_meta("incr_since_full", "0") {
                warn!("[engine] reset incr_since_full failed: {}", e);
            }
        }
    }

    /// P1-2：把 resolve_call 的 LSP 解析结果回写图 ——
    /// 标记图中已存在的边 lsp_resolved=true（内存覆盖层 + SQLite 单边 UPDATE）。
    /// 返回 Ok(false) = 图中不存在该边（不凭空造边，防止把启发式写成「LSP 已解析」）。
    pub fn mark_edge_lsp_resolved(
        &self,
        source: &str,
        target: &str,
        kind: crate::graph::EdgeKind,
    ) -> Result<bool, String> {
        let mut store_guard = self
            .store
            .lock()
            .map_err(|e| format!("store lock poisoned: {}", e))?;
        let store = store_guard
            .as_mut()
            .ok_or_else(|| "Store not initialized".to_string())?;
        {
            let mut idx = store.index.write();
            if !idx.mark_lsp_resolved(source, target, kind) {
                return Ok(false);
            }
        }
        store.db.mark_edge_lsp_resolved(source, target, kind.as_str())?;
        Ok(true)
    }

    /// P1-1：导入 SCIP 索引（index.scip），把编译器级精确的符号引用边
    /// 合并进图并落库。返回导入统计（含被诚实跳过的引用数）。
    pub fn import_scip_index(
        &self,
        path: &Path,
    ) -> Result<crate::scip_bridge::ScipImportStats, String> {
        let index = crate::scip_bridge::parse_index_file(path)?;
        let root = self.project_root();
        // 先取漂移基再拿 store 锁 —— 锁内不可调 incremental_since_full()
        //（std Mutex 不可重入，曾在此死锁）。
        let drift_base = self.incremental_since_full();
        let mut store_guard = self
            .store
            .lock()
            .map_err(|e| format!("store lock poisoned: {}", e))?;
        let store = store_guard
            .as_mut()
            .ok_or_else(|| "Store not initialized".to_string())?;
        let stats = {
            let mut idx = store.index.write();
            let s = crate::scip_bridge::import_index(&mut idx, &index, Some(&root));
            idx.flush_pending();
            // SCIP 导入是一次性离线操作 —— 全量落库换取一致性。
            idx.to_sqlite(&store.db)?;
            s
        };
        // 新鲜度治理：记录导入时的增量漂移基。此后的任何增量更新
        // 都发生在静态索引生成之后 → SCIP 边可能过期（scip_staleness()）。
        store.db.set_meta("scip_imported", "1")?;
        store
            .db
            .set_meta("scip_import_drift_base", &drift_base.to_string())?;
        Ok(stats)
    }

    /// P1-1：分析完成后自动桥接根目录的 index.scip（存在时）。
    /// 失败只 warn（不阻断分析），成功记录统计 —— 桥接默认开启。
    pub fn try_auto_import_scip(&self) {
        let root = self.project_root();
        let candidate = root.join("index.scip");
        if !candidate.is_file() {
            return;
        }
        match self.import_scip_index(&candidate) {
            Ok(stats) => info!(
                "[engine] auto-imported index.scip: docs={} defs_added={} reused={} ext={} doc_nodes={} edges={} skipped_enclosing={}",
                stats.documents, stats.definitions_added, stats.definitions_reused,
                stats.external_nodes_added, stats.document_nodes_added,
                stats.edges_added, stats.skipped_no_enclosing,
            ),
            Err(e) => warn!("[engine] auto-import index.scip failed: {}", e),
        }
    }

    /// SCIP 边过期状态：(当前增量漂移, SCIP 导入时的漂移基)。
    /// None = 尚未导入 SCIP。任何导入后的增量更新都发生在静态索引
    /// 生成之后 —— 漂移差 > 0 即 SCIP 边可能过期（不静默冒充新鲜）。
    /// 两个 meta 值在同一把 store 锁内读取 —— 不可锁内调
    /// incremental_since_full()（std Mutex 不可重入，曾在此死锁）。
    pub fn scip_staleness(&self) -> Option<(u64, u64)> {
        let store_guard = self.store.lock().ok()?;
        let store = store_guard.as_ref()?;
        let base = store
            .db
            .get_meta("scip_import_drift_base")
            .ok()
            .flatten()?
            .parse::<u64>()
            .ok()?;
        let drift = store
            .db
            .get_meta("incr_since_full")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        Some((drift, base))
    }

    /// 增量漂移重算阈值：默认 10 次增量后自动全量重分析，
    /// 可用 HOLOGRAM_INCR_FULL_REANALYZE 覆盖，0 = 禁用。
    pub fn full_reanalyze_threshold() -> u64 {
        std::env::var("HOLOGRAM_INCR_FULL_REANALYZE")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(10)
    }

    /// 漂移达标且没有正在进行的分析 → 应触发全量重分析。
    /// 纯判定逻辑，便于单测。
    pub(crate) fn should_full_reanalyze(drift: u64, threshold: u64, analyzing: bool) -> bool {
        threshold > 0 && drift >= threshold && !analyzing
    }

    /// 漂移达标 → 触发全量重分析，整体刷新社区/合成边/框架路由等
    /// 派生结果。analyze_lock 串行化、状态机防重入，与回退路径一致。
    fn maybe_full_reanalyze(engine: &super::Engine, root: &Path) {
        let threshold = Engine::full_reanalyze_threshold();
        if threshold == 0 {
            return;
        }
        let drift = engine.incremental_since_full();
        let analyzing = matches!(engine.state(), super::EngineState::Analyzing { .. });
        if !Self::should_full_reanalyze(drift, threshold, analyzing) {
            return;
        }
        info!(
            "[engine watcher] drift {} >= threshold {}, triggering full re-analysis to refresh derived results",
            drift, threshold
        );
        let _ = super::engine_record_timeline_with_props(
            "drift_full_reanalyze",
            None,
            &format!("增量漂移 {} 达阈值 {}，自动全量重分析", drift, threshold),
            &serde_json::json!({"drift": drift, "threshold": threshold}),
        );
        // 与增量失败回退同一路径：同步全量重分析（成功后漂移归零）。
        let _ = super::engine_analyze(root);
    }

    /// 处理来自 watcher 的文件变更。先尝试增量更新，
    /// 失败则回退到全量重新分析。设为静态方法，以便 watcher 线程
    /// 通过全局 ENGINE 函数调用。
    pub(super) fn handle_watcher_changes(
        root: &Path,
        changed_files: &[(PathBuf, String)],
        on_change: &Option<Box<dyn Fn(String) + Send + 'static>>,
    ) -> Result<(), String> {
        let start = std::time::Instant::now();
        let count = changed_files.len();
        info!("[engine watcher] {} file(s) changed, trying incremental update", count);

        // 填充 pending_changes，以便在更新进行中查询索引的工具
        // 能触发过期提示横幅（参见 staleness.rs）。
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        {
            let engine_guard = super::ENGINE.read();
            if let Some(engine) = engine_guard.as_ref() {
                let mut pending = engine.pending_changes.lock().unwrap_or_else(|e| e.into_inner());
                for (path, _action) in changed_files {
                    pending.push((path.to_string_lossy().to_string(), now_ms, true));
                }
            }
        }

        // 通过 IncrementalUpdater 尝试增量更新（直接访问 store）
        let inc_result = (|| -> Result<(), String> {
            let engine_guard = super::ENGINE.read();
            let engine = engine_guard
                .as_ref()
                .ok_or_else(|| "Engine not initialized".to_string())?;
            let store_guard = engine
                .store
                .lock()
                .map_err(|e| format!("store lock: {}", e))?;
            let store = store_guard
                .as_ref()
                .ok_or_else(|| "Store not initialized".to_string())?;

            let paths: Vec<(PathBuf, &str)> = changed_files
                .iter()
                .map(|(p, a)| (p.clone(), a.as_str()))
                .collect();

            let (new_idx, errors) =
                IncrementalUpdater::update(&paths, &store.index.read(), root, &store.db)?;

            // ── 增量后合成 ──
            // 增量更新器为匹配的节点保留 community_id。
            // 新节点（community_id = None）通过邻居多数投票分配社区，
            // 避免全量重新聚类导致已有 ID 不稳定。
            // 投票分配结果 upsert 到 SQLite 以在重启后保留 —
            // swap_index() 仅替换内存中的索引。
            let synth_start = std::time::Instant::now();
            let mut graph = new_idx.to_graph();
            let voted_ids = crate::community::assign_communities_to_new_nodes(&mut graph);
            compute_coupling(&mut graph);
            if !voted_ids.is_empty() {
                let voted_nodes: Vec<&crate::graph::Node> = voted_ids
                    .iter()
                    .filter_map(|id| graph.get_node(id))
                    .collect();
                if let Err(e) = store.db.batch_upsert_nodes(&voted_nodes) {
                    warn!("[engine watcher] persist voted community_ids failed: {}", e);
                }
            }
            let (graph_nodes, graph_edges) = graph.into_parts();
            let final_idx =
                MemoryIndex::from_existing_graph(graph_nodes, graph_edges);
            let synth_ms = synth_start.elapsed().as_millis();
            info!(
                "[engine watcher] post-incremental synthesis (neighbor vote): {} assigned, {}ms",
                voted_ids.len(), synth_ms
            );

            store.swap_index(final_idx);
            store.reindex_vectors();
            if errors > 0 {
                info!("[engine watcher] incremental update with {} parse errors", errors);
            }
            Ok(())
        })();

        match inc_result {
            Ok(()) => {
                let elapsed = start.elapsed().as_secs_f64();
                info!(
                    "[engine watcher] incremental done in {:.1}s",
                    elapsed
                );
                let file_entries: Vec<String> = changed_files.iter()
                    .map(|(p, a)| {
                        let rel = p.strip_prefix(root).unwrap_or(p);
                        format!("{} ({})", rel.display(), a)
                    })
                    .collect();
                let summary = if file_entries.len() <= 5 {
                    file_entries.join("  ")
                } else {
                    format!("{} … +{} more", file_entries[..5].join("  "), file_entries.len() - 5)
                };
                let _ = super::engine_record_timeline_with_props(
                    "incremental_update",
                    None,
                    &summary,
                    &serde_json::json!({"count": count, "elapsed_secs": elapsed, "files": file_entries}),
                );
                if let Some(ref cb) = on_change {
                    cb(String::from(r#"{"status":"updated"}"#));
                }
                // 清除 pending_changes — 索引已更新
                {
                    let engine_guard = super::ENGINE.read();
                    if let Some(engine) = engine_guard.as_ref() {
                        engine.clear_pending_files();
                        // 漂移计数 +1：社区/聚类等派生结果自此标记为近似（P1-4）。
                        engine.record_incremental_success();
                        // 漂移阈值：增量次数达标 → 自动全量重分析，
                        // 社区/合成边/框架路由等派生结果整体刷新（P1-4 重算臂）。
                        Self::maybe_full_reanalyze(engine, root);
                    }
                }
                return Ok(());
            }
            Err(e) => {
                info!(
                    "[engine watcher] incremental failed ({}), falling back to full re-analysis",
                    e
                );
                let _ = super::engine_record_timeline_with_props(
                    "incremental_fallback",
                    None,
                    &format!("增量失败（{}），回退全量分析", e),
                    &serde_json::json!({"reason": e, "count": count}),
                );
            }
        }

        // 回退：通过 Engine::analyze() 进行全量重新分析
        info!("[engine watcher] falling back to full re-analysis");
        match super::engine_analyze(root) {
            Ok(result) => {
                let summary = serde_json::json!({
                    "status": "ok",
                    "node_count": result.node_count,
                    "edge_count": result.edge_count,
                    "elapsed_secs": result.elapsed_secs,
                }).to_string();
                info!(
                    "[engine watcher] full re-analysis done: {} nodes, {} edges in {:.1}s",
                    result.node_count, result.edge_count, result.elapsed_secs
                );
                let _ = super::engine_record_timeline_with_props(
                    "watcher_full_reanalyze",
                    None,
                    &format!("增量回退后全量完成：{} 节点 {} 边 {:.1}s", result.node_count, result.edge_count, result.elapsed_secs),
                    &serde_json::json!({"node_count": result.node_count, "edge_count": result.edge_count, "elapsed_secs": result.elapsed_secs}),
                );
                if let Some(ref cb) = on_change {
                    cb(summary);
                }
                // 清除 pending_changes — 全量重新分析成功
                {
                    let engine_guard = super::ENGINE.read();
                    if let Some(engine) = engine_guard.as_ref() {
                        engine.clear_pending_files();
                    }
                }
                Ok(())
            }
            Err(e) => {
                warn!("[engine watcher] full re-analysis failed: {}", e);
                let _ = super::engine_record_timeline(
                    "watcher_reanalyze_failed",
                    None,
                    &format!("回退全量也失败：{}", e),
                );
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_full_reanalyze_threshold_logic() {
        // 阈值 0 = 禁用
        assert!(!Engine::should_full_reanalyze(99, 0, false));
        // 未达标不触发
        assert!(!Engine::should_full_reanalyze(9, 10, false));
        // 达标且空闲 → 触发
        assert!(Engine::should_full_reanalyze(10, 10, false));
        assert!(Engine::should_full_reanalyze(25, 10, false));
        // 达标但正在分析 → 不重入
        assert!(!Engine::should_full_reanalyze(10, 10, true));
    }
}
