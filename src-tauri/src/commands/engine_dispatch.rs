// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Engine tool dispatch — hologram_call + hologram_tools_list.

use serde_json;
use hologram_engine::tools::ToolRegistry;

#[tauri::command]
pub(crate) fn hologram_call(tool: String, mut args: serde_json::Value, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    if tool == "validate_project" {
        let changed_files: Vec<String> = state.lock().unwrap().as_ref()
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
    Ok(ToolRegistry::dispatch(&tool, &args).to_string())
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
        for tool in &tools {
            let name = tool["name"].as_str().unwrap();
            let result = ToolRegistry::dispatch(name, &serde_json::json!({}));
            if let Some(err) = result.get("error").and_then(|e| e.as_str()) {
                if err.starts_with("Tool not found") {
                    panic!(
                        "Tool '{name}' not found in ToolRegistry::dispatch — did you add it to the match block?"
                    );
                }
            }
        }
    }
}
