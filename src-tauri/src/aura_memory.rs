// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// AuraSDK memory bridge — SDR + MinHash semantic recall for the agent.
// Calls into aura.dll (https://github.com/teolex2020/AuraSDK, MIT) via FFI.
//
// ponytail: libloading, same pattern as credential.rs. No pyo3, no Python.

use std::ffi::{c_char, CStr, CString};
use std::path::PathBuf;
use std::sync::Mutex;

// ── FFI type aliases ──

/// Opaque Aura handle — a raw pointer from C. Not Send by default;
/// we assert it via unsafe wrapper below since aura.dll is single-thread-safe.
#[repr(transparent)]
struct AuraHandle(*mut std::ffi::c_void);
// SAFETY: aura.dll's internal state is behind a Mutex, and we hold our own
// Mutex around all accesses. Single-handle, single-thread-at-a-time.
unsafe impl Send for AuraHandle {}
unsafe impl Sync for AuraHandle {}

type AuraOpenFn = unsafe extern "C" fn(
    path: *const c_char,
    out_error: *mut *mut c_char,
) -> *mut std::ffi::c_void;

type AuraCloseFn = unsafe extern "C" fn(handle: *mut std::ffi::c_void, out_error: *mut *mut c_char) -> i32;
type AuraFreeFn = unsafe extern "C" fn(handle: *mut std::ffi::c_void);
type AuraFreeStringFn = unsafe extern "C" fn(s: *mut c_char);

type AuraStoreFn = unsafe extern "C" fn(
    handle: *mut std::ffi::c_void,
    content: *const c_char,
    level: u8,
    tags_json: *const c_char,
    namespace: *const c_char,
    out_error: *mut *mut c_char,
) -> *mut c_char;

type AuraRecallFn = unsafe extern "C" fn(
    handle: *mut std::ffi::c_void,
    query: *const c_char,
    token_budget: i32,
    out_error: *mut *mut c_char,
) -> *mut c_char;

type AuraRecallStructuredFn = unsafe extern "C" fn(
    handle: *mut std::ffi::c_void,
    query: *const c_char,
    top_k: i32,
    out_error: *mut *mut c_char,
) -> *mut c_char;

type AuraCountFn = unsafe extern "C" fn(handle: *mut std::ffi::c_void) -> i64;
type AuraMaintenanceFn = unsafe extern "C" fn(handle: *mut std::ffi::c_void, out_error: *mut *mut c_char) -> i32;

// ── Loaded function pointers ──
struct AuraFns {
    open: AuraOpenFn,
    close: AuraCloseFn,
    free_handle: AuraFreeFn,
    free_string: AuraFreeStringFn,
    store: AuraStoreFn,
    recall: AuraRecallFn,
    recall_structured: AuraRecallStructuredFn,
    count: AuraCountFn,
    maintenance: AuraMaintenanceFn,
}

/// Load all function pointers from the DLL. Returns (fns, leaked_lib).
/// The library is intentionally leaked so function pointers remain valid for
/// the process lifetime. AuraSDK is loaded once at startup and never unloaded.
unsafe fn load_aura_fns(dll_path: &PathBuf) -> Result<AuraFns, String> {
    // SAFETY: trusted DLL built from known Rust source
    let lib = unsafe { libloading::Library::new(dll_path) }
        .map_err(|e| format!("cannot load {}: {}", dll_path.display(), e))?;

    // Leak the library so symbols stay valid for 'static.
    // The ~6MB stays in process memory until exit — acceptable for a core component.
    let lib = Box::leak(Box::new(lib));

    Ok(AuraFns {
        open: *unsafe { lib.get::<AuraOpenFn>(b"aura_open") }
            .map_err(|e| format!("aura_open: {}", e))?,
        close: *unsafe { lib.get::<AuraCloseFn>(b"aura_close") }
            .map_err(|e| format!("aura_close: {}", e))?,
        free_handle: *unsafe { lib.get::<AuraFreeFn>(b"aura_free") }
            .map_err(|e| format!("aura_free: {}", e))?,
        free_string: *unsafe { lib.get::<AuraFreeStringFn>(b"aura_free_string") }
            .map_err(|e| format!("aura_free_string: {}", e))?,
        store: *unsafe { lib.get::<AuraStoreFn>(b"aura_store") }
            .map_err(|e| format!("aura_store: {}", e))?,
        recall: *unsafe { lib.get::<AuraRecallFn>(b"aura_recall") }
            .map_err(|e| format!("aura_recall: {}", e))?,
        recall_structured: *unsafe { lib.get::<AuraRecallStructuredFn>(b"aura_recall_structured") }
            .map_err(|e| format!("aura_recall_structured: {}", e))?,
        count: *unsafe { lib.get::<AuraCountFn>(b"aura_count") }
            .map_err(|e| format!("aura_count: {}", e))?,
        maintenance: *unsafe { lib.get::<AuraMaintenanceFn>(b"aura_run_maintenance") }
            .map_err(|e| format!("aura_run_maintenance: {}", e))?,
    })
}

// ── Global singleton ──
static AURA: Mutex<Option<(AuraHandle, AuraFns)>> = Mutex::new(None);

// ── Helpers ──

fn to_cstring(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| CString::new("").unwrap())
}

fn from_cstr(ptr: *mut c_char) -> String {
    if ptr.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }
}

/// Resolve aura library path. Checks bundled resource first, then dev paths.
/// Platform-aware: .dll on Windows, .so on Linux, .dylib on macOS.
fn aura_dll_path() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("AURA_DLL") {
        let path = PathBuf::from(&p);
        if path.exists() {
            return Ok(path);
        }
    }

    let ext = if cfg!(windows) {
        "aura.dll"
    } else if cfg!(target_os = "macos") {
        "libaura.dylib"
    } else {
        "libaura.so"
    };

    // Production: bundled next to exe
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("no exe dir: {e}"))?
        .parent()
        .ok_or("exe has no parent")?
        .to_path_buf();

    let bundled = exe_dir.join(ext);
    if bundled.exists() {
        return Ok(bundled);
    }

    // Dev paths
    let candidates = [
        PathBuf::from(format!("../grammars/{ext}")),
        PathBuf::from(format!("grammars/{ext}")),
        // Fallback: try all extensions in grammars/ (handles mismatched naming)
        PathBuf::from("../grammars/aura.so"),
        PathBuf::from("grammars/aura.so"),
        PathBuf::from("../grammars/aura.dll"),
        PathBuf::from("grammars/aura.dll"),
    ];
    for p in &candidates {
        if p.exists() {
            return Ok(p.canonicalize().unwrap_or_else(|_| p.clone()));
        }
    }
    Err(format!("aura library not found. Searched: {candidates:?}"))
}

// ── Public Tauri commands ──

/// Initialize the Aura brain at the given directory path.
/// Must be called once before any recall/store operations.
#[tauri::command]
pub fn aura_init(brain_path: String) -> Result<String, String> {
    let dll_path = aura_dll_path()?;

    let mut guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    if guard.is_some() {
        return Err("Aura already initialized".into());
    }

    // SAFETY: aura.dll is a trusted native library built from known Rust source
    let fns = unsafe { load_aura_fns(&dll_path) }?;

    let cpath = to_cstring(&brain_path);
    let mut err: *mut c_char = std::ptr::null_mut();

    let raw_handle = unsafe { (fns.open)(cpath.as_ptr(), &mut err) };
    if raw_handle.is_null() {
        let err_msg = from_cstr(err);
        unsafe { (fns.free_string)(err) };
        return Err(format!("aura_open failed: {}", err_msg));
    }

    let handle = AuraHandle(raw_handle);
    let count = unsafe { (fns.count)(handle.0) };
    *guard = Some((handle, fns));

    Ok(serde_json::json!({
        "status": "ok",
        "path": brain_path,
        "record_count": count,
    })
    .to_string())
}

/// Recall memories relevant to a query.
/// Returns JSON array: [{"id","content","score","level","tags",...}, ...]
/// top_k: 0 = default (20).
#[tauri::command]
pub fn aura_recall(query: String, top_k: i32) -> Result<String, String> {
    let guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    let (handle, fns) = guard.as_ref().ok_or("Aura not initialized. Call aura_init first.")?;

    let cquery = to_cstring(&query);
    let mut err: *mut c_char = std::ptr::null_mut();

    let result = unsafe { (fns.recall_structured)(handle.0, cquery.as_ptr(), top_k, &mut err) };
    if result.is_null() {
        let err_msg = from_cstr(err);
        unsafe { (fns.free_string)(err) };
        return Err(format!("aura_recall failed: {}", err_msg));
    }

    let json_str = from_cstr(result);
    unsafe { (fns.free_string)(result) };
    Ok(json_str)
}

/// Recall memories as a formatted text block (for LLM prompt injection).
/// token_budget: 0 = default (2048).
#[tauri::command]
pub fn aura_recall_text(query: String, token_budget: i32) -> Result<String, String> {
    let guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    let (handle, fns) = guard.as_ref().ok_or("Aura not initialized. Call aura_init first.")?;

    let cquery = to_cstring(&query);
    let mut err: *mut c_char = std::ptr::null_mut();

    let result = unsafe { (fns.recall)(handle.0, cquery.as_ptr(), token_budget, &mut err) };
    if result.is_null() {
        let err_msg = from_cstr(err);
        unsafe { (fns.free_string)(err) };
        return Err(format!("aura_recall_text failed: {}", err_msg));
    }

    let text = from_cstr(result);
    unsafe { (fns.free_string)(result) };
    Ok(text)
}

/// Store a memory into the Aura brain.
/// level: 1=Working, 2=Decisions, 3=Domain, 4=Identity. 0=default.
/// tags: JSON array string, e.g. '["tag1","tag2"]'. Empty string = no tags.
/// namespace: namespace string. Empty string = "default".
#[tauri::command]
pub fn aura_store(
    content: String,
    level: u8,
    tags: String,
    namespace: String,
) -> Result<String, String> {
    let guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    let (handle, fns) = guard.as_ref().ok_or("Aura not initialized. Call aura_init first.")?;

    let ccontent = to_cstring(&content);
    let tags_cstring = if tags.is_empty() { None } else { Some(to_cstring(&tags)) };
    let ns_cstring = if namespace.is_empty() { None } else { Some(to_cstring(&namespace)) };

    let ctags = tags_cstring.as_ref().map(|s| s.as_ptr()).unwrap_or(std::ptr::null());
    let cnamespace = ns_cstring.as_ref().map(|s| s.as_ptr()).unwrap_or(std::ptr::null());
    let mut err: *mut c_char = std::ptr::null_mut();

    let result = unsafe {
        (fns.store)(handle.0, ccontent.as_ptr(), level, ctags, cnamespace, &mut err)
    };

    if result.is_null() {
        let err_msg = from_cstr(err);
        unsafe { (fns.free_string)(err) };
        return Err(format!("aura_store failed: {}", err_msg));
    }

    let id = from_cstr(result);
    unsafe { (fns.free_string)(result) };
    Ok(id)
}

/// Get the total number of records.
#[tauri::command]
pub fn aura_count() -> Result<i64, String> {
    let guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    let (handle, fns) = guard.as_ref().ok_or("Aura not initialized. Call aura_init first.")?;
    Ok(unsafe { (fns.count)(handle.0) })
}

/// Run a maintenance cycle (decay, consolidation).
#[tauri::command]
pub fn aura_maintenance() -> Result<(), String> {
    let guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    let (handle, fns) = guard.as_ref().ok_or("Aura not initialized. Call aura_init first.")?;
    let mut err: *mut c_char = std::ptr::null_mut();
    let ret = unsafe { (fns.maintenance)(handle.0, &mut err) };
    if ret != 0 {
        let err_msg = from_cstr(err);
        unsafe { (fns.free_string)(err) };
        return Err(format!("aura_maintenance failed: {}", err_msg));
    }
    Ok(())
}

/// Shut down and free the Aura brain. Call on app exit.
#[tauri::command]
pub fn aura_shutdown() -> Result<(), String> {
    let mut guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    if let Some((handle, fns)) = guard.take() {
        let mut err: *mut c_char = std::ptr::null_mut();
        unsafe { (fns.close)(handle.0, &mut err) };
        unsafe { (fns.free_string)(err) };
        unsafe { (fns.free_handle)(handle.0) };
        // Library intentionally leaked — process exit reclaims it
    }
    Ok(())
}
