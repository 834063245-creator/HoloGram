// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! ToolResponse — 三态工具响应模型。
//!
//! 替代所有 30 个处理器中的 json!({"error": "..."}) 反模式。
//! Agent 研究表明 JSON-RPC isError 在 1-2 次失败后会降低工具采用率。
//! 降级响应让 Agent 能自我恢复。

use serde_json::{json, Value};

/// 所有 hologram_* 工具处理器的三态响应。
#[allow(dead_code)]
#[derive(Debug)]
pub enum ToolResponse {
    /// 正常成功 —— 返回完整数据。
    Success(Value),
    /// 可恢复失败 —— 引导 + 回退建议，不是 MCP 错误。
    Degraded {
        guidance: String,
        fallback: String,
        details: Value,
    },
    /// 安全拒绝 —— Agent 不得重试。
    Refused {
        reason: String,
    },
    /// 真正故障 —— 重试一次，然后放弃此工具继续。
    Fault {
        message: String,
        retry: bool,
    },
}

impl ToolResponse {
    /// 将后续工具建议附加到 Success 和 Degraded 响应。
    /// Fault/Refused 直接透传不变。
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

    /// 转换为 JSON-RPC result 或 error Value。
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

// ── JSON-RPC 辅助函数（与 McpServer 同构）──

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
