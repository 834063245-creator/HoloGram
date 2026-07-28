// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # HoloGram 结构化日志模块
//!
//! 基于 `tracing` 框架，以 NDJSON 格式写入 `.hologram/logs/engine.log`。
//! 在 MCP stdio 模式下故意不输出到 stderr，避免干扰客户端的 stdout 读取器。

use std::path::Path;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, Layer, EnvFilter, Registry};

/// 初始化日志系统。返回 `WorkerGuard`，必须在进程生命周期内持有
/// ——丢弃它会触发 flush 并关闭写入器。
///
/// 如果提供了 `project_root`，则将 JSON 日志写入
/// `<project_root>/.hologram/logs/engine.log`（不额外输出到 stderr）。
pub fn init_logging(project_root: Option<&Path>) -> WorkerGuard {
    let mut layers = Vec::new();

    // JSON 文件层——主要日志输出。有项目根目录时，日志写入
    // .hologram/logs/engine.log。故意不添加 stderr 层：
    // 在 MCP stdio 模式下 stderr 可能干扰 Windows 上客户端的 stdout 读取器，
    // 导致响应解析失败。
    let guard = if let Some(root) = project_root {
        let log_dir = root.join(".hologram").join("logs");
        let _ = std::fs::create_dir_all(&log_dir);

        let file_appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::NEVER)
            .filename_prefix("engine")
            .filename_suffix("log")
            .max_log_files(5)
            .build(&log_dir)
            .expect("failed to create engine log file appender");

        let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

        let file_layer = fmt::layer().json().with_writer(non_blocking);
        layers.push(file_layer.boxed());

        guard
    } else {
        // 无项目根目录——仅写入空 sink。stderr 会干扰 MCP stdio。
        // 开发者可以 tail 日志文件，或设置 RUST_LOG + 运行 TCP 服务器来查看输出。
        let (_, guard) = tracing_appender::non_blocking(std::io::sink());
        guard
    };

    // 日志级别过滤：优先从环境变量 RUST_LOG 读取，默认 info
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing::subscriber::set_global_default(
        Registry::default().with(filter).with(layers),
    )
    .expect("tracing subscriber already set");

    guard
}
