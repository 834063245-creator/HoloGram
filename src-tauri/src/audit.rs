// v4 Phase 5 — 审计日志：每次文件/Git/Shell 操作留痕
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// One audit record.
#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub timestamp: String,
    pub tool: String,
    pub target_path: String,
    pub action: String,   // "allowed" | "denied" | "user_approved" | "user_denied"
    pub reason: String,
}

/// Append-only JSONL audit logger.
pub struct AuditLogger {
    log_path: PathBuf,
}

impl AuditLogger {
    pub fn new(project_root: &std::path::Path) -> Self {
        let log_dir = project_root.join(".hologram");
        let _ = fs::create_dir_all(&log_dir);
        Self {
            log_path: log_dir.join("audit.jsonl"),
        }
    }

    /// Append an audit entry.
    pub fn log(&self, entry: &AuditEntry) {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.log_path) {
            let line = serde_json::json!({
                "ts": entry.timestamp,
                "tool": entry.tool,
                "path": entry.target_path,
                "action": entry.action,
                "reason": entry.reason,
            });
            let _ = writeln!(f, "{}", line);
        }
    }

    /// Read recent entries (for frontend audit panel).
    #[allow(dead_code)]
    pub fn recent(&self, limit: usize) -> Vec<String> {
        let content = fs::read_to_string(&self.log_path).unwrap_or_default();
        let lines: Vec<&str> = content.lines().collect();
        let start = if lines.len() > limit { lines.len() - limit } else { 0 };
        lines[start..].iter().map(|s| s.to_string()).collect()
    }
}

/// Helper to build a timestamp string.
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}
