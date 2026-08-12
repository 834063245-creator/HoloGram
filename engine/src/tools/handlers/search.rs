use serde_json::{json, Value};
use crate::analysis::*;
use crate::engine;
use crate::graph::query;
use crate::tools::{get_usize, project_root};
use crate::tools::with_graph;
use crate::tools::node_to_value;
use crate::tools::ToolResponse;

pub(crate) fn handler_search(args: &Value) -> ToolResponse {
    let query_str = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let limit = get_usize(args, "limit", 20);
    if query_str.is_empty() {
        return ToolResponse::Degraded {
            guidance: "query is required".into(),
            fallback: "Provide a search query string".into(),
            details: json!({}),
        };
    }
    // 1. FTS5 精确搜索
    if let Ok(results) = engine::engine_fts_search(query_str, limit) {
        if !results.is_empty() {
            let mut out = json!({
                "query": query_str,
                "count": results.len(),
                "results": results.iter().map(node_to_value).collect::<Vec<_>>(),
                "engine": "fts5",
            });
            // 如果可用，附加向量搜索结果
            merge_vector_hits(&mut out, query_str, limit);
            return ToolResponse::Success(out);
        }
    }
    // 2. 线性模糊回退
    let mut out = with_graph(|g| {
        let results = query::search_nodes(g, query_str);
        let count = results.len().min(limit);
        json!({
            "query": query_str,
            "count": count,
            "results": results.iter().take(limit).map(|n| node_to_value(n)).collect::<Vec<_>>(),
            "engine": "linear",
        })
    });
    // 附加向量搜索结果
    merge_vector_hits(&mut out, query_str, limit);
    ToolResponse::Success(out)
}

/// 将向量（语义）搜索结果附加到输出（如果可用）。
/// ponytail：即发即忘 —— 如果向量索引未构建，静默跳过。
/// 过滤策略：低于后端阈值丢弃、与主结果去重、最多 5 条。
/// （HNSW 永远返回 top-k 个最近邻，不过滤会把无关噪音塞给 Agent。）
pub(crate) fn merge_vector_hits(out: &mut Value, query: &str, limit: usize) {
    let root = project_root();
    if root.as_os_str().is_empty() { return; }
    // 使用缓存的索引 —— 避免每次搜索都从磁盘重新加载 40+ MB
    let (index, slots) = match crate::vector::get_or_load_index(&root) {
        Ok(pair) => pair,
        Err(_) => return,
    };
    let idx = index.read().unwrap_or_else(|e| e.into_inner());
    let idx = match idx.as_ref() {
        Some(i) => i,
        None => return,
    };
    let slot_data = slots.read().unwrap_or_else(|e| e.into_inner());
    if slot_data.is_empty() { return; }

    let q_vec = crate::vector::embed(query);
    // 多取候选：阈值过滤与去重会淘汰一部分
    let fetch = (limit * 2).max(20);
    let results = match idx.search(&q_vec, fetch) {
        Ok(r) => r,
        Err(_) => return,
    };

    let threshold = crate::vector::score_threshold();
    let max_hits = 5usize.min(limit.max(1));

    // 与主结果集去重（FTS/linear 已覆盖的节点不再重复出现）
    let existing: std::collections::HashSet<&str> = out["results"].as_array()
        .map(|a| a.iter().filter_map(|v| v["id"].as_str()).collect())
        .unwrap_or_default();

    // usearch 按距离升序返回 → 相似度降序
    let raw: Vec<(String, f32)> = results.keys.iter().zip(results.distances.iter())
        .filter_map(|(slot_key, distance)| {
            let slot = *slot_key as usize;
            if slot >= slot_data.len() { return None; }
            let similarity = 1.0 - (*distance).min(2.0).max(0.0);
            Some((slot_data[slot].clone(), similarity))
        })
        .collect();
    let hits = crate::vector::filter_hits(&raw, threshold, max_hits, &existing);
    if hits.is_empty() { return; }

    let top = &hits[0];
    tracing::info!(
        "[vector] {} hits for \"{}\" — top: {} ({:.0}%)",
        hits.len(), query, top.0, top.1 * 100.0
    );
    let vec_results: Vec<Value> = hits.into_iter()
        .map(|(node_id, score)| json!({"node_id": node_id, "vector_score": (score * 100.0).round() as u32}))
        .collect();
    let count = vec_results.len();
    out["vector_hits"] = json!(vec_results);
    out["vector_backend"] = json!(crate::vector::backend_id());
    if let Some(obj) = out.as_object_mut() {
        // 不计入 count —— vector_hits 是独立字段。
        // count 仅反映主（FTS5/linear）结果集。
        obj.insert("vector_count".into(), json!(count));
    }
}

pub(crate) fn handler_explore(args: &Value) -> ToolResponse {
    let symbols: Vec<String> = args
        .get("symbols")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let query_str = args.get("query").and_then(|v| v.as_str()).map(|s| s.to_string());
    if symbols.is_empty() && query_str.is_none() {
        return ToolResponse::Degraded {
            guidance: "symbols array or query string is required".into(),
            fallback: "Provide either a list of symbols or a natural language query".into(),
            details: json!({}),
        };
    }
    let include_source = args.get("includeSource").and_then(|v| v.as_bool()).unwrap_or(true);
    let root = project_root();
    ToolResponse::Success(with_graph(|g| {
        let mut out = explore(g, &root, &symbols, query_str.as_deref(), include_source);
        // 语义召回附加（仅 NL query 场景）：parse_nl_query 是名称匹配，
        // 词汇不匹配的查询（如 "memory management"）由向量命中补齐。
        // 与 search_symbols 共用 merge_vector_hits：即发即忘，无索引静默跳过。
        if let Some(q) = query_str.as_deref() {
            if !q.trim().is_empty() {
                merge_vector_hits(&mut out, q, 5);
            }
        }
        out
    }))
}


