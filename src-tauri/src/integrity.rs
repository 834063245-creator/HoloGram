// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 进程完整性自检（2026-10-15 事故立法）
//!
//! **病灶**（实机取证；姊妹事故 = 2026-10-07 WebView2 profile 丢标签，见
//! `.lantai/memory/webview2-profile-integrity-label-2026-10-07.md`）：外部工具（本机实测 =
//! DSH 的 workspace-write 沙箱）会给工作区**根目录**打一条**常驻且可继承**的 Low 强制
//! 完整性标签（一次 SetNamedSecurityInfoW 同时下发写授权 + Everyone 删除拒绝 + Low 标签，
//! 且其 dispose() **刻意不撤销**——standing，跨实例复用缓存；继承标志 OI/CI 让**全树**立刻
//! 被盖，包括已经编译好的产物）。目录里编译出的 lantai.exe 继承该标签后，Windows 在
//! CreateProcess 时按**镜像标签**压低进程完整性 ⇒ 进程从此写不进任何 Medium 对象
//! （~/.lantai/**、%APPDATA%、其它盘），用户侧表现为：provider 配置写失败 / 窗口状态落盘
//! 失败 / 一切 os error 5（拒绝访问），**重启无效**（标签焊在文件上，跟启动方式、跟两个
//! 软件是否同时在跑都无关）。
//!
//! **为什么进程内不能自愈**：实测（2026-10-15）Low 进程执行
//! icacls <自身> /setintegritylevel Medium 退出码 **1299**（缺 SeRelabelPrivilege）——
//! 抬高标签是特权操作 ⇒ 降权进程改不动自己。产品侧只有两条路：
//!   ① **构建期**把产物标签钉成 Medium（scripts/fix-product-integrity.cmd，build.cmd 收尾调用）；
//!   ② **启动期**读一次自己的完整性级别：低就留痕（boot.log），并让后续写失败的文案
//!      直接带上原因与**可执行**修复命令（permission_hint）——错误不静默，且不误导。

/// Medium 完整性级别的 RID（S-1-16-8192）。低于它 = 写用户目录会被系统拒绝。
pub(crate) const MEDIUM: u32 = 0x2000;

static LEVEL: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
static HINT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// 完整性级别 RID → 人可读名（纯函数，供测试）。
pub(crate) fn level_name(level: u32) -> &'static str {
    match level {
        0x0000 => "Untrusted",
        0x1000 => "Low",
        0x2000 => "Medium",
        0x2100 => "Medium Plus",
        0x3000 => "High",
        0x4000 => "System",
        _ => "未知级别",
    }
}

/// 修复命令（纯函数，供测试）：把产物标签钉回 Medium 的一行 icacls。
pub(crate) fn remediation_command(exe: &std::path::Path) -> String {
    format!("icacls \"{}\" /setintegritylevel Medium", exe.display())
}

/// 当前进程的强制完整性级别 RID。查询失败 / 非 Windows ⇒ None（**绝不猜**：没有证据就不加提示）。
#[cfg(windows)]
pub(crate) fn query_level() -> Option<u32> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TokenIntegrityLevel,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
        // SID 布局（内存里就地读，省一次 GetSidSubAuthority 绑定）：
        // Revision(1) · SubAuthorityCount(1) · IdentifierAuthority(6) · SubAuthority[n](各 4)
        let mut buf = [0u64; 16];
        let mut len = 0u32;
        let queried = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            (buf.len() * 8) as u32,
            &mut len,
        );
        let _ = CloseHandle(token);
        queried.ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid.0 as *const u8;
        let count = *sid.add(1) as usize;
        if count == 0 {
            return None;
        }
        Some(std::ptr::read_unaligned(
            (sid.add(8) as *const u32).add(count - 1),
        ))
    }
}

/// 非 Windows：本模块全部退化为「无读数、不提示」（macOS/Linux 上没有这套机制）。
#[cfg(not(windows))]
pub(crate) fn query_level() -> Option<u32> {
    None
}

/// 进程完整性级别（进程内只查一次；查询失败后不再重试）。
pub(crate) fn level() -> Option<u32> {
    *LEVEL.get_or_init(query_level)
}

/// 权限类写失败追加到错误尾部的原因 + 修复命令；**仅在确认进程被降权时**非空。
pub(crate) fn permission_hint() -> Option<&'static str> {
    HINT.get().map(|s| s.as_str())
}

/// I/O 失败文案的唯一 authority：PermissionDenied（os error 5）且进程被降权时追加修复提示。
///
/// 为什么不只在调用点写死：os error 5 是本壳在降权下**所有**写失败的表现（provider 配置 /
/// 卷文件 / 编辑器），在唯一的格式化处加一次，全部调用点自动受益。
pub(crate) fn io_failure_message(label: &str, attempts: u32, e: &std::io::Error) -> String {
    let mut s = format!("{} (尝试 {} 次后失败): {}", label, attempts, e);
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        if let Some(hint) = permission_hint() {
            s.push_str(hint);
        }
    }
    s
}

/// 启动期自检：紧接 boot_log::init() 调用（那时 log 门面已可用，早了会丢记录）。
/// 低完整性 ⇒ 一条 WARN 落到 boot.log + stderr，并备好写失败时要附的修复提示。
pub(crate) fn check_at_boot() {
    let Some(lvl) = level() else { return };
    if lvl >= MEDIUM {
        return;
    }
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("lantai.exe"));
    let cmd = remediation_command(&exe);
    log::warn!(
        "[integrity] 当前进程完整性级别 = {}（低于 Medium）：程序文件带低完整性标签，\
         写用户目录（~/.lantai、%APPDATA%）会被系统拒绝（os error 5）。\
         常见来源：外部沙箱工具给本目录打了可继承的 Low 标签，构建产物继承了它。\
         修复：在普通终端执行一次 {} ，然后重启兰台（进程内无法自愈：抬高标签需要 SeRelabelPrivilege）。",
        level_name(lvl),
        cmd
    );
    let _ = HINT.set(format!(
        "\n[完整性] 当前进程为 {} 完整性，系统拒绝写入（os error 5）——程序文件带低完整性标签。\
         修复：在普通终端执行一次 {} ，然后重启兰台。",
        level_name(lvl),
        cmd
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_name_covers_known_rids() {
        assert_eq!(level_name(0x1000), "Low");
        assert_eq!(level_name(0x2000), "Medium");
        assert_eq!(level_name(0x3000), "High");
        assert_eq!(level_name(0x1234), "未知级别");
    }

    #[test]
    fn remediation_command_quotes_path_and_targets_medium() {
        let p = std::path::Path::new(r"D:\HoloGramHG\target\release\lantai.exe");
        assert_eq!(
            remediation_command(p),
            r#"icacls "D:\HoloGramHG\target\release\lantai.exe" /setintegritylevel Medium"#
        );
    }

    #[test]
    fn hint_absent_until_boot_check_has_evidence() {
        // 未跑过 check_at_boot（或进程本就正常）⇒ 普通权限错误**不得**被加料
        assert!(permission_hint().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn io_failure_message_appends_hint_only_on_permission_denied() {
        let denied = std::io::Error::from_raw_os_error(5);
        assert_eq!(denied.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(io_failure_message("write_atomic(tmp)", 1, &denied)
            .starts_with("write_atomic(tmp) (尝试 1 次后失败): "));

        let not_found = std::io::Error::from_raw_os_error(2);
        assert_eq!(
            io_failure_message("stat", 1, &not_found),
            format!("stat (尝试 1 次后失败): {}", not_found)
        );
    }
}
