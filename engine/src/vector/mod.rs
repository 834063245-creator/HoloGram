// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Code vector index — embeds function/class source snippets via n-gram hashing,
// stores in HNSW index, serves semantic search.
//
// ponytail: pure Rust embedder (embed.rs) — zero deps, zero models, zero downloads.
// 3-gram character hashing captures lexical similarity well enough for code search.
// When a proper embedding model is available (e.g. bundled MiniLM ONNX), swap
// the embed module for neural embeddings.

mod embed;

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::collections::HashMap;

use tracing::{info, warn};

use crate::graph::{Node, NodeKind};

pub const VECTOR_DIM: usize = embed::EMBED_DIM;

// ═══════════════════════════════════════════════════════════════
// CodeVectorIndex
// ═══════════════════════════════════════════════════════════════

pub struct CodeVectorIndex {
    index: Arc<RwLock<Option<usearch::Index>>>,
    slots: Arc<RwLock<Vec<String>>>,
    node_to_slot: Arc<RwLock<HashMap<String, usize>>>,
    path: PathBuf,
}

impl CodeVectorIndex {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            index: Arc::new(RwLock::new(None)),
            slots: Arc::new(RwLock::new(Vec::new())),
            node_to_slot: Arc::new(RwLock::new(HashMap::new())),
            path: path.into(),
        }
    }

    fn ensure_index(&self, capacity: usize) -> Result<(), String> {
        if self.index.read().unwrap().is_some() { return Ok(()); }
        let options = usearch::IndexOptions {
            dimensions: VECTOR_DIM,
            metric: usearch::MetricKind::Cos,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        };
        let idx = usearch::Index::new(&options)
            .map_err(|e| format!("usearch index creation failed: {e}"))?;
        idx.reserve(capacity.max(1))
            .map_err(|e| format!("usearch reserve failed: {e}"))?;
        *self.index.write().unwrap() = Some(idx);
        Ok(())
    }

    /// Build the vector index from graph nodes.
    pub fn build(&self, nodes: &[Node]) -> Result<usize, String> {
        self.ensure_index(nodes.len())?;
        // Reserve capacity (always, even if index was already initialized)
        if let Some(ref idx) = *self.index.read().unwrap() {
            idx.reserve(nodes.len().max(1))
                .map_err(|e| format!("usearch reserve failed: {e}"))?;
        }

        let mut node_ids = Vec::with_capacity(nodes.len());
        let mut snippets = Vec::with_capacity(nodes.len());
        for node in nodes {
            let text = match &node.snippet {
                Some(s) if !s.trim().is_empty() => s.clone(),
                _ => format!("{} {}", node.kind.as_str(), node.name),
            };
            node_ids.push(node.id.clone());
            snippets.push(text);
        }

        if snippets.is_empty() { warn!("[vector] no nodes to embed"); return Ok(0); }

        let total = snippets.len();
        info!("[vector] embedding {} nodes (ngram hash, {} dim)...", total, VECTOR_DIM);

        let mut slot = 0usize;
        let mut slots = self.slots.write().unwrap();
        let mut node_to_slot = self.node_to_slot.write().unwrap();
        let mut index = self.index.write().unwrap();
        let index = index.as_mut().ok_or("index not initialized")?;

        slots.clear();
        node_to_slot.clear();
        slots.reserve(total);
        node_to_slot.reserve(total);

        for i in 0..total {
            let vec = embed::embed(&snippets[i]);
            index.add(slot as u64, &vec)
                .map_err(|e| format!("usearch add failed: {e}"))?;
            slots.push(node_ids[i].clone());
            node_to_slot.insert(node_ids[i].clone(), slot);
            slot += 1;

            if i > 0 && i % 500 == 0 {
                info!("[vector] embedded {}/{} nodes", i, total);
            }
        }

        info!("[vector] indexed {} nodes", slots.len());
        Ok(slots.len())
    }

    /// Search. Returns ranked (node_id, similarity) pairs.
    pub fn search(&self, query: &str, top_k: usize) -> Result<Vec<(String, f32)>, String> {
        let q_vec = embed::embed(query);

        let index = self.index.read().unwrap();
        let index = index.as_ref().ok_or("index not initialized")?;
        let slots = self.slots.read().unwrap();

        if slots.is_empty() { return Ok(vec![]); }

        let results = index.search(&q_vec, top_k)
            .map_err(|e| format!("usearch search failed: {e}"))?;

        let mut output = Vec::with_capacity(results.keys.len());
        for (slot_key, distance) in results.keys.iter().zip(results.distances.iter()) {
            let slot = *slot_key as usize;
            if slot < slots.len() {
                let similarity = 1.0 - (*distance as f32).min(2.0).max(0.0);
                output.push((slots[slot].clone(), similarity));
            }
        }
        Ok(output)
    }

    pub fn save(&self) -> Result<(), String> {
        let index = self.index.read().unwrap();
        let index = index.as_ref().ok_or("index not initialized")?;
        let path_str = self.path.to_str().ok_or("non-UTF8 path")?;
        index.save(path_str).map_err(|e| format!("usearch save: {e}"))?;
        info!("[vector] saved index to {}", path_str);

        let slot_path = self.path.with_extension("slots.json");
        let slots = self.slots.read().unwrap();
        let data = serde_json::json!({ "slots": *slots, "dim": VECTOR_DIM });
        std::fs::write(&slot_path, serde_json::to_string(&data).unwrap())
            .map_err(|e| format!("slot save: {e}"))?;
        Ok(())
    }

    pub fn load(&self) -> Result<usize, String> {
        let path_str = self.path.to_str().ok_or("non-UTF8 path")?;
        if !self.path.exists() { return Ok(0); }

        let idx = usearch::Index::restore(path_str)
            .map_err(|e| format!("usearch restore: {e}"))?;

        let slot_path = self.path.with_extension("slots.json");
        if slot_path.exists() {
            let data: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(&slot_path).map_err(|e| format!("read slots: {e}"))?
            ).map_err(|e| format!("parse slots: {e}"))?;
            let loaded: Vec<String> = data["slots"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();

            let mut node_to_slot = self.node_to_slot.write().unwrap();
            node_to_slot.clear();
            for (i, id) in loaded.iter().enumerate() {
                node_to_slot.insert(id.clone(), i);
            }
            *self.slots.write().unwrap() = loaded;
        }

        let count = self.slots.read().unwrap().len();
        *self.index.write().unwrap() = Some(idx);
        info!("[vector] loaded index: {} vectors", count);
        Ok(count)
    }

    pub fn exists_on_disk(&self) -> bool { self.path.exists() }
}

/// Extract source snippet for a node from file content.
pub fn extract_snippet(source: &str, node_name: &str, node_kind: &NodeKind) -> Option<String> {
    if matches!(node_kind, NodeKind::File) {
        let lines: Vec<&str> = source.lines().take(5).collect();
        return Some(lines.join("\n"));
    }

    for (line_num, line) in source.lines().enumerate() {
        if line.contains(node_name) {
            let all_lines: Vec<&str> = source.lines().collect();
            let start = line_num.saturating_sub(1);
            let end = (start + 30).min(all_lines.len());
            return Some(all_lines[start..end].join("\n"));
        }
    }
    Some(format!("{} {}", node_kind.as_str(), node_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_snippet() {
        let source = "import os\n\ndef hello_world():\n    print('hello')\n    return 42\n";
        let s = extract_snippet(source, "hello_world", &NodeKind::Function).unwrap();
        assert!(s.contains("hello_world"));
    }

    #[test]
    fn test_real_generated_index() {
        // Verify the vector index built during tauri dev actually works
        let path = "D:/HoloGramHG/.hologram/vectors.usearch";
        if !std::path::Path::new(path).exists() {
            eprintln!("SKIP: {path} not found — run analyze first");
            return;
        }
        let vi = CodeVectorIndex::new(path);
        let n = vi.load().unwrap();
        eprintln!("Loaded {n} vectors from {path}");

        // Test searches against the actual HoloGram codebase
        let tests = [
            ("payment processing", "Should find payment/transaction related code"),
            ("window button minimize", "Should find window control UI code"),
            ("graph community layout", "Should find graph/community detection code"),
        ];
        for (query, desc) in &tests {
            let results = vi.search(query, 5).unwrap();
            eprintln!("\n--- {desc} ---");
            eprintln!("  query: \"{query}\"");
            for (id, score) in &results {
                eprintln!("  {:.2}  {id}", score);
            }
            assert!(!results.is_empty(), "search '{query}' should return results");
        }
    }

    #[test]
    fn test_vector_index_build_search() {
        let tmp = std::env::temp_dir().join("hologram_vi_test");
        let _ = std::fs::create_dir_all(&tmp);
        let idx_path = tmp.join("test_vectors.usearch");

        let vi = CodeVectorIndex::new(&idx_path);

        let mut n1 = Node::new("n1", "handle_payment", NodeKind::Function);
        n1.snippet = Some("fn handle_payment(amount: f64) -> Result<Receipt, Error> { process(amount) }".into());
        let mut n2 = Node::new("n2", "render_ui", NodeKind::Function);
        n2.snippet = Some("fn render_ui() { draw_button(); draw_text(); }".into());
        let mut n3 = Node::new("n3", "process_refund", NodeKind::Function);
        n3.snippet = Some("fn process_refund(order_id: u64) -> Result<Money, Error> { validate(order_id) }".into());

        let count = vi.build(&[n1, n2, n3]).unwrap();
        assert_eq!(count, 3);

        let results = vi.search("payment processing", 2).unwrap();
        assert!(!results.is_empty());
        eprintln!("search 'payment processing': {:?}", results.iter().map(|(id, s)| format!("{id}({:.2})", s)).collect::<Vec<_>>());
        // handle_payment should be top
        assert_eq!(results[0].0, "n1");

        vi.save().unwrap();
        let vi2 = CodeVectorIndex::new(&idx_path);
        assert_eq!(vi2.load().unwrap(), 3);

        let results2 = vi2.search("refund money", 2).unwrap();
        eprintln!("reloaded search 'refund': {:?}", results2.iter().map(|(id, s)| format!("{id}({:.2})", s)).collect::<Vec<_>>());
        assert_eq!(results2[0].0, "n3");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
