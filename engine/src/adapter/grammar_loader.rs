// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// GrammarLoader — dynamic tree-sitter grammar loading via .dll/.so.
// Static grammars (core languages) are pre-registered via register_static().
// Dynamic grammars are loaded lazily from <engine_dir>/grammars/ on first use.
//
// ponytail: convention over configuration. DLL naming is tree-sitter-{name}.dll,
// symbol is tree_sitter_{name}. Extension mapping uses a small built-in table.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tree_sitter::Language;
use tree_sitter_language::LanguageFn;

/// A loaded grammar: owns the Library handle so Language stays valid.
struct LoadedGrammar {
    _lib: libloading::Library,
    language: Language,
    #[allow(dead_code)]
    lang_key: String,
    #[allow(dead_code)]
    extensions: Vec<String>,
}

/// Process-wide grammar loader. Initialized once as a LazyLock.
/// Thread-safe: RwLock allows concurrent reads (hot path) and serialized writes (cold path).
pub struct GrammarLoader {
    loaded: RwLock<HashMap<String, Arc<LoadedGrammar>>>,
    grammar_dir: PathBuf,
    /// Extension → (dll_name, symbol_name, extensions) for grammars discoverable on disk.
    /// Populated by scan_dir() at construction.
    available: HashMap<String, (String, String, Vec<String>)>,
}

/// Built-in extension-to-grammar-name mapping for grammars where the extension
/// doesn't match the grammar name (e.g. cpp → ["cpp","hpp","cc","hh","cxx","hxx"]).
fn known_extensions() -> Vec<(&'static str, &'static str, &'static [&'static str])> {
    vec![
        ("c", "c", &["c", "h"]),
        ("cpp", "cpp", &["cpp", "hpp", "cc", "hh", "cxx", "hxx"]),
        ("c-sharp", "c_sharp", &["cs"]),
        ("typescript", "typescript", &["ts", "tsx", "mts", "cts"]),
        ("javascript", "javascript", &["js", "jsx", "mjs", "cjs"]),
        ("python", "python", &["py", "pyi", "pyx"]),
        ("ruby", "ruby", &["rb"]),
        ("scala", "scala", &["scala", "sc"]),
        ("haskell", "haskell", &["hs"]),
        ("html", "html", &["html", "htm"]),
        ("yaml", "yaml", &["yaml", "yml"]),
        ("elixir", "elixir", &["ex", "exs"]),
        ("erlang", "erlang", &["erl", "hrl"]),
        ("bash", "bash", &["sh", "bash"]),
        ("r", "r", &["r", "R"]),
        ("ocaml", "ocaml", &["ml"]),
        // ocaml_interface handled separately for .mli
        ("kotlin", "kotlin", &["kt", "kts"]),
        ("markdown", "markdown", &["md", "markdown"]),
        ("toml", "toml", &["toml"]),
    ]
}

impl GrammarLoader {
    pub fn new(grammar_dir: &Path) -> Self {
        let available = Self::scan_dir(grammar_dir);
        Self {
            loaded: RwLock::new(HashMap::new()),
            grammar_dir: grammar_dir.to_path_buf(),
            available,
        }
    }

    /// Pre-register a statically-linked grammar (from Cargo dependency).
    /// Multiple extensions share the same Language.
    pub fn register_static(&self, lang: Language, lang_key: &str, extensions: &[&str]) {
        let grammar = Arc::new(LoadedGrammar {
            // ponytail: static grammars don't need a Library handle — data is in .text
            _lib: unsafe { std::mem::zeroed() },
            language: lang,
            lang_key: lang_key.to_string(),
            extensions: extensions.iter().map(|s| s.to_string()).collect(),
        });
        let mut loaded = self.loaded.write().unwrap();
        for ext in extensions {
            loaded.insert(ext.to_string(), grammar.clone());
        }
    }

    /// Get a Language for a file extension. Returns None if unsupported.
    pub fn get(&self, ext: &str) -> Option<Language> {
        // Fast path: already loaded (static or previously lazy-loaded)
        {
            let loaded = self.loaded.read().unwrap();
            if let Some(g) = loaded.get(ext) {
                return Some(g.language.clone());
            }
        }

        // Slow path: try to load from DLL
        let (dll_name, symbol_name, extensions) = self.available.get(ext)?;
        let dll_path = self.grammar_dir.join(dll_name);

        // SAFETY: loading a trusted grammar DLL from our own grammars/ directory.
        // The symbol name is derived from the known convention, not user input.
        unsafe {
            let lib = match libloading::Library::new(&dll_path) {
                Ok(lib) => lib,
                Err(e) => {
                    eprintln!("[grammar] failed to load {}: {e}", dll_path.display());
                    return None;
                }
            };
            let fn_ptr: libloading::Symbol<unsafe extern "C" fn() -> *const ()> =
                match lib.get(symbol_name.as_bytes()) {
                    Ok(f) => f,
                    Err(e) => {
                        eprintln!(
                            "[grammar] symbol '{}' not found in {}: {e}",
                            symbol_name,
                            dll_path.display()
                        );
                        return None;
                    }
                };
            let lang_fn = LanguageFn::from_raw(*fn_ptr);
            let language = Language::new(lang_fn);

            let grammar = Arc::new(LoadedGrammar {
                _lib: lib,
                language: language.clone(),
                lang_key: symbol_name.clone(),
                extensions: extensions.clone(),
            });

            let mut loaded = self.loaded.write().unwrap();
            for e in extensions {
                loaded.entry(e.clone()).or_insert_with(|| grammar.clone());
            }
            Some(language)
        }
    }

    /// All supported extensions (static + discovered).
    pub fn supported_extensions(&self) -> Vec<String> {
        let loaded = self.loaded.read().unwrap();
        let mut exts: Vec<String> = loaded.keys().cloned().collect();
        // Also include not-yet-loaded but available
        for ext in self.available.keys() {
            if !exts.contains(ext) {
                exts.push(ext.clone());
            }
        }
        exts
    }

    /// Scan grammars/ directory for tree-sitter-*.dll files.
    /// Returns extension → (dll_name, symbol_name, extensions) mappings.
    fn scan_dir(dir: &Path) -> HashMap<String, (String, String, Vec<String>)> {
        let mut map = HashMap::new();

        let Ok(entries) = std::fs::read_dir(dir) else {
            return map;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };

            // Match: tree-sitter-{name}.dll or tree-sitter-{name}.so
            let stem = if cfg!(windows) {
                name.strip_suffix(".dll")
            } else {
                name.strip_suffix(".so")
            };
            let Some(stem) = stem else { continue };
            let Some(grammar_name) = stem.strip_prefix("tree-sitter-") else {
                continue;
            };

            let dll_name = name.to_string();
            let symbol_name = format!("tree_sitter_{}", grammar_name.replace('-', "_"));

            // Resolve extensions
            let exts = Self::resolve_extensions(grammar_name);

            for ext in &exts {
                map.insert(
                    ext.to_string(),
                    (dll_name.clone(), symbol_name.clone(), exts.clone()),
                );
            }
        }

        map
    }

    /// Map a grammar name to its file extensions using the built-in table.
    /// Falls back to using the grammar name itself as the extension.
    fn resolve_extensions(grammar_name: &str) -> Vec<String> {
        for (key, _grammar_fn, exts) in known_extensions() {
            if key == grammar_name {
                return exts.iter().map(|s| s.to_string()).collect();
            }
        }
        // Default: grammar name IS the extension (covers go, rs, java, json, css, zig, etc.)
        vec![grammar_name.to_string()]
    }
}

/// Find the grammar directory. Checks:
/// 1. HOLOGRAM_GRAMMAR_DIR env var
/// 2. <exe_dir>/grammars/
/// 3. ./grammars/ (fallback)
pub fn find_grammar_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HOLOGRAM_GRAMMAR_DIR") {
        let p = PathBuf::from(dir);
        if p.exists() {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let d = parent.join("grammars");
            if d.exists() {
                return d;
            }
        }
    }
    PathBuf::from("grammars")
}

#[cfg(test)]
mod tests {
    use super::*;
    

    #[test]
    fn test_register_static_and_get() {
        let tmp = std::env::temp_dir().join("hologram_test_grammars_empty");
        let _ = std::fs::create_dir_all(&tmp);
        let loader = GrammarLoader::new(&tmp);

        // Use a known static grammar to test registration
        let lang: Language = tree_sitter_json::LANGUAGE.into();
        loader.register_static(lang, "json", &["json"]);

        assert!(loader.get("json").is_some());
        assert!(loader.get("nope").is_none());
    }

    #[test]
    fn test_register_static_multi_ext() {
        let tmp = std::env::temp_dir().join("hologram_test_grammars_empty2");
        let _ = std::fs::create_dir_all(&tmp);
        let loader = GrammarLoader::new(&tmp);

        let lang: Language = tree_sitter_json::LANGUAGE.into();
        loader.register_static(lang, "json", &["json", "json5"]);

        assert!(loader.get("json").is_some());
        assert!(loader.get("json5").is_some());
    }

    #[test]
    fn test_supported_extensions() {
        let tmp = std::env::temp_dir().join("hologram_test_grammars_empty3");
        let _ = std::fs::create_dir_all(&tmp);
        let loader = GrammarLoader::new(&tmp);

        let lang: Language = tree_sitter_json::LANGUAGE.into();
        loader.register_static(lang, "json", &["json"]);

        let exts = loader.supported_extensions();
        assert!(exts.contains(&"json".to_string()));
    }

    #[test]
    fn test_resolve_extensions_known() {
        let exts = GrammarLoader::resolve_extensions("cpp");
        assert!(exts.contains(&"cpp".to_string()));
        assert!(exts.contains(&"hpp".to_string()));
    }

    #[test]
    fn test_resolve_extensions_unknown() {
        let exts = GrammarLoader::resolve_extensions("zig");
        assert_eq!(exts, vec!["zig".to_string()]);
    }

    #[test]
    fn test_find_grammar_dir_env() {
        // Use a path that definitely doesn't exist on any platform
        let fake = if cfg!(windows) { "Z:\\hologram_nonexistent_12345" } else { "/nonexistent/hologram_12345" };
        std::env::set_var("HOLOGRAM_GRAMMAR_DIR", fake);
        let dir = find_grammar_dir();
        // Should fall back because the env path doesn't exist — current_exe dir or ./grammars/
        assert!(!dir.to_string_lossy().contains("nonexistent"));
        std::env::remove_var("HOLOGRAM_GRAMMAR_DIR");
    }

    #[test]
    fn test_scan_dir_empty() {
        let tmp = std::env::temp_dir().join("hologram_test_scan_empty");
        let _ = std::fs::create_dir_all(&tmp);
        let loader = GrammarLoader::new(&tmp);
        assert!(loader.available.is_empty());
    }

    #[test]
    fn test_scan_dir_with_dlls() {
        let tmp = std::env::temp_dir().join("hologram_test_scan_dlls");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Create dummy DLL files (just empty files for scan test)
        std::fs::File::create(tmp.join("tree-sitter-php.dll")).unwrap();
        std::fs::File::create(tmp.join("tree-sitter-kotlin.dll")).unwrap();
        std::fs::File::create(tmp.join("not-a-grammar.txt")).unwrap();

        let loader = GrammarLoader::new(&tmp);
        assert!(loader.available.contains_key("php"));
        assert!(loader.available.contains_key("kt")); // kotlin has known exts
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
