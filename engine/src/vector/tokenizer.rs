// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WordPiece tokenizer for BERT-family models (all-MiniLM-L6-v2).
// ponytail: much simpler than BPE — greedy longest-match against vocab.
// Loads HuggingFace vocab.txt (one token per line, index = line number).

use anyhow::{anyhow, Result};
use std::collections::HashMap;

pub struct WordPieceTokenizer {
    vocab: HashMap<String, i64>,
    unk_id: i64,
    cls_id: i64,
    sep_id: i64,
    pad_id: i64,
    max_len: usize,
}

impl WordPieceTokenizer {
    /// Load from HuggingFace vocab.txt file.
    pub fn from_file(path: &str) -> Result<Self> {
        let data = std::fs::read_to_string(path)?;
        let mut vocab = HashMap::new();
        for (i, line) in data.lines().enumerate() {
            let token = line.trim();
            if !token.is_empty() {
                vocab.insert(token.to_string(), i as i64);
            }
        }
        let unk_id = *vocab.get("[UNK]").unwrap_or(&100);
        let cls_id = *vocab.get("[CLS]").unwrap_or(&101);
        let sep_id = *vocab.get("[SEP]").unwrap_or(&102);
        let pad_id = *vocab.get("[PAD]").unwrap_or(&0);
        tracing::info!("[vector] WordPiece tokenizer: {} vocab entries", vocab.len());
        Ok(Self { vocab, unk_id, cls_id, sep_id, pad_id, max_len: 512 })
    }

    /// Encode text into token IDs and attention mask.
    pub fn encode(&self, text: &str) -> Result<(Vec<i64>, Vec<i64>)> {
        let mut ids = vec![self.cls_id];
        for word in self.basic_tokenize(text) {
            self.tokenize_word(&word, &mut ids);
            if ids.len() >= self.max_len - 1 { break; }
        }
        if ids.len() > self.max_len { ids.truncate(self.max_len); }
        ids.push(self.sep_id);
        let mask = vec![1i64; ids.len()];
        Ok((ids, mask))
    }

    /// Split text into words (whitespace + punctuation boundaries).
    fn basic_tokenize(&self, text: &str) -> Vec<String> {
        let mut words = Vec::new();
        let mut current = String::new();
        for ch in text.chars() {
            if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' {
                if !current.is_empty() { words.push(std::mem::take(&mut current)); }
            } else if ch.is_ascii_punctuation() || ch == '，' || ch == '。' {
                if !current.is_empty() { words.push(std::mem::take(&mut current)); }
                words.push(ch.to_string());
            } else {
                current.push(ch);
            }
        }
        if !current.is_empty() { words.push(current); }
        words
    }

    /// Tokenize a single word into subword tokens using WordPiece greedy algorithm.
    fn tokenize_word(&self, word: &str, ids: &mut Vec<i64>) {
        if word.is_empty() { return; }

        // ponytail: WordPiece algorithm — find longest matching prefix from vocab,
        // continue with ## prefix for subsequent subwords.
        let chars: Vec<char> = word.chars().collect();
        let mut start = 0;
        let mut is_first = true;

        while start < chars.len() {
            let mut end = chars.len();
            let mut found = false;

            while end > start {
                let sub: String = if is_first {
                    chars[start..end].iter().collect()
                } else {
                    let inner: String = chars[start..end].iter().collect();
                    format!("##{inner}")
                };

                if let Some(&id) = self.vocab.get(&sub) {
                    ids.push(id);
                    found = true;
                    break;
                }
                end -= 1;
            }

            if !found {
                ids.push(self.unk_id);
                break;
            }

            start = end;
            is_first = false;
        }
    }
}
