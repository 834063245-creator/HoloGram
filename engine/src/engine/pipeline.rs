// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Pipeline runner — the 10-stage analysis pipeline extracted from engine/mod.rs.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tracing::{info, warn};

use crate::analysis::coupling::compute_coupling;
use crate::analysis::coupling::compute_coupling_incremental;
use crate::analysis::di_reflection::{
    detect_cross_lang_calls, detect_di_reflection, detect_dynamic_imports, detect_eval,
};
use crate::analysis::dynamic_dispatch::synthesize_dynamic_edges;
use crate::analysis::dynamic_dispatch_react::synthesize_react_edges;
use crate::analysis::dynamic_dispatch_vue::synthesize_vue_edges;
use crate::analysis::flows::detect_all_flows;
use crate::analysis::framework_routes::detect_framework_routes;
use crate::community::detect_communities_and_hierarchy;
use crate::graph::resolver::CrossFileResolver;
use crate::pipeline::runner::analyze_project;
use crate::storage::MemoryIndex;

use super::{AnalyzeResult, Engine, EngineState, StageTiming};

impl Engine {
    /// Pipeline body extracted so `catch_unwind` can guard against panics
    /// without poisoning the analyze_lock or leaving state at Analyzing.
    pub(super) fn run_pipeline(
        &self,
        project_root: &Path,
        started_at: std::time::Instant,
        started_at_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<AnalyzeResult, String> {
        let set_progress = |phase: &str, current: usize, total: usize, file: &str| {
            *self.state.write() = EngineState::Analyzing {
                started_at_ms,
                phase: phase.to_string(),
                current,
                total,
                file: file.to_string(),
            };
        };

        // Per-stage timing collector
        let mut stage_timings: Vec<StageTiming> = Vec::new();

        // 1. Core analysis (parse cache included for downstream synthesis)
        set_progress("解析文件", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let mut result = analyze_project(project_root);
        let failed_note = if result.files_failed > 0 {
            format!(", {} failed", result.files_failed)
        } else { String::new() };
        eprintln!("[engine] stage: core-parse done in {:.1}s ({} nodes, {} edges, {}/{} files{})",
            stage_start.elapsed().as_secs_f64(), result.graph.node_count(), result.graph.edge_count(),
            result.files_parsed, result.files_discovered, failed_note);
        stage_timings.push(StageTiming {
            name: "Core Parse".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{}/{} files{} → {} nodes, {} edges",
                result.files_parsed, result.files_discovered, failed_note,
                result.graph.node_count(), result.graph.edge_count()),
        });
        if cancel.load(Ordering::Relaxed) {
            return Err("分析已被新的重分析请求取消".to_string());
        }
        set_progress("解析完成", result.files_parsed, result.files_discovered,
            &if result.files_failed > 0 { format!("{} 个文件解析失败", result.files_failed) } else { String::new() });

        // 1.5. LSP call resolution → moved to on-demand MCP tool
        // (resolve_call). The graph stores coarse CALLS edges;
        // type-aware disambiguation happens lazily when the Agent asks.

        // 2. Cross-file resolution
        set_progress("跨文件解析", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let resolved = CrossFileResolver::resolve(&mut result.graph);
        info!(edges = resolved, "[engine] cross-file resolved");
        eprintln!("[engine] stage: cross-file done in {:.1}s ({} edges resolved)",
            stage_start.elapsed().as_secs_f64(), resolved);
        stage_timings.push(StageTiming {
            name: "Cross-File".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} edges resolved", resolved),
        });
        if cancel.load(Ordering::Relaxed) {
            return Err("分析已被新的重分析请求取消".to_string());
        }

        // 3. Coupling analysis
        set_progress("耦合分析", 0, 0, "");
        let stage_start = std::time::Instant::now();
        compute_coupling(&mut result.graph);
        eprintln!("[engine] stage: coupling done in {:.1}s",
            stage_start.elapsed().as_secs_f64());
        stage_timings.push(StageTiming {
            name: "Coupling".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: String::new(),
        });
        if cancel.load(Ordering::Relaxed) {
            return Err("分析已被新的重分析请求取消".to_string());
        }

        // 4. Framework route detection
        set_progress("框架路由检测", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let routes_found = detect_framework_routes(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        info!(count = routes_found, "[engine] framework routes detected");
        eprintln!("[engine] stage: framework-routes done in {:.1}s ({} routes)",
            stage_start.elapsed().as_secs_f64(), routes_found);
        stage_timings.push(StageTiming {
            name: "Framework Routes".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} routes", routes_found),
        });
        if cancel.load(Ordering::Relaxed) {
            return Err("分析已被新的重分析请求取消".to_string());
        }

        // 5. Dynamic dispatch synthesis
        set_progress("动态调度合成", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let syn_edges = synthesize_dynamic_edges(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        eprintln!("[engine] stage: dynamic-dispatch done in {:.1}s ({} edges)",
            stage_start.elapsed().as_secs_f64(), syn_edges);
        stage_timings.push(StageTiming {
            name: "Dynamic Dispatch".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} edges", syn_edges),
        });

        // 5.1. React synthesis
        set_progress("React合成", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let react_edges = synthesize_react_edges(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        eprintln!("[engine] stage: react-synthesis done in {:.1}s ({} edges)",
            stage_start.elapsed().as_secs_f64(), react_edges);
        stage_timings.push(StageTiming {
            name: "React Synthesis".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} edges", react_edges),
        });

        // 5.2. Vue synthesis
        set_progress("Vue合成", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let vue_edges = synthesize_vue_edges(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        eprintln!("[engine] stage: vue-synthesis done in {:.1}s ({} edges)",
            stage_start.elapsed().as_secs_f64(), vue_edges);
        stage_timings.push(StageTiming {
            name: "Vue Synthesis".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} edges", vue_edges),
        });

        // 5.5. DI / Reflection detection
        set_progress("DI/反射检测", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let di_edges = detect_di_reflection(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        eprintln!("[engine] stage: di-reflection done in {:.1}s ({} edges)",
            stage_start.elapsed().as_secs_f64(), di_edges);
        stage_timings.push(StageTiming {
            name: "DI / Reflection".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} edges", di_edges),
        });

        // 5.6. Dynamic import detection
        set_progress("动态导入检测", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let dyn_imp_edges = detect_dynamic_imports(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        eprintln!("[engine] stage: dynamic-import done in {:.1}s ({} markers)",
            stage_start.elapsed().as_secs_f64(), dyn_imp_edges);
        stage_timings.push(StageTiming {
            name: "Dynamic Import".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} markers", dyn_imp_edges),
        });

        // 5.7. Eval / dynamic code detection
        set_progress("Eval检测", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let eval_edges = detect_eval(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        eprintln!("[engine] stage: eval done in {:.1}s ({} markers)",
            stage_start.elapsed().as_secs_f64(), eval_edges);
        stage_timings.push(StageTiming {
            name: "Eval Detection".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} markers", eval_edges),
        });

        // 5.8. Cross-language call detection
        set_progress("跨语言调用检测", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let xlang_edges = detect_cross_lang_calls(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        eprintln!("[engine] stage: cross-lang done in {:.1}s ({} markers)",
            stage_start.elapsed().as_secs_f64(), xlang_edges);
        stage_timings.push(StageTiming {
            name: "Cross-Lang".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} markers", xlang_edges),
        });

                // 6. Dataflow — now on-demand via query_file_dataflow().
        // Pipeline no longer precomputes dataflow edges at graph build time.
        // Agent tools call the query engine directly when tracing variables.

        // 6.1. Re-run coupling for edges added during synthesis (steps 4-5.8).
        // Uses incremental mode — preserves L3/L4 depths set by DI reflection.
        set_progress("耦合增量更新", 0, 0, "");
        let stage_start = std::time::Instant::now();
        compute_coupling_incremental(&mut result.graph);
        eprintln!("[engine] stage: coupling-incr done in {:.1}s",
            stage_start.elapsed().as_secs_f64());
        stage_timings.push(StageTiming {
            name: "Coupling (incr)".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: String::new(),
        });

        // ── 5.9 Extract source snippets for vector index ──
        // ponytail: build module→source index first (O(F)), then single-pass nodes
        // (O(N×D) where D = module depth). Was O(F×N) — 1060 files × 26293 nodes = 27.8M iters.
        set_progress("源码片段提取", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let mut snippets_extracted = 0usize;
        // Build file index: module_id → source (clone to release parse_cache borrow)
        let file_map: std::collections::HashMap<String, String> = result.parse_cache.iter()
            .map(|(fp, (src, _))| {
                let mid = crate::path_utils::normalize_path(fp)
                    .replace(['/', '\\'], ".");
                (mid, src.clone())
            })
            .collect();
        // Single pass over nodes — try node.id as module prefix, progressively strip
        for (_, node) in result.graph.nodes.iter_mut() {
            if node.snippet.is_some() { continue; }
            let mut key: &str = node.id.as_str();
            loop {
                if let Some(source) = file_map.get(key) {
                    if let Some(snippet) = crate::vector::extract_snippet(source, &node.name, &node.kind) {
                        node.snippet = Some(snippet);
                        snippets_extracted += 1;
                    }
                    break;
                }
                match key.rfind('.') {
                    Some(pos) => key = &key[..pos],
                    None => break,
                }
            }
        }
        let snippet_elapsed = stage_start.elapsed().as_secs_f64();
        eprintln!("[engine] stage: snippet-extract done in {:.1}s ({} snippets)",
            snippet_elapsed, snippets_extracted);
        stage_timings.push(StageTiming {
            name: "Snippet Extract".into(),
            elapsed_secs: snippet_elapsed,
            detail: format!("{} snippets", snippets_extracted),
        });

        // ponytail: release parse_cache after synthesis
        result.parse_cache.clear();
        result.parse_cache.shrink_to_fit();

        // 7. Community detection (Leiden flat + Louvain hierarchical)
        set_progress("社区检测", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let (communities, hierarchical) = detect_communities_and_hierarchy(&result.graph, 42);
        let community_count = communities.len();
        let hc_count = hierarchical.iter().filter(|c| c.level > 0).count();
        let leiden_elapsed = stage_start.elapsed().as_secs_f64();
        info!(count = community_count, super_levels = hc_count, "[engine] Leiden communities detected");
        eprintln!("[engine] stage: community done in {:.1}s ({} communities, {} super)",
            leiden_elapsed, community_count, hc_count);
        stage_timings.push(StageTiming {
            name: "Community (Leiden)".into(),
            elapsed_secs: leiden_elapsed,
            detail: format!("{} communities, {} super", community_count, hc_count),
        });
        if cancel.load(Ordering::Relaxed) {
            return Err("分析已被新的重分析请求取消".to_string());
        }
        for (comm_idx, comm) in communities.iter().enumerate() {
            for node_id in comm {
                if let Some(node) = result.graph.nodes.get_mut(node_id) {
                    node.community_id = Some(comm_idx);
                }
            }
        }

        // 7.6. Execution flow detection
        // Entry points from framework routes + naming conventions → BFS forward
        // through CALLS edges → criticality scoring → persisted as node properties.
        set_progress("执行流检测", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let flow_count = detect_all_flows(&mut result);
        let flow_elapsed = stage_start.elapsed().as_secs_f64();
        eprintln!("[engine] stage: flows done in {:.1}s ({} flows)",
            flow_elapsed, flow_count);
        stage_timings.push(StageTiming {
            name: "Flow Detection".into(),
            elapsed_secs: flow_elapsed,
            detail: format!("{} flows", flow_count),
        });

        // 7.5. Build semantic vector index (fire-and-forget in background)
        // ponytail: uses nodes with snippets populated in step 5.9.
        // Runs on a background thread — doesn't block pipeline completion.
        let vector_nodes: Vec<crate::graph::Node> = result.graph.nodes.values().cloned().collect();
        let vector_path = project_root.join(".hologram").join("vectors.usearch");
        std::thread::spawn(move || {
            let vi = crate::vector::CodeVectorIndex::new(&vector_path);
            match vi.build(&vector_nodes) {
                Ok(n) => {
                    if n > 0 {
                        if let Err(e) = vi.save() {
                            tracing::warn!("[vector] save failed: {e}");
                        } else {
                            tracing::info!("[vector] index built: {} vectors saved to {}", n, vector_path.display());
                        }
                    }
                }
                Err(e) => tracing::warn!("[vector] build skipped: {e}"),
            }
        });

        // 8. Store into GraphStore (MemoryIndex + SQLite)
        set_progress("写入数据库", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let graph_nodes = std::mem::take(&mut result.graph.nodes);
        let graph_edges = std::mem::take(&mut result.graph.edges);
        let idx = MemoryIndex::from_existing_graph(graph_nodes, graph_edges);
        // Use deduped counts from MemoryIndex — raw Graph has duplicate edges
        // from multi-stage synthesis that get collapsed during dedup.
        let node_count = idx.node_count();
        let edge_count = idx.edge_count();
        let elapsed = started_at.elapsed().as_secs_f64();

        {
            let store_guard = self
                .store
                .lock()
                .map_err(|e| format!("Store lock poisoned: {}", e))?;
            if let Some(store) = store_guard.as_ref() {
                store.swap_index(idx);
                if let Err(e) = store.save() {
                    warn!("[engine] SQLite save failed: {}", e);
                }
            }
        }
        eprintln!("[engine] stage: db-save done in {:.1}s",
            stage_start.elapsed().as_secs_f64());
        stage_timings.push(StageTiming {
            name: "DB Save".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: String::new(),
        });

        // Warm LSP server pool in background — fire-and-forget,
        // doesn't block pipeline completion. Failed servers are
        // silently skipped; handwritten adapters serve as fallback.
        let proj_root = project_root.to_path_buf();
        std::thread::spawn(move || {
            let root_str = proj_root.to_string_lossy().to_string();
            crate::lsp_manager::LspManager::warm(&root_str);
        });

        // Set state back to Ready
        *self.state.write() = EngineState::Ready {
            node_count,
            edge_count,
        };

        info!(
            "[engine] analysis done: {} nodes, {} edges (deduped) in {:.1}s",
            node_count, edge_count, elapsed
        );

        Ok(AnalyzeResult {
            graph: result.graph,
            node_count,
            edge_count,
            community_count,
            hierarchical_communities: hierarchical,
            elapsed_secs: elapsed,
            stage_timings,
        })
    }
}