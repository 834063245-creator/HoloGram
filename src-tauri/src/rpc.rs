// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// RPC — 替代 89 个独立 #[tauri::command] 函数的单一 IPC 入口。
// 所有命令通过 invoke("rpc", {method, params}) 路由，而非
// 独立的 invoke("git_status", ...) 调用。
//
// ponytail: 一个 Tauri 命令，一个 match，一个维护面。
// 添加新命令 = 此处一个 match 分支 + 前端相同的 invoke("rpc",...)。
// 不再需要双端签名对齐。

use serde_json::Value;

// ── 参数辅助函数 ──

fn req_str(params: &Value, name: &str, method: &str) -> Result<String, String> {
    params.get(name)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("{method}: missing '{name}'"))
}
fn opt_str(params: &Value, name: &str) -> Option<String> {
    params.get(name).and_then(|v| v.as_str()).map(String::from)
}
fn opt_bool(params: &Value, name: &str) -> Option<bool> {
    params.get(name).and_then(|v| v.as_bool())
}
fn opt_i32(params: &Value, name: &str) -> Option<i32> {
    params.get(name).and_then(|v| v.as_i64()).map(|n| n as i32)
}
fn opt_u32(params: &Value, name: &str) -> Option<u32> {
    params.get(name).and_then(|v| v.as_u64()).map(|n| n as u32)
}
fn opt_u64(params: &Value, name: &str) -> Option<u64> {
    params.get(name).and_then(|v| v.as_u64())
}
fn opt_usize(params: &Value, name: &str) -> Option<usize> {
    params.get(name).and_then(|v| v.as_u64()).map(|n| n as usize)
}
/// browser 命令的 agent 路由：target=self 走自家 webview 只读会话，
/// 否则走各 Agent 自己的 CDP 会话（无 _agent_id 共用 default）。
fn self_or_agent(params: &Value) -> Option<String> {
    if opt_bool(params, "self").unwrap_or(false) {
        Some(crate::cdp::SELF_AGENT_ID.to_string())
    } else {
        opt_str(params, "_agent_id")
    }
}
fn req_strs(params: &Value, name: &str, method: &str) -> Result<Vec<String>, String> {
    params.get(name)
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .ok_or_else(|| format!("{method}: missing '{name}'"))
}
fn req_u16(params: &Value, name: &str, method: &str) -> Result<u16, String> {
    params.get(name).and_then(|v| v.as_u64()).map(|n| n as u16)
        .ok_or_else(|| format!("{method}: missing '{name}'"))
}

// ── 结果辅助函数（将类型化的 Ok 转换为 JSON 字符串）──

fn ok_json<T: serde::Serialize>(r: Result<T, String>) -> Result<String, String> {
    r.and_then(|v| serde_json::to_string(&v).map_err(|e| format!("rpc: serialize: {e}")))
}
fn ok_unit(r: Result<(), String>) -> Result<String, String> {
    r.map(|_| "null".into())
}

// ── 单一 RPC 命令 ──

#[tauri::command]
pub(crate) async fn rpc(
    method: String,
    params: Value,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use crate::commands;

    match method.as_str() {
        // ═══════════════════════════════════════════════════════
        // Engine 调度（tools.rs 重新导出）
        // ═══════════════════════════════════════════════════════
        "hologram_call" => {
            let tool = req_str(&params, "tool", "hologram_call")?;
            let args = params.get("args").cloned().unwrap_or(Value::Null);
            commands::engine_dispatch::hologram_call(tool, args, state).await
        }
        "hologram_tools_list" => commands::engine_dispatch::hologram_tools_list(),

        // ═══════════════════════════════════════════════════════
        // Graph（9 个命令）
        // ═══════════════════════════════════════════════════════
        "load_graph_json" => {
            let path = opt_str(&params, "path");
            commands::graph::load_graph_json(path, state).await
        }
        "analyze_and_load" => {
            let path = req_str(&params, "path", "analyze_and_load")?;
            let force = opt_bool(&params, "force");
            commands::graph::analyze_and_load(path, force, app).await
        }
        "get_graph_meta" => commands::graph::get_graph_meta(state).await,
        "get_graph_page" => {
            let page = opt_usize(&params, "page").unwrap_or(0);
            let page_size = opt_usize(&params, "page_size");
            commands::graph::get_graph_page(page, page_size, state).await
        }
        "engine_impact" => {
            let node_id = req_str(&params, "node_id", "engine_impact")?;
            let max_depth = opt_usize(&params, "max_depth").unwrap_or(3);
            commands::graph::engine_impact(node_id, max_depth)
        }

        // ═══════════════════════════════════════════════════════
        // Git（23 个命令）
        // ═══════════════════════════════════════════════════════
        "git_status" => {
            let path = req_str(&params, "path", "git_status")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_status(path, is_agent, _agent_id, state, app).await
        }
        "git_diff_unstaged" => {
            let path = req_str(&params, "path", "git_diff_unstaged")?;
            let file = req_str(&params, "file", "git_diff_unstaged")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_diff_unstaged(path, file, is_agent, _agent_id, state, app).await
        }
        "git_diff_staged" => {
            let path = req_str(&params, "path", "git_diff_staged")?;
            let file = req_str(&params, "file", "git_diff_staged")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_diff_staged(path, file, is_agent, _agent_id, state, app).await
        }
        "git_stage" => {
            let path = req_str(&params, "path", "git_stage")?;
            let files = req_strs(&params, "files", "git_stage")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_stage(path, files, is_agent, _agent_id, state, app).await
        }
        "git_stage_all" => {
            let path = req_str(&params, "path", "git_stage_all")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_stage_all(path, is_agent, _agent_id, state, app).await
        }
        "git_commit" => {
            let path = req_str(&params, "path", "git_commit")?;
            let message = req_str(&params, "message", "git_commit")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_commit(path, message, is_agent, _agent_id, state, app).await
        }
        "git_push" => {
            let path = req_str(&params, "path", "git_push")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_push(path, is_agent, _agent_id, state, app).await
        }
        "git_pull" => {
            let path = req_str(&params, "path", "git_pull")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_pull(path, is_agent, _agent_id, state, app).await
        }
        "git_log" => {
            let path = req_str(&params, "path", "git_log")?;
            let limit = opt_i32(&params, "limit");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_log(path, limit, is_agent, _agent_id, state, app).await
        }
        "git_init" => {
            let path = req_str(&params, "path", "git_init")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_init(path, is_agent, _agent_id, state, app).await
        }
        "git_checkout" => {
            let path = req_str(&params, "path", "git_checkout")?;
            let branch = req_str(&params, "branch", "git_checkout")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_checkout(path, branch, is_agent, _agent_id, state, app).await
        }
        "git_create_branch" => {
            let path = req_str(&params, "path", "git_create_branch")?;
            let name = req_str(&params, "name", "git_create_branch")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_create_branch(path, name, is_agent, _agent_id, state, app).await
        }
        "git_stash_push" => {
            let path = req_str(&params, "path", "git_stash_push")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_stash_push(path, is_agent, _agent_id, state, app).await
        }
        "git_stash_pop" => {
            let path = req_str(&params, "path", "git_stash_pop")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_stash_pop(path, is_agent, _agent_id, state, app).await
        }
        "git_discard" => {
            let path = req_str(&params, "path", "git_discard")?;
            let file = req_str(&params, "file", "git_discard")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_discard(path, file, is_agent, _agent_id, state, app).await
        }
        "git_blame" => {
            let path = req_str(&params, "path", "git_blame")?;
            let file = req_str(&params, "file", "git_blame")?;
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_blame(path, file, _agent_id, state, app).await
        }

        // ═══════════════════════════════════════════════════════
        // 文件系统（13 个命令）
        // ═══════════════════════════════════════════════════════
        "list_directory" => {
            let path = req_str(&params, "path", "list_directory")?;
            let is_agent = opt_bool(&params, "is_agent");
            let filter_ignored = opt_bool(&params, "filter_ignored");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_json(commands::filesystem::list_directory(path, is_agent, filter_ignored, _agent_id, state, app).await)
        }
        "list_directory_flat" => {
            let path = req_str(&params, "path", "list_directory_flat")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_json(commands::filesystem::list_directory_flat(path, is_agent, _agent_id, state, app).await)
        }
        "read_file_content" => {
            let file_path = req_str(&params, "file_path", "read_file_content")?;
            let offset = opt_usize(&params, "offset");
            let limit = opt_usize(&params, "limit");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::filesystem::read_file_content(file_path, offset, limit, is_agent, _agent_id, state, app).await
        }
        "read_memory_batch" => {
            let paths: Vec<String> = params.get("paths")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            commands::filesystem::read_memory_batch(paths)
        }
        "read_file_base64" => {
            let file_path = req_str(&params, "file_path", "read_file_base64")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::filesystem::read_file_base64(file_path, is_agent, _agent_id, state, app).await
        }
        "write_file_content" => {
            let file_path = req_str(&params, "file_path", "write_file_content")?;
            let content = req_str(&params, "content", "write_file_content")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::filesystem::write_file_content(file_path, content, is_agent, _agent_id, state, app).await
        }
        "log_append" => {
            let path = req_str(&params, "path", "log_append")?;
            let content = req_str(&params, "content", "log_append")?;
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::log_append(path, content, _agent_id, state))
        }
        "create_directory" => {
            let path = req_str(&params, "path", "create_directory")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::create_directory(path, is_agent, _agent_id, state, app).await)
        }
        "get_global_memory_dir" => Ok(commands::filesystem::get_global_memory_dir()),
        "delete_file_or_dir" => {
            let path = req_str(&params, "path", "delete_file_or_dir")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::delete_file_or_dir(path, is_agent, _agent_id, state, app).await)
        }
        "rename_file_or_dir" => {
            let file_path = req_str(&params, "file_path", "rename_file_or_dir")?;
            let new_name = req_str(&params, "new_name", "rename_file_or_dir")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::rename_file_or_dir(file_path, new_name, is_agent, _agent_id, state, app).await)
        }
        "move_file" => {
            let from = req_str(&params, "from", "move_file")?;
            let to = req_str(&params, "to", "move_file")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::move_file(from, to, is_agent, _agent_id, state, app).await)
        }

        // ═══════════════════════════════════════════════════════
        // 搜索（3 个命令）
        // ═══════════════════════════════════════════════════════
        "search_content" => {
            let directory = req_str(&params, "directory", "search_content")?;
            let pattern = req_str(&params, "pattern", "search_content")?;
            let file_types = opt_str(&params, "file_types");
            let max_results = opt_usize(&params, "max_results");
            let use_regex = opt_bool(&params, "use_regex");
            let context_lines = opt_usize(&params, "context_lines");
            let output_mode = opt_str(&params, "output_mode");
            let show_line_numbers = opt_bool(&params, "show_line_numbers");
            let head_limit = opt_usize(&params, "head_limit");
            let offset = opt_usize(&params, "offset");
            let glob_filter = opt_str(&params, "glob_filter");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::search::search_content(
                directory, pattern, file_types, max_results, use_regex,
                context_lines, output_mode, show_line_numbers, head_limit,
                offset, glob_filter, is_agent, _agent_id, state, app,
            ).await
        }
        "glob" => {
            let pattern = req_str(&params, "pattern", "glob")?;
            let path = opt_str(&params, "path");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::search::glob(pattern, path, is_agent, _agent_id, state, app).await
        }

        // ═══════════════════════════════════════════════════════
        // Web（2 个命令）
        // ═══════════════════════════════════════════════════════
        "web_search" => {
            let query = req_str(&params, "query", "web_search")?;
            let agent_id = opt_str(&params, "_agent_id");
            commands::web::web_search(query, agent_id, state, app).await
        }
        "web_fetch" => {
            let url = req_str(&params, "url", "web_fetch")?;
            let agent_id = opt_str(&params, "_agent_id");
            commands::web::web_fetch(url, agent_id, state, app).await
        }

        // ═══════════════════════════════════════════════════════
        // CDP 浏览器控制（18 个命令）
        // 权限：launch/kill/attach/connect/eval 走 BrowserTool Ask（控制浏览器需用户知情）；
        //       inspect/report/targets/snapshot/console/network/screenshot/audit/status
        //       只读放行；click/type/press/scroll 依赖 attach 时已获批准的 target，
        //       不再重复弹窗——但敏感目标（已填值输入框/提交按钮/下载/高危文本）
        //       每次单独 Ask（ADR 0003 D6 L3）。
        // 会话：所有命令按 _agent_id 键控路由到各 Agent 自己的 CDP 会话；
        //       self=true 时路由到自家 webview 只读会话（操作类动作被拒）。
        // ═══════════════════════════════════════════════════════
        "browser_launch" => {
            let agent_id = opt_str(&params, "_agent_id");
            {
                let ctx = crate::utils::get_ctx(&state)?;
                let tool = crate::tools::BrowserTool { action: "launch".into(), agent_id: agent_id.clone() };
                crate::utils::check_permission(&tool, &ctx, &app).await?;
            }
            let url = opt_str(&params, "url");
            let port = opt_u64(&params, "port").map(|n| n as u16);
            crate::cdp::cdp_launch(url, port, agent_id.as_deref()).await
        }
        "browser_connect" => {
            let agent_id = opt_str(&params, "_agent_id");
            {
                let ctx = crate::utils::get_ctx(&state)?;
                let tool = crate::tools::BrowserTool { action: "connect".into(), agent_id: agent_id.clone() };
                crate::utils::check_permission(&tool, &ctx, &app).await?;
            }
            let port = opt_u64(&params, "port")
                .ok_or_else(|| "browser_connect: missing 'port'".to_string())?;
            if port == 0 || port > 65535 {
                return Err("browser_connect: 端口必须在 1-65535".into());
            }
            crate::cdp::cdp_connect(port as u16, agent_id.as_deref())
        }
        "browser_kill" => {
            let agent_id = opt_str(&params, "_agent_id");
            {
                let ctx = crate::utils::get_ctx(&state)?;
                let tool = crate::tools::BrowserTool { action: "kill".into(), agent_id: agent_id.clone() };
                crate::utils::check_permission(&tool, &ctx, &app).await?;
            }
            crate::cdp::cdp_kill(agent_id.as_deref())
        }
        "browser_targets" => {
            let agent_id = opt_str(&params, "_agent_id");
            crate::cdp::cdp_targets(agent_id.as_deref())
        }
        "browser_attach" => {
            let agent_id = opt_str(&params, "_agent_id");
            {
                let ctx = crate::utils::get_ctx(&state)?;
                let tool = crate::tools::BrowserTool { action: "attach".into(), agent_id: agent_id.clone() };
                crate::utils::check_permission(&tool, &ctx, &app).await?;
            }
            // 前端 schema 用 targetId（camelCase → target_id）；兼容旧调用方的 target
            let target = opt_str(&params, "target_id")
                .or_else(|| opt_str(&params, "target"))
                .ok_or_else(|| "browser_attach: missing 'targetId'".to_string())?;
            crate::cdp::cdp_attach(&target, agent_id.as_deref())
        }
        "browser_inspect" => {
            let agent_id = self_or_agent(&params);
            let selector = req_str(&params, "selector", "browser_inspect")?;
            let props = params.get("props")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<String>>());
            let max_results = opt_usize(&params, "max_results");
            crate::cdp::cdp_inspect(&selector, props, max_results, agent_id.as_deref()).await
        }
        "browser_report" => {
            let agent_id = self_or_agent(&params);
            let scope = opt_str(&params, "scope");
            crate::cdp::cdp_report(scope, agent_id.as_deref()).await
        }
        "browser_snapshot" => {
            let agent_id = self_or_agent(&params);
            let scope = opt_str(&params, "scope");
            let max_results = opt_usize(&params, "max_results");
            crate::cdp::cdp_snapshot(scope, max_results, agent_id.as_deref()).await
        }
        "browser_console" => {
            let agent_id = self_or_agent(&params);
            let limit = opt_usize(&params, "limit");
            Ok(crate::cdp::cdp_console(agent_id.as_deref(), limit))
        }
        "browser_network" => {
            let agent_id = self_or_agent(&params);
            let limit = opt_usize(&params, "limit");
            Ok(crate::cdp::cdp_network(agent_id.as_deref(), limit))
        }
        "browser_screenshot" => {
            let agent_id = self_or_agent(&params);
            crate::cdp::cdp_screenshot(agent_id.as_deref()).await
        }
        "browser_audit" => {
            let limit = opt_usize(&params, "limit");
            Ok(crate::cdp::cdp_audit(limit))
        }
        "browser_click" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_click: self 会话只读，不能操作自家 webview".into());
            }
            let selector = req_str(&params, "selector", "browser_click")?;
            // 敏感目标（提交按钮/下载/高危文本）→ 每次单独 Ask（ADR 0003 D6 L3）
            if crate::cdp::check_sensitive(&selector, "click", agent_id.as_deref()).await {
                let ctx = crate::utils::get_ctx(&state)?;
                let tool = crate::tools::BrowserTool { action: "click_sensitive".into(), agent_id: agent_id.clone() };
                crate::utils::check_permission(&tool, &ctx, &app).await?;
            }
            crate::cdp::cdp_click(&selector, agent_id.as_deref()).await
        }
        "browser_type" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_type: self 会话只读，不能操作自家 webview".into());
            }
            let selector = req_str(&params, "selector", "browser_type")?;
            let text = req_str(&params, "text", "browser_type")?;
            // 敏感目标（已填值输入框/密码框）→ 每次单独 Ask（ADR 0003 D6 L3）
            if crate::cdp::check_sensitive(&selector, "type", agent_id.as_deref()).await {
                let ctx = crate::utils::get_ctx(&state)?;
                let tool = crate::tools::BrowserTool { action: "type_sensitive".into(), agent_id: agent_id.clone() };
                crate::utils::check_permission(&tool, &ctx, &app).await?;
            }
            crate::cdp::cdp_type(&selector, &text, agent_id.as_deref()).await
        }
        "browser_press" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_press: self 会话只读，不能操作自家 webview".into());
            }
            let key = req_str(&params, "key", "browser_press")?;
            crate::cdp::cdp_press(&key, agent_id.as_deref()).await
        }
        "browser_scroll" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_scroll: self 会话只读，不能操作自家 webview".into());
            }
            let selector = opt_str(&params, "selector");
            let direction = opt_str(&params, "direction");
            crate::cdp::cdp_scroll(selector, direction, agent_id.as_deref()).await
        }
        "browser_eval" => {
            let agent_id = opt_str(&params, "_agent_id");
            {
                let ctx = crate::utils::get_ctx(&state)?;
                let tool = crate::tools::BrowserTool { action: "eval".into(), agent_id: agent_id.clone() };
                crate::utils::check_permission(&tool, &ctx, &app).await?;
            }
            let expr = req_str(&params, "expr", "browser_eval")?;
            crate::cdp::cdp_eval(&expr, agent_id.as_deref()).await
        }
        "browser_status" => {
            let agent_id = self_or_agent(&params);
            Ok(crate::cdp::cdp_status(agent_id.as_deref()))
        }

        // ═══════════════════════════════════════════════════════
        // Shell（3 个命令）
        // ═══════════════════════════════════════════════════════
        "exec_command" => {
            let command = req_str(&params, "command", "exec_command")?;
            let cwd = opt_str(&params, "cwd");
            let timeout_ms = opt_u64(&params, "timeout_ms");
            let run_in_background = opt_bool(&params, "run_in_background");
            let is_agent = opt_bool(&params, "is_agent");
            let agent_id = opt_str(&params, "_agent_id").or_else(|| opt_str(&params, "agent_id"));
            let stream_tool_id = opt_str(&params, "stream_tool_id");
            commands::shell::exec_command(command, cwd, timeout_ms, run_in_background, is_agent, stream_tool_id, agent_id, state, app).await
        }
        "bash_output" => {
            let job_id = params.get("job_id").and_then(|v| v.as_u64()).map(|n| n as u32)
                .ok_or_else(|| "bash_output: missing 'job_id'".to_string())?;
            commands::shell::bash_output(job_id).await
        }
                "bash_kill" => {
            let job_id = params.get("job_id").and_then(|v| v.as_u64()).map(|n| n as u32)
                .ok_or_else(|| "bash_kill: missing 'job_id'".to_string())?;
            let agent_id = opt_str(&params, "agent_id");
            commands::shell::bash_kill(job_id, agent_id).await
        }
        "bash_wait" => {
            let job_id = params.get("job_id").and_then(|v| v.as_u64()).map(|n| n as u32)
                .ok_or_else(|| "bash_wait: missing 'job_id'".to_string())?;
            let timeout_ms = opt_u64(&params, "timeout_ms");
            commands::shell::bash_wait(job_id, timeout_ms).await
        }
        "shell_env" => Ok(commands::shell::shell_env()),
        "drain_bg_notifications" => {
            commands::shell::drain_bg_notifications().await
        }

        // ═══════════════════════════════════════════════════════
        // 编辑器（1 个命令）
        // ═══════════════════════════════════════════════════════
        "edit_file" => {
            let file_path = req_str(&params, "file_path", "edit_file")?;
            let old_string = req_str(&params, "old_string", "edit_file")?;
            let new_string = req_str(&params, "new_string", "edit_file")?;
            let replace_all = opt_bool(&params, "replace_all");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::editor::edit_file(file_path, old_string, new_string, replace_all, is_agent, _agent_id, state, app).await
        }

        // ═══════════════════════════════════════════════════════
        // 身份认证（5 个命令）
        // ═══════════════════════════════════════════════════════
        "permission_ask_response" => {
            let request_id = req_str(&params, "request_id", "permission_ask_response")?;
            let allow = match params.get("allow") {
                Some(v) => v.as_bool().ok_or_else(|| format!("参数 'allow' 必须是布尔值，收到: {}", v))?,
                None => return Err("参数 'allow' 缺失 — 必须明确指定允许或拒绝".to_string()),
            };
            // 验证可选参数 — 类型错误时报错，不静默吞掉
            let remember = match params.get("remember") {
                None => None,
                Some(Value::Bool(b)) => Some(*b),
                Some(v) => return Err(format!("参数 'remember' 必须是布尔值，收到: {}", v)),
            };
            let rule_to_add = match params.get("rule_to_add") {
                None => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Null) => None,
                Some(v) => return Err(format!("参数 'rule_to_add' 必须是字符串，收到: {}", v)),
            };
            let rule_behavior = match params.get("rule_behavior") {
                None => None,
                Some(Value::String(s)) => {
                    // 验证已知行为值
                    let valid = ["allow", "deny", "ask"];
                    if !valid.contains(&s.as_str()) {
                        return Err(format!("参数 'rule_behavior' 无效: '{}' (允许: {})", s, valid.join(", ")));
                    }
                    Some(s.clone())
                }
                Some(Value::Null) => None,
                Some(v) => return Err(format!("参数 'rule_behavior' 必须是字符串，收到: {}", v)),
            };
            ok_unit(commands::identity::permission_ask_response(request_id, allow, remember, rule_to_add, rule_behavior, state).await)
        }
        "set_permission_mode" => {
            let mode = req_str(&params, "mode", "set_permission_mode")?;
            ok_unit(commands::identity::set_permission_mode(mode))
        }
        "credential_store" => {
            let provider = req_str(&params, "provider", "credential_store")?;
            let key = req_str(&params, "key", "credential_store")?;
            // 同步 DPAPI/Keychain/secret-tool 操作 — 移到阻塞线程池，避免卡住异步 runtime
            let r = tokio::task::spawn_blocking(move || commands::identity::credential_store(provider, key))
                .await
                .map_err(|e| format!("credential_store 任务失败: {e}"))?;
            ok_unit(r)
        }
        "credential_get" => {
            let provider = req_str(&params, "provider", "credential_get")?;
            let r = tokio::task::spawn_blocking(move || commands::identity::credential_get(provider))
                .await
                .map_err(|e| format!("credential_get 任务失败: {e}"))?;
            ok_json(r)
        }
        "credential_delete" => {
            let provider = req_str(&params, "provider", "credential_delete")?;
            let r = tokio::task::spawn_blocking(move || commands::identity::credential_delete(provider))
                .await
                .map_err(|e| format!("credential_delete 任务失败: {e}"))?;
            ok_unit(r)
        }

        // ═══════════════════════════════════════════════════════
        // Agent 隔离（7 个命令）
        // P1-18：worktree 生命周期操作是阻塞进程等待（git worktree add/diff/
        // merge/prune 的 .output()），全部经 spawn_blocking 移出 async worker。
        // ═══════════════════════════════════════════════════════
        "agent_isolation_create" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_create")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_create(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_create 任务失败: {e}"))?
        }
        "agent_isolation_diff" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_diff")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_diff(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_diff 任务失败: {e}"))?
        }
        "agent_isolation_merge" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_merge")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_merge(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_merge 任务失败: {e}"))?
        }
        "agent_isolation_discard" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_discard")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_discard(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_discard 任务失败: {e}"))?
        }
        "agent_isolation_status" => {
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_status(&ws))
                .await
                .map_err(|e| format!("agent_isolation_status 任务失败: {e}"))?
        }
        "agent_isolation_force_purge" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_force_purge")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_force_purge(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_force_purge 任务失败: {e}"))?
        }

        // ═══════════════════════════════════════════════════════
        // 外部服务（6 个命令）
        // ═══════════════════════════════════════════════════════
        "start_mcp_server" => {
            let project_root = req_str(&params, "project_root", "start_mcp_server")?;
            commands::external::start_mcp_server(project_root).await
        }
        "stop_mcp_server" => commands::external::stop_mcp_server().await,
        "start_unity" => commands::external::start_unity(),
        "stop_unity" => commands::external::stop_unity(),
        "unity_status" => commands::external::unity_status(),
        "sandbox_status" => commands::external::sandbox_status(),

        // ═══════════════════════════════════════════════════════
        // Hologram（尚未迁入 engine ToolRegistry 的遗留命令）
        // ═══════════════════════════════════════════════════════
        "hologram_run_check" => {
            let path = opt_str(&params, "path");
            commands::hologram::hologram_run_check(path, state).await
        }
        "hologram_record_event" => {
            let event_type = req_str(&params, "event_type", "hologram_record_event")?;
            let file = opt_str(&params, "file");
            let summary = req_str(&params, "summary", "hologram_record_event")?;
            // E3: 统一返回包装 — 将 "ok" 映射为 "null" 以保持
            // 与其他返回单元的命令一致（ok_unit 模式）。
            // 前端以 fire-and-forget 方式调用，不检查返回值。
            commands::hologram::hologram_record_event(event_type, file, summary, state)
                .await
                .map(|_| "null".into())
        }
        "get_full_graph" => commands::hologram::get_full_graph(state).await,

        // ═══════════════════════════════════════════════════════
        // 工作区（3 个命令）
        // ═══════════════════════════════════════════════════════
        "workspace_activate" => {
            let path = req_str(&params, "path", "workspace_activate")?;
            ok_unit(commands::workspace::workspace_activate(path, state).await)
        }
        "workspace_deactivate" => {
            ok_unit(commands::workspace::workspace_deactivate(state).await)
        }
        "workspace_start_watcher" => {
            ok_unit(commands::workspace::workspace_start_watcher(app, state).await)
        }

        // ═══════════════════════════════════════════════════════
        // 会话持久化（2 个命令）
        // ═══════════════════════════════════════════════════════
        "session_append" => {
            let path = req_str(&params, "path", "session_append")?;
            let session_id = req_str(&params, "session_id", "session_append")?;
            crate::utils::sanitize_path_id(&session_id, "session_id")?;
            let message = params.get("message")
                .ok_or("session_append: missing 'message'")?;
            let file = std::path::Path::new(&path)
                .join(".hologram/sessions")
                .join(format!("{session_id}.ndjson"));
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("session_append: cannot create dir: {e}"))?;
            }
            let line = serde_json::to_string(message)
                .map_err(|e| format!("session_append: serialize: {e}"))?;
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)
                .map_err(|e| format!("session_append: open: {e}"))?;
            f.write_all(line.as_bytes())
                .map_err(|e| format!("session_append: write: {e}"))?;
            f.write_all(b"\n")
                .map_err(|e| format!("session_append: write: {e}"))?;
            f.flush()
                .map_err(|e| format!("session_append: flush: {e}"))?;
            ok_unit(Ok(()))
        }

        // P1-15: agent 会话增量追加（NDJSON）— 与 session_append 同构，但写到
        // .hologram/agents/{agent_id}/session.ndjson。rewrite=true 时 truncate 重写
        // （会话被撤回/替换后全量重建），否则 append-only（每轮对话只写增量，
        // 消除旧 saveState 全量重写 session.json 的 O(全量) 写放大）。
        "agent_session_append" => {
            let project_path = req_str(&params, "project_path", "agent_session_append")?;
            let agent_id = req_str(&params, "agent_id", "agent_session_append")?;
            crate::utils::sanitize_path_id(&agent_id, "agent_id")?;
            let messages = params.get("messages")
                .ok_or("agent_session_append: missing 'messages'")?;
            let rewrite = params.get("rewrite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let file = std::path::Path::new(&project_path)
                .join(".hologram/agents")
                .join(&agent_id)
                .join("session.ndjson");
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("agent_session_append: cannot create dir: {e}"))?;
            }
            let arr = messages.as_array()
                .ok_or("agent_session_append: 'messages' must be an array")?;
            use std::io::Write;
            let mut f = if rewrite {
                // truncate 重写（撤回/替换后全量重建）
                std::fs::File::create(&file)
                    .map_err(|e| format!("agent_session_append: create: {e}"))?
            } else {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&file)
                    .map_err(|e| format!("agent_session_append: open: {e}"))?
            };
            for msg in arr {
                let line = serde_json::to_string(msg)
                    .map_err(|e| format!("agent_session_append: serialize: {e}"))?;
                f.write_all(line.as_bytes())
                    .map_err(|e| format!("agent_session_append: write: {e}"))?;
                f.write_all(b"\n")
                    .map_err(|e| format!("agent_session_append: write: {e}"))?;
            }
            f.flush()
                .map_err(|e| format!("agent_session_append: flush: {e}"))?;
            ok_unit(Ok(()))
        }

        // ═══════════════════════════════════════════════════════
        // 约束（2 个命令）
        // ═══════════════════════════════════════════════════════
        "read_constraints" => {
            let project_path = req_str(&params, "project_path", "read_constraints")?;
            commands::constraints::read_constraints(project_path).await
        }
        "write_constraints" => {
            let project_path = req_str(&params, "project_path", "write_constraints")?;
            let content = req_str(&params, "content", "write_constraints")?;
            ok_unit(commands::constraints::write_constraints(project_path, content).await)
        }

        // ═══════════════════════════════════════════════════════
        // 数据流（3 个命令）
        // ═══════════════════════════════════════════════════════
        "dataflow_save" => {
            let query = req_str(&params, "query", "dataflow_save")?;
            let content = opt_str(&params, "content");
            let explore_result = opt_str(&params, "explore_result");
            let dataflow_result = opt_str(&params, "dataflow_result");
            commands::dataflow::dataflow_save(query, content, explore_result, dataflow_result, state).await
        }
        "dataflow_query" => {
            let trace_id = opt_str(&params, "trace_id");
            let list = opt_bool(&params, "list");
            commands::dataflow::dataflow_query(trace_id, list, state).await
        }
        "dataflow_delete" => {
            let trace_id = req_str(&params, "trace_id", "dataflow_delete")?;
            commands::dataflow::dataflow_delete(trace_id, state).await
        }

        // ═══════════════════════════════════════════════════════
        // Aura 记忆（7 个命令）
        // ═══════════════════════════════════════════════════════
        "aura_init" => {
            let brain_path = req_str(&params, "brain_path", "aura_init")?;
            crate::aura_memory::aura_init(brain_path)
        }
        "aura_recall" => {
            let query = req_str(&params, "query", "aura_recall")?;
            let top_k = opt_i32(&params, "top_k").unwrap_or(0);
            crate::aura_memory::aura_recall(query, top_k)
        }
        "aura_recall_text" => {
            let query = req_str(&params, "query", "aura_recall_text")?;
            let token_budget = opt_i32(&params, "token_budget").unwrap_or(0);
            crate::aura_memory::aura_recall_text(query, token_budget)
        }
        "aura_store" => {
            let content = req_str(&params, "content", "aura_store")?;
            let level = params.get("level").and_then(|v| v.as_u64()).map(|n| n as u8).unwrap_or(0);
            let tags = opt_str(&params, "tags").unwrap_or_default();
            let namespace = opt_str(&params, "namespace").unwrap_or_default();
            crate::aura_memory::aura_store(content, level, tags, namespace)
        }
        "aura_count" => crate::aura_memory::aura_count().map(|n| n.to_string()),
        "aura_maintenance" => ok_unit(crate::aura_memory::aura_maintenance()),
        "aura_shutdown" => ok_unit(crate::aura_memory::aura_shutdown()),

        // ═══════════════════════════════════════════════════════
        // PTY（4 个命令）
        // ═══════════════════════════════════════════════════════
        "pty_spawn" => {
            let cwd = req_str(&params, "cwd", "pty_spawn")?;
            let shell = opt_str(&params, "shell");
            let cols = req_u16(&params, "cols", "pty_spawn")?;
            let rows = req_u16(&params, "rows", "pty_spawn")?;
            let id = crate::pty_manager::pty_spawn(app, cwd, shell, cols, rows).await?;
            Ok(id.to_string())
        }
        "pty_write" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "pty_write: missing 'session_id'".to_string())?;
            let data = req_str(&params, "data", "pty_write")?;
            ok_unit(crate::pty_manager::pty_write(session_id, data).await)
        }
        "pty_resize" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "pty_resize: missing 'session_id'".to_string())?;
            let cols = req_u16(&params, "cols", "pty_resize")?;
            let rows = req_u16(&params, "rows", "pty_resize")?;
            ok_unit(crate::pty_manager::pty_resize(session_id, cols, rows).await)
        }
        "pty_kill" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "pty_kill: missing 'session_id'".to_string())?;
            ok_unit(crate::pty_manager::pty_kill(session_id).await)
        }

        // ═══════════════════════════════════════════════════════
        // LSP（3 个命令）
        // ═══════════════════════════════════════════════════════
        "lsp_start" => {
            let language = req_str(&params, "language", "lsp_start")?;
            let root_uri = req_str(&params, "root_uri", "lsp_start")?;
            let id = crate::lsp_manager::lsp_start(app, language, root_uri).await?;
            Ok(id.to_string())
        }
        "lsp_request" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "lsp_request: missing 'session_id'".to_string())?;
            let method = req_str(&params, "method", "lsp_request")?;
            let lsp_params = params.get("params").cloned().unwrap_or(Value::Null);
            ok_json(crate::lsp_manager::lsp_request(session_id, method, lsp_params).await)
        }
        "lsp_stop" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "lsp_stop: missing 'session_id'".to_string())?;
            ok_unit(crate::lsp_manager::lsp_stop(session_id).await)
        }

        _ => Err(format!("rpc: unknown method '{}'", method)),
    }
}