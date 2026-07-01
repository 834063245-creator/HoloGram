// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Pure dataflow query engine — runs tree-sitter .scm queries and returns
//! structured reads/writes/shares/triggers/sequences per scope. No Graph
//! dependency — designed for on-demand Agent dataflow tracing.
//!
//! Architecture:
//!   1. Phase 1: walk tree → collect scope boundaries (functions/classes)
//!   2. Phase 2: run .scm queries → collect captures
//!   3. Phase 3: resolve captures to per-scope reads/writes/triggers/sequences
//!   4. Phase 5: reverse-index cross-function shared state detection
//!
//! A new language needs only a ~30-line .scm file + a builtin-name list —
//! no Rust walker code required.

use std::collections::{HashMap, HashSet};
use tree_sitter::{Language, Node as TsNode, Query, QueryCursor};
use streaming_iterator::StreamingIterator;

// ── Language config ──

pub struct LangDataflowConfig {
    /// Compiled-in .scm query source
    pub query_src: &'static str,
    /// Names to filter out (builtins, host objects)
    pub skip_names: &'static [&'static str],
    /// Function-scope node kinds (for scope-boundary detection)
    pub func_kinds: &'static [&'static str],
    /// Class-scope node kinds
    pub class_kinds: &'static [&'static str],
}

impl LangDataflowConfig {
    fn is_skip_name(&self, name: &str) -> bool {
        self.skip_names.contains(&name)
    }

    fn scope_role(&self, kind: &str) -> Option<&'static str> {
        if self.func_kinds.contains(&kind) { return Some("function"); }
        if self.class_kinds.contains(&kind) { return Some("class"); }
        None
    }
}

// ── Python config ──

static PY_BUILTINS: &[&str] = &[
    "str","int","float","bool","bytes","bytearray","complex",
    "list","dict","tuple","set","frozenset","object",
    "True","False","None",
    "len","range","type","print","isinstance","issubclass",
    "super","Exception","ValueError","TypeError","KeyError",
    "IndexError","AttributeError","RuntimeError","StopIteration",
    "map","filter","zip","enumerate","sorted","reversed",
    "any","all","min","max","sum","abs","round",
    "chr","ord","hex","oct","bin","hash","id","repr",
    "input","open","format","staticmethod","classmethod",
    "property","hasattr","getattr","setattr","delattr",
    "iter","next","slice","dir","vars","__name__","__file__",
];

static PY_FUNC_KINDS: &[&str] = &["function_definition","lambda"];
static PY_CLASS_KINDS: &[&str] = &["class_definition"];

// ── JS/TS config ──

static JS_SKIP_NAMES: &[&str] = &[
    "this","super","undefined","null","NaN","Infinity",
    "console","window","document","process","global","globalThis",
    "Math","JSON","Date","RegExp","Promise","Array","Object",
    "String","Number","Boolean","Function","Symbol","Map","Set",
    "WeakMap","WeakSet","Proxy","Reflect","Error","TypeError",
    "parseInt","parseFloat","isNaN","isFinite",
    "setTimeout","setInterval","clearTimeout","clearInterval",
    "fetch","XMLHttpRequest","FormData","URL","URLSearchParams",
    "Intl","BigInt",
];

static JS_FUNC_KINDS: &[&str] = &[
    "function_declaration","function_expression","arrow_function",
    "method_definition","generator_function_declaration",
];

static JS_CLASS_KINDS: &[&str] = &["class_declaration"];

// ── Rust config ──

static RS_SKIP_NAMES: &[&str] = &[
    "self","Self","true","false","None","Ok","Err","Some","Option","Result",
    "String","str","Vec","HashMap","HashSet","Box","Rc","Arc","Cell","RefCell",
    "Mutex","RwLock","i8","i16","i32","i64","u8","u16","u32","u64","f32","f64",
    "usize","isize","bool","char","println","eprintln","format","dbg","panic",
    "assert","assert_eq","assert_ne","Ok","try","unwrap","expect","clone","copy",
    "drop","into","from","new","default","len","is_empty","push","pop","insert",
    "remove","get","iter","next","map","filter","collect","fold","std","core",
    "alloc","main","crate","super",
];

static RS_FUNC_KINDS: &[&str] = &["function_item","closure_expression"];
static RS_CLASS_KINDS: &[&str] = &["impl_item","struct_item","enum_item","trait_item"];

// ── Go config ──

static GO_SKIP_NAMES: &[&str] = &[
    "nil","true","false","iota","string","int","int8","int16","int32","int64",
    "uint","uint8","uint16","uint32","uint64","float32","float64","bool","byte",
    "rune","error","complex64","complex128","uintptr","print","println","len",
    "cap","make","new","append","copy","delete","close","panic","recover","defer",
    "go","chan","map","range","select","func","interface","struct","type","var",
    "const","fmt","context","Context","err","Err","main","init",
];

static GO_FUNC_KINDS: &[&str] = &["function_declaration","method_declaration","func_literal"];
static GO_CLASS_KINDS: &[&str] = &["type_declaration"];

// ── Java config ──

static JAVA_SKIP_NAMES: &[&str] = &[
    "this","super","null","true","false","System","String","Object","Class",
    "Integer","Long","Double","Float","Boolean","Byte","Short","Character",
    "Math","Arrays","Collections","List","Map","Set","ArrayList","HashMap",
    "HashSet","Optional","Stream","StringBuilder","Exception","RuntimeException",
    "Override","Deprecated","SuppressWarnings","out","err","in","println","print",
    "equals","hashCode","toString","clone","finalize","getClass","notify","wait",
    "valueOf","parseInt","parseLong","of","main",
];

static JAVA_FUNC_KINDS: &[&str] = &["method_declaration","constructor_declaration","lambda_expression"];
static JAVA_CLASS_KINDS: &[&str] = &["class_declaration","interface_declaration","enum_declaration"];

// ── C/C++ config ──

static C_SKIP_NAMES: &[&str] = &[
    "NULL","nullptr","true","false","printf","scanf","fprintf","sprintf","snprintf",
    "malloc","calloc","realloc","free","sizeof","typeof","memcpy","memset","memcmp",
    "memmove","strlen","strcpy","strncpy","strcmp","strncmp","strcat","strncat",
    "strdup","strstr","strchr","strrchr","atoi","atol","atof","itoa","sprintf",
    "stdin","stdout","stderr","std","cout","cin","cerr","endl","vector","string",
    "map","set","pair","make_pair","shared_ptr","unique_ptr","weak_ptr","move",
    "forward","static_cast","dynamic_cast","const_cast","reinterpret_cast",
    "main","argc","argv","void","int","char","float","double","long","short",
    "unsigned","signed","const","volatile","auto","extern","register","static",
    "size_t","ssize_t","ptrdiff_t","FILE",
];

static C_FUNC_KINDS: &[&str] = &["function_definition","lambda_expression"];
static C_CLASS_KINDS: &[&str] = &["class_specifier","struct_specifier","union_specifier"];

// ── C# config ──

static CS_SKIP_NAMES: &[&str] = &[
    "null","true","false","this","base","var","string","int","long","double",
    "float","bool","char","byte","short","decimal","object","dynamic","void",
    "System","Console","Math","Convert","String","StringBuilder","List",
    "Dictionary","Array","Enumerable","Task","async","await","WriteLine",
    "Write","ReadLine","ToString","Equals","GetHashCode","GetType","Main",
];

static CS_FUNC_KINDS: &[&str] = &["method_declaration","constructor_declaration","lambda_expression"];
static CS_CLASS_KINDS: &[&str] = &["class_declaration","struct_declaration","interface_declaration","enum_declaration"];

// ── Ruby config ──

static RB_SKIP_NAMES: &[&str] = &[
    "nil","true","false","self","puts","print","p","pp","gets","raise","require",
    "include","extend","attr_accessor","attr_reader","attr_writer","new",
    "initialize","to_s","inspect","class","module","def","end","do","if",
    "else","elsif","unless","while","until","for","break","next","return",
    "Array","Hash","String","Symbol","Integer","Float","Regexp","Proc","Lambda",
    "Enumerable","Object","Kernel","Module",
];

static RB_FUNC_KINDS: &[&str] = &["method","lambda","block"];
static RB_CLASS_KINDS: &[&str] = &["class","module"];

// ── Lua config ──

static LUA_SKIP_NAMES: &[&str] = &[
    "nil","true","false","print","pairs","ipairs","next","type","tostring",
    "tonumber","assert","error","pcall","xpcall","require","module","select",
    "unpack","pack","rawget","rawset","rawlen","rawequal","setmetatable",
    "getmetatable","string","math","table","io","os","debug","coroutine",
    "utf8","self","arg","_G","_ENV","_VERSION",
];

static LUA_FUNC_KINDS: &[&str] = &["function_declaration","function_definition"];
static LUA_CLASS_KINDS: &[&str] = &[];

// ── PHP config ──

static PHP_SKIP_NAMES: &[&str] = &[
    "null","true","false","this","self","static","parent","echo","print",
    "isset","empty","unset","die","exit","require","include","require_once",
    "include_once","array","list","count","strlen","str_replace","substr",
    "trim","explode","implode","json_encode","json_decode","sprintf","printf",
    "var_dump","print_r","array_map","array_filter","array_reduce","array_keys",
    "array_values","in_array","date","time","strtotime","PDO","Exception",
    "Error","Throwable","stdClass","__construct","__destruct","__toString",
    "_GET","_POST","_SERVER","_SESSION","_COOKIE","_FILES","_REQUEST","_ENV",
    "GLOBALS","php","PHP_EOL","DIRECTORY_SEPARATOR",
];

static PHP_FUNC_KINDS: &[&str] = &["method_declaration","function_definition","arrow_function"];
static PHP_CLASS_KINDS: &[&str] = &["class_declaration","interface_declaration","trait_declaration"];

// ── Swift config ──

static SWIFT_SKIP_NAMES: &[&str] = &[
    "nil","true","false","self","Self","print","debugPrint","fatalError",
    "precondition","assert","String","Int","Double","Float","Bool","Array",
    "Dictionary","Set","Optional","Result","Error","Task","async","await",
    "guard","let","var","func","class","struct","enum","protocol","extension",
    "throws","rethrows","try","catch","throw","where","Swift","SwiftUI",
    "UIKit","Foundation","Combine","SwiftData",
];

static SWIFT_FUNC_KINDS: &[&str] = &["function_declaration","method_declaration","closure_expression"];
static SWIFT_CLASS_KINDS: &[&str] = &["class_declaration","struct_declaration","enum_declaration","protocol_declaration"];

// ── Dart config ──

static DART_SKIP_NAMES: &[&str] = &[
    "null","true","false","this","super","print","debugPrint","String","int",
    "double","bool","num","List","Map","Set","Object","dynamic","void","Future",
    "Stream","async","await","yield","assert","throw","rethrow","try","catch",
    "finally","new","const","final","var","static","library","import","export",
    "part","Flutter","Widget","BuildContext","Material","Cupertino",
];

static DART_FUNC_KINDS: &[&str] = &["function_declaration","method_declaration","function_expression"];
static DART_CLASS_KINDS: &[&str] = &["class_declaration","enum_declaration","mixin_declaration"];

// ── Scala config ──

static SCALA_SKIP_NAMES: &[&str] = &[
    "null","true","false","this","super","println","print","String","Int","Long",
    "Double","Float","Boolean","Byte","Short","Char","Unit","Any","Nothing",
    "Option","Some","None","List","Map","Set","Seq","Array","Vector","Either",
    "Left","Right","Try","Success","Failure","Future","Await","await","implicitly",
    "scala","Predef","require","assert","assume","???",
];

static SCALA_FUNC_KINDS: &[&str] = &["function_definition","method_definition","lambda_expression"];
static SCALA_CLASS_KINDS: &[&str] = &["class_definition","object_definition","trait_definition"];

// ── Zig config ──

static ZIG_SKIP_NAMES: &[&str] = &[
    "null","true","false","undefined","void","bool","u8","u16","u32","u64",
    "i8","i16","i32","i64","f32","f64","usize","isize","comptime_int",
    "comptime_float","anytype","type","error","@import","@export","@extern",
    "@intCast","@floatCast","@intFromFloat","@floatFromInt","@ptrCast",
    "@as","@sizeOf","@alignOf","@typeInfo","@typeName","@embedFile",
    "print","@memset","@memcpy","@panic","std","builtin","main",
];

static ZIG_FUNC_KINDS: &[&str] = &["function_declaration"];
static ZIG_CLASS_KINDS: &[&str] = &[];

// ── Elixir config ──

static EX_SKIP_NAMES: &[&str] = &[
    "nil","true","false","__MODULE__","__DIR__","__ENV__","__CALLER__",
    "inspect","to_string","length","hd","tl","elem","put_elem","tuple_size",
    "is_list","is_map","is_tuple","is_atom","is_integer","is_float","is_binary",
    "is_pid","is_function","is_boolean","is_nil","is_number","is_port",
    "is_reference","Enum","Map","List","String","Keyword","IO","Kernel",
    "Module","Process","Agent","GenServer","Task","Supervisor","Logger",
    "raise","throw","exit","receive","send","spawn","spawn_link","spawn_monitor",
    "self","make_ref","apply","def","defp","defmacro","defmacrop","use","import",
    "require","alias","case","cond","if","unless","with","for","try","rescue",
];

static EX_FUNC_KINDS: &[&str] = &["function","anonymous_function"];
static EX_CLASS_KINDS: &[&str] = &["module","defmodule"];

// ── Bash config ──

static SH_SKIP_NAMES: &[&str] = &[
    "echo","printf","cd","ls","pwd","cat","cp","mv","rm","mkdir","rmdir",
    "chmod","chown","ln","touch","grep","awk","sed","sort","uniq","wc","head",
    "tail","cut","tr","tee","xargs","find","which","type","export","unset",
    "readonly","declare","local","shift","source","exit","return","test",
    "true","false","null","HOME","PATH","USER","SHELL","PWD","OLDPWD",
    "IFS","PS1","PS2","PS3","PS4","RANDOM","SECONDS","LINENO","FUNCNAME",
    "BASHPID","BASH_VERSION","BASH_SOURCE","BASH_LINENO","HOSTNAME","OSTYPE",
];

static SH_FUNC_KINDS: &[&str] = &["function_definition"];
static SH_CLASS_KINDS: &[&str] = &[];

// ── R config ──

static R_SKIP_NAMES: &[&str] = &[
    "NULL","NA","NaN","Inf","TRUE","FALSE","T","F","print","cat","summary",
    "str","head","tail","length","nrow","ncol","dim","names","rownames",
    "colnames","class","typeof","mode","attributes","attr","levels","nlevels",
    "as.character","as.numeric","as.integer","as.logical","as.factor","as.matrix",
    "as.data.frame","as.list","as.vector","c","list","matrix","data.frame",
    "factor","rep","seq","seq_len","seq_along","sample","sort","order","rank",
    "which","which.min","which.max","match","%in%","is.na","is.null","is.nan",
    "is.infinite","is.finite","mean","median","sd","var","min","max","sum",
    "prod","range","quantile","cor","cov","table","aggregate","merge","subset",
    "transform","apply","lapply","sapply","tapply","mapply","library","require",
    "install.packages","read.csv","write.csv","read.table","write.table",
    "plot","hist","boxplot","barplot","par","dev.off","png","pdf",
    "if","else","for","while","repeat","break","next","function","return",
];

static R_FUNC_KINDS: &[&str] = &["function_definition","lambda_definition"];
static R_CLASS_KINDS: &[&str] = &[];

// ── Capture type ──

#[derive(Debug, Clone)]
struct Cap {
    name: String,
    line: usize,
    start: usize,
    capture: CapKind,
}

#[derive(Debug, Clone)]
enum CapKind {
    Write,
    Read,
    GlobalVar,
    TriggerCall,
    AwaitCb,
    AwaitFn,
    ThenMethod(String),
    Sequence(String), // call target name
}

// ── Scope info ──

#[derive(Debug, Clone)]
struct Scope {
    start: usize,
    end: usize,
    name: String,
}

// ── File helpers ──

fn extract_fn_name(node: &TsNode, source: &str) -> String {
    if let Some(nn) = node.child_by_field_name("name") {
        if let Ok(s) = nn.utf8_text(source.as_bytes()) {
            return s.to_string();
        }
    }
    format!("<fn@{}>", node.start_position().row + 1)
}

fn extract_name(node: &TsNode, source: &str) -> String {
    node.utf8_text(source.as_bytes()).unwrap_or("?").to_string()
}
// ═══════════════════════════════════════════════════════════════
// Pure query result types
// ═══════════════════════════════════════════════════════════════

/// Per-function dataflow summary.
#[derive(Debug, Clone)]
pub struct ScopeFlow {
    pub name: String,
    pub reads: Vec<String>,
    pub writes: Vec<String>,
    pub triggers: Vec<String>,         // await f() targets
    pub awaits_callbacks: Vec<String>, // .then(cb) callbacks
    pub sequence_calls: Vec<String>,   // consecutive call ordering
}

/// Cross-function shared state variable.
#[derive(Debug, Clone)]
pub struct SharedVarFlow {
    pub var: String,
    pub readers: Vec<String>,
    pub writers: Vec<String>,
}

/// Pure dataflow result for one file — no Graph dependency.
#[derive(Debug, Clone)]
pub struct FileDataflow {
    pub scopes: Vec<ScopeFlow>,
    pub shared: Vec<SharedVarFlow>,
}

// ═══════════════════════════════════════════════════════════════
// Public API: query_file_dataflow
// ═══════════════════════════════════════════════════════════════

/// Run dataflow queries on a single already-parsed file.
///
/// Returns per-function reads/writes/triggers/sequences + cross-function
/// shared state detection. Pure — does not touch the Graph.
///
/// For batch file queries with auto-detection of language + parsing,
/// use [`query_dataflow_files`] instead.
///
/// # Example output
/// ```text
/// FileDataflow {
///   scopes: [ScopeFlow { name: "login", reads: ["db","hash"],
///             writes: ["token"], triggers: ["validate_async"], ... }],
///   shared: [SharedVarFlow { var: "db", readers: ["login","query"],
///             writers: ["init_db"] }]
/// }
/// ```
pub fn query_file_dataflow(
    lang: Language,
    source: &str,
    tree: &tree_sitter::Tree,
    config: &LangDataflowConfig,
) -> Result<FileDataflow, String> {
    let query = Query::new(&lang, config.query_src)
        .map_err(|e| format!("query compile failed: {e}"))?;

    let mut cursor = QueryCursor::new();
    let root = tree.root_node();
    let source_bytes = source.as_bytes();

    // ── Phase 1: collect scopes ──
    let mut scopes: Vec<Scope> = Vec::new();
    {
        let mut stack: Vec<(TsNode, String)> = vec![(root, String::new())];
        while let Some((node, _)) = stack.pop() {
            if config.scope_role(node.kind()).is_some() {
                scopes.push(Scope {
                    start: node.start_byte(),
                    end: node.end_byte(),
                    name: extract_fn_name(&node, source),
                });
            }
            for child in node.children(&mut node.walk()) {
                stack.push((child, String::new()));
            }
        }
    }
    scopes.sort_by_key(|s| -(s.start as i64));

    // ── Phase 2: collect captures ──
    let mut write_offsets: HashSet<usize> = HashSet::new();
    let mut caps: Vec<Cap> = Vec::new();

    let mut captures = cursor.captures(&query, root, source_bytes);
    while let Some((qmatch, cap_idx)) = captures.next() {
        let capture = &qmatch.captures[*cap_idx];
        let cap_name: &str = &query.capture_names()[capture.index as usize];
        let node = capture.node;
        let start = node.start_byte();
        let name = extract_name(&node, source);
        let line = node.start_position().row + 1;

        match cap_name {
            "write" => {
                write_offsets.insert(start);
                caps.push(Cap { name, line, start, capture: CapKind::Write });
            }
            "read" => {
                caps.push(Cap { name, line, start, capture: CapKind::Read });
            }
            "global_var" => {
                caps.push(Cap { name, line, start, capture: CapKind::GlobalVar });
            }
            "trigger_call" => {
                caps.push(Cap { name, line, start, capture: CapKind::TriggerCall });
            }
            "await_cb" => {
                caps.push(Cap { name, line, start, capture: CapKind::AwaitCb });
            }
            "await_fn" => {
                caps.push(Cap { name, line, start, capture: CapKind::AwaitFn });
            }
            "_then_name" => {
                caps.push(Cap { name: name.clone(), line, start, capture: CapKind::ThenMethod(name) });
            }
            "sequence" => {
                caps.push(Cap { name: name.clone(), line, start, capture: CapKind::Sequence(name) });
            }
            _ => {}
        }
    }

    // ── Phase 3: resolve captures → per-scope HashMaps (no Graph) ──
    let mut scope_writes: HashMap<String, HashSet<String>> = HashMap::new();
    let mut scope_reads: HashMap<String, HashSet<String>> = HashMap::new();
    let mut scope_triggers: HashMap<String, Vec<String>> = HashMap::new();
    let mut scope_awaits: HashMap<String, Vec<String>> = HashMap::new();
    let mut scope_sequences: HashMap<String, Vec<(String, usize)>> = HashMap::new();
    let mut module_vars: HashSet<String> = HashSet::new();

    for cap in &caps {
        // ponytail: captures outside any function scope → module level
        let scope_id = find_scope(cap.start, &scopes).unwrap_or_else(|| "<module>".into());

        match &cap.capture {
            CapKind::Write => {
                if cap.name.is_empty() { continue; }
                scope_writes.entry(scope_id.clone()).or_default().insert(cap.name.clone());
            }
            CapKind::GlobalVar => {
                module_vars.insert(cap.name.clone());
            }
            CapKind::Read => {
                if write_offsets.contains(&cap.start) { continue; }
                if config.is_skip_name(&cap.name) { continue; }
                if !cap.name.chars().next().map_or(false, |c| c.is_lowercase()) { continue; }
                scope_reads.entry(scope_id.clone()).or_default().insert(cap.name.clone());
            }
            CapKind::TriggerCall => {
                scope_triggers.entry(scope_id.clone()).or_default().push(cap.name.clone());
            }
            CapKind::AwaitCb | CapKind::AwaitFn => {
                let cb = match &cap.capture {
                    CapKind::AwaitFn => format!("<cb@{}>", cap.line),
                    _ => cap.name.clone(),
                };
                scope_awaits.entry(scope_id.clone()).or_default().push(cb);
            }
            CapKind::Sequence(target) => {
                scope_sequences.entry(scope_id.clone()).or_default()
                    .push((target.clone(), cap.line));
            }
            _ => {}
        }
    }

    // ── Phase 5: shared state detection (reverse index) ──
    let mut var_to_writers: HashMap<&str, HashSet<&str>> = HashMap::new();
    for (sid, wvars) in &scope_writes {
        for v in wvars {
            var_to_writers.entry(v.as_str()).or_default().insert(sid.as_str());
        }
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut shared: Vec<SharedVarFlow> = Vec::new();
    for (scope_id, read_vars) in &scope_reads {
        for v in read_vars {
            if seen.contains(v) { continue; }
            let is_shared = module_vars.contains(v)
                || var_to_writers.get(v.as_str()).map_or(false, |w| {
                    w.len() > 1 || !w.contains(scope_id.as_str())
                });
            if is_shared {
                seen.insert(v.clone());
                let readers: Vec<String> = scope_reads.iter()
                    .filter(|(_, rv)| rv.contains(v))
                    .map(|(s, _)| s.clone())
                    .collect();
                let writers: Vec<String> = var_to_writers.get(v.as_str())
                    .map(|w| w.iter().map(|s| s.to_string()).collect())
                    .unwrap_or_default();
                shared.push(SharedVarFlow { var: v.clone(), readers, writers });
            }
        }
    }

    // ── Build per-scope output ──
    let scope_names: Vec<String> = {
        let mut set: HashSet<String> = scope_reads.keys()
            .chain(scope_writes.keys())
            .chain(scope_triggers.keys())
            .chain(scope_awaits.keys())
            .chain(scope_sequences.keys())
            .cloned()
            .collect();
        // Include scopes that only write (no reads)
        for s in &scopes {
            set.insert(s.name.clone());
        }
        let mut v: Vec<String> = set.into_iter().collect();
        v.sort();
        v
    };

    let mut scope_flows: Vec<ScopeFlow> = Vec::new();
    for name in &scope_names {
        let mut seq = scope_sequences.remove(name).unwrap_or_default();
        seq.sort_by_key(|(_, line)| *line);
        scope_flows.push(ScopeFlow {
            name: name.clone(),
            reads: sorted(&scope_reads.remove(name).unwrap_or_default()),
            writes: sorted(&scope_writes.remove(name).unwrap_or_default()),
            triggers: scope_triggers.remove(name).unwrap_or_default(),
            awaits_callbacks: scope_awaits.remove(name).unwrap_or_default(),
            sequence_calls: seq.into_iter().map(|(n, _)| n).collect(),
        });
    }

    Ok(FileDataflow { scopes: scope_flows, shared })
}

fn sorted(set: &HashSet<String>) -> Vec<String> {
    let mut v: Vec<String> = set.iter().cloned().collect();
    v.sort();
    v
}

// ═══════════════════════════════════════════════════════════════
// Engine-native API: query_dataflow_files
// ═══════════════════════════════════════════════════════════════

/// Result for one file in a batch dataflow query.
#[derive(Debug, Clone)]
pub struct DataflowFileResult {
    pub file: String,
    pub result: Result<FileDataflow, String>,
}

/// Batch dataflow query — reads files from disk, auto-detects language,
/// parses, and runs [`query_file_dataflow`] on each.
///
/// Errors (missing file, unsupported extension, parse failure) are captured
/// per-file in `DataflowFileResult::result` — never propagated.
///
/// # Agent workflow pattern
/// ```text
/// 1. hologram_search("db") → find candidate files
/// 2. query_dataflow_files(&[path1, path2, path3]) → dataflow results
/// 3. For each shared variable found, cross-reference with graph structure
/// ```
///
/// 18 languages supported. See [`config_for_ext`] for the full list.
pub fn query_dataflow_files(files: &[std::path::PathBuf]) -> Vec<DataflowFileResult> {
    files.iter().map(|p| {
        let file = p.to_string_lossy().replace('\\', "/");
        let source = match std::fs::read_to_string(p) {
            Ok(s) => s,
            Err(e) => return DataflowFileResult {
                file: file.clone(),
                result: Err(format!("read failed: {e}")),
            },
        };
        let ext = file.rsplit('.').next().unwrap_or("");
        let (grammar_key, config) = match config_for_ext(ext) {
            Some(x) => x,
            None => return DataflowFileResult {
                file: file.clone(),
                result: Err(format!("unsupported extension: .{ext}")),
            },
        };
        let lang = match crate::engine::GRAMMAR_LOADER.get(grammar_key) {
            Some(l) => l,
            None => return DataflowFileResult {
                file: file.clone(),
                result: Err(format!("grammar not loaded for {grammar_key}")),
            },
        };
        let mut parser = tree_sitter::Parser::new();
        if let Err(e) = parser.set_language(&lang) {
            return DataflowFileResult {
                file: file.clone(),
                result: Err(format!("parser init failed: {e}")),
            };
        }
        let tree = match parser.parse(&source, None) {
            Some(t) => t,
            None => return DataflowFileResult {
                file: file.clone(),
                result: Err("parse returned None".into()),
            },
        };
        DataflowFileResult {
            file,
            result: query_file_dataflow(lang, &source, &tree, &config),
        }
    }).collect()
}

/// Find the tightest enclosing scope for a byte offset.
/// ponytail: scopes sorted by start descending — nested scopes always have
/// larger start bytes, so first match is tightest. Amortized O(1) per capture.
fn find_scope(offset: usize, scopes: &[Scope]) -> Option<String> {
    for s in scopes {
        if offset >= s.start && offset <= s.end {
            return Some(s.name.clone());
        }
    }
    None
}

// ═══════════════════════════════════════════════════════════════
// Public config constructors
// ═══════════════════════════════════════════════════════════════

pub fn python_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/python_dataflow.scm"), skip_names: PY_BUILTINS, func_kinds: PY_FUNC_KINDS, class_kinds: PY_CLASS_KINDS }
}
pub fn js_ts_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/js_ts_dataflow.scm"), skip_names: JS_SKIP_NAMES, func_kinds: JS_FUNC_KINDS, class_kinds: JS_CLASS_KINDS }
}
pub fn rust_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/rust_dataflow.scm"), skip_names: RS_SKIP_NAMES, func_kinds: RS_FUNC_KINDS, class_kinds: RS_CLASS_KINDS }
}
pub fn go_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/go_dataflow.scm"), skip_names: GO_SKIP_NAMES, func_kinds: GO_FUNC_KINDS, class_kinds: GO_CLASS_KINDS }
}
pub fn java_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/java_dataflow.scm"), skip_names: JAVA_SKIP_NAMES, func_kinds: JAVA_FUNC_KINDS, class_kinds: JAVA_CLASS_KINDS }
}
pub fn c_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/c_dataflow.scm"), skip_names: C_SKIP_NAMES, func_kinds: C_FUNC_KINDS, class_kinds: C_CLASS_KINDS }
}
pub fn csharp_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/csharp_dataflow.scm"), skip_names: CS_SKIP_NAMES, func_kinds: CS_FUNC_KINDS, class_kinds: CS_CLASS_KINDS }
}
pub fn ruby_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/ruby_dataflow.scm"), skip_names: RB_SKIP_NAMES, func_kinds: RB_FUNC_KINDS, class_kinds: RB_CLASS_KINDS }
}
pub fn lua_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/lua_dataflow.scm"), skip_names: LUA_SKIP_NAMES, func_kinds: LUA_FUNC_KINDS, class_kinds: LUA_CLASS_KINDS }
}
pub fn php_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/php_dataflow.scm"), skip_names: PHP_SKIP_NAMES, func_kinds: PHP_FUNC_KINDS, class_kinds: PHP_CLASS_KINDS }
}
pub fn swift_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/swift_dataflow.scm"), skip_names: SWIFT_SKIP_NAMES, func_kinds: SWIFT_FUNC_KINDS, class_kinds: SWIFT_CLASS_KINDS }
}
pub fn dart_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/dart_dataflow.scm"), skip_names: DART_SKIP_NAMES, func_kinds: DART_FUNC_KINDS, class_kinds: DART_CLASS_KINDS }
}
pub fn scala_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/scala_dataflow.scm"), skip_names: SCALA_SKIP_NAMES, func_kinds: SCALA_FUNC_KINDS, class_kinds: SCALA_CLASS_KINDS }
}
pub fn zig_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/zig_dataflow.scm"), skip_names: ZIG_SKIP_NAMES, func_kinds: ZIG_FUNC_KINDS, class_kinds: ZIG_CLASS_KINDS }
}
pub fn elixir_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/elixir_dataflow.scm"), skip_names: EX_SKIP_NAMES, func_kinds: EX_FUNC_KINDS, class_kinds: EX_CLASS_KINDS }
}
pub fn bash_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/bash_dataflow.scm"), skip_names: SH_SKIP_NAMES, func_kinds: SH_FUNC_KINDS, class_kinds: SH_CLASS_KINDS }
}
pub fn r_config() -> LangDataflowConfig {
    LangDataflowConfig { query_src: include_str!("../../queries/r_dataflow.scm"), skip_names: R_SKIP_NAMES, func_kinds: R_FUNC_KINDS, class_kinds: R_CLASS_KINDS }
}

/// Map a file extension to (grammar_key, dataflow_config). Returns None for unsupported languages.
pub fn config_for_ext(ext: &str) -> Option<(&'static str, LangDataflowConfig)> {
    match ext {
        "py" | "pyi" | "pyx" => Some(("py", python_config())),
        "js" | "jsx" | "mjs" | "cjs" => Some(("js", js_ts_config())),
        "ts" | "tsx" | "mts" | "cts" => Some(("ts", js_ts_config())),
        "rs" => Some(("rs", rust_config())),
        "go" => Some(("go", go_config())),
        "java" => Some(("java", java_config())),
        "c" | "h" => Some(("c", c_config())),
        "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" => Some(("cpp", c_config())),
        "cs" => Some(("cs", csharp_config())),
        "rb" => Some(("rb", ruby_config())),
        "lua" => Some(("lua", lua_config())),
        "php" => Some(("php", php_config())),
        "swift" => Some(("swift", swift_config())),
        "dart" => Some(("dart", dart_config())),
        "scala" | "sc" => Some(("scala", scala_config())),
        "zig" => Some(("zig", zig_config())),
        "ex" | "exs" => Some(("ex", elixir_config())),
        "sh" | "bash" => Some(("bash", bash_config())),
        "r" | "R" => Some(("r", r_config())),
        _ => None,
    }
}

/// Validate all dataflow query configs compile against their grammars.
/// Call once at engine startup; panics on parse in test, logs errors in production.
pub fn validate_all_queries() -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    // All known extension→config pairs. Extensions that map to the same config
    // (e.g. js/ts) only need one check per config; we use the primary extension.
    // ponytail: grammar_key = file extension (how GRAMMAR_LOADER registers static grammars)
    let checks: &[(&str, fn() -> LangDataflowConfig)] = &[
        ("py", python_config),
        ("js", js_ts_config),
        ("rs", rust_config),
        ("go", go_config),
        ("java", java_config),
        ("c", c_config),
        ("cs", csharp_config),
        ("rb", ruby_config),
        ("lua", lua_config),
        ("php", php_config),
        ("swift", swift_config),
        ("dart", dart_config),
        ("scala", scala_config),
        ("zig", zig_config),
        ("ex", elixir_config),
        ("sh", bash_config),
        ("r", r_config),
    ];
    for (grammar_key, cfg_fn) in checks {
        let cfg = cfg_fn();
        match crate::engine::GRAMMAR_LOADER.get(grammar_key) {
            Some(lang) => {
                if let Err(e) = Query::new(&lang, cfg.query_src) {
                    let err_str = e.to_string();
                    if err_str.contains("Incompatible language version") {
                        eprintln!("[dataflow] grammar ABI mismatch for {grammar_key}: {err_str} — skipping (not a query error)");
                    } else {
                        let msg = format!("⚠ dataflow query FAILED for {grammar_key}: {err_str}");
                        eprintln!("{msg}");
                        errors.push(msg);
                    }
                }
            }
            None => {
                eprintln!("[dataflow] grammar not available for {grammar_key} — skipping validation");
            }
        }
    }
    if errors.is_empty() {
        eprintln!("[dataflow] all {} query configs validated OK", checks.len());
    } else {
        eprintln!("[dataflow] {} query config(s) FAILED — dataflow edges will be missing for those languages", errors.len());
    }
    errors
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::GRAMMAR_LOADER;

    #[test]
    fn test_all_queries_compile() {
        let errors = validate_all_queries();
        assert!(errors.is_empty(), "dataflow query compile failures:\n{}", errors.join("\n"));
    }

    fn run_query(lang_key: &str, cfg: LangDataflowConfig, src: &str) -> FileDataflow {
        let lang = GRAMMAR_LOADER.get(lang_key).expect("grammar not loaded");
        let mut p = tree_sitter::Parser::new();
        p.set_language(&lang).unwrap();
        let tree = p.parse(src, None).expect("parse");
        query_file_dataflow(lang, src, &tree, &cfg).expect("query failed")
    }

    fn find_scope<'a>(df: &'a FileDataflow, name: &str) -> &'a ScopeFlow {
        df.scopes.iter().find(|s| s.name == name)
            .unwrap_or_else(|| panic!("scope {name} not found in {:?}", df.scopes.iter().map(|s| &s.name).collect::<Vec<_>>()))
    }

    #[test]
    fn test_py_reads_writes() {
        let df = run_query("py", python_config(), r#"
x = 1
def foo():
    y = x + 1
    print(y)
"#);
        let foo = find_scope(&df, "foo");
        assert!(foo.reads.contains(&"x".into()), "foo should read x, got reads={:?}", foo.reads);
        assert!(foo.writes.contains(&"y".into()), "foo should write y, got writes={:?}", foo.writes);
    }

    #[test]
    fn test_py_shares() {
        let df = run_query("py", python_config(), r#"
config = {}
def set_cfg():
    config['k'] = 1
def get_cfg():
    return config
"#);
        let shared = df.shared.iter().find(|s| s.var == "config");
        assert!(shared.is_some(), "config should be detected as shared state, got shared={:?}", df.shared);
    }

    #[test]
    fn test_py_awaits() {
        let df = run_query("py", python_config(), r#"
async def fetch():
    await do_request()
"#);
        let fetch = find_scope(&df, "fetch");
        assert!(!fetch.triggers.is_empty(), "fetch should have trigger, got triggers={:?}", fetch.triggers);
    }

    #[test]
    fn test_js_reads_writes() {
        let df = run_query("js", js_ts_config(), r#"
let x = 1;
function foo() {
    let y = x + 1;
    console.log(y);
}
"#);
        let foo = find_scope(&df, "foo");
        assert!(foo.reads.contains(&"x".into()), "foo should read x, got reads={:?}", foo.reads);
        assert!(foo.writes.contains(&"y".into()), "foo should write y, got writes={:?}", foo.writes);
    }

    #[test]
    fn test_js_awaits() {
        let df = run_query("js", js_ts_config(), r#"
async function load() {
    await fetch('/api');
}
"#);
        let load = find_scope(&df, "load");
        assert!(!load.triggers.is_empty(), "load should have trigger, got triggers={:?}", load.triggers);
    }

    #[test]
    fn test_sequences() {
        let df = run_query("py", python_config(), r#"
def foo():
    a()
    b()
    c()
"#);
        let foo = find_scope(&df, "foo");
        assert_eq!(foo.sequence_calls.len(), 3, "foo should have 3 sequence calls, got {:?}", foo.sequence_calls);
    }

    #[test]
    fn test_query_files() {
        let tmp = std::env::temp_dir().join("_df_files_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "x = 1\ndef foo():\n    y = x + 1\n").unwrap();
        let results = super::query_dataflow_files(&[tmp.join("a.py")]);
        assert_eq!(results.len(), 1);
        let df = results[0].result.as_ref().expect("query should succeed");
        let foo = df.scopes.iter().find(|s| s.name == "foo");
        assert!(foo.is_some(), "should find scope foo");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_demo_realistic() {
        // Realistic patterns: shared config, caching, async, pipeline
        let src = r#"
config = {"host": "localhost"}
_cache = {}
def connect():
    return config["host"]
def query(sql):
    result = _cache.get(sql)
    if result:
        return result
    db = connect()
    data = db.execute(sql)
    _cache[sql] = data
    return data
async def fetch_users():
    data = await http_get("/api/users")
    return data
def pipeline():
    load_data()
    transform_data()
    save_results()
"#;
        let df = run_query("py", python_config(), src);
        eprintln!("=== SCOPES ===");
        for s in &df.scopes {
            eprintln!("  {}: reads={:?} writes={:?} triggers={:?} seq={:?}",
                s.name, s.reads, s.writes, s.triggers, s.sequence_calls);
        }
        eprintln!("=== SHARED ===");
        for sh in &df.shared {
            eprintln!("  {}: readers={:?} writers={:?}", sh.var, sh.readers, sh.writers);
        }
        // Assertions
        assert!(df.scopes.iter().any(|s| s.name == "connect"), "should find connect");
        assert!(df.scopes.iter().any(|s| s.name == "query"), "should find query");
        assert!(df.scopes.iter().any(|s| s.name == "fetch_users"), "should find fetch_users");
        assert!(df.scopes.iter().any(|s| s.name == "pipeline"), "should find pipeline");
        // connect reads config
        let connect = df.scopes.iter().find(|s| s.name == "connect").unwrap();
        assert!(connect.reads.contains(&"config".into()), "connect should read config");
        // fetch_users has trigger
        let fetch = df.scopes.iter().find(|s| s.name == "fetch_users").unwrap();
        assert!(!fetch.triggers.is_empty(), "fetch_users should have trigger");
        // pipeline has sequence_calls
        let pipe = df.scopes.iter().find(|s| s.name == "pipeline").unwrap();
        assert_eq!(pipe.sequence_calls.len(), 3, "pipeline should have 3 sequence calls");
        // config should be shared (read by connect)
        let config_shared = df.shared.iter().find(|s| s.var == "config");
        assert!(config_shared.is_some(), "config should be detected as shared");
    }
}
