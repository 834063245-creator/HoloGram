// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 代码向量索引 —— 嵌入函数/类源码片段，存储到 HNSW 索引中，提供语义搜索。
//
// 嵌入后端（embed.rs 自动选择）：
//   1. MiniLM（minilm.rs）—— sentence-transformers/all-MiniLM-L6-v2（ONNX，384 维），
//      经 ort crate 动态加载项目自带 onnxruntime.dll，语义区分度高。
//   2. n-gram 哈希（embed.rs::ngram_embed）—— 零依赖兜底，词法相似性。
// 索引文件带嵌入后端标识（slots.json 的 model 字段），后端切换后旧索引
// 自动判废（load 返回 0），需重新分析重建。

mod embed;
pub use embed::{backend_id, embed, embed_batch, score_threshold};

mod minilm;
mod wordpiece;

use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use tracing::{info, warn};

use crate::graph::{Node, NodeKind};

pub const VECTOR_DIM: usize = embed::EMBED_DIM;

// ═══════════════════════════════════════════════════════════════
// CodeVectorIndex
// ═══════════════════════════════════════════════════════════════

pub struct CodeVectorIndex {
    index: Arc<RwLock<Option<usearch::Index>>>,
    slots: Arc<RwLock<Vec<String>>>,
    path: PathBuf,
}

impl CodeVectorIndex {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            index: Arc::new(RwLock::new(None)),
            slots: Arc::new(RwLock::new(Vec::new())),
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

    /// 从图节点构建向量索引。
    pub fn build(&self, nodes: &[Node]) -> Result<usize, String> {
        self.ensure_index(nodes.len())?;
        // 预留容量（始终执行，即使索引已初始化）
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

        if snippets.is_empty() { warn!("[vector] 无节点可嵌入"); return Ok(0); }

        let total = snippets.len();
        info!("[vector] 正在嵌入 {} 个节点（{}, {} 维）...", total, embed::backend_id(), VECTOR_DIM);

        // 进程级向量缓存：watcher 每次文件保存都会触发全量 build()，
        // 未变更节点按 snippet 内容哈希直接命中，只有新增/变更节点真正走推理。
        let hashes: Vec<u64> = snippets.iter().map(|s| snippet_hash(s)).collect();
        let mut vectors: Vec<Option<Arc<Vec<f32>>>> = (0..total).map(|_| None).collect();
        let mut misses: Vec<usize> = Vec::new();
        {
            let cache = VECTOR_CACHE.lock().map_err(|e| format!("vector cache lock: {e}"))?;
            for (i, h) in hashes.iter().enumerate() {
                match cache.get(h) {
                    Some(v) => vectors[i] = Some(v.clone()),
                    None => misses.push(i),
                }
            }
        }

        // 顺序 batch 推理（不再 par_iter：共享 session 的 Mutex 实测负加速 0.63x，
        // 且堵满 rayon 全局池会饿死解析/dataflow 任务 —— 见 minilm.rs::embed_batch）
        if !misses.is_empty() {
            info!("[vector] {} 个节点待嵌入（{} 个命中缓存）", misses.len(), total - misses.len());
            // 按长度排序分桶：batch 内 padding 对齐到最长样本，长度相近的样本同批
            // 可显著减少填充浪费（文件头 5 行 vs 函数体 30 行混在一起时差 6 倍）
            misses.sort_by_key(|&i| snippets[i].len());
        }
        let mut embedded: Vec<(u64, Arc<Vec<f32>>)> = Vec::new();
        for (n_done, chunk) in misses.chunks(256).enumerate() {
            let batch: Vec<&str> = chunk.iter().map(|&i| snippets[i].as_str()).collect();
            let vecs = embed::embed_batch(&batch);
            for (&i, v) in chunk.iter().zip(vecs) {
                let v = Arc::new(v);
                vectors[i] = Some(v.clone());
                embedded.push((hashes[i], v));
            }
            let done = (n_done + 1) * 256;
            if done % 1024 < 256 && done < misses.len() {
                info!("[vector] embedded {}/{} nodes", done, misses.len());
            }
        }
        if !embedded.is_empty() {
            let mut cache = VECTOR_CACHE.lock().map_err(|e| format!("vector cache lock: {e}"))?;
            for (h, v) in embedded { cache.insert(h, v); }
        }

        let mut slot = 0usize;
        let mut slots = self.slots.write().unwrap();
        let mut index = self.index.write().unwrap();
        let index = index.as_mut().ok_or("index not initialized")?;

        slots.clear();
        slots.reserve(total);

        for (i, vec) in vectors.iter().enumerate() {
            let vec = vec.as_ref().expect("所有 snippet 均已嵌入");
            index.add(slot as u64, vec)
                .map_err(|e| format!("usearch add failed: {e}"))?;
            slots.push(node_ids[i].clone());
            slot += 1;
        }

        info!("[vector] 已索引 {} 个节点", slots.len());
        Ok(slots.len())
    }

    /// 搜索。返回排序后的 (node_id, 相似度) 对。
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
                let similarity = 1.0 - (*distance).min(2.0).max(0.0);
                output.push((slots[slot].clone(), similarity));
            }
        }
        Ok(output)
    }

    /// 原子落盘：先写临时文件再 rename，崩溃不会留下 index/slots 不一致的半成品。
    pub fn save(&self) -> Result<(), String> {
        let index = self.index.read().unwrap();
        let index = index.as_ref().ok_or("index not initialized")?;

        // 1. 索引 → tmp → rename
        let tmp_index = self.path.with_extension("usearch.tmp");
        let tmp_str = tmp_index.to_str().ok_or("non-UTF8 path")?;
        index.save(tmp_str).map_err(|e| format!("usearch save: {e}"))?;
        std::fs::rename(&tmp_index, &self.path)
            .map_err(|e| format!("usearch rename: {e}"))?;
        info!("[vector] 索引已保存到 {}", self.path.display());

        // 2. slots（含嵌入后端标识）→ tmp → rename
        let slot_path = self.path.with_extension("slots.json");
        let tmp_slot = self.path.with_extension("slots.json.tmp");
        let slots = self.slots.read().unwrap();
        let data = serde_json::json!({
            "slots": *slots,
            "dim": VECTOR_DIM,
            "model": embed::backend_id(),
        });
        let json_str = serde_json::to_string(&data)
            .map_err(|e| format!("slot serialize: {e}"))?;
        std::fs::write(&tmp_slot, json_str)
            .map_err(|e| format!("slot save: {e}"))?;
        std::fs::rename(&tmp_slot, &slot_path)
            .map_err(|e| format!("slot rename: {e}"))?;
        Ok(())
    }

    pub fn load(&self) -> Result<usize, String> {
        let path_str = self.path.to_str().ok_or("non-UTF8 path")?;
        if !self.path.exists() { return Ok(0); }

        let idx = usearch::Index::restore(path_str)
            .map_err(|e| format!("usearch restore: {e}"))?;

        let slot_path = self.path.with_extension("slots.json");
        if !slot_path.exists() {
            warn!("[vector] slots.json 缺失，索引不可用（需重新分析）");
            return Ok(0);
        }
        let data: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&slot_path).map_err(|e| format!("read slots: {e}"))?
        ).map_err(|e| format!("parse slots: {e}"))?;

        // 嵌入空间校验：索引的嵌入后端必须与当前激活后端一致，
        // 否则查询向量与索引向量不在同一空间，结果全是垃圾（静默错误）。
        let saved_model = data["model"].as_str().unwrap_or("ngram-hash"); // 旧索引无此字段 → n-gram
        let active = embed::backend_id();
        if saved_model != active {
            warn!("[vector] 索引嵌入后端不匹配（索引={saved_model}, 当前={active}），跳过向量搜索直至重新分析");
            return Ok(0);
        }

        let loaded: Vec<String> = data["slots"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        // 一致性校验：slots 数必须与索引内向量数一致，否则 slot 映射错位
        let index_size = idx.size();
        if loaded.len() != index_size {
            warn!("[vector] 索引/slots 不一致（index={index_size}, slots={}），索引不可用（需重新分析）", loaded.len());
            return Ok(0);
        }

        *self.slots.write().unwrap() = loaded;

        let count = self.slots.read().unwrap().len();
        *self.index.write().unwrap() = Some(idx);
        info!("[vector] 已加载索引: {} 个向量", count);
        Ok(count)
    }

    pub fn exists_on_disk(&self) -> bool { self.path.exists() }
}

// ── 进程级向量缓存：snippet 内容哈希 → 嵌入向量 ──
// 增量重建（watcher 每次文件保存触发）都对全量节点调 build()；缓存让未变更
// 节点免于重新推理，只有新增/变更节点真正走 MiniLM。5258 节点约占 8MB 内存。
static VECTOR_CACHE: LazyLock<Mutex<std::collections::HashMap<u64, Arc<Vec<f32>>>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// snippet 内容哈希（向量缓存键）。只需同一进程内一致，DefaultHasher 足够。
fn snippet_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

// ── 进程级缓存：加载的向量索引在搜索间复用 ──
// 缓存条目附带加载时索引文件的 mtime；mtime 变化（重新分析/增量重建）→ 自动失效重载。
static CACHED_INDEX: LazyLock<Mutex<Option<CachedIndex>>> = LazyLock::new(|| Mutex::new(None));

struct CachedIndex {
    vi: CodeVectorIndex,
    path: PathBuf,
    mtime: Option<std::time::SystemTime>,
}

fn index_mtime(path: &std::path::Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// 获取或创建给定项目根目录的缓存 CodeVectorIndex。
/// 首次访问时从磁盘加载；项目路径或索引文件 mtime 变化时自动重载。
pub fn get_or_load_index(project_root: &std::path::Path) -> Result<(Arc<RwLock<Option<usearch::Index>>>, Arc<RwLock<Vec<String>>>), String> {
    let path = project_root.join(".hologram").join("vectors.usearch");
    let current_mtime = index_mtime(&path);
    let mut cache = CACHED_INDEX.lock().map_err(|e| format!("vector cache lock: {e}"))?;

    let stale = match cache.as_ref() {
        None => true,
        Some(c) => c.path != path || c.mtime != current_mtime,
    };
    if stale {
        let vi = CodeVectorIndex::new(&path);
        if vi.exists_on_disk() {
            vi.load()?;
        }
        *cache = Some(CachedIndex { vi, path, mtime: current_mtime });
    }
    let c = cache.as_ref().unwrap();
    Ok((c.vi.index.clone(), c.vi.slots.clone()))
}

/// 重建完成后显式失效缓存（下次搜索重新加载磁盘上的新索引）。
pub fn invalidate_cache() {
    if let Ok(mut cache) = CACHED_INDEX.lock() {
        *cache = None;
    }
}

// ── 重建并发守卫：全量/增量重建共用，防止两个线程同时写同一索引文件 ──
static BUILD_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 尝试开始一次向量索引重建；已有重建在进行时返回 false（调用方应跳过本轮）。
pub fn try_begin_build() -> bool {
    !BUILD_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel)
}

/// 结束重建（必须与 try_begin_build 配对）。
pub fn end_build() {
    BUILD_RUNNING.store(false, std::sync::atomic::Ordering::Release);
}

/// 过滤向量命中：输入须按相似度降序。
/// 低于阈值丢弃（降序输入可提前终止）、与已有结果去重、命中内去重、最多 max_hits 条。
/// 引擎 handler 与 Tauri search 共用同一套策略。
pub fn filter_hits(
    raw: &[(String, f32)],
    threshold: f32,
    max_hits: usize,
    existing: &std::collections::HashSet<&str>,
) -> Vec<(String, f32)> {
    let mut hits: Vec<(String, f32)> = Vec::with_capacity(max_hits);
    for (id, score) in raw {
        if *score < threshold { break; }
        if existing.contains(id.as_str()) { continue; }
        if hits.iter().any(|(h, _)| h == id) { continue; }
        hits.push((id.clone(), *score));
        if hits.len() >= max_hits { break; }
    }
    hits
}

/// 从文件内容中提取节点的源码片段。
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

    /// 后端不匹配的索引必须判废（load 返回 0），防止跨嵌入空间的垃圾结果
    #[test]
    fn test_load_rejects_backend_mismatch() {
        let tmp = std::env::temp_dir().join(format!("hologram_vi_mismatch_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let idx_path = tmp.join("vectors.usearch");

        let vi = CodeVectorIndex::new(&idx_path);
        let mut n1 = Node::new("n1", "handle_payment", NodeKind::Function);
        n1.snippet = Some("fn handle_payment(amount: f64) -> Result<Receipt> { charge(amount) }".into());
        vi.build(&[n1]).unwrap();
        vi.save().unwrap();

        // 原子落盘：不应残留临时文件
        assert!(!tmp.join("vectors.usearch.tmp").exists());
        assert!(!tmp.join("vectors.slots.json.tmp").exists());

        // 篡改 slots.json 的后端标识 → load 应判废
        let slot_path = idx_path.with_extension("slots.json");
        let data = std::fs::read_to_string(&slot_path).unwrap();
        let tampered = data.replace(crate::vector::backend_id(), "bogus-backend");
        assert!(tampered != data, "slots.json 应包含当前后端标识");
        std::fs::write(&slot_path, tampered).unwrap();

        let vi2 = CodeVectorIndex::new(&idx_path);
        assert_eq!(vi2.load().unwrap(), 0, "后端不匹配的索引必须判废");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// slots 数与索引向量数不一致时必须判废（防止 slot 映射静默错位）
    #[test]
    fn test_load_rejects_size_mismatch() {
        let tmp = std::env::temp_dir().join(format!("hologram_vi_size_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let idx_path = tmp.join("vectors.usearch");

        let vi = CodeVectorIndex::new(&idx_path);
        let nodes: Vec<Node> = (0..3).map(|i| {
            let mut n = Node::new(&format!("n{i}"), &format!("func_{i}"), NodeKind::Function);
            n.snippet = Some(format!("fn func_{i}() {{ do_work({i}); }}"));
            n
        }).collect();
        vi.build(&nodes).unwrap();
        vi.save().unwrap();

        // 删掉一个 slot → 数量不一致
        let slot_path = idx_path.with_extension("slots.json");
        let mut data: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&slot_path).unwrap()
        ).unwrap();
        data["slots"].as_array_mut().unwrap().pop();
        std::fs::write(&slot_path, serde_json::to_string(&data).unwrap()).unwrap();

        let vi2 = CodeVectorIndex::new(&idx_path);
        assert_eq!(vi2.load().unwrap(), 0, "slots/index 数量不一致必须判废");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 索引文件重建（mtime 变化）后，进程级缓存必须自动失效并重载
    #[test]
    fn test_cache_invalidates_on_index_update() {
        let root = std::env::temp_dir().join(format!("hologram_vi_cache_{}", std::process::id()));
        let dir = root.join(".hologram");
        std::fs::create_dir_all(&dir).unwrap();
        let idx_path = dir.join("vectors.usearch");

        // 首次：索引不存在 → 空缓存
        let (_, slots) = get_or_load_index(&root).unwrap();
        assert!(slots.read().unwrap().is_empty());

        // 构建并保存索引（文件出现，mtime 变化）
        let vi = CodeVectorIndex::new(&idx_path);
        let mut n1 = Node::new("n1", "handle_payment", NodeKind::Function);
        n1.snippet = Some("fn handle_payment(amount: f64) -> Result<Receipt> { charge(amount) }".into());
        vi.build(&[n1]).unwrap();
        vi.save().unwrap();

        // 再次获取：必须看到新索引，而不是旧的空缓存
        let (_, slots2) = get_or_load_index(&root).unwrap();
        assert_eq!(slots2.read().unwrap().len(), 1, "索引重建后缓存必须自动失效重载");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 命中过滤：阈值截断、与已有结果去重、命中内去重、条数上限
    #[test]
    fn test_filter_hits() {
        let raw: Vec<(String, f32)> = vec![
            ("a".into(), 0.60),
            ("b".into(), 0.55),
            ("b".into(), 0.54), // 与 b 重复
            ("c".into(), 0.40),
            ("d".into(), 0.30), // 低于阈值（其后不再扫描）
            ("e".into(), 0.25),
        ];
        let mut existing = std::collections::HashSet::new();
        existing.insert("a");

        let hits = filter_hits(&raw, 0.35, 5, &existing);
        assert_eq!(hits, vec![("b".to_string(), 0.55), ("c".to_string(), 0.40)]);

        // 上限生效（a 不在 existing 时排第一）
        let capped = filter_hits(&raw, 0.35, 1, &std::collections::HashSet::new());
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].0, "a");

        // 全低于阈值 → 空
        assert!(filter_hits(&raw, 0.99, 5, &std::collections::HashSet::new()).is_empty());
    }

    #[test]
    fn test_extract_snippet() {
        let source = "import os\n\ndef hello_world():\n    print('hello')\n    return 42\n";
        let s = extract_snippet(source, "hello_world", &NodeKind::Function).unwrap();
        assert!(s.contains("hello_world"));
    }

    #[test]
    fn test_real_generated_index() {
        // 验证 tauri dev 期间构建的向量索引确实可用
        let path = "D:/HoloGramHG/.hologram/vectors.usearch";
        if !std::path::Path::new(path).exists() {
            eprintln!("跳过: 未找到 {path} —— 请先运行 analyze");
            return;
        }
        let vi = CodeVectorIndex::new(path);
        let n = vi.load().unwrap();
        eprintln!("从 {path} 加载了 {n} 个向量 (backend: {})", crate::vector::backend_id());
        if n == 0 {
            // 索引与当前嵌入后端不匹配（如旧 n-gram 索引）——需要重新分析
            eprintln!("跳过: 索引不可用或与当前嵌入后端不匹配，请重新运行 analyze");
            return;
        }

        // 对真实 HoloGram 代码库进行搜索测试
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
            assert!(!results.is_empty(), "搜索 '{query}' 应返回结果");
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
        // handle_payment 应排在首位
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
