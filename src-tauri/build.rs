use std::fs;

fn main() {
    // `tauri_build::build()` rewrites these files on every run even when
    // content is unchanged. mtime change → watcher → rebuild → loop.
    // Fix: snapshot content + mtime, restore both if content unchanged.
    let watch_paths = &[
        "build.rs",
        "capabilities/default.json",
        "gen/schemas/acl-manifests.json",
        "gen/schemas/capabilities.json",
        "gen/schemas/desktop-schema.json",
        "gen/schemas/windows-schema.json",
    ];

    // Don't restore build.rs if running under itself — that would be
    // self-modifying. But do protect its mtime for the watcher.
    let _self_protect = std::env::var("BUILD_RS_SELF_PROTECT").is_ok();

    let mut snapshots: Vec<(&str, Vec<u8>, std::time::SystemTime)> = Vec::new();
    for p in watch_paths {
        if p == &"build.rs" && !_self_protect {
            // Skip self on first run — allow second-run protection via env
            if let (Ok(data), Ok(meta)) = (fs::read(p), fs::metadata(p)) {
                if let Ok(mtime) = meta.modified() {
                    snapshots.push((p, data, mtime));
                    std::env::set_var("BUILD_RS_SELF_PROTECT", "1");
                }
            }
            continue;
        }
        if let (Ok(data), Ok(meta)) = (fs::read(p), fs::metadata(p)) {
            if let Ok(mtime) = meta.modified() {
                snapshots.push((p, data, mtime));
            }
        }
    }

    tauri_build::build();

    for (path, orig_bytes, orig_mtime) in &snapshots {
        if let Ok(after) = fs::read(path) {
            if orig_bytes == &after {
                // Content unchanged — write original bytes back, then fix mtime
                let _ = fs::write(path, orig_bytes);
                let _ = filetime::set_file_mtime(
                    path,
                    filetime::FileTime::from_system_time(*orig_mtime),
                );
            }
        }
    }
}
