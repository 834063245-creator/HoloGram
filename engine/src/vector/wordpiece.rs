// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WordPiece 分词器 —— all-MiniLM-L6-v2（BERT-base-uncased 词表，30522 词）。
// 贪心最长匹配，与 HuggingFace BertTokenizer 行为对齐：
//   1. BasicTokenizer：小写化、空白/标点切分、CJK 单字成词
//   2. WordpieceTokenizer：词首最长匹配，续词加 "##" 前缀，整词失败 → [UNK]

use std::collections::HashMap;
use std::path::Path;

/// 最大序列长度（含 [CLS]/[SEP]）。MiniLM 上限 512；
/// 代码片段取 256 兼顾覆盖率与 CPU 推理速度。
pub const MAX_SEQ_LEN: usize = 256;

pub struct WordPieceTokenizer {
    vocab: HashMap<String, i64>,
    pub cls_id: i64,
    pub sep_id: i64,
    pub unk_id: i64,
}

impl WordPieceTokenizer {
    /// 从 vocab.txt 加载（每行一个 token，行号即 id）。
    pub fn from_file(path: &Path) -> Result<Self, String> {
        let data = std::fs::read_to_string(path)
            .map_err(|e| format!("vocab.txt read failed ({}): {e}", path.display()))?;
        let mut vocab = HashMap::with_capacity(30522);
        for (i, line) in data.lines().enumerate() {
            let tok = line.trim_end_matches('\r');
            if !tok.is_empty() {
                vocab.insert(tok.to_string(), i as i64);
            }
        }
        if vocab.len() < 30000 {
            return Err(format!("vocab.txt 词条数异常: {} ({} )", vocab.len(), path.display()));
        }
        let cls_id = *vocab.get("[CLS]").unwrap_or(&101);
        let sep_id = *vocab.get("[SEP]").unwrap_or(&102);
        let unk_id = *vocab.get("[UNK]").unwrap_or(&100);
        tracing::info!("[vector] WordPiece 词表已加载: {} 词", vocab.len());
        Ok(Self { vocab, cls_id, sep_id, unk_id })
    }

    /// 编码为 (input_ids, attention_mask, token_type_ids)，含 [CLS]/[SEP]，
    /// 截断到 MAX_SEQ_LEN。
    pub fn encode(&self, text: &str) -> (Vec<i64>, Vec<i64>, Vec<i64>) {
        let mut ids = Vec::with_capacity(64);
        ids.push(self.cls_id);
        for word in basic_tokenize(text) {
            if ids.len() >= MAX_SEQ_LEN - 1 { break; }
            self.wordpiece(&word, &mut ids);
        }
        ids.push(self.sep_id);
        let mask = vec![1i64; ids.len()];
        let types = vec![0i64; ids.len()];
        (ids, mask, types)
    }

    /// 单词 → WordPiece 子词序列（贪心最长匹配）。失败整词 → [UNK]。
    fn wordpiece(&self, word: &str, out: &mut Vec<i64>) {
        let chars: Vec<char> = word.chars().collect();
        if chars.len() > 100 { out.push(self.unk_id); return; }
        let mut start = 0usize;
        while start < chars.len() {
            let mut end = chars.len();
            let mut matched: Option<i64> = None;
            while start < end {
                let piece: String = if start == 0 {
                    chars[start..end].iter().collect()
                } else {
                    let mut p = String::from("##");
                    p.extend(chars[start..end].iter());
                    p
                };
                if let Some(&id) = self.vocab.get(&piece) {
                    matched = Some(id);
                    break;
                }
                end -= 1;
            }
            match matched {
                Some(id) => {
                    if out.len() >= MAX_SEQ_LEN - 1 { return; }
                    out.push(id);
                    start = end;
                }
                None => {
                    // 整词无法切分 → 单个 [UNK]，终止该词
                    if out.len() < MAX_SEQ_LEN - 1 { out.push(self.unk_id); }
                    return;
                }
            }
        }
    }
}

/// BasicTokenizer（BERT uncased）：小写 + 标点/CJK 切分。
fn basic_tokenize(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for ch in text.to_lowercase().chars() {
        let code = ch as u32;
        let is_cjk = (0x4E00..=0x9FFF).contains(&code)
            || (0x3400..=0x4DBF).contains(&code)
            || (0x3040..=0x30FF).contains(&code)
            || (0xF900..=0xFAFF).contains(&code);
        if is_cjk {
            if !current.is_empty() { words.push(std::mem::take(&mut current)); }
            words.push(ch.to_string());
        } else if ch.is_whitespace() || is_punctuation(code) {
            if !current.is_empty() { words.push(std::mem::take(&mut current)); }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() { words.push(current); }
    words
}

fn is_punctuation(code: u32) -> bool {
    (33..=47).contains(&code)
        || (58..=64).contains(&code)
        || (91..=96).contains(&code)
        || (123..=126).contains(&code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_tokenizer() -> WordPieceTokenizer {
        // 真实词表（30522 词）
        let path = Path::new("../src-tauri/models/all-MiniLM-L6-v2/vocab.txt");
        if !path.exists() { panic!("vocab.txt 缺失: {}", path.display()); }
        WordPieceTokenizer::from_file(path).unwrap()
    }

    #[test]
    fn test_encode_basic() {
        let tk = test_tokenizer();
        let (ids, mask, types) = tk.encode("fn handle_payment(amount: f64)");
        assert_eq!(ids[0], tk.cls_id);
        assert_eq!(*ids.last().unwrap(), tk.sep_id);
        assert_eq!(ids.len(), mask.len());
        assert_eq!(ids.len(), types.len());
        assert!(ids.len() > 4, "应切出多个子词: {:?}", ids);
    }

    #[test]
    fn test_truncation() {
        let tk = test_tokenizer();
        let long = "word ".repeat(1000);
        let (ids, _, _) = tk.encode(&long);
        assert!(ids.len() <= MAX_SEQ_LEN);
        assert_eq!(*ids.last().unwrap(), tk.sep_id);
    }

    #[test]
    fn test_chinese_and_code() {
        let tk = test_tokenizer();
        let (ids, _, _) = tk.encode("// 支付重试逻辑\nfn retry_payment()");
        assert!(ids.len() > 5);
    }
}
