// Query functions — migrated from graph/query.rs.
// All functions now delegate to MemoryIndex (O(degree)) instead of
// scanning Graph's HashMap<EdgeId, Edge> (O(E)).
//
// These are thin wrappers; MCP tools that go through GraphStore can also
// call MemoryIndex methods directly via store.read(|idx| ...).

use crate::graph::{EdgeKind, Node};
use crate::storage::memory::MemoryIndex;
use crate::storage::sqlite::SqliteDb;

/// Neighbors of a node up to `depth` hops (BFS).
pub fn neighbors(
    idx: &MemoryIndex,
    node_id: &str,
    depth: u8,
) -> Vec<(String, String, u8)> {
    idx.neighbors(node_id, depth, None)
}

/// Neighbors with edge kind filter.
pub fn neighbors_filtered(
    idx: &MemoryIndex,
    node_id: &str,
    depth: u8,
    kinds: &[EdgeKind],
) -> Vec<(String, String, u8)> {
    idx.neighbors(node_id, depth, Some(kinds))
}

/// BFS shortest path between two nodes.
pub fn shortest_path(idx: &MemoryIndex, from: &str, to: &str) -> Option<Vec<String>> {
    idx.shortest_path(from, to)
}

/// BFS impact (blast radius).
pub fn impact(idx: &MemoryIndex, node_id: &str, max_depth: usize) -> Vec<(usize, Vec<String>)> {
    idx.impact(node_id, max_depth)
}

/// FTS5 full-text search (only query path that hits SQLite).
pub fn search_nodes(db: &SqliteDb, idx: &MemoryIndex, query: &str, limit: usize) -> Vec<Node> {
    idx.fts_search(db, query, limit).unwrap_or_default()
}
