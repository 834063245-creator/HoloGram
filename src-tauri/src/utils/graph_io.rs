// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 引擎图 IO — 分析/序列化/分页（从 utils.rs 拆出）

use hologram_engine as engine;
use engine::engine as engine_api;
use engine::community::detect_hierarchical_communities_with_base;
use engine::graph::Graph;
use engine::routing::preflight::save_baseline;
use engine::storage::MemoryIndex;

use tauri::Emitter;

use crate::utils::ipc_guard::lock_or_recover;
use crate::utils::{regenerate_file_graph, write_atomic};

fn cache_is_stale(root: &std::path::Path) -> bool {
    let graph_json = root.join("hologram_graph.json");
    let cache_mtime = match std::fs::metadata(&graph_json) {
        Ok(m) => match m.modified() {
            Ok(t) => t,
            Err(_) => return true, // 无法读取 mtime → 假设已过期
        },
        Err(_) => return true, // 无基线 → 已过期
    };

    const EXTS: &[&str] = &[
        ".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".rs", ".java", ".c",
        ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".rb", ".cs", ".kt", ".kts", ".swift",
        ".php", ".lua",
    ];
    const SKIP: &[&str] = &[
        ".git", "node_modules", "target", "build", "dist", "out", ".venv", "venv",
        ".hologram", "release-bin", "__pycache__", ".pytest_cache", ".ruff_cache",
        ".mypy_cache", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cursor",
        ".idea", ".vscode", ".coverage",
    ];

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                // 前缀规则与引擎 discovery.rs 保持一致：`.venv-lme` 等
                // 带后缀虚拟环境同样排除，避免其 mtime 频繁变化误判缓存过期。
                !(SKIP.iter().any(|d| name.as_ref() == *d)
                    || name.starts_with(".venv")
                    || name.starts_with("venv-")
                    || name.starts_with("venv_"))
            } else {
                true
            }
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let ext_dot = format!(".{}", ext);
        if !EXTS.contains(&ext_dot.as_str()) { continue; }
        if let Ok(meta) = path.metadata() {
            if let Ok(mtime) = meta.modified() {
                if mtime > cache_mtime {
                    eprintln!(
                        "[direct_analyze] 缓存已过期: {} 在上次分析后被修改",
                        path.display()
                    );
                    return true;
                }
            }
        }
    }
    false
}

pub(crate) fn direct_analyze(path: &str, force: bool) -> Result<String, String> {
    let root = std::path::PathBuf::from(path);
    if !root.exists() {
        return Err(format!("路径不存在: {path}"));
    }

    // 初始化引擎（幂等操作 — 加载 SQLite 缓存到内存）
    engine_api::engine_init(&root)
        .map_err(|e| format!("Engine init failed: {e}"))?;

    // ponytail: 如果 SQLite 缓存已有图数据且未强制重新分析，
    // 则跳过完整流水线。冷启动约需 420s；热重载 <1s。
    // 但首先需验证缓存新鲜度 — 若任何源文件在上次分析后被修改，
    // 缓存已过期，必须重建。否则在 HoloGram 外部所做的代码修改
    // （例如在 VS Code 中跨会话修改）将静默不可见，直到用户手动点击"重新分析"。
    if !force {
        let cached_node_count = engine_api::engine_read(|idx| idx.node_count())
            .unwrap_or(0);
        if cached_node_count > 0 && !cache_is_stale(&root) {
            eprintln!("[direct_analyze] 使用缓存图 ({cached_node_count} 个节点)，跳过完整分析");
        // 在回调内从缓存序列化 — 避免克隆整个 Graph
        return engine_api::engine_read_graph(|graph| {
            let nc = graph.node_count();
            let ec = graph.edge_count();
            let nodes: Vec<serde_json::Value> = graph.nodes_map().values().map(|n| serde_json::json!({
                "id": n.id, "name": n.name, "type": n.kind.as_str(),
                "location": n.location, "in_degree": n.in_degree,
                "out_degree": n.out_degree, "properties": n.properties,
                "position": n.position, "community_id": n.community_id,
            })).collect();
            let edges: Vec<serde_json::Value> = graph.edges_map().values().map(|e| serde_json::json!({
                "id": e.id, "source": e.source, "target": e.target,
                "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
                "cross_file": e.cross_file,
                "temporal_delay_sec": e.temporal_delay_sec,
            })).collect();
            let mut comm_map: std::collections::HashMap<usize, Vec<&str>> = std::collections::HashMap::new();
            for n in graph.nodes_map().values() {
                if let Some(cid) = n.community_id {
                    comm_map.entry(cid).or_default().push(&n.id);
                }
            }
            let comms: Vec<serde_json::Value> = comm_map.iter()
                .map(|(cid, node_ids)| {
                    let nids: Vec<String> = node_ids.iter().map(|s| s.to_string()).collect();
                    let label = derive_community_label(&nids);
                    serde_json::json!({"id": format!("comm_{}", cid), "size": nids.len(), "node_ids": nids, "label": label})
                })
                .collect();
            serde_json::json!({
                "ok": true, "node_count": nc, "edge_count": ec,
                "nodes": nodes, "edges": edges, "communities": comms,
                "hierarchical_communities": [],
                "cached": true,
            }).to_string()
        }).map_err(|e| format!("Read cached graph failed: {e}"));
    }
    } // if !force 结束

    let result = engine_api::engine_analyze(&root)
        .map_err(|e| format!("Analyze failed: {e}"))?;

    // result.graph 已被引擎消费（节点/边已移至 MemoryIndex/store）。
    // 使用 result.node_count / result.edge_count 获取标量值，
    // 从 store 读取图数据进行序列化。
    let nc = result.node_count;
    let ec = result.edge_count;

    // 从图 store 序列化（数据已由 engine_analyze 交换入）
    let serialized = serialize_cached_graph(path)?;
    let wrapped: serde_json::Value = serde_json::from_str(&serialized)
        .unwrap_or(serde_json::json!({"nodes":[],"edges":[],"communities":[]}));
    let nodes = wrapped.get("nodes").cloned().unwrap_or(serde_json::json!([]));
    let edges = wrapped.get("edges").cloned().unwrap_or(serde_json::json!([]));
    let comms = wrapped.get("communities").cloned().unwrap_or(serde_json::json!([]));
    // 层次社区来自 result（未被消费）
    let hcomms: Vec<serde_json::Value> = result.hierarchical_communities.iter()
        .map(|hc| serde_json::json!({
            "id": hc.id,
            "label": hc.label,
            "node_ids": hc.node_ids,
            "level": hc.level,
            "parent_id": hc.parent_id,
        }))
        .collect();

    // 持久化 hologram_graph.json 供冷启动使用
    let graph_path = format!("{}/hologram_graph.json", path);
    let wrapped = serde_json::json!({
        "meta": { "source_root": path,
            "generated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            "version": "0.1.0", "node_count": nc, "edge_count": ec },
        "nodes": nodes, "edges": edges, "communities": comms,
        "hierarchical_communities": hcomms,
    });
    // 原子写：大图数百 MB 写入窗口长，中途崩溃留下截断 JSON
    // 会被冷启动原样读回（雷区地图 P0-4）；失败必须可见（宪法·错误不静默）
    if let Err(e) = write_atomic(&graph_path, &serde_json::to_string(&wrapped).unwrap_or_default()) {
        eprintln!("[hologram] hologram_graph.json 落盘失败（冷启动缓存缺失）: {e}");
    }
    // 每次全量分析后都更新基线，使后续检查
    // 与最新快照进行对比 — 防止基线过期导致的误报
    // （例如图结构在两次分析间演化时出现"53 个新循环"）。
    let _ = engine_api::engine_read_graph(|g| save_baseline(&root, g));
    // .hologram MsgPack 已废弃 — CACHED_GRAPH 是唯一的运行时真相，JSON 仅用于冷启动归档
    let _ = std::fs::remove_file(format!("{}/hologram_graph.hologram", path));
    let _ = regenerate_file_graph(path);

    // 记录时间线事件（与引擎二进制的 handle_analyze 对应）
    let _ = engine_api::engine_record_timeline(
        "analyze",
        None::<&str>,
        &format!("全量分析完成：{} 节点, {} 边, {:.1}s", nc, ec, result.elapsed_secs),
    );

    Ok(serde_json::json!({
        "status": "ok", "total_nodes": nc, "total_edges": ec,
        "communities": result.community_count, "elapsed_secs": result.elapsed_secs,
        "node_count": nc, "edge_count": ec,
    }).to_string())
}
// （2026-08-04 清理：with_graph 全库零调用，已删 — 查询统一走 with_index/MemoryIndex）

/// 在 MemoryIndex（基于 CSR，O(1) 邻接查询）上运行查询。
pub(crate) fn with_index<F: FnOnce(&MemoryIndex) -> serde_json::Value>(f: F) -> Result<String, String> {
    engine_api::engine_read(|idx| {
        serde_json::to_string(&f(idx)).unwrap_or_default()
    })
    .map_err(|e| format!("Engine error: {}", e))
}

/// 序列化完整图 JSON — 前端和 analyze_and_load 共用。
/// 仅从 Engine 读取。
pub(crate) fn serialize_cached_graph(source_root: &str) -> Result<String, String> {
    engine_api::engine_read_graph(|g| {
        let nodes: Vec<serde_json::Value> = g.nodes_map().values().map(|n| serde_json::json!({
            "id": n.id, "name": n.name, "type": n.kind.as_str(),
            "location": n.location, "in_degree": n.in_degree,
            "out_degree": n.out_degree,
            "properties": n.properties, "position": n.position,
            "community_id": n.community_id,
        })).collect();
        let edges: Vec<serde_json::Value> = g.edges_map().values().map(|e| serde_json::json!({
            "id": e.id, "source": e.source, "target": e.target,
            "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
            "cross_file": e.cross_file,
            "temporal_delay_sec": e.temporal_delay_sec,
        })).collect();
        let meta = serde_json::json!({
            "source_root": source_root,
            "node_count": g.node_count(),
            "edge_count": g.edge_count(),
        });
        serde_json::to_string(&serde_json::json!({"meta": meta, "nodes": nodes, "edges": edges, "communities": build_level0_communities_json(g), "hierarchical_communities": build_hierarchical_communities_json(g)})).unwrap_or_default()
    })
    .map_err(|e| format!("Engine error: {}", e))
}

/// 从每个节点上预计算的 community_id 重建 level-0 社区
/// （避免重新运行 Louvain，其复杂度为 O(V·avg_degree·iterations)）
/// community_id 是 Option<usize> → JSON 数字，而非字符串。
fn build_level0_communities_json(g: &Graph) -> serde_json::Value {
    let mut comm_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for n in g.nodes_map().values() {
        if let Some(cid) = n.community_id {
            comm_map.entry(cid.to_string()).or_default().push(n.id.to_string());
        }
    }
    serde_json::to_value(
        comm_map.iter().map(|(cid, node_ids)| {
            // 从最常见的文件前缀推导可读标签
            let label = derive_community_label(node_ids);
            serde_json::json!({"id": cid, "size": node_ids.len(), "node_ids": node_ids, "label": label})
        }).collect::<Vec<_>>(),
    ).unwrap_or(serde_json::json!([]))
}

/// 层次社区 — 从 node.community_id 重建基础社区
/// （在分析阶段已设置），然后仅运行 Phase 2 凝聚。
/// 避免每次序列化时重新运行 Phase 1 detect_communities。
fn build_hierarchical_communities_json(g: &Graph) -> serde_json::Value {
    let mut base_map: std::collections::HashMap<usize, Vec<String>> = std::collections::HashMap::new();
    for n in g.nodes_map().values() {
        if let Some(cid) = n.community_id {
            base_map.entry(cid).or_default().push(n.id.as_str().to_owned());
        }
    }
    let base: Vec<Vec<String>> = base_map.values().cloned().collect();
    let hcommunities = detect_hierarchical_communities_with_base(g, base, 42);
    serde_json::to_value(
        hcommunities.iter().map(|hc| serde_json::json!({
            "id": hc.id,
            "label": hc.label,
            "node_ids": hc.node_ids,
            "level": hc.level,
            "parent_id": hc.parent_id,
        })).collect::<Vec<_>>(),
    ).unwrap_or(serde_json::json!([]))
}

// ═══════════════════════════════════════════════════════════════
// 图分页 — landmine-map.md P0-2 欠账清账（雷 2：大响应无尺寸上限）
// ═══════════════════════════════════════════════════════════════
// 大仓库（kernel 级）全量图 JSON 可达数百 MB，超过 IPC 硬上限
// （guard_ipc_size 128MB）会直接报错导致工作区无法打开。分页方案：
// 1. 节点按 id 字典序排序后切成等宽页（页数 = ceil(V / page_size)），
//    页边界缓存只存每页首个 id（内存可忽略），缓存键含
//    (source_root, node_count, edge_count, page_size) — 图变更自动失效。
//    每页响应远小于护栏；重复拉页不会跨页漏节点（边界重建时节点
//    只会移位到相邻页，前端按 id 去重吸收）。
// 2. 第 k 页只回「两端点均位于 0..=k 页」的边 — 前端逐页合并后
//    边集单调收敛到全图。
// 3. 社区数据不随页下发（节点自带 community_id，前端渐进重建 level-0）；
//    hierarchical_communities 仅最后一页携带（O(社区) 凝聚只做一次）。
pub(crate) const GRAPH_PAGE_DEFAULT_NODES: usize = 12_000;

struct PageIndexCache {
    key: (String, usize, usize, usize),
    boundaries: Vec<String>,
}

static PAGE_INDEX_CACHE: std::sync::LazyLock<std::sync::Mutex<Option<PageIndexCache>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// 构建/复用分页索引，返回 (页边界 id 列表, 节点总数)。
/// 边界 = 每页第一个 id（字典序）；page_of(id) = 二分定位。
fn graph_page_index(source_root: &str, page_size: usize) -> Result<(Vec<String>, usize), String> {
    let (node_count, edge_count) = engine_api::engine_read_graph(|g| (g.node_count(), g.edge_count()))
        .map_err(|e| format!("Engine error: {e}"))?;
    let key = (source_root.to_owned(), node_count, edge_count, page_size);
    {
        let cache = lock_or_recover(&PAGE_INDEX_CACHE);
        if let Some(c) = cache.as_ref() {
            if c.key == key {
                return Ok((c.boundaries.clone(), node_count));
            }
        }
    }
    let boundaries: Vec<String> = engine_api::engine_read_graph(|g| {
        let mut ids: Vec<String> = g.nodes_map().values().map(|n| n.id.to_string()).collect();
        ids.sort_unstable();
        let total_pages = if ids.is_empty() { 0 } else { (ids.len() + page_size - 1) / page_size };
        (0..total_pages).map(|p| ids[p * page_size].clone()).collect()
    })
    .map_err(|e| format!("Engine error: {e}"))?;
    *lock_or_recover(&PAGE_INDEX_CACHE) = Some(PageIndexCache { key, boundaries: boundaries.clone() });
    Ok((boundaries, node_count))
}

/// 图谱 meta + 分页信息 — 工作区切换/冷启动的轻量响应（替代全量图 JSON）。
pub(crate) fn graph_meta_json(source_root: &str, page_size: usize) -> Result<String, String> {
    let (boundaries, node_count) = graph_page_index(source_root, page_size)?;
    let total_pages = boundaries.len();
    let edge_count = engine_api::engine_read_graph(|g| g.edge_count())
        .map_err(|e| format!("Engine error: {e}"))?;
    Ok(serde_json::json!({
        "meta": {"source_root": source_root, "node_count": node_count, "edge_count": edge_count},
        "paged": true,
        "page_size": page_size,
        "total_pages": total_pages,
        "has_more": total_pages > 0,
    }).to_string())
}

/// 序列化第 page 页（0 基）。边只含两端点均已被 ≤page 页覆盖的边。
/// 最后一页附带完整 communities + hierarchical_communities。
pub(crate) fn serialize_graph_page(source_root: &str, page: usize, page_size: usize) -> Result<String, String> {
    let (boundaries, node_count) = graph_page_index(source_root, page_size)?;
    let total_pages = boundaries.len();
    if total_pages == 0 {
        return Err(format!("图谱为空，无法分页: {source_root}"));
    }
    if page >= total_pages {
        return Err(format!("图谱分页越界: page={page}, total_pages={total_pages}"));
    }
    let page_of = |id: &str| -> usize {
        boundaries.partition_point(|b| b.as_str() <= id).saturating_sub(1)
    };
    let last_page = page + 1 == total_pages;
    let (nodes, edges, edge_count, communities, hcommunities) = engine_api::engine_read_graph(|g| {
        let nodes: Vec<serde_json::Value> = g.nodes_map().values()
            .filter(|n| page_of(&n.id) == page)
            .map(|n| serde_json::json!({
                "id": n.id, "name": n.name, "type": n.kind.as_str(),
                "location": n.location, "in_degree": n.in_degree,
                "out_degree": n.out_degree,
                "properties": n.properties, "position": n.position,
                "community_id": n.community_id,
            }))
            .collect();
        let edges: Vec<serde_json::Value> = g.edges_map().values()
            .filter(|e| page_of(&e.source) <= page && page_of(&e.target) <= page)
            .map(|e| serde_json::json!({
                "id": e.id, "source": e.source, "target": e.target,
                "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
                "cross_file": e.cross_file,
                "temporal_delay_sec": e.temporal_delay_sec,
            }))
            .collect();
        let communities = if last_page { Some(build_level0_communities_json(g)) } else { None };
        let hcommunities = if last_page { Some(build_hierarchical_communities_json(g)) } else { None };
        (nodes, edges, g.edge_count(), communities, hcommunities)
    })
    .map_err(|e| format!("Engine error: {e}"))?;
    let mut payload = serde_json::json!({
        "meta": {"source_root": source_root, "node_count": node_count, "edge_count": edge_count},
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "has_more": !last_page,
        "nodes": nodes,
        "edges": edges,
    });
    if let Some(c) = communities {
        payload["communities"] = c;
    }
    if let Some(h) = hcommunities {
        payload["hierarchical_communities"] = h;
    }
    Ok(payload.to_string())
}

/// 确保引擎内存图属于 source_root 且非空（仅加载 SQLite 缓存，不触发分析）。
/// 工作区切换后引擎图可能是上一个仓库的 — 必须切回来，否则分页会错乱。
pub(crate) fn ensure_engine_graph(source_root: &str) -> Result<(), String> {
    let same_root = engine_api::with_engine(|e| {
        e.project_root() == std::path::Path::new(source_root) && e.is_ready()
    })
    .unwrap_or(false);
    if !same_root {
        engine_api::engine_init(std::path::Path::new(source_root))
            .map_err(|e| format!("Engine init failed: {e}"))?;
    }
    let node_count = engine_api::engine_read(|idx| idx.node_count()).unwrap_or(0);
    if node_count == 0 {
        return Err(format!("引擎中无图谱数据: {source_root}（请先执行分析）"));
    }
    Ok(())
}

/// 从社区的成员节点 ID 推导可读标签。
/// 使用节点 ID 中最常见的文件路径片段。
pub(crate) fn derive_community_label(node_ids: &[String]) -> String {
    use std::collections::HashMap;
    let mut prefix_counts: HashMap<String, usize> = HashMap::new();
    for nid in node_ids {
        // 节点 ID 通常为 "file_path:line" 或 "file_path::symbol"
        // 提取顶级目录或文件名
        let file = nid.split(':').next().unwrap_or(nid);
        let parts: Vec<&str> = file.split(['/', '\\']).collect();
        // 尝试获取有意义的前缀：路径的前 1-2 段
        let prefix = if parts.len() >= 2 {
            format!("{}/{}", parts[parts.len().saturating_sub(2)], parts[parts.len() - 1])
        } else {
            file.to_string()
        };
        *prefix_counts.entry(prefix).or_default() += 1;
    }
    // 选择最常见的前缀，若无则回退到第一个节点
    prefix_counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(prefix, _)| prefix)
        .unwrap_or_else(|| "社区".to_string())
}

#[allow(dead_code)] // 供 main.rs 中的测试使用
pub(crate) fn diff_to_json(before: &Graph, after: &Graph) -> serde_json::Value {
    let d = before.diff(after);
    let added_nodes: Vec<_> = d.added_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
        "location": n.location,
    })).collect();
    let removed_nodes: Vec<_> = d.removed_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
    })).collect();
    let modified_nodes: Vec<_> = d.modified_nodes.iter().map(|(old, new)| serde_json::json!({
        "node_id": new.id, "name": new.name,
        "old_kind": old.kind.as_str(), "new_kind": new.kind.as_str(),
    })).collect();
    let is_empty = added_nodes.is_empty() && removed_nodes.is_empty() && modified_nodes.is_empty();
    serde_json::json!({
        "is_empty": is_empty,
        "added_nodes": added_nodes,
        "removed_nodes": removed_nodes,
        "modified_nodes": modified_nodes,
        "added_edges": d.added_edges.len(),
        "removed_edges": d.removed_edges.len(),
    })
}

pub(crate) async fn run_analyze_with_progress(target: String, app: tauri::AppHandle, force: bool) -> Result<String, String> {
    let target_clone = target.clone();
    let app_clone = app.clone();
    let scheduled = std::time::Instant::now();

    // 在阻塞线程中启动分析
    let mut analyze_handle = tokio::task::spawn_blocking(move || {
        direct_analyze(&target_clone, force)
    });

    // 轮询进度直到阻塞任务完成（不要在 Ready 时提前退出 —
    // 排队中的分析在 analyze_lock 上等待，此时状态保持 Ready）。
    loop {
        tokio::select! {
            res = &mut analyze_handle => {
                match res {
                    Ok(result) => return result,
                    Err(e) => return Err(format!("分析任务失败: {}", e)),
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                let state = engine_api::engine_state();
                match state {
                    engine_api::EngineState::Analyzing { phase, current, total, file, started_at_ms, .. } => {
                        let _ = app_clone.emit("analyze-phase", serde_json::json!({
                            "phase": phase.clone(),
                            "message": phase,
                        }));
                        if total > 0 {
                            let _ = app_clone.emit("analyze-progress", serde_json::json!({
                                "current": current,
                                "total": total,
                                "file": file,
                            }));
                        }
                        let now_ms = chrono::Utc::now().timestamp_millis() as u64;
                        let elapsed = now_ms.saturating_sub(started_at_ms);
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": phase,
                            "elapsed": format!("{:.1}s", elapsed as f64 / 1000.0),
                        }));
                    }
                    _ => {
                        let elapsed_s = scheduled.elapsed().as_secs_f64();
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": "等待分析引擎",
                            "elapsed": format!("{:.1}s", elapsed_s),
                        }));
                    }
                }
            }
        }
    }
}