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
fn test_tools_list_returns_tools() {
    let schemas: Vec<Value> =
        serde_json::from_str(&hologram_tools_list_impl()).unwrap();
    assert!(!schemas.is_empty(), "must return at least one tool");
}

#[test]
fn test_tools_list_each_tool_has_input_schema() {
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
    assert!(names.contains(&"explore_deps"), "must include explore_deps");
    assert!(names.contains(&"get_neighbors"), "must include get_neighbors");
    assert!(names.contains(&"trace_dataflow"), "must include trace_dataflow");
}

// ═══════════════════════════════════════════════════════
// hologram_call — parameter validation (no engine needed)
// ═══════════════════════════════════════════════════════

#[test]
fn test_call_unknown_tool_returns_error() {
    let result = hologram_call_impl("nonexistent", &json!({}));
    let v = parse(&result);
    assert!(is_errorish(&v), "unknown tool must return error/degraded");
}

#[test]
fn test_call_search_missing_query() {
    let result = hologram_call_impl("search_symbols", &json!({}));
    let v = parse(&result);
    assert!(is_errorish(&v), "search without query must error/degraded");
}

#[test]
fn test_call_neighbors_missing_node_id() {
    let result = hologram_call_impl("get_neighbors", &json!({}));
    let v = parse(&result);
    assert!(is_errorish(&v), "neighbors without node_id must error/degraded");
}

#[test]
fn test_call_preflight_missing_files() {
    let result = hologram_call_impl("preflight_check", &json!({}));
    let v = parse(&result);
    assert!(is_errorish(&v), "preflight without files must error/degraded");
}

#[test]
fn test_call_status_works_without_engine() {
    // status returns empty state even without engine initialized
    let result = hologram_call_impl("engine_status", &json!({}));
    let v = parse(&result);
    assert!(v["phase"].as_str().is_some(), "status must return phase");
}

#[test]
fn test_call_graph_summary_errors_without_engine() {
    let result = hologram_call_impl("graph_summary", &json!({}));
    let v = parse(&result);
    // graph_summary needs engine data — should error gracefully。
    // 成功载荷字段为 nodes_total（曾断言的 total_nodes 已改名）；
    // 测试并行共享引擎单例，兄弟用例可能已初始化引擎 → 两种形态都接受。
    assert!(v.get("error").is_some() || v.get("nodes_total").is_some(),
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
        // Node.id 现为 NodeId 句柄（Deref<Target=str>）—— 收集字符串供 remove_node(&str)
        let ids: Vec<String> = idx.nodes_iter().map(|n| n.id.as_str().to_string()).collect();
        for id in &ids {
            idx.remove_node(id);
        }
    });
}

#[test]
fn test_call_neighbors_with_data() {
    init_test_engine();
    let result = hologram_call_impl("get_neighbors", &json!({"nodeId": "a"}));
    let v = parse(&result);
    assert!(v.get("neighbor_count").is_some(), "must return neighbor_count");
    assert!(v.get("neighbors").is_some(), "must return neighbors array");
}

#[test]
fn test_call_impact_with_data() {
    init_test_engine();
    let result = hologram_call_impl("trace_impact", &json!({"nodeId": "a", "depth": 3}));
    let v = parse(&result);
    assert!(v.get("layers").is_some(), "must return layers");
}

#[test]
fn test_call_search_finds_nodes() {
    init_test_engine();
    let result = hologram_call_impl("search_symbols", &json!({"query": "mod", "limit": 10}));
    let v = parse(&result);
    let count = v["count"].as_u64().unwrap_or(0);
    assert!(count > 0, "search must find at least one node");
}

#[test]
fn test_call_node_returns_full_info() {
    init_test_engine();
    let result = hologram_call_impl("inspect_symbol", &json!({"nodeId": "a"}));
    let v = parse(&result);
    assert!(v["node"].is_object(), "must return node object");
    assert!(v["incoming_count"].as_u64().is_some(), "must have incoming_count");
    assert!(v["outgoing_count"].as_u64().is_some(), "must have outgoing_count");
}

#[test]
fn test_call_graph_summary_with_data() {
    init_test_engine();
    let result = hologram_call_impl("graph_summary", &json!({}));
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

/// 与 src-tauri engine_dispatch::dispatch_engine 同构的信封解包：
/// ToolResponse 迁移后 dispatch() 返回 MCP JSON-RPC 信封
/// {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"<原始工具JSON>"}]}}，
/// 断言针对的是信封内的原始载荷；JSON-RPC error 统一折叠为 {"error": ...}。
fn hologram_call_impl(tool: &str, args: &Value) -> String {
    let result = ToolRegistry::dispatch(tool, args, &Value::Null);
    if let Some(text) = result
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("text"))
        .and_then(|t| t.as_str())
    {
        return text.to_string();
    }
    if let Some(err) = result.get("error") {
        return json!({ "error": err }).to_string();
    }
    String::new()
}

/// 现代错误表面：处理器级 {"error": ...}（旧）或 ToolResponse::Degraded 的
/// _isDegraded 标记（新，dispatch 层注入 _guidance/_fallback）。
fn is_errorish(v: &Value) -> bool {
    v.get("error").is_some()
        || v.get("_isDegraded").and_then(|b| b.as_bool()).unwrap_or(false)
}