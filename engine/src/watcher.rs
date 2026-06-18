// File watcher — public API delegates to Engine.
// Legacy standalone functions preserved for backward compatibility.
// Engine::start_watcher() is the canonical implementation.

use std::path::PathBuf;

/// Start watching the given project root for source file changes.
/// Delegates to the global Engine instance.
pub fn start_watcher(project_root: PathBuf) {
    crate::engine::with_engine(|engine| {
        engine.start_watcher(project_root, None::<Box<dyn Fn(String) + Send + 'static>>);
    });
}

/// Stop the file watcher. Delegates to the global Engine instance.
pub fn stop_watcher() {
    crate::engine::with_engine(|engine| {
        engine.stop_watcher();
    });
}
