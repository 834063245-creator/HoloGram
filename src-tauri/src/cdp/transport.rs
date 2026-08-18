// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! CDP 传输层：/json HTTP 端点 + 命令 WebSocket（短连接）。
//! 从 cdp.rs 拆出（第四批工程债）：只做「连上、发命令、收响应」，
//! 不持有会话状态；全链路超时仍由 WS_TIMEOUT 统一约束。

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use super::errors::{codes, err};

/// WS 命令全链路超时——connect/发送/等待响应任一步卡住都在此上限内返回错误。
pub(super) const WS_TIMEOUT: Duration = Duration::from_secs(10);

/// Chrome 调试 HTTP 端点：/json/new 用 PUT，返回 target JSON。
pub(super) fn http_new_tab(port: u16, url: &str) -> Result<Value, String> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("url", url)
        .finish();
    let endpoint = format!("http://127.0.0.1:{port}/json/new?{query}");
    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(Duration::from_secs(5)))
            .build(),
    );
    let resp = agent
        .put(&endpoint)
        .send_empty()
        .map_err(|e| err(codes::NETWORK, format!("CDP /json/new 请求失败: {e}")))?;
    let mut body = resp.into_body();
    let text = body
        .read_to_string()
        .map_err(|e| err(codes::NETWORK, format!("CDP /json/new 读取失败: {e}")))?;
    serde_json::from_str(&text).map_err(|e| err(codes::INTERNAL, format!("CDP /json/new 解析失败: {e}")))
}

/// Chrome 调试 HTTP 端点：/json/close/{targetId}，返回纯文本（非 JSON）。
pub(super) fn http_close_tab(port: u16, target_id: &str) -> Result<(), String> {
    let endpoint = format!("http://127.0.0.1:{port}/json/close/{target_id}");
    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(Duration::from_secs(5)))
            .build(),
    );
    let resp = agent
        .get(&endpoint)
        .call()
        .map_err(|e| err(codes::NETWORK, format!("CDP /json/close 请求失败: {e}")))?;
    if resp.status() != 200 {
        return Err(err(
            codes::NETWORK,
            format!("CDP /json/close 返回 HTTP {}", resp.status()),
        ));
    }
    Ok(())
}

/// GET http://127.0.0.1:port/json — 列出所有 target（原始 JSON）。
pub(super) fn list_targets_raw(port: u16) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{port}/json");
    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(Duration::from_secs(2)))
            .build(),
    );
    let resp = agent
        .get(&url)
        .call()
        .map_err(|e| err(codes::NETWORK, format!("CDP /json 请求失败: {e}")))?;
    let mut body = resp.into_body();
    let text = body
        .read_to_string()
        .map_err(|e| err(codes::NETWORK, format!("CDP /json 读取失败: {e}")))?;
    serde_json::from_str(&text).map_err(|e| err(codes::INTERNAL, format!("CDP /json 解析失败: {e}")))
}

/// 通过 CDP WebSocket 发送一条命令，返回响应 JSON（含 result）。
pub(super) async fn ws_command(
    port: u16,
    target_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let fut = async {
        let raw = list_targets_raw(port)?;
        let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
        let ws_url = arr
            .iter()
            .find(|t| t["id"].as_str() == Some(target_id))
            .and_then(|t| t["webSocketDebuggerUrl"].as_str().map(String::from))
            .ok_or_else(|| err(codes::TARGET_GONE, format!("target {target_id} 已消失（页面可能被关闭）")))?;

        let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| err(codes::NETWORK, format!("CDP WS 连接失败: {e}")))?;

        let id: u64 = 1;
        let msg = json!({ "id": id, "method": method, "params": params }).to_string();
        ws.send(Message::text(msg))
            .await
            .map_err(|e| err(codes::NETWORK, format!("CDP WS 发送失败: {e}")))?;

        loop {
            let reply = ws
                .next()
                .await
                .ok_or_else(|| err(codes::NETWORK, "CDP WS 连接关闭"))?
                .map_err(|e| err(codes::NETWORK, format!("CDP WS 接收失败: {e}")))?;
            match reply {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t)
                        .map_err(|e| err(codes::INTERNAL, format!("CDP 响应解析失败: {e}")))?;
                    if v["id"].as_u64() == Some(id) {
                        let _ = ws.close(None).await;
                        if let Some(cdp_err) = v["error"].as_object() {
                            return Err(err(
                                codes::INTERNAL,
                                format!(
                                    "CDP {} 错误: {}",
                                    method,
                                    cdp_err
                                        .get("message")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("unknown")
                                ),
                            ));
                        }
                        return Ok(v);
                    }
                }
                _ => {}
            }
        }
    };
    tokio::time::timeout(WS_TIMEOUT, fut)
        .await
        .map_err(|_| err(codes::TIMEOUT, format!("CDP {method} 超时（{WS_TIMEOUT:?} 无响应）——页面主线程可能卡死")))?
}

/// 在一条 WS 连接上批量发送命令并收集全部响应。
/// AX snapshot 需要给每个 backendNodeId 依次 resolveNode + callFunctionOn；
/// 逐条走 ws_command 会反复建连，80 个节点就是 160 次握手。这里一次建连、
/// 顺序发完、再按 id 收集，把 AX 路径的固定开销压到单次 WS 往返。
pub(super) async fn ws_command_batch(
    port: u16,
    target_id: &str,
    commands: Vec<(u64, String, Value)>,
) -> Result<HashMap<u64, Value>, String> {
    let expected = commands.len();
    if expected == 0 {
        return Ok(HashMap::new());
    }
    let fut = async {
        let raw = list_targets_raw(port)?;
        let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
        let ws_url = arr
            .iter()
            .find(|t| t["id"].as_str() == Some(target_id))
            .and_then(|t| t["webSocketDebuggerUrl"].as_str().map(String::from))
            .ok_or_else(|| err(codes::TARGET_GONE, format!("target {target_id} 已消失（页面可能被关闭）")))?;

        let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| err(codes::NETWORK, format!("CDP WS 连接失败: {e}")))?;
        for (id, method, params) in &commands {
            let msg = json!({ "id": id, "method": method, "params": params }).to_string();
            ws.send(Message::text(msg))
                .await
                .map_err(|e| err(codes::NETWORK, format!("CDP WS 批量发送失败: {e}")))?;
        }

        let mut replies: HashMap<u64, Value> = HashMap::new();
        while replies.len() < expected {
            let reply = ws
                .next()
                .await
                .ok_or_else(|| err(codes::NETWORK, "CDP WS 连接关闭"))?
                .map_err(|e| err(codes::NETWORK, format!("CDP WS 接收失败: {e}")))?;
            match reply {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t)
                        .map_err(|e| err(codes::INTERNAL, format!("CDP 响应解析失败: {e}")))?;
                    if let Some(id) = v["id"].as_u64() {
                        if commands.iter().any(|(cid, _, _)| *cid == id) {
                            replies.insert(id, v);
                        }
                    }
                }
                _ => {}
            }
        }
        let _ = ws.close(None).await;
        Ok::<HashMap<u64, Value>, String>(replies)
    };
    tokio::time::timeout(WS_TIMEOUT, fut)
        .await
        .map_err(|_| err(codes::TIMEOUT, "CDP 批量命令超时——页面主线程可能卡死".to_string()))?
}

/// 在一条 WS 连接上顺序执行命令：后一条命令的参数可以引用前一条的结果。
/// 每条命令由闭包构造：入参是上一条的完整响应（首条为 Value::Null），返回
/// (method, params)。
///
/// 为什么需要：CDP 的 DOM nodeId 是「会话（连接）本地」状态，跨连接必失效
/// （Chromium 报 "Could not find node with given id"）。getDocument →
/// querySelector → setFileInputFiles 这类依赖链必须同连接执行，不能逐条走
/// ws_command（每次新建连接）。backendNodeId 才是全局稳定的（AX 路径用后者）。
pub(super) async fn ws_command_seq(
    port: u16,
    target_id: &str,
    commands: Vec<Box<dyn Fn(&Value) -> (String, Value) + Send + Sync>>,
) -> Result<Vec<Value>, String> {
    if commands.is_empty() {
        return Ok(Vec::new());
    }
    let fut = async {
        let raw = list_targets_raw(port)?;
        let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
        let ws_url = arr
            .iter()
            .find(|t| t["id"].as_str() == Some(target_id))
            .and_then(|t| t["webSocketDebuggerUrl"].as_str().map(String::from))
            .ok_or_else(|| err(codes::TARGET_GONE, format!("target {target_id} 已消失（页面可能被关闭）")))?;

        let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| err(codes::NETWORK, format!("CDP WS 连接失败: {e}")))?;

        let mut prev = Value::Null;
        let mut results: Vec<Value> = Vec::with_capacity(commands.len());
        for (i, cmd) in commands.iter().enumerate() {
            let id = (i + 1) as u64;
            let (method, params) = cmd(&prev);
            let msg = json!({ "id": id, "method": method, "params": params }).to_string();
            ws.send(Message::text(msg))
                .await
                .map_err(|e| err(codes::NETWORK, format!("CDP WS 发送失败: {e}")))?;
            loop {
                let reply = ws
                    .next()
                    .await
                    .ok_or_else(|| err(codes::NETWORK, "CDP WS 连接关闭"))?
                    .map_err(|e| err(codes::NETWORK, format!("CDP WS 接收失败: {e}")))?;
                match reply {
                    Message::Text(t) => {
                        let v: Value = serde_json::from_str(&t)
                            .map_err(|e| err(codes::INTERNAL, format!("CDP 响应解析失败: {e}")))?;
                        if v["id"].as_u64() == Some(id) {
                            if let Some(cdp_err) = v["error"].as_object() {
                                let msg2 = cdp_err
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("unknown");
                                return Err(err(codes::INTERNAL, format!("CDP {method} 错误: {msg2}")));
                            }
                            prev = v.clone();
                            results.push(v);
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
        let _ = ws.close(None).await;
        Ok::<Vec<Value>, String>(results)
    };
    tokio::time::timeout(WS_TIMEOUT, fut)
        .await
        .map_err(|_| err(codes::TIMEOUT, "CDP 顺序命令超时——页面主线程可能卡死".to_string()))?
}
