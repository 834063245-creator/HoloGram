// SqliteDb — persistent storage for hologram.db.
// Handles all SQLite operations: schema creation, batch upsert, FTS5 search,
// timeline events, and startup migration.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use tracing::{info, warn};

use crate::graph::{EdgeKind, Node, NodeKind};

/// Wrapper around the single hologram.db connection.
pub struct SqliteDb {
    conn: Connection,
    db_path: PathBuf,
}

impl SqliteDb {
    /// Open (or create) the database at `<project_root>/.hologram/hologram.db`.
    /// Creates schema if first run.
    pub fn open(project_root: &Path) -> Result<Self, String> {
        let hologram_dir = project_root.join(".hologram");
        std::fs::create_dir_all(&hologram_dir)
            .map_err(|e| format!("mkdir .hologram: {}", e))?;
        let db_path = hologram_dir.join("hologram.db");

        let conn = Connection::open(&db_path)
            .map_err(|e| format!("open hologram.db: {}", e))?;

        // Essential pragmas
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA auto_vacuum=INCREMENTAL;",
        )
        .map_err(|e| format!("pragma: {}", e))?;

        let db = Self { conn, db_path };
        db.ensure_schema()?;
        db.migrate_timeline(project_root)?;
        Ok(db)
    }

    /// Return path for diagnostic messages.
    pub fn path(&self) -> &Path {
        &self.db_path
    }

    /// Create tables if they don't exist.
    fn ensure_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS nodes (
                    rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
                    id          TEXT NOT NULL UNIQUE,
                    name        TEXT NOT NULL,
                    kind        TEXT NOT NULL,
                    location    TEXT,
                    properties  TEXT DEFAULT '{}',
                    out_degree  INTEGER DEFAULT 0,
                    in_degree   INTEGER DEFAULT 0,
                    position_x  REAL,
                    position_y  REAL,
                    position_z  REAL,
                    community_id INTEGER
                );

                CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
                CREATE INDEX IF NOT EXISTS idx_nodes_location ON nodes(location);
                CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
                CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community_id);

                CREATE TABLE IF NOT EXISTS edges (
                    id                  TEXT PRIMARY KEY,
                    source              TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    target              TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    kind                TEXT NOT NULL,
                    coupling_depth      INTEGER DEFAULT 0,
                    cross_file          INTEGER DEFAULT 0,
                    direction           TEXT DEFAULT 'forward',
                    temporal_delay_sec  REAL,
                    medium_node_id      TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
                CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
                CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
                CREATE INDEX IF NOT EXISTS idx_edges_coupling ON edges(coupling_depth);
                CREATE INDEX IF NOT EXISTS idx_edges_source_target ON edges(source, target);

                CREATE TABLE IF NOT EXISTS timeline_events (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp   TEXT NOT NULL,
                    event_type  TEXT NOT NULL,
                    file        TEXT DEFAULT '',
                    summary     TEXT DEFAULT '',
                    properties  TEXT DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_timeline_ts ON timeline_events(timestamp);

                CREATE TABLE IF NOT EXISTS meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                );",
            )
            .map_err(|e| format!("ensure schema: {}", e))?;

        // Ensure FTS5 external content table
        self.conn
            .execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS fts_nodes USING fts5(
                    node_id,
                    name,
                    location,
                    content=nodes,
                    content_rowid=rowid
                );",
            )
            .map_err(|e| format!("fts5 table: {}", e))?;

        // Triggers for FTS sync (idempotent via IF NOT EXISTS-like pattern —
        // rusqlite doesn't support CREATE TRIGGER IF NOT EXISTS, so catch "already exists" error).
        for trigger_sql in [
            "CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
                INSERT INTO fts_nodes(rowid, node_id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
            END;",
            "CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
                INSERT INTO fts_nodes(fts_nodes, rowid, node_id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
            END;",
            "CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
                INSERT INTO fts_nodes(fts_nodes, rowid, node_id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
                INSERT INTO fts_nodes(rowid, node_id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
            END;",
        ] {
            let _ = self.conn.execute_batch(trigger_sql);
            // Ignore "already exists" — triggers are created once with the table.
        }

        // Init schema version if not present
        let _ = self.conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')",
            [],
        );

        Ok(())
    }

    /// Migrate timeline events from legacy timeline.db into hologram.db.
    fn migrate_timeline(&self, project_root: &Path) -> Result<(), String> {
        let legacy_path = project_root.join(".hologram").join("timeline.db");
        if !legacy_path.exists() {
            return Ok(());
        }
        info!(
            "[sqlite] migrating timeline events from {}",
            legacy_path.display()
        );
        let result = self.conn.execute_batch(&format!(
            "ATTACH DATABASE '{}' AS timeline_legacy;
             INSERT OR IGNORE INTO main.timeline_events (id, timestamp, event_type, file, summary, properties)
                 SELECT id, timestamp, event_type, file, summary, properties FROM timeline_legacy.events;
             DETACH DATABASE timeline_legacy;",
            legacy_path.display().to_string().replace('\\', "\\\\")
        ));
        match result {
            Ok(()) => {
                let _ = std::fs::remove_file(&legacy_path);
                info!("[sqlite] timeline migration complete, removed legacy db");
                Ok(())
            }
            Err(e) => {
                warn!("[sqlite] timeline migration failed (non-fatal): {}", e);
                Ok(())
            }
        }
    }

    // ── full table loads (for MemoryIndex construction) ──

    pub fn load_all_nodes(&self) -> Result<Vec<Node>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, kind, location, properties, out_degree, in_degree, position_x, position_y, position_z, community_id FROM nodes")
            .map_err(|e| format!("prepare nodes: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                let kind_str: String = row.get(2)?;
                let kind = match kind_str.as_str() {
                    "symbol" => NodeKind::Symbol,
                    "medium" => NodeKind::Medium,
                    "temporal" => NodeKind::Temporal,
                    _ => NodeKind::Symbol,
                };
                let props_str: String = row.get(4).unwrap_or_else(|_| "{}".into());
                let properties: serde_json::Value =
                    serde_json::from_str(&props_str).unwrap_or_default();
                let px: Option<f32> = row.get(7)?;
                let py: Option<f32> = row.get(8)?;
                let pz: Option<f32> = row.get(9)?;
                let position = match (px, py, pz) {
                    (Some(x), Some(y), Some(z)) => Some([x, y, z]),
                    _ => None,
                };
                Ok(Node {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind,
                    location: row.get(3)?,
                    properties,
                    out_degree: row.get::<_, i64>(5).unwrap_or(0) as u32,
                    in_degree: row.get::<_, i64>(6).unwrap_or(0) as u32,
                    position,
                    community_id: row.get::<_, Option<i64>>(10).unwrap_or(None).map(|v| v as usize),
                })
            })
            .map_err(|e| format!("query nodes: {}", e))?;
        let mut nodes = Vec::new();
        for row in rows {
            nodes.push(row.map_err(|e| format!("row error: {}", e))?);
        }
        Ok(nodes)
    }

    /// Returns (source, target, kind, coupling_depth, temporal_delay_sec) tuples.
    pub fn load_all_edges(&self) -> Result<Vec<(String, String, EdgeKind, u8, Option<f64>)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT source, target, kind, coupling_depth, temporal_delay_sec FROM edges")
            .map_err(|e| format!("prepare edges: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                let kind_str: String = row.get(2)?;
                let kind = edge_kind_from_str(&kind_str);
                let depth: i64 = row.get(3)?;
                let delay: Option<f64> = row.get(4)?;
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, kind, depth as u8, delay))
            })
            .map_err(|e| format!("query edges: {}", e))?;
        let mut edges = Vec::new();
        for row in rows {
            edges.push(row.map_err(|e| format!("edge row: {}", e))?);
        }
        Ok(edges)
    }

    // ── batch upsert ──

    /// Batch upsert nodes. Uses a transaction for performance.
    pub fn batch_upsert_nodes(&self, nodes: &[&Node]) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("tx: {}", e))?;
        for node in nodes {
            let (px, py, pz) = match node.position {
                Some([x, y, z]) => (Some(x as f64), Some(y as f64), Some(z as f64)),
                None => (None, None, None),
            };
            let props = serde_json::to_string(&node.properties).unwrap_or_else(|_| "{}".into());
            tx.execute(
                "INSERT INTO nodes (id, name, kind, location, properties, out_degree, in_degree, position_x, position_y, position_z, community_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, kind=excluded.kind, location=excluded.location,
                    properties=excluded.properties, out_degree=excluded.out_degree,
                    in_degree=excluded.in_degree, position_x=excluded.position_x,
                    position_y=excluded.position_y, position_z=excluded.position_z,
                    community_id=excluded.community_id",
                params![
                    node.id,
                    node.name,
                    node.kind.as_str(),
                    node.location,
                    props,
                    node.out_degree as i64,
                    node.in_degree as i64,
                    px,
                    py,
                    pz,
                    node.community_id.map(|v| v as i64),
                ],
            )
            .map_err(|e| format!("insert node {}: {}", node.id, e))?;
        }
        tx.commit().map_err(|e| format!("commit nodes: {}", e))?;
        Ok(())
    }

    /// Batch upsert edges using (source, target, kind, coupling_depth, temporal_delay_sec) tuples.
    pub fn batch_upsert_edges(
        &self,
        edges: &[(&str, &str, EdgeKind, u8, Option<f64>)],
    ) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("tx: {}", e))?;
        for &(source, target, kind, coupling_depth, temporal_delay_sec) in edges {
            let id = format!("{}::{}::{}", source, target, kind.as_str());
            tx.execute(
                "INSERT INTO edges (id, source, target, kind, coupling_depth, temporal_delay_sec)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    coupling_depth=MAX(excluded.coupling_depth, coupling_depth),
                    temporal_delay_sec=COALESCE(excluded.temporal_delay_sec, temporal_delay_sec)",
                params![id, source, target, kind.as_str(), coupling_depth as i64, temporal_delay_sec],
            )
            .map_err(|e| format!("insert edge {}: {}", id, e))?;
        }
        tx.commit().map_err(|e| format!("commit edges: {}", e))?;
        Ok(())
    }

    // ── FTS5 search ──

    pub fn fts_search(&self, query: &str, limit: usize) -> Result<Vec<String>, String> {
        // Sanitize: escape FTS5 special characters, use simple MATCH
        let safe = query.replace('"', "").replace('\'', "");
        let pattern = format!("\"{}\"", safe);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(|e| format!("fts prepare: {}", e))?;
        let rows = stmt
            .query_map(params![pattern, limit as i64], |row| row.get(0))
            .map_err(|e| format!("fts query: {}", e))?;
        let mut ids = Vec::new();
        for row in rows {
            if let Ok(id) = row {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    // ── timeline events ──

    pub fn record_timeline(
        &self,
        event_type: &str,
        file: Option<&str>,
        summary: &str,
    ) -> Result<(), String> {
        let ts = chrono::Local::now()
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string();
        self.conn
            .execute(
                "INSERT INTO timeline_events (timestamp, event_type, file, summary, properties)
                 VALUES (?1, ?2, ?3, ?4, '{}')",
                params![ts, event_type, file.unwrap_or(""), summary],
            )
            .map_err(|e| format!("timeline insert: {}", e))?;
        // Prune to keep latest 10000 events (prevents unbounded growth)
        let _ = self.conn.execute(
            "DELETE FROM timeline_events WHERE id NOT IN (SELECT id FROM timeline_events ORDER BY id DESC LIMIT 10000)",
            [],
        );
        Ok(())
    }

    pub fn query_timeline(&self, limit: usize) -> Result<Vec<serde_json::Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT timestamp, event_type, file, summary, properties FROM timeline_events ORDER BY id DESC LIMIT ?",
            )
            .map_err(|e| format!("timeline prepare: {}", e))?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                let props_str: String = row.get(4).unwrap_or_else(|_| "{}".into());
                Ok(serde_json::json!({
                    "timestamp": row.get::<_, String>(0)?,
                    "event_type": row.get::<_, String>(1)?,
                    "file": row.get::<_, String>(2).unwrap_or_default(),
                    "summary": row.get::<_, String>(3).unwrap_or_default(),
                    "properties": serde_json::from_str::<serde_json::Value>(&props_str).unwrap_or_default(),
                }))
            })
            .map_err(|e| format!("timeline query: {}", e))?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row.map_err(|e| format!("timeline row: {}", e))?);
        }
        Ok(events)
    }

    /// Run incremental vacuum to reclaim space after many incremental updates.
    pub fn incremental_vacuum(&self) -> Result<(), String> {
        self.conn
            .execute_batch("PRAGMA incremental_vacuum;")
            .map_err(|e| format!("vacuum: {}", e))
    }

    /// Get the underlying connection (for Attach/detach operations if needed).
    pub fn conn(&self) -> &Connection {
        &self.conn
    }
}

/// Parse edge kind from SQLite string.
fn edge_kind_from_str(s: &str) -> EdgeKind {
    match s {
        "imports" => EdgeKind::Imports,
        "calls" => EdgeKind::Calls,
        "inherits" => EdgeKind::Inherits,
        "defines" => EdgeKind::Defines,
        "reads" => EdgeKind::Reads,
        "writes" => EdgeKind::Writes,
        "shares" => EdgeKind::Shares,
        "triggers" => EdgeKind::Triggers,
        "awaits" => EdgeKind::Awaits,
        "sequences" => EdgeKind::Sequences,
        _ => EdgeKind::Calls, // fallback
    }
}
