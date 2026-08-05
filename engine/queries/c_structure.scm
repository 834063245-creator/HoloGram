;; C Structure Queries
;; ponytail: class_specifier 仅存在于 C++ 语法，放在 cpp_structure.scm。
;; 此文件必须只用 tree-sitter-c 已有的节点类型。

(function_definition) @fn
(struct_specifier) @class
(union_specifier) @class
(enum_specifier) @class
(call_expression) @call
(preproc_include) @import

;; ── Variables ──
(declaration) @var

;; ── Writes ──
(assignment_expression) @write

;; C 无异常机制:tree-sitter-c 没有 throw_statement 节点,
;; 写在这里会导致整个查询编译失败、C 文件结构提取全部跳过。
;; (throw 查询只应出现在 cpp/java/js/ts 等有此节点的语言文件中。)

;; ── Usage ──
(identifier) @usage
