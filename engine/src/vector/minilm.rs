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

    /// 嵌入文本 → 384 维单位向量。空文本返回零向量。
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        if text.trim().is_empty() { return Ok(vec![0.0f32; MINILM_DIM]); }

        let (ids, mask, types) = self.tokenizer.encode(text);
        let seq_len = ids.len();
        let shape = vec![1i64, seq_len as i64];

        let ids_t = Tensor::from_array((shape.clone(), ids)).map_err(|e| format!("tensor: {e}"))?;
        let mask_t = Tensor::from_array((shape.clone(), mask.clone())).map_err(|e| format!("tensor: {e}"))?;

        let mut session = self.session.lock().map_err(|e| format!("session lock: {e}"))?;
        let outputs = if self.input_names.iter().any(|n| n == "token_type_ids") {
            let types_t = Tensor::from_array((shape, types)).map_err(|e| format!("tensor: {e}"))?;
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

        // 掩码均值池化
        let mut pooled = vec![0.0f32; MINILM_DIM];
        let mask_sum: f32 = mask.iter().map(|&m| m as f32).sum();
        if mask_sum < 1e-8 { return Ok(pooled); }
        for i in 0..seq_len {
            let w = mask[i] as f32 / mask_sum;
            for d in 0..MINILM_DIM {
                pooled[d] += w * hidden[i * MINILM_DIM + d];
            }
        }

        // L2 归一化（sentence-transformers 行为，余弦 = 点积）
        let norm: f32 = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 1e-8 {
            for v in &mut pooled { *v /= norm; }
        }
        Ok(pooled)
    }
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
