// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// v4 Phase 5 — 审计日志：每次文件/Git/Shell 操作留痕
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// 一条审计记录。
#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub timestamp: String,
    pub tool: String,
    pub target_path: String,
    pub action: String,   // "allowed" | "denied" | "user_approved" | "user_denied"
    pub reason: String,
}

/// 仅追加的 JSONL 审计日志记录器。
pub struct AuditLogger {
    log_path: PathBuf,
    /// 写失败计数——审计是安全功能，写失败必须留信号可取证。
    write_failures: AtomicU64,
}

impl AuditLogger {
    pub fn new(project_root: &std::path::Path) -> Self {
        let log_dir = project_root.join(".hologram");
        if let Err(e) = fs::create_dir_all(&log_dir) {
            eprintln!("[audit] 无法创建审计日志目录 {}: {}", log_dir.display(), e);
        }
        Self {
            log_path: log_dir.join("audit.jsonl"),
            write_failures: AtomicU64::new(0),
        }
    }

    /// 追加一条审计记录。写失败不抛（审计不阻断业务），但 eprintln 告警并计数。
    pub fn log(&self, entry: &AuditEntry) {
        let line = serde_json::json!({
            "ts": entry.timestamp,
            "tool": entry.tool,
            "path": entry.target_path,
            "action": entry.action,
            "reason": entry.reason,
        });
        let result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .and_then(|mut f| writeln!(f, "{}", line));
        if let Err(e) = result {
            let n = self.write_failures.fetch_add(1, Ordering::Relaxed) + 1;
            eprintln!(
                "[audit] 审计日志写入失败（第 {} 次）{}: {} — 丢失记录: tool={} action={} path={}",
                n, self.log_path.display(), e, entry.tool, entry.action, entry.target_path
            );
        }
    }

    /// 累计写失败次数（测试与可观测用）。
    pub fn write_failure_count(&self) -> u64 {
        self.write_failures.load(Ordering::Relaxed)
    }
}

/// 构建时间戳字符串的辅助函数。
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> AuditEntry {
        AuditEntry {
            timestamp: now_iso(),
            tool: "write_file".to_string(),
            target_path: "/tmp/x".to_string(),
            action: "denied".to_string(),
            reason: "test".to_string(),
        }
    }

    // P1-23 回归：写失败必须计数 + 告警，不得静默
    #[test]
    fn test_log_write_failure_counted() {
        // .hologram 占位为普通文件 → create_dir_all 与 open 都失败
        let dir = std::env::temp_dir().join(format!("audit-fail-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".hologram"), "not a dir").unwrap();

        let logger = AuditLogger::new(&dir);
        logger.log(&entry());
        logger.log(&entry());
        assert_eq!(logger.write_failure_count(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_log_success_no_failure_and_persisted() {
        let dir = std::env::temp_dir().join(format!("audit-ok-{}", std::process::id()));
        let logger = AuditLogger::new(&dir);
        logger.log(&entry());
        assert_eq!(logger.write_failure_count(), 0);

        let content = fs::read_to_string(dir.join(".hologram").join("audit.jsonl")).unwrap();
        assert!(content.contains("\"action\":\"denied\""));

        let _ = fs::remove_dir_all(&dir);
    }
}
