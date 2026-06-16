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
        let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
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
