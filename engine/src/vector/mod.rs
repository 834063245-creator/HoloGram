// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Code vector index — embeds function/class source snippets via ONNX,
// stores in HNSW index, serves semantic search.
//
// ponytail: fastembed's ort-sys doesn't support windows-gnu, so
// we use raw ONNX FFI + BPE tokenizer (proven in memory-bundle-rs).
// Model: intfloat/multilingual-e5-large (1024-dim, cached by memory-bundle-rs).

mod onnx_ffi;
mod tokenizer;

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::collections::HashMap;

use tracing::{info, warn};

use crate::graph::{Node, NodeKind};

// ═══════════════════════════════════════════════════════════════
// Embedder
// ═══════════════════════════════════════════════════════════════

pub struct OnnxEmbedder {
    session: onnx_ffi::OrtSession,
    tokenizer: tokenizer::WordPieceTokenizer,
    dim: usize,
}

impl OnnxEmbedder {
    pub const MODEL_ID: &str = "sentence-transformers/all-MiniLM-L6-v2";
    pub const DIM: usize = 384;

    /// Create embedder. Searches for model in HF cache, then bundled path.
    pub fn new() -> Result<Self, String> {
        let cache_dir = hf_cache_dir();
        let model_key = Self::MODEL_ID.replace('/', "--");
        let model_root = cache_dir.join("hub").join(format!("models--{model_key}"));

        // Find model in HF cache, or bundled with app
        let (model_path, tok_path) = find_model_files(&model_root)
            .or_else(|| find_bundled_model())
            .ok_or_else(|| format!(
                "Model '{}' not found. Download from HuggingFace to {} or bundle with app.",
                Self::MODEL_ID, model_root.display()
            ))?;

        info!("[vector] loading ONNX model from {}", model_path.display());
        let session = onnx_ffi::OrtSession::new(
            model_path.to_str().ok_or("non-UTF8 model path")?
        )?;

        let tokenizer = tokenizer::WordPieceTokenizer::from_file(
            tok_path.to_str().ok_or("non-UTF8 tokenizer path")?
        ).map_err(|e| format!("tokenizer init failed: {e}"))?;

        info!("[vector] embedder ready: {} ({} dim)", Self::MODEL_ID, Self::DIM);
        Ok(Self { session, tokenizer, dim: Self::DIM })
    }

    pub fn dim(&self) -> usize { self.dim }

    /// Embed text → 384-dim vector. Mean pooling over sequence.
    pub fn embed(&self, text: &str, _is_query: bool) -> Result<Vec<f32>, String> {
        if text.trim().is_empty() { return Ok(vec![0.0f32; self.dim]); }

        let (ids, mask) = self.tokenizer.encode(text)
            .map_err(|e| format!("tokenize failed: {e}"))?;
        let seq_len = ids.len();

        let output = self.session.run(&ids, &mask, seq_len, self.dim)
            .map_err(|e| format!("ONNX run failed: {e}"))?;

        // Mean pooling over sequence length
        let mut pooled = vec![0.0f32; self.dim];
        let mask_sum: f32 = mask.iter().map(|&m| m as f32).sum();
        if mask_sum < 1e-8 { return Ok(pooled); }

        for i in 0..seq_len {
            let w = mask[i] as f32 / mask_sum;
            for d in 0..self.dim {
                pooled[d] += w * output[i * self.dim + d];
            }
        }

        Ok(pooled)
    }
}

fn hf_cache_dir() -> PathBuf {
    std::env::var("HF_HOME")
        .or_else(|_| std::env::var("XDG_CACHE_HOME").map(|p| format!("{p}/huggingface")))
        .unwrap_or_else(|_| {
            let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
            format!("{home}/.cache/huggingface")
        })
        .into()
}

/// Find model.onnx + vocab.txt in HuggingFace cache snapshot.
fn find_model_files(model_root: &Path) -> Option<(PathBuf, PathBuf)> {
    let snapshots = model_root.join("snapshots");
    if !snapshots.exists() { return None; }
    for entry in std::fs::read_dir(&snapshots).ok()?.flatten() {
        let path = entry.path();
        // MiniLM: look for model.onnx (ONNX export) or model.safetensors → need ONNX
        let onnx_path = path.join("onnx").join("model.onnx");
        let model_path = if onnx_path.exists() {
            onnx_path
        } else {
            path.join("model.onnx")
        };
        let vocab_path = path.join("vocab.txt");
        if model_path.exists() && vocab_path.exists() {
            return Some((model_path, vocab_path));
        }
    }
    None
}

/// Find model bundled with the app (next to exe).
fn find_bundled_model() -> Option<(PathBuf, PathBuf)> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join("models").join("all-MiniLM-L6-v2"),
        exe_dir.join("all-MiniLM-L6-v2"),
        PathBuf::from("models/all-MiniLM-L6-v2"),
    ];
    for dir in &candidates {
        let model = dir.join("model.onnx");
        let vocab = dir.join("vocab.txt");
        if model.exists() && vocab.exists() {
            return Some((model, vocab));
        }
    }
    None
}

// ═══════════════════════════════════════════════════════════════
// CodeVectorIndex
// ═══════════════════════════════════════════════════════════════

pub struct CodeVectorIndex {
    embedder: Arc<RwLock<Option<OnnxEmbedder>>>,
    index: Arc<RwLock<Option<usearch::Index>>>,
    slots: Arc<RwLock<Vec<String>>>,
    node_to_slot: Arc<RwLock<HashMap<String, usize>>>,
    dim: usize,
    path: PathBuf,
}

impl CodeVectorIndex {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            embedder: Arc::new(RwLock::new(None)),
            index: Arc::new(RwLock::new(None)),
            slots: Arc::new(RwLock::new(Vec::new())),
            node_to_slot: Arc::new(RwLock::new(HashMap::new())),
            dim: OnnxEmbedder::DIM,
            path: path.into(),
        }
    }

    fn ensure_embedder(&self) -> Result<(), String> {
        if self.embedder.read().unwrap().is_some() { return Ok(()); }
        let e = OnnxEmbedder::new()?;
        *self.embedder.write().unwrap() = Some(e);
        Ok(())
    }

    fn ensure_index(&self) -> Result<(), String> {
        if self.index.read().unwrap().is_some() { return Ok(()); }
        let idx = usearch::Index::new(&usearch::IndexOptions {
            dimensions: self.dim,
            metric: usearch::MetricKind::Cos,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        }).map_err(|e| format!("usearch index creation failed: {e}"))?;
        *self.index.write().unwrap() = Some(idx);
        Ok(())
    }

    /// Build the vector index from graph nodes.
    pub fn build(&self, nodes: &[Node]) -> Result<usize, String> {
        self.ensure_embedder()?;
        self.ensure_index()?;

        let embedder = self.embedder.read().unwrap();
        let embedder = embedder.as_ref().ok_or("embedder not initialized")?;

        // Collect embeddable nodes
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

        if snippets.is_empty() {
            warn!("[vector] no nodes to embed");
            return Ok(0);
        }

        let total = snippets.len();
        info!("[vector] embedding {} nodes...", total);

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
            let vec = embedder.embed(&snippets[i], false)?;
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
        self.ensure_embedder()?;

        let embedder = self.embedder.read().unwrap();
        let embedder = embedder.as_ref().ok_or("embedder not initialized")?;
        let q_vec = embedder.embed(query, true)?;

        let index = self.index.read().unwrap();
        let index = index.as_ref().ok_or("index not initialized")?;
        let slots = self.slots.read().unwrap();

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
        let data = serde_json::json!({ "slots": *slots, "dim": self.dim });
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

    // Search for definition in source
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
    fn test_extract_snippet_function() {
        let source = "import os\n\ndef hello_world():\n    print('hello')\n    return 42\n";
        let s = extract_snippet(source, "hello_world", &NodeKind::Function).unwrap();
        assert!(s.contains("hello_world"));
    }

    #[test]
    fn test_extract_snippet_file_node() {
        let source = "# Project\nimport os\nclass Main:\n    pass\n";
        let s = extract_snippet(source, "main.py", &NodeKind::File).unwrap();
        assert!(s.contains("Project"));
    }
}
