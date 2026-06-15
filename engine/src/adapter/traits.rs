// LanguageAdapter trait — implement per language.
pub trait LanguageAdapter: Send + Sync {
    /// Returns the file extensions this adapter handles (e.g. ["py"], ["js", "ts"])
    fn extensions(&self) -> &[&str];

    /// Parse a source file and return extracted nodes and edges.
    fn analyze(&self, file_path: &str, source: &str) -> (Vec<crate::graph::Node>, Vec<crate::graph::Edge>);
}
