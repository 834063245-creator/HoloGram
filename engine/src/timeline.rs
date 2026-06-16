use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

pub struct TimelineStore {
    db: Mutex<Connection>,
}

impl TimelineStore {
    pub fn open(project_root: &Path) -> Result<Self, String> {
        let db_path = project_root.join(".hologram").join("timeline.db");
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("timeline mkdir: {}", e))?;
        }
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("timeline db: {}", e))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                event_type TEXT NOT NULL,
                file TEXT DEFAULT '',
                summary TEXT DEFAULT '',
                properties TEXT DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);"
        ).map_err(|e| format!("timeline schema: {}", e))?;
        Ok(Self { db: Mutex::new(conn) })
    }

    pub fn record(&self, event_type: &str, file_path: Option<&str>, summary: &str) {
        let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        let file_val = file_path.unwrap_or("");
        let props = "{}";
        if let Ok(db) = self.db.lock() {
            let _ = db.execute(
                "INSERT INTO events (timestamp, event_type, file, summary, properties) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![ts, event_type, file_val, summary, props],
            );
        }
    }

    pub fn query(&self, limit: usize) -> Vec<serde_json::Value> {
        if let Ok(db) = self.db.lock() {
            let mut stmt = db.prepare(
                "SELECT timestamp, event_type, file, summary, properties FROM events ORDER BY id DESC LIMIT ?"
            ).unwrap();
            return stmt.query_map(rusqlite::params![limit as i64], |row| {
                let props_str: String = row.get(4).unwrap_or_else(|_| "{}".into());
                Ok(serde_json::json!({
                    "timestamp": row.get::<_, String>(0)?,
                    "event_type": row.get::<_, String>(1)?,
                    "file": row.get::<_, String>(2).unwrap_or_default(),
                    "summary": row.get::<_, String>(3).unwrap_or_default(),
                    "properties": serde_json::from_str::<serde_json::Value>(&props_str).unwrap_or_default(),
                }))
            }).unwrap().filter_map(|r| r.ok()).collect();
        }
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_timeline() -> (TimelineStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("hologram_timeline_test_{}", uuid::Uuid::new_v4()));
        let store = TimelineStore::open(&dir).expect("failed to open temp timeline");
        (store, dir)
    }

    fn cleanup(dir: &std::path::Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_open_creates_db() {
        let dir = std::env::temp_dir().join(format!("hologram_test_open_{}", uuid::Uuid::new_v4()));
        let result = TimelineStore::open(&dir);
        assert!(result.is_ok());
        let db_path = dir.join(".hologram").join("timeline.db");
        assert!(db_path.exists());
        cleanup(&dir);
    }

    #[test]
    fn test_record_and_query() {
        let (store, dir) = temp_timeline();
        store.record("analyze", Some("src/main.rs"), "analysis completed");
        store.record("change", None, "file modified");

        let events = store.query(10);
        assert_eq!(events.len(), 2);
        // Most recent first (DESC)
        assert_eq!(events[0]["event_type"], "change");
        assert_eq!(events[1]["event_type"], "analyze");
        assert_eq!(events[1]["file"], "src/main.rs");
        assert_eq!(events[1]["summary"], "analysis completed");
        cleanup(&dir);
    }

    #[test]
    fn test_query_respects_limit() {
        let (store, dir) = temp_timeline();
        for i in 0..5 {
            store.record("test", None, &format!("event {}", i));
        }
        let events = store.query(2);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["summary"], "event 4"); // DESC order
        cleanup(&dir);
    }

    #[test]
    fn test_query_empty() {
        let (store, dir) = temp_timeline();
        let events = store.query(10);
        assert!(events.is_empty());
        cleanup(&dir);
    }

    #[test]
    fn test_record_without_file() {
        let (store, dir) = temp_timeline();
        store.record("health_check", None, "all good");
        let events = store.query(1);
        assert_eq!(events[0]["file"], "");
        assert_eq!(events[0]["event_type"], "health_check");
        cleanup(&dir);
    }
}
