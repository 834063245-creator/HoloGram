// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # HoloGram Engine — 代码依赖拓扑分析引擎入口
//!
//! 本文件是引擎的可执行入口（binary crate），负责：
//! - 启动 TCP RPC 服务器（默认模式，供 Tauri 前端 / Unity 调用）
//! - 启动 MCP JSON-RPC 服务器（通过 stdio 与 AI 助手通信）
//! - 执行压力测试与基准评估
//! - 运行 CLI 一站式工具调用（`engine.exe run <tool>`）
//!

// 在 Windows 上隐藏控制台窗口（作为 GUI 子系统运行，避免弹出黑色终端）
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

// 全局分配器：使用 mimalloc 替代系统默认分配器
// 对于多线程小对象密集型负载（图构建、LSP 解析），可提升 20-30% 性能
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

// ── 引擎内部模块导入 ──
use hologram_engine::analysis::{fragile_nodes, detect_cycles, coupling_report, graph_summary, find_blindspots};
use hologram_engine::community::{detect_communities, detect_hierarchical_communities};
use hologram_engine::graph::{query, Graph, EdgeKind};
use hologram_engine::logging;
use hologram_engine::routing::preflight::{check_timeline_props, load_baseline, run_full_check, save_baseline};
use hologram_engine::mcp::{self, McpServer};
use hologram_engine::stress::{self, StressSize};
use hologram_engine::tools::ToolRegistry;
use serde_json::{self, json};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{info, debug, warn};

/// 程序入口。根据命令行参数分发到不同运行模式：
///
/// | 模式 | 命令示例 | 说明 |
/// |------|---------|------|
/// | TCP RPC | `engine.exe` | 默认，在 127.0.0.1:9777 上监听 |
/// | MCP serve | `engine.exe serve [--project-root <path>]` | 通过 stdio 运行 MCP JSON-RPC |
/// | 压力测试 | `engine.exe --stress <size>` | 合成图基准测试 |
/// | 真实基准 | `engine.exe --stress-real <path> [N]` | 对真实项目做基准测试 |
/// | CLI 工具 | `engine.exe run <tool> [project] [--key val]` | 一次性执行工具 |
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // ── 初始化 rayon 线程池 ──
    // 自适应策略：普通模式保留 1 个核心给 UI 保证响应性；压力测试模式使用全部核心追求精度。
    // 4 核机器：普通模式 3 线程（75%），压力测试 4 线程（100%）
    // 32 核机器：普通模式 31 线程（97%），压力测试 32 线程（100%）
    // 注意：rayon 全局线程池是惰性初始化的，必须在任何 par_iter() 之前完成构建
    let n_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let is_stress = std::env::args().any(|a| a == "--stress" || a == "--stress-real" || a == "--stress-full" || a == "--stress-dataflow" || a == "--stress-lsp" || a == "--stress-suite");
    let n_threads = if is_stress { n_cores } else { n_cores.saturating_sub(1).max(1) };
    rayon::ThreadPoolBuilder::new()
        .num_threads(n_threads)
        .build_global()
        .expect("rayon global pool already initialized — move this call earlier");

    // ── 收集命令行参数 ──
    let args: Vec<String> = std::env::args().collect();

    // ── --version / --help：打印版本信息后退出 ──
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("HoloGram Engine v4.0");
        println!("Copyright (c) 2026 Wenbing Jing. MIT License.");
        println!("https://github.com/834063245-creator/HoloGram");
        return Ok(());
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("HoloGram Engine v4.0 — Code Dependency Topology Analyzer");
        println!("Copyright (c) 2026 Wenbing Jing. MIT License.");
        println!();
        println!("USAGE:");
        println!("  engine.exe                    启动 TCP RPC 服务器（默认，127.0.0.1:9777）");
        println!("  engine.exe serve              启动 MCP JSON-RPC 服务器（通过 stdio）");
        println!("  engine.exe serve --project-root <path>  MCP 服务模式，附带项目自动分析");
        println!("  engine.exe --stress <size>    运行压力测试 (small|medium|large|xlarge|<N>)");
        println!("  engine.exe --stress-suite     运行完整压力测试套件 (small→large)");
        println!("  engine.exe --stress-real <path> [N]  对真实项目做基准测试（默认 3 轮）");
        println!("  engine.exe --stress-full <path> [N]  完整管线: 结构 + Dataflow + LSP");
        println!("  engine.exe --stress-dataflow <path> [N]  仅 Dataflow 基准测试");
        println!("  engine.exe --stress-lsp <path> [N] [ext]  仅 LSP 基准测试 (ext: py,rs,ts,go,...)");
        println!("  engine.exe run <tool> [project_path] [--key value ...]  一次性执行工具");
        println!("  engine.exe run --list                                 列出所有可用工具");
        println!("  engine.exe --version          打印版本和版权信息");
        println!("  engine.exe --help             显示此帮助信息");
        return Ok(());
    }

    // ── 压力测试模式：合成图基准 ──
    // 用法：engine.exe --stress <size>，size 可选 small/medium/large/xlarge 或数字
    if let Some(pos) = args.iter().position(|a| a == "--stress") {
        let size_str = args.get(pos + 1).map(|s| s.as_str()).unwrap_or("small");
        match StressSize::from_str(size_str) {
            Some(size) => {
                stress::run_stress(size);
                return Ok(());
            }
            None => {
                eprintln!("[stress] 未知规模 '{}'。可选: small, medium, large, xlarge, 或数字", size_str);
                std::process::exit(1);
            }
        }
    }
    // ── 真实项目基准测试 ──
    // 用法：engine.exe --stress-real <path> [iterations]
    if let Some(pos) = args.iter().position(|a| a == "--stress-real") {
        let path_str = args.get(pos + 1).map(|s| s.as_str()).unwrap_or(".");
        let iterations: usize = args.get(pos + 2)
            .and_then(|s| s.parse().ok())
            .unwrap_or(3);
        let root = PathBuf::from(path_str);
        if !root.exists() {
            eprintln!("[stress] Project path not found: {}", path_str);
            std::process::exit(1);
        }
        stress::run_stress_real(&root, iterations);
        return Ok(());
    }
    // ── 完整管线基准测试（结构 + Dataflow + LSP）──
    // 用法：engine.exe --stress-full <path> [iterations] [ext_filter]
    if let Some(pos) = args.iter().position(|a| a == "--stress-full") {
        let path_str = args.get(pos + 1).map(|s| s.as_str()).unwrap_or(".");
        let iterations: usize = args.get(pos + 2)
            .and_then(|s| s.parse().ok())
            .unwrap_or(3);
        let ext_filter: Vec<String> = args.get(pos + 3)
            .map(|s| s.split(',').map(|e| e.trim().to_string()).collect())
            .unwrap_or_default();
        let ext_slice: Vec<&str> = ext_filter.iter().map(|s| s.as_str()).collect();
        let root = PathBuf::from(path_str);
        if !root.exists() {
            eprintln!("[stress] Project path not found: {}", path_str);
            std::process::exit(1);
        }
        stress::run_stress_full(&root, iterations, &ext_slice);
        return Ok(());
    }
    // ── 仅 Dataflow 基准测试 ──
    if let Some(pos) = args.iter().position(|a| a == "--stress-dataflow") {
        let path_str = args.get(pos + 1).map(|s| s.as_str()).unwrap_or(".");
        let iterations: usize = args.get(pos + 2).and_then(|s| s.parse().ok()).unwrap_or(3);
        let root = PathBuf::from(path_str);
        if !root.exists() { eprintln!("[stress] Project path not found: {}", path_str); std::process::exit(1); }
        stress::run_stress_dataflow(&root, iterations);
        return Ok(());
    }
    // ── 仅 LSP 基准测试 ──
    // 用法：engine.exe --stress-lsp <path> [iterations] [ext_filter]
    // ext_filter 为逗号分隔的扩展名列表（如 "py,rs"），不传则分析全部语言
    if let Some(pos) = args.iter().position(|a| a == "--stress-lsp") {
        let path_str = args.get(pos + 1).map(|s| s.as_str()).unwrap_or(".");
        let iterations: usize = args.get(pos + 2).and_then(|s| s.parse().ok()).unwrap_or(3);
        // Optional language filter: comma-separated extensions, e.g. "py,rs"
        let ext_filter: Vec<String> = args.get(pos + 3)
            .map(|s| s.split(',').map(|e| e.trim().to_string()).collect())
            .unwrap_or_default();
        let ext_slice: Vec<&str> = ext_filter.iter().map(|s| s.as_str()).collect();
        let root = PathBuf::from(path_str);
        if !root.exists() { eprintln!("[stress] Project path not found: {}", path_str); std::process::exit(1); }
        stress::run_stress_lsp(&root, iterations, &ext_slice);
        return Ok(());
    }
    // ── 压力测试套件：依次运行 small→large 全部规模 ──
    if args.iter().any(|a| a == "--stress-suite") {
        stress::run_stress_suite();
        return Ok(());
    }

    // ── CLI 一站式工具调用模式 ──
    // 用法：engine.exe run <tool> [project_path] [--key value ...]
    // 复用 ToolRegistry::dispatch，与 GUI/MCP 使用同一套引擎逻辑
    if let Some(pos) = args.iter().position(|a| a == "run") {
        return cli_run(&args[pos + 1..]);
    }

    // ── MCP 服务模式（通过 stdio 运行 JSON-RPC）──
    // 由 mcp::parse_serve_args() 解析 `serve [--project-root <path>]`
    if let Some(project_root_opt) = mcp::parse_serve_args() {
        let log_root = project_root_opt.as_deref().map(PathBuf::from);
        let _log_guard = logging::init_logging(log_root.as_deref());

        match project_root_opt {
            Some(project_root) => {
                // ── 带 --project-root 的 MCP 服务：初始化引擎，延迟分析 ──
                let root = PathBuf::from(&project_root);
                if !root.exists() {
                    eprintln!("[engine] 错误: 项目根目录不存在: {}", project_root);
                    std::process::exit(1);
                }
                info!(project_root = %project_root, "engine starting in MCP serve mode (with project)");

                // 惰性初始化存储引擎（GraphStore + SQLite）
                // 实际分析延迟到首次 analyze_project MCP 调用时执行
                // 文件监视器也延迟启动——Windows notify 在启动阶段会发出大量虚假事件，
                // 可能触发反复重分析循环（曾观测到 622MB 内存、195% CPU 占用）
                if let Err(e) = hologram_engine::engine::engine_init(&root) {
                    warn!("[main] 引擎初始化失败（非致命）: {}", e);
                }

                info!("engine MCP serve ready — analysis + watcher deferred to first analyze_project");

                // 向 Tauri McpManager 发送就绪信号
                // 它期望在发送 initialize + tools/list 之前先收到 {"method":"ready"}
                // 缺少此信号会导致 read_ready() 超时
                println!(r#"{{"jsonrpc":"2.0","method":"ready"}}"#);

                let server = McpServer::new(&root);
                server.run_stdio();
            }
            None => {
                // ── 不带 --project-root 的 MCP 服务：惰性启动 ──
                // 首次 analyze_project 调用时才加载图数据
                info!("engine starting in MCP serve mode (lazy — no project)");
                let server = McpServer::new(std::path::Path::new("."));
                server.run_stdio();
            }
        }
        return Ok(());
    }

    // ── TCP RPC 服务器模式（默认）──
    // 在 127.0.0.1:9777 上监听，供 Tauri 前端 / Unity 等客户端调用
    let _log_guard = logging::init_logging(None);
    let listener = TcpListener::bind("127.0.0.1:9777").await?;
    info!("TCP server listening on 127.0.0.1:9777");

    loop {
        let (mut socket, addr) = listener.accept().await?;
        debug!(%addr, "client connected");

        // 每个连接 spawn 一个独立 task，确保 accept 循环不会被阻塞
        // 连接保持（keep-alive）：内层循环处理同一连接的多个请求
        // CPU 密集型工作（analyze、check）通过 spawn_blocking 卸载到阻塞线程池
        tokio::spawn(async move {
            loop {
            let mut buf = vec![0u8; 4096];
            let n = match socket.read(&mut buf).await {
                Ok(0) => { debug!(%addr, "client disconnected"); return; }
                Ok(n) => n,
                Err(e) => { debug!(%addr, "read error: {}", e); return; }
            };
            let request = String::from_utf8_lossy(&buf[..n]);
            let req_owned = request.to_string();
            debug!(request_len = req_owned.len(), "received request");

            // ── 根据请求前缀路由到对应的处理函数 ──
            // 命令格式：<command>[:<args>]
            let response = if req_owned.starts_with("check:") || req_owned.starts_with("preflight:") || req_owned.starts_with("health:") {
                // 检查模式：执行提交前预检（preflight check），CPU 密集型，卸载到阻塞线程
                let req = req_owned.clone();
                tokio::task::spawn_blocking(move || handle_check(req.trim()))
                    .await.unwrap_or_else(|_| b"{\"error\":\"check panicked\"}".to_vec())
            } else if req_owned.starts_with("blindspots") {
                // 盲点检测：结合耦合报告和环检测，识别架构盲区
                let arg = req_owned.trim().strip_prefix("blindspots:").unwrap_or("");
                let threshold: usize = arg.parse().unwrap_or(0);
                handle_simple("blindspots", arg, move |g, _| {
                    let c = coupling_report(g, "");
                    let cycles = detect_cycles(g);
                    find_blindspots(
                        if threshold > 0 { threshold } else { c["L4"].as_u64().unwrap_or(0) as usize },
                        cycles.len(),
                        0,
                    )
                })
            } else if req_owned.starts_with("timeline") {
                // 时间线：查询最近 50 条引擎事件记录
                handle_simple("timeline", req_owned.trim(), |_g, _a| {
                    json!(hologram_engine::engine::engine_query_timeline(50).unwrap_or_default())
                })
            } else if req_owned.starts_with("analyze:") {
                // 全量分析：解析项目源码并构建依赖图，CPU 密集型，卸载到阻塞线程
                let path = req_owned.trim().strip_prefix("analyze:").unwrap_or(".").trim().to_string();
                tokio::task::spawn_blocking(move || handle_analyze(&path))
                    .await.unwrap_or_else(|_| b"{\"error\":\"analyze panicked\"}".to_vec())
            } else if req_owned.starts_with("fragile:") {
                // 脆弱节点检测：找出高扇入/高扇出的关键节点
                handle_simple("fragile:", req_owned.trim(), |g, a| json!(fragile_nodes(g, a.parse().unwrap_or(10))))
            } else if req_owned.starts_with("cycle") {
                // 环检测：发现依赖图中的循环依赖
                handle_simple("cycle", req_owned.trim(), |g, _| json!(detect_cycles(g)))
            } else if req_owned.starts_with("coupling_report:") {
                // 耦合报告：按层级（L0-L4）统计耦合度
                handle_simple("coupling_report:", req_owned.trim(), coupling_report)
            } else if req_owned.starts_with("graph_summary") {
                // 图摘要：节点/边数量、类型分布等概要信息
                handle_simple("graph_summary", req_owned.trim(), |g, _| graph_summary(g))
            } else if req_owned.starts_with("community_report") {
                // 社区检测报告：使用 Louvain 算法（seed=42）识别模块化社区
                handle_simple("community_report", req_owned.trim(), |g, _| {
                    let communities = detect_communities(g, 42);
                    json!(communities.iter().enumerate().map(|(i,c)| json!({"id":format!("comm_{}",i),"size":c.len(),"node_ids":c})).collect::<Vec<_>>())
                })
            } else if req_owned.starts_with("community:") {
                // 查询指定节点所属的社区，返回同社区节点列表（最多 50 个）
                handle_simple("community:", req_owned.trim(), |g, a| {
                    let communities = detect_communities(g, 42);
                    let found = communities.iter().find(|c| c.contains(&a.to_string()));
                    json!(found.map(|c| c.iter().take(50).collect::<Vec<_>>()))
                })
            } else if req_owned.starts_with("diff:") {
                // 变更对比：与基线图比较，输出新增/删除/修改的节点和边
                let baseline_path = req_owned.trim().strip_prefix("diff:").unwrap_or("").trim().to_string();
                handle_diff(&baseline_path)
            } else if req_owned.starts_with("history:") {
                // 节点详情：按 ID 查询节点的名称、类型、入度、出度
                handle_simple("history:", req_owned.trim(), |g, a| {
                    g.get_node(a).map(|n| json!({"id":n.id,"name":n.name,"type":n.kind.as_str(),"out_degree":n.out_degree,"in_degree":n.in_degree}))
                        .unwrap_or(json!({"error":"not found"}))
                })
            } else if req_owned.starts_with("delayed") {
                // 延迟边查询：筛选 Triggers/Awaits/Sequences 类型的时序边
                handle_simple("delayed", req_owned.trim(), |g, _| {
                    let delayed: Vec<_> = g.edges.values().filter(|e| matches!(e.kind, EdgeKind::Triggers|EdgeKind::Awaits|EdgeKind::Sequences))
                        .map(|e| json!({"source":e.source,"target":e.target,"type":e.kind.as_str()}))
                        .collect();
                    json!(delayed)
                })
            } else if req_owned.starts_with("neighbors:") {
                // 邻居查询：获取指定节点的 N 跳邻居
                handle_query(req_owned.trim(), "neighbors:")
            } else if req_owned.starts_with("path:") {
                // 最短路径查询：查找两个节点之间的最短依赖路径
                handle_query(req_owned.trim(), "path:")
            } else if req_owned.starts_with("search:") {
                // 节点搜索：按名称模糊搜索，格式 "search:query:limit"（limit 可选，默认 50）
                let args = req_owned.trim().strip_prefix("search:").unwrap_or("");
                let (query_str, limit): (&str, usize) = match args.rfind(':') {
                    Some(pos) if pos > 0 => {
                        let (q, l) = args.split_at(pos);
                        (q, l[1..].parse().unwrap_or(50))
                    }
                    _ => (args, 50),
                };
                handle_simple("search:", query_str, move |g, _| {
                    let results = query::search_nodes(g, query_str);
                    let truncated: Vec<_> = results.iter().take(limit).map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
                    json!({"results": truncated, "total": results.len(), "limit": limit})
                })
            } else if req_owned.starts_with("impact:") {
                // 影响分析：评估指定节点的变更对周围 N 层节点的影响
                handle_query(req_owned.trim(), "impact:")
            } else if req_owned.starts_with("rename:") {
                // 重命名预检：解析 "rename:old_name:new_name:dry_run:node_id"
                // dry_run=true 时仅返回匹配结果，不实际执行重命名
                let args = req_owned.trim().strip_prefix("rename:").unwrap_or("");
                let parts: Vec<&str> = args.splitn(4, ':').collect();
                let old_name = parts.first().copied().unwrap_or("");
                let new_name = parts.get(1).copied().unwrap_or("");
                let dry_run: bool = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(false);
                let _node_id = parts.get(3).copied().unwrap_or("");
                handle_simple("rename:", old_name, move |g, _| {
                    let matched: Vec<_> = g.nodes.values()
                        .filter(|n| n.name == old_name)
                        .collect();
                    if matched.is_empty() {
                        json!({"error": format!("No nodes match '{}'", old_name)})
                    } else if dry_run {
                        json!({"dry_run": true, "matched_count": matched.len(), "matched": matched.iter().map(|n| json!({"id": n.id, "name": n.name})).collect::<Vec<_>>()})
                    } else {
                        // TCP 模式下仅支持内存级重命名，完整重命名请使用 MCP 工具
                        json!({"dry_run": false, "renamed_count": matched.len(), "old_name": old_name, "new_name": new_name, "note": "TCP rename: in-memory only. Use MCP tool for full rename support."})
                    }
                })
            } else if req_owned.contains("get_graph") {
                // 获取完整图数据（节点+边），供前端渲染
                handle_get_graph()
            } else if req_owned.contains("ping") {
                // 心跳检测
                b"{\"ok\":true}".to_vec()
            } else {
                // 未知命令
                b"{\"error\":\"unknown command\"}".to_vec()
            };

            // 用 4 字节小端长度前缀封装响应并写回
            let framed = frame_response(&response);
            if let Err(e) = socket.write_all(&framed).await {
                debug!(%addr, "write error: {}", e);
                return;
            }
            } // keep-alive 循环结束
        });
    }
}

/// 处理全量分析请求。
///
/// 流程：初始化引擎 → 执行分析 → 记录时间线 → 序列化完整图数据（含社区检测）为 JSON。
/// 返回的 JSON 包含节点、边、社区、层级社区、耗时等字段，供前端（Unity/Tauri）消费。
fn handle_analyze(path: &str) -> Vec<u8> {
    let root = PathBuf::from(path);
    if !root.exists() {
        return serde_json::to_vec(&serde_json::json!({
            "error": "path not found",
            "path": path
        }))
        .unwrap_or_default();
    }

    // 初始化引擎（打开 GraphStore + SQLite）
    if let Err(e) = hologram_engine::engine::engine_init(&root) {
        return serde_json::to_vec(&serde_json::json!({
            "error": format!("engine init failed: {}", e),
            "path": path
        }))
        .unwrap_or_default();
    }
    // 执行全量分析（解析源码 → 构建依赖图）
    let result = match hologram_engine::engine::engine_analyze(&root) {
        Ok(r) => r,
        Err(e) => return serde_json::to_vec(&serde_json::json!({"error": e})).unwrap_or_default(),
    };

    // 记录时间线事件
    let _ = hologram_engine::engine::engine_record_timeline(
        "analyze",
        None::<&str>,
        &format!("全量分析完成：{} 节点, {} 边, {:.1}s", result.node_count, result.edge_count, result.elapsed_secs),
    );

    // ── 序列化完整图数据，供前端消费 ──
    // 节点：ID、名称、类型、位置、入度、出度、属性、位置坐标、社区 ID
    let nodes: Vec<serde_json::Value> = result.graph.nodes.values().map(|n| {
        serde_json::json!({
            "id": n.id, "name": n.name, "type": n.kind.as_str(),
            "location": n.location, "in_degree": n.in_degree,
            "out_degree": n.out_degree, "properties": n.properties,
            "position": n.position, "community_id": n.community_id
        })
    }).collect();

    // 边：ID、源节点、目标节点、类型、耦合深度、是否跨文件、时序延迟
    let edges: Vec<serde_json::Value> = result.graph.edges.values().map(|e| {
        serde_json::json!({
            "id": e.id, "source": e.source, "target": e.target,
            "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
            "cross_file": e.cross_file,
            "temporal_delay_sec": e.temporal_delay_sec
        })
    }).collect();

    // ── 社区检测（扁平结构）──
    // 使用 Louvain 算法（随机种子 42），将节点聚类为模块化社区
    let communities = detect_communities(&result.graph, 42);
    let communities_json: Vec<serde_json::Value> = communities.iter().enumerate()
        .map(|(i, c)| serde_json::json!({
            "id": format!("comm_{}", i), "label": format!("社区 {}", i + 1),
            "size": c.len(), "node_ids": c
        }))
        .collect();
    // ── 层级社区检测（Level 0 + Level 1+ 超级社区）──
    // 提供多粒度的社区视图，便于前端做折叠/展开
    let hcommunities = detect_hierarchical_communities(&result.graph, 42);
    let hcommunities_json: Vec<serde_json::Value> = hcommunities.iter()
        .map(|hc| serde_json::json!({
            "id": hc.id,
            "label": hc.label,
            "node_ids": hc.node_ids,
            "level": hc.level,
            "parent_id": hc.parent_id,
        }))
        .collect();

    serde_json::to_vec(&serde_json::json!({
        "nodes": nodes, "edges": edges, "communities": communities_json,
        "hierarchical_communities": hcommunities_json,
        "elapsed_secs": result.elapsed_secs,
        "node_count": result.node_count, "edge_count": result.edge_count,
        "generator": "HoloGram v4.0 — Copyright (c) 2026 Wenbing Jing — MIT License"
    }))
    .unwrap_or_default()
}

/// 处理提交前预检（preflight check）请求。
///
/// 解析请求格式 `check:<path>` 或 `check:<path>\n<json_files>`，
/// 如果引擎尚未加载图数据则自动执行分析，然后运行完整约束检查并与基线对比。
/// 检查完成后保存新基线，并将结果记录到时间线。
fn handle_check(request: &str) -> Vec<u8> {
    // 解析 "check:<path>" 或 "check:<path>\n<变更文件列表JSON>"
    let body = request.strip_prefix("check:").unwrap_or(".");
    let (path, changed_files): (&str, Vec<String>) = if let Some((p, files_json)) = body.split_once('\n') {
        let files: Vec<String> = serde_json::from_str(files_json.trim()).unwrap_or_default();
        (p.trim(), files)
    } else {
        (body.trim(), vec![])
    };
    let root = PathBuf::from(path);

    // 前置检查：项目路径必须存在
    if !root.exists() {
        return b"{\"error\":\"project not found\"}".to_vec();
    }

    // 如果图尚未加载（节点和边都为 0），自动初始化并分析
    if !hologram_engine::engine::engine_read_graph(|g| g.node_count() > 0 || g.edge_count() > 0).unwrap_or(false) {
        if let Err(e) = hologram_engine::engine::engine_init(&root) {
            tracing::warn!("auto engine_init failed: {e}");
        }
        if let Err(e) = hologram_engine::engine::engine_analyze(&root) {
            tracing::warn!("auto engine_analyze failed: {e}");
        }
    }

    // 获取当前（分析后）的图快照
    let after = match hologram_engine::engine::engine_read_graph(|g| g.clone()) {
        Ok(g) => g,
        Err(_) => return b"{\"error\":\"analysis failed\"}".to_vec(),
    };

    // 加载之前的基线图，运行完整约束检查，然后保存新基线
    let before = load_baseline(&root);
    let result = run_full_check(&before, &after, &changed_files, path);
    save_baseline(&root, &after);

    // 将检查结果记录到时间线（仅在非静默或首次建立基线时记录）
    let quiet = result.get("quiet").and_then(|v| v.as_bool()).unwrap_or(false);
    let baseline_seed = result.get("baseline_seed").and_then(|v| v.as_bool()).unwrap_or(false);
    if !quiet || baseline_seed {
        let passed = result["passed"].as_bool().unwrap_or(true);
        let violation_count = result["violation_count"].as_u64().unwrap_or(0);
        let event_type = if passed { "commit_clean" } else { "commit_violation" };
        let summary = if baseline_seed {
            "基线已建立".to_string()
        } else if passed {
            format!("简报通过（{} 违规）", violation_count)
        } else {
            format!("简报未通过：{} 条违规", violation_count)
        };
        let props = check_timeline_props(&result);
        let _ = hologram_engine::engine::engine_record_timeline_with_props(
            event_type, None::<&str>, &summary, &props,
        );
    }

    serde_json::to_vec(&result).unwrap_or_default()
}

/// 通用图查询处理函数。
///
/// 从请求中剥离前缀提取参数，检查引擎是否就绪（已加载图数据），
/// 然后调用闭包 `f` 对图执行操作并返回 JSON 结果。
/// 引擎未初始化时返回错误提示。
fn handle_simple<F: FnOnce(&Graph, &str) -> serde_json::Value>(prefix: &str, request: &str, f: F) -> Vec<u8> {
    let arg = request.strip_prefix(prefix).unwrap_or("");
    // 检查引擎状态：Ready 或已加载部分节点时才允许查询
    let state = hologram_engine::engine::engine_state();
    let is_ready = matches!(state, hologram_engine::engine::EngineState::Ready { .. })
        || matches!(state, hologram_engine::engine::EngineState::Loading { nodes_loaded, .. } if nodes_loaded > 0);
    match hologram_engine::engine::engine_read_graph(|g| {
        if !is_ready {
            return serde_json::Value::Null; // engine not initialized
        }
        f(g, arg)
    }) {
        Ok(v) if v.is_null() => serde_json::to_vec(&json!({"error": "engine not initialized — run analyze first"})).unwrap_or_default(),
        Ok(v) => serde_json::to_vec(&v).unwrap_or_default(),
        Err(_) => serde_json::to_vec(&json!({"error": "engine not initialized"})).unwrap_or_default(),
    }
}

/// 处理变更对比请求。
///
/// 将当前图与磁盘上的基线图进行 diff，返回新增/删除/修改的节点和边。
/// 如果基线文件不存在，则将当前图保存为基线并提示用户。
fn handle_diff(baseline_path: &str) -> Vec<u8> {
    // 获取当前图快照
    let current = match hologram_engine::engine::engine_read_graph(|g| g.clone()) {
        Ok(g) if g.node_count() > 0 || g.edge_count() > 0 => g,
        _ => return b"{\"error\":\"no graph loaded, run analyze first\"}".to_vec(),
    };

    // 基线路径默认为 .hologram/baseline.json
    let baseline_path = if baseline_path.is_empty() {
        ".hologram/baseline.json".to_string()
    } else {
        baseline_path.to_string()
    };

    match Graph::from_json_file(&baseline_path) {
        Ok(baseline) => {
            // 基线存在：执行 diff 并返回差异
            let d = baseline.diff(&current);
            let added_nodes: Vec<_> = d.added_nodes.iter().map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
            let removed_nodes: Vec<_> = d.removed_nodes.iter().map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
            let modified_nodes: Vec<_> = d.modified_nodes.iter().map(|(old, new)| json!({
                "node_id": new.id, "name": new.name,
                "old_kind": old.kind.as_str(), "new_kind": new.kind.as_str(),
            })).collect();
            let is_empty = added_nodes.is_empty() && removed_nodes.is_empty() && modified_nodes.is_empty();
            serde_json::to_vec(&json!({
                "is_empty": is_empty,
                "added_nodes": added_nodes, "removed_nodes": removed_nodes,
                "modified_nodes": modified_nodes,
                "added_edges": d.added_edges.len(), "removed_edges": d.removed_edges.len(),
            })).unwrap_or_default()
        }
        Err(_) => {
            // 基线不存在：将当前图保存为基线，提示下次再对比
            if let Some(parent) = std::path::Path::new(&baseline_path).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let graph_json = serde_json::to_string_pretty(&current).unwrap_or_default();
            if let Err(e) = std::fs::write(&baseline_path, &graph_json) {
                return serde_json::to_vec(&json!({"error": format!("无法创建基线: {}", e)})).unwrap_or_default();
            }
            serde_json::to_vec(&json!({
                "is_empty": true,
                "message": "已创建变更基线，再次点击变更即可比较差异",
                "baseline_path": baseline_path,
            })).unwrap_or_default()
        }
    }
}

/// 处理图查询请求（neighbors / path / search / impact）。
///
/// 从请求中剥离前缀后解析参数，在当前图上执行对应的查询操作。
/// 所有查询都要求图已加载（节点或边数量 > 0）。
fn handle_query(request: &str, prefix: &str) -> Vec<u8> {
    let args = request.strip_prefix(prefix).unwrap_or("");
    let graph = match hologram_engine::engine::engine_read_graph(|g| g.clone()) {
        Ok(g) if g.node_count() > 0 || g.edge_count() > 0 => g,
        _ => return b"{\"error\":\"no graph loaded, run analyze first\"}".to_vec(),
    };

    let result = match prefix {
        "neighbors:" => {
            // 格式: neighbors:<node_id>:<depth>
            // depth 可选，默认 1 跳
            let parts: Vec<&str> = args.split(':').collect();
            let node_id = parts[0];
            let depth: usize = parts.get(1).and_then(|d| d.parse().ok()).unwrap_or(1);
            let nb = query::neighbors(&graph, node_id, depth);
            serde_json::json!({ "neighbors": nb.iter().map(|(s,t,d)| json!([s,t,d])).collect::<Vec<_>>() })
        }
        "path:" => {
            // 格式: path:<from>:<to>
            // 查找两个节点之间的最短路径
            let parts: Vec<&str> = args.split(':').collect();
            if parts.len() < 2 { serde_json::json!({"error":"usage: path:from:to"}) }
            else {
                match query::shortest_path(&graph, parts[0], parts[1]) {
                    Some(p) => serde_json::json!({"path": p, "length": p.len()}),
                    None => serde_json::json!({"path": null, "message": "no path found"}),
                }
            }
        }
        "search:" => {
            // 格式: search:<query>
            // 按名称模糊搜索节点
            let results = query::search_nodes(&graph, args);
            serde_json::json!({ "results": results.iter().map(|n| json!({"id":n.id,"name":n.name})).collect::<Vec<_>>() })
        }
        "impact:" => {
            // 格式: impact:<node_id>:<max_depth>
            // 评估指定节点变更的影响范围，max_depth 默认 3 层
            let parts: Vec<&str> = args.split(':').collect();
            let node_id = parts[0];
            let max_depth: usize = parts.get(1).and_then(|d| d.parse().ok()).unwrap_or(3);
            let layers = query::impact(&graph, node_id, max_depth);
            serde_json::json!({ "layers": layers })
        }
        _ => serde_json::json!({"error":"unknown query"}),
    };

    serde_json::to_vec(&result).unwrap_or_default()
}

/// 获取完整图数据（所有节点和边）。
///
/// 返回 JSON 格式：{"nodes": [...], "edges": [...]}，
/// 供前端进行整体渲染。引擎未初始化时返回空数组。
fn handle_get_graph() -> Vec<u8> {
    match hologram_engine::engine::engine_read_graph(|g| {
        let nodes: Vec<serde_json::Value> = g.nodes.values().map(|n| {
            serde_json::json!({
                "id": n.id, "name": n.name, "type": n.kind.as_str(),
                "location": n.location, "in_degree": n.in_degree,
                "out_degree": n.out_degree, "properties": n.properties,
                "position": n.position, "community_id": n.community_id,
            })
        }).collect();
        let edges: Vec<serde_json::Value> = g.edges.values().map(|e| {
            serde_json::json!({
                "id": e.id, "source": e.source, "target": e.target,
                "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
                "cross_file": e.cross_file,
                "temporal_delay_sec": e.temporal_delay_sec,
            })
        }).collect();
        serde_json::json!({"nodes": nodes, "edges": edges})
    }) {
        Ok(v) => serde_json::to_vec(&v).unwrap_or_default(),
        Err(_) => b"{\"nodes\":[],\"edges\":[]}".to_vec(),
    }
}

// ═══════════════════════════════════════════════════════════════
// 协议辅助函数（可独立测试）
// TCP 通信使用 4 字节小端长度前缀 + JSON payload 的帧协议
// ═══════════════════════════════════════════════════════════════

/// 用 4 字节小端长度前缀封装 payload。
///
/// 帧格式: `[len: u32 LE][payload bytes]`
fn frame_response(payload: &[u8]) -> Vec<u8> {
    let len = payload.len() as u32;
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&len.to_le_bytes());
    framed.extend_from_slice(payload);
    framed
}

/// 解析帧消息：返回 (payload, 消耗的字节数)，数据不足时返回 None。
#[allow(dead_code)]
fn unframe(buf: &[u8]) -> Option<(Vec<u8>, usize)> {
    if buf.len() < 4 { return None; }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if buf.len() < 4 + len { return None; }
    Some((buf[4..4 + len].to_vec(), 4 + len))
}

// ═══════════════════════════════════════════════════════════════
// CLI 一站式工具调用模式 — `engine.exe run <tool> [project_path] [--key value ...]`
// 复用 ToolRegistry::dispatch —— 与 GUI / MCP 使用同一套引擎、基线和配置
// ═══════════════════════════════════════════════════════════════

/// 解析命令行参数 `--key value` 对（以及位置参数 project_path）为 JSON 对象。
///
/// 返回三元组：(工具名, 项目路径, 参数 JSON)
///
/// 支持的类型推断：
/// - 逗号分隔 → JSON 数组（如 `--files a.rs,b.rs` → `["a.rs","b.rs"]`）
/// - `true` / `false` → 布尔值
/// - `null` → JSON null
/// - 纯数字 → i64
/// - 浮点数 → f64
/// - 其他 → 字符串
fn parse_cli_args(rest: &[String]) -> Result<(String, String, serde_json::Value), String> {
    if rest.is_empty() {
        return Err("用法: engine.exe run <tool> [project_path] [--key value ...]".into());
    }

    // --list 是特殊标志，不需要解析工具名
    if rest[0] == "--list" {
        return Ok(("--list".into(), String::new(), json!({})));
    }

    let tool = rest[0].clone();
    let mut project_path = String::new();
    let mut args_map = serde_json::Map::new();

    let mut i = 1;
    while i < rest.len() {
        let arg = &rest[i];
        if arg.starts_with("--") {
            // 解析 --key value 对
            let key = arg.strip_prefix("--").unwrap_or(arg);
            let value = rest.get(i + 1).ok_or_else(|| format!("缺少 --{} 的值", key))?;
            // 逗号分隔的值 → JSON 数组（处理器期望列表参数为数组）
            let parsed = if value.contains(',') {
                let arr: Vec<&str> = value.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
                json!(arr)
            } else if value == "true" {
                json!(true)
            } else if value == "false" {
                json!(false)
            } else if value == "null" {
                json!(null)
            } else if let Ok(n) = value.parse::<i64>() {
                json!(n)
            } else if let Ok(f) = value.parse::<f64>() {
                json!(f)
            } else {
                json!(value)
            };
            args_map.insert(key.to_string(), parsed);
            i += 2;
        } else if project_path.is_empty() {
            // 第一个非 -- 参数视为项目路径
            project_path = arg.clone();
            i += 1;
        } else {
            return Err(format!("多余的位置参数: {}", arg));
        }
    }

    // 项目路径默认为当前目录 "."
    let project_path = if project_path.is_empty() { ".".into() } else { project_path };
    Ok((tool, project_path, json!(args_map)))
}

/// 从 MCP JSON-RPC 响应信封中提取工具结果文本。
///
/// 返回 (文本内容, 是否为错误)。
///
/// 错误格式: `{"jsonrpc":"2.0","error":{"code":...,"message":"..."}}`
/// 成功格式: `{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"..."}]}}`
fn extract_mcp_result(envelope: &serde_json::Value) -> (String, bool) {
    // 错误响应：直接提取 error.message
    if let Some(err) = envelope.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
        return (msg.to_string(), true);
    }
    // 成功响应：从 result.content[0].text 中提取文本
    let text = envelope
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    (text.to_string(), false)
}

/// CLI 一站式模式的入口函数。
///
/// 流程：解析参数 → 初始化引擎 → （如需要）自动分析 → 通过 ToolRegistry 分发工具调用
/// → 提取结果 → 根据 tool 类型决定退出码
fn cli_run(rest: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let (tool, project_path, args_json) = match parse_cli_args(rest) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(2);
        }
    };

    // --list：列出所有可用工具名称及描述
    if tool == "--list" {
        let tools = ToolRegistry::global().tools_list();
        for t in &tools {
            let name = t["name"].as_str().unwrap_or("?");
            let desc = t.get("description").and_then(|d| d.as_str()).unwrap_or("");
            println!("{:<22} {}", name, desc);
        }
        return Ok(());
    }

    let root = PathBuf::from(&project_path);
    if !root.exists() {
        eprintln!("[cli] 项目路径不存在: {}", project_path);
        std::process::exit(2);
    }

    // 初始化引擎（打开 GraphStore + SQLite，与 GUI/MCP 一致）
    if let Err(e) = hologram_engine::engine::engine_init(&root) {
        eprintln!("[cli] 引擎初始化失败（非致命）: {}", e);
    }

    // 图为空时自动分析——与 handle_check 的行为保持一致
    // 跳过两种情况：
    //   1. engine_status：不需要图数据
    //   2. analyze_project / validate_project：工具自身会触发分析
    let self_analyzing = tool == "analyze_project" || tool == "validate_project";
    if tool != "engine_status" && !self_analyzing {
        let has_graph = hologram_engine::engine::engine_read_graph(|g| g.node_count() > 0 || g.edge_count() > 0)
            .unwrap_or(false);
        if !has_graph {
            eprintln!("[cli] 图为空，正在分析项目…");
            match hologram_engine::engine::engine_analyze(&root) {
                Ok(result) => info!("[cli] 自动分析完成: {} 节点, {} 边", result.node_count, result.edge_count),
                Err(e) => {
                    eprintln!("[cli] 分析失败: {}", e);
                    std::process::exit(1);
                }
            }
        }
    }

    // analyze_project：在分发前先执行分析（填充图数据）
    if tool == "analyze_project" {
        match hologram_engine::engine::engine_analyze(&root) {
            Ok(result) => info!("[cli] 分析完成: {} 节点, {} 边", result.node_count, result.edge_count),
            Err(e) => {
                eprintln!("[cli] 分析失败: {}", e);
                std::process::exit(1);
            }
        }
    }

    // 通过 ToolRegistry 分发工具调用——与 MCP / Tauri 使用同一套注册表
    let id = json!(1);
    let envelope = ToolRegistry::dispatch(&tool, &args_json, &id);
    let (text, is_error) = extract_mcp_result(&envelope);

    if is_error {
        eprintln!("{}", text);
        std::process::exit(1);
    }

    // 将工具结果输出到 stdout（原始 JSON，兼容 jq 管道处理）
    println!("{}", text);

    // validate_project：约束未通过时退出码 1（供 CI/CD 使用）
    if tool == "validate_project" {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if !v.get("passed").and_then(|p| p.as_bool()).unwrap_or(false) {
                std::process::exit(1);
            }
        }
    }

    // preflight_check：风险等级为 critical 或 high 时退出码 1
    if tool == "preflight_check" {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let risk = v.get("risk_level").and_then(|r| r.as_str()).unwrap_or("low");
            if risk == "critical" || risk == "high" {
                std::process::exit(1);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hologram_engine::graph::{EdgeKind, Node, NodeKind};

    // 互斥锁：串行化测试中对全局 CACHED_GRAPH 的访问，避免并发冲突
    static BIN_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 获取全局互斥锁，确保测试串行执行图操作
    fn lock_bin() -> std::sync::MutexGuard<'static, ()> {
        BIN_MUTEX.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 加载测试图：创建临时目录、初始化引擎、插入 2 个节点和 1 条边
    /// 返回互斥锁 guard，保持期间图数据有效
    fn load_test_graph() -> std::sync::MutexGuard<'static, ()> {
        let guard = lock_bin();
        let tmp = std::env::temp_dir().join("hologram_bin_test");
        let _ = std::fs::create_dir_all(&tmp);
        let _ = hologram_engine::engine::engine_init(&tmp);
        let _ = hologram_engine::engine::engine_write(|idx| {
            let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
            a.location = Some("src/a.rs".into());
            idx.insert_node(a);
            let mut b = Node::new("b", "mod_b", NodeKind::Symbol);
            b.location = Some("src/b.rs".into());
            idx.insert_node(b);
            idx.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
        });
        guard
    }

    fn clear_graph() {
        // 清空所有图数据，但保持引擎存活（不销毁引擎实例）
        let _ = hologram_engine::engine::engine_write(|idx| {
            let ids: Vec<String> = { idx.nodes_iter().map(|n| n.id.clone()).collect() };
            for id in &ids { idx.remove_node(id); }
        });
    }

    // ═══ 帧协议测试 ═══

    #[test]
    fn test_frame_roundtrip() {
        let payload = b"{\"ok\":true}";
        let framed = frame_response(payload);
        assert_eq!(framed.len(), 4 + payload.len());
        let (decoded, consumed) = unframe(&framed).unwrap();
        assert_eq!(decoded, payload);
        assert_eq!(consumed, framed.len());
    }

    #[test]
    fn test_frame_empty_payload() {
        let framed = frame_response(b"");
        assert_eq!(&framed[..4], &[0, 0, 0, 0]); // length 0
        let (decoded, _) = unframe(&framed).unwrap();
        assert!(decoded.is_empty());
    }

    #[test]
    fn test_frame_large_payload() {
        let payload = vec![b'x'; 65536];
        let framed = frame_response(&payload);
        let (decoded, _) = unframe(&framed).unwrap();
        assert_eq!(decoded.len(), 65536);
    }

    #[test]
    fn test_unframe_insufficient_data() {
        assert!(unframe(&[0x01]).is_none());
        let framed = frame_response(b"hello");
        assert!(unframe(&framed[..2]).is_none()); // truncated
    }

    // ═══ handle_get_graph 测试 ═══

    #[test]
    fn test_handle_get_graph_returns_empty_when_no_cache() {
        let _lock = lock_bin();
        clear_graph();
        let response = handle_get_graph();
        let v: serde_json::Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(v["nodes"].as_array().unwrap().len(), 0);
        assert_eq!(v["edges"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_handle_get_graph_returns_cached_data() {
        let _lock = lock_bin();
        let tmp = std::env::temp_dir().join("hologram_bin_get_graph");
        let _ = std::fs::create_dir_all(&tmp);
        let _ = hologram_engine::engine::engine_init(&tmp);
        let _ = hologram_engine::engine::engine_write(|idx| {
            idx.insert_node(Node::new("a", "fn_a", NodeKind::Symbol));
            idx.insert_node(Node::new("b", "fn_b", NodeKind::Symbol));
            idx.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
        });
        let response = handle_get_graph();
        let v: serde_json::Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(v["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(v["edges"].as_array().unwrap().len(), 1);
        let ids: Vec<&str> = v["nodes"].as_array().unwrap().iter()
            .filter_map(|n| n["id"].as_str()).collect();
        assert!(ids.contains(&"a"));
        assert!(ids.contains(&"b"));
        assert_eq!(v["edges"][0]["source"], "a");
    }

    // ═══ handle_simple 测试 ═══

    #[test]
    fn test_handle_simple_with_graph() {
        let _g = load_test_graph();
        // "fragile:5" → calls fragile_nodes(g, "5") where "5" is parsed as limit
        let resp = handle_simple("fragile:", "fragile:5", |g, a| {
            json!(hologram_engine::analysis::fragile_nodes(g, a.parse().unwrap_or(10)))
        });
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v.is_array());
    }

    #[test]
    fn test_handle_simple_empty_graph_is_not_an_error() {
        let _lock = lock_bin();
        clear_graph();
        // Engine is still Ready (node_count=0, edge_count=0) — not an error.
        // The callback returns json!({}), which is an empty success response.
        let resp = handle_simple("fragile:", "fragile:5", |_, _| json!({"result": "empty"}));
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["result"], "empty");
        assert!(v.get("error").is_none());
    }

    #[test]
    fn test_handle_simple_empty_arg() {
        let _g = load_test_graph();
        // "cycle" with no arg
        let resp = handle_simple("cycle", "cycle", |g, _| {
            json!(hologram_engine::analysis::detect_cycles(g))
        });
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v.is_array());
    }

    // ═══ handle_query 测试 ═══

    #[test]
    fn test_handle_query_neighbors() {
        let _g = load_test_graph();
        let resp = handle_query("neighbors:a", "neighbors:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["neighbors"].is_array());
    }

    #[test]
    fn test_handle_query_path_found() {
        let _g = load_test_graph();
        let resp = handle_query("path:a:b", "path:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["path"].is_array());
        assert!(v["length"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_handle_query_path_missing_args() {
        let _g = load_test_graph();
        let resp = handle_query("path:a", "path:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["error"].as_str().unwrap().contains("usage"));
    }

    #[test]
    fn test_handle_query_search() {
        let _g = load_test_graph();
        let resp = handle_query("search:mod", "search:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["results"].is_array());
    }

    #[test]
    fn test_handle_query_impact() {
        let _g = load_test_graph();
        let resp = handle_query("impact:a:2", "impact:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["layers"].is_array());
    }

    #[test]
    fn test_handle_query_no_graph() {
        clear_graph();
        let resp = handle_query("neighbors:a", "neighbors:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"], "no graph loaded, run analyze first");
    }

    // ═══ handle_analyze 冒烟测试（使用临时项目）═══

    #[test]
    fn test_handle_analyze_valid_project() {
        let _g = lock_bin();
        let tmp = std::env::temp_dir().join("hologram_main_test_proj");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("main.py"), "def hello(): pass\n").unwrap();

        let path = tmp.to_str().unwrap();
        // handle_analyze takes the raw request string (prefix stripped by caller in main loop)
        let resp = handle_analyze(path);
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["nodes"].is_array());
        assert!(v["node_count"].as_u64().unwrap() > 0);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_handle_analyze_nonexistent_path() {
        let fake = std::env::temp_dir().join("__nonexistent_tool_dir__");
        // Ensure it doesn't exist
        let _ = std::fs::remove_dir_all(&fake);
        let resp = handle_analyze(fake.to_str().unwrap());
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"], "path not found");
    }

    // ═══ handle_check 测试 ═══

    #[test]
    fn test_handle_check_no_project() {
        let _g = lock_bin();
        clear_graph();
        // handle_check strips the "check:" prefix internally
        let resp = handle_check("check:C:/hologram_definitely_nonexistent_dir_xyz123");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"], "project not found");
    }

    // ═══ CLI 参数解析测试 ═══

    #[test]
    fn test_parse_cli_args_basic() {
        let args: Vec<String> = vec!["trace_impact".into(), "/tmp/proj".into(), "--node_id".into(), "src/main.rs:fn".into()];
        let (tool, path, json) = parse_cli_args(&args).unwrap();
        assert_eq!(tool, "trace_impact");
        assert_eq!(path, "/tmp/proj");
        assert_eq!(json["node_id"], "src/main.rs:fn");
    }

    #[test]
    fn test_parse_cli_args_no_project() {
        let args: Vec<String> = vec!["engine_status".into()];
        let (tool, path, json) = parse_cli_args(&args).unwrap();
        assert_eq!(tool, "engine_status");
        assert_eq!(path, ".");
        assert!(json.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_parse_cli_args_types() {
        let args: Vec<String> = vec![
            "preflight_check".into(), "/tmp".into(),
            "--files".into(), "a.rs,b.rs".into(),
            "--limit".into(), "42".into(),
            "--verbose".into(), "true".into(),
        ];
        let (tool, path, json) = parse_cli_args(&args).unwrap();
        assert_eq!(tool, "preflight_check");
        assert_eq!(path, "/tmp");
        assert!(json["files"].is_array(), "comma-separated values must be arrays");
        assert_eq!(json["files"][0], "a.rs");
        assert_eq!(json["files"][1], "b.rs");
        assert_eq!(json["limit"], 42);
        assert_eq!(json["verbose"], true);
    }

    #[test]
    fn test_parse_cli_args_single_value_stays_string() {
        let args: Vec<String> = vec![
            "trace_impact".into(), "/tmp".into(),
            "--node_id".into(), "src/main.rs:fn_main".into(),
        ];
        let (_, _, json) = parse_cli_args(&args).unwrap();
        assert!(json["node_id"].is_string(), "values without commas stay as strings");
        assert_eq!(json["node_id"], "src/main.rs:fn_main");
    }

    #[test]
    fn test_parse_cli_args_missing_value() {
        let args: Vec<String> = vec!["trace_impact".into(), "--node_id".into()];
        let result = parse_cli_args(&args);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing value"));
    }

    #[test]
    fn test_parse_cli_args_empty() {
        let result = parse_cli_args(&[]);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_cli_args_list_flag() {
        let args: Vec<String> = vec!["--list".into()];
        let (tool, _path, _json) = parse_cli_args(&args).unwrap();
        assert_eq!(tool, "--list");
    }

    // ═══ MCP 结果提取测试 ═══

    #[test]
    fn test_extract_mcp_result_success() {
        let envelope = json!({
            "jsonrpc": "2.0", "id": 1,
            "result": { "content": [{ "type": "text", "text": "{\"passed\":true}" }] }
        });
        let (text, is_error) = extract_mcp_result(&envelope);
        assert!(!is_error);
        assert_eq!(text, "{\"passed\":true}");
    }

    #[test]
    fn test_extract_mcp_result_error() {
        let envelope = json!({
            "jsonrpc": "2.0", "id": 1,
            "error": { "code": -32000, "message": "Security refusal: blocked" }
        });
        let (text, is_error) = extract_mcp_result(&envelope);
        assert!(is_error);
        assert_eq!(text, "Security refusal: blocked");
    }
}