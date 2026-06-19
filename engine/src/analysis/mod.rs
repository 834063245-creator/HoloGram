pub mod coupling;
pub mod fragility;
pub mod cycles;
pub mod coupling_report;
pub mod graph_stats;
pub mod dataflow;
pub mod threading;
pub mod blindspots;
pub mod explore;
pub mod framework_routes;
pub mod dynamic_dispatch;
pub mod policy_check;

pub mod dataflow_synthesis;

/// Directories that should never be walked during analysis.
/// These are build artifacts, dependencies, and VCS — not project source.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", ".venv", "venv",
    "__pycache__", ".hologram", ".next", ".nuxt", "build", "out",
    ".angular", ".cache", "coverage", ".tox", ".eggs", "*.egg-info",
    "htmlcov", ".reasonix", ".codegraph", ".ruff_cache", ".mypy_cache",
    ".pytest_cache", "env", ".hg", ".svn",
];

/// Returns true if the entry (file or directory) lives under a skippable directory.
pub(crate) fn is_skippable_dir(entry: &walkdir::DirEntry) -> bool {
    entry.path().components().any(|c| {
        c.as_os_str().to_str().map_or(false, |name| {
            SKIP_DIRS.contains(&name) || name.starts_with('.')
        })
    })
}
pub use coupling::compute_coupling;
pub use fragility::fragile_nodes;
pub use fragility::fragile_nodes_from_index;
pub use cycles::detect_cycles;
pub use cycles::detect_cycles_from_index;
pub use coupling_report::coupling_report;
pub use coupling_report::coupling_report_from_index;
pub use graph_stats::graph_summary;
pub use graph_stats::graph_summary_from_index;
pub use dataflow::classify_cycles;
pub use dataflow::classify_cycles_from_index;
pub use threading::thread_conflict_report;
pub use blindspots::find_blindspots;
pub use explore::explore;
pub use framework_routes::detect_framework_routes;
pub use dynamic_dispatch::synthesize_dynamic_edges;
pub use dataflow_synthesis::synthesize_dataflow_edges;
pub use policy_check::policy_check_from_index;
