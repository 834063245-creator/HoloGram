// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram Tauri 桥接层结构化日志 — NDJSON 输出到 .hologram/logs/bridge.log
use std::path::Path;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, EnvFilter, Registry};

/// 初始化桥接层日志。返回一个 `WorkerGuard`，必须在
/// 进程生命周期内持有。
pub fn init_logging(project_root: &Path) -> WorkerGuard {
    let log_dir = project_root.join(".hologram").join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::NEVER)
        .filename_prefix("bridge")
        .filename_suffix("log")
        .max_log_files(5)
        .build(&log_dir)
        .expect("failed to create bridge log file appender");

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let file_layer = fmt::layer().json().with_writer(non_blocking);

    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_writer(std::io::stderr);

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing::subscriber::set_global_default(
        Registry::default().with(filter).with(file_layer).with(stderr_layer),
    )
    .expect("bridge tracing subscriber already set");

    guard
}
