# Handoff — HoloGram（2026-06-27 session 3）

## 当前状态

- **引擎**：27 门静态语言 + GrammarLoader 动态加载架构；338 测试 passed
- **前端**：无变更
- **构建**：`cargo tauri build` 通过，MSI + NSIS 产物正常
- **源码**：已恢复公开推送，移除 v4.1 隐藏规则

---

## 本次变更（2026-06-27 session 3）

### 核心：GrammarLoader 动态语法加载

**问题**：27 门语言静态链接进 exe，每加一门要改代码+Cargo.toml+重编译。kotlin/toml/markdown 因 tree-sitter 版本冲突无法静态链接。

**方案**：核心语言保持 Cargo 静态链接（零回归），其余从 `.dll` 运行时加载。

**API 链**：
```
libloading::Library::new("tree-sitter-php.dll")
  → lib.get(b"tree_sitter_php") → Symbol<fn() -> *const ()>
  → LanguageFn::from_raw(ptr) → Language::new(fn) → parser.set_language()
```

**新文件**：

| 文件 | 说明 |
|------|------|
| `engine/src/adapter/grammar_loader.rs` | GrammarLoader 进程级单例。LazyLock<RwLock<HashMap>>，并发读/串行写。register_static() 注入 27 门静态语言，get(ext) 懒加载 DLL，scan_dir() 按命名约定自动发现 |
| `grammars/build.ps1` | 编译脚本：git clone → gcc/g++ → .dll |
| `grammars/grammars.txt` | 待编译清单 |
| `grammars/tree-sitter-kotlin.dll` | 4.2 MB |
| `grammars/tree-sitter-markdown.dll` | 515 KB（需 `-DTREE_SITTER_MARKDOWN_AVOID_CRASH`） |
| `grammars/tree-sitter-toml.dll` | 119 KB |

**替换的硬编码引用（14 处）**：

| 文件 | 变更 |
|------|------|
| `engine/src/adapter/tree_sitter.rs` | 30 行 match → `GRAMMAR_LOADER.get(ext)`，删 do_parse!/do_parse_k! 宏 |
| `engine/src/engine.rs` | language_for_lsp() 10行 match → 1行；+GRAMMAR_LOADER LazyLock 初始化（27 门 register_static） |
| `engine/src/analysis/framework_routes.rs` | 7 处 `tree_sitter_xxx::LANGUAGE.into()` → GRAMMAR_LOADER.get() |
| `engine/src/analysis/dataflow_synthesis.rs` | 2 处 |
| `engine/src/analysis/dynamic_dispatch.rs` | 2 处 |
| `engine/src/adapter/python_lsp.rs` | 1 处 |
| `engine/src/adapter/go_lsp.rs` | 1 处 |
| `engine/src/pipeline/runner.rs` | 硬编码扩展名列表 → `GRAMMAR_LOADER.supported_extensions()` |

**不改的文件**：`PythonAdapter`/`TypeScriptAdapter`（核心语言保持专用适配器）、`generic_walk()`、所有 LSP adapter（它们只消费 `tree_sitter::Node`）

### 其他清理

| 操作 | 说明 |
|------|------|
| 源码恢复公开 | 移除 `.gitignore` v4.1 隐藏规则，engine/src + layout 源码重新追踪 |
| dead code 清理 | cargo fix 自动修 7 warnings；删 is_graph_fresh/find_node_file/start_engine；WIP 函数加 #[allow(dead_code)] |
| hologram_explore/status | 补注册到 generate_handler!（之前只定义了 #[tauri::command] 但没接线） |
| engine-bin 移除 | 引擎从 engine/ 源码编译，engine_binary() 搜索路径无此目录 |
| README 更新 | 测试数 287→315，语言 18→27，"从源码构建"改用 cargo build，"一句话安装"回归 Releases |
| tauri.conf.json | beforeBuildCommand 路径修复（相对→绝对）；grammars/*.dll 加入 bundle resources |
| workspace.rs | 移除 engine-bin 排除规则 |

### 依赖变更

- `engine/Cargo.toml`：+`libloading = "0.8"`, +`tree-sitter-language = "0.1"`；-`tree-sitter-kotlin`, -`tree-sitter-toml`, -`tree-sitter-markdown`（转为 DLL）

---

## 测试

- **338 passed, 18 failed**（18 个全预存 MCP 测试，与本次无关）
- +8 新增 GrammarLoader 单元测试全绿：register_static、multi_ext、supported_extensions、resolve_extensions、find_grammar_dir_env、scan_dir_empty、scan_dir_with_dlls
- `cargo tauri build` release 编译零错误零警告

---

## 架构（更新）

```
引擎启动 → LazyLock<GrammarLoader>
  ├── register_static() ← 27 门 Cargo 依赖静态注入
  └── scan_dir()       ← 扫 grammars/ 目录，按 tree-sitter-{name}.dll 约定映射
         ↓
  get("php") → RwLock 读检查 → miss → Library::new() → 写锁插入
         ↓
  parse_with_lang(lang, "php", source, file_id)  ← 现有逻辑不变
```

---

## 下一步

1. **动态加载验证**：引擎目录下放 `grammars/tree-sitter-kotlin.dll`，分析含 `.kt` 文件的项目，验证 kotlin 文件被解析
2. **Cargo feature 开关**（后续）：`static-grammars` feature，关掉后所有 grammar 纯动态加载，exe 瘦身
3. **批量编译**：`grammars/build.ps1 -All` 批量产出更多 DLL，随 Releases 分发
4. **Leiden refinement 调优**：`louvain.rs` refinement 代码保留未启用
5. **LSP 优化**：LSP 阶段 ~140s 还有空间
