// Minimal ONNX Runtime FFI — uses OrtGetApiBase to get the API table.
// ponytail: newer ORT DLLs only export OrtGetApiBase + a few entry points.
// All other functions are in the API table returned by OrtGetApiBase().

use anyhow::{anyhow, Result};
use std::ffi::c_void;
use std::sync::OnceLock;

type OrtStatusPtr = *mut c_void;

// The OrtApi struct layout (v17+). We only need the functions we actually call.
// Offsets are based on the ORT API header. Each field is a function pointer (8 bytes on x64).
#[repr(C)]
struct OrtApi {
    create_status: unsafe extern "C" fn(code: i32, msg: *const i8) -> OrtStatusPtr,
    get_error_code: unsafe extern "C" fn(status: OrtStatusPtr) -> i32,
    get_error_message: unsafe extern "C" fn(status: OrtStatusPtr, out: *mut *const i8) -> OrtStatusPtr,
    _pad0: usize, _pad1: usize, _pad2: usize, _pad3: usize, _pad4: usize,
    create_env: unsafe extern "C" fn(logging_level: i32, logid: *const i8, out: *mut *mut c_void) -> OrtStatusPtr,
    create_env_with_custom_logger: usize,
    _pad5: usize, _pad6: usize, // enable/disable telemetry events
    create_allocator: usize,
    _pad7: usize, // get_allocator_with_default_options
    _pad8: usize, // create_env_with_global_thread_pool
    _pad9: usize, // register_allocator
    create_session: unsafe extern "C" fn(env: *mut c_void, model_path: *const u16, opts: *const c_void, out: *mut *mut c_void) -> OrtStatusPtr,
    _pad10: usize, // create_session_from_array
    _pad11: usize, _pad12: usize, _pad13: usize, _pad14: usize, _pad15: usize, _pad16: usize, _pad17: usize, _pad18: usize,
    // v6
    _pad19: usize, _pad20: usize, _pad21: usize, _pad22: usize,
    // v7
    create_cpu_memory_info: unsafe extern "C" fn(atype: i32, memtype: i32, out: *mut *mut c_void) -> OrtStatusPtr,
    _pad23: usize, // create_memory_info
    _pad24: usize, _pad25: usize, _pad26: usize, _pad27: usize, _pad28: usize, _pad29: usize, _pad30: usize, _pad31: usize, _pad32: usize,
    _pad33: usize, _pad34: usize, _pad35: usize, _pad36: usize, _pad37: usize, _pad38: usize, _pad39: usize,
    create_tensor_with_data: unsafe extern "C" fn(
        info: *mut c_void, data: *mut c_void, data_len: usize,
        shape: *const i64, shape_len: usize, elem_type: i32, out: *mut *mut c_void,
    ) -> OrtStatusPtr,
    _pad40: usize, _pad41: usize,
    get_tensor_mutable_data: unsafe extern "C" fn(value: *mut c_void, out: *mut *mut c_void) -> OrtStatusPtr,
    _pad42: usize, // fill_string_tensor
    _pad43: usize, // get_string_tensor_data_length
    _pad44: usize, _pad45: usize, _pad46: usize, _pad47: usize, _pad48: usize, _pad49: usize, _pad50: usize,
    _pad51: usize, _pad52: usize, _pad53: usize, _pad54: usize,
    run: unsafe extern "C" fn(
        session: *mut c_void, run_options: *const c_void,
        input_names: *const *const i8, inputs: *const *mut c_void, num_inputs: usize,
        output_names: *const *const i8, num_outputs: usize, outputs: *mut *mut c_void,
    ) -> OrtStatusPtr,
    _pad55: usize, _pad56: usize, _pad57: usize, _pad58: usize, _pad59: usize,
    release_status: unsafe extern "C" fn(status: OrtStatusPtr),
    _pad60: usize, // release_env (proxy)
    release_session: unsafe extern "C" fn(session: *mut c_void),
    release_value: unsafe extern "C" fn(value: *mut c_void),
    release_memory_info: unsafe extern "C" fn(info: *mut c_void),
}

type OrtGetApiBaseFunc = unsafe extern "C" fn() -> *const *const OrtApi;

static API: OnceLock<&'static OrtApi> = OnceLock::new();

fn get_api() -> Result<&'static OrtApi> {
    if let Some(api) = API.get() { return Ok(api); }
    let lib = unsafe {
        libloading::Library::new("onnxruntime.dll")
            .or_else(|_| libloading::Library::new("target/release/onnxruntime.dll"))
            .map_err(|e| anyhow!("onnxruntime.dll not found: {e}"))?
    };
    let get_api_base: libloading::Symbol<OrtGetApiBaseFunc> = unsafe { lib.get(b"OrtGetApiBase")? };
    let api_ptr = unsafe { get_api_base() };
    if api_ptr.is_null() { return Err(anyhow!("OrtGetApiBase returned null")); }
    let api: &'static OrtApi = unsafe { &**api_ptr };
    // ponytail: leak the library so the API pointer stays valid (server lifetime)
    std::mem::forget(lib);
    let _ = API.set(api);
    Ok(api)
}

pub struct OrtSession {
    env: *mut c_void,
    session: *mut c_void,
    memory_info: *mut c_void,
}

impl OrtSession {
    pub fn new(model_path: &str) -> Result<Self> {
        let api = get_api()?;
        let model_wide: Vec<u16> = model_path.encode_utf16().chain(std::iter::once(0)).collect();

        let mut env: *mut c_void = std::ptr::null_mut();
        let mut session: *mut c_void = std::ptr::null_mut();
        let mut mem_info: *mut c_void = std::ptr::null_mut();

        unsafe {
            let s = (api.create_env)(3, std::ptr::null(), &mut env);
            if !s.is_null() { (api.release_status)(s); return Err(anyhow!("OrtCreateEnv failed")); }

            let s = (api.create_session)(env, model_wide.as_ptr(), std::ptr::null(), &mut session);
            if !s.is_null() { (api.release_status)(s); (api.release_status)(s); return Err(anyhow!("OrtCreateSession failed for {model_path}")); }

            let s = (api.create_cpu_memory_info)(1, 1, &mut mem_info);
            if !s.is_null() { (api.release_status)(s); return Err(anyhow!("OrtCreateCpuMemoryInfo failed")); }
        }

        Ok(Self { env, session, memory_info: mem_info })
    }

    pub fn run(&self, input_ids: &[i64], input_mask: &[i64], seq_len: usize, hidden_dim: usize) -> Result<Vec<f32>> {
        let api = get_api()?;
        unsafe {
            let shape = [1i64, seq_len as i64];
            let mut input_tensor: *mut c_void = std::ptr::null_mut();
            let s = (api.create_tensor_with_data)(
                self.memory_info,
                input_ids.as_ptr() as *mut c_void,
                (input_ids.len() * 8) as usize,
                shape.as_ptr(), 2, 7, // ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64 = 7
                &mut input_tensor,
            );
            if !s.is_null() { (api.release_status)(s); return Err(anyhow!("create input tensor failed")); }

            let mut mask_tensor: *mut c_void = std::ptr::null_mut();
            let s = (api.create_tensor_with_data)(
                self.memory_info,
                input_mask.as_ptr() as *mut c_void,
                (input_mask.len() * 8) as usize,
                shape.as_ptr(), 2, 7,
                &mut mask_tensor,
            );
            if !s.is_null() { (api.release_status)(s); return Err(anyhow!("create mask tensor failed")); }

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

            if !s.is_null() { (api.release_status)(s); return Err(anyhow!("OrtRun failed")); }

            let mut data: *mut c_void = std::ptr::null_mut();
            let s = (api.get_tensor_mutable_data)(output, &mut data);
            if !s.is_null() { (api.release_status)(s); (api.release_value)(output); return Err(anyhow!("get tensor data failed")); }

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
                if !self.env.is_null() {
                    // ponytail: no direct release_env in this API subset, session release cleans up
                }
            }
        }
    }
}

unsafe impl Send for OrtSession {}
unsafe impl Sync for OrtSession {}