// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 过期警告横幅 —— 当工具响应引用了自上次索引同步后已编辑的文件时，
//! 向 Agent 发出警告。另含增量漂移治理（P1-4）：图自上次全量分析以来
//! 经历增量更新后，社区/聚类结果是近似的，工具响应带近似性横幅。

use serde_json::Value;

use crate::engine;

/// 当前增量漂移计数（自上次全量分析以来的增量更新次数）。
/// 引擎未初始化时按 0 处理。
pub fn incremental_drift() -> u64 {
    engine::with_engine(|eng| eng.incremental_since_full()).unwrap_or(0)
}

/// 派生结果近似性横幅（P1-4）：图经过增量更新后，全局聚类只对
/// 新节点做邻居投票、旧分组可能漂移 —— 社区/聚类工具的结果
/// 必须带近似标注，不能静默冒充精确。
pub fn check_derived_staleness(tool_name: &str) -> Option<String> {
    derived_banner_for(tool_name, incremental_drift())
}

/// 纯函数版本（可单测）：drift == 0 → None；
/// 社区/聚类工具在 drift > 0 时返回近似性横幅。
pub(crate) fn derived_banner_for(tool_name: &str, drift: u64) -> Option<String> {
    if drift == 0 {
        return None;
    }
    if !matches!(tool_name, "get_community" | "cluster_report") {
        return None;
    }
    Some(format!(
        "⚠️ 图自上次全量分析以来经历了 {} 次增量更新：社区/聚类结果是近似的 \
         （新增节点按邻居投票分配，全局聚类未重跑，旧分组可能已漂移）。\
         如需精确的社区结构，请运行全量重分析。",
        drift
    ))
}

/// SCIP 边过期横幅（P1-1/P1-4 新鲜度治理）：SCIP 边来自静态索引，
/// 导入后任何增量更新都让它可能过期 —— 相关工具结果带提示，
/// 不静默冒充新鲜。drift <= base → None（未过期）；非图导航工具不打扰。
pub fn check_scip_staleness(tool_name: &str) -> Option<String> {
    let (drift, base) = engine::with_engine(|eng| eng.scip_staleness()).flatten()?;
    scip_banner_for(tool_name, drift, base)
}

/// 纯函数版本（可单测）。
pub(crate) fn scip_banner_for(tool_name: &str, drift: u64, base: u64) -> Option<String> {
    if drift <= base {
        return None;
    }
    let scoped = matches!(
        tool_name,
        "search_symbols"
            | "get_neighbors"
            | "inspect_symbol"
            | "trace_impact"
            | "coupling_report"
            | "trace_dataflow"
            | "graph_summary"
            | "find_references"
            | "find_unused"
            | "preflight_check"
            | "detect_cycles"
            | "fragile_modules"
            | "explore_deps"
            | "find_dep_path"
            | "async_edges"
    );
    if !scoped {
        return None;
    }
    Some(format!(
        "⚠️ SCIP 桥接边可能过期：导入后经历了 {} 次增量更新（导入时漂移基 {}）。\
         SCIP 边来自静态索引，不随增量刷新 —— 如需精确，请重新生成 index.scip 并运行 import_scip。",
        drift.saturating_sub(base),
        base
    ))
}

/// 检查结果是否引用了待同步文件，并渲染警告横幅。
pub fn check_staleness(result: &Value) -> Option<String> {
    let pending = engine::with_engine(|eng| eng.get_pending_files()).unwrap_or_default();
    if pending.is_empty() {
        return None;
    }

    // 收集结果中引用的文件路径（启发式：sourceCode 部分）
    let mut referenced: Vec<String> = Vec::new();
    collect_file_paths(result, &mut referenced);

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut referenced_pending: Vec<String> = Vec::new();
    let mut other_count = 0usize;

    for (path, ts_ms, indexing) in &pending {
        let age = now_ms.saturating_sub(*ts_ms);
        let status = if *indexing { "索引中" } else { "待同步" };
        let matched = referenced.iter().any(|r| path.contains(r.as_str()) || r.contains(path.as_str()));
        if matched {
            referenced_pending.push(format!("  - {} (edited {}ms ago, {})", path, age, status));
        } else {
            other_count += 1;
        }
    }

    if referenced_pending.is_empty() && other_count == 0 {
        return None;
    }

    let mut banner = String::new();
    if !referenced_pending.is_empty() {
        banner.push_str(&format!(
            "⚠️ 以下引用的文件自上次索引同步后已被编辑：\n{}\n\
             如需准确内容，请直接读取这些文件。\n",
            referenced_pending.join("\n")
        ));
    }
    if other_count > 0 {
        banner.push_str(&format!(
            "（另有 {} 个其他文件也待同步，但未在此处引用。）",
            other_count
        ));
    }

    Some(banner)
}

fn collect_file_paths(value: &Value, paths: &mut Vec<String>) {
    match value {
        Value::Object(obj) => {
            for (k, v) in obj {
                if k == "file" || k == "location" {
                    if let Some(s) = v.as_str() {
                        paths.push(s.to_string());
                    }
                }
                collect_file_paths(v, paths);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_file_paths(v, paths);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derived_banner_no_drift_is_none() {
        assert!(derived_banner_for("get_community", 0).is_none());
        assert!(derived_banner_for("cluster_report", 0).is_none());
    }

    #[test]
    fn test_derived_banner_community_tools_with_drift() {
        for tool in ["get_community", "cluster_report"] {
            let banner = derived_banner_for(tool, 3).expect("community tool with drift must be marked");
            assert!(banner.contains("3"), "banner should name the drift count: {}", banner);
            assert!(banner.contains("近似"), "banner should say results are approximate: {}", banner);
            assert!(banner.contains("全量重分析"), "banner should point at the recompute path: {}", banner);
        }
    }

    #[test]
    fn test_derived_banner_other_tools_unaffected() {
        // 耦合深度在增量后已全量重算，不需要近似标注；
        // 其余图查询工具读的是新鲜边结构。
        assert!(derived_banner_for("coupling_report", 3).is_none());
        assert!(derived_banner_for("get_neighbors", 3).is_none());
        assert!(derived_banner_for("graph_summary", 3).is_none());
    }

    #[test]
    fn test_scip_banner_stale_only_after_import_drift() {
        // 未过期（drift == base）→ 不提示
        assert!(scip_banner_for("get_neighbors", 5, 5).is_none());
        assert!(scip_banner_for("get_neighbors", 3, 5).is_none());
        // 导入后发生增量 → 图导航工具带提示
        let b = scip_banner_for("get_neighbors", 7, 5).expect("stale scip must warn");
        assert!(b.contains("2"), "banner 应写清漂移差: {}", b);
        assert!(b.contains("import_scip"), "banner 应指向重导入路径: {}", b);
        // 非图导航工具不打扰
        assert!(scip_banner_for("analyze_project", 7, 5).is_none());
        assert!(scip_banner_for("engine_status", 7, 5).is_none());
    }
}
