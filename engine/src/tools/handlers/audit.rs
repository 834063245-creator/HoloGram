use serde_json::{json, Value};
use crate::analysis::*;
use crate::engine;
use crate::graph::Node;
use crate::tools::handlers::{strip_loc_suffix, LspCheck, lsp_has_real_reference};
use crate::tools::{get_usize, project_root, with_store};
use crate::tools::ToolResponse;

pub(crate) fn handler_status(_args: &Value) -> ToolResponse {
    // 仅在未初始化或项目根目录变更时预热 LSP 池。
    //（不在每次 engine_status 轮询时重启健康的服务器。）
    // 按已索引节点中真实出现的扩展名过滤，避免把 9 个 LSP
    // 服务器全部 spawn 一遍。
    {
        let proj = project_root();
        let root = if proj.as_os_str().is_empty() {
            std::env::current_dir().unwrap_or_default()
        } else {
            proj
        };
        let root_str = root.to_string_lossy().to_string();
        if !crate::lsp_manager::LspManager::is_initialized()
            || crate::lsp_manager::LspManager::root_changed(&root_str)
        {
            let mut lsp_exts: Vec<String> = Vec::new();
            let _ = engine::engine_read(|idx| {
                for node in idx.nodes_iter() {
                    if let Some(file) = node.file() {
                        if let Some(ext) = std::path::Path::new(file)
                            .extension()
                            .and_then(|e| e.to_str())
                        {
                            let ext = ext.to_ascii_lowercase();
                            if !lsp_exts.contains(&ext) {
                                lsp_exts.push(ext);
                            }
                        }
                    }
                }
            });
            std::thread::spawn(move || {
                if lsp_exts.is_empty() {
                    // 尚无索引（首次打开/分析中）：保留旧的保守行为。
                    crate::lsp_manager::LspManager::warm(&root_str);
                } else {
                    let ext_filter: Vec<&str> = lsp_exts.iter().map(|s| s.as_str()).collect();
                    crate::lsp_manager::LspManager::warm_filtered(&root_str, &ext_filter);
                }
            });
        }
    }
    // LSP 状态独立于引擎状态 —— 始终收集
    let lsp = crate::lsp_manager::LspManager::lsp_status();
    let lsp_available: Vec<&str> = lsp.iter()
        .filter(|s| s["available"].as_bool().unwrap_or(false))
        .map(|s| s["language_id"].as_str().unwrap_or(""))
        .collect();
    let lsp_missing: Vec<&str> = lsp.iter()
        .filter(|s| !s["available"].as_bool().unwrap_or(false))
        .map(|s| s["language_id"].as_str().unwrap_or(""))
        .collect();
    let lsp_data = json!({
        "available": lsp_available,
        "missing": lsp_missing,
        "servers": lsp,
    });

    let state = engine::engine_state();
    match engine::engine_read(|idx| (idx.node_count(), idx.edge_count(), idx.has_aux_indexes())) {
        Ok((nodes, edges, has_aux)) => {
            let phase = match state {
                engine::EngineState::Ready { .. } => "ready",
                engine::EngineState::Analyzing { .. } => "analyzing",
                engine::EngineState::Loading { .. } => "loading",
                engine::EngineState::Uninitialized => "empty",
                engine::EngineState::Error(_) => "error",
            };
            let is_watching = engine::with_engine(|eng| eng.is_watching()).unwrap_or(false);
            let vi_path = project_root().join(".hologram").join("vectors.usearch");
            let vi_exists = vi_path.exists();
            // 走进程级缓存（mtime 失效）——不再每次 status 调用都从磁盘全量加载索引
            let vi_count = if vi_exists {
                crate::vector::get_or_load_index(&project_root())
                    .map(|(_, slots)| slots.read().unwrap_or_else(|e| e.into_inner()).len())
                    .unwrap_or(0)
            } else { 0 };
            ToolResponse::Success(json!({
                "phase": phase,
                "store": "MemoryIndex",
                "nodes": nodes,
                "edges": edges,
                "has_aux_indexes": has_aux,
                "is_watching": is_watching,
                "vector_index": { "exists": vi_exists, "vectors": vi_count, "backend": crate::vector::backend_id() },
                "lsp": lsp_data,
            }))
        }
        Err(_) => ToolResponse::Success(json!({
            "phase": "empty",
            "store": "none",
            "nodes": 0,
            "edges": 0,
            "lsp": lsp_data,
        })),
    }
}

pub(crate) fn handler_policy_check(args: &Value) -> ToolResponse {
    let rules: Value = if let Some(r) = args.get("rules").cloned() {
        r
    } else if let (Some(source), Some(target)) = (
        args.get("source").and_then(|v| v.as_str()),
        args.get("target").and_then(|v| v.as_str()),
    ) {
        let mut rule = json!({
            "name": "ad-hoc",
            "source": source,
            "target": target,
            "message": format!("{} -> {} dependency violation", source, target),
        });
        if let Some(kinds) = args.get("edge_kinds") {
            rule["edge_kinds"] = kinds.clone();
        }
        json!([rule])
    } else {
        return ToolResponse::Degraded {
            guidance: "Provide either 'rules' (array of rule objects) or both 'source' and 'target' (string patterns).".into(),
            fallback: "Define boundary rules with source/target file patterns".into(),
            details: json!({}),
        };
    };
    ToolResponse::Success(with_store(|idx| policy_check_from_index(idx, &rules)))
}


fn is_entry_point(node: &Node) -> bool {
    let name = &node.name;
    let raw_loc = node.location.as_deref().unwrap_or("");
    let loc = strip_loc_suffix(raw_loc);

    // 二进制入口点（任何语言的 main）
    if name == "main" {
        return true;
    }
    // 类构造函数（在 JS/TS 中通过 `new` 关键字调用）
    if name == "constructor" || name.ends_with(".constructor") {
        return true;
    }
    // 测试函数（由测试框架动态发现）
    if name.starts_with("test_") || name.ends_with("_test") || name.ends_with("Test") {
        return true;
    }
    // Tauri 命令分发器（通过 #[command] 宏注册）
    if name == "rpc" && loc.contains("rpc.rs") {
        return true;
    }
    // 引擎流水线入口
    if name == "run_pipeline" {
        return true;
    }
    // Tauri 命令处理器模块（在 commands/ 目录中，由宏注册）
    if loc.contains("/commands/") || loc.contains("\\commands\\") {
        return true;
    }
    // React/Vue 组件入口点
    if name == "App" && (loc.ends_with("App.tsx") || loc.ends_with("App.ts")) {
        return true;
    }
    // 框架初始化/引导函数
    if name == "init" && node.out_degree > 3 {
        return true;
    }
    // ponytail：跨语言的常见入口点名称模式。
    // 这些函数由框架/CLI/测试运行器调用，
    // 而非通过直接的 CALLS 边 —— 静态分析无法看到它们。
    const ENTRY_PATTERNS: &[&str] = &[
        "handle", "process", "run", "start", "stop", "serve",
        "migrate", "setup", "teardown", "bootstrap", "execute",
        "configure", "initialize", "load",
    ];
    let name_lower = name.to_lowercase();
    for pat in ENTRY_PATTERNS {
        if name_lower.starts_with(pat) || name_lower.ends_with(pat) {
            return true;
        }
    }
    false
}

/// 检查节点名称是否为 mock/stub 测试夹具。
/// 这些由测试框架连接引用，而非直接的 CALLS 边。
fn is_mock_or_stub(name: &str) -> bool {
    // mockSomething, MockXxx, createMockXxx
    if name.starts_with("mock") || name.starts_with("Mock") || name.starts_with("createMock") {
        return true;
    }
    // somethingMock, dbStub, s3Fake, userSpy（这些是代码标识符，保留英文）
    for suffix in &["Mock", "Stub", "Fake", "Spy"] {
        if name.ends_with(suffix) {
            return true;
        }
    }
    false
}

/// 通过元类/DI/框架魔法实例化的框架基类，
/// 而非通过直接的 CALLS 边。继承自其中之一意味着该类是
/// 框架管理的 —— 不是死代码。
fn is_framework_base(name: &str) -> bool {
    matches!(
        name,
        // Python ORM / Pydantic
        "Base" | "DeclarativeBase" | "Model" | "BaseModel" | "BaseSettings"
        | "db.Model" | "TableBase"
        // AWS CDK / IaC 构造
        | "Stack" | "NestedStack" | "Construct" | "Resource"
        // Django REST / DRF
        | "Serializer" | "ViewSet" | "ModelViewSet"
        // Android / 移动端
        | "Activity" | "Fragment" | "ViewModel" | "Service"
        // Spring / Java EE
        | "Application" | "Configuration"
    )
}

/// React/Vue/Android 生命周期方法 —— 由框架调用，
/// 从不通过直接的 CALLS 边。
fn is_lifecycle_method(name: &str) -> bool {
    matches!(
        name,
        "render" | "componentDidMount" | "componentWillUnmount" | "componentDidUpdate"
        | "shouldComponentUpdate" | "getDerivedStateFromProps" | "getSnapshotBeforeUpdate"
        | "mounted" | "created" | "destroyed" | "beforeMount" | "beforeDestroy"
        | "updated" | "activated" | "deactivated"
        | "onCreate" | "onDestroy" | "onStart" | "onStop" | "onResume" | "onPause"
        | "ngOnInit" | "ngOnDestroy" | "ngOnChanges" | "ngAfterViewInit"
    )
}

pub(crate) fn handler_unused(args: &Value) -> ToolResponse {
    let limit = get_usize(args, "limit", 20).min(200);
    let kind_str = args
        .get("kind_filter")
        .and_then(|v| v.as_str())
        .unwrap_or("function,class");
    let kind_label = kind_str.to_string();
    let kinds: Vec<&str> = kind_str.split(',').map(|s| s.trim()).collect();

    // ponytail：先在读锁内收集候选（轻量快照），锁外做 LSP 验证。
    // LSP references 可能触发 server warm（耗时数百 ms），不能持图锁。
    let mut candidates: Vec<Value> = match engine::engine_read(|idx| {
        idx.nodes_iter()
            .filter(|n| {
                n.non_defines_in_degree == 0
                    && kinds.iter().any(|k| n.kind.as_str() == *k)
                    && !is_entry_point(n)
                    && !is_mock_or_stub(&n.name)
                    && !is_framework_base(&n.name)
                    && !is_lifecycle_method(&n.name)
            })
            .map(|n| json!({
                "id": n.id,
                "name": n.name,
                "kind": n.kind.as_str(),
                "location": n.location,
                "out_degree": n.out_degree,
                "in_degree": n.in_degree,
                "non_defines_in_degree": n.non_defines_in_degree,
                "community_id": n.community_id,
            }))
            .collect()
    }) {
        Ok(v) => v,
        Err(e) => return ToolResponse::Degraded {
            guidance: format!("cannot access graph: {}", e),
            fallback: "Ensure the project has been analyzed first".into(),
            details: json!({}),
        },
    };

    // LSP 验证：对能定位到源码位置的候选查 references，
    // 有非定义引用（如 React JSX/对象属性使用）则不是死代码。
    // 这修复名字匹配失败导致的误报 —— 图上看不到引用，但
    // 类型系统（LSP）能确认它被使用。
    //
    // 防护：只验证 out_degree 最高的前 LSP_VERIFY_LIMIT 个候选
    // （最可疑的优先），避免批量 open_file+references 把 LSP server
    // 打崩；且任一次查询失败即停止（server 不可用时反复重试只会
    // 浪费时间），失败的候选按原判断保留。
    const LSP_VERIFY_LIMIT: usize = 50;
    candidates.sort_by_key(|n| std::cmp::Reverse(n["out_degree"].as_u64().unwrap_or(0)));
    let verify_count = candidates.len().min(LSP_VERIFY_LIMIT);
    let mut lsp_verified_removed = 0usize;
    let mut verified: Vec<Value> = Vec::with_capacity(candidates.len());
    for (i, cand) in candidates.iter().enumerate() {
        if i < verify_count {
            let loc = cand["location"].as_str().unwrap_or("");
            let name = cand["name"].as_str().unwrap_or("");
            match lsp_has_real_reference(loc, name) {
                LspCheck::HasReference => {
                    lsp_verified_removed += 1;
                    continue;
                }
                LspCheck::NoReference => {}
                LspCheck::Unavailable => {
                    // LSP 挂了——停止验证，剩余候选全部保留
                    verified.push(cand.clone());
                    verified.extend(candidates[i + 1..].iter().cloned());
                    break;
                }
            }
        }
        verified.push(cand.clone());
    }

    verified.sort_by_key(|n| std::cmp::Reverse(n["out_degree"].as_u64().unwrap_or(0)));
    let total = verified.len();
    verified.truncate(limit);
    ToolResponse::Success(json!({
        "total_unused": total,
        "limit": limit,
        "kind_filter": kind_label,
        "lsp_verified_removed": lsp_verified_removed,
        "unused": verified,
    }))
}
