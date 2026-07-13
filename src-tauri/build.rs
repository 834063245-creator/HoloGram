use std::fs;

fn main() {
    // Release builds: copy engine binary to binaries/ for bundling.
    // Dev builds: skip — utils.rs finds engine at runtime from engine/target/.
    // (Copying during dev triggers Tauri's file watcher → infinite restart loop.)
    if !cfg!(debug_assertions) {
        let target_triple = std::env::var("TARGET").unwrap_or_else(|_| "x86_64-pc-windows-msvc".into());
        let src = std::path::Path::new("../engine/target/release/hologram-engine.exe");
        if src.exists() {
            let dst = format!("binaries/hologram-engine-{}.exe", target_triple);
            let _ = fs::create_dir_all("binaries");
            if let Err(e) = fs::copy(src, &dst) {
                eprintln!("[build.rs] WARNING: failed to copy engine binary: {}", e);
            } else {
                println!("cargo:rerun-if-changed={}", dst);
            }
        }
    }

    tauri_build::build();
}
