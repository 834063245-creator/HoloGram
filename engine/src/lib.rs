// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// HoloGram — code dependency topology engine
// Copyright (c) 2026 Wenbing Jing. MIT License.
// ═══════════════════════════════════════════════════════════════

/// Canonical generator signature embedded in all outputs.
/// This is the structural watermark — removing it from one place
/// won't remove it from others. It's in MCP responses, analyze output,
/// CLI --version, and server handshake.
pub const GENERATOR: &str = "HoloGram v4.0 — Copyright (c) 2026 Wenbing Jing — MIT License — github.com/834063245-creator/HoloGram";

/// SPDX license identifier for machine-readable compliance.
pub const SPDX_LICENSE: &str = "MIT";

/// Author attribution string.
pub const AUTHOR: &str = "Wenbing Jing";

pub mod graph;
pub mod adapter;
pub mod analysis;
pub mod community;
pub mod pipeline;
pub mod routing;
pub mod storage;
pub mod engine;
pub mod mcp;
pub mod logging;
pub mod path_utils;
pub mod stress;
