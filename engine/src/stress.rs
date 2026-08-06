// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # HoloGram 压力测试框架
//!
//! 合成项目生成 + 真实项目基准评估。
//! 使用 `Engine::analyze()` 执行分析，从 `AnalyzeResult.stage_timings` 获取每阶段耗时。
//!
//! ## 用法
//! ```text
//! engine --stress small          (500 文件, ~8K 符号)
//! engine --stress medium         (2000 文件, ~32K 符号)
//! engine --stress large          (10000 文件, ~160K 符号)
//! engine --stress xlarge         (50000 文件, ~800K 符号)
//! engine --stress <N>            (N 个文件, 自动缩放)
//! engine --stress-suite          运行 small→medium→large 对比
//! engine --stress-real <path>    对真实项目基准测试（3 轮）
//! engine --stress-real <path> <N>  N 轮基准测试
//! engine --stress-full <path> <N>  完整管线: 结构 + Dataflow + LSP
//! ```

use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

use rand::prelude::*;
use rand::rngs::StdRng;
use rand::SeedableRng;
use serde_json::json;

use crate::engine::{Engine, StageTiming};

// ═══════════════════════════════════════════════════════════════
// 预设规模
// ═══════════════════════════════════════════════════════════════

/// 压力测试规模预设。
///
/// 对应不同的合成项目规模，从 Small（500 文件）到 XLarge（50000 文件）。
/// Custom 允许指定任意文件数。
#[derive(Debug, Clone, Copy)]
pub enum StressSize {
    Small,
    Medium,
    Large,
    XLarge,
    Custom(usize),
}

impl StressSize {
    /// 从字符串解析规模。
    ///
    /// 支持 "small"/"s"、"medium"/"m"、"large"/"l"、"xlarge"/"xl" 和数字。
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "small" | "s" => Some(StressSize::Small),
            "medium" | "m" => Some(StressSize::Medium),
            "large" | "l" => Some(StressSize::Large),
            "xlarge" | "xl" => Some(StressSize::XLarge),
            _ => s.parse::<usize>().ok().map(StressSize::Custom),
        }
    }

    /// 返回对应的文件数量。
    pub fn file_count(&self) -> usize {
        match self {
            StressSize::Small => 500,
            StressSize::Medium => 2000,
            StressSize::Large => 10000,
            StressSize::XLarge => 50000,
            StressSize::Custom(n) => *n,
        }
    }

    /// 返回可读的规模标签。
    pub fn label(&self) -> String {
        match self {
            StressSize::Small => "small (500 files)".into(),
            StressSize::Medium => "medium (2000 files)".into(),
            StressSize::Large => "large (10000 files)".into(),
            StressSize::XLarge => "xlarge (50000 files)".into(),
            StressSize::Custom(n) => format!("custom ({} files)", n),
        }
    }

    /// 根据文件数量估算节点数。
    ///
    /// 平均每文件 3.5 个类 × 5 个方法 + 2 个顶层函数 ≈ 19.5 个符号，
    /// 每个符号约 1 个节点，加上 ~50% 的内置/属性节点。
    pub fn estimated_nodes(&self) -> usize {
        (self.file_count() as f64 * 19.5 * 1.5) as usize
    }
}

// ═══════════════════════════════════════════════════════════════
// 合成项目生成器
// ═══════════════════════════════════════════════════════════════

/// 合成 Python 项目生成器。
///
/// 生成具有真实结构的 Python 代码：类、方法、跨模块导入和调用，
/// 用于压力测试引擎的解析和图构建性能。
struct ProjectGenerator {
    rng: StdRng,
    /// 文件计划：(目录名, 文件序号, 类数量, 顶层函数数量)
    file_plan: Vec<(String, usize, usize, usize)>,
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

    /// 生成合成项目。
    ///
    /// 流程分两阶段：
    /// 1. 规划所有文件和符号（确定类名/方法名/函数名）
    /// 2. 写入文件（生成 import、类定义、方法体、函数体）
    ///
    /// 返回生成的符号总数。
    fn generate(&mut self, root: &Path, file_count: usize) -> usize {
        let _ = fs::remove_dir_all(root);
        fs::create_dir_all(root).unwrap();

        // 规模越大，目录层级越深
        let dirs = [
            "models", "services", "controllers", "utils", "core", "api",
            "dal", "middleware", "handlers", "schemas",
        ];
        for d in &dirs {
            fs::create_dir_all(root.join(d)).unwrap();
        }

        let files_per_dir = (file_count as f64 / dirs.len() as f64).ceil() as usize;
        let show_progress = file_count >= 1000;

        // 阶段 1：规划所有文件并生成所有符号名
        if show_progress { eprint!("  Phase 1 (plan)... "); }
        for dir_idx in 0..dirs.len() {
            let dir = dirs[dir_idx];
            for file_idx in 0..files_per_dir {
                if (dir_idx * files_per_dir + file_idx) >= file_count {
                    break;
                }
                // 密度：每文件 3-8 个类，2-3 个顶层函数
                let class_count = self.rng.gen_range(3..=8);
                let top_func_count = self.rng.gen_range(2..=4);
                self.file_plan.push((dir.to_string(), file_idx, class_count, top_func_count));

                for c in 0..class_count {
                    let class_name = format!("{}_{}C{}", dir, file_idx, c);
                    self.class_names.push(class_name);
                    // 每类 3-10 个方法
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

        // 阶段 2：写入文件
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

            // 导入——2-5 个跨模块导入，制造更密集的调用图
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
                // 2-5 个实例属性
                let attr_count = self.rng.gen_range(2..=5);
                writeln!(f, "    def __init__(self):").unwrap();
                for a in 0..attr_count {
                    writeln!(f, "        self.attr_{} = {}", a, self.rng.gen_range(0..100)).unwrap();
                }

                // 计算此类的方法数（从 func_names 中连续匹配）
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
                    // 0-3 个参数
                    let param_count = self.rng.gen_range(0..=3);
                    let params: Vec<String> = (0..param_count).map(|i| format!("p{}", i)).collect();
                    writeln!(f, "    def {}(self, {}):", func_name, params.join(", ")).unwrap();
                    // 3-10 行方法体（调用表达式）
                    for _bl in 0..self.rng.gen_range(3..=10) {
                        writeln!(f, "        {}", self.gen_call_expr(&module_names)).unwrap();
                    }
                    // 70% 概率有返回语句
                    if self.rng.gen_bool(0.7) {
                        writeln!(f, "        {}", self.gen_ret_expr(&module_names)).unwrap();
                    }
                }
            }

            // 顶层函数
            for _tf in 0..*top_func_count {
                let func_name = &func_names[symbol_idx];
                symbol_idx += 1;
                let param_count = self.rng.gen_range(0..=4);
                let params: Vec<String> = (0..param_count).map(|i| format!("p{}", i)).collect();
                writeln!(f, "\ndef {}({}):", func_name, params.join(", ")).unwrap();
                for _bl in 0..self.rng.gen_range(3..=8) {
                    writeln!(f, "    {}", self.gen_call_expr(&module_names)).unwrap();
                }
                // 60% 概率有返回值
                if self.rng.gen_bool(0.6) {
                    writeln!(f, "    return {}", self.gen_ret_value()).unwrap();
                }
            }

            // 将导入语句前置到文件开头
            let mut content = String::new();
            for imp in &imports { content.push_str(imp); }
            content.push_str(&fs::read_to_string(&path).unwrap());
            fs::write(&path, &content).unwrap();
        }
        if show_progress { eprintln!("done"); }

        self.func_names.len()
    }

    /// 生成随机的调用表达式。
    ///
    /// 模式分布：类实例化调用(30%)、函数调用(30%)、方法调用(20%)、
    /// 内置函数(10%)、属性链(10%)、赋值语句(10%)。
    fn gen_call_expr(&mut self, _module_names: &[String]) -> String {
        match self.rng.gen_range(0..=10) {
            0..=2 => {
                // 类实例化调用
                if self.class_names.is_empty() { return "pass".into(); }
                let class = self.class_names.choose(&mut self.rng).unwrap();
                format!("{}().do_work()", class.rsplit('_').next().unwrap_or("Unknown"))
            }
            3..=5 => {
                // 函数调用
                if self.func_names.is_empty() { return "pass".into(); }
                let f = self.func_names.choose(&mut self.rng).unwrap();
                let short = f.rsplit('.').next().unwrap_or(f);
                let arg_count = self.rng.gen_range(0..=2);
                let args: Vec<String> = (0..arg_count).map(|i| format!("v{}", i)).collect();
                format!("{}({})", short, args.join(", "))
            }
            6..=7 => {
                // self 方法调用
                if self.func_names.is_empty() { return "pass".into(); }
                let f = self.func_names.choose(&mut self.rng).unwrap();
                format!("self.{}()", f.rsplit('.').next().unwrap_or(f))
            }
            8 => {
                // 内置函数调用
                let builtins = ["len", "str", "int", "list", "dict", "sum", "max", "min", "sorted", "print"];
                format!("{}(x)", builtins.choose(&mut self.rng).unwrap())
            }
            9 => "obj.prop.nested.leaf".into(), // 属性链
            _ => format!("x{} = {}", self.rng.gen_range(0..10), self.rng.gen_range(0..100)), // 赋值
        }
    }

    /// 生成随机的返回表达式。
    fn gen_ret_expr(&mut self, _module_names: &[String]) -> String {
        match self.rng.gen_range(0..=4) {
            0 => self.gen_ret_value(),           // 随机数值
            1 => {
                // 函数调用
                if self.func_names.is_empty() { return "None".into(); }
                let f = self.func_names.choose(&mut self.rng).unwrap();
                format!("{}(p0)", f.rsplit('.').next().unwrap_or(f))
            }
            2 => "True".into(),
            3 => "False".into(),
            _ => "None".into(),
        }
    }

    /// 生成随机的返回值（0-999 的数字）。
    fn gen_ret_value(&mut self) -> String {
        format!("{}", self.rng.gen_range(0..1000))
    }
}

// ═══════════════════════════════════════════════════════════════
// 内存跟踪
// ═══════════════════════════════════════════════════════════════

/// 获取当前进程的 RSS（物理内存占用），单位 MB。
///
/// Windows 使用 PowerShell，Linux 读取 /proc/self/status。
fn get_rss_mb() -> f64 {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // 注意:必须显式传本进程 PID —— 直接在被 spawn 的 PowerShell 里用 $pid
        // 会测到 PowerShell 自己(之前报告恒为 ~60MB 的原因)
        let self_pid = std::process::id();
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-Command", &format!("(Get-Process -Id {}).WorkingSet64 / 1MB", self_pid)]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        if let Ok(output) = c.output()
        {
            if let Ok(s) = String::from_utf8(output.stdout) {
                return s.trim().parse().unwrap_or(0.0);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Linux: 从 /proc/self/status 读取 VmRSS
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if line.starts_with("VmRSS:") {
                    return line.split_whitespace().nth(1)
                        .and_then(|s| s.parse::<f64>().ok())
                        .unwrap_or(0.0) / 1024.0; // KB → MB
                }
            }
        }
    }
    0.0
}

// ═══════════════════════════════════════════════════════════════
// 报告
// ═══════════════════════════════════════════════════════════════

/// 压力测试报告。
///
/// 包含每阶段耗时、图统计（节点/边/社区数）、峰值内存等信息。
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
    /// 迭代次数（合成测试为 1，真实项目基准测试为 N）
    pub iterations: usize,
}

impl StressReport {
    /// 以表格形式打印报告到终端。
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
            // 进度条：每个 █ 代表 2.5%
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

        // 吞吐量统计
        if total > 0.0 && self.node_count > 0 {
            println!("║  Throughput: {:>6.0} nodes/s  {:>6.0} edges/s  {:>6.1} files/s           ║",
                self.node_count as f64 / total,
                self.edge_count as f64 / total,
                self.file_count as f64 / total);
        }
        println!("╚══════════════════════════════════════════════════════════════════════╝");
        println!();
    }

    /// 将报告序列化为 JSON。
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
// 合成压力测试运行器
// ═══════════════════════════════════════════════════════════════

/// 运行合成项目压力测试。
///
/// 流程：生成合成 Python 项目 → 初始化引擎 → 执行分析 → 收集报告。
pub fn run_stress(size: StressSize) -> StressReport {
    let file_count = size.file_count();
    let label = size.label();

    let base = std::env::temp_dir().join("hologram_stress");
    let root = base.join(format!("proj_{}", file_count));

    eprintln!("══ HoloGram Stress: {} ══", label);
    eprintln!("Estimated: ~{} nodes, {} files", size.estimated_nodes(), file_count);

    // 生成合成项目
    eprint!("Generating {} files... ", file_count);
    let gen_start = Instant::now();
    let mut generator = ProjectGenerator::new(42);
    let symbol_count = generator.generate(&root, file_count);
    eprintln!("done in {:.1}s ({} symbols)", gen_start.elapsed().as_secs_f64(), symbol_count);

    // 初始化引擎并执行分析
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
// 真实项目基准测试
// ═══════════════════════════════════════════════════════════════

/// 对真实项目进行基准测试。
///
/// 运行 `Engine::analyze()` N 次，报告每阶段的 min/mean/max + 吞吐量统计。
pub fn run_stress_real(project_path: &Path, iterations: usize) -> StressReport {
    let root = project_path.to_path_buf();
    let file_count = count_source_files(&root);

    eprintln!("══ HoloGram Real-Project Benchmark ══");
    eprintln!("Project: {}", root.display());
    eprintln!("Source files: {}  |  Iterations: {}", file_count, iterations);
    eprintln!();

    // 收集所有迭代的每阶段耗时
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

        // 收集阶段耗时
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

    // 计算每阶段的 min/mean/max
    let stage_count = all_stage_names.len();
    let mut summary_stages: Vec<StageTiming> = Vec::with_capacity(stage_count);

    for si in 0..stage_count {
        let mut times: Vec<f64> = all_timings.iter().map(|t| t[si]).collect();
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let min_t = times.first().copied().unwrap_or(0.0);
        let max_t = times.last().copied().unwrap_or(0.0);
        let mean_t = times.iter().sum::<f64>() / times.len() as f64;

        // 报告均值，方差 > 5% 时在 detail 中显示范围
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

    // 总耗时取均值
    let mean_total = all_totals.iter().sum::<f64>() / all_totals.len() as f64;

    let label = format!("{} ({})", root.file_name().unwrap_or_default().to_string_lossy(), root.display());

    let report = StressReport {
        label,
        file_count,
        symbol_count: 0, // 真实项目符号数未知
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

    // 打印稳定性报告
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

/// 统计项目目录中的源代码文件数量。
///
/// 过滤掉 .git、node_modules、__pycache__、target 等目录，
/// 仅统计 37 种支持的源代码扩展名。
fn count_source_files(root: &Path) -> usize {
    // 与 runner 同口径：复用 discover_files（.gitignore 规则 + 5MB 阈值 + 统一扩展名集），
    // 避免双口径偏差（旧实现不处理 .gitignore，实测与 runner 差 5306 文件）。
    collect_source_files(root).len()
}

/// 收集项目目录中所有源代码文件路径。
///
/// 过滤规则与 count_source_files 相同（同为 discover_files 口径）。
fn collect_source_files(root: &Path) -> Vec<std::path::PathBuf> {
    let exts: Vec<String> = crate::engine::GRAMMAR_LOADER.supported_extensions();
    let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    crate::pipeline::discovery::discover_files(root, &ext_refs)
}

// ═══════════════════════════════════════════════════════════════
// 完整管线基准测试：结构 + Dataflow + LSP
// ═══════════════════════════════════════════════════════════════

/// 完整管线基准测试：结构分析（Engine::analyze）
/// + Dataflow 分析（query_dataflow_files）+ LSP 预热（warm_blocking）。
///
/// 每轮迭代依次执行三个阶段，收集每阶段耗时并汇总统计。
pub fn run_stress_full(project_path: &Path, iterations: usize, ext_filter: &[&str]) -> StressReport {
    let root = project_path.to_path_buf();
    let file_count = count_source_files(&root);

    eprintln!("══ HoloGram Full-Pipeline Benchmark ══");
    eprintln!("Project: {}", root.display());
    eprintln!("Source files: {}  |  Iterations: {}", file_count, iterations);
    eprintln!("Pipeline: Structure + Dataflow + LSP warm");
    eprintln!();

    // 预先收集源文件列表（walkdir 很快，不计时）
    let source_files = collect_source_files(&root);
    eprintln!("Collected {} source files for dataflow", source_files.len());

    // 额外阶段名称（在结构分析阶段之后）
    let all_extra_names: [&str; 2] = ["Dataflow", "LSP Warm"];

    let mut all_stage_names: Vec<String> = Vec::new();
    let mut all_timings: Vec<Vec<f64>> = Vec::new();
    let mut all_totals: Vec<f64> = Vec::new();
    let mut node_count = 0;
    let mut edge_count = 0;
    let mut community_count = 0;
    let mut peak_rss = 0.0_f64;

    for i in 0..iterations {
        let iter_start = Instant::now();
        let mut engine = Engine::new();
        engine.init(&root).expect("engine init failed");

        // 阶段 1：结构分析管线
        let result = engine.analyze(&root).expect("analysis failed");
        let struct_elapsed = iter_start.elapsed().as_secs_f64();

        // 阶段 2：Dataflow 分析
        let df_start = Instant::now();
        let df_results = crate::analysis::dataflow_engine::query_dataflow_files(&source_files);
        let df_scopes: usize = df_results.iter()
            .filter_map(|r| r.result.as_ref().ok())
            .map(|df| df.scopes.len()).sum();
        let df_shared: usize = df_results.iter()
            .filter_map(|r| r.result.as_ref().ok())
            .map(|df| df.shared.len()).sum();
        let df_success = df_results.iter().filter(|r| r.result.is_ok()).count();
        let df_elapsed = df_start.elapsed().as_secs_f64();

        // 阶段 3：LSP 预热
        let lsp_start = Instant::now();
        let (lsp_started, lsp_failed) = if ext_filter.is_empty() {
            crate::lsp_manager::LspManager::warm_blocking(&root.to_string_lossy())
        } else {
            crate::lsp_manager::LspManager::warm_blocking_filtered(&root.to_string_lossy(), ext_filter)
        };
        let lsp_elapsed = lsp_start.elapsed().as_secs_f64();

        let iter_elapsed = iter_start.elapsed().as_secs_f64();

        // 构建阶段耗时列表
        if all_stage_names.is_empty() {
            // 首轮：复制结构分析阶段名，追加额外阶段
            all_stage_names = result.stage_timings.iter().map(|s| s.name.clone()).collect();
            all_stage_names.extend(all_extra_names.iter().map(|s| s.to_string()));
        }

        let mut stage_times: Vec<f64> = Vec::with_capacity(all_stage_names.len());
        // 结构分析阶段
        for s in &result.stage_timings {
            stage_times.push(s.elapsed_secs);
        }
        // 额外阶段：Dataflow + LSP
        stage_times.push(df_elapsed);
        stage_times.push(lsp_elapsed);

        all_timings.push(stage_times);
        all_totals.push(iter_elapsed);

        node_count = result.node_count;
        edge_count = result.edge_count;
        community_count = result.community_count;

        let rss = get_rss_mb();
        if rss > peak_rss { peak_rss = rss; }

        eprintln!(
            "  iter {}/{}:  struct {:.2}s + df {:.2}s ({} scopes, {} shared, {}/{} files) + lsp {:.2}s ({} ok, {} fail)  = {:.2}s total  RSS: {:.0} MB",
            i + 1, iterations,
            struct_elapsed,
            df_elapsed, df_scopes, df_shared, df_success, df_results.len(),
            lsp_elapsed, lsp_started, lsp_failed,
            iter_elapsed, rss
        );
    }

    // 计算每阶段的 min/mean/max
    let stage_count = all_stage_names.len();
    let mut summary_stages: Vec<StageTiming> = Vec::with_capacity(stage_count);

    for si in 0..stage_count {
        let mut times: Vec<f64> = all_timings.iter().map(|t| t[si]).collect();
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let min_t = times.first().copied().unwrap_or(0.0);
        let max_t = times.last().copied().unwrap_or(0.0);
        let mean_t = times.iter().sum::<f64>() / times.len() as f64;

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

    let mean_total = all_totals.iter().sum::<f64>() / all_totals.len() as f64;

    let label = format!("{} ({}) — FULL", root.file_name().unwrap_or_default().to_string_lossy(), root.display());

    let report = StressReport {
        label,
        file_count,
        symbol_count: 0,
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

// ═══════════════════════════════════════════════════════════════
// 仅 Dataflow 基准测试
// ═══════════════════════════════════════════════════════════════

/// 仅对 Dataflow 分析进行基准测试。
///
/// 不执行结构分析和 LSP 预热，仅测量 `query_dataflow_files` 的耗时。
pub fn run_stress_dataflow(project_path: &Path, iterations: usize) -> StressReport {
    let root = project_path.to_path_buf();
    let source_files = collect_source_files(&root);
    let file_count = source_files.len();

    eprintln!("══ HoloGram Dataflow-Only Benchmark ══");
    eprintln!("Project: {}", root.display());
    eprintln!("Source files: {}  |  Iterations: {}", file_count, iterations);
    eprintln!();

    let mut all_times: Vec<f64> = Vec::new();
    let mut peak_rss = 0.0_f64;
    let mut last_scopes = 0;
    let mut last_shared = 0;
    let mut last_success = 0;

    for i in 0..iterations {
        let start = Instant::now();
        let results = crate::analysis::dataflow_engine::query_dataflow_files(&source_files);
        let elapsed = start.elapsed().as_secs_f64();

        let scopes: usize = results.iter()
            .filter_map(|r| r.result.as_ref().ok()).map(|df| df.scopes.len()).sum();
        let shared: usize = results.iter()
            .filter_map(|r| r.result.as_ref().ok()).map(|df| df.shared.len()).sum();
        let success = results.iter().filter(|r| r.result.is_ok()).count();

        all_times.push(elapsed);
        last_scopes = scopes;
        last_shared = shared;
        last_success = success;

        let rss = get_rss_mb();
        if rss > peak_rss { peak_rss = rss; }

        eprintln!("  iter {}/{}:  {:.2}s  ({} scopes, {} shared vars, {}/{} files)  RSS: {:.0} MB",
            i + 1, iterations, elapsed, scopes, shared, success, file_count, rss);
    }

    let mean = all_times.iter().sum::<f64>() / all_times.len() as f64;

    let label = format!("{} (Dataflow)", root.file_name().unwrap_or_default().to_string_lossy());
    let report = StressReport {
        label,
        file_count,
        symbol_count: 0,
        stages: vec![StageTiming {
            name: "Dataflow".into(),
            elapsed_secs: mean,
            detail: format!("{} scopes, {} shared, {}/{} files", last_scopes, last_shared, last_success, file_count),
        }],
        total_secs: mean,
        peak_rss_mb: peak_rss,
        node_count: 0, edge_count: 0, community_count: 0,
        iterations,
    };

    println!();
    report.print();

    if iterations > 1 {
        let mut sorted = all_times.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("Stability: {:.2}s–{:.2}s, range {:.1}% of mean",
            sorted.first().copied().unwrap_or(0.0), sorted.last().copied().unwrap_or(0.0),
            if mean > 0.0 { (sorted.last().unwrap() - sorted.first().unwrap()) / mean * 100.0 } else { 0.0 });
        println!();
    }

    report
}

// ═══════════════════════════════════════════════════════════════
// 仅 LSP 基准测试
// ═══════════════════════════════════════════════════════════════

/// 仅对 LSP 服务器预热进行基准测试。
///
/// 测量 `warm_blocking_filtered` 的耗时和成功率。
pub fn run_stress_lsp(project_path: &Path, iterations: usize, ext_filter: &[&str]) -> StressReport {
    let root = project_path.to_path_buf();
    let filter_label = if ext_filter.is_empty() { "all".to_string() } else { ext_filter.join(",") };

    eprintln!("══ HoloGram LSP-Only Benchmark ══");
    eprintln!("Project: {}", root.display());
    eprintln!("Iterations: {}  |  Languages: {}", iterations, filter_label);
    eprintln!();

    let mut all_times: Vec<f64> = Vec::new();
    let mut all_started = Vec::new();
    let mut all_failed = Vec::new();
    let mut peak_rss = 0.0_f64;

    for i in 0..iterations {
        let start = Instant::now();
        let (started, failed) = crate::lsp_manager::LspManager::warm_blocking_filtered(
            &root.to_string_lossy(), ext_filter,
        );
        let elapsed = start.elapsed().as_secs_f64();

        all_times.push(elapsed);
        all_started.push(started);
        all_failed.push(failed);

        let rss = get_rss_mb();
        if rss > peak_rss { peak_rss = rss; }

        eprintln!("  iter {}/{}:  {:.2}s  ({} ok, {} fail)  RSS: {:.0} MB",
            i + 1, iterations, elapsed, started, failed, rss);
    }

    let mean = all_times.iter().sum::<f64>() / all_times.len() as f64;
    let avg_started = all_started.iter().sum::<usize>() / all_started.len().max(1);
    let avg_failed = all_failed.iter().sum::<usize>() / all_failed.len().max(1);

    let label = format!("{} (LSP)", root.file_name().unwrap_or_default().to_string_lossy());
    let report = StressReport {
        label,
        file_count: 0,
        symbol_count: 0,
        stages: vec![StageTiming {
            name: "LSP Warm".into(),
            elapsed_secs: mean,
            detail: format!("{} started, {} failed", avg_started, avg_failed),
        }],
        total_secs: mean,
        peak_rss_mb: peak_rss,
        node_count: 0, edge_count: 0, community_count: 0,
        iterations,
    };

    println!();
    report.print();

    if iterations > 1 {
        let mut sorted = all_times.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("Stability: {:.2}s–{:.2}s, range {:.1}% of mean",
            sorted.first().copied().unwrap_or(0.0), sorted.last().copied().unwrap_or(0.0),
            if mean > 0.0 { (sorted.last().unwrap() - sorted.first().unwrap()) / mean * 100.0 } else { 0.0 });
        println!();
    }

    report
}

// ═══════════════════════════════════════════════════════════════
// 套件运行器
// ═══════════════════════════════════════════════════════════════

/// 运行完整压力测试套件（small→medium→large），并打印对比表和缩放分析。
pub fn run_stress_suite() {
    let sizes = [StressSize::Small, StressSize::Medium, StressSize::Large];
    let mut reports: Vec<StressReport> = Vec::new();

    for (i, size) in sizes.iter().enumerate() {
        // 清理上一规模的临时项目目录
        if i > 0 {
            let prev = std::env::temp_dir()
                .join("hologram_stress")
                .join(format!("proj_{}", sizes[i - 1].file_count()));
            let _ = fs::remove_dir_all(&prev);
        }
        reports.push(run_stress(*size));
    }

    // 对比表
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

    // 缩放分析
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
// 测试
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stress_size_parsing() {
        // 字符串和数字都应正确解析
        assert!(matches!(StressSize::from_str("small"), Some(StressSize::Small)));
        assert!(matches!(StressSize::from_str("MEDIUM"), Some(StressSize::Medium)));
        assert!(matches!(StressSize::from_str("500"), Some(StressSize::Custom(500))));
        assert!(StressSize::from_str("nonsense").is_none());
    }

    #[test]
    fn test_generator_small() {
        // 小规模生成器应产生符号和目录结构
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
        // 5 个文件的完整管线应快速完成并产生图数据
        let report = run_stress(StressSize::Custom(5));
        assert!(report.node_count > 0, "should produce nodes: {:?}", report.node_count);
        assert!(report.total_secs < 10.0, "5 files should finish quickly");
        // 必须有每阶段耗时
        assert!(!report.stages.is_empty(), "should have stage timings");
        let stage_names: Vec<&str> = report.stages.iter().map(|s| s.name.as_str()).collect();
        assert!(stage_names.contains(&"Core Parse"), "should have Core Parse stage, got: {:?}", stage_names);
        assert!(stage_names.contains(&"Community (Leiden)"), "should have Community (Leiden) stage");
    }

    #[test]
    fn test_report_json() {
        // JSON 序列化应包含所有字段
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
        // 应正确统计源代码文件，忽略非源码文件
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
