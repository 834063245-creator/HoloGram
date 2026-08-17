// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Shell 输出编码 — 2026-08-17 修复"agent shell 调用字符问题"。
//
// 问题 1（块边界丢字）：流式路径每 4KB 块用 String::from_utf8_lossy 独立解码，
// 多字节 UTF-8 序列（中文 3 字节）跨块边界时被替换成 U+FFFD —— cargo/npm/git
// 输出里的中文几乎必然踩到（9.9KB 输出实测 5 个乱码）。StreamDecoder 用 carry
// 缓冲 + valid_up_to/error_len 增量解码，跨块不丢字。
//
// 问题 2（GBK 乱码）：Windows 原生子进程（bash 内嵌 powershell.exe / cmd /
// 中文工具）在管道重定向下按 ANSI 代码页（中文系统 = GBK/936）输出，UTF-8
// 解码全变乱码（会话 223 [162] 实证：PowerShell 中文报错乱码）。策略：
// 完整缓冲区优先 UTF-8，无效则整体 GBK 转码（decode_shell_bytes）；流式路径
// 检测到首个确定无效字节后切换 GBK 增量续流（对齐到坏字节起点）。

use encoding_rs::GBK;

/// 完整 shell 输出缓冲区解码：有效 UTF-8 原样返回；无效时按 GBK 转码
/// （Windows 中文代码页），尽可能恢复 PowerShell/cmd/中文工具的输出。
pub(crate) fn decode_shell_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => GBK.decode(bytes).0.into_owned(),
    }
}

/// 流式 shell 输出解码器：增量 UTF-8（跨块边界不丢字），
/// 检测到确定无效字节后切换到 GBK 增量续流。
pub(crate) struct StreamDecoder {
    carry: Vec<u8>,
    gbk: Option<encoding_rs::Decoder>,
}

impl StreamDecoder {
    pub(crate) fn new() -> Self {
        Self { carry: Vec::new(), gbk: None }
    }

    /// 喂入一块原始字节，返回可安全发出的文本（可能为空字符串）。
    pub(crate) fn push(&mut self, data: &[u8]) -> String {
        // 已切换 GBK：用 decode_to_utf8 增量解码（显式输出缓冲，正确跨块状态；
        // decode_to_string 在本版本对 GBK 恒返回 OutputFull 且不产出，弃用）。
        if let Some(gbk) = &mut self.gbk {
            let mut out = String::new();
            let mut remaining = data;
            loop {
                let cap = remaining.len() * 6 + 32; // GBK→UTF-8 最大扩张安全裕度
                let mut dst: Vec<u8> = vec![0u8; cap.max(16)];
                let (res, read, written, _he) = gbk.decode_to_utf8(remaining, &mut dst, false);
                out.push_str(std::str::from_utf8(&dst[..written]).unwrap_or(""));
                if res == encoding_rs::CoderResult::InputEmpty || read == 0 || remaining.len() <= read {
                    break;
                }
                remaining = &remaining[read..];
            }
            return out;
        }
        self.carry.extend_from_slice(data);
        match std::str::from_utf8(&self.carry) {
            Ok(s) => {
                let out = s.to_string();
                self.carry.clear();
                out
            }
            Err(e) => {
                let valid = e.valid_up_to();
                match e.error_len() {
                    // 确定无效字节（非 UTF-8 输出，如 GBK）— 已解码部分照常发出，
                    // 从坏字节起点切换 GBK 增量解码，后续块继续喂 GBK。
                    Some(_) => {
                        let mut out = String::from_utf8_lossy(&self.carry[..valid]).into_owned();
                        let mut gbk = GBK.new_decoder();
                        let tail = &self.carry[valid..];
                        let cap = tail.len() * 6 + 32;
                        let mut dst: Vec<u8> = vec![0u8; cap.max(16)];
                        let (_res, _read, written, _he) = gbk.decode_to_utf8(tail, &mut dst, false);
                        out.push_str(std::str::from_utf8(&dst[..written]).unwrap_or(""));
                        self.carry.clear();
                        self.gbk = Some(gbk);
                        out
                    }
                    // 尾部是不完整序列（跨块）— 保留到下一块
                    None => {
                        if valid > 0 {
                            let out = String::from_utf8_lossy(&self.carry[..valid]).into_owned();
                            self.carry.drain(..valid);
                            out
                        } else {
                            String::new()
                        }
                    }
                }
            }
        }
    }

    /// EOF：清空残余（不完整 UTF-8 序列按 lossy，GBK 尾按 GBK 收尾）。
    pub(crate) fn finish(mut self) -> String {
        if let Some(gbk) = &mut self.gbk {
            // 冲刷解码器内部残留（不完整 GBK 尾）
            let mut out = String::new();
            let mut dst: Vec<u8> = vec![0u8; 64];
            let (_res, _read, written, _he) = gbk.decode_to_utf8(&[], &mut dst, true);
            out.push_str(std::str::from_utf8(&dst[..written]).unwrap_or(""));
            // GBK 模式下 carry 恒空（解码器持有跨块状态）
            out
        } else {
            String::from_utf8_lossy(&self.carry).into_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_boundary_no_replacement() {
        // 中文 3 字节字符 + 长行，强制跨 4096 块边界
        let line = "中文测试".repeat(10) + &"-".repeat(20);
        let mut full = String::new();
        for _ in 0..300 {
            full.push_str(&line);
            full.push('\n');
        }
        let bytes = full.as_bytes();
        let mut dec = StreamDecoder::new();
        let mut out = String::new();
        let mut pos = 0;
        while pos < bytes.len() {
            let end = (pos + 4096).min(bytes.len());
            out.push_str(&dec.push(&bytes[pos..end]));
            pos = end;
        }
        out.push_str(&dec.finish());
        assert!(!out.contains('�'), "块边界解码出现替换符: {out}");
        assert!(out.contains("中文测试"), "中文内容丢失");
        assert_eq!(out, full);
    }

    #[test]
    fn gbk_output_transcoded() {
        // "无法将x86识别为cmdlet" 的 GBK 编码（会话 223 [162] 同款场景）
        let text = "无法将x86识别为cmdlet，请检查命令拼写";
        let (gbk_bytes, _, _) = GBK.encode(text);
        // 拆块喂入 — 跨块也要正确
        let mut dec = StreamDecoder::new();
        let mut out = String::new();
        let mut pos = 0;
        let bytes = &gbk_bytes[..];
        while pos < bytes.len() {
            let end = (pos + 5).min(bytes.len()); // 故意用小块（GBK 双字节跨块）
            out.push_str(&dec.push(&bytes[pos..end]));
            pos = end;
        }
        out.push_str(&dec.finish());
        assert!(out.contains("cmdlet"), "GBK 转码失败: {out}");
        // 中文按 GBK 解码后应可恢复（U+FFFD 只应出现在极少数无法映射的字节上）
        let replacements = out.chars().filter(|c| *c == '�').count();
        assert!(replacements <= 1, "GBK 转码出现过多替换符: {out}");
    }

    #[test]
    fn full_buffer_gbk_fallback() {
        let text = "命令执行成功";
        let (gbk_bytes, _, _) = GBK.encode(text);
        let s = decode_shell_bytes(&gbk_bytes[..]);
        assert!(s.contains("命令执行成功"), "GBK 完整缓冲转码失败: {s}");
        // UTF-8 输入原样
        assert_eq!(decode_shell_bytes("hello 中文".as_bytes()), "hello 中文");
    }

    #[test]
    fn mixed_utf8_then_gbk_switches_at_bad_byte() {
        let prefix = "utf8部分正常\n";
        let gbk_text = "中文报错信息";
        let (gbk_bytes, _, _) = GBK.encode(gbk_text);
        let mut combined = prefix.as_bytes().to_vec();
        combined.extend_from_slice(&gbk_bytes[..]);
        let mut dec = StreamDecoder::new();
        let mut out = String::new();
        let mut pos = 0;
        while pos < combined.len() {
            let end = (pos + 7).min(combined.len());
            out.push_str(&dec.push(&combined[pos..end]));
            pos = end;
        }
        out.push_str(&dec.finish());
        assert!(out.contains("utf8部分正常"), "UTF-8 前缀应完整: {out}");
        assert!(out.contains("中文报错信息") || out.contains("中文报错"), "GBK 段应被转码: {out}");
    }

    #[test]
    fn stream_decoder_integration_chinese_output() {
        // 真实 spawn 路径：bash 输出中文 → 管道 → 流式解码器，验证无乱码
        let mut child = crate::os_sandbox::spawn_shell(
            "printf '中文测试行1\\n中文测试行2\\n' && printf '尾行-带中文-结束\\n'",
            ".",
        )
        .expect("spawn_shell failed");
        let mut reader = child.take_stdout().expect("stdout");
        let mut dec = StreamDecoder::new();
        let mut out = String::new();
        // 必须用 read_vectored：裸 read() 在此手工管道上第二次调用会永久阻塞
        // （Windows 管道 4KB 边界，见 shell.rs 注释）。3 字节小块强制跨块边界。
        use std::io::{IoSliceMut, Read};
        let mut buf = [0u8; 3];
        loop {
            let n = {
                let mut iov = [IoSliceMut::new(&mut buf)];
                match reader.read_vectored(&mut iov) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                }
            };
            out.push_str(&dec.push(&buf[..n]));
        }
        out.push_str(&dec.finish());
        assert!(out.contains("中文测试行1"), "中文输出乱码: {out:?}");
        assert!(out.contains("尾行-带中文-结束"), "尾行丢失: {out:?}");
        assert!(!out.contains('\u{FFFD}'), "出现替换符: {out:?}");
    }
}
