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
fn req_bool(params: &Value, name: &str, method: &str) -> Result<bool, String> {
    params
        .get(name)
        .and_then(|v| v.as_bool())
        .ok_or_else(|| format!("{method}: missing '{name}'"))
}
/// browser 命令的 agent 路由：target="self" 走自家 webview 只读会话，

fn req_strs(params: &Value, name: &str, method: &str) -> Result<Vec<String>, String> {
    params.get(name)
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .ok_or_else(|| format!("{method}: missing '{name}'"))
}

/// 可选 env 注入映射（protocol_bridge_spawn，app shell S2）：缺省/Null → None；
/// 对象逐键值须字符串；键禁空/含 '=' 或 NUL（Windows env 块歧义防线——名字
/// 里的 '=' 会被系统折进值），值禁 NUL。
fn opt_str_map(params: &Value, name: &str) -> Result<Option<std::collections::HashMap<String, String>>, String> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let obj = v.as_object().ok_or_else(|| format!("参数 '{name}' 必须是字符串到字符串的对象"))?;
            let mut map = std::collections::HashMap::new();
            for (k, val) in obj {
                let s = val
                    .as_str()
                    .ok_or_else(|| format!("参数 '{name}' 的键 {k} 对应值必须是字符串"))?;
                if k.is_empty() || k.contains('=') || k.contains('\0') {
                    return Err(format!("参数 '{name}' 非法 env 键（空/含 '=' 或 NUL）: {k}"));
                }
                if s.contains('\0') {
                    return Err(format!("参数 '{name}' 的键 {k} 对应值含 NUL"));
                }
                map.insert(k.clone(), s.to_string());
            }
            Ok(Some(map))
        }
    }
}

// ── 结果辅助函数（将类型化的 Ok 转换为 JSON 字符串）──

fn ok_json<T: serde::Serialize>(r: Result<T, String>) -> Result<String, String> {
    r.and_then(|v| serde_json::to_string(&v).map_err(|e| format!("rpc: serialize: {e}")))
}
fn ok_unit(r: Result<(), String>) -> Result<String, String> {
    r.map(|_| "null".into())
}

/// rpc 返回值 Value 化（landmine 根治级，2026-08-22）：commands 层保持
/// Result<String, String> 零改动，出口单点包 Value::String。
/// **故意不 parse**：出口无法区分「JSON 命令输出」和「恰好长得像 JSON 的
/// 文本」（read_file_content 读 .json 文件必须字节精确），智能留给前端
/// typedRpc 按契约分派（JSON 命令清单由 gen-rpc-contract-md.cjs 同源生成）。
/// agentInvoke 出口直通 string（工具链 string 世界零改动）。
fn str_to_value(s: String) -> Value {
    Value::String(s)
}

// ── rpc 返回值 Value 化第二步：命令→形态分派表（B 路线，2026-08-22）──
//
// JsonValue 表示「命令 Ok 输出恒为合法 JSON」：出口把字符串 parse 成真结构化
// Value 传递（serde_json 默认 BTreeMap 序，parse 消费方无感）。Text 表示字节
// 精确直通 Value::String。判定依据 = 前端同源答案卷（typedJsonRpc 调用点 +
// RpcContract 注释 + 命令实现逐一核对）；read_file_content 是刻意的文本铁律样板。
//
// 铁律：
// 1) 贴错标签 = 字节级破坏——Text 命令误标 JsonValue 会在出口 parse「长得像
//    JSON 的文本」上炸（read_file_content 读 .json 文件的回归测试钉死）；
//    JsonValue 命令误标 Text 只会让前端 typedJsonRpc 走兜底 parse string（慢
//    路径），不破坏正确性——错误方向只有一侧致命，分类偏保守。
// 2) 本表只认命令不认内容——同一命令返回形态必须恒定；动态形态命令
//    （exec_command 流式 started 响应等）一律 Text 由消费方自行 parse。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RpcResultShape {
    JsonValue,
    Text,
}

fn rpc_result_shape(method: &str) -> RpcResultShape {
    match method {
        // ── 应用层（L1 数据上下文）──
        // context_list：Vec<ContextInfo> serde，恒 JSON。
        // （workspace-session-ownership-rework 2026-08-27：session_attach/
        //  detach/focus 三命令退役，shape 表同步清。）
        "context_list" => RpcResultShape::JsonValue,

        // ── Git ──
        // （旧 git_* RPC 分支已随 kernel-plugin-runtime P2-3 迁 builtin.git 插件；
        //  插件又随 git 域收口退役（2026-09-05，c3 §8）——git_cap 能力口承接。
        //  git_cap：返回 run_git stdout 文本（porcelain 解析归 TS 编排层
        //  git-porcelain.ts；diff/blame 的 32K 截断在口内）。保持 Text：git
        //  子进程 stdout 字节直通。）
        "git_cap" => RpcResultShape::Text,

        // ── 文件系统 ──
        // （fs 工具域已收敛到 fs_cap 能力口直呼（2026-09-04 fs 域收口，builtin.fs
        //  插件退役）——本表 fs_cap 条目见下；list_directory 等旧 RPC 分支随迁退役。）
        // workspace_list：ok_json(注册表+各工作区会话计数) 恒 JSON。
        // workspace_create_dir：ok_json(归一化路径字符串) 恒 JSON 字符串。
        // （workspace-session-ownership-rework 2026-08-27：user_sessions_list 退役——
        //  首页工作区清单由 workspace_list 承担，计数扫各工作区会话根。）
        "workspace_list" | "workspace_create_dir" => {
            RpcResultShape::JsonValue
        }

        // ── 搜索 ──
        // （search_content 已随 builtin.search 退役（R2-c），R2-d(1) schema 回 TS zod；
        //  glob 随 builtin.fs 退役——fs 域收口后能力口 fs_cap.glob 承接。）
        // search_cap（R2 能力口试点）：返回与 builtin.search search_content 相同的
        // JSON 形状（json! 构造，恒合法 JSON）。
        "search_cap" => RpcResultShape::JsonValue,
        // fs_cap（R3-a 能力口）：每个 action 返回 JSON 结构（read = {path, content}
        // 其中 content 是 JSON 字符串值——出口 parse 无损；write/delete/rename/
        // create_dir = {path}；list = {entries}；glob = {pattern,count,truncated,
        // results}）。恒合法 JSON。
        "fs_cap" => RpcResultShape::JsonValue,

        // ── Shell / process ──
        // （旧 shell RPC 分支已随 kernel-plugin-runtime P2-4 迁 builtin.shell 插件；
        //  process_cap 能力口（R3-d，c3 §8）承接：exec_command 前台=命令 stdout
        //  文本（含粘性 marker 字节——截流归 TS）/ 流式=started JSON，动态形态；
        //  bash_output/bash_kill/bash_wait：输出文本；drain_bg_notifications：无通知
        //  返回空串（非 JSON）；shell_env/background_activity 恒 JSON 但形态不要求
        //  统一——与 git_cap 同判：字节精确优先，一律 Text。）
        "process_cap" => RpcResultShape::Text,

        // browser_cap（R4，kernel-capability-d4-handle-design.md）：句柄域
        // browser 族直呼——37 action 全部返回文本（插件 text() 直通原文语义，
        // 截断/结构化错误整形在 TS 工具层）。与 git_cap 同判：字节精确优先。
        "browser_cap" => RpcResultShape::Text,

        // uia_cap（R4，kernel-capability-d4-handle-design.md）：句柄域 desktop
        // 族直呼——17 action 全部返回文本（同 browser_cap 判：字节精确优先；
        // world-diff/审计报表文本直通，INVARIANTS #13 lease/grant 链在口内）。
        "uia_cap" => RpcResultShape::Text,

        // ── R4 小面清偿（kernel-capability-d4-handle-design.md §6 R4-4）──
        // web_cap：search = JSON 字符串 / fetch = 网页文本（信封 dispatch 的
        // Value 序列化语义逐字节保持）——Text。
        "web_cap" => RpcResultShape::Text,
        // （constraints_cap 随图谱全量退役删除，2026-09-09——hologram.constraints.yaml
        //  读写仅服务引擎 run_check，兰台侧已无消费方。）
        // pty_cap：spawn = 会话 id / 其余 = "null"——Text。
        "pty_cap" => RpcResultShape::Text,
        // lsp_cap：start = 会话 id / request = JSON 字符串（TS parseJson）/
        // stop = "null"——Text。
        "lsp_cap" => RpcResultShape::Text,
        // editor_cap：edit_file = diff 快照文本——Text。
        "editor_cap" => RpcResultShape::Text,

        // ── 身份认证/权限 ──
        // credential_get：Option<String> serde 序列化，恒 "key"/null JSON。
        // get_last_project：同款 Option<String> serde 序列化，恒 "path"/null。
        "credential_get" | "get_last_project" => RpcResultShape::JsonValue,

        // ── Agent 隔离 ──
        // create（json!）/status（json!）/force_purge（format! 文本）。
        // diff：三种分支都是 json! 构造，但 diff 内容含任意文本——json! 的
        // 字符串值保证转义安全，恒合法 JSON，JsonValue。
        // merge：merge_to_main 返回 git stdout 文本，Text。
        // discard：文案文本，Text。
        "agent_isolation_create" | "agent_isolation_status" | "agent_isolation_diff" => RpcResultShape::JsonValue,

        // ── 外部服务 ──
        // sandbox_status：json! 构造恒 JSON。其余 MCP 文案文本，Text。
        "sandbox_status" => RpcResultShape::JsonValue,

        // （hologram_run_check（serde 序列化、保守 Text）随图谱全量退役删除，
        //  2026-09-09——run_check 约束检查属引擎图数据面。）

        // ── 插件安装 ──
        // plugin_install：ok_json(String) 恒 JSON 字符串。uninstall/set_enabled：
        // ok_unit "null"，ok_unit 家族统一 Text（见下）。
        "plugin_install" => RpcResultShape::JsonValue,

        // ── 插件数据目录（app shell 件 B，S1）──
        // ensure：ok_json({path}) 恒 JSON 对象；list：ok_json({entries}) 恒 JSON。
        // read = 文件内容文本 / write/delete = ok_unit "null"——Text（默认臂）。
        "plugin_data_ensure" | "plugin_data_list" => RpcResultShape::JsonValue,

        // ── 随包图谱引擎探测（engine-bundled-mcp-distribution）──
        // engine_bundled_info：serde_json::json!({path,dir,available}) 恒合法 JSON。
        // **2026-09-24 补登记**：此前漏登记 ⇒ 落默认臂 Text ⇒ 出口把 JSON 当**字符串**
        // 直通，而前端 `plugins/bundled-engine.ts` 的 probeBundledEngine 用 typedRpc
        // （直通、不 parse；双形态 shim 在 typedJsonRpc）读 `raw.available` ⇒ 恒 false
        // ⇒ 设置页「随包图谱引擎」开关置灰、**拨不开**（实机缺陷，用户 2026-09-24 报）。
        // 09-16 的 CDP 探针读到的是那条 JSON 字符串本身（文本里写着 "available":true）
        // ⇒ 假阳性，把该缺陷掩盖了 8 天。回归钉在
        // `src-ui/tests/bundled-engine-probe-shape.test.ts`（两种线形都必须判 true）。
        "engine_bundled_info" => RpcResultShape::JsonValue,

        // ── 日志轮转（日志可观测性批 4）──
        // log_rotate：ok_json({rotated, size_before, path}) 恒 JSON 对象。
        "log_rotate" => RpcResultShape::JsonValue,

        // （数据流形状条目（dataflow_save / dataflow_query → Text）随图谱
        //  全量退役删除，2026-09-09。）

        // ── 其余（含 ok_unit "null" 家族、read_file_content、
        // exec_command、会话持久化、workspace、
        // protocol_bridge、llm_proxy_port、log_level_hint 等）──
        // 默认 Text：字节精确优先，形态不恒定或体量不可控的一律不展开。
        _ => RpcResultShape::Text,
    }
}

/// 第二步出口分派：JsonValue 命令的 Ok 路径 parse 成真 Value（parse 失败属
/// 命令违反「Ok 恒为合法 JSON」契约——错误不静默，转错误文案可见）；Text
/// 命令字节精确包 Value::String。Err 路径两种形态统一包 Value::String
/// （错误信息是人读文本，前端 catch 语义不变）。
fn dispatch_result_to_value(method: &str, r: Result<String, String>) -> Result<Value, String> {
    match (rpc_result_shape(method), r) {
        (RpcResultShape::JsonValue, Ok(s)) => serde_json::from_str(&s).map_err(|e| {
            tracing::error!(
                "[rpc] JsonValue 命令 {} 返回非合法 JSON（违反契约，转错误回包）: {}",
                method,
                e
            );
            format!("rpc: {}: 输出非合法 JSON: {}", method, e)
        }),
        (_, Ok(s)) => Ok(str_to_value(s)),
        (_, Err(e)) => Err(e),
    }
}

// ── 单一 RPC 命令 ──

#[tauri::command]
pub(crate) async fn rpc(
    method: String,
    params: Value,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    // panic 容器：Tauri 2.x 命令 future panic 时 resolver 随 task 一起被
    // 丢弃，invoke promise 永远不 resolve——前端工具调用永久挂起，且
    // panic 只进 stderr、不进 bridge.log（2026-08 edit 偶发挂死即此症状，
    // 根因见 editor.rs truncate_err_key 回归测试）。这里把 panic 就地转为
    // Err 回包：错误可见、调用失败返回而不是挂死。与 INVARIANTS #11
    // （响应丢失 → 前端 await 永久挂起）同症状家族的根治护栏。
    // 出口分派（Value 化第二步）：method 移入闭包供形态分派。
    let result = guard_panic(dispatch_rpc(method.clone(), params, state, app_ctx, app)).await;
    dispatch_result_to_value(&method, result)
}

/// 把命令体 panic 转为错误回包，防止 invoke promise 泄漏成永久挂起。
async fn guard_panic(
    fut: impl std::future::Future<Output = Result<String, String>>,
) -> Result<String, String> {
    use futures_util::FutureExt;
    std::panic::AssertUnwindSafe(fut)
        .catch_unwind()
        .await
        .unwrap_or_else(|payload| Err(panic_to_rpc_error(payload)))
}

/// panic payload → 人话错误消息（trace 落 bridge.log，不再无迹可寻）。
fn panic_to_rpc_error(payload: Box<dyn std::any::Any + Send>) -> String {
    let msg = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "未知 panic payload".to_string());
    tracing::error!("[rpc] 命令内部 panic（已转为错误回包）: {}", msg);
    format!("命令内部错误（panic）: {}", msg)
}

/// P1-15: agent 会话增量追加（NDJSON）— 与 session_append 同构，但写到
/// .lantai/agents/{agent_id}/session.ndjson。rewrite=true 时 truncate 重写
/// （会话被撤回/替换后全量重建），否则 append-only（每轮对话只写增量，
/// 消除旧 saveState 全量重写 session.json 的 O(全量) 写放大）。
///
/// 从 dispatch_rpc 的 match 分支原样提取（行为逐字节不变，2026-09-02 平台
/// 补课 Phase 2）——dispatch_rpc 依赖 tauri::State/AppHandle，单元测试无法
/// 构造；本函数零状态、纯 fs，是会话 NDJSON 落盘的唯一实现，持久化行为
/// 序列（round-trip / 空会话 / 损坏容忍 / 并发 / 覆盖）以此为钉测锚点。
fn agent_session_append(
    project_path: &str,
    agent_id: &str,
    messages: &Value,
    rewrite: bool,
) -> Result<(), String> {
    crate::utils::sanitize_path_id(agent_id, "agent_id")?;
    let file = std::path::Path::new(project_path)
        .join(".lantai/agents")
        .join(agent_id)
        .join("session.ndjson");
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("agent_session_append: cannot create dir: {e}"))?;
    }
    let arr = messages
        .as_array()
        .ok_or("agent_session_append: 'messages' must be an array")?;
    use std::io::Write;
    let mut f = if rewrite {
        // truncate 重写（撤回/替换后全量重建）
        std::fs::File::create(&file).map_err(|e| format!("agent_session_append: create: {e}"))?
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
    Ok(())
}

async fn dispatch_rpc(
    method: String,
    params: Value,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use crate::commands;

    match method.as_str() {
        // ═══════════════════════════════════════════════════════
        // 应用层：数据上下文（L1）
        // （workspace-session-ownership-rework 2026-08-27：session_attach/
        //  detach/focus 三命令退役——会话只在所属工作区内打开，引擎决议
        //  只看活动工作区，无需会话绑定/焦点投影。）
        // ═══════════════════════════════════════════════════════
        "context_list" => crate::app::commands::context_list(app_ctx),

        // （Engine 调度（hologram_call / hologram_tools_list）与 Graph 命令族
        //  （load_graph_json / analyze_and_load / get_graph_snapshot /
        //  hologram_file_nodes）随图谱全量退役删除，2026-09-09——兰台零引擎
        //  内置接线，引擎以独立进程 + 外部 MCP 通道形态供消费。）

        // ═══════════════════════════════════════════════════════
        // 能力口（R2 试点，kernel-capability-r2-search-pilot.md）——
        // 内核能力层直呼入口，不经 tool_call 信封 / PluginRegistry。
        // search_cap：search 全文扫描能力口（fs 能力族变体，v3 §4）。
        // R2-d(2) 收窄：口只做纯扫描返回统一原始命中集（max_matches/
        // max_files 两组收窄键 + collect_lines 携行开关）——三形态组装/分页/
        // 行号显示归 TS 编排层（search-assembly.ts）。
        // 参数说顶层 snake_case（bridge.rpc() 转换幂等）；is_agent/agent_id
        // 显式传（resolve_read_dispatch 分流 Agent 过闸 / UI 只解析）。
        // ═══════════════════════════════════════════════════════
        "search_cap" => {
            let directory = req_str(&params, "directory", "search_cap")?;
            let pattern = req_str(&params, "pattern", "search_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            // agent_id 兼容两种键：rpc-contract 面显式传 agent_id；executor 注入的
            // _agent_id（bridge.rpc() snake 化后保留下划线）也认——R2-a 曾只读
            // agent_id 导致隔离子 Agent 的搜索身份丢失（resolve_read_dispatch
            // agent_id=None → 越过 worktree 映射）。能力口统一收 snake_case 键
            // （bridge.rpc() 顶层转换契约），详见 rpc-contract search_cap 注释。
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            let r = commands::search_cap::search_content_cap(
                directory,
                pattern,
                opt_str(&params, "file_types"),
                params.get("max_matches").and_then(|v| v.as_u64()).map(|n| n as usize),
                params.get("max_files").and_then(|v| v.as_u64()).map(|n| n as usize),
                opt_bool(&params, "use_regex"),
                params.get("context_lines").and_then(|v| v.as_u64()).map(|n| n as usize),
                opt_bool(&params, "collect_lines"),
                opt_str(&params, "glob_filter"),
                is_agent,
                agent_id,
                &state,
                &app,
            )
            .await?;
            ok_json::<Value>(Ok(r))
        }

        // ═══════════════════════════════════════════════════════
        // fs_cap（R3-a，kernel-capability-c3-design.md）——fs 能力口直呼入口，
        // 不经 tool_call 信封 / PluginRegistry / PluginToolAdapter。参数顶层
        // snake_case（bridge.rpc() 转换幂等）；is_agent/agent_id 显式传。
        // action 分派在 commands/fs_cap.rs；每个 action 口内 resolve_*_dispatch
        // 过闸（Agent 过 Ask / UI 只解析）。返回 JSON 字符串（JsonValue shape）。
        // ═══════════════════════════════════════════════════════
        "fs_cap" => {
            let action = req_str(&params, "action", "fs_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            let usize_opt = |k: &str| params.get(k).and_then(|v| v.as_u64()).map(|n| n as usize);
            let r = commands::fs_cap::fs_cap(
                action,
                opt_str(&params, "path"),
                opt_str(&params, "from"),
                opt_str(&params, "to"),
                opt_str(&params, "file_path"),
                opt_str(&params, "pattern"),
                opt_str(&params, "dir"),
                opt_str(&params, "content"),
                usize_opt("offset"),
                usize_opt("limit"),
                opt_bool(&params, "line_numbers"),
                opt_bool(&params, "filter_ignored"),
                params.get("paths").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter().filter_map(|x| x.as_str().map(String::from)).collect()
                }),
                is_agent,
                agent_id,
                opt_str(&params, "workspace_root"),
                opt_bool(&params, "durable"),
                params.get("truncate_to").and_then(|v| v.as_u64()),
                &state,
                &app,
            )
            .await?;
            ok_json::<Value>(Ok(r))
        }

        // ═══════════════════════════════════════════════════════
        // git_cap（R3-c，kernel-capability-c3-design.md §8）——git 能力口直呼入口，
        // 不经 tool_call 信封 / PluginRegistry / PluginToolAdapter（builtin.git
        // 插件随 git 域收口退役）。action = 退役前 builtin.git 工具名（16 工具
        // 一一位，与历史精确规则寻址名同构）；口内闸：Agent 路径构造
        // PluginToolAdapter（只读五动作 Read 家族 / 写动作 Git 家族两段闸 +
        // subcommand 位），用户路径只解析。执行体 = git_exec_path（worktree
        // forward-map）+ run_git；porcelain 解析归 TS 编排层（c3 §8）。
        // ═══════════════════════════════════════════════════════
        "git_cap" => {
            let action = req_str(&params, "action", "git_cap")?;
            let repo_path = req_str(&params, "repo_path", "git_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            let files = params.get("files").and_then(|v| v.as_array()).map(|arr| {
                arr.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<String>>()
            });
            commands::git_cap::git_cap(
                action,
                repo_path,
                opt_str(&params, "file"),
                files,
                opt_str(&params, "message"),
                opt_str(&params, "branch"),
                params.get("count").and_then(|v| v.as_u64()).map(|n| n as usize),
                is_agent,
                agent_id,
                &state,
                &app,
            )
            .await
        }

        // ═══════════════════════════════════════════════════════
        // process_cap（R3-d，kernel-capability-c3-design.md §8/§9）——process
        // 能力口直呼入口，不经 tool_call 信封 / PluginRegistry /
        // PluginToolAdapter（builtin.shell 插件随 shell 域收口退役）。action =
        // 退役前 builtin.shell 7 工具名；口内闸：fg/bg 双检查不对称（fg =
        // require_command 可 Ask + resolve_read_dispatch / bg =
        // require_command_sync + require_read_sync 免 Ask——Bash 家族命令串
        // 规则面，直用 BashTool）。粘性 cwd 归 TS（c3 §9）：cwd 显式 + sticky_cwd
        // 候选（盘上存在才用）；落点捕获 marker 原样流经 shell:output/结果，
        // 截流/提交/回显在 TS 编排层（capture_cwd=true 时口内按方言包装）。
        // 参数顶层 snake_case（bridge.rpc() 转换幂等）；is_agent/agent_id
        // 显式传；owner_id 兼容 _owner_id（bg:note 通知路由身份）。
        // office_exec（2026-09-15 R3）＝ office 域工具专用动作：收 {argv,targets}
        // 载荷、命令由口内拼装（动词白名单 + OfficeTool 门禁），**不复用** Bash
        // 家族的命令串路径检查（officecli 的 DOM 路径/JSON 载荷不是文件系统路径）。
        // ═══════════════════════════════════════════════════════
        "process_cap" => {
            let action = req_str(&params, "action", "process_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            let owner_id = opt_str(&params, "owner_id").or_else(|| opt_str(&params, "_owner_id"));
            commands::process_cap::process_cap(
                action,
                opt_str(&params, "command"),
                opt_str(&params, "cwd"),
                opt_str(&params, "sticky_cwd"),
                params.get("timeout_ms").and_then(|v| v.as_u64()),
                opt_bool(&params, "run_in_background").unwrap_or(false),
                opt_str(&params, "stream_tool_id"),
                opt_str(&params, "interpreter"),
                opt_bool(&params, "capture_cwd").unwrap_or(false),
                // office_exec 载荷（office 域工具专用：{argv:[…], targets:[{path,write}]}）
                // ——命令由口内拼装，门禁 = OfficeTool（只审声明的目标文件）。
                params.get("office").cloned(),
                params.get("job_id").and_then(|v| v.as_u64()).map(|n| n as u32),
                params.get("wait_timeout_ms").and_then(|v| v.as_u64()),
                is_agent,
                agent_id,
                owner_id,
                &state,
                &app,
            )
            .await
        }

        // ═══════════════════════════════════════════════════════
        // browser_cap（R4，kernel-capability-d4-handle-design.md）——browser
        // 句柄域能力口直呼入口，不经 tool_call 信封 / PluginRegistry /
        // PluginToolAdapter（builtin.browser 插件随 R4-2 退役；R4-1 过渡期
        // 插件 execute 委托口内——业务单一实现在 commands/browser_cap.rs）。
        // action = 退役前 builtin.browser 37 工具名；参数顶层 snake_case
        // （bridge.rpc() 转换幂等）；is_agent/agent_id 显式传（_agent_id
        // meta 兼容）。口内闸：直接构造 BrowserTool 过 check_permission
        // （无条件过闸 + 多层语义 + click/type_sensitive 二次 Ask——D4-4/D4-5，
        // 不构造 adapter：manifest 零 permission 无精确名寻址面）。
        // 返回 Text（37 action 全文本直通）。
        // ═══════════════════════════════════════════════════════
        "browser_cap" => {
            let action = req_str(&params, "action", "browser_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            commands::browser_cap::browser_cap(action, params, is_agent, agent_id, &state, &app)
                .await
        }

        // ═══════════════════════════════════════════════════════
        // uia_cap（R4，kernel-capability-d4-handle-design.md）——desktop 句柄域
        // 能力口直呼入口，不经 tool_call 信封 / PluginRegistry /
        // PluginToolAdapter（builtin.uia 插件随 R4-3 同批退役，无信封过渡面）。
        // action = 退役前 builtin.uia 17 工具名；参数顶层 snake_case（manifest
        // 键本就 snake，无映射）；is_agent/agent_id 显式传（_agent_id meta
        // 兼容）。口内闸：直接构造 DesktopTool 过 check_permission（无条件
        // 过闸 + 六层语义）；desktop_uia_write 的 resolve→classify→grant→
        // lease→审计全链在口内（INVARIANTS #13 铁律面，D4-4/D4-5）。
        // 返回 Text（17 action 全文本直通）。
        // ═══════════════════════════════════════════════════════
        "uia_cap" => {
            let action = req_str(&params, "action", "uia_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            commands::uia_cap::uia_cap(action, params, is_agent, agent_id, &state, &app).await
        }

        // ═══════════════════════════════════════════════════════
        // R4 小面清偿（kernel-capability-d4-handle-design.md §6 R4-4）——
        // web/constraints/pty/lsp 四族能力口直呼入口，不经 tool_call 信封 /
        // PluginRegistry / PluginToolAdapter（四插件同批退役，无信封过渡面）。
        // action = 退役前各插件工具名；参数顶层 snake_case；is_agent/agent_id
        // 统一契约键（四族无家族闸——web 的 WebFetchTool 口内无条件过闸，
        // constraints/pty/lsp 原语义 Passthrough）。均返回 Text。
        // ═══════════════════════════════════════════════════════
        "web_cap" => {
            let action = req_str(&params, "action", "web_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            commands::web_cap::web_cap(action, params, is_agent, agent_id, &state, &app).await
        }
        // （constraints_cap 分发臂随图谱全量退役删除，2026-09-09。）
        "pty_cap" => {
            let action = req_str(&params, "action", "pty_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            commands::pty_cap::pty_cap(action, params, is_agent, agent_id, &state, &app).await
        }
        "lsp_cap" => {
            let action = req_str(&params, "action", "lsp_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            commands::lsp_cap::lsp_cap(action, params, is_agent, agent_id, &state, &app).await
        }

        // ═══════════════════════════════════════════════════════
        // editor_cap（R4-4b，kernel-capability-d4-handle-design.md）——edit_file
        // 直呼入口（builtin.editor 插件随本批退役——R5 拆信封前最后在册插件，
        // 本批后 PluginRegistry 出厂清单为空）。action = edit_file 一位；参数
        // 顶层 snake（file_path/old_string/new_string/replace_all——TS execute
        // 层映射，_forceGate 模型面声明键原样透传）。口内闸（仅 Agent 路径，
        // dispatch adapter 原语义）：PluginToolAdapter Edit 家族 + 精确名
        // plugin:builtin.editor.edit_file（用户既有规则不失义）；业务免检解析
        // （闸在口内已过）+ checked_write_atomic 临界区原样。返回 Text。
        // ═══════════════════════════════════════════════════════
        "editor_cap" => {
            let action = req_str(&params, "action", "editor_cap")?;
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let agent_id = opt_str(&params, "agent_id").or_else(|| opt_str(&params, "_agent_id"));
            commands::editor_cap::editor_cap(action, params, is_agent, agent_id, &state, &app)
                .await
        }

        // ═══════════════════════════════════════════════════════
        // MCP / ACP stdio 桥（进程桥原语——stdio 行协议，与工具域无关）
        // ═══════════════════════════════════════════════════════
        "protocol_bridge_spawn" => {
            let id = req_str(&params, "id", "protocol_bridge_spawn")?;
            let command = req_str(&params, "command", "protocol_bridge_spawn")?;
            let args = req_strs(&params, "args", "protocol_bridge_spawn")?;
            // env 注入（app shell S2）：受治进程 spawn 的宿主寻址面（如
            // LANTAI_PLUGIN_DATA_DIR——插件数据目录路径，TS mcp-bridge 构造）。
            let env = opt_str_map(&params, "env")?;
            commands::protocol_bridge::protocol_bridge_spawn(id, command, args, env, app)
        }
        "protocol_bridge_write" => {
            let id = req_str(&params, "id", "protocol_bridge_write")?;
            let line = req_str(&params, "line", "protocol_bridge_write")?;
            commands::protocol_bridge::protocol_bridge_write(id, line)
        }
        "protocol_bridge_kill" => {
            let id = req_str(&params, "id", "protocol_bridge_kill")?;
            // 停止原因（#2）：宿主具名原因落 bridge.log——进程「为什么没的」可查。
            let reason = opt_str(&params, "reason");
            commands::protocol_bridge::protocol_bridge_kill(id, reason)
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
        // OAuth 订阅平面（Phase 3C，provider-refactor 方案乙）：device-code
        // 登录 / 账号管理 / 刷新 / 开浏览器。网络操作 async 直接 await；
        // 本地凭证操作走 spawn_blocking（DPAPI/文件 IO 不进异步 runtime）。
        // ═══════════════════════════════════════════════════════
        "oauth_start" => {
            let provider = req_str(&params, "provider", "oauth_start")?;
            ok_json(commands::oauth::oauth_start(&provider).await)
        }
        "oauth_poll" => {
            let provider = req_str(&params, "provider", "oauth_poll")?;
            let device_auth_id = req_str(&params, "device_auth_id", "oauth_poll")?;
            let user_code = req_str(&params, "user_code", "oauth_poll")?;
            ok_json(commands::oauth::oauth_poll(&provider, &device_auth_id, &user_code).await)
        }
        "oauth_accounts" => {
            let provider = req_str(&params, "provider", "oauth_accounts")?;
            let r = tokio::task::spawn_blocking(move || commands::oauth::oauth_accounts(&provider))
                .await
                .map_err(|e| format!("oauth_accounts 任务失败: {e}"))?;
            ok_json(r)
        }
        "oauth_access" => {
            let provider = req_str(&params, "provider", "oauth_access")?;
            let account_id = opt_str(&params, "account_id");
            ok_json(commands::oauth::oauth_access(&provider, account_id).await)
        }
        "oauth_logout" => {
            let provider = req_str(&params, "provider", "oauth_logout")?;
            let account_id = req_str(&params, "account_id", "oauth_logout")?;
            let r = tokio::task::spawn_blocking(move || commands::oauth::oauth_logout(&provider, &account_id))
                .await
                .map_err(|e| format!("oauth_logout 任务失败: {e}"))?;
            ok_unit(r)
        }
        "oauth_refresh" => {
            let provider = req_str(&params, "provider", "oauth_refresh")?;
            let account_id = req_str(&params, "account_id", "oauth_refresh")?;
            ok_json(commands::oauth::oauth_refresh(&provider, &account_id).await)
        }
        "open_external" => {
            let url = req_str(&params, "url", "open_external")?;
            let r = tokio::task::spawn_blocking(move || commands::oauth::open_external(&url))
                .await
                .map_err(|e| format!("open_external 任务失败: {e}"))?;
            ok_unit(r)
        }
        "llm_proxy_port" => Ok(crate::llm_proxy::proxy_port().to_string()),
        // 前端日志级别的壳侧提示（日志可观测性批 3）：`LANTAI_LOG_LEVEL` 环境变量。
        // WebView 读不到进程环境变量，而壳读得到——故经这一手递过去（空串 = 未设/
        // 认不出 ⇒ 前端回落 localStorage → 默认 info）。见 agent/logger.ts。
        "log_level_hint" => Ok(crate::logging::level_hint_from_env()),
        // 日志轮转（日志可观测性批 4）：把超过上限（8 MiB）的主日志滚代
        // （`.1`/`.2`，保 2 代；判据真源 = logging.rs 的 LOG_MAX_BYTES/LOG_KEEP，
        // bridge/boot 同一套）。前端 logger 例行触发（ui.log 越限时），只作用于
        // `.lantai/logs/<name>.log`——口内先做路径形状围栏（is_rotatable_log），
        // 防被当成「删任意文件副本」的入口。未越限 = rotated:false（不是错误）；
        // 滚代失败带步骤与原因（失败可见，调用方落面）。
        "log_rotate" => {
            let p = req_str(&params, "path", "log_rotate")?;
            let real = crate::utils::resolve_write_dispatch(&p, false, None, &state, &app).await?;
            if !crate::logging::is_rotatable_log(&real) {
                return Err(format!("log_rotate: 只接受 .lantai/logs/ 下的 .log 文件（收到 {p}）"));
            }
            let r = tokio::task::spawn_blocking(move || {
                crate::logging::rotate_if_large(&real, crate::logging::LOG_MAX_BYTES, crate::logging::LOG_KEEP)
            })
            .await
            .map_err(|e| format!("log_rotate 任务失败: {e}"))?;
            let (rotated, size_before) = r?;
            ok_json(Ok(serde_json::json!({
                "rotated": rotated,
                "size_before": size_before,
                "path": p,
            })))
        }

        // ═══════════════════════════════════════════════════════
        // 插件安装通道（3 个命令，S4-3）：npm tarball 源 / 本地目录 → 下载/解包/
        // tar-slip 防护/原子落盘；卸载/禁用走 plugins.json 读改写。
        // 生效时机（D6，2026-08-27）：Rust 侧只管盘面与进程；前端在 RPC 落盘
        // 成功后即时装卸插件 fiber——装/卸/启/禁运行时生效（工具面下次装配）。
        // ═══════════════════════════════════════════════════════
        "plugin_install" => {
            let source = commands::plugin_install::PluginSource::from_params(&params)?;
            let expect_name = opt_str(&params, "expect_name");
            // force = true 跳过版本守卫（降级/同版本覆盖安装——显式逃生门，P3）
            let force = opt_bool(&params, "force").unwrap_or(false);
            // 本地目录源走复制路径；registry/tarball 走下载+解包路径
            let name = match source {
                commands::plugin_install::PluginSource::LocalDir(dir) => {
                    commands::plugin_install::plugin_install_local_dir(dir, expect_name, force).await?
                }
                other => commands::plugin_install::plugin_install(other, expect_name, force).await?,
            };
            ok_json(Ok(name))
        }
        "plugin_uninstall" => {
            let name = req_str(&params, "name", "plugin_uninstall")?;
            let r = tokio::task::spawn_blocking(move || commands::plugin_install::plugin_uninstall(&name))
                .await
                .map_err(|e| format!("plugin_uninstall 任务失败: {e}"))?;
            ok_unit(r)
        }
        "plugin_dir" => {
            let name = req_str(&params, "name", "plugin_dir")?;
            let r = tokio::task::spawn_blocking(move || commands::plugin_install::plugin_dir(&name))
                .await
                .map_err(|e| format!("plugin_dir 任务失败: {e}"))?;
            ok_json(r)
        }
        // 随包图谱引擎探测（engine-bundled-mcp-distribution，2026-09-16）：纯只读
        // 探测安装目录里的 hologram-engine.exe，不启动进程。前端 plugins/
        // bundled-engine.ts 消费（拿路径与安装目录锚点接 MCP 通道）。
        // spawn_blocking：canonicalize/is_file 是阻塞 IO。
        "engine_bundled_info" => {
            let r = tokio::task::spawn_blocking(|| {
                let path = crate::engine_assets::engine_exe_path();
                let dir = crate::engine_assets::install_dir();
                serde_json::json!({
                    "path": path.map(|p| p.to_string_lossy().to_string()),
                    "dir": dir.map(|d| d.to_string_lossy().to_string()),
                    "available": crate::engine_assets::engine_available(),
                })
            })
            .await
            .map_err(|e| format!("engine_bundled_info 任务失败: {e}"))?;
            ok_json(Ok(r))
        }
        "plugin_set_enabled" => {
            let name = req_str(&params, "name", "plugin_set_enabled")?;
            let enabled = match params.get("enabled") {
                Some(v) => v.as_bool().ok_or_else(|| format!("参数 'enabled' 必须是布尔值，收到: {v}"))?,
                None => return Err("参数 'enabled' 缺失 — 必须明确指定启用或禁用".to_string()),
            };
            let r = tokio::task::spawn_blocking(move || commands::plugin_install::plugin_set_enabled(&name, enabled))
                .await
                .map_err(|e| format!("plugin_set_enabled 任务失败: {e}"))?;
            ok_unit(r)
        }
        // P-1 authoring 环境（2026-09-14）：组合目录路径 + 按需创建（可选打开）。
        // 路径只来自服务端计算（composition_root_public）——无调用方路径参数。
        //
        // ⚠ 路径是**裸文本**返回（2026-09-24 真机修）：这里原用 `ok_json(r)`，而
        // `r: Result<String, _>` ⇒ `ok_json` 把 String 序列化成**带引号的 JSON 文本**
        // （`"C:\\Users\\…"`）；契约声明的是 `result: string`、前端按裸串直读（`typedRpc`，
        // 非 `typedJsonRpc`）⇒ 读到带引号的串、路径判据当场失败。同族症状见
        // `providers_dir`（provider YAML 通道被降级成内置存储）。裸串返回即正解。
        "composition_dir" => {
            let open = matches!(params.get("open"), Some(v) if v.as_bool().unwrap_or(false));
            tokio::task::spawn_blocking(move || commands::composition::composition_dir(open))
                .await
                .map_err(|e| format!("composition_dir 任务失败: {e}"))?
        }
        // provider 配置文件地基通道：配置文件（providers.yml）所在目录路径 +
        // 按需创建（可选打开）。路径只来自服务端计算（providers_file_public）
        // ——无调用方路径参数；文件内容写入走 fs_cap（沙箱放行这一个文件）。
        // ⚠ 裸文本返回（同 `composition_dir`——别改回 `ok_json`）。
        "providers_dir" => {
            let open = matches!(params.get("open"), Some(v) if v.as_bool().unwrap_or(false));
            tokio::task::spawn_blocking(move || commands::providers::providers_dir(open))
                .await
                .map_err(|e| format!("providers_dir 任务失败: {e}"))?
        }

        // ═══════════════════════════════════════════════════════
        // 插件数据目录（app shell 四件套 · 件 B，S1，5 个命令）：manifest.dataDir
        // 插件的专属数据地盘——装载期 loader 调 ensure 分配（幂等）；读写列删经
        // 宿主桥 fs 面（window.__lantai_plugin_host__.fs）；卸载回收是
        // plugin_uninstall 内钩（数据挪 .trash，不在本表）。路径双围栏 +
        // canonicalize 前缀锁死 <dataRoot>/<插件名>/（命令体 commands/
        // plugin_data.rs——越界/junction 逃逸拒绝，测试钉死）。
        // ═══════════════════════════════════════════════════════
        "plugin_data_ensure" => {
            let name = req_str(&params, "name", "plugin_data_ensure")?;
            let r = tokio::task::spawn_blocking(move || commands::plugin_data::plugin_data_ensure(&name))
                .await
                .map_err(|e| format!("plugin_data_ensure 任务失败: {e}"))?;
            ok_json(r)
        }
        "plugin_data_list" => {
            let name = req_str(&params, "name", "plugin_data_list")?;
            let path = opt_str(&params, "path").unwrap_or_default();
            let r = tokio::task::spawn_blocking(move || commands::plugin_data::plugin_data_list(&name, &path))
                .await
                .map_err(|e| format!("plugin_data_list 任务失败: {e}"))?;
            ok_json(r)
        }
        "plugin_data_read" => {
            let name = req_str(&params, "name", "plugin_data_read")?;
            let path = req_str(&params, "path", "plugin_data_read")?;
            tokio::task::spawn_blocking(move || commands::plugin_data::plugin_data_read(&name, &path))
                .await
                .map_err(|e| format!("plugin_data_read 任务失败: {e}"))?
        }
        "plugin_data_write" => {
            let name = req_str(&params, "name", "plugin_data_write")?;
            let path = req_str(&params, "path", "plugin_data_write")?;
            let content = req_str(&params, "content", "plugin_data_write")?;
            let r = tokio::task::spawn_blocking(move || commands::plugin_data::plugin_data_write(&name, &path, &content))
                .await
                .map_err(|e| format!("plugin_data_write 任务失败: {e}"))?;
            ok_unit(r)
        }
        "plugin_data_delete" => {
            let name = req_str(&params, "name", "plugin_data_delete")?;
            let path = req_str(&params, "path", "plugin_data_delete")?;
            let r = tokio::task::spawn_blocking(move || commands::plugin_data::plugin_data_delete(&name, &path))
                .await
                .map_err(|e| format!("plugin_data_delete 任务失败: {e}"))?;
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
        // 外部服务（sandbox_status；MCP server 生命周期面已随 legacy
        // McpManager 退役——引擎消费接线在前端 TS 侧，壳内零传输层）
        // ═══════════════════════════════════════════════════════
        "sandbox_status" => commands::external::sandbox_status(),

        // （hologram_run_check 随图谱全量退役删除，2026-09-09。）

        // ═══════════════════════════════════════════════════════
        // 工作区
        // ═══════════════════════════════════════════════════════
        "workspace_activate" => {
            let path = req_str(&params, "path", "workspace_activate")?;
            ok_unit(commands::workspace::workspace_activate(path, state, app_ctx).await)
        }
        "workspace_deactivate" => {
            ok_unit(commands::workspace::workspace_deactivate(state, app_ctx).await)
        }
        // get_last_project：Option<String> serde 序列化，恒 "path"/null JSON
        //（credential_get 同款）。
        "get_last_project" => {
            let r = tokio::task::spawn_blocking(commands::workspace::get_last_project)
                .await
                .map_err(|e| format!("get_last_project 任务失败: {e}"))?;
            ok_json(r)
        }
        // ── 已知工作区注册表（Stage-5 补尾：首页工作区管理）──
        "workspace_list" => {
            let r = tokio::task::spawn_blocking(commands::workspace::registry::list)
                .await
                .map_err(|e| format!("workspace_list 任务失败: {e}"))?
                .map_err(|e| format!("workspace_list: {e}"))?;
            ok_json(Ok(r))
        }
        "workspace_rename" => {
            let path = req_str(&params, "path", "workspace_rename")?;
            let name = req_str(&params, "name", "workspace_rename")?;
            let res = tokio::task::spawn_blocking(move || commands::workspace::registry::rename(&path, name))
                .await
                .map_err(|e| format!("workspace_rename 任务失败: {e}"))?;
            ok_unit(res)
        }
        "workspace_toggle_pin" => {
            let path = req_str(&params, "path", "workspace_toggle_pin")?;
            let pinned = req_bool(&params, "pinned", "workspace_toggle_pin")?;
            let res = tokio::task::spawn_blocking(move || commands::workspace::registry::toggle_pin(&path, pinned))
                .await
                .map_err(|e| format!("workspace_toggle_pin 任务失败: {e}"))?;
            ok_unit(res)
        }
        "workspace_remove" => {
            let path = req_str(&params, "path", "workspace_remove")?;
            let res = tokio::task::spawn_blocking(move || commands::workspace::registry::remove(&path))
                .await
                .map_err(|e| format!("workspace_remove 任务失败: {e}"))?;
            ok_unit(res)
        }
        // （workspace_set_graph_engine 随图谱全量退役删除，2026-09-09。）
        // 新建工作区目录（2026-08-31 首页 sheet「创建」路径）：
        // ~/Documents/兰台/<名字>，返回归一化路径字符串。
        "workspace_create_dir" => {
            let name = req_str(&params, "name", "workspace_create_dir")?;
            let res = tokio::task::spawn_blocking(move || commands::workspace::create_default_workspace_dir(&name))
                .await
                .map_err(|e| format!("workspace_create_dir 任务失败: {e}"))?;
            ok_json(res)
        }

        // ═══════════════════════════════════════════════════════
        // 会话持久化（1 个命令）
        // （workspace-session-ownership-rework 2026-08-27：chat 会话 NDJSON
        //  session_append 已拆——只写不读孤儿路径；唯一保留路径 = 工作区会话根
        //  全量快照，由前端 write_file_content 写 {ws}/.lantai/sessions/{id}.json。）
        // ═══════════════════════════════════════════════════════

        // P1-15: agent 会话增量追加（NDJSON）— 与 session_append 同构，但写到
        // .lantai/agents/{agent_id}/session.ndjson。rewrite=true 时 truncate 重写
        // （会话被撤回/替换后全量重建），否则 append-only（每轮对话只写增量，
        // 消除旧 saveState 全量重写 session.json 的 O(全量) 写放大）。
        "agent_session_append" => {
            let project_path = req_str(&params, "project_path", "agent_session_append")?;
            let agent_id = req_str(&params, "agent_id", "agent_session_append")?;
            let messages = params
                .get("messages")
                .ok_or("agent_session_append: missing 'messages'")?;
            let rewrite = params
                .get("rewrite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            ok_unit(agent_session_append(&project_path, &agent_id, messages, rewrite))
        }

        // （数据流命令族（dataflow_save / dataflow_query / dataflow_delete）随
        //  图谱全量退役删除，2026-09-09——engine-domain 插件与 .lantai/dataflow
        //  壳侧存储一并退役。）



        _ => Err(format!("rpc: unknown method '{}'", method)),
    }
}

// ═══════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::{dispatch_result_to_value, guard_panic, panic_to_rpc_error, rpc_result_shape, str_to_value, RpcResultShape};
    use serde_json::json;

    /// 回归（edit 偶发挂死家族）：命令体 panic 必须变成 Err 回包，
    /// 而不是让 panic 逃逸——逃逸时 Tauri resolver 被丢弃，前端
    /// invoke promise 永久挂起且无日志。
    #[tokio::test]
    async fn guard_panic_converts_panic_to_err_response() {
        let out = guard_panic(async {
            // 模拟命令体里的字节切片 panic（与 editor.rs 旧 bug 同型）：
            // 4 字节 ASCII 前缀 + CJK，字节 60 落在字符中间。
            // 注意纯 "中".repeat(30) 的字节 60 恰好对齐边界，不会 panic。
            let s = format!("// ab{}", "中".repeat(30));
            let _ = &s[..60];
            Ok::<String, String>("unreachable".to_string())
        })
        .await;
        let err = out.expect_err("panic 必须转为 Err 回包");
        assert!(err.contains("panic"), "错误应说明是命令内部 panic: {err}");
    }

    #[tokio::test]
    async fn guard_panic_passes_through_ok_and_err() {
        assert_eq!(guard_panic(async { Ok("ok".to_string()) }).await.unwrap(), "ok");
        assert_eq!(
            guard_panic(async { Err("业务错误".to_string()) }).await.unwrap_err(),
            "业务错误"
        );
    }

    #[test]
    fn panic_to_rpc_error_extracts_string_payload() {
        let msg = panic_to_rpc_error(Box::new("byte index 60 is not a char boundary".to_string()));
        assert!(msg.contains("命令内部错误"));
        assert!(msg.contains("char boundary"));
    }

    /// rpc 返回值 Value 化回归（landmine 根治级，2026-08-22）：
    /// 出口包装契约——纯包 Value::String，零 parse。字节精确是铁律：
    /// read_file_content 读 JSON 文件时前端必须拿到原文，不能被出口
    /// 误展开成结构化值；JSON 展开分派在前端 typedRpc 按契约进行。
    #[test]
    fn str_to_value_wraps_verbatim_never_parses() {
        // JSON 对象形状的文本也必须原样保留（字节精确）
        assert_eq!(
            str_to_value(r#"{"ok":true,"n":3}"#.to_string()),
            serde_json::Value::String(r#"{"ok":true,"n":3}"#.to_string())
        );
        // ok_unit 的 "null" 同样原样（前端 typedRpc 负责解）
        assert_eq!(str_to_value("null".to_string()), serde_json::Value::String("null".to_string()));
        // 空串、多行文本、带 BOM/控制字符的文本一律字节精确
        assert_eq!(str_to_value(String::new()), serde_json::Value::String(String::new()));
        let cjk = "中文内容\n第二行";
        assert_eq!(str_to_value(cjk.to_string()), serde_json::Value::String(cjk.to_string()));
    }

    /// Value 化第二步（B 路线，2026-08-22）：出口分派——JsonValue 命令 Ok
    /// 路径 parse 成真结构化 Value；Text 命令字节精确包 Value::String；
    /// Err 路径拒绝展开、原样传播（前端 catch 语义不变）。
    /// 贴错标签的两个方向都在这里钉死：Text 命令误标 JsonValue 会把字节
    /// 精确的文本当成 JSON 展开（错误）；JsonValue 命令误标 Text 只会
    /// 退化为慢路径（正确性不受影响）——分类偏保守的依据。
    #[test]
    fn dispatch_result_to_value_shapes() {
        use serde_json::json;
        // 形态表钉死：小样命令 = JsonValue，未列命令默认 Text
        // （shell_env / exec_command 已随 builtin.shell 迁 tool_call 退表——
        //  workspace_list 接任 JsonValue 小样，kernel-plugin-runtime P2-4；
        //  图命令族（load_graph_json 等）已随图谱退役退表，2026-09-09——
        //  get_graph_meta/get_graph_page 断言改为「未列命令默认 Text」的同型小样）
        assert_eq!(rpc_result_shape("workspace_list"), RpcResultShape::JsonValue);
        // 随包引擎探测（2026-09-24 补断言）：恒 JSON 对象 ⇒ 必须展开为 Value。
        // 漏登记会把 JSON 当字符串直通，前端读 `raw.available` 恒 false ⇒
        // 设置页开关置灰「拨不开」（实机缺陷；TS 侧对拍守卫见
        // src-ui/tests/rpc-json-shape-consistency.test.ts）。
        assert_eq!(
            rpc_result_shape("engine_bundled_info"),
            RpcResultShape::JsonValue
        );
        assert_eq!(rpc_result_shape("load_graph_json"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("get_graph_snapshot"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("hologram_file_nodes"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("get_graph_meta"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("get_graph_page"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("exec_command"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("anything_else"), RpcResultShape::Text);
        // JsonValue 命令：真结构化展开（小样 workspace_list）
        let v = dispatch_result_to_value("workspace_list", Ok(r#"{"bundled":true}"#.into())).unwrap();
        assert_eq!(v, json!({"bundled": true}));
        let v = dispatch_result_to_value("workspace_list", Ok(r#"{"total_nodes":42}"#.into())).unwrap();
        assert_eq!(v, json!({"total_nodes": 42}));
        let bad = dispatch_result_to_value("workspace_list", Ok("not json".into()));
        assert!(bad.is_err(), "JsonValue 命令 Ok 输出非合法 JSON 必须转 Err");
        // Text 命令（含默认路径）：字节精确，JSON 形状的文本也不展开
        // （exec_command 已退表——按未列命令默认 Text 走，仍可当 Text 小样）
        let raw = r#"{"looks":"like json"}"#;
        let v = dispatch_result_to_value("exec_command", Ok(raw.into())).unwrap();
        assert_eq!(v, serde_json::Value::String(raw.to_string()));
        let v = dispatch_result_to_value("unlisted_unknown_cmd", Ok(raw.into())).unwrap();
        assert_eq!(v, serde_json::Value::String(raw.to_string()));
        // Err 路径：原样传播，不包 Ok（前端 catch 语义不变）
        let e = dispatch_result_to_value("workspace_list", Err("boom".into()));
        assert_eq!(e, Err("boom".to_string()));
        let e = dispatch_result_to_value("exec_command", Err("boom".into()));
        assert_eq!(e, Err("boom".to_string()));
        let e = dispatch_result_to_value("read_file_content", Err("boom".into()));
        assert_eq!(e, Err("boom".to_string()));
    }

    // ═══════════════════════════════════════════════════════════════
    // 会话持久化行为序列钉测（2026-09-02 平台补课 Phase 2）——
    // agent_session_append 是 .lantai/agents/{agent_id}/session.ndjson
    // 的唯一落盘实现；以下断言当前真实行为，不美化。
    // ═══════════════════════════════════════════════════════════════

    use super::agent_session_append;

    /// 每测独立的临时项目根（isolation.rs spill 测试同款模式）。
    fn session_test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hologram_rpc_session_test_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn session_file(project: &std::path::Path, agent_id: &str) -> std::path::PathBuf {
        project
            .join(".lantai/agents")
            .join(agent_id)
            .join("session.ndjson")
    }

    /// ① 保存 → 重新加载 → 内容一致（round-trip）。
    /// NDJSON 契约：每条消息一行合法 JSON、行尾换行；重载按行 parse。
    #[test]
    fn agent_session_round_trip_preserves_messages() {
        let project = session_test_dir("roundtrip");
        let messages = json!([
            { "role": "user", "content": "你好，兰台" },
            { "role": "assistant", "content": "收到", "tool_calls": [] }
        ]);
        agent_session_append(project.to_str().unwrap(), "agent-rt", &messages, false).unwrap();

        let content = std::fs::read_to_string(session_file(&project, "agent-rt")).unwrap();
        assert!(content.ends_with('\n'), "NDJSON 每行以换行结尾");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2, "两条消息两行");
        for (i, line) in lines.iter().enumerate() {
            let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(parsed, messages[i], "重载内容与保存内容逐字节等价");
        }
        let _ = std::fs::remove_dir_all(&project);
    }

    /// ② 空会话（空消息数组）与仅元数据会话可正常保存/加载。
    #[test]
    fn agent_session_empty_and_metadata_only_round_trip() {
        let project = session_test_dir("emptymeta");

        // 空消息数组：文件被创建（OpenOptions create）但零行——不报错
        agent_session_append(project.to_str().unwrap(), "agent-empty", &json!([]), false).unwrap();
        let empty_file = session_file(&project, "agent-empty");
        assert!(empty_file.exists(), "空会话也要落盘建文件");
        assert_eq!(
            std::fs::read_to_string(&empty_file).unwrap(),
            "",
            "空会话 = 零字节文件"
        );

        // 仅元数据（单条 system 消息）的会话 round-trip
        let meta = json!([{ "role": "system", "content": "meta only" }]);
        agent_session_append(project.to_str().unwrap(), "agent-meta", &meta, false).unwrap();
        let content = std::fs::read_to_string(session_file(&project, "agent-meta")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed, meta[0]);
        let _ = std::fs::remove_dir_all(&project);
    }

    /// ③ 损坏 JSON 文件 → 现状恢复路径（不美化）：
    /// 追加路径不解析、不清洗既有内容——
    ///   场景 A（损坏带尾换行）：垃圾字节原样保留，新合法行续尾；
    ///   场景 B（损坏不带尾换行）：新记录与垃圾尾熔接成非法行（现状不补换行）；
    ///   真恢复 = rewrite=true 截断重写（前端全量重建）。
    #[test]
    fn agent_session_corrupted_file_tolerated_on_append_rebuilt_on_rewrite() {
        let project = session_test_dir("corrupt");

        // 场景 A：损坏带尾换行
        let file = session_file(&project, "agent-c");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "not json at all\n").unwrap();
        agent_session_append(
            project.to_str().unwrap(),
            "agent-c",
            &json!([{ "role": "user", "content": "after corruption" }]),
            false,
        )
        .unwrap();
        let content = std::fs::read_to_string(&file).unwrap();
        assert!(
            content.starts_with("not json at all\n"),
            "损坏字节必须原样保留（现状不清洗）"
        );
        let last_line = content.lines().last().unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(last_line).is_ok(),
            "新增行仍是合法 JSON：{last_line}"
        );

        // 场景 B：损坏不带尾换行 → 熔接
        let fused = session_file(&project, "agent-f");
        std::fs::create_dir_all(fused.parent().unwrap()).unwrap();
        std::fs::write(&fused, "{\"broken\": ").unwrap();
        agent_session_append(
            project.to_str().unwrap(),
            "agent-f",
            &json!([{ "role": "user", "content": "fused" }]),
            false,
        )
        .unwrap();
        let fused_content = std::fs::read_to_string(&fused).unwrap();
        let fused_line = fused_content.lines().last().unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(fused_line).is_err(),
            "现状：无尾换行的损坏文件会把新记录熔接成非法行（不补换行）：{fused_line}"
        );

        // 恢复路径 = rewrite=true 截断重写：损坏历史被清除
        agent_session_append(
            project.to_str().unwrap(),
            "agent-c",
            &json!([{ "role": "user", "content": "rebuilt" }]),
            true,
        )
        .unwrap();
        let rebuilt = std::fs::read_to_string(&file).unwrap();
        assert_eq!(rebuilt.lines().count(), 1, "rewrite 后只剩新内容");
        assert!(rebuilt.contains("rebuilt"));
        assert!(!rebuilt.contains("not json"), "损坏历史被截断清除");
        let _ = std::fs::remove_dir_all(&project);
    }

    /// ④ 并发写入 → 现状完整性（无进程内锁）：
    /// 并发安全完全依赖 OS 追加句柄语义——Windows FILE_APPEND_DATA 下每次
    /// WriteFile 原子续尾（本测试每行为一次 write_all，小缓冲单次系统调用
    /// 即完成），因此字节零丢失、标记零丢失、换行数守恒；行级原子性（一条
    /// 消息的 line 与 \n 两次 write_all 之间可能被他线程插入）不保证——故
    /// 不断言行结构，只断言字节面完整性。
    #[test]
    fn agent_session_concurrent_appends_preserve_all_bytes() {
        let project = session_test_dir("concurrent");
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let project = project.clone();
                std::thread::spawn(move || {
                    for j in 0..10 {
                        let msg = json!({ "thread": t, "seq": j, "marker": format!("M{t:02}x{j:02}") });
                        agent_session_append(
                            project.to_str().unwrap(),
                            "agent-cc",
                            &json!([msg]),
                            false,
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for h in threads {
            h.join().unwrap();
        }

        let content = std::fs::read_to_string(session_file(&project, "agent-cc")).unwrap();
        for t in 0..8 {
            for j in 0..10 {
                let marker = format!("\"M{t:02}x{j:02}\"");
                assert!(content.contains(&marker), "标记 {marker} 字节丢失");
            }
        }
        assert_eq!(
            content.matches('\n').count(),
            80,
            "80 次追加 = 80 个换行（零丢字节）"
        );
        let _ = std::fs::remove_dir_all(&project);
    }

    /// ⑤ 同会话重复保存：append 累积、rewrite=true 覆盖（truncate）。
    #[test]
    fn agent_session_repeat_save_append_accumulates_rewrite_overwrites() {
        let project = session_test_dir("overwrite");

        // 追加语义：历史行累积不丢
        agent_session_append(project.to_str().unwrap(), "agent-o", &json!([{ "role": "user", "content": "first" }]), false).unwrap();
        agent_session_append(project.to_str().unwrap(), "agent-o", &json!([{ "role": "assistant", "content": "second" }]), false).unwrap();
        let content = std::fs::read_to_string(session_file(&project, "agent-o")).unwrap();
        assert_eq!(content.lines().count(), 2, "重复保存（append）= 历史累积");
        assert!(content.contains("first") && content.contains("second"));

        // 覆盖语义：rewrite=true → File::create 截断重写
        agent_session_append(project.to_str().unwrap(), "agent-o", &json!([{ "role": "user", "content": "third" }]), true).unwrap();
        let content = std::fs::read_to_string(session_file(&project, "agent-o")).unwrap();
        assert_eq!(content.lines().count(), 1, "rewrite 保存 = 覆盖");
        assert!(content.contains("third"));
        assert!(!content.contains("first"), "旧历史被覆盖清除");
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 附加钉：持久化入口的路径穿越守卫（sanitize_path_id）——
    /// agent_id 含 / \\ .. \0 一律拒绝，不落盘、不建目录。
    #[test]
    fn agent_session_rejects_path_traversal_agent_id() {
        let project = session_test_dir("traversal");
        let err = agent_session_append(
            project.to_str().unwrap(),
            "../evil",
            &json!([{ "role": "user", "content": "x" }]),
            false,
        )
        .unwrap_err();
        assert!(err.contains("非法字符"), "穿越 agent_id 必须拒绝: {err}");
        assert!(
            !project.join(".lantai/agents").exists(),
            "拒绝时不得创建任何目录"
        );
        let _ = std::fs::remove_dir_all(&project);
    }
}
