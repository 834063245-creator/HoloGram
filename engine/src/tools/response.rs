// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! ToolResponse — three-state tool response model.
//!
//! Replaces the json!({"error": "..."}) anti-pattern in all 30 handlers.
//! Agent studies show that JSON-RPC isError kills tool adoption after 1-2 failures.
//! Degraded responses let the Agent self-recover.

use serde_json::{json, Value};

/// Three-state response for all hologram_* tool handlers.
#[allow(dead_code)]
#[derive(Debug)]
pub enum ToolResponse {
    /// Normal success — full data returned.
    Success(Value),
    /// Recoverable failure — guidance + fallback, not an MCP error.
    Degraded {
        guidance: String,
        fallback: String,
        details: Value,
    },
    /// Security refusal — the Agent must not retry.
    Refused {
        reason: String,
    },
    /// Genuine fault — retry once, then continue without this tool.
    Fault {
        message: String,
        retry: bool,
    },
}

impl ToolResponse {
    /// Attach next-tool suggestions to Success and Degraded responses.
    /// Fault/Refused pass through unchanged.
    pub fn with_suggestions(self, suggestions: &[&'static str]) -> Self {
        match self {
            Self::Success(mut data) => {
                if let Some(obj) = data.as_object_mut() {
                    obj.insert("next_tool_suggestions".into(), json!(suggestions));
                }
                Self::Success(data)
            }
            Self::Degraded { guidance, fallback, mut details } => {
                if let Some(obj) = details.as_object_mut() {
                    obj.insert("next_tool_suggestions".into(), json!(suggestions));
                }
                Self::Degraded { guidance, fallback, details }
            }
            other => other,
        }
    }

    /// Convert to a JSON-RPC result or error Value.
    pub fn to_mcp_value(&self, id: &Value) -> Value {
        match self {
            Self::Success(data) => tool_result(id, data.clone()),
            Self::Degraded { guidance, fallback, details } => {
                let mut d = details.clone();
                if let Some(obj) = d.as_object_mut() {
                    obj.insert("_guidance".into(), json!(guidance));
                    obj.insert("_fallback".into(), json!(fallback));
                    obj.insert("_isDegraded".into(), json!(true));
                }
                tool_result(id, d)
            }
            Self::Refused { reason } => {
                error_response(id, -32000, &format!("Security refusal: {}", reason))
            }
            Self::Fault { message, retry } => {
                let msg = if *retry {
                    format!("{} — retry once, then continue without this tool", message)
                } else {
                    message.clone()
                };
                error_response(id, -32603, &msg)
            }
        }
    }
}

// ── JSON-RPC helpers (same shape as McpServer) ──

fn success_response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: &Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_result(id: &Value, data: Value) -> Value {
    let text = serde_json::to_string(&data).unwrap_or_default();
    success_response(id, json!({
        "content": [{ "type": "text", "text": text }],
        "_meta": {
            "generator": "HoloGram v4.0",
            "license": "MIT",
            "copyright": "Copyright (c) 2026 Wenbing Jing"
        }
    }))
}
