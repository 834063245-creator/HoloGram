// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// GRAMMAR_LOADER — global grammar registry, lazy-initialized on first access.
// Extracted from engine/mod.rs to keep the module file under 200 lines.

use crate::adapter::grammar_loader::{find_grammar_dir, GrammarLoader};

/// Global grammar loader — static + dynamic grammars, lazy-initialized on first access.
pub static GRAMMAR_LOADER: std::sync::LazyLock<GrammarLoader> =
    std::sync::LazyLock::new(|| {
        let loader = GrammarLoader::new(&find_grammar_dir());
        // Core languages — statically linked via Cargo deps
        loader.register_static(tree_sitter_python::LANGUAGE.into(), "python", &["py","pyi","pyx"]);
        loader.register_static(tree_sitter_javascript::LANGUAGE.into(), "javascript", &["js","jsx","mjs","cjs"]);
        loader.register_static(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "typescript", &["ts","mts","cts"]);
        // ponytail: LANGUAGE_TSX is a separate grammar with JSX support.
        // tree-sitter-typescript 0.23 provides it alongside LANGUAGE_TYPESCRIPT.
        loader.register_static(tree_sitter_typescript::LANGUAGE_TSX.into(), "tsx", &["tsx"]);
        loader.register_static(tree_sitter_go::LANGUAGE.into(), "go", &["go"]);
        loader.register_static(tree_sitter_rust::LANGUAGE.into(), "rust", &["rs"]);
        loader.register_static(tree_sitter_java::LANGUAGE.into(), "java", &["java"]);
        loader.register_static(tree_sitter_c::LANGUAGE.into(), "c", &["c","h"]);
        loader.register_static(tree_sitter_cpp::LANGUAGE.into(), "cpp", &["cpp","hpp","cc","hh","cxx","hxx"]);
        loader.register_static(tree_sitter_ruby::LANGUAGE.into(), "ruby", &["rb"]);
        loader.register_static(tree_sitter_lua::LANGUAGE.into(), "lua", &["lua"]);
        loader.register_static(tree_sitter_c_sharp::LANGUAGE.into(), "c_sharp", &["cs"]);
        loader.register_static(tree_sitter_php::LANGUAGE_PHP.into(), "php", &["php"]);
        loader.register_static(tree_sitter_swift::LANGUAGE.into(), "swift", &["swift"]);
        loader.register_static(tree_sitter_dart::LANGUAGE.into(), "dart", &["dart"]);
        loader.register_static(tree_sitter_scala::LANGUAGE.into(), "scala", &["scala","sc"]);
        loader.register_static(tree_sitter_ocaml::LANGUAGE_OCAML.into(), "ocaml", &["ml"]);
        loader.register_static(tree_sitter_haskell::LANGUAGE.into(), "haskell", &["hs"]);
        loader.register_static(tree_sitter_r::LANGUAGE.into(), "r", &["r","R"]);
        loader.register_static(tree_sitter_nix::LANGUAGE.into(), "nix", &["nix"]);
        loader.register_static(tree_sitter_bash::LANGUAGE.into(), "bash", &["sh","bash"]);
        // ponytail: JSON is data, not code. generic_walk has no JSON-specific
        // node-kind handlers, so parsing JSON files is a no-op that wastes CPU.
        // loader.register_static(tree_sitter_json::LANGUAGE.into(), "json", &["json"]);
        loader.register_static(tree_sitter_html::LANGUAGE.into(), "html", &["html","htm"]);
        loader.register_static(tree_sitter_css::LANGUAGE.into(), "css", &["css"]);
        loader.register_static(tree_sitter_yaml::LANGUAGE.into(), "yaml", &["yaml","yml"]);
        loader.register_static(tree_sitter_zig::LANGUAGE.into(), "zig", &["zig"]);
        loader.register_static(tree_sitter_elixir::LANGUAGE.into(), "elixir", &["ex","exs"]);
        loader.register_static(tree_sitter_erlang::LANGUAGE.into(), "erlang", &["erl","hrl"]);
        loader
    });
