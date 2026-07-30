// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// GRAMMAR_LOADER — 全局语法注册表，首次访问时延迟初始化。
// 从 engine/mod.rs 中提取，以保持模块文件在 200 行以内。

use crate::adapter::grammar_loader::{find_grammar_dir, GrammarLoader};

/// 全局语法加载器 — 静态 + 动态语法，首次访问时延迟初始化。
pub static GRAMMAR_LOADER: std::sync::LazyLock<GrammarLoader> =
    std::sync::LazyLock::new(|| {
        let loader = GrammarLoader::new(&find_grammar_dir());
        // 核心语言 — 通过 Cargo 依赖静态链接
        loader.register_static(tree_sitter_python::LANGUAGE.into(), "python", &["py","pyi","pyx"]);
        loader.register_static(tree_sitter_javascript::LANGUAGE.into(), "javascript", &["js","jsx","mjs","cjs"]);
        loader.register_static(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "typescript", &["ts","mts","cts"]);
        // ponytail: LANGUAGE_TSX 是独立的语法，支持 JSX。
        // tree-sitter-typescript 0.23 随 LANGUAGE_TYPESCRIPT 一并提供。
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
        // ponytail: JSON 是数据而非代码。generic_walk 没有针对 JSON 的
        // 特定 node-kind 处理器，因此解析 JSON 文件是浪费 CPU 的空操作。
        // loader.register_static(tree_sitter_json::LANGUAGE.into(), "json", &["json"]);
        loader.register_static(tree_sitter_html::LANGUAGE.into(), "html", &["html","htm"]);
        loader.register_static(tree_sitter_css::LANGUAGE.into(), "css", &["css"]);
        loader.register_static(tree_sitter_yaml::LANGUAGE.into(), "yaml", &["yaml","yml"]);
        loader.register_static(tree_sitter_zig::LANGUAGE.into(), "zig", &["zig"]);
        loader.register_static(tree_sitter_elixir::LANGUAGE.into(), "elixir", &["ex","exs"]);
        loader.register_static(tree_sitter_erlang::LANGUAGE.into(), "erlang", &["erl","hrl"]);
        loader
    });
