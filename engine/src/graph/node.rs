// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use serde::{Deserialize, Serialize};

use super::NodeId;

// ── R0 语义访问器的扩展名表 ──
// 与 resolver.rs 的 code_extension_set() 同源(GRAMMAR_LOADER),
// 语义逐字等价;R2 迁移 resolver 消费点时统一去重。
fn code_extension_set() -> &'static std::collections::HashSet<String> {
    static SET: std::sync::OnceLock<std::collections::HashSet<String>> =
        std::sync::OnceLock::new();
    SET.get_or_init(|| {
        crate::engine::GRAMMAR_LOADER
            .supported_extensions()
            .into_iter()
            .collect()
    })
}

fn is_common_extension(s: &str) -> bool {
    code_extension_set().contains(s)
}

/// Node 类型 — 对应 Python 的 NodeType 枚举。
/// O(1) 度数追踪（修复了 v3 社区检测中的 O(V×E) 性能问题）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Symbol,    // 通用 / 未分类
    Function,  // 函数 / 方法 / 构造函数
    Class,     // 类 / 结构体 / 枚举
    Module,    // 命名空间 / 包
    File,      // 源文件模块
    Interface, // 接口 / trait / 类型别名
    Variable,  // 变量 / 常量 / 字段
    Medium,    // 存储 / IO
    Temporal,  // 异步 / 定时器
}

impl NodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeKind::Symbol => "symbol",
            NodeKind::Function => "function",
            NodeKind::Class => "class",
            NodeKind::Module => "module",
            NodeKind::File => "file",
            NodeKind::Interface => "interface",
            NodeKind::Variable => "variable",
            NodeKind::Medium => "medium",
            NodeKind::Temporal => "temporal",
        }
    }
}

/// 依赖图中的节点。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    /// 全局驻留句柄 —— 对外是字符串语义(`as_str()`/`Deref<Target=str>` 解析回字符串)
    pub id: NodeId,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    /// 源文件位置："src/main.py" 或 "src/main.rs:42"
    pub location: Option<String>,
    /// 该节点的源码文本（函数体、类定义等）
    /// 在解析时填充；供向量索引用于语义搜索。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// 任意元数据
    pub properties: serde_json::Value,
        /// 预计算的度数（修复 O(V×E) 社区标签性能问题）
    #[serde(default)]
    pub out_degree: u32,
    #[serde(default)]
    pub in_degree: u32,
    /// 剔除 defines 边后的入度。find_unused 用此字段判断，
    /// 避免"唯一入边是自身文件 defines 边"的假阳性。
    #[serde(default)]
    pub non_defines_in_degree: u32,
    /// 预计算的 3D 位置（可选，用于 Unity）
    pub position: Option<[f32; 3]>,
    /// 社区 ID（由社区检测分配）
    pub community_id: Option<usize>,
}

impl Node {
    pub fn new(id: impl Into<String>, name: impl Into<String>, kind: NodeKind) -> Self {
        Self {
            id: NodeId::new(id),
            name: name.into(),
            kind,
            location: None,
            snippet: None,
            properties: serde_json::Value::Object(Default::default()),
            out_degree: 0,
            in_degree: 0,
            non_defines_in_degree: 0,
            position: None,
            community_id: None,
        }
    }

    /// 去重用的稳定键："location::name::kind"
    pub fn loc_key(&self) -> String {
        format!(
            "{}::{}::{}",
            self.location.as_deref().unwrap_or(""),
            self.name,
            self.kind.as_str()
        )
    }

    /// 所属文件路径(不含行号)。来自 location,无 location 返回 None。
    /// 语义 = flows.rs strip_line_suffix(R0 统一搬到这里):
    /// 去掉末尾 ":行号" 段(处理 Windows 盘符,只剥纯数字后缀)。
    pub fn file(&self) -> Option<&str> {
        self.location.as_deref().map(|loc| {
            if let Some(pos) = loc.rfind(':') {
                let maybe_line = &loc[pos + 1..];
                if maybe_line.chars().all(|c| c.is_ascii_digit()) {
                    return &loc[..pos];
                }
            }
            loc
        })
    }

    /// 短名 —— id 的最后一段,但若该段是已知代码扩展名则再往前取一段。
    /// 语义 = resolver.rs 的 short_name(原样搬入,含 is_common_extension 逻辑,
    /// 扩展名表复用 code_extension_set())。
    ///
    /// "django.http.HttpResponse" → "HttpResponse"
    /// "a.rs"                     → "a"
    /// "app.views.index"          → "index"
    pub fn short_name(&self) -> &str {
        let full = self.id.as_str();
        let last = full.rsplit('.').next().unwrap_or(full);
        if is_common_extension(last) {
            if let Some(stripped) = full.strip_suffix(&format!(".{}", last)) {
                return stripped
                    .rsplit(&['.', '/', '\\'])
                    .next()
                    .unwrap_or(stripped);
            }
        }
        full.rsplit('.').next().unwrap_or(full)
    }

    /// 模块路径 —— id 去掉最后一段。无 '.' 时返回整个 id。
    pub fn module(&self) -> &str {
        match self.id.rfind('.') {
            Some(pos) => &self.id[..pos],
            None => &self.id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_new_defaults() {
        let n = Node::new("n1", "main", NodeKind::Symbol);
        assert_eq!(n.id, "n1");
        assert_eq!(n.name, "main");
        assert!(matches!(n.kind, NodeKind::Symbol));
        assert!(n.location.is_none());
        assert_eq!(n.out_degree, 0);
        assert_eq!(n.in_degree, 0);
        assert!(n.position.is_none());
        assert!(n.community_id.is_none());
    }

    #[test]
    fn test_node_with_location() {
        let mut n = Node::new("n1", "main", NodeKind::Symbol);
        n.location = Some("src/main.rs".into());
        assert_eq!(n.location.as_deref(), Some("src/main.rs"));
    }

    #[test]
    fn test_node_kind_as_str() {
        assert_eq!(NodeKind::Symbol.as_str(), "symbol");
        assert_eq!(NodeKind::Function.as_str(), "function");
        assert_eq!(NodeKind::Class.as_str(), "class");
        assert_eq!(NodeKind::Module.as_str(), "module");
        assert_eq!(NodeKind::File.as_str(), "file");
        assert_eq!(NodeKind::Interface.as_str(), "interface");
        assert_eq!(NodeKind::Medium.as_str(), "medium");
        assert_eq!(NodeKind::Temporal.as_str(), "temporal");
    }

    #[test]
    fn test_node_kind_as_str_roundtrip() {
        // ponytail: 验证所有 8 种 NodeKind 变体能通过字符串往返。
        // SQLite 层通过 as_str() 将 kind 存储为 TEXT；此测试确保
        // 每个变体都能正确映射回对应的枚举值。
        let kinds = vec![
            NodeKind::Symbol,
            NodeKind::Function,
            NodeKind::Class,
            NodeKind::Module,
            NodeKind::File,
            NodeKind::Interface,
            NodeKind::Medium,
            NodeKind::Temporal,
        ];
        for original in kinds {
            let s = original.as_str();
            let parsed = match s {
                "symbol" => NodeKind::Symbol,
                "function" => NodeKind::Function,
                "class" => NodeKind::Class,
                "module" => NodeKind::Module,
                "file" => NodeKind::File,
                "interface" => NodeKind::Interface,
                "medium" => NodeKind::Medium,
                "temporal" => NodeKind::Temporal,
                _ => panic!("unknown kind: {}", s),
            };
            assert_eq!(std::mem::discriminant(&parsed), std::mem::discriminant(&original),
                "kind {:?} → '{s}' did not round-trip back to same variant", original);
        }
    }

    #[test]
    fn test_loc_key_with_location() {
        let mut n = Node::new("n1", "handle_request", NodeKind::Symbol);
        n.location = Some("src/handlers.py".into());
        assert_eq!(n.loc_key(), "src/handlers.py::handle_request::symbol");
    }

    #[test]
    fn test_loc_key_without_location() {
        let n = Node::new("n1", "global_var", NodeKind::Symbol);
        assert_eq!(n.loc_key(), "::global_var::symbol");
    }

    #[test]
    fn test_loc_key_different_kinds() {
        let mut sym = Node::new("s1", "db", NodeKind::Medium);
        sym.location = Some("store.rs".into());
        assert_eq!(sym.loc_key(), "store.rs::db::medium");

        let mut tmp = Node::new("t1", "timer", NodeKind::Temporal);
        tmp.location = Some("scheduler.rs".into());
        assert_eq!(tmp.loc_key(), "scheduler.rs::timer::temporal");
    }

    #[test]
    fn test_loc_key_deduplication_same_loc_name_kind() {
        let mut a = Node::new("id_a", "fn", NodeKind::Symbol);
        a.location = Some("lib.rs".into());
        let mut b = Node::new("id_b", "fn", NodeKind::Symbol);
        b.location = Some("lib.rs".into());
        assert_eq!(a.loc_key(), b.loc_key(), "same loc+name+kind should produce same key");
    }

    #[test]
    fn test_node_serde_roundtrip() {
        let mut n = Node::new("n1", "test_fn", NodeKind::Symbol);
        n.location = Some("src/test.rs:42".into());
        n.out_degree = 3;
        n.in_degree = 1;
        n.community_id = Some(0);
        let json = serde_json::to_string(&n).unwrap();
        let back: Node = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "n1");
        assert_eq!(back.name, "test_fn");
        assert!(matches!(back.kind, NodeKind::Symbol));
        assert_eq!(back.location.as_deref(), Some("src/test.rs:42"));
        assert_eq!(back.out_degree, 3);
        assert_eq!(back.in_degree, 1);
        assert_eq!(back.community_id, Some(0));
    }

    // ── R0 语义访问器边界用例 ──

    #[test]
    fn test_file_strips_line_suffix() {
        let mut n = Node::new("n1", "f", NodeKind::Symbol);
        n.location = Some("src/main.rs:42".into());
        assert_eq!(n.file(), Some("src/main.rs"));
        // 无行号后缀 → 原样返回
        n.location = Some("src/main.rs".into());
        assert_eq!(n.file(), Some("src/main.rs"));
    }

    #[test]
    fn test_file_windows_drive_letter() {
        let mut n = Node::new("n1", "f", NodeKind::Symbol);
        // Windows 盘符冒号不是行号分隔符,不应被剥
        n.location = Some("C:\\Users\\foo\\bar.rs:10".into());
        assert_eq!(n.file(), Some("C:\\Users\\foo\\bar.rs"));
        n.location = Some("C:\\Users\\foo\\bar.rs".into());
        assert_eq!(n.file(), Some("C:\\Users\\foo\\bar.rs"));
        // 冒号后非纯数字 → 保持原样
        n.location = Some("http://example.com".into());
        assert_eq!(n.file(), Some("http://example.com"));
    }

    #[test]
    fn test_file_no_location() {
        let n = Node::new("n1", "f", NodeKind::Symbol);
        assert_eq!(n.file(), None);
    }

    #[test]
    fn test_short_name_dotted_id() {
        let n = Node::new("django.http.HttpResponse", "HttpResponse", NodeKind::Class);
        assert_eq!(n.short_name(), "HttpResponse");
        let n = Node::new("app.views.index", "index", NodeKind::Function);
        assert_eq!(n.short_name(), "index");
    }

    #[test]
    fn test_short_name_extension_aware() {
        // 最后一段是已知代码扩展名 → 再往前取一段
        let n = Node::new("a.rs", "a", NodeKind::File);
        assert_eq!(n.short_name(), "a");
        let n = Node::new("app.models.py", "models", NodeKind::File);
        assert_eq!(n.short_name(), "models");
    }

    #[test]
    fn test_short_name_no_dot() {
        let n = Node::new("main", "main", NodeKind::Function);
        assert_eq!(n.short_name(), "main");
    }

    #[test]
    fn test_module_dotted_and_plain() {
        let n = Node::new("a.b.c", "c", NodeKind::Symbol);
        assert_eq!(n.module(), "a.b");
        // 无 '.' → 返回整个 id
        let n = Node::new("main", "main", NodeKind::Symbol);
        assert_eq!(n.module(), "main");
        // 扩展名式 id 也按同一规则(只去最后一段,不感知扩展名)
        let n = Node::new("a.rs", "a", NodeKind::File);
        assert_eq!(n.module(), "a");
    }
}