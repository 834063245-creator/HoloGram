// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Minimal ONNX Runtime FFI — adapted from memory-bundle-rs.
// ponytail: fastembed's ort-sys doesn't support windows-gnu, but
// the user already has onnxruntime.dll (from memory-bundle-rs).
// This module uses raw libloading + FFI to bypass all build issues.

use std::ffi::c_void;
use std::sync::OnceLock;

type OrtStatusPtr = *mut c_void;

#[repr(C)]
struct OrtApi {
    create_status: unsafe extern "C" fn(code: i32, msg: *const i8) -> OrtStatusPtr,
    get_error_code: unsafe extern "C" fn(status: OrtStatusPtr) -> i32,
    get_error_message: unsafe extern "C" fn(status: OrtStatusPtr, out: *mut *const i8) -> OrtStatusPtr,
    _pad0: usize, _pad1: usize, _pad2: usize, _pad3: usize, _pad4: usize,
    create_env: unsafe extern "C" fn(logging_level: i32, logid: *const i8, out: *mut *mut c_void) -> OrtStatusPtr,
    _pad6: usize, _pad7: usize, _pad8: usize, _pad9: usize,
    _pad10: usize, _pad11: usize, _pad12: usize, _pad13: usize,
    _pad14: usize, _pad15: usize, _pad16: usize,
    create_session: unsafe extern "C" fn(env: *mut c_void, model_path: *const u16, opts: *const c_void, out: *mut *mut c_void) -> OrtStatusPtr,
    _pad17: usize, _pad18: usize, _pad19: usize, _pad20: usize, _pad21: usize, _pad22: usize,
    _pad23: usize, _pad24: usize, _pad25: usize, _pad26: usize, _pad27: usize, _pad28: usize,
    _pad29: usize, _pad30: usize, _pad31: usize, _pad32: usize,
    create_cpu_memory_info: unsafe extern "C" fn(atype: i32, memtype: i32, out: *mut *mut c_void) -> OrtStatusPtr,
    _pad33: usize, _pad34: usize, _pad35: usize, _pad36: usize, _pad37: usize, _pad38: usize,
    _pad39: usize, _pad40: usize, _pad41: usize, _pad42: usize, _pad43: usize, _pad44: usize,
    create_tensor_with_data: unsafe extern "C" fn(
        info: *mut c_void, data: *mut c_void, data_len: usize,
        shape: *const i64, shape_len: usize, elem_type: i32, out: *mut *mut c_void,
    ) -> OrtStatusPtr,
    _pad45: usize, _pad46: usize,
    get_tensor_mutable_data: unsafe extern "C" fn(value: *mut c_void, out: *mut *mut c_void) -> OrtStatusPtr,
    _pad47: usize, _pad48: usize, _pad49: usize, _pad50: usize, _pad51: usize, _pad52: usize, _pad53: usize,
    _pad54: usize, _pad55: usize, _pad56: usize, _pad57: usize,
    run: unsafe extern "C" fn(
        session: *mut c_void, run_options: *const c_void,
        input_names: *const *const i8, inputs: *const *mut c_void, num_inputs: usize,
        output_names: *const *const i8, num_outputs: usize, outputs: *mut *mut c_void,
    ) -> OrtStatusPtr,
    _pad58: usize, _pad59: usize, _pad60: usize, _pad61: usize,
    release_status: unsafe extern "C" fn(status: OrtStatusPtr),
    _pad62: usize,
    release_session: unsafe extern "C" fn(session: *mut c_void),
    release_value: unsafe extern "C" fn(value: *mut c_void),
    release_memory_info: unsafe extern "C" fn(info: *mut c_void),
}

type OrtGetApiBaseFunc = unsafe extern "C" fn() -> *const *const OrtApi;

static API: OnceLock<&'static OrtApi> = OnceLock::new();

fn get_api() -> Result<&'static OrtApi, String> {
    if let Some(api) = API.get() { return Ok(api); }

    // Search paths: next to exe, target/release, memory-bundle-rs
    let search_paths = [
        "onnxruntime.dll",
        "target/release/onnxruntime.dll",
        "../../memory-bundle-rs/onnxruntime.dll",
        "../memory-bundle-rs/onnxruntime.dll",
    ];

    let mut lib = None;
    for path in &search_paths {
        if let Ok(l) = unsafe { libloading::Library::new(path) } {
            lib = Some(l);
            break;
        }
    }

    let lib = lib.ok_or("onnxruntime.dll not found in search paths")?;

    let get_api_base: libloading::Symbol<OrtGetApiBaseFunc> = unsafe {
        lib.get(b"OrtGetApiBase")
    }.map_err(|e| format!("OrtGetApiBase not found: {e}"))?;

    let api_ptr = unsafe { get_api_base() };
    if api_ptr.is_null() { return Err("OrtGetApiBase returned null".into()); }

    let api: &'static OrtApi = unsafe { &**api_ptr };
    std::mem::forget(lib); // leak: API pointer must stay valid
    let _ = API.set(api);
    Ok(api)
}

pub struct OrtSession {
    env: *mut c_void,
    session: *mut c_void,
    memory_info: *mut c_void,
}

impl OrtSession {
    pub fn new(model_path: &str) -> Result<Self, String> {
        let api = get_api()?;
        let model_wide: Vec<u16> = model_path.encode_utf16().chain(std::iter::once(0)).collect();

        let mut env: *mut c_void = std::ptr::null_mut();
        let mut session: *mut c_void = std::ptr::null_mut();
        let mut mem_info: *mut c_void = std::ptr::null_mut();

        unsafe {
            let s = (api.create_env)(3, std::ptr::null(), &mut env);
            if !s.is_null() { (api.release_status)(s); return Err("OrtCreateEnv failed".into()); }

            let s = (api.create_session)(env, model_wide.as_ptr(), std::ptr::null(), &mut session);
            if !s.is_null() { (api.release_status)(s); return Err(format!("OrtCreateSession failed for {model_path}")); }

            let s = (api.create_cpu_memory_info)(1, 1, &mut mem_info);
            if !s.is_null() { (api.release_status)(s); return Err("OrtCreateCpuMemoryInfo failed".into()); }
        }

        Ok(Self { env, session, memory_info: mem_info })
    }

    pub fn run(&self, input_ids: &[i64], input_mask: &[i64], seq_len: usize, hidden_dim: usize) -> Result<Vec<f32>, String> {
        let api = get_api()?;
        unsafe {
            let shape = [1i64, seq_len as i64];
            let data_len = (input_ids.len() * 8) as usize;

            let mut input_tensor: *mut c_void = std::ptr::null_mut();
            let s = (api.create_tensor_with_data)(
                self.memory_info,
                input_ids.as_ptr() as *mut c_void, data_len,
                shape.as_ptr(), 2, 7, // INT64
                &mut input_tensor,
            );
            if !s.is_null() { (api.release_status)(s); return Err("create input tensor failed".into()); }

            let mut mask_tensor: *mut c_void = std::ptr::null_mut();
            let s = (api.create_tensor_with_data)(
                self.memory_info,
                input_mask.as_ptr() as *mut c_void, data_len,
                shape.as_ptr(), 2, 7,
                &mut mask_tensor,
            );
            if !s.is_null() { (api.release_status)(s); return Err("create mask tensor failed".into()); }

            let input_names = [b"input_ids\0".as_ptr() as *const i8, b"attention_mask\0".as_ptr() as *const i8];
            let inputs = [input_tensor, mask_tensor];
            let output_names = [b"last_hidden_state\0".as_ptr() as *const i8];
            let mut output: *mut c_void = std::ptr::null_mut();

            let s = (api.run)(
                self.session, std::ptr::null(),
                input_names.as_ptr(), inputs.as_ptr(), 2,
                output_names.as_ptr(), 1, &mut output,
            );

            (api.release_value)(input_tensor);
            (api.release_value)(mask_tensor);

            if !s.is_null() { (api.release_status)(s); return Err("OrtRun failed".into()); }

            let mut data: *mut c_void = std::ptr::null_mut();
            let s = (api.get_tensor_mutable_data)(output, &mut data);
            if !s.is_null() { (api.release_status)(s); (api.release_value)(output); return Err("get tensor data failed".into()); }

            let total_elements = seq_len * hidden_dim;
            let result = std::slice::from_raw_parts(data as *const f32, total_elements).to_vec();
            (api.release_value)(output);
            Ok(result)
        }
    }
}

impl Drop for OrtSession {
    fn drop(&mut self) {
        if let Ok(api) = get_api() {
            unsafe {
                if !self.session.is_null() { (api.release_session)(self.session); }
                if !self.memory_info.is_null() { (api.release_memory_info)(self.memory_info); }
            }
        }
    }
}

unsafe impl Send for OrtSession {}
unsafe impl Sync for OrtSession {}
