// Minimal BPE tokenizer — parses HuggingFace tokenizer.json, pure Rust.
// ponytail: just enough for multilingual-e5-large mean pooling inference.

use anyhow::{anyhow, Result};
use std::collections::HashMap;

pub struct BpeTokenizer {
    vocab: HashMap<String, i64>,
    merges: Vec<(String, String)>,
    special_tokens: HashMap<String, i64>,
    unk_token_id: i64,
    pad_token_id: i64,
}

impl BpeTokenizer {
    pub fn from_file(path: &str) -> Result<Self> {
        let data = std::fs::read_to_string(path)?;
        let json: serde_json::Value = serde_json::from_str(&data)?;

        let model = &json["model"];
        let vocab_json = model["vocab"].as_object()
            .ok_or_else(|| anyhow!("tokenizer.json: missing model.vocab"))?;

        let mut vocab = HashMap::new();
        for (k, v) in vocab_json {
            if let Some(id) = v.as_i64() { vocab.insert(k.clone(), id); }
        }

        let mut merges = Vec::new();
        if let Some(arr) = model["merges"].as_array() {
            for m in arr {
                if let Some(s) = m.as_str() {
                    let parts: Vec<&str> = s.splitn(2, ' ').collect();
                    if parts.len() == 2 { merges.push((parts[0].to_string(), parts[1].to_string())); }
                }
            }
        }

        let mut special_tokens = HashMap::new();
        let mut unk_token_id = 0i64;
        if let Some(arr) = json["added_tokens"].as_array() {
            for tok in arr {
                if let (Some(id), Some(content)) = (tok["id"].as_i64(), tok["content"].as_str()) {
                    special_tokens.insert(content.to_string(), id);
                    if content == "[UNK]" { unk_token_id = id; }
                }
            }
        }

        tracing::info!("BPE tokenizer loaded: vocab={} merges={}", vocab.len(), merges.len());
        Ok(Self { vocab, merges, special_tokens, unk_token_id, pad_token_id: 0 })
    }

    /// Encode text into token IDs and attention mask using BPE.
    pub fn encode(&self, text: &str) -> Result<(Vec<i64>, Vec<i64>)> {
        if text.trim().is_empty() {
            return Ok((vec![0], vec![0])); // [CLS] only
        }

        // Pre-tokenize: split on whitespace + punctuation
        let words: Vec<String> = self.pre_tokenize(text);

        // BPE encode each word
        let mut ids = vec![0i64]; // [CLS]
        for word in &words {
            let mut tokens = word.chars().map(|c| c.to_string()).collect::<Vec<_>>();
            // Apply BPE merge rules
            for (a, b) in &self.merges {
                let mut i = 0;
                while i + 1 < tokens.len() {
                    if tokens[i] == *a && tokens[i + 1] == *b {
                        let merged = format!("{a}{b}");
                        tokens[i] = merged;
                        tokens.remove(i + 1);
                        // Re-check from current position
                    } else {
                        i += 1;
                    }
                }
                if tokens.len() <= 1 { break; }
            }
            for t in &tokens {
                ids.push(*self.vocab.get(t).unwrap_or(&self.unk_token_id));
            }
        }

        let mask = vec![1i64; ids.len()];
        Ok((ids, mask))
    }

    /// Pre-tokenizer: split on Chinese/English boundaries, whitespace, punctuation.
    /// ponytail: simplified for multilingual-e5-large (SentencePiece-based, but we use tokenizer.json BPE).
    fn pre_tokenize(&self, text: &str) -> Vec<String> {
        let mut words = Vec::new();
        let mut current = String::new();
        let mut is_cjk: Option<bool> = None;

        for ch in text.chars() {
            let code = ch as u32;
            let cjk_range1 = code > 0x2000 && code < 0x9FFF;
            let cjk_range2 = code >= 0x4E00 && code <= 0x9FFF;
            let cjk_range3 = code >= 0x3040 && code <= 0x30FF;
            let ch_is_cjk = cjk_range1 || cjk_range2 || cjk_range3;

            let is_punct = ",.!?;:()[]{}".contains(ch)
                || "\u{FF0C}\u{3002}\u{FF01}\u{FF1F}\u{FF1B}\u{FF1A}\u{3001}".contains(ch);

            if ch.is_whitespace() || is_punct {
                if !current.is_empty() { words.push(std::mem::take(&mut current)); is_cjk = None; }
                continue;
            }

            if let Some(prev_cjk) = is_cjk {
                if ch_is_cjk != prev_cjk && !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            is_cjk = Some(ch_is_cjk);
            current.push(ch);
        }
        if !current.is_empty() { words.push(current); }
        words
    }

    pub fn vocab_size(&self) -> usize { self.vocab.len() }
}
