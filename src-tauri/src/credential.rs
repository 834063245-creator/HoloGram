// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Credential storage — per-platform encrypted secret storage.
//
// Windows: DPAPI via direct FFI (user-scoped encryption, file-based).
// macOS:   Keychain via `security` CLI (built-in, zero deps).
// Linux:   Secret Service via `secret-tool` CLI (gnome-keyring/kwallet).
//
// All platforms share the same public API:
//   store_api_key(provider, key) / get_api_key(provider) / delete_api_key / clear_credentials
//
// When the OS secret store is unavailable (no keyring daemon, no secret-tool),
// operations return Err — the frontend falls back to localStorage plaintext.

#![allow(non_snake_case)] // Win32 FFI naming conventions

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::path::PathBuf;

// ═══════════════════════════════════════════════════════════════
// Public API — same on all platforms
// ═══════════════════════════════════════════════════════════════

/// Store an API key for a provider.
pub fn store_api_key(provider: &str, key: &str) -> Result<(), String> {
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

/// Retrieve an API key for a provider. Returns None if not stored.
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

/// Delete a single provider's API key. Not an error if key doesn't exist.
pub fn delete_api_key(provider: &str) -> Result<(), String> {
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

/// Delete all stored credentials.
pub fn clear_credentials() -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = std::fs::remove_file(cred_path());
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        // Dump keychain, find all Hologram entries, extract provider names.
        let output = std::process::Command::new("security")
            .args(["dump-keychain"])
            .output()
            .map_err(|e| format!("security dump: {e}"))?;
        let dump = String::from_utf8_lossy(&output.stdout);
        let providers = parse_keychain_dump_providers(&dump);

        // If parsing didn't find any providers, fall back to known defaults.
        let targets: Vec<&str> = if providers.is_empty() {
            vec!["deepseek", "anthropic", "openai"]
        } else {
            providers.iter().map(|s| s.as_str()).collect()
        };

        for prov in &targets {
            let _ = std::process::Command::new("security")
                .args(["delete-generic-password", "-s", "hologram", "-a", prov])
                .output();
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        // secret-tool clear with just the service attribute
        let _ = std::process::Command::new("secret-tool")
            .args(["clear", "service", "hologram"])
            .output();
        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════
// macOS Keychain dump parser — extracts provider names from
// `security dump-keychain` output.
// ═══════════════════════════════════════════════════════════════

/// Parse `security dump-keychain` output to find all Hologram-stored
/// provider names (account names). Splits entries by blank lines, finds
/// those with `"svce"<blob>="hologram"`, and extracts all `"acct"<blob>`
/// values from within those entry blocks.
#[cfg(target_os = "macos")]
fn parse_keychain_dump_providers(dump: &str) -> Vec<String> {
    let mut providers: Vec<String> = Vec::new();

    // Split into blocks — each keychain entry is separated by blank lines
    for block in dump.split("\n\n") {
        if !block.contains("\"svce\"<blob>=\"hologram\"") {
            continue;
        }
        for line in block.lines() {
            if let Some(rest) = line.split("\"acct\"<blob>=").nth(1) {
                let val = rest.trim().trim_matches('"');
                if !val.is_empty() && !providers.contains(&val.to_string()) {
                    providers.push(val.to_string());
                }
            }
        }
    }

    providers
}

// ═══════════════════════════════════════════════════════════════
// Windows — DPAPI (existing implementation, unchanged)
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
        base.join("com.hologram.app").join("credentials.enc")
    }

    fn load_cred_map() -> Result<serde_json::Map<String, serde_json::Value>, String> {
        let encrypted = match std::fs::read(cred_path()) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(serde_json::Map::new())
            }
            Err(e) => return Err(format!("read credentials: {e}")),
        };
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

    pub(super) fn store_windows(provider: &str, key: &str) -> Result<(), String> {
        let dir = cred_path().parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&dir).ok();
        let mut map = load_cred_map().unwrap_or_default();
        map.insert(provider.to_string(), serde_json::Value::String(key.to_string()));
        let data = serde_json::Value::Object(map).to_string();
        let encrypted = dpapi_encrypt(data.as_bytes())?;
        std::fs::write(cred_path(), encrypted)
            .map_err(|e| format!("write credentials: {e}"))
    }

    pub(super) fn get_windows(provider: &str) -> Result<Option<String>, String> {
        let map = load_cred_map()?;
        Ok(map
            .get(provider)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    }

    pub(super) fn delete_windows(provider: &str) -> Result<(), String> {
        let mut map = load_cred_map().unwrap_or_default();
        if !map.contains_key(provider) {
            return Ok(());
        }
        map.remove(provider);
        let data = serde_json::Value::Object(map).to_string();
        let encrypted = dpapi_encrypt(data.as_bytes())?;
        std::fs::write(cred_path(), encrypted)
            .map_err(|e| format!("write credentials: {e}"))
    }
}

// Re-export Windows functions at module level
#[cfg(windows)]
use windows_impl::*;

// ═══════════════════════════════════════════════════════════════
// macOS — Keychain via `security` CLI (built-in, zero deps)
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
                "-U", // update if exists
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
            // Password is printed to stdout, trailing newline
            let key = String::from_utf8_lossy(&output.stdout);
            let key = key.trim_end_matches('\n');
            if key.is_empty() {
                Ok(None)
            } else {
                Ok(Some(key.to_string()))
            }
        } else {
            // Exit code 44 = item not found
            Ok(None)
        }
    }

    pub(super) fn delete_macos(provider: &str) -> Result<(), String> {
        let _ = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", provider])
            .output();
        Ok(())
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

    /// Check if secret-tool is available (gnome-keyring/kwallet installed).
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
            Ok(None) // key not found
        }
    }

    pub(super) fn delete_linux(provider: &str) -> Result<(), String> {
        if !secret_tool_available() {
            return Err("Secret Service 不可用（请确认 gnome-keyring/kwallet 正在运行）".into());
        }

        let _ = std::process::Command::new("secret-tool")
            .args(["clear", "service", SERVICE, "account", provider])
            .output();
        Ok(())
    }
}

#[cfg(target_os = "linux")]
use linux_impl::*;

// ═══════════════════════════════════════════════════════════════
// Fallback for other platforms
// ═══════════════════════════════════════════════════════════════

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
compile_error!("credential.rs: unsupported platform");

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::parse_keychain_dump_providers;

    // ── JSON map format tests (platform-independent) ──

    #[test]
    fn test_json_map_roundtrip() {
        // Verify the JSON Object map format used by Windows credential storage
        // survives a full serialize → deserialize cycle without data loss.
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
        // Keys may contain special JSON characters — ensure they survive.
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
        // Simulate storing a key twice: latest value must win.
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

    // ── Keychain dump parser tests ──

    #[test]
    #[cfg(target_os = "macos")]
    fn test_parse_keychain_dump_multiple_providers() {
        let dump = "\
keychain: \"/Users/test/Library/Keychains/login.keychain-db\"
version: 512
class: \"genp\"
attributes:
    \"labl\"<blob>=\"HoloGram: deepseek\"
    \"svce\"<blob>=\"hologram\"
    \"acct\"<blob>=\"deepseek\"
    \"mdat\"<timedate>=0x...

keychain: \"/Users/test/Library/Keychains/login.keychain-db\"
version: 512
class: \"genp\"
attributes:
    \"labl\"<blob>=\"HoloGram: anthropic\"
    \"svce\"<blob>=\"hologram\"
    \"acct\"<blob>=\"anthropic\"
    \"mdat\"<timedate>=0x...
";

        let providers = parse_keychain_dump_providers(dump);
        assert_eq!(providers.len(), 2);
        assert!(providers.contains(&"deepseek".to_string()));
        assert!(providers.contains(&"anthropic".to_string()));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_parse_keychain_dump_no_match() {
        let dump = "\
keychain: \"/Users/test/Library/Keychains/login.keychain-db\"
class: \"genp\"
attributes:
    \"svce\"<blob>=\"other-app\"
    \"acct\"<blob>=\"user1\"
";

        let providers = parse_keychain_dump_providers(dump);
        assert!(providers.is_empty());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_parse_keychain_dump_empty() {
        let providers = parse_keychain_dump_providers("");
        assert!(providers.is_empty());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_parse_keychain_dump_duplicate_accounts() {
        // Same account appearing in multiple entries — only returned once.
        let dump = "\
keychain: \"/Users/test/Library/Keychains/login.keychain-db\"
class: \"genp\"
attributes:
    \"svce\"<blob>=\"hologram\"
    \"acct\"<blob>=\"deepseek\"

keychain: \"/Users/test/Library/Keychains/login.keychain-db\"
class: \"genp\"
attributes:
    \"svce\"<blob>=\"hologram\"
    \"acct\"<blob>=\"deepseek\"
";

        let providers = parse_keychain_dump_providers(dump);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0], "deepseek");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_parse_keychain_dump_acct_before_svce() {
        // Order of attributes is not guaranteed — acct may appear before svce.
        let dump = "\
keychain: \"/Users/test/Library/Keychains/login.keychain-db\"
class: \"genp\"
attributes:
    \"acct\"<blob>=\"openai\"
    \"labl\"<blob>=\"HoloGram: openai\"
    \"svce\"<blob>=\"hologram\"
";

        let providers = parse_keychain_dump_providers(dump);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0], "openai");
    }
}