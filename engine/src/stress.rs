// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Stress test harness for the HoloGram analysis engine.
//!
//! Synthetic project generation + real project benchmarking.
//! Uses `Engine::analyze()` and reports per-stage timing from `AnalyzeResult.stage_timings`.
//!
//! Usage:
//!   engine --stress small          (500 files, ~8K symbols)
//!   engine --stress medium         (2000 files, ~32K symbols)
//!   engine --stress large          (10000 files, ~160K symbols)
//!   engine --stress xlarge         (50000 files, ~800K symbols)
//!   engine --stress <N>            (N files, auto-scaled)
//!   engine --stress-suite          Run small→medium→large comparison
//!   engine --stress-real <path>    Benchmark a real project (3 iterations)
//!   engine --stress-real <path> <N>  Benchmark N iterations

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rand::prelude::*;
use rand::rngs::StdRng;
use rand::SeedableRng;
use serde_json::json;

use crate::engine::{Engine, StageTiming};

// ═══════════════════════════════════════════════════════════════
// Preset sizes
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy)]
pub enum StressSize {
    Small,
    Medium,
    Large,
    XLarge,
    Custom(usize),
}

impl StressSize {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "small" | "s" => Some(StressSize::Small),
            "medium" | "m" => Some(StressSize::Medium),
            "large" | "l" => Some(StressSize::Large),
            "xlarge" | "xl" => Some(StressSize::XLarge),
            _ => s.parse::<usize>().ok().map(StressSize::Custom),
        }
    }

    pub fn file_count(&self) -> usize {
        match self {
            StressSize::Small => 500,
            StressSize::Medium => 2000,
            StressSize::Large => 10000,
            StressSize::XLarge => 50000,
            StressSize::Custom(n) => *n,
        }
    }

    pub fn label(&self) -> String {
        match self {
            StressSize::Small => "small (500 files)".into(),
            StressSize::Medium => "medium (2000 files)".into(),
            StressSize::Large => "large (10000 files)".into(),
            StressSize::XLarge => "xlarge (50000 files)".into(),
            StressSize::Custom(n) => format!("custom ({} files)", n),
        }
    }

    /// Estimated node count based on file_count and average density.
    pub fn estimated_nodes(&self) -> usize {
        // avg 3.5 classes/file × 5 methods/class + 2 top-level funcs = ~19.5 symbols
        // each symbol → roughly 1 node, plus ~50% extra from builtins/attributes
        (self.file_count() as f64 * 19.5 * 1.5) as usize
    }
}

// ═══════════════════════════════════════════════════════════════
// Synthetic project generator
// ═══════════════════════════════════════════════════════════════

struct ProjectGenerator {
    rng: StdRng,
    file_plan: Vec<(String, usize, usize, usize)>, // (dir, file_idx, class_count, top_func_count)
    class_names: Vec<String>,
    func_names: Vec<String>,
}

impl ProjectGenerator {
    fn new(seed: u64) -> Self {
        Self {
            rng: StdRng::seed_from_u64(seed),
            file_plan: Vec::new(),
            class_names: Vec::new(),
            func_names: Vec::new(),
        }
    }

    fn generate(&mut self, root: &Path, file_count: usize) -> usize {
        let _ = fs::remove_dir_all(root);
        fs::create_dir_all(root).unwrap();

        // More directories for deeper hierarchy at scale
        let dirs = [
            "models", "services", "controllers", "utils", "core", "api",
            "dal", "middleware", "handlers", "schemas",
        ];
        for d in &dirs {
            fs::create_dir_all(root.join(d)).unwrap();
        }

        let files_per_dir = (file_count as f64 / dirs.len() as f64).ceil() as usize;
        let show_progress = file_count >= 1000;

        // Phase 1: plan all files and generate all symbols
        if show_progress { eprint!("  Phase 1 (plan)... "); }
        for dir_idx in 0..dirs.len() {
            let dir = dirs[dir_idx];
            for file_idx in 0..files_per_dir {
                if (dir_idx * files_per_dir + file_idx) >= file_count {
                    break;
                }
                // Density: 3-8 classes per file, 2-3 top-level funcs
                let class_count = self.rng.gen_range(3..=8);
                let top_func_count = self.rng.gen_range(2..=4);
                self.file_plan.push((dir.to_string(), file_idx, class_count, top_func_count));

                for c in 0..class_count {
                    let class_name = format!("{}_{}C{}", dir, file_idx, c);
                    self.class_names.push(class_name);
                    // 3-10 methods per class
                    let method_count = self.rng.gen_range(3..=10);
                    for m in 0..method_count {
                        self.func_names.push(format!(
                            "{}_{}C{}_m{}",
                            dir, file_idx, c, m
                        ));
                    }
                }
                for tf in 0..top_func_count {
                    self.func_names.push(format!("{}_{}_tf{}", dir, file_idx, tf));
                }
            }
        }
        if show_progress { eprintln!("{} symbols", self.func_names.len()); }

        let module_names: Vec<String> = self.file_plan.iter()
            .map(|(d, fi, _, _)| format!("{}.mod_{}", d, fi))
            .collect();

        // Phase 2: write files
        let file_plan = self.file_plan.clone();
        let class_names = self.class_names.clone();
        let func_names = self.func_names.clone();
        let mut symbol_idx = 0;
        let mut class_idx = 0;
        let total = file_plan.len();
        let progress_step = (total / 20).max(1);

        if show_progress { eprint!("  Phase 2 (write)... "); }
        for (fi, (dir, file_idx, class_count, top_func_count)) in file_plan.iter().enumerate() {
            if show_progress && fi % progress_step == 0 {
                eprint!("{:.0}% ", (fi as f64 / total as f64) * 100.0);
            }

            let path = root.join(dir).join(format!("mod_{}.py", file_idx));
            let mut f = fs::File::create(&path).unwrap();

            // Imports — 2-5 cross-module imports for denser call graph
            let import_count = self.rng.gen_range(2..=5);
            let mut imports: Vec<String> = Vec::new();
            for _ in 0..import_count {
                if module_names.len() > 1 {
                    let target = loop {
                        let t = module_names.choose(&mut self.rng).unwrap();
                        let current = format!("{}.mod_{}", dir, file_idx);
                        if *t != current { break t.clone(); }
                    };
                    let parts: Vec<&str> = target.splitn(2, '.').collect();
                    imports.push(format!("from {}.{} import *\n", parts[0], parts[1]));
                }
            }

            for _c in 0..*class_count {
                let class_name = &class_names[class_idx];
                class_idx += 1;

                writeln!(f, "\nclass {}:", class_name).unwrap();
                let attr_count = self.rng.gen_range(2..=5);
                writeln!(f, "    def __init__(self):").unwrap();
                for a in 0..attr_count {
                    writeln!(f, "        self.attr_{} = {}", a, self.rng.gen_range(0..100)).unwrap();
                }

                let method_count = {
                    let cn = &class_names[class_idx - 1];
                    let mut c = 0;
                    for i in symbol_idx..func_names.len() {
                        if func_names[i].starts_with(cn) { c += 1; } else { break; }
                    }
                    c
                };
                for _m in 0..method_count {
                    let func_name = &func_names[symbol_idx];
                    symbol_idx += 1;
                    let param_count = self.rng.gen_range(0..=3);
                    let params: Vec<String> = (0..param_count).map(|i| format!("p{}", i)).collect();
                    writeln!(f, "    def {}(self, {}):", func_name, params.join(", ")).unwrap();
                    for _bl in 0..self.rng.gen_range(3..=10) {
                        writeln!(f, "        {}", self.gen_call_expr(&module_names)).unwrap();
                    }
                    if self.rng.gen_bool(0.7) {
                        writeln!(f, "        {}", self.gen_ret_expr(&module_names)).unwrap();
                    }
                }
            }

            for _tf in 0..*top_func_count {
                let func_name = &func_names[symbol_idx];
                symbol_idx += 1;
                let param_count = self.rng.gen_range(0..=4);
                let params: Vec<String> = (0..param_count).map(|i| format!("p{}", i)).collect();
                writeln!(f, "\ndef {}({}):", func_name, params.join(", ")).unwrap();
                for _bl in 0..self.rng.gen_range(3..=8) {
                    writeln!(f, "    {}", self.gen_call_expr(&module_names)).unwrap();
                }
                if self.rng.gen_bool(0.6) {
                    writeln!(f, "    return {}", self.gen_ret_value()).unwrap();
                }
            }

            // Prepend imports
            let mut content = String::new();
            for imp in &imports { content.push_str(imp); }
            content.push_str(&fs::read_to_string(&path).unwrap());
            fs::write(&path, &content).unwrap();
        }
        if show_progress { eprintln!("done"); }

        self.func_names.len()
    }

    fn gen_call_expr(&mut self, _module_names: &[String]) -> String {
        match self.rng.gen_range(0..=10) {
            0..=2 => {
                if self.class_names.is_empty() { return "pass".into(); }
                let class = self.class_names.choose(&mut self.rng).unwrap();
                format!("{}().do_work()", class.rsplit('_').next().unwrap_or("Unknown"))
            }
            3..=5 => {
                if self.func_names.is_empty() { return "pass".into(); }
                let f = self.func_names.choose(&mut self.rng).unwrap();
                let short = f.rsplit('.').next().unwrap_or(f);
                let arg_count = self.rng.gen_range(0..=2);
                let args: Vec<String> = (0..arg_count).map(|i| format!("v{}", i)).collect();
                format!("{}({})", short, args.join(", "))
            }
            6..=7 => {
                if self.func_names.is_empty() { return "pass".into(); }
                let f = self.func_names.choose(&mut self.rng).unwrap();
                format!("self.{}()", f.rsplit('.').next().unwrap_or(f))
            }
            8 => {
                let builtins = ["len", "str", "int", "list", "dict", "sum", "max", "min", "sorted", "print"];
                format!("{}(x)", builtins.choose(&mut self.rng).unwrap())
            }
            9 => "obj.prop.nested.leaf".into(),
            _ => format!("x{} = {}", self.rng.gen_range(0..10), self.rng.gen_range(0..100)),
        }
    }

    fn gen_ret_expr(&mut self, _module_names: &[String]) -> String {
        match self.rng.gen_range(0..=4) {
            0 => self.gen_ret_value(),
            1 => {
                if self.func_names.is_empty() { return "None".into(); }
                let f = self.func_names.choose(&mut self.rng).unwrap();
                format!("{}(p0)", f.rsplit('.').next().unwrap_or(f))
            }
            2 => "True".into(),
            3 => "False".into(),
            _ => "None".into(),
        }
    }

    fn gen_ret_value(&mut self) -> String {
        format!("{}", self.rng.gen_range(0..1000))
    }
}

// ═══════════════════════════════════════════════════════════════
// Memory tracking
// ═══════════════════════════════════════════════════════════════

fn get_rss_mb() -> f64 {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("powershell")
            .args(["-NoProfile", "-Command", "(Get-Process -Id $pid).WorkingSet64 / 1MB"])
            .output()
        {
            if let Ok(s) = String::from_utf8(output.stdout) {
                return s.trim().parse().unwrap_or(0.0);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if line.starts_with("VmRSS:") {
                    return line.split_whitespace().nth(1)
                        .and_then(|s| s.parse::<f64>().ok())
                        .unwrap_or(0.0) / 1024.0;
                }
            }
        }
    }
    0.0
}

// ═══════════════════════════════════════════════════════════════
// Report
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
pub struct StressReport {
    pub label: String,
    pub file_count: usize,
    pub symbol_count: usize,
    pub stages: Vec<StageTiming>,
    pub total_secs: f64,
    pub peak_rss_mb: f64,
    pub node_count: usize,
    pub edge_count: usize,
    pub community_count: usize,
    /// Number of iterations (1 for synthetic, N for real-project benchmarking)
    pub iterations: usize,
}

impl StressReport {
    fn print(&self) {
        println!();
        println!("╔══════════════════════════════════════════════════════════════════════╗");
        println!("║  HOLOGRAM STRESS TEST — {:<47}║", self.label);
        println!("╠══════════════════════════════════════════════════════════════════════╣");
        if self.symbol_count > 0 {
            println!("║  Files: {:>6}   Symbols: {:>6}   Iterations: {:>3}                     ║",
                self.file_count, self.symbol_count, self.iterations);
        } else {
            println!("║  Files: {:>6}   Iterations: {:>3}                                      ║",
                self.file_count, self.iterations);
        }
        println!("╠══════════════════════════════════════════════════════════════════════╣");
        println!("║  {:30}  {:>8}  {:>6}  {:>16}║", "Stage", "Time", "%", "Detail");
        println!("╠══════════════════════════════════════════════════════════════════════╣");

        let total = self.total_secs.max(0.001);
        for stage in &self.stages {
            let pct = (stage.elapsed_secs / total) * 100.0;
            let bar = "█".repeat(((pct / 2.5) as usize).min(20));
            println!("║  {:30}  {:>7.2}s  {:>5.1}%  {} {:<16}║",
                stage.name, stage.elapsed_secs, pct, bar, stage.detail);
        }

        println!("╠══════════════════════════════════════════════════════════════════════╣");
        println!("║  {:30}  {:>7.2}s  {:>5.1}%                                        ║",
            "TOTAL", total, 100.0);
        println!("╠══════════════════════════════════════════════════════════════════════╣");
        println!("║  Nodes: {:>6}  Edges: {:>6}  Communities: {:>4}  RSS: {:>7.1} MB       ║",
            self.node_count, self.edge_count, self.community_count, self.peak_rss_mb);

        // Throughput
        if total > 0.0 && self.node_count > 0 {
            println!("║  Throughput: {:>6.0} nodes/s  {:>6.0} edges/s  {:>6.1} files/s           ║",
                self.node_count as f64 / total,
                self.edge_count as f64 / total,
                self.file_count as f64 / total);
        }
        println!("╚══════════════════════════════════════════════════════════════════════╝");
        println!();
    }

    pub fn to_json(&self) -> serde_json::Value {
        let stages: Vec<serde_json::Value> = self.stages.iter().map(|s| {
            json!({ "name": s.name, "elapsed_secs": s.elapsed_secs, "detail": s.detail })
        }).collect();
        json!({
            "label": self.label,
            "file_count": self.file_count,
            "symbol_count": self.symbol_count,
            "stages": stages,
            "total_secs": self.total_secs,
            "peak_rss_mb": self.peak_rss_mb,
            "node_count": self.node_count,
            "edge_count": self.edge_count,
            "community_count": self.community_count,
            "iterations": self.iterations,
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// Synthetic stress runner
// ═══════════════════════════════════════════════════════════════

pub fn run_stress(size: StressSize) -> StressReport {
    let file_count = size.file_count();
    let label = size.label();

    let base = std::env::temp_dir().join("hologram_stress");
    let root = base.join(format!("proj_{}", file_count));

    eprintln!("══ HoloGram Stress: {} ══", label);
    eprintln!("Estimated: ~{} nodes, {} files", size.estimated_nodes(), file_count);

    eprint!("Generating {} files... ", file_count);
    let gen_start = Instant::now();
    let mut generator = ProjectGenerator::new(42);
    let symbol_count = generator.generate(&root, file_count);
    eprintln!("done in {:.1}s ({} symbols)", gen_start.elapsed().as_secs_f64(), symbol_count);

    let mut engine = Engine::new();
    engine.init(&root).expect("engine init failed");

    let result = engine.analyze(&root).expect("analysis failed");
    let peak_rss = get_rss_mb();

    let report = StressReport {
        label,
        file_count,
        symbol_count,
        stages: result.stage_timings,
        total_secs: result.elapsed_secs,
        peak_rss_mb: peak_rss,
        node_count: result.node_count,
        edge_count: result.edge_count,
        community_count: result.community_count,
        iterations: 1,
    };

    report.print();
    report
}

// ═══════════════════════════════════════════════════════════════
// Real project benchmark
// ═══════════════════════════════════════════════════════════════

/// Benchmark a real project. Runs `Engine::analyze()` N times and reports
/// per-stage min/mean/max + throughput statistics.
pub fn run_stress_real(project_path: &Path, iterations: usize) -> StressReport {
    let root = project_path.to_path_buf();
    let file_count = count_source_files(&root);

    eprintln!("══ HoloGram Real-Project Benchmark ══");
    eprintln!("Project: {}", root.display());
    eprintln!("Source files: {}  |  Iterations: {}", file_count, iterations);
    eprintln!();

    // Collect per-stage timings across all iterations
    let mut all_stage_names: Vec<String> = Vec::new();
    let mut all_timings: Vec<Vec<f64>> = Vec::new(); // [iteration][stage]
    let mut all_totals: Vec<f64> = Vec::new();
    let mut node_count = 0;
    let mut edge_count = 0;
    let mut community_count = 0;
    let mut peak_rss = 0.0_f64;

    for i in 0..iterations {
        let mut engine = Engine::new();
        engine.init(&root).expect("engine init failed");

        let iter_start = Instant::now();
        let result = engine.analyze(&root).expect("analysis failed");
        let iter_elapsed = iter_start.elapsed().as_secs_f64();

        // Collect stage timings
        if all_stage_names.is_empty() {
            all_stage_names = result.stage_timings.iter().map(|s| s.name.clone()).collect();
        }

        let mut stage_times: Vec<f64> = Vec::with_capacity(result.stage_timings.len());
        for s in &result.stage_timings {
            stage_times.push(s.elapsed_secs);
        }
        all_timings.push(stage_times);
        all_totals.push(iter_elapsed);

        node_count = result.node_count;
        edge_count = result.edge_count;
        community_count = result.community_count;

        let rss = get_rss_mb();
        if rss > peak_rss { peak_rss = rss; }

        eprintln!("  iter {}/{}:  {:.2}s  ({} nodes, {} edges, {} communities)  RSS: {:.0} MB",
            i + 1, iterations, iter_elapsed, node_count, edge_count, community_count, rss);
    }

    // Compute min/mean/max per stage
    let stage_count = all_stage_names.len();
    let mut summary_stages: Vec<StageTiming> = Vec::with_capacity(stage_count);

    for si in 0..stage_count {
        let mut times: Vec<f64> = all_timings.iter().map(|t| t[si]).collect();
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let min_t = times.first().copied().unwrap_or(0.0);
        let max_t = times.last().copied().unwrap_or(0.0);
        let mean_t = times.iter().sum::<f64>() / times.len() as f64;

        // Report mean, with detail showing range if variance > 5%
        let range_pct = if mean_t > 0.0 { (max_t - min_t) / mean_t * 100.0 } else { 0.0 };
        let detail = if iterations > 1 && range_pct > 5.0 {
            format!("mean={:.2}s  min={:.2}s  max={:.2}s", mean_t, min_t, max_t)
        } else {
            String::new()
        };

        summary_stages.push(StageTiming {
            name: all_stage_names[si].clone(),
            elapsed_secs: mean_t,
            detail,
        });
    }

    // Total: use mean
    let mean_total = all_totals.iter().sum::<f64>() / all_totals.len() as f64;

    let label = format!("{} ({})", root.file_name().unwrap_or_default().to_string_lossy(), root.display());

    let report = StressReport {
        label,
        file_count,
        symbol_count: 0, // unknown for real projects
        stages: summary_stages,
        total_secs: mean_total,
        peak_rss_mb: peak_rss,
        node_count,
        edge_count,
        community_count,
        iterations,
    };

    println!();
    report.print();

    // Print stability note
    if iterations > 1 {
        let mut sorted_totals = all_totals.clone();
        sorted_totals.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let min_t = sorted_totals.first().copied().unwrap_or(0.0);
        let max_t = sorted_totals.last().copied().unwrap_or(0.0);
        let range_pct = if mean_total > 0.0 { (max_t - min_t) / mean_total * 100.0 } else { 0.0 };
        println!("Stability: total time {:.2}s–{:.2}s, range {:.1}% of mean",
            min_t, max_t, range_pct);
        println!();
    }

    report
}

/// Count source files in a project directory.
fn count_source_files(root: &Path) -> usize {
    let exts = ["py","pyi","pyx","js","jsx","ts","tsx","mjs","cjs","mts","cts",
        "go","rs","java","c","h","cpp","hpp","cc","hh","cxx","hxx","rb","lua",
        "cs","swift","dart","scala","sc","hs","html","htm","css"];
    let mut count = 0;
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_str().unwrap_or("");
            !matches!(name, ".git" | ".hologram" | "node_modules" | "__pycache__"
                | "target" | ".venv" | "venv" | "dist" | "build" | ".next" | ".nuxt")
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() { continue; }
        if let Some(ext) = entry.path().extension() {
            if exts.contains(&ext.to_str().unwrap_or("")) {
                count += 1;
            }
        }
    }
    count
}

// ═══════════════════════════════════════════════════════════════
// Suite runner
// ═══════════════════════════════════════════════════════════════

pub fn run_stress_suite() {
    let sizes = [StressSize::Small, StressSize::Medium, StressSize::Large];
    let mut reports: Vec<StressReport> = Vec::new();

    for (i, size) in sizes.iter().enumerate() {
        if i > 0 {
            let prev = std::env::temp_dir()
                .join("hologram_stress")
                .join(format!("proj_{}", sizes[i - 1].file_count()));
            let _ = fs::remove_dir_all(&prev);
        }
        reports.push(run_stress(*size));
    }

    // Comparison table
    println!();
    println!("╔══════════════╦═════════╦══════════╦══════════╦══════════╦══════════╦════════╗");
    println!("║ Size         ║  Files  ║  Symbols ║  Nodes   ║  Edges   ║   Time   ║  RSS   ║");
    println!("╠══════════════╬═════════╬══════════╬══════════╬══════════╬══════════╬════════╣");
    for r in &reports {
        println!("║ {:12} ║ {:>6}  ║ {:>7}  ║ {:>7}  ║ {:>7}  ║ {:>6.1}s  ║ {:>5.0}M  ║",
            r.label.split('(').next().unwrap_or(&r.label).trim(),
            r.file_count, r.symbol_count, r.node_count, r.edge_count,
            r.total_secs, r.peak_rss_mb);
    }
    println!("╚══════════════╩═════════╩══════════╩══════════╩══════════╩══════════╩════════╝");

    // Scaling
    if reports.len() >= 2 {
        let first = &reports[0];
        let last = &reports[reports.len() - 1];
        let file_ratio = last.file_count as f64 / first.file_count.max(1) as f64;
        let time_ratio = last.total_secs / first.total_secs.max(0.001);
        let node_ratio = last.node_count as f64 / first.node_count.max(1) as f64;
        println!();
        println!("Scaling ({} → {}):",
            first.label.split('(').next().unwrap_or(""),
            last.label.split('(').next().unwrap_or(""));
        println!("  Files: {:>4.0}x   Time: {:>5.1}x   Efficiency: {:>5.0}%",
            file_ratio, time_ratio, (file_ratio / time_ratio.max(0.001)) * 100.0);
        println!("  Nodes: {:>4.0}x   Time/node: {:.2}ms → {:.2}ms",
            node_ratio,
            (first.total_secs * 1000.0) / first.node_count.max(1) as f64,
            (last.total_secs * 1000.0) / last.node_count.max(1) as f64);
    }
    println!();
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stress_size_parsing() {
        assert!(matches!(StressSize::from_str("small"), Some(StressSize::Small)));
        assert!(matches!(StressSize::from_str("MEDIUM"), Some(StressSize::Medium)));
        assert!(matches!(StressSize::from_str("500"), Some(StressSize::Custom(500))));
        assert!(StressSize::from_str("nonsense").is_none());
    }

    #[test]
    fn test_generator_small() {
        let base = std::env::temp_dir().join("hologram_test_stress_gen");
        let root = base.join("gen_small");
        let _ = fs::remove_dir_all(&base);

        let mut gen = ProjectGenerator::new(42);
        let symbols = gen.generate(&root, 10);
        assert!(symbols > 0, "should generate at least 1 symbol");
        assert!(root.join("models").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn test_stress_small_pipeline() {
        let report = run_stress(StressSize::Custom(5));
        assert!(report.node_count > 0, "should produce nodes: {:?}", report.node_count);
        assert!(report.total_secs < 10.0, "5 files should finish quickly");
        // Must have per-stage timings
        assert!(!report.stages.is_empty(), "should have stage timings");
        let stage_names: Vec<&str> = report.stages.iter().map(|s| s.name.as_str()).collect();
        assert!(stage_names.contains(&"Core Parse"), "should have Core Parse stage, got: {:?}", stage_names);
        assert!(stage_names.contains(&"Community (Leiden)"), "should have Community (Leiden) stage");
    }

    #[test]
    fn test_report_json() {
        let report = StressReport {
            label: "test".into(),
            file_count: 10,
            symbol_count: 50,
            stages: vec![StageTiming { name: "parse".into(), elapsed_secs: 1.0, detail: "ok".into() }],
            total_secs: 1.0,
            peak_rss_mb: 100.0,
            node_count: 20,
            edge_count: 30,
            community_count: 2,
            iterations: 1,
        };
        let json = report.to_json();
        assert_eq!(json["label"], "test");
        assert_eq!(json["stages"][0]["name"], "parse");
    }

    #[test]
    fn test_count_source_files() {
        let tmp = std::env::temp_dir().join("hologram_test_count");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src")).unwrap();
        fs::write(tmp.join("src").join("main.py"), "x=1").unwrap();
        fs::write(tmp.join("src").join("util.py"), "y=2").unwrap();
        fs::write(tmp.join("README.md"), "doc").unwrap();

        let count = count_source_files(&tmp);
        assert_eq!(count, 2, "should count 2 .py files");

        let _ = fs::remove_dir_all(&tmp);
    }
}
