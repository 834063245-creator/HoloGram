use std::fs;

fn main() {
    // `tauri_build::build()` rewrites these files on every run even when
    // content is unchanged. mtime change → watcher → rebuild → loop.
    // Fix: snapshot content + mtime, restore both if content unchanged.
    let watch_paths = &[
        "capabilities/default.json",
        "gen/schemas/acl-manifests.json",
        "gen/schemas/capabilities.json",
        "gen/schemas/desktop-schema.json",
        "gen/schemas/windows-schema.json",
    ];

    let mut snapshots: Vec<(&str, Vec<u8>, std::time::SystemTime)> = Vec::new();
    for p in watch_paths {
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
