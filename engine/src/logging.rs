// HoloGram structured logging — tracing-based, NDJSON to .hologram/logs/engine.log
use std::path::Path;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, Layer, EnvFilter, Registry};

/// Initialize logging. Returns a `WorkerGuard` that must be held for the
/// lifetime of the process — dropping it flushes and shuts down the writer.
///
/// If `project_root` is provided, writes JSON logs to
/// `<project_root>/.hologram/logs/engine.log` in addition to stderr.
pub fn init_logging(project_root: Option<&Path>) -> WorkerGuard {
    let mut layers = Vec::new();

    // Human-readable stderr layer — always active for dev/debug
    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_writer(std::io::stderr);
    layers.push(stderr_layer.boxed());

    // JSON file layer — only when we have a project root
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
        // No project root (TCP server mode without a project yet) —
        // log to stderr only. Return a no-op guard.
        let (_, guard) = tracing_appender::non_blocking(std::io::sink());
        guard
    };

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing::subscriber::set_global_default(
        Registry::default().with(filter).with(layers),
    )
    .expect("tracing subscriber already set");

    guard
}
