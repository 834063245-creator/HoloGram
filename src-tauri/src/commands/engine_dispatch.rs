// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 引擎工具分发 — hologram_call + hologram_tools_list。

use serde_json;
use hologram_engine::tools::ToolRegistry;

/// 引擎调用的同步核心 —— 大图上单次 dispatch 可达秒级，
/// 必须经 spawn_blocking 调用，绝不能在 async worker 上内联执行
/// （见 docs/adr/project-constitution.md 异步纪律）。
fn dispatch_engine(tool: &str, args: &serde_json::Value) -> Result<String, String> {
    let dummy_id = serde_json::json!(null);
    let result = ToolRegistry::dispatch(tool, args, &dummy_id);
    // 解包 MCP JSON-RPC 信封 → 返回原始工具输出文本。
    // ToolResponse 迁移后，dispatch() 将所有内容包装在
    // {"jsonrpc":"2.0","id":...,"result":{"content":[{"type":"text","text":"..."}]}} 中。
    // 所有 Tauri 调用者（timeline、check、dataflow、graph-partitioner、Agent）
    // 期望原始工具 JSON，而非信封。
    let text = result
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    if text.is_empty() {
        // 回退：可能是 Degraded 响应或错误
        if let Some(err) = result.get("error") {
            return Err(format!("Engine error: {:?}", err));
        }
        return Err("Engine returned empty result".to_string());
    }
    Ok(text.to_string())
}

#[tauri::command]
pub(crate) async fn hologram_call(tool: String, mut args: serde_json::Value, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    if tool == "validate_project" {
        let changed_files: Vec<String> = crate::utils::lock_or_recover(&state).as_ref()
            .and_then(|h| {
                let mut files = h.changed_files.lock().ok()?;
                let snapshot = files.clone();
                files.clear();
                Some(snapshot)
            })
            .unwrap_or_default();
        if let serde_json::Value::Object(ref mut map) = args {
            map.insert("changed_files".to_string(), serde_json::json!(changed_files));
        }
    }
    tokio::task::spawn_blocking(move || dispatch_engine(&tool, &args))
        .await
        .map_err(|e| format!("引擎调用任务失败: {e}"))?
}

#[tauri::command]
pub(crate) fn hologram_tools_list() -> Result<String, String> {
    let schemas = ToolRegistry::global().tools_list();
    Ok(serde_json::to_string(&schemas).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hologram_tools_list_returns_tools() {
        let raw = hologram_tools_list().expect("hologram_tools_list should succeed");
        let tools: Vec<serde_json::Value> = serde_json::from_str(&raw).expect("should parse");
        assert!(!tools.is_empty(), "must return at least one hologram tool");
        for tool in &tools {
            let name = tool["name"].as_str().expect("every tool must have a name");
            assert!(!name.is_empty(), "every tool must have a non-empty name");
            assert!(
                tool["inputSchema"].is_object(),
                "tool '{name}' must have an inputSchema"
            );
        }
    }

    #[test]
    fn hologram_call_dispatches_all_tools_no_not_found() {
        let raw = hologram_tools_list().expect("hologram_tools_list should succeed");
        let tools: Vec<serde_json::Value> = serde_json::from_str(&raw).expect("should parse");
        let dummy_id = serde_json::json!(null);
        for tool in &tools {
            let name = tool["name"].as_str().unwrap();
            let result = ToolRegistry::dispatch(name, &serde_json::json!({}), &dummy_id);
            // ToolResponse 迁移后，未知工具返回 Degraded（带 _isDegraded 的成功响应）
            if let Some(err) = result.get("error").and_then(|e| e.as_str()) {
                if err.starts_with("Tool not found") {
                    panic!(
                        "Tool '{name}' not found in ToolRegistry::dispatch — did you add it to the match block?"
                    );
                }
            }
        }
    }

    /// 回归：引擎 dispatch 必须在 spawn_blocking 中运行（宪法·异步纪律）。
    /// 大图上单次 dispatch 秒级，内联在 async worker 上会饿死全部并发 IPC
    /// （含权限弹窗）——2026-08 雷区地图 P0-1。
    #[test]
    fn dispatch_engine_in_spawn_blocking_does_not_starve_runtime() {
        let raw = hologram_tools_list().expect("hologram_tools_list should succeed");
        let tools: Vec<serde_json::Value> = serde_json::from_str(&raw).expect("should parse");
        let any_tool = tools[0]["name"].as_str().unwrap().to_string();

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let heavy = tokio::task::spawn_blocking(move || {
                // Ok/Err 都是合法完成（空 args 对多数工具是参数错误）；
                // JoinError（panic）才是致命。
                dispatch_engine(&any_tool, &serde_json::json!({}))
            });
            let light = tokio::spawn(async { 42 });
            let (heavy, light) = tokio::join!(heavy, light);
            assert_eq!(light.unwrap(), 42, "轻量任务必须不被引擎 dispatch 饿死");
            let _ = heavy.unwrap();
        });
    }
}
