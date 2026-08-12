// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! gRPC / protobuf 服务检测 — 将 `.proto` 服务定义合成进依赖图。
//!
//! 三层连接：
//!   1. 服务端定义：`.proto` 的 `service`/`rpc` → 每 rpc 一个 Symbol 节点
//!      （`properties.kind = "grpc"`，name = `"Service.Method"`）
//!   2. 实现匹配：图中同名函数/方法节点 → 合成 Calls 边（channel `"grpc"`）
//!   3. 客户端调用：`client.Method(...)` 调用点 → 合成 Calls 边（channel `"grpc-client"`）
//!
//! 设计约束：
//!   - 轻量正则解析（proto 语法简单，无需 tree-sitter grammar / .scm）
//!   - `.proto` 不在阶段 1 扩展名白名单，检测器自行 walk 发现
//!   - 客户端匹配只做同文件变量跟踪，跨文件宁缺毋滥（防噪音）
//!   - 方法名归一化（去非字母数字 + 小写）：`SayHello` / `sayHello` / `say_hello` 等价

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::json;

use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

/// 单个 rpc 方法定义（从 .proto 提取）
struct RpcDef {
    file: String,
    line: usize,
    package: String,
    service: String,
    method: String,
    input: String,
    output: String,
    streaming: bool,
}

/// 客户端连接识别结果：变量名 → 服务名
struct ClientBinding {
    var: String,
    service: String,
}

/// 方法名归一化：去非字母数字 + 小写。`SayHello`/`sayHello`/`say_hello` → `sayhello`
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 收集项目根下的 .proto 文件（尊重 discovery 的忽略规则）
fn collect_proto_files(root: &Path, out: &mut Vec<String>) {
    let mut seen: HashSet<String> = HashSet::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !crate::pipeline::discovery::is_ignored_path(&e.path().to_string_lossy()))
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() { continue; }
        let p = entry.path().to_string_lossy().replace('\\', "/");
        if p.to_lowercase().ends_with(".proto") && seen.insert(p.clone()) {
            out.push(p);
        }
    }
}

/// 逐行解析 proto：跟踪 package / service 状态，提取 rpc 定义（含行号）
fn parse_proto(file: &str, source: &str, defs: &mut Vec<RpcDef>) {
    let package_re = regex::Regex::new(r#"^\s*package\s+([\w.]+)\s*;"#).unwrap();
    let service_re = regex::Regex::new(r#"^\s*service\s+(\w+)\s*\{"#).unwrap();
    let rpc_re = regex::Regex::new(
        r#"^\s*rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*;"#,
    )
    .unwrap();

    let mut package = String::new();
    let mut service = String::new();
    for (i, line) in source.lines().enumerate() {
        if let Some(c) = package_re.captures(line) {
            package = c.get(1).unwrap().as_str().to_string();
        }
        if let Some(c) = service_re.captures(line) {
            service = c.get(1).unwrap().as_str().to_string();
        }
        if let Some(c) = rpc_re.captures(line) {
            let method = c.get(1).unwrap().as_str().to_string();
            let input_stream = c.get(2).is_some();
            let input = c.get(3).unwrap().as_str().to_string();
            let output_stream = c.get(4).is_some();
            let output = c.get(5).unwrap().as_str().to_string();
            defs.push(RpcDef {
                file: file.to_string(),
                line: i + 1,
                package: package.clone(),
                service: service.clone(),
                method,
                input,
                output,
                streaming: input_stream || output_stream,
            });
        }
    }
}

/// 在图内查找实现函数：优先 name 精确匹配（大小写不敏感），
/// 其次限定名后缀（`foo::SayHello` / `Foo.sayHello`）。找不到返回 None（缺口可见）。
fn find_impl_node(graph: &Graph, method: &str) -> Option<String> {
    let want = normalize(method);
    let mut suffix: Option<String> = None;
    for (nid, node) in graph.nodes_iter() {
        if node.kind != NodeKind::Function && node.kind != NodeKind::Class {
            continue;
        }
        if normalize(&node.name) == want {
            return Some(nid.to_string());
        }
        if suffix.is_none()
            && (node.name.ends_with(&format!("::{method}"))
                || node.name.ends_with(&format!(".{method}")))
        {
            suffix = Some(nid.to_string());
        }
    }
    suffix
}

/// 查找文件节点（按 location 前缀匹配，归一化正反斜杠），供客户端调用点无函数宿主时回退
fn find_file_node(graph: &Graph, file: &str) -> Option<String> {
    for (nid, node) in graph.nodes_iter() {
        if node.kind != NodeKind::File {
            continue;
        }
        if node
            .location
            .as_deref()
            .map_or(false, |l| l.replace('\\', "/").starts_with(file))
        {
            return Some(nid.to_string());
        }
    }
    None
}

/// 按语言模式识别客户端连接：变量 → 服务名
fn detect_client_bindings(file: &str, source: &str, bindings: &mut Vec<ClientBinding>) {
    let lower = file.to_lowercase();
    // TS/JS（grpc-js / grpc-web）：const client = new GreeterClient(addr)
    let ts_re = regex::Regex::new(
        r#"(?:const|let|var)\s+(\w+)\s*=\s*new\s+(\w+)Client\s*\("#,
    )
    .unwrap();
    // Go：client := NewGreeterClient(conn) / client = NewGreeterClient(conn)
    let go_re = regex::Regex::new(r#"(\w+)\s*(?::=|=)\s*New(\w+)Client\s*\("#).unwrap();
    // Rust（tonic）：let mut client = GreeterClient::new(conn)
    let rust_re = regex::Regex::new(r#"let\s+mut\s+(\w+)\s*=\s*(\w+)Client::new\s*\("#).unwrap();

    let mut seen: HashSet<(String, String)> = HashSet::new();
    if lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".js") {
        for c in ts_re.captures_iter(source) {
            let var = c.get(1).unwrap().as_str().to_string();
            let svc = c.get(2).unwrap().as_str().to_string();
            if seen.insert((var.clone(), svc.clone())) {
                bindings.push(ClientBinding { var, service: svc });
            }
        }
    } else if lower.ends_with(".go") {
        for c in go_re.captures_iter(source) {
            let var = c.get(1).unwrap().as_str().to_string();
            let svc = c.get(2).unwrap().as_str().to_string();
            if seen.insert((var.clone(), svc.clone())) {
                bindings.push(ClientBinding { var, service: svc });
            }
        }
    } else if lower.ends_with(".rs") {
        for c in rust_re.captures_iter(source) {
            let var = c.get(1).unwrap().as_str().to_string();
            let svc = c.get(2).unwrap().as_str().to_string();
            if seen.insert((var.clone(), svc.clone())) {
                bindings.push(ClientBinding { var, service: svc });
            }
        }
    }
}

/// gRPC 服务检测合成器 — 统一合成器签名（与 framework_routes / bridge_rpc 对齐）。
/// 返回新增节点与边的总数。
pub fn detect_grpc_services(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    // ── Step 1: 发现 .proto 文件 ──
    let mut proto_files: Vec<String> = Vec::new();
    collect_proto_files(project_root, &mut proto_files);
    if proto_files.is_empty() {
        return 0;
    }

    // ── Step 2: 解析 proto → rpc 定义 ──
    let mut defs: Vec<RpcDef> = Vec::new();
    for file in &proto_files {
        let source = parse_cache
            .get(file)
            .map(|(src, _)| src.clone())
            .or_else(|| std::fs::read_to_string(file).ok());
        let Some(source) = source else { continue };
        if !source.contains("service") {
            continue;
        }
        parse_proto(file, &source, &mut defs);
    }
    if defs.is_empty() {
        return 0;
    }

    // ── Step 3: 服务端节点 + 实现匹配 ──
    let mut proto_node_ids: HashMap<(String, String), String> = HashMap::new(); // (service, method) → node_id
    let mut edge_seq = graph.edge_count() as u32;
    for def in &defs {
        let name = format!("{}.{}", def.service, def.method);
        let id = format!(
            "grpc_{}_{}_{}",
            def.file.replace(['/', '\\', '.'], "_"),
            def.service,
            def.method
        );
        if graph.get_node(&id).is_some() {
            continue;
        }
        let mut node = Node::new(&id, &name, NodeKind::Symbol);
        node.location = Some(format!("{}:{}", def.file, def.line));
        node.properties = json!({
            "kind": "grpc",
            "package": def.package,
            "service": def.service,
            "method": def.method,
            "inputType": def.input,
            "outputType": def.output,
            "isStreaming": def.streaming,
        });
        graph.add_node(node);
        added += 1;
        proto_node_ids.insert((def.service.clone(), def.method.clone()), id.clone());

        // 实现匹配：同名函数 → 合成 Calls 边（channel "grpc"）
        if let Some(impl_id) = find_impl_node(graph, &def.method) {
            edge_seq += 1;
            graph.add_edge_unchecked(Edge::synthesized(
                format!("grpc_impl_{edge_seq}"),
                &id,
                &impl_id,
                EdgeKind::Calls,
                "grpc",
            ));
            added += 1;
        }
    }

    // ── Step 4: 客户端调用匹配（同文件变量跟踪）──
    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy().replace('\\', "/");
        let lower = s.to_lowercase();
        if lower.ends_with(".ts")
            || lower.ends_with(".tsx")
            || lower.ends_with(".js")
            || lower.ends_with(".go")
            || lower.ends_with(".rs")
        {
            files.insert(s);
        }
    }

    let call_re = regex::Regex::new(r#"\b(\w+)\.(\w+)\s*\("#).unwrap();
    for file in &files {
        let source = parse_cache
            .get(file)
            .map(|(src, _)| src.clone())
            .or_else(|| std::fs::read_to_string(file).ok());
        let Some(source) = source else { continue };
        if !source.contains("Client") && !source.contains("client") {
            continue;
        }

        // 同文件绑定：变量 → 服务名
        let mut bindings: Vec<ClientBinding> = Vec::new();
        detect_client_bindings(file, &source, &mut bindings);
        if bindings.is_empty() {
            continue;
        }

        // 调用点宿主：同文件函数/类节点，无则回退文件节点
        // （location 可能是反斜杠绝对路径，归一化后比较）
        let caller_nodes: Vec<String> = graph
            .nodes_iter()
            .filter(|(_, n)| {
                if n.kind != NodeKind::Function && n.kind != NodeKind::Class {
                    return false;
                }
                n.location
                    .as_deref()
                    .map_or(false, |l| l.replace('\\', "/").starts_with(file.as_str()))
            })
            .map(|(id, _)| id.to_string())
            .collect();

        let mut seen_edges: HashSet<String> = HashSet::new();
        for caps in call_re.captures_iter(&source) {
            if added >= 400 {
                break;
            }
            let var = caps.get(1).unwrap().as_str();
            let call_method = caps.get(2).unwrap().as_str();
            // 只处理绑定过的客户端变量
            let Some(b) = bindings.iter().find(|b| b.var == var) else {
                continue;
            };
            // 方法名归一化匹配 rpc
            let Some(proto_id) = proto_node_ids
                .iter()
                .find(|((svc, m), _)| svc == &b.service && normalize(m) == normalize(call_method))
                .map(|(_, id)| id)
            else {
                continue;
            };
            let call_norm = normalize(call_method);
            let edge_id = format!("grpc_client_{}_{}_{}", var, call_norm, proto_id);
            if !seen_edges.insert(edge_id.clone()) {
                continue;
            }
            if caller_nodes.is_empty() {
                if let Some(file_id) = find_file_node(graph, file) {
                    graph.add_edge_unchecked(Edge::synthesized(
                        format!("{edge_id}_file"),
                        &file_id,
                        proto_id,
                        EdgeKind::Calls,
                        "grpc-client",
                    ));
                    added += 1;
                }
            } else {
                for caller in &caller_nodes {
                    edge_seq += 1;
                    graph.add_edge_unchecked(Edge::synthesized(
                        format!("grpc_client_{edge_seq}"),
                        caller,
                        proto_id,
                        EdgeKind::Calls,
                        "grpc-client",
                    ));
                    added += 1;
                }
            }
        }
    }

    added
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(s: &str) -> String {
        normalize(s)
    }

    #[test]
    fn test_normalize_casing_variants() {
        assert_eq!(norm("SayHello"), "sayhello");
        assert_eq!(norm("sayHello"), "sayhello");
        assert_eq!(norm("say_hello"), "sayhello");
        assert_eq!(norm("GetUserById"), "getuserbyid");
    }

    #[test]
    fn test_parse_proto_extracts_defs() {
        let src = r#"
syntax = "proto3";
package helloworld.v1;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc WatchUpdates (stream UpdateReq) returns (stream UpdateReply);
}
"#;
        let mut defs = Vec::new();
        parse_proto("proto/greeter.proto", src, &mut defs);
        assert_eq!(defs.len(), 2);
        let d = &defs[0];
        assert_eq!(d.service, "Greeter");
        assert_eq!(d.method, "SayHello");
        assert_eq!(d.package, "helloworld.v1");
        assert_eq!(d.input, "HelloRequest");
        assert_eq!(d.output, "HelloReply");
        assert!(!d.streaming);
        assert!(defs[1].streaming, "stream rpc 应标记");
        assert_eq!(defs[0].line, 6);
    }

    #[test]
    fn test_find_impl_node_matches_case_insensitive() {
        let mut g = Graph::new();
        g.add_node(Node::new("f1", "say_hello", NodeKind::Function));
        g.add_node(Node::new("f2", "sendEmail", NodeKind::Function));
        assert_eq!(find_impl_node(&g, "SayHello").as_deref(), Some("f1"));
        assert_eq!(find_impl_node(&g, "send_email").as_deref(), Some("f2"));
        assert_eq!(find_impl_node(&g, "Nope"), None);
    }

    #[test]
    fn test_detect_client_bindings_ts() {
        let src = r#"
import { GreeterClient } from "./greeter_grpc_pb";
const client = new GreeterClient("localhost:50051");
client.sayHello({ name: "world" });
"#;
        let mut bindings = Vec::new();
        detect_client_bindings("client.ts", src, &mut bindings);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].var, "client");
        assert_eq!(bindings[0].service, "Greeter");
    }

    #[test]
    fn test_detect_client_bindings_rust() {
        let src = r#"
let mut client = GreeterClient::new(endpoint);
client.say_hello(Request::new("world")).await?;
"#;
        let mut bindings = Vec::new();
        detect_client_bindings("client.rs", src, &mut bindings);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].var, "client");
        assert_eq!(bindings[0].service, "Greeter");
    }

    #[test]
    fn test_detect_client_bindings_go() {
        let src = r#"
conn, _ := grpc.NewClient(addr)
client := NewGreeterClient(conn)
resp, err := client.SayHello(ctx, req)
"#;
        let mut bindings = Vec::new();
        detect_client_bindings("client.go", src, &mut bindings);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].var, "client");
        assert_eq!(bindings[0].service, "Greeter");
    }

    #[test]
    fn test_full_detection_fixture() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/grpc_services");
        let mut graph = Graph::new();

        // 模拟阶段 1 已解析的实现与客户端函数节点
        graph.add_node(Node::new(
            "impl_say_hello",
            "say_hello",
            NodeKind::Function,
        ));
        graph.add_node(Node::new(
            "impl_send_email",
            "send_email",
            NodeKind::Function,
        ));

        let cache: ParseCache = HashMap::new();
        let discovered: Vec<std::path::PathBuf> = vec![
            fixture.join("client/ts_client.ts"),
            fixture.join("client/go_client.go"),
            fixture.join("server/rust_impl.rs"),
        ];

        // 模拟阶段 1 已解析的客户端函数节点（location 用反斜杠验证归一化比较）
        let ts_file = discovered[0].to_string_lossy().replace('\\', "/");
        let go_file = discovered[1].to_string_lossy().replace('\\', "/");
        graph.add_node(Node::new("ts_greet", "greet", NodeKind::Function));
        graph.get_node_mut("ts_greet").unwrap().location = Some(format!("{ts_file}:4"));
        graph.add_node(Node::new("go_main", "main", NodeKind::Function));
        graph.get_node_mut("go_main").unwrap().location = Some(format!("{go_file}:11"));

        let added = detect_grpc_services(&mut graph, &fixture, &cache, &discovered);

        // 2 个 rpc 节点（SayHello / SendEmail）
        let proto_nodes: Vec<String> = graph
            .nodes_iter()
            .filter(|(_, n)| n.properties.get("kind") == Some(&json!("grpc")))
            .map(|(id, _)| id.to_string())
            .collect();
        assert_eq!(proto_nodes.len(), 2, "应有 2 个 grpc 节点");

        // 实现匹配：say_hello / send_email 各一条合成边（channel grpc）
        let grpc_edges = graph
            .edges_iter()
            .filter(|(_, e)| e.is_synthesized && e.metadata.as_ref().map_or(false, |m| m["synthesizedBy"] == json!("grpc")))
            .count();
        assert_eq!(grpc_edges, 2, "实现匹配应有 2 条边");

        // 客户端调用边：ts + go 各命中
        let client_edges = graph
            .edges_iter()
            .filter(|(_, e)| e.metadata.as_ref().map_or(false, |m| m["synthesizedBy"] == json!("grpc-client")))
            .count();
        assert!(client_edges >= 2, "客户端调用应有 ≥2 条边，实际 {client_edges}");

        assert!(added >= 2 + 2 + 2, "总数应涵盖节点与边，实际 {added}");
    }
}
