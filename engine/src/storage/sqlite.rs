// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SqliteDb — persistent storage for hologram.db.
// Handles all SQLite operations: schema creation, batch upsert, FTS5 search,
// timeline events, and startup migration.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use tracing::info;

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

        // Essential pragmas — set once at connection open.
        // ponytail: synchronous=NORMAL is safe in WAL mode and ~2x faster for bulk writes.
        // SQLite forbids changing synchronous inside a transaction, so do it here.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;
             PRAGMA auto_vacuum=INCREMENTAL;
             PRAGMA busy_timeout=5000;",
        )
        .map_err(|e| format!("pragma: {}", e))?;

        let db = Self { conn, db_path };
        db.ensure_schema()?;
        db.migrate_fts5()?;
        Ok(db)
    }

    /// Detect and fix broken FTS5 schema from v4.0 (column `node_id` mismatched
    /// `nodes.id`). Checks the FTS5 table definition directly; if it uses the old
    /// column name, drops and recreates the FTS5 index plus triggers, then rebuilds
    /// from the content table.
    fn migrate_fts5(&self) -> Result<(), String> {
        // Check if fts_nodes exists and uses the old column name `node_id`.
        let sql: String = self.conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_nodes'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_default();
        if !sql.contains("node_id") {
            return Ok(()); // already correct or table doesn't exist yet
        }
        info!("[sqlite] migrating broken FTS5 schema (node_id → id)");
        // Drop old triggers (ignore errors — they might not exist)
        for trig in &["nodes_ai", "nodes_ad", "nodes_au"] {
            let _ = self.conn.execute_batch(&format!("DROP TRIGGER {}", trig));
        }
        self.conn.execute_batch(
            "DROP TABLE IF EXISTS fts_nodes;
             CREATE VIRTUAL TABLE fts_nodes USING fts5(
                 id, name, location,
                 content=nodes,
                 content_rowid=rowid
             );
             CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
                 INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
             END;
             CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
                 INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
             END;
             CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
                 INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
                 INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
             END;
             INSERT INTO fts_nodes(fts_nodes) VALUES('rebuild');",
        )
            .map_err(|e| format!("fts5 migration: {}", e))?;
        info!("[sqlite] FTS5 migration complete");
        Ok(())
    }

    /// Return path for diagnostic messages.
    pub fn path(&self) -> &Path {
        &self.db_path
    }

    /// Secondary connection for timeline I/O — avoids blocking on graph store mutex.
    pub fn open_aux_connection(db_path: &Path) -> Result<Connection, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("open aux hologram.db: {}", e))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=5000;",
        )
        .map_err(|e| format!("pragma aux: {}", e))?;
        Ok(conn)
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
                    id,
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
                INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
            END;",
            "CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
                INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
            END;",
            "CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
                INSERT INTO fts_nodes(fts_nodes, rowid, id, name, location) VALUES ('delete', old.rowid, old.id, old.name, old.location);
                INSERT INTO fts_nodes(rowid, id, name, location) VALUES (new.rowid, new.id, new.name, new.location);
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
                    "function" => NodeKind::Function,
                    "class" => NodeKind::Class,
                    "module" => NodeKind::Module,
                    "file" => NodeKind::File,
                    "interface" => NodeKind::Interface,
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
                let kind = edge_kind_from_str(&kind_str)
                    .unwrap_or_else(|msg| {
                        eprintln!("[hologram] {}", msg);
                        EdgeKind::Calls
                    });
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

    // ── bulk write (full analysis + incremental) ──

    /// Replace all graph data in SQLite with the given nodes and edges.
    /// Uses a single transaction with performance pragmas; rolls back on failure
    /// so existing data is preserved if anything goes wrong.
    /// ponytail: synchronous=NORMAL is safe in WAL mode.
    pub fn bulk_replace_all(
        &self,
        nodes: &[&Node],
        edges: &[(&str, &str, EdgeKind, u8, Option<f64>)],
    ) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction()
            .map_err(|e| format!("tx: {}", e))?;

        // Boost cache for bulk write (safe inside transaction).
        // ponytail: synchronous & foreign_keys can't change inside a tx — set in open().
        tx.execute_batch("PRAGMA cache_size=-50000;")
            .map_err(|e| format!("pragma cache: {}", e))?;

        // Clear old data
        tx.execute_batch("DELETE FROM edges; DELETE FROM nodes;")
            .map_err(|e| format!("delete: {}", e))?;

        // Insert nodes
        for node in nodes {
            let (px, py, pz) = match node.position {
                Some([x, y, z]) => (Some(x as f64), Some(y as f64), Some(z as f64)),
                None => (None, None, None),
            };
            let props = serde_json::to_string(&node.properties).unwrap_or_else(|_| "{}".into());
            tx.execute(
                "INSERT INTO nodes (id, name, kind, location, properties, out_degree, in_degree, position_x, position_y, position_z, community_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    node.id, node.name, node.kind.as_str(), node.location, props,
                    node.out_degree as i64, node.in_degree as i64,
                    px, py, pz, node.community_id.map(|v| v as i64),
                ],
            ).map_err(|e| format!("insert node {}: {}", node.id, e))?;
        }

        // Insert edges
        for &(source, target, kind, coupling_depth, temporal_delay_sec) in edges {
            let id = format!("{}::{}::{}", source, target, kind.as_str());
            tx.execute(
                "INSERT INTO edges (id, source, target, kind, coupling_depth, temporal_delay_sec)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, source, target, kind.as_str(), coupling_depth as i64, temporal_delay_sec],
            ).map_err(|e| format!("insert edge {}: {}", id, e))?;
        }

        // Restore default cache size before commit
        tx.execute_batch("PRAGMA cache_size=-2000;")
            .map_err(|e| format!("pragma restore: {}", e))?;

        tx.commit().map_err(|e| format!("commit: {}", e))?;
        Ok(())
    }

    // ── batch upsert (incremental updates) ──

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
                    coupling_depth=excluded.coupling_depth,
                    temporal_delay_sec=excluded.temporal_delay_sec",
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
                "SELECT id FROM fts_nodes WHERE fts_nodes MATCH ?1 ORDER BY rank LIMIT ?2",
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
        timeline_record(&self.conn, event_type, file, summary)
    }

    /// Record a timeline event with custom properties JSON.
    /// Properties must be a valid serde_json::Value — stored as JSON string.
    pub fn record_timeline_with_props(
        &self,
        event_type: &str,
        file: Option<&str>,
        summary: &str,
        properties: &serde_json::Value,
    ) -> Result<(), String> {
        timeline_record_with_props(&self.conn, event_type, file, summary, properties)
    }

    pub fn query_timeline(&self, limit: usize) -> Result<Vec<serde_json::Value>, String> {
        timeline_query(&self.conn, limit)
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

const TIMELINE_KEEP: i64 = 10_000;

fn timeline_prune(conn: &Connection) {
    let _ = conn.execute(
        "DELETE FROM timeline_events WHERE id < (
            SELECT id FROM timeline_events ORDER BY id DESC LIMIT 1 OFFSET ?1
        )",
        params![TIMELINE_KEEP - 1],
    );
}

/// Record a timeline event on any hologram.db connection (WAL-safe).
pub fn timeline_record(
    conn: &Connection,
    event_type: &str,
    file: Option<&str>,
    summary: &str,
) -> Result<(), String> {
    let ts = chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    conn.execute(
        "INSERT INTO timeline_events (timestamp, event_type, file, summary, properties)
         VALUES (?1, ?2, ?3, ?4, '{}')",
        params![ts, event_type, file.unwrap_or(""), summary],
    )
    .map_err(|e| format!("timeline insert: {}", e))?;
    timeline_prune(conn);
    Ok(())
}

/// Record a timeline event with JSON properties on any connection.
pub fn timeline_record_with_props(
    conn: &Connection,
    event_type: &str,
    file: Option<&str>,
    summary: &str,
    properties: &serde_json::Value,
) -> Result<(), String> {
    let ts = chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let props_str = serde_json::to_string(properties).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO timeline_events (timestamp, event_type, file, summary, properties)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ts, event_type, file.unwrap_or(""), summary, props_str],
    )
    .map_err(|e| format!("timeline insert: {}", e))?;
    timeline_prune(conn);
    Ok(())
}

/// Query recent timeline events on any connection.
pub fn timeline_query(conn: &Connection, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, timestamp, event_type, file, summary, properties
             FROM timeline_events ORDER BY id DESC LIMIT ?",
        )
        .map_err(|e| format!("timeline prepare: {}", e))?;
    let rows = stmt
        .query_map(params![limit as i64], |row| {
            let props_str: String = row.get(5).unwrap_or_else(|_| "{}".into());
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "timestamp": row.get::<_, String>(1)?,
                "event_type": row.get::<_, String>(2)?,
                "file": row.get::<_, String>(3).unwrap_or_default(),
                "summary": row.get::<_, String>(4).unwrap_or_default(),
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

/// Parse edge kind from SQLite string.
/// Returns an error for unknown kinds instead of silently defaulting to Calls.
fn edge_kind_from_str(s: &str) -> Result<EdgeKind, String> {
    match s {
        "imports" => Ok(EdgeKind::Imports),
        "calls" => Ok(EdgeKind::Calls),
        "inherits" => Ok(EdgeKind::Inherits),
        "defines" => Ok(EdgeKind::Defines),
        "reads" => Ok(EdgeKind::Reads),
        "writes" => Ok(EdgeKind::Writes),
        "shares" => Ok(EdgeKind::Shares),
        "triggers" => Ok(EdgeKind::Triggers),
        "awaits" => Ok(EdgeKind::Awaits),
        "sequences" => Ok(EdgeKind::Sequences),
        other => Err(format!("unknown edge kind: '{}'", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Node, NodeKind, EdgeKind};

    fn make_test_node(id: &str, kind: NodeKind) -> Node {
        let mut n = Node::new(id, id, kind);
        n.location = Some(format!("src/{}.rs:1", id));
        n.out_degree = 1;
        n.in_degree = 0;
        n.position = Some([1.0, 2.0, 3.0]);
        n.community_id = Some(42);
        n
    }

    #[test]
    fn test_all_node_kinds_survive_sqlite_roundtrip() {
        let tmp = std::env::temp_dir().join("hologram_test_node_kinds");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let db = SqliteDb::open(&tmp).unwrap();

        // Write one node of each NodeKind variant
        let all_kinds = vec![
            NodeKind::Symbol,
            NodeKind::Function,
            NodeKind::Class,
            NodeKind::Module,
            NodeKind::File,
            NodeKind::Interface,
            NodeKind::Medium,
            NodeKind::Temporal,
        ];
        let nodes: Vec<Node> = all_kinds.iter()
            .map(|k| make_test_node(k.as_str(), *k))
            .collect();
        let edges = vec![
            ("symbol", "function", EdgeKind::Calls, 1u8, None::<f64>),
        ];

        db.bulk_replace_all(&nodes.iter().collect::<Vec<_>>(), &edges).unwrap();

        // Read back and verify every kind is preserved
        let loaded = db.load_all_nodes().unwrap();
        assert_eq!(loaded.len(), 8, "all 8 nodes should survive round-trip");

        for node in &loaded {
            let expected_kind_str = node.id.as_str(); // we named nodes by their kind string
            let expected_kind = match expected_kind_str {
                "symbol" => NodeKind::Symbol,
                "function" => NodeKind::Function,
                "class" => NodeKind::Class,
                "module" => NodeKind::Module,
                "file" => NodeKind::File,
                "interface" => NodeKind::Interface,
                "medium" => NodeKind::Medium,
                "temporal" => NodeKind::Temporal,
                _ => panic!("unexpected node id: {}", node.id),
            };
            assert_eq!(std::mem::discriminant(&node.kind), std::mem::discriminant(&expected_kind),
                "node '{}' loaded as {:?}, expected {:?}", node.id, node.kind, expected_kind);
            // Verify other fields survived
            assert_eq!(node.out_degree, 1);
            assert_eq!(node.in_degree, 0);
            assert_eq!(node.position, Some([1.0, 2.0, 3.0]));
            assert_eq!(node.community_id, Some(42));
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_edge_fields_survive_sqlite_roundtrip() {
        let tmp = std::env::temp_dir().join("hologram_test_edge_fields");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let db = SqliteDb::open(&tmp).unwrap();

        let nodes: Vec<Node> = vec![
            make_test_node("a", NodeKind::Symbol),
            make_test_node("b", NodeKind::Symbol),
        ];
        let edges: Vec<(&str, &str, EdgeKind, u8, Option<f64>)> = vec![
            ("a", "b", EdgeKind::Calls, 3u8, Some(0.5)),
            ("a", "b", EdgeKind::Reads, 2u8, None),
        ];

        db.bulk_replace_all(&nodes.iter().collect::<Vec<_>>(), &edges).unwrap();

        let loaded = db.load_all_edges().unwrap();
        assert_eq!(loaded.len(), 2);

        let calls = loaded.iter().find(|(_, _, k, _, _)| *k == EdgeKind::Calls).unwrap();
        assert_eq!(calls.3, 3); // coupling_depth
        assert_eq!(calls.4, Some(0.5)); // temporal_delay_sec

        let reads = loaded.iter().find(|(_, _, k, _, _)| *k == EdgeKind::Reads).unwrap();
        assert_eq!(reads.3, 2);
        assert!(reads.4.is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
