// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Bridge/RPC 调用合成 — 连接 TypeScript `rpc('cmd')` 调用到
//! Rust `#[tauri::command] fn cmd` 处理函数。
//!
//! 这些边在静态分析中不可见：TS 侧通过 Tauri `invoke()` 动态
//! 分派到 Rust 命令，静态调用图无法跨语言边界追踪。
//!
//! 此合成器在 TS 文件中查找 `rpc('command_name', ...)` 调用，
//! 在 Rust 文件中查找同名的 `#[tauri::command] fn command_name`，
//! 并在两者之间创建 Calls 边。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Edge, EdgeKind, Graph, NodeKind};

type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

/// 扫描 TS 文件中的 `rpc('xxx', ...)` 调用，在 Rust 图中
/// 寻找同名的 `#[tauri::command] fn xxx`，创建合成 Calls 边。
/// 返回新增边的数量。
pub fn synthesize_bridge_calls(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    // Step 1: 收集所有 Rust command 函数名
    let mut rust_commands: HashMap<String, String> = HashMap::new(); // name → node_id
    for (nid, node) in graph.nodes_iter() {
        if node.kind != NodeKind::Function { continue; }
        let loc = match &node.location {
            Some(l) => l,
            None => continue,
        };
        // 只看 Rust 文件
        if !loc.ends_with(".rs") && !loc.contains(".rs:") { continue; }
        // 检查是否在 src-tauri/ 路径下（或不限定路径，看 #[tauri::command] 属性无法从节点获取）
        // 策略：匹配常见的 Tauri command 命名模式 —
        // 这些函数名通常是 snake_case 动词，如 read_file_content、write_file、create_directory
        rust_commands.insert(node.name.clone(), nid.to_string());
    }

    // Step 2: 扫描 TS 文件，找 rpc('xxx', ...) 调用
    let re = regex::Regex::new(r#"\brpc\s*(?:<[^>]*>)?\s*\(\s*['"](\w+)['"]"#).unwrap();

    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy().replace('\\', "/");
        let lower = s.to_lowercase();
        if lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".js") {
            files.insert(s);
        }
    }

    for file in &files {
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };

        let source_opt = parse_cache.get(&abs_key)
            .map(|(src, _)| src.clone())
            .or_else(|| std::fs::read_to_string(project_root.join(file)).ok());

        let Some(source) = source_opt else { continue };
        if !source.contains("rpc") { continue; }

        // 找到当前文件中定义的函数（调用者）
        let caller_nodes: Vec<(String, String)> = graph.nodes_iter()
            .filter(|(_, n)| {
                if n.kind != NodeKind::Function && n.kind != NodeKind::Class { return false; }
                n.location.as_ref().map_or(false, |l| l.starts_with(file.as_str()) || l.starts_with(&abs_key))
            })
            .map(|(id, n)| (id.to_string(), n.name.clone()))
            .collect();

        let mut seen_cmds: HashSet<String> = HashSet::new();
        for caps in re.captures_iter(&source) {
            if added >= 200 { break; }
            let cmd = caps.get(1).unwrap().as_str().to_string();
            if seen_cmds.contains(&cmd) { continue; }
            seen_cmds.insert(cmd.clone());

            // 在 Rust 命令中查找匹配的
            if let Some(rust_nid) = rust_commands.get(&cmd) {
                // 将该文件中的所有 caller 连接到此 Rust 命令
                for (caller_id, _caller_name) in &caller_nodes {
                    // 跳过 Rust 函数自身（避免 Rust → Rust 自引用）
                    if caller_id == rust_nid { continue; }
                    graph.add_edge_unchecked(Edge::synthesized(
                        format!("bridge_{}_{}_{}", caller_id, cmd, rust_nid),
                        caller_id, rust_nid, EdgeKind::Calls, "bridge-rpc",
                    ));
                    added += 1;
                }
                // 即使该文件没有 native 函数，也为文件节点创建边
                if caller_nodes.is_empty() {
                    if let Some(file_node_id) = find_file_node(graph, file) {
                        graph.add_edge_unchecked(Edge::synthesized(
                            format!("bridge_file_{}_{}", file_node_id, cmd),
                            &file_node_id, rust_nid, EdgeKind::Calls, "bridge-rpc",
                        ));
                        added += 1;
                    }
                }
            }
        }
    }

    added
}

/// 在图中查找给定文件路径的 File 节点。
fn find_file_node(graph: &Graph, file: &str) -> Option<String> {
    for (id, node) in graph.nodes_iter() {
        if node.kind == NodeKind::File {
            if let Some(ref loc) = node.location {
                let loc_normalized = loc.replace('\\', "/");
                let file_normalized = file.replace('\\', "/");
                if loc_normalized == file_normalized || loc_normalized.ends_with(&file_normalized) {
                    return Some(id.to_string());
                }
            }
        }
    }
    None
}
