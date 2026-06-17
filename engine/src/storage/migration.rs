// Migration utilities: JSON → SQLite migration.
// The actual timeline.db merge is handled in SqliteDb::open() → migrate_timeline().
// This module provides the JSON-to-MemoryIndex-to-SQLite pipeline for first-time setup.

use std::path::Path;

use tracing::info;

use crate::graph::Graph;
use crate::storage::memory::MemoryIndex;
use crate::storage::sqlite::SqliteDb;

/// Try to load a graph from JSON and persist to SQLite.
/// Returns MemoryIndex on success, or an error string.
pub fn migrate_json_to_sqlite(json_path: &Path, db: &SqliteDb) -> Result<MemoryIndex, String> {
    let path_str = json_path.to_string_lossy();
    info!("[migration] loading JSON: {}", path_str);
    let graph = Graph::from_json_file(&path_str)
        .map_err(|e| format!("JSON parse error: {}", e))?;
    let idx = MemoryIndex::from_existing_graph(&graph);
    info!(
        "[migration] JSON parsed: {} nodes, {} edges",
        idx.node_count(),
        idx.edge_count()
    );
    idx.to_sqlite(db)?;
    info!("[migration] JSON → SQLite done");
    Ok(idx)
}
