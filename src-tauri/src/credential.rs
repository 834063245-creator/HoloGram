// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 凭证存储 — 跨平台加密密钥存储。
//
// Windows: DPAPI via direct FFI (用户级加密, 基于文件)。
// macOS:   Keychain via `security` CLI (内置, 零依赖)。
// Linux:   Secret Service via `secret-tool` CLI (gnome-keyring/kwallet)。
//
// 所有平台共享相同的公共 API：
//   store_api_key(provider, key) / get_api_key(provider) / delete_api_key
//
// 当 OS 密钥存储不可用时（无 keyring 守护进程、无 secret-tool），
// 操作返回 Err — 前端（settings.ts persistSecrets/restoreSecrets）catch 静默忽略。
// ⚡ 2026-08-04 治理后 apiKey 权威=系统加密凭据，localStorage 不存明文，
// 不存在「回退到 localStorage 明文存储」路径。

#![allow(non_snake_case)] // Win32 FFI 命名规范

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// 进程级写锁 — 串行化 store/delete 的「读-改-写」序列，
/// 防止多窗口/多前端并发写互相覆盖导致丢 key。
static CRED_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn cred_write_lock() -> &'static Mutex<()> {
    CRED_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

/// 单条 key 的长度上限 — 正常 API key < 200 字符，4096 已极宽松。
/// 2026-08-08 事故：前端双重 JSON 编码反馈循环把 key 膨胀到 128MiB，
/// 启动时 credential_get 经 IPC 回传 256MB 响应，直接击毁 WebView2 进程栈。
/// 写入端必须拒绝此类毒值，否则应用会在每次启动时自毁。
const MAX_KEY_LEN: usize = 4096;

/// 凭证密文文件的大小上限 — 正常文件 < 1KB。
/// 超过即视为毒化/损坏：读取方报错（前端按无 key 处理），
/// 写入方走 load_or_backup_cred_map 隔离备份后重建。
/// 绝不对超大文件执行解密+解析——那正是烧毁 IPC 通道的路径。
const MAX_CRED_FILE_SIZE: usize = 4 * 1024 * 1024;

// ═══════════════════════════════════════════════════════════════
// 公共 API — 所有平台相同
// ═══════════════════════════════════════════════════════════════

/// 为 provider 存储 API key。
pub fn store_api_key(provider: &str, key: &str) -> Result<(), String> {
    // 中毒后取回守卫继续工作 —— 写入本身是原子 rename，数据不会因 panic 损坏
    let _guard = cred_write_lock().lock().unwrap_or_else(|e| e.into_inner());
    // 尺寸护栏：拒绝写入超长 key（双重编码 bug 的产物），防止毒化凭证文件
    if key.len() > MAX_KEY_LEN {
        return Err(format!(
            "credential: key 长度 {} 超过上限 {}，拒绝写入（疑似编码 bug 产生的毒值）",
            key.len(),
            MAX_KEY_LEN
        ));
    }
    #[cfg(windows)]
    {
        store_windows(provider, key)
    }
    #[cfg(target_os = "macos")]
    {
        store_macos(provider, key)
    }
    #[cfg(target_os = "linux")]
    {
        store_linux(provider, key)
    }
}

/// 获取 provider 的 API key。未存储时返回 None。
pub fn get_api_key(provider: &str) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        get_windows(provider)
    }
    #[cfg(target_os = "macos")]
    {
        get_macos(provider)
    }
    #[cfg(target_os = "linux")]
    {
        get_linux(provider)
    }
}

/// 删除单个 provider 的 API key。key 不存在不算错误。
pub fn delete_api_key(provider: &str) -> Result<(), String> {
    let _guard = cred_write_lock().lock().unwrap_or_else(|e| e.into_inner());
    #[cfg(windows)]
    {
        delete_windows(provider)
    }
    #[cfg(target_os = "macos")]
    {
        delete_macos(provider)
    }
    #[cfg(target_os = "linux")]
    {
        delete_linux(provider)
    }
}

// ═══════════════════════════════════════════════════════════════
// Windows — DPAPI (raw FFI, 用户级加密, 基于文件)
// ═══════════════════════════════════════════════════════════════

#[cfg(windows)]
mod windows_impl {
    use super::*;

    type CryptProtectDataFn = unsafe extern "system" fn(
        *const DATA_BLOB, *const u16, *const DATA_BLOB, *const c_void,
        *const c_void, u32, *mut DATA_BLOB,
    ) -> i32;

    type CryptUnprotectDataFn = unsafe extern "system" fn(
        *const DATA_BLOB, *mut u16, *const DATA_BLOB, *const c_void,
        *const c_void, u32, *mut DATA_BLOB,
    ) -> i32;

    type LocalFreeFn = unsafe extern "system" fn(isize) -> isize;

    #[repr(C)]
    struct DATA_BLOB {
        cbData: u32,
        pbData: *mut u8,
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    fn dpapi_encrypt(data: &[u8]) -> Result<Vec<u8>, String> {
        let crypt32 = unsafe { libloading::Library::new("crypt32.dll") }
            .map_err(|e| format!("cannot load crypt32: {e}"))?;
        let kernel32 = unsafe { libloading::Library::new("kernel32.dll") }
            .map_err(|e| format!("kernel32: {e}"))?;

        let CryptProtectData: libloading::Symbol<CryptProtectDataFn> =
            unsafe { crypt32.get(b"CryptProtectData") }
                .map_err(|e| format!("CryptProtectData: {e}"))?;
        let LocalFree: libloading::Symbol<LocalFreeFn> =
            unsafe { kernel32.get(b"LocalFree") }
                .map_err(|e| format!("LocalFree: {e}"))?;

        let mut blob_in = DATA_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut blob_out = DATA_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

        let ret = unsafe {
            CryptProtectData(
                &mut blob_in,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut blob_out,
            )
        };
        if ret == 0 {
            return Err("DPAPI encrypt failed".into());
        }
        let encrypted = unsafe {
            std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec()
        };
        unsafe { LocalFree(blob_out.pbData as isize) };
        Ok(encrypted)
    }

    fn dpapi_decrypt(data: &[u8]) -> Result<Vec<u8>, String> {
        let crypt32 = unsafe { libloading::Library::new("crypt32.dll") }
            .map_err(|e| format!("cannot load crypt32: {e}"))?;
        let kernel32 = unsafe { libloading::Library::new("kernel32.dll") }
            .map_err(|e| format!("kernel32: {e}"))?;

        let CryptUnprotectData: libloading::Symbol<CryptUnprotectDataFn> =
            unsafe { crypt32.get(b"CryptUnprotectData") }
                .map_err(|e| format!("CryptUnprotectData: {e}"))?;
        let LocalFree: libloading::Symbol<LocalFreeFn> =
            unsafe { kernel32.get(b"LocalFree") }
                .map_err(|e| format!("LocalFree: {e}"))?;

        let mut blob_in = DATA_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut blob_out = DATA_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

        let ret = unsafe {
            CryptUnprotectData(
                &mut blob_in,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut blob_out,
            )
        };
        if ret == 0 {
            return Err("DPAPI decrypt failed".into());
        }
        let plain = unsafe {
            std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec()
        };
        unsafe { LocalFree(blob_out.pbData as isize) };
        Ok(plain)
    }

    pub(super) fn cred_path() -> PathBuf {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
        // 注意：目录名 com.hologram.app 与 tauri.conf.json 的 identifier
        // (com.hologram.hg) 不一致是**有意保留**的 —— 存量用户的密文
        // 都在旧路径下，迁移路径等于静默丢 key，因此不得更改。
        base.join("com.hologram.app").join("credentials.enc")
    }

    fn load_cred_map() -> Result<serde_json::Map<String, serde_json::Value>, String> {
        let map = load_cred_map_raw()?;
        // 尺寸护栏：丢弃超长 value（毒化产物），绝不让其进入 IPC 响应。
        // 保留正常 key，让应用在文件部分损坏时仍可用。
        Ok(map
            .into_iter()
            .filter(|(k, v)| {
                let ok = v.as_str().map(|s| s.len() <= MAX_KEY_LEN).unwrap_or(false);
                if !ok {
                    tracing::warn!("[credential] 丢弃异常条目 provider={}（value 超限或非字符串）", k);
                }
                ok
            })
            .collect())
    }

    fn load_cred_map_raw() -> Result<serde_json::Map<String, serde_json::Value>, String> {
        let encrypted = match std::fs::read(cred_path()) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(serde_json::Map::new())
            }
            Err(e) => return Err(format!("read credentials: {e}")),
        };
        // 尺寸护栏：超大密文绝不解密解析（解密 256MB 需数十秒且响应会击毁 IPC）
        if encrypted.len() > MAX_CRED_FILE_SIZE {
            return Err(format!(
                "credentials.enc 大小 {} 字节超过上限 {}，按损坏处理",
                encrypted.len(),
                MAX_CRED_FILE_SIZE
            ));
        }
        let plain = dpapi_decrypt(&encrypted)?;
        let s = String::from_utf8(plain).map_err(|e| format!("invalid cred: {e}"))?;
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let Some(map) = v.as_object() {
                return Ok(map.clone());
            }
            if let (Some(prov), Some(key)) = (
                v.get("provider").and_then(|p| p.as_str()),
                v.get("key").and_then(|k| k.as_str()),
            ) {
                let mut map = serde_json::Map::new();
                map.insert(prov.to_string(), serde_json::Value::String(key.to_string()));
                return Ok(map);
            }
        }
        let mut map = serde_json::Map::new();
        for line in s.lines() {
            if let Some((prov, key)) = line.split_once('=') {
                map.insert(prov.to_string(), serde_json::Value::String(key.to_string()));
            }
        }
        Ok(map)
    }

    /// 供 store/delete 使用的加载：文件存在但解密/解析失败时，先把
    /// 损坏的密文备份为 credentials.enc.corrupt-<unix_ts> 再从空 map
    /// 重新开始 —— 绝不静默丢弃已有密文。备份本身失败则返回错误
    /// （放弃写入，避免唯一密文被覆盖）。
    fn load_or_backup_cred_map() -> Result<serde_json::Map<String, serde_json::Value>, String> {
        match load_cred_map() {
            Ok(map) => Ok(map),
            Err(load_err) => {
                let path = cred_path();
                if !path.exists() {
                    // 文件不存在却读失败（权限等）— 非损坏场景，直接上报
                    return Err(load_err);
                }
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let backup = path.with_file_name(format!("credentials.enc.corrupt-{ts}"));
                std::fs::rename(&path, &backup).map_err(|e| {
                    format!(
                        "credentials.enc 损坏（{load_err}）且备份失败（{e}）— 已放弃写入以免丢 key"
                    )
                })?;
                tracing::warn!(
                    "[credential] credentials.enc 损坏（{}），已备份到 {}",
                    load_err,
                    backup.display()
                );
                Ok(serde_json::Map::new())
            }
        }
    }

    /// 原子写入凭证密文：先写同目录临时文件，再 rename 覆盖，
    /// 避免写入中途崩溃留下截断/空文件。
    /// Windows 上 rename 不能覆盖已存在的目标 —— 失败后删除目标重试。
    fn write_cred_file_atomic(encrypted: &[u8]) -> Result<(), String> {
        let path = cred_path();
        let tmp = path.with_extension("enc.tmp");
        std::fs::write(&tmp, encrypted).map_err(|e| format!("write credentials tmp: {e}"))?;
        match std::fs::rename(&tmp, &path) {
            Ok(()) => Ok(()),
            Err(first) => {
                match std::fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        return Err(format!(
                            "覆盖 credentials.enc 失败（删除旧文件: {e}; rename: {first}）"
                        ))
                    }
                }
                std::fs::rename(&tmp, &path)
                    .map_err(|e| format!("覆盖 credentials.enc 失败（rename: {e}）"))
            }
        }
    }

    pub(super) fn store_windows(provider: &str, key: &str) -> Result<(), String> {
        let dir = cred_path().parent()
            .ok_or_else(|| "无法确定凭证目录的父路径".to_string())?
            .to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|e| format!("create credentials dir: {e}"))?;
        let mut map = load_or_backup_cred_map()?;
        map.insert(provider.to_string(), serde_json::Value::String(key.to_string()));
        let data = serde_json::Value::Object(map).to_string();
        let encrypted = dpapi_encrypt(data.as_bytes())?;
        write_cred_file_atomic(&encrypted)
    }

    pub(super) fn get_windows(provider: &str) -> Result<Option<String>, String> {
        let map = load_cred_map()?;
        Ok(map
            .get(provider)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    }

    pub(super) fn delete_windows(provider: &str) -> Result<(), String> {
        let mut map = load_or_backup_cred_map()?;
        if !map.contains_key(provider) {
            return Ok(());
        }
        map.remove(provider);
        let data = serde_json::Value::Object(map).to_string();
        let encrypted = dpapi_encrypt(data.as_bytes())?;
        write_cred_file_atomic(&encrypted)
    }
}

// 在模块级别重新导出 Windows 函数
#[cfg(windows)]
use windows_impl::*;

// ═══════════════════════════════════════════════════════════════
// macOS — Keychain via `security` CLI (内置, 零依赖)
// ═══════════════════════════════════════════════════════════════

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::*;

    const SERVICE: &str = "hologram";

    pub(super) fn store_macos(provider: &str, key: &str) -> Result<(), String> {
        let output = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-s",
                SERVICE,
                "-a",
                provider,
                "-w",
                key,
                "-U", // 如已存在则更新
            ])
            .output()
            .map_err(|e| format!("security CLI not available: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Keychain store failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    }

    pub(super) fn get_macos(provider: &str) -> Result<Option<String>, String> {
        let output = std::process::Command::new("security")
            .args(["find-generic-password", "-s", SERVICE, "-a", provider, "-w"])
            .output()
            .map_err(|e| format!("security CLI not available: {e}"))?;
        if output.status.success() {
            // 密码输出到 stdout，带尾部换行
            let key = String::from_utf8_lossy(&output.stdout);
            let key = key.trim_end_matches('\n');
            if key.is_empty() {
                Ok(None)
            } else {
                Ok(Some(key.to_string()))
            }
        } else if output.status.code() == Some(44) {
            // 退出码 44 = errSecItemNotFound — 未存储，不算错误
            Ok(None)
        } else {
            Err(format!(
                "Keychain lookup failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    pub(super) fn delete_macos(provider: &str) -> Result<(), String> {
        let output = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", provider])
            .output()
            .map_err(|e| format!("security CLI not available: {e}"))?;
        // 幂等删除：条目不存在（errSecItemNotFound=44）不算错误，其余失败上报
        if output.status.success() || output.status.code() == Some(44) {
            Ok(())
        } else {
            Err(format!(
                "Keychain delete failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }
}

#[cfg(target_os = "macos")]
use macos_impl::*;

// ═══════════════════════════════════════════════════════════════
// Linux — Secret Service via `secret-tool` CLI (gnome-keyring/kwallet)
// ═══════════════════════════════════════════════════════════════

#[cfg(target_os = "linux")]
mod linux_impl {
    const SERVICE: &str = "hologram";

    /// 检查 secret-tool 是否可用（已安装 gnome-keyring/kwallet）。
    fn secret_tool_available() -> bool {
        std::process::Command::new("which")
            .arg("secret-tool")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    pub(super) fn store_linux(provider: &str, key: &str) -> Result<(), String> {
        if !secret_tool_available() {
            return Err("secret-tool not installed (install gnome-keyring or kwallet)".into());
        }

        let label = format!("HoloGram: {provider}");
        let mut cmd = std::process::Command::new("secret-tool");
        cmd.args(["store", "--label", &label, "service", SERVICE, "account", provider]);

        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("secret-tool spawn: {e}"))?;

        use std::io::Write;
        child
            .stdin
            .as_mut()
            .ok_or("stdin not available")?
            .write_all(key.as_bytes())
            .map_err(|e| format!("write to secret-tool: {e}"))?;

        let output = child
            .wait_with_output()
            .map_err(|e| format!("secret-tool wait: {e}"))?;

        if !output.status.success() {
            return Err(format!(
                "Secret Service store failed (is gnome-keyring/kwallet running?): {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    }

    pub(super) fn get_linux(provider: &str) -> Result<Option<String>, String> {
        if !secret_tool_available() {
            return Err("Secret Service 不可用（请确认 gnome-keyring/kwallet 正在运行）".into());
        }

        let output = std::process::Command::new("secret-tool")
            .args(["lookup", "service", SERVICE, "account", provider])
            .output()
            .map_err(|e| format!("secret-tool spawn: {e}"))?;

        if output.status.success() {
            let key = String::from_utf8_lossy(&output.stdout);
            let key = key.trim_end_matches('\n');
            if key.is_empty() {
                Ok(None)
            } else {
                Ok(Some(key.to_string()))
            }
        } else {
            Ok(None) // 未找到 key
        }
    }

    pub(super) fn delete_linux(provider: &str) -> Result<(), String> {
        if !secret_tool_available() {
            return Err("Secret Service 不可用（请确认 gnome-keyring/kwallet 正在运行）".into());
        }

        let output = std::process::Command::new("secret-tool")
            .args(["clear", "service", SERVICE, "account", provider])
            .output()
            .map_err(|e| format!("secret-tool spawn: {e}"))?;
        // 幂等删除：clear 未匹配到条目时仍返回 0；非零退出码为真实错误，上报
        if !output.status.success() {
            return Err(format!(
                "Secret Service delete failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
use linux_impl::*;

// ═══════════════════════════════════════════════════════════════
// 其他平台的回退
// ═══════════════════════════════════════════════════════════════

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
compile_error!("credential.rs: unsupported platform");

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    // ── JSON map 格式测试（平台无关）──

    #[test]
    fn test_json_map_roundtrip() {
        // 验证 Windows 凭证存储使用的 JSON Object map 格式
        // 经过完整的序列化 → 反序列化周期后无数据丢失。
        let mut map = serde_json::Map::new();
        map.insert(
            "deepseek".to_string(),
            serde_json::Value::String("sk-abc123".to_string()),
        );
        map.insert(
            "anthropic".to_string(),
            serde_json::Value::String("sk-ant-xyz".to_string()),
        );

        let json = serde_json::Value::Object(map.clone()).to_string();
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("valid JSON roundtrip");
        let parsed_map = parsed.as_object().expect("top-level must be an object");

        assert_eq!(parsed_map.len(), 2);
        assert_eq!(
            parsed_map.get("deepseek").and_then(|v| v.as_str()),
            Some("sk-abc123")
        );
        assert_eq!(
            parsed_map.get("anthropic").and_then(|v| v.as_str()),
            Some("sk-ant-xyz")
        );
    }

    #[test]
    fn test_json_map_empty() {
        let map = serde_json::Map::new();
        let json = serde_json::Value::Object(map).to_string();
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("empty map must parse");
        assert!(parsed.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_json_map_special_characters() {
        // Key 可能包含特殊 JSON 字符 — 确保它们能正确处理。
        let mut map = serde_json::Map::new();
        map.insert(
            "openai".to_string(),
            serde_json::Value::String("sk-\"quoted\"key\nwith newline".to_string()),
        );

        let json = serde_json::Value::Object(map.clone()).to_string();
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("special chars must roundtrip");
        let parsed_map = parsed.as_object().unwrap();

        assert_eq!(
            parsed_map.get("openai").and_then(|v| v.as_str()),
            Some("sk-\"quoted\"key\nwith newline")
        );
    }

    #[test]
    fn test_json_map_overwrite() {
        // 模拟存储两次 key：最新值必须胜出。
        let mut map = serde_json::Map::new();
        map.insert(
            "deepseek".to_string(),
            serde_json::Value::String("old-key".to_string()),
        );
        map.insert(
            "deepseek".to_string(),
            serde_json::Value::String("new-key".to_string()),
        );

        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("deepseek").and_then(|v| v.as_str()),
            Some("new-key")
        );
    }

    // ── Windows 凭证文件行为测试（真实 DPAPI 加解密）──

    /// 把 LOCALAPPDATA 重定向到临时目录的测试环境。
    /// set_var 是进程全局的，用进程内互斥锁串行化这些测试；
    /// Drop 时恢复原值并清理临时目录。
    #[cfg(windows)]
    struct TempCredEnv {
        dir: std::path::PathBuf,
        orig: Option<std::ffi::OsString>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    #[cfg(windows)]
    impl TempCredEnv {
        fn new(name: &str) -> Self {
            static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let dir = std::env::temp_dir().join(format!(
                "hologram-cred-test-{}-{}-{}",
                name,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let orig = std::env::var_os("LOCALAPPDATA");
            std::env::set_var("LOCALAPPDATA", &dir);
            TempCredEnv { dir, orig, _guard: guard }
        }

        fn cred_file(&self) -> std::path::PathBuf {
            self.dir.join("com.hologram.app").join("credentials.enc")
        }

        /// 目录下所有 credentials.enc.corrupt-* 备份文件
        fn corrupt_backups(&self) -> Vec<std::path::PathBuf> {
            let dir = match self.cred_file().parent() {
                Some(d) => d.to_path_buf(),
                None => return Vec::new(),
            };
            let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .map(|n| n.to_string_lossy().starts_with("credentials.enc.corrupt-"))
                        .unwrap_or(false)
                })
                .collect()
        }
    }

    #[cfg(windows)]
    impl Drop for TempCredEnv {
        fn drop(&mut self) {
            match &self.orig {
                Some(v) => std::env::set_var("LOCALAPPDATA", v),
                None => std::env::remove_var("LOCALAPPDATA"),
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    #[cfg(windows)]
    fn test_store_get_delete_roundtrip() {
        let env = TempCredEnv::new("roundtrip");
        super::store_api_key("testprov", "sk-test-123").unwrap();
        // 覆盖写入第二个 key —— 走 rename 覆盖已存在文件的路径
        super::store_api_key("testprov2", "sk-test-456").unwrap();

        assert_eq!(
            super::get_api_key("testprov").unwrap(),
            Some("sk-test-123".to_string())
        );
        assert_eq!(
            super::get_api_key("testprov2").unwrap(),
            Some("sk-test-456".to_string())
        );
        // 原子写入不应残留临时文件
        assert!(!env.cred_file().with_extension("enc.tmp").exists());

        super::delete_api_key("testprov").unwrap();
        assert_eq!(super::get_api_key("testprov").unwrap(), None);
        assert_eq!(
            super::get_api_key("testprov2").unwrap(),
            Some("sk-test-456".to_string())
        );
    }

    #[test]
    #[cfg(windows)]
    fn test_corrupt_file_backed_up_on_store() {
        let env = TempCredEnv::new("corrupt-store");
        let dir = env.cred_file().parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&dir).unwrap();
        // 无法 DPAPI 解密的垃圾内容 —— 模拟损坏的密文
        std::fs::write(env.cred_file(), b"not-dpapi-garbage").unwrap();

        super::store_api_key("newprov", "sk-new").unwrap();

        // 原密文必须被备份，而不是被静默覆盖
        let backups = env.corrupt_backups();
        assert_eq!(backups.len(), 1, "损坏文件应被备份而非静默丢弃");
        assert_eq!(std::fs::read(&backups[0]).unwrap(), b"not-dpapi-garbage");
        // 新 key 正常写入可读
        assert_eq!(
            super::get_api_key("newprov").unwrap(),
            Some("sk-new".to_string())
        );
    }

    #[test]
    #[cfg(windows)]
    fn test_corrupt_file_backed_up_on_delete() {
        let env = TempCredEnv::new("corrupt-delete");
        let dir = env.cred_file().parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(env.cred_file(), b"garbage").unwrap();

        // 损坏文件备份后视为空 map：删除不存在的 key 不算错误，也不重写文件
        super::delete_api_key("whatever").unwrap();
        assert_eq!(env.corrupt_backups().len(), 1);
        assert!(!env.cred_file().exists());
    }

    #[test]
    #[cfg(windows)]
    fn test_concurrent_stores_do_not_lose_keys() {
        let _env = TempCredEnv::new("concurrent");
        let mut handles = Vec::new();
        for i in 0..8 {
            handles.push(std::thread::spawn(move || {
                super::store_api_key(&format!("prov-{i}"), &format!("key-{i}")).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        // 进程级写锁保证读-改-写串行：8 个并发写入一个都不能丢
        for i in 0..8 {
            assert_eq!(
                super::get_api_key(&format!("prov-{i}")).unwrap(),
                Some(format!("key-{i}")),
                "并发存储后 prov-{i} 丢失"
            );
        }
    }

    /// 2026-08-08 事故回归：双重 JSON 编码反馈循环曾把 key 膨胀到 128MiB，
    /// 256MB IPC 响应击毁 WebView2。写入端必须拒绝超长 key。
    #[test]
    #[cfg(windows)]
    fn test_store_rejects_oversized_key() {
        let env = TempCredEnv::new("oversized-store");
        let big = "x".repeat(5000);
        assert!(super::store_api_key("bigprov", &big).is_err(), "超长 key 必须被拒绝");
        assert!(!env.cred_file().exists(), "拒绝写入时不应创建文件");
        // 正常 key 不受影响
        super::store_api_key("ok", "sk-normal").unwrap();
        assert_eq!(super::get_api_key("ok").unwrap(), Some("sk-normal".to_string()));
    }

    /// 毒化文件（超 4MB）场景：get 应快速报错而非解密数百 MB；
    /// store 应隔离备份后重建干净文件。
    #[test]
    #[cfg(windows)]
    fn test_oversized_file_quarantined_on_store() {
        let env = TempCredEnv::new("oversized-file");
        let dir = env.cred_file().parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(env.cred_file(), vec![0u8; 5 * 1024 * 1024]).unwrap();
        assert!(super::get_api_key("any").is_err(), "超大文件应直接报错而非尝试解密");
        super::store_api_key("newprov", "sk-new").unwrap();
        assert_eq!(env.corrupt_backups().len(), 1, "毒化文件应被隔离备份");
        assert_eq!(super::get_api_key("newprov").unwrap(), Some("sk-new".to_string()));
    }
}
