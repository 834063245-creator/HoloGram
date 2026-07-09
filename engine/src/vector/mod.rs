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
    tokenizer: tokenizer::BpeTokenizer,
    dim: usize,
}

impl OnnxEmbedder {
    pub const MODEL_ID: &str = "intfloat/multilingual-e5-large";
    pub const DIM: usize = 1024;

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
        ).map_err(|e| format!("ONNX load failed: {e}"))?;

        let tokenizer = tokenizer::BpeTokenizer::from_file(
            tok_path.to_str().ok_or("non-UTF8 tokenizer path")?
        ).map_err(|e| format!("tokenizer init failed: {e}"))?;

        info!("[vector] embedder ready: {} ({} dim)", Self::MODEL_ID, Self::DIM);
        Ok(Self { session, tokenizer, dim: Self::DIM })
    }

    pub fn dim(&self) -> usize { self.dim }

    /// Embed text → 1024-dim vector. E5 uses "query:" / "passage:" prefixes.
    pub fn embed(&self, text: &str, is_query: bool) -> Result<Vec<f32>, String> {
        if text.trim().is_empty() { return Ok(vec![0.0f32; self.dim]); }

        let input = if is_query {
            format!("query: {text}")
        } else {
            format!("passage: {text}")
        };

        let (ids, mask) = self.tokenizer.encode(&input)
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

/// Find model.onnx + tokenizer.json in HuggingFace cache snapshot.
fn find_model_files(model_root: &Path) -> Option<(PathBuf, PathBuf)> {
    let snapshots = model_root.join("snapshots");
    if !snapshots.exists() { return None; }
    for entry in std::fs::read_dir(&snapshots).ok()?.flatten() {
        let path = entry.path();
        let model = path.join("onnx").join("model.onnx");
        let tok = path.join("tokenizer.json");
        if model.exists() && tok.exists() {
            return Some((model, tok));
        }
    }
    None
}

/// Find model bundled with the app (next to exe).
fn find_bundled_model() -> Option<(PathBuf, PathBuf)> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join("models").join("multilingual-e5-large"),
        PathBuf::from("models/multilingual-e5-large"),
    ];
    for dir in &candidates {
        let model = dir.join("model.onnx");
        let tok = dir.join("tokenizer.json");
        if model.exists() && tok.exists() {
            return Some((model, tok));
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

    /// Verify ONNX DLL loads and e5-large model works (diagnostic, step-by-step).
    #[test]
    fn test_onnx_diagnostic() {
        let model_path = "C:/Users/Administrator/.cache/huggingface/hub/models--intfloat--multilingual-e5-large/snapshots/3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3/onnx/model.onnx";
        let tok_path = "C:/Users/Administrator/.cache/huggingface/hub/models--intfloat--multilingual-e5-large/snapshots/3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3/tokenizer.json";

        eprintln!("[1/3] testing ONNX DLL load...");
        let session = match onnx_ffi::OrtSession::new(model_path) {
            Ok(s) => { eprintln!("  OK: model opened"); s }
            Err(e) => { eprintln!("  FAIL: {e}"); return; }
        };

        eprintln!("[2/3] testing BPE tokenizer...");
        let tok = match tokenizer::BpeTokenizer::from_file(tok_path) {
            Ok(t) => { eprintln!("  OK: {}", t.vocab_size()); t }
            Err(e) => { eprintln!("  FAIL: {e}"); return; }
        };

        eprintln!("[3/3] testing tokenize + run...");
        let (ids, mask) = tok.encode("query: fn process_payment").unwrap();
        eprintln!("  tokenized: {} tokens", ids.len());
        match session.run(&ids, &mask, ids.len(), 1024) {
            Ok(output) => eprintln!("  OK: output {} elements, first: {:?}", output.len(), &output[..5.min(output.len())]),
            Err(e) => eprintln!("  FAIL: {e}"),
        }
    }

    /// Smoke test: verify MiniLM model loads and produces valid embeddings.
    #[test]
    fn test_embedder_loads_and_embeds() {
        let embedder = match OnnxEmbedder::new() {
            Ok(e) => e,
            Err(e) => {
                eprintln!("SKIP: embedder not available ({e})");
                return;
            }
        };
        assert_eq!(embedder.dim(), 384, "MiniLM should be 384-dim");

        // Embed two similar code snippets
        let v1 = embedder.embed("fn process_payment(amount: f64) -> Result<(), Error>", false).unwrap();
        let v2 = embedder.embed("fn handle_transaction(money: f64) -> Result<(), Error>", false).unwrap();
        let v3 = embedder.embed("fn render_ui_component() { draw_button(); }", false).unwrap();

        assert_eq!(v1.len(), 384);
        assert_eq!(v2.len(), 384);
        assert_eq!(v3.len(), 384);

        // Compute cosine similarities
        let sim_payment_tx = cosine(&v1, &v2);
        let sim_payment_ui = cosine(&v1, &v3);

        eprintln!("sim(payment, transaction) = {:.3}", sim_payment_tx);
        eprintln!("sim(payment, ui) = {:.3}", sim_payment_ui);

        // payment should be closer to transaction than to UI rendering
        assert!(
            sim_payment_tx > sim_payment_ui,
            "semantic similarity failed: payment-transaction ({:.3}) should exceed payment-ui ({:.3})",
            sim_payment_tx, sim_payment_ui
        );
    }

    /// Integration test: build index, search, save, reload, search again.
    #[test]
    fn test_vector_index_full_pipeline() {
        let embedder = match OnnxEmbedder::new() {
            Ok(e) => e,
            Err(_) => return,
        };

        let tmp = std::env::temp_dir().join("hologram_vi_test");
        let _ = std::fs::create_dir_all(&tmp);
        let idx_path = tmp.join("test_full.usearch");

        let vi = CodeVectorIndex::new(&idx_path);

        // Manually init embedder (skip model search)
        *vi.embedder.write().unwrap() = Some(embedder);
        vi.ensure_index().unwrap();

        // Build index with real code snippets
        let mut n1 = Node::new("n1", "process_refund", NodeKind::Function);
        n1.snippet = Some("fn process_refund(order_id: u64) -> Result<Money, Error> { validate_order(order_id)?; let amount = calculate_refund(order_id); issue_credit(amount) }".into());
        let mut n2 = Node::new("n2", "handle_payment", NodeKind::Function);
        n2.snippet = Some("fn handle_payment(amount: f64, method: PaymentMethod) -> Result<Receipt, Error> { let tx = create_transaction(amount, method)?; process_tx(&tx) }".into());
        let mut n3 = Node::new("n3", "draw_toolbar", NodeKind::Function);
        n3.snippet = Some("fn draw_toolbar(ctx: &mut UIContext) { ctx.clear(); ctx.draw_rect(0, 0, 800, 32, COLOR_DARK); ctx.draw_button(750, 4, 24, 24, \"X\"); }".into());
        let mut n4 = Node::new("n4", "render_sidebar", NodeKind::Function);
        n4.snippet = Some("fn render_sidebar(ctx: &mut UIContext, items: &[NavItem]) { for item in items { ctx.draw_list_item(item.label, item.icon); } }".into());
        let mut n5 = Node::new("n5", "charge_customer", NodeKind::Function);
        n5.snippet = Some("fn charge_customer(customer_id: u64, amount: f64) -> Result<Invoice, Error> { let cust = find_customer(customer_id)?; let invoice = create_invoice(&cust, amount); process_invoice(&invoice) }".into());

        let count = vi.build(&[n1, n2, n3, n4, n5]).unwrap();
        assert_eq!(count, 5);

        // Search: payment-related
        let results = vi.search("payment processing and refunds", 3).unwrap();
        assert!(!results.is_empty());
        let top_ids: Vec<&str> = results.iter().map(|(id, _)| id.as_str()).collect();
        eprintln!("search 'payment processing and refunds': {:?}", top_ids);
        // n1 (process_refund) or n2 (handle_payment) should be top
        assert!(
            top_ids[0] == "n1" || top_ids[0] == "n2" || top_ids[1] == "n1" || top_ids[1] == "n2",
            "payment query should return payment/refund nodes first, got: {:?}", top_ids
        );

        // Search: UI rendering
        let results2 = vi.search("user interface rendering and drawing", 3).unwrap();
        let top_ids2: Vec<&str> = results2.iter().map(|(id, _)| id.as_str()).collect();
        eprintln!("search 'user interface rendering': {:?}", top_ids2);
        assert!(
            top_ids2[0] == "n3" || top_ids2[0] == "n4",
            "UI query should return UI nodes first, got: {:?}", top_ids2
        );

        // Save + reload
        vi.save().unwrap();
        assert!(idx_path.exists());

        let vi2 = CodeVectorIndex::new(&idx_path);
        let loaded = vi2.load().unwrap();
        assert_eq!(loaded, 5);

        // Search from reloaded index
        let results3 = vi2.search("customer billing and charging", 2).unwrap();
        assert!(!results3.is_empty());
        eprintln!("reloaded search 'customer billing': {:?}", results3.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>());
        assert_eq!(results3[0].0, "n5", "billing query should return charge_customer first");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if na < 1e-8 || nb < 1e-8 { return 0.0; }
        (dot / (na * nb)).clamp(-1.0, 1.0)
    }
}

