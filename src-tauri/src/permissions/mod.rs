// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 权限系统中央入口 — has_permission_to_use_tool() (spec §4.6)
// Tool trait 定义 + PermissionContext + 裁决编排

pub mod bash;
pub mod filesystem;
pub mod git;
pub mod rule;
pub mod safety;
pub mod web;

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};

use tokio::sync::oneshot;

use crate::agent_isolation::AgentIsolation;
use crate::audit::AuditLogger;
use crate::sandbox::{Sandbox, SandboxResult};

// ═══════════════════════════════════════════════════════════════
// Tool trait — 每个 Tauri command 对应一个 Tool 实现 (spec §4.2)
// ═══════════════════════════════════════════════════════════════

pub trait Tool: Sync {
    fn name(&self) -> &'static str;
    fn get_path(&self) -> Option<PathBuf>;
    #[allow(dead_code)] // ponytail: used in later phases for mode-based decisions
    fn is_read_only(&self) -> bool;
    #[allow(dead_code)]
    fn is_destructive(&self) -> bool;
    #[allow(dead_code)]
    fn requires_user_interaction(&self) -> bool {
        false
    }
    /// 工具自治裁决。返回 Passthrough 表示本工具无特殊意见，交给引擎兜底。
    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult;
}

// ═══════════════════════════════════════════════════════════════
// PermissionResult / PermissionDecision / PermissionUpdate
// ═══════════════════════════════════════════════════════════════

#[derive(Debug)]
pub enum PermissionResult {
    Allow,
    Deny { reason: String },
    Ask {
        reason: String,
        suggestions: Vec<PermissionUpdate>,
    },
    Passthrough,
}

#[derive(Debug)]
pub enum PermissionDecision {
    Allow,
    Deny { reason: String },
    Ask {
        request_id: String,
        reason: String,
        suggestions: Vec<PermissionUpdate>,
    },
}

#[derive(Debug, Clone)]
pub struct PermissionUpdate {
    pub rule: String,
    pub behavior: String,
}

// ═══════════════════════════════════════════════════════════════
// PermissionContext — RwLock-wrapped rules + sandbox + audit
// ═══════════════════════════════════════════════════════════════

pub struct PermissionContext {
    #[allow(dead_code)] // ponytail: available for external path queries
    pub project_root: PathBuf,
    pub sandbox: Sandbox,
    rules: RwLock<rule::PermissionRules>,
    audit_logger: AuditLogger,
    /// Agent isolation state — None = direct repo access, Some(Worktree) = sandboxed.
    isolation: RwLock<Option<AgentIsolation>>,
}

impl PermissionContext {
    pub fn new(project_root: &Path) -> Self {
        let mut rules = rule::PermissionRules::new();

        // Load system rules (always active)
        rules.add_rules(rule::load_system_rules());

        // Load project rules from .hologram/permissions.json
        rules.add_rules(rule::load_project_rules(project_root));

        let sandbox = Sandbox::new(project_root);
        let audit_logger = AuditLogger::new(project_root);
        let isolation = AgentIsolation::none(project_root);

        Self {
            project_root: project_root.to_path_buf(),
            sandbox,
            rules: RwLock::new(rules),
            audit_logger,
            isolation: RwLock::new(Some(isolation)),
        }
    }

    /// Add a session rule (from "always allow" dialog choice).
    pub fn add_session_rule(&self, rule_str: &str, behavior: &str) {
        let behavior = match behavior {
            "allow" => rule::Behavior::Allow,
            "deny" => rule::Behavior::Deny,
            _ => return,
        };
        let new_rule = rule::PermissionRule {
            source: rule::RuleSource::Session,
            behavior,
            value: rule::parse_rule_value(rule_str),
        };
        if let Ok(mut rules) = self.rules.write() {
            rules.add_rule(new_rule);
        }
    }

    /// Resolve a read path through the sandbox (canonicalization + boundary check).
    pub fn resolve_read(&self, path: &str) -> Result<PathBuf, String> {
        match self.sandbox.resolve_read(Path::new(path)) {
            SandboxResult::Allowed(p) => Ok(p),
            SandboxResult::Denied(reason) => Err(reason),
        }
    }

    /// Resolve a write path through the sandbox (canonicalization + boundary check).
    pub fn resolve_write(&self, path: &str) -> Result<PathBuf, String> {
        match self.sandbox.resolve_write(Path::new(path)) {
            SandboxResult::Allowed(p) => Ok(p),
            SandboxResult::Denied(reason) => Err(reason),
        }
    }

    /// Get a read lock on the rules for tool self-checks.
    pub fn read_rules(&self) -> std::sync::RwLockReadGuard<'_, rule::PermissionRules> {
        self.rules.read().unwrap()
    }

    // ═══════════════════════════════════════════════════════════════
    // Agent isolation — worktree lifecycle + path mapping (spec §5)
    // ═══════════════════════════════════════════════════════════════

    /// Set the active agent isolation (e.g. when an agent starts in worktree mode).
    pub fn set_isolation(&self, isolation: AgentIsolation) {
        if let Ok(mut iso) = self.isolation.write() {
            *iso = Some(isolation);
        }
    }

    /// Clear isolation back to None (agent finished, worktree removed).
    pub fn clear_isolation(&self) {
        if let Ok(mut iso) = self.isolation.write() {
            *iso = Some(AgentIsolation::none(&self.project_root));
        }
    }

    /// Get the current isolation kind.
    #[allow(dead_code)] // ponytail: public API for future mode checks
    pub fn isolation_kind(&self) -> crate::agent_isolation::IsolationKind {
        self.isolation
            .read()
            .ok()
            .and_then(|iso| iso.as_ref().map(|i| i.kind))
            .unwrap_or(crate::agent_isolation::IsolationKind::None)
    }

    /// Get a clone of the current isolation state.
    pub fn get_isolation(&self) -> Option<AgentIsolation> {
        self.isolation
            .read()
            .ok()
            .and_then(|iso| iso.clone())
    }

    /// Reverse-map a path for permission checking: worktree physical path → main repo logical path.
    /// In None isolation, returns the path unchanged.
    pub fn reverse_map_path(&self, path: &Path) -> PathBuf {
        if let Ok(iso) = self.isolation.read() {
            if let Some(ref isolation) = *iso {
                return isolation.reverse_map(path);
            }
        }
        path.to_path_buf()
    }

    /// Forward-map a path for execution: main repo logical path → worktree physical path.
    /// In None isolation, returns the path unchanged.
    pub fn forward_map_path(&self, path: &Path) -> PathBuf {
        if let Ok(iso) = self.isolation.read() {
            if let Some(ref isolation) = *iso {
                return isolation.forward_map(path);
            }
        }
        path.to_path_buf()
    }

    /// Log an audit entry for a deny decision.
    pub fn audit_deny(&self, tool_name: &str, target: &str, reason: &str) {
        self.audit_logger.log(&crate::audit::AuditEntry {
            timestamp: crate::audit::now_iso(),
            tool: tool_name.to_string(),
            target_path: target.to_string(),
            action: "denied".to_string(),
            reason: reason.to_string(),
        });
    }

    /// Log an audit entry for an allow decision.
    #[allow(dead_code)]
    pub fn audit_allow(&self, tool_name: &str, target: &str) {
        self.audit_logger.log(&crate::audit::AuditEntry {
            timestamp: crate::audit::now_iso(),
            tool: tool_name.to_string(),
            target_path: target.to_string(),
            action: "allowed".to_string(),
            reason: String::new(),
        });
    }
}

// ═══════════════════════════════════════════════════════════════
// has_permission_to_use_tool — 中央入口 (spec §4.6)
// ═══════════════════════════════════════════════════════════════

/// Central permission check — orchestrates tool-level rules → tool self-check → safety → mode.
/// Lock scoping: tool-level checks release the rules lock before calling tool.check_permissions(),
/// which internally acquires its own read lock. This avoids recursive-read deadlock on non-Windows.
pub fn has_permission_to_use_tool(
    tool: &dyn Tool,
    ctx: &PermissionContext,
) -> PermissionDecision {
    let tool_name = tool.name();

    // ① Tool-level Deny — highest priority, immediate reject
    {
        let rules = ctx.rules.read().unwrap();
        if let Some(rule) = rules.find_deny(tool_name, None) {
            let reason = format!("{} 工具被规则禁止使用", rule.explain());
            let target = tool
                .get_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            drop(rules); // release lock before audit (audit doesn't need rules)
            ctx.audit_deny(tool_name, &target, &reason);
            return PermissionDecision::Deny { reason };
        }
    } // rules lock dropped

    // ② Tool-level Ask — force dialog
    {
        let rules = ctx.rules.read().unwrap();
        if let Some(rule) = rules.find_ask(tool_name, None) {
            return PermissionDecision::Ask {
                request_id: gen_ask_id(),
                reason: rule.explain(),
                suggestions: vec![],
            };
        }
    } // rules lock dropped

    // ③ Tool self-check — acquires its own rules lock internally
    let tool_result = tool.check_permissions(ctx);
    match tool_result {
        PermissionResult::Deny { reason } => {
            let target = tool
                .get_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            ctx.audit_deny(tool_name, &target, &reason);
            return PermissionDecision::Deny { reason };
        }
        PermissionResult::Ask {
            reason,
            suggestions,
        } => {
            return PermissionDecision::Ask {
                request_id: gen_ask_id(),
                reason,
                suggestions,
            };
        }
        PermissionResult::Allow => {
            // Tool self-determined this is safe (e.g. project-internal read
            // after all deny/safety/ask checks passed). Allow immediately
            // — don't fall through to default Ask.
            return PermissionDecision::Allow;
        }
        PermissionResult::Passthrough => {
            // Continue to mode/allow checks
        }
    }

    // ④ Mode decision (simplified: default mode — reads auto-allowed in project)
    // Ponytail: full mode switching (bypass/acceptEdits) is Phase 3+

    // ⑤ Tool-level Allow — bare "Read" / "Bash" / etc without content
    {
        let rules = ctx.rules.read().unwrap();
        if rules.find_allow(tool_name, None).is_some() {
            return PermissionDecision::Allow;
        }
    }

    // ⑥ No rule matched, tool has no opinion (Passthrough) → Ask
    PermissionDecision::Ask {
        request_id: gen_ask_id(),
        reason: "此操作需要批准".into(),
        suggestions: vec![],
    }
}

// ═══════════════════════════════════════════════════════════════
// Ask request management — tokio oneshot channels for frontend dialog
// ═══════════════════════════════════════════════════════════════

static ASK_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn gen_ask_id() -> String {
    let id = ASK_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("ask_{}", id)
}

static PENDING_ASKS: LazyLock<RwLock<std::collections::HashMap<String, oneshot::Sender<bool>>>> =
    LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

/// Register a pending Ask request and return a receiver.
/// The Tauri command awaits this receiver; permission_ask_response sends the answer.
pub fn register_ask(request_id: String) -> oneshot::Receiver<bool> {
    let (tx, rx) = oneshot::channel();
    if let Ok(mut pending) = PENDING_ASKS.write() {
        pending.insert(request_id, tx);
    }
    rx
}

/// Resolve a pending Ask request — called by permission_ask_response Tauri command.
pub fn resolve_ask(request_id: &str, allow: bool) {
    if let Ok(mut pending) = PENDING_ASKS.write() {
        if let Some(tx) = pending.remove(request_id) {
            let _ = tx.send(allow);
        }
    }
}
