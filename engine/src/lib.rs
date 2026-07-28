// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # HoloGram — 代码依赖拓扑分析引擎库
//!
//! 本 crate 是 HoloGram 引擎的核心库，提供代码依赖图的构建、分析和查询能力。
//! 被二进制入口 `main.rs`（TCP/MCP/CLI/压力测试）和集成测试共同依赖。

// ═══════════════════════════════════════════════════════════════
// HoloGram — 代码依赖拓扑分析引擎
// Copyright (c) 2026 Wenbing Jing. MIT License.
// ═══════════════════════════════════════════════════════════════

/// 所有输出中嵌入的规范生成器签名。
///
/// 这是结构性水印——从一处移除不会影响其他地方。
/// 它出现在 MCP 响应、分析输出、CLI --version 和服务器握手中。
pub const GENERATOR: &str = "HoloGram v4.0 — Copyright (c) 2026 Wenbing Jing — MIT License — github.com/834063245-creator/HoloGram";

/// SPDX 许可证标识符，用于机器可读的合规性检查。
pub const SPDX_LICENSE: &str = "MIT";

/// 作者署名字符串。
pub const AUTHOR: &str = "Wenbing Jing";

// ── 模块声明 ──
// 每个模块对应 src/ 下的一个子目录或同名文件

pub mod graph;       // 依赖图数据结构（节点、边、查询）
pub mod adapter;    // 语言适配器（Python/JS/Go/Rust/Java 等解析器）
pub mod analysis;    // 分析算法（环检测、脆弱节点、耦合报告、盲点）
pub mod community;   // 社区检测（Louvain/Leiden + 层级社区）
pub mod pipeline;   // 解析管线（源码 → AST → 符号 → 边 → 图合并）
pub mod routing;    // 路由与预检（提交前约束检查、影响评估）
pub mod storage;    // 存储层（GraphStore + SQLite 持久化）
pub mod engine;     // 引擎核心（Engine 结构体、全局状态、分析入口）
pub mod tools;      // MCP 工具注册表（30+ hologram_* 工具）
pub mod mcp;        // MCP JSON-RPC 服务器（stdio 通信）
pub mod logging;    // 结构化日志（tracing + NDJSON 文件输出）
pub mod path_utils;  // 路径规范化工具
pub mod stress;      // 压力测试与基准评估
pub mod lsp_manager; // LSP 服务器池管理（多语言调用解析）
pub mod vector;      // 向量检索（语义搜索）
