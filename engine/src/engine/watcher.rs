// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// File watcher — notify-based incremental update with debounce and fallback.
// Extracted from engine/mod.rs.

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
    /// Whether the file watcher is currently running.
    pub fn is_watching(&self) -> bool {
        self.watcher_running.load(Ordering::SeqCst)
    }

    /// Start the file watcher for this project.
    ///
    /// Uses OS-level filesystem events (notify crate) with a 2-second debounce.
    /// On changes: tries incremental update first, falls back to full re-analysis
    /// via Engine::analyze().
    ///
    /// `on_change` is called after each successful update with a JSON summary string.
    /// In MCP mode this is typically a no-op; in Tauri mode it emits `graph-updated`.
    pub fn start_watcher(
        &self,
        project_root: PathBuf,
        on_change: Option<Box<dyn Fn(String) + Send + 'static>>,
    ) {
        // Guard: don't start a second watcher if one is already running
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

            // Source extensions — derived from grammar_loader so newly installed
            // grammar DLLs are automatically tracked without code changes.
            let source_exts: std::collections::HashSet<String> =
                GRAMMAR_LOADER.supported_extensions().into_iter().collect();

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
                        // Filter: only source file changes
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
                                // Try incremental first, fall back to full re-analysis
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

    /// Stop the file watcher. Joins the watcher thread to guarantee it has exited
    /// before returning (no blind sleep — the thread signals completion via JoinHandle).
    pub fn stop_watcher(&self) {
        self.watcher_running.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.watcher_handle.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }

    /// Expose pending file changes from the watcher for staleness banners.
    /// Returns list of (path, timestamp_ms, is_indexing).
    pub fn get_pending_files(&self) -> Vec<(String, u64, bool)> {
        self.pending_changes.lock().unwrap().clone()
    }

    /// Clear pending file changes (called after a successful re-index).
    pub fn clear_pending_files(&self) {
        self.pending_changes.lock().unwrap().clear();
    }

    /// Handle file changes from the watcher. Tries incremental update first,
    /// falls back to full re-analysis. Static so it can be called from the
    /// watcher thread via global ENGINE functions.
    pub(super) fn handle_watcher_changes(
        root: &Path,
        changed_files: &[(PathBuf, String)],
        on_change: &Option<Box<dyn Fn(String) + Send + 'static>>,
    ) -> Result<(), String> {
        let start = std::time::Instant::now();
        let count = changed_files.len();
        info!("[engine watcher] {} file(s) changed, trying incremental update", count);

        // Populate pending_changes so staleness banners fire for tools that
        // query the index while the update is in progress (see staleness.rs).
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        {
            let engine_guard = super::ENGINE.read();
            if let Some(engine) = engine_guard.as_ref() {
                let mut pending = engine.pending_changes.lock().unwrap();
                for (path, _action) in changed_files {
                    pending.push((path.to_string_lossy().to_string(), now_ms, true));
                }
            }
        }

        // Try incremental update via IncrementalUpdater (accesses store directly)
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

            // ── Post-incremental synthesis ──
            // The incremental updater preserves community_id for matched nodes.
            // New nodes (community_id = None) get assigned via neighbor majority vote,
            // avoiding full re-clustering that would destabilize existing IDs.
            // Voted assignments are upserted to SQLite so they survive restarts —
            // swap_index() only replaces the in-memory index.
            let synth_start = std::time::Instant::now();
            let mut graph = new_idx.to_graph();
            let voted_ids = crate::community::assign_communities_to_new_nodes(&mut graph);
            compute_coupling(&mut graph);
            if !voted_ids.is_empty() {
                let voted_nodes: Vec<&crate::graph::Node> = voted_ids
                    .iter()
                    .filter_map(|id| graph.nodes.get(id))
                    .collect();
                if let Err(e) = store.db.batch_upsert_nodes(&voted_nodes) {
                    warn!("[engine watcher] persist voted community_ids failed: {}", e);
                }
            }
            let final_idx =
                MemoryIndex::from_existing_graph(graph.nodes, graph.edges);
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
                // Clear pending_changes — index is now up-to-date
                {
                    let engine_guard = super::ENGINE.read();
                    if let Some(engine) = engine_guard.as_ref() {
                        engine.clear_pending_files();
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

        // Fallback: full re-analysis via Engine::analyze()
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
                // Clear pending_changes — full re-analysis succeeded
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
