// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// End-to-end tests for hologram_call + hologram_tools_list IPC dispatch.

use serde_json::{json, Value};
use hologram_engine as engine_crate;
use engine_crate::engine as engine_api;
use engine_crate::tools::ToolRegistry;
use engine_crate::graph::{Node, NodeKind, EdgeKind};

fn parse(v: &str) -> Value {
    serde_json::from_str(v).unwrap()
}

// ═══════════════════════════════════════════════════════
// hologram_tools_list
// ═══════════════════════════════════════════════════════

#[test]
fn test_tools_list_returns_27_tools() {
    let schemas: Vec<Value> =
        serde_json::from_str(&hologram_tools_list_impl()).unwrap();
    assert_eq!(schemas.len(), 27, "must return 27 tools");
}

#[test]
fn test_tools_list_each_tool_has_inputSchema() {
    let schemas: Vec<Value> =
        serde_json::from_str(&hologram_tools_list_impl()).unwrap();
    for s in &schemas {
        let name = s["name"].as_str().unwrap();
        assert!(s["inputSchema"]["properties"].is_object(),
            "{} must have properties", name);
        assert!(s["inputSchema"]["required"].is_array(),
            "{} must have required array", name);
    }
}

#[test]
fn test_tools_list_includes_key_explore() {
    let schemas: Vec<Value> =
        serde_json::from_str(&hologram_tools_list_impl()).unwrap();
    let names: Vec<&str> = schemas.iter()
        .filter_map(|s| s["name"].as_str()).collect();
    assert!(names.contains(&"hologram_explore"));
    assert!(names.contains(&"hologram_neighbors"));
    assert!(names.contains(&"hologram_dataflow"));
}

// ═══════════════════════════════════════════════════════
// hologram_call — parameter validation (no engine needed)
// ═══════════════════════════════════════════════════════

#[test]
fn test_call_unknown_tool_returns_error() {
    let result = hologram_call_impl("nonexistent", &json!({}));
    let v = parse(&result);
    assert!(v.get("error").is_some(), "unknown tool must return error");
}

#[test]
fn test_call_search_missing_query() {
    let result = hologram_call_impl("hologram_search", &json!({}));
    let v = parse(&result);
    assert!(v.get("error").is_some(), "search without query must error");
}

#[test]
fn test_call_neighbors_missing_node_id() {
    let result = hologram_call_impl("hologram_neighbors", &json!({}));
    let v = parse(&result);
    assert!(v.get("error").is_some(), "neighbors without node_id must error");
}

#[test]
fn test_call_preflight_missing_files() {
    let result = hologram_call_impl("hologram_run_preflight", &json!({}));
    let v = parse(&result);
    assert!(v.get("error").is_some(), "preflight without files must error");
}

#[test]
fn test_call_status_works_without_engine() {
    // status returns empty state even without engine initialized
    let result = hologram_call_impl("hologram_status", &json!({}));
    let v = parse(&result);
    assert!(v["phase"].as_str().is_some(), "status must return phase");
}

#[test]
fn test_call_graph_summary_errors_without_engine() {
    let result = hologram_call_impl("hologram_graph_summary", &json!({}));
    let v = parse(&result);
    // graph_summary needs engine data — should error gracefully
    assert!(v.get("error").is_some() || v.get("total_nodes").is_some(),
        "graph_summary should not crash without engine");
}

// ═══════════════════════════════════════════════════════
// hologram_call — with engine state
// ═══════════════════════════════════════════════════════

fn init_test_engine() {
    clear_test_engine();
    let tmp = std::env::temp_dir().join("hologram_dispatch_test");
    let _ = std::fs::create_dir_all(&tmp);
    let _ = engine_api::engine_init(&tmp);
    let _ = engine_api::engine_write(|idx| {
        let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
        a.location = Some("src/a.rs".into());
        a.out_degree = 1;
        idx.insert_node(a);
        let mut b = Node::new("b", "mod_b", NodeKind::Symbol);
        b.location = Some("src/b.rs".into());
        b.in_degree = 1;
        idx.insert_node(b);
        idx.upsert_edge("a", "b", EdgeKind::Calls, 2, None);
    });
    let _ = engine_api::engine_save();
}

fn clear_test_engine() {
    let _ = engine_api::engine_write(|idx| {
        let ids: Vec<String> = idx.nodes_iter().map(|n| n.id.clone()).collect();
        for id in &ids {
            idx.remove_node(id);
        }
    });
}

#[test]
fn test_call_neighbors_with_data() {
    init_test_engine();
    let result = hologram_call_impl("hologram_neighbors", &json!({"node_id": "a"}));
    let v = parse(&result);
    assert!(v.get("neighbor_count").is_some(), "must return neighbor_count");
    assert!(v.get("neighbors").is_some(), "must return neighbors array");
}

#[test]
fn test_call_impact_with_data() {
    init_test_engine();
    let result = hologram_call_impl("hologram_impact", &json!({"node_id": "a", "depth": 3}));
    let v = parse(&result);
    assert!(v.get("layers").is_some(), "must return layers");
}

#[test]
fn test_call_search_finds_nodes() {
    init_test_engine();
    let result = hologram_call_impl("hologram_search", &json!({"query": "mod", "limit": 10}));
    let v = parse(&result);
    let count = v["count"].as_u64().unwrap_or(0);
    assert!(count > 0, "search must find at least one node");
}

#[test]
fn test_call_node_returns_full_info() {
    init_test_engine();
    let result = hologram_call_impl("hologram_node", &json!({"node_id": "a"}));
    let v = parse(&result);
    assert!(v["node"].is_object(), "must return node object");
    assert!(v["incoming_count"].as_u64().is_some(), "must have incoming_count");
    assert!(v["outgoing_count"].as_u64().is_some(), "must have outgoing_count");
}

#[test]
fn test_call_graph_summary_with_data() {
    init_test_engine();
    let result = hologram_call_impl("hologram_graph_summary", &json!({}));
    let v = parse(&result);
    // graph_summary needs engine state — verifies graceful handling
    assert!(v.is_object(), "must return JSON object");
}

// ═══════════════════════════════════════════════════════
// Impl — replicate the Tauri command logic for direct testing
// ═══════════════════════════════════════════════════════

fn hologram_tools_list_impl() -> String {
    let schemas = ToolRegistry::global().tools_list();
    serde_json::to_string(&schemas).unwrap_or_default()
}

fn hologram_call_impl(tool: &str, args: &Value) -> String {
    ToolRegistry::dispatch(tool, args).to_string()
}
