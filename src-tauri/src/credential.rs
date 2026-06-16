// v4 Phase 5 — Credential storage
// Uses DPAPI on Windows via direct FFI (avoids heavy windows crate dependencies).
#![allow(non_snake_case)] // Win32 FFI naming conventions

use std::ffi::c_void;
use std::path::PathBuf;

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
const CRYPTPROTECT_LOCAL_MACHINE: u32 = 0x4;

/// Load DPAPI functions from crypt32.dll at runtime.
fn dpapi_encrypt(data: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        // SAFETY: crypt32.dll and kernel32.dll are always present on Windows
        let crypt32 = unsafe { libloading::Library::new("crypt32.dll") }
            .map_err(|e| format!("cannot load crypt32: {}", e))?;
        let kernel32 = unsafe { libloading::Library::new("kernel32.dll") }
            .map_err(|e| format!("kernel32: {}", e))?;

        // Hold references until the end of scope
        let CryptProtectData: libloading::Symbol<CryptProtectDataFn> = unsafe { crypt32.get(b"CryptProtectData") }
            .map_err(|e| format!("CryptProtectData: {}", e))?;
        let LocalFree: libloading::Symbol<LocalFreeFn> = unsafe { kernel32.get(b"LocalFree") }
            .map_err(|e| format!("LocalFree: {}", e))?;

        let mut blob_in = DATA_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut blob_out = DATA_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

        let ret = unsafe {
            CryptProtectData(&mut blob_in, std::ptr::null(), std::ptr::null(),
                std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE,
                &mut blob_out)
        };
        if ret == 0 {
            return Err("DPAPI encrypt failed".into());
        }
        let encrypted = unsafe { std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec() };
        unsafe { LocalFree(blob_out.pbData as isize); }
        Ok(encrypted)
    }
    #[cfg(not(windows))]
    { Err("unsupported platform".into()) }
}

fn dpapi_decrypt(data: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        let crypt32 = unsafe { libloading::Library::new("crypt32.dll") }
            .map_err(|e| format!("cannot load crypt32: {}", e))?;
        let kernel32 = unsafe { libloading::Library::new("kernel32.dll") }
            .map_err(|e| format!("kernel32: {}", e))?;

        let CryptUnprotectData: libloading::Symbol<CryptUnprotectDataFn> = unsafe { crypt32.get(b"CryptUnprotectData") }
            .map_err(|e| format!("CryptUnprotectData: {}", e))?;
        let LocalFree: libloading::Symbol<LocalFreeFn> = unsafe { kernel32.get(b"LocalFree") }
            .map_err(|e| format!("LocalFree: {}", e))?;

        let mut blob_in = DATA_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut blob_out = DATA_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

        let ret = unsafe {
            CryptUnprotectData(&mut blob_in, std::ptr::null_mut(), std::ptr::null(),
                std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN,
                &mut blob_out)
        };
        if ret == 0 {
            return Err("DPAPI decrypt failed".into());
        }
        let plain = unsafe { std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec() };
        unsafe { LocalFree(blob_out.pbData as isize); }
        Ok(plain)
    }
    #[cfg(not(windows))]
    { Err("unsupported platform".into()) }
}

fn cred_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("com.hologram.app").join("credentials.enc")
}

/// Store an API key for a provider.
pub fn store_api_key(provider: &str, key: &str) -> Result<(), String> {
    let dir = cred_path().parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&dir).ok();
    let data = format!("{}={}", provider, key);
    let encrypted = dpapi_encrypt(data.as_bytes())?;
    std::fs::write(cred_path(), encrypted)
        .map_err(|e| format!("write credentials: {}", e))
}

/// Retrieve an API key for a provider.
pub fn get_api_key(provider: &str) -> Result<Option<String>, String> {
    let encrypted = match std::fs::read(cred_path()) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read credentials: {}", e)),
    };
    let plain = dpapi_decrypt(&encrypted)?;
    let s = String::from_utf8(plain).map_err(|e| format!("invalid cred: {}", e))?;
    for line in s.lines() {
        if let Some((prov, key)) = line.split_once('=') {
            if prov == provider { return Ok(Some(key.to_string())); }
        }
    }
    Ok(None)
}

/// Delete all stored credentials.
pub fn clear_credentials() -> Result<(), String> {
    let _ = std::fs::remove_file(cred_path());
    Ok(())
}
