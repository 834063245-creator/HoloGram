use regex::Regex;

pub struct PatternMatcher {
    migration: Vec<Regex>,
    serialization: Vec<Regex>,
    config: Vec<Regex>,
    threshold_vars: Vec<Regex>,
    llm_prompt_vars: Vec<Regex>,
    sort_filter_funcs: Vec<Regex>,
    rhythm_vars: Vec<Regex>,
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
            threshold_vars: compile(&[
                r"(?i).*threshold.*", r"(?i).*timeout.*", r"(?i).*interval.*", r"(?i).*ttl.*",
                r"(?i).*delay.*", r"(?i).*limit.*", r"(?i).*max_?retries?.*", r"(?i).*rate_limit.*",
                r"(?i).*capacity.*", r"(?i).*buffer_?size.*", r"(?i).*heartbeat.*", r"(?i).*deadline.*",
                r"(?i).*expir\w*.*", r"(?i).*max_\w+.*", r"(?i).*min_\w+.*",
            ]),
            llm_prompt_vars: compile(&[
                r"(?i).*\bprompt.*", r"(?i).*\bsystem_prompt.*", r"(?i).*\btemplate.*",
                r"(?i).*\binstruction.*", r"(?i).*\bsystem_message.*", r"(?i).*\bfew_shot.*",
            ]),
            sort_filter_funcs: compile(&[
                r"(?i).*\bsort.*", r"(?i).*\bfilter.*", r"(?i).*\brank.*", r"(?i).*\bscore.*",
                r"(?i).*\bweigh\w*.*", r"(?i).*\border\w*.*", r"(?i).*\brelevan\w*.*",
                r"(?i).*\bpriorit\w*.*", r"(?i).*\brecommend\w*.*",
            ]),
            rhythm_vars: compile(&[
                r"(?i).*\binterval.*", r"(?i).*\bperiod.*", r"(?i).*\bfrequency.*",
                r"(?i).*\bcron.*", r"(?i).*\bschedule.*", r"(?i).*\btick.*",
            ]),
        }
    }

    pub fn is_migration_file(&self, path: &str) -> bool { self.migration.iter().any(|r| r.is_match(path)) }
    pub fn is_serialization_file(&self, path: &str) -> bool { self.serialization.iter().any(|r| r.is_match(path)) }
    pub fn is_config_file(&self, path: &str) -> bool { self.config.iter().any(|r| r.is_match(path)) }
    pub fn is_doc_or_test_file(&self, path: &str) -> bool {
        path.contains("test_") || path.contains("_test.") || path.contains("tests/") || path.contains("__pycache__")
        || path.ends_with(".md") || path.ends_with(".rst") || path.ends_with(".txt")
        || path.ends_with(".png") || path.ends_with(".jpg") || path.ends_with(".svg")
    }
    pub fn matches_threshold_variable(&self, name: &str) -> bool { self.threshold_vars.iter().any(|r| r.is_match(name)) }
    pub fn matches_llm_prompt_variable(&self, name: &str) -> bool { self.llm_prompt_vars.iter().any(|r| r.is_match(name)) }
    pub fn matches_sort_filter_function(&self, name: &str) -> bool { self.sort_filter_funcs.iter().any(|r| r.is_match(name)) }
    pub fn matches_rhythm_variable(&self, name: &str) -> bool { self.rhythm_vars.iter().any(|r| r.is_match(name)) }
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

    #[test]
    fn test_doc_or_test_detection() {
        let matcher = PatternMatcher::new();
        assert!(matcher.is_doc_or_test_file("test_main.py"));
        assert!(matcher.is_doc_or_test_file("main_test.rs"));
        assert!(matcher.is_doc_or_test_file("tests/unit.py"));
        assert!(matcher.is_doc_or_test_file("readme.md"));
        assert!(matcher.is_doc_or_test_file("diagram.png"));
        assert!(!matcher.is_doc_or_test_file("src/handler.py"));
    }

    #[test]
    fn test_threshold_variable() {
        let matcher = PatternMatcher::new();
        assert!(matcher.matches_threshold_variable("timeout_secs"));
        assert!(matcher.matches_threshold_variable("MAX_RETRIES"));
        assert!(matcher.matches_threshold_variable("rate_limit"));
        assert!(!matcher.matches_threshold_variable("user_name"));
    }

    #[test]
    fn test_llm_prompt_variable() {
        let matcher = PatternMatcher::new();
        assert!(matcher.matches_llm_prompt_variable("system_prompt"));
        assert!(matcher.matches_llm_prompt_variable("few_shot_examples"));
        assert!(!matcher.matches_llm_prompt_variable("file_path"));
    }

    #[test]
    fn test_sort_filter_function() {
        let matcher = PatternMatcher::new();
        assert!(matcher.matches_sort_filter_function("sort_by_date"));
        assert!(matcher.matches_sort_filter_function("filter_results"));
        assert!(matcher.matches_sort_filter_function("priority_queue"));
        assert!(!matcher.matches_sort_filter_function("add_numbers"));
    }

    #[test]
    fn test_rhythm_variable() {
        let matcher = PatternMatcher::new();
        assert!(matcher.matches_rhythm_variable("cron_expression"));
        assert!(matcher.matches_rhythm_variable("schedule_task"));
        assert!(matcher.matches_rhythm_variable("tick_interval"));
        assert!(!matcher.matches_rhythm_variable("random_value"));
    }
}
