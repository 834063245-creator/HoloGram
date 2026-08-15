// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! P0-1：确定性 import 路径解析（ImportResolver）。
//!
//! 在 CrossFileResolver（名字猜测）**之前**运行：把 imports 边的 target 从
//! 原始 specifier 改写为「按语言规则确定性解析出的文件 module id」，或改写为
//! 外部依赖节点 id（`ext:<name>`）。
//!
//! 语言规则：
//! - TS/JS：相对路径 → 扩展名/目录探测；tsconfig `paths`/`baseUrl` 别名；
//!   bare specifier → 向上探测 node_modules（package.json main/module）；
//!   找不到 → External 节点。
//! - Python：`.`/`..` 相对导入（包层级）+ 点分模块路径 → `<root>/<a/b>.py`
//!   或 `<root>/<a/b>/__init__.py`；找不到 → External。
//! - Rust：`use crate::…` → src 下 `路径.rs` / `路径/mod.rs`（剥末段回退）；
//!   `use super::…` → 相对当前文件；`std`/`alloc`/`core` 与其他 crate → External。
//! - Go：`./…`/`../…` 相对；模块路径 → `<root>/<path>` 或 `vendor/<path>`；
//!   否则 External。
//!
//! 解析结果写入边 metadata（`resolved_by` / `external` / `unresolved_import`），
//! 供 P0-3 的解析率报告与不静默丢弃使用。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::graph::{EdgeKind, Graph, Node, NodeKind};

/// import 边 metadata 里的原始 specifier 键名（与 query_adapter 的约定）。
pub const META_IMPORT_RAW: &str = "import_raw";

#[derive(Debug, Default, Clone)]
pub struct ImportResolveStats {
    pub total: usize,
    pub resolved: usize,
    pub external: usize,
    pub unresolved: usize,
    /// 无原始 specifier（旧边或非 import 边），跳过。
    pub skipped: usize,
}

impl ImportResolveStats {
    pub fn summary(&self) -> String {
        format!(
            "import-path resolved={} external={} unresolved={} (total={}, skipped={})",
            self.resolved, self.external, self.unresolved, self.total, self.skipped
        )
    }
}

// ── 路径 → module id 的转换（与 query_adapter 的 module_id 构造一致）──

fn module_id_of(path: &Path) -> String {
    crate::path_utils::normalize_path(&path.to_string_lossy()).replace(['/', '\\'], ".")
}

// ── TS tsconfig paths/baseUrl 解析（最小实现）──

#[derive(Debug, Default)]
struct TsConfig {
    base_url: Option<String>,
    /// pattern（含前缀，`*` 通配）→ 目标列表（`*` 通配）。
    paths: Vec<(String, String)>,
}

fn parse_tsconfig(project_root: &Path) -> TsConfig {
    let mut cfg = TsConfig::default();
    let file = project_root.join("tsconfig.json");
    let Ok(text) = std::fs::read_to_string(&file) else {
        return cfg;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return cfg;
    };
    let Some(co) = v.get("compilerOptions") else {
        return cfg;
    };
    cfg.base_url = co
        .get("baseUrl")
        .and_then(|b| b.as_str())
        .map(|s| s.to_string());
    if let Some(paths) = co.get("paths").and_then(|p| p.as_object()) {
        for (pattern, targets) in paths {
            if let Some(t) = targets.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()) {
                cfg.paths.push((pattern.to_string(), t.to_string()));
            }
        }
    }
    // 前缀排序：更长的前缀优先匹配（@/foo/* 先于 @/*）
    cfg.paths.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    cfg
}

// ── 文件探测（带缓存）──

#[derive(Default)]
struct FsCache {
    hits: HashMap<PathBuf, bool>,
}

impl FsCache {
    fn exists(&mut self, p: &Path) -> bool {
        if let Some(v) = self.hits.get(p) {
            return *v;
        }
        let v = p.exists();
        self.hits.insert(p.to_path_buf(), v);
        v
    }
}

// ── Rust 多级 mod 树（P0-1 补充）──
//
// query_adapter 已在每个 .rs File 节点的 properties.rust_modules 里写入
// `mod x;` / `mod x { … }` 声明。这里把它们组装成 crate 模块树：
//   模块路径（`a::b`） → 定义文件（`src/a/b.rs` 或 `src/a/b/mod.rs`）
//   文件路径          → 所属模块路径
// 解析 `crate::…` / `self::…` / 多层 `super::…` 时先查模块树；
// 查不到再退回文件系统路径探测。

#[derive(Debug, Default)]
struct RustModuleIndex {
    crate_base: PathBuf,
    file_module: HashMap<PathBuf, String>,
    module_file: HashMap<String, PathBuf>,
}

fn rust_mod_key(parts: &[String]) -> String {
    parts.join("::")
}

fn rust_segments(s: &str) -> Vec<String> {
    s.split("::")
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn path_components(rel: &Path) -> Vec<String> {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(os) => os.to_str().map(|s| s.to_string()),
            _ => None,
        })
        .collect()
}

/// 文件路径 → 默认 Rust 模块路径（文件系统 2018 布局）。
fn infer_rust_module_path(path: &Path, crate_base: &Path) -> String {
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if file_name == "lib.rs" || file_name == "main.rs" {
        return String::new();
    }
    let rel = path.strip_prefix(crate_base).unwrap_or(path);
    let mut parts = path_components(rel);
    if file_name == "mod.rs" {
        parts.pop(); // 去掉 "mod.rs"，目录段即模块路径
        return rust_mod_key(&parts);
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if parts.is_empty() {
        parts.push(stem.to_string());
    } else {
        parts.pop(); // 去掉文件名
        parts.push(stem.to_string());
    }
    rust_mod_key(&parts)
}

fn walk_rust_module_tree(
    idx: &mut RustModuleIndex,
    file: &Path,
    module_path: &str,
    files: &HashMap<PathBuf, Vec<serde_json::Value>>,
    visited: &mut HashSet<(PathBuf, String)>,
) {
    if !visited.insert((file.to_path_buf(), module_path.to_string())) {
        return;
    }
    idx.file_module
        .entry(file.to_path_buf())
        .or_insert_with(|| module_path.to_string());
    idx.module_file
        .entry(module_path.to_string())
        .or_insert_with(|| file.to_path_buf());

    let Some(mods) = files.get(file) else {
        return;
    };
    let parent_dir = file.parent().unwrap_or(&idx.crate_base).to_path_buf();
    for m in mods {
        let (Some(name), Some(inline)) = (
            m.get("name").and_then(|v| v.as_str()),
            m.get("inline").and_then(|v| v.as_bool()),
        ) else {
            continue;
        };
        let child_path = if module_path.is_empty() {
            name.to_string()
        } else {
            format!("{module_path}::{name}")
        };
        if inline {
            idx.module_file
                .entry(child_path)
                .or_insert_with(|| file.to_path_buf());
            continue;
        }
        // `mod x;` → 同目录 x.rs，否则 x/mod.rs。
        let cand1 = canonicalize_lenient(&parent_dir.join(format!("{name}.rs")));
        let cand2 = canonicalize_lenient(&parent_dir.join(name).join("mod.rs"));
        let child_file = if files.contains_key(&cand1) {
            Some(cand1)
        } else if files.contains_key(&cand2) {
            Some(cand2)
        } else {
            None
        };
        if let Some(child_file) = child_file {
            walk_rust_module_tree(idx, &child_file, &child_path, files, visited);
        }
    }
}

impl RustModuleIndex {
    fn from_graph(graph: &Graph, project_root: &Path, cache: &mut FsCache) -> Self {
        let mut idx = Self::default();

        // 收集本项目已发现的 Rust 文件与 mod 声明。
        let mut files: HashMap<PathBuf, Vec<serde_json::Value>> = HashMap::new();
        for (_id, node) in graph.nodes_iter() {
            if node.kind != NodeKind::File {
                continue;
            }
            let Some(p) = node.file() else { continue };
            let path = canonicalize_lenient(Path::new(p));
            if lang_of(&path) != "rs" {
                continue;
            }
            let mods = node
                .properties
                .get("rust_modules")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            files.insert(path, mods);
        }
        if files.is_empty() {
            return idx;
        }

        // crate 根目录：优先 Cargo 布局 `<root>/src`，其次项目根本身。
        idx.crate_base = project_root.to_path_buf();
        for cand in [project_root.join("src"), project_root.to_path_buf()] {
            let cand = canonicalize_lenient(&cand);
            if cache.exists(&cand.join("lib.rs")) || cache.exists(&cand.join("main.rs")) {
                idx.crate_base = cand;
                break;
            }
        }

        // 从 lib.rs（优先）和 main.rs 两个 crate 根向下走声明树。
        let mut visited: HashSet<(PathBuf, String)> = HashSet::new();
        for root_name in ["lib.rs", "main.rs"] {
            let root_path = canonicalize_lenient(&idx.crate_base.join(root_name));
            if files.contains_key(&root_path) {
                walk_rust_module_tree(&mut idx, &root_path, "", &files, &mut visited);
            }
        }

        // 未被声明树覆盖的文件按 2018 布局补齐（也作为损坏声明的兜底）。
        for (path, _) in &files {
            if idx.file_module.contains_key(path) {
                continue;
            }
            let inferred = infer_rust_module_path(path, &idx.crate_base);
            idx.file_module.insert(path.clone(), inferred.clone());
            idx.module_file.entry(inferred).or_insert_with(|| path.clone());
        }
        idx
    }

    fn module_file_for(&self, base: &[String], rest: &[String]) -> Option<PathBuf> {
        self.module_file_for_range(base, rest, 0)
    }

    /// 与 [`module_file_for`] 相同，但要求至少匹配 rest 的前 `min_rest` 段。
    /// 用于 Rust 2018 裸路径：`use std::…` 不应回退到当前文件。
    fn module_file_for_range(&self, base: &[String], rest: &[String], min_rest: usize) -> Option<PathBuf> {
        let mut parts = base.to_vec();
        let min_rest = min_rest.min(rest.len());
        for end in (min_rest..=rest.len()).rev() {
            parts.truncate(base.len());
            parts.extend_from_slice(&rest[..end]);
            if let Some(file) = self.module_file.get(&rust_mod_key(&parts)) {
                return Some(file.clone());
            }
        }
        None
    }
}

/// 归一化 use 路径头：剥掉 `{…}` / `::*` 后缀。
fn normalize_rust_use_head(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if let Some(open) = s.find('{') {
        s.truncate(open);
    }
    s = s.trim().trim_end_matches("::").to_string();
    if s.ends_with("::*") {
        s.truncate(s.len() - 3);
        s = s.trim_end_matches("::").to_string();
    } else if s == "*" {
        s.clear();
    }
    s
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RustPathAnchor {
    Crate,
    SelfModule,
    Super(usize),
    /// Rust 2018+ 的裸路径：先按当前模块/ crate 根解析，
    /// 都不是模块时才当作外部 crate。
    Bare,
}

fn split_rust_anchor(s: &str) -> (RustPathAnchor, Vec<String>) {
    let s = normalize_rust_use_head(s);
    if let Some(rest) = s.strip_prefix("crate::") {
        return (RustPathAnchor::Crate, rust_segments(rest));
    }
    if s == "crate" {
        return (RustPathAnchor::Crate, Vec::new());
    }
    if let Some(rest) = s.strip_prefix("self::") {
        return (RustPathAnchor::SelfModule, rust_segments(rest));
    }
    if s == "self" {
        return (RustPathAnchor::SelfModule, Vec::new());
    }
    let mut n = 0usize;
    let mut rest = s.as_str();
    loop {
        if let Some(r) = rest.strip_prefix("super::") {
            n += 1;
            rest = r;
        } else if rest == "super" {
            n += 1;
            rest = "";
            break;
        } else {
            break;
        }
    }
    if n > 0 {
        return (RustPathAnchor::Super(n), rust_segments(rest));
    }
    (RustPathAnchor::Bare, rust_segments(&s))
}

fn probe_with_extensions(
    cache: &mut FsCache,
    base: &Path,
    extensions: &[&str],
    with_index: bool,
) -> Option<PathBuf> {
    // specifier 自带扩展名（"./x.css" / "./bidi-data.js"）→ 直接探测原路径
    if base.extension().is_some() && cache.exists(base) {
        return Some(base.to_path_buf());
    }
    for ext in extensions {
        let mut cand = base.as_os_str().to_owned();
        cand.push(ext);
        let p = PathBuf::from(cand);
        if cache.exists(&p) {
            return Some(p);
        }
    }
    if with_index {
        for ext in extensions {
            let idx = base.join(format!("index{ext}"));
            if cache.exists(&idx) {
                return Some(idx);
            }
        }
    }
    None
}

// ── 各语言解析 ──

#[derive(Debug)]
enum ResolveOutcome {
    File(PathBuf),
    External(String),
    Unresolved(String),
}

fn lang_of(path: &Path) -> &str {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .leak()
}

fn resolve_ts_like(
    spec: &str,
    importer: &Path,
    project_root: &Path,
    tsconfig: &TsConfig,
    cache: &mut FsCache,
) -> ResolveOutcome {
    let ext_list: &[&str] = &[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".json", ".css"];

    // 相对路径
    if spec.starts_with("./") || spec.starts_with("../") {
        let base = match importer.parent() {
            Some(p) => p.join(spec),
            None => PathBuf::from(spec),
        };
        return match probe_with_extensions(cache, &base, ext_list, true) {
            Some(p) => ResolveOutcome::File(canonicalize_lenient(&p)),
            None => ResolveOutcome::Unresolved(format!("relative probe failed: {spec}")),
        };
    }

    // tsconfig paths 别名（最长前缀优先）
    for (pattern, target) in &tsconfig.paths {
        let Some(prefix) = pattern.strip_suffix('*') else {
            continue;
        };
        if let Some(rest) = spec.strip_prefix(prefix) {
            let mapped = target.replace('*', rest);
            let base_dir = match &tsconfig.base_url {
                Some(b) => project_root.join(b),
                None => project_root.to_path_buf(),
            };
            let base = base_dir.join(&mapped);
            if let Some(p) = probe_with_extensions(cache, &base, ext_list, true) {
                return ResolveOutcome::File(canonicalize_lenient(&p));
            }
        }
    }

    // bare specifier → node_modules 向上探测
    let first = spec.split('/').next().unwrap_or(spec);
    let mut dir = importer.parent();
    while let Some(d) = dir {
        let pkg_dir = d.join("node_modules").join(first);
        if cache.exists(&pkg_dir) {
            // 项目内不分析 node_modules 源码：外部依赖一律建 External 节点，
            // 避免边指向无 File 节点的孤儿目标。
            let _ = probe_package(cache, &pkg_dir, spec, ext_list);
            return ResolveOutcome::External(external_name(spec));
        }
        dir = d.parent();
    }
    // 兜底：项目根下的 node_modules
    let root_nm = project_root.join("node_modules").join(first);
    if cache.exists(&root_nm) {
        let _ = probe_package(cache, &root_nm, spec, ext_list);
        return ResolveOutcome::External(external_name(spec));
    }

    ResolveOutcome::External(external_name(spec))
}

fn probe_package(
    cache: &mut FsCache,
    pkg_dir: &Path,
    spec: &str,
    ext_list: &[&str],
) -> Option<PathBuf> {
    // 子路径：leftpad/sub/path
    if let Some(rest) = spec.strip_prefix(spec.split('/').next().unwrap_or(spec)) {
        let sub = pkg_dir.join(rest.trim_start_matches('/'));
        if let Some(p) = probe_with_extensions(cache, &sub, ext_list, true) {
            return Some(p);
        }
    }
    let pkg_json = pkg_dir.join("package.json");
    if cache.exists(&pkg_json) {
        if let Ok(text) = std::fs::read_to_string(&pkg_json) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                for key in ["module", "main", "types", "typings"] {
                    if let Some(entry) = v.get(key).and_then(|e| e.as_str()) {
                        let p = pkg_dir.join(entry);
                        if cache.exists(&p) {
                            return Some(p);
                        }
                        let p2 = pkg_dir.join(format!("{entry}.js"));
                        if cache.exists(&p2) {
                            return Some(p2);
                        }
                    }
                }
            }
        }
    }
    // index 兜底
    probe_with_extensions(cache, &pkg_dir.join("index"), ext_list, false)
}

fn resolve_python(
    spec: &str,
    importer: &Path,
    project_root: &Path,
    cache: &mut FsCache,
    bindings: &[Value],
) -> ResolveOutcome {
    if spec.starts_with('.') {
        // 相对导入：'.'=当前包，'..'=父包
        let dots = spec.chars().take_while(|c| *c == '.').count();
        let rest = spec[dots..].trim_start_matches('.');
        let mut dir = match importer.parent() {
            Some(d) => d.to_path_buf(),
            None => importer.to_path_buf(),
        };
        for _ in 1..dots {
            dir = match dir.parent() {
                Some(d) => d.to_path_buf(),
                None => break,
            };
        }
        let rel = dir.join(rest.replace('.', "/"));
        return probe_py_module(cache, &rel)
            .map(|p| ResolveOutcome::File(canonicalize_lenient(&p)))
            .unwrap_or_else(|| ResolveOutcome::Unresolved(format!("relative python probe failed: {spec}")));
    }

    let rel = project_root.join(spec.replace('.', "/"));
    if let Some(p) = probe_py_module(cache, &rel) {
        return ResolveOutcome::File(canonicalize_lenient(&p));
    }
    // namespace package（PEP 420，无 __init__.py 的包目录）：
    // `from vendor.pkg_a import utils` → 解析到 vendor/pkg_a/utils.py
    if cache.exists(&rel) {
        for b in bindings {
            if let Some(name) = b.get("imported").and_then(|v| v.as_str()) {
                if name.contains('.') {
                    continue;
                }
                let cand = rel.join(name);
                if let Some(p) = probe_py_module(cache, &cand) {
                    return ResolveOutcome::File(canonicalize_lenient(&p));
                }
            }
        }
        return ResolveOutcome::Unresolved(format!("package dir without resolvable module: {spec}"));
    }
    ResolveOutcome::External(spec.split('.').next().unwrap_or(spec).to_string())
}

fn probe_py_module(cache: &mut FsCache, base: &Path) -> Option<PathBuf> {
    let mut with_py = base.as_os_str().to_owned();
    with_py.push(".py");
    let p = PathBuf::from(with_py);
    if cache.exists(&p) {
        return Some(p);
    }
    let init = base.join("__init__.py");
    if cache.exists(&init) {
        return Some(init);
    }
    None
}

fn probe_rust_rel(
    cache: &mut FsCache,
    base_dirs: &[PathBuf],
    rel_parts: &[String],
) -> Option<PathBuf> {
    let mut rel_try = rel_parts.join("/");
    loop {
        if !rel_try.is_empty() {
            for base in base_dirs {
                let mut with_rs = base.join(&rel_try).as_os_str().to_owned();
                with_rs.push(".rs");
                let p = PathBuf::from(with_rs);
                if cache.exists(&p) {
                    return Some(canonicalize_lenient(&p));
                }
                let mod_rs = base.join(&rel_try).join("mod.rs");
                if cache.exists(&mod_rs) {
                    return Some(canonicalize_lenient(&mod_rs));
                }
            }
        }
        match rel_try.rfind('/') {
            Some(pos) => rel_try.truncate(pos),
            None => break,
        }
    }
    None
}

/// `super::…` 只剩空余段时的模块文件探测：`dir/mod.rs`，
/// 否则父目录 `dir_name.rs`，最后 crate 根 `lib.rs`/`main.rs`。
fn probe_rust_module_file(cache: &mut FsCache, dir: &Path) -> Option<PathBuf> {
    let mod_rs = dir.join("mod.rs");
    if cache.exists(&mod_rs) {
        return Some(canonicalize_lenient(&mod_rs));
    }
    if let (Some(name), Some(parent)) = (dir.file_name(), dir.parent()) {
        let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if !stem.is_empty() {
            let file_rs = parent.join(format!("{stem}.rs"));
            if cache.exists(&file_rs) {
                return Some(canonicalize_lenient(&file_rs));
            }
        }
    }
    for root_name in ["lib.rs", "main.rs"] {
        let p = dir.join(root_name);
        if cache.exists(&p) {
            return Some(canonicalize_lenient(&p));
        }
    }
    None
}

fn resolve_rust_with_index(
    use_path: &str,
    importer: &Path,
    project_root: &Path,
    cache: &mut FsCache,
    idx: Option<&RustModuleIndex>,
    scope_rel: Option<&str>,
) -> ResolveOutcome {
    let importer = canonicalize_lenient(importer);
    let (anchor, rest) = split_rust_anchor(use_path);

    let crate_base = idx
        .map(|i| i.crate_base.clone())
        .unwrap_or_else(|| project_root.to_path_buf());
    let file_module = idx
        .and_then(|i| i.file_module.get(&importer).cloned())
        .unwrap_or_else(|| infer_rust_module_path(&importer, &crate_base));
    let mut scope_parts = rust_segments(&file_module);
    if let Some(rel) = scope_rel {
        scope_parts.extend(rust_segments(rel));
    }

    let base_parts = match anchor {
        RustPathAnchor::Crate => Vec::new(),
        RustPathAnchor::SelfModule => scope_parts.clone(),
        RustPathAnchor::Super(n) => {
            let keep = scope_parts.len().saturating_sub(n);
            scope_parts[..keep].to_vec()
        }
        // 裸路径没有固定 base：下面先按当前模块、再按 crate 根尝试。
        RustPathAnchor::Bare => Vec::new(),
    };

    // 模块树优先：`crate::a::b` / `super::super::m` / `mod x;` 归属。
    if let Some(idx) = idx {
        // 内联 mod tests 里的 `use super::*`：super == 本文件模块，
        // 应指向本文件而不是模块树里的根文件。
        if rest.is_empty() && anchor == RustPathAnchor::Super(1) && base_parts == rust_segments(&file_module) {
            return ResolveOutcome::File(importer.clone());
        }
        if anchor == RustPathAnchor::Bare {
            // 2018 裸路径：先在当前模块作用域里找（`pub use memory::…`），
            // 再退回 crate 根模块（兼容部分代码风格）。至少匹配一个
            // 路径段 —— 裸路径匹配不到模块时按外部 crate 处理。
            if let Some(file) = idx.module_file_for_range(&scope_parts, &rest, 1) {
                return ResolveOutcome::File(file);
            }
            if let Some(file) = idx.module_file_for_range(&[], &rest, 1) {
                return ResolveOutcome::File(file);
            }
            if let Some(first) = rest.first() {
                return ResolveOutcome::External(first.clone());
            }
            return ResolveOutcome::Unresolved(format!("empty rust use path: {use_path}"));
        }
        if let Some(file) = idx.module_file_for(&base_parts, &rest) {
            return ResolveOutcome::File(file);
        }
    }

    // 文件系统兜底（兼容无 rust_modules 元数据的旧图/直接单测调用）。
    let mut base_dirs: Vec<PathBuf> = Vec::new();
    match anchor {
        RustPathAnchor::Crate => {
            base_dirs.push(crate_base.clone());
            let src = project_root.join("src");
            if src != crate_base {
                base_dirs.push(src);
            }
        }
        RustPathAnchor::SelfModule => {
            if let Some(parent) = importer.parent() {
                base_dirs.push(parent.to_path_buf());
            }
        }
        RustPathAnchor::Super(n) => {
            let mut dir = importer
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| importer.clone());
            if importer.file_name().and_then(|s| s.to_str()) == Some("mod.rs") {
                if let Some(parent) = dir.parent() {
                    dir = parent.to_path_buf();
                }
            }
            for _ in 1..n {
                if let Some(parent) = dir.parent() {
                    dir = parent.to_path_buf();
                } else {
                    break;
                }
            }
            base_dirs.push(dir);
        }
        RustPathAnchor::Bare => {
            // 裸路径：先看当前模块目录，再看 crate 根。
            if let Some(parent) = importer.parent() {
                base_dirs.push(parent.to_path_buf());
            }
            base_dirs.push(crate_base.clone());
        }
    }

    if rest.is_empty() {
        for base in &base_dirs {
            if let Some(file) = probe_rust_module_file(cache, base) {
                return ResolveOutcome::File(file);
            }
        }
    } else if let Some(file) = probe_rust_rel(cache, &base_dirs, &rest) {
        return ResolveOutcome::File(file);
    } else if anchor != RustPathAnchor::Bare {
        // `super::Symbol`：Symbol 不是子模块文件时，回退到父模块文件。
        for base in &base_dirs {
            if let Some(file) = probe_rust_module_file(cache, base) {
                return ResolveOutcome::File(file);
            }
        }
    }

    if anchor == RustPathAnchor::Bare {
        if let Some(first) = rest.first() {
            return ResolveOutcome::External(first.clone());
        }
        return ResolveOutcome::Unresolved(format!("empty rust use path: {use_path}"));
    }

    ResolveOutcome::Unresolved(format!(
        "rust module probe failed: {} (importer={}, scope={}, base={:?}, rest={:?})",
        use_path,
        importer.display(),
        file_module,
        base_parts,
        rest
    ))
}

#[cfg(test)]
fn resolve_rust(
    use_path: &str,
    importer: &Path,
    project_root: &Path,
    cache: &mut FsCache,
) -> ResolveOutcome {
    resolve_rust_with_index(use_path, importer, project_root, cache, None, None)
}

fn resolve_go(
    spec: &str,
    importer: &Path,
    project_root: &Path,
    cache: &mut FsCache,
) -> ResolveOutcome {
    let spec = spec.trim().trim_matches('"').trim_matches('`');
    if spec.starts_with("./") || spec.starts_with("../") {
        let base = match importer.parent() {
            Some(p) => p.join(spec),
            None => PathBuf::from(spec),
        };
        if cache.exists(&base) {
            return ResolveOutcome::File(canonicalize_lenient(&base));
        }
        let base2 = base.as_os_str().to_owned();
        let mut s = base2;
        s.push(".go");
        let with_go = PathBuf::from(s);
        if cache.exists(&with_go) {
            return ResolveOutcome::File(canonicalize_lenient(&with_go));
        }
        return ResolveOutcome::Unresolved(format!("go relative probe failed: {spec}"));
    }
    for base in [project_root.join("vendor").join(spec), project_root.join(spec)] {
        if cache.exists(&base) {
            return ResolveOutcome::File(canonicalize_lenient(&base));
        }
        let mut s = base.as_os_str().to_owned();
        s.push(".go");
        let with_go = PathBuf::from(s);
        if cache.exists(&with_go) {
            return ResolveOutcome::File(canonicalize_lenient(&with_go));
        }
    }
    ResolveOutcome::External(spec.split('/').next().unwrap_or(spec).to_string())
}

/// 宽松 canonicalize：失败时回退原路径（避免路径不存在时丢失信息）。
fn canonicalize_lenient(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// 外部依赖节点名：TS 保留 scope（@scope/pkg），其余取首段。
fn external_name(spec: &str) -> String {
    if spec.starts_with('@') {
        let mut parts = spec.split('/');
        match (parts.next(), parts.next()) {
            (Some(scope), Some(name)) => format!("{scope}/{name}"),
            _ => spec.to_string(),
        }
    } else {
        spec.split('/').next().unwrap_or(spec).to_string()
    }
}

// ── 主入口 ──

/// 对图中所有 imports 边做确定性路径解析。返回统计。
pub fn resolve_import_edges(graph: &mut Graph, project_root: &Path) -> ImportResolveStats {
    let tsconfig = parse_tsconfig(project_root);
    let mut cache = FsCache::default();
    let mut stats = ImportResolveStats::default();

    // File 节点 id → 绝对路径
    let mut id2path: HashMap<String, PathBuf> = HashMap::new();
    for (_id, node) in graph.nodes_iter() {
        if node.kind == NodeKind::File {
            if let Some(p) = node.file() {
                id2path.insert(
                    node.id.as_str().to_string(),
                    canonicalize_lenient(Path::new(p)),
                );
            }
        }
    }
    let rust_idx = RustModuleIndex::from_graph(graph, project_root, &mut cache);

    // 收集 imports 边 id（避免借用冲突）
    let import_edges: Vec<(String, String, Option<Value>)> = graph
        .edges_iter()
        .filter(|(_, e)| e.kind == EdgeKind::Imports)
        .map(|(id, e)| {
            (
                id.to_string(),
                e.source.as_str().to_string(),
                e.metadata.clone(),
            )
        })
        .collect();

    // 外部节点去重
    let mut external_nodes: HashMap<String, bool> = HashMap::new();

    for (eid, source, metadata) in import_edges {
        stats.total += 1;
        let Some(src_path) = id2path.get(&source).cloned() else {
            stats.skipped += 1;
            continue;
        };
        // 仅处理带 import_raw 的边（query_adapter 提取时写入）。
        // 旧边 / require() / 动态 import() 等没有 raw specifier，
        // 保持原有名字匹配路径，避免回归。
        let Some(raw_quoted) = metadata
            .as_ref()
            .and_then(|m| m.get(META_IMPORT_RAW))
            .and_then(|v| v.as_str())
        else {
            stats.skipped += 1;
            continue;
        };
        let raw = raw_quoted
            .trim_matches(|c| c == '\'' || c == '"' || c == '`')
            .to_string();
        if raw.is_empty() {
            stats.skipped += 1;
            continue;
        }
        let bindings: Vec<Value> = metadata
            .as_ref()
            .and_then(|m| m.get("import_bindings"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let lang = lang_of(&src_path);

        let outcome = match lang {
            "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => {
                resolve_ts_like(&raw, &src_path, project_root, &tsconfig, &mut cache)
            }
            "py" | "pyi" => resolve_python(&raw, &src_path, project_root, &mut cache, &bindings),
            "rs" => {
                // 优先用 metadata 里解析好的 use 路径（query_adapter 提供），
                // 否则回退原始文本。
                let use_path = metadata
                    .as_ref()
                    .and_then(|m| m.get("import_path"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| raw.clone());
                let rust_scope = metadata
                    .as_ref()
                    .and_then(|m| m.get("rust_scope"))
                    .and_then(|v| v.as_str());
                resolve_rust_with_index(
                    &use_path,
                    &src_path,
                    project_root,
                    &mut cache,
                    Some(&rust_idx),
                    rust_scope,
                )
            }
            "go" => resolve_go(&raw, &src_path, project_root, &mut cache),
            _ => {
                stats.skipped += 1;
                continue;
            }
        };

        match outcome {
            ResolveOutcome::File(p) => {
                let new_target = module_id_of(&p);
                if let Some(edge) = graph.get_edge_mut(&eid) {
                    edge.target = new_target.into();
                    edge.cross_file = true;
                    let mut meta = edge.metadata.take().unwrap_or_else(|| json!({}));
                    meta["resolved_by"] = json!("import-path");
                    meta[META_IMPORT_RAW] = json!(raw);
                    edge.metadata = Some(meta);
                }
                stats.resolved += 1;
            }
            ResolveOutcome::External(name) => {
                let ext_id = format!("ext:{}", name);
                if !external_nodes.contains_key(&ext_id) {
                    let mut n = Node::new(&ext_id, &name, NodeKind::Symbol);
                    n.properties = json!({"external": true, "kind": "external_module"});
                    graph.add_node(n);
                    external_nodes.insert(ext_id.clone(), true);
                }
                if let Some(edge) = graph.get_edge_mut(&eid) {
                    edge.target = ext_id.into();
                    edge.cross_file = true;
                    let mut meta = edge.metadata.take().unwrap_or_else(|| json!({}));
                    meta["external"] = json!(true);
                    meta[META_IMPORT_RAW] = json!(raw);
                    edge.metadata = Some(meta);
                }
                stats.external += 1;
            }
            ResolveOutcome::Unresolved(reason) => {
                if let Some(edge) = graph.get_edge_mut(&eid) {
                    let mut meta = edge.metadata.take().unwrap_or_else(|| json!({}));
                    meta["unresolved_import"] = json!(true);
                    meta["unresolved_reason"] = json!(reason);
                    meta[META_IMPORT_RAW] = json!(raw);
                    edge.metadata = Some(meta);
                }
                stats.unresolved += 1;
            }
        }
    }

    stats
}

// ── P0-2：import 符号绑定与别名传播 ──

#[derive(Debug, Default, Clone)]
pub struct BindingStats {
    pub bindings: usize,
    pub rewrote: usize,
}

impl BindingStats {
    pub fn summary(&self) -> String {
        format!("import-binding bindings={} rewrote={}", self.bindings, self.rewrote)
    }
}

struct Binding {
    /// 解析后的目标 module id（import-path 阶段已改写的 imports 边 target）。
    target_module: String,
    /// 目标符号名（module 绑定为空串）。
    symbol: String,
}

/// 利用 imports 边上的 import_bindings 元数据，把同文件的 usage/calls 边
/// 中引用导入别名/符号的裸名目标改写为具体符号节点 id。
/// 必须在 CrossFileResolver 之前运行——先确定性绑定，剩余再走名字猜测。
pub fn apply_import_bindings(graph: &mut Graph) -> BindingStats {
    let mut stats = BindingStats::default();

    let node_ids: std::collections::HashSet<String> =
        graph.node_ids().map(|s| s.to_string()).collect();

    // 1. 收集 (source_module, local) → Binding
    let mut file_bindings: std::collections::HashMap<(String, String), Binding> =
        std::collections::HashMap::new();
    let import_infos: Vec<(String, String, Option<Value>)> = graph
        .edges_iter()
        .filter(|(_, e)| e.kind == EdgeKind::Imports)
        .map(|(_, e)| {
            (
                e.source.as_str().to_string(),
                e.target.as_str().to_string(),
                e.metadata.clone(),
            )
        })
        .collect();
    for (src, tgt, meta) in &import_infos {
        if tgt.starts_with("ext:") {
            continue; // 外部依赖无符号节点，跳过绑定
        }
        let explicit = meta
            .as_ref()
            .and_then(|m| m.get("import_bindings"))
            .and_then(|v| v.as_array())
            .cloned();
        // Rust use 边没有 import_bindings —— 用 import_path/import_alias 合成
        let bindings: Vec<Value> = match explicit {
            Some(b) => b,
            None => {
                let Some(path) = meta
                    .as_ref()
                    .and_then(|m| m.get("import_path"))
                    .and_then(|v| v.as_str())
                else {
                    continue;
                };
                // 花括号分组与通配导入没有单符号绑定；新边由
                // query_adapter 的 parse_rust_use 写入显式 bindings。
                if path.contains('{') || path.ends_with("::*") || path == "*" {
                    continue;
                }
                let imported = path.rsplit("::").next().unwrap_or(path).to_string();
                let local = meta
                    .as_ref()
                    .and_then(|m| m.get("import_alias"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| imported.clone());
                if imported.is_empty() || imported == "*" {
                    continue;
                }
                vec![json!({"imported": imported, "local": local})]
            }
        };
        for b in &bindings {
            let Some(imported) = b.get("imported").and_then(|v| v.as_str()) else {
                continue;
            };
            let local = b
                .get("local")
                .and_then(|v| v.as_str())
                .unwrap_or(imported)
                .to_string();
            let imported_last = imported.rsplit('.').next().unwrap_or(imported);
            // 符号绑定：目标文件下有同名符号节点；否则若目标文件名主干 ==
            // imported（namespace package 的 from X import Y，Y 是子模块），
            // 记 module 绑定（symbol 为空，method 链直接挂到文件节点后）。
            let symbol_candidate = format!("{tgt}.{imported_last}");
            // 文件名主干：module id 形如 "….pkg_a.utils.py"，取末两段的
            // 前一段剥扩展名（"utils.py" → "utils"）。
            let stem_matches = {
                let segs: Vec<&str> = tgt.rsplit('.').collect();
                let stem = if segs.len() >= 2 && segs[0] == "py" {
                    segs[1]
                } else {
                    segs[0]
                };
                stem == imported_last
            };
            if node_ids.contains(&symbol_candidate) {
                file_bindings.insert(
                    (src.clone(), local),
                    Binding {
                        target_module: tgt.clone(),
                        symbol: imported_last.to_string(),
                    },
                );
                stats.bindings += 1;
            } else if stem_matches {
                file_bindings.insert(
                    (src.clone(), local),
                    Binding {
                        target_module: tgt.clone(),
                        symbol: String::new(),
                    },
                );
                stats.bindings += 1;
            }
        }
    }

    // 2. 改写 usage/calls 边
    // Rust 同目录模块索引：dir → (stem → file_id)，用于 `format::fmt(...)`
    // 这类模块限定调用的解析。
    let mut rust_dir_index: HashMap<PathBuf, HashMap<String, String>> = HashMap::new();
    {
        for (_id, node) in graph.nodes_iter() {
            if node.kind != NodeKind::File {
                continue;
            }
            let Some(p) = node.file() else { continue };
            let path = PathBuf::from(p);
            if lang_of(&path) != "rs" {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                let dir = path.parent().unwrap_or(Path::new("")).to_path_buf();
                rust_dir_index
                    .entry(dir)
                    .or_default()
                    .insert(stem.to_string(), node.id.as_str().to_string());
            }
        }
    }
    // scope id → 所属文件路径（Rust 模块限定解析用，惰性 + 记忆化）
    let mut scope_file_memo: HashMap<String, Option<PathBuf>> = HashMap::new();

    let mut rewrites: Vec<(String, String)> = Vec::new();
    for (eid, edge) in graph.edges_iter() {
        if edge.kind != EdgeKind::Usage && edge.kind != EdgeKind::Calls {
            continue;
        }
        let tgt = edge.target.as_str();
        // ids 以 '.' 开头（绝对路径 module id），跳过已解析目标
        if tgt.starts_with('.') {
            continue;
        }
        // Rust 路径分隔符 :: 归一为 . 后拆分（format::fmt → format.fmt）
        let parsed = tgt.replace("::", ".");
        let (local, rest) = match parsed.split_once('.') {
            Some((l, r)) => (l, Some(r.to_string())),
            None => (tgt, None),
        };
        // 文件作用域绑定：edge.source 是 scope id（module 或 module.fn.class…），
        // 匹配 source == module 或 source 以 module + "." 开头（取最长前缀）。
        let mut matched: Option<&Binding> = None;
        let mut best_len = 0usize;
        for ((module, l), b) in &file_bindings {
            if *l != local {
                continue;
            }
            let src = edge.source.as_str();
            if src == module || src.starts_with(&format!("{module}.")) {
                if module.len() > best_len {
                    best_len = module.len();
                    matched = Some(b);
                }
            }
        }
        let Some(binding) = matched else {
            // Rust 模块限定调用：`format::fmt(...)`，且 local 是同目录
            // Rust 模块的文件主干 → module 绑定。
            if rest.is_some() {
                let src_path = scope_file_memo
                    .entry(edge.source.as_str().to_string())
                    .or_insert_with(|| {
                        for (_id, node) in graph.nodes_iter() {
                            if node.kind != NodeKind::File {
                                continue;
                            }
                            if let Some(p) = node.file() {
                                if edge.source.as_str() == node.id.as_str()
                                    || edge
                                        .source
                                        .as_str()
                                        .starts_with(&format!("{}.", node.id.as_str()))
                                {
                                    return Some(PathBuf::from(p));
                                }
                            }
                        }
                        None
                    })
                    .clone();
                if let Some(path) = src_path {
                    if lang_of(&path) == "rs" {
                        if let Some(dir) = path.parent() {
                            if let Some(sibling) =
                                rust_dir_index.get(dir).and_then(|m| m.get(local))
                            {
                                let cand = format!("{sibling}.{}", rest.as_deref().unwrap_or(""));
                                if node_ids.contains(&cand) {
                                    rewrites.push((eid.to_string(), cand));
                                }
                            }
                        }
                    }
                }
            }
            continue;
        };
        let candidate = if binding.symbol.is_empty() {
            match rest.as_deref() {
                Some(r) => format!("{}.{}", binding.target_module, r),
                None => binding.target_module.clone(),
            }
        } else {
            match rest.as_deref() {
                Some(r) => format!("{}.{}.{}", binding.target_module, binding.symbol, r),
                None => format!("{}.{}", binding.target_module, binding.symbol),
            }
        };
        let final_target = if node_ids.contains(&candidate) {
            Some(candidate)
        } else if rest.is_some() && !binding.symbol.is_empty() {
            // alias.method 链：method 子节点不存在时落到绑定符号本身
            // （如 `theme.primary` → theme 变量节点）
            let base = format!("{}.{}", binding.target_module, binding.symbol);
            if node_ids.contains(&base) {
                Some(base)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(new_tgt) = final_target {
            rewrites.push((eid.to_string(), new_tgt));
        }
    }
    for (eid, new_tgt) in rewrites {
        if let Some(e) = graph.get_edge_mut(&eid) {
            e.target = new_tgt.into();
            e.cross_file = true;
            match &mut e.metadata {
                Some(m) => {
                    m["resolved_by"] = json!("import-binding");
                }
                None => {
                    e.metadata = Some(json!({"resolved_by": "import-binding"}));
                }
            }
            stats.rewrote += 1;
        }
    }

    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hologram_ir_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn test_module_id_of_matches_query_adapter_scheme() {
        let p = Path::new("/home/u/proj/src/a.py");
        assert_eq!(module_id_of(p), ".home.u.proj.src.a.py");
    }

    #[test]
    fn test_ts_relative_probe() {
        let root = tmp_dir("ts_rel");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("components")).unwrap();
        std::fs::write(src.join("app.tsx"), "").unwrap();
        std::fs::write(src.join("components").join("button.tsx"), "").unwrap();
        let mut cache = FsCache::default();
        let importer = src.join("app.tsx");
        let out = resolve_ts_like("./components/button", &importer, &root, &TsConfig::default(), &mut cache);
        assert!(matches!(out, ResolveOutcome::File(p) if p.ends_with("components/button.tsx")));
    }

    #[test]
    fn test_ts_paths_alias() {
        let root = tmp_dir("ts_alias");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("theme")).unwrap();
        std::fs::write(src.join("theme/colors.ts"), "").unwrap();
        let mut cfg = TsConfig::default();
        cfg.base_url = Some(".".into());
        cfg.paths.push(("@/*".into(), "src/*".into()));
        let mut cache = FsCache::default();
        let importer = src.join("app.tsx");
        let out = resolve_ts_like("@/theme/colors", &importer, &root, &cfg, &mut cache);
        assert!(matches!(out, ResolveOutcome::File(p) if p.ends_with("theme/colors.ts")));
    }

    #[test]
    fn test_ts_node_modules_package_is_external() {
        let root = tmp_dir("ts_nm");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let pkg = root.join("node_modules/leftpad");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), r#"{ "main": "index.js" }"#).unwrap();
        std::fs::write(pkg.join("index.js"), "").unwrap();
        let mut cache = FsCache::default();
        let importer = root.join("src/uses_leftpad.ts");
        let out = resolve_ts_like("leftpad", &importer, &root, &TsConfig::default(), &mut cache);
        assert!(matches!(out, ResolveOutcome::External(name) if name == "leftpad"));
    }

    #[test]
    fn test_ts_bare_is_external() {
        let root = tmp_dir("ts_ext");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let mut cache = FsCache::default();
        let importer = root.join("src/x.ts");
        let out = resolve_ts_like("react", &importer, &root, &TsConfig::default(), &mut cache);
        assert!(matches!(out, ResolveOutcome::External(name) if name == "react"));
    }

    #[test]
    fn test_python_dotted_module_and_init() {
        let root = tmp_dir("py_dotted");
        std::fs::create_dir_all(root.join("app/services")).unwrap();
        std::fs::write(root.join("app/services/user_svc.py"), "").unwrap();
        std::fs::create_dir_all(root.join("pkg")).unwrap();
        std::fs::write(root.join("pkg/__init__.py"), "").unwrap();
        let mut cache = FsCache::default();
        let importer = root.join("app/controllers/user_ctl.py");
        let out1 = resolve_python("app.services.user_svc", &importer, &root, &mut cache, &[]);
        assert!(matches!(out1, ResolveOutcome::File(p) if p.ends_with("app/services/user_svc.py")));
        let out2 = resolve_python("pkg", &importer, &root, &mut cache, &[]);
        assert!(matches!(out2, ResolveOutcome::File(p) if p.ends_with("pkg/__init__.py")));
    }

    #[test]
    fn test_python_relative_import() {
        let root = tmp_dir("py_rel");
        std::fs::create_dir_all(root.join("app/services")).unwrap();
        std::fs::create_dir_all(root.join("app/controllers")).unwrap();
        std::fs::write(root.join("app/services/user_svc.py"), "").unwrap();
        std::fs::write(root.join("app/controllers/user_ctl.py"), "").unwrap();
        let mut cache = FsCache::default();
        let importer = root.join("app/controllers/user_ctl.py");
        let out = resolve_python("..services.user_svc", &importer, &root, &mut cache, &[]);
        assert!(matches!(out, ResolveOutcome::File(p) if p.ends_with("app/services/user_svc.py")));
    }

    #[test]
    fn test_rust_crate_use_resolves_module_file() {
        let root = tmp_dir("rs_crate");
        std::fs::create_dir_all(root.join("src/util")).unwrap();
        std::fs::write(root.join("src/util/format.rs"), "").unwrap();
        std::fs::write(root.join("src/other.rs"), "").unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        let mut cache = FsCache::default();
        let importer = root.join("src/main.rs");
        let out1 = resolve_rust("crate::util::format::fmt", &importer, &root, &mut cache);
        assert!(matches!(out1, ResolveOutcome::File(p) if p.ends_with("src/util/format.rs")));
        let out2 = resolve_rust("crate::other::fmt", &importer, &root, &mut cache);
        assert!(matches!(out2, ResolveOutcome::File(p) if p.ends_with("src/other.rs")));
    }

    #[test]
    fn test_rust_std_is_external() {
        let root = tmp_dir("rs_std");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        let mut cache = FsCache::default();
        let importer = root.join("src/main.rs");
        let out = resolve_rust("std::collections::HashMap", &importer, &root, &mut cache);
        assert!(matches!(out, ResolveOutcome::External(name) if name == "std"));
    }

    #[test]
    fn test_external_name_scoped_package() {
        assert_eq!(external_name("@types/react"), "@types/react");
        assert_eq!(external_name("leftpad/sub"), "leftpad");
    }

    #[test]
    fn test_rust_multi_super_filesystem_fallback() {
        let root = tmp_dir("rs_multi_super");
        std::fs::create_dir_all(root.join("src/framework_routes/frameworks")).unwrap();
        std::fs::write(root.join("src/framework_routes/mod.rs"), "").unwrap();
        std::fs::write(root.join("src/framework_routes/frameworks/actix.rs"), "").unwrap();
        let mut cache = FsCache::default();
        let importer = root.join("src/framework_routes/frameworks/actix.rs");

        let out1 = resolve_rust(
            "super::super::DetectedRoute",
            &importer,
            &root,
            &mut cache,
        );
        assert!(
            matches!(&out1, ResolveOutcome::File(p) if p.ends_with("framework_routes/mod.rs")),
            "super::super 应回退到父模块文件，got {:?}",
            out1
        );

        // 花括号分组头也应剥到 `super::super`。
        let out2 = resolve_rust(
            "super::super::{DetectedRoute, find_first_string}",
            &importer,
            &root,
            &mut cache,
        );
        assert!(
            matches!(&out2, ResolveOutcome::File(p) if p.ends_with("framework_routes/mod.rs")),
            "花括号多符号 use 应按基础路径解析，got {:?}",
            out2
        );
    }

    #[test]
    fn test_rust_super_wildcard_filesystem_fallback() {
        let root = tmp_dir("rs_super_wild");
        std::fs::create_dir_all(root.join("src/adapter")).unwrap();
        std::fs::write(root.join("src/adapter/mod.rs"), "").unwrap();
        std::fs::write(root.join("src/adapter/query_adapter.rs"), "").unwrap();
        let mut cache = FsCache::default();
        let importer = root.join("src/adapter/query_adapter.rs");
        let out = resolve_rust("super::*", &importer, &root, &mut cache);
        assert!(
            matches!(&out, ResolveOutcome::File(p) if p.ends_with("adapter/mod.rs")),
            "super::* 应解析到父模块文件，got {:?}",
            out
        );
    }

    #[test]
    fn test_rust_bare_use_resolves_local_module_not_external() {
        let root = tmp_dir("rs_bare_local");
        std::fs::create_dir_all(root.join("src/storage")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "").unwrap();
        std::fs::write(root.join("src/storage/mod.rs"), "").unwrap();
        std::fs::write(root.join("src/storage/memory.rs"), "").unwrap();
        let mut cache = FsCache::default();
        let importer = root.join("src/storage/mod.rs");
        let out = resolve_rust(
            "memory::{LoadProgress, MemoryIndex}",
            &importer,
            &root,
            &mut cache,
        );
        assert!(
            matches!(&out, ResolveOutcome::File(p) if p.ends_with("storage/memory.rs")),
            "Rust 2018 裸路径应优先解析为当前模块子模块，got {:?}",
            out
        );

        let out2 = resolve_rust("serde::{Serialize, Deserialize}", &importer, &root, &mut cache);
        assert!(
            matches!(&out2, ResolveOutcome::External(name) if name == "serde"),
            "无同名本地模块时才应落到外部 crate，got {:?}",
            out2
        );
    }

    #[test]
    fn test_rust_mod_tree_scope_attribution() {
        let root = tmp_dir("rs_mod_tree");
        std::fs::create_dir_all(root.join("src/graph")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "").unwrap();
        std::fs::write(root.join("src/graph/mod.rs"), "").unwrap();
        std::fs::write(root.join("src/graph/graph.rs"), "").unwrap();
        std::fs::write(root.join("src/graph/merge.rs"), "").unwrap();

        fn file_node(path: &std::path::Path, mods: serde_json::Value) -> Node {
            let id = module_id_of(path);
            let mut n = Node::new(&id, &id, NodeKind::File);
            n.location = Some(path.to_string_lossy().to_string());
            n.properties = mods;
            n
        }

        let lib = root.join("src/lib.rs");
        let graph_mod = root.join("src/graph/mod.rs");
        let graph_rs = root.join("src/graph/graph.rs");
        let merge_rs = root.join("src/graph/merge.rs");
        let mut g = Graph::new();
        let _ = g.add_node(file_node(
            &lib,
            serde_json::json!({"rust_modules": [{"name": "graph", "inline": false}]}),
        ));
        let _ = g.add_node(file_node(
            &graph_mod,
            serde_json::json!({"rust_modules": [
                {"name": "graph", "inline": false},
                {"name": "merge", "inline": false},
                {"name": "tests", "inline": true}
            ]}),
        ));
        let _ = g.add_node(file_node(
            &graph_rs,
            serde_json::json!({"rust_modules": [{"name": "tests", "inline": true}]}),
        ));
        let _ = g.add_node(file_node(&merge_rs, serde_json::json!({})));

        let mut cache = FsCache::default();
        let idx = RustModuleIndex::from_graph(&g, &root, &mut cache);
        let importer = canonicalize_lenient(&graph_rs);

        // 顶层 `use super::{…}`：super = graph 模块文件 graph/mod.rs。
        let out = resolve_rust_with_index(
            "super::{Edge, EdgeKind}",
            &importer,
            &root,
            &mut cache,
            Some(&idx),
            None,
        );
        assert!(matches!(out, ResolveOutcome::File(p) if p.ends_with("graph/mod.rs")));

        // 内联 mod tests 里 `use super::*`：super = graph.rs 文件自身。
        let out = resolve_rust_with_index(
            "super::*",
            &importer,
            &root,
            &mut cache,
            Some(&idx),
            Some("tests"),
        );
        assert!(matches!(out, ResolveOutcome::File(p) if p.ends_with("graph/graph.rs")));

        // tests 里 `use super::super::{…}`：跳过 graph.rs 后到达 graph 模块。
        let out = resolve_rust_with_index(
            "super::super::{Edge, EdgeKind, Node, NodeKind}",
            &importer,
            &root,
            &mut cache,
            Some(&idx),
            Some("tests"),
        );
        assert!(matches!(out, ResolveOutcome::File(p) if p.ends_with("graph/mod.rs")));

        // tests 里 `use super::super::merge::GraphMerger`：按模块树查子模块。
        let out = resolve_rust_with_index(
            "super::super::merge::GraphMerger",
            &importer,
            &root,
            &mut cache,
            Some(&idx),
            Some("tests"),
        );
        assert!(matches!(out, ResolveOutcome::File(p) if p.ends_with("graph/merge.rs")));
    }
}
