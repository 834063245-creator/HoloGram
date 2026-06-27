// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use regex::Regex;

pub struct PatternMatcher {
    migration: Vec<Regex>,
    serialization: Vec<Regex>,
    config: Vec<Regex>,
}

impl PatternMatcher {
    pub fn new() -> Self {
        fn compile(ps: &[&str]) -> Vec<Regex> {
            ps.iter().map(|p| Regex::new(p).unwrap()).collect()
        }
        Self {
            migration: compile(&[
                r"migrations?/", r"alembic/", r"\b\d{4,}_.*\.(py|sql)$", r"\.sql$",
                r".*schema.*\.(py|sql)$", r"\bschema\.sql\b", r"\bmigrate\b.*\.(py|sql)$",
            ]),
            serialization: compile(&[
                r"\.proto$", r"\.fbs$", r"\.avsc$", r"\.thrift$", r"\.capnp$",
            ]),
            config: compile(&[
                r"\.yaml$", r"\.yml$", r"\.toml$", r"\.json$", r"\.ini$", r"\.cfg$",
                r"\.env$", r"\.env\.", r"settings\.py$", r"config\.py$", r"\.conf$",
            ]),
        }
    }

    pub fn is_migration_file(&self, path: &str) -> bool { self.migration.iter().any(|r| r.is_match(path)) }
    pub fn is_serialization_file(&self, path: &str) -> bool { self.serialization.iter().any(|r| r.is_match(path)) }
    pub fn is_config_file(&self, path: &str) -> bool { self.config.iter().any(|r| r.is_match(path)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migration_file_detection() {
        let matcher = PatternMatcher::new();
        assert!(matcher.is_migration_file("migrations/0001_init.py"));
        assert!(matcher.is_migration_file("alembic/versions/abc.py"));
        assert!(matcher.is_migration_file("001_init.sql"));
        assert!(!matcher.is_migration_file("src/main.py"));
    }

    #[test]
    fn test_serialization_file_detection() {
        let matcher = PatternMatcher::new();
        assert!(matcher.is_serialization_file("schema.proto"));
        assert!(matcher.is_serialization_file("data.fbs"));
        assert!(!matcher.is_serialization_file("main.rs"));
    }

    #[test]
    fn test_config_file_detection() {
        let matcher = PatternMatcher::new();
        assert!(matcher.is_config_file("config.yaml"));
        assert!(matcher.is_config_file("settings.toml"));
        assert!(matcher.is_config_file(".env"));
        assert!(matcher.is_config_file("settings.py"));
        assert!(!matcher.is_config_file("main.py"));
    }

}
