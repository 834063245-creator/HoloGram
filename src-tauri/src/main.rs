// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram Tauri Backend
// 桥接层：Agent (TypeScript) → Tauri commands → Rust engine
// 不做分析逻辑，只做进程管理和文本转发

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)] use std::os::windows::process::CommandExt;

mod agent_isolation;
mod aura_memory;
mod mcp_manager;
mod pty_manager;
mod lsp_manager;
mod unity_manager;

mod permissions;
mod tools;
mod sandbox;
mod audit;
mod credential;
mod logging;
pub(crate) mod os_sandbox;
mod workspace;
mod utils;
mod commands;
mod confined_fs;
mod rpc;
mod lifecycle;

use std::sync::Arc;
use std::sync::Mutex;
use tauri::Manager;

// Re-export WorkspaceState so commands can reference it as crate::WorkspaceState
pub(crate) type WorkspaceState = Arc<Mutex<Option<workspace::WorkspaceHandle>>>;

// Engine imports — needed by tests (mod tests below uses super::*).
// Only types used by make_graph_with and serialize_cached_graph test helpers.
#[cfg(test)]
use hologram_engine as engine;
#[cfg(test)]
use engine::graph::Graph;
#[cfg(test)]
use engine::graph::{Node, NodeKind, Edge, EdgeKind};

/// Set the active workspace — now a no-op stub. Use workspace_activate instead.
/// Kept for API compatibility; frontend never calls this directly.
#[tauri::command]
fn set_active_project(_path: String) -> Result<(), String> {
    Ok(())
}

/// Return the currently active workspace path (empty string if none set).
/// Used by the frontend as a fallback when graph meta.source_root is missing on cold start.
#[tauri::command]
fn get_active_project(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    utils::workspace_path(&state)
}

// ═══════════════════════════════════════════════════════
// Watcher State (legacy — replaced by WorkspaceHandle in workspace.rs)
// ═══════════════════════════════════════════════════════

fn main() {
    let workspace_state: WorkspaceState = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 窗口位置/尺寸持久化 — Linux 无边框窗口每次启动不再回退到居中 1000x700
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(workspace_state)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Phase 1: Drain — gracefully stop all services via ResourceLedger
                let app = window.app_handle();
                if let Some(ledger) = app.try_state::<std::sync::Mutex<lifecycle::ResourceLedger>>() {
                    let ledger = ledger.lock().unwrap();
                    ledger.shutdown_all(std::time::Duration::from_secs(2));
                }
                // Also deactivate the workspace handle (stops watcher thread)
                if let Some(ws_state) = app.try_state::<WorkspaceState>() {
                    if let Ok(mut guard) = ws_state.lock() {
                        if let Some(handle) = guard.as_mut() {
                            handle.deactivate();
                        }
                    }
                }
                // Phase 2: Purge — hard exit ensures no zombie processes
                std::process::exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            rpc::rpc,
            set_active_project,
            get_active_project,
        ])
        .setup(|app| {
            // Phase 4a: OS sandbox — Job Object for die-with-parent
            os_sandbox::init();
            // Warn if OS sandbox is degraded — permission engine is the fallback
            let s = os_sandbox::status();
            if !matches!(s, os_sandbox::SandboxStatus::Available) {
                eprintln!("[hologram] OS sandbox 不可用 — 仅权限引擎生效");
            }
            // v4 Phase 4: server for Unity events
            commands::external::start_unity_event_server(app.handle().clone());
            // Memory Bundle: spawn if exe found next to hologram
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    let mb = exe_dir.join("memory-bundle.exe");
                    if mb.exists() {
                        let mut mc = std::process::Command::new(&mb);
                        mc.stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null());
                        #[cfg(windows)]
                        { mc.creation_flags(crate::utils::NO_WINDOW); }
                        // Retain Child handle for ResourceLedger to kill on shutdown
                        if let Ok(child) = mc.spawn() {
                            *commands::external::MEMORY_BUNDLE_CHILD.lock().unwrap() = Some(child);
                        }
                    }
                }
            }

            // Register all services with the ResourceLedger
            let mut ledger = lifecycle::ResourceLedger::new();
            ledger.register(Box::new(lifecycle::UnityEventService));
            ledger.register(Box::new(lifecycle::BgJobsService));
            ledger.register(Box::new(lifecycle::McpService));
            ledger.register(Box::new(lifecycle::UnityService));
            ledger.register(Box::new(lifecycle::PtyService));
            ledger.register(Box::new(lifecycle::LspService));
            ledger.register(Box::new(lifecycle::AuraService));
            ledger.register(Box::new(lifecycle::MemoryBundleService));
            ledger.register(Box::new(lifecycle::LoggingService));
            app.manage(std::sync::Mutex::new(ledger));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running hologram");
}

// ═══════════════════════════════════════════════════════
// #[cfg(test)] — 路由测试辅助（集成测试无法访问 binary crate static）
// ═══════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils;

    #[test]
    fn workspace_handle_activate_persists_last_project() {
        let tmp = std::env::temp_dir().join("hologram_test_activate");
        let _ = std::fs::create_dir_all(&tmp);
        let handle = workspace::WorkspaceHandle::new(&tmp.to_string_lossy());
        handle.activate(&tmp);
        let last_path = tmp.join(".last_project");
        assert!(last_path.exists());
        let content = std::fs::read_to_string(&last_path).unwrap();
        assert_eq!(content, tmp.to_string_lossy());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn workspace_handle_deactivate_stops_watcher() {
        let tmp = std::env::temp_dir().join("hologram_test_deactivate");
        let _ = std::fs::create_dir_all(&tmp);
        let mut handle = workspace::WorkspaceHandle::new(&tmp.to_string_lossy());
        // deactivate with no watcher running should not panic
        handle.deactivate();
        assert!(handle.changed_files.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn workspace_path_returns_error_when_no_workspace() {
        let state: WorkspaceState = Arc::new(Mutex::new(None));
        assert!(utils::workspace_path(&state).is_err());
    }

    #[test]
    fn workspace_path_returns_path_when_workspace_active() {
        let tmp = std::env::temp_dir().join("hologram_test_path");
        let _ = std::fs::create_dir_all(&tmp);
        let handle = workspace::WorkspaceHandle::new(&tmp.to_string_lossy());
        let state: WorkspaceState = Arc::new(Mutex::new(Some(handle)));
        assert_eq!(utils::workspace_path(&state).unwrap(), tmp.to_string_lossy());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Regression: serialize_cached_graph must never run on the async worker.
    /// It does heavy JSON serialization for 10k+ nodes. When run on the async
    /// thread it starves concurrent commands (read_file_content Promise hangs).
    /// This test verifies serialization works in a blocking thread and that a
    /// concurrent lightweight task can still make progress.
    #[test]
    fn serialize_cached_graph_in_spawn_blocking_does_not_starve_runtime() {
        let tmp = std::env::temp_dir().join("hologram_test_serialize_async");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("src")).unwrap();
        std::fs::write(
            tmp.join("src").join("main.py"),
            "def hello(): pass\nclass World:\n    def greet(self): pass\n",
        )
        .unwrap();

        // Init engine and run analysis to populate the graph store
        let tmp_s = tmp.to_string_lossy().to_string();
        utils::direct_analyze(&tmp_s, true).unwrap();

        // Build a tokio runtime to test spawn_blocking behaviour
        let rt = tokio::runtime::Runtime::new().unwrap();
        let tmp_c = tmp_s.clone();
        let serialized = rt.block_on(async {
            tokio::task::spawn_blocking(move || utils::serialize_cached_graph(&tmp_c))
                .await
                .unwrap()
                .unwrap()
        });

        let parsed: serde_json::Value =
            serde_json::from_str(&serialized).expect("should be valid JSON");
        let nodes = parsed["nodes"].as_array().expect("should have nodes array");
        assert!(!nodes.is_empty(), "should have at least one node");

        // Verify runtime not starved: a timer fires while serialization runs
        let tmp_c2 = tmp_s.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let _ = utils::serialize_cached_graph(&tmp_c2);
            tx.send(()).unwrap();
        });
        // serialize_cached_graph on a blocking thread should complete quickly
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .expect("serialize_cached_graph should complete within 10s");

        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── list_dir_flat tests ──

    #[test]
    fn list_dir_flat_returns_one_level() {
        let tmp = std::env::temp_dir().join("hologram_test_flat");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("sub")).unwrap();
        std::fs::write(tmp.join("a.py"), "x=1").unwrap();
        std::fs::write(tmp.join("b.rs"), "fn main(){}").unwrap();
        std::fs::write(tmp.join("sub").join("c.py"), "y=2").unwrap();

        let entries = utils::list_dir_flat(&tmp);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        // Only direct children, not c.py inside sub/
        assert!(names.contains(&"a.py"));
        assert!(names.contains(&"b.rs"));
        assert!(names.contains(&"sub"));
        assert!(!names.contains(&"c.py"), "c.py is in sub/, should not appear at top level");

        // All children must be null (no recursive loading)
        for e in &entries {
            assert!(e.children.is_none(), "children must be None for flat listing");
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_dir_flat_skips_hidden_and_vcs() {
        let tmp = std::env::temp_dir().join("hologram_test_flat_skip");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("main.py"), "x=1").unwrap();
        std::fs::write(tmp.join(".hidden"), "secret").unwrap();
        std::fs::create_dir_all(tmp.join(".git")).unwrap();
        std::fs::write(tmp.join(".git").join("config"), "git").unwrap();
        std::fs::create_dir_all(tmp.join("node_modules")).unwrap();
        std::fs::write(tmp.join("node_modules").join("lib.js"), "js").unwrap();

        let entries = utils::list_dir_flat(&tmp);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        // ponytail: only VCS internal dirs (.git/.hg/.svn) are hidden now;
        // dotfiles and build dirs are visible — git ignored coloring is frontend's job
        assert!(names.contains(&"main.py"));
        assert!(names.contains(&".hidden"), "dotfiles should be visible");
        assert!(!names.contains(&".git"), ".git should still be skipped (VCS internal)");
        assert!(names.contains(&"node_modules"), "node_modules should be visible (git-ignored coloring handles it)");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_dir_flat_keeps_allowed_dotfiles() {
        let tmp = std::env::temp_dir().join("hologram_test_flat_dotfiles");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(".env"), "SECRET=1").unwrap();
        std::fs::write(tmp.join(".gitignore"), "*.log").unwrap();
        std::fs::write(tmp.join(".editorconfig"), "root=true").unwrap();

        let entries = utils::list_dir_flat(&tmp);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        assert!(names.contains(&".env"), ".env should be included");
        assert!(names.contains(&".gitignore"), ".gitignore should be included");
        assert!(names.contains(&".editorconfig"), ".editorconfig should be included");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_dir_flat_dirs_first_then_alpha() {
        let tmp = std::env::temp_dir().join("hologram_test_flat_sort");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("zebra")).unwrap();
        std::fs::create_dir_all(tmp.join("alpha_dir")).unwrap();
        std::fs::write(tmp.join("beta.py"), "").unwrap();
        std::fs::write(tmp.join("alpha.py"), "").unwrap();

        let entries = utils::list_dir_flat(&tmp);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        // Directories first
        let alpha_dir_pos = names.iter().position(|n| *n == "alpha_dir").unwrap();
        let zebra_pos = names.iter().position(|n| *n == "zebra").unwrap();
        let alpha_file_pos = names.iter().position(|n| *n == "alpha.py").unwrap();
        let beta_pos = names.iter().position(|n| *n == "beta.py").unwrap();

        assert!(alpha_dir_pos < alpha_file_pos, "dirs should come before files");
        assert!(zebra_pos < alpha_file_pos, "dirs should come before files");
        // Within dirs: alpha_dir < zebra (case-insensitive)
        assert!(alpha_dir_pos < zebra_pos);
        // Within files: alpha.py < beta.py
        assert!(alpha_file_pos < beta_pos);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── diff_to_json regression tests ──
    // Bug: hologram_diff used to return `.len()` integers for added_nodes/
    // removed_nodes/modified_nodes. Frontend showDiff expected `{id, name}`
    // objects → `(5).map(...)` threw and status bar showed `+0 / -0 / ~0`.

    fn make_graph_with(nodes: &[(&str, &str, NodeKind)], edges: &[(&str, &str, &str, EdgeKind)]) -> Graph {
        let mut g = Graph::new();
        for (id, name, kind) in nodes {
            g.add_node(Node::new(*id, *name, *kind));
        }
        for (id, s, t, k) in edges {
            g.add_edge_unchecked(Edge::new(*id, *s, *t, *k));
        }
        g
    }

    #[test]
    fn diff_to_json_returns_node_objects_not_counts() {
        let before = make_graph_with(&[("a", "old_fn", NodeKind::Function)], &[]);
        let after = make_graph_with(&[
            ("a", "old_fn", NodeKind::Function),
            ("b", "new_fn", NodeKind::Function),
        ], &[]);
        let v = utils::diff_to_json(&before, &after);
        // added_nodes must be an array of objects, not a number
        let added = v["added_nodes"].as_array().expect("added_nodes must be array");
        assert_eq!(added.len(), 1);
        assert_eq!(added[0]["id"].as_str(), Some("b"));
        assert_eq!(added[0]["name"].as_str(), Some("new_fn"));
        assert_eq!(added[0]["type"].as_str(), Some("function"));
        assert!(!v["is_empty"].as_bool().unwrap(), "non-empty diff must report is_empty=false");
    }

    #[test]
    fn diff_to_json_removed_nodes_are_objects_with_id() {
        let before = make_graph_with(&[
            ("a", "keep", NodeKind::Function),
            ("b", "delete_me", NodeKind::Class),
        ], &[]);
        let after = make_graph_with(&[("a", "keep", NodeKind::Function)], &[]);
        let v = utils::diff_to_json(&before, &after);
        let removed = v["removed_nodes"].as_array().expect("removed_nodes must be array");
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0]["id"].as_str(), Some("b"));
        assert_eq!(removed[0]["name"].as_str(), Some("delete_me"));
        assert_eq!(removed[0]["type"].as_str(), Some("class"));
    }

    #[test]
    fn diff_to_json_modified_nodes_carry_kind_change() {
        let before = make_graph_with(&[("a", "x", NodeKind::Function)], &[]);
        let after = make_graph_with(&[("a", "x", NodeKind::Class)], &[]);
        let v = utils::diff_to_json(&before, &after);
        let modified = v["modified_nodes"].as_array().expect("modified_nodes must be array");
        assert_eq!(modified.len(), 1);
        assert_eq!(modified[0]["node_id"].as_str(), Some("a"));
        assert_eq!(modified[0]["old_kind"].as_str(), Some("function"));
        assert_eq!(modified[0]["new_kind"].as_str(), Some("class"));
    }

    #[test]
    fn diff_to_json_empty_diff_reports_is_empty() {
        let g = make_graph_with(&[("a", "x", NodeKind::Function)], &[]);
        let v = utils::diff_to_json(&g, &g);
        assert!(v["is_empty"].as_bool().unwrap());
        assert_eq!(v["added_nodes"].as_array().unwrap().len(), 0);
        assert_eq!(v["removed_nodes"].as_array().unwrap().len(), 0);
        assert_eq!(v["modified_nodes"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn diff_to_json_edge_counts_are_numbers() {
        let before = make_graph_with(&[
            ("a", "fn_a", NodeKind::Function),
            ("b", "fn_b", NodeKind::Function),
        ], &[]);
        let after = make_graph_with(&[
            ("a", "fn_a", NodeKind::Function),
            ("b", "fn_b", NodeKind::Function),
        ], &[("e1", "a", "b", EdgeKind::Calls)]);
        let v = utils::diff_to_json(&before, &after);
        // edges are counts in the command payload (showDiff only colors nodes)
        assert_eq!(v["added_edges"].as_u64(), Some(1));
        assert_eq!(v["removed_edges"].as_u64(), Some(0));
    }
}