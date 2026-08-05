// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Vue 动态分派合成 — 事件绑定、composables、Vuex、Pinia。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Edge, EdgeKind, Graph, NodeKind};

type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

pub fn synthesize_vue_edges(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy().replace('\\', "/");
        let lower = s.to_lowercase();
        if lower.ends_with(".vue") || lower.ends_with(".js") || lower.ends_with(".ts") {
            files.insert(s);
        }
    }

    for file in &files {
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };

        let source_opt = parse_cache.get(&abs_key).map(|(src, _)| src.clone())
            .or_else(|| std::fs::read_to_string(project_root.join(file)).ok());

        let Some(source) = source_opt else { continue };

        if source.contains('@') || source.contains("v-on:") {
            added += synthesize_vue_handlers(graph, file, &source);
        }
        if source.contains("= use") {
            added += synthesize_vue_composables(graph, file, &source);
        }
        if source.contains("dispatch(") {
            added += synthesize_vuex_dispatch(graph, file, &source);
        }
        if source.contains("useStore") || source.contains("defineStore(") {
            added += synthesize_pinia(graph, file, &source);
        }
    }

    added
}

fn synthesize_vue_handlers(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    let re = regex::Regex::new(r#"(?:@|v-on:)[a-zA-Z][\w-]*(?:\.[\w]+)*\s*=\s*"([^"]+)""#).unwrap();
    let node_ids: Vec<String> = graph.node_ids().map(str::to_string).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let caller = find_first_in_file(graph, file);

    for caps in re.captures_iter(source) {
        if added >= 30 { break; }
        let handler_expr = caps.get(1).unwrap().as_str().to_string();
        let fn_name = handler_expr.split('(').next().unwrap_or(&handler_expr).trim().to_string();
        if fn_name.is_empty() || seen.contains(&fn_name) { continue; }
        seen.insert(fn_name.clone());

        for nid in &node_ids {
            if let Some(node) = graph.get_node(nid) {
                if node.name == fn_name && matches!(node.kind, NodeKind::Function) {
                    if let Some(ref caller_id) = caller {
                        graph.add_edge_unchecked(Edge::synthesized(
                            format!("vue_handler_{}_{}", caller_id, nid),
                            caller_id, nid, EdgeKind::Calls, "vue-handler",
                        ));
                        added += 1;
                    }
                    break;
                }
            }
        }
    }

    added
}

fn synthesize_vue_composables(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    let re = regex::Regex::new(r#"(?:const|let|var)\s*\{[^}]+\}\s*=\s*(\w+)\s*\("#).unwrap();
    let node_ids: Vec<String> = graph.node_ids().map(str::to_string).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let caller = find_first_in_file(graph, file);

    for caps in re.captures_iter(source) {
        if added >= 20 { break; }
        let composable = caps.get(1).unwrap().as_str().to_string();
        if !composable.starts_with("use") || seen.contains(&composable) { continue; }
        seen.insert(composable.clone());

        for nid in &node_ids {
            if let Some(node) = graph.get_node(nid) {
                if node.name == composable && matches!(node.kind, NodeKind::Function) {
                    if let Some(ref caller_id) = caller {
                        graph.add_edge_unchecked(Edge::synthesized(
                            format!("vue_composable_{}_{}", caller_id, nid),
                            caller_id, nid, EdgeKind::Calls, "vue-composable",
                        ));
                        added += 1;
                    }
                    break;
                }
            }
        }
    }

    added
}

fn synthesize_vuex_dispatch(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    let re = regex::Regex::new(r#"dispatch\s*\(\s*['"]([^'"]+)['"]"#).unwrap();
    let node_ids: Vec<String> = graph.node_ids().map(str::to_string).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let caller = find_first_in_file(graph, file);

    for caps in re.captures_iter(source) {
        if added >= 120 { break; }
        let action = caps.get(1).unwrap().as_str().to_string();
        if seen.contains(&action) { continue; }
        seen.insert(action.clone());

        for nid in &node_ids {
            if let Some(node) = graph.get_node(nid) {
                if node.name == action && matches!(node.kind, NodeKind::Function) {
                    if let Some(ref caller_id) = caller {
                        graph.add_edge_unchecked(Edge::synthesized(
                            format!("vuex_{}_{}", caller_id, nid),
                            caller_id, nid, EdgeKind::Calls, "vuex-dispatch",
                        ));
                        added += 1;
                    }
                    break;
                }
            }
        }
    }

    added
}

fn synthesize_pinia(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    let re = regex::Regex::new(r#"defineStore\s*\(\s*['"]([^'"]+)['"]"#).unwrap();
    let node_ids: Vec<String> = graph.node_ids().map(str::to_string).collect();
    let caller = find_first_in_file(graph, file);

    for caps in re.captures_iter(source) {
        let store_name = caps.get(1).unwrap().as_str();
        let store_fn_name = format!("use{}Store",
            store_name.chars().enumerate()
                .map(|(i, c)| if i == 0 { c.to_ascii_uppercase() } else { c })
                .collect::<String>());

        for nid in &node_ids {
            if let Some(node) = graph.get_node(nid) {
                if node.name == store_fn_name && matches!(node.kind, NodeKind::Function) {
                    if let Some(ref caller_id) = caller {
                        graph.add_edge_unchecked(Edge::synthesized(
                            format!("pinia_{}_{}", caller_id, nid),
                            caller_id, nid, EdgeKind::Calls, "pinia-store",
                        ));
                        added += 1;
                    }
                    break;
                }
            }
        }
    }

    added
}

fn find_first_in_file(graph: &Graph, file: &str) -> Option<String> {
    for node in graph.nodes_iter().map(|(_, v)| v) {
        if matches!(node.kind, NodeKind::Function | NodeKind::Class | NodeKind::File) {
            if let Some(ref loc) = node.location {
                if loc.starts_with(file) {
                    return Some(node.id.clone());
                }
            }
        }
    }
    None
}
