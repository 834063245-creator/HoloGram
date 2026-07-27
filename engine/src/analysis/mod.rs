// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

pub mod coupling;
pub mod fragility;
pub mod cycles;
pub mod coupling_report;
pub mod graph_stats;
pub mod dataflow;
pub mod blindspots;
pub mod explore;
pub mod flows;
pub mod framework_routes;
pub mod dynamic_dispatch;
pub mod dynamic_boundaries;
pub mod dynamic_dispatch_react;
pub mod dynamic_dispatch_vue;
pub mod di_reflection;
pub mod policy_check;

pub mod dataflow_synthesis;
pub mod dataflow_engine;

pub use coupling::compute_coupling;
pub use coupling::compute_coupling_incremental;
pub use fragility::fragile_nodes;
pub use fragility::fragile_nodes_from_index;
pub use cycles::detect_cycles;
pub use cycles::detect_cycles_from_index;
pub use coupling_report::coupling_report;
pub use coupling_report::coupling_report_from_index;
pub use coupling_report::count_l4_from_index;
pub use coupling_report::count_l4_by_file;
pub use graph_stats::graph_summary;
pub use graph_stats::graph_summary_from_index;
pub use dataflow::classify_cycles;
pub use dataflow::classify_cycles_from_index;
pub use blindspots::find_blindspots;
pub use explore::explore;
pub use flows::detect_all_flows;
pub use framework_routes::detect_framework_routes;
pub use dynamic_dispatch::synthesize_dynamic_edges;
pub use di_reflection::detect_di_reflection;
pub use di_reflection::detect_dynamic_imports;
pub use di_reflection::detect_eval;
pub use di_reflection::detect_cross_lang_calls;
pub use dataflow_synthesis::synthesize_dataflow_edges;
pub use policy_check::policy_check_from_index;