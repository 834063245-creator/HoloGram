# HoloGram 日志系统落地方案

## 现状诊断

| 层面 | 当前做法 | 问题 |
|------|----------|------|
| Engine (Rust) | `eprintln!` / `println!` 裸打，15 处 | 不落盘，无时间戳，无分级，混在 stdout 里影响 MCP 协议 |
| Tauri Bridge (Rust) | 同上 | 所有 `hologram_*` 命令无入口出口日志 |
| UI Agent (TS) | `console.warn` 5 处 | 只在浏览器控制台，进程退出即丢失 |
| 文件访问 | `.hologram/audit.jsonl` | ✅ 已有，仅覆盖沙箱读写 |
| 变更历史 | `.hologram/timeline.db` | ✅ 已有，仅覆盖依赖图变化 |

**缺的是：运行时操作日志** — 谁在什么时候调了什么、耗时多久、有没有出错。

---

## 架构总览

```
┌─────────────────────────────────────────────┐
│  UI 前端 (TypeScript)                        │
│  ├─ agent.ts    → info: turn 开始/结束       │
│  ├─ tool.ts     → info: 工具调用 + 耗时      │
│  └─ bridge.ts   → info: invoke 往返          │
│      ↓ 输出到 .hologram/logs/ui.log          │
└──────────────────┬──────────────────────────┘
                   │ Tauri invoke
┌──────────────────▼──────────────────────────┐
│  Tauri Bridge (Rust)                         │
│  ├─ main.rs 每个 hologram_* 命令             │
│  │   → info: 命令名 + 参数摘要 + 耗时        │
│  └─ 转发到 engine 进程                       │
│      ↓ 输出到 .hologram/logs/bridge.log       │
└──────────────────┬──────────────────────────┘
                   │ stdin/stdout JSON-RPC
┌──────────────────▼──────────────────────────┐
│  Engine (Rust)                               │
│  ├─ main.rs: analyze / 请求路由              │
│  ├─ mcp.rs:   handle_request → tool_*        │
│  ├─ graph.rs: 图操作                         │
│  ├─ analysis/: 耦合/循环/盲点计算             │
│  │   → info:  正常流                         │
│  │   → debug: 详细中间数据                   │
│  │   → warn:  非致命异常                     │
│  │   → error: 致命失败                       │
│  └─ 输出到 .hologram/logs/engine.log          │
└─────────────────────────────────────────────┘
```

三层各自独立输出到 `.hologram/logs/`。

---

## 一、Rust Engine 端（最高优先）

### 1.1 依赖（改 `engine/Cargo.toml`）

在 `[dependencies]` 末尾追加三项：

```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
tracing-appender = "0.2"
```

都是 Rust 生态标准库，无兼容风险。

### 1.2 新建 `engine/src/logging.rs`

```rust
use tracing_subscriber::{fmt, layer::SubscriberExt, EnvFilter, Registry};
use tracing_appender::{rolling, non_blocking};
use std::path::Path;

pub fn init_logging(project_root: &Path) -> non_blocking::WorkerGuard {
    let log_dir = project_root.join(".hologram").join("logs");
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = rolling::Builder::new()
        .rotation(rolling::Rotation::NEVER)
        .filename_prefix("engine")
        .filename_suffix("log")
        .max_log_files(5)
        .build(&log_dir)
        .expect("failed to create log file appender");

    let (non_blocking, guard) = non_blocking(file_appender);

    // JSON 格式写文件，适合后续机器分析
    let file_layer = fmt::layer().json().with_writer(non_blocking);

    // 人类可读格式写 stderr，开发调试用
    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_writer(std::io::stderr);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    tracing::subscriber::set_global_default(
        Registry::default().with(filter).with(file_layer).with(stderr_layer)
    ).expect("tracing subscriber already set");

    guard // 必须持有，否则后台写线程会被销毁
}
```

### 1.3 启动接入（改 `engine/src/main.rs`）

顶部加：
```rust
mod logging;
```

`fn main()` 中获取 `project_root` 后立即：
```rust
let root = PathBuf::from(&project_root);
let _log_guard = logging::init_logging(&root);
```

### 1.4 替换全部裸打印

| 当前 (main.rs) | 替换为 |
|----------------|--------|
| `eprintln!("[engine] MCP serve mode — project: {}", project_root)` | `info!(project_root = %project_root, "engine starting in MCP serve mode")` |
| `eprintln!("[engine] ERROR: project root not found: {}", project_root)` | `error!(project_root = %project_root, "project root not found")` |
| `eprintln!("[engine] analyzing project...")` | `info!("analysis started")` |
| `eprintln!("[engine] analysis complete: {} nodes, {} edges, {:.1}s", ...)` | `info!(nodes = node_count, edges = edge_count, elapsed = %result.elapsed_secs, "analysis complete")` |
| `println!("[engine] listening on 127.0.0.1:9777")` | `info!("TCP server listening on 127.0.0.1:9777")` |
| `println!("[engine] connected: {}", addr)` | `debug!(%addr, "client connected")` |
| `println!("[engine] received: {}", request.trim())` | `debug!(request_len = request.len(), "received request")` |
| `println!("[engine] sent {} bytes", framed.len())` | `debug!(bytes = framed.len(), "response sent")` |
| `println!("[engine] coupling: {:.2}s", ...)` | `info!(elapsed_secs = ..., "coupling computation done")` |

### 1.5 MCP 请求日志（改 `mcp.rs`）

`handle_request` 入口加：
```rust
let start = std::time::Instant::now();
info!(method = %method, id = %id, "mcp request");
```

返回前加：
```rust
info!(method = %method, id = %id, elapsed_ms = start.elapsed().as_millis(), "mcp response");
```

所有 `return make_rpc(id, json!({"error": ...}))` 前加 `warn!` 或 `error!`。

---

## 二、Rust Tauri Bridge 端

### 2.1 依赖（改 `src-tauri/Cargo.toml`）

```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
tracing-appender = "0.2"
```

### 2.2 新建 `src-tauri/src/logging.rs`

与 engine 端同结构，日志文件前缀 `bridge`。在 Tauri `main()` 中调用初始化。

### 2.3 命令日志化（改 `src-tauri/src/main.rs`）

封装辅助函数一次写好，避免在 20+ 个 `hologram_*` 命令中重复：

```rust
async fn log_bridge_call(
    tool: &str,
    f: impl std::future::Future<Output = Result<String, String>>
) -> Result<String, String> {
    let start = std::time::Instant::now();
    info!(tool, "bridge call start");
    let result = f.await;
    let elapsed = start.elapsed();
    match &result {
        Ok(_) => info!(tool, elapsed_ms = elapsed.as_millis(), "bridge call ok"),
        Err(e) => warn!(tool, elapsed_ms = elapsed.as_millis(), error = %e, "bridge call failed"),
    }
    result
}
```

### 2.4 新增 `log_append` Tauri 命令（供 TS 端写日志）

```rust
#[tauri::command]
fn log_append(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open(&path).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())
}
```

---

## 三、TypeScript UI 端

### 3.1 设计原则

- **零外部依赖** — 不引入 winston/pino
- Tauri 环境通过 `invoke('log_append', ...)` 写文件
- Mock/dev 降级 `console`
- 结构化 JSON 行（NDJSON），与 Rust 端统一

### 3.2 新建 `src-ui/src/agent/logger.ts`

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  message: string;
  ctx?: Record<string, unknown>;
}

let logPath: string | null = null;
let logBuffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
const MAX_BUFFER = 50;
const FLUSH_MS = 2000;

export async function initLogger(projectPath: string): Promise<void> {
  try { logPath = `${projectPath}/.hologram/logs/ui.log`; } catch { logPath = null; }
  flushTimer = setInterval(flush, FLUSH_MS);
}

function buildEntry(level: LogLevel, module: string, message: string, ctx?: Record<string, unknown>): LogEntry {
  return { ts: new Date().toISOString(), level, module, message, ctx };
}

async function appendToFile(path: string, content: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('log_append', { path, content });
}

function write(entry: LogEntry): void {
  logBuffer.push(JSON.stringify(entry));
  if (logBuffer.length >= MAX_BUFFER) flush();
}

async function flush(): Promise<void> {
  if (logBuffer.length === 0 || !logPath) return;
  const batch = logBuffer.splice(0).join('\n') + '\n';
  logBuffer = [];
  try { await appendToFile(logPath, batch); } catch {}
}

export const log = {
  debug(m: string, msg: string, ctx?: Record<string, unknown>) { write(buildEntry('debug', m, msg, ctx)); },
  info(m: string, msg: string, ctx?: Record<string, unknown>)  { write(buildEntry('info', m, msg, ctx)); },
  warn(m: string, msg: string, ctx?: Record<string, unknown>) {
    write(buildEntry('warn', m, msg, ctx));
    console.warn(`[${m}] ${msg}`, ctx ?? '');
  },
  error(m: string, msg: string, ctx?: Record<string, unknown>) {
    write(buildEntry('error', m, msg, ctx));
    console.error(`[${m}] ${msg}`, ctx ?? '');
  },
};

export function shutdownLogger(): void {
  if (flushTimer) clearInterval(flushTimer);
  flush();
}
```

### 3.3 打点清单

#### agent.ts

| 位置 | 级别 | ctx |
|------|------|-----|
| `stream()` 入口 | info | `{turn, model}` |
| LLM 响应返回 | info | `{turn, finish_reason, token_usage, elapsed_ms}` |
| `executeBatch` 开始 | info | `{tool_names, count}` |
| 单个工具失败 | warn | `{tool, error}` |
| `stream()` 异常 | error | `{error}` |

#### tool.ts

| 位置 | 级别 | ctx |
|------|------|-----|
| `execute()` | debug | `{name, elapsed_ms}` |

#### bridge.ts

| 位置 | 级别 | ctx |
|------|------|-----|
| `invoke()` | debug | `{command}` |
| invoke 失败 | error | `{command, error}` |

#### main.ts

| 位置 | 级别 | ctx |
|------|------|-----|
| 启动 | info | `{version, nodes, edges}` |
| `analysis-failed` | error | `{error}` |

---

## 四、日志参数

| 参数 | 值 |
|------|------|
| 目录 | `.hologram/logs/` |
| 单文件上限 | 10 MB |
| 保留数 | 5 个滚动文件 |
| 格式 | NDJSON（每行一条 JSON） |

Rust 端 `tracing-appender` 自动轮转。TS 端在 flush 时检查大小，超 10MB 手动 rename。

---

## 五、示例输出

### engine.log
```json
{"timestamp":"2026-06-16T18:00:01.123Z","level":"INFO","target":"hologram_engine","message":"engine started","pid":12345}
{"timestamp":"2026-06-16T18:00:02.456Z","level":"INFO","target":"hologram_engine::main","message":"analysis started"}
{"timestamp":"2026-06-16T18:00:04.789Z","level":"INFO","target":"hologram_engine::mcp","message":"mcp request","method":"tools/call","id":"req-001"}
{"timestamp":"2026-06-16T18:00:04.901Z","level":"INFO","target":"hologram_engine::mcp","message":"mcp response","method":"tools/call","id":"req-001","elapsed_ms":89}
```

### ui.log
```json
{"ts":"2026-06-16T18:00:04.500Z","level":"info","module":"agent","message":"agent turn","ctx":{"turn":1}}
{"ts":"2026-06-16T18:00:04.800Z","level":"debug","module":"bridge","message":"invoke","ctx":{"command":"hologram_neighbors"}}
{"ts":"2026-06-16T18:00:04.900Z","level":"info","module":"agent","message":"tool done","ctx":{"tool":"hologram_neighbors","elapsed_ms":85}}
```

---

## 六、实施步骤

### Phase 1 — Rust Engine
1. 改 `engine/Cargo.toml` — 加 3 个依赖
2. 新建 `engine/src/logging.rs`
3. 改 `engine/src/main.rs` — mod 声明 + init 调用 + 全部 println/eprintln 替换
4. 改 `engine/src/mcp.rs` — MCP 请求/响应日志 + 错误日志
5. `cargo build -p hologram-engine` 验证

### Phase 2 — Rust Tauri Bridge
1. 改 `src-tauri/Cargo.toml` — 加依赖
2. 新建 `src-tauri/src/logging.rs`
3. 改 `src-tauri/src/main.rs` — 命令日志 + 新增 `log_append`
4. `cargo build` 验证

### Phase 3 — TypeScript UI
1. 新建 `src-ui/src/agent/logger.ts`
2. 改 `main.ts` — initLogger
3. 改 `agent.ts / tool.ts / bridge.ts` — 关键点打点
4. 前端编译验证

### Phase 4 — 验证
1. 启动 → 执行几次查询 → 检查 `.hologram/logs/` 下三个文件
2. 触发错误 → 确认 error 级出现在日志中

---

## 七、文件清单

| 操作 | 路径 |
|------|------|
| **新建** | `engine/src/logging.rs` |
| 修改 | `engine/Cargo.toml` |
| 修改 | `engine/src/main.rs` |
| 修改 | `engine/src/mcp.rs` |
| **新建** | `src-tauri/src/logging.rs` |
| 修改 | `src-tauri/Cargo.toml` |
| 修改 | `src-tauri/src/main.rs` |
| **新建** | `src-ui/src/agent/logger.ts` |
| 修改 | `src-ui/src/agent/agent.ts` |
| 修改 | `src-ui/src/agent/tool.ts` |
| 修改 | `src-ui/src/main.ts` |
| 修改 | `.gitignore`（追加 `.hologram/logs/`） |

---

## 八、注意事项

1. **不记敏感数据** — 完整请求体只打 `debug`，生产默认 `info` 不输出
2. **日志不影响主流程** — Rust 非阻塞模式；TS buffer+try/catch
3. **三层独立** — engine / bridge / ui 各自写文件，故障隔离
4. **与 audit.jsonl 互补** — audit 记文件读写，log 记运行操作
5. **`RUST_LOG=debug` 动态调级** — 出问题时临时开 debug 查细节
