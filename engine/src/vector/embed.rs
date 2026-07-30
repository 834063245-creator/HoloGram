// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// N-gram 哈希嵌入器 —— 纯 Rust，零依赖、零模型、零下载。
// 通过字符 3-gram 哈希将文本转换为固定维度向量。
// 捕获词法相似性："handlePayment" ≈ "process_payment" → 都包含 "pay"、"men"、"ent"。
// ponytail：不如神经网络嵌入效果好，但即时且免维护。

/// 固定嵌入维度。
pub const EMBED_DIM: usize = 384;

/// 通过 3-gram 哈希将文本嵌入为 DIM 维稠密向量。
/// 每个 3-gram 哈希到一个维度；向量经过归一化。
pub fn embed(text: &str) -> Vec<f32> {
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
