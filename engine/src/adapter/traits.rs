pub trait LanguageAdapter: Send + Sync {
    fn extensions(&self) -> Vec<String>;
    fn analyze(&self, file_path: &str, source: &str) -> (Vec<crate::graph::Node>, Vec<crate::graph::Edge>);
}
