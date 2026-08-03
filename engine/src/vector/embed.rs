// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 嵌入调度 + n-gram 哈希兜底嵌入器。
// embed() 优先走 MiniLM（minilm.rs，语义嵌入）；模型/DLL 不可用时
// 回退字符 3-gram 哈希（ngram_embed，零依赖、即时）。
// n-gram 捕获词法相似性："handlePayment" ≈ "process_payment"。
// 当前激活后端见 backend_id()；vector_hits 过滤阈值见 score_threshold()。

/// 固定嵌入维度。
pub const EMBED_DIM: usize = 384;

/// 嵌入文本 → DIM 维向量。
/// 优先 MiniLM（语义嵌入）；模型/DLL 不可用时回退 n-gram 哈希。
pub fn embed(text: &str) -> Vec<f32> {
    match super::minilm::global() {
        Ok(m) => match m.embed(text) {
            Ok(v) => {
                set_backend(BACKEND_MINILM);
                return v;
            }
            Err(e) => {
                tracing::warn!("[vector] MiniLM 推理失败，回退 n-gram: {e}");
            }
        },
        Err(e) => {
            log_fallback_once(&e);
        }
    }
    set_backend(BACKEND_NGRAM);
    ngram_embed(text)
}

fn log_fallback_once(reason: &str) {
    static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        tracing::warn!("[vector] MiniLM 不可用，使用 n-gram 哈希嵌入: {reason}");
    }
}

const BACKEND_UNKNOWN: u8 = 0;
const BACKEND_MINILM: u8 = 1;
const BACKEND_NGRAM: u8 = 2;
static BACKEND: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(BACKEND_UNKNOWN);

fn set_backend(b: u8) { BACKEND.store(b, std::sync::atomic::Ordering::Relaxed); }

/// 惰性确定后端（首次调用时探测 MiniLM 可用性）。
fn resolve_backend() -> u8 {
    let b = BACKEND.load(std::sync::atomic::Ordering::Relaxed);
    if b != BACKEND_UNKNOWN { return b; }
    let resolved = if super::minilm::global().is_ok() { BACKEND_MINILM } else { BACKEND_NGRAM };
    set_backend(resolved);
    resolved
}

/// 当前激活的嵌入后端标识（写入 slots.json，用于索引兼容性校验）。
pub fn backend_id() -> &'static str {
    match resolve_backend() {
        BACKEND_MINILM => super::minilm::BACKEND_ID,
        _ => "ngram-hash",
    }
}

/// vector_hits 的最低相似度阈值（按后端区分）。
/// 实测（HoloGram 真实索引）：MiniLM 相关命中 0.36–0.57，无关 <0.34 → 0.35 分界清晰；
/// n-gram 分数压缩在 0.3–0.49 窄带，放宽但意义有限。
pub fn score_threshold() -> f32 {
    match resolve_backend() {
        BACKEND_MINILM => 0.35,
        _ => 0.45,
    }
}

/// 通过 3-gram 哈希将文本嵌入为 DIM 维稠密向量。
/// 每个 3-gram 哈希到一个维度；向量经过归一化。
/// ponytail：MiniLM 不可用时的兜底方案。
pub fn ngram_embed(text: &str) -> Vec<f32> {
    let mut vec = vec![0.0f32; EMBED_DIM];
    let text = text.to_lowercase();
    let chars: Vec<char> = text.chars().collect();

    if chars.len() < 3 {
        // 短文本：使用 bigram 或 unigram
        for i in 0..chars.len() {
            let h = hash_char(chars[i]) % EMBED_DIM;
            vec[h] += 1.0;
        }
        for w in 2..=chars.len() {
            for i in 0..=chars.len() - w {
                let gram: String = chars[i..i + w].iter().copied().collect();
                let h = hash_str(&gram) % EMBED_DIM;
                vec[h] += 1.0;
            }
        }
    } else {
        for i in 0..=chars.len() - 3 {
            let gram: String = chars[i..i + 3].iter().copied().collect();
            let h = hash_str(&gram) % EMBED_DIM;
            vec[h] += 1.0;
        }
        // 同时添加词边界 bigram 以提升单词匹配效果
        let mut word_start = 0usize;
        for (i, &ch) in chars.iter().enumerate() {
            if ch == '_' || ch == '.' || ch == ' ' || ch == '(' || ch == ')' || ch == '{' || ch == '}' {
                if i > word_start + 2 {
                    // 词首 2-gram：如 "hello" → "#he"
                    let sow: String = std::iter::once('#').chain(chars[word_start..word_start + 2].iter().copied()).collect();
                    let h = hash_str(&sow) % EMBED_DIM;
                    vec[h] += 2.0; // 词首标记的加权
                }
                word_start = i + 1;
            }
        }
        // 最后一个词
        if chars.len() > word_start + 2 {
            let sow: String = std::iter::once('#').chain(chars[word_start..word_start + 2].iter().copied()).collect();
            let h = hash_str(&sow) % EMBED_DIM;
            vec[h] += 2.0;
        }
    }

    // 归一化为单位长度
    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-8 {
        for v in &mut vec { *v /= norm; }
    }

    vec
}

fn hash_str(s: &str) -> usize {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h as usize
}

fn hash_char(c: char) -> usize {
    c as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embed_dim() {
        let v = embed("hello world");
        assert_eq!(v.len(), EMBED_DIM);
    }

    #[test]
    fn test_similar_texts() {
        let v1 = embed("fn process_payment(amount: f64) -> Result<(), Error>");
        let v2 = embed("fn handle_transaction(money: f64) -> Result<(), Error>");
        let v3 = embed("fn render_ui(ctx: &mut UIContext) { draw_button(); }");

        let sim12 = cosine(&v1, &v2);
        let sim13 = cosine(&v1, &v3);
        eprintln!("sim(payment, transaction) = {:.3}", sim12);
        eprintln!("sim(payment, ui) = {:.3}", sim13);
        // 相似代码模式（Result<(), Error>、f64 类型）应更接近
        assert!(sim12 > sim13 * 0.8, "payment 应至少与 transaction 有一定接近度");
    }

    #[test]
    fn test_word_similarity() {
        let v1 = embed("handle_payment");
        let v2 = embed("process_payment");
        let v3 = embed("draw_button");
        let sim12 = cosine(&v1, &v2);
        let sim13 = cosine(&v1, &v3);
        eprintln!("sim(handle_payment, process_payment) = {:.3}", sim12);
        eprintln!("sim(handle_payment, draw_button) = {:.3}", sim13);
        assert!(sim12 > sim13, "相似名称应更接近");
    }

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let na = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let nb = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if na < 1e-8 || nb < 1e-8 { return 0.0; }
        (dot / (na * nb)).clamp(-1.0, 1.0)
    }
}
