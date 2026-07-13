use std::fs;

fn main() {
    let target_triple = std::env::var("TARGET").unwrap_or_else(|_| "x86_64-pc-windows-msvc".into());
    let dst = format!("binaries/hologram-engine-{}.exe", target_triple);

    // Only copy when the binary doesn't exist yet. If it already exists,
    // skip — changing mtime triggers Tauri's file watcher → restart loop.
    // First run: one-time copy, then stable thereafter.
    if !std::path::Path::new(&dst).exists() {
        let src = if cfg!(debug_assertions) {
            "../engine/target/debug/hologram-engine.exe"
        } else {
            "../engine/target/release/hologram-engine.exe"
        };
        let src_path = std::path::Path::new(src);
        if src_path.exists() {
            let _ = fs::create_dir_all("binaries");
            let _ = fs::copy(src_path, &dst);
        }
    }

    tauri_build::build();
}
