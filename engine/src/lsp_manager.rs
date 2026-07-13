// LSP Manager — long-lived LSP server pool for on-demand call resolution.
// Architecture:
//   LspManager (lazy singleton) → ServerPool → per-language LSP processes
//   Each server: stdio JSON-RPC, started on first use, kept alive forever.
//
// Lifetime:
//   Index complete → pool.warm(project_root)  → spawn servers in background
//   Agent query    → pool.resolve(file, l, c) → JSON-RPC textDocument/definition
//   UI blast radius → pool.references(file,l,c)→ JSON-RPC textDocument/references
//
// Fallback: if a server can't start (not installed / spawn failed / timeout),
// falls through to existing handwritten adapters transparently.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use serde_json::{json, Value};

// ═══════════════════════════════════════════════════════════════
// LSP server process handle
// ═══════════════════════════════════════════════════════════════

struct LspProcess {
    process: Child,
    stdin: ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    next_id: u64,
}

impl LspProcess {
    fn send_request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let body = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        self.stdin.write_all(header.as_bytes()).map_err(|e| format!("write: {}", e))?;
        self.stdin.write_all(body.as_bytes()).map_err(|e| format!("write body: {}", e))?;
        self.stdin.flush().map_err(|e| format!("flush: {}", e))?;

        // Read responses, skipping server-to-client notifications until
        // we get the matching id. LSP servers send diagnostics/log messages
        // asynchronously between request/response cycles.
        loop {
            let (resp_id, response) = self.read_one_message()?;
            if resp_id == Some(id) {
                if let Some(err) = response.get("error") {
                    return Err(format!("LSP error: {}", err));
                }
                return Ok(response);
            }
            // else: server notification (no id) or stale response → skip
        }
    }

    /// Send a notification (no id, no response expected).
    fn send_notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        let notif = json!({"jsonrpc": "2.0", "method": method, "params": params});
        let body = serde_json::to_string(&notif).map_err(|e| e.to_string())?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        self.stdin.write_all(header.as_bytes()).map_err(|e| format!("write: {}", e))?;
        self.stdin.write_all(body.as_bytes()).map_err(|e| format!("write body: {}", e))?;
        self.stdin.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    /// Read a single JSON-RPC message and return its (id, body).
    fn read_one_message(&mut self) -> Result<(Option<u64>, Value), String> {
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            self.reader.read_line(&mut line).map_err(|e| format!("read: {}", e))?;
            let trimmed = line.trim();
            if trimmed.is_empty() { break; }
            if let Some(len_str) = trimmed.strip_prefix("Content-Length: ") {
                content_length = len_str.trim().parse().ok();
            }
        }
        let len = content_length.ok_or("missing Content-Length")?;
        let mut body_buf = vec![0u8; len];
        use std::io::Read;
        self.reader.get_mut().read_exact(&mut body_buf).map_err(|e| format!("read body: {}", e))?;
        let msg: Value = serde_json::from_slice(&body_buf).map_err(|e| format!("parse: {}", e))?;
        let id = msg.get("id").and_then(|v| v.as_u64());
        Ok((id, msg))
    }

    fn initialize(&mut self, root: &str) -> Result<(), String> {
        let params = json!({
            "processId": std::process::id(),
            "rootUri": format!("file:///{}", root.replace('\\', "/")),
            "workspaceFolders": [{
                "uri": format!("file:///{}", root.replace('\\', "/")),
                "name": "project"
            }],
            "capabilities": {
                "textDocument": {
                    "definition": { "linkSupport": true },
                    "references": {},
                    "hover": {},
                },
            },
        });
        let resp = self.send_request("initialize", params)?;
        let _capabilities = resp.get("result").ok_or("no capabilities")?;

        // initialized is a notification, not a request
        self.send_notification("initialized", json!({}))?;

        // Drain any post-init diagnostics/log notifications
        // ponytail: 100ms should be enough for startup messages
        std::thread::sleep(std::time::Duration::from_millis(100));

        Ok(())
    }

    fn open_file(&mut self, uri: &str, text: &str, language: &str) -> Result<(), String> {
        // didOpen is a notification — no id, no response expected
        self.send_notification("textDocument/didOpen", json!({
            "textDocument": {
                "uri": uri,
                "languageId": language,
                "version": 1,
                "text": text,
            }
        }))
    }

    fn definition(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
        });
        let resp = self.send_request("textDocument/definition", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        parse_definition_results(&result)
    }

    fn implementation(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
        });
        let resp = self.send_request("textDocument/implementation", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        parse_definition_results(&result)
    }

    fn hover(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<String, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
        });
        let resp = self.send_request("textDocument/hover", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        if result.is_null() {
            return Ok(String::new());
        }
        // Hover result: { contents: MarkupContent | MarkedString | MarkedString[] }
        let contents = result.get("contents").cloned().unwrap_or(Value::Null);
        match contents {
            Value::String(s) => Ok(s),
            Value::Object(ref m) => m.get("value").and_then(|v| v.as_str()).map(|s| s.to_string()).ok_or("no hover value".into()),
            Value::Array(ref arr) => {
                // MarkedString[] — take the first language-tagged one
                for item in arr {
                    if let Some(s) = item.as_str() { return Ok(s.to_string()); }
                    if let Some(v) = item.get("value").and_then(|v| v.as_str()) { return Ok(v.to_string()); }
                }
                Ok(String::new())
            }
            _ => Ok(String::new()),
        }
    }

    fn references(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
            "context": {"includeDeclaration": false},
        });
        let resp = self.send_request("textDocument/references", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        parse_definition_results(&result)
    }
}

impl Drop for LspProcess {
    fn drop(&mut self) {
        let _ = self.stdin.write_all(
            json!({"jsonrpc":"2.0","method":"shutdown","params":null}).to_string().as_bytes(),
        );
        let _ = self.process.kill();
    }
}

// ═══════════════════════════════════════════════════════════════
// Location parsing
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
pub struct LspLocation {
    pub uri: String,
    pub range_start_line: u32,
    pub range_start_char: u32,
    pub range_end_line: u32,
    pub range_end_char: u32,
}

/// Convert file:/// URI to absolute path.
pub fn uri_to_path(uri: &str) -> String {
    uri.strip_prefix("file:///")
        .unwrap_or(uri)
        .replace('/', if cfg!(windows) { "\\" } else { "/" })
}

fn parse_definition_results(value: &Value) -> Result<Vec<LspLocation>, String> {
    if value.is_null() {
        return Ok(vec![]);
    }
    // LocationLink[] — has targetUri + targetRange
    if let Some(arr) = value.as_array() {
        if let Some(first) = arr.first() {
            if first.get("targetUri").is_some() {
                return arr.iter().map(parse_location_link).collect();
            }
        }
        return arr.iter().map(parse_one_location).collect();
    }
    // Single Location
    if value.get("uri").is_some() {
        return Ok(vec![parse_one_location(value)?]);
    }
    // Single LocationLink
    if value.get("targetUri").is_some() {
        return Ok(vec![parse_location_link(value)?]);
    }
    Ok(vec![])
}

fn parse_location_link(v: &Value) -> Result<LspLocation, String> {
    let uri = v.get("targetUri").and_then(|u| u.as_str()).ok_or("missing targetUri")?.to_string();
    let range = v.get("targetSelectionRange").or(v.get("targetRange")).ok_or("missing range")?;
    parse_range(uri, range)
}

fn parse_one_location(v: &Value) -> Result<LspLocation, String> {
    let uri = v.get("uri").and_then(|u| u.as_str()).ok_or("missing uri")?.to_string();
    let range = v.get("range").ok_or("missing range")?;
    parse_range(uri, range)
}

fn parse_range(uri: String, range: &Value) -> Result<LspLocation, String> {
    let start = range.get("start").ok_or("missing start")?;
    let end = range.get("end").unwrap_or(start);
    Ok(LspLocation {
        uri,
        range_start_line: start.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32,
        range_start_char: start.get("character").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
        range_end_line: end.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32,
        range_end_char: end.get("character").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
    })
}

// ═══════════════════════════════════════════════════════════════
// Server config per language
// ═══════════════════════════════════════════════════════════════

struct LspServerConfig {
    /// Command to spawn (e.g. "rust-analyzer")
    command: &'static str,
    /// CLI args
    args: &'static [&'static str],
    /// LSP language ID (e.g. "rust", "python")
    language_id: &'static str,
    /// File extensions handled by this server
    extensions: &'static [&'static str],
}

const SERVER_CONFIGS: &[LspServerConfig] = &[
    LspServerConfig {
        command: "rust-analyzer",
        args: &[],
        language_id: "rust",
        extensions: &["rs"],
    },
    LspServerConfig {
        command: "gopls",
        args: &[],
        language_id: "go",
        extensions: &["go"],
    },
    LspServerConfig {
        command: "pyright-langserver",
        args: &["--stdio"],
        language_id: "python",
        extensions: &["py", "pyi"],
    },
    LspServerConfig {
        command: "typescript-language-server",
        args: &["--stdio"],
        language_id: "typescript",
        extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
    },
    LspServerConfig {
        command: "clangd",
        args: &[],
        language_id: "cpp",
        extensions: &["c", "h", "cpp", "hpp", "cc", "hh", "cxx", "hxx"],
    },
    LspServerConfig {
        command: "jdtls",
        args: &[],
        language_id: "java",
        extensions: &["java"],
    },
    LspServerConfig {
        command: "omnisharp",
        args: &["--languageserver"],
        language_id: "csharp",
        extensions: &["cs"],
    },
    LspServerConfig {
        command: "intelephense",
        args: &["--stdio"],
        language_id: "php",
        extensions: &["php"],
    },
    LspServerConfig {
        command: "kotlin-language-server",
        args: &[],
        language_id: "kotlin",
        extensions: &["kt", "kts"],
    },
];

// ═══════════════════════════════════════════════════════════════
// Server pool
// ═══════════════════════════════════════════════════════════════

type PoolMap = HashMap<&'static str, Arc<Mutex<Option<LspProcess>>>>;

pub struct LspManager {
    pool: RwLock<PoolMap>,
    project_root: RwLock<Option<String>>,
    initialized: RwLock<bool>,
    /// Last warm error, keyed by command name. Queryable for diagnostics.
    last_warm_errors: RwLock<HashMap<String, String>>,
}

impl LspManager {
    pub fn global() -> &'static Self {
        use std::sync::LazyLock;
        static MANAGER: LazyLock<LspManager> = LazyLock::new(LspManager::new);
        &MANAGER
    }

    fn new() -> Self {
        Self {
            pool: RwLock::new(HashMap::new()),
            project_root: RwLock::new(None),
            initialized: RwLock::new(false),
            last_warm_errors: RwLock::new(HashMap::new()),
        }
    }

    /// Warm the pool — spawn all available LSP servers for the project.
    /// Call after index completes. Failures are stored in last_warm_errors
    /// and surfaced at error level — they are NOT silently swallowed.
    /// Individual servers can be re-tried via try_warm_one() on demand.
    pub fn warm(project_root: &str) {
        let mgr = Self::global();
        *mgr.project_root.write().unwrap() = Some(project_root.to_string());
        *mgr.initialized.write().unwrap() = true;

        for cfg in SERVER_CONFIGS {
            let cmd = cfg.command;
            match Self::spawn_server(cfg, project_root) {
                Ok(process) => {
                    tracing::info!(cmd, "[lsp_manager] server started");
                    mgr.pool
                        .write()
                        .unwrap()
                        .insert(cmd, Arc::new(Mutex::new(Some(process))));
                }
                Err(e) => {
                    let err_msg = format!("spawn+init {}: {}", cmd, e);
                    tracing::error!(cmd, err = %e, "[lsp_manager] server unavailable — LSP resolution will fall back to handwritten adapters for this language");
                    mgr.last_warm_errors
                        .write()
                        .unwrap()
                        .insert(cmd.to_string(), err_msg);
                }
            }
        }
    }

    /// Try to warm a single LSP server by extension. Used as a lazy retry
    /// when resolve_definition finds no server in the pool.
    fn try_warm_one(ext: &str) -> bool {
        let cfg = match SERVER_CONFIGS.iter().find(|c| c.extensions.contains(&ext)) {
            Some(c) => c,
            None => return false,
        };
        let mgr = Self::global();
        let root = match mgr.project_root.read().unwrap().as_ref() {
            Some(r) => r.clone(),
            None => return false,
        };
        let cmd = cfg.command;
        match Self::spawn_server(cfg, &root) {
            Ok(process) => {
                tracing::info!(cmd, ext, "[lsp_manager] lazy warm succeeded");
                mgr.pool
                    .write()
                    .unwrap()
                    .insert(cmd, Arc::new(Mutex::new(Some(process))));
                mgr.last_warm_errors.write().unwrap().remove(cmd);
                true
            }
            Err(e) => {
                let err_msg = format!("lazy-spawn+init {}: {}", cmd, e);
                tracing::error!(cmd, ext, err = %e, "[lsp_manager] lazy warm failed — retry exhausted");
                mgr.last_warm_errors
                    .write()
                    .unwrap()
                    .insert(cmd.to_string(), err_msg);
                false
            }
        }
    }

    fn spawn_server(cfg: &LspServerConfig, root: &str) -> Result<LspProcess, String> {
        let mut c = Command::new(cfg.command);
        c.args(cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW = 0x08000000 — prevents console flash when
            // spawning LSP servers (rust-analyzer, pyright, etc.) from a
            // GUI-subsystem parent process.
            c.creation_flags(0x08000000);
        }
        let mut child = c.spawn()
            .map_err(|e| format!("spawn {}: {}", cfg.command, e))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let mut process = LspProcess {
            process: child,
            stdin,
            reader: BufReader::new(stdout),
            next_id: 0,
        };

        process.initialize(root)?;

        Ok(process)
    }

    /// Find the LSP server for a file extension.
    fn get_server(ext: &str) -> Option<Arc<Mutex<Option<LspProcess>>>> {
        let mgr = Self::global();
        let pool = mgr.pool.read().unwrap();
        for cfg in SERVER_CONFIGS {
            if cfg.extensions.contains(&ext) {
                return pool.get(cfg.command).cloned();
            }
        }
        None
    }

    /// Get server, with a lazy warm retry if it's missing from the pool.
    /// Returns Ok(server_arc) or Err(reason).
    fn get_or_warm_server(ext: &str) -> Result<Arc<Mutex<Option<LspProcess>>>, String> {
        if let Some(arc) = Self::get_server(ext) {
            return Ok(arc);
        }
        tracing::info!(ext, "[lsp_manager] server not in pool, attempting lazy warm");
        if !Self::try_warm_one(ext) {
            return Err(format!("no server for .{} (lazy warm failed)", ext));
        }
        Self::get_server(ext).ok_or_else(|| format!("no server for .{} after warm", ext))
    }

    /// Resolve a call at (file, line, column) using an LSP server.
    /// Returns the definition location, or Err if no server available.
    pub fn resolve_definition(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<Vec<LspLocation>, String> {
        let mgr = Self::global();
        if !*mgr.initialized.read().unwrap() {
            return Err("LSP pool not initialized".into());
        }

        let server_arc = Self::get_or_warm_server(ext)?;

        let mut guard = server_arc.lock().map_err(|e| format!("lock: {}", e))?;
        let process = guard.as_mut().ok_or("server not running")?;

        let abs_path = if PathBuf::from(file_path).is_absolute() {
            file_path.to_string()
        } else {
            let root = mgr.project_root.read().unwrap();
            let root = root.as_ref().ok_or("no project root")?;
            format!("{}/{}", root, file_path)
        };
        let uri = format!("file:///{}", abs_path.replace('\\', "/"));

        // Find language ID
        let lang_id = SERVER_CONFIGS
            .iter()
            .find(|c| c.extensions.contains(&ext))
            .map(|c| c.language_id)
            .unwrap_or(ext);

        let _ = process.open_file(&uri, source, lang_id);
        process.definition(&uri, line, column)
    }

    /// Resolve the type at (file, line, column) via hover.
    pub fn resolve_type(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<String, String> {
        let (uri, lang_id) = Self::prepare(file_path, ext)?;
        let server_arc = Self::get_or_warm_server(ext)?;
        let mut guard = server_arc.lock().map_err(|e| format!("lock: {}", e))?;
        let process = guard.as_mut().ok_or("server not running")?;
        let _ = process.open_file(&uri, source, &lang_id);
        process.hover(&uri, line, column)
    }

    /// Find all implementations of the interface/trait at (file, line, column).
    pub fn find_implementations(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<Vec<LspLocation>, String> {
        let (uri, lang_id) = Self::prepare(file_path, ext)?;
        let server_arc = Self::get_or_warm_server(ext)?;
        let mut guard = server_arc.lock().map_err(|e| format!("lock: {}", e))?;
        let process = guard.as_mut().ok_or("server not running")?;
        let _ = process.open_file(&uri, source, &lang_id);
        process.implementation(&uri, line, column)
    }

    /// Find all references to the symbol at (file, line, column).
    pub fn find_references(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<Vec<LspLocation>, String> {
        let (uri, lang_id) = Self::prepare(file_path, ext)?;
        let server_arc = Self::get_or_warm_server(ext)?;
        let mut guard = server_arc.lock().map_err(|e| format!("lock: {}", e))?;
        let process = guard.as_mut().ok_or("server not running")?;
        let _ = process.open_file(&uri, source, &lang_id);
        process.references(&uri, line, column)
    }

    /// Helper: resolve uri + lang_id from file path and ext.
    fn prepare(file_path: &str, ext: &str) -> Result<(String, String), String> {
        let abs_path = if PathBuf::from(file_path).is_absolute() {
            file_path.to_string()
        } else {
            let mgr = Self::global();
            let root = mgr.project_root.read().unwrap();
            let root = root.as_ref().ok_or("no project root")?;
            format!("{}/{}", root, file_path)
        };
        let uri = format!("file:///{}", abs_path.replace('\\', "/"));
        let lang_id = SERVER_CONFIGS
            .iter()
            .find(|c| c.extensions.contains(&ext))
            .map(|c| c.language_id)
            .unwrap_or(ext)
            .to_string();
        Ok((uri, lang_id))
    }

    /// Check if LSP is available for a given file extension.
    /// Returns true only if a server process is actually running in the pool.
    pub fn is_available(ext: &str) -> bool {
        Self::get_server(ext)
            .and_then(|arc| {
                arc.lock().ok().map(|guard| guard.is_some())
            })
            .unwrap_or(false)
    }

    /// Return last warm errors for diagnostic display.
    /// Returns a map of command name → error message.
    pub fn warm_errors() -> HashMap<String, String> {
        Self::global().last_warm_errors.read().unwrap().clone()
    }

    /// Full LSP status for the settings panel / engine_status.
    /// Returns per-server availability + install hints.
    pub fn lsp_status() -> Vec<Value> {
        let mgr = Self::global();
        let errors = mgr.last_warm_errors.read().unwrap().clone();
        let pool = mgr.pool.read().unwrap();
        SERVER_CONFIGS
            .iter()
            .map(|cfg| {
                let available = pool.get(cfg.command)
                    .and_then(|arc| arc.lock().ok().map(|g| g.is_some()))
                    .unwrap_or(false);
                let error = errors.get(cfg.command).cloned();
                json!({
                    "command": cfg.command,
                    "language_id": cfg.language_id,
                    "extensions": cfg.extensions,
                    "available": available,
                    "error": error,
                })
            })
            .collect()
    }
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_single_location() {
        let json = json!({
            "uri": "file:///src/main.rs",
            "range": {
                "start": {"line": 10, "character": 5},
                "end": {"line": 10, "character": 9}
            }
        });
        let locs = parse_definition_results(&json).unwrap();
        assert_eq!(locs.len(), 1);
        assert_eq!(locs[0].uri, "file:///src/main.rs");
        assert_eq!(locs[0].range_start_line, 10);
    }

    #[test]
    fn test_parse_null_result() {
        let locs = parse_definition_results(&Value::Null).unwrap();
        assert!(locs.is_empty());
    }

    #[test]
    fn test_server_configs_complete() {
        // Every extension in the engine's LSP match should have a config
        let covered: Vec<&str> = SERVER_CONFIGS
            .iter()
            .flat_map(|c| c.extensions.iter().copied())
            .collect();
        assert!(covered.contains(&"rs"));
        assert!(covered.contains(&"py"));
        assert!(covered.contains(&"go"));
        assert!(covered.contains(&"java"));
        assert!(covered.contains(&"ts"));
        assert!(covered.contains(&"cs"));
        assert!(covered.contains(&"php"));
        assert!(covered.contains(&"kt"));
    }
}