# HoloGram 卡点修复方案

## 根因

`analyze_lock` 是全局串行锁，后台 watcher 和用户分析抢同一把锁；切换文件夹时 `deactivate()` 在持有 state 锁期间 `join()` watcher 线程，watcher 若正跑全量分析就卡死整个后端命令队列。

## 卡点链（按场景）

### 场景 A：点"重分析"卡住

`btnReanalyze` → `invoke('analyze_and_load', {force:true})` (`src-ui/src/main.ts:634`)
→ `run_analyze_with_progress` (`src-tauri/src/main.rs:540`) → `spawn_blocking(direct_analyze)` → `engine.analyze()` 拿 `analyze_lock` (`engine/src/engine.rs:330-335`)

卡住条件——此刻锁被以下之一持有：
1. **Watcher 线程**：`src-tauri/src/workspace.rs:103` 的 watcher 每秒扫盘，文件一变就调 `run_engine_analysis`→`direct_analyze`→`engine.analyze()` 抢锁 (`workspace.rs:134,259`)
2. **后台 runCheck 的 analyze fallback**：`hologram_run_check` 在图空时调 `direct_analyze` (`main.rs:827,832`)，冷启动后 fire-and-forget 触发 (`main.ts:185` 无 await)

**`force` 参数被无视** (`main.rs:2088` `let _ = force;`)，重分析没有任何优先权，只能排队等锁。

### 场景 B：点"打开文件夹"切换卡住（更严重）

`switchWorkspace` (`main.ts:140`) 第一步 `await workspace.deactivate(chatPanel)` (`main.ts:154`)
→ 前端 `invoke('workspace_deactivate')` → 后端 `handle.deactivate()` (`main.rs:295`)
→ `watcher_running.store(false)` + **`handle.join()`** (`workspace.rs:74-79`)

两个致命点：
1. **`handle.join()` 等 watcher 跑完当前分析**：若 watcher 正在 `direct_analyze` 持 `analyze_lock` 跑全量分析（几秒~几十秒），`join()` 一直阻塞，`workspace_deactivate` 命令卡住，前端 `await` 卡住，UI 无响应。
2. **持 state 锁期间阻塞**：`workspace_deactivate` 在 `*state.lock()` 期间调 `handle.deactivate()`（含阻塞 join）(`main.rs:294-297`)。这把 `WorkspaceState` Mutex 捏死，`workspace_activate`/`workspace_start_watcher`/`get_full_graph` 等所有要 state 的命令全部排队阻塞。

**按钮没禁用 → 雪崩**：`setLoading(true)` 在 deactivate **之后**才执行 (`main.ts:160`)。deactivate 卡住时 `btnOpen` 仍可点，用户重复点击 → 多个 `switchWorkspace` 并发 → 争全局 `workspace` 变量、重复 deactivate、listener 泄漏。

### 放大因素

3. **Watcher 无 ignore**：`collect_file_mtimes` (`workspace.rs:229`) 用 walkdir 递归扫整个 root，不排除 `.git`/`node_modules`/`target`/`build`/`.venv`/`engine-bin`/`release-bin`。每秒一次全量扫描，且 `build/` 里的 `.js`/`.mjs` 在扩展名白名单里 (`workspace.rs:231-233`)，前端构建产物变化会误触发全量分析，频繁抢占 `analyze_lock`。

4. **`workspace_start_watcher` 同样持锁 join**：`start_watcher` 开新 watcher 前 join 旧 watcher (`workspace.rs:93-95`)，也在 state 锁内阻塞。

## 证据位置

| 问题 | 位置 |
|------|------|
| analyze_lock 串行所有分析 | `engine/src/engine.rs:152,330-335` |
| watcher 调 direct_analyze 抢锁 | `src-tauri/src/workspace.rs:134,259` |
| deactivate join 阻塞 watcher | `src-tauri/src/workspace.rs:74-79` |
| deactivate 持 state 锁阻塞 | `src-tauri/src/main.rs:294-297` |
| force 参数被忽略 | `src-tauri/src/main.rs:2088` |
| runCheck analyze fallback | `src-tauri/src/main.rs:820-836` |
| runCheck fire-and-forget | `src-ui/src/main.ts:185` |
| setLoading 在 deactivate 之后 | `src-ui/src/main.ts:154-160` |
| watcher 无目录 ignore | `src-tauri/src/workspace.rs:229-254` |
| 冷启动注释已警示 analyze 竞争 | `src-ui/src/main.ts:784-786` |

---

## 修复方案（5 个改动）

### 修复 1 — watcher 停止时不 join，detach 让它自退

**文件**：`src-tauri/src/workspace.rs`

改 `deactivate()`（约 72-85 行）：

```rust
// 改前
    pub fn deactivate(&mut self) {
        // Signal the watcher thread to stop
        self.watcher_running.store(false, Ordering::SeqCst);

        // Join the watcher thread — guaranteed exit within 1 poll interval (1s)
        if let Some(handle) = self.watcher_thread.take() {
            let _ = handle.join();
        }

        // Clear changed files
        if let Ok(mut files) = self.changed_files.lock() {
            files.clear();
        }
    }
```

```rust
// 改后
    pub fn deactivate(&mut self) {
        // Signal the watcher thread to stop.
        self.watcher_running.store(false, Ordering::SeqCst);

        // Detach the watcher thread — do NOT join. The watcher checks the
        // running flag each poll interval and exits on its own. Joining here
        // blocks the caller while a mid-flight analysis finishes, and since
        // deactivate() runs under the state mutex (workspace_deactivate),
        // it blocks every other state-dependent command.
        // ponytail: 上限 — 旧 watcher 最迟 1s 后退出；若它正持有 analyze_lock，
        // 用户的新分析会在 engine.analyze() 排队等锁释放，不会丢数据。
        self.watcher_thread.take();

        // Clear changed files
        if let Ok(mut files) = self.changed_files.lock() {
            files.clear();
        }
    }
```

改 `start_watcher()` 开头（约 90-95 行）：

```rust
// 改前
    pub fn start_watcher(&mut self, app_handle: AppHandle) {
        // Ensure any previous watcher is fully stopped
        self.watcher_running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.watcher_thread.take() {
            let _ = handle.join();
        }

        let path = self.path.clone();
```

```rust
// 改后
    pub fn start_watcher(&mut self, app_handle: AppHandle) {
        // Signal any previous watcher to stop, then detach (don't join —
        // same reason as deactivate(): avoid blocking under the state mutex).
        self.watcher_running.store(false, Ordering::SeqCst);
        self.watcher_thread.take();

        let path = self.path.clone();
```

---

### 修复 2 — `workspace_deactivate` 不在 state 锁内做阻塞

**文件**：`src-tauri/src/main.rs`（约 290-299 行）

```rust
// 改前
async fn workspace_deactivate(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    if let Some(ref mut handle) = *state.lock().unwrap() {
        handle.deactivate();
    }
    *state.lock().unwrap() = None;
    Ok(())
}
```

```rust
// 改后
async fn workspace_deactivate(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    // Take the handle out while briefly holding the lock, then RELEASE the
    // lock before deactivating. deactivate() stops the watcher; doing that
    // under the state mutex blocks every other command that needs state
    // (workspace_activate, get_full_graph, …) for the whole stop duration.
    let handle = {
        let mut guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
        guard.take() // take() 同时把 state 内的 Option 置 None
    };
    if let Some(mut h) = handle {
        h.deactivate();
    }
    Ok(())
}
```

---

### 修复 3 — watcher 扫盘排除生成/依赖目录

**文件**：`src-tauri/src/workspace.rs` 的 `collect_file_mtimes`（约 229-238 行，只改 walkdir 构造那段）

```rust
// 改前
fn collect_file_mtimes(root: &str) -> std::collections::HashMap<String, u64> {
    let mut map = std::collections::HashMap::new();
    let exts = [".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs",
                 ".go", ".rs", ".java", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh",
                 ".rb", ".cs", ".kt", ".kts", ".swift", ".php", ".lua"];
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
```

```rust
// 改后
fn collect_file_mtimes(root: &str) -> std::collections::HashMap<String, u64> {
    let mut map = std::collections::HashMap::new();
    let exts = [".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs",
                 ".go", ".rs", ".java", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh",
                 ".rb", ".cs", ".kt", ".kts", ".swift", ".php", ".lua"];
    // Skip generated/dependency dirs — changes here (e.g. vite build output
    // in build/*.mjs) would otherwise trigger a full re-analyze and steal
    // analyze_lock from user-triggered analyses.
    const IGNORE_DIRS: &[&str] = &[
        ".git", "node_modules", "target", "build", "dist", "out",
        ".venv", "venv", ".hologram", "engine-bin", "release-bin",
        "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
        ".next", ".nuxt", ".svelte-kit", ".turbo",
        ".cursor", ".idea", ".vscode", ".coverage",
    ];
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                !IGNORE_DIRS.iter().any(|d| name.as_ref() == *d)
            } else {
                true
            }
        })
        .filter_map(|e| e.ok())
    {
```

---

### 修复 4 — watcher 让路用户分析 + 变化 debounce

**文件**：`src-tauri/src/workspace.rs`

先在文件顶部 import 区（第 23 行 `use tauri::{AppHandle, Emitter};` 附近）加一行：

```rust
use hologram_engine::engine as engine_api;
```

然后整段替换 watcher 线程闭包（约 103-169 行，从 `let handle = thread::spawn(move || {` 到对应的 `});`）：

```rust
// 改前
        let handle = thread::spawn(move || {
            let mut last_mtimes = collect_file_mtimes(&path);
            let poll_interval = Duration::from_secs(1);
            let mut consecutive_failures: u32 = 0;

            while running.load(Ordering::SeqCst) {
                thread::sleep(poll_interval);

                if !running.load(Ordering::SeqCst) {
                    break;
                }

                let current_mtimes = collect_file_mtimes(&path);

                // Collect changed file paths (new, modified, or deleted)
                let mut changed: Vec<String> = Vec::new();
                for (fp, mt) in &current_mtimes {
                    match last_mtimes.get(fp) {
                        Some(old) if old != mt => changed.push(fp.clone()),
                        None => changed.push(fp.clone()), // new file
                        _ => {}
                    }
                }
                // Deleted files
                for fp in last_mtimes.keys() {
                    if !current_mtimes.contains_key(fp) {
                        changed.push(fp.clone());
                    }
                }

                if !changed.is_empty() {
                    if let Some(_json) = run_engine_analysis(&path, &changed) {
                        last_mtimes = current_mtimes;
                        consecutive_failures = 0;

                        // Update changed_files for check/gate commands
                        if let Ok(mut last) = changed_files.lock() {
                            *last = changed.clone();
                        }

                        // Emit graph-updated event to frontend
                        // The frontend will call get_full_graph to retrieve the updated data
                        let summary = serde_json::json!({
                            "total_nodes": 0,  // frontend ignores this, re-fetches via get_full_graph
                            "node_count": 0,
                            "meta": { "source_root": &path }
                        });
                        if let Err(e) = app_handle.emit("graph-updated", summary.to_string()) {
                            eprintln!("[hologram] emit graph-updated failed: {e}");
                        }
                    } else {
                        consecutive_failures += 1;
                        // After 3 consecutive failures, update mtimes anyway to break retry loop
                        if consecutive_failures >= 3 {
                            last_mtimes = current_mtimes;
                            let msg = format!(
                                r#"{{"error":"分析失败 (已重试{}次)，实时更新已暂停。保存文件后将重新尝试。"}}"#,
                                consecutive_failures
                            );
                            if let Err(e) = app_handle.emit("graph-updated", msg) {
                                eprintln!("[hologram] emit graph-updated error failed: {e}");
                            }
                        }
                    }
                }
            }
        });
```

```rust
// 改后
        let handle = thread::spawn(move || {
            let mut last_mtimes = collect_file_mtimes(&path);
            let poll_interval = Duration::from_secs(1);
            // Debounce: wait for a quiet window after the last change before
            // analyzing. Coalesces save-storms into one analysis pass.
            let debounce = Duration::from_secs(2);
            let mut consecutive_failures: u32 = 0;
            let mut pending_changed: Vec<String> = Vec::new();
            let mut last_change_at: Option<std::time::Instant> = None;

            while running.load(Ordering::SeqCst) {
                thread::sleep(poll_interval);

                if !running.load(Ordering::SeqCst) {
                    break;
                }

                let current_mtimes = collect_file_mtimes(&path);

                // Collect changed file paths (new, modified, or deleted)
                let mut changed: Vec<String> = Vec::new();
                for (fp, mt) in &current_mtimes {
                    match last_mtimes.get(fp) {
                        Some(old) if old != mt => changed.push(fp.clone()),
                        None => changed.push(fp.clone()), // new file
                        _ => {}
                    }
                }
                // Deleted files
                for fp in last_mtimes.keys() {
                    if !current_mtimes.contains_key(fp) {
                        changed.push(fp.clone());
                    }
                }

                if !changed.is_empty() {
                    // Accumulate and (re)start the debounce window.
                    for fp in &changed {
                        if !pending_changed.contains(fp) {
                            pending_changed.push(fp.clone());
                        }
                    }
                    last_change_at = Some(std::time::Instant::now());
                    // Don't update last_mtimes yet — wait until we actually
                    // analyze, otherwise a debounce reset would lose pending
                    // changes.
                }

                // Only analyze when changes have settled (no new change for
                // `debounce`).
                let settled = last_change_at
                    .map(|t| t.elapsed() >= debounce)
                    .unwrap_or(false);
                if !settled || pending_changed.is_empty() {
                    continue;
                }

                // Yield to an in-flight user-triggered analysis (open folder
                // / reanalyze). The user took the lock first; retry next tick
                // after it frees. This is what stops the "卡点" — watcher no
                // longer blocks user analyzes.
                if engine_api::engine_state().is_analyzing() {
                    continue;
                }

                let changed = std::mem::take(&mut pending_changed);
                last_change_at = None;

                if let Some(_json) = run_engine_analysis(&path, &changed) {
                    last_mtimes = current_mtimes;
                    consecutive_failures = 0;

                    // Update changed_files for check/gate commands
                    if let Ok(mut last) = changed_files.lock() {
                        *last = changed.clone();
                    }

                    // Emit graph-updated event to frontend
                    let summary = serde_json::json!({
                        "total_nodes": 0,
                        "node_count": 0,
                        "meta": { "source_root": &path }
                    });
                    if let Err(e) = app_handle.emit("graph-updated", summary.to_string()) {
                        eprintln!("[hologram] emit graph-updated failed: {e}");
                    }
                } else {
                    consecutive_failures += 1;
                    if consecutive_failures >= 3 {
                        // Give up on this batch — update mtimes to break the loop.
                        last_mtimes = current_mtimes;
                        let msg = format!(
                            r#"{{"error":"分析失败 (已重试{}次)，实时更新已暂停。保存文件后将重新尝试。"}}"#,
                            consecutive_failures
                        );
                        if let Err(e) = app_handle.emit("graph-updated", msg) {
                            eprintln!("[hologram] emit graph-updated error failed: {e}");
                        }
                    } else {
                        // Re-queue for retry next tick.
                        pending_changed = changed;
                        last_change_at = Some(std::time::Instant::now());
                    }
                }
            }
        });
```

---

### 修复 5 — 前端切换并发 guard + 提前禁用按钮

**文件**：`src-ui/src/main.ts`

先在 State 区（约 113-115 行）加 guard 变量：

```ts
// 改前
// ── State ──
let workspace: Workspace | null = null;
let starGraph: StarGraph = new StarGraph(graphEl);
let agentViz: AgentVisualizer | null = null;
```

```ts
// 改后
// ── State ──
let workspace: Workspace | null = null;
let starGraph: StarGraph = new StarGraph(graphEl);
let agentViz: AgentVisualizer | null = null;
// Reentry guard for switchWorkspace — prevents stacked concurrent switches
// when deactivate() stalls on watcher teardown.
let _switching = false;
```

再整段替换 `switchWorkspace` 函数（约 140-187 行）：

```ts
// 改前
async function switchWorkspace(
  path?: string,
  opts?: { skipAnalysis?: boolean; cachedGraph?: any },
): Promise<void> {
  const folder = path || (await pickFolder());
  if (!folder) return;

  if (workspace?.active && isSamePath(workspace.path, folder)) {
    statusText.textContent = '已在当前工作区';
    return;
  }

  // Deactivate old
  if (workspace) {
    await workspace.deactivate(chatPanel);
    workspace = null;
  }

  resetCheckPanelState();
  if (_gitStatusTimer) { clearInterval(_gitStatusTimer); _gitStatusTimer = null; }
  setLoading(true, folder);

  // Create new
  const ws = await Workspace.open(folder, starGraph, chatPanel, checkPanel, opts);
  ws.onStatusChange = (msg) => { statusText.textContent = msg; };
  ws.onLoadingChange = (loading) => { setLoading(loading, loading ? folder : undefined); };

  workspace = ws;
  notifyAllPanels(ws);

  const nodeCount = Array.isArray(ws.graphData.nodes) ? ws.graphData.nodes.length : Object.keys(ws.graphData.nodes || {}).length;
  const genTime = ws.graphData.meta?.generated_at ? new Date(ws.graphData.meta.generated_at).toLocaleTimeString() : '';
  statusText.textContent = `✨ ${nodeCount} 节点已就绪${genTime ? ` · ${genTime}` : ''}`;
  log.info('main', 'project loaded', {
    nodes: nodeCount,
    edges: Array.isArray(ws.graphData.edges) ? ws.graphData.edges.length : Object.keys(ws.graphData.edges || {}).length,
  });
  setLoading(false);
  startGitIndicator();

  try { await ws.setupAgent(chatPanel, checkPanel); } catch (e) { console.error('[switchWorkspace] setupAgent failed:', e); }

  chatPanel.setProjectPath(folder);
  chatPanel.autoRestoreLastSession(folder).catch(() => {});
  if (FileTreePanel.get().isOpen()) FileTreePanel.get().load(folder);
  ws.runCheck(checkPanel);
  await invoke('workspace_start_watcher').catch(() => {});
}
```

```ts
// 改后
async function switchWorkspace(
  path?: string,
  opts?: { skipAnalysis?: boolean; cachedGraph?: any },
): Promise<void> {
  if (_switching) { statusText.textContent = '正在切换工作区，请稍候…'; return; }
  _switching = true;
  try {
    const folder = path || (await pickFolder());
    if (!folder) return;

    if (workspace?.active && isSamePath(workspace.path, folder)) {
      statusText.textContent = '已在当前工作区';
      return;
    }

    // Disable the open button BEFORE the possibly-slow deactivate() await.
    // Otherwise the button stays clickable while the watcher is being torn
    // down and repeated clicks stack concurrent switches.
    setLoading(true, folder);

    // Deactivate old
    if (workspace) {
      await workspace.deactivate(chatPanel);
      workspace = null;
    }

    resetCheckPanelState();
    if (_gitStatusTimer) { clearInterval(_gitStatusTimer); _gitStatusTimer = null; }

    // Create new
    const ws = await Workspace.open(folder, starGraph, chatPanel, checkPanel, opts);
    ws.onStatusChange = (msg) => { statusText.textContent = msg; };
    ws.onLoadingChange = (loading) => { setLoading(loading, loading ? folder : undefined); };

    workspace = ws;
    notifyAllPanels(ws);

    const nodeCount = Array.isArray(ws.graphData.nodes) ? ws.graphData.nodes.length : Object.keys(ws.graphData.nodes || {}).length;
    const genTime = ws.graphData.meta?.generated_at ? new Date(ws.graphData.meta.generated_at).toLocaleTimeString() : '';
    statusText.textContent = `✨ ${nodeCount} 节点已就绪${genTime ? ` · ${genTime}` : ''}`;
    log.info('main', 'project loaded', {
      nodes: nodeCount,
      edges: Array.isArray(ws.graphData.edges) ? ws.graphData.edges.length : Object.keys(ws.graphData.edges || {}).length,
    });
    setLoading(false);
    startGitIndicator();

    try { await ws.setupAgent(chatPanel, checkPanel); } catch (e) { console.error('[switchWorkspace] setupAgent failed:', e); }

    chatPanel.setProjectPath(folder);
    chatPanel.autoRestoreLastSession(folder).catch(() => {});
    if (FileTreePanel.get().isOpen()) FileTreePanel.get().load(folder);
    ws.runCheck(checkPanel);
    await invoke('workspace_start_watcher').catch(() => {});
  } finally {
    _switching = false;
  }
}
```

---

## 改动文件清单

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src-tauri/src/workspace.rs` | `deactivate`/`start_watcher` detach 不 join |
| 2 | `src-tauri/src/main.rs` | `workspace_deactivate` 释放锁再 deactivate |
| 3 | `src-tauri/src/workspace.rs` | `collect_file_mtimes` 排除生成目录 |
| 4 | `src-tauri/src/workspace.rs` | watcher 加 import + debounce + 让路 |
| 5 | `src-ui/src/main.ts` | `_switching` guard + 提前 `setLoading` |

## 验证

```powershell
# 后端编译
cargo check --manifest-path src-tauri/Cargo.toml
# 前端类型检查
npm --prefix src-ui run build
```

两个都过即可。完整跑应用：`npm --prefix src-ui run dev`（或现有的 tauri dev 命令）。

## 手测场景（按这个顺序点）

1. 开应用 → 打开项目 A → 等星图出来
2. 改一个源文件保存 → **2 秒后** watcher 触发更新（不是立即）
3. 点"重分析" → 立即响应，不再卡（watcher 让路）
4. 分析进行中点"打开文件夹"选项目 B → 按钮立即变灰，切换不卡；A 的 watcher 自动退出
5. 快速连点"打开文件夹"多次 → 只触发一次切换（guard 拦住重入）
6. 在 B 里跑 `npm run build`（build/ 目录变化）→ 不再误触发分析

## 注意事项

- 修复 1 让旧 watcher 线程"自生自灭"——它最迟 1 秒后看到 `running=false` 退出。若它当时正持 `analyze_lock` 跑分析，用户的新分析会在 `engine.analyze()` 排队等锁释放，不会丢数据，只会等几秒。这是可接受的：比整个后端卡死强。
- 修复 4 的 `is_analyzing()` 让路是软让步——watcher 每 1 秒重试一次，用户分析一释放它就接上。不会漏掉文件变化（`pending_changed` 一直保留）。
- 没有动 `engine.rs` 的 `analyze_lock` 本身——它是正确的（分析必须串行）。问题在调用方争抢方式，不在锁。
- `force` 参数（`main.rs:2088`）没改：让路机制已让用户重分析能拿到锁，`force` 现在没实际意义也无害。
