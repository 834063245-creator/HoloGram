// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// GrammarLoader — 通过 .dll/.so 动态加载 tree-sitter 语法。
// 静态语法（核心语言）通过 register_static() 预注册。
// 动态语法在首次使用时从 <engine_dir>/grammars/ 惰性加载。
//
// ponytail: 约定优于配置。DLL 命名为 tree-sitter-{name}.dll，
// 符号为 tree_sitter_{name}。扩展名映射使用内置的小型映射表。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tree_sitter::Language;
use tree_sitter_language::LanguageFn;

/// 已加载的语法：持有 Library 句柄以保持 Language 有效。
/// 静态链接语法为 `None`（数据位于 .text 段，无需卸载）。
struct LoadedGrammar {
    _lib: Option<libloading::Library>,
    language: Language,

}

/// 进程级语法加载器。作为 LazyLock 初始化一次。
/// 线程安全：RwLock 允许并发读取（热路径）和串行写入（冷路径）。
pub struct GrammarLoader {
    loaded: RwLock<HashMap<String, Arc<LoadedGrammar>>>,
    grammar_dir: PathBuf,
    /// 扩展名 → (dll_name, symbol_name, extensions)，用于可在磁盘上发现的语法。
    /// 在构造时由 scan_dir() 填充。
    available: HashMap<String, (String, String, Vec<String>)>,
}

/// 内置扩展名到语法名的映射，用于扩展名
/// 与语法名不匹配的情况（例如 cpp → ["cpp","hpp","cc","hh","cxx","hxx"]）。
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
        // ocaml_interface 单独处理 .mli
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

    /// 预注册静态链接语法（来自 Cargo 依赖）。
    /// 多个扩展名共享同一个 Language。
    pub fn register_static(&self, lang: Language, _lang_key: &str, extensions: &[&str]) {
        let grammar = Arc::new(LoadedGrammar {
            // ponytail: 静态语法不需要 Library 句柄 — 数据在 .text 段中。
            // 零值 Library 在 drop 时会调用 dlclose(0)/FreeLibrary(NULL)，在 glibc 上会导致中止。
            _lib: None,
            language: lang,
        });
        let mut loaded = self.loaded.write().unwrap();
        for ext in extensions {
            loaded.insert(ext.to_string(), grammar.clone());
        }
    }

    /// 根据文件扩展名获取 Language。如果不支持则返回 None。
    pub fn get(&self, ext: &str) -> Option<Language> {
        // 快速路径：已加载（静态或之前惰性加载的）
        {
            let loaded = self.loaded.read().unwrap();
            if let Some(g) = loaded.get(ext) {
                return Some(g.language.clone());
            }
        }

        // 慢速路径：尝试从 DLL 加载
        let (dll_name, symbol_name, extensions) = self.available.get(ext)?;
        let dll_path = self.grammar_dir.join(dll_name);

        // 安全性：从我们自己的 grammars/ 目录加载受信任的语法 DLL。
        // 符号名来自已知约定，而非用户输入。
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
                _lib: Some(lib),
                language: language.clone(),
            });

            let mut loaded = self.loaded.write().unwrap();
            for e in extensions {
                loaded.entry(e.clone()).or_insert_with(|| grammar.clone());
            }
            Some(language)
        }
    }

    /// 所有支持的扩展名（静态 + 已发现的）。
    pub fn supported_extensions(&self) -> Vec<String> {
        let loaded = self.loaded.read().unwrap();
        let mut exts: Vec<String> = loaded.keys().cloned().collect();
        // 也包括尚未加载但可用的
        for ext in self.available.keys() {
            if !exts.contains(ext) {
                exts.push(ext.clone());
            }
        }
        exts
    }

    /// 扫描 grammars/ 目录中的 tree-sitter-*.dll 文件。
    /// 返回 扩展名 → (dll_name, symbol_name, extensions) 映射。
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

            // 匹配：tree-sitter-{name}.dll 或 tree-sitter-{name}.so
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

            // 解析扩展名
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

    /// 使用内置映射表将语法名映射到其文件扩展名。
    /// 回退为使用语法名本身作为扩展名。
    fn resolve_extensions(grammar_name: &str) -> Vec<String> {
        for (key, _grammar_fn, exts) in known_extensions() {
            if key == grammar_name {
                return exts.iter().map(|s| s.to_string()).collect();
            }
        }
        // 默认：语法名即为扩展名（覆盖 go、rs、java、json、css、zig 等）
        vec![grammar_name.to_string()]
    }
}

/// 查找语法目录。检查顺序：
/// 1. HOLOGRAM_GRAMMAR_DIR 环境变量
/// 2. <exe_dir>/grammars/
/// 3. ./grammars/（回退）
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

        // 使用已知的静态语法测试注册
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
        // 使用一个在任何平台上都不存在的路径
        let fake = if cfg!(windows) { "Z:\\nonexistent_tool_12345" } else { "/nonexistent/hologram_12345" };
        std::env::set_var("HOLOGRAM_GRAMMAR_DIR", fake);
        let dir = find_grammar_dir();
        // 应该回退，因为环境变量路径不存在 — 使用 current_exe 目录或 ./grammars/
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

        // 创建虚拟语法文件（仅为扫描测试创建空文件）；
        // scan_dir 在 Windows 上匹配 .dll，在其他平台匹配 .so
        let ext = if cfg!(windows) { "dll" } else { "so" };
        std::fs::File::create(tmp.join(format!("tree-sitter-php.{ext}"))).unwrap();
        std::fs::File::create(tmp.join(format!("tree-sitter-kotlin.{ext}"))).unwrap();
        std::fs::File::create(tmp.join("not-a-grammar.txt")).unwrap();

        let loader = GrammarLoader::new(&tmp);
        assert!(loader.available.contains_key("php"));
        assert!(loader.available.contains_key("kt")); // kotlin 有已知的扩展名
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
