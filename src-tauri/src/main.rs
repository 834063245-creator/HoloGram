// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram Tauri 后端
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
mod cdp;
mod desktop;
mod llm_proxy;

use std::sync::Arc;
use std::sync::Mutex;
use tauri::Manager;

// 重新导出 WorkspaceState，使命令可以以 crate::WorkspaceState 引用
pub(crate) type WorkspaceState = Arc<Mutex<Option<workspace::WorkspaceHandle>>>;

// Engine 导入 — 测试需要（下方 mod tests 使用 super::*）。
// 仅 make_graph_with 和 serialize_cached_graph 测试辅助函数使用的类型。
#[cfg(test)]
use hologram_engine as engine;
#[cfg(test)]
use engine::graph::Graph;
#[cfg(test)]
use engine::graph::{Node, NodeKind, Edge, EdgeKind};

/// 返回当前活跃工作区路径（未设置时为空字符串）。
/// 前端在冷启动时 graph meta.source_root 缺失时用作回退。
#[tauri::command]
fn get_active_project(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    utils::workspace_path(&state)
}

// ═══════════════════════════════════════════════════════
// Watcher 状态（遗留 — 已被 workspace.rs 中的 WorkspaceHandle 替代）
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
                // Phase 1: Drain — 后台线程执行，3s 超时保护避免 shutdown 阻塞导致僵尸进程
                let app = window.app_handle();
                let (tx, rx) = std::sync::mpsc::channel();
                let app_clone = app.clone();
                std::thread::spawn(move || {
                    if let Some(ledger) = app_clone.try_state::<std::sync::Mutex<lifecycle::ResourceLedger>>() {
                        let ledger = ledger.lock().unwrap_or_else(|e| e.into_inner());
                        ledger.shutdown_all(std::time::Duration::from_secs(2));
                    }
                    if let Some(ws_state) = app_clone.try_state::<WorkspaceState>() {
                        if let Ok(mut guard) = ws_state.lock() {
                            if let Some(handle) = guard.as_mut() {
                                handle.deactivate();
                            }
                        }
                    }
                    let _ = tx.send(());
                });
                // 最多等 3 秒，超时直接强退
                let _ = rx.recv_timeout(std::time::Duration::from_secs(3));
                // Phase 2: Purge — 强制退出确保无僵尸进程
                std::process::exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            rpc::rpc,
            get_active_project,
        ])
        .setup(|app| {
            // Phase 4a: OS 沙箱 — Job Object 实现 die-with-parent + 捆绑 MSYS2 bash 解析
            os_sandbox::init(app.handle());
            // 如果 OS 沙箱降级则警告 — 权限引擎作为回退
            let s = os_sandbox::status();
            if !matches!(s, os_sandbox::SandboxStatus::Available) {
                eprintln!("[hologram] OS sandbox 不可用 — 仅权限引擎生效");
            }
            // v4 Phase 4: Unity 事件服务器
            commands::external::start_unity_event_server(app.handle().clone());
            // LLM 反向代理 — 绕开 WebView CORS，让 provider 调用走后端（2026-08-16）
            let _proxy_port = llm_proxy::spawn_llm_proxy();
            // Memory Bundle: 如果在 hologram 旁找到 exe 则启动
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
                        // 保留 Child 句柄供 ResourceLedger 在关闭时终止
                        if let Ok(child) = mc.spawn() {
                            *crate::utils::lock_or_recover(&commands::external::MEMORY_BUNDLE_CHILD) = Some(child);
                        }
                    }
                }
            }

            // 将所有服务注册到 ResourceLedger
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
        // deactivate 在无 watcher 运行时不应 panic
        handle.deactivate();
        assert!(crate::utils::lock_or_recover(&handle.changed_files).is_empty());
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

    /// 回归测试：serialize_cached_graph 绝不能在 async worker 上运行。
    /// 它需要对 10k+ 节点进行大量 JSON 序列化。在 async
    /// 线程上运行会饿死并发命令（read_file_content Promise 挂起）。
    /// 此测试验证序列化在阻塞线程中工作，且
    /// 并发的轻量任务仍能继续执行。
    #[test]
    fn serialize_cached_graph_in_spawn_blocking_does_not_starve_runtime() {
        let _guard = ENGINE_TEST_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join("hologram_test_serialize_async");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("src")).unwrap();
        std::fs::write(
            tmp.join("src").join("main.py"),
            "def hello(): pass\nclass World:\n    def greet(self): pass\n",
        )
        .unwrap();

        // 初始化引擎并运行分析以填充图存储
        let tmp_s = tmp.to_string_lossy().to_string();
        utils::direct_analyze(&tmp_s, true).unwrap();

        // 构建 tokio runtime 以测试 spawn_blocking 行为
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

        // 验证运行时未被饿死：序列化运行时定时器能触发
        let tmp_c2 = tmp_s.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let _ = utils::serialize_cached_graph(&tmp_c2);
            tx.send(()).unwrap();
        });
        // serialize_cached_graph 在阻塞线程上应快速完成
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .expect("serialize_cached_graph should complete within 10s");

        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── list_dir_flat 测试 ──

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

        // 仅直接子项，不含 sub/ 中的 c.py
        assert!(names.contains(&"a.py"));
        assert!(names.contains(&"b.rs"));
        assert!(names.contains(&"sub"));
        assert!(!names.contains(&"c.py"), "c.py is in sub/, should not appear at top level");

        // 所有子项的 children 必须为 null（无递归加载）
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

        // ponytail: 现在仅隐藏 VCS 内部目录 (.git/.hg/.svn)；
        // dotfile 和构建目录可见 — git ignored 着色由前端处理
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

        // 目录在前
        let alpha_dir_pos = names.iter().position(|n| *n == "alpha_dir").unwrap();
        let zebra_pos = names.iter().position(|n| *n == "zebra").unwrap();
        let alpha_file_pos = names.iter().position(|n| *n == "alpha.py").unwrap();
        let beta_pos = names.iter().position(|n| *n == "beta.py").unwrap();

        assert!(alpha_dir_pos < alpha_file_pos, "dirs should come before files");
        assert!(zebra_pos < alpha_file_pos, "dirs should come before files");
        // 目录内：alpha_dir < zebra（不区分大小写）
        assert!(alpha_dir_pos < zebra_pos);
        // 文件内：alpha.py < beta.py
        assert!(alpha_file_pos < beta_pos);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── diff_to_json 回归测试 ──
    // Bug: hologram_diff 过去返回 `.len()` 整数给 added_nodes/
    // removed_nodes/modified_nodes。前端 showDiff 期望 `{id, name}`
    // 对象 → `(5).map(...)` 抛出异常，状态栏显示 `+0 / -0 / ~0`。

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
        // added_nodes 必须是对象数组，而非数字
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
        // edges 在命令 payload 中是计数（showDiff 仅着色节点）
        assert_eq!(v["added_edges"].as_u64(), Some(1));
        assert_eq!(v["removed_edges"].as_u64(), Some(0));
    }

    // ── 图分页测试（P0-2 分页化）─────────────────────────────
    // 逐页拉取必须与全量序列化等价：节点集合一致、边集合收敛到全图。
    // ⚠️ direct_analyze 操作进程级全局引擎，多个此类测试并行会互相
    //    取消分析（"分析已被新的重分析请求取消"）→ 用全局锁串行化。

    static ENGINE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn make_pageable_repo(tmp: &std::path::Path) {
        std::fs::create_dir_all(tmp.join("src").join("mod_a")).unwrap();
        std::fs::create_dir_all(tmp.join("src").join("mod_b")).unwrap();
        for i in 0..6 {
            std::fs::write(
                tmp.join("src").join("mod_a").join(format!("a{i}.py")),
                format!("def fa{i}():\n    pass\nclass CA{i}:\n    def m(self): pass\n"),
            )
            .unwrap();
            std::fs::write(
                tmp.join("src").join("mod_b").join(format!("b{i}.py")),
                format!("def fb{i}():\n    pass\n"),
            )
            .unwrap();
        }
    }

    #[test]
    fn graph_pages_reassemble_to_full_graph() {
        let _guard = ENGINE_TEST_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join("hologram_test_paging");
        let _ = std::fs::remove_dir_all(&tmp);
        make_pageable_repo(&tmp);
        let tmp_s = tmp.to_string_lossy().to_string();
        utils::direct_analyze(&tmp_s, true).unwrap();

        let page_size = 3usize;
        // meta：分页信息正确
        let meta: serde_json::Value = serde_json::from_str(
            &utils::graph_meta_json(&tmp_s, page_size).unwrap(),
        ).unwrap();
        assert_eq!(meta["paged"].as_bool(), Some(true));
        let total_pages = meta["total_pages"].as_u64().expect("total_pages") as usize;
        let node_count = meta["meta"]["node_count"].as_u64().unwrap() as usize;
        assert!(total_pages >= 2, "小仓库 + 小页宽必须切出多页");
        assert_eq!(meta["page_size"].as_u64().unwrap(), page_size as u64);

        // 逐页合并
        let full: serde_json::Value =
            serde_json::from_str(&utils::serialize_cached_graph(&tmp_s).unwrap()).unwrap();
        let full_nodes: std::collections::BTreeSet<String> = full["nodes"]
            .as_array().unwrap().iter()
            .map(|n| n["id"].as_str().unwrap().to_string())
            .collect();
        let full_edges: std::collections::BTreeSet<String> = full["edges"]
            .as_array().unwrap().iter()
            .map(|e| e["id"].as_str().unwrap().to_string())
            .collect();

        let mut merged_nodes: std::collections::BTreeSet<String> = Default::default();
        let mut merged_edges: std::collections::BTreeSet<String> = Default::default();
        let mut saw_hierarchical = false;
        for page in 0..total_pages {
            let p: serde_json::Value = serde_json::from_str(
                &utils::serialize_graph_page(&tmp_s, page, page_size).unwrap(),
            ).unwrap();
            assert_eq!(p["page"].as_u64().unwrap(), page as u64);
            assert_eq!(p["total_pages"].as_u64().unwrap(), total_pages as u64);
            assert_eq!(p["meta"]["node_count"].as_u64().unwrap() as usize, node_count);
            for n in p["nodes"].as_array().unwrap() {
                merged_nodes.insert(n["id"].as_str().unwrap().to_string());
            }
            for e in p["edges"].as_array().unwrap() {
                merged_edges.insert(e["id"].as_str().unwrap().to_string());
            }
            if page + 1 == total_pages {
                // 最后一页附带权威社区数据
                assert!(p["communities"].is_array());
                assert!(p["hierarchical_communities"].is_array());
                saw_hierarchical = true;
            }
        }
        assert!(saw_hierarchical, "最后一页必须携带 hierarchical_communities");
        assert_eq!(merged_nodes, full_nodes, "逐页节点集合必须与全量一致");
        assert_eq!(merged_edges, full_edges, "逐页边集合必须收敛到全量");

        // 边增量规则：每条边恰好在 max(两端点页号) 页下发一次 →
        // 各页边数之和 == 全量边数（单页响应有界，末页不再 ≈ 全量边表）
        let mut redelivered_total = 0usize;
        for page in 0..total_pages {
            let p: serde_json::Value = serde_json::from_str(
                &utils::serialize_graph_page(&tmp_s, page, page_size).unwrap(),
            ).unwrap();
            redelivered_total += p["edges"].as_array().unwrap().len();
        }
        assert_eq!(redelivered_total, full_edges.len(), "增量规则：每条边必须恰好下发一次");

        // 越界页报错
        let err = utils::serialize_graph_page(&tmp_s, total_pages, page_size).unwrap_err();
        assert!(err.contains("分页越界"), "越界页必须明确报错: {err}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn graph_page_index_cache_invalidates_on_graph_change() {
        let _guard = ENGINE_TEST_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join("hologram_test_paging_cache");
        let _ = std::fs::remove_dir_all(&tmp);
        make_pageable_repo(&tmp);
        let tmp_s = tmp.to_string_lossy().to_string();
        utils::direct_analyze(&tmp_s, true).unwrap();

        let page_size = 3usize;
        let before: serde_json::Value = serde_json::from_str(
            &utils::graph_meta_json(&tmp_s, page_size).unwrap(),
        ).unwrap();
        let before_pages = before["total_pages"].as_u64().unwrap();

        // 加一个文件 → 节点数变化 → 缓存键失效 → 页数变化
        std::fs::write(tmp.join("src").join("mod_b").join("b99.py"), "def fb99():\n    pass\n").unwrap();
        utils::direct_analyze(&tmp_s, true).unwrap();
        let after: serde_json::Value = serde_json::from_str(
            &utils::graph_meta_json(&tmp_s, page_size).unwrap(),
        ).unwrap();
        assert_ne!(after["total_pages"].as_u64().unwrap(), before_pages, "图变更后页数必须重算");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}