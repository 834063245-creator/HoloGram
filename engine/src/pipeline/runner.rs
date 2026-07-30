// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use rayon::prelude::*;
use tracing::info;

use crate::graph::merge::GraphMerger;
use crate::graph::Graph;
use crate::path_utils::normalize_path;
use crate::engine::GRAMMAR_LOADER;
use crate::pipeline::discovery::discover_files;
use crate::pipeline::parser::{FileData, ParallelParser};

/// 分析流水线结果。
pub struct PipelineResult {
    pub graph: Graph,
    pub files_discovered: usize,
    pub files_parsed: usize,
    pub files_failed: usize,
    pub nodes_total: usize,
    pub edges_total: usize,
    pub elapsed_secs: f64,
    /// 解析缓存：file_path → (source_code, parsed_tree)。
    /// 传递给后续合成阶段（步骤 4-6），使其可以重新遍历相同的
    /// AST，而无需从磁盘重新读取和重新解析文件。
    pub parse_cache: HashMap<String, (String, Option<tree_sitter::Tree>)>,
    /// 已发现的源文件（绝对路径）。
    /// 传递给后续合成阶段，使其可以遍历此列表而非
    /// 重新遍历整个项目目录树（消除了 3 次 walkdir）。
    pub discovered_files: Vec<std::path::PathBuf>,
}

/// 对项目目录运行完整的分析流水线。
/// 1. 发现源文件
/// 2. 使用 rayon 并行解析
/// 3. 合并为单个 graph（增量索引）
/// 4. 为下游合成阶段构建解析缓存
pub fn analyze_project(root: &Path) -> PipelineResult {
    let start = Instant::now();

    // 步骤 1：文件发现
    let exts: Vec<String> = GRAMMAR_LOADER.supported_extensions();
    let ext_strs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    let files = discover_files(root, &ext_strs);
    info!("[pipeline] discovered {} source files", files.len());

    // 步骤 2：分批并行解析 + 串行合并。
    // ponytail: v1 将所有解析结果收集到 Vec 中（内存爆炸：64K 文件需 4.4 GB）。
    // v2 通过 par_iter+filter_map+for_each 流式处理并使用 merger.lock()（mutex 竞争
    // → 超线性减速）。v3 分批：并行解析 N 个文件，串行合并，
    // 释放批次内存，重复。无锁，内存有界，线性合并。
    const BATCH: usize = 200;
    let parser = ParallelParser::new();
    let file_count = files.len();
    let parse_start = std::time::Instant::now();

    eprintln!(
        "[pipeline] parsing {} files in batches of {} with {} rayon threads…",
        file_count, BATCH, rayon::current_num_threads()
    );

    let mut merger = GraphMerger::with_capacity(file_count * 40, file_count * 150);
    let mut parse_cache = HashMap::with_capacity(file_count);
    let mut files_parsed = 0usize;
    let mut files_failed = 0usize;

    for batch in files.chunks(BATCH) {
        // ── 并行解析批次（无锁）──
        let t0 = Instant::now();
        let batch_results: Vec<(std::path::PathBuf, Option<FileData>)> = batch
            .par_iter()
            .map(|path| (path.clone(), parser.parse_one(path)))
            .collect();
        let parse_ms = t0.elapsed().as_millis();

        // ── 串行合并批次（单线程，无锁）──
        let t1 = Instant::now();
        let mut batch_trees: Vec<tree_sitter::Tree> = Vec::with_capacity(BATCH);
        for (path, result) in batch_results {
            let result = match result {
                Some(r) => r,
                None => {
                    files_failed += 1;
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("?");
                    tracing::warn!(ext, path = %path.display(), "[pipeline] parse failed — no adapter, I/O error, or unsupported language");
                    continue;
                }
            };
            files_parsed += 1;
            merger.merge_slices(&result.nodes, &result.edges);
            let abs_path = normalize_path(&result.path.to_string_lossy());
            parse_cache.insert(abs_path, (result.source, None));
            // ponytail: 按批收集 CST 树，在后台线程释放。
            // ts_tree_delete() 为 O(tree.nodes) — 同步释放 200 个大文件的
            // 树会阻塞合并循环 10 秒以上。后台释放可以在
            // 不阻塞的情况下回收内存，代价是最多有 ~2×BATCH 棵树在途。
            if let Some(t) = result.tree {
                batch_trees.push(t);
            }
        }
        let merge_ms = t1.elapsed().as_millis();
        // batch_results 在此处 drop → 批次内存完全释放（nodes, edges, source）

        // 在后台线程释放 CST 树 — ts_tree_delete 为 O(nodes)，
        // 每个大文件可能耗时 100-500ms。此操作在下一批解析时并行执行。
        if !batch_trees.is_empty() {
            std::thread::spawn(move || drop(batch_trees));
        }

        eprintln!(
            "[pipeline] batch {}/{} files — parse {}ms, merge {}ms | total {} nodes, {} edges",
            files_parsed + files_failed, file_count,
            parse_ms, merge_ms,
            merger.node_count(), merger.graph().edge_count()
        );
    }

    let parse_elapsed = parse_start.elapsed().as_secs_f64();
    eprintln!(
        "[pipeline] parse+merge done in {:.2}s — {} parsed, {} failed, {} nodes, {} edges",
        parse_elapsed, files_parsed, files_failed, merger.node_count(), merger.graph().edge_count()
    );

    let graph = merger.into_graph();
    let nodes_total = graph.node_count();
    let edges_total = graph.edge_count();
    let elapsed = start.elapsed();

    // 健康检查：如果超过 5% 的已发现文件解析失败，则发出明显警告。
    if files_failed > 0 && files_failed > file_count / 20 {
        tracing::warn!(
            "[pipeline] HEALTH: {}/{} files failed to parse ({:.1}%) — analysis may be incomplete. \
             Check logs above for [parser] warnings (missing adapters, I/O errors).",
            files_failed, file_count, files_failed as f64 / file_count as f64 * 100.0
        );
    }

    let result = PipelineResult {
        graph,
        files_discovered: file_count,
        files_parsed,
        files_failed,
        nodes_total,
        edges_total,
        elapsed_secs: elapsed.as_secs_f64(),
        parse_cache,
        discovered_files: files,
    };

    info!(
        "[pipeline] done: {}/{} files parsed ({} failed) → {} nodes, {} edges in {:.2}s",
        result.files_parsed, result.files_discovered, result.files_failed,
        result.nodes_total, result.edges_total, result.elapsed_secs
    );

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_analyze_small_project() {
        let tmp = std::env::temp_dir().join("hologram_test_project");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("app")).unwrap();

        fs::write(tmp.join("app").join("models.py"),
            "from django.db import models\n\nclass User(models.Model):\n    name = models.CharField()\n"
        ).unwrap();
        fs::write(tmp.join("app").join("views.py"),
            "from .models import User\n\ndef index():\n    return User.objects.all()\n"
        ).unwrap();

        let result = analyze_project(&tmp);
        assert!(result.files_parsed >= 2);
        assert!(result.nodes_total >= 2, "should find User class + index fn, got {}", result.nodes_total);
        assert!(result.elapsed_secs < 10.0, "small project should parse in <10s, took {:.2}s", result.elapsed_secs);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_empty_project() {
        let tmp = std::env::temp_dir().join("hologram_test_empty");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let result = analyze_project(&tmp);
        assert_eq!(result.files_parsed, 0);
        assert_eq!(result.nodes_total, 0);
        assert_eq!(result.edges_total, 0);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_rust_project() {
        let tmp = std::env::temp_dir().join("hologram_test_rust");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src")).unwrap();

        fs::write(tmp.join("src").join("main.rs"),
            "fn main() {\n    println!(\"hello\");\n}\n\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n"
        ).unwrap();

        let result = analyze_project(&tmp);
        assert!(result.files_parsed >= 1);
        // Rust tree-sitter 应至少找到 main + add
        assert!(result.nodes_total >= 2, "should find main + add in Rust file");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_go_project() {
        let tmp = std::env::temp_dir().join("hologram_test_go");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        fs::write(tmp.join("main.go"),
            "package main\n\nimport \"fmt\"\n\nfunc main() {\n    fmt.Println(\"hello\")\n}\n"
        ).unwrap();

        let result = analyze_project(&tmp);
        assert!(result.files_parsed >= 1);
        assert!(result.nodes_total >= 1);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_nested_directories() {
        let tmp = std::env::temp_dir().join("hologram_test_nested");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src").join("utils")).unwrap();

        fs::write(tmp.join("src").join("main.py"), "def main(): pass\n").unwrap();
        fs::write(tmp.join("src").join("utils").join("helpers.py"), "def helper(): pass\n").unwrap();

        let result = analyze_project(&tmp);
        assert_eq!(result.files_parsed, 2);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_syntax_error_tolerant() {
        let tmp = std::env::temp_dir().join("hologram_test_err");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        fs::write(tmp.join("broken.py"), "def foo(:\n    pass\n").unwrap();
        fs::write(tmp.join("ok.py"), "def bar():\n    pass\n").unwrap();

        let result = analyze_project(&tmp);
        // 不应崩溃；应至少解析有效的文件
        assert!(result.files_parsed >= 1);

        let _ = fs::remove_dir_all(&tmp);
    }
}
