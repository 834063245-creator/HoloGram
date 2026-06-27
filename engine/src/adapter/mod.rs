// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

/// Shared resolved-call type used by all language LSP modules.
#[derive(Debug, Clone)]
pub struct ResolvedCall {
    pub caller_qn: String,
    pub callee_qn: String,
    pub strategy: String,
    pub confidence: f32,
}

pub mod grammar_loader;
pub mod traits;
pub mod python;
pub mod typescript;
pub mod tree_sitter;
pub mod registry;
pub mod types;
pub mod type_registry;
pub mod scope;
pub(crate) mod python_lsp;
pub(crate) mod go_lsp;
pub(crate) mod java_lsp;
pub(crate) mod cs_lsp;
pub(crate) mod ts_lsp;
pub(crate) mod c_lsp;
pub(crate) mod php_lsp;
pub(crate) mod kotlin_lsp;
