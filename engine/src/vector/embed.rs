// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// N-gram hashing embedder — pure Rust, zero deps, zero models, zero downloads.
// Converts text to fixed-dim vectors using character 3-gram hashing.
// Captures lexical similarity: "handlePayment" ≈ "process_payment" → both contain "pay", "men", "ent".
// ponytail: not as good as neural embeddings, but instant and maintenance-free.

/// Fixed embedding dimension.
pub const EMBED_DIM: usize = 384;

/// Embed text into a DIM-dimensional dense vector using 3-gram hashing.
/// Each 3-gram is hashed to a dimension; the vector is normalized.
pub fn embed(text: &str) -> Vec<f32> {
    let mut vec = vec![0.0f32; EMBED_DIM];
    let text = text.to_lowercase();
    let chars: Vec<char> = text.chars().collect();

    if chars.len() < 3 {
        // Short text: use bigrams or unigrams
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
        // Also add word-boundary bigrams for better word matching
        let mut word_start = 0usize;
        for (i, &ch) in chars.iter().enumerate() {
            if ch == '_' || ch == '.' || ch == ' ' || ch == '(' || ch == ')' || ch == '{' || ch == '}' {
                if i > word_start + 2 {
                    // Start-of-word 2-gram: "#he" for "hello"
                    let sow: String = std::iter::once('#').chain(chars[word_start..word_start + 2].iter().copied()).collect();
                    let h = hash_str(&sow) % EMBED_DIM;
                    vec[h] += 2.0; // bonus weight for word-start markers
                }
                word_start = i + 1;
            }
        }
        // Last word
        if chars.len() > word_start + 2 {
            let sow: String = std::iter::once('#').chain(chars[word_start..word_start + 2].iter().copied()).collect();
            let h = hash_str(&sow) % EMBED_DIM;
            vec[h] += 2.0;
        }
    }

    // Normalize to unit length
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
        // Similar code patterns (Result<(), Error>, f64 type) should be closer
        assert!(sim12 > sim13 * 0.8, "payment should be at least somewhat close to transaction");
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
        assert!(sim12 > sim13, "similar names should be closer");
    }

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let na = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let nb = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if na < 1e-8 || nb < 1e-8 { return 0.0; }
        (dot / (na * nb)).clamp(-1.0, 1.0)
    }
}
