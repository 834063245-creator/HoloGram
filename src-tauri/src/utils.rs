// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 共享工具函数。

use std::process::Command;
use tracing_appender::non_blocking::WorkerGuard;
#[cfg(windows)] use std::os::windows::process::CommandExt;
// ═══════════════════════════════════════════════════════════════
// Windows 子进程窗口控制 — 语义化常量（2026-08-17 根治复发问题）。
//
// 历史教训（修过 8 次仍在弹窗）：窗口标志的选择不能用"一个全局常量
// 盖所有调用点"。同一个数字对直接子进程和对「孙进程」的窗口行为相反：
//
//   CREATE_NO_WINDOW (0x08000000)：「隐藏控制台」—— 子进程有隐藏控制台，
//   且该隐藏控制台会被孙进程继承 → 整棵进程树都不可见。
//   DETACHED_PROCESS (0x00000008)：「无控制台」—— 子进程完全没有控制台，
//   它再 spawn 的孙进程（cmd shim → node/git/cargo 等 CUI 程序）无控制台
//   可继承 → Windows 给孙进程分配【可见新控制台窗口】→ 弹 cmd 黑窗。
//   同时给两者时 CREATE_NO_WINDOW 被忽略（MSDN），实际等效 DETACHED。
//
// 判别标准：这个子进程**会不会再拉起 CUI 孙进程**？
//   - 会（shell 解释器 bash/pwsh/cmd、.cmd shim、git、PowerShell 脚本）
//     → 必须 HIDDEN_CONSOLE，隐藏控制台被子孙继承，全程静默。
//   - 不会（一次性探测 reg/where/版本探针等 stdio 重定向短命令）
//     → 可以 DETACHED_PROCESS，无控制台、无 conhost，零残留。
//
// 验证依据（D:/tmp/winprobe 实验探针实测）：
//   cmd /c shim.cmd（cmd→cmd→ping 链，npm.cmd 同构）：
//     0x08000000  → new_visible_console=0（静默 ✅）
//     0x00000008  → new_visible_console=1（弹窗 ❌）
//     0x08000008  → new_visible_console=1（组合等效 DETACHED，弹窗 ❌）
//   PS: pty_manager 的 conhost 孤儿（8-13 动机）是 ConPTY 场景，由
//   conhost_guard 看门狗兜底，与本常量无关，不要把 DETACHED 强行扩散。
#[cfg(windows)]
pub(crate) const HIDDEN_CONSOLE: u32 = 0x08000000; // CREATE_NO_WINDOW：隐藏控制台被子孙继承
#[cfg(windows)]
pub(crate) const DETACHED_PROCESS_FLAG: u32 = 0x00000008; // 仅一次性探测（不 spawn 孙进程）

// ══════════════════════════════════════════════════════════════════════
// 模块拆分（第三批任务 11a）— 按关注点拆出的子模块，
// 经 pub use 重导出，`crate::utils::*` 调用路径保持不变。
// ══════════════════════════════════════════════════════════════════════

pub(crate) mod bg_jobs;
pub(crate) mod build_lock;
pub(crate) mod encoding;
pub(crate) mod graph_io;
pub(crate) mod ipc_guard;
pub(crate) mod path_resolve;
pub(crate) use bg_jobs::*;
pub(crate) use build_lock::*;
pub(crate) use encoding::*;
pub(crate) use graph_io::*;
pub(crate) use ipc_guard::*;
pub(crate) use path_resolve::*;

/// 日志守护 — 在首次打开项目时初始化一次，在整个进程生命周期内持有。
pub(crate) static LOG_GUARD: std::sync::OnceLock<WorkerGuard> = std::sync::OnceLock::new();

#[derive(serde::Serialize)]
pub(crate) struct DirEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) children: Option<Vec<DirEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) truncated: Option<bool>,
}

/// 递归列出目录内容（深度受限以避免过大的树）。
/// 最大深度：4 层，最大条目数：2000。当 `filter_ignored` 为 true 时，
/// 通过引擎的 is_ignored_path 排除被忽略的路径（用于面向 Agent 的工具调用）。
/// 内部调用者（消息存储、会话扫描器）传 false 以列出 .hologram 内容。
pub(crate) fn list_dir_recursive(root: &std::path::Path, filter_ignored: bool) -> Vec<DirEntry> {
    fn recurse(
        dir: &std::path::Path,
        depth: usize,
        entries: &mut Vec<DirEntry>,
        entry_count: &mut usize,
        truncated: &mut bool,
        filter_ignored: bool,
    ) {
        const MAX_DEPTH: usize = 3; // 0,1,2,3 = 4 层
        const MAX_ENTRIES: usize = 2000;

        if depth > MAX_DEPTH || *entry_count >= MAX_ENTRIES {
            *truncated = true;
            return;
        }

        let readdir = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };

        for entry in readdir.flatten() {
            if *entry_count >= MAX_ENTRIES {
                *truncated = true;
                break;
            }

            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            let is_dir = path.is_dir();
            // 复用引擎的 is_ignored_path 以保持一致的排除行为（仅面向 Agent）
            if filter_ignored && is_dir && hologram_engine::pipeline::discovery::is_ignored_path(
                &path.to_string_lossy().replace('\\', "/"),
            ) {
                continue;
            }

            let children = if is_dir {
                let mut child_entries = Vec::new();
                recurse(&path, depth + 1, &mut child_entries, entry_count, truncated, filter_ignored);
                if child_entries.is_empty() { None } else { Some(child_entries) }
            } else {
                None
            };

            *entry_count += 1;
            entries.push(DirEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                children,
                truncated: None,
            });
        }
    }

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut entry_count = 0usize;
    let mut truncated = false;
    recurse(root, 0, &mut entries, &mut entry_count, &mut truncated, filter_ignored);
    // 如果达到限制，在第一个条目上设置截断标志
    if truncated && !entries.is_empty() {
        entries[0].truncated = Some(true);
    }
    entries
}

pub(crate) fn list_dir_flat(root: &std::path::Path) -> Vec<DirEntry> {
    let mut entries: Vec<DirEntry> = Vec::new();
    // ponytail: 只隐藏 VCS 内部目录 — 其他全显示, git ignored 着色在前端处理
    let skip_dirs: std::collections::HashSet<&str> = [
        ".git", ".hg", ".svn",
    ].iter().cloned().collect();

    let readdir = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return entries,
    };

    for entry in readdir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        if is_dir && skip_dirs.contains(name.as_str()) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: None,
            truncated: None,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    entries
}

#[derive(serde::Serialize)]
pub(crate) struct GlobEntry {
    pub(crate) path: String,
    pub(crate) name: String,
}

pub(crate) fn is_private_ip(host: &str) -> bool {
    // 主机名检查（解析到本地/私有的 DNS 名称）
    let host_lower = host.to_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".local") || host_lower.ends_with(".internal") {
        return true;
    }
    use std::net::IpAddr;
    let ip: IpAddr = match host.parse() {
        Ok(ip) => ip,
        Err(_) => return false,
    };
    if ip.is_loopback() || ip.is_unspecified() { return true; }
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_link_local()
        }
        IpAddr::V6(v6) => {
            // 检查 IPv6 映射的 IPv4 地址 (::ffff:a.b.c.d)
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_private_ip(&mapped.to_string());
            }
            let segs = v6.segments();
            // 链路本地 (fe80::/10) 或 ULA (fc00::/7 — 包含 fd00::/8)
            (segs[0] & 0xffc0 == 0xfe80) || (segs[0] & 0xfe00 == 0xfc00)
        }
    }
}

pub(crate) fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => { out.push('%'); out.push_str(&format!("{:02X}", b)); }
        }
    }
    out
}

pub(crate) fn regenerate_file_graph(project_path: &str) -> Result<String, String> {
    let graph_path = format!("{}/hologram_graph.json", project_path);
    let files_path = format!("{}/hologram_graph_files.json", project_path);

    let content = std::fs::read_to_string(&graph_path)
        .map_err(|e| format!("Cannot read graph: {}", e))?;
    let g: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid graph JSON: {}", e))?;

    // 按文件分组节点
    let mut file_nodes: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    if let Some(nodes) = g.get("nodes").and_then(|v| v.as_array()) {
        for n in nodes {
            let loc = n.get("location").and_then(|v| v.as_str()).unwrap_or("");
            // 从 "file.py:123" 或 "file.py" 中提取文件路径
            let file = loc.split(':').next().unwrap_or("").to_string();
            if !file.is_empty() {
                if let Some(id) = n.get("id").and_then(|v| v.as_str()) {
                    file_nodes.entry(file).or_default().push(id.to_string());
                }
            }
        }
    }

    // 以 O(N) 构建 node_id → file 查找表 — 避免 O(N*E) 的 find_node_file 扫描
    let node_file: std::collections::HashMap<&str, &str> = g.get("nodes")
        .and_then(|v| v.as_array())
        .map(|nodes| {
            nodes.iter().filter_map(|n| {
                let id = n.get("id").and_then(|v| v.as_str())?;
                let file = n.get("location").and_then(|v| v.as_str()).unwrap_or("")
                    .split(':').next().unwrap_or("");
                if file.is_empty() { None } else { Some((id, file)) }
            }).collect()
        }).unwrap_or_default();

    // 统计每对文件之间的边数
    let mut file_edges: std::collections::HashMap<(String, String), u32> = std::collections::HashMap::new();
    if let Some(edges) = g.get("edges").and_then(|v| v.as_array()) {
        for e in edges {
            let src = e.get("source").and_then(|v| v.as_str()).unwrap_or("");
            let tgt = e.get("target").and_then(|v| v.as_str()).unwrap_or("");
            let src_file = node_file.get(src).copied().unwrap_or("");
            let tgt_file = node_file.get(tgt).copied().unwrap_or("");
            if !src_file.is_empty() && !tgt_file.is_empty() && src_file != tgt_file {
                *file_edges.entry((src_file.to_string(), tgt_file.to_string())).or_default() += 1;
            }
        }
    }

    let file_graph: serde_json::Value = serde_json::json!({
        "nodes": file_nodes.iter().map(|(f, ids)| serde_json::json!({
            "id": f,
            "name": f.split('/').next_back().unwrap_or(f),
            "type": "file",
            "location": f,
            "symbol_count": ids.len(),
        })).collect::<Vec<_>>(),
        "edges": file_edges.iter().map(|((s, t), count)| serde_json::json!({
            "source": s,
            "target": t,
            "type": "structural",
            "weight": count,
        })).collect::<Vec<_>>(),
        "meta": g.get("meta").cloned().unwrap_or(serde_json::json!({})),
    });

    std::fs::write(&files_path, serde_json::to_string(&file_graph).unwrap_or_default())
        .map_err(|e| format!("Cannot write file graph: {}", e))?;
    Ok("ok".to_string())
}

pub(crate) fn run_git_sync(dir: &str, args: &[String]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        // git 会经 shim/editor/hook 拉起孙进程 → 需隐藏控制台继承，不能 DETACHED
        cmd.creation_flags(HIDDEN_CONSOLE);
    }
    let output = cmd
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git 命令失败: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// 在阻塞线程池中运行 git 命令。
/// ponytail: .output() 会阻塞线程等待 git 进程；
/// 在 async worker 上运行会饿死并发的 Tauri 命令。
pub(crate) async fn run_git(dir: String, args: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git_sync(&dir, &args))
        .await
        .map_err(|e| format!("git 任务失败: {e}"))?
}

/// 将 `git status --porcelain` 解析为结构化 JSON。
pub(crate) fn parse_status(raw: &str) -> serde_json::Value {
    let files: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let (st, path) = if line.len() >= 4 {
                (&line[..2], line[3..].trim())
            } else {
                ("  ", line)
            };
            let status = match st.trim() {
                "M" => "modified",
                "A" => "added",
                "D" => "deleted",
                "R" => "renamed",
                "C" => "copied",
                "?" => "untracked",
                _ if st.starts_with(' ') && st.ends_with('M') => "modified",
                _ if st.starts_with(' ') && st.ends_with('D') => "deleted",
                _ => "modified",
            };
            let staged = !st.starts_with(' ') && st != "??";
            let is_rename = st.contains('R');
            // 对于重命名，路径格式为 "old -> new"
            let (display_path, old_path) = if is_rename && path.contains(" -> ") {
                let parts: Vec<&str> = path.split(" -> ").collect();
                (parts[1].to_string(), Some(parts[0].to_string()))
            } else {
                (path.to_string(), None)
            };
            let mut obj = serde_json::json!({
                "path": display_path,
                "status": status,
                "staged": staged,
            });
            if let Some(old) = old_path {
                obj["old_path"] = serde_json::json!(old);
            }
            obj
        })
        .collect();
    serde_json::json!(files)
}

/// 原子写入：临时文件再重命名。
/// 原子地写入文件（tmp → rename），当原文件已存在时创建 .bak 备份。
/// 使用 io_retry 处理瞬时错误。
/// 调用方必须已通过权限检查 — 此函数仅做纯 I/O。
pub(crate) fn write_atomic(file_path: &str, content: &str) -> Result<(), String> {
    // tmp 路径带进程内唯一后缀 — 固定 ".tmp" 会让并发写同一文件的调用
    // 互相覆盖临时文件，rename 时触发 "系统找不到指定的文件"（os error 2）
    // 或写入内容错乱（后写覆盖先写的 tmp 再 rename）。
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = format!("{}.tmp.{}", file_path, seq);
    let bak_path = format!("{}.bak", file_path);

    // 重试临时文件写入（NFS 等的瞬时 I/O 错误）
    io_retry(|| std::fs::write(&tmp_path, content), "write_atomic(tmp)")?;

    // 在覆盖原文件前创建 .bak 快照（尽力而为）
    let had_original = std::path::Path::new(file_path).exists();
    if had_original {
        // 上次崩溃可能残留旧 .bak；rename 对既有目标的行为依赖平台/std 语义，
        // 先删旧 .bak 保证重命名一定可用——否则残留 .bak 会让该文件的
        // 所有后续写入永久失败（雷区地图 P0-3）
        let _ = std::fs::remove_file(&bak_path);
        // 将原文件重命名为 .bak；忽略失败（磁盘满、权限等）
        let _ = std::fs::rename(file_path, &bak_path);
    }

    // 用 tmp 原子替换原文件
    match std::fs::rename(&tmp_path, file_path) {
        Ok(()) => {
            // 成功后删除旧的 .bak（尽力而为）
            if had_original {
                let _ = std::fs::remove_file(&bak_path);
            }
            Ok(())
        }
        Err(e) => {
            // 如果重命名失败，尝试从 .bak 恢复
            if had_original && std::path::Path::new(&bak_path).exists() {
                let _ = std::fs::rename(&bak_path, file_path);
            }
            Err(format!("write_atomic(rename): {}", e))
        }
    }
}

/// 对可能失败的 I/O 闭包最多重试 3 次（针对瞬时错误）。
/// 瞬时错误 = Interrupted、TimedOut、WouldBlock。其他错误立即失败。
fn io_retry<T, F>(mut op: F, label: &str) -> Result<T, String>
where
    F: FnMut() -> std::io::Result<T>,
{
    let retry_count = 3u32;
    for attempt in 0..=retry_count {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => {
                let retryable = matches!(
                    e.kind(),
                    std::io::ErrorKind::Interrupted
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                );
                if !retryable || attempt == retry_count {
                    return Err(format!("{} (尝试 {} 次后失败): {}", label, attempt + 1, e));
                }
                let delay = std::time::Duration::from_millis(100) * 2u32.pow(attempt);
                eprintln!(
                    "[write_atomic] {}: 可重试错误，第 {}/{} 次尝试 — {:?}（{:?} 后重试）",
                    label,
                    attempt + 1,
                    retry_count,
                    e,
                    delay
                );
                std::thread::sleep(delay);
            }
        }
    }
    Err(format!("{}: unreachable", label))
}

/// 在内容中查找包含查询字符串的行（模糊子串匹配）。
pub(crate) fn fuzzy_find(content: &str, query: &str) -> Option<(usize, String)> {
    let q = query.trim();
    if q.is_empty() { return None; }
    for (i, line) in content.lines().enumerate() {
        if line.contains(q) {
            return Some((i + 1, line.trim().chars().take(80).collect()));
        }
    }
    None
}

/// PATH 合并（shell-stability P3，平台无关纯函数）：
/// existing 在前（保留顺序），逐个追加 extras 中不重复的条目；
/// 去重大小写不敏感（Windows PATH 语义），空串/引号清理。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn merge_path_entries(existing: &[String], extras: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |p: &str, out: &mut Vec<String>| {
        let p = p.trim().trim_matches('"');
        if p.is_empty() {
            return;
        }
        if !out.iter().any(|x| x.eq_ignore_ascii_case(p)) {
            out.push(p.to_string());
        }
    };
    for p in existing {
        push(p, &mut out);
    }
    for p in extras {
        push(p, &mut out);
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_path_entries_dedupes_case_insensitive_and_keeps_order() {
        let out = merge_path_entries(
            &["C:\\Windows".into(), "\"C:\\Foo\"".into()],
            &["c:\\foo".into(), "".into(), "D:\\Bar".into()],
        );
        assert_eq!(out, vec!["C:\\Windows", "C:\\Foo", "D:\\Bar"]);
    }

    #[test]
    fn truncate_output_spill_writes_full_log_and_guides() {
        let big: String = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 10_000);
        let out = crate::utils::truncate_output_spill(&big, "test-job");
        assert!(out.contains("output truncated"), "必须带截断标记: {out}");
        assert!(out.contains("完整输出已落盘"), "必须给落盘指引: {out}");
        // 从指引里抠出路径，验证全量内容在盘上
        let path_part = out
            .split("完整输出已落盘: ")
            .nth(1)
            .and_then(|s| s.split("（用 fs(read)").next())
            .map(|s| s.trim().to_string())
            .expect("应含路径");
        let on_disk = std::fs::read_to_string(&path_part).expect("溢出文件应存在");
        assert_eq!(on_disk, big, "落盘内容必须与全量输出一致");
        // 短输出不落盘、原文返回
        let short = "hello";
        assert_eq!(crate::utils::truncate_output_spill(short, "test-job"), short);
        let _ = std::fs::remove_file(&path_part);
    }

    // ── B1: SSRF 防护必须捕获 ipv6 映射的 ipv4 (::ffff:a.b.c.d) ──
    #[test]
    fn test_b1_is_private_ip_ipv6_mapped() {
        assert!(is_private_ip("::ffff:127.0.0.1"), "ipv6 映射的回环地址必须被拦截");
        assert!(is_private_ip("::ffff:10.0.0.5"), "ipv6 映射的私有地址段必须被拦截");
        assert!(is_private_ip("::ffff:192.168.1.1"), "ipv6 映射的私有地址段必须被拦截");
    }

    #[test]
    fn test_b1_is_private_ip_baseline() {
        assert!(is_private_ip("127.0.0.1"));
        assert!(is_private_ip("10.1.2.3"));
        assert!(is_private_ip("192.168.0.1"));
        assert!(is_private_ip("172.16.5.5"));
        assert!(is_private_ip("169.254.1.1"), "链路本地地址必须被拦截");
        assert!(is_private_ip("0.0.0.0"), "未指定地址必须被拦截");
        assert!(is_private_ip("::1"), "ipv6 回环地址必须被拦截");
        assert!(is_private_ip("fe80::1"), "ipv6 链路本地地址必须被拦截");
        assert!(is_private_ip("fd00::1"), "ipv6 ULA 地址必须被拦截");
        assert!(is_private_ip("localhost"));
        // 公网地址不应被标记
        assert!(!is_private_ip("8.8.8.8"));
        assert!(!is_private_ip("1.1.1.1"));
        assert!(!is_private_ip("2606:4700:4700::1111"), "公网 ipv6 必须放行");
        assert!(!is_private_ip("example.com"), "普通主机名不是 IP 字面量");
    }

    // ── P0-2：大响应护栏（2026-08-08 事故的物理通道） ──
    #[test]
    fn truncate_output_short_passthrough() {
        let s = "hello world";
        assert_eq!(truncate_output(s), s);
    }

    #[test]
    fn truncate_output_long_keeps_head_and_tail() {
        let s: String = (0..MAX_TOOL_OUTPUT_CHARS * 2).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        let out = truncate_output(&s);
        assert!(out.contains("[output truncated:"), "必须带截断标记");
        assert!(out.starts_with(&s[..100]), "必须保留头部");
        assert!(out.ends_with(&s[s.len() - 100..]), "必须保留尾部");
        assert!(out.chars().count() < s.chars().count(), "必须真的变短");
    }

    #[test]
    fn truncate_output_multibyte_no_panic() {
        // 中文 3 字节/字，按 char 边界切绝不能 panic 或切出乱码
        let s: String = "汉".repeat(MAX_TOOL_OUTPUT_CHARS * 2);
        let out = truncate_output(&s);
        assert!(out.contains("[output truncated:"));
    }

    #[test]
    fn guard_ipc_size_allows_small() {
        let s = "x".repeat(1024);
        assert_eq!(guard_ipc_size(s.clone(), "测试").unwrap(), s);
    }

    #[test]
    fn guard_ipc_size_rejects_oversize() {
        let s = "x".repeat(MAX_IPC_RESPONSE_BYTES + 1);
        let err = guard_ipc_size(s, "Graph JSON").unwrap_err();
        assert!(err.contains("超过 IPC 上限"), "报错必须说明原因：{err}");
    }

    /// 回归 P0-3：上次崩溃残留的 .bak 不得让后续写入永久失败。
    #[test]
    fn write_atomic_clears_stale_bak() {
        let dir = std::env::temp_dir().join("hologram_test_write_atomic_bak");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("settings.json");
        let fs = f.to_string_lossy().to_string();
        std::fs::write(&f, "old").unwrap();
        std::fs::write(format!("{fs}.bak"), "stale-corpse").unwrap();
        write_atomic(&fs, "new").expect("残留 .bak 不得导致写失败");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "new");
        assert!(
            !std::path::Path::new(&format!("{fs}.bak")).exists(),
            "成功后 .bak 必须清理"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回归 P0-12：锁中毒后 lock_or_recover 恢复数据而非 panic 连锁。
    #[test]
    fn lock_or_recover_survives_poisoning() {
        use std::sync::{Arc, Mutex};
        let m = Arc::new(Mutex::new(42));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            // 故意持锁 panic 制造中毒（用 expect 避开 lock_or_recover 的 codemod 模式）
            let mut g = m2.lock().expect("test lock");
            *g = 43;
            panic!("boom");
        })
        .join();
        assert!(m.lock().is_err(), "前提：锁必须已中毒");
        assert_eq!(*lock_or_recover(&m), 43, "中毒后必须恢复数据而非 panic");
    }

    // ── BuildLock：多 Agent 构建锁互斥 ──
    // 测试共享全局 BUILD_LOCKS 且并行执行——各测试末尾的 clear() 会互踩，
    // 用共享 Mutex 串行化（Rust 测试默认并行线程）。
    // 锁定义在 build_lock.rs（bg_jobs.rs 的 build_lock_released_on_remove_job
    // 也要用它串行化——子模块测试无法访问父模块私有项），经 pub use 转发可见。

    /// 锁键按 (cwd, lock_name) 判定：同目录两个 cargo build 冲突。
    #[test]
    fn build_lock_conflict_same_resource() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let k1 = acquire_build_lock("cargo build", "C:/ws-t1", 1, Some("agent-a".into())).unwrap();
        assert!(k1.is_some(), "cargo build 应注册 target 锁");
        let err = acquire_build_lock("cargo test", "C:/ws-t1", 2, Some("agent-b".into())).unwrap_err();
        assert!(err.contains("构建锁冲突"), "冲突应打回: {err}");
        assert!(err.contains("job #1"), "打回应指明持有者 job: {err}");
        assert!(err.contains("agent-a"), "打回应指明持有者: {err}");
        assert!(err.contains("bash_wait(1)"), "打回应带等待路径: {err}");
        crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
    }

    /// 不同锁资源 / 不同 cwd 互不冲突（worktree 隔离白赚）。
    #[test]
    fn build_lock_no_conflict_different_resource() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let k1 = acquire_build_lock("cargo build", "C:/ws-t2", 1, None).unwrap();
        let k2 = acquire_build_lock("npm install", "C:/ws-t2", 2, None).unwrap();
        let k3 = acquire_build_lock("cargo build", "C:/ws-t2/worktree2", 3, None).unwrap();
        assert!(k1.is_some() && k2.is_some() && k3.is_some(), "异资源/异目录不应冲突");
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
    }

    /// 无锁命令不注册；git 只读子命令不锁。
    #[test]
    fn build_lock_ignores_nonlocking_commands() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        assert!(acquire_build_lock("echo hi", "C:/ws-t3", 1, None).unwrap().is_none());
        assert!(acquire_build_lock("git status", "C:/ws-t3", 2, None).unwrap().is_none());
        assert!(acquire_build_lock("git commit -m x", "C:/ws-t3", 3, None).unwrap().is_some());
        crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
    }

    /// remove_job 释放锁：job 完成后同资源命令恢复可执行。
    /// bash_kill 所有权边界：Agent 不能 kill 用户任务 / 其他 Agent 任务。
    #[test]
    fn kill_bg_ownership_boundary() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let id = next_job_id();
        let child = crate::os_sandbox::spawn_shell("sleep 30", ".").expect("spawn_shell failed");
        register_fg_child(id, child, "sleep 30", BgSharedOutput { stdout: Default::default(), stderr: Default::default() }, Some("agent-a".into()), None);
        // 其他 Agent 无权 kill
        let err = kill_bg(id, Some("agent-b")).unwrap_err();
        assert!(err.contains("无权终止"), "跨 Agent kill 应拒绝: {err}");
        // 本人可 kill
        assert!(kill_bg(id, Some("agent-a")).is_ok(), "本人 kill 应放行");
        // 用户任务（owner=None）：Agent 无权 kill
        let id2 = next_job_id();
        let child2 = crate::os_sandbox::spawn_shell("sleep 30", ".").expect("spawn_shell failed");
        register_fg_child(id2, child2, "sleep 30", BgSharedOutput { stdout: Default::default(), stderr: Default::default() }, None, None);
        let err2 = kill_bg(id2, Some("agent-a")).unwrap_err();
        assert!(err2.contains("无权终止"), "用户任务 Agent 不可 kill: {err2}");
        // 用户（无 agent_id）可 kill 任何任务
        assert!(kill_bg(id2, None).is_ok(), "用户 kill 应放行");
    }

    // ── P1-17：bg 任务读方只碰 shared Arc，永不阻塞读管道 ──
    #[test]
    fn bg_job_roundtrip_via_shared_arc() {
        let id = spawn_bg("echo bg-p117", ".", None, None).expect("spawn_bg failed");
        let out = wait_bg(id, 10_000).expect("wait_bg failed");
        assert!(out.contains("bg-p117"), "unexpected output: {out}");
        assert!(out.contains("exit code: 0"), "unexpected output: {out}");
    }

    /// 无输出的长任务：read_bg_output 必须立即返回快照（修复前 shared=None 分支
    /// 会持 BG_JOBS 锁阻塞读管道，任务安静时永久卡死）。shared 现为必填字段，
    /// 该分支已从类型上移除，此测试锁定行为。
    #[test]
    fn bg_output_snapshot_quiet_task_returns_fast() {
        let id = spawn_bg("sleep 5", ".", None, None).expect("spawn_bg failed");
        let start = std::time::Instant::now();
        let out = read_bg_output(id).expect("read_bg_output failed");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(2),
            "快照读取耗时 {:?}——疑似退化为阻塞管道读",
            start.elapsed()
        );
        assert!(out.contains("任务运行中"), "unexpected output: {out}");
        kill_bg(id, None).expect("kill_bg failed");
    }
}