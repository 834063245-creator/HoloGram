// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 兰台 Tauri 后端
// 桥接层：Agent (TypeScript) → Tauri commands → Rust 能力口
// 不做分析逻辑，只做进程管理和文本转发
// （图谱全量退役 2026-09-09：engine_transport 模块随引擎接线删除——
//  兰台零引擎内置，引擎以独立进程 + 外部 MCP 通道形态供消费。）

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)] use std::os::windows::process::CommandExt;

mod agent_isolation;
mod pty_manager;
mod lsp_manager;
mod oauth;

mod permissions;
mod tools;
mod sandbox;
mod audit;
mod credential;
mod logging;
mod boot_log;
mod integrity;
pub(crate) mod os_sandbox;
mod workspace;
mod ignored_paths;
mod utils;
mod commands;
mod confined_fs;
mod attachments;
mod image_probe;
mod rpc;
mod app;
mod lifecycle;
mod cdp;
mod window_drag_band;
mod desktop;
mod uia;
mod sensitive;
mod llm_proxy;
mod plugin_assets;
mod engine_assets;
mod composition_watcher;
mod providers_watcher;
mod purge;

use std::sync::Arc;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

// 重新导出 WorkspaceState，使命令可以以 crate::WorkspaceState 引用
pub(crate) type WorkspaceState = Arc<Mutex<Option<workspace::WorkspaceHandle>>>;


/// 返回当前活跃工作区路径（未设置时为空字符串）。
/// 前端在冷启动时 graph meta.source_root 缺失时用作回退。
#[tauri::command]
fn get_active_project(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    utils::workspace_path(&state)
}

fn main() {
    // 启动期诊断日志（2026-10-07 事故立法）：tauri-runtime-wry 的窗口/webview 创建失败
    // 只走 `log::error!` 且不回传调用方——不装 logger 就会静默成「双击后什么都不发生」。
    // 必须最先执行：早于 generate_context / 任何可能失败的初始化。
    boot_log::init();
    // 进程完整性自检（2026-10-15 事故立法）：外部沙箱给工作区打的可继承 Low 标签会被
    // 构建产物继承 ⇒ 本进程以 Low 运行 ⇒ 写用户目录全被拒（os error 5，且重启无效）。
    // 进程内无法自愈（抬高标签要 SeRelabelPrivilege），所以这里只做留痕 + 备好修复提示；
    // 真正的治疗在构建期（scripts\fix-product-integrity.cmd）。头注见 integrity.rs。
    integrity::check_at_boot();

    let context = tauri::generate_context!();

    // 卸载期用户数据清理（安装器的代码路径，见 src/purge.rs）：
    // 命中 `--purge-user-data` 就地清理并退出——**绝不进入任何初始化**，
    // 否则边删边写（watcher/日志/凭据重建），用户看到的还是「没卸干净」。
    if let Some(code) = purge::cli_entry(&context.config().identifier) {
        std::process::exit(code);
    }

    let workspace_state: WorkspaceState = Arc::new(Mutex::new(None));
    // L1 应用层：按工作区实例化的数据上下文注册表（会话 attach 的家）。
    let app_contexts: std::sync::Arc<app::AppContexts> = std::sync::Arc::new(app::AppContexts::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 窗口位置/尺寸持久化 — Linux 无边框窗口每次启动不再回退到居中 1000x700
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(workspace_state)
        .manage(app_contexts)
        .on_window_event(|window, event| match event {
            // 窗口状态落盘（2026-09-18 事故立法）：`tauri-plugin-window-state` 全仓
            // **唯一**的落盘点在 `RunEvent::Exit`，而本壳在 `Destroyed` 里
            // `std::process::exit(0)`（下面那条，防僵尸子进程的既定设计）抢在事件
            // 循环收尾之前 ⇒ 正常关窗永不落盘。实测物证：`.window-state.json` 只
            // 在「应用还在运行时被系统关机」那两次的同一秒被写（09-15 04:12:24 /
            // 09-16 18:34:49），中间十余次应用自身退出一次都没写 ⇒ 用户感知
            // 「不记住窗口是否最大化」。
            // `CloseRequested` 是唯一一个「窗口还活着、几何与最大化态都读得到」的
            // 时刻，且三条关窗路径（窗口钮 / 前端 watchWindowClose 拦截后 destroy /
            // 系统关窗）都先经过它。写失败必须可见，不得静默。
            // flags 用 `all()`：与插件注册时的缺省 StateFlags 一致（`Builder::new()`）。
            tauri::WindowEvent::CloseRequested { .. } => {
                if let Err(e) = window.app_handle().save_window_state(StateFlags::all()) {
                    tracing::warn!("[window] 窗口状态落盘失败: {e}");
                }
            }
            tauri::WindowEvent::Destroyed => {
                // Phase 1: Drain — 后台线程执行，3s 超时保护避免 shutdown 阻塞导致僵尸进程
                let app = window.app_handle();
                let (tx, rx) = std::sync::mpsc::channel();
                let app_clone = app.clone();
                std::thread::spawn(move || {
                    if let Some(ledger) = app_clone.try_state::<std::sync::Mutex<lifecycle::ResourceLedger>>() {
                        let ledger = ledger.lock().unwrap_or_else(|e| e.into_inner());
                        ledger.shutdown_all(std::time::Duration::from_secs(2));
                    }
                    if let Some(ws_state) = app_clone.try_state::<WorkspaceState>() {
                        let _guard = ws_state.lock();
                    }
                    let _ = tx.send(());
                });
                // 最多等 3 秒，超时直接强退
                let _ = rx.recv_timeout(std::time::Duration::from_secs(3));
                // Phase 2: Purge — 强制退出确保无僵尸进程
                std::process::exit(0);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            rpc::rpc,
            get_active_project,
        ])
        .setup(|app| {
            // .hologram → .lantai 数据目录迁移（2026-08-23 改名）：
            // 开发/安装目录下的老 .hologram 在 setup 期一次性重命名。
            // 工作区级 .hologram 在 workspace_activate 时各自迁移。
            let _ = utils::migrate_hologram_to_lantai(&utils::project_root());
            // Phase 4a: OS 沙箱 — Job Object 实现 die-with-parent + 捆绑 MSYS2 bash 解析
            os_sandbox::init(app.handle());
            // 如果 OS 沙箱降级则警告 — 权限引擎作为回退
            let s = os_sandbox::status();
            if !matches!(s, os_sandbox::SandboxStatus::Available) {
                eprintln!("[hologram] OS sandbox 不可用 — 仅权限引擎生效");
            }
            // LLM 反向代理 — 绕开 WebView CORS，让 provider 调用走后端（2026-08-16）
            // P1d：先注入内置插件产物目录（打包态 resource_dir/builtin——渲染器
            // 插件等第一方产物回退源）；dev/测试由 builtin_plugins_root 兜底仓库。
            plugin_assets::init_builtin_plugins_dir(app.handle());
            // 拖动带夹紧（2026-09-14 事故立法）：WebView2 宿主窗口把顶部 ~86px 当
            // caption，而书眉只有 56px——多出的「幽灵标题栏」会吃掉画布顶缘/目次带
            // 最上方（在那里拖内容＝挪窗口）+ 应用自绘窗口钮。子类化夹到书眉高。
            window_drag_band::install(app.handle().clone());
            let _proxy_port = llm_proxy::spawn_llm_proxy();
            // 组合层热重载 watcher（S4-2）：~/.lantai/composition/ 根级
            // roster.patch.yml 变更 → composition:changed 事件 → 前端 reload。
            // app 生命周期 = watcher 生命周期（Drop 停线程）。
            let _composition_watcher = composition_watcher::CompositionWatcher::start(app.handle().clone());
            app.manage(std::sync::Mutex::new(_composition_watcher));
            // provider 配置文件热重载 watcher：~/.lantai/providers.yml 变更 →
            // providers:changed 事件 → 前端重读 provider 配方。
            // manage key = Mutex<ProvidersWatcher>（与组合 watcher 不同类型，互不冲突）；
            // app 生命周期 = watcher 生命周期（Drop 停线程）。
            let _providers_watcher = providers_watcher::ProvidersWatcher::start(app.handle().clone());
            app.manage(std::sync::Mutex::new(_providers_watcher));
            // Memory Bundle: 如果在 hologram 旁找到 exe 则启动
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    let mb = exe_dir.join("memory-bundle.exe");
                    if mb.exists() {
                        let mut mc = std::process::Command::new(&mb);
                        mc.stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null());
                        #[cfg(windows)]
                        { mc.creation_flags(crate::utils::HIDDEN_CONSOLE); }
                        // 保留 Child 句柄供 ResourceLedger 在关闭时终止
                        if let Ok(child) = mc.spawn() {
                            *crate::utils::lock_or_recover(&commands::external::MEMORY_BUNDLE_CHILD) = Some(child);
                        }
                    }
                }
            }

            // 将所有服务注册到 ResourceLedger
            let mut ledger = lifecycle::ResourceLedger::new();
            ledger.register(Box::new(lifecycle::LlmProxyService));
            ledger.register(Box::new(lifecycle::BgJobsService));
            ledger.register(Box::new(lifecycle::PtyService));
            ledger.register(Box::new(lifecycle::LspService));
            ledger.register(Box::new(lifecycle::UiaService));
            ledger.register(Box::new(lifecycle::MemoryBundleService));
            ledger.register(Box::new(lifecycle::LoggingService));
            app.manage(std::sync::Mutex::new(ledger));

            Ok(())
        })
        .run(context)
        .expect("error running hologram");
}

// ═══════════════════════════════════════════════════════
// #[cfg(test)] — 路由测试辅助（集成测试无法访问 binary crate static）
// ═══════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils;

    #[test]
    fn workspace_handle_activate_persists_last_project() {
        let tmp = std::env::temp_dir().join("hologram_test_activate");
        let _ = std::fs::create_dir_all(&tmp);
        let handle = workspace::WorkspaceHandle::new(&tmp.to_string_lossy());
        handle.activate(&tmp);
        let last_path = tmp.join(".last_project");
        assert!(last_path.exists());
        let content = std::fs::read_to_string(&last_path).unwrap();
        assert_eq!(content, tmp.to_string_lossy());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 回归：占位工作区（path=''）activate 不清空 .last_project——
    /// 「最近工作区」记忆只记真实绑定（引擎关态冷启动的唯一恢复信号，
    /// 2026-08-22 引擎开关配套，实测踩中：占位启动把记忆抹了）。
    ///
    /// ⚠ 测试纪律：activate 的参数 root 必须指向临时目录，不得用
    /// utils::project_root()（仓库根）——后者会把假数据写进真实
    /// .last_project，污染用户工作区指针（2026-08-23 实测踩中：
    /// D:/some/real/project 残留在仓库根，新前端 listSavedSessions 全空）。
    #[test]
    fn placeholder_activate_does_not_clear_last_project() {
        let tmp = std::env::temp_dir().join("hologram_test_placeholder_activate");
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::create_dir_all(&tmp);
        let last = tmp.join(".last_project");
        // 先写一个非空记忆，再让占位句柄 activate，验证不被清空
        let _ = std::fs::write(&last, "D:/some/real/project");
        let handle = workspace::WorkspaceHandle::new("");
        handle.activate(&tmp);
        let content = std::fs::read_to_string(&last).unwrap_or_default();
        assert_eq!(content, "D:/some/real/project", "占位 activate 不得清空 .last_project");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// get_last_project（引擎开关关态的冷启动恢复信号）：读 .last_project，
    /// 缺文件/空内容 = None（trim 后过滤——写入侧带换行也读得回）。
    ///
    /// ⚠ 此测试借 handle.activate 写真实 .last_project（仓库根）后读回——
    /// 验证「写入路径与读取路径同 source」的契约。由于读写两侧都走
    /// utils::project_root()，并无伪造风险；但测试尾声必须把仓库根的
    /// .last_project 清掉，避免污染真实「最近项目」指针（2026-08-23 教训）。
    #[test]
    fn get_last_project_reads_last_project_file() {
        let tmp = std::env::temp_dir().join("hologram_test_get_last_project");
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::create_dir_all(&tmp);
        // project_root() 在测试态 = CARGO_MANIFEST_DIR 的上级（仓库根）——
        // 与 activate 写入同源：借 handle.activate 写，再读回验证往返。
        let root = utils::project_root();
        let last_at_root = root.join(".last_project");
        // 快照原值，测试尾声还原——避免覆盖真实「上次打开的项目」指针
        let prior = std::fs::read_to_string(&last_at_root).ok();
        let handle = workspace::WorkspaceHandle::new(&tmp.to_string_lossy());
        handle.activate(&root);
        let r = commands::workspace::get_last_project().expect("get_last_project should not fail");
        assert_eq!(r.as_deref(), Some(tmp.to_string_lossy().as_ref()));
        // 还原仓库根的 .last_project 到测试前状态（有则写回，无则删除）
        match prior {
            Some(content) => {
                let _ = std::fs::write(&last_at_root, content);
            }
            None => {
                let _ = std::fs::remove_file(&last_at_root);
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn get_last_project_missing_file_is_none() {
        let root = utils::project_root();
        let last = root.join(".last_project");
        if !last.exists() {
            assert_eq!(commands::workspace::get_last_project().unwrap(), None);
        }
        // 文件存在时无法构造缺失态（并行测试共享仓库根）——已由上一测试覆盖读取面。
    }

    #[test]
    fn workspace_handle_deactivate_is_idempotent() {
        let tmp = std::env::temp_dir().join("hologram_test_deactivate");
        let _ = std::fs::create_dir_all(&tmp);
        let mut handle = workspace::WorkspaceHandle::new(&tmp.to_string_lossy());
        // deactivate 幂等，不 panic（图谱退役后 watcher/pump 已删，纯状态清理）
        handle.deactivate();
        handle.deactivate();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn workspace_path_returns_error_when_no_workspace() {
        let state: WorkspaceState = Arc::new(Mutex::new(None));
        assert!(utils::workspace_path(&state).is_err());
    }

    #[test]
    fn workspace_path_returns_path_when_workspace_active() {
        let tmp = std::env::temp_dir().join("hologram_test_path");
        let _ = std::fs::create_dir_all(&tmp);
        let handle = workspace::WorkspaceHandle::new(&tmp.to_string_lossy());
        let state: WorkspaceState = Arc::new(Mutex::new(Some(handle)));
        assert_eq!(utils::workspace_path(&state).unwrap(), tmp.to_string_lossy());
        let _ = std::fs::remove_dir_all(&tmp);
    }

}
