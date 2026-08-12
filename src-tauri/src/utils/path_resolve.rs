// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 路径解析 + 权限检查（从 utils.rs 拆出）

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::permissions;
use crate::permissions::{PermissionContext, PermissionDecision, has_permission_to_use_tool, register_ask};
use crate::tools;
use crate::workspace;

/// 查找 Rust 引擎可执行文件。
/// 检查顺序：1) HOLOGRAM_ENGINE 环境变量  2) engine/target/release  3) engine/target/debug
pub(crate) fn engine_binary() -> String {
    if let Ok(p) = std::env::var("HOLOGRAM_ENGINE") {
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    let root = project_root();
    let paths = [
        // 打包资源：engine.exe 放在应用二进制文件旁边
        root.join("hologram-engine.exe"),
        // 开发布局：引擎构建在 engine/target/
        root.join("engine/target/release/hologram-engine.exe"),
        root.join("engine/target/debug/hologram-engine.exe"),
    ];
    for p in &paths {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    // 回退：默认 debug 路径
    project_root().join("engine/target/debug/hologram-engine.exe")
        .to_string_lossy().to_string()
}

pub(crate) fn project_root() -> PathBuf {
    // 生产环境（已安装应用）：使用 exe 所在目录 — python/ 和 src_python/ 打包在旁边
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir_str = dir.to_string_lossy();
            // 路径中含 "target" = cargo 构建目录 → 开发模式；否则为已安装应用
            if !dir_str.contains("target") {
                return dir.to_path_buf();
            }
        }
    }
    // 开发模式：CARGO_MANIFEST_DIR 是 src-tauri/，项目根目录在上一级
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(PathBuf::from(".").as_path())
        .to_path_buf()
}

/// 设置活动工作区 — 现为空操作桩函数。请改用 workspace_activate。
/// 仅为 API 兼容性保留；前端不会直接调用此函数。

type WorkspaceState = Arc<Mutex<Option<workspace::WorkspaceHandle>>>;

/// 辅助函数：从 WorkspaceHandle 状态获取活动工作区路径。
/// 若未打开工作区则返回错误（而非静默回退到全局变量）。
pub(crate) fn workspace_path(state: &WorkspaceState) -> Result<String, String> {
    state.lock()
        .map_err(|e| format!("工作区状态错误: {e}"))?
        .as_ref()
        .map(|h| h.path.clone())
        .ok_or_else(|| "未打开工作区，请先打开项目".into())
}

/// 拒绝可能用于路径穿越的 ID。
/// 允许字母数字、连字符、下划线、点、冒号和空格。
pub(crate) fn sanitize_path_id(id: &str, label: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err(format!("{label} 不能为空"));
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") || id.contains('\0') {
        return Err(format!("{label} 包含非法字符"));
    }
    Ok(())
}

/// 验证路径是否在某个项目根目录的 `.hologram` 目录内。
/// 拒绝 `..` 穿越和 hologram 工作区之外的路径。
pub(crate) fn validate_hologram_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("路径包含非法字符".into());
    }
    let canonical = std::path::Path::new(path);
    let normalized = canonical.to_string_lossy().replace('\\', "/");
    if normalized.contains("/../") || normalized.starts_with("../") || normalized.ends_with("/..") {
        return Err("路径包含目录穿越序列".into());
    }
    if !normalized.contains(".hologram") {
        return Err("路径不在 .hologram 目录范围内".into());
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════
// Phase 2：权限辅助函数（2026-08-04：with_workspace 已删 — 全库零调用）

/// 从工作区状态获取 PermissionContext，并立即释放锁。
pub(crate) fn get_ctx(state: &WorkspaceState) -> Result<Arc<PermissionContext>, String> {
    let guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
    let handle = guard.as_ref().ok_or("未打开工作区，请先打开项目")?;
    Ok(handle.permission_ctx.clone())
}

/// 检查 MCP/图工具权限 — deny + ask + allow + 安全检查。
/// MCP 工具是只读的；只有明确的 deny 规则才会阻止它们。
/// 无工作区 = 无规则 = 放行（允许 hologram_status 等诊断工具通过）。
pub(crate) fn check_mcp_permission(
    tool_name: &str,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    // ponytail: 无工作区 = 无 .hologram/permissions.json = 无自定义规则，放行。
    let ctx = match get_ctx(state) {
        Ok(ctx) => ctx,
        Err(_) => return Ok(()),
    };
    let rules = ctx.read_rules();

    // ① 工具级 Deny — 最高优先级
    if let Some(rule) = rules.find_deny(tool_name, None) {
        let reason = format!("{} 工具被规则禁止使用", rule.explain());
        drop(rules);
        ctx.audit_deny(tool_name, "", &reason);
        return Err(reason);
    }

    // ② 工具级 Ask — 强制弹窗确认（此前对 MCP 工具忽略此项）
    if let Some(rule) = rules.find_ask(tool_name, None) {
        // yolo 模式：Ask 一律自动放行（同步路径无前端弹窗可等）
        if permissions::current_permission_mode() == permissions::PermissionMode::Yolo {
            return Ok(());
        }
        let reason = rule.explain();
        drop(rules);
        return Err(format!("{} 工具需要用户确认: {}", tool_name, reason));
    }

    // ③ 工具级 Allow — 明确允许
    if rules.find_allow(tool_name, None).is_some() {
        return Ok(());
    }

    // ④ 无规则匹配 → 放行
    Ok(())
}

/// 检查工具权限。若为 Ask，则发送事件并等待用户响应。
pub(crate) async fn check_permission(
    tool: &dyn permissions::Tool,
    ctx: &PermissionContext,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    match has_permission_to_use_tool(tool, ctx) {
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Deny { reason } => Err(reason),
        PermissionDecision::Ask { request_id, reason, suggestions, danger } => {
            let _ = app.emit("permission-ask", serde_json::json!({
                "requestId": request_id,
                "tool": tool.name(),
                "path": tool.get_path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                "reason": reason,
                "danger": danger,
                "agentId": tool.agent_id(),
                "suggestions": suggestions.iter().map(|s| serde_json::json!({
                    "rule": s.rule,
                    "behavior": s.behavior,
                })).collect::<Vec<_>>(),
            }));
            let rx = register_ask(request_id.clone());
            match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
                Ok(Ok(true)) => Ok(()),
                Ok(Ok(false)) | Ok(Err(_)) => Err("用户拒绝了此操作".into()),
                Err(_) => {
                    // ⚡ 2026-08-04 状态治理：超时后移除残留的 Sender，
                    // 防止 PENDING_ASKS 只增不减地泄漏。
                    crate::permissions::remove_ask(&request_id);
                    Err("权限请求超时".into())
                }
            }
        }
    }
}

/// 同步检查权限（无 Await — 用于后台任务：Ask → 记录日志 + 拒绝并给出明确原因）。
/// 权限模式旁路（与前端 permission-ask 旁路对齐）：yolo → 全部 Ask 自动放行；
/// auto → 白名单工具放行。仅旁路 Ask — Deny（Critical 危险）始终拒绝。
pub(crate) fn check_permission_sync(
    tool: &dyn permissions::Tool,
    ctx: &PermissionContext,
) -> Result<(), String> {
    match has_permission_to_use_tool(tool, ctx) {
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Deny { reason } => Err(reason),
        PermissionDecision::Ask { reason, suggestions, .. } => {
            let target = tool
                .get_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let mode = permissions::current_permission_mode();
            if mode == permissions::PermissionMode::Yolo
                || (mode == permissions::PermissionMode::Auto
                    && permissions::auto_mode_allows(tool.name()))
            {
                ctx.audit_allow(tool.name(), &target);
                return Ok(());
            }
            ctx.audit_deny(tool.name(), &target, &format!("后台任务无法交互，自动拒绝: {}", reason));
            let hint = match suggestions.first() {
                Some(s) => format!("\n建议在 .hologram/permissions.json 添加: \"allow\": [\"{}\"]", s.rule),
                None => String::new(),
            };
            Err(format!("后台任务需要用户确认但无法交互: {}。请将对应操作加入 allow 规则或使用前台 Agent 执行。{}", reason, hint))
        }
    }
}

pub(crate) async fn require_read(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::ReadTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission(&tool, &ctx, app).await?;
    // 权限已授予 — 沙箱已在 check_permission 内部检查过。
    // 不再重复检查沙箱边界；用户批准的外部读取必须放行。
    std::fs::canonicalize(&physical)
        .map_err(|e| format!("无法解析路径 {}: {}", physical_str, e))
}

pub(crate) async fn require_write(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::EditTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission(&tool, &ctx, app).await?;
    ctx.resolve_write(&physical_str)
}

/// ponytail: 用户 UI 操作的路径解析 — 只做 forward-map + sandbox resolve,
/// 不检查权限规则. 权限系统是给 Agent 的, 用户在 UI 上的操作不受权限限制.
/// safety check 仍然保留在写路径 (防误操作系统文件).
pub(crate) fn resolve_path_user_read(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), None);
    let physical_str = physical.to_string_lossy().to_string();
    ctx.resolve_read(&physical_str)
}

pub(crate) fn resolve_path_user_write(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), None);
    let physical_str = physical.to_string_lossy().to_string();
    ctx.resolve_write(&physical_str)
}

/// ponytail: 根据 is_agent 标志选择路径解析方式 — Agent 走权限检查(弹 Ask), UI 只解析.
/// 前端必须发 isAgent(camelCase) 匹配 Rust 参数 is_agent; 旧的 _agent 因 Tauri 默认
/// camelCase 重命名永远对不上, 导致 agent 外部读走 user 路径被沙箱静默硬拒.
pub(crate) async fn resolve_read_dispatch(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    if is_agent {
        require_read(file_path, agent_id, state, app).await
    } else {
        resolve_path_user_read(file_path, state)
    }
}

pub(crate) async fn resolve_write_dispatch(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    if is_agent {
        require_write(file_path, agent_id, state, app).await
    } else {
        resolve_path_user_write(file_path, state)
    }
}

/// ponytail: 根据 _agent 标志选择 git 权限检查方式
pub(crate) async fn require_git_dispatch(
    repo_path: &str,
    subcommand: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    if is_agent {
        require_git(repo_path, subcommand, agent_id, state, app).await
    } else {
        Ok(())  // 用户 UI git 操作不受限制
    }
}

pub(crate) async fn require_command(command: &str, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    let tool = tools::BashTool { command: command.to_string() };
    check_permission(&tool, &ctx, app).await
}

pub(crate) fn require_command_sync(command: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    let tool = tools::BashTool { command: command.to_string() };
    check_permission_sync(&tool, &ctx)
}

pub(crate) fn require_read_sync(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::ReadTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission_sync(&tool, &ctx)?;
    std::fs::canonicalize(&physical)
        .map_err(|e| format!("无法解析路径 {}: {}", physical_str, e))
}

pub(crate) async fn require_git(repo_path: &str, subcommand: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    // Phase 3：隔离时将仓库路径前向映射到 worktree (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(repo_path), agent_id);
    let tool = tools::GitTool { repo_path: physical.to_string_lossy().to_string(), subcommand: subcommand.to_string() };
    check_permission(&tool, &ctx, app).await
}