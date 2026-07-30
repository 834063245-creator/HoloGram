// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// AuraSDK 记忆桥接 — SDR + MinHash 语义召回 for agent。
// 通过 FFI 调用 aura.dll (https://github.com/teolex2020/AuraSDK, MIT)。
//
// ponytail: libloading，与 credential.rs 相同模式。无 pyo3，无 Python。

use std::ffi::{c_char, CStr, CString};
use std::path::PathBuf;
use std::sync::Mutex;

// ── FFI 类型别名 ──

/// 不透明的 Aura 句柄 — 来自 C 的原始指针。默认不实现 Send；
/// 我们通过下方的 unsafe 包装器断言它，因为 aura.dll 是单线程安全的。
#[repr(transparent)]
struct AuraHandle(*mut std::ffi::c_void);
// SAFETY: aura.dll 的内部状态由 Mutex 保护，我们持有自己的
// Mutex 来同步所有访问。单句柄，单线程串行访问。
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

// ── 已加载的函数指针 ──
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

/// 从 DLL 加载所有函数指针。返回 (fns, leaked_lib)。
/// 库被有意泄漏，使函数指针在进程生命周期内保持有效。
/// AuraSDK 在启动时加载一次，永不卸载。
unsafe fn load_aura_fns(dll_path: &PathBuf) -> Result<AuraFns, String> {
    // SAFETY: 受信任的 DLL，由已知 Rust 源码构建
    let lib = unsafe { libloading::Library::new(dll_path) }
        .map_err(|e| format!("cannot load {}: {}", dll_path.display(), e))?;

    // 泄漏库以使符号保持 'static 有效。
    // ~6MB 保留在进程内存中直到退出 — 对核心组件而言可接受。
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

// ── 全局单例 ──
static AURA: Mutex<Option<(AuraHandle, AuraFns)>> = Mutex::new(None);

// ── 辅助函数 ──

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

/// 解析 aura 库路径。优先检查打包资源，然后检查开发路径。
/// 平台感知：Windows 上为 .dll，Linux 上为 .so，macOS 上为 .dylib。
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

    // 生产环境：打包在 exe 旁边
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("no exe dir: {e}"))?
        .parent()
        .ok_or("exe has no parent")?
        .to_path_buf();

    let bundled = exe_dir.join(ext);
    if bundled.exists() {
        return Ok(bundled);
    }

    // 开发路径
    let candidates = [
        PathBuf::from(format!("../grammars/{ext}")),
        PathBuf::from(format!("grammars/{ext}")),
        // Fallback: 尝试 grammars/ 下的所有扩展名（处理命名不匹配的情况）
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

// ── 公共 Tauri 命令 ──

/// 在指定目录路径初始化 Aura 大脑。
/// 在任何 recall/store 操作之前必须调用一次。
#[tauri::command]
pub fn aura_init(brain_path: String) -> Result<String, String> {
    let dll_path = aura_dll_path()?;

    let mut guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    if guard.is_some() {
        return Err("Aura already initialized".into());
    }

    // SAFETY: aura.dll 是受信任的原生库，由已知 Rust 源码构建
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

/// 召回与查询相关的记忆。
/// 返回 JSON 数组：[{"id","content","score","level","tags",...}, ...]
/// top_k: 0 = 默认值 (20)。
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

/// 以格式化文本块形式召回记忆（用于 LLM prompt 注入）。
/// token_budget: 0 = 默认值 (2048)。
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

/// 将记忆存入 Aura 大脑。
/// level: 1=工作记忆, 2=决策, 3=领域, 4=身份。0=默认。
/// tags: JSON 数组字符串，如 '["tag1","tag2"]'。空字符串 = 无标签。
/// namespace: 命名空间字符串。空字符串 = "default"。
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

/// 获取记录总数。
#[tauri::command]
pub fn aura_count() -> Result<i64, String> {
    let guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    let (handle, fns) = guard.as_ref().ok_or("Aura not initialized. Call aura_init first.")?;
    Ok(unsafe { (fns.count)(handle.0) })
}

/// 运行维护周期（衰减、整合）。
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

/// 关闭并释放 Aura 大脑。在应用退出时调用。
#[tauri::command]
pub fn aura_shutdown() -> Result<(), String> {
    let mut guard = AURA.lock().map_err(|e| format!("lock: {}", e))?;
    if let Some((handle, fns)) = guard.take() {
        let mut err: *mut c_char = std::ptr::null_mut();
        unsafe { (fns.close)(handle.0, &mut err) };
        unsafe { (fns.free_string)(err) };
        unsafe { (fns.free_handle)(handle.0) };
        // 库有意泄漏 — 进程退出时回收
    }
    Ok(())
}
