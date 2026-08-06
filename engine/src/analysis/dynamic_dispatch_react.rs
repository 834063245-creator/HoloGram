// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! React 动态分派合成 — JSX、setState、Redux、RTK Query。
//! 这些模式填充静态分析无法解析的边，因为
//! React 使用运行时协调，而非静态调用表达式。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Edge, EdgeKind, Graph, NodeKind};

type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

/// 合成 React 特有的边。返回新增边的数量。
pub fn synthesize_react_edges(
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
        if lower.ends_with(".jsx") || lower.ends_with(".tsx") || lower.ends_with(".js") || lower.ends_with(".ts") {
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

        if source.contains('<') && source.contains('>') {
            added += synthesize_jsx_children(graph, file, &source);
        }
        if source.contains("setState(") || source.contains("useState(") || source.contains("useReducer(") {
            added += synthesize_setstate_render(graph, file, &source);
        }
        if source.contains("createAsyncThunk(") || source.contains("dispatch(") {
            added += synthesize_redux_thunk(graph, file, &source);
        }
        if source.contains("useGet") && source.contains("Query(") {
            added += synthesize_rtk_query(graph, file, &source);
        }
        // Channel E：Next.js 数据获取方法
        if source.contains("getServerSideProps") || source.contains("getStaticProps") || source.contains("getStaticPaths") {
            added += synthesize_nextjs_data_fetch(graph, file, &source);
        }
        // Channel F：Zustand store 创建 — 仅当 create( + zustand|set( 在同一行时
        if source.contains("create(") && (source.to_lowercase().contains("zustand") || source.contains("set(")) {
            added += synthesize_zustand_store(graph, file, &source);
        }
    }

    added
}

/// Channel A：JSX `<PascalCase ...>` → 组件函数/类。
fn synthesize_jsx_children(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    let re = regex::Regex::new(r"<\s*([A-Z][\w.]*)\b").unwrap();

    let parent_id = find_first_in_file(graph, file);
    if parent_id.is_none() { return 0; }
    let parent_id = parent_id.unwrap();

    let node_ids: Vec<String> = graph.node_ids().map(str::to_string).collect();
    let mut seen: HashSet<String> = HashSet::new();

    for caps in re.captures_iter(source) {
        if added >= 30 { break; }
        let tag = caps.get(1).unwrap().as_str().to_string();
        if seen.contains(&tag) { continue; }
        seen.insert(tag.clone());

        for nid in &node_ids {
            if let Some(node) = graph.get_node(nid) {
                if node.name == tag && matches!(node.kind, NodeKind::Function | NodeKind::Class) {
                    graph.add_edge_unchecked(Edge::synthesized(
                        format!("jsx_{}_{}", parent_id, nid),
                        &parent_id, nid, EdgeKind::Calls, "jsx-child",
                    ));
                    added += 1;
                    break;
                }
            }
        }
    }

    added
}

/// Channel B：setState / useState setter → 组件 render。
fn synthesize_setstate_render(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let render_id = {
        let mut rid = None;
        for node in graph.nodes_iter().map(|(_, v)| v) {
            if node.name == "render" && node.kind == NodeKind::Function {
                if let Some(ref loc) = node.location {
                    if loc.starts_with(file) { rid = Some(node.id.clone()); break; }
                }
            }
        }
        rid
    };

    let setter_id = find_first_in_file(graph, file);
    if let (Some(render_id), Some(setter_id)) = (render_id, setter_id) {
        if render_id != setter_id {
            graph.add_edge_unchecked(Edge::synthesized(
                format!("setstate_{}_{}", setter_id, render_id),
                &setter_id, render_id.as_str(), EdgeKind::Triggers, "react-render",
            ));
            added += 1;
        }
    }

    let _ = source; // 用于分析上下文
    added
}

/// Channel C：Redux thunk dispatch。
fn synthesize_redux_thunk(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    let re = regex::Regex::new(r"dispatch\s*\(\s*(\w+)\s*\(").unwrap();
    let node_ids: Vec<String> = graph.node_ids().map(str::to_string).collect();
    let mut seen: HashSet<String> = HashSet::new();

    let caller_id = find_first_in_file(graph, file);

    for caps in re.captures_iter(source) {
        if added >= 24 { break; }
        let action = caps.get(1).unwrap().as_str().to_string();
        if seen.contains(&action) { continue; }
        seen.insert(action.clone());

        for nid in &node_ids {
            if let Some(node) = graph.get_node(nid) {
                if node.name == action && matches!(node.kind, NodeKind::Function) {
                    if let Some(ref caller) = caller_id {
                        graph.add_edge_unchecked(Edge::synthesized(
                            format!("thunk_{}_{}", caller, nid),
                            caller, nid, EdgeKind::Calls, "redux-thunk",
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

/// Channel D：RTK Query hook → endpoint builder。
fn synthesize_rtk_query(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    let re = regex::Regex::new(r"\buse(?:Get|Post|Put|Delete|Patch)(\w+)(?:Query|Mutation)\b").unwrap();
    let node_ids: Vec<String> = graph.node_ids().map(str::to_string).collect();
    let mut seen: HashSet<String> = HashSet::new();

    let caller_id = find_first_in_file(graph, file);

    for caps in re.captures_iter(source) {
        if added >= 20 { break; }
        let endpoint = caps.get(1).unwrap().as_str().to_string();
        if seen.contains(&endpoint) { continue; }
        seen.insert(endpoint.clone());

        for nid in &node_ids {
            if let Some(node) = graph.get_node(nid) {
                if node.name.contains(&endpoint) && matches!(node.kind, NodeKind::Function) {
                    if let Some(ref caller) = caller_id {
                        graph.add_edge_unchecked(Edge::synthesized(
                            format!("rtkq_{}_{}", caller, nid),
                            caller, nid, EdgeKind::Calls, "rtk-query",
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

/// Channel E：Next.js 数据获取方法（`getServerSideProps`、`getStaticProps`、
/// `getStaticPaths`）。从页面 File 节点到每个函数创建 Calls 边。
fn synthesize_nextjs_data_fetch(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    let re = regex::Regex::new(r"\b(getServerSideProps|getStaticProps|getStaticPaths)\b").unwrap();

    let file_id = find_file_node(graph, file);
    if file_id.is_none() { return 0; }
    let file_id = file_id.unwrap();

    let node_ids: Vec<String> = graph.node_ids().map(str::to_string).collect();
    let mut seen: HashSet<String> = HashSet::new();

    for caps in re.captures_iter(source) {
        if added >= 30 { break; }
        let func_name = caps.get(1).unwrap().as_str().to_string();
        if seen.contains(&func_name) { continue; }
        seen.insert(func_name.clone());

        for nid in &node_ids {
            if let Some(node) = graph.get_node(nid) {
                if node.name == func_name && node.kind == NodeKind::Function {
                    if let Some(ref loc) = node.location {
                        if loc.starts_with(file) {
                            graph.add_edge_unchecked(Edge::synthesized(
                                format!("nextjs_{}_{}", file_id, nid),
                                &file_id, nid, EdgeKind::Calls, "nextjs-data-fetch",
                            ));
                            added += 1;
                            break;
                        }
                    }
                }
            }
        }
    }

    added
}

/// Channel F：Zustand store 创建（`create(` 调用）。通过要求同一行包含
/// `zustand` 或 `set(` 来与 `createSlice` / `Object.create` 消歧。
fn synthesize_zustand_store(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    let re = regex::Regex::new(r"\bcreate\s*\(").unwrap();

    let file_id = find_file_node(graph, file);
    if file_id.is_none() { return 0; }
    let file_id = file_id.unwrap();

    let node_ids: Vec<String> = graph.node_ids().map(str::to_string).collect();
    let mut seen_create_target: HashSet<String> = HashSet::new();

    for caps in re.captures_iter(source) {
        if added >= 20 { break; }
        let matched = caps.get(0).unwrap();
        let line_start = source[..matched.start()].rfind('\n').map_or(0, |i| i + 1);
        let line_end = source[matched.end()..].find('\n').map_or(source.len(), |i| matched.end() + i);
        let line = &source[line_start..line_end];

        // 消歧：同一行必须包含 zustand 或调用 set(
        if !line.to_lowercase().contains("zustand") && !line.contains("set(") {
            continue;
        }

        for nid in &node_ids {
            if let Some(node) = graph.get_node(nid) {
                if node.name == "create" && node.kind == NodeKind::Function {
                    if seen_create_target.contains(nid) { continue; }
                    seen_create_target.insert(nid.clone());
                    graph.add_edge_unchecked(Edge::synthesized(
                        format!("zustand_{}_{}", file_id, nid),
                        &file_id, nid, EdgeKind::Calls, "zustand-store",
                    ));
                    added += 1;
                    break;
                }
            }
        }
    }

    added
}

// ── 辅助函数 ──

/// 查找给定文件路径对应的 File 节点。
fn find_file_node(graph: &Graph, file: &str) -> Option<String> {
    for node in graph.nodes_iter().map(|(_, v)| v) {
        if node.kind == NodeKind::File {
            if let Some(ref loc) = node.location {
                if loc.starts_with(file) {
                    return Some(node.id.as_str().to_owned());
                }
            }
        }
    }
    None
}

fn find_first_in_file(graph: &Graph, file: &str) -> Option<String> {
    for node in graph.nodes_iter().map(|(_, v)| v) {
        if matches!(node.kind, NodeKind::Function | NodeKind::Class | NodeKind::File) {
            if let Some(ref loc) = node.location {
                if loc.starts_with(file) {
                    return Some(node.id.as_str().to_owned());
                }
            }
        }
    }
    None
}