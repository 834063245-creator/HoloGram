use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

pub struct TimelineStore {
    db: Mutex<Connection>,
}

impl TimelineStore {
    pub fn open(project_root: &Path) -> Result<Self, String> {
        let db_path = project_root.join(".hologram").join("timeline.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("timeline db: {}", e))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                event_type TEXT NOT NULL,
                file_path TEXT,
                detail TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);"
        ).map_err(|e| format!("timeline schema: {}", e))?;
        Ok(Self { db: Mutex::new(conn) })
    }

    pub fn record(&self, event_type: &str, file_path: Option<&str>, detail: &str) {
        let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        if let Ok(db) = self.db.lock() {
            let _ = db.execute(
                "INSERT INTO events (ts, event_type, file_path, detail) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![ts, event_type, file_path, detail],
            );
        }
    }

    pub fn query(&self, limit: usize) -> Vec<serde_json::Value> {
        if let Ok(db) = self.db.lock() {
            let mut stmt = db.prepare("SELECT ts, event_type, file_path, detail FROM events ORDER BY ts DESC LIMIT ?")
                .unwrap();
            return stmt.query_map(rusqlite::params![limit as i64], |row| {
                Ok(serde_json::json!({
                    "ts": row.get::<_, String>(0)?,
                    "type": row.get::<_, String>(1)?,
                    "file": row.get::<_, Option<String>>(2)?,
                    "detail": row.get::<_, String>(3)?,
                }))
            }).unwrap().filter_map(|r| r.ok()).collect();
        }
        vec![]
    }
}
