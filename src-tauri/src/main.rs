// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram Tauri Backend
// 桥接层：Agent (TypeScript) → Tauri commands → Rust engine
// 不做分析逻辑，只做进程管理和文本转发

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_isolation;
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

use std::sync::Arc;
use std::sync::Mutex;
use tauri::Manager;

// Re-export WorkspaceState so commands can reference it as crate::WorkspaceState
pub(crate) type WorkspaceState = Arc<Mutex<Option<workspace::WorkspaceHandle>>>;

// Engine imports — needed by tests (mod tests below uses super::*)
use hologram_engine as engine;
use engine::engine as engine_api;
use engine::graph::Graph;
use engine::graph::{Node, NodeKind, Edge, EdgeKind};
use engine::analysis::{fragile_nodes, detect_cycles, coupling_report,
    graph_summary, thread_conflict_report, find_blindspots, policy_check_from_index};
use engine::community::{detect_communities, detect_hierarchical_communities_with_base};
use engine::graph::query;
use engine::routing::preflight::{check_timeline_props, load_baseline, save_baseline};

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
        .manage(workspace_state)
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Cleanup: kill background jobs
                if let Ok(mut jobs) = utils::BG_JOBS.try_lock() {
                    for (_, job) in jobs.iter_mut() {
                        let _ = job.child.kill();
                        let _ = job.child.wait();
                    }
                    jobs.clear();
                }
                // Stop MCP server
                if let Ok(mut mgr) = commands::tools::MCP_MANAGER.try_lock() {
                    mgr.stop();
                }
                // Stop Unity
                let _ = commands::tools::UNITY_MANAGER.stop();
                // Hard exit to ensure no zombie processes
                std::process::exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            // ── Hologram graph commands ──
            commands::tools::hologram_tools_list,
            commands::tools::hologram_call,
            commands::hologram::get_full_graph,
            commands::hologram::hologram_analyze,
            commands::hologram::hologram_neighbors,
            commands::hologram::hologram_impact,
            commands::hologram::hologram_path,
            commands::hologram::hologram_graph_diff,
            commands::hologram::hologram_explore,
            commands::hologram::hologram_fragile,
            commands::hologram::hologram_search,
            commands::hologram::hologram_status,
            commands::hologram::hologram_cycle,
            commands::hologram::hologram_coupling_report,
            commands::hologram::hologram_blindspots,
            commands::hologram::hologram_thread_conflicts,
            commands::hologram::hologram_timeline,
            commands::hologram::hologram_record_event,
            commands::hologram::hologram_clusters,
            commands::hologram::hologram_graph_summary,
            commands::hologram::hologram_rename,
            commands::hologram::hologram_run_check,
            commands::hologram::hologram_run_preflight,
            commands::hologram::hologram_run_health,
            commands::hologram::hologram_history,
            commands::hologram::hologram_node,
            commands::hologram::hologram_unused,
            commands::hologram::hologram_community,
            commands::hologram::hologram_delayed,
            commands::hologram::hologram_hotspots,
            commands::hologram::hologram_workspace_conflict,
            commands::hologram::hologram_gate_check,
            commands::hologram::hologram_policy_check,
            commands::dataflow::hologram_dataflow,
            // ── Dataflow trace management ──
            commands::dataflow::dataflow_save,
            commands::dataflow::dataflow_query,
            commands::dataflow::dataflow_list,
            commands::dataflow::dataflow_delete,
            commands::dataflow::dataflow_verify,
            commands::dataflow::dataflow_stale_check,
            // ── Workspace commands ──
            commands::workspace::workspace_activate,
            commands::workspace::workspace_deactivate,
            commands::workspace::workspace_start_watcher,
            // ── Agent isolation ──
            commands::tools::agent_isolation_create,
            commands::tools::agent_isolation_diff,
            commands::tools::agent_isolation_merge,
            commands::tools::agent_isolation_discard,
            commands::tools::agent_isolation_status,
            commands::tools::agent_isolation_prune,
            // ── File operations ──
            commands::tools::list_directory,
            commands::tools::list_directory_flat,
            commands::tools::read_file_content,
            commands::tools::read_file_base64,
            commands::tools::write_file_content,
            commands::tools::log_append,
            commands::tools::create_directory,
            commands::tools::delete_file_or_dir,
            commands::tools::rename_file_or_dir,
            commands::tools::move_file,
            commands::tools::open_in_explorer,
            commands::tools::read_constraints,
            commands::tools::write_constraints,
            commands::tools::get_global_memory_dir,
            // ── Search & editing ──
            commands::tools::search_code,
            commands::tools::search_content,
            commands::tools::glob,
            commands::tools::edit_file,
            // ── Web ──
            commands::tools::web_fetch,
            commands::tools::web_search,
            // ── Terminal ──
            commands::tools::exec_command,
            commands::tools::bash_output,
            commands::tools::bash_kill,
            // ── Git commands ──
            commands::tools::git_tree_status,
            commands::tools::git_status,
            commands::tools::git_diff_unstaged,
            commands::tools::git_diff_staged,
            commands::tools::git_stage,
            commands::tools::git_unstage,
            commands::tools::git_stage_all,
            commands::tools::git_commit,
            commands::tools::git_push,
            commands::tools::git_pull,
            commands::tools::git_fetch,
            commands::tools::git_log,
            commands::tools::git_init,
            commands::tools::git_list_branches,
            commands::tools::git_checkout,
            commands::tools::git_create_branch,
            commands::tools::git_stash_push,
            commands::tools::git_stash_pop,
            commands::tools::git_stash_list,
            commands::tools::git_discard,
            commands::tools::git_blame,
            commands::tools::git_file_at_head,
            commands::tools::git_show,
            // ── Graph loading ──
            commands::tools::load_graph_json,
            commands::tools::load_binary_graph,
            commands::tools::analyze_and_load,
            commands::tools::analyze_in_background,
            // ── MCP ──
            commands::tools::start_mcp_server,
            commands::tools::stop_mcp_server,
            // ── Unity ──
            commands::tools::start_unity,
            commands::tools::stop_unity,
            commands::tools::unity_status,
            // ── Engine IPC ──
            commands::tools::engine_get_graph,
            commands::tools::engine_neighbors,
            commands::tools::engine_path,
            commands::tools::engine_search,
            commands::tools::engine_impact,
            // ── Credential ──
            commands::tools::credential_store,
            commands::tools::credential_get,
            commands::tools::credential_clear,
            // ── PTY ──
            pty_manager::pty_spawn,
            pty_manager::pty_write,
            pty_manager::pty_resize,
            pty_manager::pty_kill,
            // ── LSP ──
            lsp_manager::lsp_start,
            lsp_manager::lsp_request,
            lsp_manager::lsp_stop,
            // ── Permission ──
            commands::tools::permission_ask_response,
            // ── Root-level stubs ──
            set_active_project,
            get_active_project,
        ])
        .setup(|app| {
            // Phase 4a: OS sandbox — Job Object for die-with-parent
            os_sandbox::init();
            // v4 Phase 4: server for Unity events
            commands::tools::start_unity_event_server(app.handle().clone());
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
            g.add_edge(Edge::new(*id, *s, *t, *k));
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
