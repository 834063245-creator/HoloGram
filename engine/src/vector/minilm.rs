// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MiniLM 嵌入器 —— sentence-transformers/all-MiniLM-L6-v2（ONNX，384 维）。
// 均值池化 + L2 归一化，与 sentence-transformers 输出对齐。
//
// 运行时使用 ort crate（load-dynamic）加载项目自带的 onnxruntime.dll，
// 不下载任何二进制。模型文件定位：env HOLOGRAM_MINILM_DIR → exe 祖先目录 → cwd。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use ort::session::Session;
use ort::value::Tensor;

use super::wordpiece::WordPieceTokenizer;

pub const MINILM_DIM: usize = 384;
/// 嵌入空间标识 —— 写入 slots.json，防止与 n-gram 索引混用
pub const BACKEND_ID: &str = "minilm-l6-v2";

pub struct MiniLMEmbedder {
    session: Mutex<Session>,
    tokenizer: WordPieceTokenizer,
    /// 模型声明的输入名（按导出变体裁剪投喂列表）
    input_names: Vec<String>,
}

static EMBEDDER: OnceLock<Result<MiniLMEmbedder, String>> = OnceLock::new();
static ORT_INIT: OnceLock<Result<(), String>> = OnceLock::new();

/// 获取全局嵌入器（惰性加载，进程级单例）。
pub fn global() -> Result<&'static MiniLMEmbedder, String> {
    EMBEDDER.get_or_init(MiniLMEmbedder::load).as_ref().map_err(|e| e.clone())
}

/// onnxruntime.dll 搜索候选。
/// 注意：不用裸文件名（Windows 搜索顺序会先命中 System32 里的异种 DLL）。
fn dll_candidates() -> Vec<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("HOLOGRAM_ONNXRUNTIME_DLL") {
        cands.push(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        for anc in exe.ancestors().skip(1) {
            cands.push(anc.join("onnxruntime.dll"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("onnxruntime.dll"));
        cands.push(cwd.join("engine").join("onnxruntime.dll"));
    }
    cands
}

/// 模型目录候选（含 model.onnx + vocab.txt 的目录）。
fn model_dir_candidates() -> Vec<PathBuf> {
    const DIR: &str = "all-MiniLM-L6-v2";
    let mut cands = Vec::new();
    if let Ok(p) = std::env::var("HOLOGRAM_MINILM_DIR") {
        cands.push(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        for anc in exe.ancestors().skip(1) {
            cands.push(anc.join("models").join(DIR));
            cands.push(anc.join("src-tauri").join("models").join(DIR));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("models").join(DIR));
        cands.push(cwd.join("src-tauri").join("models").join(DIR));
        cands.push(cwd.join("..").join("src-tauri").join("models").join(DIR));
    }
    cands
}

impl MiniLMEmbedder {
    fn load() -> Result<Self, String> {
        // 1. 初始化 ONNX Runtime（动态加载 DLL，进程级一次）
        ORT_INIT.get_or_init(|| {
            let mut last_err = String::from("无候选路径");
            for dll in dll_candidates() {
                if !dll.exists() { continue; }
                match ort::init_from(&dll) {
                    Ok(builder) => {
                        if builder.commit() {
                            tracing::info!("[vector] ONNX Runtime 已加载: {}", dll.display());
                            return Ok(());
                        }
                        last_err = format!("{}: commit failed", dll.display());
                    }
                    Err(e) => last_err = format!("{}: {e}", dll.display()),
                }
            }
            Err(format!("onnxruntime.dll 不可用。{last_err}"))
        }).as_ref().map_err(|e| e.clone())?;

        // 2. 定位模型文件
        let mut found = None;
        for dir in model_dir_candidates() {
            let model = dir.join("model.onnx");
            let vocab = dir.join("vocab.txt");
            if model.exists() && vocab.exists() { found = Some((model, vocab)); break; }
        }
        let (model_path, vocab_path) = found.ok_or(
            "MiniLM 模型文件未找到（需要 model.onnx + vocab.txt，可设 HOLOGRAM_MINILM_DIR）"
        )?;

        let tokenizer = WordPieceTokenizer::from_file(&vocab_path)?;
        let session = Session::builder()
            .map_err(|e| format!("session builder: {e}"))?
            .commit_from_file(&model_path)
            .map_err(|e| format!("ONNX 模型加载失败 ({}): {e}", model_path.display()))?;

        let input_names: Vec<String> = session.inputs().iter().map(|o| o.name().to_string()).collect();
        tracing::info!(
            "[vector] MiniLM 已就绪: {} ({} 维, inputs: {})",
            model_path.display(), MINILM_DIM, input_names.join(", ")
        );
        Ok(Self { session: Mutex::new(session), tokenizer, input_names })
    }

    /// 单次 run 的批量大小。CPU 上 batch 32 左右吞吐最优；再大则单次 run
    /// 延迟变长（搜索等单条请求需等当前 batch 让出锁），内存占用也上升。
    const INFER_BATCH: usize = 32;

    /// 嵌入文本 → 384 维单位向量。空文本返回零向量。
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        Ok(self.embed_batch(&[text])?.remove(0))
    }

    /// 批量嵌入 —— 单线程顺序按 batch 投喂 session.run。
    /// 刻意不用 par_iter：session 是 Mutex 保护的单例，多线程只会在锁上串行
    /// （实测并行吞吐反而降至顺序的 0.63x），还会堵满 rayon 全局池饿死
    /// 解析/dataflow 的并行任务。batch 维度由 ONNX 内部向量化，才是真并行。
    /// 空文本返回零向量；返回顺序与输入一致。
    pub fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, String> {
        let mut out: Vec<Vec<f32>> = vec![Vec::new(); texts.len()];
        // 逐条分词（无锁纯计算）；空文本直接给零向量，不进推理
        let mut encoded: Vec<Option<(Vec<i64>, Vec<i64>)>> = Vec::with_capacity(texts.len());
        let mut todo: Vec<usize> = Vec::with_capacity(texts.len());
        for (i, t) in texts.iter().enumerate() {
            if t.trim().is_empty() {
                out[i] = vec![0.0f32; MINILM_DIM];
                encoded.push(None);
            } else {
                let (ids, mask, _types) = self.tokenizer.encode(t);
                encoded.push(Some((ids, mask)));
                todo.push(i);
            }
        }

        for chunk in todo.chunks(Self::INFER_BATCH) {
            let batch = chunk.len();
            let max_len = chunk.iter()
                .map(|&i| encoded[i].as_ref().unwrap().0.len())
                .max().unwrap_or(1);

            // 右侧零填充对齐到 batch 内最大长度（mask 同步填 0，池化时忽略）
            let mut ids = vec![0i64; batch * max_len];
            let mut mask = vec![0i64; batch * max_len];
            for (row, &i) in chunk.iter().enumerate() {
                let (ri, rm) = encoded[i].as_ref().unwrap();
                let n = ri.len();
                ids[row * max_len..row * max_len + n].copy_from_slice(ri);
                mask[row * max_len..row * max_len + n].copy_from_slice(rm);
            }

            let shape = vec![batch as i64, max_len as i64];
            let ids_t = Tensor::from_array((shape.clone(), ids)).map_err(|e| format!("tensor: {e}"))?;
            let mask_t = Tensor::from_array((shape.clone(), mask)).map_err(|e| format!("tensor: {e}"))?;

            // 锁只覆盖单次 run：批量构建期间搜索请求最多等一个 batch 的时长
            let mut session = self.session.lock().map_err(|e| format!("session lock: {e}"))?;
            let outputs = if self.input_names.iter().any(|n| n == "token_type_ids") {
                let types_t = Tensor::from_array((shape, vec![0i64; batch * max_len])).map_err(|e| format!("tensor: {e}"))?;
                session.run(ort::inputs![
                    "input_ids" => ids_t,
                    "attention_mask" => mask_t,
                    "token_type_ids" => types_t,
                ])
            } else {
                session.run(ort::inputs![
                    "input_ids" => ids_t,
                    "attention_mask" => mask_t,
                ])
            }.map_err(|e| format!("ONNX 推理失败: {e}"))?;

            let (_oshape, hidden) = outputs["last_hidden_state"]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("输出提取失败: {e}"))?;

            for (row, &i) in chunk.iter().enumerate() {
                let seq_len = encoded[i].as_ref().unwrap().0.len();
                let item = &hidden[row * max_len * MINILM_DIM..(row + 1) * max_len * MINILM_DIM];
                out[i] = pool_normalize(item, seq_len);
            }
        }
        Ok(out)
    }
}

/// 均值池化 + L2 归一化（sentence-transformers 行为，余弦 = 点积）。
/// hidden 为单条样本的 [seq_len, MINILM_DIM] 切片；真实 token 的 mask 全为 1，
/// 故掩码均值等价于前 seq_len 行的算术平均。
fn pool_normalize(hidden: &[f32], seq_len: usize) -> Vec<f32> {
    let mut pooled = vec![0.0f32; MINILM_DIM];
    if seq_len == 0 { return pooled; }
    let w = 1.0 / seq_len as f32;
    for i in 0..seq_len {
        for d in 0..MINILM_DIM {
            pooled[d] += w * hidden[i * MINILM_DIM + d];
        }
    }
    let norm: f32 = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-8 {
        for v in &mut pooled { *v /= norm; }
    }
    pooled
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
    }

    /// 真实模型端到端：验证语义区分度（需要模型文件存在）
    #[test]
    fn test_minilm_semantic_separation() {
        let emb = match global() {
            Ok(e) => e,
            Err(e) => { eprintln!("跳过: {e}"); return; }
        };
        let payment = emb.embed("fn handle_payment(amount: f64) -> Result<Receipt> { charge(amount) }").unwrap();
        let refund = emb.embed("fn process_refund(order_id: u64) -> Result<Money> { validate(order_id) }").unwrap();
        let ui = emb.embed("fn render_window() { draw_button(); minimize(); }").unwrap();

        let s_rel = cosine(&payment, &refund);
        let s_unrel = cosine(&payment, &ui);
        eprintln!("sim(payment, refund) = {s_rel:.3}");
        eprintln!("sim(payment, ui)     = {s_unrel:.3}");
        // MiniLM 应给出明显区分：金融语义相近 > 无关 UI 代码
        assert!(s_rel > 0.5, "相关对相似度过低: {s_rel:.3}");
        assert!(s_rel > s_unrel + 0.15, "区分度不足: rel={s_rel:.3} unrel={s_unrel:.3}");
    }

    /// batch 推理结果必须与单条一致（padding 不得影响均值池化），空文本 → 零向量
    #[test]
    fn test_batch_matches_single() {
        let emb = match global() {
            Ok(e) => e,
            Err(e) => { eprintln!("跳过: {e}"); return; }
        };
        // 长度差异大 + 中文 + 空文本，充分触发 padding 路径
        let texts = [
            "fn handle_payment(amount: f64) -> Result<Receipt> { charge(amount) }",
            "x",
            "// 支付重试逻辑：指数退避\nasync fn retry_payment(order: &Order) -> Result<()> {\n    for attempt in 0..3 {\n        if charge(order).await.is_ok() { return Ok(()); }\n        sleep(backoff(attempt)).await;\n    }\n    Err(Error::PaymentFailed)\n}",
            "",
            "fn render_window() { draw_button(); minimize(); }",
        ];
        let batch = emb.embed_batch(&texts).unwrap();
        assert_eq!(batch.len(), texts.len());
        for (i, t) in texts.iter().enumerate() {
            let single = emb.embed(t).unwrap();
            if t.trim().is_empty() {
                assert!(batch[i].iter().all(|&x| x == 0.0), "空文本应为零向量");
                continue;
            }
            let cos = cosine(&single, &batch[i]);
            assert!(cos > 0.999, "batch 与单条结果不一致 (text {i}): cos={cos:.6}");
        }
    }

    /// 性能基准：单条延迟 / 顺序单条吞吐 / batch 推理吞吐（build() 的生产路径）
    #[test]
    #[ignore = "手动基准：cargo test bench_minilm -- --ignored --nocapture"]
    fn bench_minilm_throughput() {
        let emb = match global() {
            Ok(e) => e,
            Err(e) => { eprintln!("跳过: {e}"); return; }
        };
        let snippet = "// 支付重试逻辑：指数退避\nasync fn retry_payment(order: &Order) -> Result<()> {\n    for attempt in 0..3 {\n        if charge(order).await.is_ok() { return Ok(()); }\n        sleep(backoff(attempt)).await;\n    }\n    Err(Error::PaymentFailed)\n}";

        // 预热
        for _ in 0..3 { emb.embed(snippet).unwrap(); }

        // 单条延迟
        let t = std::time::Instant::now();
        emb.embed(snippet).unwrap();
        eprintln!("单条延迟: {:.1}ms", t.elapsed().as_secs_f64() * 1000.0);

        // 顺序单条 100 次（旧 embed() 逐条路径的下界）
        let n = 128;
        let t = std::time::Instant::now();
        for _ in 0..n { emb.embed(snippet).unwrap(); }
        let seq_ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!("顺序单条 {n} 次: {seq_ms:.0}ms ({:.1}ms/条, {:.0} 条/s)", seq_ms / n as f64, n as f64 / seq_ms * 1000.0);

        // batch 推理（build() 的生产路径）
        let texts: Vec<&str> = (0..n).map(|_| snippet).collect();
        let t = std::time::Instant::now();
        let _ = emb.embed_batch(&texts).unwrap();
        let batch_ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!("batch {n} 条: {batch_ms:.0}ms ({:.2}ms/条, {:.0} 条/s)", batch_ms / n as f64, n as f64 / batch_ms * 1000.0);
        eprintln!("batch 相对顺序单条加速: {:.2}x", seq_ms / batch_ms);

        // 外推全量索引构建耗时
        let nodes = 5258usize;
        eprintln!("外推 {nodes} 节点全量构建: 顺序单条 {:.0}s / batch {:.1}s",
            nodes as f64 * seq_ms / n as f64 / 1000.0,
            nodes as f64 * batch_ms / n as f64 / 1000.0);
    }

    /// 长代码片段 + 中文注释的实际路径
    #[test]
    fn test_minilm_realistic_snippet() {
        let emb = match global() {
            Ok(e) => e,
            Err(e) => { eprintln!("跳过: {e}"); return; }
        };
        let snippet = "// 支付重试逻辑：指数退避\nasync fn retry_payment(order: &Order) -> Result<()> {\n    for attempt in 0..3 {\n        if charge(order).await.is_ok() { return Ok(()); }\n        sleep(backoff(attempt)).await;\n    }\n    Err(Error::PaymentFailed)\n}";
        let v = emb.embed(snippet).unwrap();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "应为单位向量: {norm}");
    }
}
