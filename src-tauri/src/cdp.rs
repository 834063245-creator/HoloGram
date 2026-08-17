// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// CDP (Chrome DevTools Protocol) 客户端 — 让 Agent 观察/操作 Chromium 页面。
//
// 架构（ADR 0003 落地，P1/P2）：
//   - 命令通道：短连接（每次调用建立 WS，用完即关）——本地回环开销可忽略，
//     避免长连接命令状态机；connect/发送/等待全部包在 tokio timeout 里，
//     Runtime.evaluate 另带 CDP 层 5s 超时——页面死循环不会挂死 Agent 流。
//   - 事件通道：attach 后起一条持久 WS 后台 task，订阅 Runtime/Log/Network/Page
//     事件进环形缓冲，browser(console)/browser(network)/browser(dialog) 随时查询；
//     事件 task 随 target 消失自然退出，惰性重启。
//   - 快照 + ref：snapshot 给可交互元素打 data-hg-ref 标记，操作按 ref 引用；
//     ref 失效返回可恢复错误。selector 保留为高级参数。
//   - 操作反馈：操作前做 actionability 等待（可见/无遮挡/位置稳定），
//     操作后返回世界变化（URL / DOM 大小 / 新增错误数）。
//   - 会话按 agent 键控 + 空闲租约自动回收（默认 10 分钟，
//     HOLOGRAM_BROWSER_LEASE_SECS 可调，便于实测）+ Chrome 崩溃检测。
//   - profile 按端口隔离（hologram-browser-profile-<port>），随会话回收
//     一并删除；launch 时清扫上次进程强杀遗留的目录。具名 profile
//     （hologram-browser-profiles-<slot>）持久保留，配合 slot 切换做多账号隔离。
//   - self 会话：HoloGram 自家 webview 调试端口（9222）上的只读会话，
//     Agent 自查渲染结果走这里；操作类动作在 rpc 层被拒。
//   - 审计：全部写操作落盘（临时目录 jsonl），browser(audit) 可查。
//   - 只连 127.0.0.1；launch 用独立 profile，不碰用户日常 Chrome。

mod probes;
mod transport;
mod session;
mod actions;
mod errors;

pub(crate) use session::{
    cdp_audit, cdp_browser_activity, cdp_close_tab, cdp_connect, cdp_discover, cdp_kill,
    cdp_launch, cdp_new_tab, cdp_sessions, cdp_switch_session, is_self, SELF_AGENT_ID,
};
pub(crate) use actions::{
    cdp_attach, cdp_back, cdp_click, cdp_console, cdp_content, cdp_cookies, cdp_dialogs, cdp_eval,
    cdp_forward, cdp_handle_dialog, cdp_hover, cdp_inspect, cdp_navigate, cdp_network,
    cdp_network_detail, cdp_network_har, cdp_press, cdp_reload, cdp_report, cdp_screenshot,
    cdp_scroll, cdp_select, cdp_set_viewport, cdp_snapshot, cdp_status, cdp_targets, cdp_type,
    cdp_upload, cdp_wait, check_sensitive,
};

// 生产代码已全部拆入子模块；cdp.rs 仅保留 facade re-export 与测试。
// 测试/e2e 经 `super::*` 取用这些私有导入。
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::Arc;
#[cfg(test)]
use std::time::{Duration, Instant};
#[cfg(test)]
use serde_json::Value;

#[cfg(test)]
use probes::{probe_result_str, CONTENT_PROBE, INSPECT_PROBE, REPORT_PROBE, SNAPSHOT_PROBE};
#[cfg(test)]
use session::{
    active_session_key, audit_log, chrome_candidate_paths, cleanup_old_files_by_age, enforce_lease,
    ensure_observer_started, extract_debug_port_from_args, find_chrome, lock_sessions,
    named_profile_dir, network_on_failed, network_on_request, network_on_response,
    normalize_slot_name, parse_discover_process_lines, profile_dir_for, remove_profile_dir,
    session_key, session_key_for, set_active_slot, validate_proxy_arg, is_expired_file_time,
    session_lease, CdpSession, EventBuffers, NetworkEntry,
};
#[cfg(test)]
use transport::{http_close_tab, http_new_tab, list_targets_raw};
#[cfg(test)]
use actions::{
    ax_node_from_value, ax_role_is_interactive, is_sensitive_click_text, parse_modifiers,
    parse_world_value, ref_to_selector, runtime_evaluate, world_diff,
};

// ═══════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    /// 探针语法验证（P0-4）：探针是注入页面的 JS，语法错误要运行时才发现。
    /// 此处用 node --check 强制验证——改坏探针 cargo test 必红。
    /// node 不可用（纯 Rust 环境）时跳过，不视为失败。
    fn assert_valid_js(probe: &str, name: &str) {
        let js = format!("({probe});\n");
        let dir = std::env::temp_dir().join("hologram-probe-syntax");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("{name}.js"));
        std::fs::write(&path, &js).expect("写探针临时文件失败");
        match std::process::Command::new("node").arg("--check").arg(&path).output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => panic!(
                "探针 {name} 语法错误（node --check 失败）:\n{}",
                String::from_utf8_lossy(&out.stderr)
            ),
            Err(_) => eprintln!("警告: node 不可用，跳过探针 {name} 语法检查"),
        }
    }

    #[test]
    fn probes_are_valid_javascript() {
        assert_valid_js(CONTENT_PROBE, "content");
        assert_valid_js(INSPECT_PROBE, "inspect");
        assert_valid_js(REPORT_PROBE, "report");
        assert_valid_js(SNAPSHOT_PROBE, "snapshot");
    }

    #[test]
    fn chrome_candidate_paths_cover_current_platform() {
        let paths = chrome_candidate_paths();
        assert!(!paths.is_empty(), "每个平台都应有 Chrome/Edge 候选路径");
        #[cfg(target_os = "windows")]
        assert!(paths.iter().any(|p| p.to_string_lossy().ends_with("chrome.exe")));
        #[cfg(target_os = "macos")]
        assert!(paths.iter().any(|p| p.to_string_lossy().contains("Google Chrome.app")));
        #[cfg(all(unix, not(target_os = "macos")))]
        assert!(paths.iter().any(|p| p.to_string_lossy().contains("google-chrome")));
    }

    #[test]
    fn discover_parser_handles_powershell_and_ps_formats() {
        let text = "chrome|9333|1234
bash|9222|99
  456 chromium --remote-debugging-port=9444 --user-data-dir=/tmp/x
";
        let found = parse_discover_process_lines(text);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], ("chrome".to_string(), 9333));
        assert_eq!(found[1], ("chromium".to_string(), 9444));
        assert_eq!(extract_debug_port_from_args("--remote-debugging-port=9447 --flag"), Some(9447));
        assert_eq!(extract_debug_port_from_args("--remote-debugging-port 9447"), None, "Chrome 使用 = 形态");
    }

    #[test]
    fn session_key_falls_back_to_default() {
        assert_eq!(super::session_key(None), "default");
        assert_eq!(super::session_key(Some("")), "default");
        assert_eq!(super::session_key(Some("  ")), "default");
        assert_eq!(super::session_key(Some("agent-7")), "agent-7");
    }

    /// 第五批多账号：slot 名是 profile 目录名的安全边界，也是 session 隔离边界。
    #[test]
    fn slot_names_and_session_keys_are_isolated() {
        assert_eq!(super::normalize_slot_name("  ").unwrap(), "default");
        assert_eq!(super::normalize_slot_name("工作账号").unwrap(), "工作账号");
        assert!(super::normalize_slot_name("../evil").is_err());
        assert!(super::normalize_slot_name("a/b").is_err());
        assert!(super::normalize_slot_name("x".repeat(49).as_str()).is_err());

        let agent = Some("slot-test-agent");
        let work = super::session_key_for(agent, "work");
        let personal = super::session_key_for(agent, "personal");
        assert_ne!(work, personal, "不同 slot 必须落在不同 session key");
        assert_eq!(super::active_session_key(agent), super::session_key_for(agent, "default"));

        super::set_active_slot(agent, "work");
        assert_eq!(super::active_session_key(agent), work);
        // 恢复 default，避免污染同一 agent 的其他测试
        super::set_active_slot(agent, "default");
        assert_eq!(super::active_session_key(agent), super::session_key_for(agent, "default"));

        let named = super::named_profile_dir("工作账号");
        assert!(
            named.to_string_lossy().contains("hologram-browser-profiles-工作账号"),
            "具名 profile 目录应含前缀与 slot 名: {}",
            named.display()
        );
    }

    /// 第五批 proxy 参数：命令行参数由 std::process 逐 arg 传递，换行是唯一明确拒绝项。
    #[test]
    fn proxy_arg_validation_rejects_newlines_only() {
        assert!(super::validate_proxy_arg("proxy", "socks5://127.0.0.1:1080").is_ok());
        assert!(super::validate_proxy_arg("proxy", "").is_err());
        assert!(super::validate_proxy_arg("proxy", "socks5://host\n--remote-debugging-port=9999").is_err());
    }

    /// 状态栏后台活动快照：只返回仍有连接的浏览器会话，port=0 的已 kill 槽位
    /// 不得出现；self webview 通道也不得混入后台列表。
    #[test]
    fn browser_activity_snapshots_running_sessions_only() {
        let agent = Some("activity-snapshot-agent");
        let key = super::session_key_for(agent, "work");
        {
            let mut sessions = lock_sessions();
            sessions.insert(
                key.clone(),
                CdpSession {
                    port: 9333,
                    target_id: None,
                    slot: "work".into(),
                    created_at: Instant::now(),
                    ..CdpSession::default()
                },
            );
        }
        let rows = super::cdp_browser_activity();
        let hit = rows
            .iter()
            .find(|r| r["agent"].as_str() == Some("activity-snapshot-agent") && r["slot"].as_str() == Some("work"));
        assert!(hit.is_some(), "运行中的浏览器会话应出现在后台活动: {rows:?}");
        assert_eq!(hit.unwrap()["port"].as_u64(), Some(9333));
        {
            let mut sessions = lock_sessions();
            sessions.remove(&key);
        }
        assert!(
            super::cdp_browser_activity()
                .iter()
                .all(|r| r["agent"].as_str() != Some("activity-snapshot-agent")),
            "测试会话应清理干净"
        );
    }

    /// 第五批 profile 持久化：磁盘上已有的具名 profile 目录，即使当前进程尚未
    /// launch，也要出现在 browser(sessions) 里（应用重启后的恢复入口）。
    #[test]
    fn sessions_lists_persisted_named_profiles() {
        let slot = format!("disk-slot-test-{}", std::process::id());
        let dir = super::named_profile_dir(&slot);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建具名 profile 测试目录");
        let out = super::cdp_sessions(Some("disk-session-agent"));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(out.contains(&slot), "持久 profile 应出现在 sessions: {out}");
    }

    #[test]
    fn ref_to_selector_handles_ref_and_selector() {
        assert_eq!(super::ref_to_selector("37"), "[data-hg-ref=\"37\"]");
        assert_eq!(super::ref_to_selector("ref:5"), "[data-hg-ref=\"5\"]");
        assert_eq!(super::ref_to_selector(".btn-primary"), ".btn-primary");
        assert_eq!(super::ref_to_selector("#submit"), "#submit");
        assert_eq!(super::ref_to_selector(""), "");
    }

    /// P0 二轮评审：敏感点击检测只有中文动词 → 英文 "Pay now / Delete / Confirm /
    /// Unsubscribe" 不触发单独 Ask。此处锁定页面内 JS 同源正则的 Rust 纯函数版。
    #[test]
    fn sensitive_click_text_covers_english_high_risk_words() {
        for text in [
            "Pay now",
            "PAY NOW",
            "Delete account",
            "Confirm subscription",
            "Unsubscribe",
            "Sign out",
            "Transfer money",
            "Checkout",
            "确认支付",
        ] {
            assert!(
                super::is_sensitive_click_text(text),
                "高危文本应触发敏感点击 Ask: {text}"
            );
        }
        for text in [
            "Read more",
            "Sign in",
            "Delivery status",
            "Deletion is not supported", // 单词边界：delete 不匹配 deletion
            "Play now",                  // 单词边界：pay 不匹配 play
        ] {
            assert!(
                !super::is_sensitive_click_text(text),
                "普通文本不应触发敏感点击 Ask: {text}"
            );
        }
    }

    #[test]
    fn world_diff_reports_changes() {
        let before = ("http://a/".to_string(), 1000, 0);
        let same = ("http://a/".to_string(), 1050, 0);
        let moved = ("http://b/".to_string(), 2000, 3);
        assert_eq!(super::world_diff(&before, &same), None);
        let d = super::world_diff(&before, &moved).unwrap();
        assert!(d.contains("URL 变化"), "应报 URL 变化: {d}");
        assert!(d.contains("DOM 大小变化"), "应报 DOM 变化: {d}");
        assert!(d.contains("3 条错误"), "应报新增错误: {d}");
    }

    /// 契约锁定：world_snapshot 的 evaluate 表达式必须直接返回对象。
    /// 对象形式（当前）能解析出 URL/DOM；JSON.stringify 字符串形式
    /// （b4dd1f5 起的静默失效形态）解析结果为空——防止回归。
    #[test]
    fn parse_world_value_requires_object_form() {
        let obj = serde_json::json!({ "u": "https://a/", "d": 12345 });
        assert_eq!(super::parse_world_value(&obj), ("https://a/".to_string(), 12345));
        // 字符串形态（旧 bug）：索引不到 u/d，全部落空
        let str_form = serde_json::json!(r#"{"u":"https://a/","d":12345}"#);
        assert_eq!(super::parse_world_value(&str_form), (String::new(), 0));
    }

    /// 契约锁定：probe 返回值必须是 stringify 字符串。字符串形态（契约正确）
    /// 原样放行；对象/其他形态（e1679a0f 修复的"形态错乱"同类病）必须报错，
    /// 而非先前静默落到空快照/空结果。
    #[test]
    fn probe_result_str_requires_string_contract() {
        // 正确形态：returnByValue 返回 stringify 后的 JSON 字符串
        let ok = serde_json::json!("{\"refs\":[{\"ref\":0,\"tag\":\"button\"}],\"count\":1}");
        assert_eq!(
            super::probe_result_str(&ok, "snapshot").unwrap(),
            "{\"refs\":[{\"ref\":0,\"tag\":\"button\"}],\"count\":1}"
        );
        // 错误形态 1：返回了对象（探针未 stringify / 被二次序列化的镜像 bug）
        let obj = serde_json::json!({ "refs": [], "count": 0 });
        let e = super::probe_result_str(&obj, "snapshot").unwrap_err();
        assert!(e.contains("snapshot"), "错误应带上调用点标签: {e}");
        assert!(e.contains("形态异常"), "错误应明确提示形态异常: {e}");
        assert!(e.contains("对象"), "对象形态应被指出: {e}");
        // 错误形态 2：Null / 数字 / 非字符串
        for bad in [serde_json::Value::Null, serde_json::json!(42), serde_json::json!(true)] {
            assert!(super::probe_result_str(&bad, "inspect").is_err(), "非字符串形态应报错: {bad}");
        }
    }

    /// A4：ensure_observer_started 在重启时复用旧缓冲（Arc 同一）——
    /// 观察任务短暂断连/重启不丢已累积事件历史。无需真实 CDP：
    /// start_observer 的 tokio 任务连不上端口会自动静默退出，buffers Arc 不受影响。
    #[tokio::test]
    async fn observer_restart_reuses_buffers_arc() {
        use std::sync::Arc;
        let mut sess = CdpSession::default();
        // 首次启动：产生一个全新 buffers Arc
        super::ensure_observer_started(&mut sess, 39998, "t1");
        let first = sess.observer.as_ref().expect("首次启动应生成 observer").buffers.clone();
        // 模拟观察任务已死（alive=false），触发惰性重启
        sess.observer.as_ref().unwrap().alive.store(false, Ordering::SeqCst);
        super::ensure_observer_started(&mut sess, 39998, "t1");
        let second = sess.observer.as_ref().expect("重启后 observer 应存在").buffers.clone();
        assert!(
            Arc::ptr_eq(&first, &second),
            "重启必须复用同一个 buffers Arc——否则历史被清空"
        );
    }

    /// A4：在途启动闸——第二个 ensure_observer_started 在闸生效时被跳过，
    /// observer 不被替换（防并发重复 spawn 出孤儿观察任务）。
    #[tokio::test]
    async fn observer_inflight_guard_blocks_duplicate_start() {
        let mut sess = CdpSession::default();
        super::ensure_observer_started(&mut sess, 39998, "t1");
        let before = sess.observer.as_ref().map(|o| Arc::clone(&o.buffers));
        // 模拟并发：另一条路径已置起在途闸
        sess.observer_starting.store(true, Ordering::SeqCst);
        super::ensure_observer_started(&mut sess, 39998, "t1");
        let after = sess.observer.as_ref().map(|o| Arc::clone(&o.buffers));
        assert!(
            Arc::ptr_eq(&before.unwrap(), &after.unwrap()),
            "在途闸生效时不得替换 observer（防孤儿任务）"
        );
    }

    /// P0 新动作的参数校验单测：在触及真实 CDP 前先拒绝非法参数，
    /// 避免坏参数被误判成「需要真实浏览器」而漏测。
    #[tokio::test]
    async fn new_actions_reject_invalid_args_before_cdp() {
        let e = super::cdp_navigate("   ", None).await.unwrap_err();
        assert!(e.contains("url 不能为空"), "{e}");
        let e = super::cdp_content(None, Some("pdf".into()), None, None, None)
            .await
            .unwrap_err();
        assert!(e.contains("text 或 markdown"), "{e}");
        let e = super::cdp_select("37", "", None).await.unwrap_err();
        assert!(e.contains("value 不能为空"), "{e}");
        let e = super::cdp_upload(None, vec![], None).await.unwrap_err();
        assert!(e.contains("files 不能为空"), "{e}");
        let e = super::cdp_close_tab("  ", None).unwrap_err();
        assert!(e.contains("targetId 不能为空"), "{e}");
        let e = super::cdp_press("a", Some(vec!["hyper".into()]), None)
            .await
            .unwrap_err();
        assert!(e.contains("不支持的修饰键"), "{e}");
    }

    /// 第三批 network 配对：requestWillBeSent 建立一条记录，
    /// responseReceived 按 requestId 回填同一条（不追加 resp 流水账），
    /// loadingFailed 回填 error 且不把 requestId 塞进 url。
    #[test]
    fn network_events_pair_by_request_id() {
        let mut bufs = EventBuffers::default();
        network_on_request(
            &mut bufs,
            &serde_json::json!({
                "requestId": "r1",
                "url": "https://example.com/a",
                "method": "GET",
                "type": "Document",
                "wallTime": 1.5,
                "request": { "url": "https://example.com/a", "method": "GET", "headers": { "accept": "*/*" } }
            }),
        );
        network_on_response(
            &mut bufs,
            &serde_json::json!({
                "requestId": "r1",
                "response": { "url": "https://example.com/a", "status": 200, "statusText": "OK", "mimeType": "text/html", "headers": { "content-type": "text/html" } }
            }),
        );
        assert_eq!(bufs.network.len(), 1, "response 必须回填同一条请求，而不是追加第二条");
        let entry = &bufs.network[0];
        assert_eq!(entry.request_id, "r1");
        assert_eq!(entry.status, Some(200));
        assert_eq!(entry.mime_type.as_deref(), Some("text/html"));

        network_on_failed(
            &mut bufs,
            &serde_json::json!({
                "requestId": "r1",
                "errorText": "net::ERR_CONNECTION_REFUSED"
            }),
        );
        assert_eq!(bufs.network.len(), 1);
        let entry = &bufs.network[0];
        assert_eq!(entry.error.as_deref(), Some("net::ERR_CONNECTION_REFUSED"));
        assert_eq!(entry.url.as_deref(), Some("https://example.com/a"), "loadingFailed 不得用 requestId 覆盖 url");

        // 缺失 request 的孤立失败：只记 error，url 保持 null（诚实，不伪造 requestId=url）
        network_on_failed(
            &mut bufs,
            &serde_json::json!({ "requestId": "r2", "errorText": "net::ERR_FAILED" }),
        );
        let entry = bufs.network_index.get("r2").expect("孤立失败也应有索引条目");
        assert_eq!(entry.url, None);
        assert!(entry.summary_value()["error"].as_str().is_some());
    }

    /// 第三批 AX 解析：锁住 getFullAXTree 节点形态与可交互 role 白名单，
    /// 避免「命令成功但解析错位」只能在真实 Chrome 上才能暴露。
    #[test]
    fn ax_node_parsing_and_interactive_role_filter() {
        let node = serde_json::json!({
            "nodeId": "3",
            "ignored": false,
            "role": { "type": "role", "value": "button" },
            "name": { "type": "string", "value": "Save" },
            "backendDOMNodeId": 17,
            "properties": [
                { "name": "focusable", "value": { "type": "boolean", "value": true } }
            ]
        });
        let parsed = ax_node_from_value(&node).expect("标准 AX 节点应可解析");
        assert_eq!(parsed.backend_node_id, 17);
        assert_eq!(parsed.role, "button");
        assert_eq!(parsed.name, "Save");
        assert!(parsed.focusable);
        assert!(ax_role_is_interactive("Button"));
        assert!(ax_role_is_interactive("textbox"));
        assert!(!ax_role_is_interactive("StaticText"));

        let ignored = serde_json::json!({
            "role": { "value": "button" },
            "name": { "value": "x" },
            "backendDOMNodeId": 18,
            "ignored": true
        });
        assert!(ax_node_from_value(&ignored).is_none(), "ignored 节点不应进入快照");
        let no_backend = serde_json::json!({ "role": { "value": "button" }, "name": { "value": "x" } });
        assert!(ax_node_from_value(&no_backend).is_none(), "没有 backendDOMNodeId 无法回写 ref");
    }

    /// 第四批 HAR 导出的纯函数部分：不依赖 observer/Chrome 即可锁定
    /// entry 形状（queryString、headers、postData、状态、error 均不丢）。
    #[test]
    fn network_entry_har_shape_keeps_observable_fields() {
        let entry = NetworkEntry {
            request_id: "r1".into(),
            method: "GET".into(),
            url: Some("https://example.com/p?q=1&x=a b".into()),
            status: Some(200),
            status_text: Some("OK".into()),
            mime_type: Some("application/json".into()),
            resource_type: Some("XHR".into()),
            wall_time: Some(1_700_000_000.5),
            request_headers: Some(serde_json::json!({ "accept": "*/*" })),
            response_headers: Some(serde_json::json!({ "content-type": "application/json" })),
            post_data: Some("{\"a\":1}".into()),
            error: None,
            ..NetworkEntry::default()
        };
        let har = entry.har_entry();
        assert_eq!(har["request"]["method"], "GET");
        assert_eq!(har["request"]["url"], "https://example.com/p?q=1&x=a b");
        assert_eq!(har["request"]["queryString"][0]["name"], "q");
        assert_eq!(har["request"]["postData"]["text"], "{\"a\":1}");
        assert_eq!(har["response"]["status"], 200);
        assert_eq!(har["response"]["content"]["mimeType"], "application/json");
        assert_eq!(har["response"]["headers"][0]["name"], "content-type");
        assert!(!har["startedDateTime"].as_str().unwrap_or("").is_empty());
        assert_eq!(har["connection"], "r1");

        let failed = NetworkEntry {
            request_id: "r2".into(),
            url: Some("https://example.com/fail".into()),
            error: Some("net::ERR_FAILED".into()),
            ..NetworkEntry::default()
        };
        assert_eq!(failed.har_entry()["response"]["_error"], "net::ERR_FAILED");
    }

    /// 第四批 viewport 参数：坏尺寸/DPR 在碰真实 CDP 前拒绝。
    #[tokio::test]
    async fn viewport_rejects_invalid_args_before_cdp() {
        let e = cdp_set_viewport(0, 600, None, None, None).await.unwrap_err();
        assert!(e.contains("width/height"), "{e}");
        let e = cdp_set_viewport(800, 600, Some(4.0), None, None)
            .await
            .unwrap_err();
        assert!(e.contains("deviceScaleFactor"), "{e}");
    }

    /// 第三批 launch 参数：windowSize 非法值在找 Chrome 之前就被拒绝。
    #[tokio::test]
    async fn launch_rejects_invalid_window_size_before_cdp() {
        let e = cdp_launch(None, None, Some(false), Some((0, 600)), None, None, None, None)
            .await
            .unwrap_err();
        assert!(e.contains("windowSize"), "{e}");
    }

    /// 组合键参数归一化：别名收口、去重、非法值明确报错。
    #[test]
    fn parse_modifiers_normalizes_aliases_and_dedupes() {
        let m = super::parse_modifiers(Some(vec!["ctrl".into(), "Control".into(), "cmd".into()])).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].0, "Control");
        assert_eq!(m[1].0, "Meta");
        assert!(super::parse_modifiers(Some(vec!["bad".into()])).is_err());
    }

    /// Chrome 调试 HTTP 端点协议级测试：/json/new?url=... 走 PUT 且解析 target；
    /// /json/close/{targetId} 走 GET 且不要求 JSON body。不依赖真实 Chrome。
    #[test]
    fn http_new_tab_and_close_tab_protocol() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 本地测试端口");
        let port = listener.local_addr().expect("读取端口").port();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    let n = reader.read_line(&mut line).expect("read line");
                    if n == 0 || line == "\r\n" || line == "\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                let (status, body) = if head.starts_with("PUT /json/new?") {
                    (
                        "200 OK",
                        r#"{"id":"tab-1","title":"x","url":"https://example.com/?q=1","webSocketDebuggerUrl":"ws://127.0.0.1/devtools/page/tab-1"}"#,
                    )
                } else if head.starts_with("GET /json/close/tab-1") {
                    ("200 OK", "Target is closing")
                } else {
                    ("404 Not Found", "not found")
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(resp.as_bytes()).expect("write response");
            }
        });

        let created = super::http_new_tab(port as u16, "https://example.com/?q=1").expect("new tab 请求");
        assert_eq!(created["id"].as_str(), Some("tab-1"));
        super::http_close_tab(port as u16, "tab-1").expect("close tab 请求");
        server.join().expect("server join");
    }

    /// B3：cdp_wait 的固定 ms 路径——确定性休眠，不需要真实浏览器。
    #[tokio::test]
    async fn wait_fixed_ms_sleeps_and_returns() {
        use std::time::{Duration, Instant};
        let start = Instant::now();
        // 阈值上限 30s；这里用 200ms 验证至少等待了该时长
        let out = super::cdp_wait(None, Some(200), None).await.unwrap();
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_millis(200), "应至少等待 200ms, 实际 {elapsed:?}");
        assert!(out.contains("200"), "返回值应含 waited_ms: {out}");
    }

    /// B3：无 selector 也无 ms → 明确错误。
    #[tokio::test]
    async fn wait_requires_selector_or_ms() {
        let err = super::cdp_wait(None, None, None).await.unwrap_err();
        assert!(err.contains("selector 或 ms"), "应提示需要参数: {err}");
    }

    /// 租约回收 + profile 清理（遗留项实测的代码侧）：空闲超时 → kill 子进程、
    /// 移除会话、删除 profile 目录。用真实哑进程验证 kill 链路，不依赖 Chrome。
    #[test]
    fn lease_expiry_kills_child_and_cleans_profile() {
        // 哑进程：长时间存活（Windows 用 ping 循环，其他平台 sleep）
        let mut cmd = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        if cfg!(windows) {
            cmd.args(["/C", "ping", "-n", "1000", "127.0.0.1"]);
        } else {
            cmd.args(["-c", "sleep 1000"]);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::utils::HIDDEN_CONSOLE);
        }
        let child = cmd.spawn().expect("spawn 哑进程");

        let key = "lease-test-agent";
        let dir = std::env::temp_dir().join("hologram-browser-profile-99997");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("stale.txt"), "stale").ok();

        {
            let mut sessions = lock_sessions();
            sessions.insert(
                key.to_string(),
                CdpSession {
                    port: 9999,
                    target_id: None,
                    chrome_child: Some(child),
                    profile_dir: Some(dir.clone()),
                    profile_ephemeral: true,
                    slot: "lease-test-slot".into(),
                    headless: None,
                    window_size: None,
                    proxy: None,
                    proxy_bypass: None,
                    observer: None,
                    observer_starting: Arc::new(AtomicBool::new(false)),
                    // 活跃时间放到租约之外，强制命中回收分支
                    last_active: Instant::now() - session_lease() - Duration::from_secs(5),
                    created_at: Instant::now(),
                },
            );
        }

        enforce_lease();

        {
            let sessions = lock_sessions();
            assert!(!sessions.contains_key(key), "租约到期会话应被移除");
        }
        assert!(!dir.exists(), "profile 目录应随会话回收一并删除");
    }

    /// 第四批轮转清理：按修改时间淘汰前缀文件。用 File::set_times 把
    /// 文件 mtime 拨回过去，验证「保留窗口内不动、窗口外删除」。
    #[test]
    fn cleanup_old_files_by_age_removes_expired_prefix_only() {
        let dir = std::env::temp_dir().join(format!("hologram-cleanup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建清理测试目录");
        let now = std::time::SystemTime::now();
        let old_path = dir.join("hologram-browser-audit-20200101.jsonl");
        let fresh_path = dir.join("hologram-browser-audit-20260815.jsonl");
        let other_path = dir.join("keep-me.txt");
        for path in [&old_path, &fresh_path, &other_path] {
            let f = std::fs::File::create(path).expect("创建测试文件");
            let modified = if path == &old_path {
                now - std::time::Duration::from_secs(8 * 24 * 60 * 60)
            } else {
                now
            };
            let times = std::fs::FileTimes::new().set_modified(modified);
            f.set_times(times).expect("设置 mtime");
        }
        cleanup_old_files_by_age(&dir, "hologram-browser-audit-", 7, now);
        assert!(!old_path.exists(), "过期审计文件应被删除");
        assert!(fresh_path.exists(), "窗口内文件应保留");
        assert!(other_path.exists(), "非本套件前缀文件不得误删");
        assert!(
            !is_expired_file_time(now - std::time::Duration::from_secs(6 * 24 * 60 * 60), now, 7)
        );
        assert!(
            is_expired_file_time(now - std::time::Duration::from_secs(8 * 24 * 60 * 60), now, 7)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 审计回放（遗留项实测的代码侧）：写入 → 查询可见，内存环形路径闭环。
    /// 同时覆盖 agent 过滤：过滤匹配命中、过滤不匹配落空。
    #[test]
    fn audit_roundtrip() {
        let marker = format!("audit-test-{}", std::process::id());
        audit_log(Some("tester"), "eval", "1+1", &marker);
        let out = cdp_audit(Some("tester"), Some(50));
        assert!(out.contains(&marker), "审计查询应包含刚写入的条目: {out}");
        let out2 = cdp_audit(Some("no-such-agent"), Some(50));
        assert!(!out2.contains(&marker), "agent 过滤应排除他人条目: {out2}");
    }

    /// 结构化错误 code（2026-08-15 收口）：关键错误路径必须携带 `[CODE]` 前缀，
    /// 供 TS 层 parseBrowserError 路由。新增错误点需在此补断言。
    #[test]
    fn error_codes_are_routable() {
        // 参数校验类错误（不依赖 Chrome/网络，可直接触发）。
        let slot = session::normalize_slot_name("bad/name").unwrap_err();
        assert!(slot.starts_with("[CDP_SLOT_INVALID]"), "slot 非法应带 code: {slot}");
        let proxy = session::validate_proxy_arg("proxy", "").unwrap_err();
        assert!(proxy.starts_with("[CDP_PROXY_INVALID]"), "proxy 非法应带 code: {proxy}");
        let proxy_nl = session::validate_proxy_arg("proxyBypass", "a\nb").unwrap_err();
        assert!(proxy_nl.starts_with("[CDP_PROXY_INVALID]"), "proxy 换行应带 code: {proxy_nl}");
        let eval = actions::check_eval_expr("fetch('https://x')").unwrap_err();
        assert!(eval.starts_with("[CDP_EVAL_BLOCKED]"), "eval 白名单拦截应带 code: {eval}");
        // 会话状态类错误：未 launch 即 require_target（port==0 分支）。
        let no_session = actions::require_target(None).unwrap_err();
        assert!(
            no_session.starts_with("[CDP_SESSION]"),
            "未 launch 的会话错误应带 code: {no_session}"
        );
        // 无前缀的旧错误一律走 CDP_INTERNAL 兜底构造（err 函数本身的契约）。
        assert_eq!(
            errors::err(errors::codes::INTERNAL, "x"),
            "[CDP_INTERNAL] x"
        );
    }
}

// 真实 Chrome 端到端测试（无 Chrome 自动跳过，覆盖 connect/launch 全链路）。
#[cfg(test)]
mod e2e;
