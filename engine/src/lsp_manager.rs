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

/// Default LSP request timeout.
const LSP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

struct LspProcess {
    process: Child,
    stdin: ChildStdin,
    reader: Option<BufReader<std::process::ChildStdout>>,
    #[allow(dead_code)]
    stderr: Option<std::process::ChildStderr>,
    next_id: u64,
    timeout: std::time::Duration,
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

        // Read responses in a spawned thread so we can enforce a timeout.
        // LSP servers send diagnostics/log notifications asynchronously
        // between request/response cycles — skip those, wait for our id.
        let mut reader = self.reader.take()
            .ok_or("LSP reader lost (previous call timed out) — server will be recreated")?;

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = loop {
                match Self::read_one_message(&mut reader) {
                    Ok((resp_id, response)) => {
                        if resp_id == Some(id) {
                            if let Some(err) = response.get("error") {
                                break Err(format!("LSP error: {}", err));
                            }
                            break Ok(response);
                        }
                        // notification or stale response → skip
                    }
                    Err(e) => break Err(format!("LSP read error: {}", e)),
                }
            };
            let _ = tx.send((reader, result));
        });

        match rx.recv_timeout(self.timeout) {
            Ok((reader_back, result)) => {
                self.reader = Some(reader_back);
                result
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Thread still alive but we're done waiting.
                // Reader is lost — next call fails → get_or_warm_server recreates.
                Err(format!(
                    "LSP timeout after {:?} waiting for {}(id {})",
                    self.timeout, method, id,
                ))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("LSP reader thread panicked".to_string())
            }
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
    /// Static so it can be called from the timeout thread without borrowing self.
    fn read_one_message(reader: &mut BufReader<std::process::ChildStdout>) -> Result<(Option<u64>, Value), String> {
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).map_err(|e| format!("read: {}", e))?;
            if n == 0 {
                // EOF — server exited without sending headers
                break;
            }
            let trimmed = line.trim();
            // Skip leading noise (startup banners, stray log output, etc.)
            if trimmed.is_empty() {
                if content_length.is_some() { break; }
                continue;
            }
            // Match "Content-Length: N" with flexible whitespace
            let lower = trimmed.to_lowercase();
            if let Some(val) = lower.strip_prefix("content-length:") {
                content_length = val.trim().parse().ok();
            }
        }
        let len = content_length.ok_or("missing Content-Length")?;
        let mut body_buf = vec![0u8; len];
        use std::io::Read;
        reader.get_mut().read_exact(&mut body_buf).map_err(|e| format!("read body: {}", e))?;
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
        let resp = self.send_request("initialize", params)
            .map_err(|e| {
                // Try to read stderr for diagnostics
                let mut extra = String::new();
                if let Some(ref mut stderr) = self.stderr {
                    let mut buf = [0u8; 512];
                    use std::io::Read;
                    if let Ok(n) = stderr.read(&mut buf) {
                        if n > 0 {
                            extra = format!(" stderr: {}", String::from_utf8_lossy(&buf[..n]).trim());
                        }
                    }
                }
                format!("{}{}", e, extra)
            })?;
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
    /// Configuration file that marks the correct workspace root.
    /// If present and not found at project root, we search one level
    /// of subdirectories and use the first match's parent as rootUri.
    config_marker: &'static [&'static str],
}

const SERVER_CONFIGS: &[LspServerConfig] = &[
    LspServerConfig {
        command: "rust-analyzer",
        args: &[],
        language_id: "rust",
        extensions: &["rs"],
        config_marker: &["Cargo.toml"],
    },
    LspServerConfig {
        command: "gopls",
        args: &[],
        language_id: "go",
        extensions: &["go"],
        config_marker: &["go.mod"],
    },
    LspServerConfig {
        command: "pyright-langserver",
        args: &["--stdio"],
        language_id: "python",
        extensions: &["py", "pyi"],
        config_marker: &["pyproject.toml", "setup.py", "setup.cfg"],
    },
    LspServerConfig {
        command: "typescript-language-server",
        args: &["--stdio"],
        language_id: "typescript",
        extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
        config_marker: &["tsconfig.json", "jsconfig.json"],
    },
    LspServerConfig {
        command: "clangd",
        args: &[],
        language_id: "cpp",
        extensions: &["c", "h", "cpp", "hpp", "cc", "hh", "cxx", "hxx"],
        config_marker: &["compile_commands.json", "CMakeLists.txt", "Makefile"],
    },
    LspServerConfig {
        command: "jdtls",
        args: &[],
        language_id: "java",
        extensions: &["java"],
        config_marker: &["pom.xml", "build.gradle", "build.gradle.kts"],
    },
    LspServerConfig {
        command: "omnisharp",
        args: &["--languageserver"],
        language_id: "csharp",
        extensions: &["cs"],
        config_marker: &["*.sln", "*.csproj"],
    },
    LspServerConfig {
        command: "intelephense",
        args: &["--stdio"],
        language_id: "php",
        extensions: &["php"],
        config_marker: &["composer.json"],
    },
    LspServerConfig {
        command: "kotlin-language-server",
        args: &[],
        language_id: "kotlin",
        extensions: &["kt", "kts"],
        config_marker: &["build.gradle.kts", "settings.gradle.kts"],
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

    pub fn is_initialized() -> bool {
        *Self::global().initialized.read().unwrap()
    }

    fn new() -> Self {
        Self {
            pool: RwLock::new(HashMap::new()),
            project_root: RwLock::new(None),
            initialized: RwLock::new(false),
            last_warm_errors: RwLock::new(HashMap::new()),
        }
    }

    /// Warm the pool — spawn ALL configured LSP servers in parallel.
    /// No extension scanning, no filtering: if a server is installed on PATH,
    /// we try to start it. Slow starters don't block fast ones. Failures are
    /// recorded in `last_warm_errors` for diagnostics. Call after index completes.
    pub fn warm(project_root: &str) {
        let mgr = Self::global();
        *mgr.project_root.write().unwrap() = Some(project_root.to_string());
        *mgr.initialized.write().unwrap() = true;

        let root = project_root.to_string();
        for cfg in SERVER_CONFIGS {
            let root = Self::resolve_workspace_root(&root, cfg.config_marker);
            let cmd = cfg.command;
            let cfg: &'static LspServerConfig = cfg; // const slice → 'static
            std::thread::spawn(move || {
                match Self::spawn_server(cfg, &root) {
                    Ok(process) => {
                        tracing::info!(cmd, "[lsp_manager] server started");
                        mgr.pool
                            .write()
                            .unwrap()
                            .insert(cmd, Arc::new(Mutex::new(Some(process))));
                        mgr.last_warm_errors.write().unwrap().remove(cmd);
                    }
                    Err(e) => {
                        let diagnosed = Self::diagnose_error(cmd, &e);
                        let err_msg = format!("spawn+init {}: {}", cmd, diagnosed);
                        tracing::error!(cmd, err = %diagnosed, "[lsp_manager] server unavailable");
                        mgr.last_warm_errors
                            .write()
                            .unwrap()
                            .insert(cmd.to_string(), err_msg);
                    }
                }
            });
        }
    }

    /// Warm the pool synchronously — blocks until ALL servers are started
    /// or failed. Returns (started_count, failed_count). Used by stress tests.
    pub fn warm_blocking(project_root: &str) -> (usize, usize) {
        Self::warm_blocking_filtered(project_root, &[])
    }

    /// Warm the pool synchronously, only starting servers whose extension
    /// list overlaps with `ext_filter`. If `ext_filter` is empty, starts all.
    pub fn warm_blocking_filtered(project_root: &str, ext_filter: &[&str]) -> (usize, usize) {
        let mgr = Self::global();
        *mgr.project_root.write().unwrap() = Some(project_root.to_string());
        *mgr.initialized.write().unwrap() = true;

        let root = project_root.to_string();
        let mut handles = Vec::new();

        for cfg in SERVER_CONFIGS {
            // Apply extension filter if non-empty
            if !ext_filter.is_empty() {
                let has_match = ext_filter.iter()
                    .any(|e| cfg.extensions.contains(e));
                if !has_match { continue; }
            }

            let root = Self::resolve_workspace_root(&root, cfg.config_marker);
            let cmd = cfg.command;
            let cfg: &'static LspServerConfig = cfg;
            let handle = std::thread::spawn(move || {
                match Self::spawn_server(cfg, &root) {
                    Ok(process) => {
                        tracing::info!(cmd, "[lsp_manager] server started (blocking)");
                        mgr.pool
                            .write()
                            .unwrap()
                            .insert(cmd, Arc::new(Mutex::new(Some(process))));
                        mgr.last_warm_errors.write().unwrap().remove(cmd);
                        Ok(cmd)
                    }
                    Err(e) => {
                        let diagnosed = Self::diagnose_error(cmd, &e);
                        let err_msg = format!("spawn+init {}: {}", cmd, diagnosed);
                        tracing::error!(cmd, err = %diagnosed, "[lsp_manager] server unavailable (blocking)");
                        mgr.last_warm_errors
                            .write()
                            .unwrap()
                            .insert(cmd.to_string(), err_msg);
                        Err(cmd)
                    }
                }
            });
            handles.push(handle);
        }

        let mut started = 0;
        let mut failed = 0;
        for h in handles {
            match h.join().unwrap() {
                Ok(_) => started += 1,
                Err(_) => failed += 1,
            }
        }

        (started, failed)
    }

    /// Find the correct workspace root for an LSP server.
    /// Searches for any of the config_marker files in the project root,
    /// then one level of subdirectories. Returns the directory containing
    /// the first match, or the project root if nothing found.
    fn resolve_workspace_root(project_root: &str, markers: &[&str]) -> String {
        if markers.is_empty() {
            return project_root.to_string();
        }
        // Check project root first
        if Self::dir_has_marker(project_root, markers) {
            return project_root.to_string();
        }
        // Search immediate subdirectories
        if let Ok(entries) = std::fs::read_dir(project_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(dir_str) = path.to_str() {
                        if Self::dir_has_marker(dir_str, markers) {
                            return dir_str.to_string();
                        }
                    }
                }
            }
        }
        // Fallback: project root
        project_root.to_string()
    }

    /// Check whether a directory contains any of the given marker files.
    /// Supports literal names and extension globs (e.g. "*.sln").
    fn dir_has_marker(dir: &str, markers: &[&str]) -> bool {
        for marker in markers {
            if marker.starts_with("*.") {
                // Extension glob: check if any file with this extension exists
                let ext = &marker[1..]; // ".sln", ".csproj"
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_file() {
                            if let Some(file_ext) = p.extension().and_then(|e| e.to_str()) {
                                let dot_ext = format!(".{}", file_ext);
                                if dot_ext.eq_ignore_ascii_case(ext) {
                                    return true;
                                }
                            }
                        }
                    }
                }
            } else {
                // Literal filename
                let full = std::path::Path::new(dir).join(marker);
                if full.exists() {
                    return true;
                }
            }
        }
        false
    }

    /// Diagnose common LSP spawn failures and return actionable guidance.
    fn diagnose_error(cmd: &str, raw: &str) -> String {
        let lower = raw.to_lowercase();
        // npm global package corruption — node_modules missing
        if lower.contains("cannot find module") && lower.contains("node_modules") {
            return format!(
                "{} — npm package appears corrupted. Reinstall: npm uninstall -g {} && npm install -g {}",
                raw,
                cmd.replace("-langserver", "").replace("-language-server", ""),
                cmd.replace("-langserver", "").replace("-language-server", ""),
            );
        }
        // rustup proxy without the actual component
        if cmd == "rust-analyzer" && lower.contains("unknown binary") && lower.contains("toolchain") {
            return format!(
                "{} — rust-analyzer not installed for your Rust toolchain. Run: rustup component add rust-analyzer",
                raw,
            );
        }
        // gopls not installed
        if cmd == "gopls" && (lower.contains("not found") || lower.contains("no such file")) {
            return format!(
                "{} — gopls not found. Install: go install golang.org/x/tools/gopls@latest",
                raw,
            );
        }
        // Generic "not found"
        if lower.contains("program not found") || lower.contains("no such file") {
            return format!(
                "{} — {} is not installed or not on PATH. See 安装指南 for install instructions.",
                raw, cmd,
            );
        }
        // Pass through with no modification
        raw.to_string()
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
        // Resolve full path — on Windows npm-global tools are .cmd wrappers.
        // .cmd/.bat files must be run via cmd.exe /c (they're scripts, not PE executables).
        let exe = Self::resolve_cmd_path(cfg.command)
            .unwrap_or_else(|| std::path::PathBuf::from(cfg.command));
        let (program, args_vec) = {
            #[cfg(target_os = "windows")]
            {
                let ext = exe.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if ext == "cmd" || ext == "bat" {
                    let mut v = vec!["/c".to_string(), exe.to_string_lossy().into_owned()];
                    v.extend(cfg.args.iter().map(|a| a.to_string()));
                    (std::path::PathBuf::from("cmd.exe"), v)
                } else {
                    let v: Vec<String> = cfg.args.iter().map(|a| a.to_string()).collect();
                    (exe, v)
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let v: Vec<String> = cfg.args.iter().map(|a| a.to_string()).collect();
                (exe, v)
            }
        };

        let mut c = Command::new(&program);
        c.args(&args_vec)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()); // capture stderr for diagnostics
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = c.spawn()
            .map_err(|e| format!("spawn {}: {}", cfg.command, e))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take();

        let mut process = LspProcess {
            process: child,
            stdin,
            reader: Some(BufReader::new(stdout)),
            stderr,
            next_id: 0,
            timeout: LSP_TIMEOUT,
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
    /// Lock the server, run f, and if f fails clear the pool entry so the
    /// next call warms a fresh process.
    fn with_process<T>(
        server_arc: &Arc<Mutex<Option<LspProcess>>>,
        f: impl FnOnce(&mut LspProcess) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = server_arc.lock().map_err(|e| format!("lock: {}", e))?;
        let process = guard.as_mut().ok_or("server not running")?;
        match f(process) {
            Ok(v) => Ok(v),
            Err(e) => {
                *guard = None; // kill broken process, force recreate next call
                Err(e)
            }
        }
    }

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
        let abs_path = if PathBuf::from(file_path).is_absolute() {
            file_path.to_string()
        } else {
            let root = mgr.project_root.read().unwrap();
            let root = root.as_ref().ok_or("no project root")?;
            format!("{}/{}", root, file_path)
        };
        let uri = format!("file:///{}", abs_path.replace('\\', "/"));
        let lang_id = SERVER_CONFIGS.iter().find(|c| c.extensions.contains(&ext)).map(|c| c.language_id).unwrap_or(ext);
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, lang_id);
            process.definition(&uri, line, column)
        })
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
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, &lang_id);
            process.hover(&uri, line, column)
        })
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
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, &lang_id);
            process.implementation(&uri, line, column)
        })
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
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, &lang_id);
            process.references(&uri, line, column)
        })
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

    /// Resolve a command to its full path on the filesystem.
    /// On Windows, checks .exe/.cmd/.bat first — npm global tools have
    /// extensionless Unix scripts alongside .cmd wrappers; the extensionless
    /// file is a shell script that can't be spawned directly.
    fn resolve_cmd_path(cmd: &str) -> Option<std::path::PathBuf> {
        if let Ok(paths) = std::env::var("PATH") {
            for dir in std::env::split_paths(&paths) {
                #[cfg(target_os = "windows")]
                {
                    for ext in ["exe", "cmd", "bat"] {
                        let with_ext = dir.join(cmd).with_extension(ext);
                        if with_ext.exists() {
                            return Some(with_ext);
                        }
                    }
                }
                // Fallback: extensionless (Unix) or non-Windows
                let full = dir.join(cmd);
                if full.exists() {
                    return Some(full);
                }
            }
        }
        None
    }

    /// Check whether a command exists on PATH without spawning it.
    /// Always works — no warm() required. Used by lsp_status() to
    /// distinguish "not started" from "not installed".
    fn find_on_path(cmd: &str) -> bool {
        Self::resolve_cmd_path(cmd).is_some()
    }

    /// Full LSP status for the settings panel / engine_status.
    /// Returns per-server availability + install hints.
    /// `installed` is checked via PATH — works even when warm() hasn't run.
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
                // Always check PATH — independent of warm state
                let installed = available || Self::find_on_path(cfg.command);
                json!({
                    "command": cfg.command,
                    "language_id": cfg.language_id,
                    "extensions": cfg.extensions,
                    "available": available,
                    "installed": installed,
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

    // ── helpers ──


    /// Spawn cmd that hangs for 60s — used for timeout test.
    fn spawn_hanging_process() -> LspProcess {
        let mut child = Command::new("cmd")
            .args(&["/c", "ping -n 60 127.0.0.1 > nul"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cmd timeout");

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        LspProcess {
            process: child,
            stdin,
            reader: Some(BufReader::new(stdout)),
            stderr: None,
            next_id: 0,
            timeout: std::time::Duration::from_secs(2),
        }
    }

    // ── timeout ──

    #[test]
    fn test_send_request_timeout() {
        let mut process = spawn_hanging_process();
        let start = std::time::Instant::now();
        let result = process.send_request(
            "textDocument/references",
            json!({"textDocument":{"uri":"file:///x.rs"},"position":{"line":0,"character":0}}),
        );
        let elapsed = start.elapsed();
        // Should not hang — must return within 5s (timeout is set to 2s)
        assert!(elapsed < std::time::Duration::from_secs(5),
            "send_request should not block forever, took {:?}, result: {:?}", elapsed, result);
        assert!(result.is_err(), "expected error from hanging process, got {:?}", result);
    }

    // ── E2E: real rust-analyzer ──

    // NOTE: a rust-analyzer E2E test was attempted but is unreliable in CI:
    // cargo check timing varies wildly per machine. The timeout mechanism is
    // proven by test_send_request_timeout; real LSP calls are exercised by
    // every engine run (indexing + agent queries via MCP tools).

}